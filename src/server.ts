// Core imports: Hono for lightweight HTTP routing, Bun for serve() built-in
// nanoid generates unique IDs for temp directories to avoid file conflicts
import { Hono } from "hono";
import { logger } from "hono/logger";
import { serveStatic } from "hono/bun";
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
// Format: [HH:MM:SS] [XX%] STAGE: message { metadata }
function debug(stage: string, message: string, meta?: object, progressPct?: number) {
  if (!DEBUG) return;
  const timestamp = new Date().toISOString().split('T')[1].split('.')[0];
  const progress = progressPct !== undefined ? ` [${progressPct}%]` : '';
  const metaStr = meta ? ' ' + JSON.stringify(meta, null, 2) : '';
  console.log(`[${timestamp}]${progress} ${stage}: ${message}${metaStr}`);
}

const app = new Hono();

// Add HTTP request logging middleware (shows METHOD PATH STATUS TIMING)
app.use(logger());

// Serve static files from public directory (React bundle)
app.use('/public/*', serveStatic({ root: './' }));

// Configuration: Allow overriding via env vars for flexibility
// Default to "medium" Whisper model for balanced speed/accuracy tradeoff
const ASR_MODEL = process.env.ASR_MODEL || "medium";
const DIARIZE_SCRIPT = process.env.DIARIZE_SCRIPT || "./src/scripts/diarize.py";
const TRANSCRIBE_SCRIPT = process.env.TRANSCRIBE_SCRIPT || "./src/scripts/transcribe.py";
const YOUTUBE_DOWNLOAD_SCRIPT = process.env.YOUTUBE_DOWNLOAD_SCRIPT || "./src/scripts/download_youtube.py";
// Use virtual environment Python if it exists, otherwise fall back to system python3
const PYTHON_BIN = process.env.PYTHON_BIN ||
  (await fs.access(".venv/bin/python").then(() => ".venv/bin/python").catch(() => "python3"));

// Optimized diarization settings for YouTube URLs with transcripts
// Why: When using transcript for ASR, apply "FULL THROTTLE" diarization optimization
// Trades minor accuracy for 30-40% speed improvement
const OPTIMIZED_DIARIZATION_OPTIONS = {
  minSpeakerDuration: 1.0,     // Increased from 0.5 for speed
  enableOverlap: false,         // Disable overlap detection (saves ~20-30% time)
  batchSize: 64                 // Increased from 32 for faster processing
};

// Convert any audio format to standardized 16kHz mono WAV for ML models
// Why: pyannote and faster-whisper require consistent audio format (16kHz, mono, WAV)
// -ac 1 = mono, -ar 16000 = 16kHz sample rate, pcm_s16le = 16-bit PCM encoding
async function runFfmpegToWav16kMono(src: string, dst: string) {
  const args = ["-y", "-i", src, "-ac", "1", "-ar", "16000", "-vn", "-c:a", "pcm_s16le", dst];
  debug("FFMPEG", "Converting to 16kHz mono WAV", { input: path.basename(src), output: path.basename(dst) });
  const start = Date.now();

  await new Promise<void>((resolve, reject) => {
    const p = spawn("ffmpeg", args);
    let err = "";
    p.stderr.on("data", (d) => (err += d.toString()));
    p.on("close", (code) => {
      if (code === 0) {
        const elapsed = Date.now() - start;
        debug("FFMPEG", "Conversion complete", { elapsed_ms: elapsed });
        resolve();
      } else {
        debug("FFMPEG", "Conversion failed", { error: err.substring(0, 200) });
        reject(new Error(err));
      }
    });
  });
}

// Create cache directory path based on current datetime in local timezone
// Format: cache/YYYYMMDD-HHmm/
// Why: Organizes outputs chronologically, easy to find recent processings
function getCacheDirPath(): string {
  const now = new Date();
  // Get local timezone components (already in local time by default)
  const year = now.getFullYear();
  const month = String(now.getMonth() + 1).padStart(2, '0');
  const day = String(now.getDate()).padStart(2, '0');
  const hour = String(now.getHours()).padStart(2, '0');
  const minute = String(now.getMinutes()).padStart(2, '0');
  const dateStr = `${year}${month}${day}-${hour}${minute}`;
  return path.join("cache", dateStr);
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
    // Pass environment variables to child process (includes HF_TOKEN from .env)
    const p = spawn(PYTHON_BIN, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => {
      stderr += d.toString();
      // Log progress and timing messages from Python script in real-time
      const lines = d.toString().split('\n');
      for (const line of lines) {
        if (line.includes('[PROGRESS]')) {
          debug("DIARIZATION", line.replace('[PROGRESS]', '').trim(), {});
        } else if (line.includes('[TIMING]')) {
          debug("DIARIZATION", line.replace('[TIMING]', '').trim(), {});
        }
      }
    });
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

  // Enable fast mode by default for maximum speed (beam_size=1, distil-whisper)
  // Provides 80-90% speedup with <3% accuracy loss
  args.push("--fast");

  debug("ASR", "Spawning script", {
    script: path.basename(TRANSCRIBE_SCRIPT),
    wav: path.basename(wavPath),
    model: opts.model,
    language: opts.language,
  });
  const start = Date.now();

  return new Promise((resolve, reject) => {
    // Pass environment variables to child process (includes HF_TOKEN from .env)
    const p = spawn(PYTHON_BIN, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => {
      stderr += d.toString();
      // Log progress and timing messages from Python script in real-time
      const lines = d.toString().split('\n');
      for (const line of lines) {
        if (line.includes('[PROGRESS]')) {
          debug("ASR", line.replace('[PROGRESS]', '').trim(), {});
        } else if (line.includes('[TIMING]')) {
          debug("ASR", line.replace('[TIMING]', '').trim(), {});
        }
      }
    });
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

// Validate YouTube URL format - only accepts standard YouTube URLs
// Patterns: https://www.youtube.com/watch?v=VIDEO_ID or https://youtu.be/VIDEO_ID
// Why: Security - prevent arbitrary URLs, ensure yt-dlp gets valid input
function validateYoutubeUrl(url: string): boolean {
  const patterns = [
    /^https:\/\/www\.youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}$/,
    /^https:\/\/youtu\.be\/[a-zA-Z0-9_-]{11}$/,
  ];
  return patterns.some(pattern => pattern.test(url));
}

// Load YouTube transcript and convert to ASR format
// Why: Allows transcript to seamlessly replace ASR in pipeline
// Creates word-level timestamps by distributing evenly across segment
async function loadTranscriptAsASR(transcriptPath: string): Promise<any> {
  const transcriptData = JSON.parse(await Bun.file(transcriptPath).text());
  const segments = transcriptData.segments || [];

  const words: Word[] = [];
  const asrSegments: ASRSeg[] = [];

  for (const seg of segments) {
    const text = seg.text.trim();
    if (!text) continue;

    const wordList = text.split(/\s+/);
    const segmentDuration = seg.end - seg.start;
    const timePerWord = segmentDuration / wordList.length;

    // Generate word-level timestamps
    const segmentWords: Word[] = [];
    for (let i = 0; i < wordList.length; i++) {
      const wordStart = seg.start + (i * timePerWord);
      const wordEnd = seg.start + ((i + 1) * timePerWord);

      const word: Word = {
        start: wordStart,
        end: wordEnd,
        text: wordList[i],
        confidence: 1.0  // Assume transcript is accurate
      };

      words.push(word);
      segmentWords.push(word);
    }

    // Create segment
    asrSegments.push({
      start: seg.start,
      end: seg.end,
      text: text,
      avg_confidence: 1.0
    });
  }

  return {
    language: transcriptData.language || 'en',
    language_probability: 1.0,
    duration: segments.length > 0 ? segments[segments.length - 1].end : 0,
    words: words,
    segments: asrSegments,
    source: 'youtube_transcript'  // Tag for debugging
  };
}

// Download audio from YouTube URL using download_youtube.py script
// Why: Separation of concerns - Python handles yt-dlp CLI, TypeScript orchestrates
// Script outputs JSON to stdout with download metadata; stderr for errors
async function callYoutubeDownloadScript(
  url: string,
  outputPath: string,
  start?: number,
  end?: number,
  fetchTranscript: boolean = true
): Promise<{transcriptAvailable: boolean; videoTitle?: string}> {
  const args = [YOUTUBE_DOWNLOAD_SCRIPT, url, "--output", outputPath];

  // Add time cropping parameters if provided
  if (start !== undefined && start > 0) {
    args.push("--start", Math.floor(start).toString());
  }
  if (end !== undefined) {
    args.push("--end", Math.floor(end).toString());
  }

  // Always add transcript flag for YouTube URLs
  if (fetchTranscript) {
    args.push("--transcript");
  }

  debug("YOUTUBE", "Spawning download script", {
    script: path.basename(YOUTUBE_DOWNLOAD_SCRIPT),
    url: url.substring(0, 50) + "...",
    output: path.basename(outputPath),
    start: start !== undefined ? start : 'none',
    end: end !== undefined ? end : 'none',
  });
  const startTime = Date.now();

  return new Promise((resolve, reject) => {
    const p = spawn(PYTHON_BIN, args, { env: process.env });
    let stdout = "";
    let stderr = "";
    p.stdout.on("data", (d) => (stdout += d.toString()));
    p.stderr.on("data", (d) => {
      stderr += d.toString();
      // Log progress messages from Python script in real-time
      const lines = d.toString().split('\n');
      for (const line of lines) {
        if (line.includes('[PROGRESS]')) {
          debug("YOUTUBE", line.replace('[PROGRESS]', '').trim(), {});
        }
      }
    });
    p.on("close", (code) => {
      const elapsed = Date.now() - startTime;
      if (code !== 0) {
        debug("YOUTUBE", "Download failed", { exit_code: code, error: stderr.substring(0, 200) });
        reject(new Error(`YouTube download failed: ${stderr}`));
      } else {
        try {
          const result = JSON.parse(stdout);
          debug("YOUTUBE", "Download complete", {
            title: result.title?.substring(0, 50),
            duration: result.duration,
            file_size_bytes: result.file_size_bytes,
            transcript_available: result.transcript_available || false,
            transcript_segments: result.transcript_segments || 0,
            elapsed_ms: elapsed,
          });
          resolve({
            transcriptAvailable: result.transcript_available || false,
            videoTitle: result.title
          });
        } catch (e) {
          debug("YOUTUBE", "Parse failed", { error: String(e), output_preview: stdout.substring(0, 100) });
          reject(new Error(`Failed to parse YouTube download output: ${e}`));
        }
      }
    });
  });
}


// Web UI - Serves React app with live reload
app.get("/app", async (c) => {
  let html = await Bun.file("src/index.html").text();

  // Inject YouTube API key if configured (optional feature)
  const youtubeApiKey = process.env.YOUTUBE_API_KEY || '';
  if (youtubeApiKey) {
    const script = `<script>window.YOUTUBE_API_KEY = "${youtubeApiKey}";</script>`;
    html = html.replace('</head>', `${script}\n  </head>`);
  }

  return c.html(html);
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

// File duration endpoint - extracts duration from uploaded audio/video file
// Why: Needed for audio trimmer UI to show total duration before processing
// Uses ffprobe to read file metadata without full conversion
app.post("/v1/file/duration", async (c) => {
  try {
    const form = await c.req.parseBody();
    const file = form["file"];

    if (!file) {
      return c.json({ error: "file is required" }, 400);
    }

    // Save file to temp location for ffprobe
    const tmpFile = path.join(os.tmpdir(), `duration-check-${nanoid()}`);
    try {
      await Bun.write(tmpFile, (file as File));

      // Use ffprobe to extract duration
      const ffprobeResult = await new Promise<string>((resolve, reject) => {
        exec(
          `ffprobe -v error -show_entries format=duration -of default=noprint_wrappers=1:nokey=1 "${tmpFile}"`,
          (error, stdout, stderr) => {
            if (error) {
              reject(new Error(`ffprobe error: ${stderr || error.message}`));
            } else {
              resolve(stdout.trim());
            }
          }
        );
      });

      const duration = parseFloat(ffprobeResult);
      if (isNaN(duration)) {
        throw new Error('Could not parse duration from file');
      }

      return c.json({ duration_seconds: duration });
    } finally {
      // Clean up temp file
      await fs.unlink(tmpFile).catch(() => {});
    }
  } catch (err) {
    return c.json({ error: `Duration extraction failed: ${(err as Error).message}` }, 500);
  }
});

// Main processing endpoint - orchestrates entire pipeline: upload → preprocess → ML → align
// Why: Single endpoint simplifies client integration; all processing happens server-side
// Flow: multipart upload → temp storage → ffmpeg conversion → parallel ASR+diarization → alignment
app.post("/v1/process", async (c) => {
  const requestStart = Date.now();

  debug("PIPELINE", "Request received", {}, 0);

  // Parse multipart form data - Hono provides built-in parser for file uploads
  const form = await c.req.parseBody();
  const file = form["file"];
  const youtubeUrl = form["youtube_url"] as string | undefined;
  const customName = form["name"] as string | undefined;

  // Validate: require either file OR youtube_url (not both, not neither)
  if (!file && !youtubeUrl) {
    return c.json({ error: "file or youtube_url is required" }, 400);
  }
  if (file && youtubeUrl) {
    return c.json({ error: "provide either file or youtube_url, not both" }, 400);
  }

  // Validate YouTube URL format if provided
  if (youtubeUrl && !validateYoutubeUrl(youtubeUrl)) {
    return c.json({ error: "invalid YouTube URL format. Use: https://www.youtube.com/watch?v=... or https://youtu.be/..." }, 400);
  }

  const filename = file ? ((file as File).name || "unknown") : "youtube-audio.wav";
  const contentType = file ? ((file as File).type || "unknown") : "audio/wav";

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
  const startTime =
    form["start_time"] != null && String(form["start_time"]).length > 0
      ? Number(form["start_time"])
      : undefined;
  const endTime =
    form["end_time"] != null && String(form["end_time"]).length > 0
      ? Number(form["end_time"])
      : undefined;

  // Create isolated temp directory per request using nanoid for uniqueness
  // Why: Prevents file conflicts in concurrent requests; automatic cleanup on completion
  const id = nanoid();
  const tmpDir = path.join(os.tmpdir(), `speakslice-${id}`);
  await fs.mkdir(tmpDir, { recursive: true });
  const srcPath = path.join(tmpDir, "input.bin");
  const outWav = path.join(tmpDir, "audio.wav");

  debug(youtubeUrl ? "YOUTUBE" : "UPLOAD", youtubeUrl ? "URL received" : "File received", {
    filename,
    content_type: contentType,
    request_id: id,
    asr_model: asrModel,
    language,
    max_speakers: maxSpeakers,
    youtube_url: youtubeUrl?.substring(0, 50),
  }, 2);

  debug("TEMP", "Directory created", { path: tmpDir, id }, 3);

  // Branch: Download from YouTube OR stream uploaded file
  let transcriptAvailable = false;
  let videoTitle: string | undefined;
  if (youtubeUrl) {
    // Download YouTube audio directly to WAV format
    debug("YOUTUBE", "Starting download", { url: youtubeUrl.substring(0, 50) }, 5);
    try {
      const downloadResult = await callYoutubeDownloadScript(youtubeUrl, outWav, startTime, endTime, true);
      transcriptAvailable = downloadResult.transcriptAvailable;
      videoTitle = downloadResult.videoTitle;
      debug("YOUTUBE", "Download complete", { transcript_available: transcriptAvailable }, 10);
    } catch (err) {
      debug("YOUTUBE", "Download failed", { error: String(err) });
      return c.json({ error: `YouTube download failed: ${String(err)}` }, 500);
    }
  } else {
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
  }

  try {
    // For file uploads: enforce 2GB size limit and convert to WAV
    if (!youtubeUrl) {
      const stat = await fs.stat(srcPath);
      debug("UPLOAD", "File written to disk", { size_bytes: stat.size, size_mb: (stat.size / 1024 / 1024).toFixed(2) }, 5);

      if (stat.size > 2 * 1024 * 1024 * 1024) {
        debug("UPLOAD", "File too large, rejecting", { size_bytes: stat.size });
        return c.text("File too large", 413);
      }

      // Preprocess: Convert any format (mp3/mp4/wav) to standardized 16kHz mono WAV
      // Why: ML models require consistent input format; ffmpeg handles all conversions
      debug("PREPROCESS", "Starting audio conversion to 16kHz mono WAV", {}, 8);
      await runFfmpegToWav16kMono(srcPath, outWav);

      // If trimming is enabled for uploaded files, crop the WAV file
      if (startTime !== undefined || endTime !== undefined) {
        const trimmedPath = path.join(tmpDir, "trimmed.wav");
        debug("PREPROCESS", "Trimming audio", { start: startTime, end: endTime }, 9);

        let ffmpegCmd = `ffmpeg -i "${outWav}"`;
        if (startTime !== undefined && startTime > 0) {
          ffmpegCmd += ` -ss ${startTime}`;
        }
        if (endTime !== undefined) {
          ffmpegCmd += ` -to ${endTime}`;
        }
        ffmpegCmd += ` -c copy "${trimmedPath}"`;

        await new Promise<void>((resolve, reject) => {
          exec(ffmpegCmd, (error, stdout, stderr) => {
            if (error) {
              debug("PREPROCESS", "Trimming failed", { error: stderr.substring(0, 200) });
              reject(new Error(`Audio trimming failed: ${stderr}`));
            } else {
              debug("PREPROCESS", "Trimming complete", {}, 10);
              resolve();
            }
          });
        });

        // Replace the original WAV with the trimmed version
        await fs.rename(trimmedPath, outWav);
      }
    }

    // Get duration (YouTube download already in WAV format, file upload converted above)
    const duration = (await getDurationSec(outWav)) ?? null;
    debug("PREPROCESS", youtubeUrl ? "YouTube audio ready" : "Audio conversion complete", { duration_sec: duration }, 12);

    // Check if transcript file exists for YouTube URLs
    const transcriptPath = outWav + '.transcript.json';
    const hasTranscript = transcriptAvailable &&
                          await fs.access(transcriptPath).then(() => true).catch(() => false);

    let diarSegments: DiarSeg[];
    let asrResult: any;

    if (hasTranscript) {
      // SKIP ASR - use transcript instead with optimized diarization
      debug("TRANSCRIPT", "Using YouTube transcript (skipping ASR)", {}, 12);
      debug("PIPELINE", "Starting optimized diarization for YouTube", { diarization: "pyannote (optimized)" }, 15);
      const parallelStart = Date.now();

      // Run diarization with optimized settings and load transcript in parallel
      [diarSegments, asrResult] = await Promise.all([
        callDiarizationScript(outWav, {
          max_speakers: maxSpeakers,
          ...OPTIMIZED_DIARIZATION_OPTIONS,
        }),
        loadTranscriptAsASR(transcriptPath),
      ]);

      const parallelElapsed = Date.now() - parallelStart;
      debug("PIPELINE", "Processing complete (transcript + optimized diarization)", { elapsed_ms: parallelElapsed }, 75);
    } else {
      // Fallback to ASR + standard diarization
      if (youtubeUrl && !hasTranscript) {
        debug("TRANSCRIPT", "No transcript available, using Whisper", { model: asrModel }, 12);
      }
      // Key optimization: Run ASR and diarization in parallel (both read same WAV file)
      // Why: Saves ~50% processing time since operations are independent
      // Both use CPU-only inference, so no GPU contention
      debug("PIPELINE", "Starting parallel processing (ASR + diarization)", { diarization: "pyannote", asr: asrModel }, 15);
      const parallelStart = Date.now();

      [diarSegments, asrResult] = await Promise.all([
        callDiarizationScript(outWav, {
          max_speakers: maxSpeakers,
          min_speaker_duration: minSpeakerDuration,
          enable_overlap: enableOverlap,
        }),
        transcribeWithWhisper(outWav, { model: asrModel, language }),
      ]);

      const parallelElapsed = Date.now() - parallelStart;
      debug("PIPELINE", "Parallel processing complete", { elapsed_ms: parallelElapsed }, 75);
    }

    // Sort by timestamp for chronological order, then align words to speakers
    debug("ALIGN", "Starting word-to-speaker alignment", {}, 78);
    diarSegments.sort((a, b) => a.start - b.start);
    const words = asrResult.words.sort((a, b) => a.start - b.start);
    const aligned = alignWordsToDiarization(words, diarSegments);
    debug("ALIGN", "Alignment complete", { speaker_segments: aligned.length }, 82);

    const totalElapsed = Date.now() - requestStart;
    // Determine final name (priority: custom > video title > filename)
    const finalName = customName || videoTitle || filename;

    const responsePayload = {
      file: (c.req.header("x-filename") as string) || filename || "upload",
      name: finalName,
      youtube_url: youtubeUrl || null,
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
    }, 85);

    // Save outputs to cache directory for persistence
    debug("CACHE", "Starting output persistence", {}, 88);
    const cacheDir = getCacheDirPath();
    await fs.mkdir(cacheDir, { recursive: true });

    // Save individual components
    await fs.writeFile(
      path.join(cacheDir, "diarization.json"),
      JSON.stringify({ segments: diarSegments }, null, 2)
    );
    await fs.writeFile(
      path.join(cacheDir, "asr.json"),
      JSON.stringify({
        language: asrResult.language,
        words,
        segments: asrResult.segments,
      }, null, 2)
    );
    await fs.writeFile(
      path.join(cacheDir, "aligned.json"),
      JSON.stringify({ speaker_segments: aligned }, null, 2)
    );
    // Save complete response
    await fs.writeFile(
      path.join(cacheDir, "response.json"),
      JSON.stringify(responsePayload, null, 2)
    );
    // Save preprocessed audio file for playback
    await fs.copyFile(
      outWav,
      path.join(cacheDir, "audio.wav")
    );
    // Save transcript if it was used
    if (hasTranscript && await fs.access(transcriptPath).then(() => true).catch(() => false)) {
      await fs.copyFile(
        transcriptPath,
        path.join(cacheDir, "transcript.json")
      );
      debug("CACHE", "Transcript saved", { path: path.join(cacheDir, "transcript.json") });
    }

    debug("CACHE", "Outputs saved", { path: cacheDir }, 95);

    // Return comprehensive JSON with all data: raw + aligned transcripts
    debug("PIPELINE", "Request complete", { total_elapsed_ms: totalElapsed }, 100);
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

// List all processed files in cache directory
// Returns metadata for each cache folder: id, filename, date, duration, speakers
app.get("/v1/collections", async (c) => {
  const cacheDir = "cache";
  try {
    const entries = await fs.readdir(cacheDir, { withFileTypes: true });
    const collections = [];

    for (const entry of entries) {
      // Only process directories matching YYYYMMDD-HHmm format
      if (!entry.isDirectory() || !/^\d{8}-\d{4}$/.test(entry.name)) continue;

      const responsePath = path.join(cacheDir, entry.name, "response.json");
      try {
        const content = await fs.readFile(responsePath, "utf-8");
        const data = JSON.parse(content);

        // Parse date from folder name (YYYYMMDD-HHmm)
        const match = entry.name.match(/^(\d{4})(\d{2})(\d{2})-(\d{2})(\d{2})$/);
        const processedDate = match
          ? new Date(Number(match[1]), Number(match[2]) - 1, Number(match[3]), Number(match[4]), Number(match[5]))
          : null;

        const speakers = new Set(data.aligned?.speaker_segments?.map((s: any) => s.speaker) || []);

        collections.push({
          id: entry.name,
          filename: data.file || "unknown",
          name: data.name || data.file || "unknown",
          youtube_url: data.youtube_url || null,
          processed_date: processedDate?.toISOString() || null,
          duration_sec: data.duration_sec || null,
          speaker_count: speakers.size,
          language: data.asr?.language || null,
        });
      } catch (err) {
        // Skip folders with missing or invalid response.json
        debug("COLLECTIONS", "Skipping invalid cache folder", { folder: entry.name });
        continue;
      }
    }

    // Sort by date descending (newest first)
    collections.sort((a, b) => {
      const dateA = a.processed_date ? new Date(a.processed_date).getTime() : 0;
      const dateB = b.processed_date ? new Date(b.processed_date).getTime() : 0;
      return dateB - dateA;
    });

    return c.json({ collections });
  } catch (err: any) {
    return c.json({ error: err.message }, 500);
  }
});

// Get full response.json for a specific collection
app.get("/v1/collections/:id", async (c) => {
  const id = c.req.param("id");

  // Validate id format (prevent path traversal)
  if (!/^\d{8}-\d{4}$/.test(id)) {
    return c.json({ error: "Invalid collection ID format" }, 400);
  }

  const responsePath = path.join("cache", id, "response.json");

  try {
    const content = await fs.readFile(responsePath, "utf-8");
    const data = JSON.parse(content);
    return c.json(data);
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return c.json({ error: "Collection not found" }, 404);
    }
    return c.json({ error: err.message }, 500);
  }
});

// Get audio file for a specific collection
app.get("/v1/collections/:id/audio", async (c) => {
  const id = c.req.param("id");

  // Validate id format (prevent path traversal)
  if (!/^\d{8}-\d{4}$/.test(id)) {
    return c.json({ error: "Invalid collection ID format" }, 400);
  }

  const audioPath = path.join("cache", id, "audio.wav");

  try {
    const audio = await fs.readFile(audioPath);
    return c.body(audio, {
      headers: {
        "Content-Type": "audio/wav",
        "Content-Length": audio.length.toString(),
      },
    });
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return c.json({ error: "Audio file not found" }, 404);
    }
    return c.json({ error: err.message }, 500);
  }
});

// Update speaker names for a collection
app.patch("/v1/collections/:id/speaker-names", async (c) => {
  const id = c.req.param("id");

  // Validate id format (prevent path traversal)
  if (!/^\d{8}-\d{4}$/.test(id)) {
    return c.json({ error: "Invalid collection ID format" }, 400);
  }

  const responsePath = path.join("cache", id, "response.json");

  try {
    // Read existing response.json
    const content = await fs.readFile(responsePath, "utf-8");
    const data = JSON.parse(content);

    // Parse request body for speaker names
    const body = await c.req.json();
    if (!body.speaker_names || typeof body.speaker_names !== "object") {
      return c.json({ error: "speaker_names object required" }, 400);
    }

    // Update speaker_names field
    data.speaker_names = body.speaker_names;

    // Write back to file
    await fs.writeFile(responsePath, JSON.stringify(data, null, 2));

    debug("COLLECTIONS", "Speaker names updated", { id, speaker_names: body.speaker_names });

    return c.json({ success: true, speaker_names: data.speaker_names });
  } catch (err: any) {
    if (err.code === "ENOENT") {
      return c.json({ error: "Collection not found" }, 404);
    }
    return c.json({ error: err.message }, 500);
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
  console.log(`[DEBUG MODE ENABLED] Progress tracking enabled with percentage indicators`);
  console.log(`[DEBUG MODE ENABLED] Pipeline stages:`);
  console.log(`  [0-5%]   Upload & validation`);
  console.log(`  [8-12%]  Audio preprocessing (ffmpeg)`);
  console.log(`  [15-75%] ASR + Diarization (parallel)`);
  console.log(`  [78-82%] Word-to-speaker alignment`);
  console.log(`  [85-95%] Cache persistence`);
  console.log(`  [100%]   Complete`);
}
