# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## Project Overview

SpeakSlice is a FREE, CPU-first speaker diarization and transcription service. It takes audio files (mp3/mp4/wav) and returns:
- Speaker diarization segments with timestamps (SPEAKER_00, SPEAKER_01, etc.)
- Word-level transcripts with confidence scores
- Per-segment transcripts aligned to speakers

**Key constraint**: Must remain free and CPU-optimized. No paid services or GPU requirements.

## Architecture

### Core Design Principle: TypeScript Orchestrates, Python Scripts Execute

This is NOT a microservices architecture. It's a single-process Hono API that spawns Python CLI scripts per request.

**TypeScript Layer (Bun + Hono)**:
- `src/server.ts` - Hono API server that orchestrates the pipeline
- Handles HTTP requests, file uploads, preprocessing (ffmpeg)
- Spawns Python scripts via `child_process.spawn()`
- Aligns ASR words to diarization segments
- Returns unified JSON response

**Python Layer (CLI Scripts)**:
- `src/scripts/diarize.py` - Pyannote-based diarization, outputs JSON to stdout
- `src/scripts/transcribe.py` - Faster-whisper ASR, outputs JSON to stdout
- `src/scripts/download_youtube.py` - yt-dlp wrapper for YouTube downloads with time cropping
- All scripts are stateless: read args, write JSON to stdout
- No FastAPI, no HTTP servers, no network calls between components

**Communication Flow**:
```
Client → Hono API → ffmpeg (preprocess) → spawn diarize.py + transcribe.py (parallel)
                                        ↓
                                   parse stdout → align → return JSON
```

### Why This Architecture?

- **Simplicity**: No microservices, no HTTP overhead, no docker-compose orchestration
- **Free**: CPU-only inference with pyannote.audio and faster-whisper
- **Testable**: Python scripts can be tested independently: `python scripts/diarize.py audio.wav`
- **Parallel**: Both ASR and diarization run concurrently via `Promise.all()`

## Testing

### Unit Tests
Use Bun's built-in test runner for all TypeScript/JavaScript tests:
```bash
# Run all tests
bun test

# Watch mode
bun test --watch
```

Tests should be colocated with source files or in a `test/` directory using `.test.ts` suffix.

### Python Script Tests
Test Python scripts independently:
```bash
# Generate test audio
ffmpeg -f lavfi -i "sine=frequency=1000:duration=5" -ac 1 -ar 16000 test.wav

# Test diarization
python src/scripts/diarize.py test.wav --max-speakers 2

# Test transcription
python src/scripts/transcribe.py test.wav --model tiny

# Test YouTube download (requires yt-dlp CLI installed)
python src/scripts/download_youtube.py "https://youtube.com/watch?v=VIDEO_ID" \
  --output test.wav \
  --start "0:30" \
  --end "1:45"
```

### E2E Testing
Use the built-in web UI at `/app` for manual E2E testing:
1. Start server: `bun run dev`
2. Open browser: `http://localhost:8000/app`
3. Upload audio file and verify results

## Development Commands

### Local Development
```bash
# Create virtual environment (uv is faster than venv)
uv venv

# Activate virtual environment
source .venv/bin/activate  # Unix/macOS
# or .venv\Scripts\activate on Windows

# Install Python dependencies with uv (much faster than pip)
uv pip install -r requirements.txt

# Install Bun dependencies
bun install

# Create .env file with HF token (required for pyannote)
cp .env.example .env
# Edit .env and set HF_TOKEN=your_token_here
# IMPORTANT: Accept BOTH model licenses on HuggingFace:
#   1. https://huggingface.co/pyannote/speaker-diarization-3.1
#   2. https://huggingface.co/pyannote/segmentation-3.0

# Run server (automatically loads .env)
bun run dev
```

### Docker
```bash
# Create .env file with HF token (required)
cp .env.example .env
# Edit .env and set HF_TOKEN=your_token_here
# IMPORTANT: Accept BOTH model licenses on HuggingFace:
#   1. https://huggingface.co/pyannote/speaker-diarization-3.1
#   2. https://huggingface.co/pyannote/segmentation-3.0

# Build and run (docker-compose reads .env automatically)
docker compose up --build

# Or standalone
docker build -t speakslice .
docker run -p 8000:8000 -v $(pwd)/cache:/root/.cache -e HF_TOKEN=$HF_TOKEN speakslice
```

### Testing Endpoints
```bash
# Health check
curl http://localhost:8000/v1/health

# Process audio
curl -X POST http://localhost:8000/v1/process \
  -F "file=@audio.mp4" \
  -F "asr_model=medium" \
  -F "language=auto"
```

## Implementation Guidelines

### Web UI Endpoint

The `/app` endpoint returns HTML with inline Tailwind v4 styling (via CDN):
- Use `c.html()` from Hono to return HTML strings
- Include Tailwind v4: `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>`
- Keep UI simple and functional (no complex JavaScript frameworks)
- Use fetch API to call `/v1/process` endpoint
- Display results in a readable format with speaker segmentation

### Python Scripts Must Follow This Pattern

All Python scripts output JSON to stdout and errors to stderr:

```python
#!/usr/bin/env python3
import sys
import json
import argparse

def main():
    parser = argparse.ArgumentParser()
    parser.add_argument("wav_path")
    # ... other args
    args = parser.parse_args()

    # Do work
    result = process(args.wav_path)

    # Output to stdout only
    print(json.dumps(result))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
```

### TypeScript Script Spawning Pattern

Use this pattern for calling Python scripts:

```typescript
async function callPythonScript(
  scriptPath: string,
  args: string[]
): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON_BIN, [scriptPath, ...args]);
    let stdout = "";
    let stderr = "";

    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("close", (code) => {
      if (code !== 0) {
        reject(new Error(`Script failed: ${stderr}`));
      } else {
        try {
          resolve(JSON.parse(stdout));
        } catch (e) {
          reject(new Error(`Failed to parse output: ${e}`));
        }
      }
    });
  });
}
```

### Parallel Processing

ASR and diarization both depend on the preprocessed WAV file but are independent of each other. Always run them in parallel:

```typescript
const [diarSegments, asrResult] = await Promise.all([
  callDiarizationScript(wavPath, opts),
  transcribeWithWhisper(wavPath, opts),
]);
```

### File Handling

- All temporary files go in OS temp directory: `os.tmpdir()`
- Clean up temp files in `finally` blocks
- Preprocessed audio must be: mono, 16kHz, WAV format (use ffmpeg)

### YouTube Download Script (download_youtube.py)

Optional utility script for downloading YouTube audio/video with time-based cropping:

**Features**:
- yt-dlp wrapper with security validation (no shell injection)
- Time-based cropping using ffmpeg (supports SS, MM:SS, HH:MM:SS formats)
- Input validation (YouTube URL format, time ranges, paths)
- Dependency checking (validates yt-dlp and ffmpeg are installed)
- Outputs JSON to stdout with metadata

**Usage Pattern**:
```python
# Download full audio as WAV
python src/scripts/download_youtube.py "URL" --output file.wav

# Download audio segment (cropped)
python src/scripts/download_youtube.py "URL" --output clip.wav --start "1:30" --end "3:45"

# Download video segment
python src/scripts/download_youtube.py "URL" --output clip.mp4 --format video --start "90" --end "225"
```

**Security Notes**:
- Uses subprocess.run() with explicit args (no shell=True)
- Validates YouTube URL format before execution
- Sanitizes file paths using Path.resolve()
- Sets timeouts to prevent hanging downloads

## Dependencies

**Python** (CPU-optimized):
- `pyannote.audio==3.1.1` - Speaker diarization
- `faster-whisper==1.0.3` - ASR with word timestamps
- `torch==2.4.0` - CPU inference only
- `uv` - Fast Python package manager (Rust-based, much faster than pip)

**TypeScript**:
- `hono` - API framework
- `nanoid` - Request IDs
- Bun runtime (includes Node.js APIs)

**System**:
- `ffmpeg` - Audio preprocessing and video processing
- `python3` - Script execution
- `yt-dlp` - (Optional) YouTube download for download_youtube.py script

## Response Format

All `/v1/process` responses follow this structure:

```typescript
{
  file: string,
  duration_sec: number,
  sample_rate: 16000,
  diarization: {
    segments: [{ start, end, speaker, has_overlap }]
  },
  asr: {
    language: string,
    words: [{ start, end, text, confidence }],
    segments: [{ start, end, text, avg_confidence }]
  },
  aligned: {
    speaker_segments: [{ start, end, speaker, text, words }]
  },
  meta: {
    models: { diarization, asr },
    timings_ms: { ... }
  }
}
```

## Constraints

- File size limit: 2GB
- Duration limit: 2 hours
- CPU-only inference (no GPU dependencies)
- No paid APIs or services
- Models cached after first run (mount `/root/.cache` volume)

## Project Structure

```
speakslice/
├── src/
│   ├── server.ts              # Hono API with /app UI and /v1 endpoints
│   ├── server.test.ts         # Bun unit tests for alignment logic
│   └── scripts/
│       ├── diarize.py         # Diarization CLI script (pyannote)
│       ├── transcribe.py      # ASR CLI script (faster-whisper)
│       └── download_youtube.py # YouTube download utility (yt-dlp wrapper)
├── specs/
│   └── prd.md                 # Product requirements document
├── test/
│   ├── fixtures/              # Test audio files (gitignored)
│   └── scripts/               # Test scripts
├── tsconfig.json              # TS config
├── package.json               # Bun dependencies + test scripts
├── requirements.txt           # Python dependencies
├── Dockerfile                 # Single container with Bun + Python
├── docker-compose.yml         # Optional compose config
├── cache/                     # Model cache (mounted volume)
└── CLAUDE.md                  # Development guidelines
```
