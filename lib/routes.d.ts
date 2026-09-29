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
import type { BuiltinCatalog } from './builtin.js';
import type { LlmConfigurableProvider, SettingsDescriptor } from './types.js';
/** A provider route profile, read structurally from the settings value. */
export interface RouteProfile {
    /** Endpoint override; absent defers to the installed catalog. */
    baseURL?: unknown;
    /** Wire protocol override. */
    api?: unknown;
    /** Credential reference resolved per request. */
    apiKeyEnv?: unknown;
    /** Deployment headers sent with every request for this route. */
    headers?: unknown;
    /** The route's configured model list, if any. */
    models?: unknown;
    [key: string]: unknown;
}
/** One configured route that can be refreshed over the wire. */
export interface PlannedRoute {
    /** Provider route key. */
    provider: string;
    /** Label shown by selector surfaces. */
    displayName: string;
    /** Settings namespace owning this route. */
    settingsNs: string;
    /** Path from the namespace document root to this route's profile. */
    settingsPath: readonly string[];
    /** Revision of the owning namespace, echoed back as the write precondition. */
    revision: number | undefined;
    /** Effective endpoint the listing is derived from. */
    baseURL: string;
    /** Effective wire protocol used for the listing request. */
    api: string;
    /** Where `api` came from. */
    apiSource: 'route' | 'catalog' | 'mixed-majority';
    /** Credential reference, when the route names one. */
    apiKeyEnv?: string;
    /** Deployment headers configured on the route. */
    headers?: Record<string, string>;
    /** The effective `models` value, as stored. */
    existingModels: unknown;
    /** Whether the installed catalog ships this provider. */
    catalogKnown: boolean;
}
/** Why one directory entry was left alone. */
export interface SkippedRoute {
    provider: string;
    /** Stable reason code. */
    reason: string;
    /** Human-readable detail. */
    detail: string;
}
/** A planning request. */
export interface PlanRequest {
    /** The live configurable-provider directory. */
    entries: readonly LlmConfigurableProvider[];
    /** The live settings descriptors. */
    descriptors: readonly SettingsDescriptor[];
    /** Namespaces to serve; empty means auto-detect. */
    settingsNamespaces: readonly string[];
    /** Provider routes to include; empty means all. */
    include: readonly string[];
    /** Provider routes to exclude. */
    exclude: readonly string[];
    /** The installed catalog, when available. */
    catalog?: BuiltinCatalog;
}
/** A planning result. */
export interface PlanResult {
    /** Routes that can be interrogated and updated. */
    routes: PlannedRoute[];
    /**
     * Configured routes this build cannot interrogate — no endpoint, no
     * protocol, or a protocol without a readable listing. These are reported,
     * because a user who configured the route expects to hear about it.
     */
    unsupported: SkippedRoute[];
    /**
     * Directory entries that are none of this plugin's business: offered by a
     * catalog but never configured, filtered out, or owned by another namespace.
     * A stock profile offers dozens of these and they mean nothing to a refresh,
     * so they are kept out of the report.
     */
    ineligible: SkippedRoute[];
    /** The namespaces this plan will write into. */
    namespaces: string[];
}
/** The protocol a route's listing is interrogated with, and where it came from. */
export interface ResolvedApi {
    value: string;
    /** `route` when the profile named it, `catalog` when the catalog is of one
     *  mind, `mixed-majority` when the catalog disagrees with itself. */
    source: 'route' | 'catalog' | 'mixed-majority';
}
/**
 * Plan a refresh pass.
 *
 * @param request - the live directory, settings descriptors, and filters.
 * @returns the routes to interrogate and the entries left alone.
 */
export declare function planRoutes(request: PlanRequest): PlanResult;
//# sourceMappingURL=routes.d.ts.map