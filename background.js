import { getProviderForUrl, getAllProviders } from './providers/registry.js';

const capturedPatterns = {};

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
function normPath(p) {
  return p.replace(/\\/g, '/');
}

/**
 * Extract the directory portion of a path (everything before the last slash).
 * Returns '' if the path has no directory component.
 */
function dirName(p) {
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
async function handleDownloadFile(filename, content) {
  const stored = await chrome.storage.local.get(['lastSaveDir', 'downloadsRoot']);
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

  const downloadId = await new Promise((resolve, reject) => {
    chrome.downloads.download(
      { url, filename: targetFilename, saveAs: true },
      (id) => {
        if (isBlob) URL.revokeObjectURL(url);
        if (chrome.runtime.lastError) {
          reject(new Error(chrome.runtime.lastError.message));
        } else {
          resolve(id);
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
function trackDownloadDirectory(downloadId, targetFilename, knownRoot) {
  const TIMEOUT_MS = 60_000;

  const cleanup = () => chrome.downloads.onChanged.removeListener(listener);

  const timeout = setTimeout(cleanup, TIMEOUT_MS);

  function listener(delta) {
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
function persistDirectory(absPath, targetFilename, knownRoot) {
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

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  if (message.type === 'getPattern') {
    const pattern = capturedPatterns[message.tabId] || null;
    if (pattern) {
      sendResponse({ pattern });
    } else {
      // Service worker may have restarted, losing in-memory cache — check session storage
      chrome.storage.session.get(`pattern_${message.tabId}`).then((stored) => {
        const restored = stored[`pattern_${message.tabId}`] || null;
        if (restored) capturedPatterns[message.tabId] = restored;
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
    const provider = getProviderForUrl(message.url);
    sendResponse({ provider: provider ? { id: provider.id, name: provider.name, formats: provider.formats, stub: provider.stub || false } : null });
    return true;
  }

  if (message.type === 'fetchYoutubeTrack') {
    const provider = getAllProviders().find((p) => p.id === 'youtube');
    if (!provider) {
      sendResponse({ error: 'YouTube provider not found' });
      return true;
    }
    provider.fetchSubtitle(message.url)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }

  if (message.type === 'downloadFile') {
    handleDownloadFile(message.filename, message.content).then(
      () => sendResponse({ ok: true }),
      (err) => sendResponse({ ok: false, error: err.message })
    );
    return true;
  }

  if (message.type === 'fetchSegment') {
    const providerId = message.providerId || 'hotmart';
    const provider = getAllProviders().find((p) => p.id === providerId);
    if (!provider) {
      sendResponse({ error: 'Unknown provider' });
      return true;
    }
    provider.fetchSubtitle(message.url)
      .then((result) => sendResponse(result))
      .catch((err) => sendResponse({ error: err.message }));
    return true;
  }
});
