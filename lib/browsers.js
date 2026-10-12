/**
 * Chromium-family browser discovery.
 *
 * Upstream web-access is Chrome-only: it reads
 * `%LOCALAPPDATA%\Google\Chrome\User Data\DevToolsActivePort` and tells the
 * user to start `chrome.exe`. That assumption breaks on machines whose only
 * Chromium browser is Edge, Brave, Vivaldi, or plain Chromium — CDP is
 * identical in all of them, so there is no reason to be picky.
 *
 * This module is the single source of truth for "which browser data
 * directories and executables to consider", shared by the CDP endpoint
 * discovery and the bookmark/history search.
 *
 * @module dsh-web-access/browsers
 */

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

/** Join under the Windows local app data root. */
function localAppData(...segments) {
  return path.join(process.env.LOCALAPPDATA ?? '', ...segments)
}

/** Join under the Windows roaming app data root. */
function appData(...segments) {
  return path.join(process.env.APPDATA ?? '', ...segments)
}

/** Join under the OS home. */
function home(...segments) {
  return path.join(os.homedir(), ...segments)
}

/** Windows install roots that hold per-browser application directories. */
function windowsProgramRoots() {
  return [
    process.env['ProgramFiles'] ?? 'C:\\Program Files',
    process.env['ProgramFiles(x86)'] ?? 'C:\\Program Files (x86)',
    localAppData(),
  ]
}

/** Browser candidates exposed on Windows. */
function windowsBrowsers() {
  const roots = windowsProgramRoots()
  const exe = (relative) => roots.map((root) => path.join(root, relative))
  return [
    {
      id: 'chrome',
      label: 'Google Chrome',
      dataDirs: [localAppData('Google', 'Chrome', 'User Data')],
      executables: exe(path.join('Google', 'Chrome', 'Application', 'chrome.exe')),
    },
    {
      id: 'chrome-beta',
      label: 'Google Chrome Beta',
      dataDirs: [localAppData('Google', 'Chrome Beta', 'User Data')],
      executables: exe(path.join('Google', 'Chrome Beta', 'Application', 'chrome.exe')),
    },
    {
      id: 'chromium',
      label: 'Chromium',
      dataDirs: [localAppData('Chromium', 'User Data')],
      executables: exe(path.join('Chromium', 'Application', 'chrome.exe')),
    },
    {
      id: 'edge',
      label: 'Microsoft Edge',
      dataDirs: [localAppData('Microsoft', 'Edge', 'User Data')],
      executables: exe(path.join('Microsoft', 'Edge', 'Application', 'msedge.exe')),
    },
    {
      id: 'edge-beta',
      label: 'Microsoft Edge Beta',
      dataDirs: [localAppData('Microsoft', 'Edge Beta', 'User Data')],
      executables: exe(path.join('Microsoft', 'Edge Beta', 'Application', 'msedge.exe')),
    },
    {
      id: 'brave',
      label: 'Brave',
      dataDirs: [localAppData('BraveSoftware', 'Brave-Browser', 'User Data')],
      executables: exe(path.join('BraveSoftware', 'Brave-Browser', 'Application', 'brave.exe')),
    },
    {
      id: 'vivaldi',
      label: 'Vivaldi',
      dataDirs: [localAppData('Vivaldi', 'User Data')],
      executables: exe(path.join('Vivaldi', 'Application', 'vivaldi.exe')),
    },
    {
      id: 'opera',
      label: 'Opera',
      // Opera keeps its profile under Roaming rather than Local.
      dataDirs: [appData('Opera Software', 'Opera Stable')],
      executables: [
        ...exe(path.join('Opera', 'launcher.exe')),
        localAppData('Programs', 'Opera', 'launcher.exe'),
      ],
    },
  ]
}

/** Browser candidates exposed on macOS. */
function macBrowsers() {
  const support = (...segments) => home('Library', 'Application Support', ...segments)
  const app = (relative) => path.join('/Applications', relative)
  return [
    {
      id: 'chrome',
      label: 'Google Chrome',
      dataDirs: [support('Google', 'Chrome')],
      executables: [app('Google Chrome.app/Contents/MacOS/Google Chrome')],
    },
    {
      id: 'chrome-beta',
      label: 'Google Chrome Beta',
      dataDirs: [support('Google', 'Chrome Beta')],
      executables: [app('Google Chrome Beta.app/Contents/MacOS/Google Chrome Beta')],
    },
    {
      id: 'chromium',
      label: 'Chromium',
      dataDirs: [support('Chromium')],
      executables: [app('Chromium.app/Contents/MacOS/Chromium')],
    },
    {
      id: 'edge',
      label: 'Microsoft Edge',
      dataDirs: [support('Microsoft Edge')],
      executables: [app('Microsoft Edge.app/Contents/MacOS/Microsoft Edge')],
    },
    {
      id: 'brave',
      label: 'Brave',
      dataDirs: [support('BraveSoftware', 'Brave-Browser')],
      executables: [app('Brave Browser.app/Contents/MacOS/Brave Browser')],
    },
    {
      id: 'vivaldi',
      label: 'Vivaldi',
      dataDirs: [support('Vivaldi')],
      executables: [app('Vivaldi.app/Contents/MacOS/Vivaldi')],
    },
  ]
}

/** Browser candidates exposed on Linux. */
function linuxBrowsers() {
  const config = (...segments) => home('.config', ...segments)
  const which = (name) => [`/usr/bin/${name}`, `/usr/local/bin/${name}`, `/snap/bin/${name}`]
  return [
    {
      id: 'chrome',
      label: 'Google Chrome',
      dataDirs: [config('google-chrome')],
      executables: which('google-chrome'),
    },
    {
      id: 'chrome-beta',
      label: 'Google Chrome Beta',
      dataDirs: [config('google-chrome-beta')],
      executables: which('google-chrome-beta'),
    },
    {
      id: 'chromium',
      label: 'Chromium',
      dataDirs: [config('chromium'), home('snap/chromium/current/.config/chromium')],
      executables: [...which('chromium'), ...which('chromium-browser')],
    },
    {
      id: 'edge',
      label: 'Microsoft Edge',
      dataDirs: [config('microsoft-edge')],
      executables: [...which('microsoft-edge'), ...which('microsoft-edge-stable')],
    },
    {
      id: 'brave',
      label: 'Brave',
      dataDirs: [config('BraveSoftware', 'Brave-Browser')],
      executables: [...which('brave-browser'), ...which('brave')],
    },
    {
      id: 'vivaldi',
      label: 'Vivaldi',
      dataDirs: [config('vivaldi')],
      executables: which('vivaldi'),
    },
  ]
}

/**
 * Every Chromium-family browser worth probing on this platform, each with its
 * data directories and executable candidates.
 * @returns browser candidates, most common first.
 */
export function chromiumBrowsers() {
  switch (os.platform()) {
    case 'darwin': return macBrowsers()
    case 'win32': return windowsBrowsers()
    case 'linux': return linuxBrowsers()
    default: return []
  }
}

/** The first executable candidate that exists on disk. */
export function installedExecutable(browser) {
  for (const candidate of browser.executables) {
    try {
      if (fs.existsSync(candidate)) return candidate
    } catch {
      // Keep looking.
    }
  }
  return null
}

/**
 * Browser candidates whose profile directory exists, ordered so that a browser
 * the user actually uses comes before one that merely ships with the OS.
 * @returns `{ browser, dataDir, executable }` entries.
 */
export function installedBrowsers() {
  const installed = []
  for (const browser of chromiumBrowsers()) {
    for (const dataDir of browser.dataDirs) {
      let present = false
      try {
        present = fs.existsSync(dataDir)
      } catch {
        present = false
      }
      if (!present) continue
      installed.push({ browser, dataDir, executable: installedExecutable(browser) })
      break
    }
  }
  return installed
}

/**
 * The `<dataDir>/DevToolsActivePort` file to read for each candidate. The file
 * exists only while that browser runs with a DevTools endpoint available.
 * @returns absolute file paths.
 */
export function devToolsActivePortFiles() {
  const files = []
  for (const browser of chromiumBrowsers()) {
    for (const dataDir of browser.dataDirs) files.push(path.join(dataDir, 'DevToolsActivePort'))
  }
  return files
}

/**
 * Render the launch command that opens a browser's debug endpoint.
 * @param browser - a candidate from {@link chromiumBrowsers}.
 * @param executable - the resolved executable path, when one exists.
 * @returns a copy-pasteable command for this platform.
 */
export function debugLaunchCommand(browser, executable) {
  const exe = executable ?? `<${browser.label} executable>`
  const quoted = exe.includes(' ') ? `"${exe}"` : exe
  switch (os.platform()) {
    case 'win32': return `& ${quoted} --remote-debugging-port=9222`
    case 'darwin': return `open -a "${browser.label}" --args --remote-debugging-port=9222`
    default: return `${quoted} --remote-debugging-port=9222`
  }
}
