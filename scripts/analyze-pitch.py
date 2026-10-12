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


def analyze_torchcrepe(audio: np.ndarray, sample_rate: int, requested_device: str) -> tuple[list[dict[str, float | bool]], str]:
    import torch
    import torchcrepe

    target_rate = 16000
    if sample_rate != target_rate:
        audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=target_rate)
        sample_rate = target_rate
    hop_length = 160
    device = "cuda" if requested_device == "cuda" and torch.cuda.is_available() else "cpu"
    device_label = torch.cuda.get_device_name(0) if device == "cuda" else "CPU"
    report(0.25, f"正在使用 {device_label} 运行 TorchCrepe 神经音高分析…")
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
            device=device,
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
    return result, device_label


def neural_chunks(audio: np.ndarray, sample_rate: int):
    """Keep long songs within bounded inference memory while preserving edge context."""
    chunk = 20 * sample_rate
    margin = sample_rate // 2
    for base in range(0, len(audio), chunk):
        left = max(0, base - margin)
        right = min(len(audio), base + chunk + margin)
        yield left, base, min(len(audio), base + chunk), audio[left:right]


def analyze_rmvpe(audio: np.ndarray, sample_rate: int, model_path: Path) -> tuple[list[dict[str, float | bool]], str]:
    from rmvpe_onnx import RMVPE

    if not model_path.is_file():
        raise RuntimeError("RMVPE 权重未准备完成，请在分析环境中勾选 RMVPE 后重试。")
    target_rate = 16000
    audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=target_rate) if sample_rate != target_rate else audio
    rms = aligned_rms(audio, 1024, 160, len(audio) // 160 + 2)
    floor = max(0.002, float(np.max(rms, initial=0.0)) * 0.025)
    model = RMVPE(model_path=str(model_path), device="cpu")
    result = []
    for left, base, right, chunk in neural_chunks(audio, target_rate):
        report(0.25 + 0.62 * base / len(audio), f"RMVPE 正在分析 {base / target_rate:.0f}–{right / target_rate:.0f} 秒…")
        times, frequencies, confidences, _ = model.predict(chunk, target_rate)
        for time, hz, confidence in zip(times, frequencies, confidences):
            sample = left + round(float(time) * target_rate)
            if sample < base or sample >= right or sample >= len(audio):
                continue
            position = min(round(sample / 160), len(rms) - 1)
            energy = float(rms[position])
            voiced = math.isfinite(float(hz)) and math.isfinite(float(confidence)) and float(confidence) >= 0.03 and energy >= floor
            result.append({"time": round(sample / target_rate, 6), "hz": round(float(hz), 4) if voiced else 0.0,
                           "confidence": round(float(confidence) if math.isfinite(float(confidence)) else 0.0, 5),
                           "rms": round(energy, 7), "voiced": voiced})
    return result, "CPU · ONNX"


def analyze_fcpe(audio: np.ndarray, sample_rate: int, requested_device: str) -> tuple[list[dict[str, float | bool]], str]:
    import torch
    from torchfcpe import spawn_bundled_infer_model

    target_rate = 16000
    audio = librosa.resample(audio, orig_sr=sample_rate, target_sr=target_rate) if sample_rate != target_rate else audio
    rms = aligned_rms(audio, 1024, 160, len(audio) // 160 + 2)
    floor = max(0.002, float(np.max(rms, initial=0.0)) * 0.025)
    device = "cuda" if requested_device == "cuda" and torch.cuda.is_available() else "cpu"
    device_label = torch.cuda.get_device_name(0) if device == "cuda" else "CPU"
    model = spawn_bundled_infer_model(device=device)
    result = []
    for left, base, right, chunk in neural_chunks(audio, target_rate):
        report(0.25 + 0.62 * base / len(audio), f"FCPE 正在分析 {base / target_rate:.0f}–{right / target_rate:.0f} 秒…")
        tensor = torch.from_numpy(chunk.astype(np.float32, copy=False)).reshape(1, -1, 1).to(device)
        with torch.inference_mode():
            frequencies = model.infer(tensor, sr=target_rate, decoder_mode="local_argmax", threshold=0.006,
                                      f0_min=50, f0_max=1100, interp_uv=False,
                                      output_interp_target_length=len(chunk) // 160 + 1).reshape(-1).cpu().numpy()
        for index, hz in enumerate(frequencies):
            sample = left + index * 160
            if sample < base or sample >= right or sample >= len(audio):
                continue
            position = min(round(sample / 160), len(rms) - 1)
            energy = float(rms[position])
            voiced = math.isfinite(float(hz)) and float(hz) > 0 and energy >= floor
            result.append({"time": round(sample / target_rate, 6), "hz": round(float(hz), 4) if voiced else 0.0,
                           "confidence": 0.6 if voiced else 0.0, "rms": round(energy, 7), "voiced": voiced})
    return result, device_label


def main() -> None:
    parser = argparse.ArgumentParser(description="Analyze a vocal track with Pitchord")
    parser.add_argument("input", type=Path)
    parser.add_argument("--algorithm", choices=("pyin", "torchcrepe", "rmvpe", "fcpe"), default="pyin")
    parser.add_argument("--output", type=Path, required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
    parser.add_argument("--model", type=Path, default=None)
    args = parser.parse_args()

    report(0.08, "正在读取纯人声音频…")
    audio, sample_rate = librosa.load(args.input, sr=22050, mono=True)
    if audio.size == 0:
        raise RuntimeError("纯人声音频为空")
    report(0.18, f"已读取 {len(audio) / sample_rate:.1f} 秒纯人声音频")
    if args.algorithm == "pyin":
        points, device_label = analyze_pyin(audio, sample_rate), "CPU"
    elif args.algorithm == "torchcrepe":
        points, device_label = analyze_torchcrepe(audio, sample_rate, args.device)
    elif args.algorithm == "rmvpe":
        if not args.model:
            raise RuntimeError("缺少 RMVPE 模型路径。")
        points, device_label = analyze_rmvpe(audio, sample_rate, args.model)
    else:
        points, device_label = analyze_fcpe(audio, sample_rate, args.device)
    report(0.92, "正在保存连续音高结果…")
    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps({"algorithm": args.algorithm, "device": device_label, "points": points}, ensure_ascii=False), encoding="utf-8")
    report(1.0, f"音高分析完成，共生成 {len(points)} 个时间点")


if __name__ == "__main__":
    main()
