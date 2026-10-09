# 扩展皮肤、舞台与音乐渠道

扩展使用随应用发布的内置注册表，继续保持原生 JS、单个可执行文件与 DBX 打包。注册描述负责静态定义；播放器、舞台时钟、预置与设置仍由原模块持有。这里的接口不承诺加载未经审核的第三方插件。

## 皮肤

入口是 `plugin/ui/skins/skins.js` 的 `Skins.register`。纯布局皮肤提供 `id`、`name`、`note`，CSS 用 `[data-skin="你的 ID"]` 限定作用域。ID 同时是已保存偏好的身份，发布后不要重命名。

需要搬动业务节点的皮肤提供 `lifecycle: { mount, unmount }`；内置描述与实现分文件时，使用 `Skins.registerLifecycle(id, hooks)`。后者只接受已有描述，并拒绝重复或不完整的钩子。

- `mount` 同步挂载，必须允许对应 `unmount` 清理部分构建。先记录资源归属，再分配 DOM、监听器和 observer。
- `unmount` 归还业务节点及原位置，释放监听器、observer、timer 和 RAF，再删除皮肤生成的容器。流年与清风是现有例子。
- `Skins.apply` 顺序为卸载旧皮肤、更新属性/CSS、挂载新皮肤、通知订阅者。重复选择不重复挂载。失败会尝试恢复旧皮肤；恢复中也保留清理归属。
- `Skins.onChange` 返回取消订阅函数，供尺寸重排等观察者使用；不要用观察事件决定皮肤的挂载顺序。

业务动作通过 `Skins.request(action, extra)` 发给 `app.js::initSkinBridge`，返回值包含同步快照或异步任务。例如 `Skins.request('source-request').source` 读取当前列表，`Skins.request('step-track', { delta: 1 })` 请求下一曲。设置页可使用 `Skins.request('settings-enter', { sections: ['cache', 'dsp', 'remote'] })` 声明额外刷新范围。皮肤不创建另一套队列，不自行判断本地/在线切歌，也不直接订阅专属业务事件。新业务动作仍需在宿主明确实现。

CSS 在 `index.html` 中声明带 `data-skin-css` 的 disabled 样式表；JS 按依赖顺序加载。再按下方资源登记步骤内嵌文件。DBX 的 `<style data-skin-css>` 同样受支持；最低宿主版本为已验收的 0.6.35，0.6.29 会在内联时丢弃此标记。

验证：`node scripts/check-skins.js`、`node scripts/check-appearance-restore.js`，以及真实服务上的 `scripts/check-skin-fixes.js`。需要搬节点的皮肤至少验证正反切换、重复选择、部分挂载失败和业务节点恢复。

## 舞台场景与歌词渲染器

创意场景在 `plugin/ui/creative-gl.js` 通过 `CreativeGL.register(def)` 登记，内置场景使用同一个入口。每个描述同时给出：

- `id`、`label`、`aliases` 与 `ownsLyrics`。别名进入离线提示词；自带歌词的场景通过能力关闭宿主的额外歌词层。
- `params`：每行 `[key, label, min, max, step, unit, default]`，默认值由这些行生成，勿再手写 `defaults`。编排地址仍使用 `sc.<key>`。完整范围须位于 `CreativeGL.parameterLimit()` 给出的正负上限内，和分享校验共用原有数值边界。
- `camera`：五个字段 `cam.yaw`、`cam.dist`、`cam.pitch`、`cam.fov`、`cam.height`，作为切换/重置机位的共同基准。字段范围由 `CreativeGL.cameraSpec()` 统一供注册校验与面板消费，越界默认值会被拒绝。
- 绘制实现：`geom`、`vert`、`frag`、`uniforms`、`setup`、`depth` 和 `blend`，可选画质几何及额外绘制钩子。沿用已有场景的 shader 接口。
- 二维绘景可声明 `toneMapped: false`，保留已绘制的显示色；默认仍走原发光场景的高光压缩。收藏缩略图沿用相同色彩模式。可选 `presentation` 提供 `family`、`description`、`tag` 和本地 SVG `art`，工坊从登记描述生成导航；`creative-anime.js` 中的四套动画绘景是例子。

描述在登记时校验、复制并冻结；无效/重复 ID、参数和别名不能进入注册表。CreativeStage 的场景列表、参数面板、默认值、预置归一化与提示词由该定义派生，不再新增一份 `SCENE_SPEC` / `SCENE_CAM` 或提示词规则。新增脚本应在宿主初始化前加载；分享 v1 继续使用完整预置，接收方必须包含对应场景实现。

沉浸声场仍在 `stage3d.js::STAGES` 增加描述，但每项直接绑定 `build` 构造函数；不再同时修改 `BUILDERS` 名单。ID、机位、粒子数量与显示说明都跟随同一描述，绘制与帧门继续由 Stage3D 管理。

独立歌词视觉通过 `Stage3D.registerLyricRenderer(def)` 登记 `id`、`label`、宿主节点 `host`、`create` 工厂和 `theme` 函数，可声明 `tuning`、`cameraRig`、`viewportResize`。工厂返回统一实例方法：`setTheme`、`setFontScale`、`setVisible`、`setPaused`、`setEco`、`update`、`frame`、`rootEl`、`destroy`；有 tuning 时还需 `setTuning`。宿主统一初始化、主题/状态分发、显隐和销毁，选择器与设置标签读取 `lyricVisuals()`。

新视觉的专属控件、DOM/CSS 和调参规则仍需实现，注册表负责共用接线。starborn 是现有模式之间的导演，不是歌词渲染器；添加 renderer 不自动改变它的选镜算法。场景不得启动另一条动画时钟，继续接受 Stage 的帧门与播放器快照。

验证：`node scripts/check-scene-registry.js`、`node scripts/check-creative.js`、`node scripts/check-creative-share-code.js`、`node scripts/check-creative-prompt.js`、stage/stanza 相关检查；`node scripts/check-creative-scenes-browser.js` 验证真实 GL，`scripts/check-workshop-stage-browser.js` 验证重建服务中的实际舞台。扩展测试应通过真实登记接口加入一个新 ID，并验证参数、归一化、预置往返和生命周期，不能只比较复制的内置名单。

## 音乐渠道

实现放在 `crates/hertz-studio/src/online/<平台>.rs`，由 `online/mod.rs` 声明模块；在 `online/provider.rs::PROVIDERS` 增加一个 `Provider`：

1. `SourceInfo` 提供稳定 ID、显示名、分类与公开能力；注册顺序就是音源列表和默认搜索顺序。
2. `CoreOps` 必须提供搜索、取流、详情与歌词函数。函数接收公共上下文并返回已有 DTO / `ApiError`，注册闭包适配平台参数。
3. 按需绑定歌单读写、艺人、专辑、账号、二维码、推荐等操作组。只公开已有实现且准备开放的能力。已实现但尚未开放的能力可以保留函数槽位，公共能力门仍会拒绝调用。
4. 平台音质默认与允许档位、Referer、凭据补全/登录判断、配置就绪判断和未验收能力标记都放在这一项。平台协议细节留在实现模块内。

`Provider.kind` 默认 `music`；公开播客注册为 `podcast`，`/v1/online/sources` 同时返回此字段。
音乐选择器、聚合搜索、每日推荐与自动换源只消费音乐 Provider。播客目录/RSS/订阅归 `podcasts` 服务，
单集仍通过原 `CoreOps`、`Online.playAll` 和 AppState 队列播放。新增媒体种类不能另建播放器或靠 ID 名称猜测业务类型。

接受用户提供音频地址的 Provider 还需登记成对的 `DownloadPolicy`：首地址验证与实际下载客户端。
播客客户端校验每次 DNS 解析及每个重定向，首地址校验同时覆盖不经过 DNS 的 IP 字面量。
渐进下载与预取共用该策略；只在 RSS 解析时检查 URL 不足以保护后续下载。
底层公网策略由 `public_net` 唯一持有，RSS/音频允许 HTTP(S)，共用封面代理维持 HTTPS-only 并逐块限制图片大小。

不再分别修改搜索、取流、歌词等公共函数的 source 分支，也不手工维护 `SOURCES`，它由注册项派生。注册校验拒绝重复 ID、没有函数支撑的公开能力和错误的音质定义。公共入口继续负责输入检查、能力门和整次取流的 20 秒期限。

前端大部分列表与按钮由服务端能力决定；官方徽标、平台专属登录流程及特有产品交互仍需对应前端实现。注册表不自动提供新的上游协议或账号授权。验收应区分离线契约与真实平台联调。

验证：`cargo test --locked -p hertz-studio --lib online::`、`node scripts/check-online.js`。参考 `provider.rs` 中虚拟 Provider 的真实注册/调用用例，并针对平台协议补解析与错误用例。

## 内嵌资源

JS/CSS 只在 `crates/hertz-studio/src/assets.rs` 的 `ui_assets!` 清单登记一次。例如：

```rust
"/skins/skin.example.css", CSS => const EXAMPLE_CSS: &str =
    include_str!("../../../plugin/ui/skins/skin.example.css");
```

这条声明同时进入 HTTP 路由、MIME、内嵌内容和缓存指纹。`index.html` 仍负责实际加载及依赖顺序；DBX 继续打包 UI 目录。HTML 鉴权页、壁纸和平台图标有不同的响应规则，保留各自原入口。

`scripts/ui-assets.js` 读取真实 Rust 清单，供资产/API 检查消费。不要在检查脚本里复制另一张资源表。验证 `node scripts/check-assets.js` 和 `cargo test --locked -p hertz-studio --bin hertz-studio`；后者对每个注册资源验证真实 HTTP 内容/MIME/缓存及指纹变化。
