# GLB / KTX2 资源实施记录

2026-11-12，原 native `budget::global()` 的唯一 `OnceLock<Arc<BudgetCoordinator>>`
在原 scene catalog 冷分配前沿完成 process 准入。费用仅取原
`ManifestHeapBounds::for_bytes(0)` 的 checked source/layout/SHA 查询及两个
catalog getter；查询不解析或初始化目录，资格不符先 fail-closed。原 Ledger
同一 Mutex 内先检查既有 prepare/asset 用量，分别预约 cold workspace
1,502,113 bytes 与 permanent asset 1,136,036 bytes；任一不足均不改账本且
不进入 initializer。两项保守预约不表示物理峰值相加。原 `catalog()` 的
`OnceLock<CatalogContract>` 成功返回后只作内联状态提交，prepare 归零，asset
永久保留；panic 的 partial parser 先真实 drop，再由同账本栈 guard 退款，
不发布假 ready。process 不占 session metadata、prepare task 或 preview 槽。
原 grant/check_requests/grant_session、replacement projection 和 resource
allocations 继续沿同账本准入；release/confirm_exit/forget/purge 仅改变 token，
不能归还目录费用。独立测试用 `BudgetCoordinator::new()` 仍是空账本。

普通、embedded 与 feed-test 共用的 `app::run_with` 在 init_log 后、upgrade
prepare 和任何 Config load/default/normalize 前接入原 global；独立
`normalize_builtin` 保留 scene eligibility 拒绝先行，再调用 global 后借原
catalog。原 scene/catalog/manifest/model/ZIP 源方程和锁保持继承，不建立第二
parser、cache、ledger 或 native normalizer 回调。真实 cold 子进程核对同 Arc/
catalog 身份、双费用预约、临界拒绝、panic 顺序及原 Config/default/资源消费者，
证据位于 `output/design-final-followthrough/canonical-model-native-r22/impl/`。
另一个 `document/catalog.rs` 的 `composition_catalog()` 从 composition.json
建立 `OnceLock<Contract>`，由 document compile 和 native composition plan
触发，其费用尚未证明。composition、canonical AssetStore、compact ModelInput、
jobs/broker 与 GPU 联合包络继续实施；本片不开放 model gate，也不证明整体
320 MiB 准入。

2026-11-11，原 archive owner 增加 `CanonicalIdentityHeapBounds::for_package_bytes::<R>`，
在任何 ZIP 打开前以可信物理字节上界 P（先检查 ≤536,870,912）及 requested
`MetadataLimits` 计算整个 canonical identity 的 requested heap。真实打开与查询
共用限额因子：r=min(requested,2056)、b=x=min(requested,P)、c=min(requested,65535)；
无 caller limits 时使用原物理容器上界。Copy 私有字段保存限额、四阶段、整体 W、
raw retained/growth、entry verification、最大返回 R 与独立 catalog 费用；合法
查询零 heap、零 ZIP 读取，不初始化目录。实际 identity 的 R 仍只取同次原 manifest
记录的实际长度，不 clone/reparse 或接受 caller Manifest/手造费用作为 canonical 证明。

令原 ZIP checked opening/retained 为 O/Z，Dreader 由原
`MetadataLimits::checked_read_heap_bounds::<R>` 和 archive 的实际 usage API 共用
size_of 因子，包含原 Crc32Reader/Decompressor/BufReader/CryptoReader Box、8192
input buffer 与 pinned miniz InflateState。修改后的真实 System 分配重新验证
stable1.98.1 的 Stored=8328、Deflate=51624（outer136），Rust1.88 的
Stored=8312、Deflate=51608（outer120）；两者都从当前实际 layout 计算，并精确等于
真实 reader 活跃 heap 增量。这些是本波新 owner 的结果，不能由旧 freeze 自动转移。
仅资格内 Stored/Deflate rust_backend
适用，foreign backend/未知方法仍拒绝。

四个阶段分别计算后取 max：opening=O+602359；manifest read=Z+Dreader+786432+602359；
manifest parse=Z+524288+141607208（此时无 active manifest reader）；entry verify=
Z+524288+8594075+Dreader+2332357。最大 returned identity=9517723。
WV 的源分项是原 std HashSet String old/new table153632、lowercase bytes370080、
declared &str table69648、Verified slot old/new245760、verified strings759808、
raw name/clone131070、diagnostic602359。Rust1.88 std 使用 hashbrown0.15.3，当前
stable std 使用0.17.1，与 ZIP 的依赖独立；64-bit/String24/&str16/Verified80 和
固定原 limits 由原 private 源核对。错误先于180-byte 作者路径规则，raw名可65535，
ZIP CP437/lossy decoded 名可196605；diagnostic 已含其 fmt old/new overlap。
原 manifest 64KiB loop 只 append 成功读取的 bytes，actual cap 仍 MAX+1；EOF 不
额外 reserve。新 Stored MAX witness capacity262144，MAX+1 capacity524288、
old+new overlap786432；Deflate 的不同 chunk 几何增长仍在相同源上界内。样本不定义费用。

`inspect_package_identity_with_limits_and_cancel` 复用唯一 manifest/verify 路径，
原 ZIP by_index、CryptoReader plaintext 与 ZipFile 直接借同一 AtomicBool，
底层 read 前及 Ok（含 EOF）后 poll；ZipFile 的原 bulk delegation 保留
Crc32Reader 的成功后 CRC 更新、部分 I/O 错误后的状态与 UTF-8 错误优先顺序，
并在入口及成功返回后 poll，含空 read_exact、已缓冲输出与 EOF。无 token 的
CryptoReader 仍委托原 Take；有 token 的 plaintext bulk 在原 owner 内用固定栈
chunk 经过每次底层 read。read_to_string 的栈 guard 仅借 caller 原 Vec backing，
完整追加后才确认 UTF-8；无效追加或 panic 回滚至原有效长度，真实 I/O 错误优先。
typed `PayloadReadCancelled` 使用 Other 而非可被 std/flate2 重试的 Interrupted，
映射稳定 `cancelled`；真实非 Interrupted I/O 在 token race 下仍保留旧错误码。
原 manifest 对未取消 Interrupted 重试，resource read 仍 format_unsupported。
End/Start seek、metadata/local header、parse 与 verify 在同步操作返回后再检查；
OS in-flight 不可中断，borrowed ZipFile Drop 不 drain，原 reader/archive 自然退出
后才 public return，API 不释放 caller grant。不增加 reader wrapper、parser 或 ledger。
caller Read/Seek/Drop heap、预持有任意 caller error、stack、allocator overhead 及
process catalog 从 job W 中排除；cold/permanent catalog 分别1502113/1136036，
已由原 native process owner 独立计入。composition 目录账本、canonical AssetStore、compact
ModelInput/最后引用 retained 票据及 GPU 首帧仍继续，未证明整体320MiB准入。
本波 source transfer、独占构建和自然退出证据位于
`output/design-final-followthrough/canonical-model-binding-r21/repair1/impl/`；
未变的源方程与锁证据按 SHA 明确继承，修改后的 ZIP bulk 语义与 layout 重新验证。

2026-11-11，原 manifest owner 提供 `ManifestHeapBounds`，以原 256 KiB 上限内的
实际字节数逐项计算 scanner、Value/content、partial typed、上下文、属性首次完整
序列化、accepted clone/constraints、清理与诊断八个阶段，再取 requested heap 最大值。
原合法对象/序列、`{select:null}`、null 拒绝和错误顺序保持；成功属性费用包含
68 个 Map 的完整 allowance。当前锁定 64-bit alloc/serde 源下，最大 manifest 的
工作区界为 141,607,208 bytes，成功 manifest 保留界为 8,594,075 bytes，canonical
identity 保留界为 9,517,723 bytes。私有身份在同次原 archive 检查中记录实际
manifest 长度，`manifest_heap_bounds()` 仅从该记录取得费用来源。

费用查询借原固定 catalog 字节，以栈上 SHA 核对已证明身份，不解析或初始化目录，
合法查询不分配 heap。首次 builtin 属性校验可能在成功或失败时初始化原 OnceLock；
当前目录冷启动界 1,502,113 bytes、永久保留界 1,136,036 bytes 单独暴露，原生
process owner 已保持相应账本占用。原调用方源字节、archive manifest
buffer、ZIP/reader、条目验证工作区、pins/jobs、完整模型及 GPU 均另计；这些费用
API 尚未证明整体 320 MiB 准入。当前源方程、五配置真实 parser/Stored ZIP 与独立
冷进程证据保存于 `output/design-final-followthrough/manifest-native-fees-r20/`；
样本验证原容量和退出，不用测量斜率代替完整源码上界。固定包 canonical 绑定、
compact ModelInput、最后引用 retained 票据及同 renderer 首帧继续实施。

2026-11-11，manifest、公开属性和 composition/catalog 的开放 JSON 值沿原
`json` owner 递归按字面解析。Map 的键使用普通 String，每个子值使用同一
DeserializeSeed，直接构造原 Value/Map/Vec；桌面启用 `raw_value` 时，特殊键
中的字符串仍是作者字符串，不会再次成为隐藏的 manifest、数值或深层数组。
原字节扫描的重复键、深度和错误顺序与后续保留数据一致；公开字段类型、合法
对象/序列拼写、数值舍入和原 null 拒绝规则保持。真实 Stored ZIP 身份入口也
拒绝隐藏 manifest，catalog 的 hash 仍来自原 scenes 字节段。
Value 数组与 typed Vec 分别保持原增长和谨慎预分配规则，未增加第二棵语义树。
此修复建立实际消费特性下的字面一致性；完整 manifest/ZIP 费用、紧凑 ModelInput
及原生准备/retained/GPU 联结仍须继续核验。

2026-11-11，原 archive 的包尾/起点 seek、manifest、条目 SHA 和 composition
读取失败也复用共享标量诊断构造。操作使用固定字面量，路径来自固定 manifest 名
或前序已验证的实际条目，byte 位置记录已知的逻辑读取/seek 位置；第三方 I/O
错误的 Display/Debug/Source 不执行。原 PackageError 分类、ZIP 及文件校验、
读取/EOF 顺序保持。此修改补齐原 archive 诊断入口，完整 manifest 转换、ZIP
同存及 ModelInput/native/GPU 费用仍需由原准备流程联结。

2026-11-11，完整模型检查的容量控制和费用 API 归原解析 owner：有界数组从
1 个槽开始，按原上限扩容；已检查的属性/target 树从 Schema 移到原 facts，
保留合法自定义 semantic（包括 `_`）、作者顺序和全部未选中声明检查。节点、
scene、target、numeric jobs 使用明确容量，图像别名按同一 immutable manifest
计数后分配，原局部/全局语义和数字工作上限保持。
`ModelHeapBounds` 以有界 JSON 长度及实际 manifest 别名为输入，分别计算
opening、Schema/facts/scratch、numeric 和完整 checked 结果的 requested heap；
原 JSON/根容量、单次 grow、BTree 节点/键、decoder/bigint、错误及 Vec→Arc
同存按真实 owner 和源方程计量，不从最终长度或有限 allocator 样本外推。

共享 `ContainerReader` 的 I/O 诊断只读取 `ErrorKind` 和 `raw_os_error`，保留
原操作、byte offset 与错误代码。第三方错误的 Display/Debug/Source 不执行，
避免错误文本脱离 JSON/manifest 界后产生无界复制；GLB 和 KTX2 共用此入口。
完整包身份、manifest/ZIP 同存费用、紧凑 ModelInput 的最后引用票据及同 renderer
首帧仍须继续接入；单模型费用 API 不授予原生 320 MiB 或 GPU 资格。

2026-11-11，原 archive owner 抽出包身份检查阶段：
`inspect_package_identity` 沿用原 manifest、条目范围、实际长度与完整 SHA 校验，
返回字段私有的 `CanonicalPackageIdentity`。模型绑定只从该身份中的 model 资产
与精确 variant 取得声明，保留同文件别名的资产和变体身份；调用者手构 manifest
不能生成该身份。`inspect_package_identity_with_limits` 将调用者 ZIP 元数据限额
与原容器上限取小值，仍在原 reader 分配前执行，不能抬高原数量或物理界限。
完整 `validate_package` 共用这一阶段，再继续 composition 和全部资源检查。
身份阶段不授予 GLB 内容、ModelInput、原生联合内存包络或 GPU 资格；原准备
任务仍须先持有完整 workspace 预约，后续接入固定包与 retained 生命周期。

2026-11-11，ZIP 元数据限额在原 zip 2.6.1 reader 内维护，仓库补丁和来源见
[vendor/zip/PATCH.md](../vendor/zip/PATCH.md)。独立 bounded 构造方法保留原
`Config` 与默认 API，在 author count、中央目录变量、EOCD comment 和 ZIP64
extensible sector 分配前检查；专属 quota 直接传播。原 parser 的不可变 usage
保留 IndexMap 去重前数量，checked bounds 分别覆盖打开峰值、retained metadata
与固定 Stored/Deflate reader，不将正文大小当作 metadata 大小。

两个 HWPK 校验入口使用该原 reader，保留原 `MAX_FILES + 8` 的 manifest/目录
余量，其余变量上限来自实际物理包长度和格式长度字段。重复中央目录名字在
manifest 解压前按原 `path_collides` 拒绝；原始数量超限沿用 `too_many_files`，
其它 quota 使用 `zip_metadata_limit`。默认 ZIP API 仍保留最后同名条目覆盖行为，
HWPK 规则由原 canonical owner 执行。bounded 元数据读取覆盖到实际 footer，
仅允许完整数字签名位于目录大小之内或之后，拒绝同时少报数量和大小隐藏记录。
Standard/Full 独立发行 wrapper 从根 Cargo 的唯一 patch 表继承同一 ZIP 源，
检查脚本核对真实依赖图并编译两个 wrapper 的包合同。原 desktopBuildId 输入
包含 vendor manifest、provenance 和源码，ZIP 修复同步改变配套构建身份；
独立验收 lock 与编译缓存不参与身份。
此波尚未接入完整 typed/manifest/composition
联合包络、retained ModelInput 票据和同 renderer 首帧，原 320 MiB/GPU 资格继续。

2026-11-11，原 canonical ZIP 校验补齐压缩数据的物理范围：沿锁定 ZIP parser 的
`data_start`、`compressed_size` 与 `central_directory_start`，在首次条目解压前
以 checked 加法拒绝越过中央目录或溢出的范围。Deflate 的精确上限为实际
`E <= 100C`；资源读取前先按 manifest 规范长度检查，随后核对实际长度和 SHA，
不再用目录自报解压尺寸的整数除法。manifest 沿原 256 KiB 有界读取，以实际
解压长度检查比例；`validate_package` 和外部 manifest 的 `validate_archive`
共用此规则。ZIP 启动目录扫描仍会读取原始字节，这不等于条目正文解压。
此修复使成功验证资源的 `E <= 100P` 具备物理范围依据；ZIP metadata、typed
容量与 composition 的完整工作区、source/variant 绑定、retained 最后引用和
同 renderer 首帧继续，尚不构成 ModelInput 或完整 320 MiB/GPU 准入。

2026-11-11，模型原生准备前置沿原 AssetStore 补齐 source pin 的取消：原包与
投影的完整 SHA 读取使用固定 64 KiB 窗口及原任务标记，在同步读实际返回后
观察取消，局部句柄退出后才结束任务。现有 SVG 原稿/同包字体直接消费此入口。
这不构成 ModelInput/source-variant 证明或完整 prepare/retained/GPU 预算；
锁定 ZIP 库的目录及 ZIP64 附加数据在读取前分配，不能用窗口大小替代其费用。
原 canonical 包输入、返回事实的最后引用费用、完整成本和同 renderer 首帧继续。

2026-11-11 数值互操作修复归原 workspace 的 `serde_json` 配置：启用锁定同库的
`float_roundtrip`，使作者 JSON 十进制数正确舍入为与 JavaScript `JSON.parse`
相同的 binary64。原配置在真实 4,103 节点 GLB 中有 1,090 个末位差异；修复后
包含正负/指数的 16,412 个真实节点逐 bit 比较全部一致。7 项新增真实 GLB/HWPK
回归和包全部 242 项检查通过，涵盖 TRS/matrix、中点舍入、负零、子正规/最大有限值、
raw bounds/FLOAT 有效精度、source/variant 完整 hash 与有限/重复键拒绝。只修原
解析入口，不增加容差或第二解析器，不重写包字节/旧配置。完整 ModelInput/成本、
原 jobs/预算、有效保守 bounds 与同 renderer 首帧仍是后续资格。

本次全 workspace `--all-targets` 测试通过，桌面壁纸 505 项通过（原 2 项忽略），
两 crate Clippy、全部第一方源码格式及原 loader102/exporters/ADR 检查通过。
全仓格式检查的唯一差异来自未修改的 vendor SDK；与 HEAD 文件逐 blob 相等，
隔离的 HEAD 副本复现相同格式差异。该原有结果单独保留，未记为全仓格式通过。

2026-11-11 静态准备的事实续接仍归原有界 `ModelStructure`：保留作者节点、场景与
children/root 顺序、原 f64 TRS/matrix、逻辑 BIN 长度和声明数量；primitive 的省略
mode 与显式 TRIANGLES 分别保留。节点计数直接取 `nodes.len()`，原节点权重和
validated parents 不另建副本。node/mesh 的 loader pivot 只保留固定布尔投影，普通、
nested、转义键与 null metadata 保持原合法性；历史接受的显式 optional null 与
buffer URI 字段另留全声明标记，供后续静态准备拒绝能力，不在事实层改为坏格式。
显式 `mode:null` 仍按原规则拒绝。235 项包回归（新增事实12项）、14 项桌面资源
检查、两 crate Clippy/格式、原 loader102及合同/ADR检查通过；真实包 source/variant
与完整流 hash 仍由原入口检查。它尚未构造 ModelInput/JobSource、完整资源成本或
GPU 资格，模型运行门继续等待原准备、预算和同 renderer 首帧接线。

2026-11-11：原 `hertz-wallpaper::validate_package` / `validate_archive` 已在
ZIP 路径、实际长度、SHA-256 和组合合同核验后检查模型与 KTX2 纹理容器。
桌面导入的快照校验、安装复核和原包重开沿用此入口。

当前可验证的是容器、核心静态结构、skin/morph 存储及实际 accessor/动画数值。模型节点与 KTX2
运行适配器继续返回不可用；这些检查不能用来声称动画播放、纹理转码或 GPU 呈现已支持。

受控静态消费工厂现由同一安装包的 Three 0.186.0 GLTFLoader 实际解析 GLB，
在依赖构造前核对单 scene、无图/无变形、packed POSITION/NORMAL 和默认 PBR 的
计划事实。102 项真实 loader 用例覆盖共享 geometry/BufferAttribute/backing 的区别、
私有对象实例、作者矩阵、128 层子限额、零 URI 请求及取消/失败清理。隐藏默认材质
和 mesh 原型计入实际分配，parser/cache 不随工厂保留；共享几何与只读材质在最后
实例释放后销毁。该模块尚未接入模型运行门：固定包准备身份、完整原生成本票据、
每实例 opacity 私有材质、有效 Float32 保守 bounds、GPU 上传和同 renderer 首帧
仍须由原准备/预算/呈现 owner 完成，不能用这102项消费测试替代。mesh/node extras
直接字段与prototype carrier触发的loader pivot路径均在依赖构造前拒绝；普通无害
metadata仍可加载。原89项及SPEC失败反例单独保留，不回写历史资格。

skin 内容续接由原结构 owner 验证 joint 引用、共同祖先、skeleton、全部 node.skin
所属 scene 和实际 mesh 使用关系；原 numeric owner 的私有子模块在同一 GLB 流中
验证 IBM 关联前缀的 affine 第四行、全部消费者的最紧 joint 范围，以及逐顶点
跨所有 sets 的非零 joint 唯一性。全整数权重按 UBYTE×257/USHORT 精确求和65535；
含 FLOAT 时只强制有限与非负，不将近1、全零或零权重 joint 的推荐升级为硬拒绝。
混合 primitive、未绑定 mesh、IBM 多余尾矩阵和 affine singular 矩阵保留合法性。

新增关联动态有效载荷上限为16 MiB、预估工作上限为67,108,864，均在首 BIN 字节前
核验；这两项是新增 skin 准入子限额，不是进程内存或设备/GPU成本。所有别名的
group/set/role 使用关系保留，原 raw-layout 去重、raw bounds、64 KiB窗口和原数字
上限不变。关联状态只留关节与标志，不留转换后的值数组；每顶点完整检查后递减
固定计数器，finish为O(1)。结构摘要独立限125,536bytes，U=0时不申请；其预处理
工作及图/scene工作分别有界，未计入关联16 MiB或原 raw components。

当前纯包223项（skin24项）、桌面资源14项及两crate Clippy/fmt、合同导出与ADR
检查通过。真实GLB覆盖60个非零影响、跨远views同extrema错误配对、全部alias消费者、
两默认限额恰好接受与增加一个vertex时零BIN读取拒绝；两ZIP入口和source/variant
快照删除源后坏内容无投影拒绝、正确安装、drop后重开已验证。原失败夹具日志保留。
只退役已验证skin字段及合法base skin属性的 blanket拒绝，morph JOINTS/WEIGHTS
仍明确拒绝；metadata false和模型运行门保持，sparse/extensions/codec/准备成本、
受控loader、私有实例、绝对动画求值与GPU呈现继续后续验证。

normalized rotation/weights 内容续接已接受 normalized BYTE/UBYTE/SHORT/USHORT
的 STEP/LINEAR/CUBICSPLINE 存储。原旋转值检查按有效分量计算，SNORM 的两个最小
编码均为 -1；四元数平方长度容差仍为原 1e-4，cubic 只检查 value 的单位长度，
不修正作者键或强制导数为单位值。整数 bounds 仍比较 raw extrema，全部实际
base/index/timestamps 角色保持；相同布局只扫描一次，不由首个 alias 的
normalized 字段决定旋转意义，没有新增 Job 状态、转换数组或运行解释器。

本次纯包 197 项通过（normalized 11 项），桌面资源 13 项通过，覆盖四种整数
与两种属性/三种存储模式、端点/别名/raw bounds、非 seek 短读跨 64 KiB、读前
工作上限、source/variant 的真实 ZIP，以及 source 删除后的坏旋转无投影拒绝和
正确快照安装重开。两个 crate Clippy/fmt、合同导出和 ADR 检查通过；原失败夹具
日志保留。metadata false 与模型运行门不变，实际 loader 的转换与播放仍待验。

FLOAT TRS 动画内容续接已复用同一 typed owner 与数字扫描：translation/rotation/
scale 的 STEP/LINEAR/CUBICSPLINE 存储、目标引用/形状/count、真实非负严格递增
时间键及关键帧四元数已检查。纯包 171 项通过（动画 18 项），桌面资源 11 项
通过，包含源删除后重复时间键在 projection 前拒绝，以及正确动画快照安装重开。
这属于文件内容检查；模型运行门、片段选择和绝对动画播放仍需后续实现。

morph 与 FLOAT weights 内容续接仍使用原结构/动画 owner 和同一 BIN 扫描。
纯包 186 项通过（morph 15 项），桌面资源 12 项通过，包含 source 删除后坏
delta/权重在 projection 前拒绝，以及正确快照安装重开；两个 crate 的 Clippy、
fmt、合同导出和 ADR 检查通过。metadata 仍为 binary_content_validated=false；
这些结果没有授予 loader、动画求值、保守几何包络或 GPU 呈现资格。

targets 保留作者 semantic→accessor maps；M 取第一个定义 targets 的 primitive，
只有定义 targets 的 primitive 必须同 M。混合无 targets 的 primitive 和空 target
object 合法，不展开隐含零 delta。POSITION/NORMAL/TANGENT delta 为 FLOAT VEC3；
UV/颜色 delta 可用 FLOAT 或 normalized BYTE/UBYTE/SHORT/USHORT，bounds 比较 raw
分量。颜色 base/delta 可为不同 VEC3/VEC4；delta 不套 base 单位方向或颜色范围。
mesh/node 默认 weights 保留有限作者 f64 值，负数、>1、非 unit-sum 均合法；
省略值/继承不物化。显式空数组、null、缺少同名 base 或错误 count/ref/shape 拒绝。

used weights 动画要求 node 实例化 M>0 的 mesh，可与 matrix 共存；FLOAT SCALAR
output 精确为 K×M×(cubic?3:1)，每个 cubic key 按 M 个 in→M 个 value→M 个 out
存储，所有分量均须有限。normalized rotation/weights 内容检查见上文续接；
实际 loader 转换和动画求值仍需独立验收。
局部 targets/weights 数组各限 16384、属性 map 限 32、semantic 限 64 bytes；
全 GLB 的显式 target objects、target refs、mesh+node 作者 weights 总数分别限 16384，
在 typed 后、事实复制/引用遍历和首 BIN 字节前检查。唯一 layout 的读前数字上限、
64 KiB 窗口和完整 GLB hash 不变；别名仍保留所有实际 base/animation 角色。

静态 BIN 续接使用同一 `Read` 流完成唯一 GLB framing、typed 结构及数值检查，
不为 accessor 重开 ZIP entry。纯包 153 项通过（数值 22 项），桌面资源 10 项
通过：实际 NaN 在 projection 前拒绝，正确数值快照在删除 source 后可安装重开。
新增不可手构的 `CheckedGlbResource` 绑定本次完整 GLB 读取的 SHA-256，原包入口
再次核对该 digest；内部 metadata 的 `binary_content_validated=false` 仍保留。
此结果仅证明下列数字子集，不证明传递图片、loader 或运行资格。

同日续接完成 GLB 的核心静态结构前置检查，原 Model source/variant 包入口
先调用唯一容器 inspector，再解析有界 typed schema。结构阶段纯包 131 项通过
（模型结构 33 项），最终桌面资源导入 9 项通过，包含有效容器内的坏节点环在
资源投影前拒绝。结构结果显式保持 `binary_content_validated=false`。

| 资源 | 已实施检查 | 仍需实施与验收 |
| --- | --- | --- |
| GLB | v2容器与有界JSON；核心静态typed依赖/view/accessor/graph/作者scene/node/变换/mode及三角形metadata上界；同包图片/材质五槽UV引用；真实索引/有限FLOAT/bounds及NORMAL/TANGENT/COLOR_0；FLOAT TRS动画；核心skin结构/逐顶点关联、morph delta/defaults及FLOAT/normalized rotation/weights存储与实际值；静态无图GLTFLoader消费/私有实例离线回归 | sparse、扩展、实际材质/图片解码、完整ModelInput/准备与成本；私有opacity材质、有效bounds、绝对动画播放及GPU呈现 |
| KTX2 | 普通 2D header、16384 单边与 64 MP、mip 索引、DFD/KVD/SGD/level 范围及溢出/重叠；按压缩方式核验长度与层对齐 | DFD/格式语义、真实 Basis worker/转码、GPU 格式选择和预算、解码选项与 context 缓存身份 |

GLB 限 `model/gltf-binary`，所有 Model source/variant 都检查。Texture 中
`image/ktx2` 的 source/variant 都检查。共享同一文件的每个资产角色先检查
MIME，再去重内容检查；公共入口遇到手构 Manifest 的缺失 Model/Texture 引用
返回 `missing_file`，不会 panic。其它资源的既有检查入口保持。

未知 GLB 版本/chunk、JSON glTF 入口，以及数组/cubemap/3D KTX2 仍明确不可用。
KTX2 压缩层不要求普通层的 mip padding；BasisLZ 的
`uncompressedByteLength` 必须为零，Zstd/Zlib 必须非零。
读取范围检查不推断 DFD 合法、解压内存、格式支持或压缩收益。

容器阶段验证包括 `hertz-wallpaper` 98 项（新增容器 15 项）、桌面真实
staging/projection/install/reopen 路径、源文件删除后快照独立性、坏容器在
projection 前拒绝、hash 错误优先于内容检查，以及两个 inspector 的有界读取。
锁定 Three 0.186.0 writer 生成的真实 Zlib 两层 KTX2（首层 offset263）已由
原包入口接受；Node/Python 解压分别核对为 64/16 字节。这份 fixture 只验证
容器兼容性，不授予产品 decoder/GPU 资格。受影响 Rust 回归与独立审查记录
保存在 `output/design-final-followthrough/`。

容器阶段桌面壁纸回归以四个测试线程运行，499 项通过、2 项沿原条件忽略。
默认并发先前有一项64 MiB稀疏包测试触及既有10秒等待上限，日志保留；
该项独立运行1.04秒通过，四线程完整回归也通过。两个crate的all-target
Clippy、fmt、两份壁纸合同exporter与ADR 414项检查通过。

结构第一子集使用内部 BIN，外部 buffer URI、data URI、外链及不符合原包路径
规则的图片 URI 明确不可用。矩阵 accessor 使用完整 column padding 和
component 对齐；vertex 四字节对齐按 bufferView 内的局部 offset/stride检查。
各数组在多余元素生成前限额；图片与任何 accessor 都不能占同一 view。
节点最多5000，两个独立三角形metadata上界各限100万，不把作者的bounds/count
当实测几何。重复图片URI共享同一不可变别名列表，避免4096图片×1000别名生成
超过196 MiB的重复引用。包相机不会改变组合 canvas 相机。

核心材质五种纹理引用要求所用 primitive 有对应 TEXCOORD；未用材质不虚构
primitive。正交相机 magnification 可为负但不能为零。custom scalar/vector
属性保持有界；UINT32的当前 Khronos 正文为 SHOULD NOT，而 accessor schema
辅助描述仍为旧 MUST NOT，两者措辞不一致。本metadata子集按正文接受typed
custom UINT32，运行loader/GPU资格仍关闭；不据此声称两份来源一致。
核心骨骼内容检查见上方续接；稀疏和扩展payload在各自内容检查实施前明确不可用。

模型结构阶段的早期桌面广泛回归552项通过、2项忽略，构建早于最后规格修正，
仅保留该版本归属；最终源的资源导入9项和纯包131项另有日志。不能把旧广泛
回归当成最终模型或设备资格。

实际数字检查按精确 offset/count/stride/component/shape 布局共享一次扫描，但
每个 accessor 的声明 bounds 分别比较。重叠而不同的布局计入读前工作量：唯一
布局总 elements 最多16777216、components 最多67108864，超限在首个 BIN 字节
前拒绝。按下一个元素位置顺序读取，固定64 KiB窗口保留跨块元素；完整矩阵
column padding及stride间隙不解释为数字。未引用BIN字节仍流读并参与hash。

索引小于全部使用该布局的primitive最小vertex count，且不得含component最大
保留值。所有FLOAT accessor（含unused/custom）拒绝NaN/Inf。所有已声明bounds
对实际逐分量极值精确比较，normalized整数使用raw整数，FLOAT声明先round到f32。
结构中的FLOAT min/max顺序也在f32精度下比较，保留原声明值；两份JSON值不同
但round到同一个实际极值时可以接受，整数仍按raw值判断顺序。独立SPEC发现的
误拒绝在该唯一component精度owner修正，真实ZIP入口修正前/后证据分别保留。
NORMAL/TANGENT.xyz的squared length误差≤1e-4是本静态子集的显式数值容差，不
改写向量、不称官方常量；TANGENT.w必须±1，COLOR_0 FLOAT必须在[0,1]内。
这些都是资源内容事实；没有把作者metadata计数升级为完整准备/GPU成本。

动画事实仍在原 ModelStructure 内，私有子模块不产生另一套动画运行表示。
省略animations合法，显式空数组按核心schema的minItems要求拒绝。
每个文件最多1024 clips，typed数组在超额物化前各限16384条，跨clip的samplers/
channels总量各限16384（typed之后检查）。所有sampler input为FLOAT SCALAR且
有bounds；实际时间键即使来自unused sampler也须非负、finite并严格递增。
target.node缺失的channel按核心规范忽略，不计入used duration；显式null拒绝。
非ignored targets在每clip内唯一，TRS不能作用于有matrix的node。动画view与
vertex/index/image角色互斥，不得stride或target。

FLOAT output形状对应TRS属性，count精确为键数×1或cubic的×3；cubic至少两键，
仅每in/value/out三元组的value部分要求单位四元数，finite的非unit导数保留。
相同布局的全部linear/cubic角色合并，不能因为另一个alias丢掉单位值约束。
duration metadata只用非ignored channel所用input.max在f32精度下的上界，metadata
API仍未读取实际键值。原数组索引/name保留，不虚构重名clip或运行选择规则。
normalized动画的文件内容检查见上文；实际0.186 loader的表示转换仍需独立验证，
内容接受没有授予它资格。原数字工作量上限、固定64 KiB读取及完整GLB hash身份没有放宽。

下一步沿同一包合同与资源准备、预算、pool、renderer、clock owner 完成上表
剩余项。HWPK1 / documentVersion1 / Config5 不变；此切片不完成整个 P2-03
或 A04/A05/A06/A10 总实施计划。
