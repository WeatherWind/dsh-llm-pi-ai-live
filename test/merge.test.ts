import { describe, expect, it } from 'vitest'
import { mergeAppendOnly } from '../src/merge.js'
import type { BuiltinModelFacts } from '../src/builtin.js'
import type { ModelEntry } from '../src/merge.js'

const facts = (id: string, extra: Partial<BuiltinModelFacts> = {}): BuiltinModelFacts => ({ id, ...extra })

const noCatalog = () => undefined

describe('mergeAppendOnly', () => {
  it('appends live ids after the user entries and keeps them byte-identical', () => {
    const userEntry = { id: 'mine', name: 'Mine', contextWindow: 32000, reasoningEfforts: { off: null, high: 'high' } }
    const result = mergeAppendOnly({
      existing: [userEntry],
      live: [{ id: 'mine' }, { id: 'fresh' }],
      enrichFromCatalog: false,
      maxModels: 100,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.added).toEqual(['fresh'])
    expect(result.kept).toBe(1)
    expect(result.changed).toBe(true)
    expect(result.models[0]).toBe(userEntry)
    expect(result.models).toHaveLength(2)
    expect((result.models[1] as ModelEntry).id).toBe('fresh')
  })

  it('enriches new entries from the installed catalog, which outranks the listing', () => {
    const result = mergeAppendOnly({
      existing: [],
      live: [{ id: 'glm-5.3', name: 'Gateway Label', contextWindow: 1000, maxTokens: 10 }],
      enrichFromCatalog: true,
      maxModels: 100,
      catalogModel: (id) =>
        id === 'glm-5.3'
          ? facts('glm-5.3', { name: 'GLM 5.3', contextWindow: 200_000, maxTokens: 128_000, input: ['text', 'image'] })
          : undefined,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models[0]).toEqual({
      id: 'glm-5.3',
      name: 'GLM 5.3',
      contextWindow: 200_000,
      maxTokens: 128_000,
      input: ['text', 'image'],
    })
  })

  it('falls back to listing metadata for a model the catalog has never heard of', () => {
    const result = mergeAppendOnly({
      existing: [],
      live: [{ id: 'brand-new', name: 'Brand New', contextWindow: 65_536, maxTokens: 8192 }],
      enrichFromCatalog: true,
      maxModels: 100,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models[0]).toEqual({ id: 'brand-new', name: 'Brand New', contextWindow: 65_536, maxTokens: 8192 })
  })

  it('omits a name identical to the id, so the entry stays minimal', () => {
    const result = mergeAppendOnly({
      existing: [],
      live: [{ id: 'same-name', name: 'same-name' }],
      enrichFromCatalog: false,
      maxModels: 100,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models[0]).toEqual({ id: 'same-name' })
  })

  it('never emits a capacity the route schema would refuse', () => {
    const result = mergeAppendOnly({
      existing: [],
      live: [
        { id: 'a', contextWindow: 0, maxTokens: -5 },
        { id: 'b', contextWindow: Number.NaN, maxTokens: 1.5 },
      ],
      enrichFromCatalog: false,
      maxModels: 100,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models[0]).toEqual({ id: 'a' })
    expect(result.models[1]).toEqual({ id: 'b', maxTokens: 1 })
  })

  it('refuses when an existing entry could not be carried through untouched', () => {
    const result = mergeAppendOnly({
      existing: [{ id: 'ok' }, { name: 'no id' }],
      live: [{ id: 'fresh' }],
      enrichFromCatalog: false,
      maxModels: 100,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.reason).toBe('EXISTING_UNREADABLE')
  })

  it('refuses a non-list existing value rather than replacing it', () => {
    const result = mergeAppendOnly({
      existing: { id: 'not-a-list' },
      live: [{ id: 'fresh' }],
      enrichFromCatalog: false,
      maxModels: 100,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(false)
  })

  it('reports no change when every live model is already configured', () => {
    const result = mergeAppendOnly({
      existing: [{ id: 'a' }, { id: 'b' }],
      live: [{ id: 'a' }, { id: 'b' }],
      enrichFromCatalog: false,
      maxModels: 100,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.changed).toBe(false)
    expect(result.models).toHaveLength(2)
  })

  it('keeps a model the endpoint no longer advertises', () => {
    const result = mergeAppendOnly({
      existing: [{ id: 'delisted' }],
      live: [{ id: 'current' }],
      enrichFromCatalog: false,
      maxModels: 100,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models.map((entry) => (entry as ModelEntry).id)).toEqual(['delisted', 'current'])
  })

  it('honours the cap and reports truncation', () => {
    const result = mergeAppendOnly({
      existing: [{ id: 'a' }],
      live: [{ id: 'b' }, { id: 'c' }, { id: 'd' }],
      enrichFromCatalog: false,
      maxModels: 3,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.added).toEqual(['b', 'c'])
    expect(result.truncated).toBe(true)
  })

  it('deduplicates ids the endpoint repeated', () => {
    const result = mergeAppendOnly({
      existing: [],
      live: [{ id: 'dup' }, { id: 'dup' }],
      enrichFromCatalog: false,
      maxModels: 100,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.added).toEqual(['dup'])
  })

  it('treats an absent models field as an empty list', () => {
    const result = mergeAppendOnly({
      existing: undefined,
      live: [{ id: 'x' }],
      enrichFromCatalog: false,
      maxModels: 100,
      catalogModel: noCatalog,
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.kept).toBe(0)
    expect(result.added).toEqual(['x'])
  })

  it('skips enrichment entirely when the policy disables it', () => {
    const result = mergeAppendOnly({
      existing: [],
      live: [{ id: 'known' }],
      enrichFromCatalog: false,
      maxModels: 100,
      catalogModel: () => facts('known', { name: 'Known', contextWindow: 1000 }),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.models[0]).toEqual({ id: 'known' })
  })
})
