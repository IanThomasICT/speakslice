# SpeakSlice

**FREE, CPU-first speaker diarization and transcription service**

SpeakSlice takes audio files (mp3/mp4/wav) and returns:
- Speaker diarization segments with timestamps (SPEAKER_00, SPEAKER_01, etc.)
- Word-level transcripts with confidence scores
- Per-segment transcripts aligned to speakers

## Features

- **Free & CPU-optimized**: No paid services or GPU requirements
- **Simple architecture**: Single-process Hono API that spawns Python CLI scripts
- **Parallel processing**: ASR and diarization run concurrently
- **Docker support**: One command to run everything
- **Flexible models**: Choose from tiny/base/small/medium Whisper models

## Architecture

This is NOT a microservices architecture. It's a single-process Hono API (TypeScript/Bun) that spawns Python CLI scripts per request:

```
Client → Hono API → ffmpeg (preprocess) → spawn diarize.py + transcribe.py (parallel)
                                        ↓
                                   parse stdout → align → return JSON
```

**TypeScript Layer**: Hono API server that orchestrates the pipeline
**Python Layer**: CLI scripts for diarization (pyannote) and ASR (faster-whisper)

## Quick Start

### Prerequisites

- Bun (for TypeScript runtime)
- Python 3.10+
- ffmpeg
- uv (for Python package management - https://docs.astral.sh/uv/)

### Local Development

```bash
# Create virtual environment
uv venv

# Activate virtual environment
source .venv/bin/activate  # On Unix/macOS
# or
.venv\Scripts\activate  # On Windows

# Install Python dependencies
uv pip install -r requirements.txt

# Install Bun dependencies
bun install

# Run server
bun run dev
```

### Docker (Recommended)

```bash
# Build and run
docker compose up --build

# Server will be available at http://localhost:8000
```

## API Endpoints

### Health Check

```bash
curl http://localhost:8000/v1/health
```

Response:
```json
{
  "status": "ok",
  "scripts": {
    "diarization": "found",
    "transcription": "found"
  },
  "models": {
    "diarization": "pyannote/speaker-diarization-3.1",
    "asr": "faster-whisper-medium"
  }
}
```

### Process Audio

```bash
curl -X POST http://localhost:8000/v1/process \
  -F "file=@audio.mp4" \
  -F "asr_model=medium" \
  -F "language=auto" \
  -F "max_speakers=3" \
  -F "min_speaker_duration=0.5" \
  -F "enable_overlap=true"
```

**Parameters:**
- `file` (required): Audio file (mp3/mp4/wav, max 2GB)
- `asr_model` (optional): Whisper model size - "tiny", "base", "small", "medium" (default: "medium")
- `language` (optional): ISO language code or "auto" (default: "auto")
- `max_speakers` (optional): Maximum number of speakers to detect
- `min_speaker_duration` (optional): Minimum speaker segment duration in seconds (default: 0.5)
- `enable_overlap` (optional): Enable overlap detection (default: true)

**Response:**
```json
{
  "file": "audio.mp4",
  "duration_sec": 120.5,
  "sample_rate": 16000,
  "diarization": {
    "segments": [
      {
        "start": 0.5,
        "end": 5.2,
        "speaker": "SPEAKER_00",
        "has_overlap": false
      }
    ]
  },
  "asr": {
    "language": "en",
    "words": [
      {
        "start": 0.5,
        "end": 0.8,
        "text": "Hello",
        "confidence": 0.98
      }
    ],
    "segments": [
      {
        "start": 0.5,
        "end": 5.2,
        "text": "Hello, how are you?",
        "avg_confidence": 0.95
      }
    ]
  },
  "aligned": {
    "speaker_segments": [
      {
        "start": 0.5,
        "end": 5.2,
        "speaker": "SPEAKER_00",
        "text": "Hello, how are you?",
        "words": [...]
      }
    ]
  },
  "meta": {
    "models": {
      "diarization": "pyannote/speaker-diarization-3.1",
      "asr": "whisper-medium"
    }
  }
}
```

## Project Structure

```
speakslice/
├── src/
│   ├── server.ts              # Hono API (TypeScript/Bun)
│   └── scripts/
│       ├── diarize.py        # Diarization CLI script
│       └── transcribe.py     # ASR CLI script
├── specs/
│   └── prd.md                # Product requirements document
├── tsconfig.json             # TypeScript config
├── package.json              # Bun dependencies
├── requirements.txt          # Python dependencies
├── Dockerfile                # Single container with Bun + Python
├── docker-compose.yml        # Docker compose config
├── cache/                    # Model cache (mounted volume)
└── CLAUDE.md                 # Development guidelines
```

## Dependencies

**Python** (CPU-optimized):
- `pyannote.audio==3.1.1` - Speaker diarization
- `faster-whisper==1.0.3` - ASR with word timestamps
- `torch==2.4.0` - CPU inference only
- `uv` - Fast Python package manager

**TypeScript**:
- `hono` - API framework
- `nanoid` - Request IDs
- Bun runtime (includes Node.js APIs)

**System**:
- `ffmpeg` - Audio preprocessing
- `python3` - Script execution

## Constraints

- File size limit: 2GB
- Duration limit: 2 hours
- CPU-only inference (no GPU dependencies)
- No paid APIs or services
- Models cached after first run

## Development

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines and architecture documentation.

## Testing

Test Python scripts independently:

```bash
# Convert audio to 16kHz mono WAV first
ffmpeg -i audio.mp4 -ac 1 -ar 16000 audio.wav

# Test diarization
python src/scripts/diarize.py audio.wav --max-speakers 3

# Test transcription
python src/scripts/transcribe.py audio.wav --model medium
```

## License

MIT
