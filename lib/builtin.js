/**
 * Bridge to the installed pi-ai catalog.
 *
 * A live listing endpoint reports ids and almost nothing else: it does not
 * disclose context windows, output caps, or which models accept images. The
 * installed pi-ai snapshot *does* carry those facts, which is precisely why
 * the adapter prefers the snapshot for catalog-known routes — and precisely
 * what a naive "always fetch live" client would throw away.
 *
 * This module reads the snapshot as a *metadata source* rather than as a model
 * list: live ids decide membership, catalog facts decide the fields. A missing
 * or unreadable pi-ai install is not an error — the refresh simply writes
 * thinner entries.
 *
 * The specifier is held in a variable on purpose. This package does not depend
 * on pi-ai at build time, and a literal `import()` of a package that may be
 * absent would fail type-checking against a graph this plugin does not own.
 *
 * @module dsh-llm-pi-ai-live/builtin
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
/** The pi-ai subpath that exposes the generated catalog. */
const CATALOG_SPECIFIER = '@earendil-works/pi-ai/providers/all';
/** The package whose own dependency graph is guaranteed to contain pi-ai. */
const PI_AI_HOST = '@deepseek-ai/dsh-llm-pi-ai';
/**
 * Resolve one subpath through a package's `exports` map.
 *
 * pi-ai declares its catalogue as the wildcard `"./providers/*"`, not as a
 * literal `"./providers/all"`, so a plain property lookup finds nothing and
 * the whole fallback silently yields no catalogue. This is the smallest
 * resolver that handles what a package manifest actually uses: an exact key
 * first, then the longest matching single-`*` pattern, honouring the `import`
 * condition.
 *
 * @param exportsMap - the manifest's `exports` value.
 * @param subpath - the `./`-prefixed subpath to resolve.
 * @returns the target relative path, or `undefined`.
 */
export function resolveExportSubpath(exportsMap, subpath) {
    if (typeof exportsMap !== 'object' || exportsMap === null)
        return undefined;
    const readImport = (value) => {
        if (typeof value === 'string')
            return value;
        if (typeof value === 'object' && value !== null) {
            const condition = value['import'];
            if (typeof condition === 'string')
                return condition;
        }
        return undefined;
    };
    const map = exportsMap;
    const exact = readImport(map[subpath]);
    if (exact !== undefined)
        return exact;
    let best;
    for (const [pattern, value] of Object.entries(map)) {
        const star = pattern.indexOf('*');
        if (star < 0)
            continue;
        const prefix = pattern.slice(0, star);
        const suffix = pattern.slice(star + 1);
        if (!subpath.startsWith(prefix) || !subpath.endsWith(suffix))
            continue;
        if (subpath.length < prefix.length + suffix.length)
            continue;
        const target = readImport(value);
        if (target === undefined)
            continue;
        const captured = subpath.slice(prefix.length, subpath.length - suffix.length);
        if (best === undefined || prefix.length > best.prefixLength) {
            best = { prefixLength: prefix.length, target, captured };
        }
    }
    if (best === undefined)
        return undefined;
    return best.target.replace('*', best.captured);
}
/** Where a package manager may have put pi-ai relative to a starting directory. */
const PI_AI_SUBPATH = ['@earendil-works', 'pi-ai'];
/**
 * Find the installed pi-ai entry point without going through Node's resolver.
 *
 * A bare `import()` only reaches pi-ai from a package whose own resolution
 * chain includes it. This plugin deliberately does not depend on pi-ai — it
 * degrades to endpoint-only metadata when pi-ai is absent — so in a strict,
 * non-hoisted install layout (pnpm's, which is what `dsh plugin add` produces)
 * the bare specifier can miss the copy the host already loaded.
 *
 * `require.resolve` cannot close the gap either: pi-ai exports no
 * `./package.json` and declares every subpath under the `import` condition
 * alone, so a CommonJS resolve fails with `ERR_PACKAGE_PATH_NOT_EXPORTED`.
 * Walking the directories that must contain it, and reading its own `exports`
 * map to find the entry, is the portable answer.
 *
 * @returns a file URL for the catalog entry point, or `undefined`.
 */
export function locatePiAiCatalog(startDir) {
    let dir = startDir ?? dirname(fileURLToPath(import.meta.url));
    for (let depth = 0; depth < 8; depth += 1) {
        // A hoisted (or locally installed) copy...
        const candidates = [join(dir, 'node_modules', ...PI_AI_SUBPATH)];
        // ...and pnpm's per-package layout, beside the adapter that depends on it.
        // `PI_AI_HOST` is already scoped, so no scope is joined in front of it.
        candidates.push(join(dir, 'node_modules', PI_AI_HOST, 'node_modules', ...PI_AI_SUBPATH));
        for (const candidate of candidates) {
            const manifestPath = join(candidate, 'package.json');
            if (!existsSync(manifestPath))
                continue;
            let manifest;
            try {
                manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
            }
            catch {
                continue;
            }
            const exportsMap = typeof manifest === 'object' && manifest !== null
                ? manifest['exports']
                : undefined;
            // A manifest without an `exports` map still publishes the build output;
            // the conventional location is the last resort.
            const relative = resolveExportSubpath(exportsMap, './providers/all') ?? './dist/providers/all.js';
            const entry = join(candidate, relative);
            if (!existsSync(entry))
                continue;
            return pathToFileURL(entry).href;
        }
        const parent = dirname(dir);
        if (parent === dir)
            break;
        dir = parent;
    }
    return undefined;
}
/**
 * Load the installed pi-ai catalog.
 *
 * Tries the ordinary bare specifier first — correct whenever the host's
 * resolution already exposes pi-ai, which is the common case — then falls back
 * to locating the package on disk.
 *
 * @returns the catalog view, or `undefined` when pi-ai is absent, exports no
 *   generated catalog, or answers with an unexpected shape. A `undefined`
 *   result is a supported deployment, not a failure.
 */
export async function loadBuiltinCatalog() {
    let mod;
    try {
        mod = await import(CATALOG_SPECIFIER);
    }
    catch {
        const located = locatePiAiCatalog();
        if (located === undefined)
            return undefined;
        try {
            mod = await import(located);
        }
        catch {
            return undefined;
        }
    }
    /** Read a non-empty string from an unknown value. */
    function str(value) {
        return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined;
    }
    /** Read a positive integer from an unknown value. */
    function int(value) {
        if (typeof value !== 'number' || !Number.isFinite(value))
            return undefined;
        const n = Math.trunc(value);
        return n > 0 ? n : undefined;
    }
    /** Project one raw catalog model onto the facts this plugin copies. */
    function toFacts(raw) {
        if (typeof raw !== 'object' || raw === null)
            return undefined;
        const entry = raw;
        const id = str(entry.id);
        if (id === undefined)
            return undefined;
        const facts = { id };
        const name = str(entry.name);
        if (name !== undefined && name !== id)
            facts.name = name;
        const contextWindow = int(entry.contextWindow);
        if (contextWindow !== undefined)
            facts.contextWindow = contextWindow;
        const maxTokens = int(entry.maxTokens);
        if (maxTokens !== undefined)
            facts.maxTokens = maxTokens;
        if (Array.isArray(entry.input)) {
            const input = entry.input.filter((m) => m === 'text' || m === 'image');
            if (input.length > 0)
                facts.input = input;
        }
        const api = str(entry.api);
        if (api !== undefined)
            facts.api = api;
        return facts;
    }
    if (typeof mod !== 'object' || mod === null)
        return undefined;
    const api = mod;
    const getBuiltinModels = api.getBuiltinModels;
    const getBuiltinProviders = api.getBuiltinProviders;
    const builtinProviders = api.builtinProviders;
    if (typeof getBuiltinModels !== 'function')
        return undefined;
    const calls = { getBuiltinModels };
    // Provider ids: prefer the generated key list, fall back to the constructed
    // provider objects. Either answers the same question.
    let providerIds = [];
    if (typeof getBuiltinProviders === 'function') {
        const raw = getBuiltinProviders();
        if (Array.isArray(raw))
            providerIds = raw.filter((p) => typeof p === 'string');
    }
    const baseUrls = new Map();
    if (typeof builtinProviders === 'function') {
        const raw = builtinProviders();
        if (Array.isArray(raw)) {
            for (const provider of raw) {
                if (typeof provider !== 'object' || provider === null)
                    continue;
                const record = provider;
                const id = str(record.id);
                if (id === undefined)
                    continue;
                if (!providerIds.includes(id))
                    providerIds.push(id);
                const baseUrl = str(record.baseUrl);
                if (baseUrl !== undefined)
                    baseUrls.set(id, baseUrl);
            }
        }
    }
    const modelCache = new Map();
    const modelsFor = (provider) => {
        const cached = modelCache.get(provider);
        if (cached !== undefined)
            return cached;
        const built = new Map();
        if (providerIds.includes(provider)) {
            let raw;
            try {
                raw = calls.getBuiltinModels(provider);
            }
            catch {
                raw = undefined;
            }
            if (Array.isArray(raw)) {
                for (const entry of raw) {
                    const facts = toFacts(entry);
                    if (facts !== undefined)
                        built.set(facts.id, facts);
                }
            }
        }
        modelCache.set(provider, built);
        return built;
    };
    /** The plurality value among one fact read off every model in the catalog. */
    const agreement = (provider, read) => {
        let raw;
        try {
            raw = calls.getBuiltinModels(provider);
        }
        catch {
            return undefined;
        }
        if (!Array.isArray(raw))
            return undefined;
        const counts = new Map();
        let total = 0;
        let first;
        for (const entry of raw) {
            const value = read(entry);
            if (value === undefined)
                continue;
            total += 1;
            first ??= value;
            counts.set(value, (counts.get(value) ?? 0) + 1);
        }
        if (total === 0 || first === undefined)
            return undefined;
        let best = first;
        let bestCount = 0;
        for (const [value, count] of counts) {
            if (count > bestCount) {
                best = value;
                bestCount = count;
            }
        }
        return { value: best, unanimous: counts.size === 1, count: bestCount, total };
    };
    let generatedAt;
    const generatedAtFn = api.getBuiltinModelDataGeneratedAt;
    if (typeof generatedAtFn === 'function') {
        const raw = generatedAtFn();
        generatedAt = int(raw);
    }
    const readApi = (raw) => typeof raw === 'object' && raw !== null ? str(raw['api']) : undefined;
    const readBaseUrl = (raw) => typeof raw === 'object' && raw !== null ? str(raw['baseUrl']) : undefined;
    return {
        providerBaseUrl: (provider) => {
            const direct = baseUrls.get(provider);
            if (direct !== undefined)
                return direct;
            return agreement(provider, readBaseUrl)?.value;
        },
        providerApi: (provider) => agreement(provider, readApi),
        model: (provider, modelId) => modelsFor(provider).get(modelId),
        modelCount: (provider) => modelsFor(provider).size,
        providerIds: () => [...providerIds],
        ...(generatedAt === undefined ? {} : { generatedAt }),
    };
}
//# sourceMappingURL=builtin.js.map