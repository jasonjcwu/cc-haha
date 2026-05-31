#!/usr/bin/env python3

import json
import os
import sys
import unittest
import urllib.error
from io import BytesIO
from unittest.mock import patch

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
from cc_haha_injected import call_anthropic_advisor, parse_cli_stream_json
from prompt_templates import build_official_like_correction_prompt


class ParseCliStreamJsonTest(unittest.TestCase):
    def test_keeps_public_tool_history_and_result_usage(self):
        stdout = "\n".join([
            json.dumps({
                "type": "assistant",
                "message": {"content": [
                    {"type": "thinking", "thinking": "private"},
                    {"type": "text", "text": "Inspecting the file."},
                    {"type": "tool_use", "name": "Bash", "input": {"command": "pytest -q"}},
                ]},
            }),
            json.dumps({
                "type": "user",
                "message": {"content": [
                    {"type": "tool_result", "tool_use_id": "tool-1", "content": "1 failed"},
                ]},
            }),
            json.dumps({
                "type": "result",
                "result": "Done",
                "usage": {"input_tokens": 10, "output_tokens": 2},
                "total_cost_usd": 0.25,
            }),
        ])

        parsed = parse_cli_stream_json(stdout)

        self.assertEqual(parsed["text"], "Done")
        self.assertEqual(parsed["usage"]["input_tokens"], 10)
        self.assertEqual(parsed["total_cost_usd"], 0.25)
        self.assertEqual(parsed["stream_event_count"], 3)
        self.assertIn("[tool_use Bash]", parsed["public_transcript"])
        self.assertIn("pytest -q", parsed["public_transcript"])
        self.assertIn("1 failed", parsed["public_transcript"])
        self.assertNotIn("private", parsed["public_transcript"])

    def test_redacts_likely_credentials(self):
        stdout = "\n".join([
            json.dumps({
                "type": "user",
                "message": {"content": [
                    {
                        "type": "tool_result",
                        "tool_use_id": "tool-1",
                        "content": "API_KEY=visible TOKEN: secret-value",
                    },
                ]},
            }),
            json.dumps({"type": "result", "result": "Done"}),
        ])

        parsed = parse_cli_stream_json(stdout)

        self.assertIn("API_KEY=[REDACTED]", parsed["public_transcript"])
        self.assertIn("TOKEN: [REDACTED]", parsed["public_transcript"])
        self.assertNotIn("visible", parsed["public_transcript"])
        self.assertNotIn("secret-value", parsed["public_transcript"])


class CallAnthropicAdvisorTest(unittest.TestCase):
    @patch("cc_haha_injected.time.sleep")
    @patch("cc_haha_injected.urllib.request.urlopen")
    def test_retries_one_transient_http_error(self, urlopen, sleep):
        error = urllib.error.HTTPError("url", 500, "temporary", {}, BytesIO(b"retry"))
        response = BytesIO(json.dumps({
            "content": [{"type": "text", "text": "Recovered"}],
            "usage": {"input_tokens": 3, "output_tokens": 1},
        }).encode())
        response.__enter__ = lambda value: value
        response.__exit__ = lambda *args: None
        urlopen.side_effect = [error, response]

        result = call_anthropic_advisor(
            {"base_url": "https://example.com", "api_key": "key"},
            "advisor-model",
            "prompt",
        )

        self.assertEqual(result["text"], "Recovered")
        self.assertEqual(urlopen.call_count, 2)
        sleep.assert_called_once_with(1)


class CorrectionPromptTest(unittest.TestCase):
    def test_requires_checklist_resolution_before_finalizing(self):
        prompt = build_official_like_correction_prompt(
            {"repo": "example/repo", "problem_statement": "Fix it"},
            "transcript",
            "advisor feedback",
            1,
            current_diff="diff --git a/a b/a",
        )

        self.assertIn("Mandatory Correction Checkpoint", prompt)
        self.assertIn("Do not finalize yet", prompt)
        self.assertIn("cite concrete repository evidence", prompt)


if __name__ == "__main__":
    unittest.main()
