# 界面组件与皮肤装配契约

当前实现：`plugin/ui/shell/shell.js`、`plugin/ui/components/button.css`。验证入口：`node scripts/check-shell-layout-browser.js`（需 `HERTZ_BIN` 与 Playwright）。

## 所有权

AppShell 持有活动视图、公共区域和组件装配；Skins 持有皮肤选择、切换及皮肤专属交互。播放、队列、房间会话、舞台 renderer 的所有权不变。

组件作者在 `index.html` 的稳定根节点上声明 `data-shell-component`。需要接收装配的容器另声明 `data-shell-region`。AppShell 初始化时捕获这些节点，之后皮肤不能动态登记组件、传入选择器或传入待搬运 DOM。标记不是安全隔离机制，是由组件作者维护并经检查验证的内部契约。

| 公共组件 | 边界 |
| --- | --- |
| `navigation`、`content`、`topbar`、`stage`、`player` | 导航、内容、顶栏、舞台与播放栏的整体根节点；同时提供同名区域 |
| `brand`、`account` | 品牌与登录入口；登录状态和事件仍归原模块 |
| `stage.heading`、`stage.title`、`stage.artist`、`stage.artwork` | 舞台明确允许独立排列的子组件；迁移根节点，不允许拆取其内部元素 |
| `player.summary`、`player.progress`、`player.mode`、`player.volume` | 底部播放器的独立展示/控制单元，继续消费同一份播放状态 |
| `player.desktop`、`player.expand` | 原桌面入口和展开入口，保留原事件绑定 |
| `library.toolbar` | 曲库工具栏整体，业务查询和动作不交给皮肤 |
| `nowPlaying.volume` | 展开播放页的音量控件整体 |

额外接收区域：`app`、`floating`、`topbar.actions`、`player.controls`、`library.header`、`nowPlaying.tools`。普通业务视图不进入组件搬运接口；设置等已登记视图继续通过 `attachView/detachView` 装配。

修改组件内部 HTML 时保留公开根节点和标记即可。确实要新增可独立装配的部分，应先明确子组件边界，再增加标记及测试；不要向皮肤暴露内部选择器或通用查询方法。

发行版可以省略特定组件。例如 Standard 不发布 `account`，清风使用只读 `hasComponent('account')` 决定是否声明账号装配。不存在的组件不能被装配；可选能力由组件作者和发行版决定，不通过忽略所有未知名称兜底。

## 布局描述

```js
const layout = HertzShell.assembleLayout('skin-id', {
  regions: {
    side: { className: 'skin-side', parent: 'app' },
  },
  placements: [
    { component: 'stage', target: 'side' },
  ],
});
// 在本皮肤区域内创建自己的装饰和交互。
const side = layout.region('side');
// 卸载时先归还组件，再移除皮肤专属结构。
layout.dispose();
```

- `regions` 描述由外壳创建的局部容器，支持 `tag`、`className`、`parent`、`first`、`before`；父区域必须先声明。局部名称不能覆盖公共组件或区域。
- `placements` 只包含公共组件名和目标区域名。`before` 也使用名称；其节点必须属于目标父区域。默认追加，`first: true` 插入首位。
- 外壳验证所有权、创建区域并整体执行装配。未公开组件、任意 DOM 参数、未知区域、重复占有和 DOM 循环都会被拒绝。失败撤销本次全部移动和新建容器。
- 每个组件同一时刻只归一份布局持有。还原锚点保存在外壳内部，保证被同时重排的兄弟和嵌套组件也能恢复原顺序。
- 装配时复制并冻结描述字段。调用方之后修改原对象不能改变响应式装配对象、绕过独占检查或污染还原账本。
- `dispose()` 可重复调用；它释放媒体查询监听、归还组件、移除锚点与外壳创建的容器、释放组件所有权。皮肤随后清理自己的监听器与装饰节点。
- 可声明 `media: '(max-width: 767px)'`，由外壳管理响应式装配/还原。例如星轨把 `nowPlaying.volume` 放入 `nowPlaying.tools`，不再在 resize 回调里查询和搬动音量条。

`beginLayout().move()`、`placeAtOriginal()` 和皮肤的 `relocate/restoreMoves` 已删除。保留旧工具函数名或把任意 DOM 搬运挪到另一个模块，都不算符合此契约。

## 公共按钮

`components/button.css` 统一定义基础、primary、touch、flat、tiny 和交互状态。皮肤通过 `--button-*` 参数给出基础度量/表面，显式变体由组件本身解释。房间的按钮采用 `btn touch flat`，主操作加 `primary`。

皮肤不得再对通用 `.btn` 整段重定义尺寸或状态。具名业务区域的布局规则可以保留；如果要改变公共按钮的外观，应增加或使用公开参数/变体。primary 的前景和背景必须成对定义；hover 不得单独把背景降为弱填充而保留强调底上的文字色。

本次删除房间 `#view-room .btn.touch` 的整段覆盖，删除 `skins.css` 的通用按钮重定义，将清风的通用按钮圆角改成默认参数。房间不再靠 ID 特异性保护基础状态。

## 验证边界

浏览器回归覆盖：非法布局原子回滚、组件独占、五皮肤反复切换、节点和监听器保留、原顺序恢复、唯一设置视图、响应式释放、服务暂停与播放中两种状态，以及五皮肤×深浅主题的悬停、按压、禁用、键盘焦点与减少动态效果。`check-skins.js` 另阻止旧搬运调用回流。具体结果与原生窗口验证边界见[评审修复记录](plans/2026-11-04-ui-convergence-review-fixes.md)。

这份契约完成区域装配与按钮状态的边界修复，不等于所有业务视图和视觉组件都已完成整个 UI 收敛路线。其他模块仍应依原设计按实际迁移范围验收。
