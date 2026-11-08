# 0013：桌面多人声文档与原文往返

2026-11-07。用户已批准[A10设计](../aegis/specs/2026-11-07-desktop-lyrics-vocals-design.md)，实现与验证继续进行；本记录不表示发布验收通过。

## 决定

作者身份进入原规范行，唯一TTML解析器负责继承、背景展开与副文本归属。桌面HTTP/DBX共用投影、内容key与能力裁决，在原身份校验后要求声部schema1；普通文档沿旧形状。桌面消费真实活动区间并使用文档级几何容量；设置、窗口、播放及存储owner保持。不能正确呈现重叠的视图明确提示不支持，音乐继续。原覆盖层保存原文，JSON备份含歌词时升级至v2，恢复前统一解析，事务合并保留已有内容与删除墓碑。

原生窗口按工作区规划槽位，定位时每侧外边距不得超过对应方向剩余空间的一半，避免满高窗口、展开设置或空内容恢复窗口越界；不因此减少已规划容量。房间播放器与 Stage/OBS/主播放器均在原读取入口明确拒绝不支持的声部呈现；同资源修订为普通歌词后恢复原视图。

## 边界与 owner

| 名称（含单位） | 数值 | 定义在哪 | 改它要一起改什么 |
| --- | --- | --- | --- |
| 声部格式版本 | 1 | `crates/hertz-desktop/src/feed.rs::VOCAL_SCHEMA_VERSION` | 生产快照、HTTP/DBX参数白名单、统一校验及内嵌页面 |
| 作者声部上限（个） | 32 | `crates/vmusic-lyrics/src/structured.rs::MAX_AGENTS` | 元数据读取、规范校验与桌面校验 |
| ID与姓名上限（UTF-8字节） | 128 | `crates/vmusic-lyrics/src/structured.rs::MAX_AGENT_BYTES` | NCName、联合标签和桥字段验证 |
| 每行联合身份上限（个） | 8 | `crates/vmusic-lyrics/src/structured.rs::MAX_LINE_AGENTS` | 继承展开、声明顺序与单槽标签 |
| 源区间上界（毫秒） | 86400000 | `crates/vmusic-lyrics/src/structured.rs::MAX_TIME_MS` | 唯一解析器的源时间验证 |
| 呈现区间上界（毫秒） | 86522000 | `crates/vmusic-lyrics/src/structured.rs::MAX_PRESENTATION_TIME_MS` | 原偏移顺序、桌面投影与两入口校验 |
| 零点钳制后零长度上界（毫秒） | 2000 | `crates/hertz-desktop/src/feed.rs::CLAMPED_ZERO_MAX_MS` | 声部呈现校验，零长度永不激活 |
| 桌面文档上限（字节） | 2097152 | `crates/hertz-desktop/src/feed.rs::DOCUMENT_MAX_BYTES` | 完整投影JSON、读取与key预算 |
| 含歌词的JSON备份版本 | 2 | `crates/vmusic-store/src/backup.rs::LYRICS_BACKUP_VERSION` | v1拒绝保护、新恢复与原文往返 |
| 备份歌词上限（项） | 2048 | `crates/vmusic-store/src/backup.rs::MAX_BACKUP_LYRICS` | 整体导出与恢复前校验 |
| 备份原文合计与完整导出上限（字节） | 2097152 | `crates/vmusic-store/src/backup.rs::MAX_BACKUP_LYRICS_BYTES` | 原文预算与既有JSON恢复请求上限 |

## 禁止回退

- 不从颜色、位置、同刻起点猜身份；否则普通LRC被误判多人声，真实区间被伪造。
- 不向旧组件删除身份后下发重叠行；否则最近起点算法在短伴唱结束后丢失仍活动的主唱。
- 不为每个事件复制完整活动集或挂整首DOM；否则输入规模和重叠密度扩大内存与每帧工作。
- 不随活动行数改变多槽窗口容量，也不只按窗口中心判断工作区变化；否则切句跳窗，暂停时缩小工作区会裁掉歌词和恢复操作。
- 不把含歌词的备份伪装v1，也不覆盖已有歌词修订/墓碑；否则旧恢复静默丢词，重复恢复破坏用户编辑。
- 不以普通视图的空状态掩盖声部拒绝；否则用户无法区分没有歌词与该视图尚不支持。
