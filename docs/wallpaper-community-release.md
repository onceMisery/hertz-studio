# 社区发布、离线授权与原生信任合同

2026-11-18 已把离线根链、Signer 工作代际、Hub 发布/撤销回执、原生
trust.db/认证/订阅和原安装/Config 接线写入源码。共享纯合同位于
`hertz-wallpaper::release`，通过可选 `community-release` feature 启用。
2026-11-19 在 Rust 1.88.0 下通过 Signer 17 项与原生社区 41 项专用行为测试，
另通过共享 wallpaper 103 项、275 项集成测试和 7 项 doctest、Hub 管理 10 项。
隔离账本、信任库、实际包安装与 Config journal 测试覆盖安全和恢复接缝；
真实 OIDC、独立 OS 账号/IPC、断电与跨客户端发布资格仍需实际环境证据，见
[验收矩阵](release-validation.md)。

信任库身份预检显式等待自己唯一未导出连接的 SQLite worker 关闭，不要求其它
合法 Library 连接同时退出；错误 application_id/schema 仍拒绝。一般池关闭、
逃逸连接和独占迁移继续使用原文件句柄探测与资源额度保护。

## 发布与撤销信封

发布信封为 `{ "release": { ... }, "signature": "..." }`；release 正文固定
`hubId`、`workId`、`releaseId`、`version`、`packageHash`、`bytes`、
`permissions`、`minEngineProtocol`、`publishedAt`、`keyId`。身份使用规范 UUID，
时间以 Unix 秒表示；权限的 `audioSpectrum` 和 `pointer` 必须明确给出布尔值。
不沿本地 manifest 的省略默认值补签名正文。完整发布信封最多 64 KiB。

撤销信封为 `{ "revocations": { ... }, "signature": "..." }`；正文固定
`hubId`、`sequence`、`issuedAt`、`expiresAt`、`entries`、`keyId`。每项固定
`packageHash`、`reason`、`effectiveAt`，reason 为 security 或 copyright。
同一包 hash 不可重复；完整信封最多 1 MiB，有效期最多 24 小时。

签名字节为各自设计规定的 ASCII 域、一字节 LF 和 RFC8785 JCS 正文 UTF-8：
`HERTZ-WALLPAPER-RELEASE-V1` 与 `HERTZ-WALLPAPER-REVOCATIONS-V1`。签名只接受
规范的无 padding base64url，Ed25519 使用严格验证。未知字段、重复键、不安全
整数和无效完整 SHA-256 拒绝；验签成功后才产生 verified 对象。共享模块复用
serde_jcs/ed25519-dalek，不加载私钥、不签名或联网。

## 离线根授权链

链包含 bootstrapRoot（keyId/publicKey）与 authorizations 数组，
每项包含 `authorization` 与 `signature`。授权正文固定 `hubId`、`generation`、
`previousDigest`、`rootKeyId`、`keys`、`nextRoot`。`keys` 恰有 release 和
revocations 两种 purpose，各自包含 keyId 和公钥；公钥为 32 字节规范 base64url。
第一代的 previousDigest 为 null，后续代际连续增加并引用前一授权正文的完整
JCS SHA-256。nextRoot 为 null 或由当前根签出的下一根公钥，供下一代验签。
整个链最多 256 KiB、128 代，不截断历史或从新响应替换 bootstrapRoot。

根授权使用独立域 `HERTZ-WALLPAPER-KEY-AUTHORIZATION-V1`＋LF＋JCS 正文。
根公钥指纹是其原始 32 字节的完整 SHA-256；首次确认绑定 hubId、根公钥和完整
指纹。后续每次从原 pin 重验完整链，核对最高代际和正文摘要，拒绝回退、同代
异正文、用途混淆与重复 keyId。最新网络发布使用最新工作代际；已安装历史版本
可通过保存链中的历史工作公钥重验，不能借此降低网络水位。

独立离线可执行程序的显式命令为：

```text
hertz-wallpaper-root authorize <absolute-root-seed> <root-pin.json> <authorization.json> <previous-chain.json|genesis> <absolute-new-chain.json>
```

所有文件参数使用绝对路径，`genesis` 只用于第一代。root-pin.json 包含 hubId、
root（keyId/publicKey）和 rootFingerprint；authorization.json 是完整授权正文。
运维人员事先准备受保护的 32 字节原始 seed，CLI 核对它与当前签发根相符，在
真实交互终端显示完整正文、原根/当前根指纹及摘要，输入完整正文摘要后输出
新的受保护链文件。它没有默认密钥或覆盖既有链入口。在线 Signer 的配置和
IPC 不接受根 seed；工作 seed、公钥代际和独立检查点由 Signer 自己核对。

## Hub 回执与恢复

[Hub](wallpaper-community-hub.md) 在自己的 HTTPS origin 下提供 `/v1/keys`、
`/v1/revocations`、发布操作和原始签名信封。`/v1/works/{work}/release` 直接返回
SignedRelease JSON，原生消费完整信封，再固定 releaseId 下载相应包。
公开状态只由确切 Signer 回执推进，不由 Hub 的审核显示状态或手改数据库授予。

[Signer](wallpaper-community-signer.md) 继续独占受保护审批、签名意图及工作密钥。
Hub 核对原 UUID/body digest、独立审批证据/主体、授权代际/摘要、检查点账本/来源
和完整签名正文，先持久化 signed_pending_public，再事务推进 published。
未知签名结果只查询同一 UUID/摘要。Signer registered 表示已有意图但结果待恢复，
Hub 保持 unknown/signer_intent_pending；若仅 approved 而没有 intent，须由配置的
Hub OS 主体显式签原 UUID，不能自动重派、换发布时间或生成新 UUID。

Hub 管理角色、举报处理和审计读取沿原数据库角色边界，使用独立管理 UUID
收据与原审计事件的同一事务。举报升级结论不构成签名/撤销资格；角色变化也
不授予 Signer OS 审批权限。账号/举报/管理收据及审计接口见
[Hub 管理合同](wallpaper-community-hub.md)。这些新增源码尚未编译、迁移或运行。

## 原生 trust.db、认证与网络

trust.db 是安全真值，具有独立 application_id/schema、单连接写者、WAL 和 FULL
同步事务；wallpaper.db 的来源、订阅、版本及更新记录只作产品投影。普通作品库
备份/升级回退不包含 trust.db。打开已有库先以 SQLite 只读 committed 视图核对
身份，包含 WAL；主文件及 sidecar 拒绝重定向，恢复行在 SQL 物化前有大小界限。

根链、最高工作代际、release/撤销水位及完整 security hash 先完成信任事务，
再允许候选进入原 ImportJobs/AssetStore 安装。watermarks 只支持 stable，按
sourceId、hubId、remoteWorkId 隔离；同版本/sequence 同正文可回放，异正文冲突。
完整撤销清单须保留已知 security hash 及原 effectiveAt，不靠漏项、版权分类或
改时间解禁。过期签名可以增加安全信息，新鲜度单独判断；持久安全时钟和最大
观测时间识别无法解释的回退。已知恶意 hash 经原 session owner 停止活动内容，
并在导入、准备、预览、选择与回滚入口拦截，改名或重标本地来源不能绕过。
copyright 阻止新下载，保留用户安装文件。

原生认证沿系统浏览器 PKCE S256，临时回环端口与精确 `/oauth/callback`，完整
HTTP 头、随机 state、单次五分钟期限；同一流只允许一次等待，成功、拒绝或
取消后重复等待均返回 `callback_consumed` 并提示重新登录，令牌交换仍可读取
原 verifier/redirect。取消/退出 epoch 拦截迟到结果。访问 token
只在原生内存保留。默认不申请或保存刷新 token；明确同意后台续期且部署注册
offline_access 后，刷新凭据才进入绑定 origin/issuer/clientId/sub 的 Windows
凭据存储。刷新单槽，失败转重新登录，退出立即清访问缓存并删除保存凭据。
当前要求 authorization/token/JWKS 端点与 issuer 同 origin 且发现声明 S256，
仅接收可验证的 RS256/ES256 JWT access token，尚不支持跨 origin 端点或 opaque token。

原生 HTTPS 默认只连接公网，解析结果固定到本次连接，禁止重定向、代理和压缩。
管理员固定地址例外来自 HKLM 64 位视图
`SOFTWARE\Hertz\WallpaperCommunity\NetworkPolicy` 的 PinnedDestinations REG_SZ：
`[{"origin":"https://…","addresses":["确切 IP",…]}]`。最多 64 KiB、16 个 origin、
每个 16 个 IP；owner/写权限仅 SYSTEM/Administrators，页面或 Hub 无权新增例外。
literal IP origin 的 pin 必须恰是该 IP，TLS 名称与证书校验始终保留。Hub 自己
部署的 oidcFixedAddresses 是另一进程的配置，不向桌面下发这些权限。

## 订阅、应用与资格边界

订阅绑定规范 Hub origin/sourceId 和 remoteWorkId。下载意图保存 Config revision/
摘要、拓扑、原选择、订阅 revision、原固定版本和可选 playlist revision。
验签/信任事务 → staging 冻结下载 → 完整包匹配 → 原不可变安装 → 差异与权限
确认 → 原 Config CAS。权限扩大、变 Web 或最低协议变化转重新确认，手工应用
不绕过撤销、grant、当前能力和预算。

自动应用只在原轮播切点或启动执行。原列表在确认、准备与提交前重查 revision；
候选列表经原 Repository 新建并保留其它项目，Config 提交前不改变活动列表。
准备时的固定 reference 交给原单屏/镜像 runner，decoder/首帧交接仍归原 owner。
已提交配置、拓扑、订阅、原固定版本或列表变化使旧意图持久标记 stale，候选留库
供重新确认；设置编辑/保存/删除/列表短暂事务只暂停自动操作并重新核对。相同
候选 hash 的已有状态均去重，避免反复下载已过期或失败候选。

未知结果只按原 requestId/jobId、Config command/digest/revision 恢复，不从下载
文件推断已应用。显式回滚提交新 revision，保留安全水位和 active/draft/playlist
引用保护。原可信设置入口显示根指纹、账号/续期同意、同步陈旧/时钟回退、差异、
应用/回滚和原操作恢复；作者元数据只作文本，不执行作者 HTML。

2026-11-18 回滚源码续接：原确认入口排除 applied，并错误检查新候选的 hash。
现在由 Subscriptions 同一入口确定 review 与申请的确切 FixedVersion；确认和
apply_requested 用一条带状态/原申请/订阅 revision/已安装版本条件的 SQL 登记，
不先把回滚确认改成通用 ready。显式回滚可从 applied 申请，检查实际旧目标的
security/激活准入；不能覆盖未知 apply_requested，不能复用已登记的配置请求。
自动申请只消费原下载绑定一致、没有既有配置申请的 ready。

Config 结果同时匹配 requestId、digest、revision，原 GUI 回执与恢复入口使用
同一身份；迟到的旧回执不能改写新申请，同一提交后晚到的失败事实可补入该操作，
没有失败的恢复回执不清除已有错误。原内容写门覆盖版本核对到申请登记，
原删除计划保护未决 candidate/previous/apply hash，完成投影与 journal 终态在
同一事务写入。前向应用优先保留该 journal 的回滚目标；回滚保留原候选供显式
重新应用。沿用既有 apply_rollback 列与状态，界面区分回滚提交并显示本次实际
包 hash。rollbackAvailable 从原安装版本关系和独立 trust 的已知安全事实投影，
不可用的旧目标禁用回滚并说明重新核对/同步；最终仍重查激活、grant、能力和预算。
playlist revision 同步原 Repository 的 u64 合同。2026-11-19 的专用测试已覆盖
原 Config 身份匹配、未知结果保留、迟到回执、订阅 CAS、权限扩张与显式回滚；
实际系统浏览器/原生界面操作与完整跨客户端旅程仍待验。

2026-11-19 原生测试增加已锁定 Ed25519 2.2.0 的开发依赖，锁文件仅增加一条
依赖边，没有新增或升级包版本；serde 1.0.229、serde_json 1.0.151 及既有解析
feature 保持。catalog_heap_bounds 已同步锁文件身份并通过原分配计量套件，
原查询零堆分配、冷峰值界限 93,603 字节和保留量 92,067 字节均保持。
本轮没有新增 UI 视觉或可访问性验收。mark_web_activated 尚无执行消费者，
G3-S 未合格，社区 Web 执行继续关闭。真实 OIDC/OS 权限、断电与跨客户端恢复、
部署、第二台客户端完整旅程和 P3-06 发布资格仍开放。
