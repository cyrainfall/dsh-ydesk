/**
 * dsh-ydesk — Host half.
 *
 * Turns this Harness into a remotely controllable machine and lets the same
 * window drive another machine that runs the plugin:
 *
 *   browser ──/ydesk/ws──▶ this Host ──ws://peer:8895/stream──▶ peer Host
 *
 * The browser never leaves its own origin, so the panel keeps the Harness
 * session, theme and authentication. Peers are found by UDP probe on the local
 * network (lib/discovery.js) or dialled by host:port.
 */
import http from 'node:http'
import { spawnSync } from 'node:child_process'
import os from 'node:os'
import fs from 'node:fs'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import crypto from 'node:crypto'
import { Capture } from './lib/capture.js'
import { Injector } from './lib/input.js'
import { Discovery, probePeers } from './lib/discovery.js'
import { upgrade } from './lib/ws.js'

const PLATFORM = process.platform === 'darwin' ? 'macos' : process.platform === 'win32' ? 'windows' : process.platform
const VERSION = '0.1.0'

function log(...args) {
  console.log('[ydesk]', ...args)
}

function normalizeConfig(config = {}) {
  return {
    port: Number(config.port) || 8895,
    fps: Number(config.fps) || 60,
    bitrate: typeof config.bitrate === 'string' && config.bitrate ? config.bitrate : '6M',
    quality: typeof config.quality === 'string' && config.quality ? config.quality : 'sharp',
    scale: typeof config.scale === 'string' ? config.scale : undefined,
    display: typeof config.display === 'string' ? config.display : '',
    pin: typeof config.pin === 'string' ? config.pin.trim() : '',
    allowLan: config.allowLan !== false,
  }
}

function newPin() {
  return String(Math.floor(100000 + Math.random() * 900000))
}

/** The stream key a viewer must present: derived from the PIN, never sent as-is. */
function pairKey(pin, name) {
  return crypto.createHash('sha256').update(`${pin}:${name}:ydesk`).digest('hex').slice(0, 32)
}

/** Settings the panel changes survive a restart, so a beginner never has to
 * re-pick quality or re-share an old PIN. */
const STATE_DIR = path.join(os.homedir(), '.dsh-ydesk')
const STATE_FILE = path.join(STATE_DIR, 'settings.json')

function loadSaved() {
  try {
    const raw = fs.readFileSync(STATE_FILE, 'utf8')
    const parsed = JSON.parse(raw)
    return parsed && typeof parsed === 'object' ? parsed : {}
  } catch {
    return {}
  }
}

function saveSettings(settings, pin) {
  const payload = {
    quality: settings.quality,
    fps: settings.fps,
    bitrate: settings.bitrate,
    pin,
  }
  try {
    fs.mkdirSync(STATE_DIR, { recursive: true })
    fs.writeFileSync(STATE_FILE, `${JSON.stringify(payload, null, 2)}\n`)
  } catch (err) {
    log('cannot persist settings:', err && err.message)
  }
}

function readJsonBody(req, limit = 65536) {
  return new Promise((resolve) => {
    let size = 0
    const chunks = []
    req.on('data', (c) => {
      size += c.length
      if (size > limit) {
        req.destroy()
        resolve(null)
        return
      }
      chunks.push(c)
    })
    req.on('end', () => {
      if (!chunks.length) return resolve({})
      try {
        resolve(JSON.parse(Buffer.concat(chunks).toString('utf8')))
      } catch {
        resolve(null)
      }
    })
    req.on('error', () => resolve(null))
  })
}

function sendJson(res, status, value) {
  const body = Buffer.from(JSON.stringify(value))
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(body.length),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function hostName() {
  return os.hostname().replace(/\.local$/i, '')
}

/** A uniformly shaped channel over one WebSocket connection. */
function channelOf(conn) {
  return {
    raw: conn,
    send: (data) => conn.send(data),
    close: () => conn.close(1000, 'bye'),
  }
}

/**
 * Pump one capture into one channel: codec header first, then fragments,
 * starting from the last keyframe so a late viewer paints immediately.
 */
function pumpCapture(bus, getCapture, channel) {
  let closed = false
  let initSent = false
  const sendInit = (init, codec) => {
    if (closed || initSent || !init) return
    initSent = true
    channel.send(JSON.stringify({ t: 'codec', codec }))
    channel.send(init)
  }
  const onInit = (ev) => sendInit(ev.data, ev.codec)
  const onFragment = (ev) => {
    if (closed) return
    const src = getCapture()
    if (!initSent) {
      if (src) sendInit(src.init, src.codec)
      if (!initSent) return // header not ready yet: the snapshot below covered it
    }
    channel.send(ev.data)
  }
  bus.on('init', onInit)
  bus.on('fragment', onFragment)
  const src = getCapture()
  const snapshot = src && src.snapshotForNewViewer ? src.snapshotForNewViewer() : null
  if (snapshot) {
    sendInit(snapshot.init, src.codec)
    for (const fragment of snapshot.fragments) channel.send(fragment)
  }
  return () => {
    closed = true
    bus.off('init', onInit)
    bus.off('fragment', onFragment)
  }
}

/**
 * Annex-B pump for viewers that decode with WebCodecs: no container and no
 * media-element playback clock, so each frame is painted the moment it is
 * decoded. The wire format is one binary frame per access unit with a 0x02 tag.
 */
function pumpAvc(bus, getCapture, channel) {
  let closed = false
  let started = false
  const sendAU = (au) => {
    if (closed || !au || !au.length) return
    const body = Buffer.isBuffer(au) ? au : Buffer.from(au)
    channel.send(Buffer.concat([Buffer.from([0x02]), body]))
  }
  const start = () => {
    if (started || closed) return
    started = true
    channel.send(JSON.stringify({ t: 'codec', codec: 'avc1.42E01E', mode: 'avc' }))
    const src = getCapture()
    const snapshot = src && src.snapshotAUs ? src.snapshotAUs() : null
    if (snapshot) for (const au of snapshot) sendAU(au)
  }
  const onAU = (ev) => {
    if (!started) start()
    sendAU(ev.data)
  }
  bus.on('au', onAU)
  start()
  return () => {
    closed = true
    bus.off('au', onAU)
  }
}

/**
 * One outbound connection to a peer's /stream endpoint. Keeps the latest init
 * segment and GOP so a viewer that attaches late still paints at once.
 */
class RemoteView {
  constructor({ host, port, key, name }) {
    this.host = host
    this.port = port
    this.key = key
    this.name = name
    this.init = null
    this.codec = 'video/mp4; codecs="avc1.42E01E"'
    this.ring = []
    this.ringBytes = 0
    this.viewers = new Set()
    this.ws = null
    this.error = ''
    this.connected = false
  }

  connect() {
    if (this.ws) return
    const url = `ws://${this.host}:${this.port}/stream?key=${encodeURIComponent(this.key)}`
    const ws = new WebSocket(url)
    ws.binaryType = 'arraybuffer'
    this.ws = ws
    ws.addEventListener('open', () => {
      this.connected = true
      this.error = ''
      log('remote connected', this.host, this.port)
      this._broadcast(JSON.stringify({ t: 'remote', state: 'connected', name: this.name }))
    })
    ws.addEventListener('message', (ev) => {
      if (typeof ev.data === 'string') {
        this._broadcast(ev.data)
        return
      }
      const buf = Buffer.from(ev.data)
      if (this.mode === 'avc') {
        // Annex-B access units: no container header or GOP cache to track.
        this._broadcast(buf)
        return
      }
      if (!this.init) {
        this.init = buf
        this.ring = []
        this.ringBytes = 0
      } else {
        this.ring.push(buf)
        this.ringBytes += buf.length
        while (this.ring.length > 240 || this.ringBytes > 6 * 1024 * 1024) {
          this.ringBytes -= this.ring.shift().length
        }
      }
      this._broadcast(buf)
    })
    const dropped = (why) => {
      this.connected = false
      this.ws = null
      this.error = why
      this.init = null
      this.ring = []
      this._broadcast(JSON.stringify({ t: 'remote', state: 'closed', error: why }))
      // Reconnect while viewers remain, so a network blip heals by itself.
      if (this.viewers.size && !this.closing) {
        this.retry = setTimeout(() => this.connect(), 1200)
      }
    }
    ws.addEventListener('close', () => dropped(this.error || 'peer closed the stream'))
    ws.addEventListener('error', () => dropped('cannot reach the peer'))
  }

  _broadcast(payload) {
    for (const viewer of this.viewers) {
      try {
        viewer.send(payload)
      } catch {
        // The viewer's own close handler removes it.
      }
    }
  }

  attach(channel) {
    this.viewers.add(channel)
    channel.send(JSON.stringify({ t: 'remote', state: this.connected ? 'connected' : 'connecting', name: this.name }))
    if (this.init && this.mode !== 'avc') {
      channel.send(JSON.stringify({ t: 'codec', codec: this.codec }))
      channel.send(this.init)
      for (const fragment of this.ring) channel.send(fragment)
    }
    this.connect()
    return () => {
      this.viewers.delete(channel)
    }
  }

  setMode(mode) {
    this.mode = mode
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return
    try {
      ws.send(JSON.stringify({ t: 'mode', mode }))
    } catch {}
  }

  sendInput(text) {
    const ws = this.ws
    if (!ws || ws.readyState !== 1) return
    try {
      ws.send(text)
    } catch {
      // A closed socket is reported by the close handler.
    }
  }

  close() {
    this.closing = true
    clearTimeout(this.retry)
    this.viewers.clear()
    try {
      this.ws && this.ws.close()
    } catch {
      // Already gone.
    }
    this.ws = null
    this.connected = false
  }

  status() {
    return { host: this.host, port: this.port, name: this.name, connected: this.connected, error: this.error }
  }
}

export const inject = ['webServer']

export function apply(ctx, config = {}) {
  const opts = normalizeConfig(config)
  const name = hostName()
  const saved = loadSaved()
  let pin = opts.pin || (typeof saved.pin === 'string' && /^\d{4,8}$/.test(saved.pin) ? saved.pin : newPin())
  const settings = {
    quality: typeof saved.quality === 'string' && saved.quality ? saved.quality : opts.quality,
    fps: Number(saved.fps) || opts.fps,
    bitrate: typeof saved.bitrate === 'string' && saved.bitrate ? saved.bitrate : opts.bitrate,
    scale: opts.scale,
  }
  const disposers = []

  let capture = null
  // Pumps subscribe here instead of to a Capture instance: the instance is
  // recreated on config changes and releases, which would orphan the listeners.
  const captureBus = new EventEmitter()
  captureBus.setMaxListeners(64)
  function bindCapture(src) {
    src.on('init', (ev) => captureBus.emit('init', ev))
    src.on('fragment', (ev) => captureBus.emit('fragment', ev))
    src.on('au', (ev) => captureBus.emit('au', ev))
  }
  let captureStopTimer = null
  const inputStats = { count: 0, types: {}, last: null, errors: [] }
  let injector = null
  let remote = null
  let peerServer = null
  const localViewers = new Set()

  function hostInfo() {
    return {
      name,
      platform: PLATFORM,
      port: opts.port,
      version: VERSION,
      pinRequired: true,
      app: 'dsh-ydesk',
    }
  }

  function ensureCapture() {
    if (captureStopTimer) {
      clearTimeout(captureStopTimer)
      captureStopTimer = null
    }
    if (capture) return capture
    capture = new Capture({
      quality: settings.quality,
      fps: settings.fps,
      bitrate: settings.bitrate,
      scale: settings.scale,
      display: opts.display,
    })
    bindCapture(capture)
    capture.on('status', (status) => {
      if (status.error) log('capture:', status.error)
    })
    capture.start().catch((err) => log('capture start failed:', err && err.message))
    return capture
  }

  function ensureInjector() {
    if (injector) return injector
    injector = new Injector()
    injector.start()
    return injector
  }

  function releaseCaptureSoon(reason) {
    if (captureStopTimer) return
    captureStopTimer = setTimeout(() => {
      captureStopTimer = null
      // A viewer may have re-attached while we waited.
      if (localViewers.size || peerViewers.size) return
      if (capture) {
        log('capture released:', reason)
        capture.stop()
        capture = null
      }
      if (injector) {
        injector.stop()
        injector = null
      }
    }, 2000)
  }

  function restartCapture() {
    const old = capture
    capture = null
    if (old) old.stop()
    // Peer viewers pull through their own capture instance, so restart when any
    // viewer remains, not only local ones.
    setTimeout(() => {
      if (localViewers.size || peerViewers.size) ensureCapture()
    }, 400)
  }

  function tailnetBinary() {
    const candidates = PLATFORM === 'macos'
      ? ['/Applications/Tailscale.app/Contents/MacOS/Tailscale', '/opt/homebrew/bin/tailscale']
      : ['C:\\Program Files\\Tailscale\\tailscale.exe', 'tailscale.exe']
    for (const candidate of candidates) {
      try {
        if (fs.existsSync(candidate)) return candidate
      } catch {
        // keep looking
      }
    }
    return 'tailscale'
  }

  /** Online tailnet machines, so a peer is one click away even off-LAN. */
  function tailnetHosts() {
    let raw = ''
    try {
      const out = spawnSync(tailnetBinary(), ['status', '--json'], { encoding: 'utf8', timeout: 4000 })
      raw = out.stdout || ''
    } catch {
      return []
    }
    if (!raw) return []
    let data
    try {
      data = JSON.parse(raw)
    } catch {
      return []
    }
    const hosts = []
    for (const peer of Object.values(data.Peer || {})) {
      if (!peer || !peer.Online) continue
      const ips = Array.isArray(peer.TailscaleIPs) ? peer.TailscaleIPs : []
      const ip = ips.find((value) => /^100\./.test(String(value))) || ips[0]
      if (!ip) continue
      hosts.push({ ip: String(ip), name: peer.HostName || String(ip), os: peer.OS || '' })
    }
    return hosts
  }

  async function probeTailnet() {
    const hosts = tailnetHosts()
    if (hosts.length === 0) return []
    const results = await Promise.all(hosts.map(async (host) => {
      try {
        const res = await fetch(`http://${host.ip}:8895/info`, { signal: AbortSignal.timeout(900) })
        const info = await res.json()
        if (info && info.app === 'dsh-ydesk') {
          return { name: info.name || host.name, address: host.ip, port: info.port || 8895, platform: info.platform || host.os, source: 'tailnet' }
        }
      } catch {
        // Not every tailnet machine runs the plugin.
      }
      return null
    }))
    return results.filter(Boolean)
  }

  function applyInput(kind, msg) {
    try {
      inputStats.count += 1
      const key = String(msg && msg.t)
      inputStats.types[key] = (inputStats.types[key] || 0) + 1
      inputStats.last = { kind, t: key, at: Date.now() }
    } catch {}
    const input = ensureInjector()
    if (kind === 'local') {
      const inj = input
      switch (msg.t) {
        case 'm':
          inj.move(Number(msg.nx), Number(msg.ny))
          break
        case 'md':
          inj.button(Number(msg.b) || 1, true)
          break
        case 'mu':
          inj.button(Number(msg.b) || 1, false)
          break
        case 'w':
          inj.wheel(Number(msg.d) || 0, 0)
          break
        case 'kd':
          inj.key(String(msg.code), true)
          break
        case 'ku':
          inj.key(String(msg.code), false)
          break
        case 'txt':
          inj.text(String(msg.v || ''))
          break
        default:
          break
      }
      return
    }
    if (remote) remote.sendInput(JSON.stringify(msg))
  }

  /** Attach a browser-like channel whose input goes to this machine. */
  function attachLocal(channel) {
    localViewers.add(channel)
    channel.send(JSON.stringify({ t: 'hello', mode: 'local', host: hostInfo(), fps: settings.fps, codec: 'video/mp4; codecs="avc1.42E01E"' }))
    const source = ensureCapture()
    let stopPump = pumpCapture(captureBus, () => capture, channel)
    if (source.init) channel.send(JSON.stringify({ t: 'codec', codec: source.codec }))
    channel.setMode = (mode) => {
      if (mode !== 'avc') return
      stopPump()
      stopPump = pumpAvc(captureBus, () => capture, channel)
    }
    return () => {
      stopPump()
      localViewers.delete(channel)
      if (!localViewers.size && !peerViewers.size) releaseCaptureSoon('no viewers')
    }
  }

  /** Peer-facing stream: another machine's Host is watching this screen. */
  const peerViewers = new Set()
  function attachPeer(channel) {
    peerViewers.add(channel)
    channel.send(JSON.stringify({ t: 'hello', mode: 'peer', host: hostInfo(), fps: settings.fps, codec: 'video/mp4; codecs="avc1.42E01E"' }))
    const source = ensureCapture()
    let stopPump = () => {}
    let started = false
    const startMse = () => {
      if (started || mode) return
      started = true
      stopPump = pumpCapture(captureBus, () => capture, channel)
      if (source.init) channel.send(JSON.stringify({ t: 'codec', codec: source.codec }))
    }
    let mode = null
    const modeTimer = setTimeout(startMse, 400)
    channel.setMode = (next) => {
      if (next !== 'avc' || mode === 'avc') return
      mode = 'avc'
      clearTimeout(modeTimer)
      stopPump()
      started = true
      stopPump = pumpAvc(captureBus, () => capture, channel)
    }
    return () => {
      clearTimeout(modeTimer)
      stopPump()
      peerViewers.delete(channel)
      if (!localViewers.size && !peerViewers.size) releaseCaptureSoon('no peer viewers')
    }
  }

  function attachRemote(channel) {
    if (!remote) {
      channel.send(JSON.stringify({ t: 'error', message: 'no remote is connected' }))
      return () => {}
    }
    const detach = remote.attach(channel)
    channel.setMode = (mode) => remote.setMode(mode)
    return () => {
      detach()
    }
  }

  // ---- peer server: one port that another Harness dials, independent of auth.
  function startPeerServer() {
    const server = http.createServer((req, res) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      if (url.pathname === '/info') {
        sendJson(res, 200, hostInfo())
        return
      }
      if (url.pathname === '/health') {
        sendJson(res, 200, { ok: true })
        return
      }
      sendJson(res, 404, { error: 'not found' })
    })
    server.on('upgrade', (req, socket, head) => {
      const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
      if (url.pathname !== '/stream') {
        socket.write('HTTP/1.1 404 Not Found\r\n\r\n')
        socket.destroy()
        return
      }
      const key = url.searchParams.get('key') || ''
      if (key !== pairKey(pin, name)) {
        socket.write('HTTP/1.1 403 Forbidden\r\n\r\n')
        socket.destroy()
        return
      }
      let dispose = () => {}
      let peerChannel = null
      const conn = upgrade(req, socket, head, {
        onopen: (c) => {
          peerChannel = {
            send: (data) => c.send(data),
            close: () => c.close(1000, 'bye'),
          }
          dispose = attachPeer(peerChannel)
        },
        onmessage: (payload) => {
          if (typeof payload !== 'string') return
          let msg
          try {
            msg = JSON.parse(payload)
          } catch {
            return
          }
          if (msg && msg.t === 'mode') {
            if (peerChannel && typeof peerChannel.setMode === 'function') peerChannel.setMode(msg.mode)
            return
          }
          applyInput('local', msg)
        },
        onclose: () => dispose(),
      })
      if (!conn) return
    })
    return new Promise((resolve, reject) => {
      server.once('error', reject)
      server.listen(opts.port, opts.allowLan ? '0.0.0.0' : '127.0.0.1', () => {
        log(`peer endpoint ws://${opts.allowLan ? '<lan-ip>' : '127.0.0.1'}:${opts.port}/stream  pin ${pin}`)
        resolve(server)
      })
    })
  }

  // ---- browser-facing routes on the Harness web server (same origin).
  function registerRoutes() {
    const web = ctx.webServer
    if (!web) {
      log('webServer is unavailable: the panel cannot be served')
      return
    }
    disposers.push(
      web.register({
        kind: 'exact',
        path: '/ydesk/api/state',
        handler: async (req, res) => {
          sendJson(res, 200, {
            host: { ...hostInfo(), pin },
            platform: PLATFORM,
            settings,
            capture: capture ? capture.status() : null,
            input: injector ? { ...injector.status(), stats: inputStats } : null,
            viewers: localViewers.size,
            peerViewers: peerViewers.size,
            remote: remote ? remote.status() : null,
          })
        },
      }),
    )
    disposers.push(
      web.register({
        kind: 'exact',
        path: '/ydesk/api/peers',
        handler: async (req, res) => {
          try {
            const [lanPeers, tailnetPeers] = await Promise.all([
              probePeers(900).catch(() => []),
              probeTailnet().catch(() => []),
            ])
            const seenAddr = new Set()
            const seenName = new Set()
            const peers = []
            for (const peer of [...lanPeers, ...tailnetPeers]) {
              if (!peer || peer.name === name) continue
              const addrKey = `${peer.address}:${peer.port}`
              const nameKey = String(peer.name || '').toLowerCase()
              if (seenAddr.has(addrKey)) continue
              if (nameKey && seenName.has(nameKey)) continue
              seenAddr.add(addrKey)
              if (nameKey) seenName.add(nameKey)
              peers.push(peer)
            }
            sendJson(res, 200, { peers })
          } catch (err) {
            sendJson(res, 200, { peers: [], error: String(err && err.message) })
          }
        },
      }),
    )
    disposers.push(
      web.register({
        kind: 'exact',
        path: '/ydesk/api/config',
        handler: async (req, res) => {
          const body = await readJsonBody(req)
          if (!body) return sendJson(res, 400, { error: 'invalid json' })
          if (typeof body.quality === 'string' && body.quality) settings.quality = body.quality
          if (body.fps) settings.fps = Number(body.fps) || settings.fps
          if (typeof body.bitrate === 'string' && body.bitrate) settings.bitrate = body.bitrate
          saveSettings(settings, pin)
          restartCapture()
          sendJson(res, 200, { ok: true, settings })
        },
      }),
    )
    disposers.push(
      web.register({
        kind: 'exact',
        path: '/ydesk/api/pin',
        handler: async (req, res) => {
          const body = await readJsonBody(req)
          const next = body && typeof body.pin === 'string' ? body.pin.trim() : ''
          pin = next || newPin()
          saveSettings(settings, pin)
          sendJson(res, 200, { ok: true, pin })
        },
      }),
    )
    disposers.push(
      web.register({
        kind: 'exact',
        path: '/ydesk/api/connect',
        handler: async (req, res) => {
          const body = await readJsonBody(req)
          if (!body || !body.host) return sendJson(res, 400, { error: 'host is required' })
          const host = String(body.host).trim()
          const port = Number(body.port) || opts.port
          const pinGiven = String(body.pin || '').trim()
          if (!pinGiven) return sendJson(res, 400, { error: 'pin is required' })
          let info = null
          try {
            const answer = await fetch(`http://${host}:${port}/info`, { signal: AbortSignal.timeout(4000) })
            info = await answer.json()
          } catch (err) {
            return sendJson(res, 502, { error: `cannot reach ${host}:${port}`, detail: String(err && err.message) })
          }
          const key = pairKey(pinGiven, info && info.name ? String(info.name) : host)
          if (remote) remote.close()
          remote = new RemoteView({ host, port, key, name: (info && info.name) || host })
          remote.connect()
          sendJson(res, 200, { ok: true, remote: remote.status(), peer: info })
        },
      }),
    )
    disposers.push(
      web.register({
        kind: 'exact',
        path: '/ydesk/api/disconnect',
        handler: async (req, res) => {
          if (remote) {
            remote.close()
            remote = null
          }
          sendJson(res, 200, { ok: true })
        },
      }),
    )
    disposers.push(
      web.registerUpgrade({
        path: '/ydesk/ws',
        handler: (req, socket, head) => {
          const url = new URL(req.url || '/', `http://${req.headers.host || 'localhost'}`)
          const target = url.searchParams.get('target') || 'local'
          let dispose = () => {}
          const conn = upgrade(req, socket, head, {})
          if (!conn) {
            log('ws upgrade rejected', req.url)
            return
          }
          log('ws open', target, 'viewers', localViewers.size + 1)
          const channel = {
            send: (data) => conn.send(data),
            close: () => conn.close(1000, 'bye'),
          }
          dispose = target === 'remote' ? attachRemote(channel) : attachLocal(channel)
          conn.onmessage = (payload) => {
            if (typeof payload !== 'string') return
            let msg
            try {
              msg = JSON.parse(payload)
            } catch {
              return
            }
            if (msg && msg.t === 'mode') {
              if (typeof channel.setMode === 'function') channel.setMode(msg.mode)
              return
            }
            if (msg && msg.t) applyInput(target === 'remote' ? 'remote' : 'local', msg)
          }
          conn.onclose = (info) => {
            log('ws close', target, info && info.code)
            dispose()
          }
        },
      }),
    )
  }

  ctx.effect(() => {
    let discovery = null
    registerRoutes()
    const start = async () => {
      try {
        peerServer = await startPeerServer()
      } catch (err) {
        log(`cannot listen on port ${opts.port}:`, err && err.message)
      }
      if (opts.allowLan) {
        discovery = new Discovery()
        discovery.start(() => ({ ...hostInfo(), tcp: true }))
      }
      log(`ready on ${PLATFORM}, pin ${pin}`)
    }
    start().catch((err) => log('startup failed:', err && err.message))

    return () => {
      for (const dispose of disposers.splice(0)) {
        try {
          dispose()
        } catch {}
      }
      if (discovery) discovery.stop()
      if (remote) remote.close()
      remote = null
      if (capture) capture.stop()
      capture = null
      if (injector) injector.stop()
      injector = null
      if (peerServer) {
        try {
          peerServer.close()
        } catch {}
        peerServer = null
      }
    }
  })
}
