const express = require('express');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════════════════════
//  CACHE EM MEMÓRIA
// ══════════════════════════════════════════════════════════════════════════════

const _cache = new Map();
const TTL_SHORT = 10 * 60 * 1000;
const TTL_LONG  = 60 * 60 * 1000;

function cached(key, fn, ttl = TTL_SHORT) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < hit.ttl) return Promise.resolve(hit.value);
  return fn().then(v => { _cache.set(key, { value: v, ts: Date.now(), ttl }); return v; });
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache.entries()) if (now - v.ts > v.ttl) _cache.delete(k);
}, 20 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════════════════
//  HTTP HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_TIMEOUT = 10000;

function fetchRaw(url, headers = {}, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'okhttp/4.9.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location)
        return fetchRaw(res.headers.location, headers, timeoutMs).then(resolve).catch(reject);
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), status: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout: ${url}`)); });
  });
}

function fetchJSON(url, headers = {}, timeoutMs = DEFAULT_TIMEOUT) {
  return fetchRaw(url, { Accept: 'application/json', ...headers }, timeoutMs)
    .then(r => JSON.parse(r.buffer.toString('utf8')));
}

function isUuid(s) { return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s); }

app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ══════════════════════════════════════════════════════════════════════════════
//  PROTOBUF READER MANUAL (sem dependências — para MangaPlus)
// ══════════════════════════════════════════════════════════════════════════════

function readPB(buf) {
  const fields = {};
  let pos = 0;
  function varint() { let v=0,shift=0,b; do{b=buf[pos++];v|=(b&0x7f)<<shift;shift+=7;}while(b&0x80); return v; }
  while (pos < buf.length) {
    try {
      const tag = varint(); if(!tag) break;
      const fn = tag>>>3, wt = tag&7;
      if (!fields[fn]) fields[fn] = [];
      if      (wt===0) fields[fn].push(varint());
      else if (wt===2) { const len=varint(); fields[fn].push(buf.slice(pos,pos+len)); pos+=len; }
      else if (wt===1) pos+=8;
      else if (wt===5) pos+=4;
      else break;
    } catch { break; }
  }
  return fields;
}

const s  = b => Buffer.from(b).toString('utf8');
const pb = b => Buffer.from(b);

const MP     = 'https://jumpg-webapi.tokyo-cdn.com/api';
const MP_HDR = { 'Origin': 'https://mangaplus.shueisha.co.jp', 'Referer': 'https://mangaplus.shueisha.co.jp/' };

async function mpRaw(path) {
  const { buffer, status } = await fetchRaw(`${MP}${path}`, MP_HDR, 20000);
  if (status !== 200) throw new Error(`MangaPlus HTTP ${status} para ${path}`);
  // Detecta resposta HTML (erro/bloqueio) em vez de Protobuf
  const preview = buffer.slice(0, 20).toString('utf8');
  if (preview.startsWith('<!') || preview.startsWith('<h') || preview.startsWith('{')) {
    throw new Error(`MangaPlus: resposta inesperada (não-Protobuf): ${preview.slice(0,40)}`);
  }
  console.log(`[MP] ${path} → ${buffer.length} bytes, hex4=${buffer.slice(0,4).toString('hex')}`);
  return buffer;
}

function getSuccess(raw) {
  const resp = readPB(raw);
  const topKeys = Object.keys(resp).join(',');
  const sb = resp[1]?.[0];
  if (!sb) {
    // Log detalhado: tamanho, primeiros bytes, fields encontrados
    const hex = raw.slice(0, 16).toString('hex');
    throw new Error(`MangaPlus: success não encontrado. size=${raw.length} hex=${hex} topFields=${topKeys}`);
  }
  return readPB(pb(sb));
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
    name:      f[3]?.[0] ? s(f[3][0]) : '',
    subTitle:  f[4]?.[0] ? s(f[4][0]) : '',
  };
}

function decodePage(b) {
  const f = readPB(pb(b));
  return {
    imageUrl:      f[1]?.[0] ? s(f[1][0]) : '',
    encryptionKey: f[5]?.[0] ? s(f[5][0]) : '',
  };
}

function xorDecrypt(buf, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  return Buffer.from(buf.map((b, i) => b ^ key[i % key.length]));
}

async function mpSearch(query) {
  return cached(`mp:search:${query}`, async () => {
    const raw = await mpRaw('/title_list/allV3?language=0');
    const success = getSuccess(raw);
    const atv = success[4]?.[0];
    if (!atv) return [];
    const titles = readPB(pb(atv))[1] || [];
    const q = query.toLowerCase();
    return titles.map(decodeTitle)
      .filter(t => t.name?.toLowerCase().includes(q))
      .slice(0, 20)
      .map(t => ({ id: String(t.titleId), title: t.name, coverUrl: t.portraitImageUrl || null, source: 'mangaplus' }));
  }, TTL_LONG);
}

async function mpGetTitle(titleId) {
  return cached(`mp:manga:${titleId}`, async () => {
    const raw = await mpRaw(`/title_detail_v3?title_id=${titleId}&language=0`);
    const success = getSuccess(raw);
    const tdv = success[8]?.[0];
    if (!tdv) throw new Error('titleDetailView não encontrado');
    const detail = readPB(pb(tdv));
    const titleInfo = detail[1]?.[0] ? decodeTitle(detail[1][0]) : {};
    const chapters = [];
    const seen = new Set();
    for (const groupBuf of (detail[28] || [])) {
      const group = readPB(pb(groupBuf));
      for (const c of [...(group[2]||[]).map(decodeChapter), ...(group[4]||[]).map(decodeChapter)]) {
        if (!c.chapterId || seen.has(c.chapterId)) continue;
        seen.add(c.chapterId);
        chapters.push({ id: String(c.chapterId), title: c.subTitle || `Capítulo ${c.name}`, chapterNumber: c.name || String(c.chapterId), source: 'mangaplus' });
      }
    }
    return { title: titleInfo.name||'', coverUrl: titleInfo.portraitImageUrl||null, description: titleInfo.author||'', chapters };
  });
}

async function mpGetPages(chapterId) {
  return cached(`mp:pages:${chapterId}`, async () => {
    const raw = await mpRaw(`/manga_viewer?chapter_id=${chapterId}&split=yes&img_quality=super_high`);
    const success = getSuccess(raw);
    const viewer = success[10]?.[0];
    if (!viewer) throw new Error('mangaViewer não encontrado');
    return (readPB(pb(viewer))[1] || []).map(pb2 => {
      const page = readPB(pb(Buffer.from(pb2)));
      const mp2 = page[1]?.[0];
      return mp2 ? decodePage(mp2) : null;
    }).filter(p => p?.imageUrl);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  MANGADEX
// ══════════════════════════════════════════════════════════════════════════════

const MDX    = 'https://api.mangadex.org';
const COVERS = 'https://uploads.mangadex.org/covers';

function mdxCover(id, fileName) { return fileName ? `${COVERS}/${id}/${fileName}.512.jpg` : null; }
function mdxTitle(attrs) { return attrs.title['pt-br'] || attrs.title.en || Object.values(attrs.title)[0] || ''; }
function mdxDesc(attrs)  { return attrs.description?.['pt-br'] || attrs.description?.en || ''; }

async function mdxSearch(query) {
  return cached(`mdx:search:${query}`, async () => {
    const data = await fetchJSON(
      `${MDX}/manga?title=${encodeURIComponent(query)}&limit=20&order[relevance]=desc` +
      `&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive` +
      `&availableTranslatedLanguage[]=pt-br&availableTranslatedLanguage[]=en`
    );
    return (data.data || []).map(m => {
      const cover = m.relationships.find(r => r.type === 'cover_art');
      return { id: m.id, title: mdxTitle(m.attributes), coverUrl: mdxCover(m.id, cover?.attributes?.fileName), source: 'mangadex' };
    });
  }, TTL_SHORT);
}

async function mdxGetManga(mangaId) {
  return cached(`mdx:manga:${mangaId}`, async () => {
    const [metaRes, chapPtRes] = await Promise.allSettled([
      fetchJSON(`${MDX}/manga/${mangaId}?includes[]=cover_art`),
      fetchJSON(`${MDX}/manga/${mangaId}/feed?translatedLanguage[]=pt-br&order[chapter]=asc&limit=500`),
    ]);
    if (metaRes.status === 'rejected') throw metaRes.reason;
    const m = metaRes.value.data;
    const cover = m.relationships.find(r => r.type === 'cover_art');
    let chapters = [], lang = 'pt-br';
    if (chapPtRes.status === 'fulfilled' && chapPtRes.value.data?.length > 0) {
      chapters = chapPtRes.value.data.map(ch => ({ id: ch.id, title: ch.attributes.title || `Capítulo ${ch.attributes.chapter}`, chapterNumber: ch.attributes.chapter || '0', lang: 'pt-br', source: 'mangadex' }));
    } else {
      lang = 'en';
      try {
        const en = await fetchJSON(`${MDX}/manga/${mangaId}/feed?translatedLanguage[]=en&order[chapter]=asc&limit=500`);
        chapters = (en.data || []).map(ch => ({ id: ch.id, title: ch.attributes.title || `Chapter ${ch.attributes.chapter}`, chapterNumber: ch.attributes.chapter || '0', lang: 'en', source: 'mangadex' }));
      } catch (_) {}
    }
    return { title: mdxTitle(m.attributes), coverUrl: mdxCover(m.id, cover?.attributes?.fileName), description: mdxDesc(m.attributes), lang, chapters, source: 'mangadex' };
  });
}

async function mdxGetPages(chapterId) {
  return cached(`mdx:pages:${chapterId}`, async () => {
    const data = await fetchJSON(`${MDX}/at-home/server/${chapterId}`);
    return (data.chapter?.data || []).map(f => `${data.baseUrl}/data/${data.chapter.hash}/${f}`);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({ status: 'ok', version: '15.1-debug', sources: ['mangaplus', 'mangadex'] }));

// ─── GET /search?q=... ────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH] "${q}"`);

  // 1. MangaPlus (Shueisha: One Piece, Naruto, etc.)
  try {
    const results = await mpSearch(q);
    if (results.length > 0) { console.log(`[SEARCH] MangaPlus: ${results.length}`); return res.json({ results, source: 'mangaplus' }); }
  } catch (e) { console.warn('[SEARCH] MangaPlus:', e.message); }

  // 2. MangaDex (PT-BR preferencial)
  try {
    const results = await mdxSearch(q);
    if (results.length > 0) { console.log(`[SEARCH] MangaDex: ${results.length}`); return res.json({ results, source: 'mangadex' }); }
  } catch (e) { console.error('[SEARCH] MangaDex:', e.message); }

  res.json({ results: [], source: 'none' });
});

// ─── GET /manga?id=...&source=... ─────────────────────────────────────────────
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
    } catch (e) { console.error('[MANGA] MangaPlus:', e.message); }
  }

  try {
    const d = await mdxGetManga(id);
    console.log(`[MANGA] MangaDex: "${d.title}" | ${d.chapters.length} caps`);
    return res.json(d);
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ─── GET /chapter?id=...&source=... ───────────────────────────────────────────
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
        const pages = pageData.map(p => `${base}/image-proxy?url=${encodeURIComponent(p.imageUrl)}${p.encryptionKey ? '&key='+encodeURIComponent(p.encryptionKey) : ''}`);
        console.log(`[CHAPTER] MangaPlus: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangaplus' });
      }
    } catch (e) { console.error('[CHAPTER] MangaPlus:', e.message); }
  }

  if (isUuid(id)) {
    try {
      const pages = await mdxGetPages(id);
      if (pages.length > 0) { console.log(`[CHAPTER] MangaDex: ${pages.length} páginas`); return res.json({ pages, source: 'mangadex' }); }
    } catch (e) { console.warn('[CHAPTER] MangaDex:', e.message); }
  }

  res.json({ pages: [], source: 'none', error: 'Nenhuma fonte retornou páginas.' });
});

// ─── GET /image-proxy?url=...&key=... ─────────────────────────────────────────
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

// ─── GET /home ─────────────────────────────────────────────────────────────────
// Seções da tela inicial: MangaPlus populares + PT-BR recentes + Manhwa PT-BR
app.get('/home', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const [mpRes, recentRes, manhwaRes] = await Promise.allSettled([
    // MangaPlus — lista completa filtrada pelos mais conhecidos
    cached('home:mangaplus', async () => {
      const raw = await mpRaw('/title_list/allV3?language=0');
      const success = getSuccess(raw);
      const atv = success[4]?.[0];
      if (!atv) return [];
      return (readPB(pb(atv))[1] || []).slice(0, 30).map(decodeTitle).map(t => ({ id: String(t.titleId), title: t.name, coverUrl: t.portraitImageUrl||null, source: 'mangaplus' }));
    }, TTL_LONG),
    // MangaDex — lançamentos recentes PT-BR
    cached('home:recent_ptbr', () => fetchJSON(
      `${MDX}/manga?limit=20&order[latestUploadedChapter]=desc` +
      `&availableTranslatedLanguage[]=pt-br&includes[]=cover_art` +
      `&contentRating[]=safe&contentRating[]=suggestive`
    ).then(data => (data.data||[]).map(m => {
      const cover = m.relationships.find(r => r.type === 'cover_art');
      return { id: m.id, title: mdxTitle(m.attributes), coverUrl: mdxCover(m.id, cover?.attributes?.fileName), source: 'mangadex' };
    })), TTL_SHORT),
    // MangaDex — manhwa/manhua PT-BR mais seguidos
    cached('home:manhwa_ptbr', () => fetchJSON(
      `${MDX}/manga?limit=20&order[followedCount]=desc` +
      `&originalLanguage[]=ko&originalLanguage[]=zh&availableTranslatedLanguage[]=pt-br` +
      `&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive`
    ).then(data => (data.data||[]).map(m => {
      const cover = m.relationships.find(r => r.type === 'cover_art');
      return { id: m.id, title: mdxTitle(m.attributes), coverUrl: mdxCover(m.id, cover?.attributes?.fileName), source: 'mangadex' };
    })), TTL_LONG),
  ]);

  res.json({
    mangaplus:    mpRes.status      === 'fulfilled' ? mpRes.value      : [],
    recent_ptbr:  recentRes.status  === 'fulfilled' ? recentRes.value  : [],
    manhwa_ptbr:  manhwaRes.status  === 'fulfilled' ? manhwaRes.value  : [],
  });
});

// ══════════════════════════════════════════════════════════════════════════════
//  WARM CACHE
// ══════════════════════════════════════════════════════════════════════════════

async function warmCache() {
  console.log('[CACHE] Aquecendo...');
  await Promise.allSettled([
    mpSearch('one piece'),   // força load do allV3 do MangaPlus
    mdxSearch('naruto'),
    mdxSearch('shounen'),
  ]);
  console.log('[CACHE] Pronto.');
}

app.listen(PORT, () => {
  console.log(`Proxy v15.1-debug na porta ${PORT}`);
  setTimeout(warmCache, 3000);
});
