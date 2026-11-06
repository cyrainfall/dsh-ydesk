// Splits a fragmented-MP4 byte stream into an init segment and playable
// fragments, and reports whether each fragment starts on a sync sample.

function readBoxHeader(buf, off) {
  if (buf.length < off + 8) return null
  let size = buf.readUInt32BE(off)
  const type = buf.toString('latin1', off + 4, off + 8)
  let header = 8
  if (size === 1) {
    if (buf.length < off + 16) return null
    const hi = buf.readUInt32BE(off + 8)
    const lo = buf.readUInt32BE(off + 12)
    size = hi * 0x100000000 + lo
    header = 16
  } else if (size === 0) {
    size = buf.length - off
  }
  if (size < header) return null
  return { type, size, header }
}

function* boxes(buf, start = 0, end = buf.length) {
  let off = start
  while (off + 8 <= end) {
    const h = readBoxHeader(buf, off)
    if (!h || off + h.size > end) return
    yield { type: h.type, start: off, body: off + h.header, end: off + h.size }
    off += h.size
  }
}

// True when the first sample of this moof is a sync sample (a keyframe).
export function moofStartsOnKeyframe(moof) {
  let fallbackSync = true
  for (const traf of boxes(moof, 0, moof.length)) {
    if (traf.type !== 'traf') continue
    let defaultSync = null
    let firstSync = null
    for (const box of boxes(moof, traf.body, traf.end)) {
      const p = box.body
      if (box.type === 'tfhd') {
        const flags = moof.readUInt32BE(p) & 0xffffff
        let o = p + 4
        if (flags & 0x000001) o += 8
        if (flags & 0x000002) o += 4
        if (flags & 0x000008) o += 4
        if (flags & 0x000010) o += 4
        if (flags & 0x000020) {
          defaultSync = (moof.readUInt32BE(o) & 0x00010000) === 0
        }
      } else if (box.type === 'trun') {
        const flags = moof.readUInt32BE(p) & 0xffffff
        let o = p + 4
        const count = moof.readUInt32BE(o)
        o += 4
        if (flags & 0x000001) o += 4
        if (flags & 0x000004) {
          firstSync = (moof.readUInt32BE(o) & 0x00010000) === 0
        } else if ((flags & 0x000400) && count > 0) {
          let q = o
          if (flags & 0x000100) q += 4
          if (flags & 0x000200) q += 4
          if (flags & 0x000800) q += 4
          firstSync = (moof.readUInt32BE(q) & 0x00010000) === 0
        }
      }
    }
    if (firstSync !== null) return firstSync
    if (defaultSync !== null) return defaultSync
    return fallbackSync
  }
  return fallbackSync
}

export class Fmp4Splitter {
  constructor() {
    this.buf = Buffer.alloc(0)
    this.initDone = false
    this.initParts = []
    this.pending = []
    this.pendingKey = false
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const out = []
    for (;;) {
      const h = readBoxHeader(this.buf, 0)
      if (!h) break
      if (this.buf.length < h.size) break
      const box = this.buf.subarray(0, h.size)
      this.buf = this.buf.subarray(h.size)

      if (!this.initDone) {
        this.initParts.push(box)
        if (h.type === 'moov') {
          this.initDone = true
          out.push({ type: 'init', data: Buffer.concat(this.initParts) })
          this.initParts = []
        }
        continue
      }

      if (h.type === 'styp' || h.type === 'sidx') {
        this.pending.push(box)
        continue
      }
      if (h.type === 'moof') {
        if (this.pending.length) this.pending = []
        this.pending.push(box)
        this.pendingKey = moofStartsOnKeyframe(box)
        continue
      }
      if (h.type === 'mdat') {
        if (!this.pending.length) continue
        this.pending.push(box)
        out.push({ type: 'fragment', data: Buffer.concat(this.pending), key: this.pendingKey })
        this.pending = []
        continue
      }
      // Unknown muxer box in streaming output: ignore it.
    }
    return out
  }
}
