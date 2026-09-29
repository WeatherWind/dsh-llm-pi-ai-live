/**
 * Append-only catalog merge.
 *
 * This is the pure heart of the plugin, and it is deliberately paranoid. The
 * value it produces is written back into the user's own configuration through
 * the settings seam, so the two failure modes that matter are *losing a model
 * the user wrote by hand* and *writing an entry the adapter's strict
 * validation will refuse*. Every rule below exists to make one of those
 * impossible:
 *
 * - Existing entries are carried through by reference, in order, untouched.
 *   Nothing is ever removed, reordered, or rewritten — not even a duplicate or
 *   an entry with fields this plugin does not understand.
 * - If the existing value cannot be read as a list of model entries, the merge
 *   *refuses* instead of guessing. A refusal leaves the configuration exactly
 *   as it was.
 * - New entries carry only fields with a settled meaning in the route profile
 *   schema (`id`, `name`, `contextWindow`, `maxTokens`, `input`). Reasoning
 *   levels and wire-compatibility switches are deliberately never synthesized:
 *   an entry that leaves them unset inherits the installed catalog entry's
 *   capability, which is always at least as correct as anything derivable from
 *   a bare listing.
 *
 * @module dsh-llm-pi-ai-live/merge
 */
import type { BuiltinModelFacts } from './builtin.js';
import type { ListedModel } from './listing.js';
/** The route-profile fields this plugin is willing to synthesize. */
export interface ModelEntry {
    id: string;
    name?: string;
    contextWindow?: number;
    maxTokens?: number;
    input?: string[];
}
/** One merge request. */
export interface MergeRequest {
    /** The raw user-written `models` value for the route, exactly as stored. */
    existing: unknown;
    /** Models the endpoint advertised, in endpoint order. */
    live: readonly ListedModel[];
    /** Catalog lookup for one model id, when the installed catalog ships the provider. */
    catalogModel?: (id: string) => BuiltinModelFacts | undefined;
    /** Whether catalog facts may supply fields the listing did not. */
    enrichFromCatalog: boolean;
    /** Hard cap on the stored list length. */
    maxModels: number;
}
/** The outcome of one merge. */
export type MergeOutcome = {
    ok: true;
    /** The complete list to store: existing entries first, then new ones. */
    models: unknown[];
    /** Ids appended by this merge, in the order they were appended. */
    added: string[];
    /** How many entries the user already had. */
    kept: number;
    /** Whether the endpoint offered more models than the cap allowed. */
    truncated: boolean;
    /** Whether anything would actually change on disk. */
    changed: boolean;
} | {
    ok: false;
    /** A stable reason code; the caller logs it and leaves the route alone. */
    reason: string;
    /** Human-readable detail. */
    detail: string;
};
/**
 * Append the endpoint's models to the user's list, enriching each new entry
 * from the installed catalog.
 *
 * @param request - the existing value, the live listing, and the merge policy.
 * @returns the merged list, or a refusal that must leave the route untouched.
 */
export declare function mergeAppendOnly(request: MergeRequest): MergeOutcome;
//# sourceMappingURL=merge.d.ts.map