# 检查点

- Active slice：验证结束与交付记录。
- Evidence：经典皮肤设置视图 clientHeight=542、scrollHeight=3326、overflowY=visible；父 column overflowY=hidden；滚轮 900 后 scrollTop=0。
- Findings：设置滚动仅在流年单独补丁中实现；工作台窄屏仍保留第三栏；封面调色异步回调不验证当前曲目；MediaSession 缺少 stop/seekto 且错误声明 artwork 格式；弹窗进度没有拖动保护，主进度没有取消恢复，音量不读取播放快照，Shift+方向键使用错误 URL。
- Workers：Chandrasekhar 负责 3D 输入/性能文件；Sagan 负责 Rust 音频/播放路由。主代理负责皮肤、Stage、app 和浏览器。
- Runtime：独立 target-verify-skin-playback 构建，隔离服务端口 18774，null backend，数据与日志在 output/skin-playback；不操作用户实例。
- Evidence：真实内嵌资源 Chrome 浏览器 67 项通过；四皮肤 × 四尺寸、原生滚动条拖动、曲库/队列/收藏/歌单滚动、播放/暂停/停止/seek/音量/前后曲、MediaSession 回调、离页续播与封面开关刷新恢复。
- Evidence：Rust workspace 最终 302 passed、1 ignored；3D 浏览器 16 项、3D 输入契约 66 项、播放竞态 9 项通过。前端脚本仅每日推荐原签名两项断言失败，来自并发 FM 可见性变更，未修改；fmt check 保留并发/既有文件格式差异。
- Stop failure：同步 stop/play 传播复位失败，延迟失败报告普通 Error 并锁住重播，不自动下一曲。未领取 seek 超时撤销；已领取后阻塞源 I/O 取消仍需后续协议设计。
- Status：主要功能回归完成；不宣称所有设备、锁屏、异常媒体源均已解决。详见 90-evidence.md。
- Cleanup：最后一轮内嵌资源构建及 67/16 项浏览器验证通过后，停止本轮端口 18774 隔离服务与 skin-playback 浏览器；测试产物保留在 output，不停止其他服务。
- DriftCheckDraft：在用户原范围内；不覆盖原聚合搜索改动；没有新播放器或新时钟。
