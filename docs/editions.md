# Standard And Full

从 0.2.1 起，两个发行版共用一个仓库、主分支、提交与版本号。功能修复只改一次；
Cargo feature 决定哪些 Provider 与协议模块进入编译，UI 在构建时使用同一份转换器裁剪。

| 项目 | Standard | Full |
| --- | --- | --- |
| 本地 / WebDAV | 保留 | 保留 |
| Jamendo / ccMixter / 公开播客 | 保留 | 保留 |
| 网易云 / QQ / 酷狗 / 酷我 / 汽水 / 咪咕 | 不编译 | 保留 |
| 插件 ID | `io.github.oncemisery.hertz-studio` | `io.github.oncemisery.hertz-studio.full` |
| 默认独立数据目录 | `hertz-studio-standard` | `hertz-studio`（沿用旧版） |
| 默认端口 | 7635 | 7634 |
| 系统钥匙串服务 | `hertz-studio-standard` | `hertz-studio` |
| 商店候选发布链路 | 可进入，仍需维护者审核 | 不进入 |
| 独立发布包 | 不发布（本地验证与 DBX 商店候选） | 唯一独立发布形态 |

Jamendo 需配置自己的 client_id。作品授权以逐曲许可证为准；公开播客保留原站点 RSS 与音频地址，
公开可访问不代表授予再分发权。Standard 的命名不替代商店审核结论。

## Build

```sh
# Standalone
cargo build --locked --release -p hertz-studio
cargo build --locked --release -p hertz-studio --features full

# DBX sidecar (development)
cargo build --locked -p dbx-plugin-hertz
cargo build --locked -p dbx-plugin-hertz --features full

# DBX packages, CLI pinned to @dbx-app/plugin-cli@0.1.2
HERTZ_EDITION=standard bash scripts/ci-package-plugin.sh
HERTZ_EDITION=full bash scripts/ci-package-plugin.sh
```

独立发布包只构建 Full；上面无 `full` 的 standalone 命令保留给本地 Standard 验证与 DBX 商店候选。
Cargo 的 features 会在一次构建中合并。验证 Standard 时单独执行无 `full` 的命令；
不要使用 `--all-features` 构建商店包。两版二进制同名，本地同时保留时使用不同 `--target-dir`。
`--version`、HTTP / RPC 的 `/v1/health` 都报告发行版。

DBX 0.1.2 CLI 没有 Cargo feature 参数，脚本在 `output/editions/<edition>/plugin/` 生成包装 crate，
引用原始 sidecar 入口和共享库，显式选择 features，不复制业务代码。依赖沿用根 Cargo.lock 的版本。
`build-support/edition-ui.rs` 同时生成 standalone 内嵌 UI 和插件 UI；原始 `plugin/ui` 供 Full 开发使用。
打包应始终经过上述脚本，直接执行 `dbx-plugin package plugin` 不会裁剪 UI。

## Data And Upgrade

默认数据目录与钥匙串按发行版隔离；显式 `--data-dir` / `VMUSIC_DATA_DIR` 会覆盖默认值，
同时运行时应指定不同目录。默认端口也隔离浏览器 localStorage。

DBX 分别按插件 ID 分配宿主存储。Standard 在宿主提供的数据目录下再使用 `standard/`，
避免读取旧 0.2.0 插件的全部平台状态；Full 使用 `.full` ID 的宿主数据目录。
0.2.0 插件升级 Full 时，关闭旧插件后将旧插件数据目录的内容复制到新 `.full` 数据目录。
现有数据不会自动删除或移动到 Standard；Standalone Full 继续读取原 `hertz-studio` 目录。

## Release

`release.yml` 从同一提交构建 Full 独立程序和 Standard / Full 插件；独立程序只出 Full，
Standard 不再作为独立包发布。文件名、artifact 名与插件 ID 区分版本，只产出 Actions artifacts，
不发布。两版同时升版本，不维护长期分支或第二个项目。

商店候选链路只匹配 `hertz-plugin-standard-v<version>`，0.3.0 对应
`hertz-plugin-standard-v0.3.0`；旧 `hertz-plugin-v...` 与 Full tag 不触发候选打包。
脚本在 `PLUGIN_RELEASE=1` 时拒绝 Full，候选保持未签名，等待商店审核签名。
Full 独立包通过手动 release workflow 取得独立的 GitHub 分发产物；Standard 保留在商店候选与本地验证中。

## Verify

```sh
node scripts/check-frontend.js
node scripts/check-editions.js
cargo test --workspace
cargo test --workspace --features hertz-studio/full,dbx-plugin-hertz/full
node scripts/check-plugin-sidecar.js
# After building Full sidecar:
HERTZ_EDITION=full node scripts/check-plugin-sidecar.js
```

`check-editions.js` 检查两版 UI 语法、引用、登录素材排除、插件 ID 和版本同步。
可通过 `HERTZ_STANDARD_BIN` 指定 Standard 二进制，额外检查特定平台协议签名和端点不在包内。

最低 Rust 版本为 workspace 声明的 1.88。CI 的 `msrv` job 使用固定 1.88.0，对 Windows、Linux、macOS
分别检查 Standard / Full 工作区的全部 target；stable job 继续跑 lint 与运行回归。依赖 metadata 的
rust-version 上界不是源码编译通过的证据，`cargo check` 也不代表真实声音或宿主通过。
本机复核命令与当前能力/平台证据见[发布验收矩阵](./release-validation.md)。
