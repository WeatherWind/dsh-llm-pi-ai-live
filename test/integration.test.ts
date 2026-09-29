/**
 * Integration test against the *installed* pi-ai catalog.
 *
 * This is the regression the upstream reports describe, exercised end to end:
 * a user configures `opencode-go` with nothing but a credential reference —
 * exactly the profile in discussion #3816 — and the route must still be
 * refreshable and must pick up models released after the pinned snapshot while
 * keeping the snapshot's metadata for the models it does know.
 *
 * The catalog is a development-only symlink here, so the suite skips itself
 * when the real pi-ai package is not resolvable.
 */
import { describe, expect, it, vi } from 'vitest'
import { loadBuiltinCatalog } from '../src/builtin.js'
import { createSyncEngine } from '../src/sync.js'
import type { SyncPolicy } from '../src/sync.js'
import type { LlmConfigurableProvider, SettingsDescriptor, SettingsPathOp, SettingsSeam } from '../src/types.js'

const catalog = await loadBuiltinCatalog()
const describeIf = catalog === undefined ? describe.skip : describe

describeIf('installed pi-ai catalog', () => {
  it('is readable and carries the capacities a listing endpoint omits', () => {
    expect(catalog!.providerIds().length).toBeGreaterThan(10)
    expect(catalog!.modelCount('openrouter')).toBeGreaterThan(100)
    const model = catalog!.model('openrouter', 'openai/gpt-4o')
    expect(model).toBeDefined()
    expect(model!.contextWindow).toBeGreaterThan(0)
    expect(model!.maxTokens).toBeGreaterThan(0)
    expect(model!.input).toContain('text')
  })

  it('resolves an endpoint the provider record itself does not carry', () => {
    // opencode-go ships no provider-level baseUrl; only its models name one.
    const baseUrl = catalog!.providerBaseUrl('opencode-go')
    expect(baseUrl).toBeDefined()
    expect(baseUrl!.length).toBeGreaterThan(0)
  })

  it('reports how much a multi-protocol provider agrees with itself', () => {
    const agreement = catalog!.providerApi('openrouter')
    expect(agreement).toBeDefined()
    expect(agreement!.total).toBeGreaterThan(0)
    expect(agreement!.count).toBeGreaterThan(0)
    // openrouter genuinely ships more than one protocol.
    expect(agreement!.unanimous).toBe(false)
  })
})

describeIf('opencode-go configured with only a credential (#3816)', () => {
  /** A host where the route names no endpoint and no protocol. */
  const buildHost = () => {
    const value: Record<string, unknown> = {
      providers: { 'opencode-go': { apiKeyEnv: 'OPENCODE_API_KEY' } },
    }
    const entries: LlmConfigurableProvider[] = [
      {
        provider: 'opencode-go',
        displayName: 'opencode go',
        settingsNs: 'include:llm-pi-ai',
        settingsPath: ['providers', 'opencode-go'],
        declared: false,
      },
    ]
    const writes: SettingsPathOp[][] = []
    let revision = 3
    const settings: SettingsSeam = {
      describe: (): SettingsDescriptor[] => [{ ns: 'include:llm-pi-ai', value, revision }],
      mutate: async (_ns, ops) => {
        writes.push([...ops])
        for (const op of ops) {
          if (op.op !== 'set') continue
          let node = value as Record<string, unknown>
          for (const segment of op.path.slice(0, -1)) node = node[segment] as Record<string, unknown>
          node[op.path[op.path.length - 1]!] = op.value
        }
        revision += 1
      },
    }
    return { value, entries, writes, settings }
  }

  const policy: SyncPolicy = {
    enrichFromCatalog: true,
    maxModels: 5000,
    timeoutMs: 5000,
    dryRun: false,
    settingsNamespaces: [],
    include: [],
    exclude: [],
    reasoning: { enabled: false, rules: [] },
  }

  it('is planned rather than skipped as endpoint-less, and appends the live models', async () => {
    const host = buildHost()

    // Choose the fixture dynamically: the installed snapshot keeps gaining
    // models, so "missing from the snapshot" has to be measured, not assumed.
    const endpointCapacity = 262_144
    const liveOnly = ['zz-model-released-after-the-snapshot', 'zz-another-new-model'].filter(
      (id) => catalog!.model('opencode-go', id) === undefined,
    )
    expect(liveOnly.length).toBeGreaterThan(0)
    const snapshotId = 'glm-5.3'
    const snapshotFacts = catalog!.model('opencode-go', snapshotId)
    const advertised = [...liveOnly, ...(snapshotFacts === undefined ? [] : [snapshotId])]

    const seen: string[] = []
    const fetchImpl = vi.fn(async (url: string) => {
      seen.push(url)
      return new Response(
        JSON.stringify({
          data: advertised.map((id) => ({ id, name: id, context_length: endpointCapacity })),
        }),
        { status: 200 },
      )
    }) as unknown as typeof globalThis.fetch

    const engine = createSyncEngine({
      llm: { listConfigurableProviders: () => host.entries },
      settings: host.settings,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      policy,
      fetch: fetchImpl,
      catalog,
    })

    const report = await engine.refresh('integration')
    expect(report.routes[0]).toMatchObject({ status: 'updated', kept: 0 })
    expect(report.routes[0]!.added).toEqual(advertised)
    expect(report.routes[0]!.added).not.toContain('NO_ENDPOINT')

    // The endpoint was derived from the catalog's *models*, since the provider
    // record has none, and the protocol plurality picked a readable listing.
    expect(seen[0]).toBe('https://opencode.ai/zen/go/v1/models')

    const written = host.writes[0]![0]!
    expect(written.op).toBe('set')
    if (written.op !== 'set') return
    const models = written.value as { id: string; contextWindow?: number; maxTokens?: number }[]
    expect(models.map((model) => model.id)).toEqual(advertised)

    // A live-only id keeps the capacity the endpoint reported...
    expect(models.find((model) => model.id === liveOnly[0])!.contextWindow).toBe(endpointCapacity)

    // ...while an id the snapshot knows keeps the snapshot's richer facts,
    // even though the endpoint advertised a different number.
    if (snapshotFacts !== undefined) {
      const known = models.find((model) => model.id === snapshotId)!
      expect(known.contextWindow).toBe(snapshotFacts.contextWindow)
      expect(known.contextWindow).not.toBe(endpointCapacity)
    }
  })

  it('preserves hand-written entries exactly and stays idempotent on a second pass', async () => {
    const handWritten = { id: 'my-finetune', name: 'My finetune', contextWindow: 8192, reasoningEfforts: false }
    const value: Record<string, unknown> = { providers: { 'opencode-go': { apiKeyEnv: 'K', models: [handWritten] } } }
    let revision = 1
    const writes: SettingsPathOp[][] = []
    const settings: SettingsSeam = {
      describe: () => [{ ns: 'include:llm-pi-ai', value, revision }],
      mutate: async (_ns, ops) => {
        writes.push([...ops])
        for (const op of ops) {
          if (op.op !== 'set') continue
          let node = value as Record<string, unknown>
          for (const segment of op.path.slice(0, -1)) node = node[segment] as Record<string, unknown>
          node[op.path[op.path.length - 1]!] = op.value
        }
        revision += 1
      },
    }
    const fetchImpl = vi.fn(
      async () => new Response(JSON.stringify({ data: [{ id: 'glm-5.3' }] }), { status: 200 }),
    ) as unknown as typeof globalThis.fetch

    const engine = createSyncEngine({
      llm: {
        listConfigurableProviders: () => [
          {
            provider: 'opencode-go',
            displayName: 'opencode go',
            settingsNs: 'include:llm-pi-ai',
            settingsPath: ['providers', 'opencode-go'],
            declared: false,
          },
        ],
      },
      settings,
      logger: { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() },
      policy,
      fetch: fetchImpl,
      catalog,
    })

    await engine.refresh('first')
    const afterFirst = (value['providers'] as Record<string, { models: unknown[] }>)['opencode-go']!.models
    expect(afterFirst[0]).toBe(handWritten)
    expect(afterFirst).toHaveLength(2)

    const second = await engine.refresh('second')
    expect(second.routes[0]!.status).toBe('unchanged')
    expect(writes).toHaveLength(1)
  })
})
