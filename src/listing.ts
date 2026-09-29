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
  id: string
  /** Display name, when the endpoint disclosed one. */
  name?: string
  /** Context capacity in tokens, when the endpoint disclosed one. */
  contextWindow?: number
  /** Output cap in tokens, when the endpoint disclosed one. */
  maxTokens?: number
}

/** A refusal that leaves the caller's configuration untouched. */
export class ListingError extends Error {
  readonly code: string
  readonly status?: number

  constructor(code: string, message: string, status?: number) {
    super(message)
    this.name = 'ListingError'
    this.code = code
    if (status !== undefined) this.status = status
  }
}

/** The protocols whose model listings this build can read. */
export const LISTABLE_PROTOCOLS: readonly string[] = [
  'openai-completions',
  'openai-responses',
  'anthropic-messages',
]

/** The subset of the OpenAI Responses family that shares the completions listing dialect. */
const OPENAI_FAMILY = new Set([
  'openai-completions',
  'openai-responses',
  'azure-openai-responses',
  'openai-codex-responses',
])

/** Anthropic caps one listing page at 1,000 models, which is its maximum page size. */
export const ANTHROPIC_MODEL_LIMIT = 1000

/** Remove trailing slashes without touching the scheme's `//`. */
function trimTrailingSlashes(url: string): string {
  let end = url.length
  while (end > 0 && url.charCodeAt(end - 1) === 47 /* '/' */) end -= 1
  return url.slice(0, end)
}

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
export function listingUrl(api: string, baseURL: string): string {
  const base = trimTrailingSlashes(baseURL.trim())
  if (base.length === 0) throw new ListingError('NO_ENDPOINT', 'the route has no baseURL to interrogate')
  if (OPENAI_FAMILY.has(api)) return `${base}/models`
  if (api === 'anthropic-messages') {
    const root = base.endsWith('/v1') ? base.slice(0, -3) : base
    return `${root}/v1/models?limit=${String(ANTHROPIC_MODEL_LIMIT)}`
  }
  throw new ListingError('DISCOVERY_UNSUPPORTED', `protocol "${api}" has no model listing this build can read`)
}

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
export function listingHeaders(
  api: string,
  apiKey: string | undefined,
  headers: Readonly<Record<string, string>> | undefined,
): Record<string, string> {
  const out: Record<string, string> = { accept: 'application/json' }
  if (api === 'anthropic-messages') {
    out['anthropic-version'] = '2023-06-01'
    if (apiKey !== undefined && apiKey.length > 0) out['x-api-key'] = apiKey
  } else if (apiKey !== undefined && apiKey.length > 0) {
    out['authorization'] = `Bearer ${apiKey}`
  }
  // Deployment headers ride last so an operator's explicit value wins, but a
  // header the credential path already set is never clobbered by an empty one.
  for (const [key, value] of Object.entries(headers ?? {})) {
    if (typeof value !== 'string' || value.length === 0) continue
    out[key.toLowerCase()] = value
  }
  return out
}

/** Read a positive integer from an unknown value, ignoring anything else. */
function positiveInt(value: unknown): number | undefined {
  if (typeof value === 'number' && Number.isFinite(value)) {
    const n = Math.trunc(value)
    return n > 0 ? n : undefined
  }
  if (typeof value === 'string' && value.trim().length > 0) {
    const n = Number(value)
    if (Number.isFinite(n)) {
      const t = Math.trunc(n)
      return t > 0 ? t : undefined
    }
  }
  return undefined
}

/** Read a non-empty string from an unknown value. */
function nonEmptyString(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim() : undefined
}

/**
 * The first present capacity among several spellings.
 *
 * Listing dialects disagree about these names — OpenAI-compatible gateways
 * publish `context_length`, Anthropic publishes `max_input_tokens`, and
 * aggregators nest both under `top_provider` — so one candidate is assembled
 * from every spelling instead of one dialect.
 */
function firstCapacity(candidates: readonly unknown[]): number | undefined {
  for (const candidate of candidates) {
    const value = positiveInt(candidate)
    if (value !== undefined) return value
  }
  return undefined
}

/** Extract one candidate from a raw listing entry. */
function toCandidate(raw: unknown, fallbackId?: string): ListedModel | undefined {
  if (typeof raw === 'string') {
    const id = nonEmptyString(raw)
    return id === undefined ? undefined : { id }
  }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return undefined
  const entry = raw as Record<string, unknown>
  const topProvider =
    typeof entry.top_provider === 'object' && entry.top_provider !== null
      ? (entry.top_provider as Record<string, unknown>)
      : undefined
  // A map key is the id the endpoint routes on, so it outranks whatever
  // canonical id the entry names for itself; the entry's own id only answers
  // for the array dialects, which have no key.
  const id = nonEmptyString(fallbackId) ?? nonEmptyString(entry.id) ?? nonEmptyString(entry.name)
  if (id === undefined) return undefined

  const name = nonEmptyString(entry.display_name) ?? nonEmptyString(entry.displayName) ?? nonEmptyString(entry.name)
  const contextWindow = firstCapacity([
    entry.contextWindow,
    entry.context_window,
    entry.context_length,
    entry.max_input_tokens,
    entry.inputTokenLimit,
    topProvider?.context_length,
  ])
  const maxTokens = firstCapacity([
    entry.maxTokens,
    entry.max_tokens,
    entry.max_output_tokens,
    entry.max_completion_tokens,
    entry.outputTokenLimit,
    topProvider?.max_completion_tokens,
  ])

  const model: ListedModel = { id }
  if (name !== undefined && name !== id) model.name = name
  if (contextWindow !== undefined) model.contextWindow = contextWindow
  if (maxTokens !== undefined) model.maxTokens = maxTokens
  return model
}

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
export function parseListing(payload: unknown): ListedModel[] {
  const out: ListedModel[] = []
  const seen = new Set<string>()
  const push = (candidate: ListedModel | undefined): void => {
    if (candidate === undefined) return
    if (seen.has(candidate.id)) return
    seen.add(candidate.id)
    out.push(candidate)
  }

  if (Array.isArray(payload)) {
    for (const entry of payload) push(toCandidate(entry))
    if (out.length > 0) return out
    throw new ListingError('INVALID_LISTING', 'the endpoint reply was an array with no readable model entries')
  }

  if (typeof payload !== 'object' || payload === null) {
    throw new ListingError('INVALID_LISTING', 'the endpoint reply was not a JSON object')
  }
  const body = payload as Record<string, unknown>

  if (Array.isArray(body.data)) {
    for (const entry of body.data) push(toCandidate(entry))
  }

  const models = body.models
  if (Array.isArray(models)) {
    for (const entry of models) push(toCandidate(entry))
  } else if (typeof models === 'object' && models !== null) {
    for (const [key, entry] of Object.entries(models as Record<string, unknown>)) {
      push(toCandidate(entry, key))
    }
  }

  if (out.length === 0) {
    throw new ListingError('INVALID_LISTING', 'the endpoint reply carried no model entries this build can read')
  }
  return out
}

/** One listing interrogation request. */
export interface ListModelsRequest {
  /** Wire protocol the endpoint speaks. */
  api: string
  /** Endpoint root; the listing path is derived from it. */
  baseURL: string
  /** Resolved credential, when the route has one. */
  apiKey?: string
  /** Deployment headers configured on the route. */
  headers?: Readonly<Record<string, string>>
  /** Per-request timeout in milliseconds. */
  timeoutMs?: number
  /** Caller cancellation, combined with the timeout. */
  signal?: AbortSignal
  /** Injectable fetch, for tests. */
  fetch?: typeof globalThis.fetch
  /** Injectable clock source, for tests. */
  now?: () => number
}

/** The outcome of one successful interrogation. */
export interface ListModelsResult {
  /** Advertised models in endpoint order. */
  models: ListedModel[]
  /** The absolute URL that was interrogated. */
  url: string
  /** Wall-clock duration of the call in milliseconds. */
  durationMs: number
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
export async function listModels(request: ListModelsRequest): Promise<ListModelsResult> {
  const api = request.api
  const url = listingUrl(api, request.baseURL)
  const headers = listingHeaders(api, request.apiKey, request.headers)
  const fetchImpl = request.fetch ?? globalThis.fetch
  const now = request.now ?? Date.now
  const timeoutMs = request.timeoutMs ?? 30_000

  const controller = new AbortController()
  const onAbort = (): void => controller.abort(request.signal?.reason)
  if (request.signal !== undefined) {
    if (request.signal.aborted) onAbort()
    else request.signal.addEventListener('abort', onAbort, { once: true })
  }
  const timer = setTimeout(() => controller.abort(new Error('listing timeout')), timeoutMs)

  const started = now()
  try {
    const response = await fetchImpl(url, { method: 'GET', headers, signal: controller.signal })
    if (!response.ok) {
      throw new ListingError(
        'LISTING_HTTP_ERROR',
        `${url} answered ${String(response.status)} ${response.statusText}`.trim(),
        response.status,
      )
    }
    let payload: unknown
    try {
      payload = await response.json()
    } catch (error) {
      throw new ListingError('INVALID_LISTING', `${url} did not return JSON: ${String(error)}`)
    }
    return { models: parseListing(payload), url, durationMs: now() - started }
  } catch (error) {
    if (error instanceof ListingError) throw error
    if (controller.signal.aborted) {
      const reason = request.signal?.aborted === true ? 'the refresh was cancelled' : `timed out after ${String(timeoutMs)}ms`
      throw new ListingError('LISTING_ABORTED', `${url} ${reason}`)
    }
    throw new ListingError('LISTING_TRANSPORT_ERROR', `${url} failed: ${String(error)}`)
  } finally {
    clearTimeout(timer)
    request.signal?.removeEventListener('abort', onAbort)
  }
}
