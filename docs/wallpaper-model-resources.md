# GLB / KTX2 资源实施记录

2026-11-11：原 `hertz-wallpaper::validate_package` / `validate_archive` 已在
ZIP 路径、实际长度、SHA-256 和组合合同核验后检查模型与 KTX2 纹理容器。
桌面导入的快照校验、安装复核和原包重开沿用此入口。

当前可验证的是容器结构。模型节点与 KTX2 运行适配器继续返回不可用；
容器校验成功不能用来声称已经支持几何、动画、纹理转码或 GPU 呈现。

同日续接完成 GLB 的核心静态结构前置检查，原 Model source/variant 包入口
先调用唯一容器 inspector，再解析有界 typed schema。纯包当前 131 项通过
（模型结构 33 项），最终桌面资源导入 9 项通过，包含有效容器内的坏节点环在
资源投影前拒绝。结构结果显式保持 `binary_content_validated=false`。

| 资源 | 已实施检查 | 仍需实施与验收 |
| --- | --- | --- |
| GLB | v2容器与原始有界JSON；核心静态typed依赖/BufferView/accessor范围；节点/scene单父无环与变换；mesh及所有节点实例的三角形metadata上界；同包JPEG/PNG图片source/variant、材质五槽UV引用 | 实际二进制索引/浮点与真实几何；动画/morph/skinning、扩展、实际材质/图片解码和完整成本；受控 GLTFLoader、私有实例和绝对时间采样 |
| KTX2 | 普通 2D header、16384 单边与 64 MP、mip 索引、DFD/KVD/SGD/level 范围及溢出/重叠；按压缩方式核验长度与层对齐 | DFD/格式语义、真实 Basis worker/转码、GPU 格式选择和预算、解码选项与 context 缓存身份 |

GLB 限 `model/gltf-binary`，所有 Model source/variant 都检查。Texture 中
`image/ktx2` 的 source/variant 都检查。共享同一文件的每个资产角色先检查
MIME，再去重内容检查；公共入口遇到手构 Manifest 的缺失 Model/Texture 引用
返回 `missing_file`，不会 panic。其它资源的既有检查入口保持。

未知 GLB 版本/chunk、JSON glTF 入口，以及数组/cubemap/3D KTX2 仍明确不可用。
KTX2 压缩层不要求普通层的 mip padding；BasisLZ 的
`uncompressedByteLength` 必须为零，Zstd/Zlib 必须非零。
读取范围检查不推断 DFD 合法、解压内存、格式支持或压缩收益。

当前验证包括 `hertz-wallpaper` 98 项（新增容器 15 项）、桌面真实
staging/projection/install/reopen 路径、源文件删除后快照独立性、坏容器在
projection 前拒绝、hash 错误优先于内容检查，以及两个 inspector 的有界读取。
锁定 Three 0.186.0 writer 生成的真实 Zlib 两层 KTX2（首层 offset263）已由
原包入口接受；Node/Python 解压分别核对为 64/16 字节。这份 fixture 只验证
容器兼容性，不授予产品 decoder/GPU 资格。受影响 Rust 回归与独立审查记录
保存在 `output/design-final-followthrough/`。

桌面壁纸最终回归以四个测试线程运行，499 项通过、2 项沿原条件忽略。
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
稀疏、动画、骨骼、morph和扩展payload在各自内容检查实施前明确不可用。

模型结构阶段的早期桌面广泛回归552项通过、2项忽略，构建早于最后规格修正，
仅保留该版本归属；最终源的资源导入9项和纯包131项另有日志。不能把旧广泛
回归当成最终模型或设备资格。

下一步沿同一包合同与资源准备、预算、pool、renderer、clock owner 完成上表
剩余项。HWPK1 / documentVersion1 / Config5 不变；此切片不完成整个 P2-03
或 A04/A05/A06/A10 总实施计划。
