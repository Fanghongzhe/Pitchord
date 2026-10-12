# Third-party runtime notices

Pitchord ships or prepares a private Python analysis environment inside the portable application directory.

## python-build-standalone

- Project: https://github.com/astral-sh/python-build-standalone
- License: Mozilla Public License 2.0
- Pinned build: CPython 3.12.14, release 20260901, Windows x86-64 `install_only`
- Archive SHA-256: `e90c1b6419da3bd812dd73bb3de40287a21abf153438147639ec5e20375ea93f`

The distribution contains CPython and third-party components under their own licenses. License files shipped inside the downloaded distribution remain with that runtime. CPython is distributed under the Python Software Foundation License Version 2.

The optional offline analysis bundle contains the core pinned Python packages and an htdemucs model cache. `scripts/analysis-lock-win-x64.txt` also constrains optional online-installed packages such as RMVPE and FCPE; those packages and their weights are not included in the standard portable download.

## uv bootstrap installer

- Project: https://github.com/astral-sh/uv
- Version: 0.12.23, Windows x86-64 Python wheel
- License: MIT OR Apache-2.0
- Wheel SHA-256: `fb8a4117a5224d73abe2204a1e744ae34b544f1b9a0b761576851deaa7215c12`

The uv wheel is included in the portable application so the first installation step does not need to download it. Its license texts and software bill of materials remain inside the wheel at `vendor/uv/uv-0.12.23-py3-none-win_amd64.whl`.

## Main analysis components

- Demucs 4.1.0: MIT License, https://github.com/adefossez/demucs
- PyTorch 2.5.1: BSD-style license, https://pytorch.org
- TorchAudio 2.5.1: BSD-style license, https://github.com/pytorch/audio
- TorchCrepe 0.0.24: MIT License, https://github.com/maxrmorrison/torchcrepe
- rmvpe-onnx 0.2.3: MIT License, https://github.com/NewComer00/rmvpe-onnx
- TorchFCPE 0.0.4: MIT License, https://github.com/CNChTu/FCPE
- librosa 1.0.0: ISC License, https://github.com/librosa/librosa
- faster-whisper 1.2.1: MIT License, https://github.com/SYSTRAN/faster-whisper
- Music Source Separation Training (MSST): MIT License, https://github.com/AliceNavigator/Music-Source-Separation-Training-GUI

Pitchord includes an inference-only copy of MSST model and utility modules. Imports used only by training and spectrogram drawing are optional in this copy; the upstream license is included at `vendor/msst/LICENSE`.

## Optional lead/backing vocal model

Pitchord can download the BS-RoFormer Karaoke checkpoint and matching YAML from [becruily/bs-roformer-karaoke](https://huggingface.co/becruily/bs-roformer-karaoke) on demand. The model files are not bundled with Pitchord. Downloads are pinned to revision `f7849ae934209184dc288d1018cd8a76a7fc8b3c` and verified by SHA-256 before use. The checkpoint repository does not currently provide a model card or explicit license metadata; verify your rights before redistributing the weights. This optional model is used after the first vocal/instrumental split; its residual output is stored separately as a backing-vocal review track, not silently mixed into the accompaniment.

The lyric timestamp matcher was independently implemented from the alignment approach documented by ComfyUI Audio SRT Aligner (MIT): https://github.com/ahkimkoo/ComfyUI-Audio-Srt-Aligner. Pitchord uses faster-whisper timestamps, monotonic text matching, and duration-aware estimates for missing lyric lines and units. When an LRC provides approximate timestamps, Pitchord uses them as weak temporal weights to disambiguate repeated text. Very long references use unique-token anchors and sequence matching between anchors.

Pitchord uses `librosa.pyin` for the pYIN option. RMVPE and FCPE are optional packages installed only when selected. RMVPE's ONNX checkpoint is downloaded from [lj1995/VoiceConversionWebUI](https://huggingface.co/lj1995/VoiceConversionWebUI) (MIT), pinned to revision `e6d0c1a17da07c33557852f9dfa2bd44cc75737d` and checked against SHA-256 `5370e71ac80af8b4b7c793d27efd51fd8bf962de3a7ede0766dac0befa3660fd`. The checkpoint is not included in the portable download. FCPE's inference weights are included in the selected TorchFCPE wheel.

This notice is a summary. The license texts distributed with each component control its use and redistribution.
