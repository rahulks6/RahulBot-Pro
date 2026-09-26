"""Model downloads for the Model Manager (run by the app as a separate process).

    python -m ais_worker.download --repo ORG/NAME --cache DIR [--revision main]
        [--allow PATTERN ...] [--ignore PATTERN ...] [--check]

Uses huggingface_hub.snapshot_download, which RESUMES interrupted downloads
(partial files are kept as *.incomplete). ``--check`` compares the installed
revision with the one on Hugging Face (needs network; nothing is downloaded).
The last stdout line is a JSON result; exit codes: 0 ok, 2 usage, 3 gated /
not authorised, 4 not found, 5 network, 6 disk full, 7 missing package,
1 anything else. A Hugging Face token, when needed, comes from HF_TOKEN.
"""

from __future__ import annotations

import argparse
import errno
import json
import os
import sys
from pathlib import Path
from typing import Any

EXIT = {"ok": 0, "usage": 2, "gated": 3, "not_found": 4, "network": 5, "disk_full": 6, "missing_package": 7, "error": 1}


def classify(exc: BaseException) -> tuple[str, str]:
    """(kind, plain-language message) for a download failure."""
    name = type(exc).__name__
    text = str(exc)
    if (isinstance(exc, OSError) and exc.errno == errno.ENOSPC) or "No space left" in text:
        return (
            "disk_full",
            "The disk is full. Free up space or move MODEL_CACHE_PATH to a bigger drive, then press Install again to resume.",
        )
    if name in ("GatedRepoError",) or "gated" in text.lower() or "401" in text or "403" in text:
        return (
            "gated",
            "This model is gated: open its page on huggingface.co, accept the terms, then save a Hugging Face "
            "access token in the Model Manager and press Install again.",
        )
    if name in ("RepositoryNotFoundError", "RevisionNotFoundError", "EntryNotFoundError") or "404" in text:
        return "not_found", "The model repository or revision was not found on Hugging Face (it may have been renamed)."
    if name in ("ConnectionError", "Timeout", "ReadTimeout", "ConnectTimeout", "LocalEntryNotFoundError") or "connection" in text.lower():
        return "network", "Hugging Face could not be reached. Check the internet connection, then press Install again to resume."
    return "error", f"{name}: {text[:300]}"


def main(argv: list[str] | None = None) -> int:
    p = argparse.ArgumentParser(prog="ais_worker.download")
    p.add_argument("--repo", required=True)
    p.add_argument("--cache", required=True)
    p.add_argument("--revision", default="main")
    p.add_argument("--allow", action="append", default=None)
    p.add_argument("--ignore", action="append", default=None)
    p.add_argument("--check", action="store_true")
    try:
        args = p.parse_args(argv)
    except SystemExit:
        return EXIT["usage"]
    if "/" not in args.repo or args.repo.startswith("/") or ".." in args.repo:
        return emit({"ok": False, "kind": "usage", "message": f"invalid repository id {args.repo!r}"})
    # Downloads are the one place network access is allowed (generation runs offline).
    os.environ["HF_HUB_OFFLINE"] = "0"
    os.environ.setdefault("HF_HUB_DISABLE_TELEMETRY", "1")
    try:
        import huggingface_hub as hub  # type: ignore[import-not-found,unused-ignore]
    except ImportError:
        return emit(
            {
                "ok": False,
                "kind": "missing_package",
                "message": "The worker environment has no huggingface_hub. Run the setup program again (or: pip install huggingface_hub).",
            }
        )
    cache = Path(args.cache)
    try:
        cache.mkdir(parents=True, exist_ok=True)
        if args.check:
            remote = hub.HfApi().model_info(args.repo, revision=args.revision).sha
            ref = cache / ("models--" + args.repo.replace("/", "--")) / "refs" / args.revision
            local = ref.read_text().strip() if ref.is_file() else None
            return emit({"ok": True, "remote": remote, "local": local, "update_available": bool(local and remote and local != remote)})
        path = hub.snapshot_download(
            repo_id=args.repo,
            revision=args.revision,
            cache_dir=str(cache),
            allow_patterns=args.allow,
            ignore_patterns=args.ignore,
        )
        return emit({"ok": True, "path": str(path)})
    except BaseException as exc:
        if isinstance(exc, KeyboardInterrupt):
            raise
        kind, message = classify(exc)
        return emit({"ok": False, "kind": kind, "message": message})


def emit(result: dict[str, Any]) -> int:
    print(json.dumps(result), flush=True)
    return EXIT["ok"] if result.get("ok") else EXIT.get(str(result.get("kind")), 1)


if __name__ == "__main__":
    sys.exit(main())
