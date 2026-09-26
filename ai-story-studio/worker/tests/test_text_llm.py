"""Story writing: /generate/text, the mock text model and the transformers LLM adapter (faked torch)."""

from __future__ import annotations

import json
import sys
import types
from pathlib import Path
from typing import Any

import pytest

from ais_worker.api import WorkerAPI
from ais_worker.schemas import ValidationError, parse_text

from .conftest import make_config, post, wait
from .test_catalog_adapters import entry, write_catalog


def test_parse_text_validates_and_defaults() -> None:
    req = parse_text({"prompt": "Write a story", "json": True}, 1024)
    assert (req.max_new_tokens, req.temperature, req.json) == (2048, 0.7, True)
    with pytest.raises(ValidationError):
        parse_text({"prompt": ""}, 1024)
    with pytest.raises(ValidationError):
        parse_text({"prompt": "x", "max_new_tokens": 99999}, 1024)
    with pytest.raises(ValidationError):
        parse_text({"prompt": "x", "unknown": 1}, 1024)


def test_mock_text_is_labelled_and_never_a_story(api: WorkerAPI) -> None:
    status, job = post(api, "/generate/text", {"prompt": "A fox goes on an adventure", "json": True, "seed": 3})
    assert status == 202
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    assert done["model"]["mock"] is True
    out = json.loads(api.jobs.output_path(job["id"], "text.json").read_text())
    assert out["mock"] is True
    assert json.loads(out["text"])["note"] == "placeholder text, not AI"


class _Tensor:
    def __init__(self, ids: list[int]) -> None:
        self.ids = ids
        self.shape = (1, len(ids))

    def __getitem__(self, i: Any) -> Any:
        if isinstance(i, slice):
            return _Tensor(self.ids[i])
        return self if i == 0 else None

    def to(self, _device: Any) -> _Tensor:
        return self


@pytest.fixture
def fake_llm(monkeypatch: pytest.MonkeyPatch) -> dict[str, Any]:
    seen: dict[str, Any] = {"seeds": []}
    torch = types.ModuleType("torch")
    torch.cuda = types.SimpleNamespace(  # type: ignore[attr-defined]
        is_available=lambda: True,
        reset_peak_memory_stats=lambda: None,
        max_memory_allocated=lambda: 17 * 1024**3,
        empty_cache=lambda: None,
    )
    torch.bfloat16 = "bf16"  # type: ignore[attr-defined]
    torch.manual_seed = lambda s: seen["seeds"].append(s)  # type: ignore[attr-defined]

    class _NoGrad:
        def __enter__(self) -> None:
            return None

        def __exit__(self, *a: Any) -> None:
            return None

    torch.inference_mode = _NoGrad  # type: ignore[attr-defined]
    transformers = types.ModuleType("transformers")

    class StoppingCriteria:
        pass

    transformers.StoppingCriteria = StoppingCriteria  # type: ignore[attr-defined]
    transformers.StoppingCriteriaList = list  # type: ignore[attr-defined]

    class Tokenizer:
        eos_token_id = 0

        def apply_chat_template(self, messages: list[dict[str, str]], **kw: Any) -> str:
            seen["messages"] = messages
            return "PROMPT"

        def __call__(self, prompt: str, return_tensors: str) -> Any:
            ids = _Tensor([1, 2, 3])
            return types.SimpleNamespace(to=lambda d: {"input_ids": ids}, __getitem__=None)

        def decode(self, tokens: _Tensor, skip_special_tokens: bool) -> str:
            return ' {"title": "Milo and the Moon"} '

    class Model:
        device = "cuda"

        def eval(self) -> None:
            return None

        def generate(self, **kw: Any) -> list[_Tensor]:
            seen["generate"] = kw
            for crit in kw["stopping_criteria"]:
                assert crit(_Tensor([1, 2, 3, 4, 5]), None) is False
            return [_Tensor([1, 2, 3, 7, 8, 9])]

    transformers.AutoTokenizer = types.SimpleNamespace(from_pretrained=lambda repo, **kw: Tokenizer())  # type: ignore[attr-defined]

    def load_model(repo: str, **kw: Any) -> Model:
        seen["load"] = {"repo": repo, **kw}
        return Model()

    transformers.AutoModelForCausalLM = types.SimpleNamespace(from_pretrained=load_model)  # type: ignore[attr-defined]
    monkeypatch.setitem(sys.modules, "torch", torch)
    monkeypatch.setitem(sys.modules, "transformers", transformers)
    return seen


def test_llm_uses_the_chat_template_seed_and_json_instruction(tmp_path: Path, fake_llm: dict[str, Any]) -> None:
    cat = write_catalog(
        tmp_path,
        entry(
            id="qwen",
            kind="text",
            adapter="transformers_llm",
            repo="Qwen/Qwen2.5-7B-Instruct",
            min_vram_gb=18,
            params={"dtype": "bfloat16", "max_new_tokens": 4096},
        ),
    )
    api = WorkerAPI(make_config(tmp_path, models_file=cat, mock_models=False))
    _, job = post(
        api,
        "/generate/text",
        {"system": "You write children's stories.", "prompt": "Milo and the moon", "json": True, "seed": 42, "max_new_tokens": 9000},
    )
    done = wait(api, job["id"])
    assert done["status"] == "complete", done
    assert done["model"]["mock"] is False
    assert fake_llm["load"]["repo"] == "Qwen/Qwen2.5-7B-Instruct"
    assert fake_llm["load"]["torch_dtype"] == "bf16"
    system = fake_llm["messages"][0]["content"]
    assert system.startswith("You write children's stories.") and "ONE JSON object" in system
    assert fake_llm["messages"][1] == {"role": "user", "content": "Milo and the moon"}
    assert fake_llm["seeds"] == [42]
    assert fake_llm["generate"]["max_new_tokens"] == 4096, "capped by the catalog"
    out = json.loads(api.jobs.output_path(job["id"], "text.json").read_text())
    assert out == {"text": '{"title": "Milo and the Moon"}', "tokens": 3}
    assert done["details"]["text"] == {"tokens": 3, "hit_limit": False}
    api.close()


def test_llm_without_cuda_is_refused_with_a_reason(tmp_path: Path, fake_llm: dict[str, Any]) -> None:
    sys.modules["torch"].cuda.is_available = lambda: False
    cat = write_catalog(tmp_path, entry(id="qwen", kind="text", adapter="transformers_llm", params={}))
    api = WorkerAPI(make_config(tmp_path, models_file=cat, mock_models=False))
    _, job = post(api, "/generate/text", {"prompt": "hi"})
    err = wait(api, job["id"])["error"]
    assert err["code"] == "CUDA_UNAVAILABLE"
    api.close()
