import { parseSubtitleUrl, fixEncoding } from '../lib.js';

export default {
  id: 'hotmart',
  name: 'Hotmart',
  domains: ['*.hotmart.com'],
  formats: ['txt', 'srt', 'vtt'],

  webRequestFilter: '*://vod-akm.play.hotmart.com/video/*/hls/*-textstream_*.webvtt*',

  parseRequest(url) {
    return parseSubtitleUrl(url);
  },

  async fetchSubtitle(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) return { error: response.status };
      const buffer = await response.arrayBuffer();
      let text = new TextDecoder('utf-8').decode(buffer);
      text = fixEncoding(text);
      return { text };
    } catch (err) {
      return { error: err.message };
    }
  },

  headerRules: [
    {
      id: 1,
      priority: 1,
      action: {
        type: 'modifyHeaders',
        requestHeaders: [
          { header: 'Origin', operation: 'set', value: 'https://cf-embed.play.hotmart.com' },
          { header: 'Referer', operation: 'set', value: 'https://cf-embed.play.hotmart.com/' },
        ],
      },
      condition: {
        urlFilter: '||vod-akm.play.hotmart.com',
        resourceTypes: ['xmlhttprequest'],
      },
    },
  ],
};
