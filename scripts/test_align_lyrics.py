"""Focused regression tests for reference-text lyric alignment."""

import importlib.util
import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


spec = importlib.util.spec_from_file_location("pitchord_align_lyrics", Path(__file__).with_name("align-lyrics.py"))
aligner = importlib.util.module_from_spec(spec)
spec.loader.exec_module(aligner)


def tokens(text, start, step=0.24):
    units = [unit for unit in aligner.text_units(text) if unit["key"]]
    return [
        {"key": unit["key"], "text": unit["text"], "start": start + index * step, "end": start + (index + 1) * step}
        for index, unit in enumerate(units)
    ]


def lyrics(*texts):
    return [{"id": str(index), "text": text, "start": index * 3, "end": (index + 1) * 3, "chars": []} for index, text in enumerate(texts)]


class ReferenceAlignmentTests(unittest.TestCase):
    def assert_valid(self, result, duration):
        previous = 0
        for line in result["segments"]:
            self.assertGreaterEqual(line["start"], previous)
            self.assertGreater(line["end"], line["start"])
            self.assertLessEqual(line["end"], duration)
            for char in line["chars"]:
                self.assertGreaterEqual(char["start"], line["start"])
                self.assertLessEqual(char["end"], line["end"])
                self.assertGreaterEqual(char["end"], char["start"])
            previous = line["end"]

    def test_missing_middle_line_is_not_squeezed_between_adjacent_asr_words(self):
        reference = lyrics("春天花开", "夜色里想起你的名字", "河流向远方")
        recognized = tokens("春天花开", 1) + tokens("河流向远方", 2)
        result = aligner.align_segments(reference, recognized, 12)
        self.assert_valid(result, 12)
        self.assertGreater(result["segments"][1]["end"] - result["segments"][1]["start"], 1.0)
        self.assertEqual(result["segments"][1]["text"], reference[1]["text"])

    def test_missing_words_within_a_line_receive_usable_character_spans(self):
        reference = lyrics("在遥远的星空下唱歌")
        recognized = tokens("在遥", 1) + tokens("唱歌", 1.5)
        result = aligner.align_segments(reference, recognized, 8)
        self.assert_valid(result, 8)
        middle = result["segments"][0]["chars"][2:8]
        self.assertTrue(all(char["end"] - char["start"] >= 0.059 for char in middle))
        self.assertGreater(result["segments"][0]["end"] - result["segments"][0]["start"], 1.0)

    def test_repeated_chorus_and_punctuation_keep_order_and_bounds(self):
        reference = lyrics("你还记得吗，", "我依然在这里", "你还记得吗，", "我依然在这里")
        recognized = tokens("你还记得吗我依然在这里", 2) + tokens("你还记得吗我依然在这里", 9)
        result = aligner.align_segments(reference, recognized, 16)
        self.assert_valid(result, 16)
        self.assertGreater(result["segments"][2]["start"], result["segments"][0]["end"])
        self.assertEqual(result["segments"][0]["chars"][-1]["text"], "，")

    def test_timed_lrc_hints_disambiguate_repeated_chorus(self):
        reference = [
            {**line, "start": start, "end": start + 5, "timingSource": "lrc"}
            for line, start in zip(lyrics("可惜没如果", "只剩下结果", "可惜没如果", "只剩下结果"), (10, 20, 70, 80))
        ]
        recognized = tokens("可惜如果", 10) + tokens("只剩结果", 20) + tokens("可惜没如果", 70) + tokens("只剩下结果", 80)
        result = aligner.align_segments(reference, recognized, 100)
        self.assert_valid(result, 100)
        self.assertLess(abs(result["segments"][0]["start"] - 10), 4)
        self.assertLess(abs(result["segments"][2]["start"] - 70), 4)
        self.assertGreater(result["coverage"], 0.7)

    def test_plain_reference_text_aligns_repeated_chorus_in_order(self):
        reference = [{**line, "timingSource": "estimated"} for line in lyrics("可惜没如果", "只剩下结果", "可惜没如果", "只剩下结果")]
        recognized = tokens("可惜如果", 10) + tokens("只剩结果", 20) + tokens("可惜没如果", 70) + tokens("只剩下结果", 80)
        result = aligner.align_segments(reference, recognized, 100)
        self.assert_valid(result, 100)
        self.assertLess(abs(result["segments"][0]["start"] - 10), 5)
        self.assertLess(abs(result["segments"][2]["start"] - 70), 5)
        self.assertGreater(result["coverage"], 0.7)

    def test_old_timed_lrc_project_without_source_field_uses_its_timestamps(self):
        reference = [{key: value for key, value in line.items() if key != "timingSource"} for line in [
            {**line, "start": start, "end": start + 5, "timingSource": "lrc"}
            for line, start in zip(lyrics("春风吹过", "夜晚降临"), (15, 60))
        ]]
        self.assertEqual([x.get("timingSource") for x in aligner.alignment_hints(reference, 90)], ["lrc", "lrc"])
        self.assertIs(aligner.alignment_hints(lyrics("春风吹过", "夜晚降临"), 6)[0].get("timingSource"), None)

    def test_unrecognized_reference_stays_spread_over_available_time(self):
        reference = [{**line, "timingSource": "estimated"} for line in lyrics("全都没有识别", "但文字应当保留")]
        recognized = tokens("山川湖海", 4)
        result = aligner.align_segments(reference, recognized, 12)
        self.assert_valid(result, 12)
        self.assertEqual(result["coverage"], 0)
        self.assertTrue(all(line["end"] - line["start"] >= 0.8 for line in result["segments"]))
        self.assertLess(result["segments"][0]["start"], 2)
        self.assertGreater(result["segments"][1]["start"], 5)

    def test_dense_late_matches_stay_inside_the_recording(self):
        reference = lyrics("第一句还没识别到", "第二句只听见末尾", "第三句依旧有声音")
        recognized = tokens("末尾第三句依旧有声音", 8.0, 0.16)
        result = aligner.align_segments(reference, recognized, 10)
        self.assert_valid(result, 10)
        self.assertTrue(all(line["end"] - line["start"] > 0.5 for line in result["segments"]))

    def test_cli_aligns_reference_json_with_mock_asr_tokens(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            source = root / "lyrics.json"
            asr = root / "tokens.json"
            output = root / "aligned.json"
            source.write_text(json.dumps({"segments": lyrics("晨光照进窗口", "晚风吹过城市"), "duration": 12}, ensure_ascii=False), encoding="utf-8")
            asr.write_text(json.dumps(tokens("晨光照进窗口", 1) + tokens("晚风吹过城市", 6), ensure_ascii=False), encoding="utf-8")
            run = subprocess.run([
                sys.executable, str(Path(__file__).with_name("align-lyrics.py")), "unused.wav",
                "--lyrics", str(source), "--tokens", str(asr), "--output", str(output),
                "--model-root", directory,
            ], capture_output=True, text=True)
            self.assertEqual(run.returncode, 0, run.stderr)
            result = json.loads(output.read_text(encoding="utf-8"))
            self.assert_valid(result, 12)
            self.assertEqual([line["text"] for line in result["segments"]], ["晨光照进窗口", "晚风吹过城市"])


if __name__ == "__main__":
    unittest.main()
