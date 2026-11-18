# 独立社区 Signer 与审批账本

2026-11-18 沿已批准 P3 §8 与 Signer 实施计划补齐
`crates/hertz-wallpaper-signer`。用户随后恢复验证，当前 Rust 1.88 的 workspace
测试命令已编译 Signer；其专用行为测试为 0，独立 OS 审批、持久化中断、恢复与
真实签名仍未验证。未运行生产服务或生成真实签名，本说明不代表已取得
Windows/Linux 部署或发布资格；确切范围见[验收矩阵](release-validation.md)。

Signer 是独立可执行程序，持有发布与撤销两份工作密钥，以及专属审批和签名
账本。[Hub](wallpaper-community-hub.md) 的 `approved_pending_signature` 仅为
审核展示状态，不能授权 Signer。审批主体来自本机操作系统连接身份；Hub
账号、请求体中的角色、人工确认布尔值或模型输出均不能取得审批管理权。
离线 `hertz-wallpaper-root` 是同一 crate 的另一个可执行入口，仅签根授权正文；
在线 Signer 只接受完整公钥链和明确根指纹，不配置或读取根 seed。

## 部署身份与配置

配置是显式指定的 TOML 文件，不读取环境中的模型凭据。服务、Hub 提交者和
审批者必须是互不重叠的 OS 主体，审批者最多 16 个。Windows 使用规范的
TokenUser SID，Linux/Unix 使用十进制规范 UID；配置组 SID 不会匹配用户 token。
`initialize`、`serve` 和 `checkpoint` 必须由配置的服务主体运行。

下面是 Unix 配置结构示例。部署时须填写实际身份和存储路径，并由运维人员
提供两份独立的 32 字节原始 Ed25519 seed 文件；程序没有生成密钥或自动初始化
入口，base64 文本或 PEM 文件不能当作 seed 文件。

```toml
ledger_id = "7a90e08e-5e6f-4b79-b7e8-ecae5289371c"
hub_id = "0fe89188-3ca0-4f87-9c38-f2e7389ccf90"
service_identity = "21001"
hub_identity = "21002"
approver_identities = ["21003"]
endpoint = "/run/hertz-signer/signer.sock"
database_path = "/srv/hertz-signer/state/signer.db"
checkpoint_directory = "/srv/hertz-signer-checkpoints"
authorization_chain_file = "/srv/hertz-signer/state/authorization-chain.json"
root_fingerprint = "填写原根公钥的64字符小写SHA-256"
max_database_bytes = 1073741824

[release_key]
key_id = "release-key-v1"
seed_file = "/srv/hertz-signer/state/release.seed"

[revocations_key]
key_id = "revocations-key-v1"
seed_file = "/srv/hertz-signer/state/revocations.seed"
```

配置、密钥、数据库、锁文件和检查点必须属于服务主体，且其它主体不能读取
内容或修改它们。Unix 文件要求无 group/other 权限、单硬链接，私有目录要求
无 group/other 权限；新文件使用 0600，进程 umask 为 0077。路径祖先必须由
root 或服务主体持有，且无其它主体写权。IPC 父目录需要让客户端能够遍历，
但不可让其它主体修改；socket 的连接权限由 OS peer UID 继续裁决。

Windows 检查实际句柄的 owner/DACL、文件类型与硬链接数，拒绝 reparse point、
不受信路径祖先和其它主体对私有对象的读取或修改权。普通用户默认目录 ACL
通常不符合该合同，须显式部署在受保护路径。私有目录的子对象继承也须仅给
服务主体权限；程序不自动改 ACL。系统管理员或取得系统级权限的主体仍在
本机隔离威胁模型之外。

Windows `endpoint` 必须为本机
`\\.\pipe\hertz-wallpaper-signer-<name>`；配置中的文件路径须使用本地磁盘绝对
路径，TOML 可用单引号保留反斜杠。管道显式设置服务 owner 和受保护 DACL，
拒绝远程客户端、使用首实例标志。Hub/审批客户端只获得数据读写和身份查询
所需权限，不获得创建管道实例、修改 owner 或 DACL 的权限。

数据库父目录与检查点目录不能相互包含，检查点目录也不能承载密钥。部署与
备份应分别保护它们。账本/Hub/服务/审批主体集合、bootstrap 工作公钥和根指纹
冻结于数据库与检查点 genesis；更换这些身份会阻止旧账本启动。工作密钥轮换
使用原离线授权链的连续扩展，并配置与最新代际相符的实际 seed/keyId；不重新
建立账本身份、不清签名水位。当前没有账本身份迁移或自动轮换命令。

根链最多 256 KiB、128 代，从原完整指纹确认的 bootstrap 根逐代验签。在线
Signer 加载实际工作 seed 后核对它们与最新授权 purpose/keyId/公钥一致，并
持久化最高代际、授权摘要和独立 `authorization-<generation>.json` 检查点。
同代异正文、代际回退、原根替换或已签代际缺失检查点均拒绝。历史已登记正文
通过原代际公钥重验；恢复不能把旧 keyId 当作当前网络签发资格。

Signer 数据库当前为 schema2；新建时写入 0001/0002，已有 schema1 拒绝启动，
没有自动转换或部署迁移资格。schema2、公钥链与检查点实现均尚未编译运行。

## 离线根操作

独立 `hertz-wallpaper-root authorize` 接受受保护 root seed、root-pin.json、
授权正文、前一完整链（第一代用 genesis）和新的输出文件，所有文件使用绝对
路径。实际命令与字段见[离线根合同](wallpaper-community-release.md)。CLI 核对
seed 与当前签发根相符，显示原根/当前根完整指纹、全部授权正文及摘要，真实
终端输入完整摘要后输出新文件。它不覆盖既有链、不生成默认根，也不通过
在线服务 IPC 暴露。运维人员随后把公钥链分别交给 Signer 与 Hub 的受控配置。

## 本地操作与审批

CLI 提供以下显式命令。没有参数时仅显示帮助。

```text
initialize --config <absolute.toml>
serve --config <absolute.toml> [--recovery-proof <absolute-tail.json>]
checkpoint --config <absolute.toml>
approve <local-endpoint> <expected-service-SID-or-UID> <approval.json>
revoke <local-endpoint> <expected-service-SID-or-UID> <operation-UUID> <body-SHA256>
sign <local-endpoint> <expected-service-SID-or-UID> <release|revocations> <operation-UUID> <body-SHA256>
query <local-endpoint> <expected-service-SID-or-UID> <operation-UUID> <body-SHA256>
request <local-endpoint> <expected-service-SID-or-UID> <sign-or-query.json>
```

`initialize` 只接受新数据库和新检查点目录，不覆盖既有文件。配置目录、密钥
和所需私有目录必须事先由运维人员准备。初始化中断可能留下部分状态，程序
保留它们并拒绝自动覆盖；须由运维人员按实际阶段处置。
成功时输出 `initialized`。数据库使用独立 `HWS1` application_id；启动先检查
原始文件头，拒绝音乐/壁纸库等其它数据库后才打开 SQLite。

审批文件结构如下，`document.body` 使用
[共享发布或撤销合同](wallpaper-community-release.md) 的完整正文。下面的身份、
包哈希和证据是结构示例，不代表真实作品已经完成审核。

```json
{
  "operationId": "d2100419-9d30-49e4-a1bc-c43e0c1c8e6e",
  "document": {
    "kind": "release",
    "body": {
      "hubId": "0fe89188-3ca0-4f87-9c38-f2e7389ccf90",
      "workId": "158011de-e4ca-4768-8e70-1e66b0c41bb0",
      "releaseId": "a1c7fb4e-af96-4c65-a10a-6a27f0ed94f4",
      "version": 1,
      "packageHash": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
      "bytes": 4096,
      "permissions": { "audioSpectrum": false, "pointer": false },
      "minEngineProtocol": 1,
      "publishedAt": 1794929000,
      "keyId": "release-key-v1"
    }
  },
  "evidence": {
    "licenseChecked": true,
    "sourcesChecked": true,
    "staticScanPassed": true,
    "previewEvidence": "填写本次真实预览记录的引用",
    "reason": "填写本次批准该确切正文的审核理由"
  }
}
```

`approve` 要求真实交互终端，展示整个正文和审核证据，包括完整撤销清单，再
显示 JCS 正文的完整 SHA-256。操作者输入完整摘要才发送请求，空行取消。
控制字符和双向格式控制字符不能进入可展示证据。服务重新验证摘要、字段、
Hub/keyId 与证据要求，并将 OS peer 主体、确切正文和证据摘要写入审批账本。

`revoke` 先查询原审批并展示确切正文，原审批主体输入完整摘要后才能撤回。
已经登记签名意图的审批不能撤回或换正文，已签发布须走签署撤销清单的流程。
`request` 不接受审批或审批撤回，以保留 CLI 的明确确认路径；本地协议仍按
受信 OS 主体和确认摘要裁决，不将客户端终端标志当作授权依据。

Hub 主体只可 `signRelease`、`signRevocations` 和 `query`。审批主体只可
`approve`、`revokeApproval` 和 `query`，不能调用发布签名操作。查询给 Hub 返回
确切审批证据/摘要和原 OS 主体供回执核对，不赋予审批写权或私钥读取权；尚未
登记意图时，完整审批对象另只提供给审批主体的查询。

## 报文与结果

单连接处理一条请求：4 字节大端无符号长度，随后为 UTF-8 JSON。请求与响应
分别最多 1,100,000 字节；共享发布/撤销信封仍保持 64 KiB/1 MiB 原上限。
未知或重复字段、非法数字、非规范 UUID 或完整 SHA-256 拒绝。

服务最多持有 4 个连接任务，帧头、正文和响应写入各有 5 秒期限。客户端连接
和发送期限为 5 秒，等待响应期限为 30 秒。Unix 连接先取 peer UID 再收帧；
Windows 在帧头读取后，短暂安装连接的 identification token 取得 TokenUser，
随即恢复服务身份，不跨 async 等待使用客户端 token。

客户端核对预期服务身份。Unix 同时检查 socket owner 和 OS peer UID；Windows
检查由内核维护的管道 owner SID 与实际服务 PID，避免要求客户端读取另一
服务账号的进程 token。请求体不携带调用身份或 Hub 审核角色。

例如 `signRelease` 使用如下字段，实际 `bodyDigest` 必须是 `approve` 显示的
确切 64 字符摘要，不能使用下例的结构示例值。

```json
{
  "op": "signRelease",
  "operationId": "d2100419-9d30-49e4-a1bc-c43e0c1c8e6e",
  "bodyDigest": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"
}
```

结果状态为 `approved`、`revoked`、`registered`、`signed`、`rejected` 或
`unknown`。`signed` 返回共享签名信封；已登记的操作同时返回当前检查点尾部
证明、实际工作代际/授权摘要及确切审批证据/摘要/主体。未知操作返回
`operation_unknown`，同操作异正文返回冲突。

已经收完并认证的请求由服务持有；客户端断开不取消其持久化或签名过程。
响应丢失或存储提交无法确定时返回/报告 `operation_outcome_unknown`，应以原
操作 UUID 与正文 SHA-256 查询。不会自动生成新幂等键或自动重发另一份正文。
Hub 的 requested/unknown 若查询仅 approved、没有 intent，应保持未知结果，
由配置的 Hub OS 主体通过显式 `sign` 命令签同一 UUID/摘要。registered 表示
已有持久意图，Hub 只查询并等待 Signer 从原意图恢复签名；不能改 UUID、正文、
publishedAt 或序号。独立撤回的审批返回 revoked，Hub 记为拒绝。
服务退出先关闭监听，再等待已接管任务结束、关闭数据库并释放两份进程锁。
Unix 退出只回收本实例、相同 inode 的 socket，既有竞争 socket 不被移除。

## 签名意图、水位与检查点

审批 UUID 冻结正文、证据和主体。同 UUID、同审批内容可回放；更换证据、正文
或主体会冲突，已撤回的审批不能借同 UUID 重新批准。

签名先在 SQLite FULL 同步事务内登记意图，同时预留作品 version/releaseId
或撤销 sequence，并写入完整 security 水位。version/sequence 必须严格增加，
旧 releaseId 或同作品同版本不能用于新操作。security 包哈希不能再次发布；
新撤销清单须保留每一份已知 security 记录及原 effectiveAt。不能靠漏项、改成
copyright 或更换时间解除旧安全事实。

撤销清单在意图登记时必须新鲜，签发时间不能回退；发布也检查既有签发时钟
水位。完整撤销清单已无法再容纳一条安全记录时停止新增发布，不截断历史。
审批/签名意图最多 100,000 条，数据库页预算为配置的 16 MiB–16 GiB 范围；
达到容量时拒绝新增操作，没有清水位或自动删除审计记录入口。

每份意图有一个连续编号、不可覆盖的检查点文件，绑定 ledger 身份、原审批
摘要、确切正文、工作代际/授权摘要、登记时间与前一记录完整哈希。
记录 flush 后才执行消息签名，
回执事务完成后才返回。Unix 同步文件与父目录；Windows 使用 write-through
文件写入和文件 flush，尚待实机断电与存储资格验证。

启动逐条对照数据库、独立检查点链、审批、签名回执与派生水位。数据库落后
检查点、序号缺口、异正文或已签意图缺失检查点都会停止启动。只可补齐已在
数据库登记的未签尾部；中断写入的文件只能追加其已知缺失后缀，既有字节不
变。恢复签名只重算原已登记正文，不根据 Hub 新请求替换版本或用途。

## 备份恢复与剩余范围

`checkpoint` 导出当前身份摘要、连续位置、完整尾部 hash 与最高授权代际/摘要，不产生新的发布
签名。它会核对现有账本，并可补齐既有未签意图的检查点。备份前须协调停止
服务后导出尾部，并在与数据库、检查点均独立的受保护位置保留最新证明。

恢复后的 `serve --recovery-proof` 要求独立证明与恢复链的完整最新尾部一致，
证明文件也须满足服务主体的私有文件权限。缺少证明或尾部不符不会恢复签名。
两份本机状态一起回滚无法由本机链自行识别；普通启动没有能力判断运维是否
复制了两个旧备份。因此恢复流程必须显式提供真正独立保存的最新尾部，不能
用旧证明或一起回滚的副本声称没有丢失签名历史。

离线根授权链、工作代际、Hub 回执公开、原生 trust.db/PKCE/凭据、订阅更新和
原运行 owner 的已知撤销接线已写入源码。它们仍未编译或运行；格式整理和
离线 Cargo metadata 只说明源码已整理、依赖可解析。原目录分配 owner 仅同步
Cargo.lock 身份，不代表重跑分配或构建资格。Signer 能签名也不替代客户端的
根确认、权限、撤销新鲜度或设备隔离。mark_web_activated 尚无执行消费者，
G3-S 未合格，社区 Web 执行保持关闭，完整 P3/真实部署与发布资格仍开放。

恢复验证后，应覆盖三类身份/ACL/路径反例、Hub 无法审批、准确摘要与目的
隔离、版本/sequence 回放及完整安全保留，并逐个模拟审批提交、意图提交、
检查点部分写入、签名回执和响应丢失的中断点；另需真实 Windows/Unix 通道、
并发预算、退出和独立尾部恢复验收。当前没有这些通过证据。
