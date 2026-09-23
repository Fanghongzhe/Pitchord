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
    args = parser.parse_args()
    args.output.mkdir(parents=True, exist_ok=True)
    demucs.separate.main([
        "--two-stems", "vocals", "-n", args.model,
        "--out", str(args.output), str(args.input),
    ])


if __name__ == "__main__":
    main()
