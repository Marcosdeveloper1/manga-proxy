const express = require('express');
const https = require('https');
const http = require('http');
const protobuf = require('protobufjs');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── HTTP helpers ──────────────────────────────────────────────────────────────

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

function isUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ─── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  next();
});

// ══════════════════════════════════════════════════════════════════════════════
//  MANGAPLUS — Protobuf sem schema (Reader direto do protobufjs)
//
//  A API retorna: Response { success(1): SuccessResult }
//  SuccessResult tem vários oneofs. Lemos campo a campo sem schema.
//  Referência de field numbers vinda do mloader + hakuneko:
//    Response.success            = field 1 (message)
//    SuccessResult.allTitlesView = field 4 (message)
//    SuccessResult.titleDetail   = field 8 (message)
//    SuccessResult.mangaViewer   = field 10 (message)
//    AllTitlesView.titles        = field 1 (repeated message)
//    Title.titleId               = field 1 (uint32)
//    Title.name                  = field 2 (string)
//    Title.author                = field 3 (string)
//    Title.portraitImageUrl      = field 4 (string)
//    TitleDetail.title           = field 1 (message)
//    TitleDetail.overview        = field 2 (string)
//    TitleDetail.firstChapterList= field 6 (repeated message)
//    TitleDetail.lastChapterList = field 7 (repeated message)
//    Chapter.titleId             = field 1 (uint32)
//    Chapter.chapterId           = field 2 (uint32)
//    Chapter.name                = field 3 (string)  ← número do cap
//    Chapter.subTitle            = field 4 (string)  ← nome do cap
//    MangaViewer.pages           = field 1 (repeated message)
//    Page.mangaPage              = field 1 (message, oneof)
//    MangaPage.imageUrl          = field 1 (string)
//    MangaPage.width             = field 2 (uint32)
//    MangaPage.height            = field 3 (uint32)
//    MangaPage.encryptionKey     = field 4 (string)
// ══════════════════════════════════════════════════════════════════════════════

const MP_BASE = 'https://jumpg-webapi.tokyo-cdn.com/api';
const MP_HEADERS = {
  'Origin': 'https://mangaplus.shueisha.co.jp',
  'Referer': 'https://mangaplus.shueisha.co.jp/',
};

// Usa o Reader do protobufjs para percorrer o buffer sem schema
function readFields(buf) {
  const reader = protobuf.Reader.create(buf);
  const fields = {};
  while (reader.pos < reader.len) {
    const tag = reader.uint32();
    const fieldNum = tag >>> 3;
    const wireType = tag & 7;
    if (!fields[fieldNum]) fields[fieldNum] = [];
    if (wireType === 0) {
      fields[fieldNum].push(reader.uint32());
    } else if (wireType === 2) {
      fields[fieldNum].push(reader.bytes());
    } else if (wireType === 1) {
      reader.skip(8); // fixed64
    } else if (wireType === 5) {
      reader.skip(4); // fixed32
    } else {
      break; // wire type inválido
    }
  }
  return fields;
}

function str(bytes) { return Buffer.from(bytes).toString('utf8'); }
function buf(bytes) { return Buffer.from(bytes); }

async function mpRaw(path) {
  const { buffer, status } = await fetchRaw(`${MP_BASE}${path}`, MP_HEADERS);
  if (status !== 200) throw new Error(`HTTP ${status} para ${path}`);
  return buffer;
}

// Decodifica Title de um buffer
function decodeTitle(bytes) {
  const f = readFields(buf(bytes));
  return {
    titleId: f[1]?.[0] || 0,
    name: f[2]?.[0] ? str(f[2][0]) : '',
    author: f[3]?.[0] ? str(f[3][0]) : '',
    portraitImageUrl: f[4]?.[0] ? str(f[4][0]) : '',
  };
}

// Decodifica Chapter de um buffer
function decodeChapter(bytes) {
  const f = readFields(buf(bytes));
  return {
    titleId: f[1]?.[0] || 0,
    chapterId: f[2]?.[0] || 0,
    name: f[3]?.[0] ? str(f[3][0]) : '',      // número ex: "1", "1181"
    subTitle: f[4]?.[0] ? str(f[4][0]) : '',  // nome do capítulo
  };
}

// Decodifica MangaPage de um buffer
function decodeMangaPage(bytes) {
  const f = readFields(buf(bytes));
  return {
    imageUrl: f[1]?.[0] ? str(f[1][0]) : '',
    encryptionKey: f[4]?.[0] ? str(f[4][0]) : '',
  };
}

async function mpSearch(query) {
  const raw = await mpRaw('/title_list/allV2');
  // Response → field 1 (success) → field 4 (allTitlesView) → field 1[] (titles)
  const resp = readFields(raw);
  const successBuf = resp[1]?.[0];
  if (!successBuf) throw new Error('Campo success não encontrado na resposta');

  const success = readFields(buf(successBuf));
  const allTitlesViewBuf = success[4]?.[0];
  if (!allTitlesViewBuf) throw new Error('Campo allTitlesView não encontrado');

  const allTitlesView = readFields(buf(allTitlesViewBuf));
  const titleBufs = allTitlesView[1] || [];

  const q = query.toLowerCase();
  return titleBufs
    .map(decodeTitle)
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
  const raw = await mpRaw(`/title_detail?title_id=${titleId}`);
  // Response → field 1 (success) → field 8 (titleDetailView)
  const resp = readFields(raw);
  const successBuf = resp[1]?.[0];
  if (!successBuf) throw new Error('Campo success não encontrado');

  const success = readFields(buf(successBuf));
  const detailBuf = success[8]?.[0];
  if (!detailBuf) throw new Error('Campo titleDetailView não encontrado');

  const detail = readFields(buf(detailBuf));
  const titleInfo = detail[1]?.[0] ? decodeTitle(detail[1][0]) : {};
  const overview = detail[2]?.[0] ? str(detail[2][0]) : '';

  const firstChaps = (detail[6] || []).map(decodeChapter);
  const lastChaps = (detail[7] || []).map(decodeChapter);

  const seen = new Set();
  const chapters = [...firstChaps, ...lastChaps]
    .filter(c => { if (!c.chapterId || seen.has(c.chapterId)) return false; seen.add(c.chapterId); return true; })
    .map(c => ({
      id: String(c.chapterId),
      title: c.subTitle || `Capítulo ${c.name}`,
      chapterNumber: c.name || String(c.chapterId),
      source: 'mangaplus',
    }));

  return {
    title: titleInfo.name || '',
    coverUrl: titleInfo.portraitImageUrl || null,
    description: overview,
    chapters,
  };
}

async function mpGetPages(chapterId) {
  const raw = await mpRaw(`/manga_viewer?chapter_id=${chapterId}&split=yes&img_quality=super_high`);
  // Response → field 1 (success) → field 10 (mangaViewer) → field 1[] (pages) → field 1 (mangaPage)
  const resp = readFields(raw);
  const successBuf = resp[1]?.[0];
  if (!successBuf) throw new Error('Campo success não encontrado');

  const success = readFields(buf(successBuf));
  const viewerBuf = success[10]?.[0];
  if (!viewerBuf) throw new Error('Campo mangaViewer não encontrado');

  const viewer = readFields(buf(viewerBuf));
  const pageBufs = viewer[1] || [];

  return pageBufs
    .map(pb => {
      const page = readFields(buf(pb));
      const mangaPageBuf = page[1]?.[0];
      if (!mangaPageBuf) return null;
      return decodeMangaPage(mangaPageBuf);
    })
    .filter(p => p && p.imageUrl);
}

// Descriptografia XOR do MangaPlus
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
  res.json({ status: 'ok', version: '5.1-protobuf-reader' });
});

// ─── DEBUG (deixar por ora para diagnóstico) ───────────────────────────────────
app.get('/debug', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const titleId = req.query.id || '700005';
  try {
    const raw = await mpRaw(`/title_detail?title_id=${titleId}`);
    const resp = readFields(raw);
    const successBuf = resp[1]?.[0];
    const successFields = successBuf ? Object.keys(readFields(buf(successBuf))).join(',') : 'none';
    res.json({
      responseSize: raw.length,
      responseTopFields: Object.keys(resp).join(','),
      successFields,
      hex20: raw.slice(0, 20).toString('hex'),
    });
  } catch (e) {
    res.json({ error: e.message });
  }
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
    console.log('[SEARCH] MangaPlus: 0 resultados');
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
  } catch (e) { res.status(500).send('Erro: ' + e.message); }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Manga Proxy v5.1 (protobuf Reader) na porta ${PORT}`);
});
