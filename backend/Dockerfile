FROM python:3.13-slim AS builder

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

FROM python:3.13-slim AS runtime

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

# Preserve existing data roots while keeping compatibility with older chroma_data config.
RUN mkdir -p /data/db /data/chroma /data/chroma_data

RUN python -c "import chromadb, grpc, httptools, onnxruntime, tokenizers, uvloop; import app.main"

EXPOSE 18927

HEALTHCHECK --interval=30s --timeout=10s --retries=3 --start-period=15s \
    CMD python -c "import httpx; r = httpx.get('http://localhost:18927/'); r.raise_for_status()"

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "18927"]
