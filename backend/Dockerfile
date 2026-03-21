FROM python:3.13-slim

WORKDIR /app/backend

# System deps for building wheels
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy backend sources and the shared gameplay contract into a repo-like layout.
COPY backend/ /app/backend/
COPY shared/ /app/shared/
RUN pip install --no-cache-dir .

# Create data directories
RUN mkdir -p /data

ENV DATABASE_URL=sqlite:////data/swarmoracle.db
ENV CHROMA_PERSIST_DIR=/data/chroma_data
ENV HOST=0.0.0.0
ENV PORT=18927

EXPOSE 18927

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "18927"]
