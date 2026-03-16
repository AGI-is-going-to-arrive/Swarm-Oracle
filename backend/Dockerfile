FROM python:3.13-slim

WORKDIR /app

# System deps for building wheels
RUN apt-get update && apt-get install -y --no-install-recommends \
    gcc g++ && \
    rm -rf /var/lib/apt/lists/*

# Install Python deps
COPY pyproject.toml ./
RUN pip install --no-cache-dir -e ".[dev]" 2>/dev/null || pip install --no-cache-dir .

# Copy app code
COPY . .

# Create data directories
RUN mkdir -p /data

ENV DATABASE_URL=sqlite:////data/swarmoracle.db
ENV CHROMA_PERSIST_DIR=/data/chroma_data
ENV HOST=0.0.0.0
ENV PORT=9527

EXPOSE 9527

CMD ["python", "-m", "uvicorn", "app.main:app", "--host", "0.0.0.0", "--port", "9527"]
