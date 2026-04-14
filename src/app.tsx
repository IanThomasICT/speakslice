import { useState, useEffect, useRef } from 'react';
import { createRoot } from 'react-dom/client';

// Global type declarations
declare global {
  interface Window {
    YT: any;
    onYouTubeIframeAPIReady: () => void;
  }
}

// Types
type Word = { start: number; end: number; text: string; confidence?: number };
type Segment = {
  start: number;
  end: number;
  speaker: string;
  text: string;
  words: Word[];
};
type ASRSegment = { start: number; end: number; text: string; avg_confidence?: number };
type ProcessedData = {
  file: string;
  name?: string;
  youtube_url?: string;
  duration_sec: number;
  asr: { language: string; words: Word[]; segments: ASRSegment[] };
  aligned: { speaker_segments: Segment[] };
  speaker_names?: Record<string, string>;
};
type Collection = {
  id: string;
  filename: string;
  name?: string;
  youtube_url?: string;
  processed_date: string;
  duration_sec: number;
  speaker_count: number;
  language: string;
};
type SpeakerColor = { border: string; bg: string; text: string };
type YoutubeMetadata = {
  title: string;
  thumbnail: string;
  duration: number; // in seconds
  channelTitle: string;
};

// Constants
const SPEAKER_COLORS: Record<string, SpeakerColor> = {
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

const YOUTUBE_PATTERNS = [
  /^https:\/\/www\.youtube\.com\/watch\?v=[a-zA-Z0-9_-]{11}$/,
  /^https:\/\/youtu\.be\/[a-zA-Z0-9_-]{11}$/
];

// Utility functions
function formatTime(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = Math.floor(seconds % 60);
  return `${mins}:${secs.toString().padStart(2, '0')}`;
}

function validateYoutubeUrl(url: string): boolean {
  return YOUTUBE_PATTERNS.some(pattern => pattern.test(url));
}

function extractYoutubeVideoId(url: string): string | null {
  // Extract from https://www.youtube.com/watch?v=VIDEO_ID
  const match1 = url.match(/youtube\.com\/watch\?v=([a-zA-Z0-9_-]{11})/);
  if (match1) return match1[1];

  // Extract from https://youtu.be/VIDEO_ID
  const match2 = url.match(/youtu\.be\/([a-zA-Z0-9_-]{11})/);
  if (match2) return match2[1];

  return null;
}

function parseISO8601Duration(duration: string): number {
  // Parse ISO 8601 duration format (PT1H2M10S) to seconds
  const match = duration.match(/PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/);
  if (!match) return 0;

  const hours = parseInt(match[1] || '0');
  const minutes = parseInt(match[2] || '0');
  const seconds = parseInt(match[3] || '0');

  return hours * 3600 + minutes * 60 + seconds;
}

function secondsToTimeString(seconds: number, totalDuration: number): string {
  // Format: HH:MM:SS if duration >= 1 hour, else MM:SS
  const hours = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = Math.floor(seconds % 60);

  if (totalDuration >= 3600) {
    // Show HH:MM:SS format
    return `${hours}:${mins.toString().padStart(2, '0')}:${secs.toString().padStart(2, '0')}`;
  } else {
    // Show MM:SS format
    return `${mins}:${secs.toString().padStart(2, '0')}`;
  }
}

// Header Component
function Header() {
  return (
    <aside className="fixed top-4 left-4 z-10">
      <h1 className="text-lg font-bold text-gray-900">SpeakSlice</h1>
      <p className="text-xs text-gray-500">Free, CPU-first diarization</p>
    </aside>
  );
}

// Tab Navigation Component
function TabNavigation({ activeTab, onTabChange }: { activeTab: 'upload' | 'collections'; onTabChange: (tab: 'upload' | 'collections') => void }) {
  return (
    <div className="flex justify-center space-x-6 mb-8 border-b border-gray-200">
      <button
        onClick={() => onTabChange('upload')}
        className={`px-3 py-2 text-sm font-medium ${
          activeTab === 'upload'
            ? 'text-blue-600 border-b-2 border-blue-600'
            : 'text-gray-600 hover:text-gray-900'
        } cursor-pointer`}
      >
        Upload
      </button>
      <button
        onClick={() => onTabChange('collections')}
        className={`px-3 py-2 text-sm font-medium ${
          activeTab === 'collections'
            ? 'text-blue-600 border-b-2 border-blue-600'
            : 'text-gray-600 hover:text-gray-900'
        } cursor-pointer`}
      >
        Collections
      </button>
    </div>
  );
}

// Upload Tab Component
function UploadTab({ onResults }: { onResults: (data: ProcessedData, collectionId: string | null) => void }) {
  const [file, setFile] = useState<File | null>(null);
  const [youtubeUrl, setYoutubeUrl] = useState('');
  const [asrModel, setAsrModel] = useState('medium');
  const [language, setLanguage] = useState('auto');
  const [maxSpeakers, setMaxSpeakers] = useState('');
  const [processing, setProcessing] = useState(false);
  const [error, setError] = useState('');
  const [youtubeUrlError, setYoutubeUrlError] = useState(false);
  const [youtubeMetadata, setYoutubeMetadata] = useState<YoutubeMetadata | null>(null);
  const [metadataLoading, setMetadataLoading] = useState(false);
  const [metadataError, setMetadataError] = useState<string | null>(null);
  const [audioDuration, setAudioDuration] = useState<number | null>(null);
  const [trimStart, setTrimStart] = useState(0);
  const [trimEnd, setTrimEnd] = useState(0);
  const [trimEnabled, setTrimEnabled] = useState(false);
  const [customName, setCustomName] = useState('');

  // Debounced YouTube metadata fetching
  useEffect(() => {
    // Reset metadata when URL is cleared or invalid
    if (!youtubeUrl || !validateYoutubeUrl(youtubeUrl)) {
      setYoutubeMetadata(null);
      setMetadataError(null);
      return;
    }

    // Debounce: wait 500ms after user stops typing
    const timeoutId = setTimeout(() => {
      fetchYoutubeMetadata(youtubeUrl);
    }, 500);

    return () => clearTimeout(timeoutId);
  }, [youtubeUrl]);

  // Extract duration from YouTube metadata when available
  useEffect(() => {
    if (youtubeMetadata) {
      setAudioDuration(youtubeMetadata.duration);
      setTrimEnd(youtubeMetadata.duration);
      setTrimStart(0);
      setTrimEnabled(false);
      // Auto-fill name field with YouTube title (user can override)
      if (youtubeMetadata.title && !customName) {
        setCustomName(youtubeMetadata.title);
      }
    }
  }, [youtubeMetadata]);

  // Extract duration from uploaded file
  useEffect(() => {
    if (!file) {
      // Reset duration when file is cleared
      if (!youtubeUrl) {
        setAudioDuration(null);
        setTrimStart(0);
        setTrimEnd(0);
        setTrimEnabled(false);
      }
      return;
    }

    // Call backend to extract duration
    const extractDuration = async () => {
      try {
        const formData = new FormData();
        formData.append('file', file);

        const response = await fetch('/v1/file/duration', {
          method: 'POST',
          body: formData
        });

        const data = await response.json();

        if (response.ok && data.duration_seconds) {
          const duration = data.duration_seconds;
          setAudioDuration(duration);
          setTrimEnd(duration);
          setTrimStart(0);
          setTrimEnabled(false);
        }
      } catch (err) {
        console.error('Failed to extract duration:', err);
      }
    };

    extractDuration();
  }, [file, youtubeUrl]);

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    setError('');

    // Validation
    if (!file && !youtubeUrl) {
      setError('Please upload a file or provide a YouTube URL');
      return;
    }

    if (file && youtubeUrl) {
      setError('Please use only one input method (file or YouTube URL)');
      return;
    }

    if (youtubeUrl && !validateYoutubeUrl(youtubeUrl)) {
      setError('Invalid YouTube URL format. Use: https://www.youtube.com/watch?v=... or https://youtu.be/...');
      return;
    }

    setProcessing(true);

    try {
      const formData = new FormData();

      if (file) {
        formData.append('file', file);
      } else if (youtubeUrl) {
        formData.append('youtube_url', youtubeUrl);
      }

      // Add custom name if provided
      if (customName.trim()) {
        formData.append('name', customName.trim());
      }

      formData.append('asr_model', asrModel);
      formData.append('language', language);
      if (maxSpeakers) formData.append('max_speakers', maxSpeakers);

      // Add trimming parameters if enabled
      if (trimEnabled && audioDuration !== null) {
        formData.append('start_time', trimStart.toString());
        formData.append('end_time', trimEnd.toString());
      }

      const response = await fetch('/v1/process', {
        method: 'POST',
        body: formData
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Processing failed');
      }

      onResults(data, null);
    } catch (err) {
      setError(`Error: ${(err as Error).message}`);
    } finally {
      setProcessing(false);
    }
  };

  const fetchYoutubeMetadata = async (url: string) => {
    const videoId = extractYoutubeVideoId(url);
    if (!videoId) {
      setMetadataError('Could not extract video ID from URL');
      return;
    }

    // Check if API key is configured
    const apiKey = (window as { YOUTUBE_API_KEY?: string }).YOUTUBE_API_KEY;
    if (!apiKey) {
      // Silently skip if no API key configured (optional feature)
      setMetadataError(null);
      setYoutubeMetadata(null);
      return;
    }

    setMetadataLoading(true);
    setMetadataError(null);

    try {
      const apiUrl = `https://www.googleapis.com/youtube/v3/videos?part=snippet,contentDetails&id=${videoId}&key=${apiKey}`;
      const response = await fetch(apiUrl);

      if (!response.ok) {
        throw new Error(`YouTube API error: ${response.status}`);
      }

      const data = await response.json();

      if (!data.items || data.items.length === 0) {
        throw new Error('Video not found');
      }

      const video = data.items[0];
      const duration = parseISO8601Duration(video.contentDetails.duration);
      const thumbnail = video.snippet.thumbnails.medium?.url || video.snippet.thumbnails.default?.url;

      setYoutubeMetadata({
        title: video.snippet.title,
        thumbnail,
        duration,
        channelTitle: video.snippet.channelTitle
      });
    } catch (err) {
      setMetadataError(`Failed to fetch metadata: ${(err as Error).message}`);
      setYoutubeMetadata(null);
    } finally {
      setMetadataLoading(false);
    }
  };

  const handleYoutubeUrlChange = (url: string) => {
    setYoutubeUrl(url);
    if (url && !validateYoutubeUrl(url)) {
      setYoutubeUrlError(true);
    } else {
      setYoutubeUrlError(false);
    }
  };

  return (
    <div className="max-w-xl mx-auto mb-8">
      <form onSubmit={handleSubmit} className="space-y-3">
        {/* TODO: Replace plain file input with drag-and-drop zone (onDragOver, onDrop handlers);
                  README advertises drag-and-drop but it is not implemented */}
        <input
          type="file"
          accept="audio/*,video/*"
          onChange={(e) => setFile(e.target.files?.[0] || null)}
          className="block w-full text-sm text-gray-500 file:mr-4 file:py-2 file:px-4 file:rounded file:border-0 file:text-sm file:font-semibold file:bg-blue-50 file:text-blue-700 hover:file:bg-blue-100 cursor-pointer"
        />

        <div className="relative">
          <div className="absolute inset-0 flex items-center">
            <div className="w-full border-t border-gray-300"></div>
          </div>
          <div className="relative flex justify-center text-xs">
            <span className="px-2 bg-gray-50 text-gray-500">OR</span>
          </div>
        </div>

        <div className="space-y-1">
          <input
            type="text"
            value={youtubeUrl}
            onChange={(e) => handleYoutubeUrlChange(e.target.value)}
            placeholder="Paste YouTube URL: https://www.youtube.com/watch?v=..."
            className={`block w-full px-3 py-2 text-sm border rounded focus:ring-blue-500 focus:border-blue-500 ${
              youtubeUrlError ? 'border-red-500' : 'border-gray-300'
            }`}
          />
          <p className="text-xs text-gray-500">Supported formats: youtube.com/watch?v= or youtu.be/</p>
        </div>

        {/* YouTube Metadata Preview */}
        {metadataLoading && (
          <div className="flex items-center space-x-2 px-3 py-2 bg-blue-50 border border-blue-200 rounded text-xs text-blue-700">
            <svg className="animate-spin h-4 w-4" viewBox="0 0 24 24">
              <circle className="opacity-25" cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="4" fill="none"></circle>
              <path className="opacity-75" fill="currentColor" d="M4 12a8 8 0 018-8V0C5.373 0 0 5.373 0 12h4zm2 5.291A7.962 7.962 0 014 12H0c0 3.042 1.135 5.824 3 7.938l3-2.647z"></path>
            </svg>
            <span>Loading video metadata...</span>
          </div>
        )}

        {youtubeMetadata && !metadataLoading && (
          <div className="flex space-x-3 p-3 bg-white border border-gray-200 rounded shadow-sm">
            <img
              src={youtubeMetadata.thumbnail}
              alt={youtubeMetadata.title}
              className="w-32 h-24 object-cover rounded flex-shrink-0"
            />
            <div className="flex flex-col justify-center space-y-1 min-w-0">
              <h3 className="text-sm font-medium text-gray-900 truncate" title={youtubeMetadata.title}>
                {youtubeMetadata.title}
              </h3>
              <p className="text-xs text-gray-600">{youtubeMetadata.channelTitle}</p>
              <p className="text-xs text-gray-500">Duration: {formatTime(youtubeMetadata.duration)}</p>
            </div>
          </div>
        )}

        {metadataError && !metadataLoading && (
          <div className="px-3 py-2 bg-yellow-50 border border-yellow-200 rounded text-xs text-yellow-800">
            {metadataError}
          </div>
        )}

        {/* Name Field - shows for both file and YouTube uploads */}
        <div className="space-y-1">
          <label className="block text-sm font-medium text-gray-700">
            Name (Optional)
          </label>
          <input
            type="text"
            value={customName}
            onChange={(e) => setCustomName(e.target.value)}
            placeholder={
              youtubeUrl && youtubeMetadata
                ? "Auto-filled from YouTube video title"
                : "Give this transcript a custom name"
            }
            className="block w-full px-3 py-2 text-sm border border-gray-300 rounded focus:ring-blue-500 focus:border-blue-500"
          />
          {youtubeMetadata && youtubeMetadata.title && (
            <p className="text-xs text-gray-500">
              Auto-filled: {youtubeMetadata.title}
            </p>
          )}
        </div>

        <details className="text-xs">
          <summary className="text-gray-500 hover:text-gray-700 cursor-pointer">Options</summary>
          <div className="mt-2 space-y-2 pl-3 border-l border-gray-200">
            <select
              value={asrModel}
              onChange={(e) => setAsrModel(e.target.value)}
              className="block w-full rounded border-gray-300 text-xs"
            >
              <option value="tiny">Tiny</option>
              <option value="base">Base</option>
              <option value="small">Small</option>
              <option value="medium">Medium</option>
            </select>
            <select
              value={language}
              onChange={(e) => setLanguage(e.target.value)}
              className="block w-full rounded border-gray-300 text-xs"
            >
              <option value="auto">Auto-detect</option>
              <option value="en">English</option>
              <option value="es">Spanish</option>
              <option value="fr">French</option>
              <option value="de">German</option>
              <option value="zh">Chinese</option>
            </select>
            <input
              type="number"
              value={maxSpeakers}
              onChange={(e) => setMaxSpeakers(e.target.value)}
              min="1"
              max="10"
              placeholder="Max speakers"
              className="block w-full rounded border-gray-300 text-xs"
            />

            {/* Audio Trimmer */}
            {audioDuration !== null && (
              <div className="space-y-2 pt-2 mt-2 border-t border-gray-200">
                <label className="block text-xs font-medium text-gray-700">
                  Audio Trimmer
                  <span className="ml-2 font-normal text-gray-500">
                    (Total: {secondsToTimeString(audioDuration, audioDuration)})
                  </span>
                </label>

                {/* Start Time Slider */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-gray-600">
                    <span>Start</span>
                    <span className="font-medium text-blue-600">{secondsToTimeString(trimStart, audioDuration)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={audioDuration}
                    step="1"
                    value={trimStart}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setTrimStart(Math.min(value, trimEnd - 1));
                      setTrimEnabled(value !== 0 || trimEnd !== audioDuration);
                    }}
                    className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                </div>

                {/* End Time Slider */}
                <div className="space-y-1">
                  <div className="flex justify-between text-xs text-gray-600">
                    <span>End</span>
                    <span className="font-medium text-blue-600">{secondsToTimeString(trimEnd, audioDuration)}</span>
                  </div>
                  <input
                    type="range"
                    min="0"
                    max={audioDuration}
                    step="1"
                    value={trimEnd}
                    onChange={(e) => {
                      const value = Number(e.target.value);
                      setTrimEnd(Math.max(value, trimStart + 1));
                      setTrimEnabled(trimStart !== 0 || value !== audioDuration);
                    }}
                    className="w-full h-1 bg-gray-200 rounded-lg appearance-none cursor-pointer accent-blue-600"
                  />
                </div>

                {trimEnabled && (
                  <p className="text-xs text-blue-600 font-medium">
                    Selected: {secondsToTimeString(trimEnd - trimStart, audioDuration)}
                    ({secondsToTimeString(trimStart, audioDuration)} - {secondsToTimeString(trimEnd, audioDuration)})
                  </p>
                )}
              </div>
            )}
          </div>
        </details>

        <button
          type="submit"
          disabled={processing}
          className="w-full bg-blue-600 text-white py-2 px-4 rounded text-sm font-medium hover:bg-blue-700 cursor-pointer disabled:bg-gray-400 disabled:cursor-not-allowed"
        >
          Process
        </button>
      </form>

      {processing && (
        <div className="mt-4 text-center">
          <div className="inline-flex items-center space-x-2 text-sm text-gray-600">
            <svg className="animate-spin h-4 w-4 text-blue-600" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            <span>{youtubeUrl ? 'Downloading from YouTube...' : 'Processing...'}</span>
          </div>
        </div>
      )}

      {error && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800">
          {error}
        </div>
      )}
    </div>
  );
}

// Collections Tab Component
// TODO: Add search/filter input to collections list (filter by name or date)
// TODO: Add bulk rename — select multiple collections and rename all speakers at once
// TODO: Add playlist support — select multiple YouTube URLs and process them in sequence
function CollectionsTab({ onLoadCollection }: { onLoadCollection: (id: string) => void }) {
  const [collections, setCollections] = useState<Collection[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');

  useEffect(() => {
    loadCollections();
  }, []);

  const loadCollections = async () => {
    try {
      const response = await fetch('/v1/collections');
      const data = await response.json();

      if (data.collections && data.collections.length > 0) {
        setCollections(data.collections);
      } else {
        setCollections([]);
      }
    } catch (err) {
      setError(`Error loading collections: ${(err as Error).message}`);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="text-center py-12 text-sm text-gray-400">
        Loading...
      </div>
    );
  }

  if (collections.length === 0) {
    return (
      <div className="text-center py-12 text-sm text-gray-400">
        No files yet
      </div>
    );
  }

  return (
    <div className="mb-8">
      <div className="grid grid-cols-2 md:grid-cols-3 lg:grid-cols-4 gap-3 max-w-4xl mx-auto">
        {collections.map((col) => {
          const date = new Date(col.processed_date);
          const dateStr = date.toLocaleDateString(undefined, { month: 'short', day: 'numeric' });

          return (
            <div
              key={col.id}
              onClick={() => onLoadCollection(col.id)}
              className="border border-gray-200 rounded p-3 hover:border-blue-400 hover:shadow-sm transition cursor-pointer relative"
            >
              {col.youtube_url && (
                <div className="absolute top-2 right-2 bg-red-600 text-white text-xs px-2 py-0.5 rounded">
                  YouTube
                </div>
              )}
              <h3 className="text-sm font-medium text-gray-900 mb-1 truncate">{col.name || col.filename}</h3>
              <div className="text-xs text-gray-500 space-y-0.5">
                <div>{dateStr}</div>
                <div>{col.duration_sec ? col.duration_sec.toFixed(0) : '?'}s · {col.speaker_count} spk</div>
              </div>
            </div>
          );
        })}
      </div>

      {error && (
        <div className="mt-4 bg-red-50 border border-red-200 rounded-lg p-3 text-sm text-red-800 max-w-2xl mx-auto">
          {error}
        </div>
      )}
    </div>
  );
}

// Transcript Segment Component
function TranscriptSegment({
  segment,
  _index,
  colors,
  speakerName,
  isActive,
  onSegmentClick,
  onSpeakerRename
}: {
  segment: Segment;
  _index: number;
  colors: SpeakerColor;
  speakerName: string;
  isActive: boolean;
  onSegmentClick: (time: number) => void;
  onSpeakerRename: (speaker: string) => void;
}) {
  const [hovered, setHovered] = useState(false);

  return (
    <div
      className={`transcript-segment pl-3 py-2 border-l-2 transition-all duration-200 cursor-pointer hover:border-l-4 hover:bg-opacity-30 ${
        isActive ? 'bg-blue-50 bg-opacity-50' : ''
      }`}
      style={{
        borderColor: colors.border,
        backgroundColor: hovered && !isActive ? colors.bg : undefined
      }}
      onMouseEnter={() => setHovered(true)}
      onMouseLeave={() => setHovered(false)}
      onClick={(e) => {
        // Don't seek if clicking on speaker name
        if ((e.target as HTMLElement).classList.contains('speaker-name')) return;
        onSegmentClick(segment.start);
      }}
    >
      <div className="flex items-baseline gap-2 mb-1">
        <span
          className="text-xs font-semibold speaker-name hover:underline cursor-pointer"
          style={{
            color: colors.text,
            backgroundColor: colors.bg,
            padding: '1px 6px',
            borderRadius: '3px'
          }}
          onDoubleClick={(e) => {
            e.stopPropagation();
            onSpeakerRename(segment.speaker);
          }}
        >
          {speakerName}
        </span>
        <span className="text-xs text-gray-400">{segment.start.toFixed(1)}s</span>
      </div>
      <p className="text-sm text-gray-800 leading-relaxed">{segment.text || '(silence)'}</p>
    </div>
  );
}

// Audio Player Component
// TODO: Add keyboard shortcuts — space = play/pause, left/right arrow = seek ±5s, up/down arrow = speed change
// TODO: Add picture-in-picture support for YouTube player (document.pictureInPictureElement API)
function MediaPlayer({
  collectionId,
  youtubeUrl,
  segments,
  onSaveNames,
  onSeek,
  onSegmentChange
}: {
  collectionId: string | null;
  youtubeUrl?: string | null;
  segments: Segment[];
  onSaveNames: () => void;
  onSeek?: (seekFn: (time: number) => void) => void;
  onSegmentChange?: (index: number) => void;
}) {
  const audioRef = useRef<HTMLAudioElement>(null);
  const youtubePlayerRef = useRef<any>(null);
  const sentinelRef = useRef<HTMLDivElement>(null);
  const playerRef = useRef<HTMLDivElement>(null);
  const timeTrackerRef = useRef<number | null>(null);
  const [isPlaying, setIsPlaying] = useState(false);
  const [currentTime, setCurrentTime] = useState(0);
  const [duration, setDuration] = useState(0);
  const [playbackRate, setPlaybackRate] = useState(1);
  const [loading, setLoading] = useState(true);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(-1);
  const [showSaveButton, setShowSaveButton] = useState(false);
  const [playerReady, setPlayerReady] = useState(false);
  const [playerError, setPlayerError] = useState(false);

  // Extract video ID from YouTube URL
  const videoId = youtubeUrl ? extractYoutubeVideoId(youtubeUrl) : null;

  // Expose seek function to parent
  useEffect(() => {
    if (onSeek) {
      onSeek((time: number) => {
        if (youtubePlayerRef.current && videoId) {
          youtubePlayerRef.current.seekTo(time, true);
          if (youtubePlayerRef.current.getPlayerState() !== 1) {
            youtubePlayerRef.current.playVideo();
            setIsPlaying(true);
          }
        } else if (audioRef.current) {
          audioRef.current.currentTime = time;
          if (audioRef.current.paused) {
            audioRef.current.play();
            setIsPlaying(true);
          }
        }
      });
    }
  }, [onSeek, videoId]);

  // Initialize YouTube player
  useEffect(() => {
    if (!videoId) return;

    const initPlayer = () => {
      if (!window.YT || !window.YT.Player) {
        console.error('YouTube API not loaded');
        return;
      }

      youtubePlayerRef.current = new window.YT.Player('youtube-player', {
        videoId: videoId,
        playerVars: {
          autoplay: 0,
          controls: 0,
          modestbranding: 1,
          rel: 0,
        },
        events: {
          onReady: (event: any) => {
            setDuration(event.target.getDuration());
            setPlayerReady(true);
            setLoading(false);
          },
          onStateChange: (event: any) => {
            if (event.data === 1) { // Playing
              setIsPlaying(true);
            } else if (event.data === 2) { // Paused
              setIsPlaying(false);
            }
          },
          onError: (event: any) => {
            setPlayerError(true);
            setLoading(false);
            console.error('YouTube player error:', event.data);
          },
        },
      });
    };

    // Wait for API to be ready
    if (window.YT && window.YT.Player) {
      initPlayer();
    } else {
      window.onYouTubeIframeAPIReady = initPlayer;
    }

    return () => {
      if (youtubePlayerRef.current) {
        youtubePlayerRef.current.destroy();
        youtubePlayerRef.current = null;
      }
      if (timeTrackerRef.current !== null) {
        window.clearInterval(timeTrackerRef.current);
      }
    };
  }, [videoId]);

  // YouTube time tracking
  useEffect(() => {
    if (!youtubePlayerRef.current || !playerReady) return;

    const interval = setInterval(() => {
      if (youtubePlayerRef.current && youtubePlayerRef.current.getCurrentTime) {
        const time = youtubePlayerRef.current.getCurrentTime();
        setCurrentTime(time);

        // Find current segment
        const foundIndex = segments.findIndex(
          (seg) => time >= seg.start && time < seg.end
        );

        if (foundIndex !== currentSegmentIndex && foundIndex !== -1) {
          setCurrentSegmentIndex(foundIndex);
          if (onSegmentChange) {
            onSegmentChange(foundIndex);
          }
          // Scroll to current segment
          const segmentElements = document.querySelectorAll('.transcript-segment');
          if (segmentElements[foundIndex]) {
            segmentElements[foundIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
          }
        }
      }
    }, 100);

    timeTrackerRef.current = interval;
    return () => window.clearInterval(interval);
  }, [playerReady, segments, currentSegmentIndex, onSegmentChange]);

  useEffect(() => {
    if (!collectionId || videoId) return;

    const loadAudio = async () => {
      try {
        const response = await fetch(`/v1/collections/${collectionId}/audio`);
        if (!response.ok) throw new Error('Audio not found');

        const blob = await response.blob();
        const audioUrl = URL.createObjectURL(blob);

        if (audioRef.current) {
          audioRef.current.src = audioUrl;
          audioRef.current.load();
        }
      } catch (err) {
        console.error('Failed to load audio:', err);
        setLoading(false);
      }
    };

    loadAudio();
  }, [collectionId]);

  useEffect(() => {
    if (!sentinelRef.current || !playerRef.current) return;

    const observer = new IntersectionObserver(
      ([entry]) => {
        if (!playerRef.current) return;
        if (!entry.isIntersecting) {
          playerRef.current.classList.add('rounded-xl', 'shadow-xl', 'top-3', 'mx-4');
          playerRef.current.classList.remove('shadow-md', 'top-0');
        } else {
          playerRef.current.classList.remove('rounded-xl', 'shadow-xl', 'top-3', 'mx-4');
          playerRef.current.classList.add('shadow-md', 'top-0');
        }
      },
      { threshold: 0, rootMargin: '0px' }
    );

    observer.observe(sentinelRef.current);

    return () => observer.disconnect();
  }, []);

  useEffect(() => {
    const audio = audioRef.current;
    if (!audio) return;

    const handleLoadedMetadata = () => {
      setDuration(audio.duration);
      setLoading(false);
    };

    const handleTimeUpdate = () => {
      setCurrentTime(audio.currentTime);

      // Find current segment
      const foundIndex = segments.findIndex(
        (seg) => audio.currentTime >= seg.start && audio.currentTime < seg.end
      );

      if (foundIndex !== currentSegmentIndex && foundIndex !== -1) {
        setCurrentSegmentIndex(foundIndex);
        if (onSegmentChange) {
          onSegmentChange(foundIndex);
        }
        // Scroll to current segment
        const segmentElements = document.querySelectorAll('.transcript-segment');
        if (segmentElements[foundIndex]) {
          segmentElements[foundIndex].scrollIntoView({ behavior: 'smooth', block: 'center' });
        }
      }
    };

    audio.addEventListener('loadedmetadata', handleLoadedMetadata);
    audio.addEventListener('timeupdate', handleTimeUpdate);

    return () => {
      audio.removeEventListener('loadedmetadata', handleLoadedMetadata);
      audio.removeEventListener('timeupdate', handleTimeUpdate);
    };
  }, [segments, currentSegmentIndex, onSegmentChange]);

  const togglePlayPause = () => {
    if (youtubePlayerRef.current && videoId) {
      if (isPlaying) {
        youtubePlayerRef.current.pauseVideo();
      } else {
        youtubePlayerRef.current.playVideo();
      }
    } else if (audioRef.current) {
      if (audioRef.current.paused) {
        audioRef.current.play();
        setIsPlaying(true);
      } else {
        audioRef.current.pause();
        setIsPlaying(false);
      }
    }
  };

  const handleSeek = (e: React.ChangeEvent<HTMLInputElement>) => {
    const time = parseFloat(e.target.value);
    if (youtubePlayerRef.current && videoId) {
      youtubePlayerRef.current.seekTo(time, true);
    } else if (audioRef.current) {
      audioRef.current.currentTime = time;
    }
  };

  const handlePlaybackRateChange = (e: React.ChangeEvent<HTMLSelectElement>) => {
    const rate = parseFloat(e.target.value);
    setPlaybackRate(rate);
    if (youtubePlayerRef.current && videoId) {
      youtubePlayerRef.current.setPlaybackRate(rate);
    } else if (audioRef.current) {
      audioRef.current.playbackRate = rate;
    }
  };

  useEffect(() => {
    setShowSaveButton(collectionId !== null);
  }, [collectionId]);

  return (
    <>
      <div ref={sentinelRef}></div>

      {/* YouTube Video Player */}
      {youtubeUrl && videoId && (
        <div className="mb-4 w-full max-w-4xl mx-auto px-4">
          {!playerReady && !playerError && (
            <div className="aspect-video bg-gray-100 rounded flex items-center justify-center">
              <div className="text-gray-500 flex items-center gap-2">
                <svg className="animate-spin h-5 w-5" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
                Loading video...
              </div>
            </div>
          )}
          {playerError && (
            <div className="bg-red-50 border border-red-200 rounded p-4 mb-4">
              <p className="text-red-800 text-sm">
                Unable to load YouTube video. The video may be unavailable or deleted.
              </p>
              {collectionId && (
                <p className="text-sm text-red-600 mt-2">
                  Falling back to downloaded audio...
                </p>
              )}
            </div>
          )}
          <div className={`aspect-video bg-black rounded-lg overflow-hidden shadow-lg ${!playerReady || playerError ? 'hidden' : ''}`}>
            <div id="youtube-player" className="w-full h-full"></div>
          </div>
        </div>
      )}

      <div
        ref={playerRef}
        className="sticky top-0 z-20 bg-white mb-6 py-4 transition-all duration-300 ease-in-out shadow-md"
      >
        <div className="flex items-center justify-center gap-3 max-w-4xl mx-auto px-4">
          <button
            onClick={togglePlayPause}
            disabled={loading}
            className="w-10 h-10 rounded-full bg-blue-600 text-white flex items-center justify-center cursor-pointer hover:bg-blue-700 flex-shrink-0 disabled:bg-gray-400"
          >
            <svg xmlns="http://www.w3.org/2000/svg" width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
              {isPlaying ? (
                <>
                  <rect x="14" y="3" width="5" height="18" rx="1"/>
                  <rect x="5" y="3" width="5" height="18" rx="1"/>
                </>
              ) : (
                <path d="M5 5a2 2 0 0 1 3.008-1.728l11.997 6.998a2 2 0 0 1 .003 3.458l-12 7A2 2 0 0 1 5 19z"/>
              )}
            </svg>
          </button>
          <div className="flex-1 max-w-2xl">
            <input
              type="range"
              min="0"
              max={duration}
              value={currentTime}
              onChange={handleSeek}
              step="0.01"
              className="w-full cursor-pointer"
            />
            <div className="flex justify-between text-xs text-gray-500 mt-1">
              <span>{formatTime(currentTime)}</span>
              <span>{formatTime(duration)}</span>
            </div>
          </div>
          <select
            value={playbackRate}
            onChange={handlePlaybackRateChange}
            className="px-2 py-1.5 bg-gray-100 text-gray-700 rounded text-xs font-medium hover:bg-gray-200 cursor-pointer border border-gray-300 flex-shrink-0"
          >
            <option value="1">1x</option>
            <option value="1.25">1.25x</option>
            <option value="1.5">1.5x</option>
            <option value="2">2x</option>
          </select>
          {showSaveButton && (
            <button
              onClick={onSaveNames}
              className="px-3 py-2 bg-green-600 text-white rounded text-xs font-medium hover:bg-green-700 cursor-pointer flex-shrink-0 flex items-center gap-1.5"
            >
              <svg xmlns="http://www.w3.org/2000/svg" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M15.2 3a2 2 0 0 1 1.4.6l3.8 3.8a2 2 0 0 1 .6 1.4V19a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2z"/><path d="M17 21v-7a1 1 0 0 0-1-1H8a1 1 0 0 0-1 1v7"/><path d="M7 3v4a1 1 0 0 0 1 1h7"/></svg>
              <span>Save</span>
            </button>
          )}
          {loading && (
            <div className="flex-shrink-0">
              <svg className="animate-spin h-5 w-5 text-blue-600" xmlns="http://www.w3.org/2000/svg" width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>
            </div>
          )}
        </div>
        {/* Audio element - only for non-YouTube content or fallback */}
        {(!youtubeUrl || playerError) && (
          <audio ref={audioRef} className="hidden"></audio>
        )}
      </div>
    </>
  );
}

// Results Display Component
function ResultsDisplay({
  data,
  collectionId,
  speakerNames,
  onSpeakerRename,
  onSaveNames
}: {
  data: ProcessedData;
  collectionId: string | null;
  speakerNames: Record<string, string>;
  onSpeakerRename: (speaker: string, newName: string) => void;
  onSaveNames: () => void;
}) {
  const seekFnRef = useRef<((time: number) => void) | null>(null);
  const [currentSegmentIndex, setCurrentSegmentIndex] = useState(-1);

  const speakers = new Set(data.aligned.speaker_segments.map((s) => s.speaker));

  const handleSeekFn = (fn: (time: number) => void) => {
    seekFnRef.current = fn;
  };

  const handleSegmentClick = (time: number) => {
    if (seekFnRef.current) {
      seekFnRef.current(time);
    }
  };

  const handleSpeakerRename = (speaker: string) => {
    const currentName = speakerNames[speaker] || speaker;
    const newName = prompt(`Rename ${currentName}:`, currentName);

    if (newName && newName.trim() && newName !== currentName) {
      onSpeakerRename(speaker, newName.trim());
    }
  };

  return (
    <div className="max-w-4xl mx-auto">
      {/* TODO: Add export button — download transcript as SRT and VTT formats */}
      {/* TODO: For YouTube collections, add toggle to switch between embedded video player and audio-only player */}
      <div className="flex justify-between items-center mb-6">
        <div className="flex items-baseline gap-6 text-xs text-gray-500">
          <div><span>{data.duration_sec ? data.duration_sec.toFixed(0) : '?'}</span>s</div>
          <div>{data.asr?.language || '?'}</div>
          <div>{speakers.size} speakers</div>
        </div>
      </div>

      <MediaPlayer
        collectionId={collectionId}
        youtubeUrl={data.youtube_url}
        segments={data.aligned.speaker_segments}
        onSaveNames={onSaveNames}
        onSeek={handleSeekFn}
        onSegmentChange={setCurrentSegmentIndex}
      />

      <p className="text-xs text-gray-400 mb-4">Double-click speaker name to rename</p>

      <div className="space-y-4">
        {data.aligned.speaker_segments.map((seg, idx) => {
          const colors = SPEAKER_COLORS[seg.speaker] || SPEAKER_COLORS['SPEAKER_00'];
          const displayName = speakerNames[seg.speaker] || seg.speaker;

          return (
            <TranscriptSegment
              key={idx}
              segment={seg}
              _index={idx}
              colors={colors}
              speakerName={displayName}
              isActive={idx === currentSegmentIndex}
              onSegmentClick={handleSegmentClick}
              onSpeakerRename={handleSpeakerRename}
            />
          );
        })}
      </div>

      <details className="mt-8">
        <summary className="text-xs text-gray-400 hover:text-gray-600 cursor-pointer">Raw JSON</summary>
        <pre className="mt-2 p-3 bg-gray-50 rounded text-xs overflow-x-auto">
          {JSON.stringify(data, null, 2)}
        </pre>
      </details>
    </div>
  );
}

// Main App Component
function App() {
  const [activeTab, setActiveTab] = useState<'upload' | 'collections'>('upload');
  const [currentData, setCurrentData] = useState<ProcessedData | null>(null);
  const [currentCollectionId, setCurrentCollectionId] = useState<string | null>(null);
  const [speakerNames, setSpeakerNames] = useState<Record<string, string>>({});

  const handleResults = (data: ProcessedData, collectionId: string | null) => {
    setCurrentData(data);
    setCurrentCollectionId(collectionId);
    setSpeakerNames(data.speaker_names || {});
  };

  const handleLoadCollection = async (id: string) => {
    try {
      const response = await fetch(`/v1/collections/${id}`);
      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to load collection');
      }

      setCurrentCollectionId(id);
      setCurrentData(data);
      setSpeakerNames(data.speaker_names || {});
    } catch (err) {
      console.error('Error loading collection:', err);
    }
  };

  const handleSpeakerRename = (speaker: string, newName: string) => {
    setSpeakerNames((prev) => ({
      ...prev,
      [speaker]: newName
    }));
  };

  const handleSaveNames = async () => {
    if (!currentCollectionId) return;

    try {
      const response = await fetch(`/v1/collections/${currentCollectionId}/speaker-names`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ speaker_names: speakerNames })
      });

      const data = await response.json();

      if (!response.ok) {
        throw new Error(data.error || 'Failed to save speaker names');
      }

      // Show success feedback (optional)
      console.log('Speaker names saved successfully');
    } catch (err) {
      console.error('Error saving speaker names:', err);
    }
  };

  return (
    <div className="bg-gray-50 min-h-screen">
      <Header />
      <div className="max-w-5xl mx-auto pt-20 px-4">
        <TabNavigation activeTab={activeTab} onTabChange={setActiveTab} />

        {activeTab === 'upload' ? (
          <UploadTab onResults={handleResults} />
        ) : (
          <CollectionsTab onLoadCollection={handleLoadCollection} />
        )}

        {currentData && (
          <ResultsDisplay
            data={currentData}
            collectionId={currentCollectionId}
            speakerNames={speakerNames}
            onSpeakerRename={handleSpeakerRename}
            onSaveNames={handleSaveNames}
          />
        )}
      </div>
    </div>
  );
}

// Entry point
const root = document.getElementById('root');
if (root) {
  createRoot(root).render(<App />);
}
