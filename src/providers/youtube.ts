import type { Provider, ParsedSubtitleUrl, FetchResult } from '../types.js';

const youtube: Provider = {
  id: 'youtube',
  name: 'YouTube',
  domains: ['*.youtube.com', 'youtube.com'],
  formats: ['txt', 'srt', 'vtt'],
  webRequestFilter: null,

  parseRequest(_url: string): ParsedSubtitleUrl | null {
    return null;
  },

  async fetchSubtitle(url: string): Promise<FetchResult> {
    try {
      const response = await fetch(url);
      if (!response.ok) return { error: response.status };
      const text = await response.text();
      return { text };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },

  headerRules: [],
};

export default youtube;
