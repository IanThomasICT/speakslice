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
import os
import time
# faster-whisper: Optimized Whisper implementation using CTranslate2 for CPU inference
# Why: 4x faster than OpenAI's Whisper, lower memory usage, same quality
from faster_whisper import WhisperModel


def main():
    # Parse CLI arguments - script is independent, testable without TypeScript
    parser = argparse.ArgumentParser(description="ASR CLI using faster-whisper")
    parser.add_argument("wav_path", help="Path to 16kHz mono WAV file")
    parser.add_argument("--model", default="medium", help="Model size: tiny, base, small, medium, large")
    parser.add_argument("--language", default=None, help="Language code (auto-detect if not specified)")
    parser.add_argument("--fast", action="store_true", help="Enable fast mode (beam_size=1, no conditioning, use distil-whisper if available)")
    parser.add_argument("--cpu-threads", type=int, default=0, help="Number of CPU threads (0=auto)")
    args = parser.parse_args()

    # Auto-detect CPU count for threading
    cpu_threads = args.cpu_threads if args.cpu_threads > 0 else (os.cpu_count() or 4)

    # Map standard models to distil variants for speed (English-only)
    # Distil-Whisper is 5-7x faster with minimal accuracy loss (<2% WER increase)
    model_name = args.model
    if args.fast:
        distil_models = {
            "small": "distil-small.en",
            "medium": "distil-medium.en",
            "large": "distil-large-v2"
        }
        if args.model in distil_models:
            model_name = distil_models[args.model]
            if args.language and args.language != "en":
                print("[WARN] Distil models are English-only, using standard model for multilingual",
                      file=sys.stderr, flush=True)
                model_name = args.model

    print(f"[PROGRESS] Using model: {model_name} (fast_mode={args.fast}, cpu_threads={cpu_threads})",
          file=sys.stderr, flush=True)

    # Load Whisper model with CPU-optimized settings
    # int8 quantization: 4x smaller, 2-3x faster, minimal accuracy loss (~1%)
    # Why CPU: Free, no GPU required; sufficient speed for batch processing
    model_load_start = time.time()
    model = WhisperModel(
        model_name,
        device="cpu",
        compute_type="int8",
        cpu_threads=cpu_threads,  # Use all available CPU cores for parallelization
        num_workers=1  # Transcription is sequential, no benefit from multiple workers
    )
    model_load_time = time.time() - model_load_start
    print(f"[TIMING] Model load: {model_load_time:.2f}s", file=sys.stderr, flush=True)

    # Transcribe audio with word-level timestamps for alignment
    # vad_filter=True: Uses voice activity detection to skip silence (faster + more accurate)
    # word_timestamps=True: Needed to align words with speaker segments
    # Speed optimizations (when --fast):
    #   beam_size=1: Critical for faster-whisper performance (40-50% speedup)
    #   best_of=1: Don't generate multiple candidates (saves computation)
    #   temperature=0.0: Deterministic output (no sampling overhead)
    #   condition_on_previous_text=False: Faster but may have more repetitions
    inference_start = time.time()
    segments_iter, info = model.transcribe(
        args.wav_path,
        language=args.language,
        word_timestamps=True,
        vad_filter=True,
        beam_size=1 if args.fast else 5,
        best_of=1 if args.fast else 5,
        temperature=0.0 if args.fast else [0.0, 0.2, 0.4, 0.6, 0.8, 1.0],
        condition_on_previous_text=not args.fast,
    )

    # Collect both word-level and segment-level results
    # Why both: Words for alignment to speakers, segments for readability
    words = []
    segments = []

    # Progress tracking to stderr (doesn't interfere with stdout JSON)
    print(f"[PROGRESS] Starting transcription with {args.model} model...", file=sys.stderr, flush=True)
    segment_count = 0
    last_progress_pct = 0

    for seg in segments_iter:
        segment_count += 1

        # Calculate approximate progress based on audio timestamp
        # Estimate: if we're at timestamp T and total duration is unknown,
        # log progress every 10 segments or when crossing 10% milestones
        if segment_count % 10 == 0:
            print(f"[PROGRESS] Transcribed {segment_count} segments (at {seg.start:.1f}s)", file=sys.stderr, flush=True)
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
    inference_time = time.time() - inference_start
    print(f"[PROGRESS] Transcription complete: {segment_count} segments, {len(words)} words", file=sys.stderr, flush=True)
    print(f"[TIMING] Inference: {inference_time:.2f}s", file=sys.stderr, flush=True)
    print(f"[TIMING] Total: {model_load_time + inference_time:.2f}s", file=sys.stderr, flush=True)
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
