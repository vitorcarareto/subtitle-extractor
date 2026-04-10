import { parseWebVTT, parseSubtitleText, extractLangFromUrl, sortTracksManualFirst, deduplicateCues, cuesToSrt, cuesToVtt } from './lib.js';
import type { VideoMetadata, CaptionTrack, HotmartNextData, YouTubePlayerResponse } from './types.js';

declare function showSaveFilePicker(options?: {
  suggestedName?: string;
  types?: Array<{
    description: string;
    accept: Record<string, string[]>;
  }>;
}): Promise<FileSystemFileHandle>;

// Extract video metadata from supported video platforms
(function () {
  const hostname = location.hostname;

  function isHotmart(): boolean {
    return hostname.includes('hotmart.com');
  }

  function isYoutube(): boolean {
    return hostname.includes('youtube.com');
  }

  function extractMetadata(): VideoMetadata {
    if (isHotmart()) return extractHotmartMetadata();
    if (isYoutube()) return extractYoutubeMetadata();
    return { mediaCode: null, mediaTitle: null, videoName: null, videoIndex: null };
  }

  function extractYoutubeMetadata(): VideoMetadata {
    const videoName = document.querySelector('h1.ytd-watch-metadata yt-formatted-string')?.textContent?.trim()
      || document.querySelector('meta[name="title"]')?.getAttribute('content')
      || document.title.replace(/ - YouTube$/, '').trim()
      || null;

    // Extract caption tracks from ytInitialPlayerResponse
    let captionTracks: CaptionTrack[] | null = null;
    try {
      // Try the global variable first (available on initial page load)
      const playerResp = (window as unknown as { ytInitialPlayerResponse?: YouTubePlayerResponse }).ytInitialPlayerResponse;
      const tracks = playerResp?.captions?.playerCaptionsTracklistRenderer?.captionTracks;
      if (tracks && tracks.length > 0) {
        captionTracks = tracks.map((t: { baseUrl: string; languageCode: string; name?: { simpleText?: string }; kind?: string }) => ({
          baseUrl: t.baseUrl,
          languageCode: t.languageCode,
          name: t.name?.simpleText || t.languageCode,
          kind: t.kind || '',
        }));
      }
    } catch {
      // ignore
    }

    // Fallback: parse from page HTML if global var is stale (SPA navigation)
    if (!captionTracks) {
      try {
        const scripts = document.querySelectorAll('script');
        for (const script of scripts) {
          const text = script.textContent;
          if (text && text.includes('"captionTracks"')) {
            const match = text.match(/"captionTracks":(\[.*?\])/);
            if (match) {
              const tracks = JSON.parse(match[1]);
              captionTracks = tracks.map((t: { baseUrl: string; languageCode: string; name?: { simpleText?: string }; kind?: string }) => ({
                baseUrl: t.baseUrl,
                languageCode: t.languageCode,
                name: t.name?.simpleText || t.languageCode,
                kind: t.kind || '',
              }));
              break;
            }
          }
        }
      } catch {
        // ignore parse errors
      }
    }

    return { mediaCode: null, mediaTitle: videoName, videoName, videoIndex: null, captionTracks };
  }

  function extractHotmartMetadata(): VideoMetadata {
    let mediaCode: string | null = null;
    let mediaTitle: string | null = null;

    const nextDataEl = document.getElementById('__NEXT_DATA__');
    if (nextDataEl) {
      try {
        const data = JSON.parse(nextDataEl.textContent!) as HotmartNextData;
        const props = data?.props?.pageProps;
        if (props) {
          mediaCode = props.mediaCode || props.applicationData?.mediaCode || null;
          mediaTitle = props.mediaTitle || props.applicationData?.mediaTitle || null;
        }
        if (!mediaCode) {
          const jsonStr = nextDataEl.textContent!;
          const codeMatch = jsonStr.match(/"mediaCode"\s*:\s*"([^"]+)"/);
          const titleMatch = jsonStr.match(/"mediaTitle"\s*:\s*"([^"]+)"/);
          if (codeMatch) mediaCode = codeMatch[1];
          if (titleMatch) mediaTitle = titleMatch[1];
        }
      } catch (e) {
        // ignore parse errors
      }
    }

    if (!mediaCode) {
      const scripts = document.querySelectorAll('script');
      for (const script of scripts) {
        const text = script.textContent;
        if (text && text.includes('mediaCode')) {
          const codeMatch = text.match(/"mediaCode"\s*:\s*"([^"]+)"/);
          const titleMatch = text.match(/"mediaTitle"\s*:\s*"([^"]+)"/);
          if (codeMatch) mediaCode = codeMatch[1];
          if (titleMatch) mediaTitle = titleMatch[1];
          if (mediaCode) break;
        }
      }
    }

    if (!mediaTitle && document.title) {
      mediaTitle = document.title.replace(/\s*[-|].*$/, '').trim() || null;
    }

    let videoName: string | null = null;
    let videoIndex: number | null = null;
    let sectionIndex: number | null = null;
    const section = document.querySelector('section[id^="sectionId_"]');
    if (section) {
      // Extract section number from the button's numbered circle div
      const sectionIdMatch = section.id.match(/sectionId_(\d+)/);
      if (sectionIdMatch) {
        sectionIndex = parseInt(sectionIdMatch[1]);
      }
      const activeDiv = section.querySelector('div[data-active="true"]');
      if (activeDiv) {
        const span = activeDiv.querySelector('span[title]');
        if (span) {
          videoName = span.getAttribute('title') || span.textContent!.trim();
        }
        const allItems = section.querySelectorAll('div[data-active]');
        for (let i = 0; i < allItems.length; i++) {
          if (allItems[i] === activeDiv) {
            videoIndex = i + 1;
            break;
          }
        }
      }
    }

    return { mediaCode, mediaTitle, videoName, videoIndex, sectionIndex };
  }

  function sendMetadata(): void {
    const metadata = extractMetadata();
    if (metadata.mediaCode || metadata.mediaTitle) {
      chrome.runtime.sendMessage({
        type: 'metadata',
        ...metadata,
      });
      try {
        chrome.storage.session.set({
          [`meta_${location.href}`]: metadata,
        });
      } catch {
        // storage not available in this context
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Overlay download button
  // ---------------------------------------------------------------------------
  const OVERLAY_ID: string = 'subtitle-ext-overlay';

  function injectOverlayStyles(): void {
    if (document.getElementById('subtitle-ext-styles')) return;
    const style = document.createElement('style');
    style.id = 'subtitle-ext-styles';
    style.textContent = `
      @keyframes subtitle-ext-pulse {
        0% { transform: scale(1); }
        50% { transform: scale(0.9); }
        100% { transform: scale(1); }
      }
      @keyframes subtitle-ext-glow {
        0%, 100% { box-shadow: 0 0 6px rgba(232,168,48,0.4); }
        50% { box-shadow: 0 0 14px rgba(232,168,48,0.8); }
      }
      @keyframes subtitle-ext-ring-pulse {
        0%, 100% { stroke-dashoffset: 88; opacity: 0.5; }
        50% { stroke-dashoffset: 44; opacity: 1; }
      }
      @keyframes subtitle-ext-ring-spin {
        from { transform: rotate(-90deg); }
        to { transform: rotate(270deg); }
      }
      @keyframes subtitle-ext-pop {
        0% { transform: scale(0.5); opacity: 0.5; }
        60% { transform: scale(1.15); }
        100% { transform: scale(1); opacity: 1; }
      }
      @keyframes subtitle-ext-flash-red {
        0% { background: rgba(220,60,60,0.9); }
        100% { background: rgba(0,0,0,0.55); }
      }
      #${OVERLAY_ID} {
        position: absolute;
        top: 8px;
        right: 8px;
        z-index: 9999;
        width: 32px;
        height: 32px;
        border-radius: 6px;
        background: rgba(0,0,0,0.55);
        border: 1px solid rgba(255,255,255,0.15);
        color: rgba(255,255,255,0.7);
        cursor: pointer;
        display: flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.2s, background 0.2s, transform 0.15s ease, box-shadow 0.2s;
        pointer-events: auto;
        backdrop-filter: blur(4px);
        -webkit-backdrop-filter: blur(4px);
      }
      #${OVERLAY_ID}:hover {
        background: rgba(232,168,48,0.85);
        color: #fff;
        border-color: rgba(232,168,48,0.9);
        opacity: 1 !important;
        transform: scale(1.05);
        box-shadow: 0 0 10px rgba(232,168,48,0.5);
      }
      #${OVERLAY_ID}:active {
        transform: scale(0.95);
      }
      #${OVERLAY_ID}.clicked {
        animation: subtitle-ext-pulse 0.25s ease;
      }
      #${OVERLAY_ID}.waiting {
        background: rgba(232,168,48,0.65);
        color: #fff;
        opacity: 1 !important;
        animation: subtitle-ext-glow 1.2s ease-in-out infinite;
        pointer-events: none;
      }
      #${OVERLAY_ID}.downloading {
        background: rgba(0,0,0,0.75);
        color: #fff;
        opacity: 1 !important;
        pointer-events: none;
      }
      #${OVERLAY_ID}.downloading .progress-ring-bg {
        stroke: rgba(255,255,255,0.25);
        stroke-width: 3;
      }
      #${OVERLAY_ID}.downloading .progress-ring-fg {
        stroke: #f0b030;
        stroke-width: 3;
        filter: drop-shadow(0 0 3px rgba(240,176,48,0.7));
        transition: stroke-dashoffset 0.25s ease;
      }
      #${OVERLAY_ID}.downloading.indeterminate .progress-ring-fg {
        stroke: #f0b030;
        filter: drop-shadow(0 0 3px rgba(240,176,48,0.7));
        animation: subtitle-ext-ring-pulse 1.8s ease-in-out infinite;
        transition: none;
      }
      #${OVERLAY_ID}.downloading.indeterminate svg {
        animation: subtitle-ext-ring-spin 2.4s linear infinite;
      }
      #${OVERLAY_ID}.done {
        background: rgba(76,175,124,0.85);
        color: #fff;
        opacity: 1 !important;
      }
      #${OVERLAY_ID}.done svg {
        animation: subtitle-ext-pop 0.35s ease forwards;
      }
      #${OVERLAY_ID}.error {
        animation: subtitle-ext-flash-red 0.6s ease forwards;
        color: #fff;
        opacity: 1 !important;
      }
      #${OVERLAY_ID} svg {
        width: 16px;
        height: 16px;
      }
      /* Tooltip */
      #${OVERLAY_ID}::after {
        content: attr(data-tooltip);
        position: absolute;
        right: calc(100% + 6px);
        top: 50%;
        transform: translateY(-50%);
        background: rgba(20,20,20,0.92);
        color: #ddd;
        font-size: 11px;
        font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
        padding: 4px 8px;
        border-radius: 4px;
        white-space: nowrap;
        pointer-events: none;
        opacity: 0;
        transition: opacity 0.15s;
      }
      #${OVERLAY_ID}:hover::after {
        opacity: 1;
      }
      /* Hide tooltip during states */
      #${OVERLAY_ID}.waiting::after,
      #${OVERLAY_ID}.downloading::after,
      #${OVERLAY_ID}.done::after,
      #${OVERLAY_ID}.error::after {
        display: none;
      }
      /* Show button when hovering the video container */
      .subtitle-ext-hover-zone:hover #${OVERLAY_ID} {
        opacity: 0.7;
      }
    `;
    document.head.appendChild(style);
  }

  const SVG_DOWNLOAD: string = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 01-2 2H5a2 2 0 01-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>';
  const SVG_CHECK: string = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" style="width:18px;height:18px"><path d="M5 13l4 4L19 7"/></svg>';
  const SVG_ERROR: string = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>';

  // Circular progress ring SVG (fits within 32x32 button)
  // Circle: r=14, C=2*pi*14 ~= 87.96, rounded to 88
  const RING_CIRCUMFERENCE: number = 88;
  function buildProgressRingSVG(): string {
    return `<svg viewBox="0 0 32 32" style="width:24px;height:24px">` +
      `<circle class="progress-ring-bg" cx="16" cy="16" r="14" fill="none" stroke-width="2.5"/>` +
      `<circle class="progress-ring-fg" cx="16" cy="16" r="14" fill="none" stroke-width="2.5" ` +
        `stroke-linecap="round" stroke-dasharray="${RING_CIRCUMFERENCE}" stroke-dashoffset="${RING_CIRCUMFERENCE}" ` +
        `transform="rotate(-90 16 16)"/>` +
    `</svg>`;
  }

  function setOverlayProgress(percent: number): void {
    const btn = document.getElementById(OVERLAY_ID);
    if (!btn) return;
    const fg = btn.querySelector('.progress-ring-fg');
    if (!fg) return;
    const clamped = Math.max(0, Math.min(100, percent));
    const offset = RING_CIRCUMFERENCE - (RING_CIRCUMFERENCE * clamped / 100);
    fg.setAttribute('stroke-dashoffset', String(offset));
  }

  function findVideoContainer(): HTMLElement | null {
    if (isYoutube()) {
      return document.querySelector('#movie_player') || document.querySelector('.html5-video-player');
    }
    if (isHotmart()) {
      // We inject inside the Hotmart iframe where the <video> element lives.
      const video = document.querySelector('video');
      if (video) return video.parentElement;
      return null;
    }
    return null;
  }

  function injectOverlayButton(): void {
    if (document.getElementById(OVERLAY_ID)) return;
    const container = findVideoContainer();
    if (!container) return;

    // Ensure container is positioned for absolute child
    const pos = getComputedStyle(container).position;
    if (pos === 'static') container.style.position = 'relative';
    container.classList.add('subtitle-ext-hover-zone');

    injectOverlayStyles();

    const btn = document.createElement('div');
    btn.id = OVERLAY_ID;
    btn.setAttribute('data-tooltip', 'Download subtitles');
    btn.innerHTML = SVG_DOWNLOAD;
    container.appendChild(btn);

    btn.addEventListener('click', (e) => {
      e.stopPropagation();
      e.preventDefault();
      handleOverlayDownload();
    });
    btn.addEventListener('mousedown', (e) => { e.stopPropagation(); });
    btn.addEventListener('mouseup', (e) => { e.stopPropagation(); });
  }

  function resetBtnState(btn: HTMLElement): void {
    btn.classList.remove('clicked', 'waiting', 'downloading', 'indeterminate', 'done', 'error');
    btn.innerHTML = SVG_DOWNLOAD;
  }

  async function handleOverlayDownload(): Promise<void> {
    const btn = document.getElementById(OVERLAY_ID);
    if (!btn || btn.classList.contains('downloading') || btn.classList.contains('waiting')) return;

    // Click pulse feedback
    btn.classList.add('clicked');
    btn.addEventListener('animationend', () => btn.classList.remove('clicked'), { once: true });

    let metadata: VideoMetadata = extractMetadata();

    // If in an iframe (Hotmart), request metadata from the top frame which has
    // the sidebar with videoName, videoIndex, sectionIndex
    if (window !== window.top) {
      try {
        const topMeta = await chrome.runtime.sendMessage({ type: 'getTopFrameMetadata' });
        if (topMeta && (topMeta.videoName || topMeta.sectionIndex != null)) {
          // Merge: prefer top frame's sidebar data, keep iframe's mediaCode/mediaTitle as fallback
          metadata = {
            ...metadata,
            videoName: topMeta.videoName || metadata.videoName,
            videoIndex: topMeta.videoIndex ?? metadata.videoIndex,
            sectionIndex: topMeta.sectionIndex ?? metadata.sectionIndex,
          };
        }
      } catch {
        // top frame not available, use local metadata
      }
    }

    // Load settings from storage
    let settings: Record<string, string | number> = {};
    try {
      settings = await chrome.storage.local.get(['prefix', 'concurrency', 'format_hotmart', 'format_youtube', 'format']);
    } catch {}

    const providerId = isYoutube() ? 'youtube' : isHotmart() ? 'hotmart' : null;
    const format = settings[`format_${providerId}`] || settings.format || 'txt';
    const prefix = settings.prefix || '';
    const concurrency = settings.concurrency || 10;

    // Build filename
    const name = metadata.videoName || metadata.mediaTitle || metadata.mediaCode || 'subtitles';
    const safeName = name.replace(/[<>:"/\\|?*]/g, '_').substring(0, 200);
    const idx = metadata.videoIndex;
    const secIdx = metadata.sectionIndex;
    let filenameBase = safeName;
    if (secIdx != null && idx != null) {
      filenameBase = `${secIdx}.${idx} ${safeName}`;
    } else if (idx != null) {
      filenameBase = `${idx} ${safeName}`;
    }
    const trimmedPrefix = (prefix as string).trim();
    const filename = trimmedPrefix ? `${trimmedPrefix}${filenameBase}.${format}` : `${filenameBase}.${format}`;

    const isTopFrame = window === window.top;

    // In top frame (YouTube): use showSaveFilePicker for folder memory.
    // In iframe (Hotmart): use chrome.downloads.download via background script.
    let fileHandle: FileSystemFileHandle | undefined;
    if (isTopFrame) {
      // Show waiting state while file picker is open
      btn.classList.add('waiting');

      const mimeTypes: Record<string, string> = { txt: 'text/plain', srt: 'application/x-subrip', vtt: 'text/vtt' };
      try {
        fileHandle = await showSaveFilePicker({
          suggestedName: filename as string,
          types: [{ description: 'Subtitle file', accept: { [mimeTypes[format as string] || 'text/plain']: [`.${format}`] } }],
        });
      } catch (e) {
        btn.classList.remove('waiting');
        if ((e as Error).name === 'AbortError') return;
        throw e;
      }

      // Transition from waiting to downloading
      btn.classList.remove('waiting');
    }

    btn.classList.add('downloading');

    // Show progress ring: indeterminate for YouTube, determinate for Hotmart
    const isYT = isYoutube() && metadata.captionTracks && metadata.captionTracks.length > 0;
    btn.innerHTML = buildProgressRingSVG();
    if (isYT) {
      btn.classList.add('indeterminate');
    }

    try {
      let cues;

      if (isYT) {
        // YouTube: fetch first available track (prefer manual over auto)
        const sorted = sortTracksManualFirst(metadata.captionTracks!);
        const track = sorted[0];
        const lang = extractLangFromUrl(track.baseUrl);
        const tabResp = await chrome.runtime.sendMessage({ type: 'getTabId' }) as { tabId?: number } | undefined;
        if (!tabResp?.tabId) throw new Error('No tab ID');
        const result = await chrome.runtime.sendMessage({ type: 'fetchYoutubeTrack', tabId: tabResp.tabId, lang });
        if (result.error) throw new Error(result.error);
        cues = parseSubtitleText(result.text);
      } else {
        // Hotmart: need the captured pattern from background
        const tab = await getTabId();
        const resp = await chrome.runtime.sendMessage({ type: 'getPattern', tabId: tab });
        if (!resp || !resp.pattern) throw new Error('No subtitle pattern captured');

        const results = await fetchSegmentsFromOverlay(resp.pattern, concurrency as number);
        cues = [];
        for (const r of results) {
          if (r.text) cues.push(...parseWebVTT(r.text));
        }
      }

      if (cues.length === 0) throw new Error('No cues found');

      // Deduplicate and sort
      const unique = deduplicateCues(cues);
      unique.sort((a, b) => a.startMs - b.startMs);

      // Format output
      let text: string;
      if (format === 'srt') {
        text = cuesToSrt(unique);
      } else if (format === 'vtt') {
        text = cuesToVtt(unique);
      } else {
        text = unique.map((c) => c.text).join('\n');
      }

      if (isTopFrame) {
        // Write file via File System Access API
        const writable = await fileHandle!.createWritable();
        await writable.write(text);
        await writable.close();
      } else {
        // In iframe: use chrome.downloads.download via background script
        await chrome.runtime.sendMessage({ type: 'downloadFile', content: text, filename });
      }

      // Success state with pop animation
      btn.innerHTML = SVG_CHECK;
      btn.classList.remove('downloading', 'indeterminate');
      btn.classList.add('done');
      setTimeout(() => resetBtnState(btn), 3000);
    } catch (err) {
      // Error state: red flash then reset
      btn.classList.remove('downloading', 'indeterminate');
      btn.innerHTML = SVG_ERROR;
      btn.classList.add('error');
      setTimeout(() => resetBtnState(btn), 1500);
      console.error('Subtitle Extractor:', (err as Error).message);
    }
  }

  async function getTabId(): Promise<number | undefined> {
    const resp = await chrome.runtime.sendMessage({ type: 'getTabId' }) as { tabId?: number } | undefined;
    return resp?.tabId;
  }

  async function fetchSegmentsFromOverlay(pattern: { baseUrl: string }, concurrency: number): Promise<Array<{ seg: number; text?: string; error?: unknown }>> {
    const results: Array<{ seg: number; text?: string; error?: unknown } | undefined> = [];
    const MAX_ERRORS = 3;
    const pool = Math.max(1, concurrency);
    const inFlight: Map<number, Promise<void>> = new Map();
    let nextSeg = 0;
    let stopLaunching = false;
    let completedCount = 0;

    function buildUrl(s: number) {
      return pattern.baseUrl.replace('{SEG}', String(s));
    }

    function checkStop() {
      let consecutive = 0;
      for (let i = results.length - 1; i >= 0; i--) {
        if (results[i] === undefined) break;
        if (results[i]!.error) {
          if (results[i]!.seg === 0) break;
          consecutive++;
        } else break;
      }
      if (consecutive >= MAX_ERRORS) stopLaunching = true;
    }

    function launchNext() {
      while (inFlight.size < pool && !stopLaunching && nextSeg < 5000) {
        const s = nextSeg++;
        const url = buildUrl(s);
        const promise = chrome.runtime.sendMessage({ type: 'fetchSegment', url, providerId: 'hotmart' }).then((result: { text?: string; error?: unknown }) => {
          results[s] = { seg: s, ...result };
          inFlight.delete(s);
          completedCount++;
          // Update progress: use nextSeg as estimated total (upper bound)
          const totalEstimate = stopLaunching ? completedCount + inFlight.size : nextSeg;
          setOverlayProgress((completedCount / totalEstimate) * 100);
          checkStop();
        });
        inFlight.set(s, promise);
      }
    }

    launchNext();
    while (inFlight.size > 0) {
      await Promise.race(inFlight.values());
      if (!stopLaunching) launchNext();
    }

    return results.filter((r): r is { seg: number; text?: string; error?: unknown } => r !== undefined);
  }

  // ---------------------------------------------------------------------------
  // Init
  // ---------------------------------------------------------------------------
  function tryInjectOverlay(): void {
    if (isYoutube()) {
      // YouTube: only inject in the top frame
      if (window !== window.top) return;
      const metadata = extractMetadata();
      if (metadata.mediaTitle || metadata.mediaCode || metadata.captionTracks) {
        injectOverlayButton();
      }
      return;
    }

    if (isHotmart()) {
      // Hotmart: only inject inside the iframe where the <video> lives
      if (window === window.top) return;
      if (document.querySelector('video')) {
        injectOverlayButton();
      }
      return;
    }
  }

  if (document.readyState === 'complete') {
    sendMetadata();
    setTimeout(tryInjectOverlay, 1500);
  } else {
    window.addEventListener('load', () => {
      setTimeout(() => { sendMetadata(); tryInjectOverlay(); }, 1000);
    });
  }

  // Re-check for video container periodically (SPA navigation)
  let overlayRetries = 0;
  const overlayInterval = setInterval(() => {
    if (document.getElementById(OVERLAY_ID) || overlayRetries > 20) {
      clearInterval(overlayInterval);
      return;
    }
    tryInjectOverlay();
    overlayRetries++;
  }, 2000);

  chrome.runtime.onMessage.addListener((message: { type: string }, _sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
    if (message.type === 'getMetadata') {
      sendResponse(extractMetadata());
      return true;
    }
  });

})();
