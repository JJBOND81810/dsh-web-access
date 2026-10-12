/**
 * In-process Chrome DevTools Protocol client for the dsh `web-access` plugin.
 *
 * Upstream web-access exposed a local HTTP proxy that the model drove with
 * `curl` from a shell. dsh has no such requirement, so this module owns the
 * same capability directly: one WebSocket to the user's everyday Chrome
 * browser endpoint, flattened sessions per tab, and the same anti-fingerprint
 * debug-port guard.
 *
 * Design notes kept from upstream (v2.5.1):
 * - the browser endpoint is discovered from `DevToolsActivePort` first, so a
 *   Chrome started through `chrome://inspect/#remote-debugging` works without
 *   command-line flags; common ports are only a fallback.
 * - only a TCP probe is used for discovery, because a WebSocket connection
 *   makes Chrome raise its "allow debugging" dialog.
 * - every tab this module opens is tracked and auto-closed after an idle
 *   timeout, so an interrupted agent never leaves orphan tabs behind.
 * - page requests to the debug port itself are failed at the network layer,
 *   so a page cannot fingerprint the automation endpoint.
 *
 * @module dsh-web-access/cdp
 */

import net from 'node:net'
import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { chromiumBrowsers, debugLaunchCommand, devToolsActivePortFiles, installedBrowsers } from './browsers.js'

/** Ports probed when no `DevToolsActivePort` file yields a live endpoint. */
export const FALLBACK_PORTS = [9222, 9229, 9333]

/**
 * Ask a DevTools HTTP endpoint for its authoritative browser WebSocket URL.
 * Chromium only accepts the URL this returns; the bare `/devtools/browser`
 * path that older builds tolerated now answers 404.
 * @param port - DevTools HTTP port.
 * @param timeoutMs - request budget.
 * @returns the scoped socket URL and the browser identification string.
 */
function fetchDebuggerUrl(port, timeoutMs = 4000) {
  return new Promise((resolve, reject) => {
    const request = http.get({ host: '127.0.0.1', port, path: '/json/version', timeout: timeoutMs }, (response) => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', (chunk) => { body += chunk })
      response.on('end', () => {
        if (response.statusCode !== 200) {
          reject(new Error(`GET /json/version answered HTTP ${response.statusCode}`))
          return
        }
        try {
          const parsed = JSON.parse(body)
          const url = parsed?.webSocketDebuggerUrl
          if (typeof url !== 'string' || url === '') {
            reject(new Error('the DevTools endpoint published no webSocketDebuggerUrl'))
            return
          }
          resolve({ url, browser: typeof parsed?.Browser === 'string' ? parsed.Browser : null })
        } catch (error) {
          reject(new Error(`the DevTools endpoint returned unparsable JSON: ${error.message}`))
        }
      })
    })
    request.on('error', (error) => reject(new Error(`cannot reach the DevTools HTTP endpoint: ${error.message}`)))
    request.on('timeout', () => { request.destroy(); reject(new Error('the DevTools HTTP endpoint timed out')) })
  })
}

/** Extract the host of a URL, or null when it cannot be parsed. */
export function hostOf(url) {
  try {
    return new URL(String(url)).hostname.toLowerCase()
  } catch {
    return null
  }
}

/** Whether a URL is the empty or blank document `Target.createTarget` can leave behind. */
export function isBlankUrl(href) {
  return typeof href !== 'string' || href === '' || href === 'about:blank'
}

/**
 * Whether a loaded URL belongs to the expected host (or no expectation was
 * given). A URL with no host at all (`file:`, `data:`) yields an EMPTY expected
 * host, which is not an expectation anyone can check — and comparing it for
 * equality "matches" every host-less document, `about:blank` included, which is
 * how an unloaded tab used to pass as a finished load.
 */
export function hostMatches(href, expectedHost) {
  if (expectedHost === null || expectedHost === undefined || expectedHost === '') return true
  if (typeof href !== 'string' || href === '') return false
  try {
    const host = new URL(href).hostname.toLowerCase()
    return host === expectedHost || host.endsWith(`.${expectedHost}`)
  } catch {
    return false
  }
}

/**
 * Turn an opaque WebSocket failure into something actionable. The global
 * (undici) implementation reports a bare `TypeError` with an empty message
 * when the upgrade is refused, which on its own says nothing useful.
 * @param error - the error object the socket produced, if any.
 * @param event - the raw event, when the implementation reported one.
 * @param url - the attempted socket URL.
 * @returns a human-readable failure description.
 */
function describeSocketFailure(error, event, url) {
  const origin = url.replace(/\/devtools\/browser\/[^/]*$/, '/devtools/browser/<id>')
  const parts = []
  const message = typeof error?.message === 'string' && error.message !== '' ? error.message
    : typeof event?.message === 'string' && event.message !== '' ? event.message
      : null
  if (message !== null) parts.push(message)
  if (error?.cause?.message) parts.push(`cause: ${error.cause.message}`)
  if (parts.length > 0) return `${parts.join('; ')} (while opening ${origin})`
  return [
    `the WebSocket upgrade to ${origin} was refused without a reason.`,
    'Chromium refuses two things here: a handshake carrying an Origin header (403),',
    'and the bare /devtools/browser path (404, it needs the /devtools/browser/<uuid> URL',
    'published by /json/version).',
  ].join(' ')
}

/** Command timeout for one CDP round trip. */
const DEFAULT_COMMAND_TIMEOUT_MS = 30_000

/** How long `waitForLoad` polls `document.readyState` before giving up. */
const DEFAULT_LOAD_TIMEOUT_MS = 15_000

/** Cadence of the idle-tab sweep. */
const DEFAULT_SWEEP_INTERVAL_MS = 60_000

/** CDP errors meaning the cached session, or its tab, no longer exists. */
const SESSION_GONE = /session with given id not found|no target with given id|target closed|inspected target navigated or closed/i

/** CDP errors meaning a navigation replaced the execution context. */
const CONTEXT_GONE = /cannot find context with specified id|cannot find default execution context|execution context was destroyed/i

/** WebSocket implementation, resolved once. */
let WebSocketImpl

/**
 * Resolve a WebSocket implementation: the Node 22+ global first (dsh ships
 * Node 24), then the `ws` package for older or stripped runtimes.
 * @returns a WebSocket constructor.
 */
async function webSocketImpl() {
  if (WebSocketImpl !== undefined) return WebSocketImpl
  if (typeof globalThis.WebSocket === 'function') {
    WebSocketImpl = globalThis.WebSocket
    return WebSocketImpl
  }
  try {
    const mod = await import('ws')
    WebSocketImpl = mod.default ?? mod.WebSocket
    if (typeof WebSocketImpl !== 'function') throw new Error('ws did not export a constructor')
    return WebSocketImpl
  } catch (error) {
    throw new Error(
      'web-access: no WebSocket implementation is available (Node 22+ provides a global WebSocket; '
      + `otherwise install the "ws" package): ${error.message}`,
    )
  }
}

/**
 * Every `<dataDir>/DevToolsActivePort` candidate across the Chromium family.
 * @returns absolute file paths.
 */
export function activePortFiles() {
  return devToolsActivePortFiles()
}

/**
 * Probe a TCP port without opening a WebSocket (which would trigger Chrome's
 * authorization dialog).
 * @param port - candidate port.
 * @param timeoutMs - connect budget.
 * @returns whether something accepts connections there.
 */
export function tcpProbe(port, timeoutMs = 1500) {
  return new Promise((resolve) => {
    const socket = net.createConnection(port, '127.0.0.1')
    const timer = setTimeout(() => { socket.destroy(); resolve(false) }, timeoutMs)
    socket.once('connect', () => { clearTimeout(timer); socket.destroy(); resolve(true) })
    socket.once('error', () => { clearTimeout(timer); resolve(false) })
  })
}

/**
 * Locate a live Chromium DevTools endpoint.
 * @param configuredPort - a pinned port, when the config names one.
 * @returns `{ port, wsPath, source, browser }`, or null when nothing is listening.
 */
export async function discoverChromeEndpoint(configuredPort) {
  if (typeof configuredPort === 'number' && configuredPort > 0) {
    if (await tcpProbe(configuredPort)) {
      return { port: configuredPort, wsPath: null, source: 'config', browser: null }
    }
    return null
  }
  for (const browser of chromiumBrowsers()) {
    for (const dataDir of browser.dataDirs) {
      const file = path.join(dataDir, 'DevToolsActivePort')
      let lines
      try {
        lines = fs.readFileSync(file, 'utf8').trim().split(/\r?\n/).filter(Boolean)
      } catch {
        continue
      }
      const port = Number.parseInt(lines[0] ?? '', 10)
      if (!Number.isInteger(port) || port <= 0 || port > 65535) continue
      if (!(await tcpProbe(port))) continue
      // The second line is the browser-scoped path with its UUID. A browser
      // that was not started with an explicit --remote-debugging-port accepts
      // only that path, so it must be preserved.
      return { port, wsPath: lines[1] ?? null, source: file, browser: browser.label }
    }
  }
  for (const port of FALLBACK_PORTS) {
    if (await tcpProbe(port)) return { port, wsPath: null, source: `port ${port}`, browser: null }
  }
  return null
}

/** The remediation text shown when no Chromium browser exposes a DevTools endpoint. */
export function chromeUnavailableMessage() {
  const lines = ['web-access: no Chromium DevTools endpoint found (a WebSocket to a browser that is not listening cannot help).']
  const installed = installedBrowsers()
  if (installed.length > 0) {
    lines.push('Browsers found on this machine:')
    for (const entry of installed) {
      lines.push(`  - ${entry.browser.label}${entry.executable === null ? ' (executable not in a standard location)' : ''}`)
    }
    const preferred = installed[0]
    lines.push('')
    lines.push(`Open the remote-debugging page for one of them (${preferred.browser.label}: ${preferred.browser.dataDirs[0] === undefined ? '' : 'edge://inspect/#remote-debugging or chrome://inspect/#remote-debugging'})`)
    lines.push('and enable "Allow remote debugging for this browser instance" (a restart may be needed).')
    lines.push('Alternatively start a SEPARATE instance with a debug port and its own profile directory:')
    lines.push(`  ${debugLaunchCommand(preferred.browser, preferred.executable)}`)
  } else {
    lines.push('No Chromium-family browser profile was found. Install Chrome, Edge, Brave, Vivaldi, or Chromium,')
    lines.push('or point the plugin config at a running browser with `port: <debug port>`.')
  }
  lines.push('The port may also be pinned in the plugin config (`port: 9222`).')
  return lines.join('\n')
}

/** One tab opened by this client, and when it was last touched. */
function newTabRecord(owner) {
  return { lastAccessed: Date.now(), owner: owner ?? null }
}

/**
 * A CDP connection to the user's Chrome, multiplexing every tab as a
 * flattened session over one browser-level WebSocket.
 */
export class CdpClient {
  /**
   * @param options - deployment knobs plus a diagnostic logger.
   */
  constructor(options = {}) {
    /** Pinned port, or null for auto-discovery. */
    this.configuredPort = typeof options.port === 'number' && options.port > 0 ? options.port : null
    /** Idle budget after which a managed tab is closed. */
    this.tabIdleTimeoutMs = options.tabIdleTimeoutMs ?? 900_000
    /** Sweep cadence. */
    this.sweepIntervalMs = options.sweepIntervalMs ?? DEFAULT_SWEEP_INTERVAL_MS
    /** Per-command round-trip budget. */
    this.commandTimeoutMs = options.commandTimeoutMs ?? DEFAULT_COMMAND_TIMEOUT_MS
    /** Diagnostic sink; never receives page content. */
    this.log = typeof options.log === 'function' ? options.log : () => {}

    this.socket = null
    this.port = null
    this.wsPath = null
    this.commandId = 0
    /** id -> { resolve, timer } */
    this.pending = new Map()
    /** targetId -> sessionId */
    this.sessions = new Map()
    /** targetId -> { lastAccessed, owner } */
    this.managedTabs = new Map()
    /** Session ids whose debug-port guard is already installed. */
    this.portGuardedSessions = new Set()
    this.connecting = null
    this.sweepTimer = null
    this.lastError = null
  }

  /** Whether the browser-level socket is open. */
  isOpen() {
    return this.socket !== null && this.socket.readyState === 1
  }

  /** Connection summary for the status tool. */
  status() {
    return {
      connected: this.isOpen(),
      port: this.port,
      browser: this.browserLabel ?? null,
      endpointSource: this.endpointSource ?? null,
      sessions: this.sessions.size,
      managedTabs: [...this.managedTabs.entries()].map(([targetId, record]) => ({
        targetId,
        owner: record.owner,
        idleMs: Date.now() - record.lastAccessed,
      })),
      lastError: this.lastError,
    }
  }

  /** Drop all connection-scoped state after a failure or close. */
  #reset() {
    this.socket = null
    this.port = null
    this.wsPath = null
    this.endpointSource = null
    this.browserLabel = null
    this.sessions.clear()
    this.managedTabs.clear()
    this.portGuardedSessions.clear()
    for (const { timer } of this.pending.values()) clearTimeout(timer)
    this.pending.clear()
  }

  /**
   * Ensure a live browser-level connection, reusing an in-flight attempt.
   * @returns when the socket is open.
   */
  async connect() {
    if (this.isOpen()) return
    if (this.connecting !== null) return this.connecting
    this.connecting = this.#openConnection().finally(() => { this.connecting = null })
    return this.connecting
  }

  async #openConnection() {
    const endpoint = await discoverChromeEndpoint(this.configuredPort)
    if (endpoint === null) {
      this.lastError = 'no DevTools endpoint'
      throw new Error(chromeUnavailableMessage())
    }
    this.port = endpoint.port
    this.wsPath = endpoint.wsPath
    this.endpointSource = endpoint.source
    this.browserLabel = endpoint.browser
    const WS = await webSocketImpl()

    // Resolve the socket URL. Chromium only accepts its browser-scoped URL,
    // `/devtools/browser/<uuid>`; the bare `/devtools/browser` that older
    // versions accepted answers 404 today. `DevToolsActivePort` already
    // carries the scoped path, and otherwise `/json/version` publishes the
    // authoritative URL — so the bare path is only a last resort.
    let url
    if (endpoint.wsPath !== null) {
      url = `ws://127.0.0.1:${endpoint.port}${endpoint.wsPath}`
    } else {
      try {
        const info = await fetchDebuggerUrl(endpoint.port)
        url = info.url
        this.browserLabel = this.browserLabel ?? info.browser
      } catch (error) {
        this.lastError = error.message
        this.log(`/json/version lookup failed (${error.message}); trying the bare browser path`)
        url = `ws://127.0.0.1:${endpoint.port}/devtools/browser`
      }
    }

    await new Promise((resolve, reject) => {
      // Handshakes that carry an Origin header are refused with 403 on
      // purpose (DNS-rebinding protection), so none is ever set here.
      const socket = new WS(url)
      let settled = false
      const settle = (error, detail) => {
        if (settled) return
        settled = true
        if (error === undefined) resolve()
        else {
          const described = describeSocketFailure(error, detail, url)
          this.lastError = described
          this.#reset()
          reject(new Error(described))
        }
      }
      const onMessage = (event) => { void this.#onMessage(event) }
      if (typeof socket.on === 'function') {
        socket.on('open', () => settle())
        socket.on('error', (error) => settle(error instanceof Error ? error : new Error(String(error))))
        socket.on('close', (code, reason) => {
          if (!settled) settle(new Error(`the socket closed before it opened (code ${code ?? '?'}${reason ? `, ${reason}` : ''})`))
          this.#onClose()
        })
        socket.on('message', onMessage)
      } else {
        socket.addEventListener('open', () => settle())
        socket.addEventListener('error', (event) => settle(event?.error ?? null, event))
        socket.addEventListener('close', (event) => {
          if (!settled) settle(new Error(`the socket closed before it opened (code ${event?.code ?? '?'})`))
          this.#onClose()
        })
        socket.addEventListener('message', onMessage)
      }
      this.socket = socket
    })
    this.lastError = null
    this.log(`connected to ${this.browserLabel ?? 'Chromium'} on port ${this.port}`)
    this.#startSweep()
  }

  #onClose() {
    this.log('Chrome connection closed; port cache cleared')
    this.#reset()
  }

  /** Handle one browser-level frame. */
  async #onMessage(event) {
    let raw = event?.data ?? event
    if (typeof raw !== 'string') {
      if (raw instanceof ArrayBuffer) raw = Buffer.from(raw).toString('utf8')
      else if (ArrayBuffer.isView(raw)) raw = Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength).toString('utf8')
      else if (typeof raw?.text === 'function') raw = await raw.text()
      else raw = String(raw)
    }
    let message
    try {
      message = JSON.parse(raw)
    } catch {
      return
    }
    if (message.method === 'Target.attachedToTarget') {
      const { sessionId, targetInfo } = message.params ?? {}
      if (targetInfo?.targetId !== undefined && sessionId !== undefined) {
        this.sessions.set(targetInfo.targetId, sessionId)
      }
    }
    // Anti-fingerprint: a page probing this debug endpoint gets a refusal
    // instead of a response. Only 127.0.0.1/localhost on the Chrome port match,
    // so unrelated local services are untouched.
    if (message.method === 'Fetch.requestPaused') {
      const { requestId, sessionId } = message.params ?? {}
      void this.send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sessionId)
        .catch(() => {})
    }
    if (message.id !== undefined && this.pending.has(message.id)) {
      const { resolve, timer } = this.pending.get(message.id)
      clearTimeout(timer)
      this.pending.delete(message.id)
      resolve(message)
    }
  }

  /**
   * Send one CDP command and await its reply.
   * @param method - CDP method name.
   * @param params - method parameters.
   * @param sessionId - flattened session, when the command targets a tab.
   * @returns the raw CDP reply.
   */
  send(method, params = {}, sessionId = null) {
    return new Promise((resolve, reject) => {
      if (!this.isOpen()) {
        reject(new Error('web-access: the Chrome connection is not open. Run web_access_status, then retry.'))
        return
      }
      const id = ++this.commandId
      const message = { id, method, params }
      if (sessionId !== null && sessionId !== undefined) message.sessionId = sessionId
      const timer = setTimeout(() => {
        this.pending.delete(id)
        reject(new Error(`web-access: CDP command timed out: ${method}`))
      }, this.commandTimeoutMs)
      this.pending.set(id, { resolve, timer })
      try {
        this.socket.send(JSON.stringify(message))
      } catch (error) {
        clearTimeout(timer)
        this.pending.delete(id)
        reject(error)
      }
    })
  }

  /** Send a command and throw when CDP reports an error. */
  async sendOrThrow(method, params = {}, sessionId = null) {
    const reply = await this.send(method, params, sessionId)
    if (reply.error !== undefined) {
      throw new Error(`web-access: ${method} failed: ${reply.error.message ?? JSON.stringify(reply.error)}`)
    }
    return reply.result
  }

  /**
   * Forget one tab completely.
   *
   * A tab the user closes by hand is still recorded in `managedTabs`, so the
   * default target would keep resolving to a dead tab and every later call that
   * omits `target` would fail until the idle sweep happened to clear it.
   * @param targetId - the tab to forget.
   */
  forget(targetId) {
    const sessionId = this.sessions.get(targetId)
    if (sessionId !== undefined) this.portGuardedSessions.delete(sessionId)
    this.sessions.delete(targetId)
    this.managedTabs.delete(targetId)
  }

  /** Attach to a tab (flattened) and install the debug-port guard once. */
  async ensureSession(targetId) {
    const existing = this.sessions.get(targetId)
    if (existing !== undefined) return existing
    let result
    try {
      result = await this.sendOrThrow('Target.attachToTarget', { targetId, flatten: true })
    } catch (error) {
      // The tab is gone: closed by the user, by the browser, or by a crash.
      // Drop it before rethrowing so the next omitted-target call picks a live
      // tab (or reports that none is open) instead of failing the same way.
      this.forget(targetId)
      throw new Error(
        `target ${targetId} cannot be attached - the tab is gone (closed by the user, the browser, or a crash). `
        + `Open a new tab with web_open, or list the live ones with web_tabs. (${error.message})`,
      )
    }
    const sessionId = result.sessionId
    this.sessions.set(targetId, sessionId)
    await this.#enablePortGuard(sessionId)
    return sessionId
  }

  async #enablePortGuard(sessionId) {
    if (this.port === null || this.portGuardedSessions.has(sessionId)) return
    try {
      await this.sendOrThrow('Fetch.enable', {
        patterns: [
          { urlPattern: `http://127.0.0.1:${this.port}/*`, requestStage: 'Request' },
          { urlPattern: `http://localhost:${this.port}/*`, requestStage: 'Request' },
        ],
      }, sessionId)
      this.portGuardedSessions.add(sessionId)
    } catch {
      // The guard is hardening; its absence must not break real work.
    }
  }

  #startSweep() {
    if (this.sweepTimer !== null) return
    this.sweepTimer = setInterval(() => { void this.sweepIdleTabs() }, this.sweepIntervalMs)
    this.sweepTimer.unref?.()
  }

  /** Record activity on a tab so the idle sweep spares it. */
  touch(targetId) {
    const record = this.managedTabs.get(targetId)
    if (record !== undefined) record.lastAccessed = Date.now()
  }

  /** Close managed tabs that have been idle past the budget. */
  async sweepIdleTabs() {
    if (!this.isOpen()) return []
    const now = Date.now()
    const closed = []
    for (const [targetId, record] of [...this.managedTabs]) {
      if (now - record.lastAccessed < this.tabIdleTimeoutMs) continue
      try {
        await this.send('Target.closeTarget', { targetId })
      } catch {
        // Already gone; forgetting it is enough.
      }
      this.forget(targetId)
      closed.push(targetId)
    }
    if (closed.length > 0) this.log(`auto-closed ${closed.length} idle tab(s)`)
    return closed
  }

  /**
   * Every open page tab, marking the ones this client owns.
   * @returns page target summaries.
   */
  async listTargets() {
    await this.connect()
    const result = await this.sendOrThrow('Target.getTargets')
    return (result.targetInfos ?? [])
      .filter((info) => info.type === 'page')
      .map((info) => ({
        targetId: info.targetId,
        title: info.title,
        url: info.url,
        managed: this.managedTabs.has(info.targetId),
        owner: this.managedTabs.get(info.targetId)?.owner ?? null,
      }))
  }

  /**
   * Open a background tab and wait until the requested URL is actually loaded.
   *
   * `Target.createTarget({ url })` is not a guarantee: a background tab may be
   * created without navigating (some Chromium builds defer background loads,
   * and a headless build never loads them), which silently yields
   * `about:blank`. So the loaded URL is verified and repaired with an explicit
   * `Page.navigate` when it did not take effect.
   *
   * @param url - page to open; `about:blank` when omitted.
   * @param options - owner label and load budget.
   * @returns the new target id, the load state, and the URL actually loaded.
   */
  async openTab(url = 'about:blank', options = {}) {
    await this.connect()
    const result = await this.sendOrThrow('Target.createTarget', { url, background: true })
    const targetId = result.targetId
    this.managedTabs.set(targetId, newTabRecord(options.owner))
    let loadState = 'skipped'
    let loadedUrl = url
    if (url !== 'about:blank') {
      try {
        const sessionId = await this.ensureSession(targetId)
        const expectedHost = hostOf(url)
        let waited = await this.waitForLoad(sessionId, { timeoutMs: options.loadTimeoutMs, expectHost: expectedHost })
        // Host matching alone cannot see an unloaded tab when the target URL has
        // no host of its own (`file:`, `data:`), so the blank document that
        // `Target.createTarget` sometimes leaves behind is rejected explicitly.
        if (isBlankUrl(waited.href) || !hostMatches(waited.href, expectedHost)) {
          await this.sendOrThrow('Page.navigate', { url }, sessionId)
          waited = await this.waitForLoad(sessionId, { timeoutMs: options.loadTimeoutMs, expectHost: expectedHost })
          loadState = waited.state === 'complete' ? 'complete (after explicit navigate)' : waited.state
        } else {
          loadState = waited.state
        }
        loadedUrl = waited.href ?? url
      } catch (error) {
        loadState = `error: ${error.message}`
      }
    }
    return { targetId, loadState, url: loadedUrl }
  }

  /** Whether a target id still exists in the browser. */
  async targetExists(targetId) {
    const result = await this.sendOrThrow('Target.getTargets')
    return (result.targetInfos ?? []).some((info) => info.targetId === targetId)
  }

  /**
   * Close one tab and forget it.
   *
   * `Target.closeTarget` resolves before the target disappears from
   * `Target.getTargets`, so the closure is confirmed by polling. Orphan tabs
   * are the one thing this design must never leave behind, and a model that
   * believes a tab is closed will not try again.
   *
   * @param targetId - the tab to close.
   * @returns `{ closed, targetId, confirmed }`.
   */
  async closeTab(targetId) {
    await this.connect()
    let confirmed = false
    try {
      await this.sendOrThrow('Target.closeTarget', { targetId })
    } catch (error) {
      // The user may have closed it first, which is the state we wanted anyway;
      // only a tab that still exists makes this a real failure.
      const stillOpen = await this.targetExists(targetId).catch(() => false)
      if (stillOpen) throw error
      confirmed = true
    }
    for (let attempt = 0; attempt < 4 && !confirmed; attempt++) {
      await new Promise((resolve) => setTimeout(resolve, attempt === 0 ? 0 : 300))
      try {
        confirmed = !(await this.targetExists(targetId))
      } catch {
        confirmed = true
      }
    }
    this.forget(targetId)
    if (!confirmed) this.log(`tab ${targetId} was asked to close but is still listed`)
    return { closed: true, targetId, confirmed }
  }

  /**
   * Poll until the document is complete — and, when an expected host is given,
   * until the tab has actually reached that host.
   * @param sessionId - flattened session for the tab.
   * @param options - load budget and expected host.
   * @returns `{ state, href }`; state is `complete` or `timeout`.
   */
  async waitForLoad(sessionId, options = {}) {
    const timeoutMs = Number.isFinite(options.timeoutMs) ? options.timeoutMs : DEFAULT_LOAD_TIMEOUT_MS
    const expectHost = options.expectHost ?? null
    await this.send('Page.enable', {}, sessionId).catch(() => {})
    const deadline = Date.now() + timeoutMs
    let last = null
    while (Date.now() < deadline) {
      const reply = await this.send('Runtime.evaluate', {
        expression: '({ ready: document.readyState, href: location.href })',
        returnByValue: true,
      }, sessionId).catch(() => null)
      const value = reply?.result?.result?.value
      if (value !== undefined && value !== null) {
        last = value
        if (value.ready === 'complete' && hostMatches(value.href, expectHost)) {
          return { state: 'complete', href: value.href }
        }
      }
      await new Promise((resolve) => setTimeout(resolve, 400))
    }
    return { state: 'timeout', href: last?.href ?? null }
  }

  /** Navigate an attached tab and wait for the load to settle. */
  async navigate(targetId, url, timeoutMs) {
    const sessionId = await this.ensureSession(targetId)
    const expectedHost = hostOf(url)
    await this.sendOrThrow('Page.navigate', { url }, sessionId)
    const waited = await this.waitForLoad(sessionId, { timeoutMs, expectHost: expectedHost })
    return { loadState: waited.state, url: waited.href ?? url }
  }

  /** Go back one entry in the tab's history. */
  async goBack(targetId, timeoutMs) {
    const sessionId = await this.ensureSession(targetId)
    await this.sendOrThrow('Runtime.evaluate', { expression: 'history.back()' }, sessionId)
    const waited = await this.waitForLoad(sessionId, { timeoutMs })
    return { loadState: waited.state, url: waited.href ?? null }
  }

  /**
   * Evaluate JavaScript in the tab.
   *
   * Two CDP-level failures are recoverable exactly once, and both used to be
   * invisible: a cached session outlives a tab the user closed, and a
   * navigation replaces the execution context. The command reply for those
   * carries `error` and no `result`, so reading `.result` off it returned
   * `undefined` — a real failure that looked like a successful evaluation.
   *
   * @returns the JSON-serializable value, or a thrown error for page exceptions.
   */
  async evaluate(targetId, expression, options = {}) {
    const command = (sessionId) => this.sendOrThrow('Runtime.evaluate', {
      expression,
      returnByValue: options.returnByValue !== false,
      awaitPromise: options.awaitPromise !== false,
      userGesture: options.userGesture === true,
    }, sessionId)
    let result
    try {
      result = await command(await this.ensureSession(targetId))
    } catch (error) {
      const message = String(error?.message ?? '')
      if (SESSION_GONE.test(message)) {
        // Drop the stale record: re-attaching now either heals (the tab is
        // alive, only the session died) or reports that the tab is gone.
        this.forget(targetId)
      } else if (CONTEXT_GONE.test(message)) {
        await new Promise((resolve) => setTimeout(resolve, 150))
      } else {
        throw error
      }
      result = await command(await this.ensureSession(targetId))
    }
    if (result?.exceptionDetails !== undefined) {
      const details = result.exceptionDetails
      const description = details.exception?.description ?? details.text ?? 'evaluation failed'
      throw new Error(`web-access: page threw while evaluating: ${description}`)
    }
    return result?.result?.value
  }

  /** Click through the page's own event path (`el.click()`). */
  async click(targetId, selector) {
    return this.evaluate(targetId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'no element matches ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      el.click();
      return { clicked: true, tag: el.tagName, text: (el.textContent || '').trim().slice(0, 120) };
    })()`)
  }

  /** Click with real mouse input events (a user gesture). */
  async clickAt(targetId, selector) {
    const coord = await this.evaluate(targetId, `(() => {
      const el = document.querySelector(${JSON.stringify(selector)});
      if (!el) return { error: 'no element matches ' + ${JSON.stringify(selector)} };
      el.scrollIntoView({ block: 'center', inline: 'center' });
      const rect = el.getBoundingClientRect();
      if (rect.width === 0 || rect.height === 0) return { error: 'element has no layout box' };
      return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2, tag: el.tagName,
               text: (el.textContent || '').trim().slice(0, 120) };
    })()`)
    if (coord?.error !== undefined) throw new Error(`web-access: ${coord.error}`)
    const sessionId = await this.ensureSession(targetId)
    for (const type of ['mousePressed', 'mouseReleased']) {
      await this.sendOrThrow('Input.dispatchMouseEvent', {
        type, x: coord.x, y: coord.y, button: 'left', clickCount: 1,
      }, sessionId)
    }
    return { clicked: true, ...coord }
  }

  /** Assign local files to a file input, bypassing the file dialog. */
  async setFiles(targetId, selector, files) {
    const sessionId = await this.ensureSession(targetId)
    await this.sendOrThrow('DOM.enable', {}, sessionId)
    const doc = await this.sendOrThrow('DOM.getDocument', {}, sessionId)
    const found = await this.sendOrThrow('DOM.querySelector', { nodeId: doc.root.nodeId, selector }, sessionId)
    if (!found.nodeId) throw new Error(`web-access: no element matches ${selector}`)
    await this.sendOrThrow('DOM.setFileInputFiles', { nodeId: found.nodeId, files }, sessionId)
    return { success: true, files: files.length }
  }

  /** Scroll the tab, then give lazy loading a moment to fire. */
  async scroll(targetId, options = {}) {
    const amount = Math.abs(Number.isFinite(options.amount) ? options.amount : 3000)
    const direction = options.direction ?? 'down'
    const expression = direction === 'top' ? 'window.scrollTo(0, 0); "top"'
      : direction === 'bottom' ? 'window.scrollTo(0, document.body.scrollHeight); "bottom"'
        : direction === 'up' ? `window.scrollBy(0, -${amount}); "up"`
          : `window.scrollBy(0, ${amount}); "down"`
    const value = await this.evaluate(targetId, expression)
    await new Promise((resolve) => setTimeout(resolve, 800))
    return { value, direction }
  }

  /** Capture the rendered page, optionally to a file. */
  async screenshot(targetId, options = {}) {
    const sessionId = await this.ensureSession(targetId)
    const format = options.format === 'jpeg' ? 'jpeg' : 'png'
    const result = await this.sendOrThrow('Page.captureScreenshot', {
      format,
      ...(format === 'jpeg' ? { quality: 80 } : {}),
      ...(options.fullPage === true ? { captureBeyondViewport: true } : {}),
    }, sessionId)
    const bytes = Buffer.from(result.data, 'base64')
    if (options.file !== undefined && options.file !== null) {
      fs.mkdirSync(path.dirname(options.file), { recursive: true })
      fs.writeFileSync(options.file, bytes)
      return { file: options.file, bytes: bytes.length, format }
    }
    return { data: result.data, bytes: bytes.length, format }
  }

  /** Title, URL, and readiness of a tab. */
  async info(targetId) {
    return this.evaluate(targetId, '({ title: document.title, url: location.href, ready: document.readyState })')
  }

  /** Close every tab this client opened. */
  async closeAllManaged() {
    if (!this.isOpen()) return 0
    const targetIds = [...this.managedTabs.keys()]
    for (const targetId of targetIds) {
      try {
        await this.send('Target.closeTarget', { targetId })
      } catch {
        // Best effort on teardown.
      }
      this.forget(targetId)
    }
    return targetIds.length
  }

  /** Detach everything and close the socket. */
  async dispose() {
    if (this.sweepTimer !== null) {
      clearInterval(this.sweepTimer)
      this.sweepTimer = null
    }
    await this.closeAllManaged().catch(() => {})
    const socket = this.socket
    this.#reset()
    try {
      socket?.close?.()
    } catch {
      // Closing an already-dead socket is not an error worth reporting.
    }
  }

  /**
   * Pick the tab a tool call means: the explicit id, else the most recently
   * used tab this owner opened, so one agent never hijacks another's tab.
   * @param targetId - explicit target id from the model, when given.
   * @param owner - calling agent label.
   * @returns the resolved target id.
   */
  resolveTarget(targetId, owner) {
    if (typeof targetId === 'string' && targetId.length > 0) {
      this.touch(targetId)
      return targetId
    }
    let best = null
    for (const [candidate, record] of this.managedTabs) {
      if (owner !== null && owner !== undefined && record.owner !== owner) continue
      if (best === null || record.lastAccessed > this.managedTabs.get(best).lastAccessed) best = candidate
    }
    if (best === null) {
      throw new Error(
        'web-access: no tab is selected. Open one with web_open (or pass target with a targetId from web_tabs).',
      )
    }
    this.touch(best)
    return best
  }
}
