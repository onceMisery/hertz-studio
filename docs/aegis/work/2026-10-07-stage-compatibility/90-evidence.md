# 歌词舞台兼容性与转场验证

日期：2026-10-07。范围：用户五项优化；按要求先调查/实现，再补回归验证，不采用 TDD。

## 修复与根因

1. 凝彩取色：中性 UI 主题通过普通 `resolve` 输出白灰。`StanzaTheme.resolveTempera` 提供有彩回退并保留有彩封面的色相；各renderer独立取主题，导演切镜不再串色。单色印刷在palette明确灰阶化。
2. 凝彩逐句生成约5100个网点/纸粒，商籁editorial逐句重算全曲、重建七行，退场又克隆旧Text。改为有限网屏几何缓存（最多13份）、纸粒跨句复用、七行增量窗口和旧文字所有权移交。`destroyDisplayTree`正确释放Pixi私有GraphicsContext，外部共享context由缓存owner释放。
3. 设置漏接：sonnet的halation/atmosphere、tempera的halation/seams在setTuning被丢弃。已贯通默认值、差异检查、engineTuning与实际绘制。装饰与氛围解耦，关闭装饰不再顺带关闭氛围。光晕0摘除滤镜，不被起音重新打开。
4. `StageSettings.resolve`统一派生可用性。背景覆盖时隐藏场景坞和工坊目录，API/快捷键不能选择无效场景；绘制与手势同步停止。二维镜头不再被无3D条件误禁用。依赖项灰显并解释原因，星诞显示当前实际renderer的设置。保留模式/背景/参数偏好，刷新后恢复。
5. 光晕shader曾无条件写alpha=1，挡住下层3D。现在保留预乘alpha，空白透明，新增辉光只扩大所需覆盖。真实默认stage模式透过率：商籁约90.3%，凝彩约34.6%。
6. 星诞仍为元导演，输出段落冷影暖光、定向光位置及柔和光擦。宿主统一消费，无额外rAF/全屏滤镜。暂停冻结，seek/reset清旧转场，暗角开关包含电影阴影；导演退出清理移到配置边界，覆盖星诞→3D→星诞。
7. 沿用已有在线歌词校准入口，移除设置页仍错误禁用在线偏移按钮的旧判断。

## 参考与架构检查

- VCPChat：`Musicmodules/music-stage/music-stage-config.js`、`modes/tempera-pixi-core.js`、`sonnet-pixi-core.js`、`stage-pixi-effects.js`、movie/director光学层。
- folia-major：`src/components/visualizer/VisPlaygroundSettingsPanel.tsx`、tempera palette/motion、sonnet transitions/texture-pool/pixi-resources。
- 本项目：README、前一轮stanza-premium证据、ADR-0006。参考项目只读；保持本项目原生JS IIFE、Pixi、单Stage帧循环、宿主配置所有权。
- 独立只读审查发现并关闭：导演回调比较已更新的effective id导致晚一拍、导演切回3D不reset、歌词隐藏时仍启用律动、电影暗角未响应开关、渲染器参数丢字段、后期透明度损坏。
- ArchitectureReviewRequired: yes；Result: aligned。能力为派生状态，未另建存储；调色归Theme，效果归renderer/共享FX，导演不持有渲染器。
- Retirement: 旧逐句整窗重建、退场Text克隆、错误私有geometry销毁、散落opacity/motion禁用判断已移除；保留原背景偏好用于恢复，不保留隐藏背景的绘制开销。
- ADR Backfill: skip新增数字型ADR；此轮恢复既有owner与透明背景/设置契约，能力派生和缓存所有权在源码及本证据记录，没有新增持久化/公开协议。

## 验证命令与结果

浏览器依赖使用现有 `D:/code/github/folia-major/node_modules`，没有给项目安装新依赖。全应用验收使用独立 `VMUSIC_BACKEND=null`、端口18776、`output/stage-compatibility/data`，不改用户正在聆听的实例。

| 命令 | 结果与覆盖 |
| --- | --- |
| `node scripts/check-frontend.js --extra` | 141个JS语法通过；42步通过、0失败；资源710/710。聚合未运行18项其它live脚本，本轮相关live单独运行如下。 |
| `node scripts/check-stage-settings-browser.js` | 30模式/背景组合；DOM控件→实际光晕/氛围/HUD/接缝；依赖项、场景坞/API拦截；字号与参数保留；星诞暂停/暗角/退出reset；手机边界；服务端保存和刷新恢复；无pageerror。 |
| `node scripts/check-stanza-tempera-browser.js` | 1440×900、390×844、844×390；中性主题×stage/image/atmosphere×duo/vivid/mono；真实像素；光晕与接缝/网屏开关；有限缓存、resize、eco、destroy。 |
| `node scripts/check-stanza-transitions-browser.js` | 增量窗口对象保留、零重复Text、私有/共享context生命周期、两renderer退场、实际设置、光晕开关、透明度和预乘像素合法性。 |
| `node scripts/check-stanza-motion-browser.js` | 商籁/凝彩×三画幅：播放、暂停、seek、交接、短/长/混合歌词、reduced、eco、destroy。 |
| `node scripts/check-stanza-visual-fx.js` | 两模式两画幅的网屏/光晕/色彩/层次/图片背景、流光音频反应与减少动态效果。透明度修复后使用覆盖度验证“更实”，不再用亮度冒充不透明度。 |
| `node scripts/check-3d-interactions.js` | 66项通过。 |
| `cargo check -p hertz-studio --bins --target-dir target-qf` | 通过。 |
| `cargo build -p hertz-studio --bin hertz-studio --target-dir target-qf` | 通过，产物 `target-qf/debug/hertz-studio.exe`，全应用测试对照内嵌资源与源码一致。 |
| `cargo test -p hertz-studio --bin hertz-studio --target-dir target-qf` | 8项通过，包含资源指纹、URL版本化、令牌注入与凭据门。 |
| `git diff --check` | 通过。 |

全量测试中 `check-beat-budget.js` 原先仍要求RPC内联JSON转换，与既有HTTP/RPC共享owner冲突。已更新为验证共享owner及四条消费路径，34项通过；四种绕过/写死值的变异被拦截，生产后端未修改。

## 性能与边界

- 凝彩每次换句新建圆点约5100→274（减少约95%）；原预热换句约22–45ms，最后测试多数约4–7ms，首次新字/版型约13–15ms。
- 商籁普通换句Text 25→13；editorial 91–104→14（减少约85%）。基线约15.7–17.8ms，优化测量常见约7.5–11.7ms；最终有其它负载时边界测得20ms。资源计数比机器绝对耗时更稳定。
- 冷启动WebGL/字体仍可能约200ms；不承诺所有硬件、所有构图稳定60fps。没有新增字体/网络资源请求。
- 截图已检查：`output/playwright/stage-settings/`、`output/playwright/tempera/`、`output/stanza-fx-verify/`。原始日志：`output/stage-compatibility-*.log`。
- 工作区原本已有大量未提交更改，全部保留；本轮不提交混合工作树。

结论：五项实现与相关验收完成；Confidence: B（有直接像素/行为/性能证据，硬件帧率和冷启动仍有明确边界）。

## 追加优化：暂停、切镜与粒子生命周期

用户追加授权继续分析和优化，仍不采用 TDD。先真实浏览器诊断、再实现、最后加入回归。

### 已确认根因与修复

- 流光只暂停根节点呼吸，子行/逐字辉光仍运行，退场定时器继续删除旧行；心象平滑按墙钟 dt 推进，暂停640ms仍发生可见位移。现在流光暂停自身动画与频段变量，退场寿命用播放时间；心象输入不变的暂停帧不写样式、不清绘画布，seek直接定位，暂停调参仍刷新。
- 跨模式出场201ms、进场380ms，暂停后旧层仍被定时器隐藏，Pixi未提交首帧也照常退场。`stage3d`唯一帧循环现在先画进场层，再检查公开`isReady()`，使用Stage.position统一两层opacity；移除整层blur与墙钟退场。冷启动保留上一画面，已开始的叠化随暂停冻结，暂停手动切换与减弱动效在就绪后直接完成。离开歌词布局、关闭、销毁统一清理，快速冷切不选尚未就绪的中间层作出场层。
- 商籁装饰/重音开关原先每次新建13个Text，现为0，保留字形身份；光晕、氛围等其余设置仍正常组合。
- 凝彩mono仍被光晕暖化和RGB色散染色。现在共享后期明确消费monochrome，合法黑色`0`不再被当作无效值。蓝主题rawGL残彩像素约2.9%降至0；黑墨色mono通道最大差0，duo/vivid仍保留彩色。
- 商籁失败提示原先位于可被decor隐藏的HUD。错误复用独立空态，不随装饰开关消失；真实阻断Pixi资源加载后仍能稳定显示，`isReady()`与提示可见状态一致，destroy后的拒绝回调不再改DOM。
- 增强粒子歌词避让曲线反向，带外/带内/带外的同种光点alpha总量为28/144/28，修复后为152/28/152。销毁现在释放GL buffer、监听、ResizeObserver、动画及有界探针，允许重新init/attach。
- 独立审阅追加定位两条旧异步路径：GL降级后旧性能探针将2D粒子数79砍到39；旧涟漪完成事件让新实例计数提前归零。由粒子owner统一取消渲染器探针并隔离生命周期回调，复验分别79→79、新涟漪1→1。

### 新鲜验证证据

| 检查 | 最终结果 |
| --- | --- |
| `node scripts/check-frontend.js --extra` | 144个JS语法通过；42步通过、0失败。21项全仓库live脚本默认未运行，本任务相关live单独执行。 |
| `node scripts/check-stage-settings-browser.js` | 新编译二进制直接服务当前内嵌资源（逐文件与workspace核对），30设置组合、真实Stage帧门/renderer延迟就绪和暂停叠化、关闭重开、3D往返、保存恢复、移动端边界均通过，无pageerror。 |
| `node scripts/check-stage-handoff-browser.js` | 桌面/窄屏实际Chrome执行宿主函数与CSS，冷启动、双层同时间、暂停/恢复、seek、快速选择、减弱动效、隐藏/显示通过。 |
| `node scripts/check-stanza-dom-browser.js` | classic/cadenza × 桌面/窄屏，暂停动画、暂停零重绘、seek、退场寿命、调参及清理通过。 |
| `node scripts/check-stage-particles-browser.js` | GPU歌词避让、DPR、idle/hidden帧门、两个探针窗口取消、旧finish事件、destroy/reattach、真实context-loss回退均通过。 |
| `node scripts/check-stanza-transitions-browser.js` | 新增真实Pixi加载失败/提示可见/ready，以及开关零Text分配；原有资源所有权、增量窗口、退场、设置及预乘alpha回归通过。 |
| `node scripts/check-stanza-tempera-browser.js` | 三画幅×三背景×三配色通过，严格RGB差检测mono残彩0；ready、缓存、开关、resize、eco、destroy通过。 |
| `node scripts/check-stanza-motion-browser.js` / `check-stanza-visual-fx.js` | 两Pixi模式三画幅播放/暂停/seek/退场/降级、后期实际像素与流光反应回归通过。 |
| `cargo build -p hertz-studio --bin hertz-studio --target-dir target-qf` | 最终通过。 |
| `cargo test -p hertz-studio --bin hertz-studio --target-dir target-qf` | 8项通过。 |
| `node scripts/check-adrs.js` / `check-frame-gates.js` / `git diff --check` | 164项 / 37项 / 通过。 |

日志：`output/stage-refinement-*.log`；最终整页证据为`stage-refinement-settings-packaged.log`，截图在`output/playwright/stage-settings/`，移动端截图等待面板入场完成。中间一次编译撞上其他在途歌单后端改动，记录在`stage-refinement-build-in-progress-backend.log`；没有编辑其Rust代码。期间用临时代理验证当前资源，之后在重新构建成功时撤下代理并用真正内嵌资源完整复验。README只通过`node scripts/api-routes.js`同步生成区。

### 架构、退役与边界

Architecture Alignment: aligned。配置和可见性仍归stage3d；渲染器只报告首帧/错误就绪，单帧循环归Stage；粒子探针仍是原有两段有界测量，没有新增常驻rAF。ADR Backfill: amend ADR-0006，记录媒体时钟交接与首帧就绪契约。

Repair Track: 在各自owner修复时间、色彩、资源与异步取消边界。Retirement Track: 移除交接setTimeout/CSS动画/全层blur、流光墙钟退场、商籁显示开关重建、错方向避让和失效异步回调写入；未保留重复owner。

残余边界：首次GPU/字体初始化仍有成本，等待首帧仅避免旧画面提前消失；没有跨硬件60fps承诺。实际暖态换句本次常见4–8ms、首次新字/构图约13–15ms，受设备与并发负载影响。未提交混合工作树，用户原运行实例不替换。Confidence: B，当前授权追加优化与相关验收完成。
