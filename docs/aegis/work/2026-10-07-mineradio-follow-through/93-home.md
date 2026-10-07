# G1/G3 曲库首屏继续聆听

日期：2026-10-08。依据：`docs/research/mineradio-full-assessment.md` G1/G3/G9及主代理明确切片。沿用用户允许的先实现后行为回归流程。既有导航、播放队列、皮肤、每日推荐模块均保留。

## 实现

- 曲库首屏增加一张主要行动卡与音乐库、每日推荐、最近播放三个同层次次入口。主次通过面积、20px/16px主题字号和内容密度区分；不加首页专用队列、音频预览或自动播放。
- 已有当前曲目或恢复队列游标：暂停/停止时按钮“继续播放”，调用既有`setPlayback('play')`；已在播放时按钮“查看队列”，只导航，绝不反向暂停。队列存在但无有效当前项时明确“查看队列”。
- 没有队列时按需读取最近20条历史，从最近向后挑身份完整的记录；本地记录查询既有曲库元数据并跳过明确404，临时503等错误进入可重试状态。有效本地记录复用`playTrack`单首队列，在线记录复用`Online.playAll`与后端即时取流。主按钮明确“播放最近一首”，不暗示恢复位置或整份历史。
- 无最近记录时“添加音乐”打开原音乐目录面板并聚焦目录输入框。加载/读取失败时“去曲库”导航现有曲库并聚焦列表或目录按钮；失败另有“重试最近播放”。音乐库次入口不会擅自打开目录面板。
- 最近播放次入口复用原在线页历史列表。`setView(name, options)`新增可选`historyOnly`，避免该路径同时触发搜索/重复历史读取；等待原`Online.reloadHistory()`完成后才滚动和聚焦来源筛选，用户已离开时不夺焦点。主次导航均处理拒绝并提示。
- 所有状态只通过app.js注入的`homeSnapshot`读取。历史有请求世代与PlaybackIntent双重校验；晚到历史不能替换当前队列或新播放意图。封面节点保持身份，按id+封面键校验异步本地取图，解码与最终src提交仍委托原`applyCoverImg` owner。切歌立即撤掉旧图并作废旧解码。
- 尺寸按组件容器查询重排：宽容器为主卡/次入口两列，≤560px为纵向，≤340px次入口单列并隐藏装饰封面。使用现有色彩、间距、字号、圆角变量，无新增字体/组件框架/动效循环。导航可见性尊重既有每日/在线入口设置。

## 所有权与资源

- 新模块：`plugin/ui/home-dashboard.js`与`home-dashboard.css`；app.js只增加显式宿主绑定与原snapshot/queue/metadata更新通知。
- index.html、main.rs include/route/fingerprint全部接线；插件继续由原ui目录打包。README API生成块已更新并校验。
- `scripts/check-home-dashboard.js`纳入默认前端聚合；`check-home-dashboard-browser.js`提供真实Chrome组件检查。
- 按online子代理请求一并接好`creative-share-code.js`的index加载位置、main.rs三处、`check-creative-share-code.js`聚合；该codec、workshop实现及其证据属于94-share-code，不在本切片重复认领。

## 验证

- `node scripts/check-home-dashboard.js`：通过。实际模块行为覆盖无渲染自动播放、暂停继续/正在播放看队列、恢复队列当前项、历史乱序/新意图失效、晚到封面、空记录/读取失败/重试、处理中防重复、导航设置和次入口失败收口。执行app真实host函数验证`play`入口、不替换恢复队列、本地/在线最近身份转换、404跳过、503不伪造空历史、历史导航迟到不夺焦点。
- 恢复路径源码核对：`rpc/playback.rs::play`在audio snapshot无track_id而current_index存在时调用`play_index_for`、`consume_restore_seek`；`routes.rs::play`也有同一恢复分支，调用同一个`play_index_for`业务入口。故首页不需另发load或复制队列。此处是前后端接线核对，完整服务播放由主代理隔离null实例验证。
- `node scripts/check-home-dashboard-browser.js`：真实Chrome加载原index卡片/图标sprite、style.css/home-dashboard.css与原模块。键盘Enter继续后仍聚焦同一按钮，下一次Enter只进入队列；每日/最近/添加入口意图正确；晚到旧图不覆盖新图。
- 布局实测：900px容器高210px/两列；460px高226.7px/单列；280px高324.7px/单列；320px+双倍字号高457.4px/单列。全部按钮在容器内、无水平溢出。浅深主题变量下验证，截图保存在`output/playwright/home-dashboard/wide-light.png`与`narrow-large-type.png`，已人工查看。该脚本是组件fixture，宿主动作使用受控接口，不冒充完整app端到端。
- `node scripts/check-frontend.js --extra`退出0：47步通过，156个JS文件语法通过。包含资源745项、插件资源52项、现有曲库/收藏/每日/皮肤/播放与封面行为回归。
- `node scripts/api-routes.js --check`通过；当前119个方法+路径。相关文件`git diff --check`通过。

## 架构与剩余边界

架构对齐：符合既有“Rust业务事实、前端读快照发意图、PlaybackIntent跨视图撤销、原队列唯一owner”边界。首页仅缓存一条临时展示用历史记录与请求状态；无新增持久化、播放状态机或第二份队列。修复/退役：新增入口替代“回到应用只能手找播放按钮”的缺口，没有保留隐藏的自动回退播放分支。

剩余边界：最近入口预读最近20条；更早记录仍在原历史列表通过分页可达。在线权益和即时可播放性继续由原取流链判定，首页不据历史伪造授权。真实DBX宿主、多皮肤整页首屏与隔离服务会话恢复由最终集成记录给出，不从组件截图推导。当前证据置信度B。
