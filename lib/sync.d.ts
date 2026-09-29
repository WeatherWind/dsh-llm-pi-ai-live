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
import type { BuiltinCatalog } from './builtin.js';
import type { CredentialsSeam, LlmSeam, Logger, SettingsSeam } from './types.js';
/** The policy one pass runs under. */
export interface SyncPolicy {
    /** Whether installed-catalog facts may fill fields the listing omitted. */
    enrichFromCatalog: boolean;
    /** Hard cap on stored model entries per route. */
    maxModels: number;
    /** Per-request network timeout in milliseconds. */
    timeoutMs: number;
    /** Compute and report, but never write. */
    dryRun: boolean;
    /** Namespaces to serve; empty means auto-detect. */
    settingsNamespaces: readonly string[];
    /** Provider routes to include; empty means all. */
    include: readonly string[];
    /** Provider routes to exclude. */
    exclude: readonly string[];
}
/** Everything one pass needs from the host. */
export interface SyncDeps {
    llm: LlmSeam;
    settings: SettingsSeam;
    credentials?: CredentialsSeam;
    catalog?: BuiltinCatalog;
    logger: Logger;
    policy: SyncPolicy;
    /** Injectable fetch, for tests. */
    fetch?: typeof globalThis.fetch;
}
/** How one route fared. */
export interface RouteOutcome {
    provider: string;
    /** `updated` wrote new ids, `unchanged` had nothing to add, `skipped` was not
     * eligible, `failed` was eligible but could not be completed. */
    status: 'updated' | 'unchanged' | 'skipped' | 'failed';
    /** Ids appended by this pass. */
    added: string[];
    /** Entries the user already had. */
    kept: number;
    /** Models the endpoint advertised, when it answered. */
    advertised?: number;
    /** Stable reason code for a skip or failure. */
    reason?: string;
    /** Human-readable detail for a skip or failure. */
    detail?: string;
    /** Wall-clock duration in milliseconds. */
    durationMs: number;
}
/** The summary of one pass. */
export interface SyncReport {
    /** Wall-clock start of the pass. */
    at: number;
    /** What triggered the pass: `startup`, `interval`, `tool`, or `manual`. */
    trigger: string;
    /** Per-route outcomes. */
    routes: RouteOutcome[];
    /** Routes that gained at least one model. */
    updated: number;
    /** Total ids appended across every route. */
    added: number;
    /** Routes that could not be completed. */
    failed: number;
    /** Routes that were not eligible. */
    skipped: number;
    /** Wall-clock duration of the whole pass. */
    durationMs: number;
}
/** A refresh engine bound to one host. */
export interface SyncEngine {
    /**
     * Run one pass.
     *
     * @param trigger - what triggered the pass, recorded in the report.
     * @param options - caller cancellation and an optional provider allow-list
     *   that replaces the policy's own `include` for this pass.
     */
    refresh(trigger: string, options?: {
        signal?: AbortSignal;
        include?: readonly string[];
    }): Promise<SyncReport>;
}
/**
 * Create a refresh engine.
 *
 * @param deps - the host seams, the installed catalog, and the policy.
 * @returns the engine.
 */
export declare function createSyncEngine(deps: SyncDeps): SyncEngine;
/**
 * A one-line human summary of a pass, suitable for a tool result or a log.
 *
 * @param report - the pass summary.
 * @returns the rendered line.
 */
export declare function summarize(report: SyncReport): string;
//# sourceMappingURL=sync.d.ts.map