"""Text generation with an open instruction-tuned LLM (story writing).

Runs a Hugging Face ``transformers`` chat model (default: Qwen2.5-7B-Instruct, Apache-2.0) on the
GPU. The prompt goes through the model's own chat template; the answer is written to
``text.json`` as ``{"text": ..., "tokens": ...}``. Sampling is seeded, generation stops between
tokens when the job is cancelled, and progress is the share of ``max_new_tokens`` produced.
The app validates what comes back (and asks again with the problems listed when it is not valid);
nothing here pretends the text is correct.
"""

from __future__ import annotations

import contextlib
import json
from typing import Any

from ..catalog import CatalogEntry
from ..jobs import JobContext, JobError
from ..models.base import Model
from ..schemas import TextRequest
from ..vram import release_cuda_memory
from .common import cuda_available, info_from, require, torch_dtype, track_vram

JSON_HINT = (
    "Answer with ONE JSON object only: no explanation before or after it, no Markdown code fences, double quotes for every key and string."
)


class TransformersLlm(Model[TextRequest]):
    def __init__(self, entry: CatalogEntry, cache_dir: Any = None) -> None:
        super().__init__()
        self.entry = entry
        self.cache_dir = cache_dir
        self.info = info_from(entry, "cuda")
        self.tokenizer: Any = None
        self.model: Any = None

    def load(self, ctx: JobContext) -> None:
        torch = require("torch")
        transformers = require("transformers")
        if not cuda_available(torch):
            raise JobError("CUDA_UNAVAILABLE", f"{self.entry.id} needs an NVIDIA GPU with CUDA (none is usable here).")
        repo = self.entry.repo
        kwargs: dict[str, Any] = {"revision": self.entry.revision or None}
        if self.cache_dir:
            kwargs["cache_dir"] = str(self.cache_dir)
        ctx.log(f"loading {repo}")
        try:
            self.tokenizer = transformers.AutoTokenizer.from_pretrained(repo, **kwargs)
            self.model = transformers.AutoModelForCausalLM.from_pretrained(
                repo, torch_dtype=torch_dtype(torch, str(self.entry.params.get("dtype", "bfloat16"))), device_map="cuda", **kwargs
            )
        except OSError as exc:
            raise JobError("MODEL_NOT_INSTALLED", f"{repo} could not be loaded: {exc}") from exc
        self.model.eval()
        self.loaded = True

    def unload(self) -> None:
        self.model = None
        self.tokenizer = None
        self.loaded = False
        with contextlib.suppress(JobError):
            release_cuda_memory(require("torch"))

    def run(self, request: TextRequest, ctx: JobContext) -> None:
        torch = require("torch")
        transformers = require("transformers")
        ctx.set_status("running", f"{self.entry.id} writing (up to {request.max_new_tokens} tokens)")
        system = request.system + (("\n\n" + JSON_HINT) if request.json else "")
        messages = [{"role": "system", "content": system}, {"role": "user", "content": request.prompt}]
        prompt = self.tokenizer.apply_chat_template(messages, tokenize=False, add_generation_prompt=True)
        inputs = self.tokenizer(prompt, return_tensors="pt").to(self.model.device)
        start = inputs["input_ids"].shape[-1]
        limit = min(request.max_new_tokens, int(self.entry.params.get("max_new_tokens", 8192)))

        class Stop(transformers.StoppingCriteria):  # type: ignore[misc,name-defined]
            """Cancellation between tokens, and progress = tokens produced / limit."""

            def __call__(self, input_ids: Any, scores: Any, **kwargs: Any) -> bool:
                ctx.check()
                ctx.job.progress = min(0.99, (input_ids.shape[-1] - start) / max(1, limit))
                return False

        torch.manual_seed(request.seed)
        sample = request.temperature > 0
        with track_vram(torch, ctx), torch.inference_mode():
            out = self.model.generate(
                **inputs,
                max_new_tokens=limit,
                do_sample=sample,
                temperature=request.temperature if sample else None,
                top_p=float(self.entry.params.get("top_p", 0.9)) if sample else None,
                stopping_criteria=transformers.StoppingCriteriaList([Stop()]),
                pad_token_id=self.tokenizer.eos_token_id,
            )
        tokens = out[0][start:]
        text = self.tokenizer.decode(tokens, skip_special_tokens=True).strip()
        ctx.job.details["text"] = {"tokens": int(tokens.shape[-1]), "hit_limit": int(tokens.shape[-1]) >= limit}
        ctx.path("text.json").write_text(json.dumps({"text": text, "tokens": int(tokens.shape[-1])}))
        ctx.add_output("text.json", "application/json")
