# Subtitle Extractor

A Chrome extension that extracts subtitles from video platforms and saves them as text, SRT, or WebVTT files.

## Supported Platforms

| Platform | Status |
|----------|--------|
| Hotmart  | Supported |
| YouTube  | Supported |

## Features

- **Multi-format output** — Plain text (.txt), SubRip (.srt), WebVTT (.vtt)
- **Parallel downloading** — Configurable concurrency for fast segment fetching
- **Smart deduplication** — Handles overlapping HLS segments without duplicate lines
- **Encoding fix** — Automatically corrects UTF-8 mojibake in Portuguese subtitles
- **Filename prefix** — Optional prefix for batch downloads of video series
- **Section & video indexing** — Auto-detects video position in course structure (e.g. `5.1 Lesson Name.txt`)
- **Remembers save location** — File picker opens in the last used directory

## Installation

This is an unpacked Chrome extension for personal use.

1. Clone this repository
2. Install dependencies: `pnpm install`
3. Build the extension: `pnpm build`
4. Open Chrome and go to `chrome://extensions/`
5. Toggle **Developer mode** ON (top-right corner)
6. Click **Load unpacked** and select the `dist/` folder
7. Pin the extension icon for easy access

## Usage

1. Navigate to a supported video platform and play a video with subtitles enabled
2. Click the extension icon
3. Choose your output format (txt/srt/vtt)
4. Click **Download Subtitles** — the save dialog and download run in parallel
5. Pick your save location and the file writes automatically once both are ready

## Development

Build the extension:

```bash
pnpm build        # production build → dist/
pnpm dev          # watch mode (rebuild on save)
```

Run tests and type checking:

```bash
pnpm test         # run all 77 tests
pnpm test:watch   # watch mode
pnpm typecheck    # tsc --noEmit (strict)
```

### Architecture

The extension uses a **provider pattern** — each video platform is a self-contained module. Adding a new site means creating a new provider file. TypeScript source lives in `src/`, Vite builds to `dist/`.

```
                    ┌─────────────────────────────────────────────┐
                    │              Chrome Browser                  │
                    └─────────────────────────────────────────────┘
                         │              │              │
              ┌──────────┘              │              └──────────┐
              ▼                         ▼                         ▼
   ┌──────────────────┐    ┌──────────────────┐    ┌──────────────────┐
   │    popup.html     │    │   background.ts   │    │   content.ts     │
   │    popup.ts       │    │  (service worker) │    │ (injected into   │
   │                   │    │                   │    │  video pages)    │
   │  - Settings UI    │    │  - webRequest     │    │                  │
   │  - Format select  │    │    listener       │    │  - Metadata      │
   │  - Download flow  │    │  - Message router │    │    extraction    │
   │  - Progress bar   │    │  - Tab cleanup    │    │  - Overlay btn   │
   │  - File picker    │    │  - Download mgmt  │    │  - Direct d/l    │
   └────────┬─────────┘    └────────┬─────────┘    └────────┬─────────┘
            │                       │                        │
            │    chrome.runtime     │    chrome.runtime      │
            │◄─────.sendMessage────►│◄──────.sendMessage────►│
            │                       │                        │
            └───────────┬───────────┴────────────┬───────────┘
                        │                        │
                        ▼                        ▼
              ┌──────────────────┐    ┌──────────────────┐
              │     lib.ts       │    │   types.ts       │
              │  (pure logic)    │    │  (shared types)  │
              │                  │    │                  │
              │  - parseWebVTT   │    │  - Cue           │
              │  - deduplicateCues│   │  - Provider      │
              │  - fixEncoding   │    │  - ExtMessage    │
              │  - cuesToSrt/Vtt │    │  - VideoMetadata │
              │  - fetchParallel │    │  - CaptionTrack  │
              └──────────────────┘    └──────────────────┘
                        │
                        ▼
              ┌──────────────────┐
              │  providers/      │
              │                  │
              │  registry.ts     │──► domain → provider
              │  hotmart.ts      │──► HLS segment fetch + encoding fix
              │  youtube.ts      │──► direct VTT fetch
              └──────────────────┘
```

**Data flow — Hotmart download (popup):**

```
1. webRequest captures subtitle URL pattern → background stores it
2. Popup opens → asks background for pattern + content script for metadata
3. User clicks Download → popup calls lib.fetchAllSegmentsParallel()
4. Each segment: popup → background → hotmart.fetchSubtitle() → CORS-bypassed fetch
5. Segments parsed (parseWebVTT) → deduped → formatted (cuesToSrt/Vtt) → saved
```

**Data flow — overlay button download (content script):**

```
1. Content script detects video container → injects floating button
2. User clicks button → content script fetches segments directly via background
3. Segments parsed + formatted using lib.ts imports → saved via File System Access API
```

**Build:**

```
src/*.ts ──► vite build ──► dist/popup.html, background.js, lib.js (ES modules)
src/content.ts ──► vite build (IIFE lib mode) ──► dist/content.js (self-contained)
manifest.json + rules.json ──► copied to dist/
```

```
src/
  types.ts          — shared type definitions
  lib.ts            — pure logic: parsing, dedup, encoding, formats (77 tests)
  background.ts     — service worker, message routing, download management
  content.ts        — page metadata extraction, overlay button, direct download
  popup.html/ts     — extension popup UI
  providers/
    registry.ts     — maps domains to providers
    hotmart.ts      — Hotmart HLS subtitle extraction
    youtube.ts      — YouTube caption fetch
test/
  lib.test.ts       — unit tests for lib.ts
```

### Adding a New Provider

Create a file in `src/providers/` implementing the `Provider` interface:

```typescript
import type { Provider, ParsedSubtitleUrl, FetchResult } from '../types.js';

const mysite: Provider = {
  id: 'mysite',
  name: 'My Site',
  domains: ['*.mysite.com'],
  formats: ['txt', 'srt', 'vtt'],
  webRequestFilter: '...', // URL pattern to capture, or null
  parseRequest(url: string): ParsedSubtitleUrl | null { ... },
  async fetchSubtitle(url: string): Promise<FetchResult> { ... },
  headerRules: [],
};

export default mysite;
```

Register it in `src/providers/registry.ts` and add the domain to `manifest.json`.

## License

MIT
