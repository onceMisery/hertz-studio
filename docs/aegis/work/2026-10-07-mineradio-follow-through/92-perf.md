# C1 全局性能探针与真实帧门采样

日期：2026-10-08。授权：主代理分派的 C1 补齐切片；沿用当前 follow-through 计划。起点已有未跟踪 `plugin/ui/perf-probe.js` 与 `scripts/check-perf-probe.js`，仅定点修改，未覆盖任何用户舞台实现。

## 复现与根因

- 原检查为 171 项、6 失败。五项是断言预期错误：60ms 与100ms窗口应累计160；10ms与45ms窗口应累计55；512之后NaN按一次计入应513；排序应divisor在dpr之前；Stage只有tier方法时应保留这个已存在的字段。
- 真实探针缺陷：`Number(null)`/空字符串/布尔值伪造成合法耗时或时间起点；嵌套gates/probe直接返回活引用，快照可改来源；异常message不受性能白名单约束。
- 全仓没有实际探针调用点，且独立资源四处全部缺失。原检查允许零接线，因此可以全绿但永不采样。
- 补充回归后192项17失败，覆盖上述真实缺陷、实际gate调用记账、停机/异常、资源链。修正后196项通过。
- 真实Chrome首次采样揭出更深的旧时钟问题：30fps门在约1.4秒实际执行119次（82.4 runs/s）。`schedule()`每次续帧均清空`lastFrameAt`，主循环一直喂16.7ms；同时`tickLyrics()`会把共享`lastDt`改成歌词门累计间隔，估计器又在回调之后读它。此前`check-frame-gates.js`直接喂估计器，未覆盖真实frame→schedule链。
- 新增执行原始frame/schedule/setHidden函数的回归，211项中上述两项先失败，再于Stage唯一owner修复。

## 修复边界

- 探针只接受有限、非负的number耗时/起点；0仍合法。
- gates/probe按明确字段复制；异常使用`stats_unavailable`，不输出原异常文本。音频、相机、曲目、歌词内容不进入source快照。快照按需读取，不记自身成本，不使用网络、存储、DOM、轮询或独立rAF。
- `Stage.runGates()`在既有回调边界记录`gate.<name>`的count和cost，使用两次时钟读取；禁用时不计时，未加载时照常执行，异常继续传播且已花费成本入账。每指标样本最多90条，快照只复制尾部18条，榜最多24条。当前产品gate名均为代码常量，不来自曲目。
- Stage续帧保留时钟，真正停机/隐藏恢复才重置；frameDt局部变量隔离歌词门对lastDt的改写。保留既有ceil分频与0停机语义。
- `gateRates().achieved`仍是实测刷新率下的预算换算，不宣称是实测执行次数。实际runs/s取两次快照count差除以sinceResetMs差（同一reset周期）。
- 注册index.html script、main.rs include_str常量、asset route及指纹表；生成README API块。插件backend仅提供stdio RPC，不嵌入静态资源；真实分发owner是`plugin/dbx-plugin.toml`的`include=["assets","ui"]`及manifest的`ui/index.html`入口，本切片验证该链，没有引入第二套资源owner。
- `check-perf-probe.js`纳入默认check-frontend STEPS；新增`check-perf-probe-browser.js`用于实际Chrome与可选重建服务验证。

## 验证证据

- `node scripts/check-frontend.js --only check-perf-probe`：212项通过，151个JS文件语法通过。
- `node scripts/check-assets.js`：717/717；`node scripts/check-plugin-assets.js`：52/52。
- `node scripts/check-frame-gates.js`：37/37；`node scripts/check-stage-idle.js`：29/29。
- `node scripts/api-routes.js`生成后`--check`通过：119个方法+路径，与当前源码一致。
- `cargo test -p hertz-studio --bin hertz-studio tests:: -- --nocapture`：8/8，包括实际嵌入HTML令牌/资源指纹测试。
- Chrome shipped-ui fixture：使用原始index与全部真实模块，只移除app启动层并显式初始化Stage/CreativeStage；不模拟探针、调度器或stats方法。最后样本为38次实际调用=38次探针记录，38.5ms成本，1414.3ms窗口，实测26.9 runs/s；displayHz163.94，N=6，预算换算27.32。四个source齐全、无sourceErrors，Stage3D仅七个性能字段，注销所有gate后账本不再增长，无浏览器运行时错误。
- 浏览器脚本真实服务模式：设置`PERF_PROBE_URL`和`VMUSIC_DATA_DIR`（或`VMUSIC_UI_TOKEN`），会比对served perf-probe.js/stage.js与当前磁盘、等待完整app“服务已连接”并执行同样断言。主代理负责重建隔离null实例后的完整服务验证；本记录不把静态fixture冒充服务端端到端。
- 本次`cargo build`因用户在运行的target/debug/hertz-studio.exe文件锁退出1；没有停止用户进程，已交接主代理用独立输出构建。`cargo fmt --all -- --check`显示已有多个文件（含vendor SDK）格式差异，未批量改写；聚合格式治理由主代理收口。`git diff --check`未发现本切片空白错误。

## 架构与退役

架构对齐：符合ADR-0006的唯一Stage帧门、真实时钟和整数分频；Rust业务状态、播放意图、HTTP/RPC契约均不变。探针是只读性能账本，不成为播放状态owner。ADR补记建议：在0006保留“真实frame/schedule链必须覆盖，不能只单测gateDivisor”和“gateRates预算换算与perf实测count分开”的规则，由主代理统一维护。

修复轨：数据清洗/快照隔离落在perf原owner，采样/时钟落在Stage原owner，分发沿既有两种宿主链。退役轨：移除允许零注册的验收漏洞、任意异常文本、嵌套活引用、续帧清时钟和回调后读取共享lastDt的旧路径；不增加备用计时器、复制状态或第二套资源嵌入。

剩余风险：Chrome数值是本机约165Hz环境下的诊断样本，不是所有设备性能保证；完整隔离服务与真实DBX宿主验收需由最终集成记录明确。当前切片置信度B，直接行为/浏览器证据完备，宿主集成边界如上。
