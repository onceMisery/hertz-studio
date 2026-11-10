# GLB / KTX2 资源实施记录

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
| GLB | v2容器与有界JSON；核心静态typed依赖/view/accessor/graph/变换及三角形metadata上界；同包图片/材质五槽UV引用；真实索引/有限FLOAT/bounds及NORMAL/TANGENT/COLOR_0；FLOAT TRS动画；核心skin结构/逐顶点关联、morph delta/defaults及FLOAT/normalized rotation/weights存储与实际值 | sparse、扩展、实际材质/图片解码和完整成本；受控 GLTFLoader、私有实例、绝对动画播放及GPU呈现 |
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
