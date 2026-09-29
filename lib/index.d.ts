/**
 * dsh-llm-pi-ai-live
 *
 * Keeps `llm-pi-ai` provider routes' model catalogs current with what their
 * endpoints actually serve, without patching the harness.
 *
 * Why this exists
 * ---------------
 * The shipped adapter answers "which models can this provider serve?" from the
 * installed pi-ai snapshot for every route the snapshot knows, and never
 * contacts the endpoint. That is a deliberate design choice — the snapshot
 * carries context windows and output caps a listing endpoint does not — but it
 * means a model released after the pinned pi-ai version can never appear, and
 * a route narrowed by a hand-written `models` list is frozen at whatever was
 * typed. The workaround is to hand-maintain the list; this plugin automates
 * that, and keeps the snapshot's metadata while doing it.
 *
 * What it does
 * ------------
 * On a schedule, and on request, for every configured and listable route:
 *   1. reads the live configurable-provider directory and the live settings,
 *      deriving each route's namespace and path from the harness rather than
 *      hard-coding them,
 *   2. interrogates the endpoint (`GET {baseURL}/models` for the OpenAI
 *      dialects, `GET {root}/v1/models` for Anthropic Messages),
 *   3. merges: live ids decide membership, the installed pi-ai catalog
 *      supplies `name`/`contextWindow`/`maxTokens`/`input` for ids it knows,
 *      and the user's own entries are carried through untouched, in order,
 *      with new ids appended,
 *   4. persists through `settings.mutate`, re-reading the revision first and
 *      confirming the value actually landed.
 *
 * Nothing is ever removed or rewritten. A route this plugin cannot read, reach
 * or validate is left exactly as it was and reported.
 *
 * @module dsh-llm-pi-ai-live
 */
import z from '@deepseek-ai/schemastery';
import type { PluginContext } from './types.js';
/** The plugin's Cordis name. */
export declare const name = "llm-pi-ai-live";
/**
 * `settings` is required — without it there is nowhere to write. `llm` is
 * required — without it there are no routes to find. `timer` is required for
 * `ctx.setTimeout`/`ctx.setInterval`: Cordis mixes those helpers in from the
 * timer service, and reading a mixed-in property without declaring the
 * dependency throws `cannot get property "timer" without inject` at mount.
 * It ships in `dsh-base`, so every real profile has it.
 *
 * `credentials` and `tools` are read optionally through `ctx.get`, so a
 * deployment without them still refreshes — it simply cannot resolve a
 * credential reference, and has no manual tool.
 */
export declare const inject: string[];
/** The plugin configuration. */
export interface Config {
    /** Master switch; `false` loads the plugin but schedules nothing. */
    enabled: boolean;
    /** Delay after mount before the first pass, in milliseconds; `0` runs it immediately. */
    startupDelayMs: number;
    /** Period between passes, in milliseconds; `0` disables the periodic pass. */
    intervalMs: number;
    /** Per-request network timeout in milliseconds. */
    timeoutMs: number;
    /** Namespaces to serve; empty auto-detects the pi-ai adapter's namespace. */
    settingsNamespaces: string[];
    /** Provider routes to refresh; empty means every configured route. */
    include: string[];
    /** Provider routes to leave alone. */
    exclude: string[];
    /** Whether installed-catalog metadata may fill fields the listing omitted. */
    enrichFromCatalog: boolean;
    /** Hard cap on stored model entries per route. */
    maxModels: number;
    /** Compute and report without writing; useful for a first look. */
    dryRun: boolean;
    /** Whether to register the manual refresh tool. */
    toolEnabled: boolean;
}
/** The plugin configuration schema. */
export declare const Config: z<Schemastery.ObjectS<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    startupDelayMs: z<number, number, "defined">;
    intervalMs: z<number, number, "defined">;
    timeoutMs: z<number, number, "defined">;
    settingsNamespaces: z<string[], string[], "defined">;
    include: z<string[], string[], "defined">;
    exclude: z<string[], string[], "defined">;
    enrichFromCatalog: z<boolean, boolean, "defined">;
    maxModels: z<number, number, "defined">;
    dryRun: z<boolean, boolean, "defined">;
    toolEnabled: z<boolean, boolean, "defined">;
}>>, Schemastery.ObjectT<NoInfer<{
    enabled: z<boolean, boolean, "defined">;
    startupDelayMs: z<number, number, "defined">;
    intervalMs: z<number, number, "defined">;
    timeoutMs: z<number, number, "defined">;
    settingsNamespaces: z<string[], string[], "defined">;
    include: z<string[], string[], "defined">;
    exclude: z<string[], string[], "defined">;
    enrichFromCatalog: z<boolean, boolean, "defined">;
    maxModels: z<number, number, "defined">;
    dryRun: z<boolean, boolean, "defined">;
    toolEnabled: z<boolean, boolean, "defined">;
}>>, "plain">;
/** The manual refresh tool's name. */
export declare const TOOL_NAME = "refresh_model_catalog";
/**
 * Mount the plugin.
 *
 * @param ctx - the Cordis context.
 * @param config - the validated plugin configuration.
 */
export declare function apply(ctx: PluginContext, config: Config): void;
//# sourceMappingURL=index.d.ts.map