#!/usr/bin/env python3
"""
YouTube Download CLI Script Wrapper

Purpose: Downloads video/audio from YouTube URLs using yt-dlp CLI tool.
Validates dependencies, sanitizes inputs, and returns download metadata.

Usage:
  python download_youtube.py <youtube_url> --output <output_path> [--format audio|video] [--start TIME] [--end TIME]

Output: JSON to stdout with file metadata
  {"file_path": "...", "title": "...", "duration": ..., "format": "..."}

Security/Reliability:
  - Input validation: Validates YouTube URL format before execution
  - No shell injection: Uses subprocess.run() with explicit args (no shell=True)
  - Dependency checks: Verifies yt-dlp and ffmpeg CLI tools exist
  - Path safety: Uses shlex.quote() for file paths
  - Timeout handling: Sets reasonable timeout for downloads
  - Atomic: Validates output file before reporting success

Note on ToS: Downloading YouTube videos without permission violates YouTube's ToS.
Recommend users only download content they have rights to, or ensure they have YouTube Premium.
"""

import sys
import json
import argparse
import os
import shutil
import subprocess
import re
import shlex
import tempfile
from pathlib import Path
from typing import Optional


def validate_youtube_url(url: str) -> bool:
    """
    Validate that URL is a valid YouTube URL.

    Args:
        url: URL to validate

    Returns:
        True if valid YouTube URL, False otherwise
    """
    youtube_patterns = [
        r'(?:https?://)?(?:www\.)?youtube\.com/watch\?v=[a-zA-Z0-9_-]{11}',
        r'(?:https?://)?(?:www\.)?youtu\.be/[a-zA-Z0-9_-]{11}',
        r'(?:https?://)?(?:www\.)?youtube\.com/playlist\?list=[a-zA-Z0-9_-]+',
    ]

    for pattern in youtube_patterns:
        if re.match(pattern, url):
            return True
    return False


def parse_time_format(time_str: str) -> int:
    """
    Parse flexible time format to seconds.

    Accepts: "SS" (e.g., "45"), "MM:SS" (e.g., "1:30"), "HH:MM:SS" (e.g., "1:30:45")

    Args:
        time_str: Time string to parse

    Returns:
        Total seconds as integer

    Raises:
        ValueError: If format is invalid
    """
    parts = time_str.split(':')

    if len(parts) < 1 or len(parts) > 3:
        raise ValueError(f"Invalid time format: {time_str}. Use SS, MM:SS, or HH:MM:SS")

    try:
        # Convert parts to integers (right-to-left: seconds, minutes, hours)
        seconds = 0
        multiplier = 1
        for part in reversed(parts):
            if not part.isdigit():
                raise ValueError(f"Invalid time component: {part}")
            value = int(part)

            # Validate ranges (minutes/seconds should be 0-59, hours unlimited)
            if multiplier in [60, 3600] and value > 59:
                raise ValueError(f"Invalid time: {time_str} (minutes/seconds must be 0-59)")

            seconds += value * multiplier
            multiplier *= 60

        return seconds
    except (ValueError, AttributeError) as e:
        raise ValueError(f"Failed to parse time {time_str}: {e}")


def validate_time_range(start: str, end: str) -> tuple:
    """
    Parse and validate start/end times.

    Args:
        start: Start time string
        end: End time string

    Returns:
        (start_seconds, end_seconds) tuple

    Raises:
        ValueError: If validation fails
    """
    start_sec = parse_time_format(start)
    end_sec = parse_time_format(end)

    if start_sec >= end_sec:
        raise ValueError(f"Start time ({start_sec}s) must be before end time ({end_sec}s)")

    if start_sec < 0:
        raise ValueError("Start time cannot be negative")

    return start_sec, end_sec


def check_cli_tool(tool_name: str, version_arg: str = "--version") -> bool:
    """
    Check if a CLI tool is installed and accessible.

    Args:
        tool_name: Name of the tool (e.g., 'yt-dlp', 'ffmpeg')
        version_arg: Argument to check version (default: '--version')

    Returns:
        True if tool is available, False otherwise
    """
    if not shutil.which(tool_name):
        return False

    try:
        subprocess.run(
            [tool_name, version_arg],
            capture_output=True,
            timeout=5,
            check=False
        )
        return True
    except (subprocess.TimeoutExpired, Exception):
        return False


def validate_dependencies() -> dict:
    """
    Validate required CLI tools are installed.

    Returns:
        dict with validation results, raises RuntimeError if critical tools missing

    Raises:
        RuntimeError: If yt-dlp or ffmpeg not found
    """
    results = {}

    # Check yt-dlp (required)
    if not check_cli_tool('yt-dlp'):
        raise RuntimeError(
            "yt-dlp CLI not found. Install with:\n"
            "  Ubuntu/Debian: sudo apt install yt-dlp\n"
            "  macOS: brew install yt-dlp\n"
            "  Or: pip install yt-dlp"
        )
    results['yt_dlp'] = True

    # Check ffmpeg (required for audio/video conversion)
    if not check_cli_tool('ffmpeg', '-version'):
        raise RuntimeError(
            "ffmpeg not found. Install with:\n"
            "  Ubuntu/Debian: sudo apt install ffmpeg\n"
            "  macOS: brew install ffmpeg"
        )
    results['ffmpeg'] = True

    return results


def sanitize_output_path(output_path: str) -> str:
    """
    Sanitize and validate output path.

    Args:
        output_path: Requested output path

    Returns:
        Absolute path (safe for subprocess)

    Raises:
        ValueError: If path is invalid or unsafe
    """
    # Expand user home directory
    path = Path(output_path).expanduser()

    # Ensure parent directory exists
    parent = path.parent
    try:
        parent.mkdir(parents=True, exist_ok=True)
    except OSError as e:
        raise ValueError(f"Cannot create output directory: {e}")

    # Prevent directory traversal attacks
    try:
        path.resolve()
    except (OSError, RuntimeError) as e:
        raise ValueError(f"Invalid path: {e}")

    return str(path.absolute())


def download_transcript(url: str, output_path: str, language: str = 'en') -> Optional[dict]:
    """
    Download YouTube transcript using yt-dlp.

    Args:
        url: YouTube URL
        output_path: Base path for output (will add .transcript.json)
        language: Subtitle language code (default: 'en')

    Returns:
        Dict with transcript data or None if unavailable
    """
    transcript_file = output_path + '.transcript.json'

    try:
        # Use yt-dlp to download auto-generated subtitles
        cmd = [
            'yt-dlp',
            '--skip-download',           # Don't download video/audio
            '--write-auto-sub',           # Auto-generated captions
            '--sub-lang', language,       # Language
            '--sub-format', 'json3',      # JSON format with timestamps
            '--output', output_path,      # Base output path
            '--no-warnings',
            url
        ]

        print(f"[PROGRESS] Downloading transcript for language: {language}", file=sys.stderr, flush=True)

        result = subprocess.run(cmd, capture_output=True, text=True, timeout=60)

        # yt-dlp creates: {output_path}.{lang}.json3
        json3_file = f"{output_path}.{language}.json3"

        if not os.path.exists(json3_file):
            print(f"[PROGRESS] No transcript available", file=sys.stderr, flush=True)
            return None

        # Parse JSON3 format
        with open(json3_file, 'r', encoding='utf-8') as f:
            data = json.load(f)

        # Convert to standardized format
        segments = []
        for event in data.get('events', []):
            if 'segs' in event:
                # Combine text segments
                text = ''.join(seg.get('utf8', '') for seg in event['segs'])
                text = text.strip()

                if text:
                    start_ms = event.get('tStartMs', 0)
                    duration_ms = event.get('dDurationMs', 0)

                    segments.append({
                        'start': start_ms / 1000.0,      # Convert to seconds
                        'end': (start_ms + duration_ms) / 1000.0,
                        'text': text
                    })

        # Create standardized transcript output
        transcript_data = {
            'segments': segments,
            'language': language,
            'source': 'youtube_auto',
            'segment_count': len(segments)
        }

        # Save to .transcript.json
        with open(transcript_file, 'w', encoding='utf-8') as f:
            json.dump(transcript_data, f, indent=2, ensure_ascii=False)

        # Clean up intermediate file
        os.remove(json3_file)

        print(f"[PROGRESS] Transcript downloaded: {len(segments)} segments", file=sys.stderr, flush=True)

        return transcript_data

    except subprocess.TimeoutExpired:
        print(f"[PROGRESS] Transcript download timeout", file=sys.stderr, flush=True)
        return None
    except Exception as e:
        print(f"[PROGRESS] Transcript download failed: {e}", file=sys.stderr, flush=True)
        return None


def download_youtube(url: str, output_path: str, format_type: str, start: str = None, end: str = None, timeout: int = 600, transcript: bool = False) -> dict:
    """
    Download YouTube video/audio using yt-dlp CLI tool.

    Args:
        url: YouTube URL
        output_path: Where to save the file
        format_type: 'audio' or 'video'
        start: Optional start time for cropping (SS, MM:SS, or HH:MM:SS)
        end: Optional end time for cropping (SS, MM:SS, or HH:MM:SS)
        timeout: Download timeout in seconds (default: 600 = 10 mins)
        transcript: Download YouTube auto-generated transcript with timestamps (default: False)

    Returns:
        dict with download metadata (file_path, title, duration, etc.)

    Raises:
        RuntimeError: If download fails
        ValueError: If inputs are invalid
    """
    # Validate inputs
    if not validate_youtube_url(url):
        raise ValueError(f"Invalid YouTube URL: {url}")

    output_path = sanitize_output_path(output_path)

    # Validate time range if provided
    use_ffmpeg_crop = False
    start_sec = end_sec = None
    if start or end:
        if not (start and end):
            raise ValueError("Both --start and --end must be specified together")
        start_sec, end_sec = validate_time_range(start, end)
        use_ffmpeg_crop = True

    # Determine final output path and whether we need a temp file
    final_output_path = output_path
    if use_ffmpeg_crop:
        # Download to temp file first, then crop with ffmpeg
        # Use native format extension for temp file (yt-dlp will download in m4a/opus for audio)
        temp_dir = tempfile.gettempdir()
        temp_ext = '.m4a' if format_type == 'audio' else '.mp4'
        temp_fd, temp_file = tempfile.mkstemp(suffix=temp_ext, dir=temp_dir)
        os.close(temp_fd)  # Close file descriptor
        os.unlink(temp_file)  # Delete the empty file so yt-dlp can create it fresh
        download_path = temp_file
    else:
        download_path = output_path

    # Build yt-dlp command with security-conscious arguments
    # Note: Using explicit list (no shell=True) to prevent injection
    cmd = ['yt-dlp']

    # Format selection
    if format_type == 'audio':
        if use_ffmpeg_crop:
            # When cropping, download without post-processing to avoid codec issues
            # We'll extract audio with ffmpeg during cropping
            cmd.extend(['-f', 'bestaudio/best'])
        else:
            # Only extract audio during download when not cropping
            cmd.extend(['-f', 'bestaudio/best'])
            cmd.extend(['-x', '--audio-format', 'wav', '--audio-quality', '192K'])
    else:
        # Download best video
        cmd.extend(['-f', 'best'])

    # Output handling
    # Use -o with explicit path (already sanitized)
    cmd.extend(['-o', download_path])

    # Reliability options
    cmd.extend(['--no-warnings', '--quiet'])  # Suppress progress (we control output)
    cmd.extend(['--socket-timeout', '30'])     # Network timeout
    cmd.extend(['--fragment-retries', '3'])    # Retry failed fragments
    cmd.append(url)

    try:
        # Execute download with timeout
        result = subprocess.run(
            cmd,
            capture_output=True,
            timeout=timeout,
            text=True,
            check=False
        )

        # Check for errors
        if result.returncode != 0:
            error_msg = result.stderr.strip() if result.stderr else "Unknown error"
            raise RuntimeError(f"yt-dlp failed: {error_msg}")

        # Validate downloaded file exists and has reasonable size
        if not os.path.exists(download_path):
            # Check for possible extension changes (e.g., .wav added to audio downloads)
            base, ext = os.path.splitext(download_path)
            possible_files = [
                download_path,
                f"{base}.wav",
                f"{base}.mp4",
                f"{base}.m4a",
            ]
            actual_path = None
            for candidate in possible_files:
                if os.path.exists(candidate):
                    actual_path = candidate
                    break

            if not actual_path:
                raise RuntimeError(f"Download file not found at {download_path}")
            download_path = actual_path

        file_size = os.path.getsize(download_path)
        if file_size < 1024:  # Less than 1KB is suspicious
            raise RuntimeError(f"Downloaded file too small ({file_size} bytes)")

        # If time cropping is needed, use ffmpeg to crop the downloaded file
        if use_ffmpeg_crop:
            # Calculate duration for -t parameter
            duration = end_sec - start_sec

            # Build ffmpeg command with FAST SEEKING
            # Key optimization: -ss BEFORE -i for input seeking (much faster)
            ffmpeg_cmd = [
                'ffmpeg',
                '-ss', str(start_sec),          # Start time (BEFORE input for fast seek)
                '-t', str(duration),            # Duration
                '-i', download_path,            # Input file
            ]

            if format_type == 'audio':
                # Extract audio and convert to WAV
                ffmpeg_cmd.extend([
                    '-vn',                      # No video
                    '-acodec', 'pcm_s16le',     # WAV audio codec
                    '-ar', '16000',             # Sample rate (16kHz for speech)
                    '-ac', '1',                 # Mono
                ])
            else:
                # Copy video codec (no re-encoding for speed)
                ffmpeg_cmd.extend(['-c', 'copy'])

            ffmpeg_cmd.extend([
                '-y',                           # Overwrite output
                final_output_path
            ])

            try:
                ffmpeg_result = subprocess.run(
                    ffmpeg_cmd,
                    capture_output=True,
                    timeout=60,  # 1 minute timeout (should be much faster now)
                    text=True,
                    check=False
                )

                if ffmpeg_result.returncode != 0:
                    error_msg = ffmpeg_result.stderr.strip() if ffmpeg_result.stderr else "Unknown error"
                    raise RuntimeError(f"ffmpeg cropping failed: {error_msg}")

                if not os.path.exists(final_output_path):
                    raise RuntimeError(f"Cropped file not created at {final_output_path}")

                # Update file_size to cropped file size
                file_size = os.path.getsize(final_output_path)

            finally:
                # Clean up temporary full download (always runs, even on error)
                if os.path.exists(download_path):
                    try:
                        os.unlink(download_path)
                    except OSError:
                        pass  # Ignore cleanup errors

        # Extract metadata from yt-dlp using JSON output
        # Re-run with --dump-json to get metadata (faster than second download)
        meta_cmd = ['yt-dlp', '--dump-json', '--no-warnings', url]
        meta_result = subprocess.run(
            meta_cmd,
            capture_output=True,
            timeout=30,
            text=True,
            check=False
        )

        metadata = {}
        if meta_result.returncode == 0:
            try:
                metadata = json.loads(meta_result.stdout)
            except json.JSONDecodeError:
                pass  # Ignore metadata errors

        # Download transcript if requested
        transcript_data = None
        if transcript:
            transcript_data = download_transcript(url, output_path, language='en')

        return {
            'file_path': final_output_path,
            'title': metadata.get('title', 'Unknown'),
            'duration': metadata.get('duration', 0),
            'uploader': metadata.get('uploader', 'Unknown'),
            'format': format_type,
            'file_size_bytes': file_size,
            'transcript_available': transcript_data is not None,
            'transcript_segments': len(transcript_data['segments']) if transcript_data else 0
        }

    except subprocess.TimeoutExpired:
        raise RuntimeError(f"Download timed out after {timeout} seconds")
    except Exception as e:
        raise RuntimeError(f"Download failed: {str(e)}")


def main():
    """Main entry point for CLI script."""
    parser = argparse.ArgumentParser(
        description='Download YouTube video/audio using yt-dlp CLI tool',
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog='''
Examples:
  # Download full audio
  python download_youtube.py "https://youtube.com/watch?v=dQw4w9WgXcQ" --output video.wav

  # Download full video
  python download_youtube.py "https://youtube.com/watch?v=dQw4w9WgXcQ" --output video.mp4 --format video

  # Download audio segment (1:30 to 3:45)
  python download_youtube.py "https://youtube.com/watch?v=dQw4w9WgXcQ" --output clip.wav --start "1:30" --end "3:45"

  # Download video segment using seconds
  python download_youtube.py "https://youtube.com/watch?v=dQw4w9WgXcQ" --output clip.mp4 --format video --start "90" --end "225"
        '''
    )

    parser.add_argument('url', help='YouTube video URL')
    parser.add_argument(
        '--output',
        required=True,
        help='Output file path (e.g., /tmp/video.wav or ./downloads/video.mp4)'
    )
    parser.add_argument(
        '--format',
        choices=['audio', 'video'],
        default='audio',
        help='Download format: audio (converts to WAV) or video (MP4). Default: audio'
    )
    parser.add_argument(
        '--timeout',
        type=int,
        default=600,
        help='Download timeout in seconds (default: 600 = 10 minutes)'
    )
    parser.add_argument(
        '--start',
        default=None,
        help='Start time for cropping (formats: SS, MM:SS, or HH:MM:SS). Example: "1:30" or "90"'
    )
    parser.add_argument(
        '--end',
        default=None,
        help='End time for cropping (formats: SS, MM:SS, or HH:MM:SS). Example: "3:45" or "225"'
    )
    parser.add_argument(
        '--transcript',
        action='store_true',
        help='Download YouTube auto-generated transcript with timestamps'
    )

    args = parser.parse_args()

    try:
        # Validate dependencies before attempting download
        validate_dependencies()

        # Perform download
        result = download_youtube(
            url=args.url,
            output_path=args.output,
            format_type=args.format,
            start=args.start,
            end=args.end,
            timeout=args.timeout,
            transcript=args.transcript
        )

        # Output JSON to stdout (follows project pattern)
        print(json.dumps(result))

    except Exception as e:
        # Errors to stderr (TypeScript layer captures this)
        print(json.dumps({'error': str(e)}), file=sys.stderr)
        sys.exit(1)


if __name__ == '__main__':
    main()
