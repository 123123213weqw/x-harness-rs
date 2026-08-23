#!/usr/bin/env python3
"""Minimal single-user OpenAI Chat endpoint for the V100 Qwen deployment.

This is a deployment bridge, not part of the Rust Agent loop. It exists for
machines whose current vLLM/PyTorch wheel no longer contains sm_70 kernels.
The Rust Host still talks only to the OpenAI-compatible ModelProvider adapter.
"""

from __future__ import annotations

import argparse
import asyncio
import json
import re
import time
import uuid
from contextlib import asynccontextmanager
from typing import Any

import torch
import uvicorn
from fastapi import FastAPI, HTTPException, Request
from fastapi.responses import JSONResponse, StreamingResponse
from transformers import AutoModelForCausalLM, AutoTokenizer


TOOL_CALL_RE = re.compile(
    r"<tool_call>\s*<function=([^>\n]+)>\s*(.*?)\s*</function>\s*</tool_call>",
    re.DOTALL,
)
PARAMETER_RE = re.compile(
    r"<parameter=([^>\n]+)>\s*(.*?)\s*</parameter>", re.DOTALL
)


class Runtime:
    def __init__(self, model_path: str, served_model: str, context_window: int):
        self.model_path = model_path
        self.served_model = served_model
        self.context_window = context_window
        self.tokenizer = None
        self.model = None
        self.lock = asyncio.Lock()

    def load(self) -> None:
        self.tokenizer = AutoTokenizer.from_pretrained(self.model_path)
        self.model = AutoModelForCausalLM.from_pretrained(
            self.model_path,
            dtype=torch.float16,
            device_map="cuda:0",
            attn_implementation="sdpa",
        )
        self.model.eval()

    def generate(self, body: dict[str, Any]) -> tuple[str, int, int, bool]:
        assert self.tokenizer is not None and self.model is not None
        messages = normalize_messages(body.get("messages"))
        tools = body.get("tools") or None
        inputs = self.tokenizer.apply_chat_template(
            messages,
            tools=tools,
            tokenize=True,
            add_generation_prompt=True,
            return_tensors="pt",
            return_dict=True,
        ).to("cuda")
        input_tokens = int(inputs.input_ids.shape[1])
        requested_output = int(body.get("max_tokens") or 4096)
        max_new_tokens = min(requested_output, self.context_window - input_tokens)
        if max_new_tokens <= 0:
            raise ContextTooLarge(input_tokens, self.context_window)
        temperature = float(body.get("temperature", 0.0) or 0.0)
        generation = {
            "max_new_tokens": max_new_tokens,
            "do_sample": temperature > 0,
            "use_cache": True,
            "pad_token_id": self.tokenizer.eos_token_id,
        }
        if temperature > 0:
            generation["temperature"] = temperature
            if body.get("top_p") is not None:
                generation["top_p"] = float(body["top_p"])
        with torch.inference_mode():
            output = self.model.generate(**inputs, **generation)
        generated = output[0][input_tokens:]
        text = self.tokenizer.decode(generated, skip_special_tokens=True)
        output_tokens = int(generated.shape[0])
        return text, input_tokens, output_tokens, output_tokens >= max_new_tokens


class ContextTooLarge(Exception):
    def __init__(self, prompt_tokens: int, context_window: int):
        self.prompt_tokens = prompt_tokens
        self.context_window = context_window


def normalize_messages(value: Any) -> list[dict[str, Any]]:
    if not isinstance(value, list) or not value:
        raise HTTPException(status_code=400, detail="messages must be a non-empty array")
    messages: list[dict[str, Any]] = []
    for source in value:
        if not isinstance(source, dict):
            raise HTTPException(status_code=400, detail="each message must be an object")
        message = dict(source)
        content = message.get("content")
        if content is None:
            message["content"] = ""
        elif isinstance(content, list):
            message["content"] = "\n".join(
                part.get("text", "")
                for part in content
                if isinstance(part, dict) and part.get("type") == "text"
            )
        calls = message.get("tool_calls")
        if isinstance(calls, list):
            normalized_calls = []
            for call in calls:
                call = dict(call)
                function = dict(call.get("function") or {})
                arguments = function.get("arguments", {})
                if isinstance(arguments, str):
                    try:
                        arguments = json.loads(arguments)
                    except json.JSONDecodeError:
                        arguments = {"raw": arguments}
                function["arguments"] = arguments
                call["function"] = function
                normalized_calls.append(call)
            message["tool_calls"] = normalized_calls
        messages.append(message)
    return messages


def parse_value(text: str) -> Any:
    stripped = text.strip()
    try:
        return json.loads(stripped)
    except json.JSONDecodeError:
        return stripped


def split_generation(text: str) -> tuple[str, str, list[dict[str, Any]]]:
    reasoning = ""
    visible = text
    if "</think>" in visible:
        reasoning, visible = visible.split("</think>", 1)
        reasoning = reasoning.removeprefix("<think>").strip()
        visible = visible.lstrip()
    calls = []
    for index, match in enumerate(TOOL_CALL_RE.finditer(visible)):
        arguments = {
            parameter.group(1).strip(): parse_value(parameter.group(2))
            for parameter in PARAMETER_RE.finditer(match.group(2))
        }
        calls.append(
            {
                "index": index,
                "id": f"call_{uuid.uuid4().hex}",
                "type": "function",
                "function": {
                    "name": match.group(1).strip(),
                    "arguments": json.dumps(arguments, ensure_ascii=False),
                },
            }
        )
    if calls:
        visible = TOOL_CALL_RE.sub("", visible).strip()
    return reasoning, visible, calls


def sse(payload: Any) -> bytes:
    if payload == "[DONE]":
        return b"data: [DONE]\n\n"
    return ("data: " + json.dumps(payload, ensure_ascii=False) + "\n\n").encode()


def chunk(
    request_id: str,
    model: str,
    delta: dict[str, Any],
    finish_reason: str | None = None,
    usage: dict[str, int] | None = None,
) -> dict[str, Any]:
    value: dict[str, Any] = {
        "id": request_id,
        "object": "chat.completion.chunk",
        "created": int(time.time()),
        "model": model,
        "choices": [{"index": 0, "delta": delta, "finish_reason": finish_reason}],
    }
    if usage is not None:
        value["usage"] = usage
    return value


def create_app(runtime: Runtime) -> FastAPI:
    @asynccontextmanager
    async def lifespan(_app: FastAPI):
        await asyncio.to_thread(runtime.load)
        yield

    app = FastAPI(lifespan=lifespan)

    @app.get("/health")
    async def health() -> dict[str, str]:
        return {"status": "ok"}

    @app.get("/v1/models")
    async def models() -> dict[str, Any]:
        return {
            "object": "list",
            "data": [
                {
                    "id": runtime.served_model,
                    "object": "model",
                    "owned_by": "xharness-transformers",
                }
            ],
        }

    @app.post("/v1/chat/completions")
    async def chat(request: Request):
        body = await request.json()
        if body.get("model") not in (runtime.served_model, runtime.model_path):
            raise HTTPException(status_code=404, detail="model is not served")
        if body.get("stream") is False:
            raise HTTPException(status_code=400, detail="only stream=true is supported")

        async def stream():
            request_id = f"chatcmpl-{uuid.uuid4().hex}"
            try:
                async with runtime.lock:
                    text, input_tokens, output_tokens, hit_limit = await asyncio.to_thread(
                        runtime.generate, body
                    )
            except ContextTooLarge as error:
                yield sse(
                    {
                        "error": {
                            "message": (
                                f"request ({error.prompt_tokens} tokens) exceeds the available "
                                f"context size ({error.context_window} tokens)"
                            ),
                            "type": "exceed_context_size_error",
                        }
                    }
                )
                yield sse("[DONE]")
                return
            reasoning, content, calls = split_generation(text)
            yield sse(chunk(request_id, runtime.served_model, {"role": "assistant"}))
            if reasoning:
                yield sse(
                    chunk(
                        request_id,
                        runtime.served_model,
                        {"reasoning_content": reasoning},
                    )
                )
            if content:
                yield sse(
                    chunk(request_id, runtime.served_model, {"content": content})
                )
            for call in calls:
                yield sse(
                    chunk(request_id, runtime.served_model, {"tool_calls": [call]})
                )
            finish = "tool_calls" if calls else ("length" if hit_limit else "stop")
            yield sse(
                chunk(
                    request_id,
                    runtime.served_model,
                    {},
                    finish,
                    {
                        "prompt_tokens": input_tokens,
                        "completion_tokens": output_tokens,
                        "total_tokens": input_tokens + output_tokens,
                    },
                )
            )
            yield sse("[DONE]")

        return StreamingResponse(stream(), media_type="text/event-stream")

    @app.exception_handler(ContextTooLarge)
    async def context_error(_request: Request, error: ContextTooLarge):
        return JSONResponse(
            status_code=400,
            content={
                "error": {
                    "message": (
                        f"request ({error.prompt_tokens} tokens) exceeds the available context "
                        f"size ({error.context_window} tokens)"
                    ),
                    "type": "exceed_context_size_error",
                }
            },
        )

    return app


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--model", required=True)
    parser.add_argument("--served-model", required=True)
    parser.add_argument("--context-window", type=int, default=32768)
    parser.add_argument("--host", default="127.0.0.1")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    runtime = Runtime(args.model, args.served_model, args.context_window)
    uvicorn.run(create_app(runtime), host=args.host, port=args.port, log_level="info")


if __name__ == "__main__":
    main()
