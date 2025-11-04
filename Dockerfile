# syntax=docker/dockerfile:1
# Multi-stage build: Python base + Bun runtime
# Uses uv for 10-100x faster Python package installation

FROM python:3.10-slim as python-base

ENV PYTHONDONTWRITEBYTECODE=1 \
    PYTHONUNBUFFERED=1

# Install system dependencies
RUN apt-get update && apt-get install -y --no-install-recommends \
    ffmpeg \
    libsndfile1 \
    curl \
    ca-certificates \
    unzip \
    && rm -rf /var/lib/apt/lists/*

# Install uv - fast Python package manager (Rust-based)
RUN curl -LsSf https://astral.sh/uv/install.sh | sh
ENV PATH="/root/.cargo/bin:${PATH}"

# Install Bun - fast JavaScript runtime
RUN curl -fsSL https://bun.sh/install | bash
ENV PATH="/root/.bun/bin:${PATH}"

# Install Python dependencies with uv (much faster than pip)
WORKDIR /app
COPY requirements.txt /app/
RUN uv pip install --system -r requirements.txt

# Copy application files
COPY src/ /app/src/
COPY tsconfig.json /app/tsconfig.json
COPY package.json /app/package.json

# Make Python scripts executable
RUN chmod +x /app/src/scripts/*.py

# Install Bun dependencies
RUN bun install

EXPOSE 8000
ENV PORT=8000 \
    ASR_MODEL=medium \
    PYTHON_BIN=python3 \
    DIARIZE_SCRIPT=/app/src/scripts/diarize.py \
    TRANSCRIBE_SCRIPT=/app/src/scripts/transcribe.py

CMD ["bun", "run", "src/server.ts"]
