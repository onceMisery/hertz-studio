# 动画绘景舞台扩展 - Evidence

本轮接着 2026-10-09 的 checkpoint 收尾：完成整页宽窄屏、暂停/减少动效、存档/恢复与既有场景回归，
并把两条纯逻辑检查接进 CI 默认集合。四套绘景（晴空云海、黄昏海岸、月下列车、森间灯火）的实现本身
沿用已登记的 `CreativeGL.register` 通路，没有新增所有者。

## 上一轮那条红已经不复现

2026-10-09 20:27 的 `output/playwright/anime-scenes/report.json` 停在 `workshop fits 760`：
`.ws-panel` 实测 `left=445.35 / right=1205.35`（视口 760），同时 `close=false`——面板整块在视口外，
× 的命中测试落空。备份见 `output/anime-report-red-20261009.json` 与 `output/anime-journey-failure-20261009.png`。

复现这一步得的是**反证**：`output/anime-760-probe.js`（只起隔离服务、开舞台、开工坊、逐宽度量面板与祖先链）
在 1440/760/420/320 四档都量到 `left=0 right=视口宽`、`closeHit=ws-close`，早帧与 900ms 后的晚帧一致，
说明不是过渡动画的竞态；祖先链里 `#stage3d` 的 `contain: strict` 与 `#workshop` 的 `will-change: transform`
在两个宽度下都一样，没有哪个祖先把 `position: fixed` 的包含块带偏。当前工作树 + 当前构建复现不出溢出。

结论只到这一层：**那条红早于 00:45 的那次重建**，窄屏修复（同批 `plugin/ui/workshop.js` / 绘景 CSS）已经把它带走了。
没有「红→绿」两次连续运行做对照，所以不能指名是哪一处改动修的，也不能断言它不会回归——
现在拦住回归的是 `check-anime-scenes-browser.js` 的宽度矩阵，而不是这条记录。

## 新鲜验证

| 命令/检查 | 结果 | 证据 |
| --- | --- | --- |
| `node scripts/check-anime-scenes.js` | 98/98，退出 0 | 登记/参数/保存/分享/提示词/恢复往返 |
| `node scripts/check-anime-ui.js` | 51/51，退出 0 | 晴空绘卷外观族：图库分区、材质、点击反馈按族放行 |
| `node scripts/check-anime-scenes-browser.js` | 9 组 PASS，`failure: none`，`errors: []`，退出 0 | `output/playwright/anime-scenes/report.json` |
| 同上的布局断言 | 1440/760/420/320 四档面板全在视口内、× 可命中、320 退成单列 | `report.json` 的 `layouts` |
| `node output/anime-760-probe.js` | 四档均 `left=0 right=宽`，早晚帧一致 | `output/anime-760-probe/late-*.png` |
| `node scripts/api-routes.js` | 重生成：内嵌静态资源路由 90 → 91 | `docs/api-routes.md`（生成物，勿手改） |
| `node scripts/check-frontend.js` | 40 步 0 失败，退出 0 | 新接入的两步在其中 |
| `cargo test --locked -p hertz-studio --bin hertz-studio` | 10 passed / 0 failed，退出 0 | `output/anime-cargo-test-20261010.log` |

浏览器检查用的隔离实例由 `scripts/ui-browser-fixture.js` 自起（随机端口、临时数据目录、Null 后端），
Playwright 走 `PLAYWRIGHT_MODULE` 指向的全局模块 + 系统 Chrome。该脚本会先把磁盘上的
`creative-anime.js` / `creative-anime.css` / `cel-ui.css` 等与**服务实际吐出的那份**逐字节比对，
所以「构建里到底是不是这次的前端」不是靠印象：不重建就复现不出来。

## 接线变化

`scripts/check-frontend.js` 的默认集合（= CI 的 Frontend contract checks）新增 `check-anime-scenes.js` 与
`check-anime-ui.js`。在此之前这两条谁都不跑：`check-anime-scenes.js` 不在 STEPS 也不在 EXTRA，
`check-anime-ui.js` 同样漏，而 `.github/workflows/ci.yml` 只调 `node scripts/check-frontend.js`。
五条 `*-browser.js` 仍只被 `--live` 自动发现，CI 没有 Chrome 与隔离服务，保持原样。

`docs/api-routes.md` 之前被手改成 90，而 `crates/hertz-studio/src/assets.rs` 登记三个新资源后生成器算的是 91，
`check-frontend` 因此在第 2 阶段报红；现在回生成器一致。
