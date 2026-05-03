const express = require('express');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || null;

// ─── Helpers HTTP ──────────────────────────────────────────────────────────────

function fetchRaw(url, headers = {}) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const defaultHeaders = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64)',
      'Accept': '*/*',
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

function fetchText(url, headers = {}) {
  return fetchRaw(url, headers).then(r => ({ html: r.buffer.toString('utf8'), status: r.status }));
}

function fetchJSON(url, headers = {}) {
  return fetchText(url, { Accept: 'application/json', ...headers })
    .then(r => JSON.parse(r.html));
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
  res.json({ status: 'ok', flaresolverr: !!FLARESOLVERR_URL, version: '3.0-mangaplus' });
});

// ══════════════════════════════════════════════════════════════════════════════
//  MANGAPLUS — API oficial da Shueisha
//  One Piece titleId: 700005 | Naruto: 700007 | Boruto: 700011
//  A API responde em Protobuf. Usamos um parser mínimo manual.
// ══════════════════════════════════════════════════════════════════════════════

const MP_API = 'https://jumpg-webapi.tokyo-cdn.com/api';
const MP_HEADERS = {
  'User-Agent': 'Mozilla/5.0',
  'Origin': 'https://mangaplus.shueisha.co.jp',
  'Referer': 'https://mangaplus.shueisha.co.jp/',
};

function genDeviceId() {
  const hex = () => Math.floor(Math.random() * 16).toString(16);
  return Array.from({ length: 32 }, hex).join('');
}

// Parser Protobuf mínimo — retorna array de [fieldNum, wireType, value]
function parseProtobuf(buf) {
  const fields = [];
  let pos = 0;

  function readVarint() {
    let val = 0, shift = 0, byte;
    do {
      if (pos >= buf.length) break;
      byte = buf[pos++];
      val |= (byte & 0x7F) << shift;
      shift += 7;
    } while (byte & 0x80);
    return val;
  }

  while (pos < buf.length) {
    try {
      const tag = readVarint();
      if (tag === 0) break;
      const fieldNum = tag >> 3;
      const wireType = tag & 0x7;
      if (wireType === 0) {
        fields.push([fieldNum, 0, readVarint()]);
      } else if (wireType === 2) {
        const len = readVarint();
        const bytes = buf.slice(pos, pos + len);
        pos += len;
        fields.push([fieldNum, 2, bytes]);
      } else if (wireType === 5) {
        fields.push([fieldNum, 5, buf.readUInt32LE ? buf.readUInt32LE(pos) : 0]);
        pos += 4;
      } else if (wireType === 1) {
        pos += 8;
      } else {
        break;
      }
    } catch (_) { break; }
  }
  return fields;
}

function pbStr(buf) { return buf.toString('utf8'); }

// ─── Busca títulos no MangaPlus ────────────────────────────────────────────────
async function mpSearchTitle(query) {
  // Endpoint de todos os títulos (funciona sem auth)
  const url = `${MP_API}/title_list/allV3`;
  const { buffer } = await fetchRaw(url, MP_HEADERS);
  const topFields = parseProtobuf(buffer);
  const results = [];
  const q = query.toLowerCase();

  function tryExtractTitle(buf) {
    const fields = parseProtobuf(buf);
    let titleId = null, name = null, cover = null;
    for (const [f, w, v] of fields) {
      if (f === 1 && w === 0) titleId = v;
      if (f === 2 && w === 2) { try { name = pbStr(v); } catch(_) {} }
      if (f === 23 && w === 2) { try { cover = pbStr(v); } catch(_) {} }
      if (f === 4 && w === 2 && !cover) { try { cover = pbStr(v); } catch(_) {} }
    }
    if (titleId && name && name.toLowerCase().includes(q)) {
      results.push({ id: String(titleId), title: name, coverUrl: cover, source: 'mangaplus' });
    }
  }

  // O Protobuf do MangaPlus tem vários níveis de aninhamento
  for (const [fn, wt, val] of topFields) {
    if (wt !== 2) continue;
    tryExtractTitle(val);
    const inner = parseProtobuf(val);
    for (const [f2, w2, v2] of inner) {
      if (w2 !== 2) continue;
      tryExtractTitle(v2);
      const inner2 = parseProtobuf(v2);
      for (const [f3, w3, v3] of inner2) {
        if (w3 === 2) tryExtractTitle(v3);
      }
    }
  }
  return results.slice(0, 20);
}

// ─── Detalhes e capítulos de um título ────────────────────────────────────────
async function mpGetTitle(titleId) {
  const url = `${MP_API}/title_detail?title_id=${titleId}`;
  const { buffer } = await fetchRaw(url, MP_HEADERS);
  const fields = parseProtobuf(buffer);

  let title = '', coverUrl = '', description = '';
  const chapters = [];

  function tryExtractChapter(buf) {
    const inner = parseProtobuf(buf);
    let chapterId = null, name = '', num = '';
    for (const [f, w, v] of inner) {
      if (f === 1 && w === 0) chapterId = v;
      if (f === 2 && w === 2) { try { name = pbStr(v); } catch(_) {} }
      if (f === 3 && w === 2) { try { num = pbStr(v); } catch(_) {} }
      if (f === 6 && w === 2 && !num) { try { num = pbStr(v); } catch(_) {} }
    }
    if (chapterId && chapterId > 0) {
      chapters.push({
        id: String(chapterId),
        title: name || `Capítulo ${num}`,
        chapterNumber: num || '0',
        source: 'mangaplus',
      });
    }
  }

  for (const [fn, wt, val] of fields) {
    if (wt !== 2) continue;
    const inner = parseProtobuf(val);
    for (const [f2, w2, v2] of inner) {
      if (f2 === 1 && w2 === 2) { try { title = pbStr(v2); } catch(_) {} }
      if (f2 === 3 && w2 === 2) { try { coverUrl = pbStr(v2); } catch(_) {} }
      if (f2 === 6 && w2 === 2) { try { description = pbStr(v2); } catch(_) {} }
      if ((f2 === 5 || f2 === 6) && w2 === 2) tryExtractChapter(v2);
    }
    tryExtractChapter(val);
  }

  return { title, coverUrl, description, chapters };
}

// ─── Páginas de um capítulo (com descriptografia XOR) ─────────────────────────
async function mpGetChapterPages(chapterId) {
  const deviceId = genDeviceId();
  const url = `${MP_API}/manga_viewer?chapter_id=${chapterId}&split=yes&img_quality=super_high&device_id=${deviceId}`;
  const { buffer } = await fetchRaw(url, MP_HEADERS);
  const fields = parseProtobuf(buffer);

  const pages = [];

  function tryExtractPage(buf) {
    const inner = parseProtobuf(buf);
    let imageUrl = null, encKey = null;
    for (const [f, w, v] of inner) {
      if (f === 1 && w === 2) { try { const s = pbStr(v); if (s.startsWith('http')) imageUrl = s; } catch(_) {} }
      if (f === 4 && w === 2) { try { encKey = pbStr(v); } catch(_) {} }
    }
    if (imageUrl && encKey) pages.push({ imageUrl, encryptionKey: encKey });
  }

  for (const [fn, wt, val] of fields) {
    if (wt !== 2) continue;
    tryExtractPage(val);
    const inner = parseProtobuf(val);
    for (const [f2, w2, v2] of inner) {
      if (w2 !== 2) continue;
      tryExtractPage(v2);
      const inner2 = parseProtobuf(v2);
      for (const [f3, w3, v3] of inner2) {
        if (w3 === 2) tryExtractPage(v3);
      }
    }
  }

  return [...new Map(pages.map(p => [p.imageUrl, p])).values()];
}

// Descriptografa com XOR (chave em hex, como o MangaPlus usa)
function decryptImage(encryptedBuffer, encryptionKey) {
  const keyBytes = Buffer.from(encryptionKey, 'hex');
  const result = Buffer.alloc(encryptedBuffer.length);
  for (let i = 0; i < encryptedBuffer.length; i++) {
    result[i] = encryptedBuffer[i] ^ keyBytes[i % keyBytes.length];
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

  // 1. MangaPlus
  try {
    const results = await mpSearchTitle(query);
    if (results.length > 0) {
      console.log(`[SEARCH] MangaPlus: ${results.length}`);
      return res.json({ results, source: 'mangaplus' });
    }
  } catch (e) { console.warn('[SEARCH] MangaPlus erro:', e.message); }

  // 2. MangaDex
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
      if (detail.title) {
        console.log(`[MANGA] MangaPlus: "${detail.title}" | ${detail.chapters.length} caps`);
        return res.json({ ...detail, source: 'mangaplus' });
      }
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
        const chapData = await fetchJSON(`https://api.mangadex.org/manga/${id}/feed?translatedLanguage[]=${lang}&order[chapter]=desc&limit=100`);
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
  } catch (e) { return res.status(500).json({ error: e.message }); }
});

// ─── GET /chapter?id=...&source=... ───────────────────────────────────────────
app.get('/chapter', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id, source } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[CHAPTER] id="${id}" source="${source}"`);

  // MangaPlus — retorna URLs do /image-proxy que descriptografa XOR
  if (source === 'mangaplus' || /^\d{5,9}$/.test(id)) {
    try {
      const pageData = await mpGetChapterPages(id);
      if (pageData.length > 0) {
        const baseUrl = `${req.protocol}://${req.get('host')}`;
        const pages = pageData.map(p =>
          `${baseUrl}/image-proxy?url=${encodeURIComponent(p.imageUrl)}&key=${encodeURIComponent(p.encryptionKey)}`
        );
        console.log(`[CHAPTER] MangaPlus: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangaplus' });
      }
    } catch (e) { console.error('[CHAPTER] MangaPlus erro:', e.message); }
  }

  // MangaDex
  if (isUuid(id)) {
    try {
      const data = await fetchJSON(`https://api.mangadex.org/at-home/server/${id}`);
      const base = data.baseUrl, hash = data.chapter?.hash;
      const pages = (data.chapter?.data || []).map(f => `${base}/data/${hash}/${f}`);
      if (pages.length > 0) {
        console.log(`[CHAPTER] MangaDex: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangadex' });
      }
    } catch (e) { console.warn('[CHAPTER] MangaDex erro:', e.message); }
  }

  res.json({ pages: [], source: 'none', error: 'Nenhuma fonte retornou páginas.' });
});

// ─── GET /image-proxy?url=...&key=... ─────────────────────────────────────────
// Baixa imagem criptografada do MangaPlus, descriptografa com XOR e serve
app.get('/image-proxy', async (req, res) => {
  const { url, key } = req.query;
  if (!url) return res.status(400).send('url obrigatório');

  try {
    const { buffer, status } = await fetchRaw(decodeURIComponent(url), MP_HEADERS);
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

// ─── GET /mangaplus/all ────────────────────────────────────────────────────────
// Lista todo o catálogo MangaPlus
app.get('/mangaplus/all', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  try {
    const { buffer } = await fetchRaw(`${MP_API}/title_list/allV3`, MP_HEADERS);
    const topFields = parseProtobuf(buffer);
    const titles = [];

    for (const [fn, wt, val] of topFields) {
      if (wt !== 2) continue;
      const inner = parseProtobuf(val);
      for (const [f2, w2, v2] of inner) {
        if (w2 !== 2) continue;
        const inner2 = parseProtobuf(v2);
        for (const [f3, w3, v3] of inner2) {
          if (w3 !== 2) continue;
          const t = parseProtobuf(v3);
          let titleId = null, name = null, cover = null;
          for (const [f4, w4, v4] of t) {
            if (f4 === 1 && w4 === 0) titleId = v4;
            if (f4 === 2 && w4 === 2) { try { name = pbStr(v4); } catch(_) {} }
            if (f4 === 23 && w4 === 2) { try { cover = pbStr(v4); } catch(_) {} }
          }
          if (titleId && name) titles.push({ id: String(titleId), title: name, coverUrl: cover, source: 'mangaplus' });
        }
      }
    }

    res.json({ total: titles.length, titles });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ─── Start ─────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Manga Proxy v3 na porta ${PORT}`);
  console.log(`MangaPlus integrado | FlareSolverr: ${FLARESOLVERR_URL || 'nao configurado'}`);
});
