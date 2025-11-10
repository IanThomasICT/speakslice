# YouTube Video Embedding & Custom Name Field

**Status:** ✅ Implemented
**Created:** 2025-01-07
**Completed:** 2025-01-09
**Priority:** High

## Overview

Add YouTube video embedding functionality with synchronized playback and custom naming for both file uploads and YouTube videos. This enhancement provides visual context for YouTube transcripts and better organization for all collections.

## User Requirements

Based on user feedback, the implementation should:

1. ✅ **Show YouTube video player** - Display embedded video in results view
2. ✅ **Add "Name" field** - Allow custom naming for both file and YouTube uploads
3. ✅ **Autofill YouTube title** - Pre-populate name field with video title (user can override)
4. ✅ **Always use YouTube embed** - Stream from YouTube when URL is available
5. ✅ **Normal scroll behavior** - Video player scrolls with page (not sticky)

## Goals & Benefits

### For YouTube Videos
- **Visual Context**: Users see what's happening in the video while reading transcript
- **Click-to-Seek**: Click transcript segment → video jumps to that timestamp
- **Synchronized Highlighting**: Transcript highlights as video plays
- **Better Organization**: Use meaningful video titles instead of "youtube-audio.wav"

### For All Uploads
- **Custom Naming**: Give meaningful names to any transcript
- **Better Collections**: Easier to identify and find past transcripts
- **Flexibility**: Override auto-generated names when needed

## Current State Analysis

### What We Have

**Audio Player** (src/app.tsx:677-898)
- React component with `<audio>` element
- Time tracking via `timeupdate` event
- Playback controls (play/pause, seek, speed)
- Sticky behavior with Intersection Observer
- Auto-scroll to current segment

**Collection Cards** (src/app.tsx:542-614)
- Display filename, date, duration, speaker count
- Load collection on click
- Grid layout in Collections tab

**Data Storage** (src/server.ts:744-761)
- Saves response.json to cache/YYYYMMDD-HHmm/
- Includes: filename, duration, diarization, ASR, aligned segments
- **Missing**: youtube_url, custom name

### What's Missing

1. **YouTube URL storage** - Not saved in response.json
2. **Custom name field** - No way to set/store custom names
3. **YouTube title extraction** - Available but not stored
4. **Video player component** - Only audio player exists
5. **YouTube IFrame API** - Not integrated
6. **Collection name display** - Uses filename, not meaningful titles

## Implementation Phases

### Phase 1: Backend Data Storage

**Objective:** Store youtube_url and name in response.json

**1.1 Update callYoutubeDownloadScript() return type** (src/server.ts:313-385)

```typescript
// BEFORE:
async function callYoutubeDownloadScript(
  url: string,
  outputPath: string,
  start?: number,
  end?: number,
  fetchTranscript: boolean = true
): Promise<{transcriptAvailable: boolean}>

// AFTER:
async function callYoutubeDownloadScript(
  url: string,
  outputPath: string,
  start?: number,
  end?: number,
  fetchTranscript: boolean = true
): Promise<{
  transcriptAvailable: boolean;
  videoTitle?: string;
}>

// Extract title from download script output
const result = JSON.parse(stdout);
resolve({
  transcriptAvailable: result.transcript_available || false,
  videoTitle: result.title  // ADD THIS
});
```

**1.2 Accept name parameter from form** (src/server.ts:539)

```typescript
const form = await c.req.parseBody();
const file = form["file"];
const youtubeUrl = form["youtube_url"] as string | undefined;
const customName = form["name"] as string | undefined;  // ADD THIS
```

**1.3 Update response payload** (src/server.ts:744-761)

```typescript
// Determine final name (priority: custom > video title > filename)
const finalName = customName || videoTitle || filename;

const responsePayload = {
  file: (c.req.header("x-filename") as string) || filename || "upload",
  name: finalName,                    // ADD THIS
  youtube_url: youtubeUrl || null,   // ADD THIS
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
```

**1.4 Update /v1/collections endpoint** (src/server.ts:836-885)

```typescript
// Extract from response.json
collections.push({
  id: entry.name,
  filename: data.file || "unknown",
  name: data.name || data.file || "unknown",  // ADD THIS
  youtube_url: data.youtube_url || null,       // ADD THIS
  processed_date: processedDate?.toISOString() || null,
  duration_sec: data.duration_sec || null,
  speaker_count: speakers.size,
  language: data.asr?.language || null,
});
```

**Files Modified:**
- src/server.ts (4 locations)

**Testing:**
- [ ] Process YouTube URL → youtube_url and title saved
- [ ] Process file upload → filename saved as name
- [ ] Custom name provided → custom name saved
- [ ] Collections endpoint returns name and youtube_url

---

### Phase 2: Frontend Type Definitions

**Objective:** Update TypeScript types to support new fields

**2.1 Update ProcessedData type** (src/app.tsx:14-20)

```typescript
type ProcessedData = {
  file: string;
  name?: string;          // ADD THIS
  youtube_url?: string;   // ADD THIS
  duration_sec: number;
  asr: { language: string; words: Word[]; segments: ASRSegment[] };
  aligned: { speaker_segments: Segment[] };
  speaker_names?: Record<string, string>;
};
```

**2.2 Update Collection type** (src/app.tsx:21-28)

```typescript
type Collection = {
  id: string;
  filename: string;
  name?: string;          // ADD THIS
  youtube_url?: string;   // ADD THIS
  processed_date: string;
  duration_sec: number;
  speaker_count: number;
  language: string;
};
```

**Files Modified:**
- src/app.tsx (2 locations)

**Testing:**
- [ ] TypeScript compiles without errors
- [ ] Type inference works correctly

---

### Phase 3: Upload Form Enhancement

**Objective:** Add Name input field with YouTube title autofill

**3.1 Add state for name field** (src/app.tsx:~320)

```typescript
const [customName, setCustomName] = useState("");
const [youtubeTitle, setYoutubeTitle] = useState("");
```

**3.2 Fetch YouTube title on URL change** (src/app.tsx:~350)

```typescript
const handleYoutubeUrlChange = async (url: string) => {
  setYoutubeUrl(url);

  if (validateYoutubeUrl(url)) {
    try {
      // Fetch metadata using YouTube API (if configured)
      if (window.YOUTUBE_API_KEY) {
        const videoId = extractVideoId(url);
        const response = await fetch(
          `https://www.googleapis.com/youtube/v3/videos?id=${videoId}&key=${window.YOUTUBE_API_KEY}&part=snippet`
        );
        const data = await response.json();
        const title = data.items?.[0]?.snippet?.title;
        if (title) {
          setYoutubeTitle(title);
          setCustomName(title);  // Autofill
        }
      }
    } catch (error) {
      console.error("Failed to fetch YouTube title:", error);
    }
  }
};
```

**3.3 Add Name input field UI** (src/app.tsx:~420)

```typescript
{/* Name Field - shows for both file and YouTube uploads */}
<div className="mb-4">
  <label className="block text-sm font-medium text-gray-700 mb-2">
    Name (Optional)
  </label>
  <input
    type="text"
    value={customName}
    onChange={(e) => setCustomName(e.target.value)}
    placeholder={
      youtubeUrl
        ? "Auto-filled from YouTube video title"
        : "Give this transcript a custom name"
    }
    className="w-full px-3 py-2 border border-gray-300 rounded-md focus:outline-none focus:ring-2 focus:ring-blue-500"
  />
  {youtubeTitle && (
    <p className="text-xs text-gray-500 mt-1">
      Auto-filled: {youtubeTitle}
    </p>
  )}
</div>
```

**3.4 Send name with form data** (src/app.tsx:~450)

```typescript
const formData = new FormData();

if (youtubeUrl) {
  formData.append("youtube_url", youtubeUrl);
} else if (selectedFile) {
  formData.append("file", selectedFile);
}

// Add custom name if provided
if (customName.trim()) {
  formData.append("name", customName.trim());
}

formData.append("asr_model", asrModel);
// ... rest of form fields
```

**3.5 Add video ID extraction utility** (src/app.tsx:~50)

```typescript
function extractVideoId(url: string): string | null {
  const patterns = [
    /(?:youtube\.com\/watch\?v=|youtu\.be\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = url.match(pattern);
    if (match) return match[1];
  }

  return null;
}
```

**Files Modified:**
- src/app.tsx (5 locations)

**Testing:**
- [ ] Name field appears in upload form
- [ ] YouTube URL paste → title autofills name field
- [ ] User can override autofilled name
- [ ] File upload → name field stays empty (or user can fill)
- [ ] Name sent with form data
- [ ] Works without YouTube API key (no autofill, manual entry only)

---

### Phase 4: Collection Card Display

**Objective:** Show meaningful names on collection cards

**4.1 Update card title display** (src/app.tsx:597)

```typescript
// BEFORE:
<h3 className="text-sm font-medium text-gray-900 mb-1 truncate">
  {col.filename}
</h3>

// AFTER:
<h3 className="text-sm font-medium text-gray-900 mb-1 truncate">
  {col.name || col.filename}
</h3>
```

**4.2 Add YouTube indicator** (src/app.tsx:~590)

```typescript
<div key={col.id} onClick={() => onLoadCollection(col.id)} className="...">
  {/* YouTube indicator badge */}
  {col.youtube_url && (
    <div className="absolute top-2 right-2 bg-red-600 text-white text-xs px-2 py-1 rounded">
      YouTube
    </div>
  )}

  <h3 className="text-sm font-medium text-gray-900 mb-1 truncate">
    {col.name || col.filename}
  </h3>

  {/* ... rest of card content */}
</div>
```

**Files Modified:**
- src/app.tsx (2 locations)

**Testing:**
- [ ] Collection cards show custom names
- [ ] YouTube collections have red badge
- [ ] File uploads show filename (if no custom name)
- [ ] Truncation works correctly for long names

---

### Phase 5: YouTube Player Integration

**Objective:** Embed YouTube video with synchronized playback

**5.1 Add YouTube IFrame API script** (src/index.html)

```html
<!DOCTYPE html>
<html lang="en">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>SpeakSlice</title>
    <script src="https://cdn.tailwindcss.com"></script>
    <!-- ADD THIS -->
    <script src="https://www.youtube.com/iframe_api"></script>
  </head>
  <body>
    <div id="root"></div>
    <script type="module" src="/public/app.js"></script>
  </body>
</html>
```

**5.2 Refactor AudioPlayer to MediaPlayer** (src/app.tsx:677-898)

**Key Changes:**
- Add `youtubeUrl` prop
- Create YouTube player ref
- Conditional rendering: iframe OR audio
- YouTube player time tracking
- YouTube playback controls

```typescript
function MediaPlayer({
  collectionId,
  youtubeUrl,  // NEW
  segments,
  onSaveNames,
  onSeek,
  onSegmentChange
}: {
  collectionId: string | null;
  youtubeUrl?: string | null;  // NEW
  segments: Segment[];
  onSaveNames: () => void;
  onSeek: (time: number) => void;
  onSegmentChange: (index: number) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const videoRef = useRef<any>(null);  // YouTube player
  const youtubePlayerRef = useRef<any>(null);  // NEW

  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1.0);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(-1);

  // Extract video ID if YouTube URL provided
  const videoId = youtubeUrl ? extractVideoId(youtubeUrl) : null;

  // Initialize YouTube player
  useEffect(() => {
    if (videoId && window.YT) {
      // Wait for YouTube API to be ready
      const initPlayer = () => {
        youtubePlayerRef.current = new window.YT.Player('youtube-player', {
          videoId: videoId,
          playerVars: {
            autoplay: 0,
            controls: 0,  // We provide custom controls
            modestbranding: 1,
          },
          events: {
            onReady: (event: any) => {
              setDuration(event.target.getDuration());
            },
            onStateChange: (event: any) => {
              if (event.data === window.YT.PlayerState.PLAYING) {
                setIsPlaying(true);
              } else if (event.data === window.YT.PlayerState.PAUSED) {
                setIsPlaying(false);
              }
            },
          },
        });
      };

      if (window.YT.loaded) {
        initPlayer();
      } else {
        window.onYouTubeIframeAPIReady = initPlayer;
      }
    }
  }, [videoId]);

  // Time tracking for YouTube player
  useEffect(() => {
    if (youtubePlayerRef.current) {
      const interval = setInterval(() => {
        if (youtubePlayerRef.current && youtubePlayerRef.current.getCurrentTime) {
          const time = youtubePlayerRef.current.getCurrentTime();
          setCurrentTime(time);

          // Find current segment
          const foundIndex = segments.findIndex(
            (seg) => time >= seg.start && time < seg.end
          );
          if (foundIndex !== -1 && foundIndex !== currentSegmentIndex) {
            setCurrentSegmentIndex(foundIndex);
            onSegmentChange(foundIndex);
          }
        }
      }, 100);  // Update every 100ms

      return () => clearInterval(interval);
    }
  }, [youtubePlayerRef.current, segments, currentSegmentIndex]);

  // Playback controls
  const handlePlayPause = () => {
    if (youtubePlayerRef.current) {
      if (isPlaying) {
        youtubePlayerRef.current.pauseVideo();
      } else {
        youtubePlayerRef.current.playVideo();
      }
    } else if (audioRef.current) {
      if (isPlaying) {
        audioRef.current.pause();
      } else {
        audioRef.current.play();
      }
    }
  };

  const handleSeek = (time: number) => {
    if (youtubePlayerRef.current) {
      youtubePlayerRef.current.seekTo(time, true);
    } else if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
    setCurrentTime(time);
    onSeek(time);
  };

  const handlePlaybackRateChange = (rate: number) => {
    if (youtubePlayerRef.current) {
      youtubePlayerRef.current.setPlaybackRate(rate);
    } else if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
    setPlaybackRate(rate);
  };

  return (
    <div className="bg-white rounded-lg shadow-md p-6 mb-6">
      {/* Video/Audio Embed */}
      {youtubeUrl && videoId ? (
        <div className="mb-4 aspect-video bg-black rounded">
          <div id="youtube-player" className="w-full h-full"></div>
        </div>
      ) : (
        <audio
          ref={audioRef}
          src={collectionId ? `/v1/collections/${collectionId}/audio` : undefined}
          onLoadedMetadata={() => {
            if (audioRef.current) {
              setDuration(audioRef.current.duration);
            }
          }}
          onTimeUpdate={() => {
            if (audioRef.current) {
              setCurrentTime(audioRef.current.currentTime);

              const foundIndex = segments.findIndex(
                (seg) => audioRef.current!.currentTime >= seg.start &&
                        audioRef.current!.currentTime < seg.end
              );
              if (foundIndex !== -1 && foundIndex !== currentSegmentIndex) {
                setCurrentSegmentIndex(foundIndex);
                onSegmentChange(foundIndex);
              }
            }
          }}
          className="hidden"
        />
      )}

      {/* Playback Controls */}
      <div className="flex items-center gap-4">
        {/* Play/Pause Button */}
        <button
          onClick={handlePlayPause}
          className="p-2 rounded-full hover:bg-gray-100"
        >
          {isPlaying ? (
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
              <path d="M6 4h4v16H6V4zm8 0h4v16h-4V4z"/>
            </svg>
          ) : (
            <svg className="w-6 h-6" viewBox="0 0 24 24" fill="currentColor">
              <path d="M8 5v14l11-7z"/>
            </svg>
          )}
        </button>

        {/* Time Display */}
        <div className="text-sm text-gray-600">
          {formatTime(currentTime)} / {formatTime(duration)}
        </div>

        {/* Seek Slider */}
        <input
          type="range"
          min="0"
          max={duration || 100}
          value={currentTime}
          onChange={(e) => handleSeek(Number(e.target.value))}
          className="flex-1"
        />

        {/* Playback Speed */}
        <select
          value={playbackRate}
          onChange={(e) => handlePlaybackRateChange(Number(e.target.value))}
          className="text-sm border rounded px-2 py-1"
        >
          <option value="1">1x</option>
          <option value="1.25">1.25x</option>
          <option value="1.5">1.5x</option>
          <option value="2">2x</option>
        </select>

        {/* Save Button */}
        <button
          onClick={onSaveNames}
          className="px-4 py-2 bg-blue-600 text-white rounded hover:bg-blue-700"
        >
          Save
        </button>
      </div>
    </div>
  );
}
```

**5.3 Update ResultsDisplay** (src/app.tsx:948)

```typescript
<MediaPlayer  // Renamed from AudioPlayer
  collectionId={collectionId}
  youtubeUrl={data.youtube_url}  // ADD THIS
  segments={data.aligned.speaker_segments}
  onSaveNames={handleSaveNames}
  onSeek={handleSeek}
  onSegmentChange={setCurrentSegmentIndex}
/>
```

**5.4 Add global type definition** (src/app.tsx:~1)

```typescript
// Add to top of file
declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
    YOUTUBE_API_KEY?: string;
  }
}
```

**Files Modified:**
- src/index.html (1 location)
- src/app.tsx (4 locations - rename component, add YouTube logic, update props, add types)

**Testing:**
- [ ] YouTube video displays in results
- [ ] Video plays/pauses correctly
- [ ] Click transcript → video seeks to timestamp
- [ ] Video playback → transcript highlights current segment
- [ ] Playback speed controls work
- [ ] Time scrubber works
- [ ] File uploads still use audio player
- [ ] No sticky behavior (video scrolls normally)

---

### Phase 6: UI/UX Polish

**6.1 Responsive video sizing**

```typescript
{youtubeUrl && videoId ? (
  <div className="mb-4 w-full max-w-4xl mx-auto">
    <div className="aspect-video bg-black rounded-lg overflow-hidden shadow-lg">
      <div id="youtube-player" className="w-full h-full"></div>
    </div>
  </div>
) : (
  // Audio element
)}
```

**6.2 Loading states**

```typescript
const [playerReady, setPlayerReady] = useState(false);

// In YouTube player onReady callback
onReady: (event: any) => {
  setDuration(event.target.getDuration());
  setPlayerReady(true);  // ADD THIS
},

// Show loading indicator
{youtubeUrl && videoId && !playerReady && (
  <div className="aspect-video bg-gray-100 rounded flex items-center justify-center">
    <div className="text-gray-500">Loading video...</div>
  </div>
)}
```

**6.3 Error handling**

```typescript
const [playerError, setPlayerError] = useState(false);

// In YouTube player events
onError: (event: any) => {
  setPlayerError(true);
  console.error("YouTube player error:", event.data);
},

// Show error message
{playerError && (
  <div className="bg-red-50 border border-red-200 rounded p-4 mb-4">
    <p className="text-red-800">
      Unable to load YouTube video. The video may be unavailable or deleted.
    </p>
    {collectionId && (
      <p className="text-sm text-red-600 mt-2">
        Falling back to downloaded audio...
      </p>
    )}
  </div>
)}
```

**Files Modified:**
- src/app.tsx (3 locations)

**Testing:**
- [ ] Video displays responsively
- [ ] Loading indicator shows while video loads
- [ ] Error message shows if video unavailable
- [ ] Graceful degradation to audio if video fails

---

## File Modification Summary

| File | Changes | Lines Modified |
|------|---------|----------------|
| src/server.ts | Add youtube_url, name storage | 4 locations |
| src/app.tsx | Types, name field, YouTube player | 15+ locations |
| src/index.html | YouTube IFrame API script | 1 location |

## Testing Checklist

### Backend
- [ ] YouTube URL saved to response.json
- [ ] Video title saved to response.json
- [ ] Custom name saved when provided
- [ ] Collections endpoint returns name and youtube_url
- [ ] Name priority: custom > video title > filename

### Frontend - Upload Form
- [ ] Name field appears in upload form
- [ ] YouTube URL → title autofills (with API key)
- [ ] User can override autofilled name
- [ ] Name sent with form submission
- [ ] Works without YouTube API key (manual entry)

### Frontend - Collections
- [ ] Collection cards show custom names
- [ ] YouTube badge appears on YouTube collections
- [ ] Cards display fallback to filename if no name
- [ ] Name truncation works for long names

### Frontend - YouTube Player
- [ ] YouTube video embeds and displays
- [ ] Video plays/pauses via controls
- [ ] Click transcript → video seeks
- [ ] Video playback → transcript highlights
- [ ] Time scrubber works
- [ ] Playback speed controls work (1x/1.25x/1.5x/2x)
- [ ] Video scrolls normally (not sticky)
- [ ] Loading indicator shows
- [ ] Error handling for unavailable videos

### Frontend - Audio Player
- [ ] File uploads still use audio player
- [ ] Audio playback works normally
- [ ] All controls function correctly
- [ ] No regression in existing features

### Edge Cases
- [ ] YouTube video deleted/unavailable → shows error
- [ ] Very long custom names → truncated properly
- [ ] No YouTube API key → manual name entry works
- [ ] Empty name field → falls back to title/filename
- [ ] Non-YouTube URLs rejected
- [ ] Special characters in names handled correctly

## Implementation Order

1. **Phase 1: Backend Storage** (30 min)
   - Easiest starting point
   - Enables all other features
   - Can test immediately with API calls

2. **Phase 2: Type Definitions** (15 min)
   - Required before frontend work
   - Quick TypeScript updates

3. **Phase 4: Collection Display** (15 min)
   - Simple change, shows immediate value
   - Works even without Phase 3

4. **Phase 3: Name Input Field** (45 min)
   - User-facing feature
   - Works independently of video player

5. **Phase 5: YouTube Player** (2-3 hours)
   - Most complex change
   - Build on earlier phases
   - Test thoroughly

6. **Phase 6: Polish** (30 min)
   - Final touches
   - Improve UX

**Total Estimated Time: ~4-5 hours**

## Success Criteria

- [ ] YouTube videos display with synchronized playback
- [ ] Users can name both file and YouTube uploads
- [ ] YouTube video titles auto-populate name field
- [ ] Collection cards show meaningful names
- [ ] Video playback syncs with transcript highlighting
- [ ] All existing functionality preserved
- [ ] No TypeScript errors
- [ ] Responsive design maintained
- [ ] Error handling for edge cases

## Future Enhancements

### Phase 7 (Post-MVP)
- [ ] Toggle between video and audio for YouTube collections
- [ ] Keyboard shortcuts (space for play/pause, arrow keys for seek)
- [ ] Picture-in-picture mode
- [ ] Download transcript as SRT/VTT for YouTube
- [ ] Bulk rename collections
- [ ] Search collections by name
- [ ] Playlist support (process multiple YouTube videos)

## Notes

- YouTube IFrame API is free and has no quota limits
- Video embeds require stable internet connection
- Downloaded audio serves as permanent backup
- Name field is optional for backwards compatibility
- Existing collections without names use filename as fallback
