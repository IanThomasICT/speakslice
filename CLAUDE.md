# CLAUDE.md

Development guidelines for SpeakSlice. For project overview, features, and API documentation, see [@README.md](./README.md).

## Core Design Principle

**TypeScript Orchestrates, Python Scripts Execute**

This is NOT a microservices architecture. It's a single-process Hono API that spawns Python CLI scripts per request.

- **TypeScript Layer** (`src/server.ts`): Hono API server that orchestrates the pipeline
- **Python Layer** (`src/scripts/*.py`): Stateless CLI scripts that output JSON to stdout
- **Communication**: Spawn processes, parse stdout, no HTTP between components

## Quick Commands

```bash
# Setup (first time)
uv venv && source .venv/bin/activate
uv pip install -r requirements.txt
bun install
cp .env.example .env  # Add your HF_TOKEN

# Development
bun run dev         # Normal mode
bun run dev:debug   # With detailed logging

# Testing
bun test                                    # TypeScript tests
python src/scripts/diarize.py audio.wav    # Test diarization
python src/scripts/transcribe.py audio.wav # Test transcription
```

**IMPORTANT**: Accept BOTH HuggingFace model licenses or diarization fails:
- https://huggingface.co/pyannote/speaker-diarization-3.1
- https://huggingface.co/pyannote/segmentation-3.0

## UI Component Nomenclature

Shared vocabulary for discussing the web UI:

**Audio Bar** (sticky player controls):
- Sticky component that stays accessible while scrolling
- Contains: play/pause, time scrubber, playback speed (1x/1.25x/1.5x/2x), save button
- Sticky behavior: Intersection Observer detects scroll, applies `rounded-xl`, `shadow-xl`, `top-3`, `mx-4`
- SVG icons from `src/assets/`: play.svg, pause.svg, save.svg, loader.svg

**Speaker Snippets** (transcript segments):
- Individual speaker segments with color-coded left borders
- Interactive: hover (border expands, background fills), click-to-seek, double-click to rename
- Auto-scroll during playback, active segment highlighted with `bg-blue-50`
- Data attributes: `data-segment-idx`, `data-start-time`

## Code Style Guidelines

### Python Scripts Pattern

All Python scripts MUST follow this pattern:

```python
#!/usr/bin/env python3
import sys
import json

def main():
    # Progress logging to stderr (doesn't interfere with stdout JSON)
    print("[PROGRESS] Starting...", file=sys.stderr, flush=True)

    # Do work
    result = process()

    print("[PROGRESS] Complete", file=sys.stderr, flush=True)

    # Output to stdout ONLY
    print(json.dumps(result))

if __name__ == "__main__":
    try:
        main()
    except Exception as e:
        print(json.dumps({"error": str(e)}), file=sys.stderr)
        sys.exit(1)
```

**Rules**:
- JSON to stdout, errors/progress to stderr
- Use `[PROGRESS]` prefix for progress messages (server captures in debug mode)
- Use `[TIMING]` prefix for timing info
- `flush=True` for real-time updates

### TypeScript Script Spawning Pattern

```typescript
async function callPythonScript(scriptPath: string, args: string[]): Promise<any> {
  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON_BIN, [scriptPath, ...args], { env: process.env });
    let stdout = "", stderr = "";

    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));

    p.on("close", (code) => {
      if (code !== 0) reject(new Error(`Script failed: ${stderr}`));
      else {
        try { resolve(JSON.parse(stdout)); }
        catch (e) { reject(new Error(`Failed to parse: ${e}`)); }
      }
    });
  });
}
```

### Parallel Processing

ASR and diarization are independent. ALWAYS run in parallel:

```typescript
const [diarSegments, asrResult] = await Promise.all([
  callDiarizationScript(wavPath, opts),
  transcribeWithWhisper(wavPath, opts),
]);
```

### File Handling

- Temp files: `os.tmpdir()` (clean up in `finally` blocks)
- Preprocessed audio: mono, 16kHz, WAV format (use ffmpeg)
- Output persistence: `cache/YYYYMMDD-HHmm/` (local timezone)
  - `audio.wav` - Preprocessed audio
  - `diarization.json` - Speaker segments
  - `asr.json` - Transcription
  - `aligned.json` - Speaker-aligned transcript
  - `response.json` - Complete API response (includes `speaker_names`)

### Web UI Styling

- Use Tailwind v4 via CDN: `<script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>`
- SVG icons inline (no emoji)
- Keep UI simple and functional (no complex frameworks)
- Use `c.html()` from Hono for returning HTML

## Testing

### Unit Tests
```bash
bun test          # Run all TypeScript tests
bun test --watch  # Watch mode
```

### Python Scripts
```bash
# Generate test audio
ffmpeg -f lavfi -i "sine=frequency=1000:duration=5" -ac 1 -ar 16000 test.wav

# Test independently
python src/scripts/diarize.py test.wav --max-speakers 2
python src/scripts/transcribe.py test.wav --model tiny
```

### E2E Testing
Use web UI at `http://localhost:8000/app`:
1. Upload audio file
2. Configure options (model, language, speakers)
3. Process and verify results
4. Test interactive features (click-to-seek, speaker renaming)

## Debug Mode

Enable detailed logging:
```bash
bun run dev:debug
```

Shows:
- File upload details
- `[PROGRESS]` messages from Python scripts
- `[TIMING]` logs (model load, inference)
- Cache persistence locations
- Pipeline stage progress (0-100%)

## Performance Notes

**Fast mode** enabled by default for ASR (`--fast` flag):
- `beam_size=1` for faster-whisper (40-50% speedup)
- Distil-Whisper models for small/medium/large (5-6x faster)
- <3% accuracy trade-off (WER increase)

**To disable**: Remove `args.push("--fast")` in `transcribeWithWhisper()` (src/server.ts)

**Diarization**: CPU batch size = 32 (30-40% speedup vs default)

See [@README.md](./README.md#performance) for detailed benchmarks.

## Key Files

- `src/server.ts` - Main API server with web UI
- `src/scripts/diarize.py` - Speaker diarization (pyannote)
- `src/scripts/transcribe.py` - ASR (faster-whisper)
- `src/scripts/download_youtube.py` - YouTube download utility
- `src/assets/*.svg` - UI icons (play, pause, save, loader, upload)

## Constraints

- File size: 2GB max
- Duration: 2 hours max
- CPU-only (no GPU dependencies)
- Free models only (no paid APIs)
- Models cached after first run (`cache/hub/`)
