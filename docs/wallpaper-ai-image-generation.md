# 壁纸图像生成

图像能力独立于 `[ai]` 文本 provider。默认关闭；已有 OpenAI 文本密钥不会启用图像。正式 OpenAI Images 型号、规格、全维费率与响应合同尚未完成资格验证，因此当前生产图像配置显示不可用。

服务端离线验收可在隔离 DataDir 的 `config.toml` 中显式配置：

```toml
[ai.image]
provider = "fake"
model = "fixture-image-v1"
```

重启后，`/v1/ai/wallpaper/capabilities` 提供 `image` 类别。fixture 只返回可识别的诊断网格，不调用模型、不收费；规格为 1024×1024、1536×1024、1024×1536，`qualityId` 为 `fixture`。它仍要求原生成同意、报价与一次确认，使用原任务、单执行槽、月预算及 artifact 记录。

报价采用 `metered-v2`，显式给出 inputTokens、outputTokens、imageOutput 三维与单张尺寸/质量 SKU。fixture 的费率和实际费用为零；不能拿此结果证明真实模型免费或生产账单已验收。图像排队 60 秒，执行 180 秒；取消后的执行槽要等真实文件任务退出才释放。

base64 字段流式解码到文件，编码输入最多 48 MiB、解码文件最多 32 MiB。单帧 PNG/JPEG/WebP 经嗅探、像素限制、共享颜色/方向准备器生成标准 PNG；实际交付文件决定长度和 SHA256。最长边 4096、像素 8 Mi 是准入上界，独立 128 MiB 工作区还可能拒绝当前 decoder 无法处理的较大图片。

原始图片、base64 暂存和标准文件位于原 artifactId 目录，受同一写入 pin 保护。重启恢复与到期清理由原 artifact 记录回收固定文件。图片无效或输出提交失败仍保留独立用量事实。

当前文档描述服务端离线切片；原生图片候选的接收、预览、明确保存及 UI 仍在后续接线中。正式模型、付费调用和设备质量验收另需真实资格证据。
