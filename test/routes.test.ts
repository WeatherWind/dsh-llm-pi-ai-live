import { describe, expect, it } from 'vitest'
import type { BuiltinCatalog } from '../src/builtin.js'
import { planRoutes } from '../src/routes.js'
import type { LlmConfigurableProvider, SettingsDescriptor } from '../src/types.js'

/** A directory entry as the pi-ai adapter builds them. */
const piAiEntry = (provider: string, declared = false): LlmConfigurableProvider => ({
  provider,
  displayName: provider,
  settingsNs: 'include:llm-pi-ai',
  settingsPath: ['providers', provider],
  declared,
})

/** A directory entry as the DeepSeek adapters build them. */
const deepseekEntry: LlmConfigurableProvider = {
  provider: 'deepseek-official',
  displayName: 'DeepSeek',
  settingsNs: 'include:llm-deepseek',
  settingsPath: [],
}

/** A settings descriptor carrying a resolved `llm-pi-ai` value. */
const descriptor = (ns: string, value: unknown, revision = 7): SettingsDescriptor => ({
  ns,
  value,
  revision,
})

/** A catalog stub. */
const catalog = (overrides: Partial<BuiltinCatalog> = {}): BuiltinCatalog => ({
  providerBaseUrl: () => undefined,
  providerApi: () => undefined,
  model: () => undefined,
  modelCount: () => 0,
  providerIds: () => [],
  ...overrides,
})

describe('planRoutes', () => {
  it('addresses a configured route through the namespace and path the harness reports', () => {
    const plan = planRoutes({
      entries: [piAiEntry('openrouter')],
      descriptors: [
        descriptor('include:llm-pi-ai', {
          providers: { openrouter: { apiKeyEnv: 'OPENROUTER_API_KEY', api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1' } },
        }),
      ],
      settingsNamespaces: [],
      include: [],
      exclude: [],
    })
    expect(plan.routes).toHaveLength(1)
    const route = plan.routes[0]!
    expect(route.settingsNs).toBe('include:llm-pi-ai')
    expect(route.settingsPath).toEqual(['providers', 'openrouter'])
    expect(route.apiKeyEnv).toBe('OPENROUTER_API_KEY')
    expect(route.baseURL).toBe('https://openrouter.ai/api/v1')
    expect(route.revision).toBe(7)
  })

  it('skips a provider the catalog merely offers but the user never configured', () => {
    const plan = planRoutes({
      entries: [piAiEntry('openrouter'), piAiEntry('anthropic')],
      descriptors: [descriptor('include:llm-pi-ai', { providers: { openrouter: { baseURL: 'https://x/v1', api: 'openai-completions' } } })],
      settingsNamespaces: [],
      include: [],
      exclude: [],
    })
    expect(plan.routes.map((route) => route.provider)).toEqual(['openrouter'])
    expect(plan.ineligible).toContainEqual(
      expect.objectContaining({ provider: 'anthropic', reason: 'NOT_CONFIGURED' }),
    )
  })

  it('supplies the endpoint and protocol from the installed catalog when the route declares neither', () => {
    const builtin = catalog({
      providerBaseUrl: (provider) => (provider === 'opencode-go' ? 'https://opencode.ai/zen/go/v1' : undefined),
      providerApi: (provider) =>
        provider === 'opencode-go'
          ? { value: 'openai-completions', unanimous: true, count: 27, total: 27 }
          : undefined,
      modelCount: (provider) => (provider === 'opencode-go' ? 16 : 0),
    })
    const plan = planRoutes({
      entries: [piAiEntry('opencode-go')],
      descriptors: [descriptor('include:llm-pi-ai', { providers: { 'opencode-go': { apiKeyEnv: 'K' } } })],
      settingsNamespaces: [],
      include: [],
      exclude: [],
      catalog: builtin,
    })
    expect(plan.routes).toHaveLength(1)
    expect(plan.routes[0]!.baseURL).toBe('https://opencode.ai/zen/go/v1')
    expect(plan.routes[0]!.api).toBe('openai-completions')
    expect(plan.routes[0]!.catalogKnown).toBe(true)
    expect(plan.routes[0]!.apiSource).toBe('catalog')
  })

  it('uses the plurality protocol for a catalog provider that speaks several', () => {
    const builtin = catalog({
      providerBaseUrl: () => 'https://openrouter.ai/api/v1',
      providerApi: () => ({ value: 'openai-completions', unanimous: false, count: 351, total: 366 }),
    })
    const plan = planRoutes({
      entries: [piAiEntry('openrouter')],
      descriptors: [descriptor('include:llm-pi-ai', { providers: { openrouter: { apiKeyEnv: 'K' } } })],
      settingsNamespaces: [],
      include: [],
      exclude: [],
      catalog: builtin,
    })
    expect(plan.routes[0]!.api).toBe('openai-completions')
    expect(plan.routes[0]!.apiSource).toBe('mixed-majority')
  })

  it('lets the profile override the catalog protocol', () => {
    const builtin = catalog({
      providerBaseUrl: () => 'https://openrouter.ai/api/v1',
      providerApi: () => ({ value: 'anthropic-messages', unanimous: false, count: 15, total: 366 }),
    })
    const plan = planRoutes({
      entries: [piAiEntry('openrouter')],
      descriptors: [
        descriptor('include:llm-pi-ai', {
          providers: { openrouter: { apiKeyEnv: 'K', api: 'openai-completions' } },
        }),
      ],
      settingsNamespaces: [],
      include: [],
      exclude: [],
      catalog: builtin,
    })
    expect(plan.routes[0]!.api).toBe('openai-completions')
    expect(plan.routes[0]!.apiSource).toBe('route')
  })

  it('skips a route with no endpoint anywhere', () => {
    const plan = planRoutes({
      entries: [piAiEntry('mystery')],
      descriptors: [descriptor('include:llm-pi-ai', { providers: { mystery: { api: 'openai-completions' } } })],
      settingsNamespaces: [],
      include: [],
      exclude: [],
    })
    expect(plan.routes).toHaveLength(0)
    expect(plan.unsupported[0]).toMatchObject({ reason: 'NO_ENDPOINT' })
  })

  it('skips a protocol whose listing cannot be read', () => {
    const plan = planRoutes({
      entries: [piAiEntry('bedrock')],
      descriptors: [descriptor('include:llm-pi-ai', { providers: { bedrock: { baseURL: 'https://b', api: 'bedrock-converse-stream' } } })],
      settingsNamespaces: [],
      include: [],
      exclude: [],
    })
    expect(plan.routes).toHaveLength(0)
    expect(plan.unsupported[0]).toMatchObject({ reason: 'DISCOVERY_UNSUPPORTED' })
  })

  it('auto-detects the pi-ai namespace from the declared flag and leaves other adapters alone', () => {
    const plan = planRoutes({
      entries: [piAiEntry('openrouter'), deepseekEntry],
      descriptors: [
        descriptor('include:llm-pi-ai', { providers: { openrouter: { baseURL: 'https://x/v1', api: 'openai-completions' } } }),
        descriptor('include:llm-deepseek', { apiKeyEnv: 'DEEPSEEK_API_KEY' }),
      ],
      settingsNamespaces: [],
      include: [],
      exclude: [],
    })
    expect(plan.routes.map((route) => route.provider)).toEqual(['openrouter'])
    expect(plan.namespaces).toEqual(['include:llm-pi-ai'])
  })

  it('honours an explicit namespace list', () => {
    const plan = planRoutes({
      entries: [piAiEntry('openrouter'), deepseekEntry],
      descriptors: [
        descriptor('include:llm-pi-ai', { providers: { openrouter: { baseURL: 'https://x/v1', api: 'openai-completions' } } }),
        descriptor('include:llm-deepseek', { baseURL: 'https://api.deepseek.com/v1', api: 'openai-completions' }),
      ],
      settingsNamespaces: ['include:llm-deepseek'],
      include: [],
      exclude: [],
    })
    expect(plan.routes.map((route) => route.provider)).toEqual(['deepseek-official'])
  })

  it('applies include and exclude filters', () => {
    const entries = [piAiEntry('a'), piAiEntry('b'), piAiEntry('c')]
    const value = {
      providers: {
        a: { baseURL: 'https://a/v1', api: 'openai-completions' },
        b: { baseURL: 'https://b/v1', api: 'openai-completions' },
        c: { baseURL: 'https://c/v1', api: 'openai-completions' },
      },
    }
    const descriptors = [descriptor('include:llm-pi-ai', value)]

    expect(
      planRoutes({ entries, descriptors, settingsNamespaces: [], include: ['a'], exclude: [] }).routes.map((r) => r.provider),
    ).toEqual(['a'])

    const excluded = planRoutes({ entries, descriptors, settingsNamespaces: [], include: [], exclude: ['b'] })
    expect(excluded.routes.map((r) => r.provider)).toEqual(['a', 'c'])
    expect(excluded.ineligible).toContainEqual(expect.objectContaining({ provider: 'b', reason: 'EXCLUDED' }))
  })

  it('reads the existing models list for append-only preservation', () => {
    const existing = [{ id: 'hand-written', contextWindow: 4096 }]
    const plan = planRoutes({
      entries: [piAiEntry('a')],
      descriptors: [
        descriptor('include:llm-pi-ai', { providers: { a: { baseURL: 'https://a/v1', api: 'openai-completions', models: existing } } }),
      ],
      settingsNamespaces: [],
      include: [],
      exclude: [],
    })
    expect(plan.routes[0]!.existingModels).toBe(existing)
  })

  it('passes an unreadable models value through so the merge can refuse it', () => {
    const plan = planRoutes({
      entries: [piAiEntry('a')],
      descriptors: [
        descriptor('include:llm-pi-ai', {
          providers: { a: { baseURL: 'https://a/v1', api: 'openai-completions', models: 'oops' } },
        }),
      ],
      settingsNamespaces: [],
      include: [],
      exclude: [],
    })
    // Filtering this to `undefined` would silently replace whatever the user
    // stored; the merge is the layer that refuses it.
    expect(plan.routes[0]!.existingModels).toBe('oops')
  })

  it('reports a missing descriptor instead of guessing', () => {
    const plan = planRoutes({
      entries: [piAiEntry('a')],
      descriptors: [],
      settingsNamespaces: [],
      include: [],
      exclude: [],
    })
    expect(plan.routes).toHaveLength(0)
    expect(plan.ineligible[0]).toMatchObject({ reason: 'NO_SETTINGS_DESCRIPTOR' })
  })
})
