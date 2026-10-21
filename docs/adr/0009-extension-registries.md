# ADR-0009 · 内置扩展定义与运行时归属

状态：生效（2026-10-08）

## 决定

皮肤、舞台、音乐渠道和 JS/CSS 资源使用内置注册定义，消除新增实现时需要同步修改的重复清单。保留原生 JS、单 exe 与 DBX 分发，不增加动态插件装载器或前端构建步骤。接入步骤见 `docs/extension-guide.md`。

Provider 绑定描述、实际操作、音质、凭据与就绪策略；公开 online API 保留校验、能力门和取流截止时间。`SOURCES` 只作为从注册项派生的兼容视图。已有但未开放的功能允许保留实现，能力门继续拒绝调用。

2026-10-08 播客扩展：Provider 同时持有媒体种类及可选下载网络策略。音乐搜索、推荐与换源只消费 `music`；
`podcast` 的目录、RSS 与订阅由独立领域服务负责，持久单集 ID 仍进入原队列。首 URL 验证及实际 DNS/重定向安全
客户端必须一起传给原渐进下载器，播放与预取保持同一网络边界，不靠缓存 key 或前端 ref 猜来源。
RSS、音频及远程封面使用 `public_net` 的同一 URL/DNS/重定向规则；资源入口声明 HTTP(S) 或仅 HTTPS，
领域服务保留自己的错误和大小预算。封面代理对未知长度响应逐块检查 6 MiB，不先完整读入内存。

皮肤 registry 负责卸载→属性/CSS→挂载→广播，生命周期负责资源回收，包括部分挂载和失败恢复中的资源。app 通过一个通用宿主处理动作与快照，仍持有播放意图；皮肤不再用专属事件顺序决定挂卸载。

创意场景定义持有参数规格、默认值、机位、别名与歌词能力，CreativeStage 消费定义并继续独占预置、cue 和音频绑定。沉浸场景描述绑定构造函数；歌词渲染器描述与实例表统一宿主分发。Stage 仍持有唯一帧时钟，starborn 仍是导演而非渲染器。

2026-10-15 三维空间：SpaceHome 只消费 app 注入的业务宿主；Space3D 持有导航与通用控件，
SpaceCamera 持有机位，SpaceStagePure 持有唯一 Three.js renderer、registry、scope 与质量策略。
场景定义统一持有 API/state 版本、参数、机位、别名、能力和预览；菜单与设置从 registry 派生。
场景工厂只创建几何/材质与更新逻辑，不创建 renderer、音频分析器或帧循环。
新增场景通过 register(def) 接入，版本迁移和资源释放在同一宿主契约下验证。
Coast/Zodiac 的旧入口和新宿主共用 createScene/world 源码，旧二维与沉浸入口保留原归属。
旧 SpaceFields/SpaceLayers 仅供历史模块检查；新空间不挂载手写 WebGL、SVG 绘景或旧舞台宿主。
anime-svg 及其作品不注册也不迁移为新空间场景；非法历史来源恢复为 coast。
空间歌词与封面纹理使用有界缓存，组合效果共享同一后处理链和总预算。
qualityMode、版本化 sceneStates 与 freeCam 保存于 settings.space3d；不新增浏览器偏好副本。
舞台与歌词独立组合：selectLyrics/setLyricParams 挂载同 registry 的 ownsLyrics 定义，
ctx.layer 标记歌词层；共用 renderer 和 Stage 时钟，以独立稳定阅读机位清深度后叠加。
两层统一计入预算并各自释放 scope；schemaVersion 3 将旧歌词 sceneSource 迁移为
coast 舞台与独立 lyricStyle，原场景 ID 和参数继续兼容。
2026-10-15 歌词一致性修订：流光、心象、商籁、凝彩由 registry 的
`capabilities.stanzaRenderer` 声明，Space3D 直接复用原 Stanza 渲染器与 CSS。
它们是歌词叠加层，不是新的三维背景场景；不挂载 Stage3D，不使用近似滚动文字替代原演出。
Three.js 继续独占三维背景；商籁/凝彩按需创建一个 Pixi 上下文，由同一 Stage 门推进，
不启动 ticker。只保留当前歌词实例，回首页、关闭歌词、切换与退出时销毁。
2026-10-21 空间文字场景下架：三维歌词与逐字擦除不再注册进 registry，已保存的选择回落为简洁字幕，
旧 ID 与别名不再解析；`selectLyrics`/`setLyricParams` 与 `ctx.layer === 'lyrics'` 的叠加层契约继续保留。
四种旧空间文字工厂保留独立 API 兼容，不再作为 Space3D 的这四种效果。renderer 统计保留逻辑 lyricId，
并以 lyricBackend 区分实现。
镜头偏好在关闭/离页时提交最新快照，HTTP 请求使用 keepalive，仍经过原有串行设置写入队列；
不另设浏览器存储副本或并行末次写入，避免恢复冲突与旧写覆盖新写。离页前尚未发出的请求仍是尽力保存。

JS/CSS 由一份显式宏清单同时生成内嵌内容、HTTP 路由与指纹输入。HTML 保留加载顺序与原鉴权；图片保留原二进制响应规则。保存键、ID、分享 v1 和 HTTP/RPC 信封不变。

DBX 最低宿主版本以真实验收为准，当前为 0.6.35：0.6.29 的样式内联丢失皮肤标记，
0.6.35 保留标记并通过六套皮肤正反切换。中间版本未逐个验收，不推断最早修复版本；
不在皮肤注册表中解析 CSS 来补偿宿主丢弃的属性。事件连接仍由 transport 持有，
只有 HTTP WebSocket 握手签发一次性票，DBX stdio 和演示事件连接不经过 HTTP 鉴权。

## 边界与 owner

数值预算继续沿用 ADR-0001/0006/0008，扩展不得绕过原预算：

| 数值 | 现在是多少 | 定义在哪 | 改它要一起改什么 |
| --- | --- | --- | --- |
| 每次取流的共同期限（秒） | 20 | `crates/hertz-studio/src/online/mod.rs::STREAM_DEADLINE` | Provider 分发、同曲降档重试与 ADR-0001 |
| 分享载荷与解压字节上限 | 131072 | `plugin/ui/creative-share-code.js::MAX_BYTES` | 场景预置验证、分享 codec 与 ADR-0008 |
| 场景参数可分享范围的绝对值上限 | 1000000 | `plugin/ui/creative-gl.js::PARAMETER_LIMIT` | 场景注册 min/max/default 校验、CreativeStage 分享校验与边界往返 |

## 禁止回退

- 不为新 Provider 恢复每个操作独立的 source 分发表；否则“列表里可见、实际调用漏接”会再次出现。
- 不复制场景默认值与机位到编排或提示词模块；否则新场景可以绘制却无法保存/归一化，旧预置也可能漂移。
- 不将“是否自己绘制歌词”写成固定场景 ID 判断；否则新歌词场景会出现重复叠加层。
- 不通过 skin:changed 监听顺序挂卸载；否则反向切换时旧皮肤会把新皮肤刚搬入的节点拿走。
- 不在部分挂载失败时丢弃清理归属；否则设置页和播放节点会留在已失效容器里。
- 不手工重复 JS/CSS 路由或指纹列表；否则新文件可能只在开发环境可用，或更新后继续命中旧缓存。
