/**
 * Pure logic functions for subtitle parsing and formatting.
 * Zero Chrome API dependencies — fully testable.
 */

import type { Cue, ParsedSubtitleUrl, FetchResult, SegmentResult, FetchAllSegmentsOptions, CaptionTrack, YouTubePlayerResponse, HotmartNextData } from './types.js';

/**
 * Parse a subtitle segment URL and extract the pattern components.
 * Returns null if the URL doesn't match the expected format.
 */
export function parseSubtitleUrl(url: string): ParsedSubtitleUrl | null {
  const match = url.match(
    /[^/]*\.hotmart\.com\/video\/([^/]+)\/hls\/[^-]+-(\d+)-textstream_([^=]+)=1000-(\d+)\.webvtt\?(.+)/
  );
  if (!match) return null;

  const [, mediaCode, timestamp, lang, segmentNum, queryString] = match;
  const baseUrl = url.replace(/-(\d+)\.webvtt\?/, '-{SEG}.webvtt?');

  return { mediaCode, timestamp, lang, segmentNum, baseUrl, queryString };
}

/**
 * Fix UTF-8 mojibake: bytes were interpreted as Latin-1 instead of UTF-8.
 * If text contains Ã (0xC3), try re-encoding as latin-1 bytes then decoding as UTF-8.
 */
export function fixEncoding(text: string): string {
  if (text.includes('\u00C3')) {
    try {
      const bytes = new Uint8Array([...text].map((c) => c.charCodeAt(0)));
      const decoded = new TextDecoder('utf-8').decode(bytes);
      if (!decoded.includes('\uFFFD')) {
        return decoded;
      }
    } catch {
      // Fall through to return original
    }
  }
  return text;
}

/**
 * Parse a WebVTT string into an array of cue objects { startMs, endMs, text }.
 * Handles headers (WEBVTT, X-TIMESTAMP-MAP), numeric cue IDs, multi-line cues,
 * and strips HTML tags from cue text.
 */
export function parseWebVTT(vttText: string): Cue[] {
  const cues: Cue[] = [];
  const lines = vttText.split('\n');
  let i = 0;

  while (i < lines.length) {
    const line = lines[i].trim();

    const tsMatch = line.match(
      /^((?:\d+:)?\d{2}:\d{2}\.\d{3})\s*-->\s*((?:\d+:)?\d{2}:\d{2}\.\d{3})/
    );
    if (tsMatch) {
      const startMs = parseTimestamp(tsMatch[1]);
      const endMs = parseTimestamp(tsMatch[2]);
      const textLines = [];
      i++;
      while (i < lines.length && lines[i].trim() !== '') {
        textLines.push(lines[i].trim());
        i++;
      }
      const text = textLines.join(' ').replace(/<[^>]+>/g, '').trim();
      if (text) {
        cues.push({ startMs, endMs, text });
      }
    } else {
      i++;
    }
  }
  return cues;
}

/**
 * Parse YouTube's json3/pb3 subtitle format into cues.
 * Events with `segs` arrays contain subtitle text; others are window/style setup.
 */
export function parseYouTubeJson3(jsonText: string): Cue[] {
  let data: Record<string, unknown>;
  try {
    data = JSON.parse(jsonText);
  } catch {
    return [];
  }
  const events: Array<{ tStartMs?: number; dDurationMs?: number; segs?: Array<{ utf8?: string }> }> = (data.events as typeof events) || [];
  const cues: Cue[] = [];

  for (const event of events) {
    if (!event.segs || event.tStartMs == null || event.dDurationMs == null) continue;
    const text = event.segs
      .map((seg) => seg.utf8 || '')
      .join('')
      .replace(/\n/g, ' ')
      .trim();
    if (!text) continue;
    cues.push({
      startMs: event.tStartMs,
      endMs: event.tStartMs + event.dDurationMs,
      text,
    });
  }
  return cues;
}

/**
 * Auto-detect subtitle format (json3 vs VTT) and parse accordingly.
 */
export function parseSubtitleText(text: string): Cue[] {
  return text.trimStart().startsWith('{') ? parseYouTubeJson3(text) : parseWebVTT(text);
}

/**
 * Extract the lang query parameter from a URL.
 */
export function extractLangFromUrl(url: string): string | undefined {
  return url.match(/[?&]lang=([^&]*)/)?.[1] || undefined;
}

/**
 * Sort caption tracks with manual captions before auto-generated (ASR).
 */
export function sortTracksManualFirst<T extends { kind: string }>(tracks: T[]): T[] {
  return [...tracks].sort((a, b) => {
    if (a.kind === 'asr' && b.kind !== 'asr') return 1;
    if (a.kind !== 'asr' && b.kind === 'asr') return -1;
    return 0;
  });
}

const MS_PER_SECOND = 1000;
const MS_PER_MINUTE = 60000;
const MS_PER_HOUR = 3600000;

/**
 * Parse a WebVTT timestamp (HH:MM:SS.mmm or MM:SS.mmm) into milliseconds.
 */
export function parseTimestamp(ts: string): number {
  const parts = ts.split(':');
  if (parts.length === 2) {
    // MM:SS.mmm
    const [s, ms] = parts[1].split('.');
    return parseInt(parts[0]) * MS_PER_MINUTE + parseInt(s) * MS_PER_SECOND + parseInt(ms);
  }
  // HH:MM:SS.mmm
  const [s, ms] = parts[2].split('.');
  return parseInt(parts[0]) * MS_PER_HOUR + parseInt(parts[1]) * MS_PER_MINUTE + parseInt(s) * MS_PER_SECOND + parseInt(ms);
}

/**
 * Remove duplicate cues. Three passes:
 * 1. Remove exact (startMs, endMs, text) duplicates.
 * 2. Sort by startMs so overlap duplicates become adjacent.
 * 3. Collapse consecutive cues with identical text (segment overlap artifacts).
 */
export function deduplicateCues(cues: Cue[]): Cue[] {
  // Pass 1: exact dedup
  const seen = new Set();
  const exactDeduped: Cue[] = [];
  for (const cue of cues) {
    const key = `${cue.startMs}|${cue.endMs}|${cue.text}`;
    if (!seen.has(key)) {
      seen.add(key);
      exactDeduped.push(cue);
    }
  }

  // Pass 2: sort by start time so overlap duplicates are adjacent
  exactDeduped.sort((a, b) => a.startMs - b.startMs);

  // Pass 3: collapse consecutive cues with same text
  const unique: Cue[] = [];
  for (const cue of exactDeduped) {
    if (unique.length > 0 && unique[unique.length - 1].text === cue.text) {
      continue;
    }
    unique.push(cue);
  }
  return unique;
}

/**
 * Sort cues by start timestamp, deduplicate, and produce plain text output.
 */
export function cuesToTranscript(cues: Cue[]): string {
  const unique = deduplicateCues(cues);
  return unique.map((c) => c.text).join('\n');
}

function formatTimestamp(ms: number, sep: string): string {
  const h = String(Math.floor(ms / MS_PER_HOUR)).padStart(2, '0');
  const m = String(Math.floor((ms % MS_PER_HOUR) / MS_PER_MINUTE)).padStart(2, '0');
  const s = String(Math.floor((ms % MS_PER_MINUTE) / MS_PER_SECOND)).padStart(2, '0');
  const mil = String(ms % MS_PER_SECOND).padStart(3, '0');
  return `${h}:${m}:${s}${sep}${mil}`;
}

/** Format milliseconds as SRT timestamp: HH:MM:SS,mmm */
export const formatTimestampSrt = (ms: number) => formatTimestamp(ms, ',');

/** Format milliseconds as VTT timestamp: HH:MM:SS.mmm */
export const formatTimestampVtt = (ms: number) => formatTimestamp(ms, '.');

/**
 * Convert cues to SRT format string.
 */
export function cuesToSrt(cues: Cue[]): string {
  const unique = deduplicateCues(cues);
  if (unique.length === 0) return '';
  return unique.map((c, i) =>
    `${i + 1}\n${formatTimestampSrt(c.startMs)} --> ${formatTimestampSrt(c.endMs)}\n${c.text}`
  ).join('\n\n') + '\n';
}

/**
 * Convert cues to WebVTT format string.
 */
export function cuesToVtt(cues: Cue[]): string {
  const unique = deduplicateCues(cues);
  if (unique.length === 0) return 'WEBVTT\n';
  return 'WEBVTT\n\n' + unique.map((c) =>
    `${formatTimestampVtt(c.startMs)} --> ${formatTimestampVtt(c.endMs)}\n${c.text}`
  ).join('\n\n') + '\n';
}

/**
 * Build a segment URL from a base pattern and segment number.
 */
export function buildSegmentUrl(baseUrl: string, segmentNumber: number | string): string {
  return baseUrl.replace('{SEG}', String(segmentNumber));
}

/**
 * Process an ordered list of fetch results (each { text } or { error }) into cues.
 * Stops after maxConsecutiveErrors consecutive errors.
 * Segment 0 errors are not counted (often returns 400).
 * Returns the collected cues.
 */
export function processSegmentResults(results: FetchResult[], maxConsecutiveErrors: number = 3): Cue[] {
  const allCues: Cue[] = [];
  let consecutiveErrors = 0;

  for (let i = 0; i < results.length; i++) {
    if (consecutiveErrors >= maxConsecutiveErrors) break;

    const result = results[i];
    if (result.error) {
      consecutiveErrors++;
      if (i === 0) consecutiveErrors = 0;
    } else {
      consecutiveErrors = 0;
      const cues = parseWebVTT(result.text!);
      allCues.push(...cues);
    }
  }
  return allCues;
}

/**
 * Fetch all subtitle segments in parallel using a sliding window.
 * Pure async logic — fetchFn is injected, no Chrome API dependency.
 */
export async function fetchAllSegmentsParallel({
  concurrency,
  fetchFn,
  onProgress,
  maxConsecutiveErrors = 3,
}: FetchAllSegmentsOptions): Promise<SegmentResult[]> {
  const pool = Math.max(1, concurrency);
  const results: (SegmentResult | undefined)[] = [];  // ordered by segment number
  let nextSeg = 0;           // next segment to launch
  let completed = 0;         // total completed
  let stopLaunching = false;
  const inFlight: Map<number, Promise<void>> = new Map(); // seg -> Promise

  function checkStopCondition() {
    // Count consecutive errors from the highest completed segment backward
    let consecutive = 0;
    for (let i = results.length - 1; i >= 0; i--) {
      if (results[i] === undefined) break; // gap — not yet resolved
      if (results[i]!.error) {
        // Segment 0 errors don't count
        if (results[i]!.seg === 0) break;
        consecutive++;
      } else {
        break;
      }
    }
    if (consecutive >= maxConsecutiveErrors) {
      stopLaunching = true;
    }
  }

  function launchNext() {
    while (inFlight.size < pool && !stopLaunching && nextSeg < 5000) {
      const seg = nextSeg++;
      const promise = fetchFn(seg).then((result) => {
        results[seg] = { seg, ...result };
        completed++;
        inFlight.delete(seg);
        if (onProgress) onProgress(seg, completed);
        checkStopCondition();
      });
      inFlight.set(seg, promise);
    }
  }

  launchNext();

  while (inFlight.size > 0) {
    await Promise.race(inFlight.values());
    if (!stopLaunching) launchNext();
  }

  // Return only the contiguous resolved results (no undefined gaps)
  return results.filter((r): r is SegmentResult => r !== undefined);
}

/**
 * Parse caption tracks from a YouTube player response object.
 * Returns null if no tracks are found.
 */
export function parseYouTubeCaptionTracks(response: YouTubePlayerResponse): CaptionTrack[] | null {
  const tracks = response?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
  if (!tracks || tracks.length === 0) return null;
  return tracks.map((t) => ({
    baseUrl: t.baseUrl,
    languageCode: t.languageCode,
    name: t.name?.simpleText || t.languageCode,
    kind: t.kind || '',
  }));
}

/**
 * Extract caption tracks from a YouTube page's script text using regex.
 * Falls back to regex when the player response isn't available via interception.
 */
export function parseYouTubeCaptionTracksFromHtml(scriptText: string): CaptionTrack[] | null {
  const match = scriptText.match(/"captionTracks":(\[.*?\])/);
  if (!match) return null;
  try {
    const raw = JSON.parse(match[1]);
    return parseYouTubeCaptionTracks({ captions: { playerCaptionsTracklistRenderer: { captionTracks: raw } } });
  } catch {
    return null;
  }
}

/**
 * Parse Hotmart metadata (mediaCode, mediaTitle) from a __NEXT_DATA__ object.
 */
export function parseHotmartMetadata(data: HotmartNextData): { mediaCode: string | null; mediaTitle: string | null } {
  const props = data?.props?.pageProps;
  const mediaCode = props?.mediaCode ?? props?.applicationData?.mediaCode ?? null;
  const mediaTitle = props?.mediaTitle ?? props?.applicationData?.mediaTitle ?? null;
  return { mediaCode, mediaTitle };
}

/**
 * Extract Hotmart mediaCode and mediaTitle from script text using regex.
 * Used as a fallback when structured data isn't available.
 */
export function parseHotmartMetadataFromHtml(scriptText: string): { mediaCode: string | null; mediaTitle: string | null } {
  const codeMatch = scriptText.match(/"mediaCode"\s*:\s*"([^"]+)"/);
  const titleMatch = scriptText.match(/"mediaTitle"\s*:\s*"([^"]+)"/);
  return { mediaCode: codeMatch?.[1] || null, mediaTitle: titleMatch?.[1] || null };
}
