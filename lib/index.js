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
import { loadBuiltinCatalog } from './builtin.js';
import { createSyncEngine, summarize } from './sync.js';
/** The plugin's Cordis name. */
export const name = 'llm-pi-ai-live';
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
export const inject = ['settings', 'llm', 'timer'];
/** The largest delay `setTimeout`/`setInterval` can hold without wrapping. */
const MAX_TIMER_DELAY_MS = 2_147_483_647;
/** The plugin configuration schema. */
export const Config = z.object({
    enabled: z.boolean().default(true),
    startupDelayMs: z.natural().min(0).default(10_000),
    intervalMs: z.natural().max(MAX_TIMER_DELAY_MS).default(6 * 60 * 60 * 1000),
    timeoutMs: z.natural().min(1000).max(600_000).default(30_000),
    settingsNamespaces: z.array(z.string()).default([]),
    include: z.array(z.string()).default([]),
    exclude: z.array(z.string()).default([]),
    enrichFromCatalog: z.boolean().default(true),
    maxModels: z.natural().min(1).max(10_000).default(2000),
    dryRun: z.boolean().default(false),
    toolEnabled: z.boolean().default(true),
});
/** The manual refresh tool's name. */
export const TOOL_NAME = 'refresh_model_catalog';
/** Read a service, tolerating a profile that did not mount it. */
function service(ctx, key) {
    try {
        const resolved = ctx.get(key);
        return typeof resolved === 'object' && resolved !== null ? resolved : undefined;
    }
    catch {
        return undefined;
    }
}
/** A no-op logger, used when the context exposes none. */
const SILENT = { info: () => { }, warn: () => { }, error: () => { } };
/** Build the tool definition for a manual pass. */
function manualTool(run) {
    return {
        name: TOOL_NAME,
        description: 'Refresh the provider routes\' model catalog from their live endpoints. Queries each configured ' +
            'OpenAI-compatible or Anthropic Messages route for the models it currently serves, keeps every ' +
            'existing model entry untouched, and appends models the route does not list yet with context ' +
            'window, output cap and input modalities filled in from the installed pi-ai catalog. Use this ' +
            'after a provider releases a model, or when a newly configured route does not offer it.',
        parameters: {
            type: 'object',
            properties: {
                provider: {
                    type: 'string',
                    description: 'Refresh only this provider route key (for example "openrouter"). Omit to refresh every ' +
                        'configured route.',
                },
            },
            additionalProperties: false,
        },
        output: {
            schema: {
                type: 'object',
                properties: {
                    summary: { type: 'string' },
                    updated: { type: 'integer' },
                    added: { type: 'integer' },
                    failed: { type: 'integer' },
                    skipped: { type: 'integer' },
                    routes: {
                        type: 'array',
                        items: {
                            type: 'object',
                            properties: {
                                provider: { type: 'string' },
                                status: { type: 'string' },
                                added: { type: 'array', items: { type: 'string' } },
                                reason: { type: 'string' },
                                detail: { type: 'string' },
                            },
                        },
                    },
                },
            },
            render: (_args, value) => {
                const report = value;
                if (report === undefined)
                    return [{ type: 'text', text: 'no refresh was performed' }];
                const lines = [summarize(report)];
                for (const route of report.routes) {
                    if (route.status === 'updated') {
                        lines.push(route.reason === 'DRY_RUN'
                            ? `- ${route.provider}: would add ${route.added.join(', ')} (dry run)`
                            : `- ${route.provider}: +${String(route.added.length)} → ${route.added.join(', ')}`);
                    }
                    else if (route.status === 'failed') {
                        lines.push(`- ${route.provider}: failed (${route.reason ?? 'UNKNOWN'}) ${route.detail ?? ''}`.trim());
                    }
                }
                return [{ type: 'text', text: lines.join('\n') }];
            },
        },
        execute: async (args, exec) => {
            const provider = args?.provider;
            const include = typeof provider === 'string' && provider.length > 0 ? [provider] : undefined;
            const signal = exec?.signal ?? new AbortController().signal;
            return run(include, signal);
        },
    };
}
/**
 * Mount the plugin.
 *
 * @param ctx - the Cordis context.
 * @param config - the validated plugin configuration.
 */
export function apply(ctx, config) {
    const logger = ctx.logger ?? SILENT;
    if (!config.enabled) {
        logger.info('[live-catalog] disabled by configuration');
        return;
    }
    const settings = service(ctx, 'settings');
    const llm = service(ctx, 'llm');
    if (settings === undefined || llm === undefined) {
        logger.warn('[live-catalog] the "settings" and "llm" services are both required; plugin is inert');
        return;
    }
    const credentials = service(ctx, 'credentials');
    // The installed catalog is loaded once, lazily, and only if enrichment is on:
    // importing pi-ai's generated catalog is not free, and a deployment that
    // opted out should not pay for it.
    let catalogPromise;
    const catalog = () => {
        if (!config.enrichFromCatalog)
            return Promise.resolve(undefined);
        catalogPromise ??= loadBuiltinCatalog().catch(() => undefined);
        return catalogPromise;
    };
    const policy = (include) => ({
        enrichFromCatalog: config.enrichFromCatalog,
        maxModels: config.maxModels,
        timeoutMs: config.timeoutMs,
        dryRun: config.dryRun,
        settingsNamespaces: config.settingsNamespaces,
        include,
        exclude: config.exclude,
    });
    let running = false;
    const run = async (trigger, include, signal) => {
        if (running) {
            logger.debug?.(`[live-catalog] ${trigger}: a pass is already running; skipping`);
            return {
                at: Date.now(),
                trigger,
                routes: [],
                updated: 0,
                added: 0,
                failed: 0,
                skipped: 0,
                durationMs: 0,
            };
        }
        running = true;
        try {
            const builtin = await catalog();
            const engine = createSyncEngine({
                llm,
                settings,
                logger,
                policy: policy(include ?? config.include),
                ...(credentials === undefined ? {} : { credentials }),
                ...(builtin === undefined ? {} : { catalog: builtin }),
            });
            return await engine.refresh(trigger, {
                ...(signal === undefined ? {} : { signal }),
                ...(include === undefined ? {} : { include }),
            });
        }
        catch (error) {
            logger.warn(`[live-catalog] ${trigger} pass failed: ${String(error)}`);
            return {
                at: Date.now(),
                trigger,
                routes: [],
                updated: 0,
                added: 0,
                failed: 0,
                skipped: 0,
                durationMs: 0,
            };
        }
        finally {
            running = false;
        }
    };
    const schedule = (callback, delay) => {
        if (typeof ctx.setTimeout !== 'function' || typeof ctx.setInterval !== 'function') {
            logger.warn('[live-catalog] the timer service is not mounted; automatic refresh is unavailable');
            return;
        }
        // The startup pass always runs: `startupDelayMs: 0` means "immediately",
        // not "never". Only the periodic pass has an off switch, which is
        // `intervalMs: 0`.
        ctx.setTimeout(callback, Math.min(delay, MAX_TIMER_DELAY_MS));
        if (config.intervalMs > 0)
            ctx.setInterval(callback, Math.min(config.intervalMs, MAX_TIMER_DELAY_MS));
    };
    schedule(() => {
        void run('scheduled');
    }, config.startupDelayMs);
    if (config.toolEnabled) {
        const tools = service(ctx, 'tools');
        if (tools === undefined) {
            logger.debug?.('[live-catalog] no tools service; the manual refresh tool is unavailable');
        }
        else {
            try {
                tools.register(manualTool((include, signal) => run('tool', include, signal)));
            }
            catch (error) {
                logger.warn(`[live-catalog] could not register the manual refresh tool: ${String(error)}`);
            }
        }
    }
    const cadence = config.intervalMs > 0
        ? `first pass in ${String(config.startupDelayMs)}ms, then every ${String(config.intervalMs)}ms`
        : `first pass in ${String(config.startupDelayMs)}ms, periodic refresh off`;
    logger.info(`[live-catalog] mounted (${cadence}${config.dryRun ? ', dry run' : ''})`);
}
//# sourceMappingURL=index.js.map