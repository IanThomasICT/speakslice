# SpeakSlice

CPU-first speaker diarization and transcription service (free, no GPU required)

## Core Capabilities

- **Speaker diarization + ASR**: pyannote (diarization) + faster-whisper (transcription)
- **High performance**: 3-5min for 6min audio (80-90% faster than baseline via distil-whisper + CPU batch optimization)
- **Parallel processing**: ASR and diarization run concurrently
- **YouTube video embedding**: Videos play inline with synchronized transcript highlighting
- **Custom naming**: Name your transcripts for better organization in collections
- **YouTube optimization**: Auto-fetches transcripts + video metadata, skips ASR when available (60% speedup)
- **Output persistence**: All results saved to `cache/YYYYMMDD-HHmm/` with intermediate files
- **Flexible models**: tiny/base/small/medium Whisper variants
- **Web UI**: React + TypeScript interface with hot reloading
- **Docker support**: Single-command deployment

## Architecture

Single-process Hono API (TypeScript/Bun) that spawns Python CLI scripts per request:

```
Client → React UI → Hono API → ffmpeg (preprocess) → spawn diarize.py + transcribe.py (parallel)
                                                    ↓
                                               parse stdout → align → return JSON
```

**Layers:**
- Frontend: React + TypeScript SPA with Tailwind CSS
- TypeScript: Hono API server (orchestration)
- Python: CLI scripts for diarization (pyannote) and ASR (faster-whisper)

**YouTube optimization:** When transcript available → skip ASR → use optimized diarization settings (60% faster)

## Requirements

**Environment:**
- `HF_TOKEN` in `.env` - **BOTH licenses required**:
  - https://huggingface.co/pyannote/speaker-diarization-3.1
  - https://huggingface.co/pyannote/segmentation-3.0
- `YOUTUBE_API_KEY` in `.env` (optional, for video metadata only)

**System:**
- Bun (TypeScript runtime)
- Python 3.10+
- ffmpeg
- uv (Python package manager)

**Setup:**
```bash
cp .env.example .env  # Add HF_TOKEN and optionally YOUTUBE_API_KEY
uv venv && source .venv/bin/activate
uv pip install -r requirements.txt
bun install
bun run dev  # http://localhost:8000
```

**Docker:**
```bash
cp .env.example .env  # Add tokens
docker compose up --build
```

## API Endpoints

### GET /v1/health

```bash
curl http://localhost:8000/v1/health
```

**Response:**
```json
{
  "status": "ok",
  "scripts": {"diarization": "found", "transcription": "found"},
  "models": {"diarization": "pyannote/speaker-diarization-3.1", "asr": "faster-whisper-medium"}
}
```

### POST /v1/process

```bash
curl -X POST http://localhost:8000/v1/process \
  -F "file=@audio.mp4" \
  -F "name=My Interview Recording" \
  -F "asr_model=medium" \
  -F "language=auto" \
  -F "max_speakers=3" \
  -F "min_speaker_duration=0.5" \
  -F "enable_overlap=true"

# Or with YouTube URL
curl -X POST http://localhost:8000/v1/process \
  -F "youtube_url=https://www.youtube.com/watch?v=..." \
  -F "name=Custom Name (optional, auto-fills from video title)" \
  -F "asr_model=medium"
```

**Parameters:**
- `file` (one of file/youtube_url required): Audio file (mp3/mp4/wav, max 2GB)
- `youtube_url` (one of file/youtube_url required): YouTube video URL
- `name` (optional): Custom name for this transcript (auto-fills from YouTube title if not provided)
- `asr_model` (optional): "tiny", "base", "small", "medium" (default: "medium")
- `language` (optional): ISO code or "auto" (default: "auto")
- `max_speakers` (optional): Maximum speakers to detect
- `min_speaker_duration` (optional): Min segment duration in seconds (default: 0.5)
- `enable_overlap` (optional): Enable overlap detection (default: true)

**Response Schema:**
```json
{
  "file": "audio.mp4",
  "name": "My Interview Recording",
  "youtube_url": "https://www.youtube.com/watch?v=..." or null,
  "duration_sec": 120.5,
  "sample_rate": 16000,
  "diarization": {
    "segments": [{"start": 0.5, "end": 5.2, "speaker": "SPEAKER_00", "has_overlap": false}]
  },
  "asr": {
    "language": "en",
    "words": [{"start": 0.5, "end": 0.8, "text": "Hello", "confidence": 0.98}],
    "segments": [{"start": 0.5, "end": 5.2, "text": "Hello, how are you?", "avg_confidence": 0.95}]
  },
  "aligned": {
    "speaker_segments": [
      {"start": 0.5, "end": 5.2, "speaker": "SPEAKER_00", "text": "Hello, how are you?", "words": [...]}
    ]
  },
  "meta": {
    "models": {"diarization": "pyannote/speaker-diarization-3.1", "asr": "whisper-medium"}
  }
}
```

**Output Persistence:**

All outputs saved to timestamped directories: `cache/YYYYMMDD-HHmm/`

Files:
- `audio.wav` - Preprocessed audio (16kHz mono WAV)
- `diarization.json` - Speaker segments
- `asr.json` - Transcription with words and segments
- `aligned.json` - Speaker-aligned transcript
- `response.json` - Complete API response (includes `name`, `youtube_url`, `speaker_names`)
- `transcript.json` - YouTube transcript (only for YouTube URLs with auto-captions)

## Performance

**Processing Speed (6-minute audio):**
- Baseline: 40-50 minutes total
- Optimized: 3-5 minutes total (80-90% faster)
  - ASR: 2-3 minutes (0.3-0.5x real-time)
  - Diarization: 1-2 minutes (1.5-2x real-time)

**YouTube with transcript:**
- Standard: ~230s
- Optimized: ~90s (60% faster)

**Optimizations:**
- ASR: Fast mode (`beam_size=1`), distil-whisper models, CPU thread optimization
- Diarization: Batch size 32 (vs 1-4 default), explicit CPU config
- YouTube: Skip ASR when transcript available, optimized diarization settings

**Debug mode:** `bun run dev:debug` enables detailed logging:
- File upload details
- `[PROGRESS]` messages from Python scripts
- `[TIMING]` logs (model load, inference)
- Cache persistence locations
- Pipeline stage progress (0-100%)

## YouTube Pipeline Optimization

**When transcript available:**
1. Fetch auto-generated transcript via yt-dlp
2. Skip ASR processing (saves 2-3 minutes)
3. Use optimized diarization settings:
   - `min_speaker_duration: 1.0` (vs 0.5 default)
   - `enable_overlap: false` (vs true default)
   - `batch_size: 64` (vs 32 default)

**Limitations:**
- Only works with videos that have auto-generated captions
- Transcript accuracy depends on YouTube's quality
- Word timestamps evenly distributed (not exact speech timing)

**Implementation:** See `loadTranscriptAsASR()` and `OPTIMIZED_DIARIZATION_OPTIONS` in src/server.ts

## Project Structure

```
speakslice/
├── src/
│   ├── app.tsx                # React UI (all components in one file)
│   ├── index.html             # HTML shell with live reload script
│   ├── server.ts              # Hono API with /app and /v1 endpoints
│   ├── server.test.ts         # Bun unit tests
│   ├── assets/                # SVG icons (play, pause, save, loader, upload)
│   └── scripts/
│       ├── diarize.py         # Diarization CLI script (pyannote)
│       ├── transcribe.py      # ASR CLI script (faster-whisper)
│       └── download_youtube.py # YouTube download utility (yt-dlp)
├── public/
│   └── app.js                 # Built React bundle (auto-generated)
├── specs/
│   ├── embed-youtube-video-and-name.md  # YouTube embedding feature spec
│   └── youtube-transcript-integration.md # YouTube transcript optimization spec
├── test/                      # Test fixtures
├── tsconfig.json             # TypeScript config (with React JSX)
├── eslint.config.js          # ESLint config (React + TypeScript)
├── package.json              # Bun dependencies
├── requirements.txt          # Python dependencies
├── Dockerfile                # Single container with Bun + Python
├── docker-compose.yml        # Docker compose config
├── cache/                    # Output persistence + model cache
│   ├── YYYYMMDD-HHmm/        # Timestamped output directories
│   │   ├── audio.wav         # Preprocessed audio (16kHz mono WAV)
│   │   ├── diarization.json  # Speaker diarization output
│   │   ├── asr.json          # Transcription output
│   │   ├── aligned.json      # Speaker-aligned transcript
│   │   └── response.json     # Complete API response (includes speaker_names)
│   └── hub/                   # HuggingFace model cache
├── CLAUDE.md                 # Development guidelines
└── README.md                 # This file
```

**Note:** `cache/` serves dual purposes - model cache (`hub/`) and output persistence (`YYYYMMDD-HHmm/`)

## Dependencies

**Python (CPU-optimized):**
- `pyannote.audio==3.3.2` - Speaker diarization
- `faster-whisper==1.0.3` - ASR with word timestamps
- `torch==2.4.0` - CPU inference only
- `huggingface-hub<1.0.0` - Pinned for pyannote compatibility
- `uv` - Fast Python package manager

**TypeScript/React:**
- `hono` - API framework
- `react` + `react-dom` - UI framework
- `nanoid` - Request IDs
- `eslint` + TypeScript plugins - Code quality
- Bun runtime (includes Node.js APIs + bundler)

**System:**
- `ffmpeg` - Audio preprocessing
- `python3` - Script execution

## Constraints

- File size limit: 2GB
- Duration limit: 2 hours
- CPU-only inference (no GPU dependencies)
- No paid APIs or services
- Models cached after first run

## UI Architecture

Single-file React app (`src/app.tsx`, ~1100 lines) with all components colocated.

**Component Hierarchy:**
```
App
├── Header
├── TabNavigation
├── UploadTab (when activeTab === 'upload')
│   └── (file input, YouTube URL, custom name field, options form)
├── CollectionsTab (when activeTab === 'collections')
│   └── (grid of collection cards with custom names and YouTube badges)
└── ResultsDisplay (when currentData exists)
    ├── MediaPlayer (unified video/audio player)
    │   ├── (YouTube iframe player OR audio element)
    │   └── (sticky controls with Intersection Observer)
    └── TranscriptSegment (map over segments)
        └── (color-coded speaker snippets)
```

**MediaPlayer** — unified video/audio player:
- Supports both YouTube videos (via YouTube IFrame API) and audio files
- Conditionally renders YouTube iframe OR audio element based on `youtubeUrl` prop
- YouTube player: Initializes with `window.YT.Player`, tracks time via 100ms interval
- Audio player: Standard HTML5 `<audio>` element with `timeupdate` events
- Sticky component using Intersection Observer + `useEffect`
- Contains: play/pause, time scrubber, playback speed (1x/1.25x/1.5x/2x), save button
- Props: `collectionId`, `youtubeUrl`, `segments`, `onSaveNames`, `onSeek`, `onSegmentChange`

**TranscriptSegment** — individual speaker snippets:
- Color-coded left borders (`SPEAKER_COLORS` constant supports 10 speakers)
- Interactive: hover (border expands, background fills), click-to-seek, double-click to rename
- Props: `segment`, `colors`, `speakerName`, `isActive`, callbacks

**State Management:** Simple `useState` hooks (no Redux/Context). Props drilling for 1-2 levels max. Callbacks for child → parent communication.

**Styling:** Tailwind v4 via CDN in `src/index.html`. No CSS files — all styles via className.

## Web UI

Access at `http://localhost:8000/app`

**Features:**
- Two-tab interface: Upload (process new files) + Collections (browse previous)
- Drag-and-drop file upload (MP3/MP4/WAV, max 2GB) OR YouTube URL input
- Custom naming: Name your transcripts for better organization (auto-fills from YouTube titles)
- YouTube video embedding: Videos play inline with synchronized transcript highlighting
- Live processing status with animated loader
- Speaker-segmented transcript with color coding
- Interactive: click segments to seek video/audio, double-click speaker names to rename
- Smart media player: YouTube iframe for videos, audio player for files
- Playback speed control (1x/1.25x/1.5x/2x) for both video and audio
- Collection cards with custom names and YouTube badges
- Persistent storage in `cache/` directory

## Development

See [CLAUDE.md](./CLAUDE.md) for development guidelines, code patterns, and testing procedures.

**Quick commands:**
```bash
bun run dev         # Start with hot reload
bun run dev:debug   # With detailed logging
bun run build       # Build React bundle
bun run lint        # Run ESLint
bun test            # Run unit tests
```
