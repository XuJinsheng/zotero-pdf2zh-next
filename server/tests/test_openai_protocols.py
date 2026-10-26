from __future__ import annotations

import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch

import httpx
import openai

sys.path.insert(0, str(Path(__file__).resolve().parents[1]))

from pdf2zh_next.config.model import SettingsModel
from pdf2zh_next.config import translate_engine_model as engines
from pdf2zh_next.translator.translator_impl.openai import OpenAITranslator
from pdf2zh_next.translator.utils import get_rate_limiter, get_term_translator
from pdf2zh_next_service import create_runtime_settings


def responses_body(**overrides):
    return {
        "status": "completed",
        "output": [{
            "type": "message", "role": "assistant", "status": "completed",
            "content": [{"type": "output_text", "text": " 译文 ", "annotations": []}],
        }],
        "usage": {
            "total_tokens": 15, "input_tokens": 10, "output_tokens": 5,
            "input_tokens_details": {"cached_tokens": 3},
            "output_tokens_details": {"reasoning_tokens": 2},
        },
        **overrides,
    }


def chat_body():
    return {
        "choices": [{"message": {"role": "assistant", "content": " 译文 "}}],
        "usage": {
            "total_tokens": 15, "prompt_tokens": 10, "completion_tokens": 5,
            "prompt_tokens_details": {"cached_tokens": 3},
        },
    }


class OpenAIProtocolTests(unittest.TestCase):
    def settings(self, service="openai", url="https://example.com/v1", extra=None):
        return create_runtime_settings({
            "input_path": "/tmp/paper.pdf", "output_dir": "/tmp/output",
            "output_modes": ["dual"], "source_lang": "en", "target_lang": "zh-CN",
            "service": service,
            "llm_api": {"apiKey": "test", "model": "test", "apiUrl": url,
                        "extraData": extra or {}},
        })

    def make_translator(self, settings, body=None):
        translator = OpenAITranslator(settings, get_rate_limiter(10000))
        translator.client.close()
        self.calls = []

        def handle(request):
            self.calls.append(request)
            response_body = body
            if response_body is None:
                response_body = (responses_body() if request.url.path.endswith("/responses")
                                 else chat_body())
            return httpx.Response(200, json=response_body)

        translator.client = openai.OpenAI(
            api_key="test", base_url=settings.translate_engine_settings.openai_base_url,
            http_client=httpx.Client(transport=httpx.MockTransport(handle)),
        )
        self.addCleanup(translator.client.close)
        return translator

    def assert_usage(self, translator):
        self.assertEqual([
            translator.token_count.value, translator.prompt_token_count.value,
            translator.completion_token_count.value,
            translator.cache_hit_prompt_token_count.value,
        ], [15, 10, 5, 3])

    def test_fixed_routes_for_both_entrypoints_and_full_urls(self):
        for service, suffix in (("openai", "responses"),
                                ("openaicompatible", "chat/completions")):
            for url in ("https://example.com/v1", f" https://example.com/v1/{suffix}/ "):
                for method in ("do_translate", "do_llm_translate"):
                    with self.subTest(service=service, url=url, method=method):
                        translator = self.make_translator(self.settings(service, url))
                        self.assertEqual(getattr(translator, method)("text"), "译文")
                        request = self.calls[0]
                        self.assertEqual(request.url.path, f"/v1/{suffix}")
                        body = json.loads(request.content)
                        key = "input" if service == "openai" else "messages"
                        expected = translator.prompt("text") if method == "do_translate" else [
                            {"role": "user", "content": "text"}]
                        self.assertEqual(body[key], expected)
                        self.assertEqual(body["model"], "test")
                        if service == "openai":
                            self.assertIs(body["store"], False)
                            self.assertNotIn("messages", body)
                        else:
                            self.assertNotIn("store", body)
                            self.assertNotIn("input", body)
                        self.assert_usage(translator)

    def test_reasoning_temperature_and_json_parameters(self):
        for service, prefix in (("openai", "openai"),
                                ("openaicompatible", "openai_compatible")):
            for method in ("do_translate", "do_llm_translate"):
                with self.subTest(service=service, method=method):
                    extra = {
                        f"{prefix}_reasoning_effort": "high",
                        f"{prefix}_send_reasoning_effort": True,
                        f"{prefix}_temperature": "0.5",
                        f"{prefix}_send_temprature" if service == "openai" else
                        f"{prefix}_send_temperature": True,
                        f"{prefix}_enable_json_mode": True,
                    }
                    translator = self.make_translator(self.settings(service, extra=extra))
                    getattr(translator, method)("Return JSON", {"request_json_mode": True})
                    body = json.loads(self.calls[0].content)
                    self.assertEqual(body["temperature"], 0.5)
                    if service == "openai":
                        self.assertEqual(body["reasoning"], {"effort": "high"})
                        self.assertEqual(body["text"], {"format": {"type": "json_object"}})
                        self.assertNotIn("reasoning_effort", body)
                        self.assertNotIn("response_format", body)
                    else:
                        self.assertEqual(body["reasoning_effort"], "high")
                        self.assertEqual(body["response_format"], {"type": "json_object"})
                    getattr(translator, method)("text")
                    body = json.loads(self.calls[1].content)
                    self.assertNotIn("text", body)
                    self.assertNotIn("response_format", body)

    def test_responses_extracts_all_output_text_and_ignores_reasoning(self):
        body = responses_body()
        body["output"].insert(0, {"type": "reasoning", "id": "r1", "summary": []})
        body["output"][1]["content"].append(
            {"type": "output_text", "text": "后续", "annotations": []})
        translator = self.make_translator(self.settings(), body)
        self.assertEqual(translator.do_llm_translate("text"), "译文 后续")

    def test_empty_refused_and_incomplete_responses_raise_without_fallback(self):
        cases = [responses_body(output=[]), responses_body(output=[{
            "type": "message", "role": "assistant", "content": [
                {"type": "refusal", "refusal": "Cannot translate"}]}]),
            responses_body(status="incomplete", incomplete_details={"reason": "max_output_tokens"}),
            responses_body(status="failed", error={"code": "server_error", "message": "failed"}),
        ]
        for body in cases:
            for method in ("do_translate", "do_llm_translate"):
                with self.subTest(status=body["status"], method=method):
                    translator = self.make_translator(self.settings(), body)
                    with self.assertRaisesRegex(ValueError, "no translation text|did not complete"):
                        getattr(translator, method)("text")
                    self.assertEqual(len(self.calls), 1)
                    self.assertEqual(self.calls[0].url.path, "/v1/responses")

    def test_responses_without_usage_and_none_llm_input(self):
        translator = self.make_translator(self.settings(), responses_body(usage=None))
        self.assertIsNone(translator.do_llm_translate(None))
        self.assertEqual(len(self.calls), 0)
        self.assertEqual(translator.do_llm_translate("text"), "译文")
        self.assertEqual(translator.token_count.value, 0)

    def test_all_normalized_services_keep_chat_completions(self):
        configs = [
            engines.DeepSeekSettings(deepseek_api_key="test"),
            engines.ModelScopeSettings(modelscope_api_key="test"),
            engines.ZhipuSettings(zhipu_api_key="test"),
            engines.GeminiSettings(gemini_api_key="test"),
            engines.GrokSettings(grok_api_key="test"),
            engines.GroqSettings(groq_api_key="test"),
            engines.AliyunDashScopeSettings(aliyun_dashscope_api_key="test"),
        ]
        for config in configs:
            for method in ("do_translate", "do_llm_translate"):
                with self.subTest(engine=config.translate_engine_type, method=method):
                    settings = SettingsModel(translate_engine_settings=config)
                    settings.validate_settings()
                    self.assertEqual(settings.translate_engine_settings.openai_api_protocol,
                                     "chat_completions")
                    translator = self.make_translator(settings)
                    self.assertEqual(getattr(translator, method)("text"), "译文")
                    self.assertTrue(self.calls[0].url.path.endswith("/chat/completions"))

    def test_dedicated_term_extraction_preserves_protocol_after_normalization(self):
        for service in ("openai", "openaicompatible"):
            term = (engines.OpenAISettings(openai_api_key="test", openai_base_url="https://example.com/v1/responses")
                    if service == "openai" else engines.OpenAICompatibleSettings(
                        openai_compatible_api_key="test", openai_compatible_base_url="https://example.com/v1"))
            settings = SettingsModel(
                translate_engine_settings=engines.DeepSeekSettings(deepseek_api_key="test"),
                term_extraction_engine_settings=term,
            )
            settings.validate_settings()
            term_settings = settings.model_copy()
            term_settings.translate_engine_settings = settings.term_extraction_engine_settings
            mocked = self.make_translator(term_settings)
            # Exercise the real term factory, including its initial health check.
            with patch("pdf2zh_next.translator.translator_impl.openai.OpenAITranslator", return_value=mocked):
                translator = get_term_translator(settings)
                self.assertEqual(translator.do_llm_translate("Extract terms as JSON"), "译文")
            self.assertEqual(len(self.calls), 2)
            suffix = "/responses" if service == "openai" else "/chat/completions"
            self.assertTrue(all(request.url.path.endswith(suffix) for request in self.calls))

    def test_default_terms_and_cache_identity_follow_protocol(self):
        translators = []
        for service in ("openai", "openaicompatible"):
            settings = self.settings(service)
            self.assertIs(settings.term_extraction_engine_settings, settings.translate_engine_settings)
            translator = self.make_translator(settings)
            self.assertEqual(translator.cache.params["api_protocol"], translator.api_protocol)
            translators.append(translator)
        self.assertNotEqual(translators[0].cache.translate_engine_params,
                            translators[1].cache.translate_engine_params)


if __name__ == "__main__":
    unittest.main()
