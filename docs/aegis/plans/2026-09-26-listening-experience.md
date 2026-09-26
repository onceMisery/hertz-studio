# 歌单、封面、歌词与创意工坊体验升级

- Goal：参考 Mineradio 的立体歌单/封面与 folia-major 的歌词节奏，优化可感知的展示质量和工坊可用性。
- Architecture：原生 JS/CSS/WebGL2；Stage 保持曲目、歌词时间轴和频谱所有权，PlaylistCovers 保持封面解析所有权，app.js 保持播放/API 所有权。无新增生产依赖、播放时钟或 rAF。
- Baseline：README、shelf.js、pl-covers.js、stage.js、stage3d.js、workshop.js、creative-stage.js；参考 Mineradio/04-shelf 与 folia-major/monetLyricMotion、MonetLyricsRail、graphemeTiming。
- Compatibility：保留工作区已有收藏、在线和后端改动。保留七个场景标识、CreativeStage 编排和导入导出格式。用户明确不用 TDD；直接实现后验证。
- Verification：Node 资源/令牌/创意舞台/歌单检查、cargo build，以及浏览器真实交互和截图。使用隔离测试数据，不改用户曲库。
- ArchitectureReviewRequired：yes。

## 已确定的设计

默认歌词为大字居中、逐字柔边扫亮、前后句景深（用户已选择）。提供“封面与歌词”和简洁单句布局。封面采用唱片封套、真实侧面、黑胶唱片与反光层，随指针轻微转动。

歌单保持现有表现层，修复节点复用造成的图片原地切换，改为有连续位移的封面流；增大封面占比，提供封套厚度、倒影、导航与明确的播放/详情操作。

工坊默认编辑当前沉浸声场，选择效果后直接预览。高级编排明确切换到原创意舞台，保留全部旧能力。提供可视预设、少量常用调节、撤销/重做、恢复默认和参数分组；不把内部参数路径放进普通操作流程。

值得借鉴并纳入本轮：歌词手动浏览与回位、歌词/封面布局切换、编辑目标可见、可撤销调参。远程控制、OBS、播客与新增音源不属于本轮展示体验，记录为后续候选，不混入本次实现。

## 实施顺序

1. 改造 shelf.js / style.css：稳定卡片身份、3D 封套、封面回退、输入与集合更新。
2. 新增 stage-lyrics.js，替换 Stage3D 内原三行文字实现；保留 Stage 的时间轴与分词输入。增加封面布局与参数持久化。
3. 改造 workshop.js / creative.css：沉浸效果工作区、明确的高级编排入口、实际预览、撤销与重做、友好参数。
4. 接入资源与入口，检查生命周期、焦点、触摸与减少动态效果。
5. 构建后验证真实内嵌资源，复查桌面/手机截图，更新证据记录。

## 替代与风险

不另建播放器或统一两套渲染器；保持两套已有舞台的所有权，通过明确编辑目标消除歧义。旧 Stage3D 三行歌词展示代码在新模块接入后移除。大歌词只渲染邻近行，不随曲长增长 DOM；CSS 3D 父层避免 opacity/filter/overflow 导致压平。浏览器实测是当前硬件证据，不代替所有设备的帧率或主观视觉验收。
