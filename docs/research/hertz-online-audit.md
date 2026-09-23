# Hertz Studio 在线音源模块审计笔记

> 增量记录。路径均相对仓库根 D:\code\github\hertz-studio。

## 1. crates/vmusicd/src/online/mod.rs

- `client()` mod.rs:88-95：每次调用新建 `reqwest::Client`（无复用/无连接池共享）。`connect_timeout=8s`、`read_timeout=12s`（mod.rs:78-79），注释解释了为何不用总 timeout。
- 下载常量：`MAX_AUDIO_BYTES=64MiB`（:82）、`DOWNLOAD_TIMEOUT=120s`（:86）。
- `referer(source)` mod.rs:372-386：按音源返回 Referer（netease/qq/kugou/ccmixter/qishui），用于下载防 403。
- `Ctx { db: SqlitePool }` mod.rs:389-391：音源只依赖设置表连接。
- `search_all` mod.rs:523-548：通过 `aggregate::collect`，单源 6s 预算。
- `StreamInfo` mod.rs:553-565：`url, source, id, bitrate, expires_in_secs, fallback_urls`。**`fallback_urls` 注释称"落盘/播放 url 失败时调用方按序降级重试"** —— 需要在 routes/state 里验证调用方是否真的用了它。
- `stream()` mod.rs:572-591：`quality.unwrap_or(320_000)`，按 source 分派。**没有跨音源回退**，仅单源内部。
- `virtual_id` = `online:{source}:{id}`（:859），`split_virtual_id`（:867）。
- `cache_name` mod.rs:881-899：**永远后缀 `.mp3`**，与真实容器（QQ m4a/flac、酷狗 flac、网易 flac/m4a）无关；解码器按嗅探还是按扩展名需在 vmusic-audio 确认。
- **`fetch_to_cache` mod.rs:914-989：整首下载再播放（非流式）**：
  ```rust
  let bytes = resp.bytes().await ...;   // 全量进内存
  if bytes.len() <= 1024 { Err("内容过小") }
  tokio::fs::write(&tmp, &bytes).await; rename(tmp, final)
  ```
  - 缓存命中判定 `meta.len() > 1024`（:926）。
  - **没有缓存目录淘汰/上限**（无 LRU、无总大小限制）——需在 state/config 确认是否别处清理。
  - 缓存命中不区分音质：低音质先落盘后，之后再选高音质也永远命中旧文件（cache_name 不含 quality）。
  - 非 2xx 直接报错 `试听地址返回 HTTP {status}`（:938-943），**此处不使用 fallback_urls**（函数只收一个 url）。
  - Content-Length 检查仅对诚实服务器有效（作者自述）。
  - 临时文件带 uuid 后缀，rename 失败时若终文件存在则复用（Windows 并发防护，:963-985）。

## 2. online/http.rs

- `send_error` :79 → `is_timeout` 映射为 `upstream_timeout`；`read_error` :185 同理。
- `get_json` :103 先取 status+bytes 再解析，403/HTML 错误页会带片段。
- `get_bytes` :245-272：上限 `MAX_TEXT_BYTES` 2MiB，仅用于 API 响应，不是音频。
- Cookie 合并 `merge_cookie` :349，测试在 :363-。

## 3. online/aggregate.rs

- `collect` :16：每源 `tokio::spawn` + `tokio::time::timeout(per_source_timeout)`，panic 转 failed（测试 :134）。设计良好。

## 4. 各音源取流（stream）实现

### netease.rs `stream` :209-258
- `GET music.163.com/api/song/enhance/player/url?ids=[id]&br={quality}`，一次请求。**未探活、无 fallback_urls（`Vec::new()` :257）**。
- `expires_in_secs` 来自 `expi`（:256）——唯一提供过期时长的音源，但调用方是否使用待查。
- 错误全部 `ApiError::internal`（:219, :224, :228），登录/版权语义靠文案区分，前端无法按 code 做「去登录」跳转（对比 QQ 用 `auth_required`/`vip_required`）。
- 用户选的 quality 直接透传 `br`，无本地档位阶梯；网易返回实际 `br`。

### qq.rs `stream` :499-578
- `QUALITIES` 五档 RS01/F000/M800/M500/C400（:345-351）；`candidate_filenames(quality, media_ids)` 从首个 ≤ 请求码率的档位起切片，音质单调下降（:362）。
- 一次 `CgiGetVkey` 带全部 filename，songmid/songtype 数组等长（:529-544，回归测试 :2099）。
- `probe_audio_url` **对每个候选 URL 并发 HEAD 探活，3s 超时**（:408-419, :471-476）。首个成功者为 url，其余成功且 bps 不高于它的为 `fallback_urls`（:482-491）。
- 成本：一次点播 = vkey POST + N 个 HEAD（N = 档位数 × media_id 数 × sip 数，320k 请求两 mid 可达 6~12 个并发 HEAD）。用户感知延迟 ≈ vkey RTT + max(HEAD RTT)。
- 未取到时按登录态分 `vip_required` / `auth_required`（:562-568）。

### kugou.rs `stream` :455-
- 三通道顺序：① 移动匿名 playInfo（128k）→ ② Web H5 + retry 域 → ③ 登录网关 `/v5/url`（quality_param: ≥700k "flac"，≥320k "320"，否则 "128"，:376-381）。
- **顺序即"先低后高"**：匿名 128k 通道成功就立即 `return Ok(stream_info(url, hash))`（:502），已登录用户即使请求 320k/flac 也会拿到 128k。`stream_info` 固定 `bitrate: None, fallback_urls: Vec::new()`（:436-438）。
- 同一 `client()` 复用于四跳（:477）。

### qishui.rs `stream` :411-455
- 必须登录（:420）。`_quality` **忽略**用户选择，`select_playable` 按 rank 取最高非加密档（:427, :559）；fallback 取 ≤3 个非加密其他档（:441-446）。
- 加密档明确报 `vip_required`（:433）。

### ccmixter.rs `stream` :167-177
- 直接拼 URL，无请求；quality 忽略。

### 小结（问题 2 音质）
- 用户 quality 参数只对 netease（透传 br）和 qq（阶梯切片）有效；kugou 通道顺序导致实际偏低；qishui/ccmixter 忽略。
- 各源 `bitrate` 语义不一致（kugou None，qq 为标称档位，netease 实际值）。

## 5. crates/vmusicd/src/state.rs（播放队列/在线接力核心）

- `AppState` :59-84：`queue: Mutex<Vec<String>>`, `cursor: Mutex<Option<usize>>`（tokio Mutex，**两把独立锁**），`play_generation: AtomicUsize`, `play_commit: Mutex<()>`。**队列/光标仅在内存，无持久化字段**。
- `online_cache_dir()` = `{data_dir}/cache/online`（:93-95）。
- `play_index_for` :140-280 —— 在线曲播放路径：
  1. 持 commit 锁验代际、读 track_id、gen+1、乐观写 cursor（:148-171）。
  2. 缓存判定 `cached.exists() && std::fs::metadata(...)>1024`（:182-185）——**同步 `std::fs` 调用在 async 任务内**（本地盘一般可接受，但网络盘/杀软会卡 worker）。
  3. 未缓存：`crate::online::stream(&ctx, &source, &id, None, Some(320_000))`（:207）——**硬编码 320k，`track_ref=None`**，用户音质设置未参与；随后 `fetch_to_cache(dir, source, id, &info.url)`（:216-222）**只用 `info.url`，`fallback_urls`/`expires_in_secs` 完全未使用**。下载失败直接 `online_play_failed` → WS Error + 恢复 cursor（:294-314），**不会自动跳到下一首、不重试、不降级、不换源**。自动接力（Ended）时失败只 `tracing::warn!`（:403）→ 播放静默停止。
  4. 下载在锁外；提交尾部持 commit 锁 + `attempt_alive` 三次复核（:250-279）。代际机制处理连点 next 的竞态较严谨。
  5. 注意：连点 next 时旧代际的 `fetch_to_cache` **仍继续下载到完成**（无 abort/CancellationToken），只是结果被丢弃 → 带宽/内存浪费（整首 bytes 在内存）。
- `step()` :321-351：`RepeatOne if auto` 重复；Shuffle 随机（xorshift 用时钟种子 :355，非加密随机无所谓）；无「顺序播放到末尾停止」模式，末尾回绕到 0。
- `spawn_event_pump` :377-415：broadcast 容量 64，`Lagged` continue（正确），Ended 分支 spawn 到独立任务（正确）。
- **本地 `std::fs::metadata` / `cached.exists()` 是唯一的阻塞点；未见 `spawn_blocking`。**
