import { getProviderForUrl, getAllProviders } from './providers/registry.js';
import type { CapturedPattern, ProviderInfo, ExtensionMessage } from './types.js';

console.log('[BUILD bg] AC92A1ED-207C-4BF5-8EA4-446834D79611');

const capturedPatterns: Record<number, CapturedPattern> = {};

// Register webRequest listeners for all providers that have filters
for (const provider of getAllProviders()) {
  if (!provider.webRequestFilter) continue;

  chrome.webRequest.onBeforeRequest.addListener(
    (details) => {
      const { url, tabId } = details;
      if (tabId < 0) return;

      const parsed = provider.parseRequest(url);
      if (!parsed) return;

      capturedPatterns[tabId] = {
        providerId: provider.id,
        ...parsed,
        capturedAt: Date.now(),
        sampleUrl: url,
      };

      chrome.storage.session.set({ [`pattern_${tabId}`]: capturedPatterns[tabId] });
    },
    { urls: [provider.webRequestFilter] }
  );
}

chrome.tabs.onRemoved.addListener((tabId) => {
  delete capturedPatterns[tabId];
  chrome.storage.session.remove(`pattern_${tabId}`);
});

/**
 * Normalise path separators to forward slashes.
 */
function normPath(p: string): string {
  return p.replace(/\\/g, '/');
}

/**
 * Extract the directory portion of a path (everything before the last slash).
 * Returns '' if the path has no directory component.
 */
function dirName(p: string): string {
  const n = normPath(p);
  const i = n.lastIndexOf('/');
  return i > 0 ? n.substring(0, i) : '';
}

/**
 * Downloads a file via chrome.downloads and remembers the last save directory.
 *
 * chrome.downloads.download's `filename` param is relative to Chrome's default
 * downloads directory.  After each successful save we infer the default
 * downloads root and compute the relative directory the user chose.  On the
 * next download we prepend that relative dir so the save-as dialog opens in the
 * same folder.
 *
 * Stored keys in chrome.storage.local:
 *   lastSaveDir   – relative dir to prepend (e.g. "my-subtitles" or "")
 *   downloadsRoot – absolute path to Chrome's default downloads folder
 */
async function handleDownloadFile(filename: string, content: string): Promise<void> {
  const stored = await chrome.storage.local.get(['lastSaveDir', 'downloadsRoot']) as { lastSaveDir?: string; downloadsRoot?: string };
  const lastDir = stored.lastSaveDir || '';
  const knownRoot = stored.downloadsRoot || '';

  // Build the relative filename Chrome will use (relative to default downloads dir)
  const targetFilename = lastDir ? `${lastDir}/${filename}` : filename;

  // Create download URL — try blob first, fall back to data URL
  let url;
  let isBlob = false;
  try {
    const blob = new Blob([content], { type: 'text/plain;charset=utf-8' });
    url = URL.createObjectURL(blob);
    isBlob = true;
  } catch {
    url = 'data:text/plain;charset=utf-8,' + encodeURIComponent(content);
  }

  const downloadId = await new Promise<number>((resolve, reject) => {
    chrome.downloads.download(
      { url, filename: targetFilename, saveAs: true },
      (id) => {
        if (isBlob) URL.revokeObjectURL(url);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id!);
        }
      }
    );
  });

  // After the download completes, learn the directory the user chose and persist it.
  // This is fire-and-forget — we don't fail the download if tracking doesn't work.
  try {
    trackDownloadDirectory(downloadId, targetFilename, knownRoot);
  } catch {
    // Silently ignore — directory tracking is best-effort.
  }
}

/**
 * Watches a download for completion and persists the chosen save directory.
 */
function trackDownloadDirectory(downloadId: number, targetFilename: string, knownRoot: string): void {
  const TIMEOUT_MS = 60_000;

  const cleanup = () => chrome.downloads.onChanged.removeListener(listener);

  const timeout = setTimeout(cleanup, TIMEOUT_MS);

  function listener(delta: chrome.downloads.DownloadDelta): void {
    if (delta.id !== downloadId || !delta.state) return;

    if (delta.state.current === 'complete') {
      clearTimeout(timeout);
      cleanup();
      chrome.downloads.search({ id: downloadId }, (items) => {
        try {
          if (!items || items.length === 0 || !items[0].filename) return;
          persistDirectory(normPath(items[0].filename), targetFilename, knownRoot);
        } catch {
          // Silently ignore — directory persistence is best-effort.
        }
      });
    } else if (delta.state.current === 'interrupted') {
      clearTimeout(timeout);
      cleanup();
    }
  }

  chrome.downloads.onChanged.addListener(listener);
}

/**
 * Given the absolute path where a file was saved, the relative filename we
 * requested, and (possibly) the previously-known downloads root, compute and
 * store the relative save directory for next time.
 */
function persistDirectory(absPath: string, targetFilename: string, knownRoot: string): void {
  const absDir = dirName(absPath);
  const targetNorm = normPath(targetFilename);

  let root = knownRoot;

  // If the absolute path ends with our target filename, we can infer the
  // downloads root:  root = absPath  minus  targetFilename.
  if (absPath.endsWith('/' + targetNorm)) {
    root = absPath.substring(0, absPath.length - targetNorm.length - 1);
  }

  let relativeDir = '';

  if (root && absDir.startsWith(root)) {
    // Strip the root prefix (and the separator) to get the relative dir
    relativeDir = absDir.length > root.length ? absDir.substring(root.length + 1) : '';
  }
  // If we couldn't determine root, relativeDir stays '' (safe default: next
  // download will suggest the bare filename in the default downloads dir).

  chrome.storage.local.set({
    lastSaveDir: relativeDir,
    downloadsRoot: root,
  });
}

chrome.runtime.onMessage.addListener((message: Record<string, unknown>, sender: chrome.runtime.MessageSender, sendResponse: (response: unknown) => void) => {
  if (message.type === 'getPattern') {
    const pattern = capturedPatterns[message.tabId as number] || null;
    if (pattern) {
      sendResponse({ pattern });
    } else {
      // Service worker may have restarted, losing in-memory cache — check session storage
      chrome.storage.session.get(`pattern_${message.tabId as number}`).then((stored) => {
        const restored = stored[`pattern_${message.tabId as number}`] || null;
        if (restored) capturedPatterns[message.tabId as number] = restored as CapturedPattern;
        sendResponse({ pattern: restored });
      });
    }
    return true;
  }

  if (message.type === 'getTabId') {
    sendResponse({ tabId: sender.tab?.id });
    return true;
  }

  if (message.type === 'getTopFrameMetadata') {
    // Forward to the top frame (frameId 0) of the sender's tab
    const tabId = sender.tab?.id;
    if (!tabId) { sendResponse(null); return true; }
    chrome.tabs.sendMessage(tabId, { type: 'getMetadata' }, { frameId: 0 })
      .then((meta) => sendResponse(meta))
      .catch(() => sendResponse(null));
    return true;
  }

  if (message.type === 'getProviderForUrl') {
    const provider = getProviderForUrl(message.url as string);
    const info: ProviderInfo | null = provider ? { id: provider.id, name: provider.name, formats: provider.formats, stub: false } : null;
    sendResponse({ provider: info });
    return true;
  }

  if (message.type === 'fetchYoutubeTrack') {
    const tabId = message.tabId as number | undefined;
    const lang = message.lang as string | undefined;
    console.log('[DEBUG bg] fetchYoutubeTrack tabId:', tabId, 'lang:', lang);
    if (!tabId) {
      sendResponse({ error: 'No tabId provided' });
      return true;
    }
    // Use YouTube's internal XMLHttpRequest interception to capture the
    // subtitle response that the player fetches (with pot token included).
    // We monkey-patch XMLHttpRequest.open, trigger the player to load the
    // desired caption track, and capture the response.
    chrome.scripting.executeScript({
      target: { tabId, frameIds: [0] },
      world: 'MAIN',
      func: (trackLang: string | undefined) => {
        return new Promise<{ text?: string; error?: string }>((resolve) => {
          const timeout = setTimeout(() => resolve({ error: 'Timeout waiting for subtitle response' }), 10000);

          // Intercept fetch to capture timedtext responses
          const origFetch = window.fetch;
          window.fetch = function (...args: Parameters<typeof fetch>) {
            const url = typeof args[0] === 'string' ? args[0] : (args[0] as Request).url;
            if (url.includes('/api/timedtext') && url.includes('fmt=')) {
              return origFetch.apply(this, args).then(async (response) => {
                const clone = response.clone();
                const text = await clone.text();
                if (text.length > 0) {
                  clearTimeout(timeout);
                  window.fetch = origFetch;
                  resolve({ text });
                }
                return response;
              });
            }
            return origFetch.apply(this, args);
          };

          // Also intercept XMLHttpRequest
          const origXHROpen = XMLHttpRequest.prototype.open;
          const origXHRSend = XMLHttpRequest.prototype.send;
          XMLHttpRequest.prototype.open = function (method: string, url: string | URL, ...rest: [boolean?, string?, string?]) {
            (this as XMLHttpRequest & { __url?: string }).__url = String(url);
            return origXHROpen.call(this, method, url, ...rest);
          };
          XMLHttpRequest.prototype.send = function (...args: [Document | XMLHttpRequestBodyInit | null | undefined]) {
            const xhrUrl = (this as XMLHttpRequest & { __url?: string }).__url || '';
            if (xhrUrl.includes('/api/timedtext') && xhrUrl.includes('fmt=')) {
              this.addEventListener('load', function () {
                const text = this.responseText;
                if (text && text.length > 0) {
                  clearTimeout(timeout);
                  XMLHttpRequest.prototype.open = origXHROpen;
                  XMLHttpRequest.prototype.send = origXHRSend;
                  window.fetch = origFetch;
                  resolve({ text });
                }
              });
            }
            return origXHRSend.apply(this, args);
          };

          // Now trigger the player to load the caption track
          try {
            const player = document.querySelector('#movie_player') as HTMLElement & {
              setOption?: (module: string, option: string, value: unknown) => void;
              getOption?: (module: string, option: string) => unknown;
              getPlayerResponse?: () => {
                captions?: {
                  playerCaptionsTracklistRenderer?: {
                    captionTracks?: Array<{ baseUrl: string; languageCode: string; vssId: string }>;
                  };
                };
              };
            };

            if (!player?.setOption) {
              clearTimeout(timeout);
              XMLHttpRequest.prototype.open = origXHROpen;
              XMLHttpRequest.prototype.send = origXHRSend;
              window.fetch = origFetch;
              resolve({ error: 'YouTube player not found' });
              return;
            }

            // Find the track's vssId
            const resp = player.getPlayerResponse?.();
            const tracks = resp?.captions?.playerCaptionsTracklistRenderer?.captionTracks || [];
            const target = trackLang
              ? tracks.find((t: { languageCode: string }) => t.languageCode === trackLang)
              : tracks[0];

            if (!target) {
              clearTimeout(timeout);
              XMLHttpRequest.prototype.open = origXHROpen;
              XMLHttpRequest.prototype.send = origXHRSend;
              window.fetch = origFetch;
              resolve({ error: 'Caption track not found for lang: ' + trackLang });
              return;
            }

            // Toggle captions off then on with the desired track to force a fetch
            player.setOption('captions', 'track', {});
            setTimeout(() => {
              player!.setOption!('captions', 'track', { languageCode: target.languageCode, vssId: target.vssId });
            }, 100);
          } catch (err) {
            clearTimeout(timeout);
            XMLHttpRequest.prototype.open = origXHROpen;
            XMLHttpRequest.prototype.send = origXHRSend;
            window.fetch = origFetch;
            resolve({ error: String(err) });
          }
        });
      },
      args: [lang || null],
    })
      .then((results) => {
        console.log('[DEBUG bg] executeScript results length:', JSON.stringify(results).length);
        const result = results?.[0]?.result as { text?: string; error?: string } | undefined;
        sendResponse(result || { error: 'No result from page script' });
      })
      .catch((err) => {
        console.log('[DEBUG bg] executeScript FAILED:', err);
        sendResponse({ error: (err as Error).message });
      });
    return true;
  }

  if (message.type === 'downloadFile') {
    handleDownloadFile(message.filename as string, message.content as string).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: (err as Error).message })
    );
    return true;
  }

  if (message.type === 'fetchSegment') {
    const providerId = (message.providerId as string) || 'hotmart';
    const provider = getAllProviders().find((p) => p.id === providerId);
    if (!provider) {
      sendResponse({ error: 'Unknown provider' });
      return true;
    }
    provider.fetchSubtitle(message.url as string)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: (err as Error).message }));
    return true;
  }
});
