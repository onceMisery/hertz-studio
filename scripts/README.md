# scripts/

脚本按运行方式分四类，新增脚本前先确认自己属于哪一类。

## 1. CI 契约检查

`check-frontend.js` 是唯一聚合入口，`STEPS`（61 项）与 `.github/workflows/ci.yml`
的 Frontend contract 步骤等价；`EXTRA` 只在本地 `--extra` 时运行；`LIVE_EXTRA`
需要真实浏览器和运行中的服务（`--live`）。改 `STEPS` 时同步检查 CI 的注释与
步骤数。

## 2. 手工 / 浏览器验收

不在上面三组里的 `check-*` 必须登记在 `manual-checks.json`，至少写一行用途。
`check-scripts.js` 会拒绝未登记的新 `check-*`，也会拒绝指向缺失文件或与聚合
入口重叠的登记。浏览器类脚本优先复用 `ui-browser-fixture.js`（隔离服务、启动、
截图、断言）；`check-space-post.js` 的 `--browser` 分支是「同一条契约，纯逻辑
与真渲染两种跑法」的参考形态。

## 3. 诊断

`diag-*`、`qf-*`、一次性视觉探针不参与登记守卫。它们不承诺长期可跑；需要保留
结论时把结论写进 docs 或对应 check，不要只留脚本。

## 4. 发布 / 测量

`benchmark-search.js`、`evaluate-ai-stage.js`、`measure-release-ui.js`、
`capture-*` 等由发布或评测流程显式调用，不进入日常 CI。运行产物按
[`evals/README.md`](../evals/README.md) 的保留规则处理，不直接堆进 git。
