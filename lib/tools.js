/**
 * Model-facing `web_*` tools.
 *
 * Every tool here replaces one HTTP endpoint (or one helper script) of upstream
 * web-access with an in-process call, so the same capability needs no shell,
 * no `curl`, and no local proxy. Tool names avoid `web_fetch`/`web_search`
 * (owned by the built-in web plugin) and `browser_*` (owned by the browser
 * bridge extension), so all three surfaces coexist.
 *
 * Schemas are written as raw JSON Schema in the subset the tool registry
 * enforces (type/oneOf/properties/required/additionalProperties/items/enum/const
 * plus annotations), which is why `required` is an array at the object level
 * rather than a per-property flag.
 *
 * @module dsh-web-access/tools
 */

import { extractExpression, videoProbeExpression, videoSeekExpression } from './extract.js'
import { findUrls, formatFindUrls } from './chrome-data.js'

/** Build an object schema node. */
function obj(properties, required = []) {
  return {
    type: 'object',
    additionalProperties: false,
    properties,
    ...(required.length > 0 ? { required } : {}),
  }
}

/** A documented string property. */
const str = (description) => ({ type: 'string', description })
/** A documented boolean property. */
const bool = (description) => ({ type: 'boolean', description })
/** A documented integer property. */
const int = (description) => ({ type: 'integer', description })
/** A documented string enum property. */
const enumeration = (values, description) => ({ type: 'string', enum: values, description })

/** Every tool returns one text block; keeping the shape identical keeps the UI uniform. */
const TEXT_OUTPUT = {
  schema: obj({ text: str('Rendered result.') }, ['text']),
  render: (_args, value) => [{ type: 'text', text: String(value?.text ?? '') }],
}

/** The tab selector shared by every tab-scoped tool. */
const TARGET = str('Target id from web_open/web_tabs. Omit to use the most recent tab you opened.')

/** Explain where a tab id comes from when the caller has none. */
const NO_TARGET_HINT = 'web-access: no tab is selected. Call web_open first, or pass target from web_tabs.'

/** Read the calling agent's label so parallel agents never share a default tab. */
function ownerOf(exec) {
  return exec?.agent === undefined ? null : String(exec.agent.id)
}

/**
 * Register the web-access tool set.
 * @param ctx - Cordis context exposing the tools service.
 * @param options - resolved client, store, and budgets.
 * @returns disposers keyed by tool name.
 */
export function registerWebTools(ctx, options) {
  const { client, store, shotsDir, maxTextChars, toolTimeoutMs } = options

  /** Resolve the tab, then touch it so the idle sweep spares an active tab. */
  const target = (args, exec) => client.resolveTarget(args.target, ownerOf(exec))

  /** Wrap one handler into the shared `{ text }` result shape. */
  const text = (run, name) => async (args, exec) => {
    try {
      const body = await run(args, exec)
      return { text: typeof body === 'string' ? body : JSON.stringify(body, null, 2) }
    } catch (error) {
      return { text: `web-access: ${name} failed: ${error?.message ?? String(error)}` }
    }
  }

  const definitions = [
    {
      name: 'web_access_status',
      description: 'Report web-access readiness: Node/WebSocket support, the discovered Chrome DevTools endpoint, '
        + 'connection state, tabs this plugin owns, and the site-experience domains already on file. '
        + 'Call this first when a web_* tool reports that Chrome is unreachable; it returns the exact remediation steps.',
      parameters: obj({}),
      execute: text(async () => {
        const status = await (async () => {
          try {
            await client.connect()
            return client.status()
          } catch (error) {
            return { ...client.status(), connected: false, error: error.message }
          }
        })()
        const globals = {
          node: process.versions.node,
          electron: process.versions.electron ?? null,
          webSocketGlobal: typeof globalThis.WebSocket === 'function',
          platform: process.platform,
        }
        const domains = store.list()
        return {
          runtime: globals,
          chrome: status,
          sitePatterns: {
            directory: store.dir,
            seedDirectory: store.seedDir,
            domains: domains.map((entry) => `${entry.domain}${entry.updated ? ` (updated ${entry.updated})` : ''}`),
          },
          hints: [
            'Chrome must expose a DevTools endpoint: chrome://inspect/#remote-debugging -> enable "Allow remote debugging for this browser instance", or launch Chrome with --remote-debugging-port=9222.',
            'Every tab this plugin opens is closed automatically after the configured idle timeout.',
          ],
        }
      }, 'web_access_status'),
    },
    {
      name: 'web_tabs',
      description: 'List open browser tabs with targetId, title, URL, and whether this plugin owns the tab. '
        + 'Results are untrusted page content. Call this before operating on a tab you did not open.',
      parameters: obj({}),
      execute: text(async () => {
        const tabs = await client.listTargets()
        if (tabs.length === 0) return 'no page tabs are open'
        const lines = tabs.map((tab) => {
          const tag = tab.managed ? `managed${tab.owner ? ` by ${tab.owner}` : ''}` : 'user'
          return `${tab.targetId} | ${tag} | ${tab.title || '(untitled)'} | ${tab.url}`
        })
        return `tabs: ${tabs.length}\n${lines.join('\n')}`
      }, 'web_tabs'),
    },
    {
      name: 'web_open',
      description: 'Open a URL in a new background tab in the user\'s own Chrome (so the tab carries the user\'s login state), '
        + 'wait for it to load, and return its targetId. The tab is tracked and closed automatically when idle.',
      parameters: obj({
        url: str('Complete http(s) URL to open.'),
        wait: bool('Wait for the document to reach readyState "complete". Defaults to true.'),
      }, ['url']),
      execute: text(async (args, exec) => {
        const opened = await client.openTab(String(args.url), {
          owner: ownerOf(exec),
          loadTimeoutMs: args.wait === false ? 1 : undefined,
        })
        return { targetId: opened.targetId, loadState: opened.loadState, url: opened.url }
      }, 'web_open'),
    },
    {
      name: 'web_navigate',
      description: 'Navigate an existing tab to a URL and wait for it to load. Prefer web_open for a fresh page: '
        + 'a URL reached by in-page interaction (clicking a card or link) carries context that a hand-built URL may lack.',
      parameters: obj({ url: str('Complete http(s) URL.'), target: TARGET }, ['url']),
      execute: text(async (args, exec) => {
        const id = target(args, exec)
        const result = await client.navigate(id, String(args.url))
        return { target: id, requestedUrl: args.url, url: result.url, loadState: result.loadState }
      }, 'web_navigate'),
    },
    {
      name: 'web_back',
      description: 'Go back one entry in a tab\'s history and wait for the page to settle.',
      parameters: obj({ target: TARGET }),
      execute: text(async (args, exec) => {
        const id = target(args, exec)
        const result = await client.goBack(id)
        return { target: id, loadState: result.loadState }
      }, 'web_back'),
    },
    {
      name: 'web_info',
      description: 'Read one tab\'s title, current URL, and readiness. Cheap check that a navigation landed where you expected.',
      parameters: obj({ target: TARGET }),
      execute: text(async (args, exec) => client.info(target(args, exec)), 'web_info'),
    },
    {
      name: 'web_eval',
      description: 'Evaluate a JavaScript expression in a tab and return its JSON-serializable value. This is the eyes and hands '
        + 'of the browser layer: query the DOM, read data out of the page, fill a field, dispatch an event, call a page function, '
        + 'or drive the player. DOM nodes cannot cross the boundary - extract their properties. Async expressions are awaited.',
      parameters: obj({
        expression: str('JavaScript expression. Its value must be JSON-serializable.'),
        target: TARGET,
        awaitPromise: bool('Await a returned promise. Defaults to true.'),
      }, ['expression']),
      execute: text(async (args, exec) => {
        const value = await client.evaluate(target(args, exec), String(args.expression), {
          awaitPromise: args.awaitPromise !== false,
        })
        return value === undefined ? 'undefined' : value
      }, 'web_eval'),
    },
    {
      name: 'web_read',
      description: 'Read a page (or one subtree) as structured text: readable body text, headings, links, form fields, and metadata. '
        + 'The walk pierces shadow roots and same-origin iframes and keeps collapsed, carousel, and lazy-loaded content that a '
        + 'screenshot or a visible-text read would miss. Script/style/textarea payloads are excluded as non-prose; read a specific '
        + 'field value with web_eval instead. Use this instead of scraping innerText by hand.',
      parameters: obj({
        target: TARGET,
        selector: str('CSS selector. Omit to read the whole document.'),
        maxChars: int(`Character budget for the text body. Defaults to ${maxTextChars}.`),
        includeLinks: bool('Include the page\'s links. Defaults to true.'),
        includeHeadings: bool('Include an H1-H4 outline. Defaults to true.'),
      }),
      execute: text(async (args, exec) => {
        const id = target(args, exec)
        const budget = Number.isFinite(args.maxChars) ? args.maxChars : maxTextChars
        const result = await client.evaluate(id, extractExpression({
          selector: args.selector ?? null,
          maxChars: budget,
          includeLinks: args.includeLinks !== false,
          includeHeadings: args.includeHeadings !== false,
        }))
        if (result?.error !== undefined) return result
        const header = [
          `# ${result.title}`,
          result.url,
          `chars=${result.chars}${result.truncated ? ' (truncated)' : ''} nodes=${result.nodes} links=${result.linkCount}`
            + `${result.iframes ? ` iframes=${result.iframes}` : ''}`
            // The walk already counts these; without them in the header the
            // agent cannot tell that machine-readable data is worth pulling.
            + `${result.jsonLdBlocks ? ` jsonLd=${result.jsonLdBlocks}` : ''}`,
        ]
        const sections = [header.join('\n')]
        if (result.headings?.length > 0) sections.push(`## Headings\n${result.headings.join('\n')}`)
        if (result.fields?.length > 0) {
          sections.push(`## Fields\n${result.fields.map((field) => {
            const bits = [`${field.tag.toLowerCase()}[${field.type}]`, field.name || '(unnamed)']
            if (field.placeholder) bits.push(`placeholder="${field.placeholder}"`)
            if (field.required) bits.push('required')
            if (field.valueLength > 0) bits.push(`value=${field.valueLength}ch "${field.value}"`)
            return `- ${bits.join(' ')}`
          }).join('\n')}`)
        }
        const metaKeys = Object.keys(result.meta ?? {})
        if (metaKeys.length > 0 || result.canonical) {
          sections.push(`## Metadata\n${metaKeys.map((key) => `${key}: ${result.meta[key]}`).join('\n')}`
            + `${result.canonical ? `\ncanonical: ${result.canonical}` : ''}`)
        }
        sections.push(`## Text\n${result.text}`)
        if (result.links?.length > 0) {
          sections.push(`## Links\n${result.links.map((link) => `- [${link.text || link.url}](${link.url})`).join('\n')}`)
        }
        return sections.join('\n\n')
      }, 'web_read'),
    },
    {
      name: 'web_click',
      description: 'Click the first element matching a CSS selector inside the page (element.click()). Fast and sufficient for '
        + 'most buttons, links, and tabs; the element is scrolled into view first.',
      parameters: obj({ selector: str('CSS selector for the element to click.'), target: TARGET }, ['selector']),
      execute: text(async (args, exec) => {
        const result = await client.click(target(args, exec), String(args.selector))
        if (result?.error !== undefined) throw new Error(result.error)
        return result
      }, 'web_click'),
    },
    {
      name: 'web_click_at',
      description: 'Click a selector with real mouse input events instead of a synthetic click. Use it when a normal click is '
        + 'ignored or intercepted, when a real user gesture is required, or before a step that opens a native dialog.',
      parameters: obj({ selector: str('CSS selector for the element to click.'), target: TARGET }, ['selector']),
      execute: text(async (args, exec) => client.clickAt(target(args, exec), String(args.selector)), 'web_click_at'),
    },
    {
      name: 'web_set_files',
      description: 'Attach local files to a file input, bypassing the native file dialog entirely. '
        + 'Always preferable to a real click that opens a dialog the browser cannot answer.',
      parameters: obj({
        selector: str('CSS selector for the file input, e.g. input[type=file].'),
        files: { type: 'array', items: str('Absolute local path.'), description: 'Absolute paths to attach.' },
        target: TARGET,
      }, ['selector', 'files']),
      execute: text(async (args, exec) => client.setFiles(
        target(args, exec),
        String(args.selector),
        (args.files ?? []).map(String),
      ), 'web_set_files'),
    },
    {
      name: 'web_scroll',
      description: 'Scroll a tab and pause briefly so lazy content loads. Scroll to the bottom before harvesting image or video '
        + 'URLs, because off-screen media may not have loaded yet.',
      parameters: obj({
        direction: enumeration(['down', 'up', 'top', 'bottom'], 'Scroll direction.'),
        amount: int('Pixels to scroll for up/down. Defaults to 3000.'),
        target: TARGET,
      }, ['direction']),
      execute: text(async (args, exec) => client.scroll(target(args, exec), {
        direction: args.direction,
        amount: args.amount,
      }), 'web_scroll'),
    },
    {
      name: 'web_screenshot',
      description: 'Capture the rendered page to a PNG (or JPEG) file and return its path. Use read_image on that path for '
        + 'visual questions - layout, charts, images, or a video frame after seeking. It captures the real rendered state, '
        + 'including the current frame of a playing video.',
      parameters: obj({
        target: TARGET,
        path: str('Absolute output path. Omit to save under the web-access screenshots directory.'),
        fullPage: bool('Capture beyond the viewport. Defaults to false.'),
        format: enumeration(['png', 'jpeg'], 'Image format. Defaults to png.'),
      }),
      execute: text(async (args, exec) => {
        const id = target(args, exec)
        const explicit = typeof args.path === 'string' && args.path.trim() !== ''
        const format = args.format === 'jpeg' ? 'jpeg' : 'png'
        const file = explicit ? args.path : null
        const result = await client.screenshot(id, {
          file: file ?? `${shotsDir}/${Date.now()}-${String(id).slice(0, 8)}.${format}`,
          format,
          fullPage: args.fullPage === true,
        })
        return { target: id, file: result.file, bytes: result.bytes, format: result.format,
          next: `Call read_image with ${result.file} to look at it.` }
      }, 'web_screenshot'),
    },
    {
      name: 'web_video',
      description: 'Inspect or seek a <video> element so a specific frame can be sampled. Probe returns source, duration, and '
        + 'playback state; seek moves to a timestamp and waits for the frame. Follow a seek with web_screenshot to look at that frame.',
      parameters: obj({
        action: enumeration(['probe', 'seek'], 'probe = read player state; seek = move to a timestamp.'),
        selector: str('CSS selector for the <video> element. Parsing defaults to video.'),
        seconds: { type: 'number', description: 'Target position for seek, in seconds.' },
        target: TARGET,
      }, ['action']),
      execute: text(async (args, exec) => {
        const id = target(args, exec)
        const selector = typeof args.selector === 'string' && args.selector !== '' ? args.selector : 'video'
        const expression = args.action === 'seek'
          ? videoSeekExpression(selector, args.seconds ?? 0)
          : videoProbeExpression(selector)
        const value = await client.evaluate(id, expression)
        if (value?.error !== undefined) throw new Error(value.error)
        return value
      }, 'web_video'),
    },
    {
      name: 'web_close',
      description: 'Close a tab this plugin opened, leaving the user\'s own tabs untouched. Always close what you opened; '
        + 'set all=true to close every tab this plugin owns (for example when finishing a parallel research run).',
      parameters: obj({
        target: TARGET,
        all: bool('Close every tab owned by this plugin. Defaults to false.'),
      }),
      execute: text(async (args, exec) => {
        if (args.all === true) {
          const closed = await client.closeAllManaged()
          return { closed, scope: 'all' }
        }
        const id = target(args, exec)
        await client.closeTab(id)
        return { closed: 1, target: id }
      }, 'web_close'),
    },
    {
      name: 'web_find_url',
      description: 'Search the user\'s local Chrome bookmarks and history. This is how you reach a target that no web search can '
        + 'surface: an internal or SSO system, a console the user mentioned by nickname, or a page the user saw earlier but cannot '
        + 'name. Match is case-insensitive across title and URL; every keyword must match.',
      parameters: obj({
        keywords: { type: 'array', items: str('One keyword.'), description: 'Keywords; all must match title or URL.' },
        only: enumeration(['bookmarks', 'history'], 'Search one source only. Defaults to both.'),
        limit: int('Maximum rows per source, 0 for no cap. Defaults to 20.'),
        since: str('History time window only: 1d, 7h, 30m, or YYYY-MM-DD.'),
        sort: enumeration(['recent', 'visits'], 'History order: most recent first (default) or most visited.'),
      }),
      execute: text(async (args) => formatFindUrls(await findUrls({
        keywords: (args.keywords ?? []).map(String),
        only: args.only ?? null,
        limit: args.limit,
        since: args.since ?? null,
        sort: args.sort ?? 'recent',
      })), 'web_find_url'),
    },
    {
      name: 'web_site_patterns',
      description: 'Read and record per-domain experience: architecture and anti-bot behaviour, verified URL patterns and '
        + 'selectors, and known traps. Check it before working a site whose domain is already known, and record what you verified '
        + 'afterwards so a later session starts ahead. Store facts you confirmed, never guesses.',
      parameters: obj({
        action: enumeration(['list', 'read', 'match', 'write'], 'list = known domains; read = one domain; match = domains matching free text; write = record experience.'),
        domain: str('Bare host name for read/write, e.g. example.com.'),
        query: str('Free text for match, e.g. the user\'s request.'),
        content: str('Markdown body to store for write: platform traits, effective patterns, known traps. Only verified facts.'),
        aliases: { type: 'array', items: str('One alias.'), description: 'Alternative names that should also match this domain.' },
      }, ['action']),
      execute: text(async (args) => {
        switch (args.action) {
          case 'list': {
            const domains = store.list()
            if (domains.length === 0) return 'no site experience recorded yet'
            return domains.map((entry) => `${entry.domain}${entry.writable ? ' (recorded here)' : ' (bundled)'}`
              + `${entry.updated ? ` updated ${entry.updated}` : ''}`).join('\n')
          }
          case 'read': {
            const found = store.read(String(args.domain ?? ''))
            if (found === null) return `no site experience for ${args.domain ?? '(missing domain)'}`
            return `--- site experience: ${found.domain} (${found.source}) ---\n${found.body}`
          }
          case 'match': {
            const matches = store.match(String(args.query ?? ''))
            if (matches.length === 0) return 'no known site experience matches that text'
            return matches.map((entry) => `--- site experience: ${entry.domain} (${entry.source}) ---\n${entry.body}`).join('\n\n')
          }
          case 'write': {
            const file = store.write(String(args.domain ?? ''), String(args.content ?? ''), (args.aliases ?? []).map(String))
            return { written: file }
          }
          default:
            throw new Error(`unknown action ${args.action}`)
        }
      }, 'web_site_patterns'),
    },
  ]

  const disposers = new Map()
  for (const definition of definitions) {
    const tool = {
      name: definition.name,
      description: definition.description,
      parameters: definition.parameters,
      timeoutMs: toolTimeoutMs,
      output: TEXT_OUTPUT,
      // Every call multiplexes over one CDP socket and addresses a tab by id,
      // so parallel agents (one tab each) never race on shared state.
      isConcurrencySafe: () => true,
      execute: definition.execute,
    }
    disposers.set(tool.name, ctx.tools.register(tool))
  }
  return disposers
}

export { NO_TARGET_HINT }
