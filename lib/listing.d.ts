/**
 * Live model-listing interrogation.
 *
 * The installed adapter answers "which models can this provider serve?" from
 * pi-ai's frozen catalog for any route the catalog knows, and only reaches the
 * network for routes pi-ai has never heard of. That short-circuit is the root
 * of the drift every report on this subject describes: a gateway that ships a
 * model after the pinned pi-ai snapshot can never surface it.
 *
 * This module performs the interrogation unconditionally. It speaks the two
 * listing dialects the harness can read — OpenAI-compatible `GET {baseURL}/models`
 * and Anthropic Messages `GET {root}/v1/models` — and normalizes both into one
 * candidate shape. It never throws for an unreadable protocol: a route whose
 * protocol has no listing is reported as unsupported so the caller can skip it
 * and keep the user's configuration untouched.
 *
 * @module dsh-llm-pi-ai-live/listing
 */
/** One normalized candidate a listing endpoint advertised. */
export interface ListedModel {
    /** Request id, exactly as the endpoint spelled it. */
    id: string;
    /** Display name, when the endpoint disclosed one. */
    name?: string;
    /** Context capacity in tokens, when the endpoint disclosed one. */
    contextWindow?: number;
    /** Output cap in tokens, when the endpoint disclosed one. */
    maxTokens?: number;
}
/** A refusal that leaves the caller's configuration untouched. */
export declare class ListingError extends Error {
    readonly code: string;
    readonly status?: number;
    constructor(code: string, message: string, status?: number);
}
/** The protocols whose model listings this build can read. */
export declare const LISTABLE_PROTOCOLS: readonly string[];
/** Anthropic caps one listing page at 1,000 models, which is its maximum page size. */
export declare const ANTHROPIC_MODEL_LIMIT = 1000;
/**
 * The listing URL for one protocol and endpoint.
 *
 * Anthropic's listing lives at the API root's `/v1/models`, and gateways
 * publish that root both with and without a trailing `/v1`, so the segment is
 * normalized here. Model *requests* keep the configured `baseURL` unchanged —
 * this normalization applies to the listing URL alone.
 *
 * @param api - the route's wire protocol.
 * @param baseURL - the route's configured or catalog-supplied endpoint.
 * @returns the absolute listing URL.
 * @throws ListingError when the protocol has no readable listing.
 */
export declare function listingUrl(api: string, baseURL: string): string;
/**
 * Request headers for one listing call.
 *
 * An explicitly configured credential wins. A route with no credential is
 * still interrogated — a keyless local server is a legitimate deployment — but
 * an OpenAI-compatible endpoint generally refuses it, so the caller sees the
 * refusal rather than a silently empty catalog.
 *
 * @param api - the route's wire protocol.
 * @param apiKey - the route's resolved credential, when it has one.
 * @param headers - deployment headers configured on the route.
 * @returns the header map for the listing request.
 */
export declare function listingHeaders(api: string, apiKey: string | undefined, headers: Readonly<Record<string, string>> | undefined): Record<string, string>;
/**
 * Normalize a listing reply body into candidates, in endpoint order.
 *
 * Accepts the standard `data` array, an enriched `models` map keyed by request
 * id, and a bare array. A map key remains the request id even when its entry
 * names a different canonical id, because the key is what the endpoint routes
 * on. Primitive-valued map properties are ignored rather than guessed at.
 *
 * @param payload - the parsed JSON body.
 * @returns the normalized candidates, deduplicated by id, in encounter order.
 * @throws ListingError when the body is not a model listing at all.
 */
export declare function parseListing(payload: unknown): ListedModel[];
/** One listing interrogation request. */
export interface ListModelsRequest {
    /** Wire protocol the endpoint speaks. */
    api: string;
    /** Endpoint root; the listing path is derived from it. */
    baseURL: string;
    /** Resolved credential, when the route has one. */
    apiKey?: string;
    /** Deployment headers configured on the route. */
    headers?: Readonly<Record<string, string>>;
    /** Per-request timeout in milliseconds. */
    timeoutMs?: number;
    /** Caller cancellation, combined with the timeout. */
    signal?: AbortSignal;
    /** Injectable fetch, for tests. */
    fetch?: typeof globalThis.fetch;
    /** Injectable clock source, for tests. */
    now?: () => number;
}
/** The outcome of one successful interrogation. */
export interface ListModelsResult {
    /** Advertised models in endpoint order. */
    models: ListedModel[];
    /** The absolute URL that was interrogated. */
    url: string;
    /** Wall-clock duration of the call in milliseconds. */
    durationMs: number;
}
/**
 * Interrogate one endpoint for the models it advertises.
 *
 * The call is bounded by `timeoutMs` and by the caller's signal, whichever
 * fires first, so a hung gateway cannot stall the refresh loop.
 *
 * @param request - endpoint, protocol, credential, and bounds.
 * @returns the advertised models in endpoint order.
 * @throws ListingError for every refusal: an unreadable protocol, a non-2xx
 *   reply, an unparseable body, a timeout, or cancellation.
 */
export declare function listModels(request: ListModelsRequest): Promise<ListModelsResult>;
//# sourceMappingURL=listing.d.ts.map