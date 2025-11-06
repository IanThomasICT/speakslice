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
import os
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

    # Get Hugging Face token from environment (required for pyannote model access)
    # FREE: Requires free HF account + accepting model license at https://huggingface.co/pyannote/speaker-diarization-3.1
    hf_token = os.getenv("HF_TOKEN")
    if not hf_token:
        raise ValueError(
            "HF_TOKEN environment variable not set. "
            "Get a free token at https://huggingface.co/settings/tokens "
            "and accept the license at https://huggingface.co/pyannote/speaker-diarization-3.1"
        )

    # Progress tracking to stderr (doesn't interfere with stdout JSON)
    print("[PROGRESS] Loading pyannote speaker-diarization-3.1 model...", file=sys.stderr, flush=True)

    # Load pre-trained pyannote pipeline (downloads model on first run, then caches)
    # Why v3.1: Latest stable version with improved accuracy over v2
    # Note: Newer huggingface_hub uses 'token' instead of 'use_auth_token'
    try:
        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", token=hf_token)
    except TypeError:
        # Fallback for older pyannote versions that use 'use_auth_token'
        pipeline = Pipeline.from_pretrained("pyannote/speaker-diarization-3.1", use_auth_token=hf_token)
    except Exception as e:
        # Enhanced error message for common authentication issues
        error_msg = str(e)
        if "NoneType" in error_msg and "eval" in error_msg:
            raise ValueError(
                "Failed to load pyannote models. This usually means you haven't accepted the model licenses.\n"
                "Please accept licenses for BOTH models using your HuggingFace account:\n"
                "  1. https://huggingface.co/pyannote/speaker-diarization-3.1\n"
                "  2. https://huggingface.co/pyannote/segmentation-3.0\n"
                "After accepting, the same HF_TOKEN will work for both models."
            ) from e
        else:
            raise

    # Configure diarization parameters based on input
    # num_speakers: exact count (if known), or min_speakers/max_speakers for bounds
    # Note: min_speaker_duration is NOT a pipeline parameter in pyannote 3.x
    diar_params = {}
    if args.max_speakers:
        diar_params["max_speakers"] = args.max_speakers

    print(f"[PROGRESS] Starting diarization on {args.wav_path}...", file=sys.stderr, flush=True)
    # Run diarization inference - CPU-only, returns Annotation object
    diar = pipeline(args.wav_path, **diar_params)
    print("[PROGRESS] Diarization inference complete, processing segments...", file=sys.stderr, flush=True)

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
