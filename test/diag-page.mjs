#!/usr/bin/env node
/**
 * Focused probe: one page, several expressions, to explain an anomaly seen in
 * the live self-check (`document.querySelector('h1')` returned null on a page
 * that has an h1) and to confirm which execution context evaluate reaches.
 *
 *   node test/diag-page.mjs [url]
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { CdpClient } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'cdp.js')).href)

const url = process.argv[2] ?? 'https://example.com'
const client = new CdpClient({})
const opened = await client.openTab(url, { owner: 'diag' })
const id = opened.targetId
console.log('openTab ->', JSON.stringify(opened))

const probes = {
  title: 'document.title',
  href: 'location.href',
  ready: 'document.readyState',
  h1count: 'document.querySelectorAll("h1").length',
  h1html: 'document.querySelector("h1") ? document.querySelector("h1").outerHTML.slice(0, 120) : "NO H1 NODE"',
  h1optional: 'document.querySelector("h1")?.textContent ?? "OPTIONAL-CHAIN-SAW-NOTHING"',
  bodyStart: 'document.body.innerHTML.trim().slice(0, 160)',
  tagList: '[...document.body.querySelectorAll("*")].map(e => e.tagName).slice(0, 12).join(",")',
  contexts: 'performance.getEntriesByType("navigation").length',
}

for (const [label, expression] of Object.entries(probes)) {
  try {
    const value = await client.evaluate(id, expression)
    console.log(`${label.padEnd(12)} = ${JSON.stringify(value)}`)
  } catch (error) {
    console.log(`${label.padEnd(12)} ! ${error.message}`)
  }
}

console.log('close ->', JSON.stringify(await client.closeTab(id)))
await client.dispose()
