// Annex-B H.264 -> fragmented MP4, in pure JavaScript.
//
// ffmpeg's container muxers are dramatically slower than its raw H.264 muxer on
// some Windows hosts (~12 fps vs 60 fps at the same settings), so the Host side
// captures Annex-B and muxes it here instead. The output is the same shape the
// MSE player already consumes: one init segment, then one moof+mdat per frame.

const SYNC = 0x02000000
const NON_SYNC = 0x01010000

function u8(n) {
  return Buffer.from([n & 0xff])
}

function u16(n) {
  const b = Buffer.alloc(2)
  b.writeUInt16BE(n & 0xffff, 0)
  return b
}

function u32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}

function fourcc(s) {
  return Buffer.from(s, 'latin1')
}

function box(type, ...parts) {
  const body = Buffer.concat(parts.filter(Boolean))
  return Buffer.concat([u32(body.length + 8), fourcc(type), body])
}

function fullBox(type, version, flags, ...parts) {
  const head = Buffer.alloc(4)
  head[0] = version
  head.writeUIntBE(flags, 1, 3)
  return box(type, head, ...parts)
}

const MATRIX = Buffer.concat([
  u32(0x00010000), u32(0), u32(0),
  u32(0), u32(0x00010000), u32(0),
  u32(0), u32(0), u32(0x40000000),
])

function ftyp() {
  return box('ftyp', fourcc('isom'), u32(512), fourcc('isom'), fourcc('iso6'), fourcc('mp41'))
}

function mvhd(timescale) {
  const body = Buffer.concat([
    u32(0), // creation
    u32(0), // modification
    u32(timescale),
    u32(0), // duration
    u32(0x00010000), // rate
    u16(0x0100), // volume
    u16(0), // reserved
    u32(0),
    u32(0),
    MATRIX,
    Buffer.alloc(24),
    u32(2), // next track id
  ])
  return fullBox('mvhd', 0, 0, body)
}

function tkhd(width, height) {
  const body = Buffer.concat([
    u32(0),
    u32(0),
    u32(1), // track id
    u32(0), // reserved
    u32(0), // duration
    Buffer.alloc(8),
    u16(0), // layer
    u16(0), // alternate group
    u16(0), // volume
    u16(0),
    MATRIX,
    u32(width * 65536),
    u32(height * 65536),
  ])
  return fullBox('tkhd', 0, 3, body)
}

function mdhd(timescale) {
  return fullBox('mdhd', 0, 0, Buffer.concat([u32(0), u32(0), u32(timescale), u32(0), u16(0x55c4), u16(0)]))
}

function hdlr() {
  return fullBox('hdlr', 0, 0, Buffer.concat([
    u32(0),
    fourcc('vide'),
    Buffer.alloc(12),
    Buffer.from('VideoHandler\0', 'latin1'),
  ]))
}

function vmhd() {
  return fullBox('vmhd', 0, 1, Buffer.concat([u16(0), u16(0), u16(0), u16(0)]))
}

function dinf() {
  const url = fullBox('url ', 0, 1)
  return box('dinf', fullBox('dref', 0, 0, u32(1), url))
}

function avcC(spsList, ppsList) {
  const sps = spsList[0]
  const pps = ppsList[0]
  const head = Buffer.from([
    1,
    sps[1],
    sps[2],
    sps[3],
    0xff, // 4-byte NAL length
    0xe1, // one SPS
  ])
  const parts = [head, u16(sps.length), sps, u8(ppsList.length)]
  for (const p of ppsList) parts.push(u16(p.length), p)
  return box('avcC', ...parts)
}

function avc1(width, height, spsList, ppsList) {
  const compressor = Buffer.alloc(32)
  compressor.write('dsh-ydesk', 0, 'latin1')
  const body = Buffer.concat([
    Buffer.alloc(6),
    u16(1), // data reference index
    Buffer.alloc(16),
    u16(width),
    u16(height),
    u32(0x00480000),
    u32(0x00480000),
    u32(0),
    u16(1), // frame count
    compressor,
    u16(0x0018), // depth
    u16(0xffff), // pre_defined
    avcC(spsList, ppsList),
  ])
  return box('avc1', body)
}

function stbl(width, height, spsList, ppsList) {
  const stsd = fullBox('stsd', 0, 0, u32(1), avc1(width, height, spsList, ppsList))
  return box(
    'stbl',
    stsd,
    fullBox('stts', 0, 0, u32(0)),
    fullBox('stsc', 0, 0, u32(0)),
    fullBox('stsz', 0, 0, u32(0), u32(0)),
    fullBox('stco', 0, 0, u32(0)),
  )
}

function mvex() {
  // A fragmented movie advertises its tracks here; several demuxers refuse to
  // parse moof/traf without it.
  const trex = fullBox('trex', 0, 0, u32(1), u32(1), u32(0), u32(0), u32(0))
  return box('mvex', trex)
}

function moov(width, height, timescale, spsList, ppsList) {
  const minf = box('minf', vmhd(), dinf(), stbl(width, height, spsList, ppsList))
  const mdia = box('mdia', mdhd(timescale), hdlr(), minf)
  const trak = box('trak', tkhd(width, height), mdia)
  return box('moov', mvhd(timescale), trak, mvex())
}

function moof(seq, baseTime, duration, size, key, dataOffset) {
  const mfhd = fullBox('mfhd', 0, 0, u32(seq))
  const tfhd = fullBox('tfhd', 0, 0x020000, u32(1))
  const stamp = Buffer.alloc(8)
  stamp.writeBigUInt64BE(BigInt(Math.max(0, Math.round(baseTime))))
  const tfdt = fullBox('tfdt', 1, 0, stamp)
  const trun = fullBox(
    'trun',
    0,
    0x000701,
    u32(1),
    u32(dataOffset),
    u32(duration),
    u32(size),
    u32(key ? SYNC : NON_SYNC),
  )
  return box('moof', mfhd, box('traf', tfhd, tfdt, trun))
}

/** Splits a stream of 4-byte-start-code NAL units into access units. */
class AnnexB {
  constructor() {
    this.buf = Buffer.alloc(0)
  }

  push(chunk) {
    this.buf = this.buf.length ? Buffer.concat([this.buf, chunk]) : chunk
    const aus = []
    // An access unit begins at each AUD (NAL type 9); emit everything before it.
    while (true) {
      const first = this._find(0)
      if (first < 0) break
      const second = this._find(first + 4)
      if (second < 0) break
      const au = this.buf.subarray(first, second)
      this.buf = this.buf.subarray(second)
      aus.push(au)
    }
    return aus
  }

  _find(from) {
    for (let i = from; i + 3 < this.buf.length; i += 1) {
      if (this.buf[i] === 0 && this.buf[i + 1] === 0 && this.buf[i + 2] === 1) {
        const type = this.buf[i + 3] & 0x1f
        if (type === 9) return i > 0 && this.buf[i - 1] === 0 ? i - 1 : i
        i += 3
      }
    }
    return -1
  }
}

/** Splits one access unit into NAL payloads (start codes removed). */
function nalUnits(au) {
  const out = []
  let i = 0
  while (i + 3 < au.length) {
    if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
      const start = i + 3
      let j = start
      while (j + 3 < au.length) {
        if (au[j] === 0 && au[j + 1] === 0 && au[j + 2] === 1) break
        j += 1
      }
      const end = j + 3 >= au.length ? au.length : j
      if (end > start) out.push(au.subarray(start, end))
      i = end
    } else {
      i += 1
    }
  }
  return out
}

export class Fragmenter {
  constructor(options = {}) {
    this.width = Number(options.width) || 1920
    this.height = Number(options.height) || 1080
    this.fps = Number(options.fps) || 30
    this.timescale = this.fps * 1000
    this.duration = 1000
    this.sps = []
    this.pps = []
    this.annexb = new AnnexB()
    this.init = null
    this.seq = 0
    this.decodeTime = 0
  }

  push(chunk) {
    const events = []
    for (const au of this.annexb.push(chunk)) {
      if (this.onAU) {
        try {
          this.onAU(au)
        } catch (err) {
          if (!this._auErrLogged) {
            this._auErrLogged = true
            console.error('[ydesk] onAU failed:', (err && err.message) || err)
          }
        }
      }
      const emitted = this._frame(au)
      if (emitted && emitted.length) events.push(...emitted)
    }
    return events
  }

  _frame(au) {
    const nals = nalUnits(au)
    if (!nals.length) return null
    let key = false
    const payloads = []
    for (const nal of nals) {
      const type = nal[0] & 0x1f
      if (type === 9) continue // access unit delimiter: not part of a sample
      if (type === 7) {
        this.sps = [Buffer.from(nal)]
        continue
      }
      if (type === 8) {
        this.pps = [Buffer.from(nal)]
        continue
      }
      if (type === 5) key = true
      payloads.push(nal)
    }
    if (!payloads.length) return null
    if (!this.init) {
      if (!this.sps.length || !this.pps.length) return null
      this.init = Buffer.concat([ftyp(), moov(this.width, this.height, this.timescale, this.sps, this.pps)])
      this._pendingInit = Buffer.from(this.init)
    }

    const parts = []
    let total = 0
    for (const nal of payloads) {
      parts.push(u32(nal.length), nal)
      total += 4 + nal.length
    }
    const sample = Buffer.concat(parts)
    if (total !== sample.length) return null

    const events = []
    if (this._pendingInit) {
      events.push({ type: 'init', data: this._pendingInit })
      this._pendingInit = null
    }

    const placeholder = moof(this.seq, this.decodeTime, this.duration, sample.length, key, 0)
    const dataOffset = placeholder.length + 8
    const head = moof(this.seq, this.decodeTime, this.duration, sample.length, key, dataOffset)
    const mdat = box('mdat', sample)
    this.seq += 1
    this.decodeTime += this.duration
    events.push({ type: 'fragment', data: Buffer.concat([head, mdat]), key })
    return events
  }
}

export default Fragmenter
