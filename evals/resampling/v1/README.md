# S1 流式重采样合成测量 v1

这是无设备、无媒体文件、无网络的合成检查，**不是实际声音、完整音质或发布验收**。实现和限制见[音频重采样](../../../docs/audio-resampling.md)。报告保留 `realSoundCardVerified:false`、`releaseEligible:false`。

从仓库根目录在 Windows 运行：

```powershell
cargo test --locked -p vmusic-audio --lib --test resampling
cargo build --locked -p vmusic-audio --example resample_probe --release
node -e "require('fs').writeFileSync('local-resampling-run.json', require('child_process').execFileSync('target/release/examples/resample_probe.exe'))"
Get-FileHash target/release/examples/resample_probe.exe -Algorithm SHA256
rustc --version --verbose
```

其它 OS 可执行文件无 `.exe` 后缀，但当前没有它们的测量结果。探针运行前应先确认构建命令成功；重新测量写入本地文件，保留历史记录。报告内的 `sourceHash/backendHash/lockHash` 对应编译时包含的原始文件字节，比较时不能先更换换行。它们用于绑定代码与依赖，不能单独替代实际候选产物身份。

已保存 [Windows x64 原始结果](./windows-x64-20261018.json) 和[编译器、源码及产物身份](./windows-x64-20261018.meta.json)。2026-10-18 在 Windows、`Intel64 Family 6 Model 186 Stepping 2, GenuineIntel` 上使用 rustc 1.98.1；源码是 HEAD `401a90376c0fa8391b5d60234103eeb381ef2c2c` 加未提交改动，并非已发布提交。使用仓库 release profile（opt-level 3、thin LTO、4 codegen units），报告确认没有 debug assertions。产物是独立探针，不是播放器或 DBX 安装包。

| 本机测量 | 结果 |
| --- | --- |
| 44.1→48 kHz，双声道，每次一秒信号，3 次处理用时中位数 | 3.3707 ms，RTF 0.0033707 |
| 同一组合，构造用时中位数 / 最大处理用时 | 1.7309 ms / 3.4852 ms |
| 18 种采样率对/声道组合中，最大的处理用时中位数 | 6.1672 ms / 一秒信号 |
| 18 种组合的长度、有限输出、1 kHz 增益误差 <0.05 dB | 全部通过 |
| 96→44.1/48 kHz，27/30/40 kHz 单音，混叠投影 <-80 dB | 6 项全部通过 |

处理计时包含 Converter 的 process/finish 及输出到预分配结果缓冲的复制，构造与缓冲准备另计；不是设备回调预算或整机 CPU 百分比。每项只有三次运行，未做长时间/弱机/P95 统计；不能把一台机器的结果当成硬件门槛。

质量探针只测一秒确定性正弦的中间半秒，排除两端瞬态，以正交单音投影测增益和混叠。极低的投影值不代表宽带底噪或完整音频动态范围。线性参考连续插值仅供对照，不复刻原实现的包边界行为，也不是第二个产品后端。18 kHz 通带、极短流、碎片输入、脉冲时刻、finish/reset 与分配约束另由音频测试覆盖，不把探针中的六个单音当成所有滤波特性。

保存时核对报告里的三个源码/锁文件 hash 与磁盘原始字节一致；metadata 另保存探针源、清单、库入口、可执行文件和报告 SHA-256 及编译器完整版本。未来源码或依赖改变需重新生成报告，不能沿用此身份宣称新候选通过。
