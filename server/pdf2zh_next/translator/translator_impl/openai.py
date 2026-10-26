import logging

import httpx
import openai
from babeldoc.utils.atomic_integer import AtomicInteger
from pdf2zh_next.config.model import SettingsModel
from pdf2zh_next.translator.base_rate_limiter import BaseRateLimiter
from pdf2zh_next.translator.base_translator import BaseTranslator
from tenacity import before_sleep_log
from tenacity import retry
from tenacity import retry_if_exception_type
from tenacity import stop_after_attempt
from tenacity import wait_exponential

logger = logging.getLogger(__name__)


class OpenAITranslator(BaseTranslator):
    # https://github.com/openai/openai-python
    name = "openai"

    def __init__(
        self,
        settings: SettingsModel,
        rate_limiter: BaseRateLimiter,
    ):
        super().__init__(settings, rate_limiter)
        self.api_protocol = settings.translate_engine_settings.openai_api_protocol
        self.stream = settings.translate_engine_settings.openai_stream
        self.add_cache_impact_parameters("api_protocol", self.api_protocol)
        self.timeout = settings.translate_engine_settings.openai_timeout
        self.client = openai.OpenAI(
            base_url=settings.translate_engine_settings.openai_base_url,
            api_key=settings.translate_engine_settings.openai_api_key,
            timeout=float(self.timeout) if self.timeout else openai.NOT_GIVEN,
            http_client=httpx.Client(
                limits=httpx.Limits(
                    max_connections=None, max_keepalive_connections=None
                )
            ),
        )
        self.options = {}
        self.temperature = settings.translate_engine_settings.openai_temperature
        self.reasoning_effort = (
            settings.translate_engine_settings.openai_reasoning_effort
        )
        self.send_temperature = (
            settings.translate_engine_settings.openai_send_temprature
        )
        self.send_reasoning_effort = (
            settings.translate_engine_settings.openai_send_reasoning_effort
        )

        if self.send_temperature and self.temperature:
            self.add_cache_impact_parameters("temperature", self.temperature)
            self.options["temperature"] = float(self.temperature)
        if self.send_reasoning_effort and self.reasoning_effort:
            self.add_cache_impact_parameters("reasoning_effort", self.reasoning_effort)
            if self.api_protocol == "responses":
                self.options["reasoning"] = {"effort": self.reasoning_effort}
            else:
                self.options["reasoning_effort"] = self.reasoning_effort

        self.model = settings.translate_engine_settings.openai_model
        self.add_cache_impact_parameters("model", self.model)
        self.add_cache_impact_parameters("prompt", self.prompt(""))
        self.token_count = AtomicInteger()
        self.prompt_token_count = AtomicInteger()
        self.completion_token_count = AtomicInteger()
        self.cache_hit_prompt_token_count = AtomicInteger()

        self.enable_json_mode = (
            settings.translate_engine_settings.openai_enable_json_mode
        )
        if self.enable_json_mode:
            self.add_cache_impact_parameters("enable_json_mode", self.enable_json_mode)

    @retry(
        retry=retry_if_exception_type(openai.RateLimitError),
        stop=stop_after_attempt(100),
        wait=wait_exponential(multiplier=1, min=1, max=15),
        before_sleep=before_sleep_log(logger, logging.WARNING),
    )
    def do_translate(self, text, rate_limit_params: dict = None) -> str:
        return self._translate_messages(self.prompt(text), rate_limit_params)

    @retry(
        retry=retry_if_exception_type(openai.RateLimitError),
        stop=stop_after_attempt(100),
        wait=wait_exponential(multiplier=1, min=1, max=15),
        before_sleep=before_sleep_log(logger, logging.WARNING),
    )
    def do_llm_translate(self, text, rate_limit_params: dict = None):
        if text is None:
            return None
        return self._translate_messages(
            [{"role": "user", "content": text}], rate_limit_params
        )

    def _translate_messages(self, messages, rate_limit_params):
        options = self.options.copy()
        if (
            self.enable_json_mode
            and rate_limit_params
            and rate_limit_params.get("request_json_mode", False)
        ):
            if self.api_protocol == "responses":
                options["text"] = {"format": {"type": "json_object"}}
            else:
                options["response_format"] = {"type": "json_object"}

        if self.api_protocol == "responses":
            response = self.client.responses.create(
                model=self.model,
                input=messages,
                store=False,
                **({"stream": True} if self.stream else {}),
                **options,
            )
            if self.stream:
                response = self._read_responses_stream(response)
            if response.usage:
                self.token_count.inc(response.usage.total_tokens)
                self.prompt_token_count.inc(response.usage.input_tokens)
                self.completion_token_count.inc(response.usage.output_tokens)
                if response.usage.input_tokens_details:
                    self.cache_hit_prompt_token_count.inc(
                        response.usage.input_tokens_details.cached_tokens
                    )
            if response.status != "completed":
                raise ValueError(
                    f"OpenAI Responses request did not complete: {response.status}; "
                    f"details={response.incomplete_details}; error={response.error}"
                )
            message = self._remove_cot_content(response.output_text.strip()).strip()
            if not message:
                raise ValueError("OpenAI Responses returned no translation text")
            return message

        if self.stream:
            with self.client.chat.completions.create(
                model=self.model,
                messages=messages,
                stream=True,
                stream_options={"include_usage": True},
                **options,
            ) as stream:
                parts = []
                finish_reason = None
                usage = None
                for chunk in self._stream_events(stream):
                    if chunk.usage:
                        usage = chunk.usage
                    for choice in chunk.choices:
                        if choice.index != 0:
                            continue
                        if choice.delta.content:
                            parts.append(choice.delta.content)
                        if choice.finish_reason is not None:
                            finish_reason = choice.finish_reason
                if finish_reason is None:
                    raise openai.APIConnectionError(
                        message="Chat Completions stream ended without a finish reason",
                        request=stream.response.request,
                    )
                if finish_reason != "stop":
                    raise ValueError(
                        f"Chat Completions stream did not complete: {finish_reason}"
                    )
                message = self._remove_cot_content("".join(parts).strip()).strip()
                if not message:
                    raise ValueError("Chat Completions stream returned no translation text")
                self._record_chat_usage(usage)
                return message

        response = self.client.chat.completions.create(
            model=self.model, messages=messages, **options
        )
        self._record_chat_usage(getattr(response, "usage", None))
        message = response.choices[0].message.content.strip()
        message = self._remove_cot_content(message)
        return message

    def _stream_events(self, stream):
        try:
            yield from stream
        except httpx.TransportError as exc:
            raise openai.APIConnectionError(
                message=f"LLM stream disconnected: {exc}",
                request=stream.response.request,
            ) from exc

    def _read_responses_stream(self, stream):
        response = None
        with stream:
            for event in self._stream_events(stream):
                if event.type in (
                    "response.completed", "response.failed", "response.incomplete"
                ):
                    response = event.response
                    break
                if event.type == "error":
                    raise ValueError(f"OpenAI Responses stream error: {event.message}")
            if response is None:
                raise openai.APIConnectionError(
                    message="OpenAI Responses stream ended without a final response",
                    request=stream.response.request,
                )
        return response

    def _record_chat_usage(self, usage):
        try:
            if usage:
                if hasattr(usage, "total_tokens"):
                    self.token_count.inc(usage.total_tokens)
                if hasattr(usage, "prompt_tokens"):
                    self.prompt_token_count.inc(usage.prompt_tokens)
                if hasattr(usage, "completion_tokens"):
                    self.completion_token_count.inc(usage.completion_tokens)
                if hasattr(usage, "prompt_cache_hit_tokens"):
                    self.cache_hit_prompt_token_count.inc(
                        usage.prompt_cache_hit_tokens
                    )
                elif hasattr(usage, "prompt_tokens_details") and hasattr(
                    usage.prompt_tokens_details, "cached_tokens"
                ):
                    self.cache_hit_prompt_token_count.inc(
                        usage.prompt_tokens_details.cached_tokens
                    )
        except Exception as e:
            logger.error(f"Error getting token usage: {e}")
            pass
