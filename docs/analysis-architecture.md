# 分析模块结构

Pitchord 默认把分析能力放在程序根目录的 `environment` 中，也允许用户在首次向导中选择其他磁盘。界面把它作为一个独立环境展示，不要求用户理解其中 Python、命令行工具和模型缓存的区别；高级用户也可以指定现有 Python 3.10–3.12 环境。

运行时以 `torch.cuda.is_available()` 判断真实可用性：CUDA 版 PyTorch 与兼容 NVIDIA 驱动同时存在时，Demucs、MSST 与 TorchCrepe 自动使用第一张 CUDA GPU；不可用时使用 CPU。pYIN 使用 CPU。faster-whisper 由 CTranslate2 单独检测 CUDA，GPU 初始化失败时回退 CPU。GitHub Release 只包含应用和 FFmpeg；独立 Python、CPU 或 CUDA 12.1 PyTorch 及模型在首次配置和首次使用时下载到用户选择的环境目录。

## 1. 媒体处理

- 使用随桌面应用分发的 FFmpeg 和 FFprobe 读取音频或视频。
- 原媒体复制到工程的 `media`；波形、分离结果和音高结果保存到工程，避免后续步骤依赖原文件的临时位置。

## 2. 人声分离

当前推理提供者是 Demucs，模型目录支持：

- `htdemucs`：默认平衡方案，首次使用时按需下载。
- `htdemucs_ft`：微调高质量方案，速度较慢，可按需准备。
- `mdx_extra_q`：量化轻量方案，可按需准备。

参考 MSST GUI 的模型目录设计，后续可以增加 MDX23C、BS RoFormer、Mel Band RoFormer 等提供者。每个提供者需要单独声明依赖、配置、权重来源、许可和资源需求，不能只把模型名称加入选择框。

## 3. 音高识别

- pYIN：通过 `librosa.pyin` 运行，包含概率候选、Viterbi 连续性和有声判断，默认用于干净纯人声。
- TorchCrepe：神经网络歌声音高识别，通过 `torchcrepe` 运行，适合作为复杂唱法的对照结果。
- 浏览器预览：使用轻量自相关基线，不作为桌面版最终分析结果。
- RMVPE：已加入能力目录，但当前不可选。启用前需要确定可再分发的模型权重、推理实现许可、校验值和 CPU 性能。

PitchBall 提供了 pYIN、YIN 与 RMVPE 的工程经验，但其代码采用 GPL-3.0，Pitchord 不复制其实现。PitchBall 源码仓库也不包含 RMVPE 权重，因此不能直接把它作为完整模型来源。

## 4. 歌词时间对齐

当前已具备句级和字级人工校准、辅助线吸附、音高与字时间范围匹配，以及可撤回调整。PitchBall 解决的是音高检测，不提供歌词强制对齐，所以它不能直接产生歌词时间戳。

后续自动对齐需要独立的语音或歌声识别模型，输出音素或字级边界，再结合纯人声音高、静音区和已有 LRC 生成建议。自动结果必须保留置信度，并允许用户在现有时间轴中覆盖。
