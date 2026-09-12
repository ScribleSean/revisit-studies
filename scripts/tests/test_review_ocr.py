import os
from pathlib import Path
import subprocess
import sys
import unittest
from unittest.mock import patch

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))
from review_ocr import extract_ocr, sample_times


class OcrTests(unittest.TestCase):
    def test_sampling_covers_recording_without_seeking_to_eof(self):
        self.assertEqual(sample_times(8), list(range(8)))
        self.assertEqual(sample_times(0.1, 2), [0, 0.05])
        for duration, count in [(0, 8), (float("nan"), 8), (2, 0), (2, 65), (2, True)]:
            with self.assertRaises(ValueError):
                sample_times(duration, count)

    @patch("review_ocr.shutil.which", return_value="tesseract")
    def test_empty_text_is_retained_and_temporary_images_are_removed(self, _):
        paths = []
        def runner(args, **kwargs):
            if args[-1].endswith("frame.png"):
                paths.append(Path(args[-1]))
                paths[-1].write_bytes(b"fixture")
                return subprocess.CompletedProcess(args, 0)
            return subprocess.CompletedProcess(args, 0, stdout="" if len(paths) == 1 else "Submit response\n")
        frames = extract_ocr("video", 4, 2, runner)
        self.assertEqual(frames, [{"index": 0, "timestamp": 0, "text": "", "wordCount": 0}, {"index": 1, "timestamp": 2, "text": "Submit response", "wordCount": 2}])
        self.assertTrue(all(not path.parent.exists() for path in paths))

    @patch("review_ocr.shutil.which", return_value="tesseract")
    def test_failed_decode_cannot_reuse_an_earlier_frame(self, _):
        calls = 0
        def runner(args, **kwargs):
            nonlocal calls
            if args[-1].endswith("frame.png"):
                calls += 1
                if calls == 1:
                    Path(args[-1]).write_bytes(b"fixture")
                return subprocess.CompletedProcess(args, 0)
            return subprocess.CompletedProcess(args, 0, stdout="first")
        with self.assertRaisesRegex(RuntimeError, "decode"):
            extract_ocr("video", 4, 2, runner)

    @patch("review_ocr.shutil.which", return_value=None)
    def test_missing_binary_is_explicit(self, _):
        with self.assertRaisesRegex(RuntimeError, "Tesseract"):
            extract_ocr("video", 4)


if __name__ == "__main__":
    unittest.main()
