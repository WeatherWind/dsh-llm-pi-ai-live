import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { locatePiAiCatalog, resolveExportSubpath } from '../src/builtin.js'

const scratch: string[] = []

/** Build a throwaway tree and return its root. */
function fixture(): string {
  const root = mkdtempSync(join(tmpdir(), 'pi-ai-locate-'))
  scratch.push(root)
  return root
}

/** Write a minimal package manifest, creating its directory. */
function packageAt(root: string, relative: string, manifest: unknown): string {
  const dir = join(root, relative)
  mkdirSync(dir, { recursive: true })
  writeFileSync(join(dir, 'package.json'), JSON.stringify(manifest))
  return dir
}

afterEach(() => {
  for (const root of scratch.splice(0)) rmSync(root, { recursive: true, force: true })
})

describe('resolveExportSubpath', () => {
  it('matches an exact key', () => {
    expect(resolveExportSubpath({ './providers/all': './dist/providers/all.js' }, './providers/all')).toBe(
      './dist/providers/all.js',
    )
  })

  it('honours the import condition on an exact key', () => {
    expect(
      resolveExportSubpath({ './providers/all': { import: './dist/providers/all.js' } }, './providers/all'),
    ).toBe('./dist/providers/all.js')
  })

  it('expands a wildcard key, which is how pi-ai actually declares its catalogue', () => {
    const exportsMap = {
      '.': { import: './dist/index.js' },
      './providers/*': { types: './dist/providers/*.d.ts', import: './dist/providers/*.js' },
    }
    expect(resolveExportSubpath(exportsMap, './providers/all')).toBe('./dist/providers/all.js')
  })

  it('prefers the longest matching pattern', () => {
    const exportsMap = { './p/*': './short/*.js', './providers/*': './long/*.js' }
    expect(resolveExportSubpath(exportsMap, './providers/all')).toBe('./long/all.js')
  })

  it('refuses a subpath no pattern covers', () => {
    expect(resolveExportSubpath({ './providers/*': './dist/providers/*.js' }, './api/lazy')).toBeUndefined()
    expect(resolveExportSubpath(undefined, './providers/all')).toBeUndefined()
    expect(resolveExportSubpath('not-an-object', './providers/all')).toBeUndefined()
  })

  it('does not let a pattern match past its own literal parts', () => {
    // `./providers/*` must not answer for `./providers` itself.
    expect(resolveExportSubpath({ './providers/*': './dist/providers/*.js' }, './providers')).toBeUndefined()
  })
})

describe('locatePiAiCatalog', () => {
  const catalogManifest = {
    name: '@earendil-works/pi-ai',
    exports: { './providers/*': { import: './dist/providers/*.js' } },
  }

  /** Create the entry file a manifest's exports point at. */
  function withEntry(dir: string): void {
    mkdirSync(join(dir, 'dist', 'providers'), { recursive: true })
    writeFileSync(join(dir, 'dist', 'providers', 'all.js'), 'export const getBuiltinModels = () => []\n')
  }

  it('finds a hoisted copy by walking up from the starting directory', () => {
    const root = fixture()
    const pkg = packageAt(root, 'node_modules/@earendil-works/pi-ai', catalogManifest)
    withEntry(pkg)
    const start = join(root, 'lib', 'nested')
    mkdirSync(start, { recursive: true })
    expect(locatePiAiCatalog(start)).toContain('dist/providers/all.js')
  })

  it("finds pnpm's per-package copy beside the adapter that depends on it", () => {
    const root = fixture()
    // No hoisted copy at all — only the adapter's own node_modules.
    const pkg = packageAt(
      root,
      'node_modules/@deepseek-ai/dsh-llm-pi-ai/node_modules/@earendil-works/pi-ai',
      catalogManifest,
    )
    withEntry(pkg)
    const start = join(root, 'lib')
    mkdirSync(start, { recursive: true })
    expect(locatePiAiCatalog(start)).toContain('dist/providers/all.js')
  })

  it('falls back to the conventional build path when a manifest declares no exports', () => {
    const root = fixture()
    const pkg = packageAt(root, 'node_modules/@earendil-works/pi-ai', { name: '@earendil-works/pi-ai' })
    withEntry(pkg)
    expect(locatePiAiCatalog(root)).toContain('dist/providers/all.js')
  })

  it('returns undefined when pi-ai is simply not installed', () => {
    expect(locatePiAiCatalog(fixture())).toBeUndefined()
  })

  it('returns undefined when the declared entry file is missing', () => {
    const root = fixture()
    packageAt(root, 'node_modules/@earendil-works/pi-ai', catalogManifest)
    expect(locatePiAiCatalog(root)).toBeUndefined()
  })

  it('ignores an unreadable manifest instead of throwing', () => {
    const root = fixture()
    const dir = join(root, 'node_modules/@earendil-works/pi-ai')
    mkdirSync(dir, { recursive: true })
    writeFileSync(join(dir, 'package.json'), '{ not json')
    expect(locatePiAiCatalog(root)).toBeUndefined()
  })
})
