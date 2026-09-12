import json
import sys
import unittest
from pathlib import Path
from unittest.mock import Mock, patch
from types import SimpleNamespace

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from review_timeline import analyze, transcript_events, is_digital_silence


def word(text, start, end):
    return {"word": text, "start": start, "end": end}


class TimelineTests(unittest.TestCase):
    def test_audio_and_ocr_failures_preserve_scene_evidence(self):
        clock = lambda seconds: SimpleNamespace(get_seconds=lambda: seconds)
        detector = SimpleNamespace(ContentDetector=lambda **_: None,
                                   detect=lambda *_: [(clock(0), clock(2)), (clock(2), clock(4))])
        probe = SimpleNamespace(stdout=json.dumps({"format": {"duration": "4"},
                                                  "streams": [{"codec_type": "video"}, {"codec_type": "audio"}]}))
        with patch.dict(sys.modules, {"scenedetect": detector}), \
                patch("review_timeline.subprocess.run", return_value=probe), \
                patch("review_timeline.is_digital_silence", side_effect=RuntimeError("audio decode failed")), \
                patch("review_timeline.extract_ocr", side_effect=RuntimeError("OCR decode failed")):
            result = analyze(Path("clip.mp4"), ["wait"], "unused-models")
        self.assertEqual(result["events"], [{"type": "scene_change", "timestamp": 2,
                                              "evidence": "PySceneDetect content cut"}])
        self.assertEqual(result["ocr"], [])
        self.assertTrue(result["meta"]["audio_skipped"])
        self.assertEqual(result["meta"]["audio_skip_reason"], "audio decode failed")
        self.assertEqual(result["meta"]["ocr_error"], "OCR decode failed")

    def test_scene_failure_preserves_ocr_for_a_recording_without_audio(self):
        detector = SimpleNamespace(ContentDetector=lambda **_: None,
                                   detect=Mock(side_effect=RuntimeError("scene decode failed")))
        probe = SimpleNamespace(stdout=json.dumps({"format": {"duration": "4"},
                                                  "streams": [{"codec_type": "video"}]}))
        frames = [{"timestamp": 1, "text": "Submit response"}]
        with patch.dict(sys.modules, {"scenedetect": detector}), \
                patch("review_timeline.subprocess.run", return_value=probe), \
                patch("review_timeline.extract_ocr", return_value=frames):
            result = analyze(Path("clip.webm"), [], "unused-models")
        self.assertEqual(result["events"], [])
        self.assertEqual(result["ocr"], frames)
        self.assertEqual(result["meta"]["scene_error"], "scene decode failed")
        self.assertEqual(result["meta"]["audio_skip_reason"], "no_audio_stream")

    def test_silence_check_accepts_only_exact_zero_not_quiet_or_missing_measurements(self):
        for peak, expected in [("-inf", True), ("-120.5", False), ("0.0", False), ("nan", False)]:
            with patch("review_timeline.subprocess.run", return_value=SimpleNamespace(stderr=f"Peak level dB: {peak}\n")) as run:
                self.assertEqual(is_digital_silence(Path("clip.mp4")), expected)
                self.assertEqual(run.call_args.kwargs["timeout"], 60)
                self.assertTrue(run.call_args.kwargs["check"])
        with patch("review_timeline.subprocess.run", return_value=SimpleNamespace(stderr="")):
            self.assertFalse(is_digital_silence(Path("clip.mp4")))

    def test_phrase_uses_actual_word_time_and_not_substrings(self):
        segments = [{"words": [word("somewhat", 0, 1), word("not", 4, 4.3), word("sure", 4.4, 5)]}]
        events = transcript_events(segments, [], 10, ["what", "not sure"])
        matches = [e for e in events if e["type"] == "confusion_word"]
        self.assertEqual(matches, [{"type": "confusion_word", "timestamp": 4, "evidence": "Matched: not sure"}])

    def test_word_pause_and_transition_inside_single_segment(self):
        segments = [{"words": [word("a", 0, 1), word("b", 5, 6)]}]
        self.assertEqual([e["type"] for e in transcript_events(segments, [3], 10, [])], ["hesitation", "confused_transition"])
        self.assertEqual([e["type"] for e in transcript_events(segments, [], 10, [])], ["hesitation", "reading"])

    def test_invalid_words_and_empty_input_produce_no_evidence(self):
        self.assertEqual(transcript_events([], [], 10, []), [])
        self.assertEqual(transcript_events([{"words": [word("wait", -1, 2), word("wait", float("nan"), 2), word("wait", 3, 20)]}], [], 10, ["wait"]), [])

    def test_active_interaction_requires_speech_and_scene_activity(self):
        words = [word("a", i / 3, i / 3 + 0.1) for i in range(90)]
        self.assertEqual([e["type"] for e in transcript_events([{"words": words}], [5, 15], 30, [])], ["active_interaction"])
        self.assertEqual(transcript_events([{"words": words}], [], 30, []), [])


if __name__ == "__main__":
    unittest.main()
