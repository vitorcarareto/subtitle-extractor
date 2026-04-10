declare function showSaveFilePicker(options?: {
  suggestedName?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}): Promise<FileSystemFileHandle>;

import { buildSegmentUrl, cuesToSrt, cuesToVtt, deduplicateCues, fetchAllSegmentsParallel, parseWebVTT, parseYouTubeJson3 } from './lib.js';
import type { Cue, CapturedPattern, ProviderInfo, VideoMetadata } from './types.js';

console.log('[BUILD popup] AC92A1ED-207C-4BF5-8EA4-446834D79611');

const statusBox = document.getElementById('statusBox')!;
const statusIcon = document.getElementById('statusIcon')!;
const statusText = document.getElementById('statusText')!;
const metaSection = document.getElementById('metaSection')! as HTMLElement;
const videoTitle = document.getElementById('videoTitle')!;
const downloadBtn = document.getElementById('downloadBtn')! as HTMLButtonElement;
const progressSection = document.getElementById('progressSection')!;
const progressFill = document.getElementById('progressFill')!;
const segmentCount = document.getElementById('segmentCount')!;
const concurrencyInput = document.getElementById('concurrencyInput')! as HTMLInputElement;
const prefixInput = document.getElementById('prefixInput')! as HTMLInputElement;
const formatSelect = document.getElementById('formatSelect')! as HTMLSelectElement;
const langSelect = document.getElementById('langSelect')! as HTMLSelectElement;
const langRow = document.getElementById('langRow')! as HTMLElement;
const parallelGroup = document.getElementById('parallelGroup')! as HTMLElement;
const savedOverlay = document.getElementById('savedOverlay')!;
const savedLabel = document.getElementById('savedLabel')!;
const savedDetail = document.getElementById('savedDetail')!;

let currentPattern: CapturedPattern | { youtube: true } | null = null;
let currentMetadata: VideoMetadata | null = null;
let currentProvider: ProviderInfo | null = null;

const STATUS_ICONS = {
  info: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="5" r="0.8"/><rect x="7.2" y="7" width="1.6" height="4" rx="0.8"/></svg>',
  success:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 8.5l2 2 3.5-4"/></svg>',
  error:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/></svg>',
  warning:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5l6.5 12H1.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="11" r="0.8"/><rect x="7.2" y="5.5" width="1.6" height="3.5" rx="0.8"/></svg>',
};

function setStatus(text: string, type?: string): void {
  statusBox.className = `status-bar ${type}`;
  statusIcon.innerHTML = STATUS_ICONS[type as keyof typeof STATUS_ICONS] || STATUS_ICONS.info;
  statusText.textContent = text;
}

function setProgress(current: number, done: boolean): void {
  progressSection.classList.add('visible');
  if (done) {
    (progressFill as HTMLElement).style.width = '100%';
    progressFill.classList.remove('active');
    progressFill.classList.add('done');
    segmentCount.textContent = `${current} segments`;
  } else {
    const pct = Math.round(95 * (1 - 1 / (1 + current * 0.05)));
    (progressFill as HTMLElement).style.width = `${pct}%`;
    progressFill.classList.add('active');
    progressFill.classList.remove('done');
    segmentCount.textContent = `${current} segments...`;
  }
}

function showSavedOverlay(lineCount: number, filename: string): void {
  savedLabel.textContent = 'Saved!';
  savedDetail.innerHTML = `${filename}<br><span style="opacity:0.6">${lineCount} lines</span>`;
  savedOverlay.classList.add('visible');
  setTimeout(() => {
    savedOverlay.classList.remove('visible');
  }, 3000);
}

function buildFilename(): string {
  const format = formatSelect.value;
  const name = currentMetadata?.videoName || currentMetadata?.mediaTitle || (currentPattern as CapturedPattern)?.mediaCode || 'subtitles';
  const safeName = name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
  const idx = currentMetadata?.videoIndex;
  const secIdx = currentMetadata?.sectionIndex;
  const prefix = prefixInput.value.trim();
  let filenameBase = safeName;
  if (secIdx != null && idx != null) {
    filenameBase = `${secIdx}.${idx} ${safeName}`;
  } else if (idx != null) {
    filenameBase = `${idx} ${safeName}`;
  }
  return prefix ? `${prefix}${filenameBase}.${format}` : `${filenameBase}.${format}`;
}

function formatCues(cues: Cue[]): string {
  const format = formatSelect.value;
  if (format === 'srt') return cuesToSrt(cues);
  if (format === 'vtt') return cuesToVtt(cues);
  return cues.map((c) => c.text).join('\n');
}

async function init(): Promise<void> {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus('No active tab found.', 'error');
    return;
  }

  // Detect provider
  try {
    const providerResp = await chrome.runtime.sendMessage({ type: 'getProviderForUrl', url: tab.url! }) as { provider: ProviderInfo | null } | undefined;
    if (providerResp && providerResp.provider) {
      currentProvider = providerResp.provider;
      formatSelect.innerHTML = '';
      for (const fmt of currentProvider.formats) {
        const opt = document.createElement('option');
        opt.value = fmt;
        opt.textContent = `.${fmt}`;
        formatSelect.appendChild(opt);
      }
    }
  } catch {}

  // Get metadata from content script
  try {
    const metadata = await chrome.tabs.sendMessage(tab.id!, { type: 'getMetadata' }, { frameId: 0 }) as VideoMetadata | undefined;
    if (metadata && (metadata.mediaCode || metadata.mediaTitle || metadata.videoName)) {
      currentMetadata = metadata;
      (metaSection as HTMLElement).style.display = 'block';
      const displayName = metadata.videoName || metadata.mediaTitle || metadata.mediaCode || 'Unknown';
      const sec = metadata.sectionIndex;
      const vid = metadata.videoIndex;
      const indexPrefix = sec != null && vid != null ? `${sec}.${vid} ` : vid != null ? `${vid} ` : '';
      videoTitle.textContent = `${indexPrefix}${displayName}`;

      // YouTube: populate language dropdown if caption tracks available
      if (metadata.captionTracks && metadata.captionTracks.length > 0) {
        langRow.style.display = 'flex';
        langSelect.innerHTML = '';
        // Sort: manual captions first, then auto-generated
        const sorted = [...metadata.captionTracks].sort((a, b) => {
          if (a.kind === 'asr' && b.kind !== 'asr') return 1;
          if (a.kind !== 'asr' && b.kind === 'asr') return -1;
          return 0;
        });
        for (const track of sorted) {
          const opt = document.createElement('option');
          opt.value = track.baseUrl;
          const label = track.kind === 'asr' ? `${track.name} (auto)` : track.name;
          opt.textContent = label;
          langSelect.appendChild(opt);
        }
        // YouTube doesn't need webRequest pattern capture — enable download directly
        currentPattern = { youtube: true };
        setStatus('Ready — captions found.', 'success');
        downloadBtn.disabled = false;
        // Hide parallel control (YouTube is a single fetch)
        parallelGroup.style.display = 'none';
      }
    }
  } catch {
    // Content script not injected in main frame
  }

  // Get captured subtitle pattern (Hotmart flow)
  if (!currentPattern) {
    const response = await chrome.runtime.sendMessage({
      type: 'getPattern',
      tabId: tab.id!,
    }) as { pattern: CapturedPattern | null } | undefined;

    if (response && response.pattern) {
      currentPattern = response.pattern;
      if (!currentMetadata) {
        currentMetadata = { mediaCode: currentPattern.mediaCode, mediaTitle: null, videoName: null, videoIndex: null };
        (metaSection as HTMLElement).style.display = 'block';
        videoTitle.textContent = currentPattern.mediaCode;
      }
      setStatus('Ready — subtitle pattern captured.', 'success');
      downloadBtn.disabled = false;
    } else if (!currentPattern) {
      setStatus('No subtitles detected yet. Play the video with subtitles on, then refresh.', 'warning');
    }
  }

  // Load persisted settings
  try {
    const stored = await chrome.storage.local.get('concurrency') as { concurrency?: string };
    if (stored.concurrency) concurrencyInput.value = stored.concurrency;
  } catch {}

  try {
    const storedPrefix = await chrome.storage.local.get('prefix') as { prefix?: string };
    if (storedPrefix.prefix) prefixInput.value = storedPrefix.prefix;
  } catch {}

  try {
    const key = currentProvider ? `format_${currentProvider.id}` : 'format';
    const stored = await chrome.storage.local.get(key) as Record<string, string | undefined>;
    if (stored[key]) formatSelect.value = stored[key]!;
  } catch {}
}

concurrencyInput.addEventListener('change', () => {
  const val = Math.min(20, Math.max(1, parseInt(concurrencyInput.value) || 10));
  concurrencyInput.value = String(val);
  chrome.storage.local.set({ concurrency: val });
});

prefixInput.addEventListener('change', () => {
  chrome.storage.local.set({ prefix: prefixInput.value });
});

formatSelect.addEventListener('change', () => {
  const key = currentProvider ? `format_${currentProvider.id}` : 'format';
  chrome.storage.local.set({ [key]: formatSelect.value });
});

downloadBtn.addEventListener('click', async () => {
  if (!currentPattern) return;

  const filename = buildFilename();
  const format = formatSelect.value;
  const mimeTypes: Record<string, string> = { txt: 'text/plain', srt: 'application/x-subrip', vtt: 'text/vtt' };

  // Launch file picker immediately (uses user gesture)
  const filePickerPromise = showSaveFilePicker({
    suggestedName: filename,
    types: [{ description: 'Subtitle file', accept: { [mimeTypes[format] || 'text/plain']: [`.${format}`] } }],
  });

  downloadBtn.disabled = true;
  setStatus('Fetching subtitles...', 'info');
  progressSection.classList.add('visible');

  let fileHandle: FileSystemFileHandle;
  let text: string;
  let lineCount: number;

  try {
    let cuesPromise: Promise<Cue[]>;

    if ('youtube' in currentPattern) {
      // YouTube: single fetch for the selected track
      cuesPromise = fetchYoutubeTrack();
    } else {
      // Hotmart: parallel segmented fetch
      cuesPromise = fetchAllSegments(currentPattern);
    }

    const [handle, cues] = await Promise.all([filePickerPromise, cuesPromise]);
    fileHandle = handle;

    if (cues.length === 0) {
      setStatus('No subtitle cues found.', 'error');
      downloadBtn.disabled = false;
      return;
    }

    const unique = deduplicateCues(cues);
    unique.sort((a, b) => a.startMs - b.startMs);
    text = formatCues(unique);
    lineCount = unique.length;
  } catch (e) {
    if ((e as Error).name === 'AbortError') {
      setStatus('Cancelled.', 'warning');
      progressSection.classList.remove('visible');
      downloadBtn.disabled = false;
      return;
    }
    setStatus(`Error: ${(e as Error).message}`, 'error');
    downloadBtn.disabled = false;
    return;
  }

  // Write the file
  try {
    setStatus('Saving...', 'info');
    const writable = await fileHandle!.createWritable();
    await writable.write(text!);
    await writable.close();
    setStatus(`${lineCount!} lines extracted.`, 'success');
    segmentCount.textContent = '';
    progressSection.classList.remove('visible');
    showSavedOverlay(lineCount!, fileHandle!.name);
  } catch (err) {
    setStatus(`Save error: ${(err as Error).message}`, 'error');
  }

  downloadBtn.disabled = false;
});

async function fetchYoutubeTrack(): Promise<Cue[]> {
  const trackUrl = langSelect.value;
  if (!trackUrl) throw new Error('No caption track selected');

  // Append &fmt=vtt to get WebVTT format
  const vttUrl = trackUrl.replace(/&fmt=[^&]*/, '') + '&fmt=vtt';

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab?.id) throw new Error('No active tab');

  // Extract lang from the selected track URL
  const langMatch = trackUrl.match(/[?&]lang=([^&]*)/);
  const lang = langMatch?.[1] || undefined;
  console.log('[DEBUG] fetchYoutubeTrack lang:', lang);

  setProgress(0, false);
  // Fetch via background → chrome.scripting.executeScript in page's MAIN world.
  // The page script gets a fresh track URL from YouTube's player (which includes pot).
  const result = await chrome.runtime.sendMessage({
    type: 'fetchYoutubeTrack',
    url: trackUrl,
    lang,
    tabId: tab.id,
  }) as { text?: string; error?: string };
  setProgress(1, true);

  console.log('[DEBUG] fetchYoutubeTrack raw result:', JSON.stringify(result).substring(0, 500));

  if (result.error) throw new Error(`Failed to fetch captions: ${result.error}`);

  const text = result.text!;
  // YouTube's player fetches json3/pb3 format; fall back to VTT parsing
  let cues: Cue[];
  if (text.trimStart().startsWith('{')) {
    cues = parseYouTubeJson3(text);
  } else {
    cues = parseWebVTT(text);
  }
  console.log('[DEBUG] fetchYoutubeTrack parsed cues:', cues.length);
  return cues;
}

async function fetchAllSegments(pattern: CapturedPattern): Promise<Cue[]> {
  const concurrency = parseInt(concurrencyInput.value) || 10;

  const fetchFn = async (seg: number) => {
    const url = buildSegmentUrl(pattern.baseUrl, seg);
    const providerId = currentProvider?.id || 'hotmart';
    return chrome.runtime.sendMessage({ type: 'fetchSegment', url, providerId });
  };

  const results = await fetchAllSegmentsParallel({
    concurrency,
    fetchFn,
    onProgress: (_seg, totalCompleted) => setProgress(totalCompleted, false),
  });

  setProgress(results.length, true);

  const allCues: Cue[] = [];
  for (const result of results) {
    if (result.text) {
      const cues = parseWebVTT(result.text);
      allCues.push(...cues);
    }
  }
  return allCues;
}

document.getElementById('refreshBtn')!.addEventListener('click', () => {
  currentPattern = null;
  currentMetadata = null;
  currentProvider = null;
  (metaSection as HTMLElement).style.display = 'none';
  langRow.style.display = 'none';
  parallelGroup.style.display = '';
  downloadBtn.disabled = true;
  progressSection.classList.remove('visible');
  (progressFill as HTMLElement).style.width = '0%';
  progressFill.classList.remove('active', 'done');
  segmentCount.textContent = '';
  setStatus('Checking page...', 'info');
  init();
});

init();
