# CLAUDE.md

Development guidelines for SpeakSlice. For project overview, features, architecture, and API documentation, see [README.md](./README.md).

## Quick Commands

```bash
# Setup (first time)
uv venv && source .venv/bin/activate
uv pip install -r requirements.txt
bun install
cp .env.example .env  # Add your HF_TOKEN

# Development
bun run dev         # Start with hot reload (React + server)
bun run dev:debug   # With detailed logging
bun run build       # Build React bundle for production
bun run lint        # Run ESLint on React code

# Testing
bun test                                    # TypeScript tests
python src/scripts/diarize.py audio.wav    # Test diarization
python src/scripts/transcribe.py audio.wav # Test transcription
```

**IMPORTANT**: Accept BOTH HuggingFace model licenses or diarization fails:
- https://huggingface.co/pyannote/speaker-diarization-3.1
- https://huggingface.co/pyannote/segmentation-3.0

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

## React Development Rules

- **Single-file approach**: All components in `src/app.tsx` — do not split unless file exceeds 1500 lines
- **Colocation over separation**: Keep component + logic together
- **Styling**: Tailwind v4 via CDN only. No CSS files.
- **State management**: Simple `useState` hooks only. No Redux/Context.
- **Type safety**: Full TypeScript strict mode. All props and state typed. API response types defined.
- **Global declarations**: `window.YT` for YouTube IFrame API

**Hot Reload Workflow:**
1. Edit `src/app.tsx` → Bun rebuilds bundle (~instant)
2. Browser polls `/public/app.js` every 1s for changes
3. When bundle updates → browser auto-refreshes
4. Edit `src/server.ts` → Bun restarts server (~instant)

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

## Linting & Code Quality

```bash
bun run lint  # Run ESLint on React code
```

- Uses ESLint v9 flat config format (`eslint.config.js`)
- Enforces React best practices and hooks rules
- TypeScript strict type checking
- Bun build will fail on type errors

## Build Process

- Dev: `bun run dev` starts watch mode + server
- Production: `bun run build` creates minified bundle
- Bundle output: `public/app.js` (auto-generated, ~400KB minified)