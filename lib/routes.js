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
import { LISTABLE_PROTOCOLS } from './listing.js';
/** Follow a path through nested plain objects. */
function navigate(root, path) {
    let node = root;
    for (const segment of path) {
        if (typeof node !== 'object' || node === null || Array.isArray(node))
            return undefined;
        node = node[segment];
    }
    return node;
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
function resolveNamespaces(entries, configured) {
    if (configured.length > 0)
        return new Set(configured);
    const auto = new Set();
    for (const entry of entries) {
        if (entry.declared !== undefined)
            auto.add(entry.settingsNs);
    }
    if (auto.size > 0)
        return auto;
    return new Set(entries.map((entry) => entry.settingsNs));
}
/** Narrow an unknown to a string-to-string record, dropping anything else. */
function stringRecord(value) {
    if (typeof value !== 'object' || value === null || Array.isArray(value))
        return undefined;
    const out = {};
    for (const [key, entry] of Object.entries(value)) {
        if (typeof entry === 'string' && entry.length > 0)
            out[key] = entry;
    }
    return Object.keys(out).length > 0 ? out : undefined;
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
function resolveApi(route, catalog, provider) {
    if (typeof route.api === 'string' && route.api.trim().length > 0) {
        return { value: route.api.trim(), source: 'route' };
    }
    const fromCatalog = catalog?.providerApi(provider);
    if (fromCatalog === undefined)
        return undefined;
    return { value: fromCatalog.value, source: fromCatalog.unanimous ? 'catalog' : 'mixed-majority' };
}
/**
 * Plan a refresh pass.
 *
 * @param request - the live directory, settings descriptors, and filters.
 * @returns the routes to interrogate and the entries left alone.
 */
export function planRoutes(request) {
    const namespaces = resolveNamespaces(request.entries, request.settingsNamespaces);
    const include = new Set(request.include);
    const exclude = new Set(request.exclude);
    const descriptors = new Map(request.descriptors.map((descriptor) => [descriptor.ns, descriptor]));
    const routes = [];
    const unsupported = [];
    const ineligible = [];
    const usedNamespaces = new Set();
    for (const entry of request.entries) {
        const provider = entry.provider;
        /** Record a route the user configured but this build cannot serve. */
        const reportSkip = (reason, detail) => {
            unsupported.push({ provider, reason, detail });
        };
        /** Record a directory entry that was never this plugin's business. */
        const ignore = (reason, detail) => {
            ineligible.push({ provider, reason, detail });
        };
        if (!namespaces.has(entry.settingsNs)) {
            ignore('FOREIGN_NAMESPACE', `namespace "${entry.settingsNs}" is not served`);
            continue;
        }
        if (include.size > 0 && !include.has(provider)) {
            ignore('NOT_INCLUDED', 'not named by the include list');
            continue;
        }
        if (exclude.has(provider)) {
            ignore('EXCLUDED', 'excluded by configuration');
            continue;
        }
        const descriptor = descriptors.get(entry.settingsNs);
        if (descriptor === undefined) {
            ignore('NO_SETTINGS_DESCRIPTOR', `namespace "${entry.settingsNs}" has no live settings form`);
            continue;
        }
        const profile = navigate(descriptor.value, entry.settingsPath);
        if (typeof profile !== 'object' || profile === null || Array.isArray(profile)) {
            ignore('NOT_CONFIGURED', 'the user has not configured this route');
            continue;
        }
        const route = profile;
        const catalog = request.catalog;
        const baseURL = (typeof route.baseURL === 'string' && route.baseURL.trim().length > 0 ? route.baseURL.trim() : undefined) ??
            catalog?.providerBaseUrl(provider);
        if (baseURL === undefined) {
            reportSkip('NO_ENDPOINT', 'the route declares no baseURL and the installed catalog supplies none');
            continue;
        }
        const api = resolveApi(route, request.catalog, provider);
        if (api === undefined) {
            reportSkip('NO_PROTOCOL', 'the route declares no api and the installed catalog supplies none');
            continue;
        }
        if (!LISTABLE_PROTOCOLS.includes(api.value)) {
            reportSkip('DISCOVERY_UNSUPPORTED', `protocol "${api.value}" has no model listing this build can read`);
            continue;
        }
        const apiKeyEnv = typeof route.apiKeyEnv === 'string' && route.apiKeyEnv.trim().length > 0 ? route.apiKeyEnv.trim() : undefined;
        const planned = {
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
        };
        if (apiKeyEnv !== undefined)
            planned.apiKeyEnv = apiKeyEnv;
        const headers = stringRecord(route.headers);
        if (headers !== undefined)
            planned.headers = headers;
        routes.push(planned);
        usedNamespaces.add(entry.settingsNs);
    }
    return { routes, unsupported, ineligible, namespaces: [...usedNamespaces] };
}
//# sourceMappingURL=routes.js.map