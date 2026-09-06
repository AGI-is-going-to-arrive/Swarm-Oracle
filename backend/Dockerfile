FROM python:3.13.12-slim@sha256:f1927c75e81efd1e091dbd64b6c0ecaa5630b38635a3d1c04034ac636e1f94c8 AS python-base

# Share patched tooling so copying builder packages cannot leave the runtime
# base's older pip metadata alongside the upgraded distribution.
RUN python -m pip install --no-cache-dir --only-binary=:all: --upgrade \
    pip==26.2.1 setuptools==83.0.0

FROM python-base AS dependencies

COPY --from=ghcr.io/astral-sh/uv:0.12.7@sha256:95f2aa1fe59274951cfe9b0cbc7972e879ff1004bc8945d130a32eb0dbd85945 /uv /usr/local/bin/uv

WORKDIR /app/backend

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    UV_PROJECT_ENVIRONMENT=/opt/venv \
    UV_PYTHON_DOWNLOADS=never \
    UV_LINK_MODE=copy

COPY backend/pyproject.toml backend/uv.lock /app/backend/
# Wheel-only, hash-checked universal lock: no unpinned compiler/build dependency
# resolution. The pinned slim base already contains libstdc++.so.6.
RUN uv sync --locked --no-dev --no-install-project --no-build --compile-bytecode

FROM dependencies AS builder

COPY backend/app/ /app/backend/app/
COPY backend/alembic/ /app/backend/alembic/
COPY backend/alembic.ini /app/backend/alembic.ini
COPY shared/ /app/shared/

FROM python-base AS runtime

WORKDIR /app/backend

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1 \
    DATABASE_URL=sqlite:////data/swarmoracle.db \
    CHROMA_PERSIST_DIR=/data/chroma_data \
    PATH="/opt/venv/bin:$PATH" \
    HOST=0.0.0.0 \
    PORT=18927

COPY --from=builder /opt/venv /opt/venv
COPY --from=builder /app/backend/app/ /app/backend/app/
COPY --from=builder /app/backend/alembic/ /app/backend/alembic/
COPY --from=builder /app/backend/alembic.ini /app/backend/alembic.ini
COPY --from=builder /app/backend/pyproject.toml /app/backend/pyproject.toml
COPY --from=builder /app/backend/uv.lock /app/backend/uv.lock
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
