import { describe, expect, it } from 'vitest'
import { THINKING_LEVELS, applyReasoning, compileEfforts, compileRules, matchesGlob } from '../src/reasoning.js'
import type { CompiledRule, ReasoningPolicy } from '../src/reasoning.js'

const policy = (rules: ReasoningPolicy['rules'], enabled = true): ReasoningPolicy => ({ enabled, rules })

const rule = (over: Partial<CompiledRule> = {}): CompiledRule => ({
  provider: '*',
  model: '*',
  efforts: { off: null, high: 'high' },
  ...over,
})

const noCatalog = { provider: 'acme', catalogKnown: () => false }

describe('matchesGlob', () => {
  it('matches everything with a bare star', () => {
    expect(matchesGlob('*', 'anything')).toBe(true)
    expect(matchesGlob('*', '')).toBe(true)
  })

  it('matches literals exactly', () => {
    expect(matchesGlob('acme-gateway', 'acme-gateway')).toBe(true)
    expect(matchesGlob('acme-gateway', 'acme-gateway-2')).toBe(false)
  })

  it('handles a leading, trailing, and inner star', () => {
    expect(matchesGlob('glm-*', 'glm-5.3')).toBe(true)
    expect(matchesGlob('*-turbo', 'glm-turbo')).toBe(true)
    expect(matchesGlob('g*-*3', 'glm-5.3')).toBe(true)
  })

  it('anchors the first and last fragment', () => {
    // `glm-*` must not match a prefix elsewhere in the string.
    expect(matchesGlob('glm-*', 'x/glm-5')).toBe(false)
    // `*-turbo` must match at the end.
    expect(matchesGlob('*-turbo', 'glm-turbo-x')).toBe(false)
  })

  it('treats regex metacharacters literally', () => {
    expect(matchesGlob('openai/gpt-4o', 'openai/gpt-4o')).toBe(true)
    expect(matchesGlob('a.b', 'axb')).toBe(false)
  })
})

describe('compileEfforts', () => {
  it('accepts false as "this model does not reason"', () => {
    expect(compileEfforts(false)).toBe(false)
  })

  it('accepts a level map and keeps null only for off', () => {
    expect(compileEfforts({ off: null, high: 'high', max: 'ultra' })).toEqual({ off: null, high: 'high', max: 'ultra' })
  })

  it('ignores levels a form materialized as unset', () => {
    expect(compileEfforts({ off: undefined, high: 'high', max: undefined })).toEqual({ high: 'high' })
  })

  it('refuses an unknown level name', () => {
    expect(compileEfforts({ nonsense: 'x' })).toBeUndefined()
  })

  it('refuses null for any level but off', () => {
    expect(compileEfforts({ high: null })).toBeUndefined()
  })

  it('refuses an empty declaration and non-maps', () => {
    expect(compileEfforts({})).toBeUndefined()
    expect(compileEfforts({ off: undefined })).toBeUndefined()
    expect(compileEfforts('high')).toBeUndefined()
    expect(compileEfforts([])).toBeUndefined()
    expect(compileEfforts(null)).toBeUndefined()
  })

  it('refuses a blank wire spelling', () => {
    expect(compileEfforts({ high: '   ' })).toBeUndefined()
  })

  it('knows exactly the levels pi-ai accepts', () => {
    expect(THINKING_LEVELS).toEqual(['off', 'minimal', 'low', 'medium', 'high', 'xhigh', 'max'])
    for (const level of THINKING_LEVELS) {
      expect(compileEfforts({ [level]: level === 'off' ? null : 'x' })).toBeDefined()
    }
  })
})

describe('compileRules', () => {
  it('keeps usable rules and reports the refused ones by index', () => {
    const { rules, invalid } = compileRules(
      policy([
        { provider: 'a', model: '*', efforts: { high: 'high' } },
        { provider: 'b', model: '*', efforts: { bogus: 'x' } as never },
        { provider: 'c', model: '*', efforts: false },
      ]),
    )
    expect(rules).toHaveLength(2)
    expect(rules.map((entry) => entry.provider)).toEqual(['a', 'c'])
    expect(invalid).toHaveLength(1)
    expect(invalid[0]!.index).toBe(1)
    expect(invalid[0]!.detail).toContain('thinking levels')
  })
})

describe('applyReasoning', () => {
  it('declares reasoning for a third-party model that has none', () => {
    const entries = [{ id: 'third-party', contextWindow: 131_072 }]
    const outcome = applyReasoning(entries, [rule()], noCatalog)
    expect(outcome.applied).toEqual([{ id: 'third-party', levels: ['off', 'high'], rule: 0 }])
    expect(outcome.models[0]).toEqual({
      id: 'third-party',
      contextWindow: 131_072,
      reasoningEfforts: { off: null, high: 'high' },
    })
  })

  it('declares a model non-reasoning when the rule says false', () => {
    const outcome = applyReasoning([{ id: 'plain' }], [rule({ efforts: false })], noCatalog)
    expect(outcome.applied).toEqual([{ id: 'plain', levels: 'non-reasoning', rule: 0 }])
    expect((outcome.models[0] as Record<string, unknown>)['reasoningEfforts']).toBe(false)
  })

  it('never touches an entry that already declares efforts', () => {
    const declared = { id: 'mine', reasoningEfforts: { off: null, max: 'ultra' } }
    const outcome = applyReasoning([declared], [rule()], noCatalog)
    expect(outcome.applied).toHaveLength(0)
    expect(outcome.skipped).toEqual([{ id: 'mine', reason: 'DECLARED' }])
    expect(outcome.models[0]).toBe(declared)
  })

  it('treats an explicit `false` as a decision, not as a gap', () => {
    const declared = { id: 'plain', reasoningEfforts: false }
    const outcome = applyReasoning([declared], [rule()], noCatalog)
    expect(outcome.applied).toHaveLength(0)
    expect(outcome.skipped).toEqual([{ id: 'plain', reason: 'DECLARED' }])
  })

  it('never touches a model the installed catalog knows', () => {
    const known = { id: 'openai/gpt-4o' }
    const outcome = applyReasoning([known], [rule()], { provider: 'openrouter', catalogKnown: () => true })
    expect(outcome.applied).toHaveLength(0)
    expect(outcome.skipped).toEqual([{ id: 'openai/gpt-4o', reason: 'CATALOG_KNOWN' }])
    expect(outcome.models[0]).toBe(known)
  })

  it('leaves a model alone when no rule matches', () => {
    const entry = { id: 'other' }
    const outcome = applyReasoning([entry], [rule({ provider: 'acme' })], { provider: 'different', catalogKnown: () => false })
    expect(outcome.applied).toHaveLength(0)
    expect(outcome.skipped).toEqual([{ id: 'other', reason: 'NO_RULE' }])
    expect(outcome.models[0]).toBe(entry)
  })

  it('applies the first matching rule and ignores later ones', () => {
    const rules = [rule({ model: 'glm-*', efforts: { high: 'first' } }), rule({ model: '*', efforts: { high: 'second' } })]
    const outcome = applyReasoning([{ id: 'glm-5.3' }], rules, noCatalog)
    expect(outcome.applied[0]!.rule).toBe(0)
    expect((outcome.models[0] as Record<string, unknown>)['reasoningEfforts']).toEqual({ high: 'first' })
  })

  it('scopes a rule to its provider route', () => {
    const rules = [rule({ provider: 'acme-gateway' })]
    expect(applyReasoning([{ id: 'm' }], rules, { provider: 'acme-gateway', catalogKnown: () => false }).applied).toHaveLength(1)
    expect(applyReasoning([{ id: 'm' }], rules, { provider: 'other', catalogKnown: () => false }).applied).toHaveLength(0)
  })

  it('carries unusable entries through untouched', () => {
    const outcome = applyReasoning([null, 'string', { noId: true }, { id: 'ok' }], [rule()], noCatalog)
    expect(outcome.models[0]).toBeNull()
    expect(outcome.models[1]).toBe('string')
    expect(outcome.models[2]).toEqual({ noId: true })
    expect(outcome.applied).toHaveLength(1)
  })

  it('preserves entry order and unrelated fields', () => {
    const entries = [{ id: 'a', name: 'A', compat: { x: 1 } }, { id: 'b' }]
    const outcome = applyReasoning(entries, [rule()], noCatalog)
    expect((outcome.models[0] as Record<string, unknown>)['name']).toBe('A')
    expect((outcome.models[0] as Record<string, unknown>)['compat']).toEqual({ x: 1 })
    expect(outcome.models.map((entry) => (entry as { id: string }).id)).toEqual(['a', 'b'])
  })

  it('does nothing when no rules were compiled', () => {
    const entry = { id: 'm' }
    const outcome = applyReasoning([entry], [], noCatalog)
    expect(outcome.applied).toHaveLength(0)
    expect(outcome.models[0]).toBe(entry)
  })
})
