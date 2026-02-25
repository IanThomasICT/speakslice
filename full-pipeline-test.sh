#!/bin/bash
# Full pipeline test for YouTube transcript integration
# Tests end-to-end processing with transcript

TEST_URL="https://www.youtube.com/watch?v=VUyib5mR8Pg"
OUTPUT_DIR="test-output"
mkdir -p "$OUTPUT_DIR"

echo "=== Full Pipeline Test with Transcript ==="
echo "Testing URL: $TEST_URL"
echo ""

# Run the full pipeline
time curl -X POST http://localhost:8000/v1/process \
  -F "youtube_url=$TEST_URL" \
  -F "asr_model=tiny" \
  -F "max_speakers=2" \
  > "$OUTPUT_DIR/full-pipeline-result.json" 2>&1

echo ""
echo "=== Processing Result ==="
if [ -f "$OUTPUT_DIR/full-pipeline-result.json" ]; then
  cat "$OUTPUT_DIR/full-pipeline-result.json" | jq '.meta'

  echo ""
  echo "=== Aligned Segments ==="
  echo "Total speaker segments: $(cat "$OUTPUT_DIR/full-pipeline-result.json" | jq '.aligned.speaker_segments | length')"

  echo ""
  echo "=== First Speaker Segment ==="
  cat "$OUTPUT_DIR/full-pipeline-result.json" | jq '.aligned.speaker_segments[0]'

  echo ""
  echo "=== Cache Directory ==="
  # Find the most recent cache directory
  CACHE_DIR=$(ls -td cache/*/ | head -1)
  if [ -d "$CACHE_DIR" ]; then
    echo "Cache location: $CACHE_DIR"
    echo "Files in cache:"
    ls -lh "$CACHE_DIR"

    echo ""
    echo "=== Checking for transcript.json ==="
    if [ -f "${CACHE_DIR}transcript.json" ]; then
      echo "✓ Transcript saved to cache"
      echo "Segment count: $(cat "${CACHE_DIR}transcript.json" | jq '.segment_count')"
    else
      echo "✗ No transcript in cache (fallback to ASR)"
    fi
  fi
else
  echo "Error: No output file generated"
  cat "$OUTPUT_DIR/full-pipeline-result.json" 2>&1 || echo "File not found"
fi
