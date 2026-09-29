/**
 * Structural slices of the DSH host seams this plugin talks to.
 *
 * The plugin deliberately declares *shapes*, not imports: it is mounted into a
 * running harness whose packages are resolved by the profile, and a structural
 * contract keeps the build hermetic (no compile-time dependency on the host's
 * internal package graph) while still failing loudly at runtime when a seam is
 * missing. Every member below is a subset of a documented service method; none
 * is invented.
 *
 * @module dsh-llm-pi-ai-live/types
 */
/**
 * One path-addressed edit handed to `settings.mutate`. `set` writes the value
 * at `path`; `unset` removes it. Paths are addressed from the namespace's own
 * document root, so `['providers', 'openai', 'models']` names the `models`
 * field of the `openai` route.
 */
export type SettingsPathOp = {
    op: 'set';
    path: readonly string[];
    value: unknown;
} | {
    op: 'unset';
    path: readonly string[];
};
/**
 * One live settings form.
 *
 * `value` is the fully resolved configuration (schema defaults materialized);
 * `user` is the raw user-written layer, which is the only place a field that
 * the user never wrote is genuinely absent. `revision` is the optimistic-lock
 * token every write must echo back.
 */
export interface SettingsDescriptor {
    /** The profile entry id this form belongs to. */
    ns: string;
    /** Projected JSON Schema of the entry's Config. */
    schema?: unknown;
    /** Resolved live value. */
    value?: unknown;
    /** Raw user-written layer, when the seam exposes one. */
    user?: unknown;
    /** Base/inherited layer, when the seam exposes one. */
    base?: unknown;
    /** Revision used as the `expectedRevision` precondition of a write. */
    revision?: number;
}
/** The `settings` service, as this plugin uses it. */
export interface SettingsSeam {
    /** Read active plugin schemas and their live values. */
    describe(options?: {
        redactSecrets?: boolean;
    }): readonly SettingsDescriptor[];
    /** Apply path-addressed edits without restating redacted secrets. */
    mutate(ns: string, ops: readonly SettingsPathOp[], expectedRevision?: number): Promise<void>;
    /** Merge editable fields into an entry's config; used as a fallback write path. */
    update?(ns: string, patch: object, expectedRevision?: number): Promise<void>;
}
/**
 * One provider route an adapter plugin can activate through configuration.
 *
 * The directory is the reason this plugin needs no hard-coded namespace: it
 * supplies the owning plugin's `settingsNs` and the exact `settingsPath` that
 * addresses the route inside that namespace's document.
 */
export interface LlmConfigurableProvider {
    /** Provider route key a request selects with `GenerateOptions.provider`. */
    provider: string;
    /** Label shown by selector surfaces. */
    displayName: string;
    /** Settings namespace (profile entry id) that owns this route's configuration. */
    settingsNs: string;
    /** Path from the namespace document root to this route's profile. */
    settingsPath: readonly string[];
    /** Whether pi-ai ships no catalog entry under this key. */
    declared?: boolean;
    /** Resolution error retained for an unserviceable profile. */
    error?: string;
}
/** The `llm` service, as this plugin uses it. */
export interface LlmSeam {
    /** List every declared configurable provider, registered or dormant. */
    listConfigurableProviders(): readonly LlmConfigurableProvider[];
}
/** The `credentials` service, as this plugin uses it. */
export interface CredentialsSeam {
    /**
     * Resolve one credential reference (an environment-variable-style name) to
     * its current value. Resolution is per call and must not be cached.
     */
    resolve(ref: string): Promise<{
        value: string;
        source: string;
    } | undefined>;
}
/** A model-facing tool schema. */
export interface ToolSchema {
    name: string;
    description: string;
    parameters: Record<string, unknown>;
}
/** The result shape one tool execution returns to the model. */
export interface ToolOutputDefinition {
    readonly schema: unknown;
    render(args: unknown, value: unknown): readonly {
        type: 'text';
        text: string;
    }[];
}
/** The tool definition accepted by `tools.register`. */
export interface ToolDefinition extends ToolSchema {
    readonly output: ToolOutputDefinition;
    execute(args: unknown, exec: unknown): Promise<unknown>;
}
/** The `tools` service, as this plugin uses it. */
export interface ToolsSeam {
    register(definition: ToolDefinition): () => void;
}
/** Minimal logger surface, matching Cordis' `ctx.logger`. */
export interface Logger {
    debug?(...args: unknown[]): void;
    info(...args: unknown[]): void;
    warn(...args: unknown[]): void;
    error(...args: unknown[]): void;
}
/**
 * The subset of a Cordis `Context` this plugin uses.
 *
 * `get` is the optional-service accessor: a seam the deployment did not mount
 * reads as `undefined` instead of failing plugin loading, which is what lets
 * the same artifact run on a headless profile that has no `tools` service.
 * `setTimeout`/`setInterval` are mixed in by `cordis-plugin-timer` and are
 * fiber-scoped, so every timer this plugin starts is disposed with it — they
 * require `timer` to be listed in the plugin's `inject`, because Cordis throws
 * on reading a mixed-in property whose service was not declared.
 */
export interface PluginContext {
    get(name: string): unknown;
    logger?: Logger;
    setTimeout(callback: () => void, delay: number): () => void;
    setInterval(callback: () => void, delay: number): () => void;
}
//# sourceMappingURL=types.d.ts.map