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
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
        'Referer': 'https://mangalivre.net/',
        'Origin': 'https://mangalivre.net',
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
//  PROTOBUF READER (para MangaPlus)
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

// Mapa de IDs fixos — acesse mangaplus.shueisha.co.jp/titles/XXXXXX para achar novos
const MANGA_IDS = {
  // Em serialização
  'one piece':              700005,
  'boruto two blue vortex': 100269,
  'boruto':                 100269,
  'dandadan':               100171,
  'dan da dan':             100171,
  'jujutsu kaisen':         100136,
  'chainsaw man':           100191,
  'my hero academia':       100103,
  'black clover':           100109,
  'blue lock':              100227,
  'spy x family':           100249,
  'sakamoto days':          100235,
  'kaiju no 8':             100247,
  'kaiju number 8':         100247,
  'oshi no ko':             100220,
  'kagurabachi':            100282,
  'undead unluck':          100143,
  'witch watch':            100211,
  // Clássicos
  'naruto':                 100129,
  'dragon ball':            100010,
  'dragon ball super':      100194,
  'bleach':                 100021,
  'demon slayer':           100197,
  'kimetsu no yaiba':       100197,
  'death note':             100028,
  'fullmetal alchemist':    100031,
  'haikyuu':                100060,
  'hunter x hunter':        100008,
  'assassination classroom':100050,
  'tokyo ghoul':            100095,
  'soul eater':             100042,
  'bakuman':                100020,
  'world trigger':          100079,
  // Adicione novos abaixo: 'nome em minúsculo': ID_NUMERICO,
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
      chapters.push({ id: String(c.chapterId), title: c.subTitle || `Capítulo ${c.name}`, chapterNumber: c.name, source: 'mangaplus' });
    }
  }
  return { title: titleInfo.name || '', coverUrl: titleInfo.portraitImageUrl || null, description: titleInfo.author || '', chapters, source: 'mangaplus' };
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
  // Busca exata
  if (MANGA_IDS[q]) {
    try {
      const detail = await mpGetTitle(MANGA_IDS[q]);
      if (detail.title) return [{ id: String(MANGA_IDS[q]), title: detail.title, coverUrl: detail.coverUrl, source: 'mangaplus' }];
    } catch (e) { console.warn('[MP] exato erro:', e.message); }
  }
  // Busca parcial
  const matches = Object.entries(MANGA_IDS).filter(([key]) => key.includes(q) || q.includes(key.split(' ')[0]));
  const results = [];
  for (const [, id] of matches.slice(0, 3)) {
    if (results.find(r => r.id === String(id))) continue;
    try {
      const detail = await mpGetTitle(id);
      if (detail.title) results.push({ id: String(id), title: detail.title, coverUrl: detail.coverUrl, source: 'mangaplus' });
    } catch (e) { console.warn('[MP] parcial erro:', e.message); }
  }
  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
//  MANGÁ LIVRE
// ══════════════════════════════════════════════════════════════════════════════

const ML_HEADERS = {
  'X-Requested-With': 'XMLHttpRequest',
  'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
  'Referer': 'https://mangalivre.net/',
  'Accept': 'application/json',
};

async function mlSearch(query) {
  try {
    const { buffer, status } = await fetchPOST(
      'https://mangalivre.net/api/search',
      { search: query },
    );
    if (status !== 200) { console.warn('[ML] search HTTP', status); return []; }
    const data = JSON.parse(buffer.toString());
    const series = data.series || data.data || [];
    if (!Array.isArray(series) || series.length === 0) return [];
    return series.slice(0, 10).map(s => ({
      id: String(s.id_series || s.id || ''),
      title: s.name || s.title || '',
      coverUrl: s.cover || s.image || null,
      source: 'mangalivre',
    })).filter(r => r.id && r.title);
  } catch (e) { console.warn('[ML] search erro:', e.message); return []; }
}

async function mlGetManga(seriesId) {
  try {
    const { buffer, status } = await fetchRaw(`https://mangalivre.net/api/chapters/${seriesId}`, ML_HEADERS);
    if (status !== 200) throw new Error('HTTP ' + status);
    const data = JSON.parse(buffer.toString());
    const chapters = (data.chapters || []).map(c => ({
      id: String(c.id_release || c.releases?.[Object.keys(c.releases)[0]]?.id_release || c.id || ''),
      title: c.chapter_name || `Capítulo ${c.number}`,
      chapterNumber: String(c.number || '0'),
      source: 'mangalivre',
    })).filter(c => c.id);
    return {
      title: data.name || '',
      coverUrl: data.cover || null,
      description: data.description || '',
      chapters,
      source: 'mangalivre',
    };
  } catch (e) {
    console.error('[ML] getManga erro:', e.message);
    return { title: '', description: '', chapters: [], source: 'mangalivre' };
  }
}

async function mlGetPages(releaseId) {
  try {
    const { buffer, status } = await fetchRaw(`https://mangalivre.net/api/pages/${releaseId}`, ML_HEADERS);
    if (status !== 200) throw new Error('HTTP ' + status);
    const data = JSON.parse(buffer.toString());
    const images = data.images || data.pages || [];
    return images.map(p => p.legacy || p.online || p.avif || p.url || '').filter(Boolean);
  } catch (e) {
    console.error('[ML] getPages erro:', e.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  DESCRIPTOGRAFIA MANGAPLUS
// ══════════════════════════════════════════════════════════════════════════════

function xorDecrypt(buf, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  return Buffer.from(buf.map((b, i) => b ^ key[i % key.length]));
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({ status: 'ok', version: '10.0-completo', sources: ['mangaplus', 'mangalivre', 'mangadex'] }));

// GET /search?q=...
app.get('/search', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH] "${q}"`);

  // 1. MangaPlus
  try {
    const mp = await mpSearch(q);
    if (mp.length > 0) { console.log(`[SEARCH] MangaPlus: ${mp.length}`); return res.json({ results: mp, source: 'mangaplus' }); }
  } catch (e) { console.warn('[SEARCH] MangaPlus erro:', e.message); }

  // 2. Mangá Livre
  try {
    const ml = await mlSearch(q);
    if (ml.length > 0) { console.log(`[SEARCH] MangaLivre: ${ml.length}`); return res.json({ results: ml, source: 'mangalivre' }); }
  } catch (e) { console.warn('[SEARCH] MangaLivre erro:', e.message); }

  // 3. MangaDex
  try {
    const data = await fetchJSON(`https://api.mangadex.org/manga?title=${encodeURIComponent(q)}&limit=20&order[relevance]=desc&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive`);
    if (data.data?.length > 0) {
      const results = data.data.map(m => {
        const title = m.attributes.title.en || m.attributes.title['pt-br'] || Object.values(m.attributes.title)[0] || '';
        const cover = m.relationships.find(r => r.type === 'cover_art');
        return { id: m.id, title, coverUrl: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes?.fileName}.512.jpg` : null, source: 'mangadex' };
      });
      console.log(`[SEARCH] MangaDex: ${results.length}`);
      return res.json({ results, source: 'mangadex' });
    }
  } catch (e) { console.error('[SEARCH] MangaDex erro:', e.message); }

  res.json({ results: [], source: 'none' });
});

// GET /manga?id=...&source=...
app.get('/manga', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id, source } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[MANGA] id="${id}" source="${source}"`);

  if (source === 'mangaplus' || /^\d{5,7}$/.test(id)) {
    try {
      const d = await mpGetTitle(id);
      console.log(`[MANGA] MangaPlus: "${d.title}" | ${d.chapters.length} caps`);
      return res.json({ ...d, source: 'mangaplus' });
    } catch (e) { console.error('[MANGA] MangaPlus erro:', e.message); }
  }

  if (source === 'mangalivre') {
    try {
      const d = await mlGetManga(id);
      console.log(`[MANGA] MangaLivre: "${d.title}" | ${d.chapters.length} caps`);
      return res.json(d);
    } catch (e) { console.error('[MANGA] MangaLivre erro:', e.message); }
  }

  // MangaDex
  try {
    const m = (await fetchJSON(`https://api.mangadex.org/manga/${id}?includes[]=cover_art`)).data;
    const title = m.attributes.title.en || m.attributes.title['pt-br'] || Object.values(m.attributes.title)[0] || '';
    const cover = m.relationships.find(r => r.type === 'cover_art');
    const coverUrl = cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes?.fileName}.512.jpg` : null;
    const desc = m.attributes.description?.['pt-br'] || m.attributes.description?.en || '';
    let chapters = [];
    for (const lang of ['pt-br', 'en']) {
      try {
        const cd = await fetchJSON(`https://api.mangadex.org/manga/${id}/feed?translatedLanguage[]=${lang}&order[chapter]=desc&limit=100`);
        if (cd.data?.length > 0) {
          chapters = cd.data.map(ch => ({ id: ch.id, title: ch.attributes.title || `Capítulo ${ch.attributes.chapter}`, chapterNumber: ch.attributes.chapter || '0', lang, source: 'mangadex' }));
          break;
        }
      } catch (_) {}
    }
    return res.json({ title, coverUrl, description: desc, chapters, source: 'mangadex' });
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// GET /chapter?id=...&source=...
app.get('/chapter', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id, source } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[CHAPTER] id="${id}" source="${source}"`);

  if (source === 'mangaplus' || /^\d{6,10}$/.test(id)) {
    try {
      const pageData = await mpGetPages(id);
      if (pageData.length > 0) {
        const base = `${req.protocol}://${req.get('host')}`;
        const pages = pageData.map(p => `${base}/image-proxy?url=${encodeURIComponent(p.imageUrl)}${p.encryptionKey ? '&key=' + encodeURIComponent(p.encryptionKey) : ''}`);
        console.log(`[CHAPTER] MangaPlus: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangaplus' });
      }
    } catch (e) { console.error('[CHAPTER] MangaPlus erro:', e.message); }
  }

  if (source === 'mangalivre') {
    try {
      const pages = await mlGetPages(id);
      if (pages.length > 0) { console.log(`[CHAPTER] MangaLivre: ${pages.length} páginas`); return res.json({ pages, source: 'mangalivre' }); }
    } catch (e) { console.error('[CHAPTER] MangaLivre erro:', e.message); }
  }

  if (isUuid(id)) {
    try {
      const data = await fetchJSON(`https://api.mangadex.org/at-home/server/${id}`);
      const pages = (data.chapter?.data || []).map(f => `${data.baseUrl}/data/${data.chapter.hash}/${f}`);
      if (pages.length > 0) { console.log(`[CHAPTER] MangaDex: ${pages.length} páginas`); return res.json({ pages, source: 'mangadex' }); }
    } catch (e) { console.warn('[CHAPTER] MangaDex erro:', e.message); }
  }

  res.json({ pages: [], source: 'none' });
});

// GET /image-proxy?url=...&key=...
app.get('/image-proxy', async (req, res) => {
  const { url, key } = req.query;
  if (!url) return res.status(400).send('url obrigatório');
  try {
    const { buffer, status } = await fetchRaw(decodeURIComponent(url), { 'Referer': 'https://mangaplus.shueisha.co.jp/' });
    if (status !== 200) return res.status(status).send('Erro ' + status);
    const result = key ? xorDecrypt(buffer, decodeURIComponent(key)) : buffer;
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(result);
  } catch (e) { res.status(500).send('Erro: ' + e.message); }
});

// GET /titles — lista todos os títulos mapeados no MangaPlus
app.get('/titles', (req, res) => {
  const unique = {};
  for (const [name, id] of Object.entries(MANGA_IDS)) {
    if (!unique[id]) unique[id] = { id: String(id), name };
  }
  res.json({ total: Object.keys(unique).length, titles: Object.values(unique) });
});

app.listen(PORT, () => console.log(`Proxy v10.0 (MangaPlus + MangaLivre + MangaDex) na porta ${PORT}`));
