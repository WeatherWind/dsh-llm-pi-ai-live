import { describe, expect, it, vi } from 'vitest'
import { Config, TOOL_NAME, apply, inject } from '../src/index.js'
import { compileRules } from '../src/reasoning.js'
import type { Config as PluginConfig } from '../src/index.js'
import type { SettingsDescriptor, SettingsPathOp, SettingsSeam, ToolDefinition } from '../src/types.js'

const silent = { info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() }

/** Wait until `predicate` holds, or fail after a bounded number of ticks. */
async function waitFor(predicate: () => boolean, ticks = 200): Promise<void> {
  for (let i = 0; i < ticks; i += 1) {
    if (predicate()) return
    await new Promise((resolve) => setTimeout(resolve, 1))
  }
  throw new Error('condition never held')
}

interface Harness {
  ctx: Parameters<typeof apply>[0]
  value: Record<string, unknown>
  writes: readonly SettingsPathOp[][]
  timeouts: { callback: () => void; delay: number }[]
  intervals: { callback: () => void; delay: number }[]
  tools: ToolDefinition[]
  setSettings(value: unknown): void
  setServices(services: Record<string, unknown>): void
}

/** Build a fake Cordis context with the seams the plugin reads. */
function harness(options: {
  settingsValue?: Record<string, unknown> | undefined
  withCredentials?: boolean
  withTools?: boolean
} = {}): Harness {
  const value = options.settingsValue ?? {
    providers: { openrouter: { api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1' } },
  }
  const writes: SettingsPathOp[][] = []
  const timeouts: Harness['timeouts'] = []
  const intervals: Harness['intervals'] = []
  const tools: ToolDefinition[] = []
  let revision = 1

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
  const llm = {
    listConfigurableProviders: () => [
      {
        provider: 'openrouter',
        displayName: 'OpenRouter',
        settingsNs: 'include:llm-pi-ai',
        settingsPath: ['providers', 'openrouter'],
        declared: false,
      },
    ],
  }

  const services: Record<string, unknown> = { settings, llm }
  if (options.withCredentials !== false) services['credentials'] = { resolve: async () => ({ value: 'sk', source: 'test' }) }
  if (options.withTools !== false) {
    services['tools'] = {
      register: (definition: ToolDefinition) => {
        tools.push(definition)
        return () => {}
      },
    }
  }

  const ctx = {
    get: (name: string) => services[name],
    logger: silent,
    setTimeout: (callback: () => void, delay: number) => {
      timeouts.push({ callback, delay })
      return () => {}
    },
    setInterval: (callback: () => void, delay: number) => {
      intervals.push({ callback, delay })
      return () => {}
    },
  }

  return {
    ctx,
    value,
    writes,
    timeouts,
    intervals,
    tools,
    setSettings: (next: unknown) => {
      for (const key of Object.keys(value)) delete value[key]
      Object.assign(value, next as Record<string, unknown>)
    },
    setServices: (next) => Object.assign(services, next),
  }
}

const config = (overrides: Partial<PluginConfig> = {}): PluginConfig => ({
  enabled: true,
  startupDelayMs: 5,
  intervalMs: 60_000,
  timeoutMs: 5000,
  settingsNamespaces: [],
  include: [],
  exclude: [],
  enrichFromCatalog: false,
  maxModels: 100,
  dryRun: false,
  toolEnabled: true,
  reasoning: { enabled: false, rules: [] },
  ...overrides,
})

const okFetch = (body: unknown) =>
  vi.fn(async () => new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof globalThis.fetch

describe('inject', () => {
  it('declares every mixed-in service it reads', () => {
    // Cordis throws `cannot get property "timer" without inject` on reading a
    // mixed-in helper whose service was not declared. A real mount caught
    // exactly that, so it is pinned here.
    expect(inject).toContain('timer')
    expect(inject).toContain('settings')
    expect(inject).toContain('llm')
  })
})

describe('Config schema', () => {
  it('defaults to a ten-second first pass and a six-hour period', () => {
    const resolved = Config({}) as PluginConfig
    expect(resolved.enabled).toBe(true)
    expect(resolved.startupDelayMs).toBe(10_000)
    expect(resolved.intervalMs).toBe(6 * 60 * 60 * 1000)
    expect(resolved.enrichFromCatalog).toBe(true)
  })

  it('rejects a nonsensical timeout', () => {
    expect(() => Config({ timeoutMs: 10 })).toThrow()
  })

  it('defaults reasoning off, and carries a rule through the form', () => {
    const off = Config({}) as PluginConfig
    expect(off.reasoning).toEqual({ enabled: false, rules: [] })

    const on = Config({
      reasoning: {
        enabled: true,
        rules: [
          { provider: 'acme-gateway', model: 'glm-*', efforts: { off: null, high: 'high', max: 'ultra' } },
          { provider: 'local', model: '*', efforts: false },
        ],
      },
    }) as PluginConfig
    expect(on.reasoning.enabled).toBe(true)
    expect(on.reasoning.rules[0]!.efforts).toEqual({ off: null, high: 'high', max: 'ultra' })
    expect(on.reasoning.rules[1]!.efforts).toBe(false)
    expect(compileRules(on.reasoning).invalid).toHaveLength(0)
  })

  it('lets a mistyped level through the form but refuses it at compile time', () => {
    // schemastery drops unknown keys rather than rejecting them, so the named
    // level fields are a UI affordance; compileRules is the enforcement.
    const typo = Config({
      reasoning: { enabled: true, rules: [{ provider: '*', model: '*', efforts: { bogus: 'x' } }] },
    }) as PluginConfig
    const compiled = compileRules(typo.reasoning)
    expect(compiled.rules).toHaveLength(0)
    expect(compiled.invalid[0]!.index).toBe(0)
  })
})

describe('apply', () => {
  it('is inert when disabled', () => {
    const h = harness()
    apply(h.ctx, config({ enabled: false }))
    expect(h.timeouts).toHaveLength(0)
    expect(h.intervals).toHaveLength(0)
    expect(h.tools).toHaveLength(0)
  })

  it('is inert, with a warning, when a required seam is absent', () => {
    const h = harness()
    h.setServices({ llm: undefined })
    apply(h.ctx, config())
    expect(h.timeouts).toHaveLength(0)
    expect(silent.warn).toHaveBeenCalled()
  })

  it('schedules the first pass and the period, and registers the manual tool', () => {
    const h = harness()
    apply(h.ctx, config())
    expect(h.timeouts).toHaveLength(1)
    expect(h.timeouts[0]!.delay).toBe(5)
    expect(h.intervals).toHaveLength(1)
    expect(h.intervals[0]!.delay).toBe(60_000)
    expect(h.tools.map((tool) => tool.name)).toEqual([TOOL_NAME])
  })

  it('omits the periodic timer when the interval is zero', () => {
    const h = harness()
    apply(h.ctx, config({ intervalMs: 0 }))
    expect(h.intervals).toHaveLength(0)
  })

  it('still runs the startup pass when its delay is zero', () => {
    // `0` means "immediately", not "never": a real mount showed the startup
    // pass silently disappearing under a `> 0` guard.
    const h = harness()
    apply(h.ctx, config({ startupDelayMs: 0 }))
    expect(h.timeouts).toHaveLength(1)
    expect(h.timeouts[0]!.delay).toBe(0)
  })

  it('refreshes on the startup timer and writes the new models', async () => {
    const h = harness()
    const fetchImpl = okFetch({ data: [{ id: 'brand-new' }] })
    apply(h.ctx, config(), )
    expect(h.timeouts).toHaveLength(1)

    // The plugin builds its own fetch through the global; patch it for the test.
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      h.timeouts[0]!.callback()
      await waitFor(() => h.writes.length > 0)
    } finally {
      globalThis.fetch = original
    }

    expect(h.value).toEqual({
      providers: { openrouter: { api: 'openai-completions', baseURL: 'https://openrouter.ai/api/v1', models: [{ id: 'brand-new' }] } },
    })
  })

  it('runs a manual pass through the tool execute', async () => {
    const h = harness()
    apply(h.ctx, config())
    const tool = h.tools[0]!
    const fetchImpl = okFetch({ data: [{ id: 'manual-add' }] })
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const result = (await tool.execute({}, {})) as { added: number; routes: { status: string }[] }
      expect(result.added).toBe(1)
      expect(result.routes[0]!.status).toBe('updated')
    } finally {
      globalThis.fetch = original
    }
  })

  it('narrows a manual pass to the named provider', async () => {
    const h = harness()
    apply(h.ctx, config())
    const tool = h.tools[0]!
    const fetchImpl = okFetch({ data: [{ id: 'x' }] })
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const result = (await tool.execute({ provider: 'nope' }, {})) as { routes: unknown[] }
      expect(result.routes).toHaveLength(0)
      expect(h.writes).toHaveLength(0)
    } finally {
      globalThis.fetch = original
    }
  })

  it('renders a readable tool result', async () => {
    const h = harness()
    apply(h.ctx, config())
    const tool = h.tools[0]!
    const fetchImpl = okFetch({ data: [{ id: 'added' }] })
    const original = globalThis.fetch
    globalThis.fetch = fetchImpl
    try {
      const value = await tool.execute({}, {})
      const blocks = tool.output.render({}, value)
      expect(blocks[0]!.type).toBe('text')
      expect(blocks[0]!.text).toContain('added')
    } finally {
      globalThis.fetch = original
    }
  })

  it('does not register the tool when disabled', () => {
    const h = harness()
    apply(h.ctx, config({ toolEnabled: false }))
    expect(h.tools).toHaveLength(0)
  })

  it('survives a host whose timer service is not mounted', () => {
    const h = harness()
    h.setServices({})
    const ctx = { ...h.ctx, setTimeout: undefined, setInterval: undefined } as unknown as typeof h.ctx
    expect(() => { apply(ctx, config()) }).not.toThrow()
    expect(silent.warn).toHaveBeenCalled()
  })
})
