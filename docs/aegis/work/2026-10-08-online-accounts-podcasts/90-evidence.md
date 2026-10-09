# 在线账号修复与中文播客 - Evidence

2026-10-09 交付记录。实现经独立审查后，以三方文件合并回 `D:/code/github/hertz-studio`，
保留并行首页、清风、网易改动；索引与 Git refs 未改动。原有 7634 服务未用于验证。

## 产品和协议证据

- 汽水：旧 PNG 中 `/ucenter_web/app/sdk-next` 实测 404；新二维码由同一握手 token 生成
  `/light/invoke/scan_login`，正确保留 `os=Windows`、参数转义和创建期 Cookie。
  最终真实服务创建及轮询返回 waiting；抖音手机确认未进行，`qr_login` 保留未验收标记。
- 咪咕：官方 v5 SDK 与公开接口核验后实现 `pacmtoken` 账号验证、歌单分页、PQ 取流信封。
  模块用例 28 passed / 1 ignored；显式真实接口验收 1 passed：匿名和合成无效票为 auth_required，
  歌单总数 113，首 100 / 跨页 3 / 尾 2 / 越界 0；公共歌曲无 ref 得到 206 / audio/mpeg / ID3，
  会员曲 440013 为 vip_required。本人有效 Cookie 未验证，cookie_login 继续标未验收。
- 播客：Apple 中文搜索成功；真实 RSS 收录故事FM 995、忽左忽右 645、声东击西 432 期。
  真实封面经过共用代理；订阅/取消/分页、取消后详情和稳定 ID 保留。HTTP/RPC 共用同一 DTO/服务。
- 实际解码：隔离数据目录、`VMUSIC_SECRETS=memory`、CPAL volume=0。
  咪咕公开歌曲、声东击西 MP3、忽左忽右 M4A 均实际播放，快照推进超过 1200 ms。
  使用合并后构建重启服务，只凭持久单集 ID 可再次读取详情并解码播放，订阅仍在。
- Chrome：真实服务中搜索、100 期分页、订阅、RSS 导入、播放、咪咕 Cookie-only 表单与无效票拒绝；
  classic / liunian / qingfeng / ios / sheen / workbench 全部进入播客，390 px 窄屏无水平溢出；无 pageerror。
  桌面、窄屏、登录与各皮肤截图已查看。Node 控制通道曾出现临时 localhost TCP 超时，
  浏览器验收改由实际页面 transport 执行控制后独立重跑；它不是媒体或产品验证成功的替代条件。
  最终截图跳过有限入场动画的中间帧，补查每套皮肤的播客导航选中状态；再次运行退出 0。

## 回归与构建

所有 Cargo 命令均为 `--locked`，隔离 target 为 `D:/code/github/hertz-studio/target-online-podcasts`。

| 命令 | 结果与覆盖 |
| --- | --- |
| `cargo test -p hertz-studio`（合并后目录） | lib 414 passed / 3 ignored，bin 10 passed；退出 0 |
| `cargo build -p hertz-studio -p dbx-plugin-hertz` | 两个最终程序构建成功；退出 0 |
| `node scripts/check-plugin-sidecar.js`（最终程序、Null） | 280/280；媒体类型、咪咕能力、播客路由/输入错误与既有协议。Null 仅作协议测试 |
| `node scripts/check-frontend.js --extra`（合并后目录） | 48 步通过、0 失败；聚合命令不包含活体检查，实际浏览器另行执行 |
| `node output/online-podcasts-live.js browser`（合并后构建） | 退出 0；六套皮肤、搜索、分页、订阅、实际播放、导入、窄屏和无效咪咕凭据；0 pageerror |
| `node scripts/check-podcasts-browser.js` | 真实 DOM：乱序、文本安全、分页、播放索引、订阅、导入、失败刷新保留内容和容量提示 |
| `node scripts/check-online-login-browser.js` | Cookie-only 源不申请二维码；保存后账号验证；无效票/超时/换源后的迟到响应 |
| `node scripts/check-adrs.js` | 215 项通过；共享网络归属与 3 秒/6 MiB/2000 期限制同步 |
| `node scripts/api-routes.js --check` | 124 方法/路径 + 82 静态资源；合并首页资源后已重新生成 README |
| `cargo fmt -p hertz-studio -p vmusic-store -- --check`；`git diff --check` | 本轮 crate 格式及整个工作区差异空白检查通过；退出 0 |

初轮整套 Rust 的唯一失败是 Windows 下 SQLite 关闭后临时目录句柄短暂残留；
该用例的能力断言均已完成，清理改为 best effort，最终全套通过。未改生产行为掩盖失败。

全工作区 `cargo fmt --all --check` 退出 1，仅报告 `plugin/vendor/dbx-plugin-sdk/src/lib.rs`。
已与基线 `f07ac6c` 对比确认该文件未改，未连带格式化第三方代码。
Aegis workspace `check` 退出 1，报告三份非本轮文档未索引：既有 hardening spec、
cover-sphere reflection 及并行 home-quote plan；本轮记录没有结构错误。
这些结果单独保留，不计入上表通过数，也不以结构检查代替产品验收。

## 独立审查及修复

后端规范审查通过；质量审查复现并关闭：

1. 慢 RSS 刷新耗尽取流期限：可选刷新限 3 秒，超时/取消释放 future，并仍能使用已保存 URL。
2. 刷新期间分页总数与条目跨快照：节目与单集共用 SQLite 读事务；双连接回归先 RED 后 GREEN。
3. RSS 封面经过旧代理可访问内网且先完整分配图片：提取唯一 `public_net`，验证首跳、实际 DNS、
   每跳重定向，图片全程 HTTPS；6 MiB 逐块拒绝并验证无 EOF 响应被取消。cover_ 12/0、public_net 5/0。
4. 已确认订阅被迟到 feed 回滚：每节目 revision 合并；订阅和取消两方向 Chrome RED→GREEN。
5. 截断节目仍显示“共 N 期”：`episode_limit` 从后端常量下发，显示“已收录”及容量提示；RED→GREEN。

最终独立审查无未关闭代码缺陷；实际验收另由 root 执行，不用代理 PASS 代替运行证据。

## 外部限制与置信度

故事FM 的 RSS 可读，但 2026-10-09 真实播放时其 `tk.wavpub.com` 跳转域名返回
`CERT_HAS_EXPIRED`，Hertz 下载器与独立 Node TLS 请求均失败；未跳过证书校验，也未自动降为 HTTP。
当前只能如实记录该发布者音频暂不可用，不把早前 Range 成功当作现在仍可播。

有效本人咪咕会话、抖音手机确认和人工听音没有覆盖。置信度 B：功能、协议和静音解码有直接证据，
本人账号及外部平台状态独立验收。三个 ignored 网络用例为咪咕公开验收、QQ 私人推荐探测、播客公网
样例；咪咕与播客另外做了显式真实验证，未读取用户 QQ 凭据。

证据原件放在仓库 `output/`，截图在 `output/playwright/online-podcasts/`；
日志只保留结果、域名和匿名 fixture，不复制测试服务的 token、二维码票或用户凭据。
隔离测试进程已按可执行路径校验后关闭；原 7634 监听仍在。交付前再比对 34 份生产/测试文件，
均与已验证的三方合并结果一致；其后仅整理 README、任务记录及忽略的输出证据。

## EvidenceBundleDraft

- Artifact key: podcast-api-and-ui
- Type: test
- Source: cargo test --lib podcast_; node scripts/check-frontend.js --extra; node scripts/check-podcasts-browser.js; node scripts/check-online-login-browser.js
- Summary: Provider/下载初始私网拦截/HTTP-RPC相同订阅分页和持久ID3项GREEN；前端48步通过；Chrome确认刷新失败保留单集、旧订阅/节目响应不覆盖、Cookie必须账号验证
- Verifier: root执行命令并核验输出

## EvidenceBundleDraft

- Artifact key: review-fixes
- Type: test
- Source: node scripts/check-podcasts-browser.js; cargo test -p hertz-studio; node scripts/check-adrs.js
- Summary: 历史切片记录：订阅迟到feed回滚与容量提示均Chrome RED到GREEN；当时图片公网策略待完成。该中间状态由下方最终集成证据及上表 424 项 Rust 通过结果替代。
- Verifier: root运行和核对输出，审查者独立复核代码

## EvidenceBundleDraft

- Artifact key: final-integrated-regression
- Type: test
- Source: cargo test --locked -p hertz-studio --target-dir D:/code/github/hertz-studio/target-online-podcasts; cargo build --locked -p hertz-studio -p dbx-plugin-hertz --target-dir D:/code/github/hertz-studio/target-online-podcasts; node scripts/check-frontend.js --extra; node scripts/check-plugin-sidecar.js
- Summary: 合并后原目录独立执行：Rust lib 414/bin 10 通过，3 ignored；两程序构建通过；前端48步通过；HERTZ_PLUGIN_BIN指向最终dbx-plugin-hertz.exe，memory凭据/Null协议280项通过。命令均退出0。
- Verifier: root 执行最终命令并核对日志/退出码

## EvidenceBundleDraft

- Artifact key: final-live-and-restart
- Type: test
- Source: output/online-podcasts-live-final.log; output/online-podcasts-integrated-browser.log; output/online-podcasts-restart.log; output/storyfm-tls-diagnostic.log; output/playwright/online-podcasts/
- Summary: 隔离CPAL且volume=0，咪咕公共歌曲、声东击西MP3、忽左忽右M4A实际解码推进超过1200ms。合并后构建重启保留订阅和稳定ID重播。最终Chrome六皮肤/搜索/订阅/分页/导入/播放/窄屏/无效咪咕会话通过且无pageerror；上一次Node控制连接超时保留在原日志，独立浏览器重跑成功。手机确认、有效本人会话、人工听音未覆盖；故事FM音频证书过期。置信度B。
- Verifier: root 执行真实服务、Chrome及独立TLS请求，查看最终截图

## EvidenceBundleDraft

- Artifact key: review-fixes
- Type: test
- Source: crates/hertz-studio/src/podcasts/tests.rs; crates/hertz-studio/src/public_net.rs; scripts/check-podcasts-browser.js; output/podcasts-integrated-rust-tests.log; output/podcasts-subscription-race-red.log; output/podcasts-subscription-race-green.log; output/podcasts-capacity-red.log; output/podcasts-capacity-green.log
- Summary: 最终关闭慢刷新期限、分页跨SQLite快照、封面URL/DNS/重定向及6MiB逐块读取、订阅迟到响应和收录上限误报五项；独立质量审查无未关闭代码问题。先前切片406项/目录清理失败及后端待验证状态被最终424项Rust通过替代。
- Verifier: 独立审查者复核实现；root独立执行行为回归和最终全套

## EvidenceBundleDraft

- Artifact key: workspace-and-format-boundaries
- Type: check
- Source: cargo fmt -p hertz-studio -p vmusic-store -- --check; git diff --check; cargo fmt --all --check; python C:/Users/miracle/.codex/aegis/scripts/aegis-workspace.py check --root .
- Summary: 本轮crate格式与差异空白检查退出0。全工作区格式退出1，仅既有vendor SDK lib.rs，内容与f07ac6c相同。结构检查退出1，仅未索引的hardening spec、cover-sphere reflection与并行home-quote plan，本轮记录无结构报错；不改无关文件来使检查变绿。
- Verifier: root 运行并对照基线及任务文件清单

## EvidenceBundleDraft

- Artifact key: delivery-integrity
- Type: check
- Source: output/podcasts-integrated-delivery.log; output/podcasts-runtime-cleanup.log; output/online-podcasts-evidence-manifest.json
- Summary: 34份生产/测试文件与已验证合并一致；安全证据和稳定截图已保存在原目录；隔离运行时按路径校验后关闭，原7634监听仍在。未更改Git索引、refs或推送。
- Verifier: root 比较文件、核对进程并整理交付
