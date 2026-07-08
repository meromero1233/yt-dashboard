import 'dotenv/config';
import http from 'node:http';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.YOUTUBE_API_KEY?.trim();
const DEFAULT_CHANNEL = process.env.CHANNEL_ID?.trim() || 'UCM1vJX0aYxbt69U0XrwsVag';
const DEFAULT_GOAL = Number(process.env.SUBSCRIBER_GOAL || 1000000);
const PORT = Number(process.env.PORT || 5178);

// ── YouTube API ヘルパー ──────────────────────────────────────────────────────
async function yt(endpoint, params) {
  const u = new URL(`https://www.googleapis.com/youtube/v3/${endpoint}`);
  u.searchParams.set('key', KEY);
  for (const [k, v] of Object.entries(params)) u.searchParams.set(k, v);
  const r = await fetch(u);
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`YouTube ${endpoint} ${r.status}: ${t.slice(0, 200)}`);
  }
  return r.json();
}

// チャンネル指定（UC... / @handle / handle）を解決して channelId を返す
async function resolveChannel(input) {
  const q = (input || DEFAULT_CHANNEL).trim();
  if (/^UC[\w-]{20,}$/.test(q)) return q;
  const handle = q.replace(/^@/, '');
  const d = await yt('channels', { part: 'id', forHandle: handle });
  if (d.items?.[0]) return d.items[0].id;
  // フォールバック：検索
  const s = await yt('search', { part: 'snippet', q, type: 'channel', maxResults: '1' });
  if (s.items?.[0]) return s.items[0].snippet.channelId;
  throw new Error('チャンネルが見つかりませんでした');
}

function parseDuration(iso) {
  // PT#H#M#S → 秒
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

async function getAnalytics(channelInput, maxVideos = 50) {
  const channelId = await resolveChannel(channelInput);

  const ch = await yt('channels', {
    part: 'snippet,statistics,contentDetails',
    id: channelId,
  });
  const c = ch.items?.[0];
  if (!c) throw new Error('チャンネル情報を取得できませんでした');

  const uploads = c.contentDetails.relatedPlaylists.uploads;

  // アップロード動画のIDを新しい順に集める（動画0本なら404になるので握りつぶす）
  const ids = [];
  let pageToken = '';
  try {
    while (ids.length < maxVideos) {
      const pl = await yt('playlistItems', {
        part: 'contentDetails',
        playlistId: uploads,
        maxResults: '50',
        ...(pageToken ? { pageToken } : {}),
      });
      for (const it of pl.items || []) ids.push(it.contentDetails.videoId);
      if (!pl.nextPageToken) break;
      pageToken = pl.nextPageToken;
    }
  } catch (e) {
    console.warn('[playlist] 動画が取得できませんでした（0本の可能性）:', e.message);
  }

  // 動画の統計を取得（50件ずつ）
  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    if (batch.length === 0) break;
    const vd = await yt('videos', {
      part: 'snippet,statistics,contentDetails',
      id: batch.join(','),
    });
    for (const v of vd.items || []) {
      const dur = parseDuration(v.contentDetails?.duration);
      videos.push({
        id: v.id,
        title: v.snippet.title,
        publishedAt: v.snippet.publishedAt,
        thumb: v.snippet.thumbnails?.medium?.url || v.snippet.thumbnails?.default?.url || '',
        views: Number(v.statistics?.viewCount || 0),
        likes: Number(v.statistics?.likeCount || 0),
        comments: Number(v.statistics?.commentCount || 0),
        duration: dur,
        isShort: dur > 0 && dur <= 60,
        url: `https://www.youtube.com/watch?v=${v.id}`,
      });
    }
  }
  videos.sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt));

  return {
    channel: {
      id: channelId,
      title: c.snippet.title,
      thumb: c.snippet.thumbnails?.medium?.url || '',
      subscribers: Number(c.statistics?.subscriberCount || 0),
      totalViews: Number(c.statistics?.viewCount || 0),
      totalVideos: Number(c.statistics?.videoCount || 0),
      hiddenSubs: c.statistics?.hiddenSubscriberCount || false,
    },
    videos,
    goal: DEFAULT_GOAL,
    fetchedAt: new Date().toISOString(),
  };
}

// ── HTTP サーバー ─────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url, `http://localhost:${PORT}`);

  if (url.pathname === '/api/analytics') {
    try {
      const data = await getAnalytics(url.searchParams.get('channel'), Number(url.searchParams.get('max') || 50));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(data));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 静的ファイル
  let file = url.pathname === '/' ? '/index.html' : url.pathname;
  try {
    const full = path.join(__dirname, 'public', file);
    const body = await readFile(full);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(full)] || 'application/octet-stream' });
    res.end(body);
  } catch {
    res.writeHead(404); res.end('Not found');
  }
});

server.listen(PORT, () => console.log(`▶ YT Dashboard: http://localhost:${PORT}`));
