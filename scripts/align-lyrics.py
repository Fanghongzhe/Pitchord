"""Align user supplied lyrics to a vocal track with faster-whisper timestamps.

The user's lyrics remain authoritative. Whisper supplies timed recognition tokens;
the aligner finds monotonic anchors, matches the text between anchors, and
interpolates only tokens that could not be matched directly.
"""

from __future__ import annotations

import argparse
import json
import math
import os
import re
import sys
import unicodedata
import uuid
from collections import Counter
from difflib import SequenceMatcher
from pathlib import Path


UNIT_RE = re.compile(r"[\u3400-\u9fff]|[A-Za-z]+(?:['’-][A-Za-z]+)*|\d+|[^\s]", re.UNICODE)


def emit_progress(value: float, message: str) -> None:
    print(f"PITCHORD_PROGRESS|{max(0.0, min(1.0, value)):.3f}|{message}", flush=True)


def normalize(value: str) -> str:
    value = unicodedata.normalize("NFKC", value).lower().strip()
    return "".join(ch for ch in value if ch.isalnum() or "\u3400" <= ch <= "\u9fff")


def text_units(text: str) -> list[dict]:
    result = []
    for match in UNIT_RE.finditer(text):
        result.append({
            "text": match.group(0),
            "startOffset": match.start(),
            "endOffset": match.end(),
            "key": normalize(match.group(0)),
        })
    return result


def split_asr_word(text: str, start: float, end: float) -> list[dict]:
    units = [unit for unit in text_units(text) if unit["key"]]
    if not units:
        return []
    span = max(0.01, end - start)
    weights = [max(1, len(unit["key"])) for unit in units]
    total = sum(weights)
    elapsed = 0
    result = []
    for unit, weight in zip(units, weights):
        unit_start = start + span * elapsed / total
        elapsed += weight
        unit_end = start + span * elapsed / total
        result.append({"key": unit["key"], "text": unit["text"], "start": unit_start, "end": unit_end})
    return result


def longest_increasing_pairs(pairs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Return a longest subsequence whose reference and ASR indexes both increase."""
    pairs = sorted(pairs)
    if not pairs:
        return []
    lengths = [1] * len(pairs)
    previous = [-1] * len(pairs)
    best = 0
    for index, (_, asr_index) in enumerate(pairs):
        for candidate in range(index):
            if pairs[candidate][1] < asr_index and lengths[candidate] + 1 > lengths[index]:
                lengths[index] = lengths[candidate] + 1
                previous[index] = candidate
        if lengths[index] > lengths[best]:
            best = index
    result = []
    while best >= 0:
        result.append(pairs[best])
        best = previous[best]
    return list(reversed(result))


def matched_indexes(reference: list[dict], recognized: list[dict]) -> dict[int, int]:
    ref_keys = [token["key"] for token in reference]
    asr_keys = [token["key"] for token in recognized]
    ref_counts, asr_counts = Counter(ref_keys), Counter(asr_keys)
    asr_position = {key: index for index, key in enumerate(asr_keys) if asr_counts[key] == 1}
    anchors = longest_increasing_pairs([
        (index, asr_position[key])
        for index, key in enumerate(ref_keys)
        if key and ref_counts[key] == 1 and asr_counts[key] == 1
    ])
    matches: dict[int, int] = {ref: asr for ref, asr in anchors}
    sentinels = [(-1, -1), *anchors, (len(reference), len(recognized))]
    for (left_ref, left_asr), (right_ref, right_asr) in zip(sentinels, sentinels[1:]):
        ref_start, asr_start = left_ref + 1, left_asr + 1
        matcher = SequenceMatcher(
            None,
            ref_keys[ref_start:right_ref],
            asr_keys[asr_start:right_asr],
            autojunk=False,
        )
        for block in matcher.get_matching_blocks():
            for offset in range(block.size):
                matches[ref_start + block.a + offset] = asr_start + block.b + offset
    return matches


def interpolate_times(reference: list[dict], recognized: list[dict], matches: dict[int, int], duration: float) -> list[tuple[float, float]]:
    if not reference:
        return []
    recognized_start = recognized[0]["start"] if recognized else 0.0
    recognized_end = recognized[-1]["end"] if recognized else duration
    direct = {
        ref_index: (recognized[asr_index]["start"], recognized[asr_index]["end"])
        for ref_index, asr_index in matches.items()
    }
    times: list[tuple[float, float] | None] = [direct.get(index) for index in range(len(reference))]
    matched = sorted(direct)
    sentinels = [-1, *matched, len(reference)]
    for left, right in zip(sentinels, sentinels[1:]):
        first = left + 1
        last = right - 1
        if first > last:
            continue
        window_start = direct[left][1] if left in direct else recognized_start
        window_end = direct[right][0] if right in direct else recognized_end
        if window_end <= window_start:
            window_end = min(duration, window_start + 0.04 * (last - first + 1))
        count = last - first + 1
        for offset, index in enumerate(range(first, last + 1)):
            times[index] = (
                window_start + (window_end - window_start) * offset / count,
                window_start + (window_end - window_start) * (offset + 1) / count,
            )
    clean: list[tuple[float, float]] = []
    cursor = 0.0
    for item in times:
        start, end = item or (cursor, cursor + 0.04)
        start = max(cursor, min(duration, float(start)))
        end = max(start + 0.001, min(duration, float(end)))
        if end > duration:
            start = max(cursor, duration - 0.001)
            end = duration
        clean.append((round(start, 3), round(end, 3)))
        cursor = end
    return clean


def align_segments(segments: list[dict], recognized: list[dict], duration: float) -> dict:
    flat_reference = []
    segment_units = []
    for segment_index, segment in enumerate(segments):
        units = text_units(str(segment.get("text", "")))
        content_indexes = []
        for unit_index, unit in enumerate(units):
            if unit["key"]:
                content_indexes.append(len(flat_reference))
                flat_reference.append({**unit, "segment": segment_index, "unit": unit_index})
        segment_units.append((units, content_indexes))

    matches = matched_indexes(flat_reference, recognized)
    content_times = interpolate_times(flat_reference, recognized, matches, duration)
    aligned_segments = []
    previous_end = 0.0
    for segment_index, segment in enumerate(segments):
        units, content_indexes = segment_units[segment_index]
        old_chars = segment.get("chars") if isinstance(segment.get("chars"), list) else []
        if content_indexes:
            line_start = content_times[content_indexes[0]][0]
            line_end = content_times[content_indexes[-1]][1]
        else:
            line_start = float(segment.get("start", previous_end))
            line_end = float(segment.get("end", line_start + 0.2))
        line_start = max(previous_end, min(duration, line_start))
        line_end = max(line_start + 0.001, min(duration, line_end))

        # Punctuation receives the nearest gap; recognized lyric units keep ASR time.
        content_by_unit = {flat_reference[index]["unit"]: content_times[index] for index in content_indexes}
        timed_units: list[tuple[float, float]] = []
        for unit_index in range(len(units)):
            if unit_index in content_by_unit:
                timed_units.append(content_by_unit[unit_index])
                continue
            left = next((content_by_unit[i][1] for i in range(unit_index - 1, -1, -1) if i in content_by_unit), line_start)
            right = next((content_by_unit[i][0] for i in range(unit_index + 1, len(units)) if i in content_by_unit), line_end)
            timed_units.append((left, max(left + 0.001, right)))
        chars = []
        for unit_index, (unit, timing) in enumerate(zip(units, timed_units)):
            old = old_chars[unit_index] if unit_index < len(old_chars) else {}
            chars.append({
                "id": old.get("id") or str(uuid.uuid4()),
                "text": unit["text"],
                "startOffset": unit["startOffset"],
                "endOffset": unit["endOffset"],
                "start": round(max(line_start, timing[0]), 3),
                "end": round(min(line_end, max(timing[0] + 0.001, timing[1])), 3),
                "origin": "estimated",
            })
        aligned_segments.append({
            **segment,
            "start": round(line_start, 3),
            "end": round(line_end, 3),
            "chars": chars,
        })
        previous_end = line_end
    return {
        "segments": aligned_segments,
        "coverage": round(len(matches) / max(1, len(flat_reference)), 4),
        "matchedTokens": len(matches),
        "referenceTokens": len(flat_reference),
        "recognizedTokens": len(recognized),
    }


def transcribe(audio: str, model_name: str, language: str | None, model_root: str) -> tuple[list[dict], str | None]:
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise RuntimeError("当前分析环境缺少 faster-whisper，请先准备歌词对齐环境。") from error
    model_directory = os.path.join(model_root, model_name)
    local_only = os.path.isdir(model_directory) and any(Path(model_directory).iterdir())
    emit_progress(0.06, f"正在载入 {model_name} 语音识别模型…")
    model = WhisperModel(
        model_directory if local_only else model_name,
        device="cpu",
        compute_type="int8",
        download_root=model_root,
        local_files_only=local_only,
    )
    emit_progress(0.14, "正在识别人声音轨并生成字词时间戳…")
    stream, info = model.transcribe(
        audio,
        language=language or None,
        beam_size=5,
        word_timestamps=True,
        vad_filter=True,
        condition_on_previous_text=False,
    )
    tokens = []
    for segment in stream:
        for word in segment.words or []:
            tokens.extend(split_asr_word(word.word, float(word.start), float(word.end)))
    return tokens, getattr(info, "language", language)


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--lyrics", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--tokens", help="Use timed ASR tokens from JSON instead of running Whisper (test/debug).")
    args = parser.parse_args()
    payload = json.loads(Path(args.lyrics).read_text(encoding="utf-8"))
    segments = payload.get("segments", [])
    duration = float(payload.get("duration") or max((float(item.get("end", 0)) for item in segments), default=0))
    if not segments or duration <= 0:
        raise RuntimeError("歌词内容为空，或媒体时长无效。")
    if args.tokens:
        recognized = json.loads(Path(args.tokens).read_text(encoding="utf-8"))
        detected_language = args.language
    else:
        recognized, detected_language = transcribe(args.audio, args.model, args.language, args.model_root)
    if not recognized:
        raise RuntimeError("没有从人声音轨中识别到可用于对齐的歌词。")
    emit_progress(0.86, "正在把识别时间戳匹配到输入歌词…")
    result = align_segments(segments, recognized, duration)
    result.update({"model": args.model, "language": detected_language, "source": "faster-whisper-monotonic-text-alignment"})
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    emit_progress(1.0, f"对齐完成，歌词匹配覆盖率 {result['coverage'] * 100:.1f}%")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"PITCHORD_ERROR|{error}", file=sys.stderr, flush=True)
        raise
