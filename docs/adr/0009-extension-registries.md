# ADR-0009 · 内置扩展定义与运行时归属

状态：生效（2026-10-08）

## 决定

2026-11-11 整个 canonical identity 的 pre-opening heap 归原 archive owner：Copy 私有 `CanonicalIdentityHeapBounds` 从物理包上界与 caller MetadataLimits 共用原 opening 限额因子，按 opening/read/parse/verify 四阶段取 max；原 ZIP 预开包/实际 usage reader 费用共用 generic size_of，原 manifest 实际长度提供返回身份 R，独立 process catalog 费用另计。原 by_index/CryptoReader plaintext/ZipFile 借同一 AtomicBool，在底层和 logical Read 成功含 EOF 前后 poll；ZipFile 原 bulk delegation 保留 CRC 部分错误状态与 UTF-8 顺序，入口 poll 覆盖空 read_exact；token plaintext bulk 在原 CryptoReader 内经过每次 read，栈 String guard 只借 caller 原 backing 并在无效追加或 panic 时回滚，真实 I/O 错误优先。typed Other sentinel 映射 cancelled，真实非 Interrupted I/O race 保持旧码；原 manifest 的 Interrupted 重试与 resource 拒绝顺序保持。原有 owner 自然退出后才 public return，不新增 wrapper/parser/ledger、不释放 caller grant；native catalog/canonical AssetStore/compact ModelInput/retained/GPU 联结继续，源方程和资格见[模型记录](../wallpaper-model-resources.md)。

2026-11-11 原 manifest 的 checked 费用仍归唯一解析 owner：`ManifestHeapBounds` 从有界原字节长度计算全部八个同存/错误阶段及成功保留界，canonical identity 在同次 archive 检查记录私有实际长度作为费用来源，不接受调用方手构 Manifest 的容量证明。原 fixed catalog 字节和栈上 SHA 联结其冷启动/永久保留费用；查询不解析、初始化或创建第二份目录。首次属性校验建立的 OnceLock 永久 owner 必须在后续原生 process 生命周期保持原账本占用，不能随准备任务归还。原 JSON/校验/合法序列语义保持，不增 parser、ledger 或运行资格；caller bytes、ZIP/reader、验证工作区、compact ModelInput/pins/jobs 与 GPU 仍由原准备流程组合。源码或目录身份变化须重做原费用证明，当前界与后续资格见[模型记录](../wallpaper-model-resources.md)。

2026-11-11 开放 JSON 值的字面语义归原 json/manifest/property/document/catalog owner：同一 serde_json 字节解析器通过普通 String 键与递归 seed 直接保留原 Value/Map/Vec，退役 Value 私有 carrier 的字符串再解析路径。manifest 字节检查及所有本片递归字段使用同一语义，真实包身份入口不能从隐藏字符串取得 seal；原 catalog 字节 hash、公开类型、合法序列/null 边界及数值/容量规则保持。没有键名黑名单、第二语义树或全局关闭 raw_value。完整 manifest/ZIP 费用与 native/ModelInput/GPU 资格继续由原准备流程联结，见[模型记录](../wallpaper-model-resources.md)。

2026-11-11 原 archive 读取诊断复用既有 resource_container_io 标量构造，包 seek、manifest、条目 hash 和 composition IO 不再复制任意外部错误文本。固定操作、已验证实际路径和已知 byte 位置仍归原 archive 调用点；GLB/KTX2 保留原无路径诊断文本与错误分类。此片不增加 reader wrapper、parser 或 ledger，也不授予完整 archive/manifest/native/GPU 费用资格，见[模型记录](../wallpaper-model-resources.md)。

2026-11-11 原完整模型解析继续持有容量与费用：Limited 保留原语义上限并明确扩容，经过原作者总量/view-role检查的属性与target树从Schema移到原facts，退役其deep clone同存；nodes/scenes/targets/numeric jobs和图像别名由原owner分配明确容量。ModelHeapBounds的阶段最大值来自真实类型、语法跨度和同存/错误源方程，不增加语义解析器、全输入allocator hook或预算ledger。共享ContainerReader的I/O诊断由其原owner读取固定ErrorKind/raw_os_error和byte位置，退役第三方错误全文Display复制，GLB/KTX2保持原错误分类和读取退出。完整native基底、compact ModelInput/retained及GPU资格仍由后续原准备/预算/renderer闭环，见[模型记录](../wallpaper-model-resources.md)。

2026-11-11 包身份仍归原 archive owner：从完整包校验中抽出共用的 manifest/条目范围/实际长度/SHA 阶段，只有该阶段能构造字段私有的 CanonicalPackageIdentity。模型 source 与精确 variant 绑定借用其原 model 资产声明，保留同文件别名身份；手构 manifest 不取得该 seal。调用者 ZIP metadata 限额与原容器上限取小，执行于原 reader 分配前。完整包校验随后继续 composition 和所有资源语义，不引入另一解析器、身份算法或预算 owner；此 seal 不证明 GLB 内容、ModelInput/native 联合包络或 GPU 资格，见[模型记录](../wallpaper-model-resources.md)。

2026-11-11，同版本 ZIP 补丁也归原发行和配套身份 owner：Standard/Full 独立 wrapper 继承根唯一 Cargo patch 表并解析原路径，发行检查核对真实 ZIP 依赖并编译包合同；desktopBuildId 输入包含 vendor manifest、provenance 和源码，原 plugin/studio 身份随之变化，独立验收 lock 与编译缓存排除。修复原入口，不增加另一套补丁配置或身份算法。

2026-11-11 ZIP 元数据分配限制归同版本原 parser：工作区通过 `vendor/zip` 的 zip 2.6.1 补丁提供独立 `with_metadata_limits` 构造方法，保留 `Config`、默认读取和解码语义。源码、原许可证、发布包 checksum、VCS revision 与上游测试原件身份随补丁入库；依赖缓存保持只读。限额在原元数据分配前检查，专属 quota 不能被目录候选重试吞掉；原 parser 产生去重前条目数和 checked opening/retained/Stored-Deflate reader bounds。canonical HWPK 入口沿用 `MAX_FILES + 8` 及原物理包长度，在 manifest 解压前拒绝重复中央目录记录，避免 IndexMap 去重隐藏路径冲突。原 ledger、运行预算与资源 owner 保持；完整联合准备包络和 ModelInput/GPU 资格仍独立验证。上游提供并验证等价分配控制、原始计数及成本 API 后可移除同版本补丁，详见[补丁说明](../../vendor/zip/PATCH.md)和[模型记录](../wallpaper-model-resources.md)。

2026-11-11 HWPK 压缩范围与比例仍归原 archive owner：消费锁定 ZIP parser 的绝对 data_start/compressed_size/central_directory_start，在条目解压前以 checked 加法拒绝越界；资源按规范并最终实测的 E、manifest 按有界实际长度核验精确 E≤100C，退役目录自报 U/C 的整数除法。两个公开校验入口共用原 manifest 读取，不新增 ZIP parser 或依赖 fork。目录启动扫描与正文解压分别观测；原长度/SHA/路径和限额保持。完整临时阶段包络、retained、ModelInput 与 GPU 资格仍单独验证，见[模型记录](../wallpaper-model-resources.md)。

2026-11-11 固定资源取消仍归原 AssetStore/ImportJobs：source pin 的原包和投影完整 SHA 流统一使用固定 64 KiB 读取与原任务 cancel，在同步 Read 真正返回后观察取消；局部句柄清理与原单槽退出顺序保持。SVG 原稿/同包字体传同一个任务标记，退役该入口两条无取消 copy，不增文件 broker、worker、账本或兼容 wrapper。此为模型准备前置，未将读窗口视作 ZIP/typed/retained 完整预算或开启模型运行门；[SVG 记录](../wallpaper-svg-resources.md)与[模型记录](../wallpaper-model-resources.md)保留具体资格边界。

2026-11-11 原workspace serde_json依赖统一启用float_roundtrip，让原typed作者十进制事实按正确binary64舍入，与JS JSON.parse严格互操作。只替换原无该feature的配置，不新增解析器、expectedFacts容差或消费者回写；原有限/有界/完整hash owner、锁定版本与HWPK1/Config5保持。实际GLB/HWPK回归和跨语言逐bit结果见[模型资源实施记录](../wallpaper-model-resources.md)；native retained费用、准备/呈现预算和同renderer资格仍单独实施。

2026-11-11 静态GLB准备事实仍由原纯包typed Schema产生：作者scene/node/TRS或matrix、primitive authored mode、逻辑BIN长度与声明数量直接保留，原parents/children移动复用，退役冗余node_count与mode默认值擦除。私有固定metadata visitor只提取node/mesh loader pivot；原optional null及URI存在差异用全声明固定标记保留，不另解析Value或扩大格式拒绝。原动画模块只读同一Option视图，共享schema宏使用自身绝对路径；完整hash/数字/skin owner和metadata不授予proof的边界保持。原ModelInput/jobs/预算和同renderer资格仍后续实施，不新建准备账本、loader或scheduler；事实与验证详见[资源实施记录](../wallpaper-model-resources.md)。

皮肤、舞台、音乐渠道和 JS/CSS 资源使用内置注册定义，消除新增实现时需要同步修改的重复清单。保留原生 JS、单 exe 与 DBX 分发，不增加动态插件装载器或前端构建步骤。接入步骤见 `docs/extension-guide.md`。

Provider 绑定描述、实际操作、音质、凭据与就绪策略；公开 online API 保留校验、能力门和取流截止时间。`SOURCES` 只作为从注册项派生的兼容视图。已有但未开放的功能允许保留实现，能力门继续拒绝调用。

2026-10-08 播客扩展：Provider 同时持有媒体种类及可选下载网络策略。音乐搜索、推荐与换源只消费 `music`；
`podcast` 的目录、RSS 与订阅由独立领域服务负责，持久单集 ID 仍进入原队列。首 URL 验证及实际 DNS/重定向安全
客户端必须一起传给原渐进下载器，播放与预取保持同一网络边界，不靠缓存 key 或前端 ref 猜来源。
RSS、音频及远程封面使用 `public_net` 的同一 URL/DNS/重定向规则；资源入口声明 HTTP(S) 或仅 HTTPS，
领域服务保留自己的错误和大小预算。封面代理对未知长度响应逐块检查 6 MiB，不先完整读入内存。

皮肤 registry 负责卸载→属性/CSS→挂载→广播，生命周期负责资源回收，包括部分挂载和失败恢复中的资源。app 通过一个通用宿主处理动作与快照，仍持有播放意图；皮肤不再用专属事件顺序决定挂卸载。

创意场景定义持有参数规格、默认值、机位、别名与歌词能力，CreativeStage 消费定义并继续独占预置、cue 和音频绑定。沉浸场景描述绑定构造函数；歌词渲染器描述与实例表统一宿主分发。Stage 仍持有唯一帧时钟，starborn 仍是导演而非渲染器。

2026-11-11 组合资格扩展：可组合 metadata、source profile/完整资源计划和时钟输入要求仍属于原 scene registry，经同一 catalog 导出。Rust 与 JS 查询编译器最终参数槽和结构版本，缺项拒绝，不建立另一份场景白名单或补默认值。当前只开放 root spectrum-towers v1/source low、ripple/post为零的实际验收子集；其它scene/model和文档自动化明确未支持。原native目标在资源准备前选择唯一DPI栅格，原scope持有source预留/claim，原renderer按3D→clearDepth→2D→一次sRGB输出；原帧时钟和pending/committed输入只在成功提交后换代。规格或目录可校验不等于设备可呈现，当前资格与后续边界见[实施记录](../wallpaper-builtin-composition.md)。

2026-11-11 模型资源前置检查仍归纯 `hertz-wallpaper` 包合同：原 ZIP 长度/hash 核验后检查 GLB/KTX2 source 与 variants，每个资产角色先验证 MIME，再按文件去重内容检查。检查使用原始有界 JSON 与固定流块，不引入第二个字节 broker、renderer 或格式能力 registry。容器事实不授予 loader、几何/动画、DFD/codec 或 GPU 资格，运行门保持；后续原资源准备器继续消费同一检查。范围及证据见[资源实施记录](../wallpaper-model-resources.md)。

同日结构续接：GLB的typed有界schema、view/accessor范围、单父图与mesh/实例metadata上界仍由原包合同持有，原Model入口在容器之后调用唯一结构inspector。同包图片只映射原Image/Texture source/variant refs，重复URI共享不可变别名metadata，未增加文件broker或运行pool。返回事实显式binary_content_validated=false；实际BIN、动画/扩展与prepared/loader/GPU资格仍独立，不能由结构解析成功开放运行。来源措辞差异与子集范围记录在上述资源实施记录，不把尚未验证的表示写进能力registry。

静态BIN数字续接仍由同一纯包owner持有：唯一framing在BIN读取前调用私有结构/数值callback，固定窗口按位置扫描有界且去重的accessor布局，原metadata API合同保留。不可手构数字结果绑定同次完整GLB流digest，archive核对expected hash；不接受可手构ModelStructure作为proof输入。该数字事实不证明传递图片、动画或GPU，没有新增broker/能力registry/运行账本。退役的是Model包校验只检查metadata就接受坏实际索引/浮点的路径，原模型运行拒绝继续保留。

独立SPEC发现的FLOAT bounds原始f64顺序误拒绝在结构owner修正：component精度规则供结构顺序与实际数字比较共同调用，FLOAT均先round到f32、整数保持raw精度。原作者bounds照样保留，没有消费者补丁、特殊样本例外或另一套格式解释器。

FLOAT TRS动画存储续接归原ModelStructure owner，其私有animation子模块返回有界引用与duration metadata；真实timestamps/quaternion继续归同一numeric布局/heap/窗口与GLB流hash，不新增播放器或scheduler。仅在已检查FLOAT TRS子集内退役animations一概Pending拒绝；normalized rotation、weights/morph/skin/extensions及模型运行门仍保留。clip数组索引/原name保持，metadata不裁决既有animationClip字符串的运行选择。实际播放继续由后续同renderer/clock资格负责。

morph/FLOAT weights内容续接继续由上述唯一owner持有：原ModelStructure保存作者targets、mesh M及有限f64默认/覆盖weights，私有animation消费已验证mesh事实，现有numeric job直接扫描所有delta/weights且只对真实base属性赋方向/颜色角色。局部数组/map超额前拒绝，全 GLB 作者总量在typed后、派生复制/引用与BIN前检查；不生成每primitive/node的继承或零数组。退役Primitive.targets/Mesh.weights/Node.weights的一概Pending以及合法FLOAT weights一概拒绝，保留normalized动画、skin/sparse/extensions与运行门。没有新decoder/broker/pool/scheduler/能力registry；内容有限不证明32-bit求值、保守bounds或GPU资格。

normalized动画续接由原结构admission接受rotation/weights的四种normalized整数，原numeric旋转角色使用私有有效分量解释；raw解码/extrema/index/base/timestamp与唯一layout key不变，首alias的normalized标志不决定实际channel约束。整数weights的有效有限性由合法存储范围和规范公式保证，不另建状态、转换数组或逐分量冗余扫描。退役上述四种normalized动画的一概unavailable，原1e-4旋转容差与cubic值/导数区分保持；skin/sparse/extensions、准备/loader/动画播放/GPU与模型运行门继续保留。新旧官方来源身份分别记录，内容精度检查不等于锁定0.186 loader转换或设备资格。

核心skin续接进一步退役合法skin字段/base属性的一概拒绝：ModelStructure仍唯一拥有joint图、全部node.skin场景与实际使用事实，model_binary私有skin子模块消费同次raw解码并保留每个group/set/role消费者。跨sets关联使用预分配joint/flags状态与active链表，完成顶点只校验一次并更新固定剩余计数；没有第二输入、转换数组、loader或运行账本。新增动态关联有效载荷16 MiB/预估工作67,108,864子限额在BIN前按实际capacity和全部作者消费者核验，原raw元素/分量计数及64 KiB窗口不变；结构摘要125,536bytes及预处理/图工作独立有界，不冒称进程RSS或GPU成本。morph的JOINTS/WEIGHTS保持明确invalid，FLOAT权重推荐与IBM尾部/singular合法性不被放严；metadata false、sparse/extensions/codec/准备/loader/私有实例/绝对动画/GPU运行资格继续独立。上述段落保留各阶段归属，本段是当前skin内容边界。

静态GLB消费续接复用安装包Three0.186.0的GLTFLoader；插件读取该loader已解析JSON核对原计划事实和窄能力范围，不建立另一个JSON解释入口。mesh/node extras按该loader实际userData合并/继承语义在依赖构造前拒绝可见pivot，包括prototype carrier；检查归profile owner，未以late TRS补丁掩盖未计划路径，无害metadata保留。工厂不持有parser/cache，不自行fetch、预约预算、建立pool/renderer或scheduler；原caller持有输入/parser及backing/upload两类不同票据，取消和partial失败等已开始依赖实际settle后回收。readonly geometry/material按原pool所有权约定共享，Object3D层级/变换各实例私有；hidden默认材质与mesh原型的allocated/retained区别有真实用例。该消费切片未退休模型运行门，原固定包准备/完整成本、每实例可变材质/opacity、保守bounds及同rendererGPU首帧仍由后续原owner接线。

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

2026-11-01 二维流体增强：StageControl 在原二维偏好 schema 中持有独立的本机开关，StageFluid 只持有
一个可选二维 WebGL 上下文，与三维／创意宿主互斥；不新增通用效果 registry，不接管其它 renderer。
Canvas UI 派生 solver 作为应用内部独立产物，保留 MIT + Commons Clause 与完整署名，不能并入标为
纯 MIT 的共享 runtime。来源、构建、支持范围及验证边界见 `docs/stage-fluid-enhancement.md`。

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
