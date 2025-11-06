#!/usr/bin/env python3
"""
ASR (Automatic Speech Recognition) CLI script using faster-whisper.
Purpose: Transcribes audio to text with word-level timestamps and confidence scores
Usage: python transcribe.py <wav_path> --model <model_size> [--language <lang>]
Outputs JSON to stdout: {"words": [...], "segments": [...], "language": "..."}
"""
import sys
import json
import argparse
# faster-whisper: Optimized Whisper implementation using CTranslate2 for CPU inference
# Why: 4x faster than OpenAI's Whisper, lower memory usage, same quality
from faster_whisper import WhisperModel


def main():
    # Parse CLI arguments - script is independent, testable without TypeScript
    parser = argparse.ArgumentParser(description="ASR CLI using faster-whisper")
    parser.add_argument("wav_path", help="Path to 16kHz mono WAV file")
    parser.add_argument("--model", default="medium", help="Model size: tiny, base, small, medium, large")
    parser.add_argument("--language", default=None, help="Language code (auto-detect if not specified)")
    args = parser.parse_args()

    # Load Whisper model with CPU-optimized settings
    # int8 quantization: 4x smaller, 2-3x faster, minimal accuracy loss (~1%)
    # Why CPU: Free, no GPU required; sufficient speed for batch processing
    model = WhisperModel(args.model, device="cpu", compute_type="int8")

    # Transcribe audio with word-level timestamps for alignment
    # vad_filter=True: Uses voice activity detection to skip silence (faster + more accurate)
    # word_timestamps=True: Needed to align words with speaker segments
    segments_iter, info = model.transcribe(
        args.wav_path,
        language=args.language,
        word_timestamps=True,
        vad_filter=True,
    )

    # Collect both word-level and segment-level results
    # Why both: Words for alignment to speakers, segments for readability
    words = []
    segments = []

    # Progress tracking to stderr (doesn't interfere with stdout JSON)
    print(f"[PROGRESS] Starting transcription with {args.model} model...", file=sys.stderr, flush=True)
    segment_count = 0

    for seg in segments_iter:
        segment_count += 1
        # Log progress every 10 segments
        if segment_count % 10 == 0:
            print(f"[PROGRESS] Processed {segment_count} segments (current: {seg.start:.1f}s)", file=sys.stderr, flush=True)
        seg_words = []
        if seg.words:
            # Extract each word with timing and confidence (probability score)
            for w in seg.words:
                word_obj = {
                    "start": round(w.start, 3),  # millisecond precision
                    "end": round(w.end, 3),
                    "text": w.word.strip(),  # remove leading/trailing spaces
                    "confidence": round(w.probability, 3) if hasattr(w, "probability") else None,
                }
                words.append(word_obj)
                seg_words.append(word_obj)

        # Segment: sentence/phrase-level text with aggregated confidence
        segments.append({
            "start": round(seg.start, 3),
            "end": round(seg.end, 3),
            "text": seg.text.strip(),
            "avg_confidence": round(sum(w.probability for w in seg.words if hasattr(w, "probability")) / len(seg.words), 3)
                if seg.words else None,
        })

    # Output JSON to stdout for TypeScript to parse
    # Why this format: Provides both granular (words) and readable (segments) data
    print(f"[PROGRESS] Transcription complete: {segment_count} segments, {len(words)} words", file=sys.stderr, flush=True)
    output = {
        "words": words,
        "segments": segments,
        "language": info.language if hasattr(info, "language") else None,
    }
    print(json.dumps(output))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Errors go to stderr, TypeScript captures and reports them
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
