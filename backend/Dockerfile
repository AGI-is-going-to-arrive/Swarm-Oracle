FROM python:3.13-slim AS python-base

# Share patched tooling so copying builder packages cannot leave the runtime
# base's older pip metadata alongside the upgraded distribution.
RUN python -m pip install --no-cache-dir --only-binary=:all: --upgrade \
    pip==26.2.1 setuptools==83.0.0

FROM python-base AS builder

WORKDIR /app/backend

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    PIP_NO_CACHE_DIR=1

# Build native wheels/dependencies outside the runtime image.
RUN apt-get update && apt-get install -y --no-install-recommends \
    build-essential \
    gcc \
    g++ \
    && rm -rf /var/lib/apt/lists/*

COPY backend/pyproject.toml /app/backend/pyproject.toml
COPY backend/app/ /app/backend/app/
COPY backend/alembic/ /app/backend/alembic/
COPY backend/alembic.ini /app/backend/alembic.ini
COPY shared/ /app/shared/

RUN pip install --no-cache-dir .

FROM python-base AS runtime

WORKDIR /app/backend

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_URL=sqlite:////data/swarmoracle.db \
    CHROMA_PERSIST_DIR=/data/chroma_data \
    HOST=0.0.0.0 \
    PORT=18927

# Keep only shared runtime libraries required by native Python wheels.
RUN apt-get update && apt-get install -y --no-install-recommends \
    libstdc++6 \
    && rm -rf /var/lib/apt/lists/*

COPY --from=builder /usr/local/lib/python3.13/site-packages /usr/local/lib/python3.13/site-packages
COPY --from=builder /usr/local/bin /usr/local/bin
COPY --from=builder /app/backend/app/ /app/backend/app/
COPY --from=builder /app/backend/alembic/ /app/backend/alembic/
COPY --from=builder /app/backend/alembic.ini /app/backend/alembic.ini
COPY --from=builder /app/backend/pyproject.toml /app/backend/pyproject.toml
COPY --from=builder /app/shared/ /app/shared/
COPY packs/ /app/packs/
COPY samples/ /app/samples/

# W-10: provision a non-root runtime user and grant ownership of the data
# roots before a fresh volume is mounted, so the container does not run as
# uid 0. Existing root-owned volumes retain their ownership; upgrade them
# explicitly using the backup-first procedure in deploy/README.md.
RUN useradd --system --uid 1000 --user-group --create-home --shell /usr/sbin/nologin appuser \
    && mkdir -p /data/db /data/chroma /data/chroma_data \
    && chown -R appuser:appuser /app /data

USER appuser

RUN python -c "import chromadb, grpc, httptools, onnxruntime, tokenizers, uvloop; import app.main"

EXPOSE 18927

# W-11: use the stdlib http.client for the healthcheck so the probe does
# not pay the cost of importing httpx (+ its TLS/h2 stack) every 30s.
HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
    CMD python -c "import http.client, sys; c = http.client.HTTPConnection('localhost', 18927, timeout=5); c.request('GET', '/'); r = c.getresponse(); sys.exit(0 if r.status < 400 else 1)"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "18927"]
