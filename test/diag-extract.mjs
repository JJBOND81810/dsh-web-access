#!/usr/bin/env node
/**
 * Extraction quality probe: opens a URL and reports what `web_read` would
 * return, checking the two failure modes found on real pages —
 * a non-prose payload leaking into the text, and the character budget being
 * exceeded by one oversized text node.
 *
 *   node test/diag-extract.mjs [url] [maxChars]
 */

import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const { CdpClient } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'cdp.js')).href)
const { extractExpression } = await import(pathToFileURL(path.join(HERE, '..', 'lib', 'extract.js')).href)

const url = process.argv[2] ?? 'https://www.baidu.com'
const maxChars = Number(process.argv[3] ?? 3000)

const client = new CdpClient({})
const opened = await client.openTab(url, { owner: 'diag-extract' })
console.log('openTab ->', JSON.stringify(opened))

const page = await client.evaluate(opened.targetId, extractExpression({ maxChars }))
if (page?.error) {
  console.log('extraction error:', page.error)
} else {
  const text = page.text ?? ''
  const violations = []
  if (text.length > maxChars) violations.push(`text length ${text.length} exceeds the ${maxChars} budget`)
  if (/html\{font-size|@keyframes|\.c-container\s*\{/.test(text)) violations.push('CSS leaked into the text')
  if (/\b(function|var |=>)\s*[({]/.test(text.slice(0, 2000))) violations.push('JavaScript leaked into the text')

  console.log(`title      : ${page.title}`)
  console.log(`url        : ${page.url}`)
  console.log(`chars      : ${page.chars} (budget ${maxChars}, truncated=${page.truncated})`)
  console.log(`nodes      : ${page.nodes}`)
  console.log(`headings   : ${page.headings?.length ?? 0}`)
  console.log(`links      : ${page.linkCount}`)
  console.log(`fields     : ${(page.fields ?? []).length}`)
  for (const field of (page.fields ?? []).slice(0, 5)) console.log(`   - ${JSON.stringify(field)}`)
  console.log(`text head  : ${JSON.stringify(text.slice(0, 240))}`)
  console.log(violations.length === 0 ? 'VERDICT: clean' : `VERDICT: FAIL — ${violations.join('; ')}`)
}

console.log('close ->', JSON.stringify(await client.closeTab(opened.targetId)))
await client.dispose()
