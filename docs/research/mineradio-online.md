# Mineradio 在线播放 / 状态持久化 调研笔记

> 源码：D:\code\github\Mineradio （Electron；前端 public/js/modules/**，服务端 server.js 代理 网易云/QQ/酷狗/汽水）
> 目的：为 hertz-studio 在线播放的“快启动、稳播放、状态持久化”提供参考。逐文件增量记录（file:line）。

---

## A. 05-playback/00-api-quality-output.js（音质模型 + 输出设备）

### A1. apiJson 统一超时封装 (L2-19)
- `apiJson(url, {timeoutMs})`：用 `AbortController` + `setTimeout(abort, timeoutMs)`，`finally clearTimeout`。所有 API 调用可传 `timeoutMs`，超时直接 abort，不会挂死。

### A2. 音质枚举与归一化 (L21-42)
- 统一 5 级枚举（跨平台同一命名）：`jymaster > hires > lossless > exhigh > standard`；`normalizePlaybackQuality` 把别名（`master/svip -> jymaster`, `flac/sq -> lossless`, `320k/hq -> exhigh`, `128k/normal -> standard`）归一；未知值默认 `'hires'`。
- `normalizePlaybackQualityForProvider`：QQ 不支持 `jymaster` -> 降为 `hires`（L40）。
- `playbackQualityRank` (L119-127)：jymaster=5, hires=4, lossless=3, exhigh=2, standard=1；用于比较“是否降级”。

### A3. 每平台默认与可选项（00-state/00-core-stores.js L113-127）
```
PLAYBACK_QUALITY_DEFAULTS = { netease: 'hires', qq: 'lossless', kugou: 'lossless', qishui: 'standard', spotify: 'standard' }
netease: jymaster(SVIP,svip:true) / hires(默认) / lossless / exhigh / standard
qq:      hires('优先尝试') / lossless('稳定优先') / exhigh / standard
```
- 存储 key：`PLAYBACK_QUALITY_STORE_KEY = 'mineradio-playback-quality-v1'`（localStorage，JSON `{netease,qq,kugou,qishui,spotify}`）。
- `readPlaybackQualityPreference` (L183-218)：兼容旧格式（非 `{` 开头的纯字符串 -> 映射到所有平台）；每字段各自归一化 + 回退默认；try/catch 全兜底。
- `savePlaybackQualityPreference` (L219-221)：每次 `setProviderPlaybackQuality` 即时写 localStorage（无 debounce，值很小）。

### A4. 运行期音质上限 runtime cap (L128-166)
- `playbackQualityTrackKey(song, provider)` = `provider:id:mediaId`（id 兼容 id/mid/songmid/hash/fileHash/...，无 id 时用 `name|artist|album`）。
- `playbackQualityRuntimeCaps[key] = {provider, ceiling, reason, at}`：当服务端实际返回的音质低于请求档位时，记录该曲目的“最高可播档位”；只会往下收紧（`prev.rank <= ceiling.rank` 时不更新，L155）。
- `effectivePlaybackQualityForSong` (L145-150)：请求档位 = min(用户偏好, cap)。
- UI：超过 cap 的档位按钮 `disabled` + `cap-locked` 类，title “当前歌曲最高: xxx”（L237-266）。
- 仅内存（未持久化），因为 URL 可用性会随登录态变化。

### A5. 切换音质时热重载 (L286-316)
- `canReloadCurrentTrackForQuality`：仅当 audio 有 src、非 paused/ended、非本地曲目、provider ∈ {netease,qq,kugou} 才立即重载；否则 toast “下次播放生效”。
- 重载调 `playQueueAt(currentIdx, { qualityOverride, qualitySwitch:true, resumeAt: audio.currentTime, preserveHomeState:true })`——同一入口，靠 `resumeAt` 恢复进度。
- SVIP 门控：netease `jymaster` 需 `hasProviderSvip('netease', loginStatus)`，否则 toast 并打开登录（L279-283）。

### A6. 输出设备路由 (L560-992)
- 存储：`AUDIO_OUTPUT_DEVICE_STORE_KEY='mineradio-audio-output-device-v1'`（deviceId 字串）、`AUDIO_OUTPUT_MIRROR_STORE_KEY='mineradio-audio-output-mirror-v1'`（最多 4 个 id 的 JSON 数组，L588-597）、`AUDIO_INPUT_BRIDGE_STORE_KEY`。
- `applyAudioOutputDevice(media)` (L871-914)：对 `audio` 元素、`audioCtx`（AudioContext.setSinkId）、`uiSfxCtx` 三者分别 `setSinkId`；若 WebAudio 链路已激活（`audioReady && audioCtx && gainNode`），以 `audioCtx.setSinkId` 结果为准。`NotFoundError` 时清空偏好并保存（设备被拔掉自动回系统默认）。
- 镜像监听：为每个 mirror deviceId 创建独立 `<audio>` 元素同 src，`setSinkId` 后跟随主 audio 的 play/pause/seek/ratechange/volumechange 事件同步（L754-770），并 `setInterval(2200ms)` 时钟校正，漂移 >0.22s 时 `mirror.currentTime = audio.currentTime`（L843-845, L868）。
- `navigator.mediaDevices.addEventListener('devicechange', refreshAudioOutputDevices)`（L555-558）。

