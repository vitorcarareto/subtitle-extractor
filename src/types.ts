// ── Cue ──

export interface Cue {
  startMs: number;
  endMs: number;
  text: string;
}

// ── Subtitle URL parsing ──

export interface ParsedSubtitleUrl {
  mediaCode: string;
  timestamp: string;
  lang: string;
  segmentNum: string;
  baseUrl: string;
  queryString: string;
}

// ── Provider ──

export interface Provider {
  id: string;
  name: string;
  domains: string[];
  formats: string[];
  webRequestFilter: string | null;
  headerRules: chrome.declarativeNetRequest.Rule[];
  parseRequest(url: string): ParsedSubtitleUrl | null;
  fetchSubtitle(url: string): Promise<FetchResult>;
}

// ── Fetch results ──

export type FetchResult =
  | { text: string; error?: undefined }
  | { error: string | number; text?: undefined };

export interface SegmentResult {
  seg: number;
  text?: string;
  error?: string | number;
}

// ── Parallel fetch options ──

export interface FetchAllSegmentsOptions {
  concurrency: number;
  fetchFn: (seg: number) => Promise<FetchResult>;
  onProgress?: (segmentNumber: number, totalCompleted: number) => void;
  maxConsecutiveErrors?: number;
}

// ── Extension messages ──

export type ExtensionMessage =
  | { type: 'getPattern'; tabId: number }
  | { type: 'getTabId' }
  | { type: 'getTopFrameMetadata' }
  | { type: 'getMetadata' }
  | { type: 'metadata'; mediaCode: string | null; mediaTitle: string | null; videoName: string | null; videoIndex: number | null; sectionIndex?: number | null; captionTracks?: CaptionTrack[] | null }
  | { type: 'getProviderForUrl'; url: string }
  | { type: 'fetchYoutubeTrack'; tabId: number; lang?: string }
  | { type: 'downloadFile'; content: string; filename: string }
  | { type: 'fetchSegment'; url: string; providerId?: string };

// ── Format ──

export type Format = 'txt' | 'srt' | 'vtt';

// ── Platform data interfaces ──

export interface CaptionTrack {
  baseUrl: string;
  languageCode: string;
  name: string;
  kind: string;
}

export interface HotmartNextData {
  props?: {
    pageProps?: {
      mediaCode?: string;
      mediaTitle?: string;
      applicationData?: {
        mediaCode?: string;
        mediaTitle?: string;
      };
    };
  };
}

export interface YouTubePlayerResponse {
  captions?: {
    playerCaptionsTracklistRenderer?: {
      captionTracks?: Array<{
        baseUrl: string;
        languageCode: string;
        name?: { simpleText?: string };
        kind?: string;
      }>;
    };
  };
}

// ── Metadata ──

export interface VideoMetadata {
  mediaCode: string | null;
  mediaTitle: string | null;
  videoName: string | null;
  videoIndex: number | null;
  sectionIndex?: number | null;
  captionTracks?: CaptionTrack[] | null;
}

// ── Provider info (serializable subset sent via messages) ──

export interface ProviderInfo {
  id: string;
  name: string;
  formats: string[];
  stub: boolean;
}

// ── Captured pattern stored in session ──

export interface CapturedPattern {
  providerId: string;
  mediaCode: string;
  timestamp: string;
  lang: string;
  segmentNum: string;
  baseUrl: string;
  queryString: string;
  capturedAt: number;
  sampleUrl: string;
}
