# 局域网一起听 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use subagent-driven-development for isolated implementation tasks, with separate specification and quality reviews. The controller integrates dependent application changes in this session.

**Goal:** 交付本地歌曲原生 LAN 房间、电脑接收端及可操作界面，包含音质、身份、权限、生命周期和错误恢复闭环。

**Architecture:** 按已批准的 `docs/lan-listening.md` 执行。AppState 唯一拥有业务队列，audio actor/RenderCore 唯一拥有渲染时间线，Receiver 唯一拥有设备输出；网络只传版本化投影与 PCM。独立 TLS listener 不复用旧全权 API，接收端 Rust 固定证书指纹连接，页面只访问本机鉴权 API。

**Tech Stack:** Rust/Tokio/Axum/rustls、Symphonia/CPAL/Rubato、SQLite、现有原生 JS/CSS。

## 约束与决策复核

- 用户已要求完整实施，沿用已批准设计，常规实现无需重复批准。原工作区同时开发桌面/场景，交付在 `codex/lan-listening-delivery` 独立工作树完成，已带入九项 review 修复。
- First principle：不同电脑按照同一可听时间线输出同一渲染结果。不可用 UI 进度模拟音频同步。
- 删除历史假设：主机必须有声卡、浏览器在线人数等于音频租约、下载原文件分别解码即可同步。
- owner/retirement：抽取既有混音和 DSP，CPAL 成为本地输出适配；不长期保留第二套混音器。AppState 的旧写入口统一执行模式门禁。传输/设备/聊天各有有界生命周期。
- 反证：主机无声卡；两个独立实例；控制或音频单连接失效；慢端；旧会话；连续 seek/next/pause；聊天磁盘失败；关闭全部 UI。每项均须有测试或实机证据。
- 验收区分源码与设备证据：当前 Windows 主机执行可运行的测试；CI 验证三平台构建；真实三平台声学矩阵不以模拟结果冒充。

## Task 1：公共渲染所有者

**Files:** `crates/vmusic-audio/src/render.rs`, `cpal_backend.rs`, `lib.rs`, `crates/vmusic-core/src/audio.rs`。

- [ ] 把已有解码、双 deck、fade、EQ、limiter 与谱分析收敛到无设备依赖的 RenderCore；CPAL 后端只拥有设备和 stream，并调用同一渲染方法。
- [ ] 稳定的公共接口如下；构造不枚举/打开设备，配置检查在开始前完成，渲染回调不分配和阻塞。

```rust
pub struct RenderFormat { pub sample_rate: u32, pub channels: u16 }
impl RenderCore {
    pub fn new(format: RenderFormat) -> Result<Self, vmusic_core::AudioError>;
    pub fn render(&self, output: &mut [f32]);
}
```

- [ ] 用真实 PCM/压缩夹具测试 load/play/pause/seek、EOF、下一曲、crossfade 和已有回调零分配/锁争用行为，保留单机契约。
- [ ] 执行 `cargo test -p vmusic-audio --lib`；完成后分别进行 spec/quality review，再提交限定路径。

## Task 2：版本化传输与时钟

**Files:** 新 `crates/vmusic-lan/{Cargo.toml,src/lib.rs,src/protocol.rs,src/clock.rs,src/buffer.rs,src/identity.rs}`。

- [ ] PCM 二进制固定头，显式 little endian、版本、实例/房间/会话、epoch/sequence/frame/format。以十进制字符串序列化 JS 可见 u64。
- [ ] 校验整数溢出、消息总长 <=64KiB、有限 f32、连续帧、旧会话和重复序号；借用/Arc 样本块按每端/全局预算管理。

```rust
assert!(decode_pcm(&[0; 12]).is_err());
assert!(validate_payload(960, 2, 960 * 2 * 4).is_ok());
assert!(validate_payload(u32::MAX, 2, 0).is_err());
```

- [ ] 使用四时间戳与 RTT/MAD 样本筛选、长期频偏估计和阶跃重建；平台单调钟统一纳秒，不把 wall clock 用作播放钟。
- [ ] `cargo test -p vmusic-lan` 覆盖协议畸形输入、字节往返、容量边界及时钟抖动/阶跃。

## Task 3：TLS、发现、配对与权限

**Files:** `vmusic-lan/src/{tls.rs,discovery.rs}`, `crates/hertz-studio/src/room/{mod.rs,identity.rs,members.rs,listener.rs}`。

- [ ] 服务 profile 持久证书，实例/房间/会话独立身份；接收端校验证书指纹与握手证明，不禁用证书校验。
- [ ] 邀请含至少 128bit 单次秘密，5min 期限、原子消费；限制并发握手/成员数、来源与全局配对速率。成员凭据独立撤销，秘密不进查询串、日志或房间快照。
- [ ] 手工地址与 mDNS 都只提供发现信息；已核验身份才能授予权限。长期客户端凭据使用既有系统钥匙串，不回退明文。
- [ ] 权限对每个请求、音频连接、资源访问持续检查；无授权路径/在线 ID 均拒绝。
- [ ] TLS loopback 集成测试：错误指纹失败、重复邀请失败、过期/满额失败、撤权关闭两条连接。

## Task 4：有界广播与接收调度

**Files:** `vmusic-lan/src/{server.rs,client.rs,receiver.rs}`, `vmusic-audio/src/{output_clock.rs,receiver_output.rs}`, `hertz-studio/src/room/playback.rs`。

- [ ] 房间定速 producer 使用 Task 1 的 RenderCore；主机本地音频经过同一 Receiver 缓冲，所有设备输出只应用本机音量。
- [ ] 每20ms PCM 带房间帧时间；复用 PlanScheduler/ReceiverGate 的准备、Ready、Commit、冻结前缀和代际门禁。
- [ ] 接收端以实际设备时钟/排队期限调度，转换在工作线程，回调只取预分配队列。动态重采样连续相位，播放截止用有理数计算。
- [ ] 两条连接任一失效先静音并清理；重新获取实例/会话、对时及未来加入点，不追播。慢端隔离，保留窗受3秒/8MiB与64MiB全局约束。
- [ ] 虚拟设备集成测试并复用 WASAPI 回录；`cargo test -p vmusic-lan -p vmusic-audio`。

## Task 5：业务唯一入口与生命周期

**Files:** `hertz-studio/src/{state.rs,state/viewers.rs,bootstrap.rs,routes.rs,rpc/playback.rs}`, `src/room/{commands.rs,projection.rs,leases.rs,resources.rs}`。

- [ ] AppState 保持唯一队列；房间快照按呈现边界投影，历史/歌词不能跟 render head 提前。旧HTTP/RPC/AI/内部自动推进全部经过模式门禁。
- [ ] 播控、队列、循环/随机、总音量/DSP、分享范围变更使用统一串行裁决与 revision；操作结果支持查询与过期水位。
- [ ] 成员仅收到白名单元数据和不透明资源 ID；全部共享曲目读/起播/后继预备都重查分享授权。
- [ ] 音频租约1秒续期/5秒过期，最后音频端离开有3秒宽限；UI 断连不终止健康音频端。结束房间撤销全部授权，离开不自动叠播原队列。
- [ ] 运行现有 HTTP/RPC/AI 播控集成检查与新增房间模式测试，阻止旧入口绕过。

## Task 6：聊天与有界历史

**Files:** `vmusic-store/src/room_chat.rs`, `hertz-studio/src/room/chat.rs`。

- [ ] 纯文本200字符/800字节，可信成员身份，独立消息序号与操作命名空间；每成员1/s burst3、全房间10/s burst10。
- [ ] 独立 SQLite 文件/page 上限，默认10k条/7天/64MiB三限额，预留写与维护空间；删除、清空、仅实时、崩溃恢复和磁盘满明确行为。
- [ ] 控制连接低优先级聊天队列64条/128KiB，音频与Commit不被聊天拖停。历史分页100条/256KiB。
- [ ] 测试三种淘汰条件、去重、磁盘满、重连游标、身份权限和 XSS 文本投影。

## Task 7：完整前端操作

**Files:** `plugin/ui/{room.js,room.css,index.html,app.js}`。

- [ ] 原生 JS 模块拥有房间 UI 状态，不再往 app.js 堆业务；本机服务 API 客户端与 DOM 展示分离。入口支持创建/发现/邀请加入，显示真实连接进度和失败。
- [ ] 房间主页共享歌曲/歌词/队列；设备列表与本机声卡/音量/补偿；房主邀请/分享范围/权限/移除/结束；聊天列表与有界弹幕、禁言/删除/空间管理。
- [ ] 前端只按服务器授权和操作终态显示；不乐观伪造同步成功，不把凭据存进 localStorage，不自动重试相对写操作。
- [ ] 浏览器真实操作测试创建/加入/播放/权限冲突/聊天/退出，键盘与错误反馈可用；保存 UI 截图证据。

## Task 8：三平台与交付验收

**Files:** `.github/workflows/ci.yml`, `scripts/check-lan-*`, `docs/{lan-listening.md,api-routes.md}`, `evals/lan-sync/`。

- [ ] Windows/macOS/Linux 构建和单测；标准版/完整版均可用，安装文档含接口绑定、防火墙、睡眠与无声卡主机。
- [ ] 两独立实例真实 TLS/控制/PCM/聊天端到端；输出前后 PCM hash 一致，慢端/断网/重连/版本不兼容/注销/关闭测资源回收。
- [ ] 执行格式、单机转场回归、故障注入、8端资源压力，记录每项构建身份和范围。
- [ ] 同一采集时钟多通道录音证明两机与跨OS音频误差，8小时长稳单列实测结果；无硬件证据的项保持待验收，不能宣称完整质量发布。
- [ ] 独立 spec review 与 quality review 通过后形成可审阅分支/提交、运行说明、支持矩阵和剩余硬件验收状态。
