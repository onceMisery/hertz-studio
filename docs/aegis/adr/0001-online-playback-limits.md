# ADR-0001 · 在线播放的时间与档位边界

状态：生效（首次记录 2026-10-07）

## 决定

一次在线播放只允许**一个总时限**，套在整段取流外面（平台调用 + 候选降级 + 重定向），
而不是每个 HTTP 请求各设一个 timeout。理由是失败要有确定的形状：用户按下载之后
最坏等 20 秒就该看到「这首放不了」或换源结果，而不是三段超时叠成 60 秒的静默。

2026-10-08 修正：同曲取流降档重试也共用这一个截止时间。只对明确的档位拒绝和解码失败收紧；限流及一般 `upstream_rejected` 不算档位证据。提交时记录实际档位及 actor/播放代际，失败最多消费一次该证据。

音质档位固定四档（标准 / 高品 320k / 无损 / Hi-Res），档位只由「用户逐源偏好」与
「这一首自己的运行时上限」共同决定：运行时上限**只降不升**，且只由「这一档给不出来」
类失败产生。网络抖动与账号未登录不算证据（见 §禁止回退）。

## 边界与 owner

| 数值 | 现在是多少 | 定义在哪 | 改它要一起改什么 |
| --- | --- | --- | --- |
| 一次取流的总时限（秒） | 20 | `crates/hertz-studio/src/online/mod.rs::STREAM_DEADLINE` | 前端错误条文案、`--live` 用例里等播放失败的时长 |
| 每轨运行时音质上限的条数 | 4096 | `crates/hertz-studio/src/state.rs::QUALITY_CEILING_CAP` | 只影响内存上限；被淘汰等于忘掉证据、会重新试一次高档 |
| 单首音频的下载体积上限 | 536870912 | `crates/hertz-studio/src/online/progressive.rs::MAX_AUDIO_BYTES` | 半首个数、`.part` 命名与缓存 LRU 的字节口径 |
| 上游响应体的读取上限 | 2097152 | `crates/hertz-studio/src/online/http.rs::MAX_TEXT_BYTES` | 搜索/歌词这类大响应的截断行为；别拿它当缓存上限 |
| 补拉详情的批量条数 | 50 | `crates/hertz-studio/src/complete.rs::MAX_BATCH` | 一次请求的上游调用数与前端等待时间 |
| 公开播客 RSS 读取上限 | 16777216 | `crates/hertz-studio/src/podcasts.rs::MAX_FEED_BYTES` | 三个真实中文 RSS 均超过通用 2 MiB；只放宽专用 RSS 通道 |
| 单 RSS 收录单集上限 | 2000 | `crates/hertz-studio/src/podcasts.rs::MAX_EPISODES` | 解析/持久化/分页共用，`FeedPage.episode_limit` 下发界面容量提示 |
| XML 节点及原始标记上限 | 200000 | `crates/hertz-studio/src/podcasts.rs::MAX_XML_NODES` | `podcasts/parse.rs::preflight_xml` 在分配前检查；CDATA/属性边界回归 |
| 播放已保存单集时的 RSS 刷新预算（秒） | 3 | `crates/hertz-studio/src/podcasts.rs::STREAM_REFRESH_BUDGET` | 这是共同 20 秒取流期限内的可选刷新；到限仍使用已保存直链 |

播客的专用 XML 预算还限制每标签 128 个属性、深度 64、每作用域 64 个命名空间、全篇 4096 次声明，
在 roxmltree 分配前检查；描述最多保留 4000 字符，扫描本身保持线性。目录查询缓存最多 64 项，TTL 15 分钟。
长节目音频仍使用同一个 512 MiB 下载器和实际字节档位判断；RSS 的 enclosure length 不能作为音质证据。

## 禁止回退

- 不许把总时限拆回「每个候选一段 timeout」：阶梯降级时那等于把预算乘以候选数。
- 不许用 `auth_required` 收紧音质上限。那是**账号**级证据，owner 是登录流程与
  `Online.accountVerdict` 的会话三态；记到每首歌头上会让整批 VIP 曲在一次未登录
  尝试后被永久压低。参考实现同规：`login_required` 不进降档重试。
- 不许用 `upstream_timeout`/网络类失败降档：换档救不了网络，只会把一次抖动变成
  整个进程的永久低音质。
- 不许让「重试同一首」再撞刚才那一档。每轨上限的存在就是为了这条；改回去等于每次
  播放都重等一轮必然失败的取流。
- 档位标注必须跟着**真正交付字节的那一档**走（缓存命中用文件名里那档），拿请求档
  去标就会把 320k 报成无损。
