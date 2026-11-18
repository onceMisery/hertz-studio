# 独立壁纸社区 Hub

`hertz-wallpaper-hub` 是单独部署的社区服务，管理作者、隔离上传、候选审核和
受状态约束的下载。播放器不会启动此进程，服务不访问音乐库、不控制桌面，
私钥和独立签名审批账本不放在 Hub 中。

2026-11-18 当前已通过有限开发编译与管理回归：HTTP、认证、上传/审核、流式下载、维护、
离线公钥链、Signer 发布/撤销回执、公开读取回执核对与恢复轮转已写入源码。
数据库角色管理、举报队列/处理、管理操作收据和审计读取也已接入原 API。原生 trust.db、PKCE/凭据、
订阅和原安装/Config 接线也已落盘，见[共享与原生合同](wallpaper-community-release.md)。
用户随后明确恢复验证。Rust 1.88 的 Hub 编译与 10 项隔离 SQLite 管理测试通过，
覆盖迁移/重启、角色 CAS/权限重查、管理收据、举报结论、原子审计与失败回滚。
真实 OIDC、公开发布/Signer 中断恢复、部署和跨客户端旅程仍待验收；本轮未启动
生产服务或生成真实签名。确切范围见[验收矩阵](release-validation.md)。

## 启动配置

可执行入口只接受 `hertz-wallpaper-hub --config <绝对路径.toml>`。配置最多64KiB，
不提供默认线上地址、账号、管理员、密钥或监听配置。字段使用 camelCase：

| 字段 | 必须明确的内容 |
| --- | --- |
| `hubId` | 小写规范 UUID，与本数据库唯一社区身份一致 |
| `publicOrigin` | HTTPS 443 origin，不含路径、凭据、查询或片段 |
| `listen` | TLS 反向代理之后的地址与非零端口 |
| `issuer` | OIDC issuer 的精确 HTTPS 443 URL |
| `desktopClientId` / `apiAudience` | 两个不同的注册标识，API audience 专用于 access token |
| `scopes` | 显式注册列表，至少含 openid、profile、wallpaper.read、wallpaper.write |
| `allowedSigningAlgorithms` | RS256、ES256 的显式允许列表 |
| `databasePath` | 独立数据库的绝对 `.db` 路径，不能位于内容目录内 |
| `contentDirectory` | Hub 专用内容目录的绝对路径，不挂为静态站点目录 |
| `trustedProxies` | 最多16个代理的精确 IP 地址，不能为空 |
| `signerEndpoint` | 本机 Signer endpoint；Unix 为绝对 socket 路径，Windows 为受控命名管道 |
| `signerServiceIdentity` / `signerLedgerId` | 预期 Signer 服务 SID/UID 和规范账本 UUID；不是 Hub 审核账号 |
| `authorizationChainFile` / `rootFingerprint` | 完整离线公钥链的绝对文件路径与经运维确认的完整根 SHA-256 |
| `releaseKeyId` / `revocationsKeyId` | 最新根授权代际中两个独立 purpose 的工作 keyId |
| `administrators` | 至少一个 `{ issuer, sub }` 主体，issuer 必须等于本部署 issuer |
| `oidcFixedAddresses` | 可选，固定 issuer origin 的管理员指定地址；缺省为空 |
| `clockLeewaySeconds` | 可选，缺省0，最大60秒 |

首次打开数据库写入独立 application_id、schema 和来源身份；已有音乐/桌面
数据库会拒绝。已有 Hub 的 hubId/origin/issuer/clientId/audience 不匹配也拒绝。
数据库与内容目录各持一个实例锁，直到请求与自有上传/校验任务退出后释放。
管理员配置只用于显式初始化/授予库中角色，不读取 JWT 中的 role/email。
删除配置项不等于撤销已经持久化的管理员角色。先移出配置并重启，再通过角色
管理接口显式降权；当前配置中的管理员及最后一个数据库管理员不能由接口降权。

Hub 仅加载受配置指纹约束的完整公钥链，持久保存最高代际、摘要及 Signer
账本/服务身份；回退、同代异正文或更换既有身份会拒绝。轮换须先离线扩展原
授权链，再配置对应的最新工作 keyId。Hub 不读取任何 seed 或签名私钥。

代理必须清除客户端的转发头并**覆盖** `X-Forwarded-For` 为一个实测客户端 IP，
覆盖 `X-Forwarded-Proto: https`，保留匹配 publicOrigin 的 Host。Hub 拒绝不受信
直连、逗号 IP 链、重复关键头和 `Forwarded`。若请求带 Origin，必须匹配该
社区来源。没有 Cookie 会话或跨站 CORS 授权。IPv4 映射 IPv6 归一后计费限流。
部署方还须设置连接/空闲期限、请求头限额及总量不超过20MiB的日志轮转。

## 身份与 API

JWT 必须验证 issuer、唯一 API audience、exp、nbf、kid 和当前操作所需 scope。
仅接受已注册 scopes；access token 还须有 `typ: at+jwt` / `application/at+jwt`
或 `token_use: access` 的明确标识。ID token、opaque token、未知算法、错误
用途/曲线的 JWK 拒绝。OIDC 发行方必须按此合同注册 access token。

发现/JWKS 单份最多64KiB，不跟随重定向或环境代理；DNS 有5秒期限，最多16个
解析地址，并在连接前逐个拒绝非公网地址和固定解析结果。显式私有地址例外只
绑定配置 issuer 的同一 origin。JWKS 缓存最长1小时，失败/未知 kid 刷新间隔
至少30秒，单次认证总等待25秒。日志不包含 token、OIDC 响应或配置正文。

JSON 操作要求 application/json，最多64KiB、16层，拒绝重复字段与未知字段，
读取最多10秒。分页用 `offset`（0–1000000）和 `limit`（1–50，默认20）。

| 方法与路径 | 权限与结果 |
| --- | --- |
| GET `/.well-known/hertz-wallpaper-community` | 公开部署身份与 OIDC 客户端配置，不建立信任根 |
| GET `/v1/auth/config` | 与发现入口相同的部署身份、OIDC 和完整根指纹 |
| GET `/v1/admin/users` | read + admin；已有账号的 UUID、issuer/sub、当前角色与配置管理员标记 |
| GET `/v1/admin/users/{id}` | read + admin；精确读取目标账号，供角色变更前核对与冲突后重新确认 |
| PUT `/v1/admin/users/{id}/role` | write + admin；绑定 expectedRole 和原操作 UUID 的角色变更 |
| GET `/v1/admin/audit` | read + admin；按递增审计 ID 游标读取事件与管理 operationId |
| GET `/v1/management/operations/{id}` | read + 审核角色；admin 可读全部管理收据，moderator 只读举报处理收据 |
| GET `/v1/keys` | 完整根授权链；原生仍须确认或核对原 pin |
| GET `/v1/revocations` | 完整已签撤销快照；存储签名和摘要重新核对，支持 ETag |
| GET `/v1/works` | 从已核对确切签名回执且未生效撤销的候选构建作品列表 |
| GET `/v1/works/{work}/release` | 最新可公开版本的签名信封 |
| GET `/v1/works/{work}/package` | 最新可公开包，单区间 Range/ETag |
| GET `/v1/works/{work}/releases/{id}` | 精确 releaseId 的公开签名信封 |
| GET `/v1/works/{work}/releases/{id}/package` | 精确 releaseId 的公开包；客户端应从签名信封固定此版本 |
| POST `/v1/works` | write；用 operationId/workId/title/license 认领作品 |
| GET `/v1/me/works` | read；自己的作品 |
| GET `/v1/me/releases` | read；自己的候选和状态 |
| POST `/v1/works/{work}/uploads` | write；operationId/packageHash/bytes/minEngineProtocol 申请上传槽 |
| GET `/v1/uploads/{id}` | write；所属作者查询原上传结果 |
| PUT `/v1/uploads/{id}/content` | write；原始包、application/octet-stream、精确 Content-Length |
| POST `/v1/uploads/{id}/submit` | write；空请求体，重新核验包并创建待审候选 |
| GET `/v1/releases/{id}` | read；所属作者或数据库中的审核者读取候选 |
| GET `/v1/releases/{id}/package` | read；同上，隔离下载用于审核，不执行作者代码 |
| GET `/v1/review-queue` | read + 审核角色；待审候选，不含自己的作品 |
| POST `/v1/releases/{id}/review` | write + 审核角色；绑定确切包/权限/正文摘要的结论和证据 |
| POST `/v1/releases/{id}/publish` | write + 审核角色；登记确切操作，核对独立审批并消费签名回执 |
| GET `/v1/publications/{id}` | read + 审核角色；恢复原发布/撤销操作，未知签名结果只查询 |
| POST `/v1/revocations/prepare` | write + admin；基于现有完整清单准备新的 sequence/期限 |
| POST `/v1/releases/{id}/revoke` | write + admin；把确切版本的撤销纳入完整签名快照 |
| POST `/v1/releases/{id}/withdraw` | write；作者以空请求体撤回未签名候选，可重复查询同一终态 |
| POST `/v1/reports` | write；operationId/releaseId/reason/description，原因 security/copyright/other |
| GET `/v1/reports` | read + 审核角色；按 open/dismissed/escalated 读取举报队列 |
| GET `/v1/reports/{id}` | read；举报提交者或审核者读取确切举报与处理结论 |
| POST `/v1/reports/{id}/resolve` | write + 审核角色；绑定 reportDigest、原 UUID、dismiss/escalate 与理由 |

版本、包、权限、许可和正文在提交后固定；需要修改就提交新版本。包内 workId
不授予所有权，库中作者归属及单调版本在同一事务中判定。作者不能审核自己。
批准需完整许可/来源/静态扫描声明、人工预览证据和理由，结果只进入
`approved_pending_signature`。发布接口另行登记不变的正文、操作 UUID 和摘要，
Signer 只在独立 OS 审批主体已批准该确切操作后签名；Hub 验证回执后先保存
`signed_pending_public`，再事务推进 published。手工把数据库状态改成 published
不能提供所需的签名/回执与独立审批。公开最新版、精确版本和作品列表读取均
调用原回执核对模块，绑定候选正文、完整包 hash、权限、版本和长度，重新核对
独立审批、工作密钥 purpose/代际、根授权、checkpoint 和 Ed25519 签名，并要求
候选保存的信封与原操作回执一致。这些读取使用本地保存的完整授权链和回执，
无需在线 Signer；历史已授权工作密钥仍可核对原发布版本。作者 Web 包继续拒绝。

审核 JSON 字段为 operationId、decision（approve/reject）、packageHash、
permissionsDigest、bodyDigest、evidence。evidence 包含 licenseChecked、
sourcesChecked、staticScanPassed、previewEvidence 和 reason。Hub 存储审核证据，
不会伪称代替审核者执行静态扫描或合格隔离客户端人工预览。

## 精确发布、撤销与签名丢响应

发布 JSON 为 operationId、bodyDigest、packageHash、permissionsDigest，必须绑定
已审核候选的完整摘要。初次调用登记 prepared/awaiting_approval 并返回
approvalTemplate；运维人员通过 Signer 的独立交互审批入口批准该原 UUID。
显式重用同一发布请求后，Hub 先查询审批，再在自身事务中写入 requested，
只有这次已持久化的首次调度发送签名请求。

回执重新核对原 operationId/bodyDigest、完整审批证据/摘要、独立审批主体、
工作密钥 purpose/代际/根授权摘要、Signer checkpoint 的账本/来源/位置，以及
签名信封的完整 JCS 正文摘要。确切已签回执先写入 operation，再完成公开事务；
请求断开不放弃自有操作槽中的持久化责任。

requested/unknown 重启或丢响应后只查询原 UUID/摘要。Signer registered 已有
持久签名意图，Hub 保持 unknown/signer_intent_pending，等待 Signer 恢复原意图
后继续查询。如果查询只有 approved、没有 intent，Hub 保持
unknown/signer_intent_not_registered；须由配置的 Hub OS 主体通过 Signer CLI
显式 sign 原 UUID/摘要。不能自动再次发送、重造 UUID、更换 publishedAt 或正文。
独立审批已撤回则记录 rejected；登记意图后不能撤回审批或改变正文。

后台恢复复用原 publication 锁中的内存 UUID 游标，每批至多查询四个
requested/unknown/signed 原操作，读到末尾后回到开头。游标在处理确切操作前
推进，某条已签记录无法公开也不会一直占住首批；重启从头查询原账本。
signed 失败保留已签状态和回执，写入诊断并使 updated_at 不回退；published/
rejected 保持终态。恢复仍只查询原 UUID/摘要，游标不授予重新调度签名的权限。

撤销请求使用原 operationId、递增 sequence、issuedAt/expiresAt 与审核理由；
针对版本的 revoke 另给 security/copyright reason 和 effectiveAt。Hub 从当前
持久撤销构造完整快照，prepare 可续签同一完整清单的新序号/期限，空清单也须
独立批准和签名。security hash 与原生效时间只增不减；完整信封达 1 MiB 时拒绝
新增并要求协议升级，不截断历史。发布/撤销回执都使用同一操作账本恢复边界。

## 角色、举报与管理收据

管理员从 `/v1/admin/users` 读取已在 Hub 登记的账号，使用该账号 UUID 修改角色；
已知 UUID 可直接 GET `/v1/admin/users/{id}` 重新核对，无需重找整页账号。
角色只接受 author、moderator、admin；issuer/sub 仍来自经验证的账号身份，
客户端自报的登录 role/email 不会授予操作者权限。角色请求 JSON 是 operationId、expectedRole、
role、reason；reason 为必填文本，最多4000字符。事务内重新检查操作者当前的
数据库管理员角色，目标角色须仍等于 expectedRole，且新角色须不同。发生冲突时
重新读取目标并重新确认；不能更改原操作的正文。角色变更影响后续请求，已受理
的签名操作仍按原不可变 UUID/digest 和独立审批、回执恢复合同完成。

原举报提交 JSON 和返回 `{ id }` 保持。提交者可用该 ID 读取本人举报，审核者
可读取队列和任一确切举报；队列默认 status=open，支持 dismissed/escalated，
offset/limit 沿原分页合同。详情包含原文本、releaseId、提交者 ID、reportDigest、
当前 status 和可选 resolution。reportDigest 绑定确切举报 ID、提交者、版本、
原因、描述和创建时间，处理时原样带回；它不是发布或撤销签名资格。

处理 JSON 为 operationId、reportDigest、decision、reason，decision 只接受
dismiss 或 escalate。一个举报只有一个持久结论；同一原操作重试返回原收据，
其它操作不能覆盖已有结论。escalate 记录进一步审核需求，版本下架/安全撤销
仍须原管理员的独立 Signer 撤销流程，不从举报结论直接改变 release 或信任水位。
新举报提交和处理写入原 audit_events；既有举报不伪造补记历史提交事件。

角色与举报处理共用 management_operations 的规范 UUID，绑定操作者、命令类型、
目标和完整 requestDigest。同 UUID 同内容返回原响应，异内容冲突；丢响应先
GET `/v1/management/operations/{id}` 查询原操作，不用新 UUID 重做未知结果。
响应含 operationId、actorId、objectId、requestDigest、committedAt、auditEventId
及带 kind 的 result。查询仍需当前数据库权限；失去角色的账号不能借旧 UUID
恢复管理权限，管理员可读取管理收据，moderator 可读取举报处理收据。

角色/举报变更、原审计事件和确切响应收据在同一原 SQLx 事务提交。管理收据
最多32KiB，账本最多100000条；达到容量时拒绝新命令并回滚同事务变更，保留
原 UUID 墓碑。账号、举报、处理理由、收据及审计字段在 SQL 物化前分别限额，
UUID/hash/状态和必需字段异常时拒绝读取。所有内容只是 JSON 文本数据。

`/v1/admin/audit` 使用 after（缺省0，非负安全整数）和 limit（1–50，缺省20），
按原 audit_events.id 递增返回。下一页用本页末项的 id 作为 after；空页返回空
数组。新管理事件附 operationId，可读取确切变更收据；原上传/审核/发布事件
仍按原记录返回。配置在启动时首次授予或重新授予管理员角色，和
administrator_configured 系统审计事件在同一事务保存；已有 admin 不重复记录，
旧启动历史不伪造补记。该接口沿原 OIDC read scope、管理员角色、代理和请求槽，
不读取凭据或 Signer 私钥。新增独立 Hub 0003 migration 当前只写入源码，
尚未执行数据库迁移或运行这些接口。

## 限额、恢复与下载

单作者1个/全服务4个上传槽，30分钟期限，包最多512MiB，作者内容和预留合计
最多5GiB，每小时10次新上传申请。实际流写入 staging，完整长度/hash一致并
同步文件后移动到 quarantine；提交再次从同一文件句柄计算 hash 并调用共享
包验证器，单个验证任务运行，其它工作仍受全局4槽限制。上传状态转换与后续
处理由自有任务持有，HTTP 响应取消不释放半完成状态的责任。

同一个作者 operationId 同内容返回原记录，换内容冲突；响应不明时先查询原
uploadId。启动恢复 receiving/validating 状态。每分钟将过期活动槽释放，24小时
后清理未提交文件，保留请求身份墓碑防止旧请求重新建槽。目录扫描每次最多
128项并保留游标，只清理两个固定目录下、命名符合本 Hub 合同、超过24小时且
数据库无引用的孤立文件。无递归删除或播放器数据回收。

候选记录的全部物化读取复用同一 SQL 限额投影，覆盖查询、审核、撤回、提交、
发布和撤销；必需字段越界转为 NULL，使记录读取失败。正文和发布信封各最多
64KiB，包内许可 JSON 最多4KiB，权限 JSON 最多256字节；文本、UUID、hash、
版本、长度和状态也有固定界限。该许可界限来自 HWPK1 包内许可合同，与认领
作品时的许可字段界限分别处理。公开作品分页先只保留至多50项 ID/时间，再
逐项读取并核对候选和确切回执。最新版按 releases.version 原字段排序；最高
符合公开状态的记录越界或回执不一致时拒绝读取，不因投影成 NULL 退回旧版。

访问每 IP 每分钟120次，处理请求全局64槽；下载每 IP 4个、全局32个，许可
随响应体存续，单次只读取64KiB，断开连接释放。包固定作为 attachment 和
application/octet-stream 返回，带 nosniff；不直接展示 HTML。支持 GET/HEAD、
单区间 Range、If-Range 与 If-None-Match；不支持多区间。先核对访问状态、
已知生效撤销及公开候选的确切签名回执，再处理条件请求。拒绝/未签名版本不会通过公开路径返回，隔离
下载必须有作者/审核者身份。收到撤销前已经开始的流目前不会中途取消，撤销
同步后的原生处置经独立 trust.db 和原 session owner 拦截/停止；这不承诺离线
发现未知撤销。过期清单可提供安全事实，但不算新鲜状态。

SIGTERM（Unix）/Ctrl-C 后停止接收新请求，等待请求及自有工作收尾，再关数据库
和释放实例锁。启动可能创建新 Hub 目录/数据库；本轮只编写这些逻辑，没有
实际运行它们。真实崩溃恢复、磁盘故障、TLS/OIDC 部署、备份恢复RPO/RTO、
签名发布与另一台客户端的完整旅程都须在后续恢复验证后取得证据。原生目前
要求 OIDC 端点与 issuer 同 origin、发现明确声明 S256，默认不保存刷新 token，
仅用户明确同意才启用 offline_access。原生管理员地址例外与 Hub 的
oidcFixedAddresses 各由自身部署配置控制，不从 Hub 响应授予桌面连接权限。
G3-S 未合格，mark_web_activated 尚无执行消费者，社区 Web 执行仍关闭。
