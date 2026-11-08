# 粒子层的同帧输入与生命周期

M0 沿用现有 Stage、Onset、Canvas2D 和 WebGL2。Stage 的唯一主循环把版本 1 帧记录作为 gate callback 的第二参数传给粒子层；第一参数仍是该门累积的真实毫秒。记录在初始化时分配，同一主帧的到期门借用同一记录，消费者不能修改、保存或异步使用记录和频谱。稳态接线不新建帧对象或音频数组。

帧包含采样时间、播放/减少动态/可见性、原质量档位、媒体身份和播放位置，以及位置 anchor/discontinuity 与频谱收帧 revision。频谱序号按每次收到输入增加，复用同一个数组也算新输入；实际收帧时间为 0 可有效，年龄达到 600ms 即失效。普通暂停快照和播放开关不当作 seek；显式 seek、原 700ms 校正及同曲暂停位置改变有独立失效标记。这里不新增服务端音频代际，不能识别现有输送协议未标记的迟到旧曲数据。

StageParticles 保存自己的 sceneTime。活动门以非负有限 dt 推进、上限 100ms；初始化、恢复和后端交接后的第一帧 dt=0。暂停、页面/抽屉隐藏、空间或创意遮挡、减少动态、零尺寸、关闭全部效果及 A/B 基线窗口冻结相位。恢复等待恢复水位以后收到的新频谱，首帧建立原 Onset 基线，随后才发新拍。播放位置只给歌词/cue/诊断，不进入粒子位移或亮度相位。

参数、颜色、尺寸、让位和状态改变通过 dirty 合并并调用原 Stage.kick。可见且就绪时暂停状态可提交一次静态绘制，随后粒子 gate=0；隐藏或零尺寸保留 dirty。fps 和 stats 查询不推进、reset 或唤醒。只有本层撤销绘制，不清其它宿主的频谱或停止它们的门。

涟漪保留 12 槽和 1600ms。WAAPI 创建后立即暂停，currentTime 只由 sceneTime-birth 设置；没有 WAAPI 时也按同一相位到期。暂停/隐藏保留已呈现环；seek、换曲、关闭涟漪和 destroy 取消环。实例代次与节点 token 防止旧回执回收复用后的槽。dust 关闭、ripples 开启时仍有活动时钟，环可以正常到期。

共享 audioFeatures 以 available、instanceId、收帧 revision 和真实收帧 sampledAt 标识资格。无效时 bands/rise/pulse/energy 立即为零，同一实例 beats 只在原 Onset 发布拍时增加，检测历史 reset 不倒退公共计数。StageFluid 在新实例或恢复时重建基线，只接受有效、未过期并递增的拍；Backgrounds 的共享无效 pulse 为零。其它宿主的完整时间和能源治理属于 M1。

每个 renderer 负责自己的 context、部分创建资源、TypedArray、画布、精灵和监听。Canvas 的创建/颜色/数组/尺寸事务、GL 的 shader/program/buffer/VAO/上传/监听/真实预热事务都可以撤销，dispose 幂等。context-loss 即时通知粒子 owner，即使暂停 gate=0 也会回退；旧后端事件不能影响新代。失败后先释放再挂 Canvas；双失败报告 actualBackend=none/effectiveMode=unavailable，停止本层。请求偏好和原预算保持，回退不重置 sceneTime。

原 count/DPR 表、量化面积、countScale 与 Stage 档位仍是预算依据。500ms/500ms 串行 A/B 和 12%/30% 阈值保持；任何资格、媒体、代次或成本变化取消整轮，GL 窗口必须有生产提交。HertzPerf 关闭不关闭该保护。

HertzPerf 的 particles 来源只读白名单包含实际后端、预算、CPU 提交计时和资源数字。attachCpuMs 截止 mount/首次数量上传，warmUpSubmitCpuMs 测同一真实画布的非零中性预热并清屏；生产首帧单独测提交和从有效显示请求开始的等待。中断样本标明，零尺寸/零数量不冒充预热成功。计时不执行 gl.finish/readPixels，因此不证明 GPU 已完成或用户已经看到像素。

资源读数分开报告 renderer 拥有的 CPU TypedArray 字节、GL buffer API 申请字节、累计上传和实际表面像素，以及创建/释放/存量/峰值。能力探测、部分初始化、精灵或数组替换峰值和跨后端回退都保留；销毁保留有界数字摘要并解除 renderer/DOM/动画/监听引用。模块固定的 Onset 和预分配投影数组沿用原有有界状态，不将 renderer 资源归零写成所有 JS 内存归零。它们不是物理 GPU 显存测量，释放请求不保证驱动立即回收。M0 仅提供单层基线，不建立跨宿主总准入器。

验证入口：`node scripts/check-stage-engine-m0-browser.js`（真实 Stage、受控时间合同与真实 Chrome/GL/Canvas/native-time 计时分别记录），`node scripts/check-stage-particles-browser.js`（原局部回归），`node scripts/check-frame-gates.js`、`node scripts/check-perf-probe.js`、`node scripts/check-window-rendering.js` 及流体/背景/控制检查。当前完整服务页面的浏览器旅程另外记录服务二进制和实际加载 UI 的身份。

M0 不交付平面构图与真实透视的 2D/3D 双实现场景族；M1–M4、弱硬件、其它 OS 和完整发行资格继续分别验收。
