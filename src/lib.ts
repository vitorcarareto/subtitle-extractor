/**
 * Pure logic functions for Hotmart subtitle extraction.
 * Zero Chrome API dependencies — fully testable.
 */

import type { Cue, ParsedSubtitleUrl, FetchResult, SegmentResult, FetchAllSegmentsOptions } from './types.js';

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
      /^(\d{2}:\d{2}:\d{2}\.\d{3})\s*-->\s*(\d{2}:\d{2}:\d{2}\.\d{3})/
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
 * Parse a WebVTT timestamp (HH:MM:SS.mmm) into milliseconds.
 */
export function parseTimestamp(ts: string): number {
  const [h, m, rest] = ts.split(':');
  const [s, ms] = rest.split('.');
  return parseInt(h) * 3600000 + parseInt(m) * 60000 + parseInt(s) * 1000 + parseInt(ms);
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

/**
 * Format milliseconds as SRT timestamp: HH:MM:SS,mmm
 */
export function formatTimestampSrt(ms: number): string {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const mil = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s},${mil}`;
}

/**
 * Format milliseconds as VTT timestamp: HH:MM:SS.mmm
 */
export function formatTimestampVtt(ms: number): string {
  const h = String(Math.floor(ms / 3600000)).padStart(2, '0');
  const m = String(Math.floor((ms % 3600000) / 60000)).padStart(2, '0');
  const s = String(Math.floor((ms % 60000) / 1000)).padStart(2, '0');
  const mil = String(ms % 1000).padStart(3, '0');
  return `${h}:${m}:${s}.${mil}`;
}

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
