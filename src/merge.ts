/**
 * Append-only catalog merge.
 *
 * This is the pure heart of the plugin, and it is deliberately paranoid. The
 * value it produces is written back into the user's own configuration through
 * the settings seam, so the two failure modes that matter are *losing a model
 * the user wrote by hand* and *writing an entry the adapter's strict
 * validation will refuse*. Every rule below exists to make one of those
 * impossible:
 *
 * - Existing entries are carried through by reference, in order, untouched.
 *   Nothing is ever removed, reordered, or rewritten — not even a duplicate or
 *   an entry with fields this plugin does not understand.
 * - If the existing value cannot be read as a list of model entries, the merge
 *   *refuses* instead of guessing. A refusal leaves the configuration exactly
 *   as it was.
 * - New entries carry only fields with a settled meaning in the route profile
 *   schema (`id`, `name`, `contextWindow`, `maxTokens`, `input`). Reasoning
 *   levels and wire-compatibility switches are deliberately never synthesized:
 *   an entry that leaves them unset inherits the installed catalog entry's
 *   capability, which is always at least as correct as anything derivable from
 *   a bare listing.
 *
 * @module dsh-llm-pi-ai-live/merge
 */

import type { BuiltinModelFacts } from './builtin.js'
import type { ListedModel } from './listing.js'

/** The route-profile fields this plugin is willing to synthesize. */
export interface ModelEntry {
  id: string
  name?: string
  contextWindow?: number
  maxTokens?: number
  input?: string[]
}

/** One merge request. */
export interface MergeRequest {
  /** The raw user-written `models` value for the route, exactly as stored. */
  existing: unknown
  /** Models the endpoint advertised, in endpoint order. */
  live: readonly ListedModel[]
  /** Catalog lookup for one model id, when the installed catalog ships the provider. */
  catalogModel?: (id: string) => BuiltinModelFacts | undefined
  /** Whether catalog facts may supply fields the listing did not. */
  enrichFromCatalog: boolean
  /** Hard cap on the stored list length. */
  maxModels: number
}

/** The outcome of one merge. */
export type MergeOutcome =
  | {
      ok: true
      /** The complete list to store: existing entries first, then new ones. */
      models: unknown[]
      /** Ids appended by this merge, in the order they were appended. */
      added: string[]
      /** How many entries the user already had. */
      kept: number
      /** Whether the endpoint offered more models than the cap allowed. */
      truncated: boolean
      /** Whether anything would actually change on disk. */
      changed: boolean
    }
  | {
      ok: false
      /** A stable reason code; the caller logs it and leaves the route alone. */
      reason: string
      /** Human-readable detail. */
      detail: string
    }

/** Read a positive integer from an unknown value. */
function positiveInt(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined
  const n = Math.trunc(value)
  return n > 0 ? n : undefined
}

/** Keep only modalities the route profile schema accepts. */
function modalities(value: unknown): string[] | undefined {
  if (!Array.isArray(value)) return undefined
  const out = value.filter((m): m is string => m === 'text' || m === 'image')
  return out.length > 0 ? out : undefined
}

/** Whether a value is a plain object that can be carried through verbatim. */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * Read the user's existing `models` value.
 *
 * `undefined` is the common case and means "the route serves the installed
 * catalog unchanged" — the merge then appends to an empty list, which is what
 * turns the route into an explicitly pinned one. Anything else must be an
 * array whose every element is an object carrying a non-empty `id`; a list
 * this plugin cannot fully account for is refused rather than partially
 * rewritten.
 */
function readExisting(existing: unknown): { ok: true; entries: unknown[] } | { ok: false; detail: string } {
  if (existing === undefined || existing === null) return { ok: true, entries: [] }
  if (!Array.isArray(existing)) {
    return { ok: false, detail: `the stored "models" value is a ${typeof existing}, not a list` }
  }
  for (let index = 0; index < existing.length; index += 1) {
    const entry = existing[index]
    if (!isPlainObject(entry)) {
      return { ok: false, detail: `models[${String(index)}] is not an object` }
    }
    const id = entry['id']
    if (typeof id !== 'string' || id.trim().length === 0) {
      return { ok: false, detail: `models[${String(index)}] has no usable "id"` }
    }
  }
  return { ok: true, entries: [...existing] }
}

/**
 * Build one new entry for a model the route does not serve yet.
 *
 * Catalog facts win over listing facts: the installed snapshot carries the
 * capacities a listing endpoint omits, and where both speak the snapshot is
 * the vendor's own number rather than a gateway's summary of it.
 */
function buildEntry(
  live: ListedModel,
  facts: BuiltinModelFacts | undefined,
): ModelEntry {
  const entry: ModelEntry = { id: live.id }
  const name = facts?.name ?? live.name
  if (name !== undefined && name.length > 0 && name !== live.id) entry.name = name
  const contextWindow = positiveInt(facts?.contextWindow) ?? positiveInt(live.contextWindow)
  if (contextWindow !== undefined) entry.contextWindow = contextWindow
  const maxTokens = positiveInt(facts?.maxTokens) ?? positiveInt(live.maxTokens)
  if (maxTokens !== undefined) entry.maxTokens = maxTokens
  const input = modalities(facts?.input)
  if (input !== undefined) entry.input = input
  return entry
}

/**
 * Append the endpoint's models to the user's list, enriching each new entry
 * from the installed catalog.
 *
 * @param request - the existing value, the live listing, and the merge policy.
 * @returns the merged list, or a refusal that must leave the route untouched.
 */
export function mergeAppendOnly(request: MergeRequest): MergeOutcome {
  const read = readExisting(request.existing)
  if (!read.ok) return { ok: false, reason: 'EXISTING_UNREADABLE', detail: read.detail }
  const entries = read.entries
  // Captured before the append loop: `entries` grows in place, so reading its
  // length afterwards would count the models this merge just added.
  const kept = entries.length

  const present = new Set<string>()
  for (const entry of entries) {
    present.add((entry as Record<string, unknown>)['id'] as string)
  }

  const added: string[] = []
  let truncated = false
  for (const live of request.live) {
    if (kept + added.length >= request.maxModels) {
      truncated = true
      break
    }
    if (present.has(live.id)) continue
    present.add(live.id)
    const facts =
      request.enrichFromCatalog && request.catalogModel !== undefined
        ? request.catalogModel(live.id)
        : undefined
    entries.push(buildEntry(live, facts))
    added.push(live.id)
  }

  return {
    ok: true,
    models: entries,
    added,
    kept,
    truncated,
    changed: added.length > 0,
  }
}
