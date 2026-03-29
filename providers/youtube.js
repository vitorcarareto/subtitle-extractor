export default {
  id: "youtube",
  name: "YouTube",
  domains: ["*.youtube.com", "youtube.com"],
  formats: ["txt", "srt", "vtt"],
  webRequestFilter: null, // YouTube uses page data, not network capture
  stub: false,

  parseRequest() {
    return null;
  },

  async fetchSubtitle(url) {
    try {
      const response = await fetch(url);
      if (!response.ok) return { error: response.status };
      const text = await response.text();
      return { text };
    } catch (err) {
      return { error: err.message };
    }
  },

  headerRules: [],
};
