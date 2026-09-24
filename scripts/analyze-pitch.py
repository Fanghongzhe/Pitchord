"""Offline vocal pitch analysis for Pitchord.

The script keeps model work outside the Electron renderer and writes a small,
portable JSON result that can be saved with the project.
"""

from __future__ import annotations

import argparse
import json
import math
from pathlib import Path

import librosa
import numpy as np


def report(progress: float, message: str) -> None:
    print(f"PITCHORD_PROGRESS|{max(0.0, min(1.0, progress)):.3f}|{message}", flush=True)


def aligned_rms(audio: np.ndarray, frame_length: int, hop_length: int, count: int) -> np.ndarray:
    values = librosa.feature.rms(
        y=audio,
        frame_length=frame_length,
        hop_length=hop_length,
        center=True,
    )[0]
    if len(values) >= count:
        return values[:count]
    return np.pad(values, (0, count - len(values)))


def analyze_pyin(audio: np.ndarray, sample_rate: int) -> list[dict[str, float | bool]]:
    frame_length = 2048
    hop_length = 256
    report(0.25, "正在运行 pYIN 概率音高与连续性分析…")
    frequencies, voiced_flags, voiced_probabilities = librosa.pyin(
        audio,
        fmin=librosa.note_to_hz("C2"),
        fmax=librosa.note_to_hz("C7"),
        sr=sample_rate,
        frame_length=frame_length,
        hop_length=hop_length,
        center=True,
    )
    count = len(frequencies)
    times = librosa.times_like(frequencies, sr=sample_rate, hop_length=hop_length)
    rms = aligned_rms(audio, frame_length, hop_length, count)
    floor = max(0.002, float(np.max(rms, initial=0.0)) * 0.025)
    result = []
    for time, frequency, flag, probability, energy in zip(times, frequencies, voiced_flags, voiced_probabilities, rms):
        voiced = bool(flag) and math.isfinite(float(frequency)) and float(energy) >= floor
        result.append({
            "time": round(float(time), 6),
            "hz": round(float(frequency), 4) if voiced else 0.0,
            "confidence": round(float(probability) if math.isfinite(float(probability)) else 0.0, 5),
            "rms": round(float(energy), 7),
            "voiced": voiced,
        })
    return result


def analyze_torchcrepe(audio: np.ndarray, sample_rate: int) -> list[dict[str, float | bool]]:
    import torch
    import torchcrepe

    target_rate = 16000
    if sample_rate != target_rate:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=target_rate)
        sample_rate = target_rate
    hop_length = 160
    report(0.25, "正在运行 TorchCrepe 神经音高分析…")
    tensor = torch.from_numpy(audio.astype(np.float32, copy=False)).unsqueeze(0)
    with torch.inference_mode():
        frequency, periodicity = torchcrepe.predict(
            tensor,
            sample_rate,
            hop_length,
            50,
            1100,
            model="full",
            batch_size=1024,
            device="cpu",
            return_periodicity=True,
            pad=True,
        )
        frequency = torchcrepe.filter.mean(frequency, 3).squeeze(0).cpu().numpy()
        periodicity = torchcrepe.filter.median(periodicity, 3).squeeze(0).cpu().numpy()
    rms = aligned_rms(audio, 1024, hop_length, len(frequency))
    floor = max(0.002, float(np.max(rms, initial=0.0)) * 0.025)
    result = []
    for index, (hz, confidence, energy) in enumerate(zip(frequency, periodicity, rms)):
        voiced = math.isfinite(float(hz)) and float(confidence) >= 0.28 and float(energy) >= floor
        result.append({
            "time": round(index * hop_length / sample_rate, 6),
            "hz": round(float(hz), 4) if voiced else 0.0,
            "confidence": round(float(confidence), 5),
            "rms": round(float(energy), 7),
            "voiced": voiced,
        })
    return result


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze a vocal track with Pitchord")
    parser.add_argument("input", type=Path)
    parser.add_argument("--algorithm", choices=("pyin", "torchcrepe"), default="pyin")
    parser.add_argument("--output", type=Path, required=True)
    args = parser.parse_args()

    report(0.08, "正在读取纯人声音频…")
    audio, sample_rate = librosa.load(args.input, sr=22050, mono=True)
    if audio.size == 0:
        raise RuntimeError("纯人声音频为空")
    report(0.18, f"已读取 {len(audio) / sample_rate:.1f} 秒纯人声音频")
    points = analyze_pyin(audio, sample_rate) if args.algorithm == "pyin" else analyze_torchcrepe(audio, sample_rate)
    report(0.92, "正在保存连续音高结果…")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"algorithm": args.algorithm, "points": points}, ensure_ascii=False), encoding="utf-8")
    report(1.0, f"音高分析完成，共生成 {len(points)} 个时间点")


if __name__ == "__main__":
    main()
