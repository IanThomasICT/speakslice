// Core imports: Hono for lightweight HTTP routing, Bun for serve() built-in
// nanoid generates unique IDs for temp directories to avoid file conflicts
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serve } from "bun";
import { nanoid } from "nanoid";
// spawn() creates child processes to run Python scripts and capture their output
// fs operations handle file uploads and cleanup
import { spawn } from "node:child_process";
import { createWriteStream, promises as fs } from "node:fs";
import path from "node:path";
import os from "node:os";
import { parseArgs } from "node:util";

// Type definitions for ASR (Automatic Speech Recognition) and diarization outputs
// Word: individual word with timing and confidence from Whisper
type Word = { start: number; end: number; text: string; confidence?: number };
// ASRSeg: sentence-level segments with aggregated confidence scores
type ASRSeg = { start: number; end: number; text: string; avg_confidence?: number };
// DiarSeg: speaker segments from pyannote with overlap detection flag
type DiarSeg = { start: number; end: number; speaker: string; has_overlap: boolean };

// Parse CLI arguments for debug flag
const { values } = parseArgs({
  args: Bun.argv,
  options: {
    debug: { type: "boolean" as const, short: "d", default: false },
  },
  strict: false,
  allowPositionals: true,
});

const DEBUG = values.debug || false;

// Debug logging helper - only outputs when --debug flag is set
// Format: [HH:MM:SS] STAGE: message { metadata }
function debug(stage: string, message: string, meta?: object) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const metaStr = meta ? ' ' + JSON.stringify(meta, null, 2) : '';
  console.log(`[${timestamp}] ${stage}: ${message}${metaStr}`);
}

const app = new Hono();

// Add HTTP request logging middleware (shows METHOD PATH STATUS TIMING)
app.use(logger());

// Configuration: Allow overriding via env vars for flexibility
// Default to "medium" Whisper model for balanced speed/accuracy tradeoff
const ASR_MODEL = process.env.ASR_MODEL || "medium";
const DIARIZE_SCRIPT = process.env.DIARIZE_SCRIPT || "./src/scripts/diarize.py";
const TRANSCRIBE_SCRIPT = process.env.TRANSCRIBE_SCRIPT || "./src/scripts/transcribe.py";
// Use virtual environment Python if it exists, otherwise fall back to system python3
const PYTHON_BIN = process.env.PYTHON_BIN ||
  (await fs.access(".venv/bin/python").then(() => ".venv/bin/python").catch(() => "python3"));

// Convert any audio format to standardized 16kHz mono WAV for ML models
// Why: pyannote and faster-whisper require consistent audio format (16kHz, mono, WAV)
// -ac 1 = mono, -ar 16000 = 16kHz sample rate, pcm_s16le = 16-bit PCM encoding
async function runFfmpegToWav16kMono(src: string, dst: string) {
  const args = ["-y", "-i", src, "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le", dst];
  debug("FFMPEG", "Preprocessing started", { input: path.basename(src), output: path.basename(dst) });
  const start = Date.now();

  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) {
        const elapsed = Date.now() - start;
        debug("FFMPEG", "Preprocessing complete", { elapsed_ms: elapsed });
        resolve();
      } else {
        debug("FFMPEG", "Preprocessing failed", { error: err.substring(0, 200) });
        reject(new Error(err));
      }
    });
  });
}

// Extract audio duration using ffprobe for metadata in response
// Why: Useful for clients to know file length without downloading/parsing entire file
// Returns duration in seconds rounded to 3 decimal places, or null if parsing fails
async function getDurationSec(wavPath: string): Promise<number | null> {
  return new Promise((resolve) => {
    const args = [
      "-v",
      "error",
      "-show_entries",
      "format=duration",
      "-of",
      "default=nw=1:nk=1",
      wavPath,
    ];
    const p = spawn("ffprobe", args);
    let out = "";
    p.stdout.on("data", (d) => (out += d.toString()));
    p.on("close", () => {
      const v = parseFloat(out.trim());
      const duration = Number.isFinite(v) ? Math.round(v * 1000) / 1000 : null;
      debug("FFPROBE", "Duration extracted", { duration_sec: duration });
      resolve(duration);
    });
  });
}

// Spawn Python diarization script (pyannote) and parse JSON output from stdout
// Why: Separation of concerns - Python handles ML inference, TypeScript orchestrates
// Script outputs JSON to stdout for easy parsing; stderr captured for error reporting
async function callDiarizationScript(
  wavPath: string,
  opts: { max_speakers?: number | null; min_speaker_duration?: number; enable_overlap?: boolean }
): Promise<DiarSeg[]> {
  const args = [DIARIZE_SCRIPT, wavPath];
  if (opts.max_speakers != null) args.push("--max-speakers", String(opts.max_speakers));
  if (opts.min_speaker_duration != null) args.push("--min-speaker-duration", String(opts.min_speaker_duration));
  if (opts.enable_overlap != null) args.push("--enable-overlap", String(opts.enable_overlap));

  debug("DIARIZATION", "Spawning script", {
    script: path.basename(DIARIZE_SCRIPT),
    wav: path.basename(wavPath),
    max_speakers: opts.max_speakers,
  });
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON_BIN, args);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      const elapsed = Date.now() - start;
      if (code !== 0) {
        debug("DIARIZATION", "Script failed", { exit_code: code, error: stderr.substring(0, 200) });
        reject(new Error(`Diarization script failed: ${stderr}`));
      } else {
        try {
          const result = JSON.parse(stdout);
          const segments = (result.segments ?? []) as DiarSeg[];
          const speakers = new Set(segments.map(s => s.speaker)).size;
          debug("DIARIZATION", "Complete", {
            segments: segments.length,
            speakers,
            elapsed_ms: elapsed,
          });
          resolve(segments);
        } catch (e) {
          debug("DIARIZATION", "Parse failed", { error: String(e), output_preview: stdout.substring(0, 100) });
          reject(new Error(`Failed to parse diarization output: ${e}`));
        }
      }
    });
  });
}

// Match ASR words to diarization speaker segments based on timestamp overlap
// Why: Combine "who spoke" (diarization) with "what was said" (ASR) for complete transcript
// Uses efficient sliding window approach - maintains pointer to avoid re-scanning words
function alignWordsToDiarization(words: Word[], diar: DiarSeg[]) {
  debug("ALIGN", "Started", { words: words.length, diar_segments: diar.length });
  const start = Date.now();

  const aligned = [];
  let wi = 0; // word index pointer - avoids O(n²) by not re-scanning from start
  for (const seg of diar) {
    const s0 = seg.start;
    const s1 = seg.end;
    const segWords: Word[] = [];
    // Skip words that end before this speaker segment starts
    while (wi < words.length && words[wi].end <= s0) wi++;
    let wj = wi;
    // Collect all words that overlap with this speaker segment
    while (wj < words.length && words[wj].start < s1) {
      const w = words[wj];
      if (w.end > s0 && w.start < s1) segWords.push(w);
      wj++;
    }
    const text = segWords.map((w) => w.text).join(" ").trim();
    aligned.push({
      start: s0,
      end: s1,
      speaker: seg.speaker,
      text,
      words: segWords,
    });
  }

  const elapsed = Date.now() - start;
  debug("ALIGN", "Complete", { speaker_segments: aligned.length, elapsed_ms: elapsed });
  return aligned;
}

// Spawn Python ASR script (faster-whisper) to transcribe audio with word timestamps
// Why: Whisper provides word-level timing + confidence scores; faster-whisper is CPU-optimized
// Returns both word-level (for alignment) and segment-level (for readability) transcripts
async function transcribeWithWhisper(
  wavPath: string,
  opts: { model: string; language?: string | "auto" }
): Promise<{ words: Word[]; segments: ASRSeg[]; language?: string }> {
  const args = [TRANSCRIBE_SCRIPT, wavPath, "--model", opts.model];
  if (opts.language && opts.language !== "auto") args.push("--language", opts.language);

  debug("ASR", "Spawning script", {
    script: path.basename(TRANSCRIBE_SCRIPT),
    wav: path.basename(wavPath),
    model: opts.model,
    language: opts.language,
  });
  const start = Date.now();

  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON_BIN, args);
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => (stderr += d.toString()));
    p.on("close", (code) => {
      const elapsed = Date.now() - start;
      if (code !== 0) {
        debug("ASR", "Script failed", { exit_code: code, error: stderr.substring(0, 200) });
        reject(new Error(`Transcription script failed: ${stderr}`));
      } else {
        try {
          const result = JSON.parse(stdout);
          const words = result.words ?? [];
          const segments = result.segments ?? [];
          debug("ASR", "Complete", {
            words: words.length,
            segments: segments.length,
            language: result.language,
            elapsed_ms: elapsed,
          });
          resolve({
            words,
            segments,
            language: result.language,
          });
        } catch (e) {
          debug("ASR", "Parse failed", { error: String(e), output_preview: stdout.substring(0, 100) });
          reject(new Error(`Failed to parse transcription output: ${e}`));
        }
      }
    });
  });
}

// Web UI for E2E testing - simple HTML interface for uploading and testing
// Why: Manual testing without curl; makes it easy to verify end-to-end flow
// Uses Tailwind v4 CDN for styling without build step
app.get("/app", (c) => {
  return c.html(`<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>SpeakSlice - Audio Diarization & Transcription</title>
  <script src="https://cdn.jsdelivr.net/npm/@tailwindcss/browser@4"></script>
</head>
<body class="bg-gray-50 min-h-screen p-8">
  <div class="max-w-4xl mx-auto">
    <header class="mb-8">
      <h1 class="text-3xl font-bold text-gray-900 mb-2">SpeakSlice</h1>
      <p class="text-gray-600">Free, CPU-first speaker diarization and transcription</p>
    </header>

    <div class="bg-white rounded-lg shadow p-6 mb-6">
      <h2 class="text-xl font-semibold mb-4">Upload Audio</h2>

      <form id="uploadForm" class="space-y-4">
        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">Audio File (MP3/MP4/WAV)</label>
          <input type="file" id="audioFile" accept="audio/*,video/*" required
            class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100">
        </div>

        <div class="grid grid-cols-2 gap-4">
          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">ASR Model</label>
            <select id="asrModel" class="block w-full rounded border-gray-300 shadow-sm">
              <option value="tiny">Tiny (fastest)</option>
              <option value="base">Base</option>
              <option value="small">Small</option>
              <option value="medium" selected>Medium (default)</option>
            </select>
          </div>

          <div>
            <label class="block text-sm font-medium text-gray-700 mb-2">Language</label>
            <select id="language" class="block w-full rounded border-gray-300 shadow-sm">
              <option value="auto">Auto-detect</option>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="zh">Chinese</option>
            </select>
          </div>
        </div>

        <div>
          <label class="block text-sm font-medium text-gray-700 mb-2">Max Speakers (optional)</label>
          <input type="number" id="maxSpeakers" min="1" max="10" placeholder="Auto-detect"
            class="block w-full rounded border-gray-300 shadow-sm">
        </div>

        <button type="submit" id="submitBtn"
          class="w-full bg-blue-600 text-white py-2 px-4 rounded font-medium hover:bg-blue-700 disabled:bg-gray-400 disabled:cursor-not-allowed">
          Process Audio
        </button>
      </form>

      <div id="progress" class="hidden mt-4">
        <div class="flex items-center space-x-2">
          <div class="animate-spin rounded-full h-5 w-5 border-b-2 border-blue-600"></div>
          <span class="text-gray-600">Processing... (this may take a minute)</span>
        </div>
      </div>
    </div>

    <div id="results" class="hidden bg-white rounded-lg shadow p-6">
      <h2 class="text-xl font-semibold mb-4">Results</h2>

      <div class="mb-4 p-3 bg-gray-50 rounded">
        <div class="grid grid-cols-3 gap-4 text-sm">
          <div><span class="font-medium">Duration:</span> <span id="duration">-</span>s</div>
          <div><span class="font-medium">Language:</span> <span id="detectedLang">-</span></div>
          <div><span class="font-medium">Speakers:</span> <span id="speakerCount">-</span></div>
        </div>
      </div>

      <h3 class="text-lg font-semibold mb-3">Speaker Transcript</h3>
      <div id="transcript" class="space-y-3 mb-6"></div>

      <details class="mt-6">
        <summary class="cursor-pointer text-sm font-medium text-gray-700 hover:text-gray-900">
          Show Raw JSON Response
        </summary>
        <pre id="rawJson" class="mt-2 p-4 bg-gray-50 rounded text-xs overflow-x-auto"></pre>
      </details>
    </div>

    <div id="error" class="hidden bg-red-50 border border-red-200 rounded-lg p-4 text-red-800"></div>
  </div>

  <script>
    const form = document.getElementById('uploadForm');
    const progress = document.getElementById('progress');
    const results = document.getElementById('results');
    const error = document.getElementById('error');
    const submitBtn = document.getElementById('submitBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

      // Reset UI
      progress.classList.remove('hidden');
      results.classList.add('hidden');
      error.classList.add('hidden');
      submitBtn.disabled = true;

      try {
        const formData = new FormData();
        formData.append('file', document.getElementById('audioFile').files[0]);
        formData.append('asr_model', document.getElementById('asrModel').value);
        formData.append('language', document.getElementById('language').value);

        const maxSpeakers = document.getElementById('maxSpeakers').value;
        if (maxSpeakers) formData.append('max_speakers', maxSpeakers);

        const response = await fetch('/v1/process', {
          method: 'POST',
          body: formData
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Processing failed');
        }

        // Display results
        displayResults(data);

      } catch (err) {
        error.textContent = 'Error: ' + err.message;
        error.classList.remove('hidden');
      } finally {
        progress.classList.add('hidden');
        submitBtn.disabled = false;
      }
    });

    function displayResults(data) {
      // Metadata
      document.getElementById('duration').textContent = data.duration_sec?.toFixed(1) || 'N/A';
      document.getElementById('detectedLang').textContent = data.asr?.language || 'N/A';

      const speakers = new Set(data.aligned.speaker_segments.map(s => s.speaker));
      document.getElementById('speakerCount').textContent = speakers.size;

      // Transcript
      const transcript = document.getElementById('transcript');
      transcript.innerHTML = '';

      data.aligned.speaker_segments.forEach(seg => {
        const div = document.createElement('div');
        div.className = 'border-l-4 border-blue-500 pl-4 py-2';
        div.innerHTML = \`
          <div class="flex items-baseline space-x-2 mb-1">
            <span class="font-semibold text-blue-700">\${seg.speaker}</span>
            <span class="text-xs text-gray-500">\${seg.start.toFixed(1)}s - \${seg.end.toFixed(1)}s</span>
          </div>
          <p class="text-gray-900">\${seg.text || '(silence)'}</p>
        \`;
        transcript.appendChild(div);
      });

      // Raw JSON
      document.getElementById('rawJson').textContent = JSON.stringify(data, null, 2);

      results.classList.remove('hidden');
    }
  </script>
</body>
</html>`);
});

// Health check endpoint - verifies Python scripts exist before processing requests
// Why: Fail fast if dependencies are missing; helps with debugging deployment issues
// Returns script status and model info for monitoring/debugging
app.get("/v1/health", async (c) => {
  const scriptsExist = await Promise.all([
    fs.access(DIARIZE_SCRIPT).then(() => true).catch(() => false),
    fs.access(TRANSCRIBE_SCRIPT).then(() => true).catch(() => false),
  ]);

  return c.json({
    status: "ok",
    scripts: {
      diarization: scriptsExist[0] ? "found" : "missing",
      transcription: scriptsExist[1] ? "found" : "missing",
    },
    models: { diarization: "pyannote/speaker-diarization-3.1", asr: `faster-whisper-${ASR_MODEL}` },
  });
});

// Main processing endpoint - orchestrates entire pipeline: upload → preprocess → ML → align
// Why: Single endpoint simplifies client integration; all processing happens server-side
// Flow: multipart upload → temp storage → ffmpeg conversion → parallel ASR+diarization → alignment
app.post("/v1/process", async (c) => {
  const requestStart = Date.now();

  // Parse multipart form data - Hono provides built-in parser for file uploads
  const form = await c.req.parseBody();
  const file = form["file"];
  if (!file || !(file as File).stream) {
    return c.text("file is required (multipart/form-data)", 400);
  }

  const filename = (file as File).name || "unknown";
  const contentType = (file as File).type || "unknown";

  // Extract optional parameters with sensible defaults
  // Why defaults: most users want medium model, auto language detection, no speaker limit
  const asrModel = (form["asr_model"] as string) || ASR_MODEL;
  const language = ((form["language"] as string) || "auto") as string;
  const maxSpeakers =
    form["max_speakers"] != null && String(form["max_speakers"]).length > 0
      ? Number(form["max_speakers"])
      : null;
  const minSpeakerDuration =
    form["min_speaker_duration"] != null
      ? Number(form["min_speaker_duration"])
      : 0.5;
  const enableOverlap =
    form["enable_overlap"] != null
      ? String(form["enable_overlap"]).toLowerCase() === "true"
      : true;

  // Create isolated temp directory per request using nanoid for uniqueness
  // Why: Prevents file conflicts in concurrent requests; automatic cleanup on completion
  const id = nanoid();
  const tmpDir = path.join(os.tmpdir(), `speakslice-${id}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const srcPath = path.join(tmpDir, "input.bin");
  const outWav = path.join(tmpDir, "audio.wav");

  debug("UPLOAD", "File received", {
    filename,
    content_type: contentType,
    request_id: id,
    asr_model: asrModel,
    language,
    max_speakers: maxSpeakers,
  });

  debug("TEMP", "Directory created", { path: tmpDir, id });

  // Stream uploaded file to disk (handles large files without memory overflow)
  const write = createWriteStream(srcPath);
  const stream = (file as File).stream();
  const reader = stream.getReader();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    write.write(value);
  }

  // Wait for write stream to finish before proceeding
  await new Promise<void>((resolve, reject) => {
    write.on('finish', resolve);
    write.on('error', reject);
    write.end();
  });

  try {
    // Enforce 2GB size limit to prevent memory/disk issues with huge files
    const stat = await fs.stat(srcPath);
    debug("UPLOAD", "File written to disk", { size_bytes: stat.size, size_mb: (stat.size / 1024 / 1024).toFixed(2) });

    if (stat.size > 2 * 1024 * 1024 * 1024) {
      debug("UPLOAD", "File too large, rejecting", { size_bytes: stat.size });
      return c.text("File too large", 413);
    }

    // Preprocess: Convert any format (mp3/mp4/wav) to standardized 16kHz mono WAV
    // Why: ML models require consistent input format; ffmpeg handles all conversions
    await runFfmpegToWav16kMono(srcPath, outWav);
    const duration = (await getDurationSec(outWav)) ?? null;

    // Key optimization: Run ASR and diarization in parallel (both read same WAV file)
    // Why: Saves ~50% processing time since operations are independent
    // Both use CPU-only inference, so no GPU contention
    debug("PIPELINE", "Starting parallel processing", { diarization: "pyannote", asr: asrModel });
    const parallelStart = Date.now();

    const [diarSegments, asrResult] = await Promise.all([
      callDiarizationScript(outWav, {
        max_speakers: maxSpeakers,
        min_speaker_duration: minSpeakerDuration,
        enable_overlap: enableOverlap,
      }),
      transcribeWithWhisper(outWav, { model: asrModel, language }),
    ]);

    const parallelElapsed = Date.now() - parallelStart;
    debug("PIPELINE", "Parallel processing complete", { elapsed_ms: parallelElapsed });

    // Sort by timestamp for chronological order, then align words to speakers
    diarSegments.sort((a, b) => a.start - b.start);
    const words = asrResult.words.sort((a, b) => a.start - b.start);
    const aligned = alignWordsToDiarization(words, diarSegments);

    const totalElapsed = Date.now() - requestStart;
    const responsePayload = {
      file: (c.req.header("x-filename") as string) || filename || "upload",
      duration_sec: duration,
      sample_rate: 16000,
      diarization: { segments: diarSegments },
      asr: {
        language: asrResult.language,
        words,
        segments: asrResult.segments,
      },
      aligned: { speaker_segments: aligned },
      meta: {
        models: {
          diarization: "pyannote/speaker-diarization-3.1",
          asr: `whisper-${asrModel}`,
        },
      },
    };

    const payloadSize = JSON.stringify(responsePayload).length;
    debug("RESPONSE", "Payload generated", {
      size_bytes: payloadSize,
      size_kb: (payloadSize / 1024).toFixed(2),
      total_elapsed_ms: totalElapsed,
    });

    // Return comprehensive JSON with all data: raw + aligned transcripts
    return c.json(responsePayload);
  } catch (e: any) {
    debug("ERROR", "Request failed", {
      error: e.message ?? String(e),
      stack: e.stack?.substring(0, 300),
    });
    return c.json({ error: e.message ?? String(e) }, 500);
  } finally {
    // Always cleanup temp files, even on error (prevents disk space leaks)
    debug("CLEANUP", "Removing temp directory", { path: tmpDir });
    try {
      await fs.rm(tmpDir, { recursive: true, force: true });
      debug("CLEANUP", "Complete", { path: tmpDir });
    } catch (cleanupErr: any) {
      debug("CLEANUP", "Failed", { error: cleanupErr.message });
    }
  }
});

// Start Bun server - uses native HTTP server (faster than Node.js)
// Why Bun: Built-in TypeScript support, fast startup, includes Node.js APIs
const PORT = Number(process.env.PORT || 8000);

serve({
  fetch: app.fetch,
  port: PORT,
});

console.log(`SpeakSlice API running on port ${PORT}`);
if (DEBUG) {
  console.log(`[DEBUG MODE ENABLED] Using Python: ${PYTHON_BIN}`);
  console.log(`[DEBUG MODE ENABLED] ASR Model: ${ASR_MODEL}`);
}
