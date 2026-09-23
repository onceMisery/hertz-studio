# Mineradio 3D 舞台 / 视觉系统调研笔记

> 目的：为 hertz-studio 用手写 WebGL2 + CSS 3D（无 Three.js）复刻 Mineradio 的舞台视觉与交互。
> 源码根：D:\code\github\Mineradio\public\js\modules\  （所有引用形如 `文件:行`）
> 增量写入，每 2-3 个文件追加一节。

---

## 1. 01-scene/00-renderer-quality.js —— 渲染器、DPR 与帧率档位

- 场景：`THREE.Scene`，背景 `null`（透明 canvas，CSS 背景在下面）(00-renderer-quality.js:2-3)
- 相机：`PerspectiveCamera(fov=45, aspect, near=0.1, far=100)` (:4)
- Renderer：`antialias:false, alpha:true, powerPreference:'high-performance'`，clearColor 0x000000 alpha 0，canvas 挂到 `#canvas-container`，`tabIndex=0`（可聚焦以接收键盘）(:177-186)

### DPR 策略 (:5-7, :126-147)
- 常量：`RENDER_DPR_CAP=1.35`，`RENDER_PIXEL_BUDGET=5.2M px`，`RENDER_MIN_DPR=0.72`
- 质量档 `renderQualityProfile()`（fx.performanceQuality: eco/balanced/default/ultra，lowSpec 由硬件探测给出）：
  | 档 | cap (lowSpec) | min | 像素预算 (lowSpec) |
  |---|---|---|---|
  | eco | 0.95 (0.88) | 0.52 | 2.4M (1.9M) |
  | balanced | 1.12 (0.98) | 0.62 | 3.8M (2.8M) |
  | default | 1.35 (1.12) | 0.72 (0.66) | 5.2M (3.6M) |
  | ultra | 1.75 | 0.85 | 7.8M |
- `getRenderPixelRatio()`：`budgetCap = sqrt(budget / (innerW*innerH))`，`dpr = clamp(min(device, min(cap,budgetCap)), min, ..)`；深后台模式（deep background）直接 `min(device, 0.30)` (:135-143)
- 负载 tier `getRenderLoadTier()`：cssPx>=7.2M 或 renderPx>=5.0M → 2；cssPx>=3.2M 或 renderPx>=3.6M → 1；否则 0 (:170-176)

### 帧率常量 (:9-19)
- `RENDER_VISIBLE_VSYNC=true`（前台可见动画走 vsync）
- idle: 72 / large 60 / huge 48；active: 90 / 75 / 60；interaction: 0(=vsync) / 90 / 75
- `RENDER_INTERACTION_HOLD_MS=900`：`markRenderInteraction(reason, holdMs)` 把 boost 截止时间推后 900ms；若前台不是固定 fps 模式则清 `renderPerfState.lastRenderAt=0` 立即渲染 (:148-166)

### 显示刷新率估计 (:39-58)
- 每 rAF 记录间隔，4..40ms 之间有效，保留最近 36 个样本取中位数 → hz clamp 48..240；`stableHz` 用 0.90/0.10 低通，跳变 >18Hz 直接跟随。

### 自适应帧成本压力 (:62-90)
- `budget = (1000/fps)*0.78`；`avgMs` EMA 0.92/0.08；avg>budget → pressure+=0.70(max 8)；avg<0.62*budget → -0.30；否则 -0.10；level = pressure>=4 ? 2 : pressure>=2 ? 1 : 0

### 自适应渲染节拍 divisor (:97-125)
- idle：displayHz>=144 且 (tier>=1 或 budgetLevel<=0) → divisor 2
- playback：displayHz>=190 且 (tier>=2 或 pressure>=1) → 2
- interaction：始终 1
- 非 interaction 额外：budgetLevel<=0 且 pressure>=2 且 hz>=118 → 至少 2；budgetLevel==1 且 pressure>=2 且 hz>=144 → 至少 2；pressure>=3 且 hz>=180 → 至少 3
- divisor 递减直到 `displayHz/divisor >= minFps`（idle 48，其他 60）

---

## 2. 01-scene/01-orbit-free-camera.js —— 轨道相机 + 自由相机

### orbit 状态 (:2-25)
- 结构：`user*`（用户拖拽目标，永久保留）、`cine*`（电影模式微偏移，叠加）、当前 `theta/phi/radius`、`baseline*`（回正目标）
- 默认：theta 0，phi 0.08，radius 6.6；phi 范围 ±0.45π；radius 2.4..14.0
- `lookAt` 向量 + `focus{active,type:'shelf-side'|'shelf-stage'|'queue', theta,phi,radius,lookAt}` 用于 hover 货架/队列时的镜头跟拍
- `glowFollowX/Y/Roll`、`beatGlow` 供节拍发光跟随
- Sonic 预设基线：`{theta 0, phi 0.18, radius 8.4}` (:26)；`BASE_FOV=45` (:29)
- 相机位置公式（球坐标，y-up）：`pos = (r*cos(phi)*sin(theta), r*sin(phi), r*cos(phi)*cos(theta))` (:284-290)

### 各预设默认轨道 `defaultOrbitStateForPreset(p)` (:208-227)
| preset | theta | phi | radius |
|---|---|---|---|
| 1 | 0 | 0.03 | 6.2 |
| 2 | 0 | 0.15 | 7.0 |
| 3 | 0 | 0.05 | 8.0 |
| 4 | 0 | 0.04 | 6.5 |
| 6 | 0.18 | 0.10 | 7.4 |
| 9 | -0.08 | 0.12 | 7.4 |
| 10 | 0 | 0.02 | 7.15 |
| 11 | 0.10 | 0.11 | 7.0 |
| 12 | -0.12 | 0.18 | 7.35 |
| SONIC | 0 | 0.18 | 8.4 |
| 其他 | 0 | 0.08 | 6.6 |
- preset 5 不应用基线（自定义）(:230)

### 回正 (:246-279)
- `dampCameraImpulseForRecenter(strength=0.36)`：cine 偏移、camPunch、beatCam 各 kick 乘以 damp
- `captureCurrentOrbitAsBaseline()`：当前减去 cine 偏移作为新基线，`centerLocked=true`

### 自由相机 freeCamera (:32-45, :454-505)
- 状态：position(默认 0,0,6.6)、yaw/pitch/roll、fov(26..72)、velocity、keys；持久化 localStorage `FREE_CAMERA_STORE_KEY`，延迟保存 720ms
- 输入：WASD 平移（相机局部系，用 YXZ 欧拉 pitch/yaw 旋转），Space 上、Ctrl 下；速度 2.35，Shift 6.2；Q/E 滚转 0.9 rad/s；鼠标 pointer lock 转向（K 回正）
- 速度平滑：`velocity.lerp(target, clamp(ease*dt))`，加速时 ease 8.2，松手 13.5；|v|²<0.0004 归零
- 回正 tween 620ms easeOutCubic，角度用 shortestAngleDelta；结束后 `syncOrbitAfterFreeCameraReset` 把位置反解为 theta=atan2(x,z)、phi=asin(y/r) 写回 orbit 基线 (:392-425, :456-479)
- 节拍震动叠加 (:367-387)：`cameraShake=clamp(fx.cinemaShake,0,1.8)`；rotation = (pitch + phiKick*shake*0.45, yaw + thetaKick*shake*0.45, roll + rollKick*shake)；沿视线前向平移 `radiusKick*shake*0.52`；FOV 冲击 `punch = max(camPunch*0.55, beatCam.punch*0.54 + radiusKick*0.16)*shake`，targetFov = fov - punch*1.75，fov 收缩时 lerp 0.24、恢复 0.12；camPunch 每帧 *0.86
- Sonic 预设歌词 lookAt (:82-103)：取 stageLyrics.group 世界坐标，x clamp ±2.4，y-0.18 clamp[-1.55,1.25]，z+0.10 clamp[-2.6,1.55]


---

## 3. 01-scene/02-beat-camera-runtime.js —— 节拍相机（beatCam）事件与 kick 合成

### beatCam 默认参数（定义在 00-state/03-beat-dj-state.js:35-55）
- `lookahead 0.075s`，`minInterval 0.500s`（beat map 事件最小间隔），`fallbackMinInterval 0.320`，`realtimeMinInterval 0.460`，`realtimeMergeWindow 0.135`
- ADSR 默认：`attack 0.028s, hold 0.030s, release 0.185s`
- 输出量：`punch, thetaKick, phiKick, radiusKick, rollKick`
- `cinemaDynamics = {avg 0, lowAvg 0, peak 0.30, scale 0.82}`（:57）；`cinemaTrackProfile.scale 1.0`

### 事件包络 `updateBeatCamera(dt)` (02-beat-camera-runtime.js:920-1015)
- 暂停时所有 kick 按 `pow(0.05, dt)`、punch `pow(0.08, dt)` 衰减并清空事件 (:922-931)
- 音频时间跳变 >0.55s → 重新对齐事件游标 (:932-935)
- 每个事件 val：smoothstep 上升 (attack) → 1 (hold) → 1-smoothstep 下降 (release)；`ease(x)=x²(3-2x)` (:66-69, :953-965)
- 取 `evPunch = val*amp` 最大者作为 lead 事件，按 `combo` 决定 kick 组合 (:974-997)：
  | combo | radiusKick | phiKick | rollKick |
  |---|---|---|---|
  | downbeat | punch*zoomAmp | -punch*0.0032 | - |
  | push | punch*zoomAmp*0.72 | -punch*0.0014 | - |
  | drop | punch*zoomAmp*0.46 | +punch*phiAmp*0.92 | - |
  | rebound | punch*zoomAmp*0.30 | -punch*phiAmp*0.22 | - |
  | accent | punch*zoomAmp*0.90 | -punch*0.0022 | sign*punch*rollAmp*(0.45+snapFlick*0.30) |
  - `sign = sin(phase)>=0 ? 1 : -1`，`phase = idx*2.399963 + (snap-low)*1.4`（黄金角散布）(:908)
  - `snapFlick = 1 - clamp((val-0.25)/0.75)`
- 平滑到 beatCam：上升快（0.72 / dj 0.82），下降慢（0.38 / 0.34；dj 0.44/0.40） (:1010-1014)
- combo 由节拍序号 `idx % 4` → downbeat/push/drop/rebound；strength>0.84 且非 downbeat → accent (:575-579, :709-710)

### 事件调度 `scheduleBeatCamera(beat, source)` (:639-918) — 非 DJ 路径的关键量
- 过滤：map 源非 primary 忽略；impact<0.18 且 strength<0.56 忽略；confidence<0.30 且 strength<0.68 忽略 (:652-654)
- tone 归一化 low/body/snap；mode: snap 若 snap>0.42 且 >low*1.18 且 >body*1.08；body 若 body>0.46 且 >low*1.12；否则 deep (:676-677)
- `amp = clamp(0.15 + strength*0.34 + confidence*0.06 + mass*0.13 + snap*0.04, 0.18, 0.72)`；map 源 `*= 0.68+impact*0.46`；deep 模式 `min(0.62, amp*1.12)`；最终 clamp 0.08..0.68 (:688-694, :853)
- `attack = clamp(0.028*(1.18-sharpness*0.55), 0.014, 0.038)`；`hold = clamp(0.030*(0.62+low*0.55+body*0.25), 0.014, 0.052)`；`release = clamp(0.185*(0.76+mass*0.56+body*0.18-sharpness*0.18), 0.110, 0.255)` (:697-705)
- `zoomAmp = 0.070 + mass*0.190 + (deep?0.095:0.018) + strength*0.045`；`thetaAmp 0.00035`；`phiAmp = 0.002 + (body?0.012 : snap?0.005 : 0.002)`；`rollAmp = snap ? 0.003+snap*0.004 : 0.0008`；再乘 dynScale 因子 (:712-718)
- combo 修饰（非 DJ）：downbeat amp*1.10 zoom*1.18 phi*0.72；push 0.84/0.88/0.62；drop 0.96/0.72/1.22；rebound 0.74/0.62/0.78；accent amp*1.14 zoom*1.08 roll*1.35 (:821-841)
- 事件 start = 命中时间 - attack（提前起振），最多保留 8 个事件（DJ 12）(:895-917)
- 实时（live）与离线 beat map 事件在 0.135s 窗口内合并为 'hybrid' (:607-637)

### 电影动态尺度 `updateCinemaDynamics` (:71-99)
- composite = energy*0.62 + low*0.38；avg/lowAvg 慢跟随；peak 衰减 0.9988 下限 0.30
- lift = smoothstep((composite - max(0.10, avg*0.82)) / max(0.18, peak-floor))
- target = 0.42 + lift*0.56 + clamp((low-lowAvg)/0.36)*0.12；安静时 *0.78；energy>0.48 且 low>0.46 时 ≥0.92；clamp 0.34..1.08；scale 上升 0.045 下降 0.022
- `cameraDynamicsScale()` = clamp(cinemaDynamics.scale * trackProfile.scale * extra, 0.18, 1.18) (:101-105)
- 曲目启动预热 `primeCinemaAfterTrackStart`：scale≥0.92，punch≥0.16，radiusKick≥0.085 (:35-47)

### 实时节拍引擎（供复刻参考的频段）(:392-605)
- 频段 RMS（byte FFT）：sub 38-74Hz，kick 52-165，body 165-420，vocal 420-2600，snap 1800-9200；`low = min(1, kick*0.86 + sub*0.42)`
- 快/慢包络 follow（tau 秒）：sub 0.018/0.064 vs 0.320/0.520；low 0.016/0.070 vs 0.300/0.540 …
- onset = subRise*0.88 + subFlux*0.66 + lowRise*1.62 + lowFlux*1.34 + 0.16*musicalOnset
- 命中输出 strength = clamp(0.24 + score*0.36 + lowPresence*0.34 + min(1.25,lowDominance)*0.07 + rmsFlux*0.95)
- tempo 锁：gap 折叠到 0.42..0.88s，tempoGap EMA(0.22 / 锁定后 0.10)，confidence +0.18/命中，每帧衰减 0.996^(dt*60)

---

## 4. 01-scene/03-focus-cinema-camera.js —— 相机主更新、焦点跟拍、电影漂移

### `updateCamera()` (:34-143)
- 优先自由相机；否则：
- 回正 recentering：ease = clamp(0.050 + dist*0.080, 0.052, 0.135)，dist 由 theta/phi/(radius/baseRadius) 差合成；完成阈值 theta/phi <0.0012、radius<0.014 且视觉已稳定（<0.0016 / 0.018）或超时 1800ms (:36-62)
- 目标姿态：focus.active → focus 目标；centerLocked → baseline+cine；否则 user+cine；lookAt 默认原点 (:65-83)
- 插值（线性 lerp 得自然缓出）：`focusEase = focus?0.16:0.10`，`radiusEase = focus?0.12:0.07`；节拍 punch>0.01 时 ease ≥ 0.12+punch*0.12 / 0.09+punch*0.12 (:85-91)
- Sonic 歌词 lookAt 时 ease ≥0.115 / 0.082 (:92-96)
- 货架焦点进出速度乘 `shelfSummonSettings().cameraEnterSpeed/cameraExitSpeed`，clamp 0.018..0.42 / 0.014..0.36 (:97-107)
- 位置：`lookAt + r*(cos(phi)sin(theta), sin(phi), cos(phi)cos(theta))`，`camera.lookAt(lookAt)`，再 `rotation.z += rollKick*shake` (:126-135)
- FOV：`punch = max(camPunch*0.55, beatCam.punch*0.54 + radiusKick*0.16)*shake`；`targetFOV = 45 - punch*2.35`（DJ 2.62）；收缩 ease 0.24，恢复 0.12；camPunch*=0.86 (:137-142)

### 焦点区 `activateFocusZone(type)` (:177-226)（portrait = 竖屏；wallpaper 预设 5 走 safe 分支）
| type | theta | phi | radius | lookAt | camPunch |
|---|---|---|---|---|---|
| shelf-side（横屏） | 0.42 | -0.12 | 4.20 | (2.32, -0.10, 0.72) | ≥0.82 |
| shelf-side（竖屏） | 0.24 | -0.06 | 5.28 | (1.08, -0.18, 0.72) | |
| shelf-side wallpaper 横 | 0.24 | 0.02 | 5.32 | (2.24, -0.08, 0.78) | ≥0.28 |
| shelf-detail 横 | 0.34 | -0.06 | 4.86 | (1.74, 0.02, 0.82) | ≥0.38 |
| shelf-detail 竖 | 0.16 | -0.03 | 5.90 | (0.62, -0.08, 0.82) | |
| shelf-stage 横 | 0 | -0.32 | 3.8 | (0, -1.7, 0.8) | |
| shelf-stage 竖 | 0 | -0.24 | 4.8 | (0, -1.86, 0.8) | |
| queue | 0.40 | 0.05 | 5.8 | (-1.2, 0, 0) | |
- `setFocusZone(type, immediate)`：hover 后延迟 260ms 激活；退出延迟 120ms（queue 用 PEEK_HIDE_DELAY）(:227-262)

### 电影漂移 `updateCinema(dt)` (:270-288)
- fx.cinema 关闭：cine 偏移每帧 *0.95
- 用户拖拽中 damp=0.25；focus 激活时节拍 damp 0.55
- `cineTheta = sin(t*0.08)*0.012*idleDamp + thetaKick*beatDamp`
- `cinePhi   = sin(t*0.06+1.0)*0.010*idleDamp + phiKick*beatDamp`
- `cineRadius= sin(t*0.04+2.0)*0.080*idleDamp - radiusKick*beatDamp*1.18`（节拍向前推近）
- 全部乘 `shake = clamp(fx.cinemaShake, 0, 1.8)`
- 常量 `CAM_PUNCH_MIN_INTERVAL 0.45s`，`CAM_PUNCH_BEAT_THRESHOLD 0.55` (:268-269)
- `recenterCamera()`：centerLocked+recentering，damp 冲量 0.32，清 pointer parallax，toast「视角回正」(:291-315)
