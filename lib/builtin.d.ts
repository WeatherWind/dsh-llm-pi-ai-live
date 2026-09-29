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
/** The catalog facts this plugin copies onto a provider's model entries. */
export interface BuiltinModelFacts {
    /** Model id as the catalog spells it. */
    id: string;
    /** Display name. */
    name?: string;
    /** Context capacity in tokens. */
    contextWindow?: number;
    /** Output cap in tokens. */
    maxTokens?: number;
    /** Accepted request modalities. */
    input?: readonly string[];
    /** The model's wire protocol. */
    api?: string;
}
/** How a provider's models agree about one wire fact. */
export interface ProviderAgreement {
    /** The value the plurality of the provider's models carries. */
    value: string;
    /** Whether every model carries the same value. */
    unanimous: boolean;
    /** How many models carry `value`. */
    count: number;
    /** How many models the provider ships in total. */
    total: number;
}
/** A read-only view over the installed pi-ai catalog. */
export interface BuiltinCatalog {
    /**
     * The catalog endpoint for one provider route.
     *
     * pi-ai puts the endpoint on the provider record *or* on each model, and
     * several real providers use only the latter: `opencode-go` ships no
     * provider-level `baseUrl` at all, so a route configured with nothing but a
     * credential has no endpoint unless the models are consulted. The plurality
     * of the models' endpoints is used, which is also what normalizes the
     * `/v1`-suffixed and unsuffixed spellings some catalogs mix.
     */
    providerBaseUrl(provider: string): string | undefined;
    /**
     * The wire protocol the catalog assigns one provider route.
     *
     * Providers are not required to be single-protocol: `openrouter` ships both
     * `anthropic-messages` and `openai-completions` models, and `opencode-go`
     * ships three protocols. The plurality answer is returned, with `unanimous`
     * telling the caller whether it was actually unanimous.
     */
    providerApi(provider: string): ProviderAgreement | undefined;
    /** The catalog entry for one model id, when the provider ships one. */
    model(provider: string, modelId: string): BuiltinModelFacts | undefined;
    /** How many models the catalog ships for one provider route. */
    modelCount(provider: string): number;
    /** Every provider id the catalog ships. */
    providerIds(): readonly string[];
    /** Generation timestamp of the installed catalog, when it discloses one. */
    generatedAt?: number;
}
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
export declare function resolveExportSubpath(exportsMap: unknown, subpath: string): string | undefined;
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
export declare function locatePiAiCatalog(startDir?: string): string | undefined;
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
export declare function loadBuiltinCatalog(): Promise<BuiltinCatalog | undefined>;
//# sourceMappingURL=builtin.d.ts.map