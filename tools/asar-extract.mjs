#!/usr/bin/env node
/**
 * Minimal asar reader, extracted while porting this plugin.
 *
 * The dsh implementation checkout ships as an Electron `app.asar`, and a plain
 * `read` of a path inside it fails (the archive header uses BigInt sizes).
 * This reads the format directly: a pickle header, then a JSON index whose file
 * offsets are relative to the data section.
 *
 * Usage:
 *   node tools/asar-extract.mjs list    <asar> <regex>
 *   node tools/asar-extract.mjs extract <asar> <outDir> <prefix...>
 *
 * Example (read the dsh plugin API from a local install):
 *   node tools/asar-extract.mjs list "$DSH_APP/resources/app.asar" "^dsh/node_modules/@deepseek-ai/[^/]+/package\.json$"
 *   node tools/asar-extract.mjs extract "$DSH_APP/resources/app.asar" ./asar-out "dsh/node_modules/@deepseek-ai/dsh-tools"
 */

import fs from 'node:fs'
import path from 'node:path'

const [mode, asarPath, ...rest] = process.argv.slice(2)
if (mode === undefined || asarPath === undefined) {
  console.error('usage: asar-extract.mjs list <asar> <regex> | extract <asar> <outDir> <prefix...>')
  process.exit(2)
}

const fd = fs.openSync(asarPath, 'r')
try {
  const head = Buffer.alloc(16)
  fs.readSync(fd, head, 0, 16, 0)
  const headerSize = head.readUInt32LE(4)
  const jsonSize = head.readUInt32LE(12)
  const jsonBuffer = Buffer.alloc(jsonSize)
  fs.readSync(fd, jsonBuffer, 0, jsonSize, 16)
  const header = JSON.parse(jsonBuffer.toString('utf8'))
  const dataStart = 8 + headerSize

  const walk = (node, prefix, visit) => {
    for (const [name, entry] of Object.entries(node.files ?? {})) {
      const rel = prefix === '' ? name : `${prefix}/${name}`
      if (entry.files) walk(entry, rel, visit)
      else visit(rel, entry)
    }
  }

  if (mode === 'list') {
    const pattern = new RegExp(rest[0] ?? '.')
    let count = 0
    let bytes = 0
    walk(header, '', (rel, entry) => {
      if (!pattern.test(rel)) return
      count++
      bytes += Number(entry.size)
      if (count <= 400) console.log(String(entry.size).padStart(9), rel)
    })
    console.log(`# ${count} entries, ${(bytes / 1048576).toFixed(1)} MiB total`)
  } else if (mode === 'extract') {
    const [outDir, ...prefixes] = rest
    if (outDir === undefined || prefixes.length === 0) {
      console.error('usage: asar-extract.mjs extract <asar> <outDir> <prefix...>')
      process.exit(2)
    }
    let count = 0
    let bytes = 0
    walk(header, '', (rel, entry) => {
      if (!prefixes.some((prefix) => rel === prefix || rel.startsWith(`${prefix}/`) || rel.startsWith(prefix))) return
      if (entry.unpacked) return // lives in app.asar.unpacked instead
      const target = path.join(outDir, rel)
      fs.mkdirSync(path.dirname(target), { recursive: true })
      const size = Number(entry.size)
      const buffer = Buffer.alloc(size)
      const offset = dataStart + Number(entry.offset)
      let read = 0
      while (read < size) {
        const got = fs.readSync(fd, buffer, read, size - read, offset + read)
        if (got <= 0) break
        read += got
      }
      fs.writeFileSync(target, buffer)
      count++
      bytes += size
    })
    console.log(JSON.stringify({ extracted: count, bytes, out: outDir }))
  } else {
    console.error(`unknown mode: ${mode}`)
    process.exit(2)
  }
} finally {
  fs.closeSync(fd)
}
