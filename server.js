import 'dotenv/config';
import http from 'node:http';
import fs from 'node:fs';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const KEY = process.env.YOUTUBE_API_KEY?.trim();
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY?.trim();
const TAVILY_KEY = process.env.TAVILY_API_KEY?.trim();

// ── 永続ストレージ（Railway Volume / ローカル ./data）──────────────────────────
const DATA_DIR = process.env.DATA_DIR?.trim() || './data';
const CFG_FILE = path.join(DATA_DIR, 'config.json');
const CACHE_FILE = path.join(DATA_DIR, 'cache.json');
function loadJSON(f, def) { try { return JSON.parse(fs.readFileSync(f, 'utf8')); } catch { return def; } }
function saveJSON(f, o) { try { fs.mkdirSync(DATA_DIR, { recursive: true }); fs.writeFileSync(f, JSON.stringify(o, null, 2)); } catch (e) { console.error('[store] save失敗:', e.message); } }

// ベンチマーク対象（同ジャンル大手）のデフォルト。ユーザーが追加・削除・表示切替できる
const DEFAULT_BENCHMARKS = [
  { id: null, name: 'たっくーTVれいでぃお', query: 'たっくーTVれいでぃお', enabled: true, kind: 'default' },
  { id: null, name: 'コヤッキースタジオ', query: 'コヤッキースタジオ', enabled: true, kind: 'default' },
  { id: null, name: 'ナオキマンショー', query: '@naokimanshow-naokiman', enabled: true, kind: 'default' },
  { id: null, name: 'とみビデオ', query: 'とみビデオ 都市伝説', enabled: true, kind: 'default' },
  { id: null, name: '雨穴', query: '雨穴', enabled: true, kind: 'default' },
  { id: null, name: '都市ボーイズ', query: '都市ボーイズ', enabled: true, kind: 'default' },
];

function getConfig() {
  let c = loadJSON(CFG_FILE, null);
  if (!c || !Array.isArray(c.channels)) {
    c = { channels: DEFAULT_BENCHMARKS.map((x) => ({ ...x })) };
  }
  if (!Array.isArray(c.emergingPins)) c.emergingPins = [];   // {id,name} 常に表示
  if (!Array.isArray(c.emergingHidden)) c.emergingHidden = []; // id 自動発見から除外
  saveJSON(CFG_FILE, c);
  return c;
}
function saveConfig(c) { saveJSON(CFG_FILE, c); }

// Tavily Web/X 検索
async function webSearch(query, max = 5) {
  if (!TAVILY_KEY) return { answer: '', results: '' };
  const r = await fetch('https://api.tavily.com/search', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ api_key: TAVILY_KEY, query, search_depth: 'basic', max_results: max, include_answer: true }),
  });
  if (!r.ok) return { answer: '', results: '' };
  const d = await r.json();
  return {
    answer: d.answer || '',
    results: (d.results || []).map((x) => `・${x.title}: ${(x.content || '').slice(0, 180)}`).join('\n'),
  };
}
const DEFAULT_CHANNEL = process.env.CHANNEL_ID?.trim() || 'UCM1vJX0aYxbt69U0XrwsVag';
const DEFAULT_GOAL = Number(process.env.SUBSCRIBER_GOAL || 1000000);
const PORT = Number(process.env.PORT || 5178);

// ── Claude（高島）呼び出し ────────────────────────────────────────────────────
async function askClaude(system, user, maxTokens = 1500) {
  const r = await fetch('https://api.anthropic.com/v1/messages', {
    method: 'POST',
    headers: {
      'x-api-key': ANTHROPIC_KEY,
      'anthropic-version': '2023-06-01',
      'content-type': 'application/json',
    },
    body: JSON.stringify({
      model: 'claude-haiku-4-5-20251001',
      max_tokens: maxTokens,
      system,
      messages: [{ role: 'user', content: user }],
    }),
  });
  if (!r.ok) throw new Error(`Anthropic ${r.status}: ${(await r.text()).slice(0, 200)}`);
  const d = await r.json();
  return d.content?.[0]?.text ?? '';
}

const TAKASHIMA = `あなたは「高島」という敏腕YouTubeマネージャーです。冷静沈着、データドリブン、的確で簡潔。厳しくも愛のある口調。語尾は自然な敬語。分析は具体的に、必ず「次にやる行動」まで落とし込む。おだてず、でも折れさせない。`;

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

// チャンネル指定（UC... / @handle / handle / 名前）を解決して channelId を返す（キャッシュ付き）
const resolveCache = new Map();
async function resolveChannel(input) {
  const q = (input || DEFAULT_CHANNEL).trim();
  if (/^UC[\w-]{20,}$/.test(q)) return q;
  if (resolveCache.has(q)) return resolveCache.get(q);
  const handle = q.replace(/^@/, '');
  let id = null;
  const d = await yt('channels', { part: 'id', forHandle: handle }).catch(() => null);
  if (d?.items?.[0]) id = d.items[0].id;
  if (!id) {
    const s = await yt('search', { part: 'snippet', q, type: 'channel', maxResults: '1' });
    if (s.items?.[0]) id = s.items[0].snippet.channelId;
  }
  if (!id) throw new Error('チャンネルが見つかりませんでした: ' + q);
  resolveCache.set(q, id);
  return id;
}

// ベンチマーク用：チャンネルの「直近◯日以内」の動画を分析
async function getChannelBenchmark(query, sinceDays) {
  const channelId = await resolveChannel(query);
  const ch = await yt('channels', { part: 'snippet,statistics,contentDetails', id: channelId });
  const c = ch.items?.[0];
  if (!c) throw new Error('取得失敗: ' + query);
  const uploads = c.contentDetails.relatedPlaylists.uploads;
  const since = Date.now() - sinceDays * 86400000;

  const ids = [];
  let pageToken = '';
  try {
    for (let p = 0; p < 4; p++) { // 最大200件まで遡る
      const pl = await yt('playlistItems', {
        part: 'contentDetails', playlistId: uploads, maxResults: '50',
        ...(pageToken ? { pageToken } : {}),
      });
      let oldestInPage = Infinity;
      for (const it of pl.items || []) {
        const t = new Date(it.contentDetails.videoPublishedAt || 0).getTime();
        oldestInPage = Math.min(oldestInPage, t);
        if (t >= since) ids.push(it.contentDetails.videoId);
      }
      if (!pl.nextPageToken || oldestInPage < since) break;
      pageToken = pl.nextPageToken;
    }
  } catch { /* 動画なし等 */ }

  const videos = [];
  for (let i = 0; i < ids.length; i += 50) {
    const batch = ids.slice(i, i + 50);
    if (!batch.length) break;
    const vd = await yt('videos', { part: 'snippet,statistics,contentDetails', id: batch.join(',') });
    for (const v of vd.items || []) {
      const dur = parseDuration(v.contentDetails?.duration);
      videos.push({
        id: v.id, title: v.snippet.title, publishedAt: v.snippet.publishedAt,
        thumb: v.snippet.thumbnails?.medium?.url || '',
        views: Number(v.statistics?.viewCount || 0),
        likes: Number(v.statistics?.likeCount || 0),
        comments: Number(v.statistics?.commentCount || 0),
        isShort: dur > 0 && dur <= SHORT_MAX,
        url: `https://www.youtube.com/watch?v=${v.id}`,
      });
    }
  }
  videos.sort((a, b) => b.views - a.views);

  const totalViews = videos.reduce((a, v) => a + v.views, 0);
  const shortVids = videos.filter((v) => v.isShort);
  const longVids = videos.filter((v) => !v.isShort);
  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, v) => a + v.views, 0) / arr.length) : 0;
  return {
    channelId,
    name: c.snippet.title,
    thumb: c.snippet.thumbnails?.default?.url || '',
    subscribers: Number(c.statistics?.subscriberCount || 0),
    totalVideos: Number(c.statistics?.videoCount || 0),
    recentCount: videos.length,
    recentAvgViews: videos.length ? Math.round(totalViews / videos.length) : 0,
    avgViewsLong: avg(longVids),
    avgViewsShort: avg(shortVids),
    longCount: longVids.length,
    shortCount: shortVids.length,
    shortRatio: videos.length ? Math.round(shortVids.length / videos.length * 100) : 0,
    topLong: longVids.slice(0, 4),
    topShort: shortVids.slice(0, 4),
    top: videos.slice(0, 5),
  };
}

function parseDuration(iso) {
  // PT#H#M#S → 秒
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?/.exec(iso || '');
  if (!m) return 0;
  return (+(m[1] || 0)) * 3600 + (+(m[2] || 0)) * 60 + (+(m[3] || 0));
}

// YouTubeショートは現在最大3分（180秒）。この尺以下をショート扱いする
const SHORT_MAX = 180;

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
        isShort: dur > 0 && dur <= SHORT_MAX,
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

// 新興チャンネル発見：同ジャンルで「開設◯ヶ月以内」なのに伸びているチャンネル
async function getEmergingChannels(months, limit = 6) {
  const since = Date.now() - months * 30 * 86400000;
  // クォータ節約：検索は各100ユニット。3日に1回の自動取得で使う想定
  const queries = [
    '都市伝説 shorts', '雑学 shorts', '未解決事件', '怖い話', '闇 ゆっくり解説', 'ゾッとする話', 'オカルト',
  ];
  const chIds = new Set();
  for (const q of queries) {
    const s = await yt('search', {
      part: 'snippet', q, type: 'video', order: 'viewCount',
      publishedAfter: new Date(Date.now() - 120 * 86400000).toISOString(),
      maxResults: '25', regionCode: 'JP', relevanceLanguage: 'ja',
    }).catch(() => null);
    for (const it of s?.items || []) chIds.add(it.snippet.channelId);
  }

  const allIds = [...chIds];
  if (!allIds.length) return [];
  const chItems = [];
  for (let i = 0; i < allIds.length; i += 50) {
    const chd = await yt('channels', { part: 'snippet,statistics,contentDetails', id: allIds.slice(i, i + 50).join(',') });
    chItems.push(...(chd.items || []));
  }

  let list = chItems.map((c) => ({
    id: c.id,
    name: c.snippet.title,
    thumb: c.snippet.thumbnails?.default?.url || '',
    createdAt: c.snippet.publishedAt,
    subs: Number(c.statistics?.subscriberCount || 0),
    totalViews: Number(c.statistics?.viewCount || 0),
    totalVideos: Number(c.statistics?.videoCount || 0),
    uploads: c.contentDetails?.relatedPlaylists?.uploads,
  })).filter((c) => new Date(c.createdAt).getTime() >= since && c.totalVideos > 0 && c.subs > 0);

  list.forEach((c) => {
    c.ageMonths = Math.max(0.5, (Date.now() - new Date(c.createdAt).getTime()) / (30 * 86400000));
    c.velocity = Math.round(c.subs / c.ageMonths); // 月あたり登録者増ペース
  });
  list.sort((a, b) => b.velocity - a.velocity);
  list = list.slice(0, limit);

  for (const c of list) await enrichEmerging(c);
  return list;
}

// 1チャンネルを新興カード用に詳細分析（投稿頻度・ロング/ショート別平均・上位動画・マイルストーン）
const EM_MILES = [10000, 30000, 50000, 100000, 500000, 1000000];
async function enrichEmerging(c) {
  c.freqPerMonth = Math.round((c.totalVideos / c.ageMonths) * 10) / 10;
  c.freqPerWeek = Math.round((c.totalVideos / c.ageMonths / 4.33) * 10) / 10;
  c.milestones = EM_MILES.filter((m) => c.subs >= m).map((m) => {
    const months = c.velocity > 0 ? m / c.velocity : null;
    return { m, months: months ? Math.round(months * 10) / 10 : null, videos: months ? Math.round(c.freqPerMonth * months) : null };
  });
  try {
    const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: c.uploads, maxResults: '30' });
    const vids = (pl.items || []).map((i) => i.contentDetails.videoId).slice(0, 30);
    if (vids.length) {
      const vd = await yt('videos', { part: 'snippet,statistics,contentDetails', id: vids.join(',') });
      const arr = (vd.items || []).map((v) => {
        const dur = parseDuration(v.contentDetails?.duration);
        return {
          title: v.snippet.title, views: Number(v.statistics?.viewCount || 0), publishedAt: v.snippet.publishedAt,
          thumb: v.snippet.thumbnails?.medium?.url || '', isShort: dur > 0 && dur <= SHORT_MAX,
          url: `https://www.youtube.com/watch?v=${v.id}`,
        };
      });
      const longs = arr.filter((v) => !v.isShort), shorts = arr.filter((v) => v.isShort);
      const avg = (a) => a.length ? Math.round(a.reduce((x, v) => x + v.views, 0) / a.length) : 0;
      c.shortRatio = arr.length ? Math.round(shorts.length / arr.length * 100) : 0;
      c.avgViewsLong = avg(longs); c.avgViewsShort = avg(shorts);
      c.longCount = longs.length; c.shortCount = shorts.length;
      c.topLong = [...longs].sort((a, b) => b.views - a.views).slice(0, 3);
      c.topShort = [...shorts].sort((a, b) => b.views - a.views).slice(0, 3);
      c.top = [...arr].sort((a, b) => b.views - a.views).slice(0, 3);
      c.recent = [...arr].sort((a, b) => new Date(b.publishedAt) - new Date(a.publishedAt)).slice(0, 3);
    } else { Object.assign(c, { top: [], recent: [], topLong: [], topShort: [], shortRatio: 0, longCount: 0, shortCount: 0, avgViewsLong: 0, avgViewsShort: 0 }); }
  } catch { Object.assign(c, { top: [], recent: [], topLong: [], topShort: [], shortRatio: 0, longCount: 0, shortCount: 0, avgViewsLong: 0, avgViewsShort: 0 }); }
  return c;
}

// ユーザー指定のチャンネルを新興カード用に分析（ピン留め・追加チャンネル用）
async function analyzeEmergingByQuery(query) {
  const channelId = await resolveChannel(query);
  const ch = await yt('channels', { part: 'snippet,statistics,contentDetails', id: channelId });
  const c = ch.items?.[0];
  if (!c) throw new Error('取得失敗: ' + query);
  const created = c.snippet.publishedAt;
  const subs = Number(c.statistics?.subscriberCount || 0);
  const card = {
    id: channelId, name: c.snippet.title, thumb: c.snippet.thumbnails?.default?.url || '',
    createdAt: created, subs, totalViews: Number(c.statistics?.viewCount || 0),
    totalVideos: Number(c.statistics?.videoCount || 0),
    uploads: c.contentDetails?.relatedPlaylists?.uploads,
    pinned: true,
  };
  card.ageMonths = Math.max(0.5, (Date.now() - new Date(created).getTime()) / (30 * 86400000));
  card.velocity = Math.round(subs / card.ageMonths);
  await enrichEmerging(card);
  return card;
}

// 最適投稿タイミング：同ジャンルの人気動画の投稿曜日・時間（JST）を再生数で重み付け集計
async function getBestTiming() {
  const queries = ['都市伝説', '雑学 豆知識', '未解決事件', '怖い話'];
  const ids = new Set();
  for (const q of queries) {
    const s = await yt('search', {
      part: 'snippet', q, type: 'video', order: 'viewCount',
      publishedAfter: new Date(Date.now() - 120 * 86400000).toISOString(),
      maxResults: '25', regionCode: 'JP', relevanceLanguage: 'ja',
    }).catch(() => null);
    for (const it of s?.items || []) ids.add(it.id.videoId);
  }
  const dow = Array(7).fill(0), hour = Array(24).fill(0);
  const slotMap = new Map(); // "dow-hour" → 重み合計
  const allIds = [...ids];
  for (let i = 0; i < allIds.length; i += 50) {
    const vd = await yt('videos', { part: 'snippet,statistics', id: allIds.slice(i, i + 50).join(',') });
    for (const v of vd.items || []) {
      const t = new Date(v.snippet.publishedAt).getTime();
      const jst = new Date(t + 9 * 3600e3);
      const d = jst.getUTCDay(), h = jst.getUTCHours();
      const w = Math.log10(Number(v.statistics?.viewCount || 1) + 10); // 再生数で重み（対数）
      dow[d] += w;
      hour[h] += w;
      const k = `${d}-${h}`;
      slotMap.set(k, (slotMap.get(k) || 0) + w);
    }
  }
  const bestDow = dow.indexOf(Math.max(...dow));
  const bestHour = hour.indexOf(Math.max(...hour));
  // 曜日×時間帯のベスト5スロット
  const slots = [...slotMap.entries()]
    .map(([k, score]) => { const [d, h] = k.split('-').map(Number); return { dow: d, hour: h, score }; })
    .sort((a, b) => b.score - a.score)
    .slice(0, 5);
  return { dow, hour, bestDow, bestHour, slots, sample: allIds.length };
}

// ── AI分析（再利用）──────────────────────────────────────────────────────────
function summarizeBenchmark(channels) {
  return channels.map((c) => `■${c.name}（登録${c.subscribers}）直近平均${c.recentAvgViews}回・${c.recentCount}本・short${c.shortRatio}%\n  代表作: `
    + (c.top || []).slice(0, 3).map((v) => `「${v.title}」${v.views}回`).join(' / ')).join('\n');
}
function summarizeEmerging(channels) {
  return channels.map((c) => `■${c.name}：開設${Math.round(c.ageMonths)}ヶ月・登録${c.subscribers}（月+${c.velocity}）・総動画${c.totalVideos}本・週${c.freqPerWeek}本・short${c.shortRatio}%\n  マイルストーン: `
    + ((c.milestones || []).map((m) => `${m.m}人=推定${m.months}ヶ月/約${m.videos}本`).join(' , ') || 'なし')
    + `\n  代表作: ` + (c.top || []).map((v) => `「${v.title}」${v.views}回(${v.isShort ? 'short' : 'long'})`).join(' / ')).join('\n');
}

async function aiBenchmark(channels) {
  const names = channels.map((c) => c.name);
  let web = '';
  for (const q of [
    `${names.slice(0, 3).join(' ')} YouTube 伸びている 理由 戦略`,
    '都市伝説 雑学 YouTube チャンネル 2026 伸びている 共通点',
  ]) { const { answer, results } = await webSearch(q, 4); if (answer || results) web += `▼「${q}」\n${answer}\n${results}\n\n`; }
  const user = `以下は、りくまこRadio（都市伝説・雑学・未解決事件ジャンル）の同ジャンル大手チャンネルの直近データとWeb情報です。

【同ジャンル大手の直近データ】
${summarizeBenchmark(channels)}

【Web情報】
${web || '（一般知見で補ってください）'}

高島として：
■ 各チャンネルが伸びている要因（1chにつき1〜2行）
■ 伸びているチャンネルの共通点（3〜5個、具体的に）
■ りくまこRadioへのアジャスト案（今すぐ真似る3つ＋中期2つ。登録者ゼロ前提で現実的に）
■ 高島の結論（勝ち筋を一言）`;
  return askClaude(TAKASHIMA, user, 2200);
}

async function aiEmerging(channels) {
  let web = '';
  for (const q of ['YouTube アルゴリズム 2026 重視 指標 伸ばし方', '都市伝説 雑学 YouTube 今 バズってる トレンド ネタ 2026']) {
    const { answer, results } = await webSearch(q, 4); if (answer || results) web += `▼「${q}」\n${answer}\n${results}\n\n`;
  }
  const user = `以下は、都市伝説・雑学・未解決系ジャンルで「開設6ヶ月以内なのに急成長している新興YouTubeチャンネル」の実データ（投稿頻度・ショート比率・マイルストーン推定つき）です。りくまこRadioも開設したばかりのゼロスタート。この新興から学べる"初速の勝ちパターン"を知りたい。

【新興チャンネルの実データ】
${summarizeEmerging(channels)}

【Web情報（アルゴリズム・トレンド）】
${web || '（一般知見で補ってください）'}

高島として、分かりやすく：
■ 各チャンネルの総評（1chにつき2〜3行。速さ・投稿頻度・ショート比率に触れ、勝因をズバッと）
■ ベストな投稿頻度（成功データから逆算。週◯本・ショート◯：ロング◯など具体的に）
■ 今のYouTubeアルゴリズムが重視していること（3〜4個、具体的に）
■ 今アツいトレンド・ネタの方向性（具体的に3つ）
■ 動画の構成・脚本で重視すべきこと（3〜4個）
■ りくまこRadioが今日から実行すべきこと（3つ）
■ 高島の一言`;
  return askClaude(TAKASHIMA, user, 2600);
}

// 設定に登録された（表示ON）大手チャンネルのベンチマークを取得。id未解決なら解決して保存
async function fetchManagedBenchmark(days = 90) {
  const cfg = getConfig();
  const enabled = cfg.channels.filter((c) => c.enabled);
  const out = [];
  let dirty = false;
  for (const c of enabled) {
    try {
      const data = await getChannelBenchmark(c.id || c.query, days);
      if (!c.id && data.channelId) { c.id = data.channelId; dirty = true; }
      out.push({ label: c.name, ...data });
    } catch (e) { console.warn('[benchmark]', c.name, e.message); }
  }
  if (dirty) saveConfig(cfg);
  out.sort((a, b) => b.recentAvgViews - a.recentAvgViews);
  return out;
}

// ピン留め（＋追加）チャンネルと自動発見を合成して新興リストを作る
async function fetchEmergingCombined(limit = 10) {
  const cfg = getConfig();
  const pinned = [];
  for (const p of cfg.emergingPins) {
    try { pinned.push(await analyzeEmergingByQuery(p.id || p.query || p.name)); }
    catch (e) { console.warn('[emerging pin]', p.name, e.message); }
  }
  const pinnedIds = new Set(pinned.map((c) => c.id));
  const hidden = new Set(cfg.emergingHidden);
  const auto = (await getEmergingChannels(6, limit + cfg.emergingHidden.length + pinned.length))
    .filter((c) => !hidden.has(c.id) && !pinnedIds.has(c.id));
  return [...pinned, ...auto].slice(0, Math.max(limit, pinned.length));
}

// ── 3日に1回の自動取得（ダッシュボード全体を作ってキャッシュ）────────────────
let building = false;
async function buildDashboard() {
  if (building) return;
  building = true;
  console.log('[auto] ダッシュボード自動取得を開始…');
  try {
    const benchmark = await fetchManagedBenchmark(90);
    const emerging = await fetchEmergingCombined(10);
    // クォータ切れ等で取得がほぼ空なら、既存の良いキャッシュを壊さず数時間後に再試行
    if (benchmark.length < 2 || emerging.length < 1) {
      console.warn(`[auto] 取得不足（大手${benchmark.length}・新興${emerging.length}）→ キャッシュ保持、3時間後に再試行`);
      setTimeout(() => buildDashboard(), 3 * 3600 * 1000);
      return;
    }
    let timing = null;
    try { timing = await getBestTiming(); } catch (e) { console.error('[auto] timing:', e.message); }
    let benchmarkAdvice = '', emergingAdvice = '';
    try { benchmarkAdvice = await aiBenchmark(benchmark); } catch (e) { console.error('[auto] benchmark AI:', e.message); }
    try { emergingAdvice = await aiEmerging(emerging); } catch (e) { console.error('[auto] emerging AI:', e.message); }
    const cache = { updatedAt: new Date().toISOString(), benchmark: { days: 90, channels: benchmark }, emerging: { channels: emerging }, timing, benchmarkAdvice, emergingAdvice };
    saveJSON(CACHE_FILE, cache);
    console.log(`[auto] 完了：大手${benchmark.length}件・新興${emerging.length}件`);
    return cache;
  } catch (e) {
    console.error('[auto] 失敗:', e.message);
    setTimeout(() => buildDashboard(), 3 * 3600 * 1000);
  } finally {
    building = false;
  }
}

// ── 成長履歴トラッキング（毎日1回、りくまこの実データを記録）──────────────────
const HISTORY_FILE = path.join(DATA_DIR, 'history.json');
async function snapshotHistory() {
  try {
    const ch = await yt('channels', { part: 'statistics', id: DEFAULT_CHANNEL });
    const s = ch.items?.[0]?.statistics;
    if (!s) return;
    const today = new Date(Date.now() + 9 * 3600e3).toISOString().slice(0, 10); // JST日付
    const hist = loadJSON(HISTORY_FILE, []);
    const rec = { date: today, subs: Number(s.subscriberCount || 0), views: Number(s.viewCount || 0), videos: Number(s.videoCount || 0) };
    const i = hist.findIndex((h) => h.date === today);
    if (i >= 0) hist[i] = rec; else hist.push(rec);
    if (hist.length > 400) hist.splice(0, hist.length - 400);
    saveJSON(HISTORY_FILE, hist);
    console.log(`[history] ${today} subs=${rec.subs} views=${rec.views}`);
  } catch (e) { console.error('[history]', e.message); }
}
function scheduleHistory() {
  snapshotHistory();
  setInterval(snapshotHistory, 24 * 3600 * 1000);
}

// ── 新着動画の自動診断（りくまこの投稿を検知→バリューアップ＋成功事例比較）──────
const NEWVID_FILE = path.join(DATA_DIR, 'newvideo.json');
async function checkNewVideo() {
  try {
    const ch = await yt('channels', { part: 'contentDetails', id: DEFAULT_CHANNEL });
    const uploads = ch.items?.[0]?.contentDetails?.relatedPlaylists?.uploads;
    if (!uploads) return;
    const pl = await yt('playlistItems', { part: 'contentDetails', playlistId: uploads, maxResults: '1' }).catch(() => null);
    const vid = pl?.items?.[0]?.contentDetails?.videoId;
    if (!vid) return;
    const state = loadJSON(NEWVID_FILE, {});
    if (state.lastVid === vid) return; // 新着なし

    const vd = await yt('videos', { part: 'snippet,statistics', id: vid });
    const v = vd.items?.[0]; if (!v) return;
    const video = {
      id: vid, title: v.snippet.title, thumb: v.snippet.thumbnails?.medium?.url || '',
      views: Number(v.statistics?.viewCount || 0), url: `https://www.youtube.com/watch?v=${vid}`,
      publishedAt: v.snippet.publishedAt,
    };

    // 似た人気動画を検索（タイトルの先頭キーワードで）
    let similar = [];
    try {
      const s = await yt('search', { part: 'snippet', q: video.title.slice(0, 22), type: 'video', order: 'viewCount', maxResults: '8', regionCode: 'JP', relevanceLanguage: 'ja' });
      const ids = (s.items || []).map((i) => i.id.videoId).filter(Boolean);
      if (ids.length) {
        const vs = await yt('videos', { part: 'snippet,statistics', id: ids.join(',') });
        similar = (vs.items || []).filter((x) => x.id !== vid)
          .map((x) => ({ title: x.snippet.title, views: Number(x.statistics?.viewCount || 0), url: `https://www.youtube.com/watch?v=${x.id}` }))
          .sort((a, b) => b.views - a.views).slice(0, 5);
      }
    } catch (e) { console.error('[newvideo] similar:', e.message); }

    const user = `りくまこRadio（都市伝説・雑学・未解決系）が新しく投稿した動画の自動診断です。

【投稿した動画】「${video.title}」（現在 ${video.views}回）
【同じテーマで伸びている人気動画】
${similar.map((x) => `・「${x.title}」${x.views}回`).join('\n') || '（見つかりませんでした）'}

高島として、分かりやすく：
■ この動画のバリューアップ（タイトル改善案2つ＋サムネ改善のコンセプト1つ。なぜ伸びるかも一言）
■ 伸びている動画と比べて足りない/取り入れるべきこと（3つ、具体的に）
■ 次の動画への一言（短く、前を向かせる）`;
    let diagnosis = '';
    try { diagnosis = await askClaude(TAKASHIMA, user, 1400); } catch (e) { console.error('[newvideo] AI:', e.message); }

    saveJSON(NEWVID_FILE, { lastVid: vid, at: new Date().toISOString(), video, similar, diagnosis });
    console.log('[newvideo] 新着診断を生成:', video.title);
  } catch (e) { console.error('[newvideo]', e.message); }
}
function scheduleNewVideo() {
  setTimeout(checkNewVideo, 15000);
  setInterval(checkNewVideo, 6 * 3600 * 1000);
}

const THREE_DAYS = 3 * 24 * 60 * 60 * 1000;
function scheduleAutoFetch() {
  const cache = loadJSON(CACHE_FILE, null);
  const age = cache ? Date.now() - new Date(cache.updatedAt).getTime() : Infinity;
  const incomplete = !cache || (cache.benchmark?.channels?.length || 0) < 2 || (cache.emerging?.channels?.length || 0) < 1;
  if (age > THREE_DAYS || incomplete) {
    console.log(`[auto] 取得します（${incomplete ? 'キャッシュ不十分' : 'キャッシュ期限切れ'}）`);
    setTimeout(() => buildDashboard(), 5000);
  } else {
    console.log(`[auto] キャッシュ有効（${Math.round(age / 3600000)}時間前）`);
  }
  setInterval(() => buildDashboard(), THREE_DAYS);
}

// ── HTTP サーバー ─────────────────────────────────────────────────────────────
const MIME = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css' };

function readBody(req) {
  return new Promise((resolve, reject) => {
    let b = '';
    req.on('data', (c) => { b += c; if (b.length > 2e6) req.destroy(); });
    req.on('end', () => resolve(b));
    req.on('error', reject);
  });
}

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

  // ダッシュボード（自動取得のキャッシュを返す。無ければ生成を開始）
  if (url.pathname === '/api/dashboard') {
    const cache = loadJSON(CACHE_FILE, null);
    if (!cache && !building) buildDashboard();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(cache ? { ...cache, building } : { building: true }));
    return;
  }

  // 手動で自動取得を再実行
  if (url.pathname === '/api/refresh' && req.method === 'POST') {
    if (!building) buildDashboard();
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify({ started: true, building: true }));
    return;
  }

  // 管理チャンネル一覧の取得・変更（add/remove/toggle）
  if (url.pathname === '/api/channels') {
    if (req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(getConfig()));
      return;
    }
    if (req.method === 'POST') {
      try {
        const { action, query, id } = JSON.parse((await readBody(req)) || '{}');
        const cfg = getConfig();
        if (action === 'add') {
          const chId = await resolveChannel(query);
          if (cfg.channels.some((c) => c.id === chId)) throw new Error('すでに追加済みです');
          const info = await yt('channels', { part: 'snippet', id: chId });
          const name = info.items?.[0]?.snippet?.title || query;
          cfg.channels.push({ id: chId, name, query: chId, enabled: true, kind: 'custom' });
        } else if (action === 'remove') {
          cfg.channels = cfg.channels.filter((c) => (c.id || c.query) !== id);
        } else if (action === 'toggle') {
          const c = cfg.channels.find((x) => (x.id || x.query) === id);
          if (c) c.enabled = !c.enabled;
        }
        saveConfig(cfg);
        res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify(cfg));
      } catch (e) {
        res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
        res.end(JSON.stringify({ error: e.message }));
      }
      return;
    }
  }

  // 新興チャンネル1件を分析（追加時の即時表示用）
  if (url.pathname === '/api/emerging-one') {
    try {
      const card = await analyzeEmergingByQuery(url.searchParams.get('query'));
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(card));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 新興チャンネルのピン留め・除外・追加
  if (url.pathname === '/api/emerging-channels' && req.method === 'POST') {
    try {
      const { action, query, id, name } = JSON.parse((await readBody(req)) || '{}');
      const cfg = getConfig();
      if (action === 'pin') {
        const chId = await resolveChannel(query || id);
        const info = await yt('channels', { part: 'snippet', id: chId });
        const nm = info.items?.[0]?.snippet?.title || name || query;
        cfg.emergingHidden = cfg.emergingHidden.filter((x) => x !== chId);
        if (!cfg.emergingPins.some((p) => p.id === chId)) cfg.emergingPins.push({ id: chId, name: nm });
      } else if (action === 'unpin') {
        cfg.emergingPins = cfg.emergingPins.filter((p) => p.id !== id);
      } else if (action === 'hide') {
        cfg.emergingPins = cfg.emergingPins.filter((p) => p.id !== id);
        if (!cfg.emergingHidden.includes(id)) cfg.emergingHidden.push(id);
      } else if (action === 'unhide') {
        cfg.emergingHidden = cfg.emergingHidden.filter((x) => x !== id);
      }
      saveConfig(cfg);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ ok: true, emergingPins: cfg.emergingPins, emergingHidden: cfg.emergingHidden }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ベンチマーク（管理チャンネルの直近分析・オンデマンド）
  if (url.pathname === '/api/benchmark') {
    try {
      const days = Number(url.searchParams.get('days') || 90);
      const channels = await fetchManagedBenchmark(days);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ days, channels, fetchedAt: new Date().toISOString() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 新興チャンネル発見
  if (url.pathname === '/api/emerging') {
    try {
      const months = Number(url.searchParams.get('months') || 6);
      const channels = await getEmergingChannels(months, 10);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ months, channels, fetchedAt: new Date().toISOString() }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 最新投稿の自動診断
  if (url.pathname === '/api/newvideo') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(loadJSON(NEWVID_FILE, null)));
    return;
  }

  // 成長履歴（りくまこの実データ）
  if (url.pathname === '/api/history') {
    res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
    res.end(JSON.stringify(loadJSON(HISTORY_FILE, [])));
    return;
  }

  // タイトル/サムネ A/B 案ジェネレーター
  if (url.pathname === '/api/ab' && req.method === 'POST') {
    try {
      const { idea } = JSON.parse((await readBody(req)) || '{}');
      if (!idea) throw new Error('ネタ・テーマを入力してください');
      const user = `動画のネタ・テーマ：「${idea}」

高島として、この動画がクリックされ、伸びるためのタイトルとサムネの案を出してください。

■ タイトル案（5つ）
それぞれ、狙い（なぜクリックされるか）を一言添える。クリックされやすく具体的に、15〜28字目安。煽りすぎ・釣りすぎはNG。

■ サムネのコンセプト案（3つ）
それぞれ「大きく見せる要素・表情/構図・入れる文字（6〜9字）・色」を具体的に。

■ A/Bテストのおすすめ
まずどの2案で比較すべきか、高島の推し。`;
      const text = await askClaude(TAKASHIMA, user, 1400);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ text }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 最適投稿タイミング
  if (url.pathname === '/api/timing') {
    try {
      const t = await getBestTiming();
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify(t));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // 新興チャンネルAI分析（POST：各chの高島総評＋秘訣抽出＋りくまこへの適用）
  if (url.pathname === '/api/emerging-ai' && req.method === 'POST') {
    try {
      const { summary } = JSON.parse((await readBody(req)) || '{}');
      let web = '';
      for (const q of [
        'YouTube アルゴリズム 2026 重視 されている 指標 伸ばし方',
        '都市伝説 雑学 YouTube 今 バズってる トレンド ネタ 2026',
      ]) {
        const { answer, results } = await webSearch(q, 4);
        if (answer || results) web += `▼「${q}」\n${answer}\n${results}\n\n`;
      }

      const user = `以下は、都市伝説・雑学・未解決系ジャンルで「開設6ヶ月以内なのに急成長している新興YouTubeチャンネル」の実データです（投稿頻度・ショート比率・マイルストーン到達の推定つき）。りくまこRadioも開設したばかりのゼロスタートなので、この新興チャンネルから学べる"初速の勝ちパターン"を知りたい。

【新興チャンネルの実データ】
${summary}

【Web情報（アルゴリズム・トレンド）】
${web || '（一般知見で補ってください）'}

高島として次の形式で、分かりやすく：
■ 各チャンネルの総評（1chにつき2〜3行。「開設◯ヶ月で登録◯万＝月◯人ペース」の速さと、投稿頻度・ショート比率に触れつつ、勝因をズバッと。初心者にも分かる言葉で）
■ ベストな投稿頻度（新興の成功データから逆算して「週◯本・ショート◯：ロング◯」など具体的に。なぜその頻度かも）
■ 今のYouTubeアルゴリズムが重視していること（データとWeb情報から3〜4個。ショート起点の集客→ロングで定着、視聴維持率、初速など具体的に）
■ 今アツいトレンド・ネタの方向性（このジャンルで今伸びている切り口を具体的に3つ）
■ 動画の構成・脚本で重視すべきこと（冒頭フック・展開・オチなど、伸びてる動画に共通する型を3〜4個）
■ りくまこRadioが今日から実行すべきこと（3つ、具体的に）
■ 高島の一言（背中を押す短い言葉）`;

      const text = await askClaude(TAKASHIMA, user, 2600);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ text }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // ベンチマークAI分析（POST：伸びた要因＋りくまこへのアジャスト）
  if (url.pathname === '/api/benchmark-ai' && req.method === 'POST') {
    try {
      const { summary, channelNames } = JSON.parse((await readBody(req)) || '{}');
      // Web/Xから伸びた要因を集める
      let web = '';
      for (const q of [
        `${(channelNames || []).slice(0, 3).join(' ')} YouTube 伸びている 理由 戦略`,
        '都市伝説 雑学 YouTube チャンネル 2026 伸びている 共通点',
        'YouTube 都市伝説 ショート バズ 構成 サムネ 傾向',
      ]) {
        const { answer, results } = await webSearch(q, 4);
        if (answer || results) web += `▼「${q}」\n${answer}\n${results}\n\n`;
      }

      const user = `以下は、りくまこRadio（都市伝説・雑学・未解決事件ジャンルのYouTube）の同ジャンル大手チャンネルの直近データと、Web/Xで集めた情報です。

【同ジャンル大手の直近データ】
${summary}

【Web/X情報（伸びた要因のヒント）】
${web || '（Web情報は取得できませんでした。データと一般知見で分析してください）'}

高島として、次を分析してください：
■ 各チャンネルが伸びている要因（データとWeb情報から、チャンネルごとに1〜2行）
■ 伸びているチャンネルの共通点（コンテンツの性質・構成・サムネ/タイトル・投稿頻度など、具体的に3〜5個）
■ りくまこRadioへのアジャスト案（今すぐ真似できること3つ＋中期で仕込むこと2つ。りくまこは登録者ゼロからのスタートである前提で、現実的に）
■ 高島の結論（この分析から言える"勝ち筋"を一言で）`;

      const text = await askClaude(TAKASHIMA, user, 2200);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ text, hadWeb: !!web }));
    } catch (e) {
      res.writeHead(500, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ error: e.message }));
    }
    return;
  }

  // AIアドバイス / バリューアップ（POST）
  if (url.pathname === '/api/ai' && req.method === 'POST') {
    try {
      const body = await readBody(req);
      const { kind, summary } = JSON.parse(body || '{}');
      let system = TAKASHIMA, user, maxTokens = 1500;

      if (kind === 'advice') {
        user = `以下はYouTubeチャンネルの分析データです。高島として「成長診断」をしてください。

${summary}

次の形式で、簡潔かつ具体的に：
■ 現状の評価（良い点・課題を各2つ、データを引用して）
■ 一番の伸びしろ（1つに絞って、なぜそこかを説明）
■ 今週の具体アクション（3つ、すぐ実行できる粒度で）
■ 高島からの一言（短く、熱量のある一言）`;
      } else if (kind === 'valueup') {
        maxTokens = 2000;
        user = `以下はYouTubeチャンネルの動画データ（再生数つき）です。高島として「バリューアッププラン」を作ってください。
再生数が伸び悩んでいる動画を中心に、最大5本について、タイトルとサムネイルをどう変えれば伸びる可能性が上がるかを提案します。

${summary}

各動画について次の形式で：
【元タイトル】（そのまま）
【改善タイトル案】（クリックされやすく、具体的に。15〜28字目安）
【サムネ改善のコンセプト】（何を大きく見せる/どんな表情・文字・色か、1〜2行）
【期待できる伸び】（例：「CTR改善で再生数1.5〜2倍の可能性」など、根拠を一言添えて現実的に）
最後に ■まとめ として、タイトル・サムネ全体に共通して意識すべきポイントを3つ。`;
      } else {
        throw new Error('unknown kind');
      }

      const text = await askClaude(system, user, maxTokens);
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8' });
      res.end(JSON.stringify({ text }));
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

server.listen(PORT, () => {
  console.log(`▶ YT Dashboard: http://localhost:${PORT}`);
  scheduleAutoFetch();  // 3日に1回の自動取得
  scheduleHistory();    // 毎日1回の成長スナップショット
  scheduleNewVideo();   // 新着動画の自動診断（6時間ごとチェック）
});
