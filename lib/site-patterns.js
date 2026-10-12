/**
 * Site-experience store: the cross-session knowledge upstream web-access keeps
 * under `references/site-patterns/`.
 *
 * Two directories are read and only one is written: the seed directory shipped
 * inside the plugin (upstream's own accumulated notes) and the writable
 * runtime directory under the dsh home. Facts are recorded with the date they
 * were observed, so a later run treats them as hints to verify, not as
 * guarantees — which is exactly how upstream framed them.
 *
 * @module dsh-web-access/site-patterns
 */

import fs from 'node:fs'
import path from 'node:path'

/** A domain is a bare host name, optionally dotted; never a path. */
const DOMAIN_PATTERN = /^[a-z0-9][a-z0-9.-]*$/i

/** Normalize a domain or URL-ish input to a file-safe bare host. */
export function normalizeDomain(input) {
  const raw = String(input ?? '').trim()
  if (raw === '') return null
  let host = raw
  if (/^https?:\/\//i.test(raw)) {
    try { host = new URL(raw).hostname } catch { return null }
  }
  host = host.replace(/^www\./i, '').split('/')[0].toLowerCase()
  return DOMAIN_PATTERN.test(host) ? host : null
}

/** Read `aliases:` out of a pattern file's front matter. */
function aliasesOf(content) {
  const line = content.split(/\r?\n/).find((candidate) => candidate.startsWith('aliases:'))
  if (line === undefined) return []
  return line
    .replace(/^aliases:\s*/, '')
    .replace(/^\[/, '')
    .replace(/\]$/, '')
    .split(',')
    .map((value) => value.trim().replace(/^["']|["']$/g, ''))
    .filter(Boolean)
}

/** Strip the leading front matter block, returning the readable body. */
function bodyOf(content) {
  const fences = [...content.matchAll(/^---\s*$/gm)]
  return fences.length >= 2
    ? content.slice(fences[1].index + fences[1][0].length).replace(/^\r?\n/, '')
    : content
}

/** Per-domain experience files spread over a read-only seed and a writable store. */
export class SitePatternStore {
  /**
   * @param options - writable directory and an optional bundled seed directory.
   */
  constructor(options = {}) {
    /** Directory new observations are written to. */
    this.dir = options.dir
    /** Read-only directory shipped with the plugin. */
    this.seedDir = options.seedDir ?? null
  }

  /** Domains known across both directories, writable store winning. */
  list() {
    const seen = new Map()
    for (const [directory, writable] of [[this.seedDir, false], [this.dir, true]]) {
      if (directory === null || !fs.existsSync(directory)) continue
      let entries
      try { entries = fs.readdirSync(directory, { withFileTypes: true }) } catch { continue }
      for (const entry of entries) {
        if (!entry.isFile() || !entry.name.endsWith('.md')) continue
        const domain = entry.name.replace(/\.md$/, '')
        const previous = seen.get(domain)
        seen.set(domain, { domain, writable: writable || previous?.writable === true, updated: this.#updated(domain) })
      }
    }
    return [...seen.values()].sort((a, b) => a.domain.localeCompare(b.domain))
  }

  #updated(domain) {
    for (const directory of [this.dir, this.seedDir]) {
      if (directory === null) continue
      const file = path.join(directory, `${domain}.md`)
      try {
        const content = fs.readFileSync(file, 'utf8')
        const match = /^updated:\s*(.+)$/m.exec(content)
        if (match !== null) return match[1].trim()
      } catch {
        // Try the next directory.
      }
    }
    return null
  }

  /**
   * Read one domain's experience, preferring the writable store.
   * @param domain - bare host.
   * @returns the file body plus its provenance, or null.
   */
  read(domain) {
    const normalized = normalizeDomain(domain)
    if (normalized === null) return null
    for (const [directory, source] of [[this.dir, 'runtime'], [this.seedDir, 'bundled']]) {
      if (directory === null) continue
      const file = path.join(directory, `${normalized}.md`)
      try {
        const content = fs.readFileSync(file, 'utf8')
        return { domain: normalized, source, file, content, body: bodyOf(content).trim() }
      } catch {
        // Try the next directory.
      }
    }
    return null
  }

  /**
   * Record verified experience for one domain, creating the file when needed.
   * @param domain - bare host.
   * @param content - the facts to store; front matter is added when absent.
   * @param aliases - alternative names that should also match this domain.
   * @returns the written file path.
   */
  write(domain, content, aliases = []) {
    const normalized = normalizeDomain(domain)
    if (normalized === null) throw new Error('web-access: a site-experience domain must be a bare host name')
    fs.mkdirSync(this.dir, { recursive: true })
    const file = path.join(this.dir, `${normalized}.md`)
    const today = new Date().toISOString().slice(0, 10)
    const hasFrontMatter = /^---\s*\n/.test(content.trimStart())
    const document = hasFrontMatter
      ? content.trimStart()
      : [
        '---',
        `domain: ${normalized}`,
        `aliases: [${aliases.join(', ')}]`,
        `updated: ${today}`,
        '---',
        content.trimStart(),
      ].join('\n')
    fs.writeFileSync(file, document.endsWith('\n') ? document : `${document}\n`, 'utf8')
    return file
  }

  /**
   * Match free text (a user request) against every known domain and alias.
   * @param query - text to test.
   * @returns rendered experience blocks for every match.
   */
  match(query) {
    const text = String(query ?? '')
    if (text.trim() === '') return []
    const matches = []
    for (const entry of this.list()) {
      const found = this.read(entry.domain)
      if (found === null) continue
      const aliases = aliasesOf(found.content)
      const escape = (value) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
      const pattern = [entry.domain, ...aliases].map(escape).join('|')
      if (!new RegExp(pattern, 'i').test(text)) continue
      matches.push({ domain: entry.domain, aliases, source: found.source, body: found.body })
    }
    return matches
  }
}
