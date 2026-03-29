import { buildSegmentUrl, cuesToSrt, cuesToVtt, deduplicateCues, fetchAllSegmentsParallel, parseWebVTT } from "./lib.js";

const statusBox = document.getElementById("statusBox");
const statusIcon = document.getElementById("statusIcon");
const statusText = document.getElementById("statusText");
const metaSection = document.getElementById("metaSection");
const videoTitle = document.getElementById("videoTitle");
const downloadBtn = document.getElementById("downloadBtn");
const progressSection = document.getElementById("progressSection");
const progressFill = document.getElementById("progressFill");
const segmentCount = document.getElementById("segmentCount");
const concurrencyInput = document.getElementById("concurrencyInput");
const prefixInput = document.getElementById("prefixInput");
const formatSelect = document.getElementById("formatSelect");
const langSelect = document.getElementById("langSelect");
const langRow = document.getElementById("langRow");
const parallelGroup = document.getElementById("parallelGroup");
const savedOverlay = document.getElementById("savedOverlay");
const savedLabel = document.getElementById("savedLabel");
const savedDetail = document.getElementById("savedDetail");

let currentPattern = null;
let currentMetadata = null;
let currentProvider = null;

const STATUS_ICONS = {
  info: '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" stroke-width="1.5"/><circle cx="8" cy="5" r="0.8"/><rect x="7.2" y="7" width="1.6" height="4" rx="0.8"/></svg>',
  success:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M5.5 8.5l2 2 3.5-4"/></svg>',
  error:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round"><circle cx="8" cy="8" r="6"/><path d="M6 6l4 4M10 6l-4 4"/></svg>',
  warning:
    '<svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor"><path d="M8 1.5l6.5 12H1.5z" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linejoin="round"/><circle cx="8" cy="11" r="0.8"/><rect x="7.2" y="5.5" width="1.6" height="3.5" rx="0.8"/></svg>',
};

function setStatus(text, type = "info") {
  statusBox.className = `status-bar ${type}`;
  statusIcon.innerHTML = STATUS_ICONS[type] || STATUS_ICONS.info;
  statusText.textContent = text;
}

function setProgress(current, done) {
  progressSection.classList.add("visible");
  if (done) {
    progressFill.style.width = "100%";
    progressFill.classList.remove("active");
    progressFill.classList.add("done");
    segmentCount.textContent = `${current} segments`;
  } else {
    const pct = Math.round(95 * (1 - 1 / (1 + current * 0.05)));
    progressFill.style.width = `${pct}%`;
    progressFill.classList.add("active");
    progressFill.classList.remove("done");
    segmentCount.textContent = `${current} segments...`;
  }
}

function showSavedOverlay(lineCount, filename) {
  savedLabel.textContent = "Saved!";
  savedDetail.innerHTML = `${filename}<br><span style="opacity:0.6">${lineCount} lines</span>`;
  savedOverlay.classList.add("visible");
  setTimeout(() => {
    savedOverlay.classList.remove("visible");
  }, 3000);
}

function buildFilename() {
  const format = formatSelect.value;
  const name = currentMetadata?.videoName || currentMetadata?.mediaTitle || currentPattern?.mediaCode || "subtitles";
  const safeName = name.replace(/[<>:"/\\|?*]/g, "_").substring(0, 200);
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

function formatCues(cues) {
  const format = formatSelect.value;
  if (format === "srt") return cuesToSrt(cues);
  if (format === "vtt") return cuesToVtt(cues);
  return cues.map((c) => c.text).join("\n");
}

async function init() {
  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    setStatus("No active tab found.", "error");
    return;
  }

  // Detect provider
  try {
    const providerResp = await chrome.runtime.sendMessage({ type: "getProviderForUrl", url: tab.url });
    if (providerResp && providerResp.provider) {
      currentProvider = providerResp.provider;
      formatSelect.innerHTML = "";
      for (const fmt of currentProvider.formats) {
        const opt = document.createElement("option");
        opt.value = fmt;
        opt.textContent = `.${fmt}`;
        formatSelect.appendChild(opt);
      }
    }
  } catch {}

  // Get metadata from content script
  try {
    const metadata = await chrome.tabs.sendMessage(tab.id, { type: "getMetadata" }, { frameId: 0 });
    if (metadata && (metadata.mediaCode || metadata.mediaTitle || metadata.videoName)) {
      currentMetadata = metadata;
      metaSection.style.display = "block";
      const displayName = metadata.videoName || metadata.mediaTitle || metadata.mediaCode || "Unknown";
      const sec = metadata.sectionIndex;
      const vid = metadata.videoIndex;
      const indexPrefix = sec != null && vid != null ? `${sec}.${vid} ` : vid != null ? `${vid} ` : "";
      videoTitle.textContent = `${indexPrefix}${displayName}`;

      // YouTube: populate language dropdown if caption tracks available
      if (metadata.captionTracks && metadata.captionTracks.length > 0) {
        langRow.style.display = "flex";
        langSelect.innerHTML = "";
        // Sort: manual captions first, then auto-generated
        const sorted = [...metadata.captionTracks].sort((a, b) => {
          if (a.kind === "asr" && b.kind !== "asr") return 1;
          if (a.kind !== "asr" && b.kind === "asr") return -1;
          return 0;
        });
        for (const track of sorted) {
          const opt = document.createElement("option");
          opt.value = track.baseUrl;
          const label = track.kind === "asr" ? `${track.name} (auto)` : track.name;
          opt.textContent = label;
          langSelect.appendChild(opt);
        }
        // YouTube doesn't need webRequest pattern capture — enable download directly
        currentPattern = { youtube: true };
        setStatus("Ready — captions found.", "success");
        downloadBtn.disabled = false;
        // Hide parallel control (YouTube is a single fetch)
        parallelGroup.style.display = "none";
      }
    }
  } catch {
    // Content script not injected in main frame
  }

  // Get captured subtitle pattern (Hotmart flow)
  if (!currentPattern) {
    const response = await chrome.runtime.sendMessage({
      type: "getPattern",
      tabId: tab.id,
    });

    if (response && response.pattern) {
      currentPattern = response.pattern;
      if (!currentMetadata) {
        currentMetadata = { mediaCode: currentPattern.mediaCode, mediaTitle: null };
        metaSection.style.display = "block";
        videoTitle.textContent = currentPattern.mediaCode;
      }
      setStatus("Ready — subtitle pattern captured.", "success");
      downloadBtn.disabled = false;
    } else if (!currentPattern) {
      setStatus("No subtitles detected yet. Play the video with subtitles on, then refresh.", "warning");
    }
  }

  // Load persisted settings
  try {
    const stored = await chrome.storage.local.get("concurrency");
    if (stored.concurrency) concurrencyInput.value = stored.concurrency;
  } catch {}

  try {
    const storedPrefix = await chrome.storage.local.get("prefix");
    if (storedPrefix.prefix) prefixInput.value = storedPrefix.prefix;
  } catch {}

  try {
    const key = currentProvider ? `format_${currentProvider.id}` : "format";
    const stored = await chrome.storage.local.get(key);
    if (stored[key]) formatSelect.value = stored[key];
  } catch {}
}

concurrencyInput.addEventListener("change", () => {
  const val = Math.min(20, Math.max(1, parseInt(concurrencyInput.value) || 10));
  concurrencyInput.value = val;
  chrome.storage.local.set({ concurrency: val });
});

prefixInput.addEventListener("change", () => {
  chrome.storage.local.set({ prefix: prefixInput.value });
});

formatSelect.addEventListener("change", () => {
  const key = currentProvider ? `format_${currentProvider.id}` : "format";
  chrome.storage.local.set({ [key]: formatSelect.value });
});

downloadBtn.addEventListener("click", async () => {
  if (!currentPattern) return;

  const filename = buildFilename();
  const format = formatSelect.value;
  const mimeTypes = { txt: "text/plain", srt: "application/x-subrip", vtt: "text/vtt" };

  // Launch file picker immediately (uses user gesture)
  const filePickerPromise = window.showSaveFilePicker({
    suggestedName: filename,
    types: [{ description: "Subtitle file", accept: { [mimeTypes[format] || "text/plain"]: [`.${format}`] } }],
  });

  downloadBtn.disabled = true;
  setStatus("Fetching subtitles...", "info");
  progressSection.classList.add("visible");

  let fileHandle, text, lineCount;

  try {
    let cuesPromise;

    if (currentPattern.youtube) {
      // YouTube: single fetch for the selected track
      cuesPromise = fetchYoutubeTrack();
    } else {
      // Hotmart: parallel segmented fetch
      cuesPromise = fetchAllSegments(currentPattern);
    }

    const [handle, cues] = await Promise.all([filePickerPromise, cuesPromise]);
    fileHandle = handle;

    if (cues.length === 0) {
      setStatus("No subtitle cues found.", "error");
      downloadBtn.disabled = false;
      return;
    }

    const unique = deduplicateCues(cues);
    unique.sort((a, b) => a.startMs - b.startMs);
    text = formatCues(unique);
    lineCount = unique.length;
  } catch (e) {
    if (e.name === "AbortError") {
      setStatus("Cancelled.", "warning");
      progressSection.classList.remove("visible");
      downloadBtn.disabled = false;
      return;
    }
    setStatus(`Error: ${e.message}`, "error");
    downloadBtn.disabled = false;
    return;
  }

  // Write the file
  try {
    setStatus("Saving...", "info");
    const writable = await fileHandle.createWritable();
    await writable.write(text);
    await writable.close();
    setStatus(`${lineCount} lines extracted.`, "success");
    segmentCount.textContent = "";
    progressSection.classList.remove("visible");
    showSavedOverlay(lineCount, fileHandle.name);
  } catch (err) {
    setStatus(`Save error: ${err.message}`, "error");
  }

  downloadBtn.disabled = false;
});

async function fetchYoutubeTrack() {
  const trackUrl = langSelect.value;
  if (!trackUrl) throw new Error("No caption track selected");

  // Append &fmt=vtt to get WebVTT format
  const vttUrl = trackUrl.replace(/&fmt=[^&]*/, "") + "&fmt=vtt";

  setProgress(0, false);
  const result = await chrome.runtime.sendMessage({ type: "fetchYoutubeTrack", url: vttUrl });
  setProgress(1, true);

  if (result.error) throw new Error(`Failed to fetch captions: ${result.error}`);

  return parseWebVTT(result.text);
}

async function fetchAllSegments(pattern) {
  const concurrency = parseInt(concurrencyInput.value) || 10;

  const fetchFn = async (seg) => {
    const url = buildSegmentUrl(pattern.baseUrl, seg);
    const providerId = currentProvider?.id || "hotmart";
    return chrome.runtime.sendMessage({ type: "fetchSegment", url, providerId });
  };

  const results = await fetchAllSegmentsParallel({
    concurrency,
    fetchFn,
    onProgress: (_seg, totalCompleted) => setProgress(totalCompleted, false),
  });

  setProgress(results.length, true);

  const allCues = [];
  for (const result of results) {
    if (result.text) {
      const cues = parseWebVTT(result.text);
      allCues.push(...cues);
    }
  }
  return allCues;
}

document.getElementById("refreshBtn").addEventListener("click", () => {
  currentPattern = null;
  currentMetadata = null;
  currentProvider = null;
  metaSection.style.display = "none";
  langRow.style.display = "none";
  parallelGroup.style.display = "";
  downloadBtn.disabled = true;
  progressSection.classList.remove("visible");
  progressFill.style.width = "0%";
  progressFill.classList.remove("active", "done");
  segmentCount.textContent = "";
  setStatus("Checking page...", "info");
  init();
});

init();
