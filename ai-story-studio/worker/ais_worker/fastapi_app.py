"""FastAPI adapter (production entry point: ``uvicorn ais_worker.fastapi_app:app``).

Delegates every request to ``WorkerAPI`` so behaviour matches the stdlib
server exactly. FastAPI/uvicorn are optional dependencies (requirements.txt);
this module is only imported when they are installed.
"""

from __future__ import annotations

from fastapi import FastAPI, Request
from fastapi.responses import FileResponse, JSONResponse
from fastapi.responses import Response as FastResponse

from . import __version__
from .api import WorkerAPI
from .config import WorkerConfig

config = WorkerConfig.from_env()
api = WorkerAPI(config)
app = FastAPI(title="AI Story Studio worker", version=__version__, docs_url=None, redoc_url=None, openapi_url=None)


@app.on_event("shutdown")
def _shutdown() -> None:
    api.close()


@app.api_route("/{path:path}", methods=["GET", "POST"])
async def dispatch(path: str, request: Request) -> FastResponse:
    body = await request.body()
    headers = {k.lower(): v for k, v in request.headers.items()}
    res = api.handle(request.method, "/" + path, headers, body)
    if res.file is not None:
        return FileResponse(res.file, media_type=res.mime)
    return JSONResponse(res.body or {}, status_code=res.status, headers={"X-Content-Type-Options": "nosniff"})
