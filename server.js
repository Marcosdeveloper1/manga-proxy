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
    lib.get(url, { headers: { 'User-Agent': 'okhttp/4.9.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRaw(res.headers.location, headers).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), status: res.statusCode }));
    }).on('error', reject);
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

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ══════════════════════════════════════════════════════════════════════════════
//  PROTOBUF READER
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
    'Accept-Language': 'pt-BR,pt;q=0.9,en;q=0.8',
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
  if (!successBuf) throw new Error('sem success. buffer size: ' + raw.length);
  return readPB(pb(successBuf));
}

function decodeTitle(b) {
  const f = readPB(pb(b));
  return {
    titleId: f[1]?.[0] || 0,
    name: f[2]?.[0] ? s(f[2][0]) : '',
    author: f[3]?.[0] ? s(f[3][0]) : '',
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

function decodePage(b) {
  const f = readPB(pb(b));
  return {
    imageUrl: f[1]?.[0] ? s(f[1][0]) : '',
    encryptionKey: f[5]?.[0] ? s(f[5][0]) : '',
  };
}

const MANGA_IDS = {
  'one piece': 700005, 'boruto two blue vortex': 100269, 'boruto': 100269, 'dandadan': 100171,
  'dan da dan': 100171, 'jujutsu kaisen': 100136, 'chainsaw man': 100191, 'my hero academia': 100103,
  'blue lock': 100227, 'spy x family': 100249, 'sakamoto days': 100235, 'kaiju no 8': 100247,
  'kaiju number 8': 100247, 'oshi no ko': 100220, 'kagurabachi': 100282, 'undead unluck': 100143,
  'witch watch': 100211, 'akane-banashi': 100185, 'naruto': 100018, 'dragon ball': 200010,
  'dragon ball super': 100012, 'bleach': 100004, 'death note': 100008, 'demon slayer': 100197,
  'kimetsu no yaiba': 100197, 'fullmetal alchemist': 100031, 'haikyuu': 100060, 'hunter x hunter': 100007,
  'assassination classroom': 100050, 'tokyo ghoul': 100095, 'soul eater': 100042, 'bakuman': 100020,
  'black clover': 100003, 'world trigger': 100079, 'boruto naruto next generations': 100006,
};

async function mpGetTitle(titleId) {
  const raw = await mpRaw(`/title_detail_v3?title_id=${titleId}&language=0`);
  const success = getSuccess(raw);
  const tdv = success[8]?.[0];
  if (!tdv) throw new Error('sem titleDetailView');
  const detail = readPB(pb(tdv));
  const titleInfo = detail[1]?.[0] ? decodeTitle(detail[1][0]) : {};
  const chapters = [];
  const seen = new Set();
  for (const groupBuf of (detail[28] || [])) {
    const group = readPB(pb(groupBuf));
    for (const c of [...(group[2] || []).map(decodeChapter), ...(group[4] || []).map(decodeChapter)]) {
      if (!c.chapterId || seen.has(c.chapterId)) continue;
      seen.add(c.chapterId);
      chapters.push({
        id: String(c.chapterId),
        title: c.subTitle || `Capítulo ${c.name}`,
        chapterNumber: c.name,
        source: 'mangaplus'
      });
    }
  }
  return {
    title: titleInfo.name || '',
    coverUrl: titleInfo.portraitImageUrl || null,
    description: titleInfo.author || '',
    chapters,
    source: 'mangaplus'
  };
}

async function mpGetPages(chapterId) {
  const raw = await mpRaw(`/manga_viewer?chapter_id=${chapterId}&split=yes&img_quality=super_high`);
  const success = getSuccess(raw);
  const viewer = success[10]?.[0];
  if (!viewer) throw new Error('sem mangaViewer');
  const pages = readPB(pb(viewer))[1] || [];
  return pages.map(p => {
    const page = readPB(Buffer.from(p));
    const mp = page[1]?.[0];
    return mp ? decodePage(mp) : null;
  }).filter(p => p?.imageUrl);
}

async function mpSearch(query) {
  const q = query.toLowerCase().trim();
  if (MANGA_IDS[q]) {
    try {
      const detail = await mpGetTitle(MANGA_IDS[q]);
      if (detail.title) return [{ id: String(MANGA_IDS[q]), title: detail.title, coverUrl: detail.coverUrl, source: 'mangaplus' }];
    } catch (e) { console.warn('[MP] exato erro:', e.message); }
  }
  const matches = Object.entries(MANGA_IDS).filter(([key]) =>
    key.includes(q) || q.includes(key) || key.split(' ').some(w => w.length > 3 && q.includes(w))
  );
  const results = [];
  for (const [, id] of matches.slice(0, 5)) {
    if (results.find(r => r.id === String(id))) continue;
    try {
      const detail = await mpGetTitle(id);
      if (detail.title) results.push({ id: String(id), title: detail.title, coverUrl: detail.coverUrl, source: 'mangaplus' });
    } catch (e) { console.warn('[MP] parcial erro:', e.message); }
  }
  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMICK
// ══════════════════════════════════════════════════════════════════════════════

const COMICK_BASE = 'https://comick-source-api.notaspider.dev/api';

async function comickSearch(query) {
  try {
    console.log(`[COMICK] Buscando: "${query}"`);
    const response = await fetchPOST(
      `${COMICK_BASE}/search`,
      { query: query, source: "all" }
    );
    const text = response.buffer.toString('utf8');
    const results = [];
    const jsonObjects = text.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || [];
    
    for (const jsonStr of jsonObjects) {
      try {
        const obj = JSON.parse(jsonStr);
        if (obj.results && Array.isArray(obj.results)) {
          results.push(...obj.results.map(item => ({
            id: item.id,
            title: item.title,
            coverUrl: item.coverImage,
            url: item.url,
            latestChapter: item.latestChapter,
            source: 'comick'
          })));
        }
      } catch (e) {}
    }
    return results.slice(0, 20);
  } catch (e) {
    console.error('[COMICK] erro:', e.message);
    return [];
  }
}

async function comickGetManga(mangaId) {
  try {
    const searchResp = await fetchPOST(`${COMICK_BASE}/search`, { query: mangaId, source: "all" });
    const searchText = searchResp.buffer.toString('utf8');
    const searchObjects = searchText.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || [];
    
    let mangaUrl = null, title = mangaId;
    for (const jsonStr of searchObjects) {
      try {
        const obj = JSON.parse(jsonStr);
        if (obj.results && obj.results[0]) {
          mangaUrl = obj.results[0].url;
          title = obj.results[0].title;
          break;
        }
      } catch {}
    }
    
    if (!mangaUrl) return { title, chapters: [], source: 'comick' };

    const chaptersResp = await fetchPOST(`${COMICK_BASE}/chapters`, { url: mangaUrl });
    const chaptersText = chaptersResp.buffer.toString('utf8');
    const chaptersObjects = chaptersText.match(/\{[^{}]*(?:\{[^{}]*\}[^{}]*)*\}/g) || [];
    
    let chapters = [];
    for (const jsonStr of chaptersObjects) {
      try {
        const obj = JSON.parse(jsonStr);
        if (obj.chapters) {
          chapters = obj.chapters.map(c => ({
            id: Buffer.from(c.url).toString('base64'), 
            title: c.title || `Cap ${c.number}`,
            chapterNumber: c.number,
            source: 'comick'
          }));
          break;
        }
      } catch {}
    }
    return { title, chapters, source: 'comick' };
  } catch (e) { return { title: mangaId, chapters: [], source: 'comick' }; }
}

async function comickGetPages(chapterHid) {
  try {
    // Decodifica base64 → URL do capítulo
    const chapterUrl = Buffer.from(chapterHid, 'base64').toString('utf8');
    console.log(`[COMICK] Lendo capítulo: ${chapterUrl}`);
    
    // Faz request na URL do capítulo (mistscans.com, etc)
    const { buffer } = await fetchRaw(chapterUrl, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36'
    });
    
    const html = buffer.toString('utf8');
    
    // Extrai URLs das imagens (padrão comum nos sites de scan)
    const imgUrls = [];
    const imgMatches = html.match(/https:\/\/[^"]+\.(jpg|jpeg|png|webp|gif)(?:\?[^"]*)?/gi) || [];
    
    for (const url of imgMatches) {
      // Filtra só imagens de mangá (tamanho grande, não thumbnails)
      if (url.includes('thumb') || url.includes('avatar') || url.length < 50) continue;
      imgUrls.push(url);
    }
    
    console.log(`[COMICK] ${imgUrls.length} imagens extraídas`);
    return imgUrls.slice(0, 100); // Limita pra não crashar
    
  } catch (e) {
    console.error('[COMICK] getPages erro:', e.message);
    return [];
  }
}
// ══════════════════════════════════════════════════════════════════════════════
//  ANILIST / MANGADEX / ROTAS (Mantidos conforme lógica original)
// ══════════════════════════════════════════════════════════════════════════════

async function anilistSearch(query) {
  const gql = `query ($search: String) { Page(page: 1, perPage: 10) { media(search: $search, type: MANGA) { id title { romaji english } coverImage { large } } } }`;
  try {
    const { buffer } = await fetchPOST('https://graphql.anilist.co', { query: gql, variables: { search: query } });
    const json = JSON.parse(buffer.toString());
    return (json.data?.Page?.media || []).map(m => ({ id: `al:${m.id}`, title: m.title.english || m.title.romaji, coverUrl: m.coverImage.large, source: 'anilist' }));
  } catch { return []; }
}

async function mdxSearch(query) {
  const data = await fetchJSON(`https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=20&includes[]=cover_art`);
  return (data.data || []).map(m => ({ id: m.id, title: m.attributes.title.en || Object.values(m.attributes.title)[0], source: 'mangadex' }));
}

function xorDecrypt(buf, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  return Buffer.from(buf.map((b, i) => b ^ key[i % key.length]));
}

app.get('/search', async (req, res) => {
  const { q, source } = req.query;
  if (!q) return res.status(400).json({ error: 'q obrigatório' });
  if (source === 'comick') return res.json({ results: await comickSearch(q), source: 'comick' });
  const mp = await mpSearch(q);
  if (mp.length > 0) return res.json({ results: mp, source: 'mangaplus' });
  res.json({ results: await comickSearch(q), source: 'comick' });
});

app.get('/manga', async (req, res) => {
  const { id, source, url } = req.query;
  if (source === 'comick') return res.json(await comickGetManga(id));
  if (source === 'mangaplus') return res.json(await mpGetTitle(id));
  res.status(404).json({ error: 'not found' });
});

app.get('/chapter', async (req, res) => {
  const { id, source } = req.query;
  if (source === 'comick') return res.json({ pages: await comickGetPages(id), source: 'comick' });
  if (source === 'mangaplus') {
    const p = await mpGetPages(id);
    const base = `${req.protocol}://${req.get('host')}`;
    return res.json({ pages: p.map(pg => `${base}/image-proxy?url=${encodeURIComponent(pg.imageUrl)}&key=${encodeURIComponent(pg.encryptionKey)}`), source: 'mangaplus' });
  }
  res.json({ pages: [] });
});

app.get('/image-proxy', async (req, res) => {
  const { url, key } = req.query;
  try {
    const { buffer } = await fetchRaw(decodeURIComponent(url), { 'Referer': 'https://mangaplus.shueisha.co.jp/' });
    const result = key ? xorDecrypt(buffer, decodeURIComponent(key)) : buffer;
    res.setHeader('Content-Type', 'image/jpeg');
    res.send(result);
  } catch { res.status(500).send('error'); }
});

app.listen(PORT, () => console.log(`Rodando na porta ${PORT}`));
