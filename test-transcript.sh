#!/bin/bash
# Test script for YouTube transcript download
# Benchmarks download with and without --transcript flag

TEST_URL="https://www.youtube.com/watch?v=VUyib5mR8Pg"
OUTPUT_DIR="test-output"
PYTHON_BIN=".venv/bin/python"

# Use system python3 if venv doesn't exist
if [ ! -f "$PYTHON_BIN" ]; then
  PYTHON_BIN="python3"
fi

mkdir -p "$OUTPUT_DIR"

echo "=== Benchmark 1: Download WITHOUT transcript ==="
time $PYTHON_BIN src/scripts/download_youtube.py \
  "$TEST_URL" \
  --output "$OUTPUT_DIR/test-no-transcript.wav" \
  2>&1 | tee "$OUTPUT_DIR/benchmark-no-transcript.log"

echo ""
echo "=== Benchmark 2: Download WITH transcript ==="
time $PYTHON_BIN src/scripts/download_youtube.py \
  "$TEST_URL" \
  --output "$OUTPUT_DIR/test-with-transcript.wav" \
  --transcript \
  2>&1 | tee "$OUTPUT_DIR/benchmark-with-transcript.log"

echo ""
echo "=== Files created ==="
ls -lh "$OUTPUT_DIR/"

echo ""
echo "=== Transcript preview ==="
if [ -f "$OUTPUT_DIR/test-with-transcript.wav.transcript.json" ]; then
  echo "Segments found: $(cat "$OUTPUT_DIR/test-with-transcript.wav.transcript.json" | jq '.segment_count')"
  echo "First 3 segments:"
  cat "$OUTPUT_DIR/test-with-transcript.wav.transcript.json" | jq '.segments[:3]'
fi
