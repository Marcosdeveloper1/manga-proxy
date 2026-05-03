const express = require('express');
const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════════════════════
//  HTTP HELPERS
// ══════════════════════════════════════════════════════════════════════════════

function fetchRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const timeout = setTimeout(() => reject(new Error('Timeout')), 10000);
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36', ...headers } }, (res) => {
      clearTimeout(timeout);
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRaw(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), status: res.statusCode, contentType: res.headers['content-type'] }));
    }).on('error', (e) => { clearTimeout(timeout); reject(e); });
  });
}

function fetchJSON(url, headers = {}) {
  return fetchRaw(url, { Accept: 'application/json', ...headers })
    .then(r => JSON.parse(r.buffer.toString('utf8')));
}

function fetchPOST(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname + (urlObj.search || ''),
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), status: res.statusCode }));
    });
    req.on('error', reject);
    req.write(data);
    req.end();
  });
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

function parseJsonStream(text) {
  const objects = [];
  let depth = 0, start = -1;
  for (let i = 0; i < text.length; i++) {
    if (text[i] === '{') { if (depth === 0) start = i; depth++; }
    else if (text[i] === '}') {
      depth--;
      if (depth === 0 && start !== -1) {
        try { objects.push(JSON.parse(text.slice(start, i + 1))); } catch (_) {}
        start = -1;
      }
    }
  }
  return objects;
}

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ══════════════════════════════════════════════════════════════════════════════
//  CACHE DO COMICK
// ══════════════════════════════════════════════════════════════════════════════
const comickById = {};
const comickByTitle = {};

function titleKey(t) {
  return (t || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

// ══════════════════════════════════════════════════════════════════════════════
//  PROTOBUF READER (MANGAPLUS)
// ══════════════════════════════════════════════════════════════════════════════

function readPB(buf) {
  const fields = {};
  let pos = 0;
  function varint() {
    let v = 0, shift = 0, b;
    do { b = buf[pos++]; v |= (b & 0x7f) << shift; shift += 7; } while (b & 0x80);
    return v;
  }
  while (pos < buf.length) {
    try {
      const tag = varint();
      if (!tag) break;
      const fn = tag >>> 3;
      const wt = tag & 7;
      if (!fields[fn]) fields[fn] = [];
      if (wt === 0) { fields[fn].push(varint()); }
      else if (wt === 2) { const len = varint(); fields[fn].push(buf.slice(pos, pos + len)); pos += len; }
      else if (wt === 1) { pos += 8; }
      else if (wt === 5) { pos += 4; }
      else break;
    } catch { break; }
  }
  return fields;
}

const s = b => Buffer.from(b).toString('utf8');
const pb = b => Buffer.from(b);

// ══════════════════════════════════════════════════════════════════════════════
//  MANGAPLUS
// ══════════════════════════════════════════════════════════════════════════════

const MP_WEB = 'https://jumpg-webapi.tokyo-cdn.com/api';

function mpHeaders() {
  return {
    'Origin': 'https://mangaplus.shueisha.co.jp',
    'Referer': 'https://mangaplus.shueisha.co.jp/',
    'SESSION-TOKEN': randomUUID(),
    'OS-VERSION': 'Android/14',
    'APP-VERSION': '100',
    'ANDROID-ID': randomUUID().replace(/-/g, '').slice(0, 16),
  };
}

async function mpRaw(path) {
  const { buffer, status } = await fetchRaw(`${MP_WEB}${path}`, mpHeaders());
  if (status !== 200) throw new Error(`HTTP ${status}`);
  return buffer;
}

function getSuccess(raw) {
  const resp = readPB(raw);
  const successBuf = resp[1]?.[0];
  if (!successBuf) throw new Error('sem success');
  return readPB(pb(successBuf));
}

function decodeTitle(b) {
  const f = readPB(pb(b));
  return {
    titleId: f[1]?.[0] || 0,
    name: f[2]?.[0] ? s(f[2][0]) : '',
    portraitImageUrl: f[4]?.[0] ? s(f[4][0]) : '',
  };
}

function decodeChapter(b) {
  const f = readPB(pb(b));
  return {
    chapterId: f[2]?.[0] || 0,
    name: f[3]?.[0] ? s(f[3][0]) : '',
    subTitle: f[4]?.[0] ? s(f[4][0]) : '',
  };
}

const MANGA_IDS = {
  'one piece': 700005, 'boruto two blue vortex': 100269, 'boruto': 100269, 'dandadan': 100171,
  'jujutsu kaisen': 100136, 'chainsaw man': 100191, 'my hero academia': 100103, 'naruto': 100018,
  'dragon ball super': 100012, 'kagurabachi': 100282, 'black clover': 100003, 'kaiju no 8': 100247
};

async function mpGetTitle(titleId) {
  const raw = await mpRaw(`/title_detail_v3?title_id=${titleId}&language=0`);
  const success = getSuccess(raw);
  const detail = readPB(pb(success[8]?.[0]));
  const titleInfo = detail[1]?.[0] ? decodeTitle(detail[1][0]) : {};
  const chapters = [];
  const seen = new Set();
  for (const groupBuf of (detail[28] || [])) {
    const group = readPB(pb(groupBuf));
    for (const c of [...(group[2] || []).map(decodeChapter), ...(group[4] || []).map(decodeChapter)]) {
      if (!c.chapterId || seen.has(c.chapterId)) continue;
      seen.add(c.chapterId);
      chapters.push({ id: String(c.chapterId), title: c.subTitle || `Capítulo ${c.name}`, chapterNumber: c.name, source: 'mangaplus' });
    }
  }
  return { title: titleInfo.name || '', coverUrl: titleInfo.portraitImageUrl || null, chapters, source: 'mangaplus' };
}

async function mpSearch(query) {
  const q = query.toLowerCase().trim();
  const results = [];
  if (MANGA_IDS[q]) {
    try {
      const d = await mpGetTitle(MANGA_IDS[q]);
      results.push({ id: String(MANGA_IDS[q]), title: d.title, coverUrl: d.coverUrl, source: 'mangaplus' });
    } catch (_) {}
  }
  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
//  TAIYO.MOE (PT-BR)
// ══════════════════════════════════════════════════════════════════════════════

async function taiyoSearch(query) {
  try {
    const data = await fetchJSON(`https://api.taiyo.moe/manga/search?q=${encodeURIComponent(query)}`);
    return (data || []).map(m => ({ id: `taiyo:${m.id}`, title: m.title, coverUrl: m.cover, source: 'taiyo' }));
  } catch (e) { return []; }
}

async function taiyoGetManga(id) {
  try {
    const m = await fetchJSON(`https://api.taiyo.moe/manga/${id.replace('taiyo:', '')}`);
    const chapters = (m.chapters || []).map(c => ({
      id: Buffer.from(`https://api.taiyo.moe/chapter/${c.id}`).toString('base64'),
      title: c.title || `Capítulo ${c.number}`,
      chapterNumber: String(c.number),
      source: 'taiyo'
    }));
    return { title: m.title, coverUrl: m.cover, description: m.description || '', chapters, source: 'taiyo' };
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMICK
// ══════════════════════════════════════════════════════════════════════════════

const COMICK_BASE = 'https://comick-source-api.notaspider.dev/api';

async function comickSearch(query) {
  try {
    const response = await fetchPOST(`${COMICK_BASE}/search`, { query, source: 'all' });
    const objects = parseJsonStream(response.buffer.toString('utf8'));
    const results = [];
    const seenIds = new Set();
    for (const obj of objects) {
      if (!obj.results) continue;
      const srcId = (obj.source || 'unknown').toLowerCase().replace(/\s+/g, '');
      for (const item of obj.results) {
        if (!item.id) continue;
        if (item.url) comickById[item.id] = { url: item.url, title: item.title, coverUrl: item.coverImage, sourceId: srcId };
        const key = titleKey(item.title);
        if (key) {
          if (!comickByTitle[key]) comickByTitle[key] = [];
          if (!comickByTitle[key].find(e => e.id === item.id)) comickByTitle[key].push({ id: item.id, url: item.url, sourceId: srcId });
        }
        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        results.push({ id: item.id, title: item.title, coverUrl: item.coverImage, source: 'comick' });
      }
    }
    return results.slice(0, 20);
  } catch (e) { return []; }
}

async function comickGetManga(mangaId, providedUrl) {
  try {
    const urlsToTry = [];
    const seen = new Set();
    const add = (url, src) => { if (url && !seen.has(url)) { seen.add(url); urlsToTry.push({ url, sourceId: src }); } };

    if (providedUrl) add(providedUrl, 'provided');
    if (comickById[mangaId]) add(comickById[mangaId].url, comickById[mangaId].sourceId);
    const key = titleKey(comickById[mangaId]?.title);
    if (key) (comickByTitle[key] || []).forEach(s => add(s.url, s.sourceId));

    // PARALELISMO: Testar todas as fontes Comick ao mesmo tempo
    const attempts = urlsToTry.map(async ({ url, sourceId }) => {
      try {
        const res = await fetchPOST(`${COMICK_BASE}/chapters`, { url });
        const objs = parseJsonStream(res.buffer.toString('utf8'));
        for (const obj of objs) {
          const list = obj.chapters || obj.items || obj.data || [];
          if (Array.isArray(list) && list.length > 0) {
            return {
              title: obj.title || comickById[mangaId]?.title || mangaId,
              coverUrl: obj.coverImage || comickById[mangaId]?.coverUrl,
              chapters: list.map(c => ({
                id: Buffer.from(c.url || String(c.id)).toString('base64'),
                title: c.title || `Capítulo ${c.chap || c.number}`,
                chapterNumber: String(c.chap || c.number || '0'),
                source: 'comick'
              }))
            };
          }
        }
      } catch (_) {}
      return null;
    });

    const results = await Promise.all(attempts);
    const firstGood = results.find(r => r && r.chapters.length > 0);
    return firstGood || { title: mangaId, coverUrl: null, chapters: [], source: 'comick' };
  } catch (e) { return { title: mangaId, coverUrl: null, chapters: [], source: 'comick' }; }
}

async function comickGetPages(chapterHid) {
  try {
    const url = Buffer.from(chapterHid, 'base64').toString('utf8');
    const { buffer, status } = await fetchRaw(url);
    if (status !== 200) return [];
    const html = buffer.toString('utf8');
    const pages = [];
    const seen = new Set();
    
    const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextMatch) {
      const urls = JSON.stringify(JSON.parse(nextMatch[1])).match(/https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?/gi) || [];
      for (const u of urls) {
        if (!seen.has(u) && !u.includes('logo') && u.length > 40) { seen.add(u); pages.push(u); }
      }
    }
    
    if (pages.length === 0) {
      const imgRegex = /(?:src|data-src)="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
      let m; while ((m = imgRegex.exec(html)) !== null) {
        if (!seen.has(m[1]) && !m[1].includes('logo')) { seen.add(m[1]); pages.push(m[1]); }
      }
    }
    return pages.slice(0, 150);
  } catch (e) { return []; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MANGADEX
// ══════════════════════════════════════════════════════════════════════════════

async function mdxSearch(query) {
  try {
    const d = await fetchJSON(`https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=20&includes[]=cover_art`);
    return (d.data || []).map(m => {
      const cv = m.relationships.find(r => r.type === 'cover_art');
      return { id: m.id, title: m.attributes.title.en || Object.values(m.attributes.title)[0], coverUrl: cv ? `https://uploads.mangadex.org/covers/${m.id}/${cv.attributes.fileName}.256.jpg` : null, source: 'mangadex' };
    });
  } catch (e) { return []; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({ status: 'ok', version: '14.0-parallel', sources: ['mangaplus', 'taiyo', 'mangadex', 'comick'], comickCache: Object.keys(comickById).length }));

app.get('/search', async (req, res) => {
  const { q, source } = req.query;
  if (!q) return res.status(400).json({ error: 'q missing' });

  if (source === 'taiyo') return res.json({ results: await taiyoSearch(q), source: 'taiyo' });
  if (source === 'mangadex') return res.json({ results: await mdxSearch(q), source: 'mangadex' });

  // PARALELISMO NA BUSCA GERAL (ACABA COM OS 2 MINUTOS)
  const promises = [
    mpSearch(q).then(r => ({ s: 'mangaplus', r })),
    taiyoSearch(q).then(r => ({ s: 'taiyo', r })),
    mdxSearch(q).then(r => ({ s: 'mangadex', r })),
    comickSearch(q).then(r => ({ s: 'comick', r }))
  ];

  const all = await Promise.allSettled(promises);
  const found = all.filter(p => p.status === 'fulfilled' && p.value.r.length > 0).map(p => p.value);
  
  if (found.length > 0) return res.json({ results: found[0].r, source: found[0].s });
  res.json({ results: [], source: 'none' });
});

app.get('/manga', async (req, res) => {
  const { id, source, url } = req.query;
  if (source === 'taiyo') return res.json(await taiyoGetManga(id));
  if (source === 'mangaplus' || /^\d+$/.test(id)) return res.json(await mpGetTitle(id));
  if (source === 'comick') return res.json(await comickGetManga(id, url));
  
  if (source === 'mangadex' || isUuid(id)) {
    const m = (await fetchJSON(`https://api.mangadex.org/manga/${id}?includes[]=cover_art`)).data;
    const feed = await fetchJSON(`https://api.mangadex.org/manga/${id}/feed?translatedLanguage[]=pt-br&translatedLanguage[]=en&order[chapter]=desc&limit=100`);
    return res.json({
      title: m.attributes.title.en || Object.values(m.attributes.title)[0],
      chapters: (feed.data || []).map(c => ({ id: c.id, title: c.attributes.title || `Capítulo ${c.attributes.chapter}`, chapterNumber: c.attributes.chapter, source: 'mangadex' })),
      source: 'mangadex'
    });
  }
  res.status(404).json({ error: 'not found' });
});

app.get('/chapter', async (req, res) => {
  const { id, source } = req.query;
  if (source === 'taiyo') {
    const url = Buffer.from(id, 'base64').toString('utf8');
    const data = await fetchJSON(url);
    return res.json({ pages: data.pages || [], source: 'taiyo' });
  }
  if (source === 'comick') return res.json({ pages: await comickGetPages(id), source: 'comick' });
  if (source === 'mangaplus') {
    const raw = await mpRaw(`/manga_viewer?chapter_id=${id}&split=yes&img_quality=super_high`);
    const viewer = readPB(pb(getSuccess(raw)[10]?.[0]));
    const pages = (viewer[1] || []).map(p => {
      const d = readPB(pb(readPB(pb(p))[1]?.[0]));
      const base = `${req.protocol}://${req.get('host')}`;
      return `${base}/image-proxy?url=${encodeURIComponent(d[1]?.[0])}${d[5]?.[0] ? '&key=' + encodeURIComponent(s(d[5][0])) : ''}`;
    });
    return res.json({ pages, source: 'mangaplus' });
  }
  if (isUuid(id)) {
    const data = await fetchJSON(`https://api.mangadex.org/at-home/server/${id}`);
    const pages = (data.chapter.data || []).map(f => `${data.baseUrl}/data/${data.chapter.hash}/${f}`);
    return res.json({ pages, source: 'mangadex' });
  }
  res.json({ pages: [] });
});

app.get('/image-proxy', async (req, res) => {
  const { url, key } = req.query;
  try {
    const { buffer, contentType } = await fetchRaw(decodeURIComponent(url), { 'Referer': new URL(decodeURIComponent(url)).origin });
    let result = buffer;
    if (key) {
      const k = Buffer.from(decodeURIComponent(key), 'hex');
      result = Buffer.from(buffer.map((b, i) => b ^ k[i % k.length]));
    }
    res.setHeader('Content-Type', contentType || 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.send(result);
  } catch (e) { res.status(500).send(e.message); }
});

app.listen(PORT, () => console.log(`Server v14.0 na porta ${PORT}`));
```[cite: 1]
