# 离线参数模板创作

本工具实现 [Stage 可行性基线 §4.3](stage-engine-feasibility.md#43-t2-离线效果创作管线) 的受限参数候选路径：固定源码与工具链 → JSON 参数 → 原 `CreativeDraft.prepare` → 多档真实 WebGL 探针 → 可人工审阅的候选包。它没有接入应用运行时，不登记场景，不增加默认值 owner，不执行输入中的 GLSL、脚本或素材地址。

M4 发布退出条件尚未达成。当前候选包的人工视觉、许可、弱机与驱动矩阵、长时探针、操作系统隔离和原 owner 入库检查均为 pending。通过本地机械检查不等于新场景已批准或随包发布。

## 数据与 owner

`scripts/stage-authoring.cjs` 是离线 CLI；辅助脚本只归该工具使用。输入示例在 `scripts/fixtures/stage-authoring/quiet-orb-study.json`。

- `CreativeTemplates.list()` 提供可用模板身份、版本、目标场景与兼容性。本工具不复制模板目录。
- `CreativeStageContract` 提供数值槽位与范围；未知键、越界和非数值失败，不依赖静默钳位。
- `CreativeDraft.prepare()` 校验版本、schema hash、原 owner 的规范基线 hash、意图物化与完整分享码往返。
- `CreativeStage.normalizeSharePreset()` 与 `CreativeShareCode` 处理完整预置和命名后的分享码。本工具不复制默认参数。
- `CreativeGL.create()` 与原 `StageResourceBudget` 提供固定源码编译、分档绘制和资源票据。本工具没有生成代码编译入口。

输入限 32 KiB、10 层 JSON、最多 64 个数值 patch 槽位。当前支持现有三份模板的参数变体，固定 `director:false` 和 `hand.on:false`；不接受 cues、bindings、自由图层组合、GLSL、JavaScript、URL、文件素材或任意依赖。描述与 provenance 是受限纯文本，仅记录声明，绝不解释为指令或源码。`approved`、`reviewStatus` 等额外字段无论真假都拒绝。

来源记录包含作者、源引用、修订、许可证和署名；工具另记录固定上游 owner、MIT 许可证文件 hash 和全部实际使用源码 hash。源引用使用短记录 ID，工具不跟随路径或 URL。许可证策略仅允许 MIT、BSD-2-Clause、BSD-3-Clause、Apache-2.0、CC0-1.0、CC-BY-4.0；未知、ND 及未明确允许的条款失败。允许列表只是机械筛查，作者声明、衍生权、署名和分发条件仍须人工核查，不提供法律结论。

## 固定工具链与运行

需要已安装 Node 22.14 或兼容的 Node 22+、Playwright 及本地 Chromium 系浏览器。脚本不下载依赖，不调用模型或 API，不需要 token。先明确锁定当前已审阅的本地文件；`pin` 只记录身份，不批准源码或许可证。

PowerShell 示例（将工具路径改为本机的实际安装路径）：

```powershell
node scripts/stage-authoring.cjs pin `
  --playwright 'C:/tools/node_modules/playwright' `
  --browser 'C:/Program Files/Google/Chrome/Application/chrome.exe' `
  --out 'output/stage-authoring-toolchain.json'

node scripts/stage-authoring.cjs build `
  --input scripts/fixtures/stage-authoring/quiet-orb-study.json `
  --lock output/stage-authoring-toolchain.json `
  --out output/stage-authoring-review

node scripts/check-stage-authoring.cjs --bundle output/stage-authoring-review
```

`pin` 记录 Node 二进制与版本、Playwright 和 playwright-core 的完整包树、浏览器安装目录树，以及准备/渲染脚本、canonical owner、契约与许可证文件的 SHA-256。运行前、运行后都匹配完整锁，源码、浏览器自动更新或依赖变化会失败。需要重新审阅并显式创建新锁；脚本不自动给旧候选升级版本或改 hash。

输出目录和导出文件必须是新路径，现有结果不会覆盖。准备过程复制固定源码快照后才运行，输入目录不会成为通用资源根。输出包括：

| 文件 | 含义 |
| --- | --- |
| `candidate.json` | 原输入、规范预置、分享码、诊断、内容 hash、来源与机械校验 |
| `toolchain-lock.json` | 本次使用的源码和工具链锁 |
| `render-report.json` | 四档真实渲染、CPU 提交时长、图像内容、资源与回收证据 |
| `low/medium/high/high-dpr2` 的首帧和预热 PNG | 人工观察材料，不代表视觉通过 |
| `bundle.json` | 候选身份、每个证据文件 hash、时限和未过的发布门槛 |
| `review.pending.json`、`REVIEW.md` | 独立人工复核入口；所有门槛初始 pending |
| `failure.json` | 准备、编译、渲染、超时或版本失败；失败不能入库 |

临时源码与浏览器 profile 在拥有的输出目录内创建，结束后校验绝对路径边界并清理。超时终止工作进程树。失败的证据目录保留，不能作为已通过的 bundle 使用。

## 隔离边界与未满足项

本实现针对不可信的**参数 JSON**。只有固定且按 hash 校验的仓库 JavaScript 进入 VM fixture 和浏览器；`node:vm` 只是命名空间，不能当作任意代码沙箱。自由 GLSL 开发模式未实现。

| 已实施限制 | 明确范围 |
| --- | --- |
| 独立准备进程，清空继承环境 | 只保留系统启动路径和本次临时目录；不传入 token、应用环境或用户数据目录 |
| Node permission 模式 | 准备进程只读固定源码快照；不授权文件写入、子进程或 worker；fixture 不暴露 require/process/网络 API |
| 独立渲染进程与新浏览器 profile | 固定来源脚本以内容注入，关闭 service worker，禁止下载，没有用户曲库或持久 profile |
| 浏览器网络拒绝 | offline context、全部 request abort、DNS 拒绝和页面 CSP；有真实导航拒绝探针 |
| 有限工作与超时 | 输入 32 KiB、固定源码 4 MiB、工作进程输出 4 MiB；准备 12 秒，渲染 90 秒；四档各 90 帧 |
| JS 内存限制 | 准备 Node heap 128 MiB，渲染 Node heap 256 MiB，浏览器 JS heap 128 MiB；额外记录 Node RSS/CPU 用量 |
| 原 owner 资源票据 | 已声明 GPU/CPU/画布资源的有限策略，预热后不增长，销毁后归零 |

以上并未证明操作系统级的完全网络/任意文件 IO 禁止，也未给浏览器、GPU 驱动和所有子进程实施总体内存或 CPU 配额。干净 profile 与清空环境不能证明操作系统进程绝无可访问的宿主信息。当前 `StageResourcePolicy` 本身也是 development candidate，不能当成设备容量认证。需要在经过独立验证的 OS runner 中重做本次固定来源构建和渲染，并绑定源锁、候选和证据，方能关闭 §4.3 的 isolation 门槛。不得因本工具输入受限而免除该门槛。

## 渲染证据范围

low、medium、high 分别使用真实 CreativeGL 的 quality 0、1、2；另外运行 high-DPR2。fixture 使用固定合成频谱、主题颜色、已物化预置与确定性相位。它是渲染器评审，不复制或运行 CreativeStage 宿主的导演、漂移、皮肤、歌词叠加和交互生命周期；这些组合仍由原宿主的检查与人工评审覆盖。

每档覆盖首帧非空读回、预热编译、90 帧资源稳定、真实 context-loss 后拒绝绘制、销毁、新实例重建、资源释放和浏览器关闭。截图在绘制同一个任务中读取，避免非 preserve drawing buffer 在任务后被清空。固定源码的 GLSL 保留字、`pow` 负底数、`atan` 分支、驱动差异等历史风险仍归原 shader 源码检查和人工审阅，不通过一个词法黑名单宣称排除。固定源码所有权不代表模板候选无需评审。

时长是原生 `performance.now()` 的 CPU 提交与 `gl.finish()` 调用采样，不等于显示帧率或 GPU 完成时长；浏览器计时精度可以返回零。90 帧属于有限回收探针，不是长时间稳定性资格。即使当前设备返回硬件 renderer，仍不能外推弱机和驱动矩阵；软件 WebGL 更不能据此通过实机门槛。

## 人工检查与静态交接

人工检查文件必须独立于生成输入，并绑定当前 `bundleHash`、`candidateHash`。每个门槛包含 `status`、实际审核人、ISO 时间、证据记录 ID 与具体理由：

1. `visual`：歌词、皮肤、横竖屏和运动舒适度。
2. `license`：来源、作者声明、许可证和署名条件。
3. `physicalDevice`：弱机、真实 GPU/驱动和 DPI 矩阵。
4. `longRun`：真实持续运行与资源峰值、回收证据。
5. `isolation`：同一固定源码与候选的 OS 隔离构建证据，包含网络/IO 拒绝和 CPU/总内存约束。
6. `ownerIntegration`：原 registry/模板 owner 的静态改动、契约导出、fixture 与随包发布评审。

未完成的门槛保持 pending；拒绝意见填写 rejected。模型不能替人批准，测试中的合成审核记录不能复用。工具只核验记录的完整性与内容绑定，不能认证审核人的身份；签名与维护者身份由仓库既有审核/发布过程保证。

确有完整审核记录后，可生成供维护者查看的静态 JSON 交接：

```powershell
node scripts/stage-authoring.cjs admit `
  --bundle output/stage-authoring-review `
  --review reviewed-candidate.json `
  --out output/stage-authoring-static-handoff.json
```

任何 pending、rejected、遗漏、版本漂移、证据文件 hash 不符都失败且不写交接。此命令不修改 registry、不生成 JavaScript、不热加载任何代码，也不宣称发布完成。维护者在原静态 owner 做正常代码评审、契约导出、fixture 与打包发布；本地候选分享码仅用于参数评审，不能作为新场景代码装载器。

必要检查是 `node scripts/check-stage-authoring.cjs`；带 `--bundle` 还核验真实渲染和 fail-closed 交接。首次实现按用户要求采用先实现、后验证，未采用 TDD。
