# web-access 工具参考（CDP 层）

upstream 的 `references/cdp-api.md` 描述的是 `http://localhost:3456/*` 的 HTTP 端点；这里改为 dsh 工具的等参说明。
连接、端口发现、tab 生命周期全部由插件在宿主进程内管理，调用方只需关心参数。

## 连接与前置

Chrome 必须暴露 DevTools 端点，两种方式：

1. Chrome 地址栏打开 `chrome://inspect/#remote-debugging`，勾选
   **Allow remote debugging for this browser instance**（可能需要重启浏览器）。
2. 用调试端口启动：`--remote-debugging-port=9222`。

插件按顺序发现端点：`DevToolsActivePort` 文件（含 Chrome 未显式指定端口时必需的带 UUID 的 WebSocket 路径）
→ 常用端口 9222/9229/9333。发现只用 TCP 探测，因为 WebSocket 探测会让 Chrome 弹出授权对话框。

`web_access_status` 返回发现结果、连接状态与修复步骤。

## 工具参数

### web_access_status
无参数。返回运行时能力（Node/Electron 版本、是否有全局 WebSocket）、Chrome 端点与连接状态、
本插件持有的 tab（含归属 agent 与闲置时长）、站点经验目录与域名列表。

### web_tabs
无参数。返回每个 page tab：`targetId | user|managed | title | url`。

### web_open
| 参数 | 类型 | 说明 |
|------|------|------|
| `url` | string（必填） | 完整 http(s) 地址 |
| `wait` | boolean | 是否等待 `readyState === "complete"`，默认 true |

返回 `{ targetId, loadState, url }`。tab 在后台创建，不抢占用户当前视图。

### web_navigate / web_back
`web_navigate` 需要 `url`（必填）与可选 `target`；`web_back` 只接受可选 `target`。两者都返回 `loadState`。

### web_info
可选 `target`。返回 `{ title, url, ready }`。

### web_eval
| 参数 | 类型 | 说明 |
|------|------|------|
| `expression` | string（必填） | JS 表达式 |
| `target` | string | tab id |
| `awaitPromise` | boolean | 是否 await 返回的 Promise，默认 true |

返回表达式的值（走 `returnByValue`）。页面抛异常时工具返回错误文本，包含异常描述。
DOM 节点不能直接返回——提取属性或 `JSON.stringify()` 后返回。

### web_read
| 参数 | 类型 | 说明 |
|------|------|------|
| `target` | string | tab id |
| `selector` | string | 只读取该子树；省略则整篇文档 |
| `maxChars` | integer | 正文字符预算 |
| `includeLinks` / `includeHeadings` | boolean | 默认 true |

返回 Markdown 形式的分段结果：标题头 / Headings 大纲 / Metadata（meta、canonical、JSON-LD 块数）/ Text / Links。
遍历穿透 `shadowRoot` 与 same-origin iframe，**不按可见性过滤**（折叠、轮播、懒加载内容都会被读到）。

### web_click / web_click_at
都需要 `selector`（必填）与可选 `target`。`web_click` 走 `el.click()`（先 `scrollIntoView`）；
`web_click_at` 取元素中心坐标后派发真实 `mousePressed`/`mouseReleased`（算用户手势）。
元素不存在或没有布局盒时返回错误。

### web_set_files
| 参数 | 类型 | 说明 |
|------|------|------|
| `selector` | string（必填） | 例如 `input[type=file]` |
| `files` | string[]（必填） | 本地绝对路径列表 |
| `target` | string | tab id |

走 `DOM.setFileInputFiles`，完全绕过原生文件对话框。

### web_scroll
`direction`（必填：down/up/top/bottom），可选 `amount`（默认 3000 px）、`target`。滚动后等待 800ms 触发懒加载。

### web_screenshot
可选 `target`、`path`（省略则写入 `$DSH_HOME/web-access/shots/`）、`fullPage`、`format`（png/jpeg）。
返回 `{ target, file, bytes, format, next }`。用 `read_image` 打开返回的路径查看。

### web_video
`action`（必填：probe/seek），可选 `selector`（默认 `video`）、`seconds`、`target`。
probe 返回 `{ src, duration, currentTime, paused, readyState, width, height }`；
seek 设置 `currentTime` 并等待 `seeked` 事件。采帧用 `seek` → `web_screenshot`。

### web_close
可选 `target`；`all: true` 关闭本插件持有的全部 tab。用户原有 tab 永不受影响。

### web_find_url
可选：`keywords`（string[]，多词 AND）、`only`（bookmarks/history）、`limit`（默认 20，0 不限）、
`since`（`1d` / `7h` / `30m` / `YYYY-MM-DD`，仅历史）、`sort`（recent/visits，仅历史）。
历史库以只读副本方式打开，优先用 `node:sqlite`，缺失时回退 `sqlite3` 命令。

### web_site_patterns
`action`（必填：list/read/match/write），可选 `domain`、`query`、`content`、`aliases`。
`write` 会补全 front matter（`domain` / `aliases` / `updated`）后写入
`$DSH_HOME/web-access/site-patterns/<domain>.md`；`read`/`match` 同时会读到插件内附带的经验。

## 常用 JS 提取模式

```js
// 页面上的全部链接（含去重后的绝对地址）
[...document.querySelectorAll('a[href]')]
  .map(a => ({ text: a.innerText.trim().slice(0, 80), url: a.href }))
  .filter(x => x.text)

// 穿透 Shadow DOM 收集文本
(() => {
  const out = [];
  const walk = (root) => {
    for (const el of root.querySelectorAll('*')) {
      if (el.shadowRoot) walk(el.shadowRoot);
      if (el.children.length === 0 && el.textContent.trim()) out.push(el.textContent.trim());
    }
  };
  walk(document);
  return out.slice(0, 200);
})()

// 批量数据（结构化字段优先，避免整页 HTML）
JSON.stringify([...document.querySelectorAll('.item')].map(el => ({
  title: el.querySelector('.title')?.innerText ?? null,
  href: el.querySelector('a')?.href ?? null,
})), null, 1)

// 等渲染完成再取数
await new Promise(r => setTimeout(r, 1500)); document.querySelector('.list')?.children.length

// 媒体 URL（先滚到底触发懒加载）
[...document.querySelectorAll('img')].map(i => i.currentSrc || i.src).filter(Boolean)
```

## 错误处理

| 现象 | 原因 | 解决 |
|------|------|------|
| `no Chrome DevTools endpoint found` | Chrome 未开远程调试 | 按返回的 hints 开启后重试；或在插件配置里 pin `port` |
| `the Chrome connection is not open` | 连接已断开（Chrome 退出/重启） | 直接重试；端口缓存会在重连时重新发现 |
| `no tab is selected` | 未打开 tab 就用了默认 target | 先 `web_open`，或传 `web_tabs` 返回的 `target` |
| `target <id> cannot be attached - the tab is gone` | targetId 无效，或 tab 已被关闭（用户手动关闭、浏览器回收、崩溃） | 该 tab 已被剔除出默认目标；用 `web_tabs` 取在线 tab，或重新 `web_open` |
| `no element matches <selector>` | 选择器与当前 DOM 不符 | `web_read` 看结构，或 `web_eval` 查 `document.querySelectorAll(...)` |
| `CDP command timed out` | 页面长时间无响应 | 重试；必要时 `web_close` 后重新 `web_open` |
| 网络请求被拒（匿名抓取） | `web_fetch` 的目标地址策略 | 不要重试，改用浏览器层 |
| 命中"内容不存在"页面 | 可能只是访问方式问题 | 用站点内交互取真实 URL（保留全部参数）再试 |

> **tab 会被用户关掉**：用户在浏览器里手动关闭（包括"关闭其他标签页"）会一次性带走本插件持有的 tab。
> 插件在 attach 失败时会把该 tab 从默认目标中剔除，所以下一次省略 `target` 的调用会落到仍然存活的 tab 上，
> 或者明确报 `no tab is selected`——不会反复卡在同一个死 target 上。
> `web_close` 对"用户已经关掉的"tab 视为成功，不报错。
