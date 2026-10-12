#!/usr/bin/env node
/**
 * Pre-install self-check for the dsh-web-access plugin.
 *
 * Runs the real module graph with plain Node, mounts the plugin against a fake
 * Cordis context, and validates every registered tool definition against the
 * JSON Schema subset `@deepseek-ai/dsh-tools` enforces. Because the plugin has
 * no external imports, this catches almost everything the loader would throw,
 * without touching the user's profile.
 *
 *   node test/selfcheck.mjs            # static checks
 *   node test/selfcheck.mjs --live     # plus a real Chrome round trip
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ENTRY = path.join(HERE, '..', 'lib', 'index.js')
/** Artifacts land in the OS temp area so the package tree stays clean. */
const SCRATCH = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-web-access-selfcheck-'))

const failures = []
const notes = []
const check = (label, ok, detail = '') => {
  if (ok) console.log(`  ok    ${label}${detail ? ` — ${detail}` : ''}`)
  else { failures.push(`${label}${detail ? ` — ${detail}` : ''}`); console.log(`  FAIL  ${label}${detail ? ` — ${detail}` : ''}`) }
}

/* ------------------------------------------------------------------ schema */

const ANNOTATIONS = new Set(['description', 'title', 'default', 'examples'])
const CONSTRAINTS = new Set(['type', 'oneOf', 'properties', 'required', 'additionalProperties', 'items', 'enum', 'const'])
const SCALARS = new Set(['string', 'number', 'integer', 'boolean', 'null'])
const isRecord = (v) => typeof v === 'object' && v !== null && !Array.isArray(v)

/** Validate one node the way dsh-tools' raw-schema boundary does. */
function validateSchema(node, at, violations, inProperty = false) {
  if (!isRecord(node)) { violations.push(`${at} must be a schema object`); return }
  for (const key of Object.keys(node)) {
    if (!CONSTRAINTS.has(key) && !ANNOTATIONS.has(key)) violations.push(`${at}.${key} is not a supported keyword`)
  }
  // The author DSL's `required: true` must never reach a raw schema.
  if (inProperty && Object.hasOwn(node, 'required')) violations.push(`${at}.required is author-DSL syntax; use the parent's required array`)
  if (Object.hasOwn(node, 'oneOf')) {
    for (const key of ['properties', 'required', 'additionalProperties', 'items', 'enum', 'const']) {
      if (Object.hasOwn(node, key)) violations.push(`${at}.${key} is not supported beside oneOf`)
    }
    if (!Array.isArray(node.oneOf) || node.oneOf.length < 2) violations.push(`${at}.oneOf must list at least two schemas`)
    else node.oneOf.forEach((branch, index) => validateSchema(branch, `${at}.oneOf[${index}]`, violations))
    return
  }
  if (!Object.hasOwn(node, 'type')) { violations.push(`${at} needs type or oneOf`); return }
  const type = node.type
  if (typeof type !== 'string' || (!SCALARS.has(type) && type !== 'object' && type !== 'array')) {
    violations.push(`${at}.type must be a scalar/object/array (raw schemas cannot use "json")`)
    return
  }
  if (type === 'object') {
    if (typeof node.additionalProperties !== 'boolean') violations.push(`${at}.additionalProperties must be explicit for an object`)
    const properties = node.properties ?? {}
    if (!isRecord(properties)) violations.push(`${at}.properties must be an object of schemas`)
    else for (const [key, child] of Object.entries(properties)) validateSchema(child, `${at}.properties.${key}`, violations, true)
    if (Object.hasOwn(node, 'required')) {
      if (!Array.isArray(node.required) || node.required.some((name) => typeof name !== 'string')) {
        violations.push(`${at}.required must be an array of strings`)
      } else for (const name of node.required) {
        if (!Object.hasOwn(properties, name)) violations.push(`${at}.required names "${name}" which is not in properties`)
      }
    }
  }
  if (type === 'array' && Object.hasOwn(node, 'items')) validateSchema(node.items, `${at}.items`, violations)
  // Keywords are only legal on the node type they constrain.
  const onlyOn = {
    enum: SCALARS,
    const: SCALARS,
    items: new Set(['array']),
    properties: new Set(['object']),
    additionalProperties: new Set(['object']),
  }
  for (const [key, allowed] of Object.entries(onlyOn)) {
    if (!Object.hasOwn(node, key)) continue
    if (!allowed.has(type)) violations.push(`${at}.${key} is not supported on type "${type}"`)
  }
}

/* -------------------------------------------------------------------- mount */

const registered = new Map()
const disposed = []
const captured = { skill: null, prompt: null, fetchProvider: null }

const fakeCtx = {
  logger: { info: () => {}, warn: (m) => notes.push(m) },
  effect(fn, label) {
    const disposer = fn()
    disposed.push({ label, disposer })
    return () => {}
  },
  get(name) {
    if (name === 'skills') {
      return { register: (skill) => { captured.skill = skill; return () => {} } }
    }
    if (name === 'systemPrompt') {
      return { section: (section) => { captured.prompt = section; return () => {} } }
    }
    if (name === 'web') {
      return { registerFetchProvider: (provider) => { captured.fetchProvider = provider; return () => {} } }
    }
    return undefined
  },
  tools: {
    register(definition) {
      if (registered.has(definition.name)) throw new Error(`duplicate tool ${definition.name}`)
      registered.set(definition.name, definition)
      return () => registered.delete(definition.name)
    },
  },
}

console.log(`\nimport ${ENTRY}`)
const plugin = await import(pathToFileURL(ENTRY).href)
check('module exports apply()', typeof plugin.apply === 'function')
check('module exports name', plugin.name === 'web-access', plugin.name)
check('inject lists tools', Array.isArray(plugin.inject) && plugin.inject.includes('tools'), JSON.stringify(plugin.inject))

console.log('\nmount against a fake context')
await plugin.apply(fakeCtx, { provideCdpFetch: true })
check('registered at least 15 tools', registered.size >= 15, `${registered.size} tools`)
check('skill registered', captured.skill !== null)
check('skill content loaded from skill/SKILL.md', (captured.skill?.content?.length ?? 0) > 4000, `${captured.skill?.content?.length ?? 0} chars`)
check('skill name is kebab-case', captured.skill?.name === 'web-access')
check('skill declares a resource directory', captured.skill?.resourceBase?.kind === 'directory')
check('system prompt section added', captured.prompt !== null && captured.prompt.order === 106)
check('opt-in cdp fetch provider registered', captured.fetchProvider?.id === 'cdp')

console.log('\nvalidate every tool definition')
for (const [name, tool] of registered) {
  const violations = []
  if (typeof tool.description !== 'string' || tool.description.length < 40) violations.push('description too short')
  if (name !== 'run_code' && !/^web_/.test(name)) violations.push('name must stay in the web_ namespace')
  validateSchema(tool.parameters, `${name}.parameters`, violations)
  const outputOk = isRecord(tool.output) && typeof tool.output.render === 'function' && isRecord(tool.output.schema)
  if (!outputOk) violations.push('output must be { schema, render }')
  else validateSchema(tool.output.schema, `${name}.output.schema`, violations)
  if (!(Number.isFinite(tool.timeoutMs) && tool.timeoutMs > 0)) violations.push('timeoutMs must be positive')
  if (typeof tool.execute !== 'function') violations.push('execute must be a function')
  check(name, violations.length === 0, violations.join('; '))
}

console.log('\nvalidate tool naming against the built-in surfaces')
for (const reserved of ['web_fetch', 'web_search', 'run_code']) {
  check(`does not shadow ${reserved}`, !registered.has(reserved))
}
check('no browser_* collision', [...registered.keys()].every((name) => !name.startsWith('browser_')))

console.log('\nexercise handlers with no Chrome present')
for (const name of ['web_access_status', 'web_tabs', 'web_site_patterns', 'web_find_url']) {
  const tool = registered.get(name)
  const args = name === 'web_site_patterns' ? { action: 'list' } : name === 'web_find_url' ? { keywords: [] } : {}
  const result = await tool.execute(args, { agent: { id: 'selfcheck' }, signal: new AbortController().signal })
  const text = result?.text ?? ''
  check(`${name} returns text without throwing`, typeof text === 'string' && text.length > 0, `${text.length} chars`)
  // Only counts are printed: this reads the user's real browsing data.
  if (name === 'web_find_url') {
    console.log(`  ---- ${name} ----`)
    for (const line of text.split('\n')) if (/^\[(bookmarks|history)\]|^note:/.test(line)) console.log(`  | ${line}`)
    console.log('  ----')
  }
  if (name === 'web_access_status' || name === 'web_tabs') {
    console.log(`  ---- ${name} ----`)
    console.log(text.split('\n').map((line) => `  | ${line}`).join('\n'))
    console.log('  ----')
  }
}

/* --------------------------------------------------------------------- live */

if (process.argv.includes('--live')) {
  console.log('\nlive browser round trip')
  const { CdpClient, discoverChromeEndpoint } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'cdp.js')).href)
  const endpoint = await discoverChromeEndpoint(null)
  check('a DevTools endpoint is discoverable', endpoint !== null, JSON.stringify(endpoint))
  if (endpoint !== null) {
    const client = new CdpClient({})
    let targetId = null
    try {
      const opened = await client.openTab('https://example.com', { owner: 'selfcheck' })
      targetId = opened.targetId
      check('connected, opened a managed background tab', typeof targetId === 'string', `${targetId} loadState=${opened.loadState}`)
      check('status reports the browser', client.status().connected === true, JSON.stringify(client.status().browser))

      const info = await client.info(targetId)
      check('read page info', (info?.title ?? '').length > 0, JSON.stringify(info))
      check('navigation reached the requested host', String(info?.url ?? '').includes('example.com'), info?.url)

      const { extractExpression } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'extract.js')).href)
      const page = await client.evaluate(targetId, extractExpression({ maxChars: 4000 }))
      check('extracted readable text', (page?.text?.length ?? 0) > 50, `${page?.text?.length ?? 0} chars, ${page?.linkCount ?? 0} links`)

      // Assert on arbitrary DOM-derived data, not on one fixed markup detail:
      // example.com is served in several shapes (the current one has no <h1>).
      const shaped = await client.evaluate(targetId, '({ title: document.title, '
        + 'paragraphs: document.body.querySelectorAll("p").length, '
        + 'links: document.querySelectorAll("a").length, '
        + 'url: location.href })')
      check('evaluated page JavaScript into a structured value',
        typeof shaped?.title === 'string' && shaped.title.length > 0 && shaped.paragraphs >= 1,
        JSON.stringify(shaped))

      const shot = await client.screenshot(targetId, { file: path.join(SCRATCH, 'shot.png') })
      check('captured a screenshot', (shot?.bytes ?? 0) > 1000, `${shot?.bytes} bytes at ${shot?.file}`)

      await client.navigate(targetId, 'https://example.com/?dsh=1')
      const after = await client.info(targetId)
      check('navigated an existing tab', String(after?.url ?? '').includes('dsh=1'), after?.url)

      await client.scroll(targetId, { direction: 'bottom' })
      check('scrolled the page', true)

      const patterns = await (await import(pathToFileURL(path.join(HERE, '..', 'lib', 'site-patterns.js')).href))
      const store = new patterns.SitePatternStore({ dir: path.join(SCRATCH, 'patterns') })
      const file = store.write('example.com', '## 平台特征\n- self-check wrote this\n', ['示例'])
      check('recorded site experience', file.endsWith('example.com.md'), file)
      check('matched site experience by alias', store.match('打开示例看看').length === 1)
    } catch (error) {
      check('live round trip completed without throwing', false, `${error?.name}: ${error?.message}`)
    } finally {
      if (targetId !== null) {
        const tabs = await client.listTargets()
        check('the tab is still listed before close', tabs.some((tab) => tab.targetId === targetId))
        const closeResult = await client.closeTab(targetId)
        check('closed the tab it opened', closeResult.confirmed === true && !(await client.listTargets()).some((tab) => tab.targetId === targetId))
      }
      await client.dispose()
      check('disposed cleanly', client.status().connected === false)
    }
  }
}

/* ------------------------------------------------------------------- report */

console.log(`\n${failures.length === 0 ? 'PASS' : `FAIL (${failures.length})`}`)
for (const note of notes) console.log(`note: ${note}`)
fs.rmSync(SCRATCH, { recursive: true, force: true })
process.exit(failures.length === 0 ? 0 : 1)
