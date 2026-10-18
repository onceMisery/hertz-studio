# 本地音频格式与错误说明

扫描扩展名、成功读取标签、成功解码、实际声卡出声是四件不同的事。当前扫描检查 13 种扩展名；只有元数据读取与数据库写入成功才计入新增/更新，失败显示在音乐目录的扫描明细中。已有记录在重扫读取失败时保留，不把暂时无法读取当作文件已删除。

| 文件扩展名 | 当前编译的容器/解码路径 | 边界 |
| --- | --- | --- |
| mp3 | MPEG audio / MP3 | 损坏文件、截断下载仍可能失败 |
| flac | FLAC | 成功读标签不证明后续全部音频帧完好 |
| wav | RIFF/WAVE、PCM、ADPCM | WAV 是容器，并非其中任意编码都支持 |
| aiff、aif | AIFF、PCM | 仍依赖实际编码与文件完整性 |
| m4a、aac、alac | ISO MP4、AAC、ALAC | 扩展名只是探测提示，不保证任意同名文件可用 |
| ogg、oga | Ogg、Vorbis | Ogg 中的 Opus 当前不能解码 |
| opus、ape、wma | 当前没有对应解码器 | 扫描会检查，元数据读取可能失败；已导入记录也不保证播放 |

该表来自根 Cargo.toml 的 Symphonia 0.5 features 与 `vmusic-library::AUDIO_EXTENSIONS`，Standard / Full、独立 / DBX 共用这些定义。它描述编译能力，不能当作各 OS、声卡或原生宿主已通过验收。null 后端用于受控检查，不验证解码能力或真实声音。

音乐目录入口会提示格式边界。播放错误按服务端稳定 code 显示，不从扩展名或错误句子猜测：

| code | 含义与下一步 |
| --- | --- |
| unsupported_format | 未识别容器或编码，或解码器明确不支持。也可能是文件头损坏；检查原文件，或用其它工具另存为 FLAC/WAV 再扫描。改扩展名不是转换 |
| decode_failed | 文件读取、坏数据、截断或其它解码失败；检查文件可访问性、下载是否完整，并尝试其它播放器。不能据此断言整个格式不支持 |

探测器自身有时把无法识别的损坏输入返回为 Unsupported，因此 unsupported_format 也不证明某一格式永远不能播放。已识别的坏 WAV 与读取截断则保留 decode_failed。HTTP/RPC 使用原有 CoreError 映射；前端保留 request_id 供诊断，未知 code 保留服务端说明。失败 POST 不自动重试，载入失败后清理加载按钮，后续可重新选择播放。

## 当前验证

```powershell
cargo test -p vmusic-audio --lib -- --test-threads=1
cargo clippy -p vmusic-audio -p hertz-studio --all-targets -- -D warnings
node scripts/check-frontend.js
# 先构建隔离服务并配置 HERTZ_BIN / PLAYWRIGHT_MODULE：
node scripts/check-audio-errors-browser.js
```

真实 Symphonia 内存文件检查覆盖可解码 WAV、有效 WAV 使用 opus 扩展名提示、坏 PCM 头、不支持的 WAV 编码和截断文件。音频模块回归不打开声卡；不能代替真实声卡听测。浏览器在隔离 null 服务上使用受控错误响应，验证实际 HTTP 错误提示、request_id、无 POST 重试、加载状态清理、后续成功载入和 390px 长提示边界；该部分不伪装成真实解码结果。截图保存到 `output/playwright/audio-errors/`。

完整能力、宿主与发布验收范围仍见[路线进度](./roadmap-progress.md)；本增量不新增解码器。
