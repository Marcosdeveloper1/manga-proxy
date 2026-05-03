const express = require('express');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Helpers HTTP ──────────────────────────────────────────────────────────────

function fetchRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': 'application/json',
    };
    lib.get(url, { headers: { ...defaultHeaders, ...headers } }, (res) => {
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
  return fetchRaw(url, headers).then(r => {
    const text = r.buffer.toString('utf8');
    return { data: JSON.parse(text), status: r.status };
  });
}

function isUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ─── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ─── Health ────────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', version: '4.0-mangaplus-json' });
});

// ══════════════════════════════════════════════════════════════════════════════
//  MANGAPLUS — API oficial da Shueisha
//
//  Base: https://jumpg-api.tokyo-cdn.com/api   (app mobile, retorna JSON)
//  Todos os endpoints retornam: { "success": { ... } } ou { "error": { ... } }
//
//  IDs conhecidos:
//    One Piece      → 700005
//    Naruto         → 700007  (encerrado, capítulos disponíveis)
//    Boruto         → 700011
//    Demon Slayer   → 700016
//    Jujutsu Kaisen → 700030
//    Chainsaw Man   → 700054
//    Dan Da Dan     → 700061
// ══════════════════════════════════════════════════════════════════════════════

const MP_BASE = 'https://jumpg-api.tokyo-cdn.com/api';
const MP_HEADERS = {
  'User-Agent': 'okhttp/4.9.0',         // imita o app Android
  'Accept': 'application/json',
  'Origin': 'https://mangaplus.shueisha.co.jp',
  'Referer': 'https://mangaplus.shueisha.co.jp/',
};

// Busca todos os títulos do MangaPlus e filtra pelo query
async function mpSearch(query) {
  const url = `${MP_BASE}/title_list/allV2?format=json`;
  const { data } = await fetchJSON(url, MP_HEADERS);

  // Estrutura: data.success.allTitlesView.titles  OU  data.success.titleGroups[].titles
  const success = data?.success;
  if (!success) throw new Error('MangaPlus: sem success no allV2');

  let allTitles = [];

  // Tenta allTitlesView
  if (success.allTitlesView?.titles) {
    allTitles = success.allTitlesView.titles;
  }
  // Tenta titleGroups (formato V2)
  else if (success.titleGroups) {
    for (const group of success.titleGroups) {
      if (group.titles) allTitles.push(...group.titles);
    }
  }
  // Tenta allTitlesGroup (formato alternativo)
  else if (success.allTitlesGroup) {
    for (const group of success.allTitlesGroup) {
      if (group.titles) allTitles.push(...group.titles);
    }
  }

  const q = query.toLowerCase();
  return allTitles
    .filter(t => t.name && t.name.toLowerCase().includes(q))
    .slice(0, 20)
    .map(t => ({
      id: String(t.titleId),
      title: t.name,
      coverUrl: t.portraitImageUrl || t.thumbnailUrl || null,
      author: t.author || null,
      source: 'mangaplus',
    }));
}

// Busca detalhes de um título pelo ID
async function mpGetTitle(titleId) {
  const url = `${MP_BASE}/title_detail?title_id=${titleId}&format=json`;
  const { data } = await fetchJSON(url, MP_HEADERS);

  const success = data?.success;
  if (!success) throw new Error(`MangaPlus: sem success para title ${titleId}`);

  const view = success.titleDetailView || success;
  const t = view.title || {};

  const title = t.name || '';
  const coverUrl = t.portraitImageUrl || t.thumbnailUrl || null;
  const description = view.overview || view.viewingPeriodDescription || '';

  // Capítulos: firstChapterList + lastChapterList
  const rawChapters = [
    ...(view.firstChapterList || []),
    ...(view.lastChapterList || []),
    ...(view.chapterListGroup?.flatMap(g => [...(g.firstChapterList||[]), ...(g.lastChapterList||[])]) || []),
  ];

  // Remove duplicatas por chapterId
  const seen = new Set();
  const chapters = rawChapters
    .filter(c => { if (seen.has(c.chapterId)) return false; seen.add(c.chapterId); return true; })
    .map(c => ({
      id: String(c.chapterId),
      title: c.name || `Capítulo ${c.chapterNumber || c.name}`,
      chapterNumber: String(c.chapterNumber || c.name || '0'),
      isAvailable: !c.isVerticalOnly,  // alguns caps só no app pago
      source: 'mangaplus',
    }));

  return { title, coverUrl, description, chapters };
}

// Busca páginas de um capítulo (com encryptionKey para XOR)
async function mpGetPages(chapterId) {
  const url = `${MP_BASE}/manga_viewer?chapter_id=${chapterId}&split=yes&img_quality=super_high&format=json`;
  const { data } = await fetchJSON(url, MP_HEADERS);

  const success = data?.success;
  if (!success) throw new Error(`MangaPlus: sem success para chapter ${chapterId}`);

  const viewer = success.mangaViewer || success;
  const pagesRaw = viewer.pages || [];

  const pages = pagesRaw
    .filter(p => p.mangaPage)
    .map(p => ({
      imageUrl: p.mangaPage.imageUrl,
      encryptionKey: p.mangaPage.encryptionKey || null,
    }))
    .filter(p => p.imageUrl);

  return pages;
}

// Descriptografa imagem MangaPlus com XOR
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

// ─── GET /search?q=... ────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH] "${query}"`);

  // 1. MangaPlus (fonte principal — tem One Piece, Naruto, etc.)
  try {
    const results = await mpSearch(query);
    if (results.length > 0) {
      console.log(`[SEARCH] MangaPlus: ${results.length} resultados`);
      return res.json({ results, source: 'mangaplus' });
    }
    console.log('[SEARCH] MangaPlus: 0 resultados, tentando MangaDex');
  } catch (e) {
    console.warn('[SEARCH] MangaPlus erro:', e.message);
  }

  // 2. MangaDex (fallback para títulos não na Shueisha)
  try {
    const url = `https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=20&order[relevance]=desc&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive`;
    const { data } = await fetchJSON(url);
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
      console.log(`[SEARCH] MangaDex: ${results.length} resultados`);
      return res.json({ results, source: 'mangadex' });
    }
  } catch (e) {
    console.error('[SEARCH] MangaDex erro:', e.message);
  }

  res.json({ results: [], source: 'none' });
});

// ─── GET /manga?id=...&source=... ─────────────────────────────────────────────
app.get('/manga', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id, source } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[MANGA] id="${id}" source="${source}"`);

  // MangaPlus: IDs numéricos (ex: 700005)
  if (source === 'mangaplus' || /^\d{5,7}$/.test(id)) {
    try {
      const detail = await mpGetTitle(id);
      if (detail.title) {
        console.log(`[MANGA] MangaPlus: "${detail.title}" | ${detail.chapters.length} caps`);
        return res.json({ ...detail, source: 'mangaplus' });
      }
    } catch (e) {
      console.error('[MANGA] MangaPlus erro:', e.message);
    }
  }

  // MangaDex: UUIDs
  try {
    const m = (await fetchJSON(`https://api.mangadex.org/manga/${id}?includes[]=cover_art`)).data.data;
    const title = m.attributes.title.en || m.attributes.title['pt-br'] || Object.values(m.attributes.title)[0] || '';
    const cover = m.relationships.find(r => r.type === 'cover_art');
    const coverUrl = cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes?.fileName}.512.jpg` : null;
    const desc = m.attributes.description?.['pt-br'] || m.attributes.description?.en || '';

    let chapters = [];
    for (const lang of ['pt-br', 'en']) {
      try {
        const chapData = (await fetchJSON(
          `https://api.mangadex.org/manga/${id}/feed?translatedLanguage[]=${lang}&order[chapter]=desc&limit=100`
        )).data;
        if (chapData.data?.length > 0) {
          chapters = chapData.data.map(ch => ({
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
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─── GET /chapter?id=...&source=... ───────────────────────────────────────────
app.get('/chapter', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id, source } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[CHAPTER] id="${id}" source="${source}"`);

  // MangaPlus: IDs numéricos longos (ex: 1000001)
  if (source === 'mangaplus' || /^\d{6,10}$/.test(id)) {
    try {
      const pageData = await mpGetPages(id);
      if (pageData.length > 0) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const pages = pageData.map(p =>
          `${baseUrl}/image-proxy?url=${encodeURIComponent(p.imageUrl)}${p.encryptionKey ? '&key=' + encodeURIComponent(p.encryptionKey) : ''}`
        );
        console.log(`[CHAPTER] MangaPlus: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangaplus' });
      }
    } catch (e) {
      console.error('[CHAPTER] MangaPlus erro:', e.message);
    }
  }

  // MangaDex: UUIDs
  if (isUuid(id)) {
    try {
      const data = (await fetchJSON(`https://api.mangadex.org/at-home/server/${id}`)).data;
      const base = data.baseUrl, hash = data.chapter?.hash;
      const pages = (data.chapter?.data || []).map(f => `${base}/data/${hash}/${f}`);
      if (pages.length > 0) {
        console.log(`[CHAPTER] MangaDex: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangadex' });
      }
    } catch (e) {
      console.warn('[CHAPTER] MangaDex erro:', e.message);
    }
  }

  res.json({ pages: [], source: 'none', error: 'Nenhuma fonte retornou páginas.' });
});

// ─── GET /image-proxy?url=...&key=... ─────────────────────────────────────────
// Baixa imagem do MangaPlus, descriptografa com XOR e serve como JPEG
app.get('/image-proxy', async (req, res) => {
  const { url, key } = req.query;
  if (!url) return res.status(400).send('url obrigatório');

  try {
    const { buffer, status } = await fetchRaw(decodeURIComponent(url), {
      'User-Agent': 'okhttp/4.9.0',
      'Referer': 'https://mangaplus.shueisha.co.jp/',
    });
    if (status !== 200) return res.status(status).send('Erro ao buscar imagem');

    const decrypted = key ? decryptImage(buffer, decodeURIComponent(key)) : buffer;
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(decrypted);
  } catch (e) {
    console.error('[IMAGE-PROXY] erro:', e.message);
    res.status(500).send('Erro interno');
  }
});

// ─── GET /mangaplus/popular ────────────────────────────────────────────────────
// Lista os títulos populares do MangaPlus (útil para tela inicial do app)
app.get('/mangaplus/popular', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const url = `${MP_BASE}/title_list/ranking?format=json`;
    const { data } = await fetchJSON(url, MP_HEADERS);
    const success = data?.success;
    const titles = (success?.titleRankingView?.titles || []).map(t => ({
      id: String(t.titleId),
      title: t.name,
      coverUrl: t.portraitImageUrl || t.thumbnailUrl || null,
      source: 'mangaplus',
    }));
    res.json({ titles, source: 'mangaplus' });
  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Manga Proxy v4 (MangaPlus JSON) na porta ${PORT}`);
});
