# Hertz 壁纸受管 AI：生成、推荐与切换实施记录

记录 A06 工作包（设计 docs/desktop-wallpaper.md §19/§20.5）各切片的实施与
验收状态。AI-01 的批准实施细节见其检查点与 2026-11-09 的
[壁纸设计主文档](desktop-wallpaper.md)条目；本表只汇总可核验事实。

| 切片 | 状态 | 证据 |
| --- | --- | --- |
| AI-01 离线推荐与明确切换 | 2026-11-09 已实施并通过 Windows 开发候选 8 项真实验收 | [主文档条目](desktop-wallpaper.md) |
| AI-02 切片 1：生成合同纯数据层 | 2026-11-16 已实施（见下） | 本文档 + `crates/hertz-wallpaper/src/generation.rs` 测试 |
| AI-02 切片 2+：quote/submit、短会话配对、capability 目录、路由 | 未实施 | 设计 §19.2–§19.5 |
| AI-03 结果交付与入库 | 未实施 | 设计 §19.6 |
| AI-04 图像 adapter 与计费 | 未实施 | 设计 §19.5、§20.5 |
| AI-05 声明式组合 | 未实施 | 设计 §19.3 |
| AI-06 外部助手申请 | 未实施 | 设计 §19.2 |

## 2026-11-16 AI-02 切片 1：生成合同纯数据层

`crates/hertz-wallpaper/src/generation.rs` 落地设计 §19.3 的纯数据类型与
确定性验证；不含 quote/submit、短会话配对、provider 调用、路由或 UI。

- `WallpaperGenerateRequest`：version=1；完整控制 JSON ≤12 KiB、brief ≤4 KiB
  （沿 ai.rs 的 `MAX_BRIEF_BYTES`）；`json.rs` 字节级扫描器的重复键拒绝与
  深度上限 + `deny_unknown_fields` 落实「拒绝重复/未知字段」；registry 与
  schema 哈希须 64 位十六进制；builtin 的 sceneId 必须在自校验资格目录内。
- `WallpaperGeneration`：kind 判别的普通结构——serde 内部 tag 枚举不支持
  `deny_unknown_fields`（本片实测发现），因此逐类别强制「只允许自己的字段
  集合」，其余类别字段出现即拒绝。image 沿设计上界最长边 4096、像素总数
  ≤8 Mi；质量枚举留给能力目录切片。
- `BuiltinSceneOutput`：模型输出 `{kind,sceneId,stateVersion,params}` ≤64 KiB
  领域上限；stateVersion 与目录逐字匹配；params 严格按场景 schema——未知
  参数、越界、select 选项表外值（目录选项为 `{value,label}` 对象）与类型
  不符均拒绝，不自动 clamp；目录三类（number/boolean/select）之外的新类型
  fail-closed。
- `WallpaperArtifact`：信封由服务按实际接收字节构造；ID 边界、sha256 十六
  进制、字节 1 B–32 MiB（§19.5 原生接收上界）与 MIME-kind 一致
  （builtin/composition→application/json；image→png/jpeg/webp）。
- 错误码 `invalid_generation`；重复键保留 `json.rs` 扫描器的 `duplicate_key`；
  跨端 `registryHash`/`generationSchemaHash` 一致性由持有两端的调用方裁决，
  本层只验格式与本地目录成员。

真实证据：`cargo +stable/+1.88.0 test -p hertz-wallpaper --lib generation`
各 5 项通过；wallpaper 全套件 357 项双工具链串行绿；桌面 lib 869/0/2 双
工具链串行绿（新模块进入依赖图后不变）；clippy `-D warnings` 与
`fmt --all -- --check` 双工具链干净。开放项：AI-02 切片 2+（quote/submit、
§19.2 配对流程、capability snapshot 服务端产生、asset-sets、ai/jobs 的
`wallpaper.generate` capability 注册与路由）、AI-03～06。
