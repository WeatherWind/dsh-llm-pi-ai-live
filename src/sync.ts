/**
 * The refresh engine.
 *
 * One pass is: read the live directory and settings, plan the routes that can
 * be interrogated, interrogate each one, merge append-only, and write the
 * result back through the settings seam. Every step is fail-soft per route: a
 * gateway that is down, a malformed listing, a protocol with no readable
 * listing, or a rejected write leaves that route's configuration exactly as it
 * was and is reported in the pass summary. No pass can make a route *worse*
 * than it found it, because the only write that ever happens appends ids.
 *
 * Writes re-read the settings revision immediately before mutating, and retry
 * once on a rejected write, which is what makes an edit landing in the
 * settings UI mid-pass harmless rather than a lost update.
 *
 * @module dsh-llm-pi-ai-live/sync
 */

import type { BuiltinCatalog } from './builtin.js'
import { listModels } from './listing.js'
import { mergeAppendOnly } from './merge.js'
import { applyReasoning, compileRules } from './reasoning.js'
import type { ReasoningApplication, ReasoningPolicy } from './reasoning.js'
import { planRoutes } from './routes.js'
import type { PlannedRoute } from './routes.js'
import type { CredentialsSeam, LlmSeam, Logger, SettingsSeam } from './types.js'

/** The policy one pass runs under. */
export interface SyncPolicy {
  /** Whether installed-catalog facts may fill fields the listing omitted. */
  enrichFromCatalog: boolean
  /** Hard cap on stored model entries per route. */
  maxModels: number
  /** Per-request network timeout in milliseconds. */
  timeoutMs: number
  /** Compute and report, but never write. */
  dryRun: boolean
  /** Namespaces to serve; empty means auto-detect. */
  settingsNamespaces: readonly string[]
  /** Provider routes to include; empty means all. */
  include: readonly string[]
  /** Provider routes to exclude. */
  exclude: readonly string[]
  /** Whether and how to declare reasoning for models that have none. */
  reasoning: ReasoningPolicy
}

/** Everything one pass needs from the host. */
export interface SyncDeps {
  llm: LlmSeam
  settings: SettingsSeam
  credentials?: CredentialsSeam
  catalog?: BuiltinCatalog
  logger: Logger
  policy: SyncPolicy
  /** Injectable fetch, for tests. */
  fetch?: typeof globalThis.fetch
}

/** How one route fared. */
export interface RouteOutcome {
  provider: string
  /** `updated` wrote new ids, `unchanged` had nothing to add, `skipped` was not
   * eligible, `failed` was eligible but could not be completed. */
  status: 'updated' | 'unchanged' | 'skipped' | 'failed'
  /** Ids appended by this pass. */
  added: string[]
  /** Models this pass declared reasoning for. */
  reasoned: ReasoningApplication[]
  /** Entries the user already had. */
  kept: number
  /** Models the endpoint advertised, when it answered. */
  advertised?: number
  /** Stable reason code for a skip or failure. */
  reason?: string
  /** Human-readable detail for a skip or failure. */
  detail?: string
  /** Wall-clock duration in milliseconds. */
  durationMs: number
}

/** The summary of one pass. */
export interface SyncReport {
  /** Wall-clock start of the pass. */
  at: number
  /** What triggered the pass: `startup`, `interval`, `tool`, or `manual`. */
  trigger: string
  /** Per-route outcomes. */
  routes: RouteOutcome[]
  /** Routes that gained at least one model. */
  updated: number
  /** Total ids appended across every route. */
  added: number
  /** Routes that could not be completed. */
  failed: number
  /** Routes that were not eligible. */
  skipped: number
  /** Wall-clock duration of the whole pass. */
  durationMs: number
}

/** A refresh engine bound to one host. */
export interface SyncEngine {
  /**
   * Run one pass.
   *
   * @param trigger - what triggered the pass, recorded in the report.
   * @param options - caller cancellation and an optional provider allow-list
   *   that replaces the policy's own `include` for this pass.
   */
  refresh(trigger: string, options?: { signal?: AbortSignal; include?: readonly string[] }): Promise<SyncReport>
}

/** Resolve the credential a route names, tolerating an absent credentials seam. */
async function resolveApiKey(
  deps: SyncDeps,
  route: PlannedRoute,
): Promise<string | undefined> {
  if (route.apiKeyEnv === undefined) return undefined
  if (deps.credentials === undefined) return undefined
  try {
    const resolved = await deps.credentials.resolve(route.apiKeyEnv)
    return resolved?.value
  } catch {
    return undefined
  }
}

/**
 * Persist one route's merged list.
 *
 * The revision is re-read immediately before the write so a settings edit that
 * landed during the network call is not reported as a lost update; a rejected
 * write is retried once against a fresh revision. A write that the seam
 * accepts is then confirmed by re-reading the descriptor, because a write that
 * "succeeds" while resolution keeps returning another layer's value would
 * otherwise be invisible until the next restart.
 *
 * @returns `undefined` on success, or a `[reason, detail]` pair.
 */
async function writeModels(
  deps: SyncDeps,
  route: PlannedRoute,
  models: unknown[],
): Promise<[string, string] | undefined> {
  const ops = [{ op: 'set' as const, path: [...route.settingsPath, 'models'], value: models }]

  for (let attempt = 0; attempt < 2; attempt += 1) {
    let revision: number | undefined
    try {
      const descriptor = deps.settings
        .describe()
        .find((candidate) => candidate.ns === route.settingsNs)
      revision = descriptor?.revision
    } catch (error) {
      return ['SETTINGS_UNREADABLE', `could not read the settings revision: ${String(error)}`]
    }
    try {
      await deps.settings.mutate(route.settingsNs, ops, revision)
    } catch (error) {
      if (attempt === 0) continue
      return ['WRITE_REJECTED', String(error)]
    }

    try {
      const after = deps.settings
        .describe()
        .find((candidate) => candidate.ns === route.settingsNs)
      const profile = after?.value
      let node: unknown = profile
      for (const segment of route.settingsPath) {
        if (typeof node !== 'object' || node === null) break
        node = (node as Record<string, unknown>)[segment]
      }
      const written = typeof node === 'object' && node !== null ? (node as Record<string, unknown>)['models'] : undefined
      if (Array.isArray(written) && written.length >= models.length) return undefined
      return ['WRITE_NOT_APPLIED', 'the settings seam accepted the write but the value did not change']
    } catch {
      // Verification is best-effort; a seam that cannot answer is not a failure.
      return undefined
    }
  }
  return ['WRITE_REJECTED', 'the settings seam rejected the write twice']
}

/**
 * Create a refresh engine.
 *
 * @param deps - the host seams, the installed catalog, and the policy.
 * @returns the engine.
 */
export function createSyncEngine(deps: SyncDeps): SyncEngine {
  const refresh = async (
    trigger: string,
    options?: { signal?: AbortSignal; include?: readonly string[] },
  ): Promise<SyncReport> => {
    const signal = options?.signal
    const include = options?.include ?? deps.policy.include
    const started = Date.now()
    const outcomes: RouteOutcome[] = []

    let entries: readonly ReturnType<LlmSeam['listConfigurableProviders']>[number][]
    let descriptors: ReturnType<SettingsSeam['describe']>
    try {
      entries = deps.llm.listConfigurableProviders()
      descriptors = deps.settings.describe()
    } catch (error) {
      deps.logger.warn(`[live-catalog] could not read the live composition: ${String(error)}`)
      return {
        at: started,
        trigger,
        routes: [],
        updated: 0,
        added: 0,
        failed: 0,
        skipped: 0,
        durationMs: Date.now() - started,
      }
    }

    const reasoningRules = compileRules(deps.policy.reasoning)
    for (const refused of reasoningRules.invalid) {
      deps.logger.warn(
        `[live-catalog] reasoning rule #${String(refused.index)} was refused: ${refused.detail}`,
      )
    }

    const plan = planRoutes({
      entries,
      descriptors,
      settingsNamespaces: deps.policy.settingsNamespaces,
      include,
      exclude: deps.policy.exclude,
      ...(deps.catalog === undefined ? {} : { catalog: deps.catalog }),
    })

    for (const skipped of plan.unsupported) {
      outcomes.push({
        provider: skipped.provider,
        status: 'skipped',
        added: [],
        reasoned: [],
        kept: 0,
        reason: skipped.reason,
        detail: skipped.detail,
        durationMs: 0,
      })
    }

    if (plan.routes.length === 0) {
      deps.logger.debug?.(
        `[live-catalog] ${trigger}: no refreshable route (${String(plan.ineligible.length)} directory entry/entries not configured, ` +
          `${String(plan.unsupported.length)} unsupported)`,
      )
    }

    for (const route of plan.routes) {
      const routeStarted = Date.now()
      const base: Omit<RouteOutcome, 'status' | 'durationMs'> = {
        provider: route.provider,
        added: [],
        reasoned: [],
        kept: 0,
      }
      if (signal?.aborted === true) {
        outcomes.push({ ...base, status: 'skipped', reason: 'ABORTED', detail: 'the pass was cancelled', durationMs: 0 })
        continue
      }

      const apiKey = await resolveApiKey(deps, route)
      let listing
      try {
        listing = await listModels({
          api: route.api,
          baseURL: route.baseURL,
          timeoutMs: deps.policy.timeoutMs,
          ...(apiKey === undefined ? {} : { apiKey }),
          ...(route.headers === undefined ? {} : { headers: route.headers }),
          ...(signal === undefined ? {} : { signal }),
          ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
        })
      } catch (error) {
        const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'LISTING_ERROR'
        outcomes.push({
          ...base,
          status: 'failed',
          reason: code,
          detail: error instanceof Error ? error.message : String(error),
          durationMs: Date.now() - routeStarted,
        })
        continue
      }

      const merged = mergeAppendOnly({
        existing: route.existingModels,
        live: listing.models,
        enrichFromCatalog: deps.policy.enrichFromCatalog,
        maxModels: deps.policy.maxModels,
        ...(deps.catalog === undefined
          ? {}
          : { catalogModel: (id: string) => deps.catalog?.model(route.provider, id) }),
      })

      if (!merged.ok) {
        outcomes.push({
          ...base,
          status: 'failed',
          reason: merged.reason,
          detail: merged.detail,
          advertised: listing.models.length,
          durationMs: Date.now() - routeStarted,
        })
        continue
      }

      // Reasoning runs on the merged list, so a model appended by this pass can
      // be declared in the same write rather than needing a second one. It only
      // ever adds a field to an entry that has none; see reasoning.ts.
      let models = merged.models
      let reasoned: ReasoningApplication[] = []
      if (deps.policy.reasoning.enabled && reasoningRules.rules.length > 0) {
        const outcome = applyReasoning(models, reasoningRules.rules, {
          provider: route.provider,
          catalogKnown: (id) => deps.catalog?.model(route.provider, id) !== undefined,
        })
        models = outcome.models
        reasoned = outcome.applied
      }
      const changed = merged.changed || reasoned.length > 0

      if (!changed) {
        outcomes.push({
          ...base,
          status: 'unchanged',
          kept: merged.kept,
          advertised: listing.models.length,
          durationMs: Date.now() - routeStarted,
        })
        continue
      }

      if (deps.policy.dryRun) {
        outcomes.push({
          ...base,
          status: 'updated',
          added: merged.added,
          reasoned,
          kept: merged.kept,
          advertised: listing.models.length,
          reason: 'DRY_RUN',
          detail: 'computed but not written',
          durationMs: Date.now() - routeStarted,
        })
        continue
      }

      const failure = await writeModels(deps, route, models)
      if (failure !== undefined) {
        outcomes.push({
          ...base,
          status: 'failed',
          reason: failure[0],
          detail: failure[1],
          advertised: listing.models.length,
          durationMs: Date.now() - routeStarted,
        })
        continue
      }

      outcomes.push({
        ...base,
        status: 'updated',
        added: merged.added,
        reasoned,
        kept: merged.kept,
        advertised: listing.models.length,
        ...(merged.truncated ? { detail: `capped at ${String(deps.policy.maxModels)} models` } : {}),
        durationMs: Date.now() - routeStarted,
      })
    }

    const report: SyncReport = {
      at: started,
      trigger,
      routes: outcomes,
      updated: outcomes.filter((outcome) => outcome.status === 'updated').length,
      added: outcomes.reduce((total, outcome) => total + outcome.added.length, 0),
      failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
      skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
      durationMs: Date.now() - started,
    }

    for (const outcome of report.routes) {
      const reasoningLine =
        outcome.reasoned.length === 0
          ? ''
          : `; reasoning declared for ${String(outcome.reasoned.length)}: ` +
            outcome.reasoned
              .map((entry) => `${entry.id}=${entry.levels === 'non-reasoning' ? 'none' : entry.levels.join('/')}`)
              .join(', ')
      if (outcome.status === 'updated' && outcome.reason === 'DRY_RUN') {
        // A dry run that reported nothing would be useless: the whole point of
        // the mode is to see what a real pass would change.
        deps.logger.info(
          `[live-catalog] ${outcome.provider}: dry run — would add ${String(outcome.added.length)} model(s): ` +
            `${outcome.added.join(', ')}${reasoningLine}`,
        )
      } else if (outcome.status === 'updated') {
        deps.logger.info(
          `[live-catalog] ${outcome.provider}: +${String(outcome.added.length)} model(s) — ` +
            `${outcome.added.join(', ')}${reasoningLine}`,
        )
      } else if (outcome.status === 'failed') {
        deps.logger.warn(
          `[live-catalog] ${outcome.provider}: ${outcome.reason ?? 'FAILED'} — ${outcome.detail ?? ''}`,
        )
      }
    }
    deps.logger.debug?.(
      `[live-catalog] ${trigger}: ${String(report.updated)} updated, ${String(report.added)} added, ` +
        `${String(report.failed)} failed, ${String(report.skipped)} skipped in ${String(report.durationMs)}ms`,
    )
    return report
  }

  return { refresh }
}

/**
 * A one-line human summary of a pass, suitable for a tool result or a log.
 *
 * @param report - the pass summary.
 * @returns the rendered line.
 */
export function summarize(report: SyncReport): string {
  const reasoned = report.routes.reduce((total, route) => total + route.reasoned.length, 0)
  const parts = [
    `${String(report.routes.length)} route(s) examined`,
    `${String(report.updated)} updated`,
    `${String(report.added)} model(s) added`,
  ]
  if (reasoned > 0) parts.push(`${String(reasoned)} reasoning declaration(s) written`)
  if (report.failed > 0) parts.push(`${String(report.failed)} failed`)
  return parts.join(', ')
}
