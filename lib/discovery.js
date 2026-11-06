// LAN discovery: hosts answer a UDP probe with their ydesk endpoint.

import dgram from 'node:dgram'
import os from 'node:os'

export const DISCOVERY_PORT = 8897
const PROBE = 'YDESK_PROBE_1'
const REPLY = 'YDESK_HOST_1'

export function lanAddresses() {
  const out = []
  const nets = os.networkInterfaces()
  for (const name of Object.keys(nets)) {
    for (const net of nets[name] || []) {
      if (net.family === 'IPv4' && !net.internal) out.push(net.address)
    }
  }
  return out
}

export class Discovery {
  constructor(options = {}) {
    this.port = Number(options.port) || DISCOVERY_PORT
    this.socket = null
    this.info = null
  }

  start(infoProvider) {
    if (this.socket) return
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    this.socket = socket
    socket.on('error', () => {
      try { socket.close() } catch {}
      this.socket = null
    })
    socket.on('message', (msg, rinfo) => {
      if (msg.toString('utf8') !== PROBE) return
      const info = infoProvider()
      if (!info) return
      const payload = Buffer.from(REPLY + JSON.stringify(info), 'utf8')
      socket.send(payload, rinfo.port, rinfo.address, () => {})
    })
    socket.bind(this.port, '0.0.0.0')
  }

  stop() {
    try { this.socket && this.socket.close() } catch {}
    this.socket = null
  }
}

// Broadcast a probe and collect whatever answers within the timeout.
export function probePeers(timeoutMs = 900) {
  return new Promise((resolve) => {
    const socket = dgram.createSocket({ type: 'udp4', reuseAddr: true })
    const seen = new Map()
    const finish = () => {
      try { socket.close() } catch {}
      resolve([...seen.values()])
    }
    const timer = setTimeout(finish, timeoutMs)
    socket.on('error', () => {
      clearTimeout(timer)
      finish()
    })
    socket.on('message', (msg, rinfo) => {
      const text = msg.toString('utf8')
      if (!text.startsWith(REPLY)) return
      try {
        const info = JSON.parse(text.slice(REPLY.length))
        const key = `${rinfo.address}:${info.port || 0}`
        seen.set(key, { ...info, address: rinfo.address, key })
      } catch {}
    })
    socket.bind(0, () => {
      try { socket.setBroadcast(true) } catch {}
      const payload = Buffer.from(PROBE, 'utf8')
      const targets = ['255.255.255.255', '127.0.0.1', ...lanAddresses().map((ip) => {
        const parts = ip.split('.')
        return `${parts[0]}.${parts[1]}.${parts[2]}.255`
      })]
      for (const target of new Set(targets)) {
        socket.send(payload, DISCOVERY_PORT, target, () => {})
      }
    })
  })
}
