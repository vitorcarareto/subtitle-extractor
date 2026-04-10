import { describe, it, expect } from 'vitest';
import {
  parseSubtitleUrl,
  fixEncoding,
  parseWebVTT,
  parseYouTubeJson3,
  parseSubtitleText,
  extractLangFromUrl,
  sortTracksManualFirst,
  parseTimestamp,
  deduplicateCues,
  cuesToTranscript,
  cuesToSrt,
  cuesToVtt,
  formatTimestampSrt,
  formatTimestampVtt,
  buildSegmentUrl,
  processSegmentResults,
  fetchAllSegmentsParallel,
} from '../src/lib.js';
import type { FetchResult } from '../src/types.js';

// ---------------------------------------------------------------------------
// URL pattern parsing
// ---------------------------------------------------------------------------
describe('parseSubtitleUrl', () => {
  const SAMPLE_URL =
    'https://vod-akm.play.hotmart.com/video/WZEpQvQvLv/hls/WZEpQvQvLv-1740073517000-textstream_pt_br=1000-101.webvtt?hdntl=exp=1774837448~acl=/*~data=hdntl~hmac=ed2a4ae0&app=093b9050';

  it('extracts mediaCode', () => {
    expect(parseSubtitleUrl(SAMPLE_URL)!.mediaCode).toBe('WZEpQvQvLv');
  });

  it('extracts timestamp', () => {
    expect(parseSubtitleUrl(SAMPLE_URL)!.timestamp).toBe('1740073517000');
  });

  it('extracts language', () => {
    expect(parseSubtitleUrl(SAMPLE_URL)!.lang).toBe('pt_br');
  });

  it('extracts segment number', () => {
    expect(parseSubtitleUrl(SAMPLE_URL)!.segmentNum).toBe('101');
  });

  it('builds base URL with {SEG} placeholder', () => {
    const result = parseSubtitleUrl(SAMPLE_URL)!;
    expect(result.baseUrl).toContain('{SEG}');
    expect(result.baseUrl).not.toContain('-101.webvtt');
  });

  it('extracts query string', () => {
    const result = parseSubtitleUrl(SAMPLE_URL)!;
    expect(result.queryString).toContain('hdntl=');
    expect(result.queryString).toContain('app=');
  });

  it('returns null for a completely unrelated URL', () => {
    expect(parseSubtitleUrl('https://example.com/video.mp4')).toBeNull();
  });

  it('returns null for a Hotmart video URL without textstream', () => {
    expect(
      parseSubtitleUrl(
        'https://vod-akm.play.hotmart.com/video/ABC/hls/ABC-123-video=5000-1.ts?tok=xyz'
      )
    ).toBeNull();
  });

  it('returns null for missing segment number', () => {
    expect(
      parseSubtitleUrl(
        'https://vod-akm.play.hotmart.com/video/X/hls/X-1-textstream_en=1000-.webvtt?q=1'
      )
    ).toBeNull();
  });

  it('handles segment number 0', () => {
    const url =
      'https://vod-akm.play.hotmart.com/video/ABC/hls/ABC-999-textstream_en=1000-0.webvtt?tok=x';
    expect(parseSubtitleUrl(url)!.segmentNum).toBe('0');
  });

  it('handles language codes with underscores', () => {
    const url =
      'https://vod-akm.play.hotmart.com/video/X/hls/X-1-textstream_zh_hans=1000-5.webvtt?q=1';
    expect(parseSubtitleUrl(url)!.lang).toBe('zh_hans');
  });

  it('parses contentplayer.hotmart.com URLs', () => {
    const url =
      'https://contentplayer.hotmart.com/video/DZmJO1nyRz/hls/DZmJO1nyRz-1775573079000-textstream_pt_br=1000-467.webvtt?Policy=eyJ&app=f518eb50';
    const result = parseSubtitleUrl(url)!;
    expect(result).not.toBeNull();
    expect(result.mediaCode).toBe('DZmJO1nyRz');
    expect(result.lang).toBe('pt_br');
    expect(result.segmentNum).toBe('467');
    expect(result.timestamp).toBe('1775573079000');
  });
});

// ---------------------------------------------------------------------------
// Encoding fix
// ---------------------------------------------------------------------------
describe('fixEncoding', () => {
  it('fixes construÃ§Ã£o → construção', () => {
    expect(fixEncoding('construÃ\u00A7Ã£o')).toBe('construção');
  });

  it('fixes Ã© → é', () => {
    expect(fixEncoding('Ã©')).toBe('é');
  });

  it('fixes cafÃ© → café', () => {
    expect(fixEncoding('cafÃ©')).toBe('café');
  });

  it('passes through already-correct UTF-8 text unchanged', () => {
    expect(fixEncoding('construção')).toBe('construção');
  });

  it('passes through plain ASCII text unchanged', () => {
    expect(fixEncoding('hello world')).toBe('hello world');
  });

  it('passes through empty string', () => {
    expect(fixEncoding('')).toBe('');
  });

  it('passes through text with no mojibake markers', () => {
    const text = 'This is a normal sentence with numbers 123 and symbols @#$.';
    expect(fixEncoding(text)).toBe(text);
  });
});

// ---------------------------------------------------------------------------
// WebVTT parsing
// ---------------------------------------------------------------------------
describe('parseWebVTT', () => {
  it('parses a simple VTT segment with one cue', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
Hello world`;
    const cues = parseWebVTT(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0]).toEqual({
      startMs: 1000,
      endMs: 4000,
      text: 'Hello world',
    });
  });

  it('parses multiple cues', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
First line

00:00:05.000 --> 00:00:08.000
Second line`;
    const cues = parseWebVTT(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe('First line');
    expect(cues[1].text).toBe('Second line');
  });

  it('handles multi-line cues', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
First line
Second line
Third line`;
    const cues = parseWebVTT(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('First line Second line Third line');
  });

  it('skips WEBVTT header and X-TIMESTAMP-MAP', () => {
    const vtt = `WEBVTT
X-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:900000

00:00:01.000 --> 00:00:04.000
Hello`;
    const cues = parseWebVTT(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Hello');
  });

  it('skips numeric cue IDs', () => {
    const vtt = `WEBVTT

1
00:00:01.000 --> 00:00:04.000
First

2
00:00:05.000 --> 00:00:08.000
Second`;
    const cues = parseWebVTT(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0].text).toBe('First');
    expect(cues[1].text).toBe('Second');
  });

  it('strips HTML tags from cue text', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000
<b>Bold</b> and <i>italic</i>`;
    const cues = parseWebVTT(vtt);
    expect(cues[0].text).toBe('Bold and italic');
  });

  it('skips empty cues (timestamp with no text)', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:04.000

00:00:05.000 --> 00:00:08.000
Has text`;
    const cues = parseWebVTT(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Has text');
  });

  it('handles empty input', () => {
    expect(parseWebVTT('')).toEqual([]);
  });

  it('handles VTT with only headers, no cues', () => {
    expect(parseWebVTT('WEBVTT\nX-TIMESTAMP-MAP=LOCAL:00:00:00.000,MPEGTS:0\n')).toEqual([]);
  });

  it('parses timestamps with hours correctly', () => {
    const vtt = `WEBVTT

01:30:00.500 --> 01:30:05.000
Late in the video`;
    const cues = parseWebVTT(vtt);
    expect(cues[0].startMs).toBe(5400500);
    expect(cues[0].endMs).toBe(5405000);
  });

  it('parses MM:SS.mmm timestamps (no hours)', () => {
    const vtt = `WEBVTT

00:05.000 --> 00:10.000
Short format`;
    const cues = parseWebVTT(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].startMs).toBe(5000);
    expect(cues[0].endMs).toBe(10000);
    expect(cues[0].text).toBe('Short format');
  });

  it('parses single-digit hour timestamps', () => {
    const vtt = `WEBVTT

0:00:05.000 --> 0:00:10.000
Single digit hour`;
    const cues = parseWebVTT(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].startMs).toBe(5000);
    expect(cues[0].endMs).toBe(10000);
  });

  it('parses mixed timestamp formats in same file', () => {
    const vtt = `WEBVTT

00:05.000 --> 00:10.000
Short format

00:00:15.000 --> 00:00:20.000
Long format`;
    const cues = parseWebVTT(vtt);
    expect(cues).toHaveLength(2);
    expect(cues[0].startMs).toBe(5000);
    expect(cues[1].startMs).toBe(15000);
  });
});

// ---------------------------------------------------------------------------
// parseTimestamp
// ---------------------------------------------------------------------------
describe('parseTimestamp', () => {
  it('parses 00:00:00.000 as 0', () => {
    expect(parseTimestamp('00:00:00.000')).toBe(0);
  });

  it('parses seconds and milliseconds', () => {
    expect(parseTimestamp('00:00:05.500')).toBe(5500);
  });

  it('parses minutes', () => {
    expect(parseTimestamp('00:02:00.000')).toBe(120000);
  });

  it('parses hours', () => {
    expect(parseTimestamp('01:00:00.000')).toBe(3600000);
  });

  it('parses a complex timestamp', () => {
    expect(parseTimestamp('02:15:30.750')).toBe(
      2 * 3600000 + 15 * 60000 + 30 * 1000 + 750
    );
  });

  it('parses MM:SS.mmm format (no hours)', () => {
    expect(parseTimestamp('00:05.000')).toBe(5000);
  });

  it('parses MM:SS.mmm with minutes', () => {
    expect(parseTimestamp('02:30.500')).toBe(150500);
  });

  it('parses single-digit hour H:MM:SS.mmm', () => {
    expect(parseTimestamp('1:00:00.000')).toBe(3600000);
  });

  it('parses multi-digit hours HHH:MM:SS.mmm', () => {
    expect(parseTimestamp('100:00:00.000')).toBe(360000000);
  });
});

// ---------------------------------------------------------------------------
// Deduplication
// ---------------------------------------------------------------------------
describe('deduplicateCues', () => {
  it('removes exact duplicates', () => {
    const cues = [
      { startMs: 1000, endMs: 2000, text: 'Hello' },
      { startMs: 1000, endMs: 2000, text: 'Hello' },
      { startMs: 3000, endMs: 4000, text: 'World' },
    ];
    expect(deduplicateCues(cues)).toHaveLength(2);
  });

  it('removes consecutive cues with same text but different timestamps (segment overlap)', () => {
    // This is the real-world case: overlapping HLS segments produce the same cue
    // text with slightly different timestamps
    const cues = [
      { startMs: 1000, endMs: 2000, text: 'Hello' },
      { startMs: 1050, endMs: 2050, text: 'Hello' },
      { startMs: 3000, endMs: 4000, text: 'World' },
    ];
    expect(deduplicateCues(cues)).toHaveLength(2);
  });

  it('keeps non-consecutive cues with same text (legitimate repetition)', () => {
    const cues = [
      { startMs: 1000, endMs: 2000, text: 'Hello' },
      { startMs: 3000, endMs: 4000, text: 'World' },
      { startMs: 5000, endMs: 6000, text: 'Hello' },
    ];
    expect(deduplicateCues(cues)).toHaveLength(3);
  });

  it('keeps cues with same timestamps but different text', () => {
    const cues = [
      { startMs: 1000, endMs: 2000, text: 'Hello' },
      { startMs: 1000, endMs: 2000, text: 'World' },
    ];
    expect(deduplicateCues(cues)).toHaveLength(2);
  });

  it('returns cues sorted by startMs', () => {
    const cues = [
      { startMs: 3000, endMs: 4000, text: 'B' },
      { startMs: 1000, endMs: 2000, text: 'A' },
      { startMs: 3000, endMs: 4000, text: 'B' },
    ];
    const result = deduplicateCues(cues);
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('A');
    expect(result[1].text).toBe('B');
  });

  it('handles empty array', () => {
    expect(deduplicateCues([])).toEqual([]);
  });

  it('collapses non-adjacent duplicate cues after sorting by startMs', () => {
    // BUG SCENARIO: Two segments deliver cues out of order.
    // Cue "B" appears at two different positions in the array, separated by "A".
    // Without sorting before the consecutive-text pass, the two "B" cues
    // are not adjacent and won't be collapsed.
    const cues = [
      { startMs: 5000, endMs: 6000, text: 'B' },
      { startMs: 1000, endMs: 2000, text: 'A' },
      { startMs: 5050, endMs: 6050, text: 'B' },  // overlap duplicate of first "B"
    ];
    const result = deduplicateCues(cues);
    // After sorting by startMs: A(1000), B(5000), B(5050)
    // Consecutive-text pass should collapse the two B's into one.
    expect(result).toHaveLength(2);
    expect(result[0].text).toBe('A');
    expect(result[1].text).toBe('B');
  });
});

// ---------------------------------------------------------------------------
// Plain text output
// ---------------------------------------------------------------------------
describe('cuesToTranscript', () => {
  it('produces sorted, deduplicated plain text', () => {
    const cues = [
      { startMs: 5000, endMs: 6000, text: 'Second' },
      { startMs: 1000, endMs: 2000, text: 'First' },
      { startMs: 5000, endMs: 6000, text: 'Second' }, // exact duplicate
      { startMs: 9000, endMs: 10000, text: 'Third' },
    ];
    expect(cuesToTranscript(cues)).toBe('First\nSecond\nThird');
  });

  it('removes consecutive duplicates from overlapping segments', () => {
    // Simulates two overlapping HLS segments with shared cues at boundary
    const cues = [
      { startMs: 1000, endMs: 3000, text: 'Line one' },
      { startMs: 3000, endMs: 5000, text: 'Line two' },
      { startMs: 3050, endMs: 5050, text: 'Line two' },  // overlap duplicate
      { startMs: 5000, endMs: 7000, text: 'Line three' },
      { startMs: 5000, endMs: 7000, text: 'Line three' }, // exact duplicate
      { startMs: 5050, endMs: 7050, text: 'Line three' }, // overlap duplicate
      { startMs: 7000, endMs: 9000, text: 'Line four' },
    ];
    expect(cuesToTranscript(cues)).toBe('Line one\nLine two\nLine three\nLine four');
  });

  it('returns empty string for no cues', () => {
    expect(cuesToTranscript([])).toBe('');
  });

  it('handles a single cue', () => {
    expect(cuesToTranscript([{ startMs: 0, endMs: 1000, text: 'Only line' }])).toBe(
      'Only line'
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: real-world HLS segment overlap producing duplicate transcript lines
// ---------------------------------------------------------------------------
describe('regression: HLS segment overlap deduplication', () => {
  it('produces clean transcript from overlapping segments with near-identical timestamps', () => {
    // Simulates the real bug: two consecutive HLS segments both contain the same
    // subtitle cue with slightly offset timestamps, producing duplicate lines
    const seg1 = 'WEBVTT\n\n' +
      '00:05:01.000 --> 00:05:04.000\n' +
      'uma construção de residência, que é o que eu queria deixar claro para você de\n\n' +
      '00:05:04.000 --> 00:05:07.000\n' +
      'estrutura de cronograma.';
    const seg2 = 'WEBVTT\n\n' +
      '00:05:04.000 --> 00:05:07.000\n' +
      'estrutura de cronograma.\n\n' +
      '00:05:07.000 --> 00:05:10.000\n' +
      'Uma obra, pelo menos no meu método,';

    const cues1 = parseWebVTT(seg1);
    const cues2 = parseWebVTT(seg2);
    const allCues = [...cues1, ...cues2];

    const transcript = cuesToTranscript(allCues);
    const lines = transcript.split('\n');

    // "estrutura de cronograma." must appear only once
    const occurrences = lines.filter(l => l === 'estrutura de cronograma.').length;
    expect(occurrences).toBe(1);
    expect(lines).toHaveLength(3);
  });

  it('produces clean transcript when same cue appears in 3 consecutive segments', () => {
    const cues = [
      { startMs: 1000, endMs: 3000, text: 'Nós temos um momento pré -obra e daqui' },
      { startMs: 1050, endMs: 3050, text: 'Nós temos um momento pré -obra e daqui' },
      { startMs: 1100, endMs: 3100, text: 'Nós temos um momento pré -obra e daqui' },
      { startMs: 3000, endMs: 5000, text: 'para frente vai ser a nossa construção.' },
    ];
    expect(cuesToTranscript(cues)).toBe(
      'Nós temos um momento pré -obra e daqui\npara frente vai ser a nossa construção.'
    );
  });
});

// ---------------------------------------------------------------------------
// Regression: encoding mojibake in Portuguese subtitles
// ---------------------------------------------------------------------------
describe('regression: Portuguese subtitle encoding', () => {
  it('fixes common Portuguese mojibake patterns in VTT content', () => {
    // These are real patterns seen in Hotmart Portuguese subtitles
    const vtt = 'WEBVTT\n\n' +
      '00:00:01.000 --> 00:00:04.000\n' +
      'construÃ§Ã£o de residÃªncia';
    const fixed = fixEncoding(vtt);
    expect(fixed).toContain('construção');
    expect(fixed).toContain('residência');
  });
});

// ---------------------------------------------------------------------------
// SRT timestamp formatting
// ---------------------------------------------------------------------------
describe('formatTimestampSrt', () => {
  it('formats 0ms as 00:00:00,000', () => {
    expect(formatTimestampSrt(0)).toBe('00:00:00,000');
  });

  it('formats milliseconds correctly', () => {
    expect(formatTimestampSrt(5500)).toBe('00:00:05,500');
  });

  it('formats hours, minutes, seconds, ms', () => {
    expect(formatTimestampSrt(3723750)).toBe('01:02:03,750');
  });
});

// ---------------------------------------------------------------------------
// VTT timestamp formatting
// ---------------------------------------------------------------------------
describe('formatTimestampVtt', () => {
  it('formats 0ms as 00:00:00.000', () => {
    expect(formatTimestampVtt(0)).toBe('00:00:00.000');
  });

  it('uses dot separator (not comma)', () => {
    expect(formatTimestampVtt(5500)).toBe('00:00:05.500');
  });

  it('formats hours, minutes, seconds, ms', () => {
    expect(formatTimestampVtt(3723750)).toBe('01:02:03.750');
  });
});

// ---------------------------------------------------------------------------
// SRT output
// ---------------------------------------------------------------------------
describe('cuesToSrt', () => {
  it('produces numbered SRT cues with comma timestamps', () => {
    const cues = [
      { startMs: 1000, endMs: 4000, text: 'Hello world' },
      { startMs: 5000, endMs: 8000, text: 'Second line' },
    ];
    const srt = cuesToSrt(cues);
    expect(srt).toBe(
      '1\n00:00:01,000 --> 00:00:04,000\nHello world\n\n' +
      '2\n00:00:05,000 --> 00:00:08,000\nSecond line\n'
    );
  });

  it('deduplicates and sorts cues', () => {
    const cues = [
      { startMs: 5000, endMs: 8000, text: 'Second' },
      { startMs: 1000, endMs: 4000, text: 'First' },
      { startMs: 5000, endMs: 8000, text: 'Second' },
    ];
    const srt = cuesToSrt(cues);
    expect(srt).toContain('1\n00:00:01,000');
    expect(srt).toContain('2\n00:00:05,000');
    expect(srt.match(/^2\n/gm)).toHaveLength(1); // only two cues
  });

  it('returns empty string for no cues', () => {
    expect(cuesToSrt([])).toBe('');
  });
});

// ---------------------------------------------------------------------------
// VTT output
// ---------------------------------------------------------------------------
describe('cuesToVtt', () => {
  it('produces WEBVTT header with dot timestamps', () => {
    const cues = [
      { startMs: 1000, endMs: 4000, text: 'Hello world' },
    ];
    const vtt = cuesToVtt(cues);
    expect(vtt).toBe(
      'WEBVTT\n\n' +
      '00:00:01.000 --> 00:00:04.000\nHello world\n'
    );
  });

  it('deduplicates and sorts cues', () => {
    const cues = [
      { startMs: 5000, endMs: 8000, text: 'Second' },
      { startMs: 1000, endMs: 4000, text: 'First' },
      { startMs: 1000, endMs: 4000, text: 'First' },
    ];
    const vtt = cuesToVtt(cues);
    expect(vtt.match(/-->/g)).toHaveLength(2);
  });

  it('returns WEBVTT header for no cues', () => {
    expect(cuesToVtt([])).toBe('WEBVTT\n');
  });
});

// ---------------------------------------------------------------------------
// buildSegmentUrl
// ---------------------------------------------------------------------------
describe('buildSegmentUrl', () => {
  it('replaces {SEG} with the segment number', () => {
    const base = 'https://example.com/video-{SEG}.webvtt?tok=abc';
    expect(buildSegmentUrl(base, 42)).toBe('https://example.com/video-42.webvtt?tok=abc');
  });

  it('works with segment 0', () => {
    const base = 'https://example.com/{SEG}.webvtt';
    expect(buildSegmentUrl(base, 0)).toBe('https://example.com/0.webvtt');
  });
});

// ---------------------------------------------------------------------------
// Segment fetching stop condition
// ---------------------------------------------------------------------------
describe('processSegmentResults', () => {
  it('collects cues from successful segments', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello';
    const results = [{ text: vtt }, { text: vtt }];
    const cues = processSegmentResults(results);
    expect(cues).toHaveLength(2);
  });

  it('stops after 3 consecutive errors', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello';
    const results = [
      { text: vtt },       // seg 0 - ok
      { text: vtt },       // seg 1 - ok
      { error: 404 },      // seg 2 - err 1
      { error: 403 },      // seg 3 - err 2
      { error: 404 },      // seg 4 - err 3 → stop
      { text: vtt },       // seg 5 - never reached
    ];
    const cues = processSegmentResults(results);
    expect(cues).toHaveLength(2); // only from seg 0 and 1
  });

  it('resets error count on success', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello';
    const results = [
      { text: vtt },       // ok
      { error: 404 },      // err 1
      { error: 404 },      // err 2
      { text: vtt },       // ok - resets
      { error: 404 },      // err 1
      { error: 404 },      // err 2
      { text: vtt },       // ok - resets
    ];
    const cues = processSegmentResults(results);
    expect(cues).toHaveLength(3);
  });

  it('does not count segment 0 errors', () => {
    const vtt = 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHello';
    const results = [
      { error: 400 },      // seg 0 - error but not counted
      { text: vtt },       // seg 1 - ok
      { text: vtt },       // seg 2 - ok
    ];
    const cues = processSegmentResults(results);
    expect(cues).toHaveLength(2);
  });

  it('stops immediately if first 4 segments all error (seg 0 excluded)', () => {
    const results = [
      { error: 400 },      // seg 0 - not counted
      { error: 404 },      // seg 1 - err 1
      { error: 404 },      // seg 2 - err 2
      { error: 404 },      // seg 3 - err 3 → stop
      { error: 404 },      // seg 4 - never reached
    ];
    const cues = processSegmentResults(results);
    expect(cues).toHaveLength(0);
  });

  it('handles empty results', () => {
    expect(processSegmentResults([])).toEqual([]);
  });

  it('respects custom maxConsecutiveErrors', () => {
    const results = [
      { error: 404 },  // seg 0 - not counted
      { error: 404 },  // err 1 → stop with max=1
      { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi' },
    ];
    const cues = processSegmentResults(results, 1);
    expect(cues).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Parallel segment fetching
// ---------------------------------------------------------------------------
describe('fetchAllSegmentsParallel', () => {
  it('fetches segments and returns results in order', async () => {
    const responses = [
      { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nSeg0' },
      { text: 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nSeg1' },
      { text: 'WEBVTT\n\n00:00:05.000 --> 00:00:06.000\nSeg2' },
      { error: 404 },
      { error: 404 },
      { error: 404 },
    ];
    const fetchFn = (seg: number) => Promise.resolve(responses[seg] || { error: 404 });
    const results = await fetchAllSegmentsParallel({ concurrency: 2, fetchFn });
    // Should have results for segments 0-5 (stops after 3 consecutive errors at tail)
    expect(results.filter(r => r.text)).toHaveLength(3);
    expect(results[0].seg).toBe(0);
    expect(results[1].seg).toBe(1);
    expect(results[2].seg).toBe(2);
  });

  it('respects concurrency limit', async () => {
    let maxInFlight = 0;
    let inFlight = 0;
    const fetchFn = (seg: number): Promise<FetchResult> => {
      inFlight++;
      maxInFlight = Math.max(maxInFlight, inFlight);
      return new Promise((resolve) => {
        setTimeout(() => {
          inFlight--;
          resolve(seg < 5 ? { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi' } : { error: 404 });
        }, 10);
      });
    };
    // 5 success + 3 errors to stop = 8 fetches, concurrency 3
    await fetchAllSegmentsParallel({ concurrency: 3, fetchFn });
    expect(maxInFlight).toBeLessThanOrEqual(3);
  });

  it('stops after 3 consecutive errors at the tail', async () => {
    const fetched: number[] = [];
    const fetchFn = (seg: number): Promise<FetchResult> => {
      fetched.push(seg);
      if (seg < 10) return Promise.resolve({ text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi' });
      return Promise.resolve({ error: 404 });
    };
    await fetchAllSegmentsParallel({ concurrency: 2, fetchFn });
    // Should fetch 10 successes + 3 errors = 13 segments, then stop
    const maxSeg = Math.max(...fetched);
    expect(maxSeg).toBeLessThanOrEqual(15); // some may be in-flight when stop triggers
  });

  it('does not count segment 0 errors toward consecutive errors', async () => {
    const responses = [
      { error: 400 },  // seg 0 — not counted
      { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi' }, // seg 1
      { error: 404 },  // seg 2
      { error: 404 },  // seg 3
      { error: 404 },  // seg 4 — 3 consecutive → stop
    ];
    const fetchFn = (seg: number) => Promise.resolve(responses[seg] || { error: 404 });
    const results = await fetchAllSegmentsParallel({ concurrency: 1, fetchFn });
    expect(results.filter(r => r.text)).toHaveLength(1);
  });

  it('calls onProgress for each completed segment', async () => {
    const progressCalls: Array<{ seg: number; total: number }> = [];
    const fetchFn = (seg: number) => Promise.resolve(
      seg < 3 ? { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi' } : { error: 404 }
    );
    await fetchAllSegmentsParallel({
      concurrency: 1,
      fetchFn,
      onProgress: (seg, total) => progressCalls.push({ seg, total }),
    });
    expect(progressCalls.length).toBeGreaterThanOrEqual(3);
    // Each call should have increasing total
    for (let i = 1; i < progressCalls.length; i++) {
      expect(progressCalls[i].total).toBeGreaterThanOrEqual(progressCalls[i - 1].total);
    }
  });

  it('clamps concurrency to minimum of 1', async () => {
    const fetchFn = (seg: number) => Promise.resolve(
      seg < 2 ? { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi' } : { error: 404 }
    );
    // Should not hang or error with concurrency 0
    const results = await fetchAllSegmentsParallel({ concurrency: 0, fetchFn });
    expect(results.filter(r => r.text)).toHaveLength(2);
  });

  it('handles all-error case and stops quickly', async () => {
    const fetched: number[] = [];
    const fetchFn = (seg: number) => {
      fetched.push(seg);
      return Promise.resolve({ error: 404 });
    };
    const results = await fetchAllSegmentsParallel({ concurrency: 5, fetchFn });
    // seg 0 not counted, then 3 consecutive → stops around seg 4
    // With concurrency 5, some extra may be in-flight
    expect(fetched.length).toBeLessThanOrEqual(10);
    expect(results.filter(r => r.text)).toHaveLength(0);
  });

  it('resets consecutive error count on success', async () => {
    const responses = [
      { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nA' }, // seg 0
      { error: 404 },  // seg 1
      { error: 404 },  // seg 2
      { text: 'WEBVTT\n\n00:00:03.000 --> 00:00:04.000\nB' }, // seg 3 — resets
      { error: 404 },  // seg 4
      { error: 404 },  // seg 5
      { error: 404 },  // seg 6 — 3 consecutive → stop
    ];
    const fetchFn = (seg: number) => Promise.resolve(responses[seg] || { error: 404 });
    const results = await fetchAllSegmentsParallel({ concurrency: 1, fetchFn });
    expect(results.filter(r => r.text)).toHaveLength(2);
  });

  it('respects custom maxConsecutiveErrors', async () => {
    const fetchFn = (seg: number) => Promise.resolve(
      seg === 0 ? { text: 'WEBVTT\n\n00:00:01.000 --> 00:00:02.000\nHi' } : { error: 404 }
    );
    const results = await fetchAllSegmentsParallel({
      concurrency: 1,
      fetchFn,
      maxConsecutiveErrors: 1,
    });
    // seg 0 ok, seg 1 error → 1 consecutive → stop
    expect(results.filter(r => r.text)).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// YouTube json3/pb3 parsing
// ---------------------------------------------------------------------------
describe('parseYouTubeJson3', () => {
  it('parses events with segs into cues', () => {
    const json = JSON.stringify({
      wireMagic: 'pb3',
      events: [
        { tStartMs: 320, dDurationMs: 4959, segs: [{ utf8: 'Hello world' }] },
        { tStartMs: 5280, dDurationMs: 3000, segs: [{ utf8: 'Second line' }] },
      ],
    });
    const cues = parseYouTubeJson3(json);
    expect(cues).toHaveLength(2);
    expect(cues[0]).toEqual({ startMs: 320, endMs: 5279, text: 'Hello world' });
    expect(cues[1]).toEqual({ startMs: 5280, endMs: 8280, text: 'Second line' });
  });

  it('skips events without segs (window/style setup)', () => {
    const json = JSON.stringify({
      wireMagic: 'pb3',
      events: [
        { tStartMs: 0, dDurationMs: 3537839, id: 1, wpWinPosId: 1, wsWinStyleId: 1 },
        { tStartMs: 320, dDurationMs: 4959, segs: [{ utf8: 'Hello' }] },
      ],
    });
    const cues = parseYouTubeJson3(json);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Hello');
  });

  it('concatenates multiple segs in a single event', () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 100, dDurationMs: 2000, segs: [
          { utf8: 'Hello ' },
          { utf8: 'world' },
        ]},
      ],
    });
    const cues = parseYouTubeJson3(json);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Hello world');
  });

  it('replaces newlines with spaces in seg text', () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 100, dDurationMs: 2000, segs: [{ utf8: 'Line one\nLine two' }] },
      ],
    });
    const cues = parseYouTubeJson3(json);
    expect(cues[0].text).toBe('Line one Line two');
  });

  it('skips events with empty text after joining segs', () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 100, dDurationMs: 2000, segs: [{ utf8: '\n' }] },
        { tStartMs: 200, dDurationMs: 2000, segs: [{ utf8: '' }] },
        { tStartMs: 300, dDurationMs: 2000, segs: [{ utf8: 'Real text' }] },
      ],
    });
    const cues = parseYouTubeJson3(json);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Real text');
  });

  it('skips events missing tStartMs or dDurationMs', () => {
    const json = JSON.stringify({
      events: [
        { dDurationMs: 2000, segs: [{ utf8: 'No start' }] },
        { tStartMs: 100, segs: [{ utf8: 'No duration' }] },
        { tStartMs: 200, dDurationMs: 2000, segs: [{ utf8: 'Valid' }] },
      ],
    });
    const cues = parseYouTubeJson3(json);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Valid');
  });

  it('handles tStartMs of 0', () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 0, dDurationMs: 1000, segs: [{ utf8: 'Start' }] },
      ],
    });
    const cues = parseYouTubeJson3(json);
    expect(cues).toHaveLength(1);
    expect(cues[0].startMs).toBe(0);
  });

  it('handles empty events array', () => {
    const json = JSON.stringify({ wireMagic: 'pb3', events: [] });
    expect(parseYouTubeJson3(json)).toEqual([]);
  });

  it('handles missing events key', () => {
    const json = JSON.stringify({ wireMagic: 'pb3' });
    expect(parseYouTubeJson3(json)).toEqual([]);
  });

  it('handles segs with missing utf8 field', () => {
    const json = JSON.stringify({
      events: [
        { tStartMs: 100, dDurationMs: 2000, segs: [{}] },
        { tStartMs: 200, dDurationMs: 2000, segs: [{ utf8: 'Valid' }] },
      ],
    });
    const cues = parseYouTubeJson3(json);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Valid');
  });

  it('returns empty array for malformed JSON', () => {
    expect(parseYouTubeJson3('not json at all')).toEqual([]);
  });

  it('returns empty array for truncated JSON', () => {
    expect(parseYouTubeJson3('{"events":[{"tStartMs":0')).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// parseSubtitleText (format auto-detection)
// ---------------------------------------------------------------------------
describe('parseSubtitleText', () => {
  it('parses json3 when text starts with {', () => {
    const json = JSON.stringify({
      events: [{ tStartMs: 100, dDurationMs: 2000, segs: [{ utf8: 'Hello' }] }],
    });
    const cues = parseSubtitleText(json);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Hello');
  });

  it('parses json3 when text has leading whitespace before {', () => {
    const json = '  \n' + JSON.stringify({
      events: [{ tStartMs: 100, dDurationMs: 2000, segs: [{ utf8: 'Hello' }] }],
    });
    const cues = parseSubtitleText(json);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Hello');
  });

  it('parses VTT when text starts with WEBVTT', () => {
    const vtt = `WEBVTT

00:00:01.000 --> 00:00:02.000
Hello`;
    const cues = parseSubtitleText(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].text).toBe('Hello');
  });

  it('parses VTT for non-JSON text', () => {
    const vtt = `WEBVTT

00:05.000 --> 00:10.000
Short format`;
    const cues = parseSubtitleText(vtt);
    expect(cues).toHaveLength(1);
    expect(cues[0].startMs).toBe(5000);
  });
});

// ---------------------------------------------------------------------------
// extractLangFromUrl
// ---------------------------------------------------------------------------
describe('extractLangFromUrl', () => {
  it('extracts lang parameter from URL', () => {
    expect(extractLangFromUrl('https://example.com/api/timedtext?lang=en&fmt=json3')).toBe('en');
  });

  it('extracts lang when not first param', () => {
    expect(extractLangFromUrl('https://example.com/api?fmt=json3&lang=pt')).toBe('pt');
  });

  it('returns undefined when no lang param', () => {
    expect(extractLangFromUrl('https://example.com/api?fmt=json3')).toBeUndefined();
  });

  it('returns undefined for empty string', () => {
    expect(extractLangFromUrl('')).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// sortTracksManualFirst
// ---------------------------------------------------------------------------
describe('sortTracksManualFirst', () => {
  it('sorts manual tracks before ASR tracks', () => {
    const tracks = [
      { name: 'Auto', kind: 'asr', baseUrl: 'a' },
      { name: 'Manual', kind: '', baseUrl: 'b' },
    ];
    const sorted = sortTracksManualFirst(tracks);
    expect(sorted[0].name).toBe('Manual');
    expect(sorted[1].name).toBe('Auto');
  });

  it('preserves order when all manual', () => {
    const tracks = [
      { name: 'English', kind: '', baseUrl: 'a' },
      { name: 'Spanish', kind: '', baseUrl: 'b' },
    ];
    const sorted = sortTracksManualFirst(tracks);
    expect(sorted[0].name).toBe('English');
    expect(sorted[1].name).toBe('Spanish');
  });

  it('does not mutate the original array', () => {
    const tracks = [
      { name: 'Auto', kind: 'asr', baseUrl: 'a' },
      { name: 'Manual', kind: '', baseUrl: 'b' },
    ];
    sortTracksManualFirst(tracks);
    expect(tracks[0].name).toBe('Auto');
  });

  it('handles empty array', () => {
    expect(sortTracksManualFirst([])).toEqual([]);
  });
});
