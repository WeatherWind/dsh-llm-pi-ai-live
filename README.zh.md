# dsh-llm-pi-ai-live

[English](README.md) | 中文

给 DSH 的 `llm-pi-ai` provider 路由做**模型列表实时刷新**的伴生插件。不改动 DSH 本体，走官方
`settings` / `credentials` / `llm` / `tools` 缝隙。

## 为什么需要它

内置的 `@deepseek-ai/dsh-llm-pi-ai` 在回答"这个 provider 现在能提供哪些模型"时，对 pi-ai catalog
**已经认识**的路由直接短路返回安装包里的快照，**完全不发网络请求**：

```js
// dsh-llm-pi-ai/lib/index.js  discoverModels()
const installed = catalogModels(request.provider)
if (installed.size > 0) return [...installed.values()].map(...)   // 直接返回快照
```

这是个有意的取舍——快照里带着 listing 端点不会公开的 `contextWindow`、`maxTokens`、多模态等元数据——
但代价是：**pin 住的 pi-ai 版本之后发布的模型永远出不来**，用户手写的 `models` 列表也会一直冻结在
当初抄下来的那几行。

社区已经反复报告过这个漂移：

- [#3816](https://github.com/deepseek-ai/deepseek-harness/discussions/3816) — `opencode-go` 线上 28 个模型，快照只有 16 个；新模型（glm-5.3、qwen3.8-max、gpt-5.6-luna…）永远显示不出来
- [#5306](https://github.com/deepseek-ai/deepseek-harness/discussions/5306) — 「模型列表陈旧且不完整，从不向 provider 端点刷新」
- [#5691](https://github.com/deepseek-ai/deepseek-harness/discussions/5691) — 「目录是静态的：OpenRouter 431 个模型只显示 333 个」
- [#4685](https://github.com/deepseek-ai/deepseek-harness/discussions/4685) — 「从 OpenRouter 拉取模型不工作」

本插件就是这些报告里共同诉求的落地：**总是查线上端点、失败时回落快照、把快照的元数据合并到线上
id 上、并且把结果真正写进路由配置。**

## 它做什么

一次刷新（定时触发、启动后触发，或调用 `refresh_model_catalog` 工具）：

1. **发现路由** — 从 `llm.listConfigurableProviders()` 取实时的 configurable-provider 目录，
   拿到每条路由真正所属的 settings namespace 与 settingsPath。
   *不硬编码 `llm-pi-ai`*：settings namespace 是 profile 的 loader entry id（stock profile 里是
   `include:llm-pi-ai`），写死它的插件会静默失效。
2. **探测端点** — OpenAI 系协议走 `GET {baseURL}/models`（Bearer），Anthropic Messages 走
   `GET {root}/v1/models?limit=1000`（`x-api-key` + `anthropic-version`），两种响应方言都归一化。
3. **合并** — 线上 id 决定"有哪些模型"，已安装的 pi-ai catalog 决定 `name` / `contextWindow` /
   `maxTokens` / `input`；端点自己报了容量的则以端点值兜底。
4. **写回** — 通过 `settings.mutate()` 写入，写前重读 revision，写后回读确认真的落地。

### 保证

- **只追加，绝不删改。** 用户已有的条目按原顺序、原字段、原对象引用原样穿过，只在末尾追加新 id。
  端点已下线的模型**不会**被移除。
- **读不懂就不写。** 若既有 `models` 不是一份能完整解释的列表（比如被误写成字符串、或有条目缺
  `id`），整条路由放弃并报告——而不是猜一个值把它覆盖掉。
- **失败不动配置。** 端点 5xx、超时、返回非 JSON、协议不可读、写入被拒——任何一步失败都只报告，
  该路由配置保持原样。
- **不合成危险字段。** 只写 `id` / `name` / `contextWindow` / `maxTokens` / `input` 这五个语义
  明确的字段。`reasoningEfforts`、`compat` 这类字段**绝不**从列表推断：留空即继承 catalog 条目的
  能力，永远比"从裸列表猜"更准。

## 安装

```sh
# 1) 构建
cd dsh-plugins/dsh-llm-pi-ai-live
npm install && npm run verify && npm run build

# 2) 装进目标 profile（本地路径用 link:）
dsh plugin --profile <profile> add link:$PWD

# 3) 重启 DSH
```

也可以手工把 `cordis.patch.yml` 里的 `insert` 段并入 `<DSH_PROFILE_DIR>/cordis.patch.yml`。

首次使用建议先开 `dryRun: true` 跑一轮。dry run **只计算并报告，绝不写入**，报告直接进日志：

```
[live-catalog] mounted (first pass in 0ms, periodic refresh off, dry run)
[live-catalog] openrouter: dry run — would add 464 model(s): openai/gpt-6.1-sol-pro, ...
[live-catalog] scheduled: 1 updated, 464 added, 0 failed, 0 skipped in 932ms
```

（上面是一次对真实 OpenRouter 端点、真实 DSH 启动的实测输出。）确认无误后把 `dryRun` 关掉即可。

## 配置

全部字段可省略。默认值见 [`cordis.patch.yml`](cordis.patch.yml)。

| 字段 | 默认值 | 含义 |
|---|---|---|
| `enabled` | `true` | 总开关；`false` 时只加载不调度 |
| `startupDelayMs` | `10000` | 挂载后首次刷新的延迟（毫秒）；`0` = 立即执行（首次刷新总会执行） |
| `intervalMs` | `21600000` | 刷新周期（毫秒，默认 6 小时）；`0` 关闭周期刷新 |
| `timeoutMs` | `30000` | 单次网络请求超时 |
| `settingsNamespaces` | `[]` | 要服务的 namespace；空 = 从目录自动探测 pi-ai 的 namespace |
| `include` | `[]` | 只刷新这些 provider 路由；空 = 全部已配置路由 |
| `exclude` | `[]` | 跳过的 provider 路由，例如 `['openrouter']` |
| `enrichFromCatalog` | `true` | 用已安装 pi-ai catalog 补齐新条目的元数据 |
| `maxModels` | `2000` | 每条路由存储的模型数上限 |
| `dryRun` | `false` | 只计算并报告，不写入 |
| `toolEnabled` | `true` | 是否注册 `refresh_model_catalog` 工具 |

## 工具

`refresh_model_catalog`（可选参数 `provider`：只刷新某一条路由）——让 agent 在 provider 发布新模型后
按需刷新，无需改配置或重启。

## 它不做什么

- **不替换内置的「拉取可用模型」按钮。** `ctx.llm.registerModelDiscovery(ns)` 对同一 namespace
  重复注册会抛 `DUPLICATE_DISCOVERY`，而 `llm-pi-ai` 已占用该 namespace，所以外部插件无法在设置页
  替换内置的短路逻辑。本插件走的是另一条路：把实时结果**真正写进**路由的 `models`。
- **不碰没有端点可查的路由。** 一个既没有 `baseURL`、catalog 也没给端点的 provider（例如纯 OAuth
  的 Bedrock/Vertex）会被报告为 `NO_ENDPOINT` 并跳过。
- **不做协议探测。** 一个 catalog 路由若同时说多种协议（OpenRouter 就同时有 Anthropic 与 OpenAI
  方言），列表请求按**多数派**协议发；该路由自己的模型仍各自保留协议不变。
- **不自动补 `models` 之外的字段。** 见上文"不合成危险字段"。
- **大型网关会写出很长的 `models` 列表。** 实测 OpenRouter 线上 464 个模型，写进
  `cordis.patch.yml` 后约 88 KB。这是"把线上目录固化进配置"的必然代价；`maxModels`
  默认 2000 是上限护栏，`exclude` 可以整条路由排除。

## 与同类插件的区别

这个方向已经有若干社区插件，选择时值得知道彼此的差别。特别值得指出：

- **不要再走 `ctx.llm.discoverModels('llm-pi-ai', …)`。** 那个服务对 pi-ai catalog 认识的路由
  直接短路返回安装包里的快照，是 #3816/#5306 抱怨的根因。有的同类插件正是通过它取列表，于是
  「实时同步」拿到的其实是快照。本插件自己发 HTTP 请求。
- **本插件是协议通用的**，不是只服务某一家网关：OpenAI 系 + Anthropic Messages 两种列表方言都读。
- **provider 级没有 endpoint 时从模型级取。** `opencode-go` 在 catalog 里 `baseUrl` 为空、只有
  模型级才有——不处理这点，最典型的「只配了一个 credential」场景会被直接跳过。
- **只追加、读不懂就拒绝。** `models` 若是读不懂的值，本插件放弃该路由而不是覆盖它。
- **绝不合成 `reasoningEfforts` / `compat`。** 有些同类插件会探测或按家族推断思考等级；本插件
  留空让其继承 catalog 能力，因为猜错会直接改变请求形状。

同类参考：`mpetruc/dsh-model-sync`、`ddddd-ren/dsh-relay-toolkit`（功能更宽，含设置页 UI 与
连通性探测）、`Retr67/dsh-opencode-models`、`fan56/dsh-model-sync`、`zpis666/dsh-opencode-go-sync`、
`dsh-model-catalog-refresh`、`dsh-model-catalog-sync`。本插件的取舍是**窄而可验证**：不做 UI 面板，
把力气花在合并语义的正确性和验证深度上。

## 开发

```sh
npm run typecheck   # 源码 + 测试的类型检查（两个 tsconfig）
npm test            # vitest（单元 + 真实 catalog 集成）
npm run build       # src → lib
npm run verify      # typecheck + test
npm run test:e2e    # 真实启动一次 DSH，端到端验证
```

测试分两层：

- `test/{listing,merge,routes,sync,index}.test.ts` — 纯逻辑与编排，全部用假 seam。
- `test/integration.test.ts` — 若能从 `node_modules` 解析到真实的 `@earendil-works/pi-ai`，就用**真实
  catalog** 跑一遍 #3816 的场景（只配了 credential 的 `opencode-go`），否则自动跳过。

做真实 catalog 集成测试时，把 profile 里的包链进来即可：

```sh
PROF=$DSH_PROFILE_DIR/node_modules
mkdir -p node_modules/@earendil-works
ln -sfn $PROF/@earendil-works/pi-ai node_modules/@earendil-works/pi-ai
```

### 端到端验证

`npm run test:e2e` 会：

1. 在本包的 `.e2e/` 下建一个一次性的 `DSH_HOME` 与 `scratch` profile；
2. 链入你指定 profile 的依赖包（默认 `~/.dsh/profiles/desktop`），并把本包按**包名**链进去
   ——loader 导入的是裸标识符，绝对目录路径无法被 ESM 解析，所以 `name:` 必须写包名；
3. 在 `127.0.0.1` 起一个假的 `/models` 端点，写一份真实 `llm-pi-ai` 路由的 patch；
4. 真实启动 `dsh --profile scratch`；
5. 断言 profile patch 文件里新增了端点上的模型、而手写条目原样保留。

用 `DSH_PROFILE_DIR=... npm run test:e2e` 指定包来源。除本地假端点外不启动任何服务。

**这一步不是可选的。** 本项目开发中它抓到了两个单元测试不可能发现的缺陷：
`inject` 缺 `timer` 导致插件在真实 profile 里根本不激活；以及 `startupDelayMs: 0` 让首次刷新
被静默跳过。两处都已修复并有回归测试。

### 依赖与解析

按官方 [publish.md](https://github.com/deepseek-ai/deepseek-harness/blob/master/docs/user/develop/basic/publish.md) 与
[app-boot README](https://github.com/deepseek-ai/deepseek-harness/blob/master/packages/boot/app-boot/README.md)：

- DSH 在导入插件前，会把 `peerDependencies` 里的 `@deepseek-ai/dsh` 与 `@deepseek-ai/dsh-*`
  **对照运行时版本**逐条校验，不匹配即拒绝加载。本插件声明 `>=0.1.7-rc.2 <0.2.0`。
- 但 `@deepseek-ai/dsh-llm` 这类包**只在 DSH 安装体内分发，公共 registry 上并不存在对应版本**。
  所以每个 peer 都标了 `optional: true`——既保留版本声明供准入校验，又避免 pnpm 去 registry
  抓一个取不到的包。
- 非 `@deepseek-ai/dsh*` 的 peer（cordis、timer、pi-ai）不参与准入校验，同样标记 optional。
- `@deepseek-ai/schemastery` 留在 `dependencies`：它是无状态的 schema 工具库，官方文档明确把
  "无状态 dsh 工具"归入 `dependencies`；自带一份也保证插件在任何 profile 里都能加载。

**pi-ai 的定位**：本插件不在构建期依赖 pi-ai，运行期按两级策略取用——先走普通裸导入；失败时
（pnpm 非扁平布局下很常见）退化为在磁盘上定位它。`require.resolve` 这条常规退路走不通，因为
pi-ai 的 `exports` 里没有 `./package.json`，且子路径只在 `import` 条件下导出；本插件因此自带一个
最小的 `exports` 通配符解析器（pi-ai 声明的键是 `"./providers/*"`，不是字面量）。两者都失败时
**不报错**，只是新模型只带端点自报的元数据。

### 环境依赖

`inject: ['settings', 'llm', 'timer']` 是硬依赖。`timer` 由 `@deepseek-ai/cordis-plugin-timer`
提供（`dsh-base` 已包含）。`credentials` 与 `tools` 通过 `ctx.get` 可选读取，缺失时插件照常刷新，
只是无法解析 `apiKeyEnv`、也没有手动工具。

## 许可

MIT
