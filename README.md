# SpeakSlice

**FREE, CPU-first speaker diarization and transcription service**

SpeakSlice takes audio files (mp3/mp4/wav) and returns:
- Speaker diarization segments with timestamps (SPEAKER_00, SPEAKER_01, etc.)
- Word-level transcripts with confidence scores
- Per-segment transcripts aligned to speakers

## Features

- **Free & CPU-optimized**: No paid services or GPU requirements
- **High-performance**: Optimized for speed with 80-90% faster processing vs baseline
  - 6-min audio: ~3-5 mins total (vs 40-50 mins baseline)
  - Uses distil-whisper models and CPU batch optimization
- **Simple architecture**: Single-process Hono API that spawns Python CLI scripts
- **Parallel processing**: ASR and diarization run concurrently
- **Docker support**: One command to run everything
- **Flexible models**: Choose from tiny/base/small/medium Whisper models
- **Web UI**: Built-in testing interface at `/app` with Tailwind styling
- **YouTube support**: Download and process videos with time-based cropping
- **Progress logging**: Real-time progress updates during transcription and diarization
- **Output persistence**: All outputs saved to `cache/YYYYMMDD-HHmm/` for later analysis

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
- **Hugging Face account** (free) for pyannote model access

### Setup Hugging Face Token (Required)

Pyannote speaker diarization requires a **free** Hugging Face account:

1. **Create free account**: https://huggingface.co/join

2. **Accept model licenses** (one-time) - **BOTH required**:
   - Primary pipeline: https://huggingface.co/pyannote/speaker-diarization-3.1
   - Segmentation model: https://huggingface.co/pyannote/segmentation-3.0
   - Click "Agree and access repository" on BOTH pages
   - ⚠️ **Missing the segmentation license causes**: `'NoneType' object has no attribute 'eval'` error

3. **Create access token**: https://huggingface.co/settings/tokens
   - Click "New token" → "Read" access is sufficient

4. **Create `.env` file**:
   ```bash
   cp .env.example .env
   # Then edit .env and add your token:
   # HF_TOKEN=your_token_here
   ```

**Note**: This is 100% FREE - no paid tier required, just authentication to track license acceptance.

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

# Create .env file with your HF token
cp .env.example .env
# Edit .env and set HF_TOKEN=your_token_here

# Run server
bun run dev
```

### Docker (Recommended)

```bash
# Create .env file with your HF token (docker-compose will use it)
cp .env.example .env
# Edit .env and set HF_TOKEN=your_token_here

# Build and run (docker-compose reads HF_TOKEN from .env)
docker compose up --build

# Server will be available at http://localhost:8000
```

## API Endpoints

### Web UI

Access the testing interface at:
```
http://localhost:8000/app
```

Features:
- File upload (MP3/MP4/WAV)
- Model configuration (ASR model, language, speaker count)
- Live processing status
- Speaker-segmented transcript display
- Raw JSON response viewer

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

**Output Persistence:**
All processing outputs are automatically saved to timestamped directories:
- Location: `cache/YYYYMMDD-HHmm/` (e.g., `cache/20251106-1830/`)
- Files saved:
  - `diarization.json` - Speaker segments
  - `asr.json` - Transcription with words and segments
  - `aligned.json` - Speaker-aligned transcript
  - `response.json` - Complete API response

## Project Structure

```
speakslice/
├── src/
│   ├── server.ts              # Hono API with /app UI and /v1 endpoints
│   ├── server.test.ts         # Bun unit tests
│   └── scripts/
│       ├── diarize.py         # Diarization CLI script
│       ├── transcribe.py      # ASR CLI script
│       └── download_youtube.py # YouTube download utility (yt-dlp)
├── specs/
│   └── prd.md                # Product requirements document
├── test/                      # Test fixtures directory
├── tsconfig.json             # TypeScript config
├── package.json              # Bun dependencies
├── requirements.txt          # Python dependencies
├── Dockerfile                # Single container with Bun + Python
├── docker-compose.yml        # Docker compose config
├── cache/                    # Timestamped output directories (YYYYMMDD-HHmm/)
└── CLAUDE.md                 # Development guidelines
```

**Note**: The `cache/` directory serves dual purposes:
- Model cache: ML models downloaded on first run
- Output persistence: Timestamped directories with processing results

## Dependencies

**Python** (CPU-optimized):
- `pyannote.audio==3.3.2` - Speaker diarization
- `faster-whisper==1.0.3` - ASR with word timestamps
- `torch==2.4.0` - CPU inference only
- `huggingface-hub<1.0.0` - Pinned for pyannote compatibility
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

## Performance

SpeakSlice is optimized for speed while maintaining CPU-only operation:

### Processing Speed (6-minute audio)

**Before optimization:**
- ASR (tiny model): 25-30 minutes
- Diarization: 15-20 minutes
- **Total: 40-50 minutes**

**After optimization:**
- ASR (tiny/medium with distil): 2-3 minutes (0.3-0.5x real-time)
- Diarization: 9-12 minutes (1.5-2x real-time)
- **Total: 3-5 minutes (80-90% faster)**

### Key Optimizations

**ASR (Transcription):**
- Fast mode enabled by default (`beam_size=1`, distil-whisper models)
- CPU thread optimization (uses all available cores)
- 5-6x speedup from distil-whisper for English audio
- <3% accuracy trade-off (Word Error Rate increase)

**Diarization:**
- Increased batch sizes (32 vs 1-4 default)
- Explicit CPU device configuration
- 30-40% speedup with <1% accuracy impact

**Monitoring:** Enable debug mode (`bun run dev:debug`) to see detailed timing logs with `[TIMING]` messages showing model load and inference times.

See [CLAUDE.md](./CLAUDE.md) for detailed performance documentation and how to disable fast mode if needed.

## Development

See [CLAUDE.md](./CLAUDE.md) for detailed development guidelines and architecture documentation.

## Testing

### Web UI (E2E Testing)
The easiest way to test the complete pipeline:

1. Start the server: `bun run dev`
2. Open browser: `http://localhost:8000/app`
3. Upload an audio file and verify results

The web UI provides a complete interface for uploading files, configuring options, and viewing results with speaker-segmented transcripts.

### Unit Tests
Run Bun tests for TypeScript code:

```bash
# Run all tests
bun test

# Watch mode
bun test --watch
```

### Python Script Tests
Test Python scripts independently:

```bash
# Convert audio to 16kHz mono WAV first
ffmpeg -i audio.mp4 -ac 1 -ar 16000 audio.wav

# Test diarization
python src/scripts/diarize.py audio.wav --max-speakers 3

# Test transcription
python src/scripts/transcribe.py audio.wav --model medium

# Test YouTube download (requires yt-dlp and ffmpeg)
python src/scripts/download_youtube.py "https://youtube.com/watch?v=VIDEO_ID" --output test.wav --start "0:30" --end "1:45"
```

## License

MIT
