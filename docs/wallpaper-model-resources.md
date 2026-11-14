# GLB / KTX2 资源实施记录

2026-11-12，原 `BudgetRequest` 的 grant/check_requests 与 `SessionPlan::new`
复用同一身份规则：session 非空且最多 128 UTF-8 bytes，generation 非零，task id
沿原 local id 规则最多 64 bytes。session 仍允许 Unicode、冒号与大写，不套用
task 的字符规则；身份失败在 shape 校验最先拒绝，诊断不复制或格式化申请字段。

`grant_session` 在原 ledger 锁内借用资源计划，全部 shape、64 条 metadata 与资源
quota 校验成功后才建立原 `SessionResources` 的自有副本。pending 与已确认墓碑
继续占 metadata，真实退出才归还资源额度，确认后 forget 才回收记录。
本波只完成有界 request metadata 和准入后 clone 前置；完整 Nnative、canonical
path/Arc 生命周期、联合 W/R、同一不可变工厂输入、ModelInput 与 GPU 接线仍待
实施验收，不授予 native 资格或完整 320 MiB/GPU 准入。

2026-11-12，原 native `budget::global()` 的唯一 `OnceLock<Arc<BudgetCoordinator>>`
先保有原 Arc，然后每次返回前在原 Ledger 的同一 Mutex 内等待 scene 与 composition
两目录就绪。scene 成功、composition 拒绝或 panic 时，原 Arc 与 scene 永久费用
继续存活；没有 ready 返回，poison recovery 重试只构造未成功的 composition。
两个 inline 三态 process record 复用原账本，不增加 ready cache、token 或 manager。

scene 费用仍取原 `ManifestHeapBounds::for_bytes(0)` 及两个 catalog getter：
cold workspace 1,502,113 bytes，permanent asset 1,136,036 bytes。composition
费用由原 `document::catalog` 所有权边界的字段私有 Copy
`CompositionCatalogHeapBounds::for_embedded_catalog()` 查询给出：cold 93,356 bytes，
permanent 91,820 bytes。查询与原 `composition_catalog()` 借同一私有 embedded
constant，不解析、初始化或分配；64-bit 原 types/BTree witness、固定 JSON 长度/SHA、
原 catalog/json 源码及 Cargo.lock 的编译时 text identity 失配返回 None。Rust/lock
文本仅以栈 SHA 流式等价 LF/CRLF，不复制；bare CR 保持身份，composition JSON 保持精确 raw SHA。依赖/std 精确
source hashes 和 wallpaper/desktop/media-probe/studio full 完整 feature graph 仍须
独立 verified-build 审核；sizeof 加 JSON hash 不能检测任意同尺寸源码变化，变更须重审。
已审计配置为 serde 1.0.229/serde_json 1.0.151 float_roundtrip，原 raw_value 可开启，
preserve_order/arbitrary_precision 的布局拒绝。费用只保证原 embedded 成功源，
不为任意无长度上限 public `parse_catalog` 输入提供 W。

固定 composition JSON 14,314 bytes、509 owned Strings 共 3,396 UTF-8 bytes，
原 nodes/effects Vec 各 capacity 8、String Vec 总 backing 516 slots、Value arrays
24 slots、AssetKind 56 byte slots，Field maps 18 leaves/5 internals；asset/quality/cost
6/5/5 leaves。真实原类型布局的 checked 源式得到 R=91,820。scanner 递归 frontier
S=2,263，最大 single-grow old backing G=1,536，raw top key schemaVersion=13，
stack SHA 的一次 hex write=64；W=max(S,R+G,R+13,R+64)=93,356 是完整 cold bound。
原 fixed float 都走 lexical fast path，无 scratch/Bigint，成功校验借用且返回只 move。

每个目录均在首分配前核 source 资格及既有 prepare/asset 两 cap，分别预约 W/R；
任一不足不进入 initializer。原 OnceLock 成功发布后立即无 allocation/fallible/外部
callback 内联提交 prepare=0、asset=R。panic 的 partial parser 先真实 drop，再由
原账本 stack guard 仅退款未成功目录。两项保守预约之和不是物理峰；两目录都 ready
时 process asset 总额为 1,227,856 bytes。process 不占 session metadata、prepare task
或 preview 槽；grant/check_requests/grant_session、replacement projection、resource
allocate/release/confirm_exit/forget/purge 均保留两费，独立 `BudgetCoordinator::new()` 为零。

原 `AssetStore::new` 唯一生产工厂最早等待同一 global，再进入 RootOwner 与文件系统；
覆盖原 validate_staged/verify_installed/read_installed_manifest 的 archive composition
validate/compile 早于 plan/read_document 的路径，以及 native pin/read、public properties
和 selection 恢复。原 app/init_log→global→upgrade/Config 与 normalize_builtin 既有
global 入口继续；纯库不依赖 native budget。pins、不可变身份、错误与安装规则保持。
真实 requested System old+new meter、原类型/node allocations/capacities 和 cold 子进程
核对同 Arc/两 catalog 地址、一遍初始化、双费用预约、临界拒绝、partial drop/poison
重试及原资源消费者，证据在
`output/design-final-followthrough/canonical-model-composition-r23/impl/`。
canonical AssetStore 的联合包络绑定、完整 compact ModelInput、jobs/broker anchoring、
renderer GPU first frame 和 A04–A10 仍后续；总体目标 active，model gate closed，
本波不授予整体 320 MiB 或 GPU 资格。

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
已由原 native process owner 独立计入。composition 目录账本已由本波接入；canonical AssetStore 联合包络、compact
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

纯 GLB inspector 现在提供 `inspect_glb_with_cancel` 和完整内容入口
`inspect_glb_resource_content_with_cancel`，借用可选 `AtomicBool`；原入口继续使用
无 token 路径。原 `ContainerReader` 的所有底层同步读取（包括整个 JSON）每次
最多 64 KiB，前后以 Acquire 检查取消；空 read/skip 也检查但不调用底层 I/O。
原完整 schema、数值工作量上限、缓存窗口及未用 BIN 的完整 SHA-256 保持。
数值窗口 fill/skip 不再把 `cancelled` 改成 `invalid_model_binary`。
有 token 时也保留原 ZIP reader 的 typed payload 取消；无 token 入口仍保留
原 I/O 分类。识别该已知类型不会调用外部错误的 Display/Debug/Source。

取消是协作式的：同步 `Read` 已阻塞时，token 不会中断该调用，资源和实际读取
必须一直存活至调用返回、检查取消并退出。真实非 Interrupted I/O 失败优先于
同次读取的取消，诊断仍只格式化固定上下文、ErrorKind、OS scalar 和原逻辑起点；
成功的 CPU 阶段之间及数值循环检查取消，已产生的语义失败保留原分类。
borrowed token 只增加栈上指针，唯一短取消诊断使用原固定 allowance；有限的
System meter 回归检查原 `ModelHeapBounds` 下的峰值与 drop=0，不建立经验费用。
这只是后续 native binding 的前置修复，native/ModelInput/GPU 准入门仍关闭。

`AssetStore::pin_canonical_model_source` 现在提供已安装 original File 的 canonical
Model source / 精确 variant 工厂。它先验证有界 AssetRef，再取得原 prepare
opening 工作区 Wc；在 RootOwner 的 absolute verbatim disk/UNC 前缀下以单个预分配
PathBuf 逐级固定 packages/hash/files 和 canonical entry 的父目录。目录拒绝
reparse、允许读写共享但拒绝删除；original 与 projection File 只允许读共享。
在 Wc 下取得这个 immutable File 的实际长度，以完整原 limits 查询并取得 Wi，
账本检查 Wc+Wi 同存不超过320 MiB，之后才读包。较大的 metadata 工作区仍会
拒绝；不缩小原 ZIP limits，也不把包长度当成 metadata 实际用量。
同一个 original File 完整 SHA-256 核对后 seek 到开头，借给原 canonical
identity inspector；不重新打开 original、不信任 receipt 或 caller Manifest。
只有 canonical Model、source 或精确 variant、model/gltf-binary，以及原声明与
全部已验证 entry 的 path/bytes/SHA/MIME tuple 相等才可选择；投影长度与完整
SHA 另行复核。未知资产、非 Model 和未知 variant 都失败，没有 fallback。

成功工厂只 move 整个 original identity、两个原 File、目录 pins 和 RootOwner
Arc 到私有 outer source。调用方只能 clone outer Arc 或借用引用/entry/manifest
事实，不能取得裸 File、独立 media Arc 或自行构造 source。保留票由原 Probe
准备票派生，继承实际 job session/generation；Wc/Wi 计原 prepare CPU quota，R
计原 asset CPU quota，不占 decoder/context/GPU。失败 scope 先释放文件和
identity 再确认 Wi/Wc；最后一个 outer anchor drop 时先释放全部资源再确认自身 R，
不会 purge 同会话其它资源。原 ImportJobs 单槽、内容写门、typed oneshot、取消与
严格终态数据库守卫复用；终态失败或等待期间取消不能发送成功 source，receiver
丢失时返回的 source 随原 send 结果 drop。

这段 checked source factory 费用来自 actual RootOwner
path/目录 Vec capacity 与 actual Arc<T> 布局、AssetStore root 和输入 AssetRef
实际 capacities。native path upper bound 为 canonical root encoded bytes +261；
单个 path backing、Windows wide `(L+1)*2` 和92个 File pins均在 grant 前通过
checked Layout，File 内联值不另造 heap。原普通 grant 元数据只计 actual private
Reservation 布局的32→64旧新同存96个 body和64份有界128+64 request字符串；
调用方 prepare/Wc/Wi/R 的字符串另外同存计费。Wi 使用同一个 original File
metadata 提供的可信实际长度调用原
`CanonicalIdentityHeapBounds::for_package_bytes::<&mut File>(actual, None)`；
原512 MiB上界的完整 Wi 约8.41 GB，不能假称它适合320 MiB quota。
固定 scalar I/O 诊断只分配一个
108字节 String：已审计1.88与当前stable的最长 ErrorKind 名称为22字节
StaleNetworkFileHandle，外部错误 Display/Debug/Source 不运行。64/128 KiB
预owned错误的真实 System 样本核对这个请求界，样本不是经验费用公式。
R 使用 original identity 自己记录的实际 manifest retained fee，加同存 native
owner 控制；transfer 期间 Wc/Wi/R 保守重叠。process catalogs 1,227,856字节继续
由原 owner 单独长期记账，不随 job 退还。

此费用名义仅为 source factory bounds；没有组合 legacy JobRequest/history/channel/
终态诊断常驻、SessionResources/projection 或完整 Nnative。尚未把 outer source
接入当前 MediaAccess/ReadPermit/Broker 流，完整 ModelInput/native runtime/GPU/
首帧资格门保持关闭。完整 checked GLB R207,392,124字节仍超过128 MiB，下一波
必须在 W 内产生 compact ModelInput，不能 deep clone 或缩小完整 profile 来替代。
完整 A01–A10、HWPK1/Config5、canonical unused entries、权限与别名保留不变。

`CheckedGlbResource::into_compact` 现在消费原完整 checked owner，move 整个
`ModelStructure`、原 BIN range、完整 SHA32、总字节、source path 和 NumericFacts，
只释放原 JSON backing，并保留 JSON 字节数。所有 author-indexed / unselected
记录、morph maps / weights、skin / binding、动画 name / interpolation / ignored
channel、Matrix/TRS、mode / pivot / presence、min/max 和 image alias 均保留。
原 metadata 的 `binary_content_validated=false` 语义不改变。没有第二 parser、
第二 tree、flat arena、deep clone 或 shrink。compact 不能从 caller structure
构造，也没有 Clone/Default/Deserialize 或 mutable getter。

compact retained query 使用 actual Vec/String capacities，逐项包含全部 root
数组、min/max、primitive/target/default-weight、animation sampler/channel/name、
skin joints、node children、scene roots、node weights，以及每个 image 的实际
path/MIME/SHA 字符串。原 String→usize BTree 的 verified x64 leaf368/internal464
采用非空 `368+96*(m-1)`；空 map 保守计368，不把 len0 当作任意 tree 没有 backing
的证明。key String backing 另计。shared image reference Arc 通过 preceding
records 的 `Arc::ptr_eq` 无 scratch 去重，unique slice 计两个 AtomicUsize header、
actual slice Layout 与全部 asset/variant id String backing；每 record 字符串仍计。
4096 images 的 scan 最多8,386,560次 pointer comparisons。pure caller Manifest
没有 canonical reference 字符串或总条目界，查询不采用109,935,396候选最大值。
unsupported layout / checked Layout、转换、加乘 overflow 返回 inline Copy error，
失败也不分配诊断。有限 System allocator fixtures只核对上述实际请求，不建立
meter slope 或完整输入最大值定理。

原 `AssetStore::prepare_canonical_model_input` 与 `ImportJobs::prepare_model_input`
现在返回私有 outer `ModelInput`。工厂自行取得新的 canonical source；固定
`&mut CanonicalModelSource` 操作先 `Arc::get_mut`，拒绝任何 clone 后才读取，借用
immutable canonical Manifest、精确 entry 与原 pinned projection `&mut File`
调用唯一完整 inspector。原 source 已 seek0；检查完整 SHA32/bytes/path 与该
entry 相等，hex decode 使用 fixed32数组。没有 File getter、callback、try_clone、
reopen、独立 source/media pin Arc 或 caller checked-result minting 入口。

private ModelInput source mode 在 source Wc 与 source R 内显式增加
`Cmodel=actual Arc<ModelInputInner> Layout + 2*(128+64) new W/R request String
floor + original query diagnostic59 + ordinary Dgrant987 + fixed native literal34`。
source-only mode仍传0。原 `ModelHeapBounds::for_json_bytes(MAX_TEXT_BYTES,
canonical Manifest).workspace_with_live_base(actual_source_R_charge)` 在完整 model
读取前计这个 live base，使用原320MiB W / 128MiB R 与64-record账本，不在旧
3*192 ticket allowance 中隐藏新费用。Wi/Wc 已退出，不把 Wi 与 model W 相加。
完整 inspector/compact 和 actual retained query在 W 下完成；只对 compact payload
另取 ownFactsR，source R 已含 native Arc/body 和两个新 request floors，R在
escaping Arc allocation 之前取得。最后 outer clone释放时先 drop compact，再
释放 canonical source 的 outer Arc、identity/Files/pins，将原 sourceR ticket 移入
无资源、不可 Clone、无公开 constructor 的 inline guard。随后 finish ownFactsR，
在 sourceR/Cmodel 仍覆盖 facts-ticket strings 时释放其 caller 与原 ledger backings，
最后 guard.finish sourceR；不 purge sibling。

native `facts()` 只返回与 `&ModelInput` 同寿命的 borrowed view，保留 stream/JSON/BIN
长度与 range、SHA32、path、全部 NumericFacts 和每个原结构字段。无 Arc 的原数组
借用为 immutable slices，images 使用 allocation-free ExactSize/DoubleEnded borrowed
enum iterator，只借用 package reference slice 或 embedded range；不借出整个
CompactCheckedGlbResource/ModelStructure/ModelImage、Arc、Weak 或 owner callback。
pure ModelStructure/ModelImage 和完整 compact getters/Clone 合约不改。

source 与 input 的每个 clone 都消费私有 `Option<Arc<Inner>>` 并调用安全
`Arc::into_inner`；无 escaped Weak 的最后消费者在 Arc backing 的实际 deallocation
之后才清理 move 出的 Inner。构造中失败仍有 resource-first Inner Drop fallback。
原 Reservation 的显式 armed bool 与最多128字节 stack session 保留原 consuming
finish 合约；caller session/task String 在 pending 占用下释放。原 coordinator 的
ordinary retirement 在同一 mutex 下核对 token/session/generation，拒绝 resources
或 children，保持 scalar 占用直到原 ledger request strings 与该 record 已销毁。
普通 Drop 仍只 release，原 confirm/forget/purge/tombstone 合约保持。

r28 两编译器 actual x64 layouts 单独验证：Reservation160，source Inner728/Arc744，
input Inner624/Arc640，两个 outer 与 Option<Arc> 均8，inline source guard160，
Cmodel2104（较 r27 增8）。source Wc/sourceR 自动按 source Arc 实际 Layout 计入
相应增8；model W 使用 live sourceR，与已退出 Wc/Wi 分阶段。guard与 stack identity
不是新增 heap owner。typed Result source48/input208、producing-thread oneshot
requested104/264、cfg(test) source/input futures344/480；cfg(test) worker_loop5688
仅为该 test build witness，完整 production worker frame 与 pre-source admission
仍待原 control task 证明。

原单一 System test allocator 的 fixed-capacity cross-thread pointer/Layout capture
只在真实 System.dealloc 返回后记 event，before/after gates 不分配或进入预算 mutex。
原 quota 饱和下的真实 successor grant 核对 input/source Arc、unique shared image
backings、最后 File pin-vector、caller/ledger strings 的实际退出先后；两/八个同时
final input clones 与两/八个 source clones 均要求 capture overflow=false、drop 分配0、
facts refund 在 source payload 后与 source refund 最后。完整 borrowed fields 对真实
rich installed source/exact variant 的原 inspector 逐字段比对，view 与 exhausted
iterator 分配0；编译 fixtures 另拒绝 owner lifetime、whole structure/image、Arc/Weak
提取，并验证原 pure Clone 仍可用。

`ModelPreparationError` 私有持有 `Option<JobError>` 与 `Option<Guard>`，不能 Clone
或裸提取 JobError。pre-W query/grant失败保留同 source R 与 pins，直到实际 error
consumer drop。post-W scope先在已含 source/Cmodel 的 W 下释放 partial/full facts
和 source，再返回 W-only guard。原 model 的长诊断在 W 下释放后才构造固定 literal
`canonical model preparation failed`，保留原 static code；不调用外部 Display/
Debug/Source。error Drop先释放整个 JobError（含 details），再 source，再显式
W.finish。原 worker在 terminal DB wait / retry和slot return间将guard保留在generic
outcome旁，existing Err不被DB失败覆盖，成功input在late cancel/DB失败时释放；
typed reply只做一次owned transfer，receiver丢失或没有reply时先释放outcome再guard。
prepare task ticket/单槽退出与小error所持的大W是不同生命周期。

真实 rich GLB/installed ZIP、source删除/store重开、exact variant、未用BIN完整hash、
actual W/R denial、64记录、unique-source refusal、borrowed pinned File实际read返回
后的确定取消、最后clone/pins、同session sibling、pool close、BEGIN IMMEDIATE终态
wait/cancel与receiver loss覆盖这条原路径。long invalid-token fixture显式以
identity-valid、故意未做full resource validation的测试安装进入model inspector，
不声称完整package validator接受它。Config测试只比较实际文件bytes/absence和DB
manifest，没有证明live Config5 revision journey。

inline guard使原 typed oneshot payload和native async frame变大：channel allocation
在source成功前发生，不能由之后Cmodel倒付，也不能称zero-cost。两编译器实际
producing-thread System allocator日志和cfg(test)实际source/input future size日志
单独记录该frontier；这些test-build future数值不宣称是production worker frame费用。
尚未组合完整 pre-source channel/request/frame/status/history/DB/persistent controls、
shared RootOwner/permanent ledger storage与其它原 control destructor tails。returned guard
只保护其实际held JobError，不保护额外history/progress copies。image projections
仍需canonical closure与真实pins/codec费用；outer input还未贯穿原Broker/cache/
ReadPermit/stream/clone。loader/runtime/CPUready/GPU/first-frame与完整A01–A10目标
继续开放，全部qualification gates保持关闭；此checked-facts输入不是运行成功替代。


2026-11-12 r29 启动准入续接：原 BudgetCoordinator在 stack Ledger中先预记
自己 Arc及64条 Reservation的固定 backing费用，随后创建 Vec和 Arc。
OnceLock持有该生产实例直到进程退出；confirm/forget/purge不能退回这些容量。
原独立 stack new保持零进程费用，原 scene/composition费用和配额检查与该 floor
相加；advisory projection保留原进程占用。checked Layout使用两个 Arc atomic
counters与真实私有类型，并以原单一 System allocator逐工具链检查请求字节。

该改动仅闭合生产账本启动及其固定 record backing；普通 request strings仍沿原
保守 metadata费用及退出合同。advisory实际副本、RootOwner/ImportJobs、线程与
production worker frame、request/reply/status/history/query/SQLx等仍需各自准入
和物理退出证明。纹理闭包、Broker/SessionPlan/loader、同renderer GPU首帧和
原 A01–A10剩余要求继续保持未验收。未发布构造 panic只释放该 stack实例；
已发布目录失败后保持同一 Arc和常驻费用，沿原 poison恢复路径重试。

2026-11-12 r30 控制准入续接：`check_requests` 与桌面替换预检现在只构造
固定大小的 `BudgetProjection`，保留同一锁内读取的进程费用、用量、墓碑记录数
和预览输出占用；不复制 Reservation、请求字符串或资源计划，也不授予 token。
仅省略指定代际的 Active Desktop；ReleasePending 与 Released 墓碑仍保留原规则。
投影生成后保持冻结，session/child 元数据仍沿原预检口径省略。
真实 grant 与预检共用 `budget_checks.rs` 中的一套 shape、配额及检查顺序。
`GlPlan::new` 直接读取原用量快照，AI 继续使用同一规划器。

拒绝对象与其 clone 只持有静态文字和标量；`BudgetDiagnostic::Display` 在原消费
边界生成原完整文字，quota/cap/held/requested 与 JobError 映射保持原合同。
此前普通 grant 诊断费用 API 的保守上界保留，但被移除的首份格式化 String
不再列作真实存活对象；调用方格式化与响应副本仍需自己的准入。

生产启动 floor 另预留 `64 * (128 + 64) = 12,288` requested bytes，覆盖同一
账本全部有界 session/task 字符串 clone，包括未回收墓碑；它在首次 Vec/Arc
分配前入账，退出、forget 与 purge 后保留。冷启动实际分配仍只有 Arc/backing，
字符串 headroom 不冒充冷启动物理堆。独立 stack `new()` 保持零进程费用。
完整请求/响应、SessionResources/children、RootOwner/ImportJobs/SQLx、线程、
production worker frame 与状态历史仍未由此闭合；纹理闭包、Broker/loader、
同 renderer GPU 首帧及原 A01–A10 的完整验收继续开放。

2026-11-13 r33 控制准入续接：`ImportJobs::reserve` 在单槽忙判定之后、
status/cancel 构造之前，于同一把 `inner` 锁内调用原账本 `admit_controls`。
控制费用为 `A(Mutex<JobStatus>) + A(AtomicBool) + len(job_id)`（std repr(C)
ArcInner 布局公式），只写 inline 标量，不占 64 条 reservation metadata；
成功与拒绝都不分配账本元数据，拒绝仍只产出静态 `BudgetDiagnostic`。
`ControlCharge` 声明在 `JobRequest` 字段最后，随真实 request 销毁才归还；
忙分支保持 r31 的 54B 静态文案，配额拒绝先放锁再构造 `{quota}: {diagnostic}`。
`BudgetUsage` 新增 `control_prepare_cpu_bytes` / `control_records` 分项并计入
原 `prepare_cpu_bytes`，advisory projection 同步保留。

worker 线程在 `block_on` 前先构造真实 production future 并用 `size_of_val`
查询实际 frame 字节，在同一账本准入后显式 `Box::pin`；guard 留在 `block_on`
外面，worker loop 退出、Box 销毁后才退款。显式 Box 是审计允许的所有权选择，
阈值以下也会增加一个基线 Box。SVG 准备与字体排空测试改用新增的
`remaining_prepare_workspace()` 请求剩余未占用上限，`grant` 仍在同一锁内
原子复核，因此控制与工作区之和可恰好达到原 cap。

本批不声称 typed oneshot/reply、dispatch 返回 id clone、RootOwner/线程/
runtime/SQLx 初始化所有权、status/history/query/JSON/DB 副本准入，或完整
closure/Broker/SessionPlan/loader/GPU 首帧。另修复一个前置基线问题：
`LOCK_SOURCE_SHA` 与 0.3.4 发布提交后的 `Cargo.lock` 不一致（该提交只改第一方
0.3.3→0.3.4 版本行，依赖图未变），刷新该 fail-closed 常量后 HEAD 才能进入
`budget::global()`。

2026-11-14 r40 纹理闭包续接：`ModelInput` 在 compact facts 之后、retained
facts-R 之前构造 `ModelTextureClosure`。每个 `ModelImage::Package` 记录逐一
绑定到 canonical identity 中由原 ZIP 实际长度/SHA-256 核验的 entry，要求
path/bytes/SHA-256/MIME 与闭包事实完全相等，SHA 另解码为固定32字节；缺失
entry、tuple 不符、MIME 不符、空 references 一律 fail-closed。Embedded image
不进入闭包（字节已由 checked BIN 承担）。同路径别名共享同一 entry，唯一源
字节只计一次，但聚合上界按全部 Package 记录保守求和，上限
`MAX_MODEL_TEXTURE_SOURCE_BYTES=256 MiB`，记录数沿用 `MAX_MODEL_IMAGE_RECORDS`。

闭包固定记录 `ClosedTexture`（image/entry 索引、bytes、SHA32、references）
在分配前以 `Layout::array` 精确请求独立 `model_texture_closure_bytes` 小额度
（2 MiB，不并入 prepare/asset）；准入仍只写账本标量、拒绝只产出静态
`BudgetDiagnostic`。记录 Vec 先于 charge 字段声明/销毁，物理释放后才退款；
真实 rich fixture 的 3 条 Package 记录绑定 2 个 entry、唯一源字节 8、精确入账
168 字节，`PhysicalReleaseCapture` 证明 System.dealloc 返回且 Vec 析构未完成
期间额度仍占用。三处变异（跳过准入、提前退款、缩小源字节 cap）均按预期变红。

本批只闭合 canonical 元数据绑定：未打开纹理文件、未做真实 pins/完整 SHA
重算/codec 费用；Broker/SessionPlan/loader/同 renderer GPU 首帧与 A04 整体
继续开放，全部 qualification gates 保持关闭。

2026-11-14 r41 纹理 pins 续接：闭包第二遍在单一预分配 PathBuf 下拼出
`<root>/packages/<hash>/files/<canonical path>`，复用原 source factory 的
`reset_path`/`append_segment`/`open_file`（只读共享、拒绝 reparse）打开每个唯一
纹理；`metadata.len()` 必须等于 entry bytes，随后复用 `read_source_sha256`
（64 KiB 栈缓冲、Acquire 取消检查）完整重算 SHA-256 并逐字符与 canonical entry
比较，再 seek0 保留 File pin。缺失文件映射 `model_texture_missing`，长度或摘要
不符映射 `model_texture_mismatch`；任务取消沿原协作式 token 退出。`ClosedTexture`
增加 file_index 后仍为 56B；同 entry 的重复 image 记录复用同一 File。

闭包 charge 现精确覆盖三项 backing：记录 Vec（count×56）、File pin Vec
（count×8，唯一 pin 少于保守容量）与保留的 path 容量（root+261）；仍走独立
`model_texture_closure_bytes` 桶，字段顺序 records→files→path→charge 保证三项
System.dealloc 全部返回后才退款。真实 rich fixture 入账 168+24+path 容量
（本次 root 355 → 547 字节），pin 期间纹理不可写、全部 clone 销毁后可写；
`PhysicalReleaseCapture` 逐项 gate 三个 backing 并确认退款最后发生。三处变异
（跳过完整 SHA 比较、pin 改为共享写/删、charge 提前声明）均按预期变红后还原。

本批仍不创建 decoder/renderer/GPU：Broker/SessionPlan/loader、同 renderer
首帧、KTX2 转码与 A04 其余矩阵继续开放。

2026-11-14 r42 纹理只读接口续接：`ModelInput::texture_read_permit` 返回借用型
`TextureReadPermit<'a>`（无 Clone/owned 提取，不能活过 input，也不暴露 File/
path/closure owner）。permit 提供 `texture_bytes(image_index)` 与
`read_into(image_index, offset, &mut [u8], cancel)`：按 image 索引找固定记录，
`offset+len` checked 不得越过 entry bytes，单次输出 ≤1 MiB；使用 Windows
`seek_read` 位置读，不消费/移动共享 File 游标，多个 permit/克隆可交错读取；
循环填满、Interrupted 重试、读取间隙检查取消，提前 EOF 映射 mismatch。错误码
固定为 `model_texture_bounds`/`model_texture_missing`/`model_texture_mismatch`/
`cancelled`；成功路径零堆分配（measure_requested_heap 峰值 0）。

真实 fixture 覆盖整段/偏移/尾部/零长读取、Embedded 与未知索引、u64::MAX 偏移、
越界、取消，以及用 1 MiB+1 不可压缩纹理证明 1 MiB 单次上限；同 Arc 的两个
permit 位置读互不影响。三处变异（去越界检查、去取消检查、去 1 MiB 上限）均按
预期变红后还原。本批未创建 decoder/renderer/GPU；Broker HTTP/CSP、
SessionPlan、loader、首帧与 A04 其余矩阵继续开放。

2026-11-14 r43 纹理资源索引续接：`ModelInput::texture_resources` 返回借用型
`ModelTextureResources<'a>`，为未来 loader/Broker 提供只读清单：`len()` 为唯一
Package entry 数；`iter()` 逐项给出 path/MIME/bytes/解码后的 SHA32/references/
代表性 image_index；`authorize(path)` 只对 canonical identity entry 的完整路径
做精确相等匹配，后缀斜杠、`..`、双斜杠、大小写变化、查询串、模型相对别名和
非纹理 entry 全部返回 None。索引与授权不拼路径、不重开文件、不新增分配；
授权句柄 `TextureResource<'a>` 只借用 input，并复用 r42 的 `read_into` 位置读。

闭包内新增零分配 `UniqueTextures` 迭代器，按 entry_index 去除同路径别名
（O(n²) 有界，n≤4096）；不向父模块暴露 ClosedTexture/File。真实 fixture 清单
为 tex.png（references=2、image 0）与 other.png（references=1、image 2），
SHA32 与 [1,2,3,4] 一致；索引+迭代+授权整体 measure_requested_heap 为 0。
三处变异（path 前缀匹配、去重移除、descriptor 字节数改错）均按预期变红后还原。
本批未接 WebView/HTTP/CSP、未改 MediaAccess/SessionPlan、未创建 decoder/
renderer/GPU；loader 与首帧继续开放。

2026-11-14 r44 纹理计划租约续接：`ModelInput::grant_texture_plan(session,
generation)` 返回 `ModelTexturePlan`，把 r43 索引绑定到有界 session（≤128B，
inline 存储、无新堆分配）与非零 generation；plan 持有 input clone，因此 source/
facts/File pins/闭包 charge 在 plan 存续期间不能退出。`matches` 同时校验 active、
session 与 generation；`permit(path)` 只在 active 时走 exact-path 授权并返回借用
lease；`revoke` 原子失活后新 permit 为 None，既有 lease 的 `read_into` 返回固定
`model_texture_revoked`，否则复用 r42 位置读。

真实 fixture 证据：grant 后 drop 原 input，usage 保持；lease 读 tex.png 得
[1,2,3,4]；revoke 后拒绝；plan drop 后 usage 回 baseline。空/129B session 与
generation0 拒绝，128B/u64::MAX 接受；grant+permit+read 的
measure_requested_heap 为 0。三处变异（permit 忽略 active、lease 读取忽略
active、matches 忽略 generation）均按预期变红后还原。本批仍未接
WebView/HTTP/CSP、未改 MediaAccess、未创建 decoder/renderer/GPU；loader 与
首帧继续开放。

2026-11-14 r45 纹理 controller 续接：`ModelTextureController` 持有唯一当前
`ModelTexturePlan`（`Mutex<Option<..>>`）。`install(input, session, generation)`
要求严格更大的 generation；同代/回退/非法身份拒绝且不改当前 plan。换代时锁内
replace、锁外 drop 旧 plan，旧 plan 的 input clone/闭包 charge 随之实际退出。
`revoke` 清空 plan 并返回是否存在；`read_into(path, offset, &mut out, cancel)`
在锁内通过 exact-path `plan.permit` 同步读取，无 plan/伪路径返回 None，读错误
透传；lease 不逃逸，controller drop 自然释放最后 plan。

真实 fixture 证据：g1 安装后读取，g1/0 回退拒绝、g2 接受；drop 原 input 后
usage 保持，controller revoke 后归零；revoke 后读取 None，再安装 g3 成功。
空/129B session 与 generation0 不改变空状态；空串/尾斜杠/`..`/大小写/查询串/
glb 路径全部 None。install+read 的 measure_requested_heap 为 0。三处变异
（install 允许同代、read 忽略 path、revoke 不清 plan）均按预期变红后还原。
本批未接 WebView2/HTTP Range/CSP、未改 MediaAccess、未创建 decoder/renderer/
GPU；loader 与首帧继续开放。

2026-11-14 r46 会话生命周期续接：`WallpaperSession` 增加
`ModelTextureController` 字段。`admit_textures(generation, input, session)` 只在
当前 generation 且状态为 Attaching 时调用 controller install；非当前代际、
非 Attaching 或非法 session 身份不改变已有 plan。`read_texture` 委托 controller
锁内 exact-path 同步读。`retire_current_resources` 在 apply/disable/fail 路径
先 revoke 纹理 plan；由于是同步 pins、没有 controller-close 屏障，撤销立即释放
plan 的 input clone 与闭包 charge。`WallpaperSession` 的 Debug 通过 controller
自定义 Debug 保持。

真实 fixture 证据：会话 g1 在 Resolving 时 admit 拒绝，Attaching 后接受并读到
[1,2,3,4]；generation+1 与空 session 拒绝；apply 新意图后旧 plan 读取 None 且
usage 仍由原 input 持有；g2 重新 admit 后读取成功，disable 后读取 None；最后
drop input 回到 baseline。三处变异（retire 不 revoke、admit 忽略 Attaching、
admit 忽略 generation）均按预期变红后还原。本批未接 WebView2/HTTP Range/CSP、
未改 MediaAccess、未创建 decoder/renderer/GPU；loader 与首帧继续开放。

2026-11-14 r47 分块 loader 读取续接：1 MiB 单次读取上限提升为
`MAX_MODEL_TEXTURE_READ_BYTES`（model_prepare），闭包与 session 共用。
`ModelTextureController::chunk_reader(path)` 返回借用型
`ModelTextureChunkReader`；`WallpaperSession::texture_chunk_reader` 直接委托。
reader 记录 total/offset，`next_chunk(&mut [u8], cancel)` 每次最多填 1 MiB 并
前进；EOF/空输出返回 0；path 在创建时 exact-path 授权；每次读取重新进入
controller，revoke 后返回固定 `model_texture_revoked`，取消透传；不复制整文件、
不分配。

真实 fixture 证据：4B 纹理按 3+1+0 分块且字节为 [1,2,3,4]；空串/尾斜杠/glb
无 reader；1 MiB+1 不可压缩纹理按 1 MiB+1B 两块读取并逐字节一致；会话 fail()
撤销后新 reader 为 None、read_texture None，新代际可重新准入；controller 级
reader 在 revoke 后下一块返回 `model_texture_revoked`；cancel=true 返回
cancelled；reader 创建+读取零分配。三处变异（offset 不前进、忽略 EOF、把
revoked None 当成功）均按预期变红后还原。本批未接 WebView2/HTTP Range/CSP、
未改 MediaAccess、未创建 decoder/renderer/GPU；loader 表示转换与 GPU 首帧继续
开放。

2026-11-14 r48 Broker 形响应计划续接：`WallpaperSession::plan_texture_response`
复用 `media_stream::parse_range_header/plan_response`，对当前 session 纹理给出
HEAD/GET/Range 计划与窗口 reader：HEAD 200 无 body、GET 200 全量、可满足范围
206 + `bytes a-b/N`、不可满足 416 + `bytes */N`、多范围/非数字 400；未知/伪
路径返回 None。body 窗口由 `ModelTextureChunkReader` 从 range start 起按
≤1 MiB 读取；`chunk_reader_range` 用 checked start+length 限制在 canonical
字节内；body=true 但窗口 reader 缺失时整体 fail-closed。

真实 fixture 证据：HEAD (200,4,false,None)；GET 200 读 [1,2,3,4]；
`bytes=1-2` → 206/2/`bytes 1-2/4` body [2,3]；`bytes=-2` → `bytes 2-3/4`
body [3,4]；`bytes=9-` → 416/0/`bytes */4` 无 reader；多范围与非数字 → 400；
glb/空串 None。1 MiB+1 纹理全量响应两块读完，末字节范围
`bytes=1048576-1048576/1048577` 正确；fail() 后重新计划 None。三处变异
（忽略 Range、body 总从 0 开始、HEAD 当 GET）均按预期变红后还原。本批未接
WebView2 WebResourceRequested/CSP/crossOrigin、未改 MediaAccess、未创建
decoder/renderer/GPU；真实 HTTP 响应与 GPU 首帧继续开放。

2026-11-14 r49 授权键集续接：`ModelTextureController::with_resource_keys` 在
controller 锁内取 active plan，遍历 r43 唯一资源索引，回调
`(package_hash, canonical path)` 并返回条数；无 plan/撤销时返回 0，不分配、
不借出 File。`WallpaperSession::with_texture_keys` 直接委托，调用方可用同一
session generation 填充既有 `MediaAccess::replace`。

真实 fixture 证据：键集恰为 tex.png/other.png 两条、hash 为 package hash；
`MediaAccess::replace(generation, &keys)` 成功，permit 两条纹理路径 Some，
glb 与错误 hash None，同代重复 replace false；fail() 后键集为空。键遍历
`measure_requested_heap` 为 0（2×64 hash + 16/18 路径字节 = 162）。三处变异
（去重移除、混入 model glb、path 置空）均按预期变红后还原。本批只把键集交给
broker access；webresource 真正服务 model 纹理、MIME/Origin 与解码/GPU 仍未
接线。

2026-11-14 r50 授权发布续接：`MediaAccess::replace_owned(generation, Vec<..>)`
避免 replace 的二次 clone，保留 512 上限与代际递增规则；`replace` 委托
`to_vec`。`WallpaperSession::publish_texture_access(access, generation)` 要求
generation 等于 session 当前代际，用 with_texture_keys 收集键并发布；空/撤销
plan 也发布空集，从而清除上一代际的纹理键；stale generation 在触碰 access 前
拒绝。

真实 fixture 证据：g1 发布后 broker permit tex/other 均为 Some、glb None；
stale g+1 发布 false；fail 后 apply 新代际再发布空集，旧 permit 变 None；旧
代际再发布 false。三处变异（发布空键集、跳过空集清除、key 写成 model glb）均
按预期变红后还原。>512 纹理模型沿用 MediaAccess 既有上限 fail-closed，本批未
扩展；WebView 实测与 GPU 首帧继续开放。

2026-11-14 r51 响应状态语义续接：`ModelTextureController::has_plan` 只在锁内
判断当前 plan 是否存在；`WallpaperSession::resolve_texture_response` 返回
`ModelTextureResolution::{Response,NotFound,Unavailable}`：有当前 plan 且路径
命中 → Response，有 plan 但路径未知 → NotFound，无 plan/撤销 → Unavailable。
`plan_texture_response` 保持原 Option 语义不变。broker 证据使用真实已安装投影：
发布键集后 `pin_verified_media` 对 tex.png 返回 4 字节/`image/png`，重读文件为
[1,2,3,4] 且 SHA 与闭包一致；未知路径返回 Err(io)，与 webresource 404 映射
一致。三处变异（无 plan→NotFound、未知路径→Unavailable、命中→NotFound）均
按预期变红后还原。本批未接 WebView2 响应头与 app 生命周期；GPU 首帧继续开放。

2026-11-14 r52 KTX2 DFD 续接：`inspect_ktx2` 在既有 header/level 范围检查之后
解析唯一的 Khronos BASIC descriptor block：totalSize 必须等于 header 的 DFD
长度；vendor/descriptorType word 必须为 0、version 必须为 2、blockSize 必须
等于 DFD 长度减 4 且为 24+16×n；colorModel 不得为 UNSPECIFIED，flags 只允许
bit0；texel block 必须是单平面 2D（dim2/dim3 解码后为 1）、每边 ≤32；
bytesPlane[0] 必须非零且能被 typeSize 整除，bytesPlane[1..8] 必须为 0；
每个 sample 的 position 必须落在 texel block 内、bitOffset+bitLength 不得超出
texel 平面。supercompression=0 时按 mip 递减尺寸
`ceil(w/blockW)×ceil(h/blockH)×bytesPlane[0]` 逐 level 校验 uncompressed
长度；supercompressed 不猜测解压后布局。DFD 通过既有 ContainerReader 前向
skip 到 offset 后以 4+8+16B 固定块与 16B/sample 流式读取，不保留 sample 表。

真实证据：最小 RGBA8 fixture DFD 92B（colorModel 1、primaries/transfer 1、
texel block [1,1,1,1]、bytesPlane [4,0..]、4 samples）被接受并暴露
`Ktx2DataFormat`；真实 KTX-Parse writer + Zlib fixture 继续通过。反例：非零
vendor/type、version 1、colorModel 0、dim2/dim3 非 1、bytesPlane 多平面均
`texture_container_unavailable`；totalSize/blockSize 不符、level 字节数与 DFD
布局不符、sample bit/position 越界、bytesPlane 与 typeSize 不符均
`invalid_texture_container`；两 mip（4×4/2×2）逐 level 尺寸校验，破坏 mip1
即拒绝。三处变异（跳过 level 尺寸校验、接受 UNSPECIFIED colorModel、跳过
sample position）均按预期变红后还原。本批不实现 BasisLZ/UASTC 解压、KTX2→GPU
格式选择、转码 worker 或真实 GPU 上传/首帧；多 block/vendor DFD fail-closed。

2026-11-14 r53 BasisLZ SGD 续接：supercompression=1 时要求 SGD 存在且位于 DFD
之后，解析 20B 头（endpoint/selector 计数与四段字节数）、逐 level 20B
imageDesc（RGB/alpha slice）与数据段：计数必须在 1..=16128，endpoints 字节数
必须等于 count×4、selectors 同理；总长必须等于
20+20×level_count+四段数据和；RGB slice 非空且 offset+length 落在该 level
payload 内，alpha 同理，alpha>0 时两者不得重叠。validated 事实以
`Ktx2GlobalData` 暴露，非 BasisLZ 为 None；数据段只 skip，不解释 ETC1S/Huffman。

真实证据：pinned KTX-Parse writer 生成并用其 reader 回读的 `basislz.ktx2`
（4×4、ETC1S DFD、1 level/8B、SGD 56B：2 endpoints/1 selector/1 imageDesc，
SHA ca653a8f…）被接受，DFD/level/SGD facts 精确匹配；反例：zero SGD、
SGD 长度 55、endpoints 字节数 12、endpoint count 0、rgb slice 9 > level 8
均 `invalid_texture_container`。三处变异（跳过 SGD 校验、跳过总长校验、
跳过 slice bounds）均按预期变红后还原。本批不做 ETC1S 解码、GPU 格式选择、
转码 worker 或 GPU 上传/首帧；UASTC 仍只做容器/DFD 结构校验。

2026-11-14 r54 纹理 URL 绑定续接：`ModelTextureResources::url(image_index)`
在唯一 closure 记录中按 image index 查找，用已安装 entry path 与 input 的
package hash 调用既有 `webresource::files_url`，产出
`https://<hash前32>.<hash后32>.wallpaper.invalid/files/<path>`；
`ModelTexturePlan::texture_url` 要求 plan 仍 active，
`ModelTextureController::texture_url` 锁内委托，
`WallpaperSession::texture_url(generation, image_index)` 先要求 generation
等于当前代际，stale/撤销后一律 None。未新增 File 所有者或响应路径。

真实 fixture 证据：index 0/2 精确得到 tex.png/other.png URL；index 1 是同路径
别名的非唯一记录、index 3 是 Embedded、index 4 未知，三者均 None；stale
generation None；fail 撤销后 None。三处变异（url 恒 None、session 忽略
generation、URL 只返回 path）均按预期变红后还原。本批不发起浏览器请求、不接
WebView2、不创建 decoder/renderer/GPU；URL 是可服务性绑定，不是实际 HTTP
响应或 GPU 首帧证据。

2026-11-14 r55 KTX2 上传选择续接：新增纯策略模块 `ktx2_upload`，输入已验证
container 与调用方声明的 `Ktx2UploadCapabilities { astc, etc1, etc2, dxt,
bptc }`（对应 Three KTX2Loader 探测的 WebGL 扩展），输出
`Direct { vk_format }` 或 `Transcode { target, srgb, rgba_bytes }`。RGBA8_UNORM
总是 Direct；BC1–3/BC6H–7/ETC2/ASTC LDR 分别要求 dxt/bptc/etc2/astc；
BC4/5、EAC、未知格式与非 Basis 超压缩 fail-closed。ETC1S/UASTC 目标优先级
ASTC4x4 > UASTC BC7 > BC3/BC1（alpha 决定）> ETC2 RGBA/RGB >
ETC1S 非 alpha 非 sRGB 的 ETC1 > RGBA8；rgba_bytes 按全部已声明 mip 求和。
DFD 事实新增 `has_alpha`（任一 sample channel 低 4 位为 15）。

真实证据：basislz fixture（ETC1S、无 alpha）全能力 → Astc4x4/64B；Zlib fixture
（vk37/sc3）→ unavailable。合成矩阵覆盖各 family 有无 capability、ETC1S/UASTC
全目标链、sRGB、两 mip rgba_bytes=80。三处变异（忽略 capability、transcode
恒 RGBA8、rgba 只算 level0）均按预期变红后还原。本批不探测 GPU、不运行转码
worker、不上传纹理、不产生首帧；Direct/Transcode 只是策略结果。

2026-11-14 r59 loader 材质事实续接：`ModelStructure` 在原有校验通过后保留三组
固定容量事实（≤4096）：`materials`（PBR baseColorFactor、五类纹理引用、normal
scale、occlusion strength、emissiveFactor、alphaMode/alphaCutoff、doubleSided）、
`textures`（source/sampler）、`samplers`（缺省字段落成 glTF 默认 mag 9729、
min 9987、wrap 10497）。新增 `material_texture_bindings(material)` 零分配槽位
表示转换：固定 BaseColor→MetallicRoughness→Normal→Occlusion→Emissive 顺序，
逐项解析 texture→image、sampler（无 sampler 用默认）、texCoord；未知 material
为空迭代，不拼接路径、不读文件、不借出 File。

真实 fixture 证据：两材质文档保留 PBR factors、normal scale 0.5、occlusion
strength 0.5、MASK/0.25/doubleSided 与默认材质；三纹理分别使用显式 sampler0、
只声明 wrapS 的 sampler1 与无 sampler，槽位得到 9728/9729/33071/33648、
9729/9987/33071/10497 与全默认 9729/9987/10497/10497；texCoord 0/1/0/0/2 与
image 0 全部匹配。桌面 complete-facts 测试解构新增三组字段并逐项比对 native
投影与纯 crate 槽位。`fact_roots()` 与 compact retained 计入三个固定容量 Vec。
三处变异（调换槽位角色、minFilter 默认写错、用 texture 索引冒充 image）均按
预期变红后还原。本批不创建 decoder/renderer/GPU，不发起浏览器请求，不接
WebView2；loader 实际 Three 表示转换与 GPU 首帧继续开放。

2026-11-14 r60 textured-PBR loader 续接：受控 Three 工厂新增
`STATIC_TEXTURED_PROFILE='static-pbr-texture-v1'` 与
`parseTexturedModel(buffer, expectedFacts, { textureUrl, ... })`，不改动既有
`static-core-pbr-v1` 的 102 项契约。允许 images/textures/samplers/materials，
材质仅支持 baseColorFactor/baseColorTexture、metallicFactor/roughnessFactor/
metallicRoughnessTexture、alphaMode/alphaCutoff/doubleSided；normal/occlusion/
emissive 等其它槽位与扩展明确拒绝。纹理支持 embedded bufferView PNG/JPEG 与
外部 URI：外部 URI 必须由调用方 `textureUrl(uri)` 映射（同包 broker URL），
未映射在加载前拒绝且不发起请求。sampler 缺省值落成 glTF 默认；baseColor 与
MR 不得引用同一 texture index（避免 GLTFLoader 按 source+sampler 缓存导致的
colorspace 复用）。primitive 必须按槽位 texCoord（0/1）声明 TEXCOORD_n，仅允许
POSITION/NORMAL/TEXCOORD_0/1，仍要求 packed FLOAT accessor、POSITION bounds
与三角形上界。

`verifyTexturedActual` 核对真实 MeshStandardMaterial：color/opacity/metalness/
roughness、alphaMode 的 transparent/alphaTest/depthWrite、doubleSided、map/
metalnessMap/roughnessMap 身份（texCoord>0 时 GLTFLoader 逐次 clone，按
image+channel+sampler+colorSpace 核对）、flipY/wrap/filter、UV/UV1 accessor、
纹理对象数（原图+clone）、材质/几何数量与释放。真实 Chrome 测试
（`scripts/check-wallpaper-model-textured-browser.js`）：本地 HTTP + import map
加载锁定 Three 0.186.0，内嵌 2×2 PNG 与外部 PNG（经 textureUrl 映射）均真实
解码；材质 0.25/0.5/0.75/0.8、metal .4/rough .6、MASK .3、双面、两纹理与
wrap/filter/colorSpace 精确匹配；释放后纹理 4/材质 2/几何 1 次 dispose，重复
instantiate 拒绝；负例（缺 TEXCOORD、非法 sampler、normalTexture、未映射 URI）
均在加载前失败且外部请求仅 1 次。三处变异（TEXCOORD 名称映射、33071 wrap 映射、
sRGB/linear 期望反转）均按预期变红后还原。本批不创建 WebGL renderer/GPU 上传、
不产生首帧，也不接 WebView2 broker 响应；normal/occlusion/emissive 槽位与 KTX2
解码继续开放。

2026-11-14 r61 材质槽位续接：textured-PBR profile 新增 normalTexture（scale）、
occlusionTexture（strength）、emissiveTexture 与 emissiveFactor；五个槽位统一
要求 texCoord 0/1 的 TEXCOORD_n，且被使用的 texture index 必须互不相同，
否则 `texture-slot-sharing` fail-closed（避免 GLTFLoader 按 source+sampler
缓存把 colorspace/channel 泄漏到其它角色）。验证新增 normalMap/normalScale、
aoMap/aoMapIntensity、emissiveMap/emissive（linear）；无 TANGENT 时 GLTFLoader
会克隆最终材质并把 normalScale.y 取反，按该真实行为核对。材质分配事实改为
每个使用中材质 2 份（原材质 + derivative-tangent clone）。

真实 Chrome 证据：5 张 2×2 PNG（4 内嵌 + 1 外部 emissive），base0/MR1/clone、
normal1/clone、ao0、emissive0；normalScale 0.75/-0.75、aoMapIntensity 0.6、
emissive 0.1/0.2/0.3、各槽 wrap/filter/channel/colorSpace 精确匹配；释放
纹理 8（5 原图 + 3 clone）/材质 2/几何 1，重复 instantiate 拒绝；外部请求
恰好 1 次。负例（缺 TEXCOORD、非法 sampler、共享 texture index、PBR 未知字段、
未映射 URI）均在加载前失败。三处变异（normalScale.y 符号、aoMapIntensity、
emissive colorSpace）均按预期变红后还原；旧 loader 102 项与前端聚合 86 步保持
通过。本批仍不创建 renderer/GPU/首帧、不接 WebView2；KTX2 与真实设备能力
继续开放。

2026-11-14 r62 组合时间线轨道续接：新增纯 `composition/animation.js`（区间二分、
linear/easeInOut `j*t²(3-2t)`/step 取左键、首末键 clamp），`plan.js` 校验 target
slot/keys/easing/范围，并对文本重排与粒子 count/seed 轨道 fail-closed；
`runtime.js` 在 timeChanged 时将轨道值写入 numeric、按 slotDependencies 的 node
mask 更新受影响节点并恢复 base（plan diff 仍比较作者/公开值，plan 替换时重置
visualTime）。真实 Rust IR + Chrome 像素：opacity 0.2→0.4→0.6→reverse 0.4→
loop 0.2 得到 124/170/203/170/124；纯求值 linear/ease/step/clamp 通过。三处
变异（step 取右键、easeInOut 公式、paused 跳过轨道）均变红后还原；33 项
composition 检查、前端聚合 86 步通过。bindings 栈程序、效果图与 GPU 时间继续，
组合运行门不变。

2026-11-14 r63 组合 binding 续接：`animation.js` 新增 `validateBinding` 与
`evaluateBinding`，实现编译器 0–10 opcode（input/parameter/const/add/mul/sin/
cos/abs/clamp/map/smoothstep）与调用方预分配 scratch stack；非有限中间值返回
null。`plan.js` 接受 bindings、构建 bindingParameters 并按公共
`BindingParameter` target 覆盖（越界/非有限 fail-closed）；`runtime.js` 每帧在
轨道后执行 bindings（input 白名单映射 energy/bass/mid/high/pointerX/pointerY/
sceneTime/spectrumN，缺省 0），按 add/multiply/replace 组合，动画目标槽每帧
重新 applyNode，binding parameter 变化纳入 plan diff。

真实 Rust IR + Chrome 证据：multiply 绑定 `clamp(sceneTime*gain+0.5,0,1)` 在
sceneTime .2/.6 像素 218/255；公共 gain=0 覆盖后 188；纯求值 map=15、
smoothstep=.5、abs/sin/cos 组合通过。三处变异（sceneTime 输入恒 0、map 公式、
忽略 binding parameter 覆盖）均变红后还原；34 项 composition 检查与前端聚合
通过。效果图、GPU 时间/首帧与真实音频设备校准继续开放。

2026-11-14 r64 output colorAdjust 续接：`plan.js` 接受 target=output 的 colorAdjust，
校验 brightness/contrast/saturation/hueDegrees 四项有限，返回 `outputEffects`；
节点效果、其它效果类型与链式多效果继续 fail-closed。`runtime.js` 最终输出
shader 增加四项 uniform：线性空间加亮度、绕 0.5 对比度、Rec.709 亮度饱和度
混合、hue 旋转矩阵，再走既有 `colorspace_fragment`；无效果时恒等参数，plan
替换时更新输出 uniform。

真实 Rust IR + Chrome 像素：红色底图 saturation=0 得到 127/127/127；
brightness=0.2 得到 255/124/124。三处变异（忽略 saturation、忽略 brightness、
plan 丢弃 outputEffects）均变红后还原；35 项 composition 检查与前端聚合通过。
ripple/wind/mask/glow、节点离屏后处理、效果图 surface 预算与 GPU 时间继续开放。

2026-11-14 r65 节点 ripple/wind 续接：`plan.js` 接受 target.kind==='node' 的
ripple/wind，按 nodeId 解析索引并限定 image/video/text/particles，校验
amplitude/frequency/speed 与 strength/speed/directionDegrees 有限、assets 为空，
同节点重复同类型 fail-closed；效果写入 `nodePlans[index].effects`，不增加
surface/program/primitive 预算。`nodes.js` 节点片元 shader 增加
`effectUv(uv, base)`：ripple 以 base.y 正弦横向位移，wind 沿 direction 正弦位移；
粒子路径改用 `gl_PointCoord` 求值。`runtime.js` 在 timeChanged 时把时间线采样
时间写入 `effectTime` uniform 并标记输出。

真实 Rust IR + Chrome 像素：wide 半红半绿图 ripple amplitude=1/frequency=8/
speed=0 时第 2 行与第 6 行发生相反位移（右上翻红、左下翻绿），t=1 快照与 t=0
一致；speed=1 时 t=.25 由红翻绿。wind direction=0 时左绿右红，direction=90 时
恢复左红右绿（只作用于另一轴），speed=1 时 t=.25 左列翻红。三处变异（去掉
ripple 位移、wind 忽略 direction、runtime 不更新 effectTime）均变红后还原；
38 项 composition 检查连续 3 次通过，前端聚合 86 步通过。mask/glow、节点离屏
后处理、效果图 surface 预算与 GPU 时间继续开放。

2026-11-14 r66 节点 mask 续接：`plan.js` 接受 target.kind==='node' 的 mask，
校验 `invert` 布尔与 `maskAsset` 字符串，写入 `nodePlans[index].effects.mask`；
资源闭包把 effect 的 maskAsset 资源 use（nodeIndex=null）解析到目标节点的
`resources.maskAsset`，同一节点 schema mask 与 mask effect 并存时 fail-closed。
`nodes.js` shader 增加 `maskInvert` uniform，alpha 按
`mix(mask, 1-mask, invert)` 采样。

真实 Rust IR + Chrome 像素：cutout 遮罩（左白右黑）普通 mask 左红右黑，invert
后左黑右红。三处变异（plan 丢 invert、资源闭包拒绝 effect use、shader 忽略
invert）均变红后还原；39 项 composition 检查连续 3 次通过。glow（output
surfaces=2/drawPasses=3）与效果图预算、离屏后处理、GPU 时间继续开放。

2026-11-14 r67 output glow 续接：`plan.js` 接受 target=output 的 glow，校验
strength/radius/threshold 与 IR `effectSurfaces`/`staticRequirements` 的
count/inputTextures/rgba8/sampleScale/cost（surfaces=2、drawPasses=3、
bytesPerPixel=4）；按 `ceil(target*sampleScale)` 计算两半分辨率 surface，
resources 增加 `2*w*h*4` render target 字节、2 program、3 draw call/6 triangle。
`runtime.js` 新增 threshold 与 5-tap 线性采样高斯 blur 材质，render 在场景
target 后执行 threshold→blurH→blurV 到两个 RGBA8 surface，最终输出先加
`glow*strength` 再走 colorAdjust；resize 提交 glowTicket，dispose/retirement
释放 surface 与 ticket。

真实 Rust IR + Chrome 像素：16×16 白块中心 255，块外 8px 由 0 变为 69；
strength=0、radius=0、threshold=1 三种对照块外均 0；renderTarget 持有字节相对
无 glow 增加 32×32×8=8192。三处变异（忽略 threshold、blurStep 恒 0、不预留
glowTicket）均变红后还原；40 项 composition 检查连续 3 次通过。GPU 时间/首帧、
真实设备矩阵与 A01/A05–A10 剩余验收继续开放。

2026-11-14 r68 节点 colorAdjust 续接：`plan.js` colorAdjust 分支同时接受
target.kind==='node'，限定 image/video/text/particles、校验四项属性有限与空
assets，写入 `nodePlans[index].effects.colorAdjust`；同节点重复 fail-closed。
`nodes.js` shader 增加 hasGrade/gradeBrightness/gradeContrast/gradeSaturation/
gradeHue 与 gradeColor（线性空间加亮度、绕 0.5 对比度、Rec.709 饱和度、色相
旋转），在 video 传递后、alpha 前 clamp 应用；updateNodeMaterial 写入参数。

真实 Rust IR + Chrome 像素：红色节点 saturation=0 得 127/127/127，相邻绿色
节点保持 0/255/0；brightness=0.2 得 255/124/124。三处变异（shader 忽略饱和度、
plan 丢弃节点效果、updateNodeMaterial 不写 hasGrade）均变红后还原；41 项
composition 检查连续 3 次通过。GPU 时间/首帧、真实设备矩阵与 A01/A05–A10
剩余验收继续开放。

2026-11-14 r69 native glow 准入续接：`composition_plan.rs` 的
`validate_structure` 改为效果 allowlist（output: colorAdjust/glow；node:
colorAdjust/ripple/wind；带 assets 的 mask 与 tracks/bindings/3D 继续
fail-closed）；`Costs` 按 IR `EffectSurfaces` 的 count/sampleScale/cost 计入
surface 字节、glow 2 个 program 与 drawPasses 个 draw call，并同步进 `gpu`、
`pageLimits.renderTargetDeclaredBytes` 与 `programs`。新增 Rust fixture 测试
发射 video+glow 的真实选择/GlAdmission 投影（effectSurfaces=2、sampleScale=.5、
cost 2/3/4、RT=64*64*16+2*32*32*4、programs=4），`check-wallpaper-composition-
native-page.js` 在真实原生页面加载该投影并断言 firstFrame、budget.error=null、
HertzGlBudget 字节相对基线 +8192、卸载后 contexts=0。

验证：两工具链串行全量各 853 passed / 0 failed / 2 ignored，clippy 双工具链
通过；原生页面检查连续 3 次通过并写出 glow 截图/evidence；三处变异（pageLimits
丢 effect 字节、glow 不记 program、runtime 不创建 glow surface）均变红后还原；
composition 41 项与前端聚合 86 步通过。mask 原生资源准入、tracks/bindings/3D
原生 adapter、GPU 设备矩阵与 A01/A05–A10 外部验收继续开放。

2026-11-14 r70 native tracks/bindings 续接：`validate_structure` 移除 tracks/
bindings 拒绝，保留 3D fail-closed；按 JS adapter 语义拒绝 builtinScene 轨道、
text 布局轨道与 particles count/seed 轨道。新增 Rust fixture：video + x 轨道
（0..4s → 0..1）+ opacity binding `clamp((sceneTime-2.5)*4,0,1)` multiply；
投影断言 tracks/bindings 各 1、programs=2、RT 不变，并发射 `tracks/`。
`check-wallpaper-composition-native-page.js` 加载该投影：sceneTime 109ms 时
输出 [0,0,0]（binding 门未开），3187ms 时 [2,0,63]（轨道/绑定已应用），
budget.error=null、contexts 1→0。

验证：两工具链串行全量各 854 passed / 0 failed / 2 ignored，clippy 双工具链
通过；原生页面检查连续 3 次通过并写 tracks 截图/evidence；三处变异
（native 拒绝 tracks、runtime 不执行 applyTimeline、binding sceneTime 恒 0）
均变红后还原；composition 41 项与前端聚合 86 步通过。mask 原生资源准入、
3D/model adapter、GPU 设备矩阵与 A01/A05–A10 外部验收继续开放。

2026-11-14 r71 native mask effect 续接：`validate_structure` 允许 node mask
（唯一带 assets 的效果）；`validate_resource_uses` 对 effect use 改用效果 schema
校验 kind；`media_costs` 新增 `usage_node_index`，由 effect target nodeId 解析
目标节点，mask 纹理计入 texture_bytes（program/RT 不变）。新增 Rust fixture：
64×64 红底图 + 64×64 mask（左白右黑）invert=false，投影含 mask effect 与两张
prepared image，textureDeclaredBytes=32768，并发射 `mask/`（含 prepared PNG 与
files.json）。原生页面加载后左像素 [255,0,0]、右像素 [0,0,0]，budget.error=null、
contexts 1→0。

验证：两工具链串行全量各 855 passed / 0 failed / 2 ignored，clippy 双工具链
通过；原生页面检查连续 3 次通过并写 mask 截图/evidence；三处变异（native 拒绝
mask、资源 schema 校验忽略 effect、runtime plan 拒绝 effect use）均变红后还原；
composition 41 项与前端聚合 86 步通过。3D/model adapter、GPU 设备矩阵与
A01/A05–A10 外部验收继续开放。

2026-11-14 r72 JS 组合静态 GLB / scene3d 续接：`plan.js` 接受 `model` 节点与
space=3d 的 group，要求合法 `canvas.scene3d`（position/target/米制坐标、fov
1–120、near>0、far>near），3D 节点必须是 painterOrder 前缀（3D 层在 2D 覆盖层
之前，交错 fail-closed）；3D 节点拒绝 effect/track/binding，opacity 必须为 1。
model 资源仅接受 `adapterId=three-gltf-loader`、`decodeOptions.profile=
static-core-pbr-v1`、`modelFacts.profile/loaderVersion` 一致、且无
images/textures/materials 的 core profile；预算按 facts 计
`bufferDeclaredBytes=gpuBufferBytes`、`ownedCpuBytes=encoded+bin+json*2+
cpuBackingBytes`、真实 drawCalls/triangles、depth `pixels*4` 与 +1 program，
同一 GLB 多节点共享 fail-closed。

`runtime.js` 新增 `modelScene`、固定 AmbientLight+DirectionalLight 与
`PerspectiveCamera`（aspect=canvas 宽高比），target 在 3D 时开启深度；render
顺序为 background → 3D → 2D，3D pass 后 clearDepth；resize 更新相机；
`reserveAll`/`reserveDelta` 为 model 建构造 CPU ticket 与
`bufferPlan(cpuBackingBytes,gpuBufferBytes)`；diff 在 model 资源变化时重建节点。
`model-node.js` 用 fetch + `parseStaticModel` 消费真实 GLB，`nodes.js` 保持无
顶层 import（文本布局 VM 检查不变），默认 PBR 材质在本切片以 metalness=0 接受
固定灯光。

真实证据：`check-wallpaper-composition-browser.js` 用 Rust 编译器产出带
scene3d 的真实 IR，manifest/HTTP 提供真实 core GLB（80B BIN、3 accessor）；
相机 [0,0,3]→原点时 45° 视角三角形真实像素命中右上、左下保持黑；节点
position=[.5,.5,0] 后亮区移动；2D 图层覆盖 3D；跨空间顺序、opacity 0.5、
textured profile 三种负例均在预留前拒绝且 ledger 持平。三处变异（plan 忽略
跨空间顺序、3D pass 改用正交相机、绕过 model 加载）均变红后还原；组合检查
45 项连续 3 次通过，前端聚合 86 步通过。

本批只闭合 JS 端无纹理静态 GLB 与固定相机；纹理/KTX2、GLB 动画、逐实例
材质透明度、多材质 program 精确计数，以及原生 `composition_plan.rs` 的
scene3d/model 资源准备/准入仍未实施，GPU 设备矩阵与 A01/A05–A10 外部验收
继续开放。

2026-11-14 r73 JS 组合 textured-PBR 续接：`plan.js` 的 model 资源增加
`static-pbr-texture-v1`：`decodeOptions.profile` 必须与 `modelFacts.profile`
一致，facts 需含 materials/textures/images 且计数与 `resources.textureCount/
imageCount` 相符；投影必须携带整数 `textureUploadBytes`（≥ images×4）与
`textureUrls` 映射，外部图片 URI 必须逐个映射，未映射或多映射 fail-closed；
预算增加 `textureDeclaredBytes/decodeReservedBytes` 与按材质数的 program。
`model-node.js` 按 profile 选择 `parseTexturedModel`，把 `textureUrl` 绑定到
投影映射；成功后提交 upload 票、释放 decode 票，失败路径释放全部构造/解码/
上传票（同时修复 r72 失败加载的票泄漏）。纹理材质保留作者 PBR 参数，仅 core
默认材质继续 metalness=0；3D 场景改为仅 AmbientLight，避免未发布的定向光
镜面项污染 authored 纹理像素。

真实证据：core 与 textured 两套真实 GLB 均由 Rust 编译器 IR + 本地 HTTP
加载。2×2 红/绿嵌入 PNG（NEAREST/CLAMP、metallic=0）在三角形 UV 上得到
左红 [255,0,0]、右绿 [0,255,0]；`ledger.live.textureDeclaredBytes=64`、
decode=0。负例：缺失 `textureUploadBytes` → preparation-required；facts 中
新增未映射外部 URI → texture-url-required，两者均未预留配额。三处变异
（plan 不校验上传字节、textured 改用 core parser、upload 票不 commit）均变红
后还原；组合检查 47 项连续 3 次通过，文本布局 9 项与前端聚合 86 步通过。

仍未闭合：KTX2/Basis 转码与 GPU 格式、外部纹理真实 broker/CSP、GLB 动画、
逐实例材质透明度、多材质 program 精确计数，以及原生 scene3d/model 资源准入、
GPU 设备矩阵与 A01/A05–A10 外部验收。

2026-11-14 r74 原生 static-core facts 续接：`hertz-wallpaper` 新增
`model_profile::static_core_profile_facts(&GlbResource, encodedBytes)`，把已
检查的 GLB 结构转换为 shipped `static-core-pbr-v1` 运行时 facts：input 三长度、
declared 计数、可达 scene nodes/transform、object/allocated 计数、used
accessor/view 布局、geometry key、gpu/cpu 字节与固定材质计数。该函数对
images/materials/textures/samplers/animations/skins/cameras/morph、非
TRIANGLES、非默认材质、非 packed、非 FLOAT VEC3 / 无符号 SCALAR 全部返回
`model_profile_unavailable`；bufferView byteOffset 转为相对 BIN 起点。

新增 example `export_model_profile_facts <glb> <manifest> <path>`，复用
`inspect_glb_resource_content` 的完整 SHA/数值检查后输出 facts JSON。组合浏览器
测试不再使用 JS oracle：mesh.glb 的 `modelFacts` 直接取 Rust 导出结果，再交给
真实 Three GLTFLoader 的 `parseStaticModel` 严格比较与渲染。47 项检查（含真实
三角形像素、平移、2D 覆盖、textured 纹理像素）连续通过，证明 Rust facts 与
loader 实际事实逐字段一致。

验证：新增 2 项 lib 测试（facts 形状/字节与材质拒绝）；两工具链
`hertz-wallpaper` 60/60、`hertz-desktop` 855 passed / 0 failed / 2 ignored；
两工具链 clippy `--all-targets -D warnings` 与 fmt 通过；组合检查 47 项连续
3 次通过、前端聚合 86 步通过。三处变异（bufferView 用绝对偏移、材质分配数
1、objectCount 少算根节点）均使 GLTFLoader facts 比较变红后还原。

仍未闭合：把该 facts 接入桌面 `composition_plan.rs` 的 model 资源准备
（GLB pin/读取、URL 与纹理闭包、成本/pageLimits）与 scene3d 准入、原生页面
像素；KTX2、GLB 动画、GPU 设备矩阵与 A01/A05–A10 外部验收继续开放。

2026-11-14 r75 桌面 model 投影与原生页面续接：`composition_plan.rs` 新增
`PreparedModel`/`CompositionAsset::Model`，对 `AssetKind::Model` 通过
`pin_verified_media` 固定 GLB、以 64KiB 有界读与 `inspect_glb_resource_content`
完整 SHA/数值检查后调用 `model_profile::static_core_profile_facts`，生成
`resolvedAssets{kinds:model, url, byteLength, contentKey, decodeOptions,
modelFacts}`；成本按 facts 计 buffer/CPU/1 program/drawCalls/triangles，3D 节点
增加 depth 4B/px 与 4KiB 页面兜底纹理预算；`validate_structure` 移除 scene3d
一刀切拒绝，改为：3D 必须有合法相机、3D 节点必须是 painterOrder 前缀、opacity
必须 1、model animationClip 必须为空，3D 节点拒绝 effect/track/binding，其余
adapter 语义与 JS plan 一致。

新增 2 项桌面测试：真实安装包 + model.glb 的 selected/projection/pageLimits
断言（programs=3、bufferDeclaredBytes=170、renderTarget=64×64×20、
modelFacts.profile/ drawCalls），以及跨空间顺序/opacity/animation 拒绝。
原生 fixture 发射 `model/`（projection、GLB、files.json、native-init.js、
uri.txt）；`check-wallpaper-composition-native-page.js` 增加 model 阶段：真实
Rust 选择/GlAdmission + 原生页面加载真实 GLB，三角形内像素 >200、外部 <8，
budget.error=null、contexts 1→0，并写 native-page-model.png。

验证：两工具链 hertz-desktop 857 passed / 0 failed / 2 ignored；两工具链
clippy --all-targets -D warnings 与 fmt 通过；原生页面检查连续 3 次通过（glow/
tracks/mask/model 四阶段）；组合浏览器 47 项与前端聚合 86 步通过。三处变异
（跨空间前缀检查、model buffer 字节、3D depth 字节）均变红后还原。

仍未闭合：原生 textured/KTX2 model（当前 `static_core_profile_facts` 对纹理/
材质 fail-closed）、外部纹理 broker/CSP、GLB 动画、逐实例材质透明度、真实 GPU
设备矩阵与 A01/A05–A10 外部验收。

2026-11-14 r76 原生 textured model 续接：`model_profile` 新增
`static_textured_profile_facts`，按 shipped `static-pbr-texture-v1` 输出
materials/textures/images/scene/resources facts：PBR factors 与五类槽位、
texCoord、normal scale/occlusion strength、alphaMode/alphaCutoff/doubleSided、
sampler 默认值、texCoord↔TEXCOORD_n 一一对应（未用/缺失/共享纹理均
fail-closed）。仅接受 Embedded PNG/JPEG；Package 外部图片继续
`model_profile_unavailable`。新增 `embedded_image_upload_bytes`：从完整 GLB
字节解析 PNG IHDR / JPEG SOF 尺寸，按 `2 × w × h × 4` 声明含 mip 的上传上界。

桌面 `prepare_assets` 按结构选择 core/textured facts，汇总
`textureUploadBytes` 并写入投影（`textureUrls:{}`）；成本增加纹理上传/解码
字节与按材质数的 program。新增桌面 textured 测试（`textureUploadBytes=32`、
programs=3、buffer=194、textureDeclaredBytes=4128）与 `model-textured/` 原生
fixture；浏览器组合测试的 textured GLB 也改用 Rust facts 作为唯一 oracle。

验证：两工具链 hertz-wallpaper 61/61、hertz-desktop 858 passed / 0 failed /
2 ignored；双工具链 clippy 与 fmt 通过；原生页面连续 3 次通过（新增
model-textured 阶段：左红 [>200,<20,<20]、右绿 [<20,>200,<20]，
budget.error=null、contexts 1→0）；组合浏览器 47 项与前端聚合 86 步通过。
三处变异（sampler magFilter、跳过纹理上传字节、textured 误用 core facts）均
变红后还原。

仍未闭合：原生外部纹理 URL/broker 发布、KTX2/Basis、GLB 动画、逐实例材质
透明度、多材质 program 精确计数、真实 GPU 设备矩阵与 A01/A05–A10 外部验收。

2026-11-14 r77 原生外部纹理续接：`static_textured_profile_facts` 增加
`model_path` 参数并接受 `ModelImage::Package`：由包内路径去除模型目录得到
作者 model-relative URI，facts.images 输出 `source:external/mime/uri`；
`image_upload_bytes` 独立公开，供嵌入与外部文件共用（PNG/JPEG 尺寸 ×2 上界）。

桌面 `prepare_assets` 对 Package 图片逐个 `pin_verified_media`、核对
path/bytes/SHA/MIME、有界读取并计算上传字节，生成 `textureUrls`（URI→
files URL）与 `texture_pins`；`PreparedComposition::pins()` 将纹理条目与普通
assets 一并交给 `MediaAccess::grant_composition`，绑定后外部纹理路径以
pinned file 形式可读（测试验证绑定前不可读、绑定后可读）。新增
`model-textured-external/` fixture；原生页面阶段由真实 GLTFLoader 请求纹理
URL，左红/右绿像素、budget.error=null、contexts 1→0，并断言至少一次纹理
HTTP 路由。

验证：两工具链 hertz-wallpaper 61/61、hertz-desktop 859 passed / 0 failed /
2 ignored；双工具链 clippy 与 fmt 通过；原生页面连续 3 次通过（含 external
texture route）；组合浏览器 47 项与前端聚合 86 步通过。三处变异（external
URI 用完整包路径、纹理 pin 不发布、textureUrls 不写入）均变红后还原。

仍未闭合：KTX2/Basis、GLB 动画、逐实例材质透明度、多材质 program 精确计数、
真实 GPU 设备矩阵与 A01/A05–A10 外部验收。

2026-11-14 r78 直读格式 KTX2 model 续接：`model_structure` 把 extensions 白名单
限定为 `KHR_texture_basisu`（名称精确匹配、去重、required 必须在 used 中），纹理
可声明 `textures[i].extensions.KHR_texture_basisu.source`；有效 source 取扩展值，
核心 fallback 仍校验。`image_mime` 接受 `image/ktx2`；核心 source 指向 KTX2 图片
而无扩展时 fail-closed。`model_profile` 抽出共享纹理投影并新增
`static_ktx2_profile_facts(glb, resource, encodedBytes, modelPath, external)`：
Embedded 从完整 GLB 切片、Package 由调用方提供已 pin 文件字节，经既有
`inspect_ktx2` 校验 2D/DFD/level，要求 `supercompression=0`、vkFormat 37/43、
至少一层，facts 输出 width/height/vkFormat/srgb/levelCount/levelByteLengths/
uploadBytes 与 `resources.imageUploadBytes`；`plan_ktx2_upload` 将 RGBA8 SRGB(43)
纳入 always-direct。example 增加 `ktx2` 参数。

桌面按图片 mime 选择 ktx2 profile；declared basisu 纹理的 Package 图片先
`pin_verified_media`/核对 tuple/有界读取，作为容器 facts 与上传字节来源；仅
used external 图片发布 `textureUrls` 与 `texture_pins`，投影写
`textureUploadBytes`，成本沿用纹理上传/解码字节与按材质 program。

JS `parseKtx2Model` 复用 textured 场景/材质/几何校验，`KTX2Loader` 仅调用
`detectSupport(renderer)` 走 raw DataTexture 路径（Basis 转码资源不随 bundle
发布，构建期把 `import.meta.url` 的 transcoder URL 置空，Basis 在 facts 前
fail-closed）。实际纹理校验 DataTexture/RGBAFormat/UnsignedByteType、宽高、
每层 byteLength 与尺寸；容器字段在 `beforeRoot` 仅做结构比较、由实际纹理核对。
`plan.js` 接受 ktx2 profile 并要求 `textureUploadBytes === resources.imageUploadBytes
=== Σ levelByteLengths`，外部 URI 必须全部映射；`model-node`/`runtime` 透传
renderer 与纹理票。

真实证据：`scripts/composition-model-fixture.js` 生成 2×2 RGBA8 SRGB KTX2
（左红右绿）并嵌入 GLB；Rust `export_model_profile_facts ktx2` 作为唯一 oracle；
Chrome 组合检查 49 项通过（KTX2 左红/右绿、ledger textureDeclaredBytes=16、
decode=0；vkFormat=0 与上传字节 15 两处负例在预留前拒绝且 ledger 持平）。
原生页面新增 `model-ktx2` 阶段：真实 Rust 选择/GlAdmission 投影，左红/右绿、
budget.error=null、contexts 1→0，并写出 `native-page-model-ktx2.png`。桌面新增
embedded/external KTX2 投影测试（profile、16B 上传、textureUrls/pins、
pageLimits.textureDeclaredBytes=16+4096、buffer=194）。

仍未闭合：Basis ETC1S/UASTC 转码与 transcoder 资源/Worker/CSP、GPU 压缩格式
（BC/ETC2/ASTC）设备矩阵、GLB 动画、逐实例材质透明度、多材质 program 精确计数、
真实 GPU 显存/首帧与 A01/A05–A10 外部验收。

2026-11-15 r79 GLB 动画续接：`model_profile` 新增共享 `animation_projection`，
core/textured/ktx2 facts 均输出 `animations`（clip 名称/时长/逐 channel 的
node/path/interpolation/input/output accessor/times/values/components）以及
`resources.animationAccessors/animationBufferViews/animationCount/
animationChannelCount/animationCpuBytes`。要求 channel 目标在可达场景内、TRS
路径、times 为 packed FLOAT SCALAR、输出按 path 为 VEC3/VEC4 且 count 与
CUBICSPLINE 布局一致、clip 名称唯一、声明 duration 为正；动画 accessor 视图并入
CPU backing，CPU 预算另加每 channel 512B mixer 绑定余量。`check_textured_accessor`
与 core accessor 允许动画所需的 FLOAT SCALAR / VEC4，同时 primitive 仍强制
POSITION/NORMAL 为 FLOAT VEC3、索引为无符号 SCALAR。

JS facts 同步投影动画并纳入 CPU 预算；`verifyAnimations` 用 parser accessor 身份
核对 `track.times/values` 指针、长度、插值、clip 名称/时长与轨道数，要求被动画
节点有唯一名称、在场景内且 track 名精确为 `<name>.<position|quaternion|scale>`；
`createModelResource` 保留真实 AnimationClip。`nodes.js` 为选中 clip 的模型实例
创建 AnimationMixer；`runtime.js` 在时间变化时 `setTime(time % duration)` 并更新
矩阵。`plan.js` 接受非空 `animationClip`（≤128B）且必须命中 facts clip 名称，
未知 clip 在预留前 fail-closed；模型构造 CPU 票加入 `animationCpuBytes`。

桌面 `validate_structure` 允许 3D model 的有界 clip 名称，`media_costs` 在资源
已准备后校验名称存在于该模型 facts，成本加入 `animationCpuBytes`；未知 clip 仍
返回 adapter_unavailable。

真实证据：Rust 新增 core/textured 动画 facts 测试（translation 时长/accessor/
预算、未命名 clip 解析、单关键帧拒绝）；桌面 `model-animated` fixture 断言
projection 动画 facts 与 pageLimits；Chrome 组合检查 51 项（triangle 平移像素、
在 clip duration 内循环、未知 clip 零配额）；原生页面新增 `model-animated` 阶段
（真实 Rust 投影 + GlAdmission，早期/后期像素位移、budget.error=null、
contexts 1→0）。

仍未闭合：Basis ETC1S/UASTC 转码与 transcoder 资源/Worker/CSP、GPU 压缩格式
设备矩阵、GLB 蒙皮/形变动画、动画混合与多 clip、逐实例材质透明度、多材质
program 精确计数、真实 GPU 显存/首帧与 A01/A05–A10 外部验收。

2026-11-15 r80 逐实例材质透明度续接：JS `nodes.js` 为每个 3D model 实例克隆
全部 mesh 材质（共享贴图，记录 authored opacity/transparent/depthWrite），
`runtime.js` 在 MATERIAL 同步时按 `baseOpacity × node.opacity` 更新 clone：
透明度 <1 时 `transparent=true`、`depthWrite=false`，恢复 1 时还原 authored
状态；model opacity 数值变化计入 rebuild 差分。`plan.js` 移除 3D opacity 必须
为 1 的拒绝，改为有限且 0..1；每个 model 节点计入 `materialCount × 1024B`
clone CPU 预算，runtime 构造票与 delta 重建票同步包含该预算。桌面
`geometry_costs` 接受 0..1 的 3D opacity，`media_costs` 为模型加入相同 clone
字节，`pageLimits` 同步；未知/非有限范围仍在规划期拒绝。

真实证据：组合浏览器 52 项通过（新增 opacity=0.5 白色三角形叠加黑色背景得到
[188,188,188]）；桌面新增 `model-opacity` fixture 与投影测试（programs=3、
buffer=170、ownedCpu≥1024）；原生页面新增 `model-opacity` 阶段（真实 Rust
投影 + GlAdmission，中心像素约为 188、外部黑、budget.error=null、contexts 1→0）。
现有 model 原生 fixture 因 pageLimits 增加 clone 预算重新发射并通过。

仍未闭合：Basis ETC1S/UASTC 转码与 transcoder 资源/Worker/CSP、GPU 压缩格式
设备矩阵、GLB 蒙皮/形变动画、动画混合与多 clip、多材质 program 精确计数、
真实 GPU 显存/首帧与 A01/A05–A10 外部验收。
