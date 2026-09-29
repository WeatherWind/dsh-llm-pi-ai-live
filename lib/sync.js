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
import { listModels } from './listing.js';
import { mergeAppendOnly } from './merge.js';
import { planRoutes } from './routes.js';
/** Resolve the credential a route names, tolerating an absent credentials seam. */
async function resolveApiKey(deps, route) {
    if (route.apiKeyEnv === undefined)
        return undefined;
    if (deps.credentials === undefined)
        return undefined;
    try {
        const resolved = await deps.credentials.resolve(route.apiKeyEnv);
        return resolved?.value;
    }
    catch {
        return undefined;
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
async function writeModels(deps, route, models) {
    const ops = [{ op: 'set', path: [...route.settingsPath, 'models'], value: models }];
    for (let attempt = 0; attempt < 2; attempt += 1) {
        let revision;
        try {
            const descriptor = deps.settings
                .describe()
                .find((candidate) => candidate.ns === route.settingsNs);
            revision = descriptor?.revision;
        }
        catch (error) {
            return ['SETTINGS_UNREADABLE', `could not read the settings revision: ${String(error)}`];
        }
        try {
            await deps.settings.mutate(route.settingsNs, ops, revision);
        }
        catch (error) {
            if (attempt === 0)
                continue;
            return ['WRITE_REJECTED', String(error)];
        }
        try {
            const after = deps.settings
                .describe()
                .find((candidate) => candidate.ns === route.settingsNs);
            const profile = after?.value;
            let node = profile;
            for (const segment of route.settingsPath) {
                if (typeof node !== 'object' || node === null)
                    break;
                node = node[segment];
            }
            const written = typeof node === 'object' && node !== null ? node['models'] : undefined;
            if (Array.isArray(written) && written.length >= models.length)
                return undefined;
            return ['WRITE_NOT_APPLIED', 'the settings seam accepted the write but the value did not change'];
        }
        catch {
            // Verification is best-effort; a seam that cannot answer is not a failure.
            return undefined;
        }
    }
    return ['WRITE_REJECTED', 'the settings seam rejected the write twice'];
}
/**
 * Create a refresh engine.
 *
 * @param deps - the host seams, the installed catalog, and the policy.
 * @returns the engine.
 */
export function createSyncEngine(deps) {
    const refresh = async (trigger, options) => {
        const signal = options?.signal;
        const include = options?.include ?? deps.policy.include;
        const started = Date.now();
        const outcomes = [];
        let entries;
        let descriptors;
        try {
            entries = deps.llm.listConfigurableProviders();
            descriptors = deps.settings.describe();
        }
        catch (error) {
            deps.logger.warn(`[live-catalog] could not read the live composition: ${String(error)}`);
            return {
                at: started,
                trigger,
                routes: [],
                updated: 0,
                added: 0,
                failed: 0,
                skipped: 0,
                durationMs: Date.now() - started,
            };
        }
        const plan = planRoutes({
            entries,
            descriptors,
            settingsNamespaces: deps.policy.settingsNamespaces,
            include,
            exclude: deps.policy.exclude,
            ...(deps.catalog === undefined ? {} : { catalog: deps.catalog }),
        });
        for (const skipped of plan.unsupported) {
            outcomes.push({
                provider: skipped.provider,
                status: 'skipped',
                added: [],
                kept: 0,
                reason: skipped.reason,
                detail: skipped.detail,
                durationMs: 0,
            });
        }
        if (plan.routes.length === 0) {
            deps.logger.debug?.(`[live-catalog] ${trigger}: no refreshable route (${String(plan.ineligible.length)} directory entry/entries not configured, ` +
                `${String(plan.unsupported.length)} unsupported)`);
        }
        for (const route of plan.routes) {
            const routeStarted = Date.now();
            const base = {
                provider: route.provider,
                added: [],
                kept: 0,
            };
            if (signal?.aborted === true) {
                outcomes.push({ ...base, status: 'skipped', reason: 'ABORTED', detail: 'the pass was cancelled', durationMs: 0 });
                continue;
            }
            const apiKey = await resolveApiKey(deps, route);
            let listing;
            try {
                listing = await listModels({
                    api: route.api,
                    baseURL: route.baseURL,
                    timeoutMs: deps.policy.timeoutMs,
                    ...(apiKey === undefined ? {} : { apiKey }),
                    ...(route.headers === undefined ? {} : { headers: route.headers }),
                    ...(signal === undefined ? {} : { signal }),
                    ...(deps.fetch === undefined ? {} : { fetch: deps.fetch }),
                });
            }
            catch (error) {
                const code = typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : 'LISTING_ERROR';
                outcomes.push({
                    ...base,
                    status: 'failed',
                    reason: code,
                    detail: error instanceof Error ? error.message : String(error),
                    durationMs: Date.now() - routeStarted,
                });
                continue;
            }
            const merged = mergeAppendOnly({
                existing: route.existingModels,
                live: listing.models,
                enrichFromCatalog: deps.policy.enrichFromCatalog,
                maxModels: deps.policy.maxModels,
                ...(deps.catalog === undefined
                    ? {}
                    : { catalogModel: (id) => deps.catalog?.model(route.provider, id) }),
            });
            if (!merged.ok) {
                outcomes.push({
                    ...base,
                    status: 'failed',
                    reason: merged.reason,
                    detail: merged.detail,
                    advertised: listing.models.length,
                    durationMs: Date.now() - routeStarted,
                });
                continue;
            }
            if (!merged.changed) {
                outcomes.push({
                    ...base,
                    status: 'unchanged',
                    kept: merged.kept,
                    advertised: listing.models.length,
                    durationMs: Date.now() - routeStarted,
                });
                continue;
            }
            if (deps.policy.dryRun) {
                outcomes.push({
                    ...base,
                    status: 'updated',
                    added: merged.added,
                    kept: merged.kept,
                    advertised: listing.models.length,
                    reason: 'DRY_RUN',
                    detail: 'computed but not written',
                    durationMs: Date.now() - routeStarted,
                });
                continue;
            }
            const failure = await writeModels(deps, route, merged.models);
            if (failure !== undefined) {
                outcomes.push({
                    ...base,
                    status: 'failed',
                    reason: failure[0],
                    detail: failure[1],
                    advertised: listing.models.length,
                    durationMs: Date.now() - routeStarted,
                });
                continue;
            }
            outcomes.push({
                ...base,
                status: 'updated',
                added: merged.added,
                kept: merged.kept,
                advertised: listing.models.length,
                ...(merged.truncated ? { detail: `capped at ${String(deps.policy.maxModels)} models` } : {}),
                durationMs: Date.now() - routeStarted,
            });
        }
        const report = {
            at: started,
            trigger,
            routes: outcomes,
            updated: outcomes.filter((outcome) => outcome.status === 'updated').length,
            added: outcomes.reduce((total, outcome) => total + outcome.added.length, 0),
            failed: outcomes.filter((outcome) => outcome.status === 'failed').length,
            skipped: outcomes.filter((outcome) => outcome.status === 'skipped').length,
            durationMs: Date.now() - started,
        };
        for (const outcome of report.routes) {
            if (outcome.status === 'updated' && outcome.reason === 'DRY_RUN') {
                // A dry run that reported nothing would be useless: the whole point of
                // the mode is to see what a real pass would change.
                deps.logger.info(`[live-catalog] ${outcome.provider}: dry run — would add ${String(outcome.added.length)} model(s): ` +
                    `${outcome.added.join(', ')}`);
            }
            else if (outcome.status === 'updated') {
                deps.logger.info(`[live-catalog] ${outcome.provider}: +${String(outcome.added.length)} model(s) — ${outcome.added.join(', ')}`);
            }
            else if (outcome.status === 'failed') {
                deps.logger.warn(`[live-catalog] ${outcome.provider}: ${outcome.reason ?? 'FAILED'} — ${outcome.detail ?? ''}`);
            }
        }
        deps.logger.debug?.(`[live-catalog] ${trigger}: ${String(report.updated)} updated, ${String(report.added)} added, ` +
            `${String(report.failed)} failed, ${String(report.skipped)} skipped in ${String(report.durationMs)}ms`);
        return report;
    };
    return { refresh };
}
/**
 * A one-line human summary of a pass, suitable for a tool result or a log.
 *
 * @param report - the pass summary.
 * @returns the rendered line.
 */
export function summarize(report) {
    const parts = [
        `${String(report.routes.length)} route(s) examined`,
        `${String(report.updated)} updated`,
        `${String(report.added)} model(s) added`,
    ];
    if (report.failed > 0)
        parts.push(`${String(report.failed)} failed`);
    return parts.join(', ');
}
//# sourceMappingURL=sync.js.map