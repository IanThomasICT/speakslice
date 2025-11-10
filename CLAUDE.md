# CLAUDE.md

Development guidelines for SpeakSlice. For project overview, features, and API documentation, see [@README.md](./README.md).

## Core Design Principle

**React UI → TypeScript Orchestrates → Python Scripts Execute**

This is NOT a microservices architecture. It's a single-process Hono API that spawns Python CLI scripts per request, with a React frontend for the UI.

- **React Layer** (`src/app.tsx`): Single-file React app with all UI components colocated
- **TypeScript Layer** (`src/server.ts`): Hono API server that orchestrates the pipeline
- **Python Layer** (`src/scripts/*.py`): Stateless CLI scripts that output JSON to stdout
- **Communication**: React → Hono API → spawn processes → parse stdout → return JSON

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

## React Component Architecture

**Single-File Approach** (`src/app.tsx`):
- All components in one file (~700 lines) for simplicity
- No component splitting unless file becomes unmanageable (>1500 lines)
- Colocation over separation (component + logic together)

**Component Hierarchy**:
```
App
├── Header
├── TabNavigation
├── UploadTab (when activeTab === 'upload')
│   └── (file input, YouTube URL, custom name field, options form)
├── CollectionsTab (when activeTab === 'collections')
│   └── (grid of collection cards with custom names and YouTube badges)
└── ResultsDisplay (when currentData exists)
    ├── MediaPlayer (renamed from AudioPlayer)
    │   ├── (YouTube iframe player OR audio element)
    │   └── (sticky controls with Intersection Observer)
    └── TranscriptSegment (map over segments)
        └── (color-coded speaker snippets)
```

**Component Nomenclature**:

**MediaPlayer** (unified video/audio player):
- Supports both YouTube videos (via YouTube IFrame API) and audio files
- Conditionally renders YouTube iframe OR audio element based on `youtubeUrl` prop
- YouTube player: Initializes with `window.YT.Player`, tracks time via 100ms interval
- Audio player: Standard HTML5 `<audio>` element with `timeupdate` events
- Sticky component using Intersection Observer + `useEffect`
- Contains: play/pause, time scrubber, playback speed (1x/1.25x/1.5x/2x), save button
- Sticky behavior: Applies `rounded-xl`, `shadow-xl`, `top-3`, `mx-4` when sentinel out of view
- Uses `useRef` for audio element, YouTube player, sentinel, and player container
- Props: `collectionId`, `youtubeUrl`, `segments`, `onSaveNames`, `onSeek`, `onSegmentChange`

**TranscriptSegment** (speaker snippets):
- Individual speaker segments with color-coded left borders
- Interactive: hover (border expands, background fills), click-to-seek, double-click to rename
- Color-coded via `SPEAKER_COLORS` constant (10 speakers supported)
- Receives props: `segment`, `colors`, `speakerName`, `isActive`, callbacks

**State Management**:
- Simple `useState` hooks (no Redux/Context needed)
- Props drilling for 1-2 levels max
- Callbacks for child → parent communication

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
  - `response.json` - Complete API response (includes `name`, `youtube_url`, `speaker_names`)

### React Development

**Component Structure** (`src/app.tsx` - single file, ~1100 lines):
- All components colocated in one file for simplicity
- Component hierarchy:
  - `App` (root) → `Header`, `TabNavigation`, `UploadTab`/`CollectionsTab`, `ResultsDisplay`
  - `UploadTab` → includes custom name field (auto-fills from YouTube video titles)
  - `CollectionsTab` → displays collection cards with custom names and YouTube badges
  - `ResultsDisplay` → `MediaPlayer`, `TranscriptSegment` (repeated)
- State management: Simple `useState` hooks (no Redux/Context)
- Type safety: Full TypeScript with defined types for API responses
- Global declarations: `window.YT` for YouTube IFrame API

**Styling**:
- Use Tailwind v4 via CDN in `src/index.html`
- No CSS files - all styles via className
- Keep components functional and simple

**Hot Reload Workflow**:
1. Edit `src/app.tsx` → Bun rebuilds bundle (~instant)
2. Browser polls `/public/app.js` every 1s for changes
3. When bundle updates → browser auto-refreshes
4. Edit `src/server.ts` → Bun restarts server (~instant)

**Build Process**:
- Dev: `bun run dev` starts watch mode + server
- Production: `bun run build` creates minified bundle
- Bundle output: `public/app.js` (auto-generated, ~400KB minified)

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

### Linting & Code Quality

```bash
bun run lint  # Run ESLint on React code
```

**ESLint Configuration** (`eslint.config.js`):
- Uses ESLint v9 flat config format
- Enforces React best practices and hooks rules
- TypeScript strict type checking
- Catches common errors (unused vars, undefined variables, etc.)

**Type Checking**:
- Full TypeScript strict mode enabled
- All React props and state typed
- API response types defined
- Bun build will fail on type errors

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

## YouTube Optimization

For YouTube URLs, the pipeline intelligently adapts:

**Standard Pipeline:**
```
Download → ASR (2-3 min) → Diarization (1-2 min) → Align
```

**Optimized Pipeline (with transcript):**
```
Download + Transcript → Diarization (optimized, 40-80s) → Align
```

**Optimizations Applied:**
- ASR skipped when transcript available (YouTube auto-captions)
- Transcript converted to ASR-compatible format with word-level timestamps
- Diarization settings optimized for speed:
  - `min_speaker_duration: 1.0` (vs 0.5 default)
  - `enable_overlap: false` (vs true default)
  - `batch_size: 64` (vs 32 default)
- ~60% faster processing overall (90s vs 230s for typical video)

**Implementation:**
- `loadTranscriptAsASR()` (src/server.ts:313) - Converts transcript to ASR format
- `OPTIMIZED_DIARIZATION_OPTIONS` (src/server.ts:67) - Optimized diarization settings
- `/v1/process` endpoint (src/server.ts:687-734) - Conditional ASR skip logic

## Key Files

**Frontend**:
- `src/app.tsx` - React UI (all components colocated, ~1100 lines)
- `src/index.html` - HTML shell with Tailwind CDN + YouTube IFrame API + live reload script
- `public/app.js` - Built React bundle (auto-generated by Bun)
- `eslint.config.js` - ESLint configuration for React + TypeScript

**Backend**:
- `src/server.ts` - Hono API server (serves React app + API endpoints)
- `src/scripts/diarize.py` - Speaker diarization (pyannote)
- `src/scripts/transcribe.py` - ASR (faster-whisper)
- `src/scripts/download_youtube.py` - YouTube download utility

**Assets**:
- `src/assets/*.svg` - UI icons (play, pause, save, loader, upload)

## Constraints

- File size: 2GB max
- Duration: 2 hours max
- CPU-only (no GPU dependencies)
- Free models only (no paid APIs)
- Models cached after first run (`cache/hub/`)
