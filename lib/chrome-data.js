/**
 * Local Chrome resource search: bookmarks and history.
 *
 * A port of upstream `scripts/find-url.mjs`. It answers the questions a web
 * search cannot: an internal or SSO host the user visits, or a page the user
 * saw earlier but cannot name. Upstream shelled out to the `sqlite3` binary;
 * dsh ships Node 24, so `node:sqlite` is preferred and the binary is only a
 * fallback.
 *
 * Chrome keeps its history database locked while running, so the file is
 * copied before it is opened.
 *
 * @module dsh-web-access/chrome-data
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { installedBrowsers } from './browsers.js'

/** Microseconds between 1601-01-01 (WebKit epoch) and 1970-01-01. */
const WEBKIT_EPOCH_DIFF_US = 11_644_473_600_000_000n

/** `node:sqlite` DatabaseSync, or null when unavailable. */
let databaseSync
let databaseSyncResolved = false

async function sqliteDriver() {
  if (databaseSyncResolved) return databaseSync
  databaseSyncResolved = true
  try {
    const mod = await import('node:sqlite')
    databaseSync = mod.DatabaseSync ?? null
  } catch {
    databaseSync = null
  }
  return databaseSync
}

/**
 * Every installed Chromium-family browser profile root, so a bookmark or
 * history lookup is not limited to Chrome (this machine's browser may be Edge).
 * @returns `{ browser, dataDir }` entries, in candidate order.
 */
export function browserDataDirs() {
  return installedBrowsers().map(({ browser, dataDir }) => ({ browser: browser.label, dataDir }))
}

/**
 * Enumerate Chrome profiles.
 * @param dataDir - Chrome user-data directory.
 * @returns `{ dir, name }` entries, always non-empty.
 */
export function listProfiles(dataDir) {
  try {
    const state = JSON.parse(fs.readFileSync(path.join(dataDir, 'Local State'), 'utf8'))
    const info = state?.profile?.info_cache ?? {}
    const list = Object.keys(info).map((dir) => ({ dir, name: info[dir]?.name ?? dir }))
    if (list.length > 0) return list
  } catch {
    // Fall through to the conventional default profile.
  }
  return [{ dir: 'Default', name: 'Default' }]
}

/** Parse `--since` values such as `7d`, `12h`, `30m`, or an ISO date. */
export function parseSince(value) {
  if (value === undefined || value === null || value === '') return null
  if (value instanceof Date) return value
  const relative = /^(\d+)([dhm])$/.exec(String(value).trim())
  if (relative !== null) {
    const count = Number.parseInt(relative[1], 10)
    const unit = { d: 86_400_000, h: 3_600_000, m: 60_000 }[relative[2]]
    return new Date(Date.now() - count * unit)
  }
  const absolute = new Date(value)
  return Number.isNaN(absolute.getTime()) ? null : absolute
}

/**
 * Search one profile's bookmarks.
 * @param profileDir - profile directory.
 * @param profileName - display name.
 * @param keywords - all keywords must match title or URL (case-insensitive).
 * @returns matching bookmarks.
 */
export function searchBookmarks(profileDir, profileName, keywords) {
  if (keywords.length === 0) return []
  const file = path.join(profileDir, 'Bookmarks')
  if (!fs.existsSync(file)) return []
  let data
  try {
    data = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return []
  }
  const needles = keywords.map((keyword) => keyword.toLowerCase())
  const out = []
  const walk = (node, trail) => {
    if (node === null || typeof node !== 'object') return
    if (node.type === 'url') {
      const haystack = `${node.name ?? ''} ${node.url ?? ''}`.toLowerCase()
      if (needles.every((needle) => haystack.includes(needle))) {
        out.push({ profile: profileName, title: node.name ?? '', url: node.url ?? '', folder: trail.join(' / ') })
      }
    }
    if (Array.isArray(node.children)) {
      const next = node.name ? [...trail, node.name] : trail
      for (const child of node.children) walk(child, next)
    }
  }
  for (const root of Object.values(data.roots ?? {})) walk(root, [])
  return out
}

/** Build the history SQL for one profile's `urls` table. */
function historySql({ keywords, since, limit, sort }) {
  const conditions = ['last_visit_time > 0']
  for (const keyword of keywords) {
    const escaped = String(keyword).toLowerCase().replace(/'/g, "''")
    conditions.push(`LOWER(title || ' ' || url) LIKE '%${escaped}%'`)
  }
  if (since instanceof Date) {
    // Computed as an exact 64-bit literal: microsecond timestamps exceed the
    // float64 integer range, so this must never round-trip through a JS number.
    const unixSeconds = BigInt(Math.floor(since.getTime() / 1000))
    conditions.push(`last_visit_time >= ${(unixSeconds + WEBKIT_EPOCH_DIFF_US / 1_000_000n) * 1_000_000n}`)
  }
  const order = sort === 'visits' ? 'visit_count DESC, last_visit_time DESC' : 'last_visit_time DESC'
  const bound = limit === 0 ? -1 : limit
  return `SELECT title, url, datetime((last_visit_time / 1000000) - 11644473600, 'unixepoch', 'localtime') AS visit, visit_count
    FROM urls WHERE ${conditions.join(' AND ')} ORDER BY ${order} LIMIT ${bound};`
}

/**
 * Search one profile's history. The database is copied first because Chrome
 * holds it locked; the copy is always removed.
 * @param profileDir - profile directory.
 * @param profileName - display name.
 * @param query - keywords, time window, limit, and sort order.
 * @returns matching history rows, or an empty list when unreadable.
 */
export async function searchHistory(profileDir, profileName, query) {
  const source = path.join(profileDir, 'History')
  if (!fs.existsSync(source)) return []
  const copy = path.join(os.tmpdir(), `dsh-web-access-history-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}.sqlite`)
  try {
    fs.copyFileSync(source, copy)
    const sql = historySql(query)
    const rows = await queryHistory(copy, sql)
    return rows.map((row) => ({
      profile: profileName,
      title: row.title ?? '',
      url: row.url ?? '',
      visit: row.visit ?? '',
      visitCount: Number(row.visit_count ?? 0),
    }))
  } catch (error) {
    if (error?.code === 'SQLITE_UNAVAILABLE') return []
    return []
  } finally {
    try { fs.unlinkSync(copy) } catch { /* the copy may already be gone */ }
  }
}

async function queryHistory(file, sql) {
  const DatabaseSync = await sqliteDriver()
  if (DatabaseSync !== null) {
    const db = new DatabaseSync(file, { readOnly: true })
    try {
      return db.prepare(sql).all()
    } finally {
      db.close()
    }
  }
  try {
    const raw = execFileSync('sqlite3', ['-separator', '\t', file, sql], {
      encoding: 'utf8',
      maxBuffer: 64 * 1024 * 1024,
    })
    return raw.trim().split('\n').filter(Boolean).map((line) => {
      const [title, url, visit, visit_count] = line.split('\t')
      return { title, url, visit, visit_count }
    })
  } catch (error) {
    if (error?.code === 'ENOENT') {
      const unavailable = new Error('neither node:sqlite nor the sqlite3 binary is available')
      unavailable.code = 'SQLITE_UNAVAILABLE'
      throw unavailable
    }
    return []
  }
}

/**
 * Search bookmarks and history across every Chrome profile.
 * @param query - keywords, `only`, `limit`, `since`, and `sort`.
 * @returns `{ bookmarks, history, profiles, notes }`.
 */
export async function findUrls(query = {}) {
  const keywords = (query.keywords ?? []).filter((keyword) => typeof keyword === 'string' && keyword.trim() !== '')
  const limit = Number.isFinite(query.limit) ? Math.max(0, Math.floor(query.limit)) : 20
  const only = query.only ?? null
  const sort = query.sort === 'visits' ? 'visits' : 'recent'
  const since = parseSince(query.since)
  const notes = []

  const roots = browserDataDirs()
  if (roots.length === 0) {
    return { bookmarks: [], history: [], sources: [], notes: ['no Chromium-family browser profile directory was found'] }
  }
  const bookmarks = []
  const history = []
  for (const root of roots) {
    for (const profile of listProfiles(root.dataDir)) {
      const profileDir = path.join(root.dataDir, profile.dir)
      if (!fs.existsSync(profileDir)) continue
      // One label per browser+profile, so a row stays traceable when several
      // browsers are installed.
      const label = profile.name === 'Default' || profile.name === '' ? root.browser : `${root.browser} / ${profile.name}`
      if (only !== 'history') bookmarks.push(...searchBookmarks(profileDir, label, keywords))
      if (only !== 'bookmarks') {
        history.push(...await searchHistory(profileDir, label, {
          keywords,
          since,
          limit: limit === 0 ? 0 : limit * 2,
          sort,
        }))
      }
    }
  }
  if (only !== 'history' && keywords.length === 0) {
    notes.push('Bookmarks have no time dimension, so an empty keyword list returns none; add keywords or use only=history.')
  }
  history.sort(sort === 'visits'
    ? (a, b) => (b.visitCount - a.visitCount) || String(b.visit).localeCompare(String(a.visit))
    : (a, b) => String(b.visit).localeCompare(String(a.visit)))
  const cap = (items) => (limit === 0 ? items : items.slice(0, limit))
  const sources = [...new Set([...bookmarks, ...history].map((row) => row.profile))]
  return { bookmarks: cap(bookmarks), history: cap(history), sources, notes }
}

/** Render `findUrls` output as the compact text block the model reads. */
export function formatFindUrls(result) {
  const lines = []
  const clean = (value) => String(value ?? '').replaceAll('|', '│').trim()
  const multiSource = (result.sources?.length ?? 0) > 1
  lines.push(`[bookmarks] ${result.bookmarks.length}`)
  for (const entry of result.bookmarks) {
    const segments = [clean(entry.title) || '(untitled)', clean(entry.url)]
    if (entry.folder) segments.push(clean(entry.folder))
    if (multiSource) segments.push(`@${clean(entry.profile)}`)
    lines.push(`  ${segments.join(' | ')}`)
  }
  lines.push('')
  lines.push(`[history] ${result.history.length}`)
  for (const entry of result.history) {
    const segments = [clean(entry.title) || '(untitled)', clean(entry.url), clean(entry.visit)]
    if (entry.visitCount > 1) segments.push(`visits=${entry.visitCount}`)
    if (multiSource) segments.push(`@${clean(entry.profile)}`)
    lines.push(`  ${segments.join(' | ')}`)
  }
  for (const note of result.notes) lines.push(`note: ${note}`)
  return lines.join('\n')
}
