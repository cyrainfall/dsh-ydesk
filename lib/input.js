// Input injection: drives a platform helper process over stdin lines.

import { spawn, spawnSync } from 'node:child_process'
import fs from 'node:fs'
import net from 'node:net'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import path from 'node:path'

const here = path.dirname(fileURLToPath(import.meta.url))
const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

const VK = {
  Escape: 0x1b, Digit1: 0x31, Digit2: 0x32, Digit3: 0x33, Digit4: 0x34, Digit5: 0x35,
  Digit6: 0x36, Digit7: 0x37, Digit8: 0x38, Digit9: 0x39, Digit0: 0x30,
  Minus: 0xbd, Equal: 0xbb, Backspace: 0x08, Tab: 0x09,
  KeyQ: 0x51, KeyW: 0x57, KeyE: 0x45, KeyR: 0x52, KeyT: 0x54, KeyY: 0x59, KeyU: 0x55,
  KeyI: 0x49, KeyO: 0x4f, KeyP: 0x50, BracketLeft: 0xdb, BracketRight: 0xdd, Backslash: 0xdc,
  CapsLock: 0x14, KeyA: 0x41, KeyS: 0x53, KeyD: 0x44, KeyF: 0x46, KeyG: 0x47, KeyH: 0x48,
  KeyJ: 0x4a, KeyK: 0x4b, KeyL: 0x4c, Semicolon: 0xba, Quote: 0xde, Enter: 0x0d,
  ShiftLeft: 0xa0, KeyZ: 0x5a, KeyX: 0x58, KeyC: 0x43, KeyV: 0x56, KeyB: 0x42, KeyN: 0x4e,
  KeyM: 0x4d, Comma: 0xbc, Period: 0xbe, Slash: 0xbf, ShiftRight: 0xa1,
  ControlLeft: 0xa2, AltLeft: 0xa4, Space: 0x20, AltRight: 0xa5, ControlRight: 0xa3,
  MetaLeft: 0x5b, MetaRight: 0x5c, ContextMenu: 0x5d,
  ArrowLeft: 0x25, ArrowUp: 0x26, ArrowRight: 0x27, ArrowDown: 0x28,
  Insert: 0x2d, Delete: 0x2e, Home: 0x24, End: 0x23, PageUp: 0x21, PageDown: 0x22,
  NumLock: 0x90, ScrollLock: 0x91, PrintScreen: 0x2c, Pause: 0x13,
  Numpad0: 0x60, Numpad1: 0x61, Numpad2: 0x62, Numpad3: 0x63, Numpad4: 0x64,
  Numpad5: 0x65, Numpad6: 0x66, Numpad7: 0x67, Numpad8: 0x68, Numpad9: 0x69,
  NumpadMultiply: 0x6a, NumpadAdd: 0x6b, NumpadSubtract: 0x6d, NumpadDecimal: 0x6e, NumpadDivide: 0x6f,
  NumpadEnter: 0x0d,
}
for (let i = 1; i <= 24; i++) VK[`F${i}`] = 0x6f + i

const MACCODE = {
  KeyA: 0, KeyS: 1, KeyD: 2, KeyF: 3, KeyH: 4, KeyG: 5, KeyZ: 6, KeyX: 7, KeyC: 8, KeyV: 9,
  KeyB: 11, KeyQ: 12, KeyW: 13, KeyE: 14, KeyR: 15, KeyY: 16, KeyT: 17,
  Digit1: 18, Digit2: 19, Digit3: 20, Digit4: 21, Digit6: 22, Digit5: 23, Equal: 24,
  Digit9: 25, Digit7: 26, Minus: 27, Digit8: 28, Digit0: 29, BracketRight: 30,
  KeyO: 31, KeyU: 32, BracketLeft: 33, KeyI: 34, KeyP: 35, Enter: 36, KeyL: 37, KeyJ: 38,
  Quote: 39, KeyK: 40, Semicolon: 41, Backslash: 42, Comma: 43, Slash: 44, KeyN: 45, KeyM: 46,
  Period: 47, Tab: 48, Space: 49, Backquote: 50, Backspace: 51, Escape: 53,
  MetaLeft: 55, ShiftLeft: 56, CapsLock: 57, AltLeft: 58, ControlLeft: 59,
  ShiftRight: 60, AltRight: 61, ControlRight: 62,
  NumpadDecimal: 65, NumpadMultiply: 67, NumpadAdd: 69, NumLock: 71, NumpadDivide: 75,
  NumpadEnter: 76, NumpadSubtract: 78, Numpad0: 82, Numpad1: 83, Numpad2: 84, Numpad3: 85,
  Numpad4: 86, Numpad5: 87, Numpad6: 88, Numpad7: 89, Numpad8: 91, Numpad9: 92,
  F5: 96, F6: 97, F7: 98, F3: 99, F8: 100, F9: 101, F11: 103, F13: 105,
  F14: 107, F10: 109, F12: 111, F15: 113, Home: 115, PageUp: 116, Delete: 117,
  F4: 118, End: 119, F2: 120, PageDown: 121, F1: 122,
  ArrowLeft: 123, ArrowRight: 124, ArrowDown: 125, ArrowUp: 126,
}

export function keyCodeFor(code) {
  if (isMac) return MACCODE[code]
  return VK[code]
}

export class Injector {
  constructor() {
    this.child = null
    this.ready = false
    this.error = ''
    this.buffer = ''
    this.queue = []
    this.flushTimer = null
    this.lastMove = null
    this.sent = 0
    this.socket = null
    this.port = 0
    this.task = ''
    this.socket = null
    this.port = 0
    this.task = ''
    this.starting = false
  }

  start() {
    if (isWin) {
      this.startWin()
      return
    }
    if (this.child) return
    if (!isMac) {
      this.error = 'input injection is only implemented on macOS and Windows'
      return
    }
    const script = isMac ? path.join(here, 'helper-mac.py') : path.join(here, 'helper-win.ps1')
    const argv = isMac
      ? ['/usr/bin/python3', '-u', script]
      : ['powershell.exe', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', script]
    let child
    try {
      child = spawn(argv[0], argv.slice(1), { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true })
    } catch (err) {
      this.error = `cannot start input helper: ${err.message}`
      return
    }
    this.child = child
    child.stdout.on('data', (d) => {
      this.buffer += d.toString('utf8')
      const lines = this.buffer.split('\n')
      this.buffer = lines.pop() || ''
      for (const line of lines) {
        const text = line.trim()
        if (text === 'READY') this.ready = true
        else if (text.startsWith('ERR ')) this.error = text.slice(4)
      }
    })
    let stderr = ''
    child.stderr.on('data', (d) => { stderr = (stderr + d.toString('utf8')).slice(-2000) })
    child.on('error', (err) => { this.error = `input helper failed: ${err.message}` })
    child.on('close', () => {
      this.child = null
      this.ready = false
      if (!this.error && stderr.trim()) this.error = stderr.trim().split('\n').pop()
    })
  }

  /**
   * Windows Harness usually runs in session 0, where SendInput lands on a
   * desktop nobody can see. The helper therefore has to live in the user's
   * interactive session: schedule it there and drive it over loopback TCP.
   */
  startWin() {
    if (this.socket || this.starting) return
    this.starting = true
    const script = path.join(here, 'helper-win.ps1')
    const port = 9300 + Math.floor(Math.random() * 500)
    this.port = port
    const base = process.env.LOCALAPPDATA || os.tmpdir()
    const dir = path.join(base, 'ydesk', `input-${process.pid}-${Date.now().toString(36)}`)
    const task = `dsh-ydesk-input-${process.pid}`
    this.task = task
    try {
      fs.mkdirSync(dir, { recursive: true })
      const cmd = [
        '@echo off',
        'cd /d "%~dp0"',
        `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -WindowStyle Hidden -File "${script}" -ServerPort ${port}`,
        '',
      ].join('\r\n')
      fs.writeFileSync(path.join(dir, 'inject.cmd'), cmd, 'ascii')
    } catch (err) {
      this.error = `cannot prepare input helper: ${err.message}`
      this.starting = false
      return
    }
    const user = process.env.USERNAME || ''
    for (const args of [
      ['/end', '/tn', task],
      ['/delete', '/tn', task, '/f'],
      ['/create', '/tn', task, '/tr', path.join(dir, 'inject.cmd'), '/sc', 'once', '/st', '23:59', '/ru', user, '/it', '/rl', 'HIGHEST', '/f'],
      ['/run', '/tn', task],
    ]) {
      try {
        const out = spawnSync('schtasks', args, { encoding: 'utf8', windowsHide: true })
        if (out.status !== 0 && args[0] !== '/end' && args[0] !== '/delete') {
          this.error = `schtasks ${args[0]} failed: ${(out.stderr || out.stdout || '').trim().slice(0, 200)}`
        }
      } catch (err) {
        this.error = `schtasks ${args[0]} failed: ${err.message}`
      }
    }
    const deadline = Date.now() + 8000
    const attempt = () => {
      const socket = net.connect(port, '127.0.0.1')
      socket.setNoDelay(true)
      socket.once('connect', () => {
        this.socket = socket
        this.starting = false
      })
      socket.on('data', (d) => {
        this.buffer += d.toString('utf8')
        const lines = this.buffer.split('\n')
        this.buffer = lines.pop() || ''
        for (const line of lines) {
          const text = line.trim()
          if (text === 'READY') { this.ready = true; this.error = '' }
          else if (text.startsWith('ERR ')) this.error = text.slice(4)
        }
      })
      socket.on('error', () => {})
      socket.on('close', () => {
        if (this.socket === socket) {
          this.socket = null
          this.ready = false
        }
      })
      setTimeout(() => {
        if (this.socket) return
        try { socket.destroy() } catch {}
        if (Date.now() < deadline && this.starting) {
          setTimeout(attempt, 250)
          return
        }
        this.starting = false
        if (!this.error) this.error = 'input helper did not answer on loopback'
      }, 400)
    }
    attempt()
  }

  write(line) {
    if (isWin) {
      if (!this.socket) this.startWin()
      if (!this.socket || !this.socket.writable) return false
      try {
        this.socket.write(line + '\r\n')
        return true
      } catch {
        return false
      }
    }
    if (!this.child) this.start()
    if (!this.child || !this.child.stdin.writable) return false
    try {
      this.child.stdin.write(line + '\n')
      return true
    } catch {
      return false
    }
  }

  move(nx, ny) {
    this.lastMove = [nx, ny]
    if (this.flushTimer) return
    this.flushTimer = setTimeout(() => {
      this.flushTimer = null
      const point = this.lastMove
      if (!point) return
      this.lastMove = null
      this.write(`m ${point[0].toFixed(5)} ${point[1].toFixed(5)}`)
    }, 6)
  }

  button(button, down) {
    // 1 = left, 2 = right, 3 = middle: both helpers use that convention.
    const code = button === 2 ? 2 : button === 3 ? 3 : 1
    this.write(`${down ? 'md' : 'mu'} ${code}`)
  }

  wheel(lines, horizontal = 0) {
    this.write(`w ${lines} ${horizontal}`)
  }

  key(code, down) {
    const mapped = keyCodeFor(code)
    if (mapped === undefined) return false
    this.write(`${down ? 'kd' : 'ku'} ${mapped}`)
    return true
  }

  text(value) {
    if (!value) return
    this.write(`t ${Buffer.from(value, 'utf8').toString('base64')}`)
  }

  status() {
    return {
      active: !!(this.child || this.socket),
      ready: this.ready,
      error: this.error,
      helper: isMac ? 'python3-cgevent' : isWin ? 'powershell-sendinput' : 'none',
      transport: isWin ? 'loopback' : 'stdio',
      port: this.port || 0,
      sent: this.sent || 0,
    }
  }

  stop() {
    try { this.child && this.child.kill('SIGKILL') } catch {}
    this.child = null
    if (this.socket) {
      try { this.socket.destroy() } catch {}
      this.socket = null
    }
    if (this.task) {
      spawnSync('schtasks', ['/end', '/tn', this.task], { windowsHide: true })
      spawnSync('schtasks', ['/delete', '/tn', this.task, '/f'], { windowsHide: true })
      this.task = ''
    }
    this.ready = false
    this.starting = false
  }
}
