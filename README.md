# dsh-ydesk

在 DSH 里把另一台装了 Harness 的电脑当成一个面板来操作：局域网自动发现，跨网络经云端 Harness 中转。

- **Host 半边**：`index.js` + `lib/*`。用 ffmpeg 抓屏，输出 fragmented MP4；WebSocket 注册在 DSH 自己的
  `webServer` 上（`/ydesk/ws`），所以同源、走现有隧道与鉴权，不需要额外端口和 token。
- **Client 半边**：`client.js`。侧栏「远程桌面」入口 + 主面板；播放用 MediaSource Extensions（fMP4），
  输入用指针/键盘事件回传，不需要 WebCodecs，因此非 https 的 DSH 页面也能用。
- **输入注入**：macOS 走 `lib/helper-mac.py`（CGEventPost），Windows 走 `lib/helper-win.ps1`（SendInput）。
  注意 Windows 的 Harness 常驻在服务会话（Session 0），那里的 SendInput 落在一个看不见的桌面上，
  所以 Windows 侧会把这个 helper 用计划任务送进登录用户的会话，再通过回环 TCP 驱动它。

## 安装

```bash
dsh plugin --profile web add /path/to/dsh-ydesk -w
```

`dsh plugin add` 只装依赖，不会注册 bundle。确认 `~/.dsh/profiles/web/package.json` 里：

```json
{
  "dependencies": { "dsh-ydesk": "link:/path/to/dsh-ydesk" },
  "dsh": { "profile": { "bundles": ["...", "dsh-ydesk"] } }
}
```

重启 `dsh web` 后，侧栏出现「远程桌面」。

依赖：`ffmpeg` 在 PATH 里（或用 `YDESK_FFMPEG` 指定绝对路径）。macOS 额外需要 `swiftc`（随 Xcode 命令行工具），
用于编译 ScreenCaptureKit 抓屏 helper。

## 在两台机器上互控（局域网 / tailnet）

1. 两边都装本插件并重启各自的 `dsh web`，侧栏出现「远程桌面」。
2. 被控端打开面板，会显示本机名与**配对码**（每台不同，可「换一个」）。配对码只在本机面板可见，
   对端要连它必须知道这个码——`/info` 接口不返回配对码。
3. 主控端在「用地址连接」填 `IP` / `8895` / 对方配对码，点「连接」。局域网 IP 或 tailnet IP 都行；
   「局域网内的电脑」会把同网段广播发现的机器和 tailnet 里装了插件的机器都列出来（自动探 `:8895/info`），
   点「连接」自动填好地址与端口，只需再输一次配对码；
   对方 `8895` 需可达（Windows 首次弹防火墙时选“允许”）。
4. 连上后画面下方显示对端名称、状态与实测帧率；`F11` 全屏。
5. 连接成功后会记住上次的对端与配对码，下次打开面板直接点「一键连接」。

面板里改过的画质/帧率/码率与配对码会存到 `~/.dsh-ydesk/settings.json`，重启 DSH 后仍然生效。

### WebCodecs 快路（127.0.0.1 访问时）

页面在安全上下文里（例如通过 `http://127.0.0.1:3080` 打开本机 DSH）会自动向 Host 请求
`{t:'mode',mode:'avc'}`，Host 改为逐帧送 Annex-B 访问单元（二进制首字节 `0x02`），客户端用
`VideoDecoder` 解码后**在解码回调里直接 drawImage 到 canvas**——没有 MSE 的播放时钟和追帧逻辑。

实测（Mac 页面 ← tailnet → cyx240）：1920×1080、稳定 **57–63 帧/秒**、约 1.7 Mbps、0 解码错误；
同一条流仍保留 fMP4/MSE 兜底（非安全上下文，如直接访问 `http://100.64.0.8:3080`）。

## 参数

`cordis.patch.yml` 里的 `config`：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `port` | `8895` | 被控端监听端口（对端通过它拉流） |
| `quality` | `sharp` | `smooth`(720p/2M) / `balanced`(1600×900/4M) / `sharp`(1920×1080/6M) / `original`(原生/8M) |
| `fps` | `60` | 采集帧率（Windows 上 `gdigrab` 能跑到 60；>60 无收益，浏览器合成上限 60Hz） |
| `bitrate` | `6M` | 编码码率 |
| `pin` | 空 | 固定配对码；留空则每次启动随机生成 |
| `relay` | 空 | 云端中转地址（预留） |
| `allowLan` | `true` | 允许局域网/其他主机连接 `port`；关掉则只监听回环 |

## 协议

- 浏览器 ↔ 本机 Host：`/ydesk/ws?target=local|remote`。文本帧是 JSON 控制消息（`hello` / `codec` / `remote` / `error`），
  二进制帧是 fMP4 的 init 段或一个 fragment。
- Host ↔ Host：`GET /info`（只报名字/端口/是否需要配对码）、`GET /health`、
  `WS /stream?key=<sha256(pin:name:ydesk)[:32]>`，key 不对返回 403。
- 输入消息：`{t:'m',nx,ny}`（归一化坐标）、`{t:'md'|'mu',b:1|2|3}`、`{t:'w',d:±1}`、
  `{t:'kd'|'ku',code:'KeyA'}`、`{t:'txt',v:'文字'}`。

## 画质与实测

默认 `sharp`（1920×1080 / 60fps / 6M）在局域网或 tailnet 上的实测（Mac 面板 → Windows 被控机）：

| 指标 | 实测 |
| --- | --- |
| 分辨率 | 1920×1080 |
| 播放帧率 | ~60 fps（HUD 与 `video.currentTime` 双证） |
| 时间轴推进 | 5 秒墙钟内前进 5.00 秒（≈100% 实时，不积压） |
| 码率 | 1.8–4 Mbps（随画面变化） |
| 播放端 readyState | 4（`HAVE_ENOUGH_DATA`） |
| 输入回传 | 面板 `Cmd+R → notepad → 打字` 在被控机原样落地（见 `docs/shot-input-notepad.png`） |

### 延迟实测与瓶颈（2026-11-05）

「操作起来有延迟」分两段量：

| 段 | 之前 | 现在 | 做法 |
| --- | --- | --- | --- |
| 播放端缓冲（画面落后直播沿多少） | 290 ms | 70–95 ms | `client.js` 的 live-edge 策略：滞后 >0.32 s 直接 seek 到 `end-0.04`，0.08–0.32 s 用 `playbackRate` 1.0→1.25 平滑追（不再每 500 ms 硬跳） |
| 输入→像素（面板动鼠标 → 画面里光标动） | 290–400 ms | 中位 75–210 ms，最快 22 ms | `requestVideoFrameCallback` + 画布差分，10–12 次采样取中位 |

采集侧还有一个硬瓶颈（这台 Windows）：

- GDI 抓屏 `BitBlt` 单次 **110–123 ms**，且**与区域大小无关**（640×480 与 2560×1440 都是 ~115 ms）。
- 于是 `gdigrab` 实际只交得出 **8–11 帧/秒**，其余都是 ffmpeg 为维持 60 fps 补的重复帧（`ffmpeg -stats` 的 `dup=311 / 360` 就是证据）。HUD 的 60 fps 是**编码帧率**，不是内容更新率。
- 桌面挂在 `OrayIddDriver`（ToDesk 的虚拟显示器）上、AMD RX 6600 没接物理屏 —— 这是 BitBlt 变慢的直接原因。
- `ddagrab`（DXGI Desktop Duplication，GPU 采集）在这台机器上**直接挂死**（无任何输出）。再往下要自己写 DXGI 采集 helper（macOS 侧已经这么做：`lib/sck-capture.swift`）。

这条链路和逆向阶段用浏览器直连 Windows 时的效果一致：同一套 `gdigrab → x264 → Annex-B` 采集，
只是把 fMP4 封装从 ffmpeg 搬到了插件里（`lib/muxer.js`）。原因很实在：这台 Windows 上 ffmpeg 的
**任何容器 muxer 都只有 ~12.5 fps**（`-f mp4/-f matroska/-f mpegts/-f nut` 都一样，与分辨率、
帧率和 `-movflags` 无关），只有 `-f h264` 能跑满 60，所以容器封装必须自己做。

## 输入注入为什么要绕一圈（Windows）

Harness 在 Windows 上通常是 ssh 或服务起的，进程落在 **Session 0**：那里也有一个桌面，但没人看得见，
`SendInput` 会打进那个隐藏桌面。所以插件把注入 helper 用计划任务（`/ru <user> /it /rl HIGHEST`）送进
登录用户自己的会话，再用回环 TCP 把 `m/md/mu/kd/ku/t/w` 这些行发给它——抓屏用同一套路进 Session 1。

macOS 不需要这层：DSH 就在用户会话里，`CGEventPost` 直接生效（需要「辅助功能」授权）。

## 已知限制

- **Windows 被控端**：Harness 若以服务/会话 0 运行，`gdigrab` 没有桌面可抓（`Failed to capture image (error 5)`），
  插件会自动注册计划任务，在交互会话里起 ffmpeg。个别机器上终端防护不允许 ffmpeg 自己创建文件（`Permission denied`），
  于是改成把 fMP4 推到本机回环端口，插件侧直接读 socket。
- **macOS 被控端**：新版系统上 ffmpeg 的 `avfoundation` 抓屏可能一帧都拿不到，插件会自动编译并改用
  ScreenCaptureKit（需要「屏幕录制」授权；输入注入需要「辅助功能」授权）。
- **本机预览是只读的**：主控端和被控端是同一台机器时，注入的鼠标会回流成新的输入，形成自激，所以 `target=local`
  不转发输入事件。
- Windows 上建议只留一个抓屏进程：多个残留 ffmpeg 会抢桌面，帧率直接掉一半。插件启动前会清理自己的残留进程。

## 跨网络中转（进行中）

两台机器都能主动连出去时，用云端 DSH 上的同一插件做会合点：双方各自向云端 `/ydesk/relay` 建立出站
WebSocket，用配对码配对，云端只转发字节流、不解码。这样双方都不需要开入站端口，也不依赖 tailnet。

当前可用替代：任一侧已经能 ssh 到云端时，用 `ssh -R 127.0.0.1:<远端端口>:127.0.0.1:8895 root@cloud`
把被控端端口映射到云端，再用「用地址连接」填云端的隧道端口（配合 `ssh -L`）。

## 文件

```
index.js            Host 半边：路由、WebSocket、Capture 生命周期、RemoteView 代理
client.js           Client 半边：面板、MSE 播放、输入回传
lib/capture.js      ffmpeg 抓屏（mac SCK / win gdigrab / 交互会话兜底）
lib/sck-capture.swift  ScreenCaptureKit helper（NV12 + GPU 缩放）
lib/fmp4.js         fMP4 解析：init/fragment 切分、判断 moof 是否从关键帧开始
lib/ws.js           极简 RFC6455 服务端
lib/input.js        输入注入调度（平台分派 + 节流）
lib/helper-mac.py   macOS 注入（CGEventPost）
lib/helper-win.ps1  Windows 注入（SendInput）
lib/discovery.js    局域网 UDP 发现（8897）
```
