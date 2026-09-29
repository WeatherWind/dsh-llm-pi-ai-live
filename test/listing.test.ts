import { describe, expect, it, vi } from 'vitest'
import { ListingError, listModels, listingHeaders, listingUrl, parseListing } from '../src/listing.js'

describe('listingUrl', () => {
  it('appends /models for the OpenAI dialects', () => {
    expect(listingUrl('openai-completions', 'https://api.example.com/v1')).toBe('https://api.example.com/v1/models')
    expect(listingUrl('openai-responses', 'https://api.example.com/v1/')).toBe('https://api.example.com/v1/models')
  })

  it('uses the Anthropic listing path and its maximum page size', () => {
    expect(listingUrl('anthropic-messages', 'https://api.anthropic.com')).toBe(
      'https://api.anthropic.com/v1/models?limit=1000',
    )
  })

  it('normalizes either published spelling of the Anthropic API root', () => {
    expect(listingUrl('anthropic-messages', 'https://gateway.example/anthropic/v1')).toBe(
      'https://gateway.example/anthropic/v1/models?limit=1000',
    )
    expect(listingUrl('anthropic-messages', 'https://gateway.example/anthropic/v1/')).toBe(
      'https://gateway.example/anthropic/v1/models?limit=1000',
    )
  })

  it('refuses a protocol whose listing this build cannot read', () => {
    expect(() => listingUrl('bedrock-converse-stream', 'https://bedrock.example')).toThrow(ListingError)
  })

  it('refuses an empty endpoint', () => {
    expect(() => listingUrl('openai-completions', '   ')).toThrow(ListingError)
  })
})

describe('listingHeaders', () => {
  it('sends a bearer token for the OpenAI dialects', () => {
    expect(listingHeaders('openai-completions', 'sk-1', undefined)).toMatchObject({ authorization: 'Bearer sk-1' })
  })

  it('sends the Anthropic key header and version', () => {
    const headers = listingHeaders('anthropic-messages', 'sk-ant', undefined)
    expect(headers['x-api-key']).toBe('sk-ant')
    expect(headers['anthropic-version']).toBe('2023-06-01')
    expect(headers['authorization']).toBeUndefined()
  })

  it('interrogates a keyless route without inventing a credential', () => {
    const headers = listingHeaders('openai-completions', undefined, undefined)
    expect(headers['authorization']).toBeUndefined()
  })

  it('lets a deployment header override the derived one and drops empty values', () => {
    const headers = listingHeaders('openai-completions', 'sk-1', {
      Authorization: 'Bearer deployment',
      'X-Org': 'acme',
      'X-Empty': '',
    })
    expect(headers['authorization']).toBe('Bearer deployment')
    expect(headers['x-org']).toBe('acme')
    expect(headers['x-empty']).toBeUndefined()
  })
})

describe('parseListing', () => {
  it('reads the standard OpenAI data array', () => {
    expect(parseListing({ object: 'list', data: [{ id: 'a' }, { id: 'b' }] })).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('reads Anthropic fields into the shared shape', () => {
    expect(
      parseListing({
        data: [{ id: 'claude-x', display_name: 'Claude X', max_input_tokens: 200_000, max_tokens: 8192 }],
      }),
    ).toEqual([{ id: 'claude-x', name: 'Claude X', contextWindow: 200_000, maxTokens: 8192 }])
  })

  it('reads capacities a gateway nested under top_provider', () => {
    expect(
      parseListing({ data: [{ id: 'a', context_length: 128_000, top_provider: { max_completion_tokens: 16_384 } }] }),
    ).toEqual([{ id: 'a', contextWindow: 128_000, maxTokens: 16_384 }])
  })

  it('reads an enriched map and keeps the key as the request id', () => {
    expect(parseListing({ models: { 'route-id': { id: 'canonical-id', name: 'Label' } } })).toEqual([
      { id: 'route-id', name: 'Label' },
    ])
  })

  it('reads a models array and ignores primitive-valued map properties', () => {
    expect(parseListing({ models: [{ id: 'a' }, { id: 'b' }] })).toEqual([{ id: 'a' }, { id: 'b' }])
    expect(parseListing({ models: { a: { id: 'a' }, b: true } })).toEqual([{ id: 'a' }])
  })

  it('accepts a bare array', () => {
    expect(parseListing([{ id: 'a' }])).toEqual([{ id: 'a' }])
  })

  it('deduplicates while preserving endpoint order', () => {
    expect(parseListing({ data: [{ id: 'a' }, { id: 'b' }, { id: 'a' }] })).toEqual([{ id: 'a' }, { id: 'b' }])
  })

  it('drops a display name identical to the id', () => {
    expect(parseListing({ data: [{ id: 'a', name: 'a' }] })).toEqual([{ id: 'a' }])
  })

  it('refuses a reply that is not a model listing', () => {
    expect(() => parseListing({ error: 'nope' })).toThrow(ListingError)
    expect(() => parseListing('a string')).toThrow(ListingError)
    expect(() => parseListing({ data: [] })).toThrow(ListingError)
  })
})

describe('listModels', () => {
  const ok = (body: unknown): typeof globalThis.fetch =>
    vi.fn(async () => new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })) as unknown as typeof globalThis.fetch

  it('interrogates the derived URL and returns endpoint order', async () => {
    const fetchImpl = ok({ data: [{ id: 'z' }, { id: 'a' }] })
    const result = await listModels({
      api: 'openai-completions',
      baseURL: 'https://api.example.com/v1',
      fetch: fetchImpl,
    })
    expect(result.url).toBe('https://api.example.com/v1/models')
    expect(result.models.map((model) => model.id)).toEqual(['z', 'a'])
    expect(fetchImpl).toHaveBeenCalledOnce()
  })

  it('reports a non-2xx reply with its status and leaves parsing alone', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('nope', { status: 401, statusText: 'Unauthorized' }),
    ) as unknown as typeof globalThis.fetch
    await expect(
      listModels({ api: 'openai-completions', baseURL: 'https://api.example.com/v1', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'LISTING_HTTP_ERROR', status: 401 })
  })

  it('reports a body that is not JSON', async () => {
    const fetchImpl = vi.fn(
      async () => new Response('<html>nope</html>', { status: 200 }),
    ) as unknown as typeof globalThis.fetch
    await expect(
      listModels({ api: 'openai-completions', baseURL: 'https://api.example.com/v1', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'INVALID_LISTING' })
  })

  it('reports a transport failure', async () => {
    const fetchImpl = vi.fn(async () => {
      throw new Error('connect ECONNREFUSED')
    }) as unknown as typeof globalThis.fetch
    await expect(
      listModels({ api: 'openai-completions', baseURL: 'https://api.example.com/v1', fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'LISTING_TRANSPORT_ERROR' })
  })

  it('bounds a hung endpoint by its own timeout', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    ) as unknown as typeof globalThis.fetch
    await expect(
      listModels({ api: 'openai-completions', baseURL: 'https://api.example.com/v1', timeoutMs: 20, fetch: fetchImpl }),
    ).rejects.toMatchObject({ code: 'LISTING_ABORTED' })
  })

  it('honours caller cancellation', async () => {
    const fetchImpl = vi.fn(
      (_url: unknown, init?: { signal?: AbortSignal }) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener('abort', () => {
            reject(new Error('aborted'))
          })
        }),
    ) as unknown as typeof globalThis.fetch
    const controller = new AbortController()
    const pending = listModels({
      api: 'openai-completions',
      baseURL: 'https://api.example.com/v1',
      fetch: fetchImpl,
      signal: controller.signal,
    })
    controller.abort()
    await expect(pending).rejects.toMatchObject({ code: 'LISTING_ABORTED' })
  })
})
