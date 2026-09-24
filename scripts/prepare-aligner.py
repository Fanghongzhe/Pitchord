"""Download a faster-whisper CTranslate2 model into Pitchord's own environment."""

from __future__ import annotations

import argparse
import os
import warnings
from pathlib import Path


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", default="small")
    parser.add_argument("--output", required=True)
    args = parser.parse_args()
    warnings.filterwarnings("ignore", message=".*local_dir_use_symlinks.*")
    from faster_whisper.utils import download_model

    target = Path(args.output)
    target.mkdir(parents=True, exist_ok=True)
    print(f"PITCHORD_PROGRESS|0.050|正在准备 {args.model} 歌词对齐模型…", flush=True)
    download_model(
        args.model,
        output_dir=str(target),
        cache_dir=os.environ.get("HF_HOME"),
        local_files_only=False,
    )
    print("PITCHORD_PROGRESS|1.000|歌词对齐模型已准备完成", flush=True)


if __name__ == "__main__":
    main()
