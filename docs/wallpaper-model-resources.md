# GLB / KTX2 资源实施记录

2026-11-11：原 `hertz-wallpaper::validate_package` / `validate_archive` 已在
ZIP 路径、实际长度、SHA-256 和组合合同核验后检查模型与 KTX2 纹理容器。
桌面导入的快照校验、安装复核和原包重开沿用此入口。

当前可验证的是容器结构。模型节点与 KTX2 运行适配器继续返回不可用；
容器校验成功不能用来声称已经支持几何、动画、纹理转码或 GPU 呈现。

| 资源 | 已实施检查 | 仍需实施与验收 |
| --- | --- | --- |
| GLB | v2、JSON 加可选 BIN、精确总长及四字节对齐、chunk 顺序与范围；原始 JSON 的 4 MiB、重复键、16 层深度及所有有限数值；asset.version/minVersion；固定 64 KiB 流读取 BIN | 同包依赖与 URI、BufferView/accessor 和真实二进制数据、节点/三角形成本、材质/动画闭包、受控 GLTFLoader、私有骨骼实例和绝对时间采样 |
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

下一步沿同一包合同与资源准备、预算、pool、renderer、clock owner 完成上表
剩余项。HWPK1 / documentVersion1 / Config5 不变；此切片不完成整个 P2-03
或 A04/A05/A06/A10 总实施计划。
