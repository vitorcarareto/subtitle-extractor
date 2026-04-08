import { parseSubtitleUrl, fixEncoding } from '../lib.js';
import type { Provider, ParsedSubtitleUrl, FetchResult } from '../types.js';

const hotmart: Provider = {
  id: 'hotmart',
  name: 'Hotmart',
  domains: ['*.hotmart.com'],
  formats: ['txt', 'srt', 'vtt'],

  webRequestFilter: '*://*.hotmart.com/video/*/hls/*-textstream_*.webvtt*',

  parseRequest(url: string): ParsedSubtitleUrl | null {
    return parseSubtitleUrl(url);
  },

  async fetchSubtitle(url: string): Promise<FetchResult> {
    try {
      const response = await fetch(url);
      if (!response.ok) return { error: response.status };
      const buffer = await response.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buffer);
      text = fixEncoding(text);
      return { text };
    } catch (err) {
      return { error: (err as Error).message };
    }
  },

  headerRules: [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders' as chrome.declarativeNetRequest.RuleActionType,
        requestHeaders: [
          { header: 'Origin', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'https://cf-embed.play.hotmart.com' },
          { header: 'Referer', operation: 'set' as chrome.declarativeNetRequest.HeaderOperation, value: 'https://cf-embed.play.hotmart.com/' },
        ],
      },
      condition: {
        requestDomains: ['vod-akm.play.hotmart.com', 'contentplayer.hotmart.com'],
        resourceTypes: ['xmlhttprequest' as chrome.declarativeNetRequest.ResourceType],
      },
    },
  ],
};

export default hotmart;
