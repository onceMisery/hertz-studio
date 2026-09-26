# 按优先级补齐播放器功能 - Evidence

No evidence has been recorded yet.

## EvidenceBundleDraft

- Artifact key: paging
- Type: tests
- Source: scripts/check-library.js
- Summary: Store10 tests、library JS回归、favorites108检查通过；独立服务205真实WAV API通过；浏览器按艺术家排序、收藏200至205继续加载确认；需求与代码审查PASS。最新submittedRevision保护有JS回归，待与第2项共同构建最终UI。
- Verifier: root

## EvidenceBundleDraft

- Artifact key: scan-ui-regression
- Type: test
- Source: scripts/check-scan-ui.js
- Summary: 实际目录控制函数：过期目录响应、启停移除、终态事件与在途请求竞态、失败明细显示均通过；108收藏断言与分页回归、345资源检查和CSS检查通过
- Verifier: root

## EvidenceBundleDraft

- Artifact key: playlist-mixed
- Type: tests
- Source: scripts/check-library-api.py --playlists
- Summary: 真实服务205曲目：混合歌单快照写入/幂等入单/混合队列占队/重排/服务重启后顺序与在线快照不丢，全部通过。store 层4项新测试（快照对齐、幂等不改写、移除重排保留快照、重开持久）通过
- Verifier: root

## EvidenceBundleDraft

- Artifact key: mixed-playlist-ui
- Type: browser
- Source: scripts/check-favorites.js + scripts/check-online.js + browser session
- Summary: 浏览器验收：歌单详情在线快照行渲染（重启后）；整单播放混合队列本地起播成功；收藏视图在线行平台徽标+快照；「播放收藏」206首混合队列（本地+在线虚拟身份）；在线搜索行「加入歌单」→菜单→虚拟身份 online:netease:21231345 入单并快照渲染。契约脚本 favorites 113/113、online 197/197 通过
- Verifier: root

## EvidenceBundleDraft

- Artifact key: lyrics-priority-offset
- Type: tests + browser
- Source: scripts/check-library-api.py --lyrics + browser session
- Summary: sidecar 文件偏移 200ms 应用正确；每曲用户偏移 -500/±0.5s×2 叠加落库（1200→700ms；UI +1.0s → 服务端 1000ms → 行 2200ms）；手动导入优先（source=imported，导入不改偏移）；DELETE 回退 sidecar。内嵌提取由 FLAC VORBIS_COMMENT fixture 单测覆盖（LYRICS 标签→meta.lyrics）。np 弹窗来源徽标（同名 .lrc/已导入）、清除导入按钮显隐随服务端状态刷新
- Verifier: root

## EvidenceBundleDraft

- Artifact key: library-batch-cache
- Type: tests + browser
- Source: scripts/check-library-api.py --library/--backup/--cache + browser session
- Summary: 库管理（facets 205 歌手、artist 筛选 total=1、编辑覆盖层重扫保留、重置回文件标签、封面替换 has_cover=1 重扫不丢、失效整理 missing→batch-delete）；备份导出含 205+ 收藏与凭据隔离、幂等恢复、未知版本 400、M3U 往返含 skipped 计数；缓存统计 470B/4 文件/按源分组、keep 前缀豁免经 clear 验证、按源清理 60B（含 .part）
- Verifier: root
