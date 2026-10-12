# DSH 插件 API 要点（移植过程中逆向所得）

移植 web-access 到 dsh 时，官方插件文档并不在产品内，这些结论来自对运行的
DeepSeek Harness 安装的实际读取与实测验证。记录在此，便于后续写别的 dsh 插件。

## 为什么不是从 GitHub 读的

本次环境里 `web_fetch` 对 github.com 报 `resolves to a non-public IP address`，浏览器层
（一次性 profile 的 headless Edge）得到 `ERR_CONNECTION_CLOSED`。所以 dsh 接口定义全部取自本机
`app.asar`。普通 fs 工具解析 asar 头会 `Cannot mix BigInt and other types` 而失败，
故用仓库里的 [`tools/asar-extract.mjs`](../tools/asar-extract.mjs) 直接按格式解：

```bash
# 列出候选包
node tools/asar-extract.mjs list "$DSH_APP/resources/app.asar" "^dsh/node_modules/@deepseek-ai/[^/]+/package\.json$"
# 解出需要的包（只有编译后的 lib/*.js，没有 .d.ts）
node tools/asar-extract.mjs extract "$DSH_APP/resources/app.asar" ./asar-out "dsh/node_modules/@deepseek-ai/dsh-tools"
```

## asar 布局

```
app.asar
├── package.json                      # Electron 应用清单
└── dsh/
    ├── package.json                  # dsh 自身清单
    ├── desktop-runtime.json          # 随包运行时（node/pnpm/python 版本）
    └── node_modules/@deepseek-ai/*   # 全部 dsh 包（编译产物）
```

## 一个 host 插件长什么样

```js
export const name = 'my-plugin'          // loader 诊断用
export const inject = ['tools']          // 依赖的服务；缺一则不挂载
export const Config = z.object({ ... })  // 可选；schemastery。省略则 config 原样传入
export async function apply(ctx, config) { ... }
```

注册与清理（对 HMR 安全）：

```js
ctx.effect(() => ctx.tools.register(toolDefinition), 'label')  // 返回 disposer
ctx.get('skills')        // 可选服务：undefined 时降级
ctx.get('systemPrompt')  // 可选：section({ name, order, text })
ctx.logger.info(msg)
```

## `defineTool` 的真实契约

见 `@deepseek-ai/dsh-tools/lib/types/schema.js`。它把作者 DSL 编译成原始 JSON Schema 再包一层
参数校验；**直接用原始 schema 调 `ctx.tools.register` 也完全合法** —— 本插件就绕开了 `defineTool`，
从而做到零外部 import（因此 `test/selfcheck.mjs` 能用裸 node 跑完整模块图）。

原始 schema 只接受这些关键字：
`type` / `oneOf` / `properties` / `required` / `additionalProperties` / `items` / `enum` / `const`，
外加注解 `description` / `title` / `default` / `examples`。要点：

- `type` 只能是 `string|number|integer|boolean|null|array|object`（作者 DSL 的 `json` 是编译期专用）
- **object 必须显式声明 `additionalProperties: boolean`**
- `required` 只能是对象层的**字符串数组**；作者 DSL 里逐属性的 `required: true` 是编译器输入，不是原始 schema
- `oneOf` 至少两项，且不得与 `properties`/`required`/`items`/`enum`/`const` 同时出现

`register(definition)` 只校验 `output.schema` 与 `timeoutMs`。工具定义形状为
`{ name, description, parameters, timeoutMs, output: { schema, render }, execute }`，
`render(args, value)` 返回 ContentBlock 数组（如 `[{ type: 'text', text }]`）。
`run_code` 是保留名，同层重名会报错。可选字段：`deferLoading`、`isConcurrencySafe`、
`finalizeContent`、`projectContent`、`presentCall`、`presentResult`、`output.presentationMeta`。

## Bundle 插件包结构

照抄一个现成的第三方 bundle 最省事（本机装的是 `@yuxianglin/dsh-bridge-browser`）：

```
package.json     type: module, main: lib/index.js,
                 dsh.bundle.patch: "./cordis.patch.yml",
                 exports 需含 "./cordis.patch.yml"
cordis.patch.yml - insert: [ { id, name, config } ]
lib/index.js     上面的 host 插件
```

`dsh.client` 字段用于带前端半边的插件（本插件不需要）。

## 装载路径

- profile 根：`$DSH_HOME/profiles/<name>/`
- profile 清单：`package.json` 的 `dsh.profile.bundles` + `dependencies`
- 插件实体：`profiles/<name>/node_modules/<name>`（本地开发用 `link:`）
- 用户补丁层：`profiles/<name>/cordis.patch.yml`（按 `id` 覆盖 config / disable / insert）
- bundle 自带补丁：`<包>/cordis.patch.yml`，由 `dsh.bundle.patch` 指向

`install_bundle` 的 spec 解析（`dsh-plugin-manager/lib/types/install-spec.js`）：绝对路径 →
`kind: 'path'`；也接受 `file:` / `link:` 前缀、npm 名、git 速记、tarball。安装后 `reconcile()`
会把新依赖里声明了 `dsh.bundle` 的包自动追加进 `dsh.profile.bundles`。

## 关键服务（`cordis_inspect_query`，provider = `Service`）

| 服务 | 用途 |
|------|------|
| `tools.register(definition)` | 注册工具（本插件主通道） |
| `skills.register(skill)` / `registerProvider` | 注册 skill（`content` + `resourceBase`） |
| `systemPrompt.section/context` | 注入提示段 |
| `web.registerFetchProvider(provider)` | 替换 `web_fetch` 的抓取实现（`{ id, available(), fetch() }`） |
| `browserUse.register(name)` | 占位共享 browser-use provider 槽 |
| `subprocess.spawn` | 抽象子进程（宿主内，不受 agent 沙箱影响） |
| `attachments.saveImages` / `readImage` | 二进制附件 |

## 宿主运行时事实

Electron 44 / Node 24.18.1（`process.versions` 实测），随包运行时 node 24.21.0、pnpm 11.7.0、
python 3.12.14。因此**全局 `WebSocket` 与 `node:sqlite` 都可用** —— 本插件的 CDP 客户端与
历史检索正是建立在这一点上（`lib/cdp.js`、`lib/chrome-data.js`）。

## 两条容易踩的装载陷阱

1. **改了 `lib/*.js` 必须重启 dsh**。`set_bundle` 禁用再启用只会重挂插件
   （日志 `application: applied`），ESM 模块在进程内被缓存，新代码不会重新导入 ——
   本插件实测确认过：重启前 `web_read` 仍返回旧行为。想让改动热生效，可把插件目录加进
   profile `cordis.patch.yml` 里 `hmr` 行的 `root`。
2. **同层工具重名会直接报错**。所以 `web_*` 工具必须避开内置 web 插件的 `web_fetch` /
   `web_search`，以及浏览器桥扩展的 `browser_*`。
