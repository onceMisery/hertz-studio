# 2026-10-07 凝彩/商籁「高级感」优化 —— 证据

参考 VCPChat 上游音乐舞台（Musicmodules/music-stage-*）的设计语言调研结论：其「高级感」签名是
**频段驱动**（bass 推缩放、vocal 推辉光）+ 四层背景栈 + 逐字入场。本项目 `resolveAudioBands`
每帧已算出五频段，但两个舞台此前只消费 power/impact —— 本轮补上这一层，并把各自母题推深。

## 改动

共享引擎 `stanza-sonnet-fx.js`：
- `createPerformance` 状态新增平滑 `bass/vocal/treble`（5/s 指数平滑；切歌/seek 复位直接吸附）。
- `createHalation` 强度吃 vocal（人声推溢光，`+vocal*0.22`）。
- `buildAtmosphere.update` 增加可选第 4 参 vocal，柔光随人声上浮。
- 新增纯函数 `singingGlyph(nodes,time)`（正在唱的字素，0.35s 拖尾）与 `createVocalGlow`
  （加色混合柔光垫在 textContainer 最底，跟随当前字素，亮度吃 vocal/energy）。

商籁 `stanza-sonnet.js`：接入 vocalGlow；巨型水印字吃 bass 呼吸（+bass*0.05）；扫描扇区吃
treble 亮度；HUD 增加 `VOX n%` 读数；新增 `NEXT ▸` 下一句预告行（DOM 左下，`--fl-sonnet-secondary`
着色，≤760px 收敛到 16px/46vw）。

凝彩 `stanza-tempera.js`：新增 `sweepGlow`（扫光带辉光版，add 混合，亮度吃 vocal）；色版
「套色错版」—— 每块非底板色版种子化 `rgx/rgy ∈ {-1,0,1}`，起音时沿它滑出 `kick*0.9%` 画幅再弹回；
漂移振幅吃 bass。`stanza.css` 增加 `.fl-sonnet-next`。

## 验证

Node 契约（全部通过）：
- `check-stanza-sonnet.js` 全部通过（新增 §9 频段平滑/复位吸附、§10 singingGlyph 选字/拖尾/空格不挂光）
- `check-stanza-tempera.js` / `check-stanza-motion.js` / `check-stanza.js` / `check-sonnet-palette.js`
  （1083 组色相，活动字最低对比 7.26:1）/ `check-css-tokens.js`（1846 规则）/ `check-assets.js`（686/686）
  / `check-creative.js`（341/341）

浏览器实测（playwright shim + chrome channel）：
- `check-stanza-visual-fx.js` 全部通过：sonnet/tempera × 1440x900/390x844 × t=6500/13500，
  无未捕获异常、无 shader 编译告警；新增断言「人声辉光层已建」「扫光辉光层为加色混合」均 PASS；
  图片模式商籁 ≥96% 像素透明、凝彩色块更实。截图 `output/stanza-fx-verify/`。
- `check-stanza-motion-browser.js` PASS（playback/pause/seek/handoff/reduced/eco/destroy）。
- 全应用（隔离实例 `VMUSIC_BACKEND=null target-verify/debug/hertz-studio.exe --port 18774
  --data-dir output/stanza-premium/data`，含本轮改动的重建二进制）：
  - `check-workshop-stanza-lock.js` 全 PASS（商籁接管时工坊 4 模板/5 控件/3 历史禁用，声场卡仍可选）。
  - `check-stage-visual-browser.js` 前 5 项 PASS（球面渲染/相机旋转/中性主题彩色调色/壁纸独立保存/
    重载持久），**第 6 项失败：390px 视口 `scrollWidth 394 > innerWidth 390`**。逐元素探针定位溢出
    来自主页 chrome（top-right/col-tools/daily-tools/ts-wall-img），与 stanza 层无关
    （`.fl-sonnet-next` 不在溢出列表）；并行会话正在改主页文件，非本轮范围。
- 视觉验收：visual-judge 子代理本会话不可用（provider-not-found），按协议降级自检 11 张截图
  （8 张 harness + 3 张真应用）：构图/可读性/质感均成立，anime 模式下 NEXT/VOX 元素以正确
  亮度出现。代表截图见 `screenshots/`。

## 未提交原因

工作区混有并行会话对 `stanza-sonnet-fx.js`（段落镜头池）、`stanza-tempera.js`（段落构图池）、
`stanza-starborn.js`（重写）、`stanza.css`、主页 chrome 等的未提交改动，pathspec 提交会把这些
一并扫入。本轮全部改动留在工作树，由用户决定合并提交。

---

# 第二轮（同一会话续做）：流光与星诞 + 一组真 bug

## 12. 改了什么

**星诞——把「重复但升级」的承诺补完整。** 导演设计里写「副歌第二次到来沿用同一张脸，
只把景别与力度抬一档」，曲式层确实把升级烘进了段落 `openness/intensity`（bump =
min(0.16,(visit-1)*0.08)），但它的全部消费者是 DOM 镜头机架与遮幅——**商籁/凝彩的 Pixi
相机根本看不见 visit**，而副歌的主力模式恰恰是这两个。补法：`FX.chorusLift(section)` 用
**同一个 bump 公式**（两处各写一个数迟早漂移）出口，商籁（motion*2）与凝彩（motion*1.6）的
`cameraIntensity` 乘上它。行级驱动、确定性不变，星诞模式与单独选商籁/凝彩都生效。

**流光——第一次接上音频反应。** 此前它对频谱零反应（呼吸是固定 7s 的 CSS 动画）。现在
classic 每帧算一次频段均值，写 `--fl-vocal`（vocal*0.78+power*0.22）与 `--fl-bass` 两个
CSS 变量（0.015 死区防样式系统空转），CSS calc 消费：辉光透明度 `calc(0.78+vocal*0.4)`、
字身 `scale(calc(1+bass*0.024))`。宿主选择刻意避开了所有已被占用的属性（.fl-glow 的
opacity 空着、.fl-body 没有 transform），不与入场/旋转动画抢；`data-rm~="lyrics"` 与
`.s3d-reduced` 两处降级都钉死在基准位。

**顺带抓到一组真 bug（经典的「契约沙箱 mask 掉浏览器死亡」）：** 引擎 UMD 的实际导出名是
`StanzaSonnetFx`（小写 x），而 stage3d 的电影层（bands/onset）与星诞导演（`var FX =`）都在用
大写 `StanzaSonnetFX`——**在真实浏览器里是 undefined**。后果：星诞打分的音频证据在真机上
恒为全零（只剩文本结构 + 种子抖动在选模式）；电影层的起音冲击/色散 `--s3d-kick` 恒 0。
check-stanza-starborn 的沙箱此前**手工注入大写别名**把这件事 mask 成了全绿。三处拼写修正，
契约沙箱改为按真实导出名装载，并钉住「剥注释后的代码不得再出现大写拼写」。

## 13. 证据（第二轮）

```
check-stanza-starborn   160 项 0 失败（+chorusLift 下传/公式同源/拼写钉死；沙箱改真实导出名）
check-stanza-sonnet     全部通过（+§11 chorusLift 七条：非副歌回 1、首访不抬、1.08/封顶 1.16）
check-stanza-tempera/motion/stanza/palette/css-tokens/lineage-names/stage-cinema(114)/
stage-control(89)/frame-gates(37)/creative(341)  全绿
check-stanza-visual-fx  全部通过（新增 classic 块：词挂载/状态机/--fl-vocal=0.836/--fl-bass=0.850/
  bodyT=matrix(1.0204)（恰为 1+0.85*0.024）/辉光透明度/降级两处钉死；harness 补加载真 stanza.css）
check-frontend --extra  剩 2 失败均为并行会话在途工作：check-assets 的 search-history.js 路由未挂、
  check-skins 的搜索历史持久化 3 条（skins.js/index.html 非本轮改动文件，探针确认与 stanza 无关）
```

全应用（重建 target-verify 二进制，1747 后含全部内嵌资源）：
- `check-workshop-stanza-lock.js` 全 PASS。
- 真机探针（fixture 曲 + seek 6s + 星诞）：**导演冷启动并把画面切给商籁**（select 值变 sonnet、
  Pixi 画布挂载、遮幅/NEXT/VOX 齐），流光 9 词挂载、变量 0.000（null 后端无频谱——诚实值），
  零页面异常。截图 `screenshots/app-starborn.png`、`app-classic.png`、`classic-1440x900.png`。
- 视觉自检：星诞+壁纸构图完整；流光当前词辉光清晰、散布排版成立。评审子代理仍不可用（同第一轮）。

## 14. 未提交原因（不变）

同第一轮：工作树混有并行会话未提交改动（本轮还叠加了它们在 index.html/skins.js 的
search-history 半成品），全部留在工作树由用户合并提交。

---

# 第三轮（同一会话续做）：真歌暴露的三件事 —— 心象叠字、商籁重影、彩色氛围褪成黑白

## 15. 现象与根因（真歌复现：网易云《让一切随风》，彩色氛围背景，矿石黑默认主题）

用真歌在 18774 隔离实例逐视觉截图复现（t=18s 元数据行 / t=189s 主歌）：

| 现象 | 根因 |
| --- | --- |
| 心象「野克」叠字 | 心象排版器只保证**基准位**零碰撞；入场横扰 ±0.45em 与唱后漂移 ±0.25em/±24° 叠上去后，相邻已唱字重新相撞 —— 漂移的相对幅度（≤0.09em）超过基准间隙富余 |
| 心象构图破碎 | hero 选词选中「一」（独笔画）当强调字、且 <8 单元的短句也强制 hero 独占一行，六字句被拆成三行摊满整屏 |
| 商籁「歌词重叠」 | 巨型水印字的文本就是当前句前 8 字、位置又在画面中心 —— 与正文/站点**同位叠印**，读作同一句词的双重曝光 |
| 彩色氛围全黑白 | stage3d 用 `StanzaTheme.resolve()` 的主题色覆写场景三色（--fl-scene-*），而 resolve() 在中性主题（矿石黑的近白 accent）下回退到白灰 DEFAULT；「彩色氛围」这个选项名承诺的是颜色 |

## 16. 修复

- `stanza-textlayout.js`：hero 候选排除独笔画/标点（`heroEligible`，全 trivial 回退原选择）；
  hero 独占一行收窄到 ≥8 单元的长句；入场横扰 ±0.45em→±0.18em；唱后漂移改成**余烬式**——
  全组同向（右下）、低方差（相对漂移 ≤0.036em，小于基准碰撞带富余 bandOf 的 +2px）、
  转角 ±24°→±4.5°。方差是数学边界：任何更大的随机方向漂移都会重新撞上邻居。
- `stanza-sonnet.js`：水印巨字基线从画面中心（0.5h−20px）移到上带 0.24h，漂移幅度同步收敛
  —— 它现在是背景肌理，不再与正文/站点抢同一块画布。
- `stanza-theme.js`：`resolve(reactivity, colorfulFallback)` 增加显式彩色回退 —— 中性源色 +
  colorfulFallback 时返回 `stage-nocturne`（夜曲蓝调：accent hsl(198,66,71)，与商籁中性回退
  同族，对比度过 checkPalette 全部阈值）；不传 flag 行为不变（P2 白灰，非氛围模式的既有语义）。
- `stage3d.js`：`applyStanzaConfig` 在 `stanza.bgMode === 'atmosphere'` 时传该 flag ——
  彩色氛围模式下场景三色与歌词辉光必然有彩色；有色主题/封面取色路径不变。

## 17. 证据（第三轮）

```
check-stanza            全部通过（+§12 排版姿态边界：hero 排除独笔画/标点、入场 ≤0.2em、
                        漂移同向有界、转角 ≤±4.5°、满漂移位形零重叠、短句 hero 同行、长句 hero 独行保留）
check-sonnet-palette    PASS（+resolve(1.35,true) 夜曲回退：彩色/对比度过 checkPalette/无 flag 行为不变）
check-stanza-sonnet/starborn/tempera/motion/css-tokens/assets/creative/stage-cinema  全绿
```

真歌复验（同一首《让一切随风》、同两时刻、彩色氛围、矿石黑主题，重建二进制后）：
- 心象 t18：单行连贯斜排，作曲灰鬼影+蓝色冒号+hero 大，零重叠；t189：整句一行、
  已唱字余烬式淡出、活动字蓝色辉光。
- 商籁 t18/t189：水印移至上带，站点/正文/水印三层不再同位叠印。
- 流光 t189：活动字蓝色辉光（此前白灰）。
- 星诞 t189：导演切到商籁社论轨，蓝调氛围+遮幅+NEXT/VOX 齐。
- 截图 `screenshots/t18-cadenza.png`、`t189-cadenza.png`、`t189-sonnet.png`、
  `t189-classic.png`、`t189-starborn.png`（修前对比见上一节与本轮 git 历史）。

复现探针要点（下轮可复用）：真歌走 `GET /v1/online/search?source=netease&q=…` →
`POST /v1/player/load {track_id:"online:netease:<id>"}`；**stanza 背景样式/商籁调参持久化在
服务端 settings，localStorage.clear() 不复位** —— 复现要显式 `Stage3D.configure({stanzaBg:…})`。

## 18. 未提交原因（不变）

工作树仍混有并行会话未提交改动，全部改动留在工作树由用户合并提交。实例（18774，cpal 真声卡）
以修复后的二进制运行中，token 未变。

---

# 第四轮（同一会话续做）：「全屏控制按钮不隐藏」—— chrome 豁免位卡死

## 19. 现象与根因

用户报告：进舞台后顶栏/场景坞/播放坞一直不消失。排查发现自动隐藏机制本身存在且健康
（`pokeChrome` + `s3d-chrome` 类，静止 2.6s 摘除；播放中纯空闲 4.2s 实测 head/dock/player
全部淡出）——真凶是**豁免位**：

- chrome 的隐藏定时器回调里有一句 `root.querySelector('.s3d-head:focus-within, …')` 豁免：
  鼠标点过播放/暂停/全屏任意按钮后，焦点残留在按钮上（`:focus-visible` 为假），这句豁免
  从此恒真 → chrome 被永久钉住。用户「点一下播放再欣赏」的常规路径必然踩中。
- 排查中的两次误诊记档：① 探针在**无曲目**时点 `#s3d-play`，`play()` 按「去曲库选歌」
  语义关台（正确行为），我量到的是已关舞台的残留 class，误判成焦点钉住；② MutationObserver
  把同批 add/remove/add 记成多个「+」，看不出交错。教训：探针必须带真曲目、用 MutationObserver
  断言交错不可靠，包一层 setTimeout/clearTimeout 看调度/执行计数才是决定性证据。

## 20. 修复与证据

- `stage3d.js`：豁免抽成 `chromeKeyboardFocus()` —— 只有 `:focus-visible`（键盘 Tab 来的
  焦点）才豁免自动隐藏；鼠标点击残留的焦点不再钉住 chrome。设置/工坊模态、拖拽中的豁免不变。
- `scripts/check-3d-interactions.js` +5 项（66 全过）：鼠标残留焦点 → 静止后隐藏；
  键盘焦点 → 保留；设置面板打开 → 保留；拖拽中 → 保留；pokeChrome 源码不再含 `:focus-within`。
- 真机复验（重建二进制 + 真曲目 + `page.click('#s3d-play')` 后静止 3.8s）：
  `chrome:false, head opacity 0`；鼠标一动即恢复。播放中纯空闲同样隐藏（截图
  `screenshots/immersed-playing.png`）。
- 回归：check-stage-cinema / check-stage-backgrounds / check-frame-gates / workshop-lock 全绿。

## 21. 用户验收（第四轮）

进舞台后**不要动鼠标**，2.6 秒起顶栏/场景坞/播放坞/品牌角标整体淡出（沉浸模式）；动一下鼠标
或按任意键整组唤回。点过任何按钮后再静止，同样会隐藏（这是本次修的行为——之前点过按钮就再也不藏）。
