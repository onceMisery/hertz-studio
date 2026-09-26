# mmusic-studio

一个本地优先（local-first）的音乐服务与播放器：单个 Rust 进程负责解码、播放、曲库与歌词，浏览器（或任意 HTTP 客户端）通过 REST + WebSocket 使用它。

本地优先（local-first）：播放、曲库、歌词、歌单、设置全部在你自己的机器上完成，
断网也能用。在线曲库浏览是显式启用的附加能力，由本机服务代理解析，
不上传你的曲库、收听记录或任何个人数据。

---

## 特性

**已有**

- 真实的本地播放：`symphonia` 解码 → `cpal` 输出，支持 mp3 / flac / wav / m4a / ogg / opus / ape 等
- 播放控制：播放、暂停、停止、跳转、音量、上一首 / 下一首、三种播放模式（重复 / 单曲 / 随机）
- 自动续播：一首结束自动进入下一首
- 实时频谱：64 段 FFT，通过 WebSocket 推送（30 fps）
- 本地曲库：目录扫描、内嵌标签与封面提取、增删自动同步、标题/艺术家/专辑搜索
- 大曲库：服务端按标题 / 艺术家 / 专辑 / 添加时间排序后分页，点播使用完整筛选结果作为队列；收藏支持继续加载和跨页播放
- 音乐目录管理：添加、启停、移除目录，监听文件变化自动增量扫描；支持手动扫描、取消与失败明细，移除目录不会删除音乐原文件
- 歌词：读取音频同目录下的 `.lrc`，支持普通歌词与**逐字时间轴**（enhanced LRC），支持 `[offset:]`
- 自定义歌单：CRUD + 增删曲目 + 顺序维护
- 设置持久化（服务端 SQLite，不依赖浏览器 localStorage）
- 内置 Web UI，零构建步骤，由服务自身托管
- 沉浸式歌词舞台：逐字染色（普通 LRC 也会按字摊时间轴）、行内进度插值、
  按距离衰减的排版节奏、封面取色
- 全屏舞台 3D 视角：拖拽自由旋转、按行产生景深视差、自动漂移、双击复位；
  纯 CSS 3D，文字仍是 DOM 所以清晰、可点、可读屏
- 心象歌词模式：当前行逐词按确定性伪随机散开、旋转、变色、变字号
- 舞台粒子层：从频谱做起音检测，光尘随律动呼吸、节拍落涟漪（Canvas 2D，无依赖）
- 可选的 WebGL2 增强渲染：设置里手动开启，粒子预算提升到上万颗；带硬件警示、
  重新加载生效、以及帧率代价探测与自动降级
- 3D 歌单架：CSS 3D 扇形排布，滚轮 / 方向键 / 拖拽 / 点选切换，带曲目详情条。
  卡片是唱片封套式的：封面铺满、顶部灯边、底部渐变压字、两条绕 Y 转 90° 的
  真实厚度面，脚下还有一张随频谱呼吸的舞台地面；中心卡跟随顶拍
- 全屏舞台封面盘：可开关（设置里、或全屏舞台上的按钮随时切换，即时生效），
  双面 3D 翻转 + 透视 + 随能量呼吸，和歌词共用同一个 3D 场景因此拖拽视角时一起转
- 逐行过渡时长：每一行按自己的时长算过渡（短句几乎瞬发、长句满档），
  淡入比位移短一截；当前行另有极缓的呼吸起伏
- 混合歌单：自建歌单可同时存本地与在线曲目（元数据快照随单持久，
  重启后显示与顺序不丢），在线结果行可直接「加入歌单」，收藏全部播放
  支持本地+在线混合队列
- 歌词管理：来源优先级为手动导入 > 音频内嵌标签 > 同名 `.lrc`，
  支持在播放控制弹窗导入 `.lrc`、清除导入与每曲 ±0.5s 偏移（持久化）
- 曲库管理：专辑/歌手浏览筛选、曲目信息编辑（覆盖层，重扫保留）、
  批量编辑/收藏/加入歌单、替换封面（重扫不覆盖）、失效文件整理
- 数据备份：歌单/收藏/设置/曲库目录一键导出导入（JSON，不含凭据，
  幂等恢复），歌单 M3U 导入导出
- 在线缓存管理：占用统计、按音源清理、指定曲目保留（豁免 LRU 回收）
- 系统凭据：平台 cookie 等秘密存入操作系统钥匙串（Windows 凭据管理器 /
  macOS 钥匙串 / Secret Service），启动自动迁移旧明文数据
- 远程来源（WebDAV）：登记服务器（密码进钥匙串）、目录浏览、
  把远程音频导入曲库并以 HTTP Range 直链播放
- 音效与均衡器：六段 EQ、增益补偿、按 ReplayGain 标签的响度归一化、
  软限幅防削波、可调交叉淡化；设置即时生效并持久化
- 播放历史：分页、来源筛选与搜索，可回放
- 逐字演出感：未唱到的字退半步、正在唱的字弹起并带两层同色辉光 + 基线下光柱，
  每个字按自己的相位极缓浮动；擦除边界是软过渡带而不是硬切；
  字号上限从 42px 提到 68px 并把长行 balance 断行
- 在线曲库：音源注册表驱动（网易云 / CCmixter），搜索、详情、歌词、试听与封面
  全部由本机服务代理并归一化成同一套字段；前端的选择框与分类由
  `GET /v1/online/sources` 生成，加一个音源不用改前端
- 在线音源登录：支持填入**你自己**在该站点的账号 cookie（服务端持久化、
  永不回显原文），用于解锁该账号本来就有的检索与试听结果
- 三档性能预算（eco / balanced / high）+ 分系统帧门，弱机自动降密度与刷新率；
  3D 视角只受「减少动效」管辖，不随低性能降级一起关掉
- 本地 token 鉴权 + 只监听回环地址
- 沉浸声场：顶栏立方体按钮或 **V** 进入，提供极光、粒子隧道、点阵地形、粒子球、
  棱镜星系、共振星环和封面浮雕七种场景。频谱驱动局部形变与节拍波纹，支持拖动旋转、
  滚轮缩放、逐字歌词、播放进度与音量控制；律动、镜头和光晕强度可即时调整并保存。
  数字 **1–7** 切场景，**L** 切歌词，**F** 全屏，**K** 复位，**Esc** 返回。
- 创意舞台：三维场景 + 可编排的演出数据 + 用户工坊 + 手绘风格 + 自定义背景
  （详见 [`创意功能方案.md`](创意功能方案.md)）
  - 手写 WebGL2 内核：透视相机、深度缓冲、离屏帧缓冲与后处理链，五个音频驱动场景
    （频谱塔林 / 频谱球 / 光隧道 / 星云 / 频谱地形）
  - **零顶点缓冲**：几何全部由 `gl_VertexID` / `gl_InstanceID` 在顶点着色器里解析，
    换场景只是换一个 program 与一次 drawArrays，没有 buffer 的创建/销毁/重传
  - **频谱走纹理不走 uniform 数组**：64 段写成一张 `64×2` 的 `R8` 纹理，
    32/64/128 段配置对场景透明
  - **后处理链只用 RGBA8**：泛光 / 径向色散 / 暗角 / 颗粒 / Sobel 描边 / 程序化纸纹 /
    调色，牺牲 HDR 换来"任何支持 WebGL2 的设备都能跑"
  - **舞台是一张可寻址的参数表，不是场景图**：`cam.` / `look.` / `stage.` / `sc.`
    四种前缀，滑块、cue 轨、音频绑定、JSON 存取共用同一套寻址
  - 一帧固定四步：基础值 → 音频绑定 → 动画写入 → 钳位；手动 < 绑定 < 编排
  - **编排轨**：秒级 cue（跟歌曲进度）与节拍 cue（跟起音计数），触发时从当前实时值起算
  - **音频绑定**：参数可绑到低频/中低/中高/高频聚合、起音脉冲、整体能量；
    全部关掉就得到一张静止的舞台照片，方便先调构图再加律动
  - **自动导演**：短窗/长窗能量比判段落，切镜头与影调强度；推送的是可见、可改、可关的 cue
  - **代价探测**：三维层起来后自己量一次"这一层值多少帧"（静默窗口 vs 在画窗口的 A/B），
    太贵就一档档降渲染分辨率而不是降帧率，降到最低档仍不可接受才关掉；结论显示在工坊的
    运行状态里，用户重新拨一次开关就不会再被自动降档
  - **创意工坊**：按参数表自动生成控件，六个页签管场景 / 参数 / 编排 / 绑定 / 背景手绘 / 导出；
    一份预置就是一段 JSON，可存可导可分享
  - **一句成景（离线提示词生成舞台，首期）**：工坊高级编排里输入一句中文 / 英文描述
    （≤120 字），离线规则编译器 `creative-prompt.js` 确定性地给出**可解释**的匹配摘要
    （场景 / 氛围 / 镜头 / 质感 / 手绘 / 音乐响应 + 未识别片段 + 冲突警告），
    确认后经 `CreativeStage.applyIntent` 一次性原子应用到当前预置（切场景填默认值与
    入画机位、参数白名单钳位、保留 cue / 绑定 / 背景 / 名称，单次事件），可整体撤销；
    全程无网络、无模型、无随机数，未知词不猜测、不虚构不支持的效果
  - **手绘风格**：自写的 rough 引擎（约 80 行）实时生成抖动线条，而不是贴手绘纹理 ——
    缩放不糊、换主题自动跟色、抖动幅度是个可绑到音量的数字；用确定性伪随机保证
    相邻两帧的偏移相关，线条才是"手抖"而不是"信号干扰"
  - **自定义背景**：跟随主题 / 渐变网格 / 漩涡流场 / 频谱色谱 / 封面取色 / 本地图片视频；
    生成式背景只画到长边 384 像素再交给合成器放大并加模糊
  - 三维与原粒子层互斥（开三维时粒子层让位，**关掉时原样还回**）；
    WebGL2 不可用、上下文创建失败、着色器编译失败、运行中上下文丢失都能降级到原样，
    并把原因显示在设置页

**规划中**

- WebDAV / HTTP(S) 远程音源
- DSP 二期：升采样、参数 EQ、卷积 IR、EBU R128 响度归一化、真峰值限幅、噪声整形、交叉馈送、饱和
- Windows WASAPI 独占模式
- DBX 插件形态（同一套 UI 打包进 `ui/`）

---

## 快速开始

```bash
# 构建（需要 Rust 1.85+）
cargo build --release

# 运行
./target/release/vmusicd

# 或者一步到位，并自动打开浏览器
cargo run --release -- --open
```

启动后会打印：

```
mmusic-studio v0.1.0
  ui       http://127.0.0.1:7634/?token=…
  health   http://127.0.0.1:7634/v1/health
  discovery C:\Users\…\mmusic-studio\vmusicd.json
```

在 UI 左侧填入音乐目录 → 点「扫描」→ 点击曲目即可播放。

常用参数：

| 参数               | 说明                        |
| ---------------- | ------------------------- |
| `--bind ADDR`    | 监听地址，默认 `127.0.0.1`       |
| `--port PORT`    | 端口，`0` 表示随机空闲端口，默认 `7634` |
| `--data-dir DIR` | 数据库、封面缓存、token 的存放位置      |
| `--open`         | 启动后尝试打开浏览器                |

环境变量：`VMUSIC_BIND` `VMUSIC_PORT` `VMUSIC_BACKEND` `VMUSIC_LOG` `VMUSIC_DATA_DIR`。

---

## 架构

```
┌─ 表现层 ────────────────────────────────────────────────┐
│  内置 Web UI（零构建）· curl · 插件                       │
└───────────────────────────┬─────────────────────────────┘
                            │ REST(JSON) + WebSocket
                            │ 127.0.0.1 · Bearer token
┌─ vmusicd（tokio 多线程）───┴─────────────────────────────┐
│  routes   axum 路由 + 鉴权中间件 + 错误边界               │
│  scan     后台扫描任务，进度经事件总线广播                 │
│  state    播放队列、事件总线、discovery 文件              │
└───────────────────────────┬─────────────────────────────┘
                            │ 命令队列（单消费者）
┌─ audio actor（专用线程）───┴─────────────────────────────┐
│  串行执行所有播放命令，唯一的播放状态写入者                │
│  快照经 arc-swap 无锁发布，频谱在 actor 线程计算           │
└───────────────────────────┬─────────────────────────────┘
                            │ AudioBackend trait
┌─ 后端 ────────────────────┴─────────────────────────────┐
│  CpalBackend   解码线程 → 环形缓冲 → cpal 回调 → 声卡     │
│  NullBackend   不出声，确定性时序，供测试与 CI 使用        │
└─────────────────────────────────────────────────────────┘
```

**核心设计取舍**

| 主题     | 选择                       | 原因                                         |
| ------ | ------------------------ | ------------------------------------------ |
| 并发     | 单消费者命令队列 + `arc-swap` 快照 | 播放操作之间有严格的时序约束，用串行化代替加锁；读多写少的状态用无锁快照       |
| 音频回调   | 独立于 tokio 的 OS 线程        | 回调里 `await`、抢锁或分配内存都会爆音                    |
| Web 框架 | axum + tower-http        | tower 中间件生态、类型安全 extractor；本服务瓶颈在音频而非路由    |
| 数据访问   | sqlx 运行时校验（非 `query!` 宏） | 无需 `.sqlx/` 元数据即可离线构建，CI 更简单；所有语句由集成测试覆盖   |
| 搜索     | SQLite `LIKE`            | 几千首曲库不需要 FTS5，省掉虚表与触发器                     |
| 重采样    | 线性插值                     | 依赖轻、代码可审计；`AudioBackend` 是替换成 sinc/FIR 的接缝 |
| 前端     | 零构建原生 JS                 | `cargo run` 之后就能直接用，不引入 npm 工具链            |

---

## API

所有 `/v1/*` 请求（`/v1/health` 除外）需要 `Authorization: Bearer <token>`。
错误统一返回 `{ "error": { "code", "message", "request_id" } }`。

| 方法                  | 路径                                                 | 说明                                                   |
| ------------------- | -------------------------------------------------- | ---------------------------------------------------- |
| GET                 | `/v1/health`                                       | 版本、协议版本、后端名（免鉴权）                                     |
| GET                 | `/v1/state`                                        | 播放快照                                                 |
| POST                | `/v1/player/load`                                  | `{ track_id, queue? }`                               |
| POST                | `/v1/player/play` `pause` `stop` `next` `previous` | 播放控制                                                 |
| POST                | `/v1/player/seek`                                  | `{ position_ms }`                                    |
| POST                | `/v1/player/volume`                                | `{ volume: 0..1 }`                                   |
| POST                | `/v1/player/mode`                                  | `{ mode: repeat \| repeat_one \| shuffle }`          |
| GET                 | `/v1/devices` · POST `/v1/devices/select`          | 输出设备                                                 |
| GET                 | `/v1/tracks?q=&sort=&limit=&offset=`               | 曲库分页与搜索；sort 为 title / artist / album / added       |
| GET                 | `/v1/tracks/ids?q=&sort=`                          | 完整筛选结果的有序 ID，供全量播放队列使用                     |
| GET                 | `/v1/tracks/{id}` `/cover` `/lyrics`               | 单曲详情、封面、歌词                                           |
| POST                | `/v1/library/scan` · GET `/v1/library/status`      | 增量扫描、进度与失败明细                                   |
| POST                | `/v1/library/scan/cancel`                          | 取消正在进行的扫描                                       |
| GET/POST/PUT/DELETE | `/v1/library/roots`                                | 音乐目录列表、添加、启停、移除（DELETE 使用 path 查询参数） |
| GET/POST/PUT/DELETE | `/v1/playlists[/{id}]`                             | 歌单                                                   |
| POST · DELETE       | `/v1/playlists/{id}/tracks[/{track_id}]`           | 歌单曲目                                                 |
| GET · PUT           | `/v1/settings`                                     | 键值设置（音源凭据不在其中，见下）                            |
| GET                 | `/v1/online/sources`                               | 音源清单：id、显示名、分类、是否支持登录、当前是否已登录              |
| GET                 | `/v1/online/search?source=&q=&cat=&limit=&offset=` | 按音源搜索，返回归一化曲目                                     |
| GET                 | `/v1/online/stream` `/detail` `/lyric`             | 试听地址、单曲详情、歌词                                       |
| POST                | `/v1/online/play`                                  | 取地址 → 落盘缓存 → 用 `online:` 虚拟 id 走本地同一套播放链路 |
| POST                | `/v1/online/cookie`                                | `{ source, cookie }` 保存 / 清除用户自有账号凭据           |
| WS                  | `/ws?token=…`                                      | `state` / `spectrum` / `scan` / `ended` / `error` 事件 |

协议版本 `PROTOCOL_VERSION` 独立于软件版本演进；宿主握手不匹配时应拒绝连接而不是猜字段。

### 在线音源的边界

目前接入了网易云音乐、QQ 音乐、酷狗音乐三个平台和 CCmixter 开放曲库。对接用的
是两类东西：平台**网页端/自家客户端公开使用的端点**（含这些端点要求的请求签名，
如酷狗的 MD5 签名、QQ 的 `zzc` 搜索签名与 vkey 取流），和**用户自己账号的
凭据**（cookie 或网易云扫码登录）。平台客户端签名算法是项目所有者明确授权实现的
（设计决策 D7）：仅在用户本机、以用户本人凭据发起请求，不分发平台内容、不做
商业服务，全部代码为原创实现。

红线不变，具体不做的事：

- 不解密受技术保护措施保护的音频（DRM / CENC / 加密容器一律不碰）；
- 不绕过付费墙，也不模拟会员权益判定（VIP 歌曲在界面上如实置灰）；
- 不伪造设备指纹，也不实现平台未公开的私有付费内容接口；
- 不在服务里存放别人的账号，也不做账号池/凭据共享。

能力失败一律如实上报：某源不支持的能力返回 `404 capability_unsupported`，
聚合搜索里失败的源进 `failed` 列表而不是被伪装成空结果。

凭据的处理：`/v1/online/cookie` 写进设置表，`GET /v1/settings` 会把它过滤掉
（只回 `signedIn` 布尔），`PUT /v1/settings` 直接拒绝写这类键。服务只监听回环
地址且需要 bearer token，cookie 只会作为 `Cookie:` 头发给该音源站点自己。

加一个音源的成本写在 `crates/vmusicd/src/online/mod.rs` 的模块注释里：一个源
文件 + 注册表一行 + dispatch 一个分支，界面由 `/v1/online/sources` 的能力表
自动驱动。

---

## 配置

首次运行会在数据目录生成 `config.toml`（可直接编辑），环境变量优先级更高。

```toml
[server]
bind = "127.0.0.1"
port = 7634
expose_ui = true

[audio]
backend = "cpal"        # 或 "null"（不出声，用于测试）
volume = 0.8
spectrum_bands = 64

[log]
level = "info"          # 例如 "vmusicd=debug,vmusic_audio=info"
format = "pretty"       # pretty | json
```

数据目录默认位置：Windows `%LOCALAPPDATA%\mmusic-studio`，macOS `~/Library/Application Support`，Linux `~/.local/share`。
其中含 `vmusic.db`（曲库）、`cache/covers/`（封面）、`token`（鉴权令牌）、`vmusicd.json`（服务发现文件，宿主据此拿到端口与令牌）。

---

## 目录结构

```
mmusic-studio/
├── migrations/              数据库迁移（sqlx migrate 自动执行）
├── crates/
│   ├── vmusic-core/         领域模型、AudioBackend trait、错误分类
│   ├── vmusic-audio/        NullBackend / CpalBackend + 命令 actor
│   ├── vmusic-store/        SQLite 仓储（sqlx）
│   ├── vmusic-library/      目录扫描、元数据与封面、歌词文件查找
│   ├── vmusic-lyrics/       LRC 解析（含逐字时间轴）
│   └── vmusicd/             服务二进制：axum 路由、WS、配置、内置 UI
│       ├── src/online/      音源注册表：mod（契约+分发+缓存）· netease · ccmixter
│       └── web/             零构建的前端，由服务内嵌托管
│           ├── index.html / app.js / style.css
│           ├── stage.js / stage.css     歌词舞台（演出模式）
│           ├── onset.js                 起音检测（粒子层与三维层共用唯一一份）
│           ├── stage-control.js         舞台控制舱（参数写进 CSS 变量）
│           ├── stage-particles.js       粒子层（帧门 + 渲染器调度）
│           ├── stage-particles-gl.js    增强渲染器（WebGL2，可选）
│           ├── creative-gl.js           三维舞台内核：相机 / FBO / 后处理 / 5 场景
│           ├── creative-stage.js        编排层：预置 · 参数寻址 · 绑定 · cue · 自动导演
│           ├── creative-prompt.js       离线提示词编译器：描述文本 → StageIntent（无 DOM/存储/网络）
│           ├── handdrawn.js             手绘层（自写 rough 引擎，SVG）
│           ├── backgrounds.js           背景层（6 种来源 + 封面取色 + 本地媒体）
│           ├── workshop.js              创意工坊面板（只编辑数据，不持渲染）
│           ├── creative.css             以上四层与工坊的样式
│           ├── shelf.js                 3D 歌单架（CSS 3D）
│           └── themes.js                主题色目录
├── scripts/                 端到端冒烟脚本（smoke.sh / smoke.ps1）
│                             + check-creative.js（创意舞台契约，零依赖）
│                             + check-assets.js（前端资源接线，零依赖）
│                             + check-css-tokens.js（CSS 令牌契约，零依赖）
└── .github/workflows/       CI：fmt · clippy · test · smoke
```

---

## 开发

```bash
cargo test --workspace        # 单元 + 集成测试
cargo clippy --workspace -- -D warnings
cargo fmt --all
node scripts/check-css-tokens.js   # 前端 CSS 令牌契约（零依赖）
node scripts/check-assets.js       # 前端资源接线：include_str! ↔ 路由 ↔ index.html（零依赖）
node scripts/check-creative.js     # 创意舞台契约：逐帧解析链的 NaN / 降级路径（零依赖）
node scripts/check-creative-prompt.js  # 提示词编译器契约：词典 / 冲突 / 否定 / 边界（零依赖）
```

**创意舞台的验证边界**：三维舞台跑在浏览器里，CI 上起不了 WebGL。但真正容易出错的地方
不是 GLSL 的渲染结果，而是两件事：

1. **每帧的参数解析链** —— 基础值 → 音频绑定 → 动画 → 钳位，四步里任何一步把值算成
   `undefined` 或 `NaN`，画面就整块变黑，而浏览器不会报任何错。
2. **GLSL 里静态可见的那一半** —— 引用了一个从未声明的 uniform，GL 只回一句
   "use of undeclared identifier"，不带上下文；`decl` 里声明了但从没在 `setup()`
   里赋值，参数永远停在 0，表现为"旋钮拖了没反应"；片元里的 `in` 在顶点没有同名
   `out`，链接才失败；用了 GLSL ES 3.00 的保留字（`half` 是最容易顺手写出来的一个），
   或者不带花括号的 `if` 后面跟了第二条语句 —— 这两类只要出现在 `GEOM` / `COMMON`
   这段五个场景共用的前导里，就是**五个场景一起编译不过**，而 `warmUp()` 为了
   "单个场景坏掉不影响其它"把异常咽了，症状于是推迟成"第一次切进某个场景，
   整个三维层静默降级"。

`check-creative.js` 对这两类各查一遍：只替换 GL 引擎、把 DOM 补成最小桩，把参数解析链
按帧跑 900 次逐帧断言每个数字都是有限值（并对账渲染次数）；对 5 个场景与 4 个后处理
pass 做上面那一条的 GLSL 静态校验；再用三台"假机器"跑一遍代价探测的决策表。
共 196 条断言 / 14 组。

脚本里的时钟是**可推进的假时钟**：用真实 `Date.now` 的话，几百次同步 tick 只过去几毫秒，
导演的 250ms 采样节流永远不会触发 —— 测试会"通过"，但什么也没验到。

**仍然要靠真机确认的**：GLSL 能否真正编译通过、画面是不是黑的、以及不同 GPU 上的帧率。
这四步（拼源码编译 / 真链接 / 读 scene FBO 统计亮像素 / 读 `stats().probe`）的具体做法
和实测数字记在 [`创意功能方案.md`](创意功能方案.md) §8.4 —— 这一轮就是靠它发现
"契约检查全绿，但一个场景都画不出来"。前提是一个**可见的**浏览器窗口：
后台标签页里 `visibilityState === 'hidden'`，`requestAnimationFrame` 完全停转。

前端是零构建的原生 JS/CSS，但 `crates/vmusicd/web/` 下的 CSS 有一层约定需要守：
`style.css` 与 `stage.css` 都在 `:root` 上声明变量，后者在 `<link>` 里排在后面，
**同优先级整块覆盖**。因此共享令牌（`--glass-*`、`--hover`）只允许由 `style.css`
的 `:root` 定义，且 `--glass-border` 是 `1px solid <color>` 完整简写、
`--glass-shadow` 是完整阴影列表 —— 不能再拼接 `1px solid` 或 `0 8px 28px`。
违反时页面不报错、也不缺元素，只会静默丢掉描边和投影。
`scripts/check-css-tokens.js` 把这条契约变成断言。

**没有声卡也能开发**：

```bash
cargo run -- --port 0         # 后端自动降级为 null
VMUSIC_BACKEND=null cargo test
```

`NullBackend` 用墙上时钟驱动完整状态机，因此播放/暂停/跳转的时序逻辑无需音频设备即可验证。
也可以关闭 `playback` feature 只编译 null 后端：`cargo build --no-default-features -p vmusic-audio`。

端到端验证（构建 → 启动 → 调 API → 关闭）：

```bash
bash scripts/smoke.sh 7899        # macOS / Linux
pwsh -File scripts/smoke.ps1 7899 # Windows
```

---

## 路线图

- **P1（已完成）** 可运行骨架：播放、频谱、曲库扫描、歌词、歌单、Web UI
- **P1.5（已完成）** 在线曲库：音源注册表、代理归一化、落盘缓存、自有账号 cookie
- **P2（已完成）** 远程音源：WebDAV 管理/浏览/导入，HTTP(S) Range 直链播放，
  凭据存入系统钥匙串
- **P3 一期（已完成）** 六段 EQ、ReplayGain 响度归一化、软限幅、可调交叉淡化。
  二期保留：升采样、卷积 IR、噪声整形
- **P4** DBX 插件形态：sidecar 拉起本服务，同一套 UI 打包进 `ui/`
- **P5（已完成）** 歌词舞台：消费播放时钟、歌词时间轴、频谱与主题四契约的自研演出模式
- **P6（已完成）** 舞台粒子层与 3D 歌单架：沿用 P5 的四契约与帧门调度，不新增依赖
- **P7（已完成）** 创意舞台：三维场景与后处理链、可编排的演出数据（参数表 + cue 轨 +
  音频绑定 + 自动导演）、创意工坊、手绘风格、自定义背景。仍然是**零运行时依赖、
  零构建步骤** —— 三维内核是手写的 WebGL2，手绘线条是自写的 rough 引擎
- **P8** 创意舞台二期：旋律轨迹（服务端基频估计）、录制回放、三维歌词排版、色谱进度条。
  其中第 14 项"离线提示词预置"的首期（工坊「一句成景」：离线规则编译器 +
  `StageIntent v1` + `applyIntent` 原子写入口）已完成；旋律轨迹与录制回放各自独立立项，
  DBX 见 P4

---

## 许可

本项目采用 **MIT 许可**，见 [`LICENSE`](LICENSE)。

第三方依赖与致谢见 [`NOTICE`](NOTICE)。每个源文件头部均带有 SPDX 许可标识。
