# 壁纸原生媒体 fixture

`wallpaper-vp8.webm` 是无音轨的 64×48、12 fps、2 秒 VP8 测试图，24 帧。仅用于自动化测试，不随产品打包。动态色块由 FFmpeg 的 `testsrc2` 生成，不含外部素材。

SHA-256：`c980bbaaaf8f888d9d4aba493403ba5c7a974a35008ee45c48d218a754bb550b`。

生成命令（FFmpeg 7.1，已有工具，测试运行时不需要安装或下载）：

```sh
ffmpeg -f lavfi -i 'testsrc2=size=64x48:rate=12:duration=2' \
  -c:v libvpx -deadline best -b:v 80k -an \
  -fflags +bitexact -flags:v +bitexact wallpaper-vp8.webm
ffmpeg -v error -i wallpaper-vp8.webm -f null -
```

固定样本避免在 WorkerW 遮挡/合成节流下录制出仅有容器头、没有视频帧的 MediaRecorder 文件。原生脚本仍需验证实际首帧、seek 和持续循环；这份小视频不提供 1080p/4K 硬解、解码成本或长时间设备恢复的资格证据。
