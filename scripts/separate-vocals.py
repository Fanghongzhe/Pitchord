"""Local Demucs adapter used by the desktop app's optional analysis action.

The application does not download model weights silently. Install Demucs and
download its model explicitly before running this adapter, then the desktop
bridge loads the generated ``vocals.wav`` into the pitch analysis track.
"""

from __future__ import annotations

import argparse
from pathlib import Path

import demucs.separate


def main() -> None:
    parser = argparse.ArgumentParser(description="Separate a vocal stem with Demucs")
    parser.add_argument("input", type=Path)
    parser.add_argument("--output", type=Path, default=Path("analysis-output"))
    parser.add_argument("--model", default="htdemucs")
    parser.add_argument("--repo", type=Path)
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    command = ["--two-stems", "vocals", "-n", args.model]
    if args.repo:
        command.extend(["--repo", str(args.repo)])
    command.extend(["--out", str(args.output), str(args.input)])
    demucs.separate.main(command)


if __name__ == "__main__":
    main()
