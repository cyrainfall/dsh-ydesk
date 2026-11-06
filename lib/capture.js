// Screen capture pipeline: ffmpeg -> fragmented MP4 -> init + playable
// fragments, with a small ring buffer so a new viewer starts instantly.

import { spawn, spawnSync } from 'node:child_process'

function logLine(message) {
  process.stderr.write(`[ydesk] ${message}\n`)
}

// Only one screen-capture process may own the display at a time: macOS
// AVFoundation refuses a second concurrent screen input, and Windows leaves
// the second one silent. Keep a module-level owner so a re-created Capture
// always tears the previous one down first.
let ACTIVE = null
import net from 'node:net'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { Fragmenter } from './muxer.js'

const isMac = process.platform === 'darwin'
const isWin = process.platform === 'win32'

// --- macOS ScreenCaptureKit helper -------------------------------------------
// AVCaptureScreenInput (what ffmpeg uses for `-f avfoundation`) opens the screen
// device but can then deliver zero frames on recent macOS releases. ScreenCaptureKit
// is the supported path, so we compile a tiny helper once and pipe its raw BGRA
// frames into ffmpeg, which keeps doing the H.264/fMP4 work.
const SCK_SOURCE = path.join(path.dirname(new URL(import.meta.url).pathname), 'sck-capture.swift')

function sckBinaryPath() {
  const stamp = (() => {
    try { return String(Math.round(fs.statSync(SCK_SOURCE).mtimeMs)) } catch { return '0' }
  })()
  const dir = path.join(os.tmpdir(), 'dsh-ydesk-tools')
  try { fs.mkdirSync(dir, { recursive: true }) } catch {}
  return path.join(dir, `sck-capture-${stamp}`)
}

function ensureSckHelperSync() {
  const bin = sckBinaryPath()
  if (fs.existsSync(bin)) return bin
  if (!fs.existsSync(SCK_SOURCE)) return null
  const swiftc = ['/usr/bin/swiftc', '/usr/local/bin/swiftc'].find((p) => {
    try { fs.accessSync(p, fs.constants.X_OK); return true } catch { return false }
  })
  if (!swiftc) return null
  const run = spawnSync(swiftc, ['-O', '-o', bin, SCK_SOURCE], { encoding: 'utf8', timeout: 120000 })
  if (run.status !== 0 || !fs.existsSync(bin)) {
    console.error('[ydesk] sck helper build failed:', (run.stderr || '').split('\n')[0])
    return null
  }
  return bin
}

function probeScreenSize(helper) {
  const run = spawnSync(helper, ['--probe'], { encoding: 'utf8', timeout: 15000 })
  const m = /^(\d+)\s+(\d+)/.exec((run.stdout || '').trim())
  if (!m) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

function onPath(name) {
  const dirs = (process.env.PATH || '').split(path.delimiter).filter(Boolean)
  const names = isWin ? [name, `${name}.exe`, `${name}.cmd`, `${name}.bat`] : [name]
  for (const dir of dirs) {
    for (const candidate of names) {
      const full = path.join(dir, candidate)
      try {
        if (fs.statSync(full).isFile()) return full
      } catch {}
    }
  }
  return null
}

export function resolveFfmpeg(configured) {
  const candidates = []
  if (configured) candidates.push(configured)
  if (process.env.YDESK_FFMPEG) candidates.push(process.env.YDESK_FFMPEG)
  if (isMac) candidates.push('/opt/homebrew/bin/ffmpeg', '/usr/local/bin/ffmpeg')
  if (isWin) {
    candidates.push(
      'ffmpeg',
      'C:\\ProgramData\\chocolatey\\bin\\ffmpeg.exe',
      'C:\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Users\\Public\\ffmpeg\\bin\\ffmpeg.exe',
      'C:\\Users\\cyx\\Documents\\repository_git\\xiaomusic\\ffmpeg\\bin\\ffmpeg.exe',
    )
  } else if (!isMac) {
    candidates.push('ffmpeg', '/usr/bin/ffmpeg')
  }
  for (const c of candidates) {
    if (!c) continue
    if (path.isAbsolute(c)) {
      try {
        if (fs.statSync(c).isFile()) return c
      } catch {}
      continue
    }
    // A bare name has to be resolved against PATH: a scheduled task inherits a
    // different environment than the Harness, so "ffmpeg" alone often fails.
    const found = onPath(c)
    if (found) return found
  }
  return candidates.find((c) => c && path.isAbsolute(c)) || 'ffmpeg'
}

function findMacScreenDevice(ffmpeg, callback) {
  const child = spawn(ffmpeg, ['-hide_banner', '-f', 'avfoundation', '-list_devices', 'true', '-i', ''], {
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  let text = ''
  const collect = (d) => { text += d.toString('utf8') }
  child.stdout.on('data', collect)
  child.stderr.on('data', collect)
  const done = () => {
    const lines = text.split('\n')
    const screens = []
    for (const line of lines) {
      const m = line.match(/\[(\d+)\]\s+Capture screen/)
      if (m) screens.push(m[1])
    }
    callback(screens.length ? screens[0] : '2')
  }
  child.on('error', () => callback('2'))
  child.on('close', done)
  setTimeout(() => { try { child.kill('SIGKILL') } catch {} }, 2500)
}

function parseScale(scale) {
  if (!scale) return null
  const m = /^(\d+):(\d+)$/.exec(String(scale).trim())
  if (!m) return null
  return { width: Number(m[1]), height: Number(m[2]) }
}

const QUALITY_PRESETS = {
  smooth: { fps: 30, bitrate: '2M', scale: '1280:720' },
  balanced: { fps: 30, bitrate: '4M', scale: '1600:900' },
  sharp: { fps: 30, bitrate: '6M', scale: '1920:1080' },
  original: { fps: 30, bitrate: '8M', scale: '' },
}

export class Capture {
  constructor(options = {}) {
    this.ffmpeg = resolveFfmpeg(options.ffmpeg)
    this.display = options.display || process.env.YDESK_DISPLAY || ''
    const preset = QUALITY_PRESETS[options.quality] || QUALITY_PRESETS.balanced
    this.fps = Number(options.fps) || preset.fps
    this.bitrate = options.bitrate || preset.bitrate
    this.scale = options.scale !== undefined ? options.scale : preset.scale
    this.listeners = { init: [], fragment: [], au: [], status: [] }
    this.init = null
    this.codec = 'video/mp4; codecs="avc1.42E01E"'
    this.ring = []
    this.ringBytes = 0
    this.child = null
    this.tcpServer = null
    this.lastKey = null
    this.frames = 0
    this.startedAt = 0
    this.running = false
    this.error = ''
    this.restartDelay = 500
    this.stopping = false
    this.started = false
    this.spawning = false
    this.restarts = 0
    this.spawns = 0
  }

  on(event, fn) {
    if (!this.listeners[event]) this.listeners[event] = []
    this.listeners[event].push(fn)
  }

  emit(event, value) {
    for (const fn of this.listeners[event] || []) {
      try { fn(value) } catch (err) { console.error('[ydesk] capture listener failed:', err) }
    }
  }

  status() {
    return {
      running: this.running,
      fps: this.fps,
      bitrate: this.bitrate,
      scale: this.scale,
      codec: this.codec,
      frames: this.frames,
      aus: this.auCount || 0,
      uptime: this.startedAt ? Math.round((Date.now() - this.startedAt) / 1000) : 0,
      // A working interactive-session tail supersedes the failed attempt in
      // session 0; do not keep reporting that stale error.
      error: this.scheduled && this.running ? '' : this.error,
      source: this.scheduled ? 'session' : 'process',
      ffmpeg: this.ffmpeg,
      spawns: this.spawns,
      taskName: this.taskName || '',
      listening: Boolean(this.scheduledServer),
      pid: this.child ? this.child.pid : 0,
    }
  }

  inputArgs(display) {
    if (isMac) {
      return [
        '-f', 'avfoundation',
        '-capture_cursor', '1',
        '-pix_fmt', 'uyvy422',
        '-framerate', String(Math.min(this.fps * 2, 60)),
        '-i', `${display}:none`,
      ]
    }
    if (isWin) {
      return ['-f', 'gdigrab', '-draw_mouse', '1', '-framerate', String(this.fps), '-i', 'desktop']
    }
    return ['-f', 'x11grab', '-draw_mouse', '1', '-framerate', String(this.fps), '-i', process.env.DISPLAY || ':0']
  }

  args(display, output) {
    const filters = []
    if (isMac && !this.rawInput) filters.push(`fps=${this.fps}`)
    // With the ScreenCaptureKit helper the GPU already delivered the final
    // size, so a software scale here would only burn CPU.
    if (!this.rawInput && this.scale) filters.push(`scale=${this.scale}:flags=fast_bilinear`)
    const out = [
      '-hide_banner', '-loglevel', 'error', '-nostdin',
      ...(this.rawInput
        ? ['-f', 'rawvideo', '-pixel_format', 'nv12',
           '-video_size', `${this.rawInput.width}x${this.rawInput.height}`,
           '-framerate', String(this.rawInput.fps || this.fps), '-i', 'pipe:0']
        : this.inputArgs(display)),
      '-an',
      ...(filters.length ? ['-vf', filters.join(',')] : []),
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-tune', 'zerolatency',
      '-profile:v', 'baseline',
      '-pix_fmt', 'yuv420p',
      '-x264-params', `aud=1:keyint=${this.fps * 2}:min-keyint=${this.fps * 2}:scenecut=0:repeat-headers=1:sync-lookahead=0:rc-lookahead=0`,
      '-b:v', this.bitrate,
      '-maxrate', this.bitrate,
      '-bufsize', '1M',
      '-flush_packets', '1',
      '-f', 'h264',
      output,
    ]
    return out
  }

  async start() {
    if (this.running || this.spawning) return
    if (ACTIVE && ACTIVE !== this) {
      try { ACTIVE.stop() } catch {}
      // Give the OS a moment to release the capture device.
      await new Promise((resolve) => setTimeout(resolve, 350))
    }
    ACTIVE = this
    this.spawning = true
    this.stopping = false
    this.started = true
    this.startedAt = Date.now()
    this.frames = 0
    this.error = ''
    if (isMac) {
      const started = await this._startMac()
      if (started) return
    }
    let display = this.display
    if (isMac && !display) {
      display = await new Promise((resolve) => findMacScreenDevice(this.ffmpeg, resolve))
      this.display = display
    }
    this._spawnDirect(display || '2')
  }

  _handleEvents(events) {
    for (const ev of events) {
      if (ev.type === 'init') {
        this.init = ev.data
        this.codec = codecString(ev.data) || this.codec
        this.ring = []
        this.ringBytes = 0
        this.auRing = []
        this.emit('init', { data: ev.data, codec: this.codec })
        continue
      }
      if (ev.type === 'fragment') {
        this.frames += 1
        if (this.frames % 60 === 0) {
          const now = Date.now()
          const dt = (now - (this._rateAt || now)) / 1000
          this._rateAt = now
          if (dt > 0) logLine(`fragment rate ${(60 / dt).toFixed(1)} fps`)
        }
        this.running = true
        this.spawning = false
        this.restarts = 0
        this.restartDelay = 500
        if (ev.key) this.lastKey = ev.data
        this.ring.push({ data: ev.data, key: !!ev.key })
        this.ringBytes += ev.data.length
        while (this.ring.length > 240 || this.ringBytes > 6 * 1024 * 1024) {
          const dropped = this.ring.shift()
          this.ringBytes -= dropped.data.length
        }
        this.emit('fragment', { data: ev.data, key: !!ev.key })
      }
    }
  }

  /** Keep a short Annex-B ring so a WebCodecs viewer can start on a keyframe. */
  _emitAU(au) {
    this.auCount = (this.auCount || 0) + 1
    let key = false
    for (let i = 0; i + 3 < au.length; i++) {
      if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
        const type = au[i + 3] & 0x1f
        if (type === 5) {
          key = true
          break
        }
        i += 2
      }
    }
    if (!this.auRing) this.auRing = []
    this.auRing.push({ data: au, key })
    let bytes = 0
    for (const item of this.auRing) bytes += item.data.length
    while (this.auRing.length > 240 || bytes > 6 * 1024 * 1024) {
      const dropped = this.auRing.shift()
      bytes -= dropped.data.length
    }
    this.emit('au', { data: au, key })
  }

  snapshotAUs() {
    if (!this.auRing || !this.auRing.length) return null
    let start = 0
    for (let i = this.auRing.length - 1; i >= 0; i--) {
      if (this.auRing[i].key) {
        start = i
        break
      }
    }
    return this.auRing.slice(start).map((item) => item.data)
  }

  _attachStream(stream, onFail) {
    const splitter = new Fragmenter({ width: (this.rawInput && this.rawInput.width) || 0, height: (this.rawInput && this.rawInput.height) || 0, fps: this.fps })
    splitter.onAU = (au) => this._emitAU(au)
    let got = 0
    let failed = false
    const failTimer = setTimeout(() => {
      if (got === 0) {
        failed = true
        if (onFail) onFail()
      }
    }, 6000)
    stream.on('data', (chunk) => {
      got += chunk.length
      if (got > 0) clearTimeout(failTimer)
      this._handleEvents(splitter.push(chunk))
    })
    stream.on('error', (err) => {
      if (!failed) this.error = String(err.message || err)
    })
    return { splitter, stats: () => got }
  }

  /** macOS: ScreenCaptureKit helper -> raw BGRA -> ffmpeg -> fMP4. */
  async _startMac() {
    const helper = ensureSckHelperSync()
    if (!helper) return false
    const size = probeScreenSize(helper)
    if (!size) {
      this.error = 'sck helper could not probe the display'
      this.emit('status', this.status())
      return false
    }
    const target = parseScale(this.scale)
    const width = target && target.width < size.width ? target.width : size.width
    const height = target && target.height < size.height ? target.height : size.height
    this.rawInput = {
      width,
      height,
      fps: this.fps,
      native: width === size.width && height === size.height,
    }
    this.helper = helper
    this._spawnDirect(this.display || '2')
    return true
  }

  _spawnDirect(display) {
    if (this.child) return
    this.spawning = true
    const args = this.args(display, 'pipe:1')
    let child
    try {
      child = spawn(this.ffmpeg, args, { stdio: [this.rawInput ? 'pipe' : 'ignore', 'pipe', 'pipe'] })
    } catch (err) {
      this.error = `cannot start ffmpeg: ${err.message}`
      this.emit('status', this.status())
      return
    }
    this.child = child
    this.spawns += 1
    console.log('[ydesk] capture spawn', this.spawns, 'pid', child.pid, this.rawInput ? `raw ${this.rawInput.width}x${this.rawInput.height}` : '')
    if (this.rawInput && this.helper) {
      const width = this.rawInput.native ? '0' : String(this.rawInput.width)
      const height = this.rawInput.native ? '0' : String(this.rawInput.height)
      const helper = spawn(
        this.helper,
        ['--fps', String(this.fps), '--cursor', '1', '--width', width, '--height', height],
        { stdio: ['ignore', 'pipe', 'pipe'] },
      )
      this.helperChild = helper
      helper.stdout.pipe(child.stdin)
      helper.stderr.on('data', (d) => {
        const text = d.toString('utf8').trim()
        if (text && !/^READY$/.test(text)) console.error('[ydesk] sck:', text.split('\n')[0])
      })
      helper.on('close', () => {
        try { child.stdin.end() } catch {}
        try { child.kill('SIGKILL') } catch {}
      })
    }
    let stderr = ''
    child.stderr.on('data', (d) => {
      stderr = (stderr + d.toString('utf8')).slice(-4000)
    })
    this._attachStream(child.stdout, () => {
      // Direct capture produced nothing: on Windows this is the classic
      // "session 0 has no desktop" case; retry inside the interactive session.
      if (isWin) {
        this.error = stderr.trim().split('\n').pop() || 'no video from gdigrab'
        this.scheduled = true
        try { child.kill('SIGKILL') } catch {}
        this._spawnScheduled(display)
      }
    })
    child.on('error', (err) => {
      this.error = `ffmpeg failed: ${err.message}`
      this.running = false
      this.emit('status', this.status())
    })
    child.on('close', (code) => {
      this.running = false
      this.child = null
      this.spawning = false
      if (this.stopping) return
      // The interactive-session capture owns the screen now; the session-0
      // attempt must not keep respawning alongside it.
      if (this.scheduled) return
      if (!this.error && code) this.error = `ffmpeg exited with code ${code}: ${stderr.trim().split('\n').pop() || ''}`
      this.emit('status', this.status())
      this.restarts += 1
      if (this.restarts > 5) {
        this.running = false
        if (!this.error) this.error = 'capture stopped after repeated failures'
        this.emit('status', this.status())
        return
      }
      const delay = this.restartDelay
      this.restartDelay = Math.min(this.restartDelay * 2, 5000)
      setTimeout(() => { if (!this.stopping && !this.child) this._spawnDirect(display) }, delay)
    })
  }

  // Windows fallback: the Harness can run in session 0, where gdigrab has no
  // desktop. Start ffmpeg from a scheduled task in the interactive session and
  // tail the fragmented MP4 it appends, because fragmented MP4 is append-only.
  _spawnScheduled(display) {
    if (this.stopping) return
    if (!this.taskName) this.taskName = `dsh-ydesk-capture-${process.pid}-${Date.now().toString(36)}`
    if (this.scheduledServer) return
    const id = `${process.pid}-${Date.now()}`
    const base = isWin && process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'ydesk') : os.tmpdir()
    const tmp = path.join(base, `capture-${id}`)
    try {
      fs.mkdirSync(tmp, { recursive: true })
    } catch {}
    const bat = path.join(tmp, 'capture.cmd')
    const logPath = path.join(tmp, 'ffmpeg.err')
    const task = this.taskName
    const port = 9200 + Math.floor(Math.random() * 600)
    this.scheduledDir = tmp
    this.scheduledLog = logPath

    // Endpoint protection denies ffmpeg direct file creation on some hosts and
    // %TEMP% may reject writes from the interactive session, so the encoder
    // pushes fragmented MP4 over a loopback socket instead.
    const args = this.args(display, `tcp://127.0.0.1:${port}`)
    const line = [this.ffmpeg, ...args].map((a) => (a.includes(' ') ? `"${a}"` : a)).join(' ')
    fs.writeFileSync(bat, `@echo off\r\ncd /d "%~dp0"\r\n${line} 2> "${logPath}"\r\n`, 'utf8')

    const splitter = new Fragmenter({ width: (this.rawInput && this.rawInput.width) || 0, height: (this.rawInput && this.rawInput.height) || 0, fps: this.fps })
    splitter.onAU = (au) => this._emitAU(au)
    const server = net.createServer((socket) => {
      logLine(`scheduled connected on ${port}`)
      socket.setNoDelay(true)
      this.running = true
      this.error = ''
      this.restarts = 0
      this.emit('status', this.status())
      socket.on('data', (chunk) => {
        try {
          this._handleEvents(splitter.push(chunk))
        } catch (err) {
          this.error = `capture stream failed: ${err.message}`
        }
      })
      socket.on('error', () => {})
      socket.on('close', () => {
        logLine(`scheduled socket closed (${this.frames} frames)`)
        this.running = false
        if (!this.stopping) {
          this.restartTimer = setTimeout(() => {
            this.scheduledServer = null
            try { server.close() } catch {}
            this._spawnScheduled(display)
          }, 900)
        }
      })
    })
    this.scheduledServer = server
    server.on('error', (err) => {
      this.error = `capture socket failed: ${err.message}`
    })
    server.listen(port, '127.0.0.1', () => {
      const run1 = (argv) => {
        try {
          const r = spawnSync('schtasks', argv, { encoding: 'utf8', windowsHide: true, timeout: 15000 })
          if (r.status !== 0) {
            logLine(`scheduled ${argv[0]} -> ${r.status} ${(r.stderr || r.stdout || '').trim().slice(0, 160)}`)
          }
          return r
        } catch (err) {
          logLine(`scheduled ${argv[0]} failed: ${err.message}`)
          return null
        }
      }
      const user = process.env.USERNAME || ''
      // Stale encoders keep the desktop and drag the frame rate down: kill the
      // ones that belong to dsh-ydesk before starting a fresh session.
      try {
        spawnSync('cmd.exe', ['/c', 'wmic process where "name=\'ffmpeg.exe\' and commandline like \'%ydesk%\'" call terminate >nul 2>&1'], {
          windowsHide: true,
          timeout: 10000,
        })
      } catch {}
      run1(['/end', '/tn', task])
      run1(['/delete', '/tn', task, '/f'])
      const created = run1([
        '/create', '/tn', task, '/tr', bat, '/sc', 'once', '/st', '23:59', '/ru', user, '/it', '/rl', 'HIGHEST', '/f',
      ])
      if (created && created.status !== 0) {
        this.error = 'scheduled task could not be created'
        return
      }
      const started = run1(['/run', '/tn', task])
      logLine(`scheduled run ${task} -> ${started && started.status}`)
      this.scheduledTask = task
    })
  }

  snapshotForNewViewer() {
    if (!this.init) return null
    const parts = [this.init]
    let started = false
    for (const item of this.ring) {
      if (!started) {
        if (!item.key) continue
        started = true
      }
      parts.push(item.data)
    }
    if (!started) return { init: this.init, fragments: [] }
    return { init: this.init, fragments: parts.slice(1) }
  }

  stop() {
    this.stopping = true
    this.stopping = true
    if (ACTIVE === this) ACTIVE = null
    this.running = false
    this.spawning = false
    clearTimeout(this.restartTimer)
    try { this.helperChild && this.helperChild.kill('SIGTERM') } catch {}
    this.helperChild = null
    try { this.child && this.child.kill('SIGKILL') } catch {}
    clearInterval(this.tailTimer)
    if (this.scheduledTask) {
      try { spawn('schtasks', ['/end', '/tn', this.scheduledTask], { stdio: 'ignore', windowsHide: true }) } catch {}
      this.scheduledTask = null
    }
    this.child = null
    this.ring = []
    this.ringBytes = 0
    this.init = null
  }
}

// Derive the MSE codec string from the avcC box inside the init segment.
function codecString(init) {
  for (let off = 0; off + 8 <= init.length; ) {
    const size = init.readUInt32BE(off)
    const type = init.toString('latin1', off + 4, off + 8)
    if (size < 8) break
    if (type === 'moov') {
      const codec = findAvcC(init, off + 8, off + size)
      if (codec) return codec
      break
    }
    off += size
  }
  return ''
}

function findAvcC(buf, start, end) {
  for (let off = start; off + 8 <= end; ) {
    const size = buf.readUInt32BE(off)
    const type = buf.toString('latin1', off + 4, off + 8)
    if (size < 8 || off + size > end) return ''
    if (type === 'avcC') {
      const p = off + 8
      const profile = buf[p + 1]
      const compat = buf[p + 2]
      const level = buf[p + 3]
      const hex = (n) => n.toString(16).padStart(2, '0')
      return `video/mp4; codecs="avc1.${hex(profile)}${hex(compat)}${hex(level)}"`
    }
    if (type === 'trak' || type === 'mdia' || type === 'minf' || type === 'stbl' || type === 'mvex') {
      const nested = findAvcC(buf, off + 8, off + size)
      if (nested) return nested
    }
    off += size
  }
  return ''
}
