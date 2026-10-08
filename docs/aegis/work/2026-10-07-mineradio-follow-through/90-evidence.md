# 验证证据

本记录保留前次收口证据。2026-10-08 再次续接的压缩音频资格、集合失败保留和登录初始化修复，以及新的最终验证，见 [续接证据](95-resume-verification.md)。

日期：2026-10-08。工作目录保留本轮开始日 2026-10-07。基线为 `09de7b7` 加用户已有未提交改动。旧十四批检查只作历史；本记录用于当前工作区。

## 已取得的集成证据

| 命令 / 检查 | 结果 | 覆盖与限制 |
| --- | --- | --- |
| `cargo test --workspace` | 退出0；498通过、1忽略 | hertz lib347、bin8、audio53、beats8、core3、library18、lyrics11、store44、vendor SDK6；不代表实体声卡/平台账号验收 |
| `cargo clippy --workspace --all-targets -- -D warnings` | 退出0 | 修复 state.rs 一处无意义借用后通过；没有 suppress lint |
| CI 范围 `cargo fmt ... -- --check` | 退出0 | 包为 hertz-studio/vmusic-core/vmusic-audio/vmusic-store/vmusic-library/vmusic-lyrics/vmusic-beats/dbx-plugin-hertz，不修改 vendor SDK；用户 library 仅有格式整理 |
| `node scripts/check-frontend.js --extra` | 退出0；47步通过、0失败 | 含首页/分享码；活体脚本单独对隔离实例运行，不批量命中默认端口 |
| `node scripts/check-frame-gates.js` | 50/50 | 整数分频/0停机，加高刷切低刷的浮点收敛回归；62.5Hz不能错误吸附为60 |
| `node scripts/check-perf-probe.js` | 212/212 | 真frame/schedule时钟、计数成本、白名单、异常、两形态资源接线 |
| `node scripts/check-adrs.js` | 190/190 | 8篇决策日志、52条数值边界；只证明文档接线，不授予完成结论 |

日志位于 `output/mineradio-workspace-test.log`、`mineradio-clippy.log`、`mineradio-frontend-check.log`。日志中不包含用户平台凭据。首次 workspace 的争用用例超时已单独调查：旧测试将线程启动和回调等待混在250ms内；改为ready/start握手，注入6秒启动仍通过，注入真实阻塞锁仍失败，再跑全workspace通过。不能从旧日志反推发生过实时回调阻塞。

前端首次完整回归的两项失败为三个源码断言依赖单行 Rust 排版（clone/ensure_origin/route）；经逐行核对实际调用仍在后，仅让断言接受空白换行，没有删除行为保护。

## 切片证据索引

- [在线播放](online-playback-evidence.md)：集合首页/续页意图、真实计数、deadline、实际音质、同曲解码降档与接力出处。
- [节拍与长列表、队列](91-beat-ui.md)：许可生命周期的修复前失败、任务单飞、缓存边界、浏览器窗口化及固定队列。
- [全局性能探针](92-perf.md)：初始实际缺陷、资源接线、真实Chrome计数和统计白名单。
- [首页继续入口](93-home.md)：原命令与历史owner、窄容器/主题/字体、次入口失败及焦点。
- [创意分享码](94-share-code.md)：完整版本化预置、边界与安全投影、宿主兼容和浏览器异步竞态。

## 主代理补充回归

- 会员资料未知/明确零级/溢出/旧字段兼容，以及QQ本地503 purl失败测试包含在workspace内；通用CDN错误不能假装会员不足。
- `transition_then_immediate_decode_failure_keeps_successor_evidence` 覆盖同tick切换后失败清空快照：已发生的Transitioned仍先提交，下一事件消费正确曲目的实际档位。
- 每元素封面意图覆盖代理/解码乱序与失败清旧图；删除新增永久订阅路径。daily卡片元数据更新、原位重排、焦点保留：favorites185项、daily-strip浏览器30项通过。
- G4/G8真实Chrome组件验证已由主代理复跑：末项点击携带完整原集合及绝对索引、跨窗口键盘顺序、640px重排、哨兵按需续页；固定队列超时仍可见，关闭恢复焦点，零播放命令。

## 独立评审与修复闭环

1. 音频初版在回调中阻塞取锁、分配bypass原因、释放退休deck，以及cold-thread ArcSwap初始化分配。现统一try_lock，争用静音但不消耗样本/时钟/淡入进度；事件承载退休deck交actor释放。冷线程不同转场分支零分配/零释放及五类锁争用均已验证。
2. 接力初版删除重复原曲所需快照，集合/电台追加后预备旧回卷曲；已克隆来源并在追加后撤销重排后继。
3. 封面初版只在代理成功时回调，失败保留旧封面与元素引用；已换一次resolve promise，失败清当前图、没有永久订阅。
4. C1独立review发现120→60Hz时EMA停在60.000000000000014使ceil多分一档。canonical estimator只合并小于1e-9的数值尾差；独立真实frame/schedule模拟修复后60Hz、30fps divisor2、60fps divisor1，10秒300次回调，始终一个pending RAF。
5. C5独立review发现枚举允许任意数值、绑定target/source被数组隐式转串接受后再静默丢弃；已按原spec枚举与string形状验证，44项回归通过。首页次入口的异步导航异常也统一收口，不留下unhandled rejection。

## 独立实例与完整页面

- `cargo build -p hertz-studio --bin hertz-studio --target-dir target-mineradio-follow-through` 退出0；未覆盖正在运行的用户binary。最终工坊提示改动曾被served-vs-source核对检出未嵌入，重新构建后验证最终资源。
- 自建 `output/mineradio-live-48662137` 数据目录，null后端、127.0.0.1随机端口；启动日志/令牌不写入版本化证据。重启测试仅结束由本轮启动且校验路径匹配的进程。
- `PERF_PROBE_URL=<own-base> VMUSIC_DATA_DIR=<own-data> node scripts/check-perf-probe-browser.js` 退出0：完整服务4个stats源，38次真实回调=38次采样，38ms成本/1412ms窗口；163.99Hz、N6、预算27.33、实测26.9次/秒；无页面错误，撤销门后计数不增。
- `node output/check-mineradio-home-live.cjs` 及重启后的 `--recent` 均退出0：真实API扫描隔离WAV、原play恢复、查看队列不暂停，重启后无队列时读取并明确重放最近单曲。截图 `output/playwright/home-dashboard/live-service.png`。初次测试曾错误假设“清队列会卸载音频”，经原接口契约核对改为重启后的场景；没有为迁就测试改生产语义。
- `STAGE_VISUAL_URL=<own-base> VMUSIC_DATA_DIR=<own-data> node scripts/check-stage-settings-browser.js` 退出0：30种歌词/背景组合、真实DOM设置、frame gate/延迟首帧交接/播放时钟淡变/暂停清理、星诞电影层、手机设置与服务端保存重载全部通过。
- `SHARE_CODE_URL=<own-base> VMUSIC_DATA_DIR=<own-data> node scripts/check-creative-share-code-browser.js` 退出0：精确核对内嵌资源后，完整app验证J/G导入、剪贴板失败、坏码不提交、编辑/关窗/输入竞态、缺gzip能力、JSON兼容与窄屏。日志 `output/mineradio-share-live.log`。
- 最终前端聚合包含157个JS语法文件、745项资源检查，47步全部通过。Rust忽略项为需要QQ真实凭据的 `probe_daily_candidates_with_cred`，没有将它计入通过。
- 清理：自建PID35048及重启后的24480均按可执行路径复核后结束，最终确认不再运行；用户原实例未动。末尾仅纠正两处0ms歌曲衔接的旧注释，再次独立build、fmt和diff空白检查退出0。

## 不覆盖的验收

- 真实MP3/AAC编码延迟夹具、实体声卡听测、不同操作系统设备驱动；本轮PCM/模拟覆盖不能替代它们。
- 真实平台登录/VIP到期/打卡累计、真实DBX宿主运行；两形态资源和HTTP/RPC业务入口通过静态/行为验证，不把它叫宿主端到端。
- automix、离线补发回执、视频跨刷新持久化仍为原文条件/后续产品项。没有权威权益端点，不制造权益授权/TTL缓存。
- 全局探针的gate计数是调度入口调用数，个别子系统内部还会跳过渲染，不能称GPU提交次数。浏览器停止计数证明门不再执行，RAF真正停机另由主循环VM断言覆盖。

综合置信度B：已验证的代码行为有回归与浏览器证据，平台/硬件边界明确。结构检查和子代理评审均不是独立的完成授权。
