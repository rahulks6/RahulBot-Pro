# AI Story Studio worker image (Phase 2: mock models, no weights, no CUDA base yet).
# The cloud GPU image is Dockerfile.cuda (Phase 5).
FROM python:3.11-slim

RUN apt-get update \
 && apt-get install -y --no-install-recommends ffmpeg \
 && rm -rf /var/lib/apt/lists/*

RUN useradd --create-home --uid 10001 worker
WORKDIR /app
COPY requirements.txt .
RUN pip install --no-cache-dir -r requirements.txt
COPY ais_worker ./ais_worker

ENV WORKER_HOST=0.0.0.0 \
    WORKER_PORT=8765 \
    WORKER_DATA_DIR=/data \
    WORKER_MOCK_MODELS=true \
    PYTHONUNBUFFERED=1
RUN mkdir -p /data && chown worker:worker /data
USER worker
VOLUME ["/data"]
EXPOSE 8765

# /health needs no token; every other endpoint requires WORKER_AUTH_TOKEN (passed at run time, never baked in).
HEALTHCHECK --interval=30s --timeout=5s --retries=3 \
  CMD python -c "import urllib.request,sys; sys.exit(0 if urllib.request.urlopen('http://127.0.0.1:8765/health', timeout=4).status == 200 else 1)"

CMD ["uvicorn", "ais_worker.fastapi_app:app", "--host", "0.0.0.0", "--port", "8765", "--no-server-header"]
