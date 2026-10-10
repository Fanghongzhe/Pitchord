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
import statistics
from bisect import bisect_left
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


def split_asr_word(text: str, start: float, end: float, probability: float | None = None) -> list[dict]:
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
        result.append({"key": unit["key"], "text": unit["text"], "start": unit_start, "end": unit_end, "probability": probability})
    return result


def longest_increasing_pairs(pairs: list[tuple[int, int]]) -> list[tuple[int, int]]:
    """Return a longest subsequence whose reference and ASR indexes both increase."""
    pairs = sorted(pairs)
    if not pairs:
        return []
    tails: list[int] = []
    tail_indexes: list[int] = []
    previous = [-1] * len(pairs)
    for index, (_, asr_index) in enumerate(pairs):
        position = bisect_left(tails, asr_index)
        if position == len(tails):
            tails.append(asr_index)
            tail_indexes.append(index)
        else:
            tails[position] = asr_index
            tail_indexes[position] = index
        if position:
            previous[index] = tail_indexes[position - 1]
    result = []
    cursor = tail_indexes[-1]
    while cursor >= 0:
        result.append(pairs[cursor])
        cursor = previous[cursor]
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
    # Individual Chinese characters are often repeated throughout a song. A
    # handful of unique-character anchors is less reliable than matching the
    # complete reference in order (as in Audio-Srt-Aligner's fallback).
    if len(anchors) < max(12, int(min(len(reference), len(recognized)) * 0.008)):
        anchors = []
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


def matched_indexes_with_time_hints(reference: list[dict], recognized: list[dict], segments: list[dict]) -> dict[int, int]:
    """Weighted monotonic text alignment, using LRC times to resolve repeats.

    The hints affect where identical words are matched, never the reference
    text itself. A missing or inaccurate hint can simply remain unmatched.
    """
    expected: list[float | None] = [None] * len(reference)
    average = typical_token_duration(recognized)
    by_line: list[list[int]] = [[] for _ in segments]
    for index, token in enumerate(reference):
        by_line[token["segment"]].append(index)
    for line_index, indexes in enumerate(by_line):
        segment = segments[line_index]
        if segment.get("timingSource") not in ("lrc", "manual") or not indexes:
            continue
        start = float(segment.get("start", 0))
        span = max(0.1, float(segment.get("end", start)) - start)
        if segment.get("timingSource") == "lrc":
            span = min(span, max(2.0, min(7.0, len(indexes) * average * 1.8)))
        for local_index, index in enumerate(indexes):
            expected[index] = start + span * (local_index + 0.5) / len(indexes)

    width = len(recognized)
    previous = [0.0] * (width + 1)
    directions = [bytearray(width + 1) for _ in range(len(reference) + 1)]
    for ref_index, token in enumerate(reference, 1):
        current = [0.0] * (width + 1)
        hint = expected[ref_index - 1]
        for asr_index, word in enumerate(recognized, 1):
            if current[asr_index - 1] >= previous[asr_index]:
                best = current[asr_index - 1]
                direction = 2
            else:
                best = previous[asr_index]
                direction = 1
            if token["key"] == word["key"]:
                distance = abs((word["start"] + word["end"]) / 2 - hint) if hint is not None else 0.0
                if distance <= 8.0:
                    score = previous[asr_index - 1] + 1.0 - distance * 0.08
                    if score > best:
                        best = score
                        direction = 3
            current[asr_index] = best
            directions[ref_index][asr_index] = direction
        previous = current
    matched: dict[int, int] = {}
    ref_index, asr_index = len(reference), width
    while ref_index and asr_index:
        direction = directions[ref_index][asr_index]
        if direction == 3:
            matched[ref_index - 1] = asr_index - 1
            ref_index -= 1
            asr_index -= 1
        elif direction == 2:
            asr_index -= 1
        else:
            ref_index -= 1
    return matched


def typical_token_duration(recognized: list[dict]) -> float:
    spans = [token["end"] - token["start"] for token in recognized if 0.04 <= token["end"] - token["start"] <= 1.0]
    return max(0.12, min(0.35, statistics.median(spans) if spans else 0.20))


def line_intervals(lines: list[list[int]], segments: list[dict], recognized: list[dict], matches: dict[int, int], duration: float) -> tuple[list[tuple[float, float]], list[set[int]]]:
    """Find line ranges first; weak/missing ASR matches must not collapse a line."""
    average = typical_token_duration(recognized)
    counts = [max(1, len(indexes)) for indexes in lines]
    gap = min(0.01, duration / max(1, len(lines) * 4))
    floors = [max(0.12, count * max(0.10, average * 0.65)) for count in counts]
    floor_budget = max(0.001, duration - gap * max(0, len(lines) - 1))
    if sum(floors) > floor_budget:
        floors = [value * floor_budget / sum(floors) for value in floors]

    proposals: list[tuple[float, float] | None] = [None] * len(lines)
    accepted: list[set[int]] = [set() for _ in lines]
    for line_index, indexes in enumerate(lines):
        if not indexes:
            continue
        observations = []
        for local_index, ref_index in enumerate(indexes):
            if ref_index not in matches:
                continue
            token = recognized[matches[ref_index]]
            center = (token["start"] + token["end"]) / 2
            estimated_center = center + ((len(indexes) - 1) / 2 - local_index) * average
            observations.append((ref_index, local_index, token, estimated_center))
        required = 1 if len(indexes) <= 2 else max(2, math.ceil(len(indexes) * 0.25))
        if len(observations) < required:
            continue
        median_center = statistics.median(item[3] for item in observations)
        tolerance = max(0.8, len(indexes) * average * 0.7)
        inliers = [item for item in observations if abs(item[3] - median_center) <= tolerance]
        if len(inliers) < required:
            continue
        accepted[line_index] = {item[0] for item in inliers}
        start = min(
            statistics.median(item[2]["start"] - item[1] * average for item in inliers),
            min(item[2]["start"] for item in inliers),
        )
        end = max(
            statistics.median(item[2]["end"] + (len(indexes) - item[1] - 1) * average for item in inliers),
            max(item[2]["end"] for item in inliers),
        )
        center = (start + end) / 2
        span = max(floors[line_index], end - start)
        proposed_start = max(0.0, center - span / 2)
        proposed_end = min(duration, center + span / 2)
        hint = segments[line_index]
        if hint.get("timingSource") in ("lrc", "manual") and abs(proposed_start - float(hint.get("start", 0))) > 5.0:
            accepted[line_index] = set()
            continue
        proposals[line_index] = (proposed_start, proposed_end)

    # A timed LRC provides a useful fallback when speech recognition misses a
    # sung line. Treat it as a weak estimate rather than forcing an exact time.
    for index, segment in enumerate(segments):
        if proposals[index] is not None or segment.get("timingSource") not in ("lrc", "manual"):
            continue
        start = max(0.0, min(duration, float(segment.get("start", 0))))
        original_span = max(0.0, float(segment.get("end", start)) - start)
        if segment.get("timingSource") == "manual":
            span = max(floors[index], original_span)
        else:
            span = max(floors[index], min(original_span, max(2.0, min(7.0, counts[index] * average * 1.8))))
        proposals[index] = (start, min(duration, start + span))

    # Entire lines may be absent from Whisper output (especially sung Chinese).
    # Place them between neighboring reliable lines, weighted by lyric length.
    position = 0
    while position < len(lines):
        if proposals[position] is not None:
            position += 1
            continue
        first = position
        while position < len(lines) and proposals[position] is None:
            position += 1
        last = position
        left = proposals[first - 1][1] if first else 0.0
        right = proposals[last][0] if last < len(lines) else duration
        if right <= left:
            right = left + sum(counts[first:last]) * average
        weight_total = sum(counts[first:last])
        weight_before = 0
        for index in range(first, last):
            slot_start = left + (right - left) * weight_before / weight_total
            weight_before += counts[index]
            slot_end = left + (right - left) * weight_before / weight_total
            span = max(floors[index], min(slot_end - slot_start, counts[index] * average * 2.5))
            center = (slot_start + slot_end) / 2
            proposals[index] = (center - span / 2, center + span / 2)

    # Preserve each line's shape on collision by moving following lines. If
    # necessary, remove free gaps before reducing any line's duration.
    placed: list[tuple[float, float]] = []
    for index, proposal in enumerate(proposals):
        assert proposal is not None
        start, end = proposal
        span = max(end - start, floors[index])
        start = max(0.0 if not placed else placed[-1][1] + gap, start)
        placed.append((start, start + span))
    if placed[-1][1] > duration:
        spans = [end - start for start, end in placed]
        free_gaps = [placed[0][0], *[placed[index][0] - placed[index - 1][1] for index in range(1, len(placed))]]
        overflow = placed[-1][1] - duration
        reducible_gaps = sum(free_gaps) - gap * max(0, len(lines) - 1)
        remove = min(overflow, max(0.0, reducible_gaps))
        if remove:
            removable = [free_gaps[0], *[max(0.0, value - gap) for value in free_gaps[1:]]]
            free_gaps = [value - remove * part / sum(removable) for value, part in zip(free_gaps, removable)]
            overflow -= remove
        if overflow > 0:
            extras = [max(0.0, span - floor) for span, floor in zip(spans, floors)]
            reduction = min(overflow, sum(extras))
            if reduction:
                spans = [span - reduction * extra / sum(extras) for span, extra in zip(spans, extras)]
        placed = []
        cursor = 0.0
        for free, span in zip(free_gaps, spans):
            start = cursor + free
            placed.append((start, start + span))
            cursor = start + span
    return placed, accepted


def token_intervals(indexes: list[int], recognized: list[dict], matches: dict[int, int], accepted: set[int], start: float, end: float) -> dict[int, tuple[float, float]]:
    """Spread unmatched words inside their line rather than in a tiny anchor gap."""
    if not indexes:
        return {}
    count = len(indexes)
    step = (end - start) / count
    anchors = [(-1, start - step / 2)]
    for position, ref_index in enumerate(indexes):
        if ref_index in accepted:
            token = recognized[matches[ref_index]]
            center = (token["start"] + token["end"]) / 2
            if start <= center <= end:
                anchors.append((position, center))
    anchors.append((count, end + step / 2))
    anchors.sort()
    targets = [start + (position + 0.5) * step for position in range(count)]
    for (left_index, left_time), (right_index, right_time) in zip(anchors, anchors[1:]):
        for index in range(max(0, left_index), min(count - 1, right_index) + 1):
            targets[index] = left_time + (right_time - left_time) * (index - left_index) / (right_index - left_index)
    minimum = min(0.06, step * 0.5)
    centers = [max(start + (index + 0.5) * minimum, target) for index, target in enumerate(targets)]
    for index in range(count - 1, -1, -1):
        upper = end - (count - index - 0.5) * minimum
        if index + 1 < count:
            upper = min(upper, centers[index + 1] - minimum)
        centers[index] = min(centers[index], upper)
    for index in range(1, count):
        centers[index] = max(centers[index], centers[index - 1] + minimum)
    boundaries = [start, *[(centers[index - 1] + centers[index]) / 2 for index in range(1, count)], end]
    return {ref_index: (boundaries[index], boundaries[index + 1]) for index, ref_index in enumerate(indexes)}


def alignment_hints(segments: list[dict], duration: float) -> list[dict]:
    """Recognize timed LRC saved by older Pitchord versions without metadata."""
    if any(segment.get("timingSource") in ("lrc", "manual", "estimated") for segment in segments):
        return segments
    if len(segments) < 2:
        return segments
    slot = duration / len(segments)
    looks_uniform = all(abs(float(segment.get("start", 0)) - index * slot) < 0.15 for index, segment in enumerate(segments))
    return segments if looks_uniform else [{**segment, "timingSource": "lrc"} for segment in segments]


def vocal_activity(audio: str, pitch_points: list[dict] | None = None) -> dict | None:
    """Find phrase onsets and clear vocal gaps in the selected vocal stem."""
    try:
        import numpy as np
        import soundfile as sf

        with sf.SoundFile(audio) as source:
            sample_rate = source.samplerate
            step = max(1, round(sample_rate * 0.02))
            rms = []
            while True:
                frame = source.read(step, dtype="float32", always_2d=True)
                if not len(frame):
                    break
                rms.append(float(np.sqrt(np.mean(frame * frame))))
    except (ImportError, OSError, RuntimeError, ValueError):
        return None
    if not rms:
        return None
    reference = float(np.quantile(rms, 0.90))
    low = [value >= max(0.002, reference * 0.025) for value in rms]
    high = [value >= max(0.012, reference * 0.10) for value in rms]

    def runs(flags: list[bool]) -> list[tuple[int, int]]:
        found = []
        index = 0
        while index < len(flags):
            if not flags[index]:
                index += 1
                continue
            end = index + 1
            while end < len(flags) and flags[end]:
                end += 1
            found.append((index, end))
            index = end
        return found

    # Small drops within a sung syllable should not become phrase breaks.
    for flags in (low, high):
        spans = runs(flags)
        for (_, left_end), (right_start, _) in zip(spans, spans[1:]):
            if right_start - left_end <= 3:
                flags[left_end:right_start] = [True] * (right_start - left_end)

    seconds = step / sample_rate
    low_runs = runs(low)
    onsets = [
        start * seconds for index, (start, end) in enumerate(low_runs)
        if (end - start) * seconds >= 0.18
        and (index == 0 or (start - low_runs[index - 1][1]) * seconds >= 0.40)
    ]
    high_runs = runs(high)
    gaps = [
        (left_end * seconds, right_start * seconds)
        for (left_start, left_end), (right_start, right_end) in zip(high_runs, high_runs[1:])
        if (left_end - left_start) * seconds >= 0.18
        and (right_end - right_start) * seconds >= 0.12
        and 0.16 <= (right_start - left_end) * seconds <= 2.0
    ]
    pitch_gaps = []
    if pitch_points:
        voiced = [bool(point.get("voiced")) and float(point.get("hz") or 0) > 0 for point in pitch_points]
        pitch_runs = runs(voiced)
        for (left_start, left_end), (right_start, right_end) in zip(pitch_runs, pitch_runs[1:]):
            gap_start = float(pitch_points[left_end]["time"])
            gap_end = float(pitch_points[right_start]["time"])
            if float(pitch_points[left_end - 1]["time"]) - float(pitch_points[left_start]["time"]) < 0.08:
                continue
            if float(pitch_points[right_end - 1]["time"]) - float(pitch_points[right_start]["time"]) < 0.08:
                continue
            if 0.10 <= gap_end - gap_start <= 1.5:
                pitch_gaps.append((gap_start, gap_end))
    return {
        "step": seconds, "rms": rms, "high": high, "onsets": onsets, "gaps": gaps,
        "pitchGaps": pitch_gaps,
        "pitchTimes": [float(point["time"]) for point in pitch_points] if pitch_points else [],
        "pitchVoiced": voiced if pitch_points else [],
    }


def local_vocal_valleys(activity: dict, boundary: float) -> list[tuple[float, float]]:
    """Find a quiet phrase break relative to the local sung volume."""
    values = activity.get("rms")
    if not values:
        return []
    step = activity["step"]
    baseline_start = max(0, round((boundary - 0.34) / step))
    baseline_end = min(len(values), round((boundary + 0.10) / step))
    if baseline_end <= baseline_start:
        return []
    baseline = statistics.median(values[baseline_start:baseline_end])
    if baseline < 0.008:
        return []
    threshold = max(0.003, baseline * 0.20)
    start = max(0, round((boundary + 0.08) / step))
    stop = min(len(values), round((boundary + 1.35) / step))
    valleys = []
    while start < stop:
        if values[start] >= threshold:
            start += 1
            continue
        end = start + 1
        while end < stop and values[end] < threshold:
            end += 1
        if (end - start) * step >= 0.12:
            valleys.append((start * step, end * step))
        start = end
    return valleys


def refine_ranges_with_vocals(ranges: list[tuple[float, float]], accepted: list[set[int]], segments: list[dict], activity: dict | None) -> tuple[list[tuple[float, float]], list[dict]]:
    if not ranges or not activity:
        return ranges, []
    updated = list(ranges)
    adjustments = []
    # A missed opening phrase should use the first clear vocal onset near its
    # LRC hint, instead of keeping an inaccurate timestamp unchanged.
    if not accepted[0] and segments[0].get("timingSource") in ("lrc", "manual"):
        start, end = updated[0]
        nearby = [time for time in activity["onsets"] if start - 0.4 <= time <= start + 3.0 and time <= end - 0.25]
        if nearby:
            onset = min(nearby, key=lambda time: abs(time - start))
            if abs(onset - start) >= 0.08:
                updated[0] = (onset, end)
                adjustments.append({"line": 0, "kind": "onset", "from": start, "to": onset})

    for index in range(len(updated) - 1):
        start, boundary = updated[index]
        next_start, next_end = updated[index + 1]
        frame = min(len(activity["high"]) - 1, max(0, round(boundary / activity["step"])))
        if not activity["high"][frame]:
            continue
        energy_gaps = [*activity["gaps"], *local_vocal_valleys(activity, boundary)]
        candidates = [
            (gap_start, gap_end) for gap_start, gap_end in energy_gaps
            if boundary + 0.08 <= gap_start <= boundary + 0.95
            and gap_start > start + 0.25 and gap_end < next_end - 0.25
            and gap_end >= next_start - 0.25
        ]
        if not candidates:
            continue
        gap_start, gap_end = min(candidates, key=lambda gap: gap[0] - boundary - 0.2 * (gap[1] - gap[0]))
        matching_pitch_gaps = [
            (pitch_start, pitch_end) for pitch_start, pitch_end in activity.get("pitchGaps", [])
            if min(gap_end, pitch_end) - max(gap_start, pitch_start) >= 0.04
            and pitch_start >= boundary + 0.08 and pitch_end < next_end - 0.25
        ]
        if matching_pitch_gaps:
            gap_start, gap_end = min(matching_pitch_gaps, key=lambda gap: abs(gap[0] - gap_start))
        if gap_start - boundary < 0.24:
            continue
        pitch_times = activity.get("pitchTimes", [])
        if pitch_times:
            first = bisect_left(pitch_times, boundary)
            last = bisect_left(pitch_times, gap_start)
            region = activity["pitchVoiced"][first:last]
            if len(region) < 5 or sum(region) / len(region) < 0.70:
                continue
        elif gap_start - boundary < 0.40 or gap_end - gap_start < 0.20:
            continue
        updated[index] = (start, gap_start)
        updated[index + 1] = (gap_end, next_end)
        adjustments.append({"line": index, "kind": "gap", "from": boundary, "to": gap_start, "nextStart": gap_end})
    return updated, adjustments


def align_segments(segments: list[dict], recognized: list[dict], duration: float, activity: dict | None = None) -> dict:
    hinted_segments = alignment_hints(segments, duration)
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

    # Weighted monotonic matching also works without LRC timestamps. Its
    # global sequence view handles repeated verses better than unique single
    # characters; retain the cheaper anchor matcher for unusually long files.
    matches = (
        matched_indexes_with_time_hints(flat_reference, recognized, hinted_segments)
        if len(flat_reference) * len(recognized) <= 4_000_000
        else matched_indexes(flat_reference, recognized)
    )
    line_indexes = [indexes for _, indexes in segment_units]
    ranges, accepted = line_intervals(line_indexes, hinted_segments, recognized, matches, duration)
    ranges, audio_adjustments = refine_ranges_with_vocals(ranges, accepted, hinted_segments, activity)
    aligned_segments = []
    for segment_index, segment in enumerate(segments):
        units, content_indexes = segment_units[segment_index]
        old_chars = segment.get("chars") if isinstance(segment.get("chars"), list) else []
        line_start, line_end = ranges[segment_index]

        content_times = token_intervals(content_indexes, recognized, matches, accepted[segment_index], line_start, line_end)
        content_by_unit = {flat_reference[index]["unit"]: content_times[index] for index in content_indexes}
        reference_by_unit = {flat_reference[index]["unit"]: index for index in content_indexes}
        timed_units: list[tuple[float, float]] = []
        for unit_index in range(len(units)):
            if unit_index in content_by_unit:
                timed_units.append(content_by_unit[unit_index])
                continue
            # Punctuation has no spoken duration; keep its marker beside the
            # nearest lyric unit and entirely inside the enclosing line.
            previous = next((content_by_unit[i][1] for i in range(unit_index - 1, -1, -1) if i in content_by_unit), None)
            following = next((content_by_unit[i][0] for i in range(unit_index + 1, len(units)) if i in content_by_unit), None)
            point = previous if previous is not None else following if following is not None else line_start
            timed_units.append((max(line_start, point - 0.001), min(line_end, point + 0.001)))
        chars = []
        for unit_index, (unit, timing) in enumerate(zip(units, timed_units)):
            old = old_chars[unit_index] if unit_index < len(old_chars) else {}
            reference_index = reference_by_unit.get(unit_index)
            direct_match = reference_index is not None and reference_index in accepted[segment_index]
            token = recognized[matches[reference_index]] if direct_match else None
            evidence = {
                "source": "asr" if direct_match else "punctuation" if not unit["key"] else "lrc" if segment.get("timingSource") == "lrc" and not accepted[segment_index] else "interpolated",
                "matched": direct_match,
            }
            if token and isinstance(token.get("probability"), (int, float)):
                evidence["asrProbability"] = max(0.0, min(1.0, float(token["probability"])))
            chars.append({
                "id": old.get("id") or str(uuid.uuid4()),
                "text": unit["text"],
                "startOffset": unit["startOffset"],
                "endOffset": unit["endOffset"],
                "start": round(max(line_start, min(line_end, timing[0])), 3),
                "end": round(max(line_start, min(line_end, timing[1])), 3),
                "origin": "estimated",
                "timingEvidence": evidence,
                **({"startLocked": True} if old.get("startLocked") else {}),
                **({"endLocked": True} if old.get("endLocked") else {}),
                **({"pitchOverride": old["pitchOverride"]} if old.get("text") == unit["text"] and old.get("pitchOverride") else {}),
            })
        aligned_segments.append({
            **segment,
            "start": round(line_start, 3),
            "end": round(line_end, 3),
            "chars": chars,
        })
    return {
        "segments": aligned_segments,
        "coverage": round(len(matches) / max(1, len(flat_reference)), 4),
        "matchedTokens": len(matches),
        "referenceTokens": len(flat_reference),
        "recognizedTokens": len(recognized),
        "lowConfidenceLines": [index for index, indexes in enumerate(line_indexes) if indexes and not accepted[index]],
        "audioBoundaryAdjustments": audio_adjustments,
    }


def transcribe(audio: str, model_name: str, language: str | None, model_root: str, requested_device: str) -> tuple[list[dict], str | None, str]:
    try:
        from faster_whisper import WhisperModel
    except ImportError as error:
        raise RuntimeError("当前分析环境缺少 faster-whisper，请先准备歌词对齐环境。") from error
    model_directory = os.path.join(model_root, model_name)
    local_only = os.path.isdir(model_directory) and any(Path(model_directory).iterdir())
    emit_progress(0.06, f"正在载入 {model_name} 语音识别模型…")
    device = "cuda" if requested_device == "cuda" else "cpu"
    try:
        model = WhisperModel(
            model_directory if local_only else model_name,
            device=device,
            compute_type="float16" if device == "cuda" else "int8",
            download_root=model_root,
            local_files_only=local_only,
        )
    except Exception:
        if device != "cuda":
            raise
        emit_progress(0.08, "CUDA 语音识别初始化失败，已自动回退到 CPU。")
        device = "cpu"
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
        # Sung and quiet syllables can be rejected by speech VAD. The input is
        # already the selected vocal stem, so preserve the whole recording.
        vad_filter=False,
        condition_on_previous_text=False,
    )
    tokens = []
    for segment in stream:
        if segment.words:
            for word in segment.words:
                probability = getattr(word, "probability", None)
                tokens.extend(split_asr_word(word.word, float(word.start), float(word.end), float(probability) if probability is not None else None))
        else:
            # Whisper sometimes supplies segment text without word timings.
            fallback = [unit for unit in text_units(segment.text or "") if unit["key"]]
            start = float(segment.start or 0)
            end = max(start + 0.05, float(segment.end or start + 0.05))
            for index, unit in enumerate(fallback):
                tokens.append({
                    "key": unit["key"], "text": unit["text"],
                    "start": start + (end - start) * index / len(fallback),
                    "end": start + (end - start) * (index + 1) / len(fallback),
                })
    return tokens, getattr(info, "language", language), device


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("audio")
    parser.add_argument("--lyrics", required=True)
    parser.add_argument("--output", required=True)
    parser.add_argument("--model", default="small")
    parser.add_argument("--language", default="zh")
    parser.add_argument("--model-root", required=True)
    parser.add_argument("--device", choices=("cpu", "cuda"), default="cpu")
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
        device = "test"
    else:
        recognized, detected_language, device = transcribe(args.audio, args.model, args.language, args.model_root, args.device)
    if not recognized:
        raise RuntimeError("没有从人声音轨中识别到可用于对齐的歌词。")
    emit_progress(0.86, "正在把识别时间戳匹配到输入歌词…")
    result = align_segments(segments, recognized, duration, vocal_activity(args.audio, payload.get("pitchPoints")))
    result["asrTokens"] = recognized
    result.update({"model": args.model, "language": detected_language, "device": device, "source": "faster-whisper-monotonic-text-alignment"})
    Path(args.output).parent.mkdir(parents=True, exist_ok=True)
    Path(args.output).write_text(json.dumps(result, ensure_ascii=False, indent=2), encoding="utf-8")
    emit_progress(1.0, f"对齐完成，歌词匹配覆盖率 {result['coverage'] * 100:.1f}%")


if __name__ == "__main__":
    try:
        main()
    except Exception as error:
        print(f"PITCHORD_ERROR|{error}", file=sys.stderr, flush=True)
        raise
