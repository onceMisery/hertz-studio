# 当前界面布局与按钮契约

2026-11-10 整合旧 UI 分支时，保留现有 Hertz 单一布局及旧皮肤退役结果。AppShell 是公共布局还原的唯一所有者；Skins 继续管理 Hertz 创建的视图子结构及其生命周期。播放、队列、房间和舞台的业务所有权保持。

活动接口是 HertzShell.beginLayout(id)、handle.move(node,parent,before)、handle.restore() 和 HertzShell.releaseLayout(id)。同一组件只能由一个装配持有，业务视图根只能经 attachView；循环、脱离节点与失败插入在记录提交前拒绝。原位注释锚点维持精确次序，同一装配多次搬运只保存最初位置；释放自动还原并清除所有权。

旧分支的 assembleLayout 与五套皮肤调用不再适合当前 Hertz 动态视图结构；整合保留其独占、失败回滚和精确还原语义，不恢复已删除的皮肤或第二套布局 API。

components/button.css 是按钮尺寸和交互态的唯一实现。Hertz 通过 --button-* 参数调整默认及 primary 外观；touch/tiny/flat 保留各自公开变体。主按钮的 hover 保持前景背景配对，flat.primary 保持强调底和墨色，减少动态效果时关闭过渡。房间不再重复这些规则。

验证：node scripts/check-frontend.js --extra；node scripts/check-shell-layout-browser.js 验证真实 Hertz 页面、组件独占、非法搬运、还原顺序以及桌面/移动深浅主题按钮。原生资格及跨设备验证仍单独保留。
