# Subtitle Extractor

[![CI](https://github.com/vitorcarareto/subtitle-extractor/actions/workflows/ci.yml/badge.svg?branch=main)](https://github.com/vitorcarareto/subtitle-extractor/actions/workflows/ci.yml)
[![codecov](https://codecov.io/gh/vitorcarareto/subtitle-extractor/graph/badge.svg)](https://codecov.io/gh/vitorcarareto/subtitle-extractor)

A Chrome extension that extracts subtitles from video platforms and saves them as text, SRT, or WebVTT files.

Particularly useful for extracting video transcripts to use as context for LLMs and AI agents — turn any lecture, tutorial, or course into structured text you can feed into your AI workflow.

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

### Quick install (no build needed)

1. Download the latest `subtitle-extractor-vX.X.X.zip` from [Releases](https://github.com/vitorcarareto/subtitle-extractor/releases)
2. Unzip it to a folder
3. Open Chrome and go to `chrome://extensions/`
4. Toggle **Developer mode** ON (top-right corner)
5. Click **Load unpacked** and select the unzipped folder
6. Pin the extension icon for easy access

### From source

1. Clone this repository
2. Install dependencies: `pnpm install`
3. Build the extension: `pnpm build`
4. Follow steps 3–6 above, selecting the `dist/` folder

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
