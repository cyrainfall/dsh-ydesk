/**
 * dsh-ydesk — Client half.
 *
 * A sidebar entry plus one central panel: preview this machine, or drive another
 * machine that runs the plugin. The video path is fragmented MP4 fed into
 * MediaSource, so it works on a plain http origin (no WebCodecs/secure context
 * requirement) and needs no frames from the Harness UI itself.
 */
window.__ModuleLoader__.load({
  id: 'dsh-ydesk',
  factory(require) {
    const React = require('react')
    const h = React.createElement
    const { useState, useEffect, useRef, useCallback, useMemo } = React

    const DICT = {
      en: {
        'nav.label': 'Remote desktop',
        'title': 'Remote desktop',
        'subtitle': 'Drive another Harness machine from this window, or let it drive this one.',
        'thisMachine': 'This machine',
        'pin': 'Pairing PIN',
        'pinHint': 'The other machine types this PIN once; change it any time.',
        'newPin': 'New PIN',
        'copy': 'Copy',
        'copied': 'Copied',
        'lanPeers': 'Machines on this network',
        'refresh': 'Refresh',
        'scanning': 'Looking for machines…',
        'noPeers': 'Nothing found yet. Make sure the plugin is installed and enabled on the other machine.',
        'manual': 'Connect by address',
        'lastOne': 'Last connection',
        'reconnect': 'Reconnect',
        'fillPin': 'Enter PIN',
        'host': 'Address',
        'port': 'Port',
        'connect': 'Connect',
        'previewLocal': 'Preview this screen',
        'back': 'Back',
        'disconnect': 'Disconnect',
        'quality': 'Quality',
        'quality.smooth': 'Smooth',
        'quality.balanced': 'Balanced',
        'quality.sharp': 'Sharp',
        'quality.original': 'Original size',
        'status.idle': 'Not connected',
        'status.connecting': 'Connecting…',
        'status.live': 'Live',
        'status.error': 'Connection problem',
        'landingHint': 'Click the picture to take control. F11 goes fullscreen, Esc leaves it.',
        'localNote': 'You are looking at this machine.',
        'remoteNote': 'You are driving {name}.',
        'needPin': 'Enter the PIN shown on the other machine.',
        'fps': 'fps',
        'failed': 'Could not connect',
      },
      zh: {
        'nav.label': '远程桌面',
        'title': '远程桌面',
        'subtitle': '在这个窗口里操作另一台装了 Harness 的电脑，或者让它操作这台。',
        'thisMachine': '本机',
        'pin': '配对码',
        'pinHint': '对方输入一次这个配对码即可连接，随时可以更换。',
        'newPin': '换一个',
        'copy': '复制',
        'copied': '已复制',
        'lanPeers': '局域网内的电脑',
        'refresh': '刷新',
        'scanning': '正在查找…',
        'noPeers': '暂时没找到。确认对方也装好并启用了这个插件。',
        'manual': '用地址连接',
        'lastOne': '上次连接',
        'reconnect': '一键连接',
        'fillPin': '输入配对码',
        'host': '地址',
        'port': '端口',
        'connect': '连接',
        'previewLocal': '预览本机屏幕',
        'back': '返回',
        'disconnect': '断开',
        'quality': '画质',
        'quality.smooth': '流畅',
        'quality.balanced': '均衡',
        'quality.sharp': '清晰',
        'quality.original': '原始大小',
        'status.idle': '未连接',
        'status.connecting': '连接中…',
        'status.live': '已连接',
        'status.error': '连接出错',
        'landingHint': '点一下画面即可操作。F11 全屏，Esc 退出全屏。',
        'localNote': '你正在看本机屏幕。',
        'remoteNote': '你正在操作 {name}。',
        'needPin': '请输入对方屏幕上显示的配对码。',
        'fps': '帧',
        'failed': '连接失败',
      },
    }

    let tr = (key, params) => {
      let text = (DICT.zh[key] || DICT.en[key] || key)
      if (params) for (const name of Object.keys(params)) text = text.split(`{${name}}`).join(String(params[name]))
      return text
    }

    function pickDict() {
      const lang = typeof navigator !== 'undefined' && navigator.language ? navigator.language : 'zh'
      return /^zh/i.test(lang) ? DICT.zh : DICT.en
    }

    const CSS = `
.ydesk-root { display: flex; flex-direction: column; height: 100%; min-height: 0; background: var(--dsw-alias-bg-base); color: var(--dsw-alias-label-primary); }
.ydesk-bar { display: flex; align-items: center; gap: 10px; padding: 10px 14px; border-bottom: 1px solid var(--dsw-alias-border-l1); flex: 0 0 auto; flex-wrap: wrap; }
.ydesk-bar h2 { font-size: 14px; font-weight: 600; margin: 0; }
.ydesk-dim { color: var(--dsw-alias-label-secondary); font-size: 12px; }
.ydesk-pill { font-size: 11px; padding: 2px 8px; border-radius: 999px; border: 1px solid var(--dsw-alias-border-l1); color: var(--dsw-alias-label-secondary); }
.ydesk-pill.live { color: var(--dsw-alias-state-success-primary); border-color: var(--dsw-alias-state-success-primary); }
.ydesk-pill.error { color: var(--dsw-alias-state-error-primary); border-color: var(--dsw-alias-state-error-primary); }
.ydesk-pill.connecting { color: var(--dsw-alias-state-warn-primary); border-color: var(--dsw-alias-state-warn-primary); }
.ydesk-spacer { flex: 1 1 auto; }
.ydesk-btn { font: inherit; font-size: 12px; padding: 5px 10px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); cursor: pointer; }
.ydesk-btn:hover { border-color: var(--dsw-alias-border-l2); }
.ydesk-btn.primary { background: var(--dsw-alias-brand-primary); border-color: var(--dsw-alias-brand-primary); color: var(--dsw-alias-label-primary-foreground, #fff); }
.ydesk-btn.primary:hover { background: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); border-color: var(--dsw-alias-button-primary-hover, var(--dsw-alias-brand-primary)); }
.ydesk-btn:disabled { opacity: .5; cursor: default; }
.ydesk-input { font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.ydesk-select { font: inherit; font-size: 12px; padding: 5px 8px; border-radius: 6px; border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); color: var(--dsw-alias-label-primary); }
.ydesk-body { flex: 1 1 auto; min-height: 0; overflow: auto; padding: 16px; display: flex; flex-direction: column; gap: 16px; }
.ydesk-card { border: 1px solid var(--dsw-alias-border-l1); background: var(--dsw-alias-bg-layer-1); border-radius: 10px; padding: 14px; }
.ydesk-card h3 { margin: 0 0 4px; font-size: 13px; font-weight: 600; }
.ydesk-pin { font-family: ui-monospace, SFMono-Regular, Menlo, monospace; font-size: 26px; letter-spacing: 6px; font-weight: 700; }
.ydesk-row { display: flex; align-items: center; gap: 8px; flex-wrap: wrap; }
.ydesk-peers { display: flex; flex-direction: column; gap: 8px; margin-top: 8px; }
.ydesk-peer { display: flex; align-items: center; gap: 10px; padding: 8px 10px; border: 1px solid var(--dsw-alias-border-l1); border-radius: 8px; background: var(--dsw-alias-bg-layer-2); }
.ydesk-peer .name { font-size: 13px; font-weight: 600; }
.ydesk-stage { flex: 1 1 auto; min-height: 0; position: relative; background: #000; display: flex; align-items: center; justify-content: center; overflow: hidden; }
.ydesk-stage video { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; cursor: none; outline: none; background: #000; }
.ydesk-stage canvas { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: contain; display: block; cursor: none; background: #000; }
.ydesk-stage.empty canvas { opacity: 0; }
.ydesk-void { position: absolute; inset: 0; display: flex; align-items: center; justify-content: center; flex-direction: column; gap: 10px; color: #c9ccd1; text-align: center; padding: 24px; font-size: 13px; }
`

    function Icon(props) {
      const size = (props && props.size) || 20
      const active = props && props.active
      return h(
        'svg',
        { viewBox: '0 0 24 24', width: size, height: size, fill: 'none', 'aria-hidden': true, style: { display: 'block' } },
        h('rect', {
          x: 2.5,
          y: 4,
          width: 19,
          height: 13,
          rx: 2,
          stroke: 'currentColor',
          strokeWidth: active ? 2 : 1.6,
          opacity: active ? 1 : 0.85,
        }),
        h('path', {
          d: 'M8 8.5l6 3.5-6 3.5z',
          fill: 'currentColor',
          opacity: active ? 1 : 0.85,
        }),
        h('path', { d: 'M8 20.5h8', stroke: 'currentColor', strokeWidth: 1.6, strokeLinecap: 'round' }),
      )
    }

    function useMediaSurface(videoRef) {
      const msRef = useRef(null)
      const sbRef = useRef(null)
      const queueRef = useRef([])
      const codecRef = useRef('video/mp4; codecs="avc1.42E01E"')

      const drain = useCallback(() => {
        const sb = sbRef.current
        const ms = msRef.current
        if (!sb || !ms || sb.updating || ms.readyState !== 'open') return
        const queue = queueRef.current
        while (queue.length && !sb.updating) {
          const chunk = queue.shift()
          try {
            sb.appendBuffer(chunk)
          } catch (err) {
            queue.unshift(chunk)
            if (err && err.name === 'QuotaExceededError') trimBuffer(sb, true)
            break
          }
        }
        trimBuffer(sb, false)
      }, [])

      const trimBuffer = (sb, aggressive) => {
        if (!sb || sb.updating) return
        const video = videoRef.current
        let end = 0
        try {
          if (sb.buffered.length) end = sb.buffered.end(sb.buffered.length - 1)
        } catch {
          return
        }
        // Never cut past the playhead: removing the chunk under the current
        // position stalls the element forever.
        const now = video ? video.currentTime : 0
        const keep = aggressive ? 0.6 : 3
        const limit = Math.min(Math.max(now - 1, 0.5), end - keep)
        if (limit > 0.5) {
          try {
            sb.remove(0, limit)
          } catch {}
        }
      }

      const retryRef = useRef(0)
      const start = useCallback((codec) => {
        const video = videoRef.current
        if (!video || msRef.current) return
        if (codec) codecRef.current = codec
        // The panel may still be mounting: wait until the element is in the
        // document, otherwise Chrome detaches the pipeline and MediaSource ends
        // up 'closed' before sourceopen arrives.
        if (!video.isConnected) {
          if (retryRef.current < 40) {
            retryRef.current += 1
            requestAnimationFrame(() => start(codecRef.current))
          }
          return
        }
        retryRef.current = 0
        const ms = new MediaSource()
        msRef.current = ms
        try {
          if (video.src) URL.revokeObjectURL(video.src)
        } catch {}
        video.src = URL.createObjectURL(ms)
        ms.addEventListener(
          'sourceopen',
          () => {
            if (ms.readyState !== 'open') {
              // A re-render swapped the <video> element; start over cleanly.
              msRef.current = null
              try { video.removeAttribute('src'); video.load() } catch {}
              if (retryRef.current < 20) {
                retryRef.current += 1
                requestAnimationFrame(() => start(codecRef.current))
              }
              return
            }
            try {
              const sb = ms.addSourceBuffer(codecRef.current)
              sb.mode = 'segments'
              sb.addEventListener('updateend', drain)
              sbRef.current = sb
              drain()
            } catch (err) {
              console.error('[ydesk] cannot open the video pipeline:', err)
              msRef.current = null
              if (retryRef.current < 20) {
                retryRef.current += 1
                setTimeout(() => start(codecRef.current), 150)
              }
            }
          },
          { once: true },
        )
      }, [drain, videoRef])

      const push = useCallback(
        (buf) => {
          if (!msRef.current) start(null)
          queueRef.current.push(buf)
          if (queueRef.current.length > 240) queueRef.current.shift()
          drain()
        },
        [drain, start],
      )

      const reset = useCallback(() => {
        queueRef.current = []
        const video = videoRef.current
        try {
          if (sbRef.current) sbRef.current.abort && sbRef.current.abort()
        } catch {}
        sbRef.current = null
        try {
          if (msRef.current && msRef.current.readyState === 'open') msRef.current.endOfStream('network')
        } catch {}
        msRef.current = null
        if (video) {
          try {
            video.removeAttribute('src')
            video.load()
          } catch {}
        }
      }, [videoRef])

      // A fresh object each render would re-run the socket effect below on every
      // state change (open -> close -> reopen loop), so keep the identity stable.
      return useMemo(() => ({ push, start, reset, codecRef }), [push, start, reset])
    }

    function Viewer(props) {
      const { target, onExit, onStatus } = props
      const videoRef = useRef(null)
      const stageRef = useRef(null)
      const wsRef = useRef(null)
      const movePending = useRef(null)
      const rafRef = useRef(0)
      const [status, setStatus] = useState('connecting')
      const [title, setTitle] = useState(target === 'local' ? '' : props.name || '')
      const [fps, setFps] = useState(0)
      const [error, setError] = useState('')
      const media = useMediaSurface(videoRef)
      const mediaRef = useRef(media)
      mediaRef.current = media
      const canvasRef = useRef(null)
      const avcRef = useRef(null)
      const [avcMode, setAvcMode] = useState(false)

      const sendObj = useCallback((value) => {
        const ws = wsRef.current
        if (ws && ws.readyState === 1) {
          try {
            ws.send(JSON.stringify(value))
          } catch {}
        }
      }, [])

      useEffect(() => {
        let closed = false
        let frames = 0
        let sourceFps = 0
        let lastClock = -1
        let lastTick = performance.now()
        let retry = 0

        let auTs = 0
        const stopAvc = () => {
          const state = avcRef.current
          avcRef.current = null
          if (state && state.dec) {
            try {
              state.dec.close()
            } catch {}
          }
        }
        const isKeyAU = (au) => {
          for (let i = 0; i + 4 < au.length; i++) {
            if (au[i] === 0 && au[i + 1] === 0 && au[i + 2] === 1) {
              if ((au[i + 3] & 0x1f) === 5) return true
              i += 2
            }
          }
          return false
        }
        const startAvc = () => {
          if (!window.isSecureContext || typeof VideoDecoder !== 'function') return false
          stopAvc()
          let dec = null
          try {
            dec = new VideoDecoder({
              output: (frame) => {
                const cv = canvasRef.current
                if (cv) {
                  if (cv.width !== frame.displayWidth || cv.height !== frame.displayHeight) {
                    cv.width = frame.displayWidth
                    cv.height = frame.displayHeight
                  }
                  const g2 = cv.getContext('2d')
                  if (g2) g2.drawImage(frame, 0, 0, cv.width, cv.height)
                }
                frame.close()
                frames += 1
                setStatus((prev) => (prev === 'live' ? prev : 'live'))
                const now = performance.now()
                if (now - lastTick >= 1000) {
                  const seconds = (now - lastTick) / 1000
                  if (frames && seconds > 0) setFps(Math.max(1, Math.round(frames / seconds)))
                  frames = 0
                  lastTick = now
                }
              },
              error: (err) => {
                setError(String((err && err.message) || err))
              },
            })
            dec.configure({ codec: 'avc1.42E01E', optimizeForLatency: true, avc: { format: 'annexb' } })
          } catch (err) {
            setError(String((err && err.message) || err))
            return false
          }
          avcRef.current = { dec, gotKey: false }
          setAvcMode(true)
          return true
        }
        const pushAvc = (buf) => {
          const state = avcRef.current
          if (!state || !state.dec) return
          const au = buf.subarray(1)
          if (!au.length) return
          const key = isKeyAU(au)
          // A decoder configured mid-stream throws on the first delta frame, so
          // hold off until the host's next keyframe arrives.
          if (!state.gotKey) {
            if (!key) return
            state.gotKey = true
          }
          auTs += Math.round(1000 / (sourceFps || 60))
          try {
            state.dec.decode(new EncodedVideoChunk({ type: key ? 'key' : 'delta', timestamp: auTs, data: au }))
          } catch (err) {
            setError(String((err && err.message) || err))
          }
        }

        // Read the surface through a ref: a new identity here would tear the
        // socket down on every status update (open -> close -> reopen loop).
        const mv = mediaRef.current
        const connect = () => {
          if (closed) return
          const scheme = location.protocol === 'https:' ? 'wss' : 'ws'
          const ws = new WebSocket(`${scheme}://${location.host}/ydesk/ws?target=${target}`)
          ws.binaryType = 'arraybuffer'
          wsRef.current = ws
          ws.addEventListener('open', () => {
            setStatus('connecting')
            setError('')
            if (window.isSecureContext && typeof VideoDecoder === 'function') {
              try {
                ws.send(JSON.stringify({ t: 'mode', mode: 'avc' }))
              } catch {}
            }
          })
          ws.addEventListener('message', (ev) => {
            if (typeof ev.data === 'string') {
              let msg = null
              try {
                msg = JSON.parse(ev.data)
              } catch {
                return
              }
              if (!msg) return
              if (msg.t === 'codec') {
                if (msg.mode === 'avc') {
                  if (!startAvc()) {
                    setAvcMode(false)
                    mv.codecRef.current = 'video/mp4; codecs="avc1.42E01E"'
                    mv.start(mv.codecRef.current)
                  }
                } else {
                  stopAvc()
                  setAvcMode(false)
                  mv.codecRef.current = msg.codec
                  mv.start(msg.codec)
                }
              } else if (msg.t === 'hello' && msg.host) {
                setTitle(msg.host.name || '')
                if (msg.fps) sourceFps = Number(msg.fps) || 0
              } else if (msg.t === 'remote') {
                if (msg.state === 'connected') {
                  setStatus('live')
                  if (msg.name) setTitle(msg.name)
                } else if (msg.state === 'closed') {
                  setStatus('connecting')
                  setError(msg.error || '')
                } else {
                  setStatus('connecting')
                }
              } else if (msg.t === 'error') {
                setStatus('error')
                setError(msg.message || '')
              }
              return
            }
            const buf = new Uint8Array(ev.data)
            if (buf.length && buf[0] === 0x02) {
              pushAvc(buf)
              return
            }
            mv.push(buf)
            frames += 1
            setStatus((prev) => (prev === 'live' ? prev : 'live'))
            const now = performance.now()
            if (now - lastTick >= 1000) {
              // The Host muxes exactly one fragment per encoded frame, so the
              // delivered frame rate is what the viewer should report.
              const seconds = (now - lastTick) / 1000
              if (frames && seconds > 0) setFps(Math.max(1, Math.round(frames / seconds)))
              frames = 0
              lastTick = now
            }
          })
          const retryOpen = () => {
            if (closed) return
            setStatus('connecting')
            retry = Math.min(retry + 1, 6)
            setTimeout(() => {
              if (!closed) connect()
            }, 400 * retry)
          }
          ws.addEventListener('close', () => {
            stopAvc()
            setAvcMode(false)
            mv.reset()
            if (!closed) retryOpen()
          })
          ws.addEventListener('error', () => {
            setError(tr('failed'))
          })
        }

        connect()
        return () => {
          closed = true
          stopAvc()
          const ws = wsRef.current
          wsRef.current = null
          try {
            ws && ws.close()
          } catch {}
          mv.reset()
        }
      }, [target])

      useEffect(() => {
        // A stalled element usually means the appended fragments restarted their
        // timestamps (encoder restart). Reconnecting makes the host resend the
        // init segment plus a keyframe, which is the only clean way back.
        let lastTime = -1
        let lastChange = performance.now()
        const id = setInterval(() => {
          const video = videoRef.current
          if (!video || video.paused) return
          let end = video.currentTime
          try {
            const b = video.buffered
            if (b.length) end = b.end(b.length - 1)
          } catch {}
          if (Math.abs(video.currentTime - lastTime) > 0.02) {
            lastTime = video.currentTime
            lastChange = performance.now()
          } else if (performance.now() - lastChange > 3000) {
            lastChange = performance.now()
            const ws = wsRef.current
            try { ws && ws.close() } catch {}
            return
          }
          const behind = end - video.currentTime
          if (behind > 0.6) {
            try { video.currentTime = end - 0.05 } catch {}
          }
        }, 500)
        return () => clearInterval(id)
      }, [])

      useEffect(() => {
        if (onStatus) onStatus({ status, fps, error, title })
      }, [status, fps, error, title, onStatus])

      // Keep the picture near the live edge: fragments arrive continuously, so
      // drift here would turn into permanent input-to-eye latency.
      useEffect(() => {
        const timer = setInterval(() => {
          const video = videoRef.current
          if (!video || !video.buffered || !video.buffered.length) return
          const end = video.buffered.end(video.buffered.length - 1)
          const behind = end - video.currentTime
          // Stay close to the live edge: a big cushion here is pure input lag.
          if (behind > 0.32) {
            try { video.currentTime = Math.max(0, end - 0.04) } catch {}
            video.playbackRate = 1
          } else if (behind > 0.08) {
            // Drain the backlog smoothly instead of seeking (seeking stutters).
            video.playbackRate = Math.min(1.25, 1 + (behind - 0.04) * 2.2)
          } else if (video.playbackRate !== 1) {
            video.playbackRate = 1
          }
        }, 200)
        return () => clearInterval(timer)
      }, [])

      // object-fit: contain letterboxes the picture, so the pointer must be
      // mapped against the drawn area, not the stage box.
      const pointOf = (ev) => {
        const stage = stageRef.current
        if (!stage) return null
        const rect = stage.getBoundingClientRect()
        if (!rect.width || !rect.height) return null
        const video = videoRef.current
        const cv = canvasRef.current
        const useCanvas = avcMode && cv && cv.width > 0
        const vw = (useCanvas && cv.width) || (video && video.videoWidth) || 0
        const vh = (useCanvas && cv.height) || (video && video.videoHeight) || 0
        let drawW = rect.width
        let drawH = rect.height
        if (vw && vh) {
          const scale = Math.min(rect.width / vw, rect.height / vh)
          drawW = vw * scale
          drawH = vh * scale
        }
        const left = rect.left + (rect.width - drawW) / 2
        const top = rect.top + (rect.height - drawH) / 2
        const nx = Math.min(1, Math.max(0, (ev.clientX - left) / drawW))
        const ny = Math.min(1, Math.max(0, (ev.clientY - top) / drawH))
        return { nx, ny }
      }

      // Previewing this machine itself would feed the injected cursor back into
      // the browser window as real mouse events, so preview is view-only.
      const allowInput = target !== 'local'

      const onPointerMove = (ev) => {
        if (!allowInput) return
        const point = pointOf(ev)
        if (!point) return
        movePending.current = point
        if (rafRef.current) return
        rafRef.current = requestAnimationFrame(() => {
          rafRef.current = 0
          const next = movePending.current
          if (next) sendObj({ t: 'm', nx: next.nx, ny: next.ny })
        })
      }

      const onPointerDown = (ev) => {
        if (!allowInput) return
        ev.preventDefault()
        const stage = stageRef.current
        if (stage && stage.focus) stage.focus()
        const point = pointOf(ev)
        if (point) sendObj({ t: 'm', nx: point.nx, ny: point.ny })
        const button = ev.button === 2 ? 2 : ev.button === 1 ? 3 : 1
        sendObj({ t: 'md', b: button })
      }

      const onPointerUp = (ev) => {
        if (!allowInput) return
        const button = ev.button === 2 ? 2 : ev.button === 1 ? 3 : 1
        sendObj({ t: 'mu', b: button })
      }

      const onWheel = (ev) => {
        if (!allowInput) return
        ev.preventDefault()
        const lines = ev.deltaY > 0 ? -3 : 3
        sendObj({ t: 'w', d: lines })
      }

      // macOS Chrome never delivers keydown/keyup for Meta itself, so holding
      // Cmd would leave the remote's Win key stuck (and Win+letter becomes a
      // shortcut instead of text). Shortcut modifiers are sent as a tap:
      // mods down, key down/up, mods up.
      const tapped = useRef(new Set())
      const MOD_CODE = { meta: 'MetaLeft', ctrl: 'ControlLeft', alt: 'AltLeft' }

      const onKeyDown = (ev) => {
        if (!allowInput) return
        const stage = stageRef.current
        if (!stage || (document.activeElement !== stage && document.activeElement !== videoRef.current)) return
        if (ev.key === 'F11') {
          ev.preventDefault()
          toggleFullscreen()
          return
        }
        if (ev.key === 'Escape' && document.fullscreenElement) return
        ev.preventDefault()
        if (ev.repeat) return
        if (ev.key === 'Meta' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Shift') return
        const modsNow = []
        if (ev.metaKey) modsNow.push(MOD_CODE.meta)
        if (ev.ctrlKey) modsNow.push(MOD_CODE.ctrl)
        if (ev.altKey) modsNow.push(MOD_CODE.alt)
        if (ev.key.length === 1 && modsNow.length === 0) {
          sendObj({ t: 'txt', v: ev.key })
          return
        }
        for (const m of modsNow) sendObj({ t: 'kd', code: m })
        sendObj({ t: 'kd', code: ev.code })
        sendObj({ t: 'ku', code: ev.code })
        for (let i = modsNow.length - 1; i >= 0; i -= 1) sendObj({ t: 'ku', code: modsNow[i] })
        tapped.current.add(ev.code)
      }

      const onKeyUp = (ev) => {
        if (!allowInput) return
        if (ev.key === 'F11') return
        if (ev.key === 'Meta' || ev.key === 'Control' || ev.key === 'Alt' || ev.key === 'Shift') return
        if (tapped.current.has(ev.code)) {
          tapped.current.delete(ev.code)
          return
        }
        if (ev.key.length === 1 && !ev.ctrlKey && !ev.metaKey && !ev.altKey) return
        sendObj({ t: 'ku', code: ev.code })
      }

      const toggleFullscreen = () => {
        const stage = stageRef.current
        if (!stage) return
        if (document.fullscreenElement) document.exitFullscreen().catch(() => {})
        else if (stage.requestFullscreen) stage.requestFullscreen().catch(() => {})
      }

      const label =
        status === 'live'
          ? tr('status.live')
          : status === 'error'
            ? tr('status.error')
            : tr('status.connecting')

      return h(
        'div',
        { className: 'ydesk-root' },
        h(
          'div',
          { className: 'ydesk-bar' },
          h('h2', null, title || tr('title')),
          h('span', { className: `ydesk-pill ${status}` }, label),
          fps ? h('span', { className: 'ydesk-dim' }, `${fps} ${tr('fps')}`) : null,
          error ? h('span', { className: 'ydesk-dim', style: { color: 'var(--dsw-alias-state-error-primary)' } }, error) : null,
          h('span', { className: 'ydesk-spacer' }),
          h('button', { className: 'ydesk-btn', onClick: toggleFullscreen }, 'F11'),
          h('button', { className: 'ydesk-btn', onClick: onExit }, tr('back')),
        ),
        h(
          'div',
          {
            className: `ydesk-stage${status === 'live' ? '' : ' empty'}`,
            ref: stageRef,
            tabIndex: 0,
            onPointerMove,
            onPointerDown,
            onPointerUp,
            onWheel,
            onKeyDown,
            onKeyUp,
            onContextMenu: (ev) => ev.preventDefault(),
            style: { outline: 'none' },
          },
          h('video', { ref: videoRef, playsInline: true, autoPlay: true, muted: true, style: avcMode ? { visibility: 'hidden' } : undefined }),
          h('canvas', { ref: canvasRef, style: avcMode ? undefined : { display: 'none' } }),
          status !== 'live' ? h('div', { className: 'ydesk-void' }, status === 'error' ? error || tr('status.error') : tr('status.connecting')) : null,
        ),
      )
    }

    function Panel() {
      const [state, setState] = useState(null)
      const [peers, setPeers] = useState([])
      const [last, setLast] = useState(null)
      const [scanning, setScanning] = useState(false)
      const [target, setTarget] = useState(null)
      const [targetName, setTargetName] = useState('')
      const [form, setForm] = useState({ host: '', port: '', pin: '' })
      const [notice, setNotice] = useState('')
      const [copied, setCopied] = useState(false)
      const [quality, setQuality] = useState('')

      const loadState = useCallback(async () => {
        try {
          const answer = await fetch('/ydesk/api/state', { cache: 'no-store' })
          const data = await answer.json()
          setState(data)
          setQuality((prev) => prev || (data.settings && data.settings.quality) || 'balanced')
          setForm((prev) => ({ ...prev, port: prev.port || String((data.host && data.host.port) || 8895) }))
          if (data.remote && data.remote.connected && !target) {
            setTargetName(data.remote.name || data.remote.host)
          }
        } catch (err) {
          setNotice(String(err && err.message))
        }
      }, [target])

      useEffect(() => {
        loadState()
        const timer = setInterval(loadState, 4000)
        return () => clearInterval(timer)
      }, [loadState])

      const scan = useCallback(async () => {
        setScanning(true)
        try {
          const answer = await fetch('/ydesk/api/peers', { cache: 'no-store' })
          const data = await answer.json()
          setPeers(Array.isArray(data.peers) ? data.peers : [])
        } catch {
          setPeers([])
        } finally {
          setScanning(false)
        }
      }, [])

      useEffect(() => {
        try {
          const saved = JSON.parse(localStorage.getItem('ydesk:last') || 'null')
          if (saved && saved.host) setLast(saved)
        } catch {}
        scan()
      }, [scan])

      const connectTo = useCallback(
        async (host, port, pin, name) => {
          setNotice('')
          if (!pin) {
            setNotice(tr('needPin'))
            return
          }
          let answer
          try {
            answer = await fetch('/ydesk/api/connect', {
              method: 'POST',
              headers: { 'content-type': 'application/json' },
              body: JSON.stringify({ host, port: Number(port) || undefined, pin }),
            })
          } catch (err) {
            setNotice(tr('failed'))
            return
          }
          const data = await answer.json()
          if (!answer.ok || !data.ok) {
            setNotice((data && (data.detail || data.error)) || tr('failed'))
            return
          }
          const label = name || (data.peer && data.peer.name) || host
          setTargetName(label)
          setTarget('remote')
          // Beginners should never retype an address: remember the last pair.
          try {
            localStorage.setItem('ydesk:last', JSON.stringify({ host, port: String(port || 8895), pin, name: label }))
          } catch {}
        },
        [],
      )

      const changeQuality = useCallback(async (next) => {
        setQuality(next)
        try {
          await fetch('/ydesk/api/config', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ quality: next }),
          })
        } catch {}
        loadState()
      }, [loadState])

      const newPin = useCallback(async () => {
        try {
          await fetch('/ydesk/api/pin', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
        } catch {}
        loadState()
      }, [loadState])

      const copyPin = useCallback(() => {
        const pin = state && state.host && state.host.pin
        if (!pin) return
        try {
          navigator.clipboard.writeText(pin)
          setCopied(true)
          setTimeout(() => setCopied(false), 1500)
        } catch {}
      }, [state])

      if (target) {
        return h(Viewer, {
          target,
          name: targetName,
          onExit: async () => {
            if (target === 'remote') {
              try {
                await fetch('/ydesk/api/disconnect', { method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}' })
              } catch {}
            }
            setTarget(null)
            loadState()
          },
        })
      }

      const host = (state && state.host) || {}
      const pin = host.pin || '······'
      const platform = host.platform || ''

      return h(
        'div',
        { className: 'ydesk-root' },
        h(
          'div',
          { className: 'ydesk-bar' },
          h('h2', null, tr('title')),
          h('span', { className: 'ydesk-dim' }, tr('subtitle')),
          h('span', { className: 'ydesk-spacer' }),
          h(
            'a',
            { className: 'ydesk-btn', href: '#', onClick: (ev) => { ev.preventDefault(); window.location.reload() }, title: 'reload' },
            '⟳',
          ),
        ),
        h(
          'div',
          { className: 'ydesk-body' },
          notice ? h('div', { className: 'ydesk-card', style: { borderColor: 'var(--dsw-alias-state-warn-primary)' } }, notice) : null,
          h(
            'div',
            { className: 'ydesk-card' },
            h('h3', null, `${tr('thisMachine')} · ${host.name || '—'}`),
            h('div', { className: 'ydesk-dim' }, platform ? `${platform} · :${host.port || ''}` : ''),
            h(
              'div',
              { className: 'ydesk-row', style: { marginTop: 10 } },
              h('span', { className: 'ydesk-dim' }, tr('pin')),
              h('span', { className: 'ydesk-pin' }, pin),
              h('button', { className: 'ydesk-btn', onClick: copyPin }, copied ? tr('copied') : tr('copy')),
              h('button', { className: 'ydesk-btn', onClick: newPin }, tr('newPin')),
            ),
            h('div', { className: 'ydesk-dim', style: { marginTop: 6 } }, tr('pinHint')),
            h(
              'div',
              { className: 'ydesk-row', style: { marginTop: 12 } },
              h(
                'button',
                { className: 'ydesk-btn primary', onClick: () => { setTargetName(host.name || ''); setTarget('local') } },
                tr('previewLocal'),
              ),
              h('span', { className: 'ydesk-dim' }, tr('quality')),
              h(
                'select',
                { className: 'ydesk-select', value: quality, onChange: (ev) => changeQuality(ev.target.value) },
                ['smooth', 'balanced', 'sharp', 'original'].map((id) =>
                  h('option', { key: id, value: id }, tr(`quality.${id}`)),
                ),
              ),
            ),
          ),
          h(
            'div',
            { className: 'ydesk-card' },
            h(
              'div',
              { className: 'ydesk-row' },
              h('h3', null, tr('lanPeers')),
              h('span', { className: 'ydesk-spacer' }),
              h('button', { className: 'ydesk-btn', onClick: scan, disabled: scanning }, scanning ? tr('scanning') : tr('refresh')),
            ),
            h(
              'div',
              { className: 'ydesk-peers' },
              peers.length === 0
                ? h('div', { className: 'ydesk-dim' }, scanning ? tr('scanning') : tr('noPeers'))
                : peers.map((peer) =>
                    h(
                      'div',
                      { className: 'ydesk-peer', key: `${peer.address}:${peer.port}` },
                      h('span', { className: 'name' }, peer.name || peer.address),
                      h('span', { className: 'ydesk-dim' }, `${peer.address} · ${peer.platform || ''}`),
                      h('span', { className: 'ydesk-spacer' }),
                      h(
                        'button',
                        {
                          className: 'ydesk-btn',
                          onClick: () => {
                            setForm({ host: peer.address, port: String(peer.port || 8895), pin: '' })
                            const input = document.getElementById('ydesk-pin-input')
                            if (input) input.focus()
                          },
                        },
                        tr('connect'),
                      ),
                    ),
                  ),
            ),
          ),
          h(
            'div',
            { className: 'ydesk-card' },
            h('h3', null, tr('manual')),
            last
              ? h(
                  'div',
                  { className: 'ydesk-row', style: { marginTop: 8 } },
                  h('span', { className: 'ydesk-dim' }, tr('lastOne')),
                  h('span', null, `${last.name || last.host} · ${last.host}`),
                  h('span', { className: 'ydesk-spacer' }),
                  h(
                    'button',
                    {
                      className: 'ydesk-btn primary',
                      onClick: () => {
                        setForm({ host: last.host, port: String(last.port || 8895), pin: last.pin || '' })
                        if (last.pin) connectTo(last.host, last.port, last.pin, last.name)
                        else {
                          const input = document.getElementById('ydesk-pin-input')
                          if (input) input.focus()
                        }
                      },
                    },
                    last.pin ? tr('reconnect') : tr('fillPin'),
                  ),
                )
              : null,
            h(
              'div',
              { className: 'ydesk-row', style: { marginTop: 8 } },
              h('input', {
                className: 'ydesk-input',
                placeholder: tr('host'),
                value: form.host,
                onChange: (ev) => setForm({ ...form, host: ev.target.value }),
                style: { minWidth: 180 },
              }),
              h('input', {
                className: 'ydesk-input',
                placeholder: tr('port'),
                value: form.port,
                onChange: (ev) => setForm({ ...form, port: ev.target.value }),
                style: { width: 70 },
              }),
              h('input', {
                className: 'ydesk-input',
                id: 'ydesk-pin-input',
                placeholder: tr('pin'),
                value: form.pin,
                onChange: (ev) => setForm({ ...form, pin: ev.target.value }),
                style: { width: 100 },
              }),
              h(
                'button',
                { className: 'ydesk-btn primary', onClick: () => connectTo(form.host, form.port, form.pin) },
                tr('connect'),
              ),
            ),
          ),
        ),
      )
    }

    return {
      inject: ['slots', 'locale'],
      apply(ctx) {
        const dict = pickDict()
        tr = (key, params) => {
          let text = dict[key] || DICT.en[key] || key
          if (params) for (const name of Object.keys(params)) text = text.split(`{${name}}`).join(String(params[name]))
          return text
        }
        const locale = ctx.get ? ctx.get('locale') : null
        if (locale && typeof locale.register === 'function') {
          try {
            locale.register('dsh-ydesk', 'en', DICT.en)
            locale.register('dsh-ydesk', 'zh', DICT.zh)
            const bound = locale.bind('dsh-ydesk')
            if (typeof bound === 'function') tr = bound
          } catch (err) {
            console.error('[ydesk] locale registration failed:', err)
          }
        }
        if (typeof document !== 'undefined') {
          ctx.effect(() => {
            const style = document.createElement('style')
            style.textContent = CSS
            document.head.appendChild(style)
            return () => style.remove()
          }, 'dsh-ydesk: styles')
        }
        const slots = ctx.get ? ctx.get('slots') : null
        if (!slots || typeof slots.register !== 'function') {
          console.error('[ydesk] slots service unavailable')
          return
        }
        ctx.effect(() =>
          slots.inject('sidebar.panellist', () =>
            slots.register(
              {
                name: 'sidebar.panellist',
                id: 'ydesk',
                order: 62,
                label: () => tr('nav.label'),
              },
              Icon,
            ),
          ),
        )
        ctx.effect(() =>
          slots.inject('main', () =>
            slots.register(
              {
                name: 'main',
                key: 'ydesk',
                label: () => tr('nav.label'),
              },
              Panel,
            ),
          ),
        )
      },
    }
  },
})
