import { describe, expect, it, vi } from 'vitest'
import type { BuiltinCatalog } from '../src/builtin.js'
import { createSyncEngine, summarize } from '../src/sync.js'
import type { SyncPolicy } from '../src/sync.js'
import type { CredentialsSeam, LlmConfigurableProvider, Logger, SettingsDescriptor, SettingsPathOp, SettingsSeam } from '../src/types.js'

interface Host {
  settings: SettingsSeam
  entries: LlmConfigurableProvider[]
  writes: { ns: string; ops: readonly SettingsPathOp[] }[]
  value: Record<string, unknown>
  bumpRevision(): void
}

/** Build a settings/llm host that behaves like the real seams. */
function makeHost(options: { value: Record<string, unknown>; entries?: LlmConfigurableProvider[] }): Host {
  const value = options.value
  const entries = options.entries ?? [
    {
      provider: 'openrouter',
      displayName: 'OpenRouter',
      settingsNs: 'include:llm-pi-ai',
      settingsPath: ['providers', 'openrouter'],
      declared: false,
    },
  ]
  const writes: Host['writes'] = []
  let revision = 1

  const setPath = (root: unknown, path: readonly string[], next: unknown): void => {
    let node = root as Record<string, unknown>
    for (const segment of path.slice(0, -1)) {
      const child = node[segment]
      if (typeof child !== 'object' || child === null) node[segment] = {}
      node = node[segment] as Record<string, unknown>
    }
    node[path[path.length - 1]!] = next
  }

  const settings: SettingsSeam = {
    describe: (): SettingsDescriptor[] => [{ ns: 'include:llm-pi-ai', value, revision }],
    mutate: async (ns, ops, expectedRevision) => {
      if (expectedRevision !== undefined && expectedRevision !== revision) {
        throw new Error(`settings namespace "${ns}" changed since it was read`)
      }
      writes.push({ ns, ops })
      for (const op of ops) {
        if (op.op === 'set') setPath(value, op.path, op.value)
      }
      revision += 1
    },
  }

  return { settings, entries, writes, value, bumpRevision: () => { revision += 1 } }
}

const silent: Logger = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

const policy = (overrides: Partial<SyncPolicy> = {}): SyncPolicy => ({
  enrichFromCatalog: true,
  maxModels: 100,
  timeoutMs: 5000,
  dryRun: false,
  settingsNamespaces: [],
  include: [],
  exclude: [],
  ...overrides,
})

const okFetch = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch

const catalog = (overrides: Partial<BuiltinCatalog> = {}): BuiltinCatalog => ({
  providerBaseUrl: () => undefined,
  providerApi: () => undefined,
  model: () => undefined,
  modelCount: () => 0,
  providerIds: () => [],
  ...overrides,
})

const route = (extra: Record<string, unknown> = {}): Record<string, unknown> => ({
  apiKeyEnv: 'OPENROUTER_API_KEY',
  api: 'openai-completions',
  baseURL: 'https://openrouter.ai/api/v1',
  ...extra,
})

describe('createSyncEngine', () => {
  it('appends the live models through the settings seam', async () => {
    const host = makeHost({ value: { providers: { openrouter: route({ models: [{ id: 'old' }] }) } } })
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: silent,
      policy: policy(),
      fetch: okFetch({ data: [{ id: 'old' }, { id: 'new-model' }] }),
      catalog: catalog({ model: (provider, id) => (id === 'new-model' ? { id, contextWindow: 128_000 } : undefined) }),
    })

    const report = await engine.refresh('test')
    expect(report.updated).toBe(1)
    expect(report.added).toBe(1)
    expect(report.routes[0]).toMatchObject({ provider: 'openrouter', status: 'updated', added: ['new-model'], kept: 1 })

    expect(host.writes).toHaveLength(1)
    const written = host.writes[0]!.ops[0]!
    expect(written.op).toBe('set')
    if (written.op !== 'set') return
    expect(written.path).toEqual(['providers', 'openrouter', 'models'])
    expect(written.value).toEqual([{ id: 'old' }, { id: 'new-model', contextWindow: 128_000 }])
  })

  it('sends the resolved credential as a bearer token', async () => {
    const host = makeHost({ value: { providers: { openrouter: route() } } })
    const fetchImpl = okFetch({ data: [{ id: 'a' }] })
    const credentials: CredentialsSeam = { resolve: async () => ({ value: 'sk-secret', source: 'env' }) }
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      credentials,
      logger: silent,
      policy: policy(),
      fetch: fetchImpl,
    })
    await engine.refresh('test')
    const init = (fetchImpl as unknown as { mock: { calls: [string, { headers: Record<string, string> }][] } }).mock.calls[0]![1]
    expect(init.headers['authorization']).toBe('Bearer sk-secret')
  })

  it('leaves the configuration untouched when the endpoint refuses', async () => {
    const host = makeHost({ value: { providers: { openrouter: route({ models: [{ id: 'old' }] }) } } })
    const fetchImpl = vi.fn(async () => new Response('nope', { status: 503 })) as unknown as typeof globalThis.fetch
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: silent,
      policy: policy(),
      fetch: fetchImpl,
    })

    const report = await engine.refresh('test')
    expect(report.failed).toBe(1)
    expect(report.routes[0]).toMatchObject({ status: 'failed', reason: 'LISTING_HTTP_ERROR' })
    expect(host.writes).toHaveLength(0)
    expect(host.value).toEqual({ providers: { openrouter: route({ models: [{ id: 'old' }] }) } })
  })

  it('refuses to write when the stored list cannot be read, keeping the user data', async () => {
    const existing = [{ id: 'ok' }, { name: 'broken' }]
    const host = makeHost({ value: { providers: { openrouter: route({ models: existing }) } } })
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: silent,
      policy: policy(),
      fetch: okFetch({ data: [{ id: 'fresh' }] }),
    })

    const report = await engine.refresh('test')
    expect(report.routes[0]).toMatchObject({ status: 'failed', reason: 'EXISTING_UNREADABLE' })
    expect(host.writes).toHaveLength(0)
    expect(host.value).toEqual({ providers: { openrouter: route({ models: existing }) } })
  })

  it('writes nothing in dry-run mode but reports what it would add', async () => {
    const host = makeHost({ value: { providers: { openrouter: route() } } })
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: silent,
      policy: policy({ dryRun: true }),
      fetch: okFetch({ data: [{ id: 'a' }] }),
    })

    const report = await engine.refresh('test')
    expect(report.routes[0]).toMatchObject({ status: 'updated', added: ['a'], reason: 'DRY_RUN' })
    expect(host.writes).toHaveLength(0)
  })

  it('reports no change when the route already serves every advertised model', async () => {
    const host = makeHost({ value: { providers: { openrouter: route({ models: [{ id: 'a' }] }) } } })
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: silent,
      policy: policy(),
      fetch: okFetch({ data: [{ id: 'a' }] }),
    })
    const report = await engine.refresh('test')
    expect(report.routes[0]).toMatchObject({ status: 'unchanged', kept: 1 })
    expect(host.writes).toHaveLength(0)
  })

  it('retries once when a settings edit lands mid-pass', async () => {
    const host = makeHost({ value: { providers: { openrouter: route() } } })
    const realMutate = host.settings.mutate.bind(host.settings)
    let attempts = 0
    host.settings.mutate = async (ns, ops, expectedRevision) => {
      attempts += 1
      if (attempts === 1) throw new Error('settings namespace "include:llm-pi-ai" changed since it was read')
      return realMutate(ns, ops, expectedRevision)
    }
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: silent,
      policy: policy(),
      fetch: okFetch({ data: [{ id: 'a' }] }),
    })

    const report = await engine.refresh('test')
    expect(attempts).toBe(2)
    expect(report.routes[0]).toMatchObject({ status: 'updated', added: ['a'] })
  })

  it('reports a write the seam accepted but did not apply', async () => {
    const host = makeHost({ value: { providers: { openrouter: route() } } })
    host.settings.mutate = async () => {
      // Accept the write and silently drop it.
    }
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: silent,
      policy: policy(),
      fetch: okFetch({ data: [{ id: 'a' }] }),
    })

    const report = await engine.refresh('test')
    expect(report.routes[0]).toMatchObject({ status: 'failed', reason: 'WRITE_NOT_APPLIED' })
  })

  it('fails a route whose stored list is unreadable but keeps other routes working', async () => {
    const host = makeHost({
      value: {
        providers: {
          openrouter: route({ models: 'not-a-list' }),
          anthropic: { api: 'anthropic-messages', baseURL: 'https://api.anthropic.com' },
        },
      },
      entries: [
        { provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'include:llm-pi-ai', settingsPath: ['providers', 'openrouter'], declared: false },
        { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'include:llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: false },
      ],
    })
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: silent,
      policy: policy(),
      fetch: vi.fn(async (url: string) =>
        new Response(JSON.stringify(url.includes('anthropic') ? { data: [{ id: 'claude' }] } : { data: [{ id: 'x' }] }), {
          status: 200,
        }),
      ) as unknown as typeof globalThis.fetch,
    })

    const report = await engine.refresh('test')
    expect(report.failed).toBe(1)
    expect(report.updated).toBe(1)
    expect(host.writes).toHaveLength(1)
    expect(host.writes[0]!.ops[0]).toMatchObject({ op: 'set', path: ['providers', 'anthropic', 'models'] })
  })

  it('honours a per-pass provider allow-list', async () => {
    const host = makeHost({
      value: {
        providers: {
          openrouter: route(),
          anthropic: { api: 'anthropic-messages', baseURL: 'https://api.anthropic.com' },
        },
      },
      entries: [
        { provider: 'openrouter', displayName: 'OpenRouter', settingsNs: 'include:llm-pi-ai', settingsPath: ['providers', 'openrouter'], declared: false },
        { provider: 'anthropic', displayName: 'Anthropic', settingsNs: 'include:llm-pi-ai', settingsPath: ['providers', 'anthropic'], declared: false },
      ],
    })
    const fetchImpl = okFetch({ data: [{ id: 'a' }] })
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: silent,
      policy: policy(),
      fetch: fetchImpl,
    })
    await engine.refresh('tool', { include: ['anthropic'] })
    expect(fetchImpl).toHaveBeenCalledOnce()
    expect(host.writes[0]!.ops[0]).toMatchObject({ path: ['providers', 'anthropic', 'models'] })
  })

  it('reports an empty pass when nothing is configured', async () => {
    const host = makeHost({ value: { providers: {} } })
    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: silent,
      policy: policy(),
      fetch: okFetch({ data: [] }),
    })
    const report = await engine.refresh('test')
    expect(report.routes).toHaveLength(0)
    expect(report.updated).toBe(0)
  })
})

describe('summarize', () => {
  it('renders one line', () => {
    expect(
      summarize({ at: 0, trigger: 't', routes: [], updated: 2, added: 5, failed: 1, skipped: 3, durationMs: 1 }),
    ).toContain('5 model(s) added')
  })
})
