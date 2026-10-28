# ADR-0012 · DBX 可选桌面读取与授权边界

状态：已实施，发布验收待完成（2026-10-29）。D0 数据传输、D1 授权及原生读取、D2 管理与设置流程已通过独立规格和质量审查；D3 配套产物及真实环境进展以[实施记录](../plans/2026-10-28-dbx-desktop-implementation.md)为准。下表只登记已实现的边界，不代表真实跨用户、图形工作台和长稳验收全部通过。

## 决定

DBX 桌面功能通过用户主动授权的本机只读管道复用 HertzDesktop，AppState 继续拥有播放、队列、歌词与频谱投影。未授权启动不创建桥 listener、窄凭据、发现记录或组件探测，不迁移原生配置。桥恢复或连接失败只影响可选桌面状态，原 SDK、音频和退出屏障保持原合同；“DBX 单独使用无行为变化”是实现与回归的硬约束。

真实最低及当前 DBX 运行时均会在停用时回收 sidecar 后代，因此组件固定由用户独立启动，sidecar 仅连接，不执行组件或 `--describe`。原生配置按来源隔离且只有一个活动来源；连接仅提供候选，切源、启用歌词或壁纸仍须用户在中心显式确认。DBX 歌词入口在 native 与页面均拒绝播控。

授权记录决定重启恢复，钥匙文件不单独代表同意。撤销先封闸、推进代际、取消实际 I/O，再提交持久禁用并分别报告清理结果。数据响应的发送登记与撤销共用闸门；原生端按请求起点及单调时钟独立计算各 scope 新鲜度，晚到快照不能重新获得完整寿命。

共用管理门面只在显式检测/连接时访问组件，HTTP 仅增加 capability 查询，DBX 连接/撤销走 RPC。操作在排队与探测前捕获原始 admission，授权成功后才改用实际新 generation；退出或撤销后，旧管理结果不能继续发布。组件就绪、授权、listener、管理可用和来源已认证分别表达，部分失败不伪造授权回滚；来源 true 仅随本次有效实时应答返回，不延长原生健康窗口。

设置区初始化、原设置刷新、保存的默认设置视图恢复、换肤与全局 Escape 不触发检测；真实打开设置及显式桌面动作才发起有界检测。首次授权保留明确按钮，底栏只打开并聚焦设置。页面允许撤销抢占 pending connect，用本地操作代际拒绝迟到回填；网络结果未知时不把上次授权事实冒充本次操作确认。

## 边界与 owner

| 名称（含单位） | 数值 | 定义在哪 | 改它要一起改什么 |
| --- | --- | --- | --- |
| 数据桥协议版本 | 1 | `crates/hertz-desktop-ipc/src/lib.rs::BRIDGE_PROTOCOL` | 发现、双方握手与组件构建兼容性检查 |
| 发现记录协议版本 | 1 | `crates/hertz-desktop-ipc/src/lib.rs::DISCOVERY_PROTOCOL` | 私有发现文件校验与来源重连 |
| 数据请求上限（字节） | 8192 | `crates/hertz-desktop-ipc/src/lib.rs::REQUEST_LIMIT` | 编码、解码、超限拒绝与真实句柄回收检查 |
| 数据响应上限（字节） | 4194304 | `crates/hertz-desktop-ipc/src/lib.rs::RESPONSE_LIMIT` | 文档序列化预算与慢客户端隔离 |
| 发现记录上限（字节） | 65536 | `crates/hertz-desktop-ipc/src/lib.rs::DISCOVERY_LIMIT` | 先限长后解析、路径及身份验证 |
| 授权记录上限（字节） | 8192 | `crates/hertz-desktop-ipc/src/lib.rs::AUTHORIZATION_LIMIT` | 持久授权读取、未来 schema 保留与撤销重试 |
| 连接期限（秒） | 1 | `crates/hertz-desktop-ipc/src/lib.rs::CONNECT_TIMEOUT` | 管道忙碌、缺失与取消回收检查 |
| 建连后总期限（秒） | 2 | `crates/hertz-desktop-ipc/src/lib.rs::REQUEST_TIMEOUT` | 读、业务等待、写与资源回收使用同一预算 |
| 管理请求与响应上限（字节） | 8192 | `crates/hertz-desktop-ipc/src/management.rs::MESSAGE_LIMIT` | 单条 raw JSON、旧客户端互通、空消息与慢客户端回收 |
| 原生管理协议版本 | 2 | `crates/hertz-desktop/src/component.rs::MANAGEMENT_PROTOCOL` | 严格目标来源、实际构建及 requestId 关联；legacy 独立版兼容 |
| 门面单次操作总期限（秒） | 5 | `crates/hertz-studio/src/desktop/windows/mod.rs::TOTAL` | 排队、探测与全部管理请求共用剩余预算，超时取消并回收实际 worker |
| 门面管理可用缓存期限（秒） | 3 | `crates/hertz-studio/src/desktop/windows/protocol.rs::FRESHNESS` | 当前操作/授权代际遮罩；来源认证不复用此缓存 |
| 原生配置 schema 版本 | 3 | `crates/hertz-desktop/src/config.rs::SCHEMA_VERSION` | v1/v2 迁移、未绑定独立版偏好与降级说明 |
| 已绑定来源上限（个） | 8 | `crates/hertz-desktop/src/config.rs::MAX_PROFILES` | 插入活动来源后数量校验与设置页候选 |
| 原生配置上限（字节） | 65536 | `crates/hertz-desktop/src/config.rs::MAX_CONFIG_BYTES` | 读入前限长与提交失败不替换内存 |
| 音乐数据失效期限（秒） | 3 | `crates/hertz-desktop/src/management.rs::STALE_AFTER` | 原生独立计时、管理来源在线事实、页面剩余寿命与同身份文档恢复 |

## 禁止回退

- 不把钥匙存在视为授权：否则撤销后残留文件会在重启时重新开放数据。
- 不在插件启动路径探测或启动组件：否则未使用桌面功能的 DBX 会新增启动依赖，组件故障也会拖累基础插件。
- 不以外层 timeout 包装不可取消的阻塞 I/O：否则返回超时后句柄和连接额度仍被占用，后续请求持续失败。
- 不在管理等待中持有授权生命周期锁，也不让旧代际提交新发布：否则撤销会被慢组件阻塞，迟到 connect 可重新开放已撤销来源。
- 不从桌面创建第二个音频、队列、频谱或页面观众 owner：否则关闭工作台、媒体键和原退出行为会改变。
- 不按响应送达时刻重置完整新鲜度：否则延迟快照和频谱能在来源失效后继续显示。
- 不用数据管道的鉴权替代管理管道验证，不把同用户测试冒充跨用户或跨会话验收：否则安全与发布结论超出实际证据。
