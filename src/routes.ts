/**
 * Route planning: which configured provider routes can be refreshed, and how
 * each one is addressed.
 *
 * Two facts make this module necessary.
 *
 * First, the settings namespace is a *profile entry id*, not a plugin name.
 * The bundled pi-ai adapter registers its namespace as
 * `ctx.fiber.entry?.options.id ?? 'llm-pi-ai'`, which resolves to something
 * like `include:llm-pi-ai` in a stock profile — so any plugin that hard-codes
 * `'llm-pi-ai'` silently does nothing. The llm service's configurable-provider
 * directory is the supported way to learn the real key, and it hands back the
 * exact `settingsPath` that addresses each route's profile.
 *
 * Second, a directory entry is not a configured route. pi-ai declares every
 * provider in its installed catalog whether or not the user configured it, so
 * planning must resolve each entry's profile out of the live settings value
 * and drop the ones that are merely *offered*.
 *
 * @module dsh-llm-pi-ai-live/routes
 */

import type { BuiltinCatalog } from './builtin.js'
import { LISTABLE_PROTOCOLS } from './listing.js'
import type { LlmConfigurableProvider, SettingsDescriptor } from './types.js'

/** A provider route profile, read structurally from the settings value. */
export interface RouteProfile {
  /** Endpoint override; absent defers to the installed catalog. */
  baseURL?: unknown
  /** Wire protocol override. */
  api?: unknown
  /** Credential reference resolved per request. */
  apiKeyEnv?: unknown
  /** Deployment headers sent with every request for this route. */
  headers?: unknown
  /** The route's configured model list, if any. */
  models?: unknown
  [key: string]: unknown
}

/** One configured route that can be refreshed over the wire. */
export interface PlannedRoute {
  /** Provider route key. */
  provider: string
  /** Label shown by selector surfaces. */
  displayName: string
  /** Settings namespace owning this route. */
  settingsNs: string
  /** Path from the namespace document root to this route's profile. */
  settingsPath: readonly string[]
  /** Revision of the owning namespace, echoed back as the write precondition. */
  revision: number | undefined
  /** Effective endpoint the listing is derived from. */
  baseURL: string
  /** Effective wire protocol used for the listing request. */
  api: string
  /** Where `api` came from. */
  apiSource: 'route' | 'catalog' | 'mixed-majority'
  /** Credential reference, when the route names one. */
  apiKeyEnv?: string
  /** Deployment headers configured on the route. */
  headers?: Record<string, string>
  /** The effective `models` value, as stored. */
  existingModels: unknown
  /** Whether the installed catalog ships this provider. */
  catalogKnown: boolean
}

/** Why one directory entry was left alone. */
export interface SkippedRoute {
  provider: string
  /** Stable reason code. */
  reason: string
  /** Human-readable detail. */
  detail: string
}

/** A planning request. */
export interface PlanRequest {
  /** The live configurable-provider directory. */
  entries: readonly LlmConfigurableProvider[]
  /** The live settings descriptors. */
  descriptors: readonly SettingsDescriptor[]
  /** Namespaces to serve; empty means auto-detect. */
  settingsNamespaces: readonly string[]
  /** Provider routes to include; empty means all. */
  include: readonly string[]
  /** Provider routes to exclude. */
  exclude: readonly string[]
  /** The installed catalog, when available. */
  catalog?: BuiltinCatalog
}

/** A planning result. */
export interface PlanResult {
  /** Routes that can be interrogated and updated. */
  routes: PlannedRoute[]
  /**
   * Configured routes this build cannot interrogate — no endpoint, no
   * protocol, or a protocol without a readable listing. These are reported,
   * because a user who configured the route expects to hear about it.
   */
  unsupported: SkippedRoute[]
  /**
   * Directory entries that are none of this plugin's business: offered by a
   * catalog but never configured, filtered out, or owned by another namespace.
   * A stock profile offers dozens of these and they mean nothing to a refresh,
   * so they are kept out of the report.
   */
  ineligible: SkippedRoute[]
  /** The namespaces this plan will write into. */
  namespaces: string[]
}

/** Follow a path through nested plain objects. */
function navigate(root: unknown, path: readonly string[]): unknown {
  let node = root
  for (const segment of path) {
    if (typeof node !== 'object' || node === null || Array.isArray(node)) return undefined
    node = (node as Record<string, unknown>)[segment]
  }
  return node
}

/**
 * Decide which namespaces to serve.
 *
 * The pi-ai adapter marks every directory entry it owns with `declared`, the
 * flag that tells a hand-declared route from a narrowed catalog route. No
 * other adapter sets it. Auto-detection therefore keys on that flag, and falls
 * back to every namespace when no entry carries it — a build that renamed the
 * flag still gets served, and the per-route endpoint check below keeps the
 * fallback safe.
 */
function resolveNamespaces(entries: readonly LlmConfigurableProvider[], configured: readonly string[]): Set<string> {
  if (configured.length > 0) return new Set(configured)
  const auto = new Set<string>()
  for (const entry of entries) {
    if (entry.declared !== undefined) auto.add(entry.settingsNs)
  }
  if (auto.size > 0) return auto
  return new Set(entries.map((entry) => entry.settingsNs))
}

/** Narrow an unknown to a string-to-string record, dropping anything else. */
function stringRecord(value: unknown): Record<string, string> | undefined {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return undefined
  const out: Record<string, string> = {}
  for (const [key, entry] of Object.entries(value as Record<string, unknown>)) {
    if (typeof entry === 'string' && entry.length > 0) out[key] = entry
  }
  return Object.keys(out).length > 0 ? out : undefined
}

/** The protocol a route's listing is interrogated with, and where it came from. */
export interface ResolvedApi {
  value: string
  /** `route` when the profile named it, `catalog` when the catalog is of one
   *  mind, `mixed-majority` when the catalog disagrees with itself. */
  source: 'route' | 'catalog' | 'mixed-majority'
}

/**
 * Decide which listing dialect to interrogate a route with.
 *
 * A profile that names its own protocol always wins. Otherwise the catalog
 * answers — but real catalog providers are not single-protocol (`openrouter`
 * ships both an Anthropic and an OpenAI dialect; `opencode-go` ships three),
 * so the plurality answer is used and the route's own models keep their
 * individual protocols regardless. The listing endpoint is a property of the
 * *gateway*, and a gateway that speaks several protocols still publishes one
 * model list.
 */
function resolveApi(
  route: RouteProfile,
  catalog: BuiltinCatalog | undefined,
  provider: string,
): ResolvedApi | undefined {
  if (typeof route.api === 'string' && route.api.trim().length > 0) {
    return { value: route.api.trim(), source: 'route' }
  }
  const fromCatalog = catalog?.providerApi(provider)
  if (fromCatalog === undefined) return undefined
  return { value: fromCatalog.value, source: fromCatalog.unanimous ? 'catalog' : 'mixed-majority' }
}

/**
 * Plan a refresh pass.
 *
 * @param request - the live directory, settings descriptors, and filters.
 * @returns the routes to interrogate and the entries left alone.
 */
export function planRoutes(request: PlanRequest): PlanResult {
  const namespaces = resolveNamespaces(request.entries, request.settingsNamespaces)
  const include = new Set(request.include)
  const exclude = new Set(request.exclude)
  const descriptors = new Map(request.descriptors.map((descriptor) => [descriptor.ns, descriptor]))

  const routes: PlannedRoute[] = []
  const unsupported: SkippedRoute[] = []
  const ineligible: SkippedRoute[] = []
  const usedNamespaces = new Set<string>()

  for (const entry of request.entries) {
    const provider = entry.provider
    /** Record a route the user configured but this build cannot serve. */
    const reportSkip = (reason: string, detail: string): void => {
      unsupported.push({ provider, reason, detail })
    }
    /** Record a directory entry that was never this plugin's business. */
    const ignore = (reason: string, detail: string): void => {
      ineligible.push({ provider, reason, detail })
    }

    if (!namespaces.has(entry.settingsNs)) {
      ignore('FOREIGN_NAMESPACE', `namespace "${entry.settingsNs}" is not served`)
      continue
    }
    if (include.size > 0 && !include.has(provider)) {
      ignore('NOT_INCLUDED', 'not named by the include list')
      continue
    }
    if (exclude.has(provider)) {
      ignore('EXCLUDED', 'excluded by configuration')
      continue
    }

    const descriptor = descriptors.get(entry.settingsNs)
    if (descriptor === undefined) {
      ignore('NO_SETTINGS_DESCRIPTOR', `namespace "${entry.settingsNs}" has no live settings form`)
      continue
    }

    const profile = navigate(descriptor.value, entry.settingsPath)
    if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
      ignore('NOT_CONFIGURED', 'the user has not configured this route')
      continue
    }
    const route = profile as RouteProfile

    const catalog = request.catalog
    const baseURL =
      (typeof route.baseURL === 'string' && route.baseURL.trim().length > 0 ? route.baseURL.trim() : undefined) ??
      catalog?.providerBaseUrl(provider)
    if (baseURL === undefined) {
      reportSkip('NO_ENDPOINT', 'the route declares no baseURL and the installed catalog supplies none')
      continue
    }

    const api = resolveApi(route, request.catalog, provider)
    if (api === undefined) {
      reportSkip('NO_PROTOCOL', 'the route declares no api and the installed catalog supplies none')
      continue
    }
    if (!LISTABLE_PROTOCOLS.includes(api.value)) {
      reportSkip('DISCOVERY_UNSUPPORTED', `protocol "${api.value}" has no model listing this build can read`)
      continue
    }

    const apiKeyEnv =
      typeof route.apiKeyEnv === 'string' && route.apiKeyEnv.trim().length > 0 ? route.apiKeyEnv.trim() : undefined

    const planned: PlannedRoute = {
      provider,
      displayName: entry.displayName,
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath,
      revision: descriptor.revision,
      baseURL,
      api: api.value,
      apiSource: api.source,
      // Pass the value through whenever the key is *present*, even when it is
      // not a list: the merge refuses such a value, and filtering it here
      // would silently replace whatever the user actually stored.
      existingModels: 'models' in route ? route.models : undefined,
      catalogKnown: (catalog?.modelCount(provider) ?? 0) > 0,
    }
    if (apiKeyEnv !== undefined) planned.apiKeyEnv = apiKeyEnv
    const headers = stringRecord(route.headers)
    if (headers !== undefined) planned.headers = headers

    routes.push(planned)
    usedNamespaces.add(entry.settingsNs)
  }

  return { routes, unsupported, ineligible, namespaces: [...usedNamespaces] }
}
