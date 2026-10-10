# DBX 插件市场提交手册（Hertz Studio）

面向 `t8y2/dbx-store` 的上架流程。规则出处是 DBX 仓库的 `plugins/RELEASING.md` 与
store 仓库的 `CONTRIBUTING.md` + `schemas/plugin-candidate.schema.json`；本文只写
「我们这边具体怎么做、哪些字段填什么」。

## 信任边界（先记住这条，别的都是细节）

| 产物 | 归谁 | 放哪 |
| --- | --- | --- |
| 源码 + manifest + 打包脚本 | 我们 | 本仓库 |
| **未签名候选** `.dbxp` + `.artifact.json` + `release-candidates.json` | 我们 | 本仓库的 GitHub Release（不可变 URL） |
| 提交材料 `publishers/oncemisery.json` + `candidates/<id>.json` | 我们 | 提 PR 到 `t8y2/dbx-store` |
| **签名后的最终包** | DBX 维护者 | 他们的 R2 存储 + `<id>-<version>` release |
| `plugins/<id>.json`、`catalog/index.json`、公钥、吊销 | DBX 维护者 | `t8y2/dbx-store`（由签名 workflow 生成） |

我们拿不到 DBX Store 的签名私钥，所以**永远只交候选**。候选包里出现 `signature.json`、
候选元数据里出现 `signingKeyId`，都会被发布/校验环节直接拒（`scripts/ci-package-plugin.sh`
也提前拦一遍）。

反过来说：`plugins/*.json` 和 `catalog/index.json` **不需要我们手写**。store 的签名
workflow 会在我们那条 PR 上把最终目录生成出来、删掉 `candidates/<id>.json`，再等维护者合并。

## 一次性准备

- `.github/workflows/plugin-release.yml` —— Release 触发，调用 DBX 的可复用 workflow，
  跑满 5 个 target（`linux-x64` / `linux-arm64` / `windows-x64` / `darwin-x64` / `darwin-arm64`），
  把候选与合并的 `release-candidates.json` 回传到该 Release。
- `scripts/ci-package-plugin.sh` —— 真正干活的地方：装 Linux 的 ALSA/libdbus 依赖、
  `dbx-plugin package .`、核对 `sha256`/`size`/manifest 身份、把 `url` 写成 Release 资产地址。
  检视链路（`release.yml` 的 plugin job）共用它，区别只是不带 `PLUGIN_RELEASE=1`，
  于是 `url` 留裸文件名。

两处钉版本，都是硬约束：

- 可复用 workflow 钉在 commit `069adbc5…`（DBX `v0.6.38` 背后的 commit）。上游原先的
  `plugin-sdk-v1` 分支**已经不存在**——早期写的是那个 ref，结果是这条链路一次都没被调度起来
  （Actions 里 `release dbx plugin` 的历史记录为 0）。钉 tag 名不够，tag 能被上游挪走。
- CLI 版本钉在 `0.1.2`（workflow 的 `plugin-cli-version`）。CLI 版本一变，同一个源码 tag
  就会打出字节不同的包，直接违反下面的不可变约束。
  但**钉住 CLI 也不等于逐字节可复现**：2026-10-10 把同一个提交（`plugin/` 一个字节没改）
  重打一遍，4 个 target 恰好相同，`windows-x64` 却差 5 字节、sha 完全不同。所以「重跑一次
  应该一样」不能当依据——唯一事实来源是那次发布留下的 `release-candidates.json` 里的 sha/size。

`manifest.json` 的 `publisher` 必须是小写 `oncemisery`：store 的 candidate schema 对
`id`/`publisher` 都要求 `^[a-z0-9][a-z0-9._-]*$`，而签名环节会拿候选元数据逐字比对包内
manifest 的 `id`/`version`/`publisher`，`onceMisery` 这种带大写的写法过不了 schema，
改成小写又对不上 manifest，两头都拒。

## 每次发版

1. `plugin/manifest.json` 的 `version` 递增。同名版本**不可原地重建**——源码、元数据、
   包字节任一处变了，就得开新版本（已被列进目录或被吊销的版本也不能重交）。
2. 跑一遍本地契约检查（`node scripts/check-frontend.js`，等价于 CI 的 Frontend contract
   checks），确认插件形态没退化。
3. 建 tag 与 Release，命名沿用 `hertz-plugin-v<version>`（例：`hertz-plugin-v0.1.0`）。
   Release 正文见下面「Release notes 模板」。
4. Publish 该 Release → `release dbx plugin` workflow 跑完，Release 资产里应出现
   5 个 `.dbxp` + 5 个 `.artifact.json` + `release-candidates.json`。
5. Fork `t8y2/dbx-store`，往 `main` 开**一条 PR**，只带两个文件：
   `publishers/oncemisery.json`（仅首次）和 `candidates/io.github.oncemisery.hertz-studio.json`。
   PR 正文按他们的模板逐项填（见「PR 正文要点」）。
6. 这条 PR 的 CI 会**故意停在红**，报 `open candidate(s) awaiting DBX Store signing`——
   那是闸门，不是故障。维护者 review 后跑保护 workflow（`/sign` 评论或手动 dispatch），
   它校验候选字节、签名、把最终包发到 R2 与 `<id>-<version>` release，再把生成好的
   `plugins/<id>.json` + `catalog/index.json` 和「删掉 candidates 文件」推回我们这条 PR。
   需要 maintainer 能改我们的分支，否则他们只能拿 patch artifact 手工合。
7. CI 转绿后维护者合并。我们这边不动 `plugins/`、`catalog/`。

## 提交材料

### `publishers/oncemisery.json`（仅首次）

发布者记录只管署名和 review 归属，不是信任根，也不放密钥：

```json
{
  "id": "oncemisery",
  "name": "onceMisery",
  "status": "unverified"
}
```

`status` 只能由维护者改成 `verified`，我们自己提交时留 `unverified`。

### `candidates/io.github.oncemisery.hertz-studio.json`

`targets[]` 的 `url`/`sha256`/`size` 直接从 Release 上的 `release-candidates.json` 搬
（形状是 `{ "plugin": {…身份…}, "artifacts": [ …每个 target 一条… ] }`）。候选阶段用的就是
未签名字节，签名只追加 `signature.json`、不改包体，所以 `sha256`/`size` 之后不用重算。

```jsonc
{
  "schemaVersion": 1,
  "id": "io.github.oncemisery.hertz-studio",
  "publisher": "oncemisery",
  "version": "0.1.0",
  "name": "Hertz Studio",
  "description": "Local-first music service and player: library scanning, native playback, playlists, word-level lyrics and an immersive 3D stage, all running on your own machine.",
  // icon 要 URI。照 store 里现有条目的做法，钉到 tag 的 raw 地址，别用 HEAD。
  "icon": "https://raw.githubusercontent.com/onceMisery/hertz-studio/hertz-plugin-v0.1.0/plugin/assets/plugin.svg",
  "tags": ["music", "player", "lyrics", "audio", "local-first"],
  "permissions": ["host.events", "host.storage", "host.workbench"],
  // source 也钉到 tag：reviewer 要能从源码对上包字节。
  "source": "https://github.com/onceMisery/hertz-studio/tree/hertz-plugin-v0.1.0",
  "homepage": "https://github.com/onceMisery/hertz-studio",
  "license": "MIT",
  "releaseNotes": "与 Release 正文一致的那段。",
  "localizations": {
    "zh-CN": {
      "name": "Hertz Studio",
      "description": "本地优先的音乐服务与播放器：曲库扫描、原生出声、歌单、逐字歌词与沉浸式 3D 舞台，全部跑在你自己的机器上。"
    }
  },
  "targets": [
    { "target": "windows-x64", "url": "https://github.com/onceMisery/hertz-studio/releases/download/hertz-plugin-v0.1.0/<包名>.dbxp", "sha256": "<64位hex>", "size": 0 }
    // linux-x64 / linux-arm64 / darwin-x64 / darwin-arm64 各一条
  ]
}
```

schema 是 `additionalProperties: false`，所以：没有 `screenshots` 字段（截图只作为 review
材料放 PR 正文或 Release），没有 `signingKeyId`（签名后的事，由他们的 workflow 写），
`size` 上限 512 MiB，URL 必须 HTTPS 且**不许指向 `t8y2/dbx-store` 的 release**。
本地校验用 `node scripts/validate.mjs`（在 store 仓里跑）。

### PR 正文要点

照 `t8y2/dbx-store/.github/PULL_REQUEST_TEMPLATE.md` 的小节写，内容我们都有：

- 身份：Plugin ID / Version / Publisher ID。
- 源码与 tag：`https://github.com/onceMisery/hertz-studio` + `hertz-plugin-v0.1.0`。
- 能力与工作流：一个 workbench（曲库浏览 + 原生出声播放 + 沉浸式歌词舞台），一个命令
  `Open Hertz Studio`（singleton tab），入口在命令面板和 app 工具栏。
- 权限与数据/网络访问：`host.events`、`host.storage`、`host.workbench`。曲库扫描只读用户
  指定的本地目录；在线音源要用户自己登录，凭据进操作系统钥匙串（Windows Credential
  Manager / macOS Keychain / freedesktop Secret Service），不落 SQLite 明文、不上传第三方。
- 原生 sidecar 行为：自带 `bin/dbx-plugin-hertz`，与宿主走 stdio JSON-RPC。**插件形态不开监听口**——
  HTTP + token 那一层只存在于独立形态（独立默认绑 `127.0.0.1`，绑到非回环会打警告）。
  插件路径不 spawn 子进程：全仓唯一的 `Command::new` 是独立 CLI 的 `--open`（`cmd /C start <url>`）。
  浮动胶囊是渐进增强：宿主没有 `capabilities.floating` 时自动退回页内最小化。
- License：MIT（仓库 LICENSE；上游第三方署名见 NOTICE）。
- Support：`https://github.com/onceMisery/hertz-studio/issues`。

### store 校验器实际会卡什么

`scripts/validate.mjs` 是逐条 exact-keys 的，先对齐再提，别拿一轮 review 换一条错：

- 候选文件名必须等于 `<candidate.id>.json`；`publishers/<id>.json` 同理，且发布者记录**只许**
  `id`/`name`/`status` 三个键。
- 候选顶层只许 `schemaVersion, id, publisher, version, releaseNotes, name, description, icon,
  tags, permissions, source, homepage, license, localizations, targets`——多写一个（比如截图）就红；
  `targets[]` 只许 `target`/`url`/`sha256`/`size`；`localizations.<locale>` 只许 `name`/`description`。
- `icon` 在候选阶段只要求 HTTP(S)，但结尾必须是 `.svg` 或 `.png`（`iconExtension()` 会抛）。
  签名时 store 会把它镜像成 `https://dl.dbxio.com/plugins/<id>/<latestVersion>/icon.<ext>`。
- 已列出或已吊销的版本不能重交；`publisher` 必须已经在 `publishers/` 里注册（所以首次提交要同时带那份记录）。
- CI 的 `node scripts/validate.mjs` 只要 `candidates/` 非空就**主动抛错**
  （`open candidate(s) awaiting DBX Store signing`）。那是签名闸门，不是我们把 PR 写坏了。

## Release notes 模板

```markdown
## Hertz Studio 插件 <version>

- 独立形态与插件形态同一份前端/后端；插件形态自带 sidecar。
- 桌面浮动胶囊：最小化后是独立置顶窗口，可拖到任意位置，贴边停靠（拖到边缘松手即收起，
  鼠标碰那条边滑出，离开一会儿收回去）。
- 沉浸式 3D 舞台、逐字歌词、本地曲库扫描与原生出声。

Requires DBX >= 0.6.35. 浮动胶囊窗口需要 DBX 支持 plugin floating surface；不支持时自动
退回页内最小化，功能不缺失。
```

## 后续版本可以少动手

store 有自动化：他们的仓在 `automation/plugin-sources.json` 里登记源码仓库 +
`metadataPath`（约定是源码仓库根的 `.dbx-store.json`）+ `autoUpdate: true`，之后每次
publish Release，机器人只凭 Release 和 `release-candidates.json` 就自动开/更新候选 PR。
`.dbx-store.json` 只在首次提交或有意改列表信息时才用，字段形状照他们的 CONTRIBUTING.md。
这条路要先给 `t8y2/dbx-store` 提一条登记 PR，属于可选优化。

## 提交前的材料状态

首次提交已发出：**`t8y2/dbx-store` PR #242**（`io.github.oncemisery.hertz-studio@0.1.0`，
切自 tag `hertz-plugin-v0.1.0`）。它停在维护者侧要两步：先 approve workflow runs，再 review + `/sign`。

2026-10-08 已在 DBX 0.6.35 验证最终候选包的六皮肤切换、创意/沉浸场景、事件链路与网易云原生播放；
2026-10-10 又把 5 个候选包逐个下载回算过 `sha256`/`size`，与 `release-candidates.json` 一致。
过程记录（联调细节、账号范围、未完成项）只留在本机 `docs/aegis/`，已从仓库下架——对外能核对的是
Release 上的 `release-candidates.json`、包内 `manifest.json` 的身份，以及钉到 tag 的源码。
Windows 下替换同版本插件前，先关闭它的工作台并停止插件进程，避免运行中的 exe 占用导致安装失败。

- [x] store 图标：`plugin/assets/plugin.svg`，用钉到 tag 的 raw URL 即可，无需额外尺寸版本。
- [ ] 截图 2–4 张（曲库/播放、3D 舞台、桌面浮动胶囊），只作为 review 材料附在 PR 评论。浮动胶囊可用
      `output/dbx-float-dock-shots.js` 现拍（收起态 + 滑出态各一张）。
- [x] support 渠道就用 GitHub Issues（PR 正文里已按这个填）。

## 四个已知的坑

1. **宿主样式内联契约**：最低版本设为已实际联调的 `>=0.6.35`。DBX 0.6.29 内联
   样式时丢弃 `data-skin-css` 标记，导致所有皮肤退回经典；0.6.35 已保留属性，六套
   皮肤的正反切换通过。0.6.30–0.6.34 未逐版验收，不推断最早修复版本。浮动 surface
   仍按 `capabilities.floating` 探测，无该能力时保留页内最小化。
2. **插件 id 变更的迁移**：本项目早期以 `io.github.mmusic-studio.hertz-studio` 分发过。
   DBX 的插件数据按 id 存放（`plugin-data/<id>/`），换 id 等于换一份全新状态：曲库、
   在线登录态、界面偏好都不继承。老用户升级需要在 release notes 里明确「重装并重新登录」，
   不要指望自动迁移。`publisher` 只是署名与 provenance 比对项，不参与这个目录，改大小写不丢数据。
3. **上游 ref 会消失，而它坏得没有日志**：`plugin-sdk-v1` 这个分支/标签已经不在 `t8y2/dbx` 上了，
   早期照它写的 `uses:` 让发布链路一次都没跑起来。按完整 commit SHA 引用是对的（官方
   `t8y2/dbx-plugin-s3` 也这么写），但 SHA 抄错一个字符的报错长这样：
   `error parsing called workflow … failed to fetch workflow: workflow was not found`——
   整个 run **0 个 job、没有日志、`gh run view --log` 回 `log not found`**，只在页面底部
   Annotations 里那一条。所以核对 SHA 要拿 `git ls-remote` 或 API 回读，别凭手抄。
   顺手把「Actions 里这条 workflow 有没有历史运行」当成一项检查。
4. **附属 release 会把候选重打一遍**：`on: release: types: [published]` 对**任何**新发布都触发。
   2026-10-10 为了挂 review 截图发了一条 `hertz-plugin-v0.1.0-screenshots`，结果 `release dbx plugin`
   按 0.1.0 又编了一套塞进去，其中 `windows-x64` 与已提交那套差 5 字节——同一版本号两种字节，
   reviewer 拿错 URL 就签不过。现在 workflow 里有 `gate` job 兜底：只有 tag 名**精确等于**
   `hertz-plugin-v` + `manifest.json` 的 `version` 才打候选，其余只留一条 notice 跳过。
   约定：上架候选只认 `hertz-plugin-v<version>` 那条 release 的 `release-candidates.json`；
   截图等附属材料另发 tag（本次是 `hertz-plugin-v0.1.0-screenshots`，里面那 6 个候选资产保留但
   **不作为提交内容**）；独立形态的安装包另发 `hertz-studio-v<version>`，别混进插件那条。
   **但 gate 不是全能的**：`on: release` 取的是**触发事件那个提交里**的 workflow 文件，不是默认分支
   那份。给独立形态发 `hertz-studio-v0.1.0`（目标提交 `11454b0`，早于 gate）时它就没生效，
   5 个 target 全开始编，最后靠手动 `gh run cancel` 停在 Publish 之前才没多出候选包。
   所以：给**旧提交**补发 release 前，先确认那个提交里有没有 gate；要彻底免疫就把这条 workflow
   改成只 `workflow_dispatch` 手动触发（代价：每次发版多一步手工启动）。
