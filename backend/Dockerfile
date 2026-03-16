FROM python:3.13-slim

WORKDIR /app

# System deps for building wheels
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ && \
    rm -rf /var/lib/apt/lists/*

# Copy app code before install so the package metadata and sources stay in sync.
COPY . .
RUN pip install --no-cache-dir .

# Create data directories
RUN mkdir -p /data

ENV DATABASE_URL=sqlite:////data/swarmoracle.db
ENV CHROMA_PERSIST_DIR=/data/chroma_data
ENV HOST=0.0.0.0
ENV PORT=18927

EXPOSE 18927

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "18927"]
