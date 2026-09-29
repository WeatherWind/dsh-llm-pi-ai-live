# dsh-llm-pi-ai-live

English | [中文](README.zh.md)

A companion plugin that keeps DSH `llm-pi-ai` provider routes' model catalogs current with what their
endpoints actually serve. It patches nothing: it works through the official `settings`, `credentials`,
`llm`, and `tools` seams.

## Why it exists

The shipped `@deepseek-ai/dsh-llm-pi-ai` adapter answers "which models can this provider serve?" from
pi-ai's installed snapshot for every route the snapshot knows, and never contacts the endpoint:

```js
// dsh-llm-pi-ai/lib/index.js  discoverModels()
const installed = catalogModels(request.provider)
if (installed.size > 0) return [...installed.values()].map(...)   // snapshot, no network
```

That is a deliberate trade — the snapshot carries `contextWindow`, `maxTokens`, and modality facts no
listing endpoint discloses — but it means a model released after the pinned pi-ai version can never
appear, and a hand-written `models` list stays frozen at whatever was typed.

The drift has been reported repeatedly:

- [#3816](https://github.com/deepseek-ai/deepseek-harness/discussions/3816) — opencode-go serves 28 models live, the snapshot knew 16; glm-5.3, qwen3.8-max and others never showed up
- [#5306](https://github.com/deepseek-ai/deepseek-harness/discussions/5306) — "model list is stale and incomplete — never refreshed from provider endpoints"
- [#5691](https://github.com/deepseek-ai/deepseek-harness/discussions/5691) — "model catalogs are static: OpenRouter shows 333 of 431 models"
- [#4685](https://github.com/deepseek-ai/deepseek-harness/discussions/4685) — "fetching models from OpenRouter doesn't work"

This plugin implements what those reports ask for together: **always query the live endpoint, fall
back to the catalog on failure, merge catalog metadata onto live ids, and actually persist the
result into the route.**

## What it does

One refresh — scheduled, on startup, or via the `refresh_model_catalog` tool:

1. **Plan** — read the live configurable-provider directory through
   `llm.listConfigurableProviders()` to learn each route's owning settings namespace and path.
   *Nothing hard-codes `llm-pi-ai`*: the settings namespace is the profile's loader entry id
   (`include:llm-pi-ai` in a stock profile), so a plugin that hard-codes the plugin name silently
   does nothing.
2. **Interrogate** — `GET {baseURL}/models` with bearer auth for the OpenAI dialects,
   `GET {root}/v1/models?limit=1000` with `x-api-key` and `anthropic-version` for Anthropic Messages.
   Both reply dialects normalize into one candidate shape.
3. **Merge** — live ids decide membership; the installed pi-ai catalog supplies `name`,
   `contextWindow`, `maxTokens`, and `input`; an endpoint-reported capacity is the fallback.
4. **Persist** — through `settings.mutate()`, re-reading the revision first and confirming the value
   landed afterwards.

### Guarantees

- **Append-only.** Existing entries pass through by reference, in order, with their fields untouched.
  New ids are appended. A model the endpoint stopped advertising is never removed.
- **Refuse rather than guess.** If the stored `models` value is not a list this plugin can fully
  account for — a string, or an entry with no `id` — the whole route is skipped and reported, instead
  of being overwritten with a guess.
- **Failures never touch the configuration.** A 5xx, a timeout, a non-JSON body, an unreadable
  protocol, or a rejected write all leave the route exactly as it was and appear in the report.
- **No synthesized risky fields.** Only `id`, `name`, `contextWindow`, `maxTokens`, and `input` are
  ever written. `reasoningEfforts` and `compat` are deliberately never inferred from a listing:
  leaving them unset inherits the installed catalog entry's capability, which is always at least as
  correct as anything derivable from a bare list of ids.

## Install

```sh
# 1) build
cd dsh-plugins/dsh-llm-pi-ai-live
npm install && npm run verify && npm run build

# 2) add to the target profile (local path uses link:)
dsh plugin --profile <profile> add link:$PWD

# 3) restart DSH
```

Alternatively merge the `insert` block from `cordis.patch.yml` into
`<DSH_PROFILE_DIR>/cordis.patch.yml`.

Start with `dryRun: true` for the first pass. A dry run **computes and reports without writing**, and
the report goes to the log:

```
[live-catalog] mounted (first pass in 0ms, periodic refresh off, dry run)
[live-catalog] openrouter: dry run — would add 464 model(s): openai/gpt-6.1-sol-pro, ...
[live-catalog] scheduled: 1 updated, 464 added, 0 failed, 0 skipped in 932ms
```

That output is from a real boot against OpenRouter's live endpoint. Turn `dryRun` off once it looks
right.

## Configuration

Every field is optional; defaults are documented in [`cordis.patch.yml`](cordis.patch.yml).

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Master switch; `false` loads the plugin but schedules nothing |
| `startupDelayMs` | `10000` | Delay after mount before the first pass (ms); `0` runs it immediately, and the startup pass always runs |
| `intervalMs` | `21600000` | Period between passes (ms, six hours); `0` disables the periodic pass |
| `timeoutMs` | `30000` | Per-request network timeout |
| `settingsNamespaces` | `[]` | Namespaces to serve; empty auto-detects the pi-ai namespace |
| `include` | `[]` | Routes to refresh; empty means every configured route |
| `exclude` | `[]` | Routes to leave alone, e.g. `['openrouter']` |
| `enrichFromCatalog` | `true` | Fill new entries from the installed pi-ai catalog |
| `maxModels` | `2000` | Cap on stored model entries per route |
| `dryRun` | `false` | Compute and report without writing |
| `toolEnabled` | `true` | Register the `refresh_model_catalog` tool |

## Tool

`refresh_model_catalog` — optional `provider` narrows the pass to one route. Lets the agent pick up a
newly released model on demand, with no config edit or restart.

## What it does not do

- **It does not replace the "fetch available models" action.** `ctx.llm.registerModelDiscovery(ns)`
  throws `DUPLICATE_DISCOVERY` for a namespace that already has one, and `llm-pi-ai` owns its own, so
  no external plugin can replace the built-in short-circuit. This plugin takes the other road: it
  writes the live result into the route's `models`.
- **It does not touch a route with no interrogable endpoint.** A provider with neither a configured
  `baseURL` nor a catalog endpoint (pure-OAuth Bedrock/Vertex) is reported as `NO_ENDPOINT`.
- **It does not probe protocols.** When a catalog route speaks several (OpenRouter ships both an
  Anthropic and an OpenAI dialect), the listing request uses the plurality dialect; the route's own
  models keep their individual protocols.
- **It does not fill fields beyond `models`.** See the guarantee above.
- **A large gateway produces a long `models` list.** Measuring OpenRouter's 464 live models
  wrote about 88 KB into `cordis.patch.yml`. That is the inherent cost of pinning the live
  directory into configuration; `maxModels` (default 2000) is the guard rail, and `exclude`
  can drop a route entirely.

## How it differs from the other plugins in this space

Several community plugins already work this area, and the differences are worth knowing before
choosing. The sharpest one:

- **This plugin does not go through `ctx.llm.discoverModels('llm-pi-ai', …)`.** That service
  short-circuits to the installed snapshot for any route the pi-ai catalog knows — the exact root
  cause #3816 and #5306 describe. A "live sync" built on it receives the snapshot. This plugin makes
  its own HTTP request instead.
- **Protocol-generic**, not tied to one gateway: both the OpenAI dialects and Anthropic Messages
  listings are read.
- **Endpoint recovery from the catalog's models**, which is what makes the common
  "credential-only route" case work for providers like `opencode-go` whose provider record carries no
  `baseUrl`.
- **Append-only with a refusal path**: an unreadable `models` value abandons that route rather than
  overwriting it.
- **Never synthesizes `reasoningEfforts` or `compat`.** Some peers probe or infer thinking levels;
  leaving them unset inherits the catalog capability, and a wrong guess changes the request shape.

Related work: `mpetruc/dsh-model-sync`, `ddddd-ren/dsh-relay-toolkit` (broader — settings UI,
connectivity probing, capability backfill), `Retr67/dsh-opencode-models`, `fan56/dsh-model-sync`,
`zpis666/dsh-opencode-go-sync`, `dsh-model-catalog-refresh`, `dsh-model-catalog-sync`. This plugin's
trade-off is **narrow and verifiable**: no UI panel, with the effort spent on merge semantics and
verification depth.

## Development

```sh
npm run typecheck   # source and tests, via two tsconfigs
npm test            # vitest (unit + real-catalog integration)
npm run build       # src → lib
npm run verify      # typecheck + test
npm run test:e2e    # boot a real DSH and verify end to end
```

Two layers of tests:

- `test/{listing,merge,routes,sync,index}.test.ts` — pure logic and orchestration over fake seams.
- `test/integration.test.ts` — exercises the #3816 scenario (an `opencode-go` route configured with
  nothing but a credential) against the **real** installed catalog, and skips itself when
  `@earendil-works/pi-ai` is not resolvable.

To run the real-catalog integration test, link the profile's packages in:

```sh
PROF=$DSH_PROFILE_DIR/node_modules
mkdir -p node_modules/@earendil-works
ln -sfn $PROF/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
```

### End-to-end verification

`npm run test:e2e`:

1. builds a throwaway `DSH_HOME` and `scratch` profile under this package's `.e2e/`;
2. links the packages of the profile you point it at (default `~/.dsh/profiles/desktop`) and links
   this package in **by name** — the loader imports a bare specifier, and an absolute directory path
   cannot be resolved by ESM, so `name:` must be the package name;
3. serves a fake `/models` endpoint on `127.0.0.1` and writes a patch mounting a real `llm-pi-ai`
   route;
4. boots the real `dsh --profile scratch`;
5. asserts the profile patch gained the endpoint's new model while the hand-written entry survived.

Point it elsewhere with `DSH_PROFILE_DIR=... npm run test:e2e`. No server other than the local fake
endpoint is started.

**This step is not optional.** It caught two defects no unit test could: a missing `timer` in
`inject` that stopped the plugin activating in a real profile at all, and a `startupDelayMs: 0` guard
that silently skipped the startup pass. Both are fixed and pinned by regression tests.

### Dependencies and resolution

Per the official [publish.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md)
and the [app-boot README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md):

- Before importing a plugin, DSH checks every `@deepseek-ai/dsh` and `@deepseek-ai/dsh-*` entry in
  `peerDependencies` **against the runtime version** and refuses a mismatch. This plugin declares
  `>=0.1.7-rc.2 <0.2.0`.
- Those packages are **distributed inside the DSH installation and have no matching version on the
  public registry**, so every peer is marked `optional: true`: the version claim still feeds the
  admission check, while pnpm is never sent looking for a package it cannot fetch.
- Peers outside `@deepseek-ai/dsh*` (cordis, the timer plugin, pi-ai) are not admission-checked and
  are optional too.
- `@deepseek-ai/schemastery` stays a plain `dependencies` entry: it is a stateless schema utility,
  which the official guide puts under `dependencies`, and shipping our own copy guarantees the plugin
  loads in any profile.

**How pi-ai is found.** The plugin does not depend on pi-ai at build time and resolves it at runtime
in two steps: the ordinary bare import first, then a filesystem search, which matters because
`dsh plugin add` produces pnpm's non-hoisted layout. The usual fallback cannot help — pi-ai exports
no `./package.json` and declares its subpaths under the `import` condition alone — so the plugin
carries a minimal `exports` wildcard resolver (pi-ai declares `"./providers/*"`, not a literal key).
When both steps fail it is **not an error**: new models simply carry only what the endpoint disclosed.

### Environment

`inject: ['settings', 'llm', 'timer']` are hard dependencies; `timer` comes from
`@deepseek-ai/cordis-plugin-timer`, which `dsh-base` already includes. `credentials` and `tools` are
read optionally through `ctx.get`: without them the plugin still refreshes, it simply cannot resolve
an `apiKeyEnv` reference and has no manual tool.

## License

MIT
