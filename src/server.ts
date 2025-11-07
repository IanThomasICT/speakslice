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
<body class="bg-gray-50 min-h-screen">
  <!-- Header as aside in top-left -->
  <aside class="fixed top-4 left-4 z-10">
    <h1 class="text-lg font-bold text-gray-900">SpeakSlice</h1>
    <p class="text-xs text-gray-500">Free, CPU-first diarization</p>
  </aside>

  <div class="max-w-5xl mx-auto pt-20 px-4">
    <!-- Tab Navigation at top -->
    <div class="flex justify-center space-x-6 mb-8 border-b border-gray-200">
      <button id="uploadTab" class="px-3 py-2 text-sm font-medium text-blue-600 border-b-2 border-blue-600 cursor-pointer">
        Upload
      </button>
      <button id="collectionsTab" class="px-3 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 cursor-pointer">
        Collections
      </button>
    </div>

    <!-- Upload Tab Content -->
    <div id="uploadContent">
      <div class="max-w-xl mx-auto mb-8">
        <form id="uploadForm" class="space-y-3">
          <input type="file" id="audioFile" accept="audio/*,video/*" required
            class="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer">

          <details class="text-xs">
            <summary class="text-gray-500 hover:text-gray-700 cursor-pointer">Options</summary>
            <div class="mt-2 space-y-2 pl-3 border-l border-gray-200">
              <select id="asrModel" class="block w-full rounded border-gray-300 text-xs">
                <option value="tiny">Tiny</option>
                <option value="base">Base</option>
                <option value="small">Small</option>
                <option value="medium" selected>Medium</option>
              </select>
              <select id="language" class="block w-full rounded border-gray-300 text-xs">
                <option value="auto">Auto-detect</option>
                <option value="en">English</option>
                <option value="es">Spanish</option>
                <option value="fr">French</option>
                <option value="de">German</option>
                <option value="zh">Chinese</option>
              </select>
              <input type="number" id="maxSpeakers" min="1" max="10" placeholder="Max speakers"
                class="block w-full rounded border-gray-300 text-xs">
            </div>
          </details>

          <button type="submit" id="submitBtn"
            class="w-full bg-blue-600 text-white py-2 px-4 rounded text-sm font-medium hover:bg-blue-700 cursor-pointer disabled:bg-gray-400 disabled:cursor-not-allowed">
            Process
          </button>
        </form>

        <div id="progress" class="hidden mt-4 text-center">
          <div class="inline-flex items-center space-x-2 text-sm text-gray-600">
            <svg class="animate-spin h-4 w-4 text-blue-600" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <span>Processing...</span>
          </div>
        </div>
      </div>
    </div>

    <!-- Collections Tab Content -->
    <div id="collectionsContent" class="hidden">
      <div class="mb-8">
        <div id="collectionsGrid" class="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 max-w-4xl mx-auto"></div>
        <div id="collectionsEmpty" class="hidden text-center py-12 text-sm text-gray-400">
          No files yet
        </div>
      </div>
    </div>

    <!-- Results Display (shared) -->
    <div id="results" class="hidden">
      <div class="max-w-4xl mx-auto">
        <div class="flex justify-between items-center mb-6">
          <div class="flex items-baseline gap-6 text-xs text-gray-500">
            <div><span id="duration">-</span>s</div>
            <div><span id="detectedLang">-</span></div>
            <div><span id="speakerCount">-</span> speakers</div>
          </div>
        </div>

        <!-- Sentinel element for sticky detection -->
        <div id="audioSentinel"></div>

        <!-- Audio Player - Sticky with enhanced UI transitions -->
        <div id="audioPlayer" class="hidden sticky top-0 z-20 bg-white mb-6 py-4 transition-all duration-300 ease-in-out shadow-md">
          <div class="flex items-center justify-center gap-3 max-w-4xl mx-auto px-4">
            <button id="playBtn" class="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center cursor-pointer hover:bg-blue-700 flex-shrink-0">
              <svg id="playIcon" xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/></svg>
            </button>
            <div class="flex-1 max-w-2xl">
              <input type="range" id="audioSeeker" min="0" max="100" value="0" step="0.01"
                class="w-full cursor-pointer">
              <div class="flex justify-between text-xs text-gray-500 mt-1">
                <span id="currentTime">0:00</span>
                <span id="totalTime">0:00</span>
              </div>
            </div>
            <select id="playbackSpeed" class="px-2 py-1.5 bg-gray-100 text-gray-700 rounded text-xs font-medium hover:bg-gray-200 cursor-pointer border border-gray-300 flex-shrink-0">
              <option value="1">1x</option>
              <option value="1.25">1.25x</option>
              <option value="1.5">1.5x</option>
              <option value="2">2x</option>
            </select>
            <button id="saveNamesBtn" class="hidden px-3 py-2 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 cursor-pointer flex-shrink-0 flex items-center gap-1.5">
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>
              <span>Save</span>
            </button>
            <div id="audioLoading" class="hidden flex-shrink-0">
              <svg class="animate-spin h-5 w-5 text-blue-600" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            </div>
          </div>
          <audio id="audioElement" class="hidden"></audio>
        </div>

        <p class="text-xs text-gray-400 mb-4">Double-click speaker name to rename</p>
        <div id="transcript" class="space-y-4"></div>

        <details class="mt-8">
          <summary class="text-xs text-gray-400 hover:text-gray-600 cursor-pointer">Raw JSON</summary>
          <pre id="rawJson" class="mt-2 p-3 bg-gray-50 rounded text-xs overflow-x-auto"></pre>
        </details>
      </div>
    </div>

    <div id="error" class="hidden bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 max-w-2xl mx-auto"></div>
  </div>

  <script>
    // Speaker color palette (consistent mapping)
    const SPEAKER_COLORS = {
      'SPEAKER_00': { border: 'rgb(59, 130, 246)', bg: 'rgb(239, 246, 255)', text: 'rgb(29, 78, 216)' }, // blue
      'SPEAKER_01': { border: 'rgb(249, 115, 22)', bg: 'rgb(255, 247, 237)', text: 'rgb(194, 65, 12)' }, // orange
      'SPEAKER_02': { border: 'rgb(34, 197, 94)', bg: 'rgb(240, 253, 244)', text: 'rgb(21, 128, 61)' }, // green
      'SPEAKER_03': { border: 'rgb(234, 179, 8)', bg: 'rgb(254, 252, 232)', text: 'rgb(161, 98, 7)' }, // yellow
      'SPEAKER_04': { border: 'rgb(168, 85, 247)', bg: 'rgb(250, 245, 255)', text: 'rgb(107, 33, 168)' }, // purple
      'SPEAKER_05': { border: 'rgb(236, 72, 153)', bg: 'rgb(253, 242, 248)', text: 'rgb(157, 23, 77)' }, // pink
      'SPEAKER_06': { border: 'rgb(99, 102, 241)', bg: 'rgb(238, 242, 255)', text: 'rgb(67, 56, 202)' }, // indigo
      'SPEAKER_07': { border: 'rgb(6, 182, 212)', bg: 'rgb(236, 254, 255)', text: 'rgb(14, 116, 144)' }, // cyan
      'SPEAKER_08': { border: 'rgb(132, 204, 22)', bg: 'rgb(247, 254, 231)', text: 'rgb(77, 124, 15)' }, // lime
      'SPEAKER_09': { border: 'rgb(244, 63, 94)', bg: 'rgb(255, 241, 242)', text: 'rgb(159, 18, 57)' }, // rose
    };

    // Global state
    let currentData = null;
    let currentCollectionId = null;
    let speakerNames = {};
    let audioElement = null;
    let isAudioLoaded = false;
    let currentSegmentIndex = -1;

    // Sticky audio bar detection and styling
    function setupStickyAudioBar() {
      const sentinel = document.getElementById('audioSentinel');
      const audioPlayer = document.getElementById('audioPlayer');

      if (!sentinel || !audioPlayer) return;

      const observer = new IntersectionObserver(
        ([entry]) => {
          // When sentinel is not intersecting (out of view), audio bar is sticky
          if (!entry.isIntersecting) {
            audioPlayer.classList.add('rounded-xl', 'shadow-xl', 'top-3', 'mx-4');
            audioPlayer.classList.remove('shadow-md', 'top-0');
          } else {
            audioPlayer.classList.remove('rounded-xl', 'shadow-xl', 'top-3', 'mx-4');
            audioPlayer.classList.add('shadow-md', 'top-0');
          }
        },
        { threshold: 0, rootMargin: '0px' }
      );

      observer.observe(sentinel);
    }

    // Tab switching
    const uploadTab = document.getElementById('uploadTab');
    const collectionsTab = document.getElementById('collectionsTab');
    const uploadContent = document.getElementById('uploadContent');
    const collectionsContent = document.getElementById('collectionsContent');

    uploadTab.addEventListener('click', () => {
      uploadTab.className = 'px-3 py-2 text-sm font-medium text-blue-600 border-b-2 border-blue-600 cursor-pointer';
      collectionsTab.className = 'px-3 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 cursor-pointer';
      uploadContent.classList.remove('hidden');
      collectionsContent.classList.add('hidden');
    });

    collectionsTab.addEventListener('click', () => {
      collectionsTab.className = 'px-3 py-2 text-sm font-medium text-blue-600 border-b-2 border-blue-600 cursor-pointer';
      uploadTab.className = 'px-3 py-2 text-sm font-medium text-gray-600 hover:text-gray-900 cursor-pointer';
      collectionsContent.classList.remove('hidden');
      uploadContent.classList.add('hidden');
      loadCollections();
    });

    // Upload form handling
    const form = document.getElementById('uploadForm');
    const progress = document.getElementById('progress');
    const results = document.getElementById('results');
    const error = document.getElementById('error');
    const submitBtn = document.getElementById('submitBtn');

    form.addEventListener('submit', async (e) => {
      e.preventDefault();

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

        displayResults(data, null);

      } catch (err) {
        error.textContent = 'Error: ' + err.message;
        error.classList.remove('hidden');
      } finally {
        progress.classList.add('hidden');
        submitBtn.disabled = false;
      }
    });

    // Load collections
    async function loadCollections() {
      try {
        const response = await fetch('/v1/collections');
        const data = await response.json();

        const grid = document.getElementById('collectionsGrid');
        const empty = document.getElementById('collectionsEmpty');

        if (!data.collections || data.collections.length === 0) {
          grid.innerHTML = '';
          empty.classList.remove('hidden');
          return;
        }

        empty.classList.add('hidden');
        grid.innerHTML = '';

        data.collections.forEach(col => {
          const card = document.createElement('div');
          card.className = 'border border-gray-200 rounded p-3 hover:border-blue-400 hover:shadow-sm transition cursor-pointer';

          const date = new Date(col.processed_date);
          const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

          card.innerHTML = \`
            <h3 class="text-sm font-medium text-gray-900 mb-1 truncate">\${col.filename}</h3>
            <div class="text-xs text-gray-500 space-y-0.5">
              <div>\${dateStr}</div>
              <div>\${col.duration_sec?.toFixed(0) || '?'}s · \${col.speaker_count} spk</div>
            </div>
          \`;

          card.addEventListener('click', () => loadCollection(col.id));
          grid.appendChild(card);
        });
      } catch (err) {
        error.textContent = 'Error loading collections: ' + err.message;
        error.classList.remove('hidden');
      }
    }

    // Load specific collection
    async function loadCollection(id) {
      try {
        const response = await fetch(\`/v1/collections/\${id}\`);
        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to load collection');
        }

        currentCollectionId = id;
        displayResults(data, id);
      } catch (err) {
        error.textContent = 'Error loading collection: ' + err.message;
        error.classList.remove('hidden');
      }
    }

    // Display results with speaker colors and renaming
    function displayResults(data, collectionId) {
      currentData = data;
      currentCollectionId = collectionId;
      speakerNames = data.speaker_names || {};

      // Metadata
      document.getElementById('duration').textContent = data.duration_sec?.toFixed(0) || '?';
      document.getElementById('detectedLang').textContent = data.asr?.language || '?';

      const speakers = new Set(data.aligned.speaker_segments.map(s => s.speaker));
      document.getElementById('speakerCount').textContent = speakers.size;

      // Transcript with colors and editable names
      const transcript = document.getElementById('transcript');
      transcript.innerHTML = '';

      data.aligned.speaker_segments.forEach((seg, idx) => {
        const div = document.createElement('div');
        const colors = SPEAKER_COLORS[seg.speaker] || SPEAKER_COLORS['SPEAKER_00'];

        div.className = 'transcript-segment pl-3 py-2 border-l-2 transition-all duration-200 cursor-pointer hover:border-l-4 hover:bg-opacity-30';
        div.style.borderColor = colors.border;
        div.setAttribute('data-segment-idx', idx);
        div.setAttribute('data-start-time', seg.start);

        // Add hover background color
        div.addEventListener('mouseenter', () => {
          div.style.backgroundColor = colors.bg;
        });
        div.addEventListener('mouseleave', () => {
          // Only remove background if not currently active
          if (!div.classList.contains('bg-blue-50')) {
            div.style.backgroundColor = '';
          }
        });

        const displayName = speakerNames[seg.speaker] || seg.speaker;

        div.innerHTML = \`
          <div class="flex items-baseline gap-2 mb-1">
            <span class="text-xs font-semibold speaker-name hover:underline cursor-pointer"
                  style="color: \${colors.text}; background-color: \${colors.bg}; padding: 1px 6px; border-radius: 3px;"
                  data-speaker="\${seg.speaker}"
                  data-idx="\${idx}">
              \${displayName}
            </span>
            <span class="text-xs text-gray-400">\${seg.start.toFixed(1)}s</span>
          </div>
          <p class="text-sm text-gray-800 leading-relaxed">\${seg.text || '(silence)'}</p>
        \`;

        transcript.appendChild(div);
      });

      // Add double-click listeners for renaming
      document.querySelectorAll('.speaker-name').forEach(el => {
        el.addEventListener('dblclick', (e) => {
          e.stopPropagation(); // Prevent segment click when double-clicking speaker name
          const speaker = e.target.getAttribute('data-speaker');
          const currentName = speakerNames[speaker] || speaker;
          const newName = prompt(\`Rename \${currentName}:\`, currentName);

          if (newName && newName.trim() && newName !== currentName) {
            speakerNames[speaker] = newName.trim();
            // Update all occurrences in UI
            document.querySelectorAll(\`[data-speaker="\${speaker}"]\`).forEach(span => {
              span.textContent = newName.trim();
            });
            // Show save button
            document.getElementById('saveNamesBtn').classList.remove('hidden');
          }
        });
      });

      // Add click listeners to segments for audio seeking
      document.querySelectorAll('.transcript-segment').forEach(el => {
        el.addEventListener('click', (e) => {
          // Don't seek if clicking on speaker name (for renaming)
          if (e.target.classList.contains('speaker-name')) return;

          const startTime = parseFloat(el.getAttribute('data-start-time'));
          if (audioElement && isAudioLoaded && !isNaN(startTime)) {
            audioElement.currentTime = startTime;
            // Auto-play if not already playing
            if (audioElement.paused) {
              audioElement.play();
              const playIcon = document.getElementById('playIcon');
              playIcon.innerHTML = '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>';
            }
          }
        });
      });

      // Raw JSON
      document.getElementById('rawJson').textContent = JSON.stringify(data, null, 2);

      results.classList.remove('hidden');

      // Show save button if viewing a collection
      if (collectionId) {
        document.getElementById('saveNamesBtn').classList.remove('hidden');
      } else {
        document.getElementById('saveNamesBtn').classList.add('hidden');
      }

      // Load audio if viewing a collection
      if (collectionId) {
        loadAudio(collectionId);
      }
    }

    // Format time in MM:SS format
    function formatTime(seconds) {
      const mins = Math.floor(seconds / 60);
      const secs = Math.floor(seconds % 60);
      return \`\${mins}:\${secs.toString().padStart(2, '0')}\`;
    }

    // Load audio file for playback
    async function loadAudio(collectionId) {
      if (!collectionId) return;

      const loading = document.getElementById('audioLoading');
      loading.classList.remove('hidden');

      try {
        const response = await fetch(\`/v1/collections/\${collectionId}/audio\`);
        if (!response.ok) throw new Error('Audio not found');

        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);

        audioElement = document.getElementById('audioElement');
        audioElement.src = audioUrl;
        audioElement.load();

        audioElement.addEventListener('loadedmetadata', () => {
          const seeker = document.getElementById('audioSeeker');
          seeker.max = audioElement.duration;
          document.getElementById('totalTime').textContent = formatTime(audioElement.duration);
          document.getElementById('audioPlayer').classList.remove('hidden');
          isAudioLoaded = true;
          loading.classList.add('hidden');

          // Setup sticky audio bar observer
          setupStickyAudioBar();
        });

        // Update UI during playback
        audioElement.addEventListener('timeupdate', handleTimeUpdate);
      } catch (err) {
        loading.classList.add('hidden');
        console.error('Failed to load audio:', err);
      }
    }

    // Handle audio time updates and auto-scroll
    function handleTimeUpdate() {
      const currentTime = audioElement.currentTime;

      // Update seeker and time display
      document.getElementById('audioSeeker').value = currentTime;
      document.getElementById('currentTime').textContent = formatTime(currentTime);

      // Find current segment based on audio time
      const segments = currentData.aligned.speaker_segments;
      let foundIndex = -1;

      for (let i = 0; i < segments.length; i++) {
        if (currentTime >= segments[i].start && currentTime < segments[i].end) {
          foundIndex = i;
          break;
        }
      }

      // Highlight and scroll to current segment
      if (foundIndex !== currentSegmentIndex && foundIndex !== -1) {
        currentSegmentIndex = foundIndex;

        // Remove previous highlight
        document.querySelectorAll('.transcript-segment').forEach(el => {
          el.classList.remove('bg-blue-50', 'bg-opacity-50');
        });

        // Add highlight to current segment
        const currentSegment = document.querySelectorAll('.transcript-segment')[foundIndex];
        if (currentSegment) {
          currentSegment.classList.add('bg-blue-50', 'bg-opacity-50');
          currentSegment.scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    }

    // Play/Pause button
    document.getElementById('playBtn').addEventListener('click', () => {
      if (!audioElement || !isAudioLoaded) return;

      const playIcon = document.getElementById('playIcon');
      if (audioElement.paused) {
        audioElement.play();
        // Change to pause icon
        playIcon.innerHTML = '<rect x="14" y="3" width="5" height="18" rx="1"/><rect x="5" y="3" width="5" height="18" rx="1"/>';
      } else {
        audioElement.pause();
        // Change to play icon
        playIcon.innerHTML = '<path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>';
      }
    });

    // Audio seeker control
    document.getElementById('audioSeeker').addEventListener('input', (e) => {
      if (!audioElement || !isAudioLoaded) return;
      audioElement.currentTime = e.target.value;
    });

    // Playback speed control
    document.getElementById('playbackSpeed').addEventListener('change', (e) => {
      if (!audioElement || !isAudioLoaded) return;
      audioElement.playbackRate = parseFloat(e.target.value);
    });

    // Save speaker names
    document.getElementById('saveNamesBtn').addEventListener('click', async () => {
      if (!currentCollectionId) return;

      try {
        const response = await fetch(\`/v1/collections/\${currentCollectionId}/speaker-names\`, {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ speaker_names: speakerNames })
        });

        const data = await response.json();

        if (!response.ok) {
          throw new Error(data.error || 'Failed to save speaker names');
        }

        // Show success feedback
        const btn = document.getElementById('saveNamesBtn');
        btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M20 6 9 17l-5-5"/></svg><span>Saved</span>';
        btn.classList.remove('bg-green-600', 'hover:bg-green-700');
        btn.classList.add('bg-gray-300');
        setTimeout(() => {
          btn.innerHTML = '<svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg><span>Save</span>';
          btn.classList.remove('bg-gray-300');
          btn.classList.add('bg-green-600', 'hover:bg-green-700');
          btn.classList.add('hidden');
        }, 1500);

      } catch (err) {
        error.textContent = 'Error saving speaker names: ' + err.message;
        error.classList.remove('hidden');
      }
    });
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

  debug("PIPELINE", "Request received", {}, 0);

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
  }, 2);

  debug("TEMP", "Directory created", { path: tmpDir, id }, 3);

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
    debug("UPLOAD", "File written to disk", { size_bytes: stat.size, size_mb: (stat.size / 1024 / 1024).toFixed(2) }, 5);

    if (stat.size > 2 * 1024 * 1024 * 1024) {
      debug("UPLOAD", "File too large, rejecting", { size_bytes: stat.size });
      return c.text("File too large", 413);
    }

    // Preprocess: Convert any format (mp3/mp4/wav) to standardized 16kHz mono WAV
    // Why: ML models require consistent input format; ffmpeg handles all conversions
    debug("PREPROCESS", "Starting audio conversion to 16kHz mono WAV", {}, 8);
    await runFfmpegToWav16kMono(srcPath, outWav);
    const duration = (await getDurationSec(outWav)) ?? null;
    debug("PREPROCESS", "Audio conversion complete", { duration_sec: duration }, 12);

    // Key optimization: Run ASR and diarization in parallel (both read same WAV file)
    // Why: Saves ~50% processing time since operations are independent
    // Both use CPU-only inference, so no GPU contention
    debug("PIPELINE", "Starting parallel processing (ASR + diarization)", { diarization: "pyannote", asr: asrModel }, 15);
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
    debug("PIPELINE", "Parallel processing complete", { elapsed_ms: parallelElapsed }, 75);

    // Sort by timestamp for chronological order, then align words to speakers
    debug("ALIGN", "Starting word-to-speaker alignment", {}, 78);
    diarSegments.sort((a, b) => a.start - b.start);
    const words = asrResult.words.sort((a, b) => a.start - b.start);
    const aligned = alignWordsToDiarization(words, diarSegments);
    debug("ALIGN", "Alignment complete", { speaker_segments: aligned.length }, 82);

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
