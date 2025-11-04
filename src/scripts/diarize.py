#!/usr/bin/env python3
"""
Diarization CLI script using pyannote.audio.
Purpose: Identifies "who spoke when" by clustering voice embeddings into speaker segments
Usage: python diarize.py <wav_path> [--max-speakers N] [--min-speaker-duration S] [--enable-overlap true/false]
Outputs JSON to stdout: {"segments": [{"start": ..., "end": ..., "speaker": ..., "has_overlap": ...}]}
"""
import sys
import json
import argparse
# pyannote.audio: State-of-the-art speaker diarization using deep learning
# Why: Free, CPU-compatible, pre-trained models with good accuracy on meeting audio
from pyannote.audio import Pipeline


def main():
    # Parse CLI arguments - keeps script testable independently of TypeScript layer
    parser = argparse.ArgumentParser(description="Diarization CLI")
    parser.add_argument("wav_path", help="Path to 16kHz mono WAV file")
    parser.add_argument("--max-speakers", type=int, default=None, help="Max number of speakers")
    parser.add_argument("--min-speaker-duration", type=float, default=0.5, help="Min speaker duration (seconds)")
    parser.add_argument("--enable-overlap", type=str, default="true", help="Enable overlap detection")
    args = parser.parse_args()

    # Load pre-trained pyannote pipeline (downloads model on first run, then caches)
    # Why v3.1: Latest stable version with improved accuracy over v2
    pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1")

    # Configure diarization parameters based on input
    # num_speakers helps when you know speaker count; otherwise auto-detects
    diar_params = {"min_speaker_duration": args.min_speaker_duration}
    if args.max_speakers:
        diar_params["num_speakers"] = args.max_speakers

    # Run diarization inference - CPU-only, returns Annotation object
    diar = pipeline(args.wav_path, **diar_params)

    # Convert pyannote Annotation to simple JSON format for TypeScript parsing
    # itertracks() yields (Segment, track_id, speaker_label) tuples
    segments = []
    for turn, _, speaker in diar.itertracks(yield_label=True):
        segments.append({
            "start": round(turn.start, 3),  # 3 decimals = millisecond precision
            "end": round(turn.end, 3),
            "speaker": speaker,  # e.g., "SPEAKER_00", "SPEAKER_01"
            "has_overlap": False  # pyannote basic doesn't flag overlaps in this output; post-MVP feature
        })

    # Sort chronologically for consistent output order
    segments.sort(key=lambda x: (x["start"], x["end"]))

    # Output JSON to stdout (TypeScript reads this via spawn's stdout pipe)
    # Why stdout: Simple, language-agnostic IPC; no network overhead
    print(json.dumps({"segments": segments}))


if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        # Send errors to stderr (TypeScript captures this separately)
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
