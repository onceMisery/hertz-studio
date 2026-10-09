# 窄屏双行顶栏与确定性清风检查 - Evidence

本轮按引用聊天最后的推荐方案实施，范围为窄屏顶栏和清风检查，不重新实施已合入的在线账号/播客功能。

## 根因与修复

- 旧顶栏固定按钮组在 330px 撑到 364px；连接状态虽隐藏文字，仍保留胶囊 padding/gap。手机改为工具一行、搜索一行，缩减状态点占位和间距；经典/工作台/流年/潮汐共用高度令牌，iOS 保留自己的安全区与双行规则。
- `stage3d.css` 额外覆写共用按钮间距，导致只改 `style.css` 仍会被盖掉；已将这条布局规则收回 `style.css`，按钮尺寸保持。
- 搜索菜单最小 380px 超过手机宽度；改为按视口减去两侧 12px 限制。浮光搜索原来仍为桌面留出 460px 按钮区，320/330/390px 输入框只剩 22px；≤900px 改为唤起时在导航位置横向铺开。
- 清风脚本从外部服务读取未知播放状态，却要求标题/歌手非空；改为自建随机端口、临时目录、Null 后端和内存凭据的真实服务，先验空态，再生成带 INFO 标签的 WAV、扫描、校验、加载并暂停。finally 关闭服务/浏览器并验证清理路径。

## 新鲜验证

| 命令/检查 | 结果 | 证据 |
| --- | --- | --- |
| 旧 `check-qf-issues` + 全新隔离空播放器 | 6 PASS / 2 FAIL，退出 1；标题和歌手为空 | `output/narrow-qf-red.log` |
| 新窄屏检查 + 修复前构建 | 330px 经典 34px 溢出，搜索菜单越界；退出 1 | `output/narrow-topbar-red.log` |
| `cargo build --locked -p hertz-studio --target-dir target-narrow-topbar` | 退出 0，包含最终前端资源 | `output/narrow-topbar-build-final.log` |
| `node scripts/check-narrow-topbar-browser.js` | 49 组，0 失败，退出 0 | `output/narrow-topbar-green-2.log` |
| `node scripts/check-qf-issues.js`（最终构建） | 10 PASS / 0 FAIL，退出 0 | `output/narrow-qf-final.log` |
| `node scripts/check-skins.js` | 795/795，退出 0 | 同时纳入前端聚合 |
| `node scripts/check-appearance-restore.js` | 45/45，退出 0 | 同时纳入前端聚合 |
| `node scripts/check-frontend.js --extra` | 48 步，0 失败，退出 0；未执行整组 live | `output/narrow-frontend-final.log` |
| `git -c core.safecrlf=false diff --check` | 退出 0 | 最终交付检查 |

浏览器矩阵取自实际 `Skins.list()`：classic、sheen、workbench、liunian、ios、qingfeng、chaoxi，宽度为 320、330、390、620、621、700、1440px。
每组检查 `scrollWidth/clientWidth/scrollX`、内容区起点、所有当前皮肤应显示的共用按钮边界和命中，并用 Playwright trial click 验证。
实际开启主题、皮肤、更多菜单，等待有限动画完成再测边界与菜单项命中；搜索检查真实 `/` 快捷键、输入框宽度及下拉锚点。
清风有自己的搜索结构，矩阵不把其隐藏的共用搜索框判成故障；其空态与加载音频另由清风检查覆盖。

第一次扩大检查时，菜单在跨 1440→320px 后的中间帧沿用了旧几何；等待菜单的有限动画结束后复测通过，未改菜单生产代码。
`output/playwright/narrow-topbar/geometry.json` 保留尺寸、命中及错误计数；同目录存 320/390/1440px 截图，已查看经典、iOS、流年截图。

## 重跑

```powershell
$env:NODE_PATH = 'D:/dev-env/node/node_global/node_modules/@playwright/cli/node_modules'
$env:HERTZ_BIN = 'D:/code/github/hertz-studio/target-narrow-topbar/debug/hertz-studio.exe'
node scripts/check-narrow-topbar-browser.js
node scripts/check-qf-issues.js
```

`check-frontend --live` 会发现窄屏检查；清风也显式加入 live 清单。`qf-skin-checks.sh` 将 HERTZ_EXE 传给它的 HERTZ_BIN，不再传 TK 或依赖已有歌曲。

## 边界

默认 `cargo build` 因运行中的 `target/debug/hertz-studio.exe` 文件锁退出 101，已改为独立目录成功构建。测试自建进程均已关闭，未操作既有实例，用户需启动新构建使用新界面。
不把七组宽度推定为所有主题、触屏设备或所有业务页面均已验收；本轮不评估第三方账号与平台可用性。置信度 B。
工作区结构检查仅报告三份既有未索引文档，本轮记录无结构错误；未修改那些无关文档。

## EvidenceBundleDraft

- Artifact key: browser-regressions
- Type: test
- Source: output/narrow-topbar-green-2.log; output/playwright/narrow-topbar/geometry.json; output/narrow-qf-final.log
- Summary: 新构建通过七皮肤×320/330/390/620/621/700/1440px共49组，页面overflow/scrollX为0，按钮命中、搜索快捷键、弹层定位通过。清风自动隔离空态与真实WAV扫描加载，10通过0失败。
- Verifier: root执行真实Chrome检查并查看截图

## EvidenceBundleDraft

- Artifact key: final-build-frontend
- Type: test
- Source: output/narrow-topbar-build-final.log; output/narrow-frontend-final.log; git diff --check
- Summary: 独立目录最终构建成功；前端聚合48步全通过（包括皮肤795、外观恢复45）；差异空白检查退出0。默认exe文件锁和三份既有未索引文档是已记录边界。
- Verifier: root运行并核对退出码
