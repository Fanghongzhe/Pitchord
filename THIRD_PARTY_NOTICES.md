# Third-party runtime notices

Pitchord ships or prepares a private Python analysis environment inside the portable application directory.

## python-build-standalone

- Project: https://github.com/astral-sh/python-build-standalone
- License: Mozilla Public License 2.0
- Pinned build: CPython 3.12.14, release 20260901, Windows x86-64 `install_only`
- Archive SHA-256: `e90c1b6419da3bd812dd73bb3de40287a21abf153438147639ec5e20375ea93f`

The distribution contains CPython and third-party components under their own licenses. License files shipped inside the downloaded distribution remain with that runtime. CPython is distributed under the Python Software Foundation License Version 2.

The complete portable bundle contains the pinned Python packages listed in `scripts/analysis-lock-win-x64.txt` and the htdemucs model cache. Their license metadata and license files remain in the bundled wheels or installed packages.

## Main analysis components

- Demucs 4.1.0: MIT License, https://github.com/adefossez/demucs
- PyTorch 2.14.0: BSD-style license, https://pytorch.org
- TorchAudio 2.11.0: BSD-style license, https://github.com/pytorch/audio
- TorchCrepe 0.0.24: MIT License, https://github.com/maxrmorrison/torchcrepe
- librosa 1.0.0: ISC License, https://github.com/librosa/librosa
- faster-whisper 1.2.1: MIT License, https://github.com/SYSTRAN/faster-whisper
- Music Source Separation Training (MSST): MIT License, https://github.com/AliceNavigator/Music-Source-Separation-Training-GUI

Pitchord includes an inference-only copy of MSST model and utility modules. Imports used only by training and spectrogram drawing are optional in this copy; the upstream license is included at `vendor/msst/LICENSE`.

The lyric timestamp matcher was independently implemented from the alignment approach documented by ComfyUI Audio SRT Aligner (MIT): https://github.com/ahkimkoo/ComfyUI-Audio-Srt-Aligner. Pitchord uses faster-whisper timestamps, monotonic text matching, and duration-aware estimates for missing lyric lines and units. When an LRC provides approximate timestamps, Pitchord uses them as weak temporal weights to disambiguate repeated text. Very long references use unique-token anchors and sequence matching between anchors.

Pitchord uses `librosa.pyin` for the pYIN option. The optional RMVPE entry is a capability placeholder only; no RMVPE implementation or model weights are currently distributed.

This notice is a summary. The license texts distributed with each component control its use and redistribution.
