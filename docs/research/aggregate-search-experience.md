# 聚合搜索与加载体验改进

2026-09-30。参考 Folia 的搜索状态、分页与歌曲行，以及 VCPChat 的切歌请求隔离；按 Hertz 现有接口独立实现，未引入其他播放器的运行时。

## 实现

- `web/online.js` 统一管理一次搜索的各源页面，通过已有 `/v1/online/search` 并发取数，各源完成即显示。保留原服务端 `/v1/online/search/all` 接口兼容。
- 综合列表按歌曲名、歌手、专辑相关性排序；同分按音源注册顺序及原始页序稳定排列。来源筛选不会重新请求。
- 各源独立分页、错误与重试；原始响应长度推进 offset，source + id 去重，空页和纯重复页停止继续请求。不同平台、Live 等版本独立保留，不误合并。
- 新搜索、输入改变、清空及切源都会作废旧请求。HTTP transport 透传取消信号，取消不重试；超时覆盖响应体读取，临时网络错误仍重试一次。
- 会话缓存按关键词与来源存储，有效期两分钟，最多 12 项，每项最多缓存 300 首。账号刷新清空缓存并取消旧搜索；更大的结果仍可浏览，但不进入缓存。
- 搜索视图保存筛选和滚动位置；追加时复用歌曲行、保留滚动锚点，避免重建封面。骨架、部分失败、加载更多和实际已加载计数分开展示。
- 播放行显示加载、失败及重试；同一待加载曲目重复点击不重复提交。复用宿主 PlaybackIntent 和服务端播放代际，旧播放及封面/歌词异步结果不再覆盖新意图。继续使用已有渐进下载、预取及音频缓存。
- 320/390px 窄屏采用独立歌曲行布局、横向来源筛选、可换行头部及账号卡。提供键盘激活、焦点保留与减少动画适配。

## 验证

最终源文件及其内嵌构建：

| 检查 | 结果 |
| --- | --- |
| `node scripts/check-online.js` | 235 项通过，含渐进显示、排序、竞态、分页、重复页、缓存时效/容量/账号失效、播放意图 |
| `node scripts/check-online-transport.js` | 取消、响应体超时清理、网络错误重试通过 |
| `node scripts/check-assets.js` | 447 项通过 |
| `node scripts/check-css-tokens.js` | 通过 |
| `node scripts/check-library.js` | 通过 |
| `node scripts/check-favorites.js` | 144 项通过 |
| `node scripts/check-online-playlist-view.js` | 59 项通过 |
| `cargo build -p vmusicd --target-dir target-verify-search` | 通过；独立目录避免覆盖用户正在运行的实例 |
| `cargo test -p vmusicd online:: --target-dir target-verify-search` | 150 通过，1 个原有测试忽略 |
| `node scripts/check-search-browser.js` | 最终内嵌资源通过桌面、390px、320px 浏览器验证；未覆盖源文件路由 |

浏览器脚本使用隔离服务和模拟平台响应，验证慢源未返回时展示快源、骨架、相关性、分页、行内加载、重复点击、播放失败后实际重试以及清空。播放接口被拦截，不修改用户的真实队列或发出声音。使用现有 Playwright 安装时可通过 `PLAYWRIGHT_MODULE` 指定模块路径；`SEARCH_UI_URL` 指向隔离服务。截图位于忽略目录 `output/playwright/search-*.png`。

真实源探测：独立未登录配置中 CCmixter 返回 27 首，约 2.8 秒；网易云、QQ、酷狗、酷我、汽水返回上游连接错误。Python 直连网易云、QQ、酷狗同样出现 TLS `UNEXPECTED_EOF_WHILE_READING`，因此不能据此声称真实平台搜索、会员取流和音频播放全部通过。本次未降低 TLS 校验或改变账号/版权限制。

## 边界复核

平台协议、凭据和元数据归一化仍由 Rust provider 持有；前端没有新的 provider 适配层或额外流式协议。既有 API、歌曲虚拟 ID、收藏/歌单入口保持兼容。两个参考仓库只读；不涉及推荐、舞台或播放器替换。

后续检查补充：各音源统一请求每页 20 首，以满足酷狗后端上限；增加真实限页行为测试，防止将满页误判为结束。
