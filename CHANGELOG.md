# Changelog

All notable changes to this plugin are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and this project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Changed

- **Renamed** `dsh-llm-pi-ai-live-catalog` to **`dsh-llm-pi-ai-live`** (package, plugin name,
  patch entry id, workspace directory).
- Dependency declarations now follow the official publishing guide: every peer is `optional`, because
  the `@deepseek-ai/dsh-*` packages are distributed inside the installation and have no matching
  version on the public registry. The declared ranges still feed DSH's admission check, which reads
  `peerDependencies` against the runtime version.
- `@earendil-works/pi-ai` is no longer pinned to `^0.85.1`. That range excluded every future pi-ai
  release, and the plugin treats pi-ai as optional anyway.

### Added

- **A filesystem fallback for locating pi-ai.** A bare `import()` only reaches it from a package
  whose own resolution chain includes it, which is not this plugin's position under pnpm's
  non-hoisted layout. `require.resolve` cannot close the gap either — pi-ai exports no
  `./package.json` and declares its subpaths under the `import` condition alone — so the plugin now
  carries a minimal `exports` wildcard resolver and searches the directories that must contain the
  copy the host loaded. Verified in both layouts: 366 OpenRouter models either way.
- **Dry-run reporting.** A dry run previously wrote nothing *and said nothing*, which made the mode
  useless. It now logs exactly what a real pass would append, verified against the live OpenRouter
  endpoint.

### Fixed

- The mount log said `then every 0ms` when the periodic pass was disabled.

## [0.1.0] — 2026-09-30

First release. A companion plugin that refreshes `llm-pi-ai` provider routes' model catalogs from
their live endpoints through the official settings seam, with no patch to the harness.

### Fixed during development

Both defects were found by the real-boot harness (`npm run test:e2e`), not by unit tests, and both
are now pinned by regression tests:

- **`timer` was missing from `inject`.** Cordis mixes `ctx.setTimeout`/`ctx.setInterval` in from the
  timer service and throws `cannot get property "timer" without inject` on reading them; the plugin
  failed to activate at all in a real profile. `inject` is now
  `['settings', 'llm', 'timer']`.
- **`startupDelayMs: 0` silently disabled the startup pass**, because the guard read `> 0`. Zero now
  means "immediately"; only `intervalMs: 0` has an off switch.

### Added

- **Scheduled and on-demand refresh.** A pass runs `startupDelayMs` after mount, then every
  `intervalMs` (default six hours), and on demand through the `refresh_model_catalog` tool.
- **Live interrogation** of `GET {baseURL}/models` for the OpenAI dialects and
  `GET {root}/v1/models?limit=1000` for Anthropic Messages, normalizing both reply dialects —
  the standard `data` array and the enriched `models` map — and reading capacities from every
  spelling gateways publish (`context_length`, `max_input_tokens`, `top_provider.*`, …).
- **Catalog metadata merged onto live ids**, so a newly discovered model arrives with its
  `contextWindow`, `maxTokens`, and `input` modalities instead of a bare id.
- **Append-only writes** through `settings.mutate()`, preserving user entries by reference and
  re-reading the settings revision before each write, with one retry and a read-back confirmation.
- **Route discovery through the harness** (`llm.listConfigurableProviders()`), so the settings
  namespace and path are never hard-coded.
- **Endpoint recovery from the catalog's models**, because several real catalog providers
  (`opencode-go`) carry no provider-level `baseUrl` and would otherwise be skipped.
- **Plurality protocol selection** for catalog providers that speak several protocols
  (`openrouter` ships 366 models across two dialects; `opencode-go` across three).

### Guarantees

- Append-only: nothing is ever removed, reordered, or rewritten.
- An unreadable stored `models` value refuses the route instead of overwriting it.
- Every failure mode (transport, HTTP status, parsing, unsupported protocol, rejected write, write
  that did not land) leaves the route's configuration untouched and is reported.
- `reasoningEfforts` and `compat` are never synthesized from a listing.

### Verification

- 81 tests across listing, merge, route planning, the sync engine, plugin wiring, and a real-catalog
  integration test that reproduces discussion #3816 against the installed pi-ai 0.85.1.
- A real boot of `dsh --profile scratch` (`npm run test:e2e`) that asserts the profile patch gained
  the endpoint's model while the hand-written entry survived.
- A live run against OpenRouter's real endpoint: the snapshot (generated 2026-09-05) ships 366
  OpenRouter models while the endpoint serves 464. `stealth/space-bunny-alpha` — absent from the
  snapshot — was appended with the endpoint's own numbers (1,000,000 context / 524,288 output),
  while snapshot-known ids kept the catalog's facts even where the endpoint disagreed
  (`x-ai/grok-4.20`: catalog 1,800,000 vs endpoint 450,000 output cap). A second pass rewrote
  nothing: 465 unique entries and a zero-byte difference.
