#!/usr/bin/env node
/**
 * Diagnostic: why does the browser-level WebSocket handshake fail?
 * Prints the authoritative debugger URL from /json/version, the raw handshake
 * response, and a global-WebSocket attempt against the exact URL.
 *
 *   node test/diag-ws.mjs [port]
 */

import http from 'node:http'
import net from 'node:net'

const port = Number(process.argv[2] ?? 9222)

const get = (path) => new Promise((resolve) => {
  const request = http.get({ host: '127.0.0.1', port, path, timeout: 4000 }, (response) => {
    let body = ''
    response.on('data', (chunk) => { body += chunk })
    response.on('end', () => resolve({ status: response.statusCode, body }))
  })
  request.on('error', (error) => resolve({ status: null, body: `error: ${error.message}` }))
  request.on('timeout', () => { request.destroy(); resolve({ status: null, body: 'timeout' }) })
})

const version = await get('/json/version')
console.log('GET /json/version ->', version.status)
console.log(version.body.slice(0, 600))

let debuggerUrl = null
try {
  debuggerUrl = JSON.parse(version.body).webSocketDebuggerUrl ?? null
} catch { /* not json */ }
console.log('webSocketDebuggerUrl:', debuggerUrl)

const targets = await get('/json/list')
console.log('\nGET /json/list ->', targets.status, `${targets.body.length} bytes`)

/** Raw handshake so the response status line and headers are visible. */
function rawHandshake(url, extraHeaders = []) {
  return new Promise((resolve) => {
    const { hostname, port: urlPort, pathname } = new URL(url)
    const socket = net.createConnection(Number(urlPort), hostname)
    let reply = ''
    const done = () => { socket.destroy(); resolve(reply.split('\r\n\r\n')[0]) }
    socket.setTimeout(4000, done)
    socket.on('connect', () => {
      socket.write([
        `GET ${pathname} HTTP/1.1`,
        `Host: ${hostname}:${urlPort}`,
        'Upgrade: websocket',
        'Connection: Upgrade',
        'Sec-WebSocket-Key: dGhlIHNhbXBsZSBub25jZQ==',
        'Sec-WebSocket-Version: 13',
        ...extraHeaders,
        '', '',
      ].join('\r\n'))
    })
    socket.on('data', (chunk) => {
      reply += chunk.toString('utf8')
      if (reply.includes('\r\n\r\n')) done()
    })
    socket.on('error', (error) => { resolve(`socket error: ${error.message}`) })
  })
}

for (const candidate of [
  `ws://127.0.0.1:${port}/devtools/browser`,
  debuggerUrl,
].filter(Boolean)) {
  console.log(`\n--- raw handshake (no Origin): ${candidate}`)
  console.log(await rawHandshake(candidate))
  console.log(`--- raw handshake (with Origin): ${candidate}`)
  console.log((await rawHandshake(candidate, [`Origin: http://127.0.0.1:${port}`])).split('\r\n').slice(0, 3).join('\n'))
}

/** Now try the real client, on the authoritative URL. */
async function tryWebSocket(url, label) {
  console.log(`\n--- global WebSocket -> ${label}`)
  console.log(`    ${url}`)
  await new Promise((resolve) => {
    let settled = false
    const finish = (verdict) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      console.log(`    ${verdict}`)
      try { socket.close() } catch { /* ignore */ }
      resolve()
    }
    const timer = setTimeout(() => finish('TIMEOUT (no open, no error)'), 6000)
    const socket = new WebSocket(url)
    socket.addEventListener('open', () => finish('OPEN'))
    socket.addEventListener('error', (event) => {
      const error = event?.error
      finish(`ERROR type=${error?.constructor?.name} message=${JSON.stringify(error?.message)} `
        + `cause=${JSON.stringify(error?.cause?.message ?? error?.cause ?? null)}`)
    })
    socket.addEventListener('close', (event) => finish(`CLOSE code=${event?.code} reason=${JSON.stringify(event?.reason)}`))
  })
}

if (debuggerUrl !== null) await tryWebSocket(debuggerUrl, 'authoritative URL')
await tryWebSocket(`ws://127.0.0.1:${port}/devtools/browser`, 'guessed browser path')
