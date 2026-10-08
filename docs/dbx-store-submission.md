# DBX 插件市场提交手册（Hertz Studio）

面向 `t8y2/dbx-store` 的上架流程。规则出处是 DBX 仓库的 `plugins/RELEASING.md` 与
`plugins/marketplace.schema.json`；本文只写「我们这边具体怎么做、哪些字段填什么」。

## 信任边界（先记住这条，别的都是细节）

| 产物 | 归谁 | 放哪 |
| --- | --- | --- |
| 源码 + manifest + 打包脚本 | 我们 | 本仓库 |
| **未签名候选** `.dbxp` + `.artifact.json` + `release-candidates.json` | 我们 | 本仓库的 GitHub Release（不可变 URL） |
| **签名后的最终包** | DBX 维护者 | 他们的发布存储 |
| 目录条目、发布者身份、公钥、吊销 | DBX 维护者 | `t8y2/dbx-store` |

我们拿不到 DBX Store 的签名私钥，所以**永远只交候选**。候选包里出现 `signature.json`、
候选元数据里出现 `signingKeyId`，都会被发布/校验环节直接拒（`scripts/ci-package-plugin.sh`
也提前拦一遍）。

## 一次性准备

发布链路已经接好，不需要额外配置：

- `.github/workflows/plugin-release.yml` —— Release 触发，调用 DBX 的可复用 workflow，
  跑满 5 个 target（`linux-x64` / `linux-arm64` / `windows-x64` / `darwin-x64` / `darwin-arm64`），
  把候选与合并的 `release-candidates.json` 回传到该 Release。
- `scripts/ci-package-plugin.sh` —— 真正干活的地方：装 Linux 的 ALSA/libdbus 依赖、
  `dbx-plugin package .`、核对 `sha256`/`size`/manifest 身份、把 `url` 写成 Release 资产地址。
  检视链路（`release.yml` 的 plugin job）共用它，区别只是不带 `PLUGIN_RELEASE=1`，
  于是 `url` 留裸文件名。

CLI 版本钉在 `0.1.2`（两处：workflow 的 `plugin-cli-version` 与 `release.yml` 的 npm 安装）。
**不要放开**：CLI 版本一变，同一个源码 tag 就会打出字节不同的包，直接违反下一条的不可变约束。

## 每次发版

1. `plugin/manifest.json` 的 `version` 递增。同名版本**不可原地重建**——源码、元数据、
   包字节任一处变了，就得开新版本。
2. 跑一遍本地契约检查（`node scripts/check-plugin-assets.js` 等，CI 的 Frontend contract
   checks 那一串），确认插件形态没退化。
3. 建 tag 与 Release，命名沿用 `hertz-plugin-v<version>`（例：`hertz-plugin-v0.1.0`）。
   Release 正文见下面「Release notes 模板」。
4. Publish 该 Release → `release dbx plugin` workflow 跑完，Release 资产里应出现
   5 个 `.dbxp` + 5 个 `.artifact.json` + `release-candidates.json`。
5. 去 `t8y2/dbx-store` 开 **Plugin submission issue**，正文用下面模板。
6. 等 review + 他们跑保护流程签名，产出最终 artifact 的 URL/size/SHA-256/`signingKeyId`。
7. 开 catalog PR（`t8y2/dbx-store:main`），把最终值填进条目；跑 store 校验，维护者终审后放行。

## Submission issue 模板

```markdown
Plugin submission: Hertz Studio 0.1.0

- Plugin ID: io.github.oncemisery.hertz-studio
- Publisher: onceMisery
- Source repository: https://github.com/onceMisery/hertz-studio
- Source tag: hertz-plugin-v0.1.0
- Candidates: https://github.com/onceMisery/hertz-studio/releases/tag/hertz-plugin-v0.1.0
  (release-candidates.json 附在该 Release 上)
- Targets: linux-x64, linux-arm64, windows-x64, darwin-x64, darwin-arm64
- Manifest permissions: host.events, host.storage, host.workbench
- License: MIT（仓库 LICENSE；上游第三方署名见 NOTICE）
- Homepage / Support: https://github.com/onceMisery/hertz-studio
  · 问题反馈 https://github.com/onceMisery/hertz-studio/issues
- Privacy: 全部数据在本机处理。曲库扫描只读用户指定的本地目录；在线音源需要用户自行
  登录，凭据存操作系统钥匙串（Windows Credential Manager / macOS Keychain /
  freedesktop Secret Service），不落 SQLite 明文，也不上传第三方。播放发现服务只在
  127.0.0.1 上监听，并带本地 token 鉴权。
- Runtime note: 需要 DBX 的 sidecar 插件运行时（自带 dbx-plugin-hertz 后端进程）。
  浮动胶囊窗口 surface 是渐进增强：宿主没有 `capabilities.floating` 时自动退回页内最小化。
```

## Catalog 条目骨架（签名后回填）

按 `marketplace.schema.json` 的形状，`plugins[]` 里一条长这样；`???` 处必须等维护者签名后
用他们发布的最终值填：

```jsonc
{
  "id": "io.github.oncemisery.hertz-studio",
  "name": "Hertz Studio",
  "publisher": "onceMisery",
  "description": "Local-first music service and player: library scanning, native playback, playlists, word-level lyrics and an immersive 3D stage, all running on your own machine.",
  "homepage": "https://github.com/onceMisery/hertz-studio",
  "source": "https://github.com/onceMisery/hertz-studio",
  "icon": "???",                      // 用 plugin/assets/plugin.svg，按 store 仓的存放约定
  "license": "MIT",
  "tags": ["music", "player", "lyrics", "audio", "local-first"],
  "permissions": ["host.events", "host.storage", "host.workbench"],
  "localizations": { "zh-CN": { /* 与 manifest.localizations['zh-CN'] 保持一致 */ } },
  "latestVersion": "0.1.0",
  "versions": [{
    "version": "0.1.0",
    "releasedAt": "???",              // ISO-8601
    "releaseNotes": "???",            // 与 Release 正文一致
    "artifacts": [                    // 每个 target 一条，签名后才有 signingKeyId
      { "target": "windows-x64", "url": "???", "sha256": "???", "size": 0, "signingKeyId": "???" }
    ]
  }]
}
```

`sha256`/`size` 用候选的值即可（签名只追加 `signature.json`，不改包体字节）；`url` 与
`signingKeyId` **必须**换成签名后最终产物的地址，不能指向候选。

## Release notes 模板

```markdown
## Hertz Studio 插件 <version>

- 独立形态与插件形态同一份前端/后端；插件形态自带 sidecar。
- 桌面浮动胶囊：最小化后是独立置顶窗口，可拖到任意位置，贴边停靠（拖到边缘松手即收起，
  鼠标碰那条边滑出，离开一会儿收回去）。
- 沉浸式 3D 舞台、逐字歌词、本地曲库扫描与原生出声。

Requires DBX >= 0.6.29. 浮动胶囊窗口需要 DBX 支持 plugin floating surface；不支持时自动
退回页内最小化，功能不缺失。
```

## 提交前还缺的材料

- [ ] 截图 2–4 张（曲库/播放、3D 舞台、桌面浮动胶囊）。浮动胶囊可用
      `output/dbx-float-dock-shots.js` 现拍（收起态 + 滑出态各一张）。
- [ ] store 侧图标：源文件 `plugin/assets/plugin.svg`，按 `dbx-store` 的要求转成它规定的尺寸/存放方式。
- [ ] 确认 support 渠道就用 GitHub Issues（若另设邮箱/论坛，替换模板里的链接）。

## 两个已知的坑

1. **`engines.dbx` 与未发布的宿主能力**：manifest 写的是 `>=0.6.29`，而浮动 surface 是
   DBX `main` 上尚未发版的能力。当前行为是渐进增强（探测 `capabilities.floating`，没有就
   页内最小化），所以对已发布宿主无害。等 DBX 正式发版带上该能力后，把 `engines.dbx`
   提到那个版本，避免用户以为浮窗在旧宿主上应该可用。
2. **插件 id 变更的迁移**：本项目早期以 `io.github.mmusic-studio.hertz-studio` 分发过。
   DBX 的插件数据按 id 存放（`plugin-data/<id>/`），换 id 等于换一份全新状态：曲库、
   在线登录态、界面偏好都不继承。老用户升级需要在 release notes 里明确「重装并重新登录」，
   不要指望自动迁移。
