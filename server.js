const express = require('express');
const https = require('https');
const http = require('http');
const path = require('path');
const protobuf = require('protobufjs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

function fetchRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'Mozilla/5.0', ...headers } }, (res) => {
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

function isUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ─── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ══════════════════════════════════════════════════════════════════════════════
//  MANGAPLUS — Protobuf com schema real
// ══════════════════════════════════════════════════════════════════════════════

const MP_BASE = 'https://jumpg-webapi.tokyo-cdn.com/api';
const MP_HEADERS = {
  'User-Agent': 'okhttp/4.9.0',
  'Origin': 'https://mangaplus.shueisha.co.jp',
  'Referer': 'https://mangaplus.shueisha.co.jp/',
};

let mpProto = null;  // cache do schema carregado

async function getMpProto() {
  if (mpProto) return mpProto;
  mpProto = await protobuf.load(path.join(__dirname, 'mangaplus.proto'));
  return mpProto;
}

async function mpFetch(url) {
  const root = await getMpProto();
  const Response = root.lookupType('Response');
  const { buffer } = await fetchRaw(url, MP_HEADERS);
  const msg = Response.decode(buffer);
  return Response.toObject(msg, { longs: String, enums: String, defaults: true });
}

async function mpSearch(query) {
  const data = await mpFetch(`${MP_BASE}/title_list/allV2`);
  const titles = data?.success?.allTitlesView?.titles || [];
  const q = query.toLowerCase();
  return titles
    .filter(t => t.name && t.name.toLowerCase().includes(q))
    .slice(0, 20)
    .map(t => ({
      id: String(t.titleId),
      title: t.name,
      coverUrl: t.portraitImageUrl || null,
      author: t.author || null,
      source: 'mangaplus',
    }));
}

async function mpGetTitle(titleId) {
  const data = await mpFetch(`${MP_BASE}/title_detail?title_id=${titleId}`);
  const view = data?.success?.titleDetailView;
  if (!view) throw new Error('titleDetailView não encontrado');

  const t = view.title || {};
  const rawChaps = [
    ...(view.firstChapterList || []),
    ...(view.lastChapterList || []),
  ];
  const seen = new Set();
  const chapters = rawChaps
    .filter(c => { if (seen.has(c.chapterId)) return false; seen.add(c.chapterId); return true; })
    .map(c => ({
      id: String(c.chapterId),
      title: c.subTitle || c.name || `Capítulo ${c.chapterId}`,
      chapterNumber: c.name || String(c.chapterId),
      source: 'mangaplus',
    }));

  return {
    title: t.name || '',
    coverUrl: t.portraitImageUrl || null,
    description: view.overview || '',
    chapters,
  };
}

async function mpGetPages(chapterId) {
  const data = await mpFetch(`${MP_BASE}/manga_viewer?chapter_id=${chapterId}&split=yes&img_quality=super_high`);
  const viewer = data?.success?.mangaViewer;
  if (!viewer) throw new Error('mangaViewer não encontrado');

  return (viewer.pages || [])
    .filter(p => p.mangaPage?.imageUrl)
    .map(p => ({
      imageUrl: p.mangaPage.imageUrl,
      encryptionKey: p.mangaPage.encryptionKey || null,
    }));
}

function decryptImage(buf, hexKey) {
  const keyBytes = Buffer.from(hexKey, 'hex');
  const result = Buffer.alloc(buf.length);
  for (let i = 0; i < buf.length; i++) {
    result[i] = buf[i] ^ keyBytes[i % keyBytes.length];
  }
  return result;
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => {
  res.json({ status: 'ok', version: '5.0-protobuf' });
});

// ─── GET /search?q=... ────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH] "${query}"`);

  try {
    const results = await mpSearch(query);
    if (results.length > 0) {
      console.log(`[SEARCH] MangaPlus: ${results.length}`);
      return res.json({ results, source: 'mangaplus' });
    }
  } catch (e) { console.warn('[SEARCH] MangaPlus erro:', e.message); }

  try {
    const url = `https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=20&order[relevance]=desc&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive`;
    const data = await fetchJSON(url);
    if (data.data?.length > 0) {
      const results = data.data.map(m => {
        const title = m.attributes.title.en || m.attributes.title['pt-br'] || Object.values(m.attributes.title)[0] || '';
        const cover = m.relationships.find(r => r.type === 'cover_art');
        return {
          id: m.id, title,
          coverUrl: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes?.fileName}.512.jpg` : null,
          source: 'mangadex',
        };
      });
      console.log(`[SEARCH] MangaDex: ${results.length}`);
      return res.json({ results, source: 'mangadex' });
    }
  } catch (e) { console.error('[SEARCH] MangaDex erro:', e.message); }

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
      const detail = await mpGetTitle(id);
      console.log(`[MANGA] MangaPlus: "${detail.title}" | ${detail.chapters.length} caps`);
      return res.json({ ...detail, source: 'mangaplus' });
    } catch (e) { console.error('[MANGA] MangaPlus erro:', e.message); }
  }

  try {
    const m = (await fetchJSON(`https://api.mangadex.org/manga/${id}?includes[]=cover_art`)).data;
    const title = m.attributes.title.en || m.attributes.title['pt-br'] || Object.values(m.attributes.title)[0] || '';
    const cover = m.relationships.find(r => r.type === 'cover_art');
    const coverUrl = cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes?.fileName}.512.jpg` : null;
    const desc = m.attributes.description?.['pt-br'] || m.attributes.description?.en || '';
    let chapters = [];
    for (const lang of ['pt-br', 'en']) {
      try {
        const cd = (await fetchJSON(`https://api.mangadex.org/manga/${id}/feed?translatedLanguage[]=${lang}&order[chapter]=desc&limit=100`)).data;
        if (cd.data?.length > 0) {
          chapters = cd.data.map(ch => ({
            id: ch.id,
            title: ch.attributes.title || `Capítulo ${ch.attributes.chapter}`,
            chapterNumber: ch.attributes.chapter || '0',
            lang, source: 'mangadex',
          }));
          break;
        }
      } catch (_) {}
    }
    return res.json({ title, coverUrl, description: desc, chapters, source: 'mangadex' });
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
        const pages = pageData.map(p =>
          `${base}/image-proxy?url=${encodeURIComponent(p.imageUrl)}${p.encryptionKey ? '&key=' + encodeURIComponent(p.encryptionKey) : ''}`
        );
        console.log(`[CHAPTER] MangaPlus: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangaplus' });
      }
    } catch (e) { console.error('[CHAPTER] MangaPlus erro:', e.message); }
  }

  if (isUuid(id)) {
    try {
      const data = await fetchJSON(`https://api.mangadex.org/at-home/server/${id}`);
      const pages = (data.chapter?.data || []).map(f => `${data.baseUrl}/data/${data.chapter.hash}/${f}`);
      if (pages.length > 0) {
        console.log(`[CHAPTER] MangaDex: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangadex' });
      }
    } catch (e) { console.warn('[CHAPTER] MangaDex erro:', e.message); }
  }

  res.json({ pages: [], source: 'none', error: 'Nenhuma fonte retornou páginas.' });
});

// ─── GET /image-proxy?url=...&key=... ─────────────────────────────────────────
app.get('/image-proxy', async (req, res) => {
  const { url, key } = req.query;
  if (!url) return res.status(400).send('url obrigatório');
  try {
    const { buffer, status } = await fetchRaw(decodeURIComponent(url), {
      'Referer': 'https://mangaplus.shueisha.co.jp/',
    });
    if (status !== 200) return res.status(status).send('Erro ao buscar imagem');
    const result = key ? decryptImage(buffer, decodeURIComponent(key)) : buffer;
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(result);
  } catch (e) { res.status(500).send('Erro interno: ' + e.message); }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, async () => {
  // Pré-carrega o schema proto na inicialização
  try {
    await getMpProto();
    console.log(`Manga Proxy v5 (Protobuf real) na porta ${PORT}`);
  } catch (e) {
    console.error('ERRO ao carregar mangaplus.proto:', e.message);
  }
});
