// Minimal RFC 6455 server-side WebSocket endpoint.
// Server frames are never masked; client frames must be.

import crypto from 'node:crypto'

const GUID = '258EAFA5-E914-47DA-95CA-C5AB0DC85B11'

export function acceptKey(key) {
  return crypto.createHash('sha1').update(String(key) + GUID).digest('base64')
}

function encodeFrame(opcode, payload) {
  const len = payload.length
  let header
  if (len < 126) {
    header = Buffer.alloc(2)
    header[1] = len
  } else if (len < 65536) {
    header = Buffer.alloc(4)
    header[1] = 126
    header.writeUInt16BE(len, 2)
  } else {
    header = Buffer.alloc(10)
    header[1] = 127
    header.writeUInt32BE(0, 2)
    header.writeUInt32BE(len, 6)
  }
  header[0] = 0x80 | opcode
  return Buffer.concat([header, payload])
}

export class Conn {
  constructor(socket) {
    this.socket = socket
    this.open = true
    this.buf = Buffer.alloc(0)
    this.fragOpcode = 0
    this.fragParts = []
    this.onmessage = null
    this.onclose = null
    socket.on('data', (chunk) => {
      this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
      this._drain()
    })
    socket.on('close', () => this._closed())
    socket.on('error', () => this._closed())
  }

  _closed() {
    if (!this.open) return
    this.open = false
    try { this.socket.destroy() } catch {}
    if (this.onclose) {
      const fn = this.onclose
      this.onclose = null
      try { fn() } catch {}
    }
  }

  _drain() {
    for (;;) {
      const b = this.buf
      if (b.length < 2) return
      const fin = (b[0] & 0x80) !== 0
      const opcode = b[0] & 0x0f
      const masked = (b[1] & 0x80) !== 0
      let len = b[1] & 0x7f
      let off = 2
      if (len === 126) {
        if (b.length < 4) return
        len = b.readUInt16BE(2)
        off = 4
      } else if (len === 127) {
        if (b.length < 10) return
        const hi = b.readUInt32BE(2)
        const lo = b.readUInt32BE(6)
        if (hi > 0x1fffff) { this._closed(); return }
        len = hi * 0x100000000 + lo
        off = 10
      }
      const maskLen = masked ? 4 : 0
      if (b.length < off + maskLen + len) return
      const mask = masked ? b.subarray(off, off + 4) : null
      const start = off + maskLen
      let payload = b.subarray(start, start + len)
      if (mask) {
        payload = Buffer.from(payload)
        for (let i = 0; i < payload.length; i++) payload[i] ^= mask[i & 3]
      }
      this.buf = b.subarray(start + len)

      if (opcode === 0x8) { this._closed(); return }
      if (opcode === 0x9) { this._raw(0xa, payload); continue }
      if (opcode === 0xa) continue
      if (opcode === 0x0) {
        this.fragParts.push(payload)
        if (!fin) continue
        const whole = Buffer.concat(this.fragParts)
        const op = this.fragOpcode
        this.fragParts = []
        this.fragOpcode = 0
        this._message(op, whole)
        continue
      }
      if (!fin) {
        this.fragOpcode = opcode
        this.fragParts = [payload]
        continue
      }
      this._message(opcode, payload)
    }
  }

  _message(opcode, payload) {
    if (!this.onmessage) return
    try {
      this.onmessage(opcode === 0x1 ? payload.toString('utf8') : payload)
    } catch (err) {
      console.error('[ydesk] ws handler failed:', err)
    }
  }

  _raw(opcode, payload) {
    if (!this.open) return
    try { this.socket.write(encodeFrame(opcode, payload)) } catch {}
  }

  send(data) {
    if (!this.open) return false
    const payload = Buffer.isBuffer(data)
      ? data
      : typeof data === 'string'
        ? Buffer.from(data, 'utf8')
        : Buffer.from(data.buffer ? data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength) : data)
    this._raw(typeof data === 'string' ? 0x1 : 0x2, payload)
    return this.open
  }

  close(code = 1000, reason = '') {
    if (!this.open) return
    const body = Buffer.alloc(2 + Buffer.byteLength(reason))
    body.writeUInt16BE(code, 0)
    body.write(reason, 2)
    this._raw(0x8, body)
    try { this.socket.end() } catch {}
    this._closed()
  }
}

export function upgrade(req, socket, head, handlers = {}) {
  const key = req.headers['sec-websocket-key']
  if (!key) {
    socket.write('HTTP/1.1 400 Bad Request\r\n\r\n')
    socket.destroy()
    return null
  }
  socket.write(
    'HTTP/1.1 101 Switching Protocols\r\n' +
      'Upgrade: websocket\r\n' +
      'Connection: Upgrade\r\n' +
      `Sec-WebSocket-Accept: ${acceptKey(key)}\r\n\r\n`,
  )
  if (socket.setNoDelay) socket.setNoDelay(true)
  const conn = new Conn(socket)
  conn.onmessage = handlers.onmessage || null
  conn.onclose = handlers.onclose || null
  if (head && head.length) {
    conn.buf = Buffer.from(head)
    conn._drain()
  }
  if (handlers.onopen) {
    try { handlers.onopen(conn) } catch (err) { console.error('[ydesk] ws open failed:', err) }
  }
  return conn
}
