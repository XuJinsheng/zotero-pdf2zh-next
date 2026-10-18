from __future__ import annotations

import json
import unittest
from unittest.mock import patch

import httpx
import openai

import test_openai_protocols as protocols
from test_openai_protocols import responses_body, chat_body
from pdf2zh_next.translator.translator_impl.openai import OpenAITranslator
from pdf2zh_next.translator.utils import get_rate_limiter, get_term_translator
from pdf2zh_next_service import configure_request_retries


def chat_chunk(content=None, finish=None, usage=None):
    return {
        "id": "test", "object": "chat.completion.chunk", "created": 0, "model": "test",
        "choices": [{"index": 0, "delta": {"content": content}, "finish_reason": finish}],
        "usage": usage,
    }


def events(service):
    if service == "openai":
        return [
            {"type": "response.output_text.delta", "delta": "discard this", "output_index": 0,
             "content_index": 0, "item_id": "test", "sequence_number": 0},
            {"type": "response.completed", "response": responses_body(), "sequence_number": 1},
        ]
    return [
        {**chat_chunk(), "choices": []},
        chat_chunk(" 译"), chat_chunk("文 "), chat_chunk(finish="stop"),
        {**chat_chunk(usage=chat_body()["usage"]), "choices": []},
    ]


class SSEStream(httpx.SyncByteStream):
    def __init__(self, items, failure=None):
        self.items = items
        self.failure = failure
        self.closed = False

    def __iter__(self):
        for item in self.items:
            yield f"data: {json.dumps(item)}\n\n".encode()
        if self.failure:
            raise self.failure
        yield b"data: [DONE]\n\n"

    def close(self):
        self.closed = True


class OpenAIStreamingTests(unittest.TestCase):
    settings = protocols.OpenAIProtocolTests.settings
    assert_usage = protocols.OpenAIProtocolTests.assert_usage

    def make_translator(self, service="openai", items=None, failure=None, retry_items=None):
        prefix = "openai" if service == "openai" else "openai_compatible"
        settings = self.settings(service, extra={f"{prefix}_stream": "true"})
        translator = OpenAITranslator(settings, get_rate_limiter(10000))
        translator.client.close()
        self.calls = []
        self.streams = []

        def handle(request):
            self.calls.append(request)
            retrying = len(self.calls) > 1 and retry_items is not None
            stream = SSEStream(retry_items if retrying else (
                events(service) if items is None else items), None if retrying else failure)
            self.streams.append(stream)
            return httpx.Response(200, headers={"content-type": "text/event-stream"}, stream=stream)

        translator.client = openai.OpenAI(
            api_key="test", base_url="https://example.com/v1",
            http_client=httpx.Client(transport=httpx.MockTransport(handle)),
        )
        self.addCleanup(translator.client.close)
        return translator, settings

    def test_both_entrypoints_use_stream_and_record_final_usage(self):
        for service in ("openai", "openaicompatible"):
            for method in ("do_translate", "do_llm_translate"):
                with self.subTest(service=service, method=method):
                    translator, _ = self.make_translator(service)
                    self.assertEqual(getattr(translator, method)("text"), "译文")
                    body = json.loads(self.calls[0].content)
                    self.assertIs(body["stream"], True)
                    if service == "openai":
                        self.assertIs(body["store"], False)
                        self.assertTrue(self.calls[0].url.path.endswith("/responses"))
                    else:
                        self.assertEqual(body["stream_options"], {"include_usage": True})
                        self.assertTrue(self.calls[0].url.path.endswith("/chat/completions"))
                    self.assert_usage(translator)
                    self.assertTrue(all(stream.closed for stream in self.streams))
                    self.assertNotIn("stream", translator.cache.params)

    def test_usage_is_optional(self):
        for service in ("openai", "openaicompatible"):
            items = ([{"type": "response.completed", "response": responses_body(usage=None)}]
                     if service == "openai" else [chat_chunk("译文", "stop")])
            translator, _ = self.make_translator(service, items)
            self.assertEqual(translator.do_llm_translate("text"), "译文")
            self.assertEqual(translator.token_count.value, 0)

    def test_failed_incomplete_empty_and_error_events_close_stream(self):
        cases = [
            ("openai", [{"type": "response.failed", "response": responses_body(status="failed")}]),
            ("openai", [{"type": "response.incomplete", "response": responses_body(status="incomplete")}]),
            ("openai", [{"type": "response.completed", "response": responses_body(output=[])}]),
            ("openai", [{"type": "error", "message": "failure", "code": "server_error", "param": None}]),
            ("openaicompatible", [chat_chunk("partial", "length")]),
            ("openaicompatible", [chat_chunk("", "stop")]),
            ("openaicompatible", [chat_chunk("", "content_filter")]),
        ]
        for service, items in cases:
            with self.subTest(service=service, items=items):
                translator, _ = self.make_translator(service, items)
                with self.assertRaises(ValueError):
                    translator.do_llm_translate("text")
                self.assertEqual(len(self.calls), 1)
                self.assertTrue(self.streams[0].closed)

    def test_missing_terminal_event_and_transport_failure_retry_entire_request(self):
        for service in ("openai", "openaicompatible"):
            for failure in (None, httpx.ReadError("disconnected"), httpx.ReadTimeout("timeout")):
                for method in ("do_translate", "do_llm_translate"):
                    with self.subTest(service=service, failure=failure, method=method):
                        translator, _ = self.make_translator(
                            service, events(service)[:1] if service == "openai" else [chat_chunk("partial")],
                            failure, retry_items=events(service),
                        )
                        configure_request_retries(translator, {"retry_count": 1, "retry_interval": 0})
                        self.assertEqual(getattr(translator, method)("text"), "译文")
                        self.assertEqual(len(self.calls), 2)
                        self.assert_usage(translator)
                        self.assertTrue(all(stream.closed for stream in self.streams))

    def test_zero_retries_rejects_partial_result(self):
        for service in ("openai", "openaicompatible"):
            translator, _ = self.make_translator(service, [])
            configure_request_retries(translator, {"retry_count": 0})
            with self.assertRaises(openai.APIConnectionError):
                translator.do_llm_translate("text")
            self.assertEqual(len(self.calls), 1)
            self.assertTrue(self.streams[0].closed)

    def test_dedicated_terms_and_default_settings(self):
        for service in ("openai", "openaicompatible"):
            translator, settings = self.make_translator(service)
            settings.term_extraction_engine_settings = settings.translate_engine_settings
            with patch("pdf2zh_next.translator.translator_impl.openai.OpenAITranslator", return_value=translator):
                term = get_term_translator(settings)
                self.assertEqual(term.do_llm_translate("Extract terms"), "译文")
            self.assertEqual(len(self.calls), 2)
            self.assertFalse(self.settings(service).translate_engine_settings.openai_stream)


if __name__ == "__main__":
    unittest.main()
