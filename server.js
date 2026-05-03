const express = require('express');
const https = require('https');
const http = require('http');

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

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

// ─── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ══════════════════════════════════════════════════════════════════════════════
//  PROTOBUF READER MANUAL (sem dependências externas)
//
//  Field numbers confirmados nos endpoints v3 do MangaPlus (2024/2025):
//    Response         → success: field 1
//    SuccessResult    → allTitlesView: field 4 | titleDetailView: field 8 | mangaViewer: field 10
//    AllTitlesView    → titles[]: field 1
//    Title            → titleId:1 name:2 author:3 portraitImageUrl:4
//    TitleDetailView  → title:1 overview:2 firstChapterList:6 lastChapterList:7
//    Chapter          → titleId:1 chapterId:2 name:3 subTitle:4
//    MangaViewer      → pages[]: field 1
//    Page             → mangaPage: field 1
//    MangaPage        → imageUrl:1 width:2 height:3 encryptionKey:4
// ══════════════════════════════════════════════════════════════════════════════

function readPB(buf) {
  // Retorna Map: fieldNum → [values...]
  // Cada value é: number (varint/fixed) ou Buffer (length-delimited)
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

// Endpoints atuais do MangaPlus (confirmados em 2024/2025):
const MP = 'https://jumpg-webapi.tokyo-cdn.com/api';
const MP_HDR = { 'Origin': 'https://mangaplus.shueisha.co.jp', 'Referer': 'https://mangaplus.shueisha.co.jp/' };

async function mpRaw(path) {
  const { buffer, status } = await fetchRaw(`${MP}${path}`, MP_HDR);
  if (status !== 200) throw new Error(`HTTP ${status} para ${path}`);
  return buffer;
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
    name: f[3]?.[0] ? s(f[3][0]) : '',     // número "1", "1181"
    subTitle: f[4]?.[0] ? s(f[4][0]) : '', // nome do capítulo
  };
}

function decodePage(b) {
  const f = readPB(pb(b));
  return {
    imageUrl: f[1]?.[0] ? s(f[1][0]) : '',
    encryptionKey: f[4]?.[0] ? s(f[4][0]) : '',
  };
}

// Navega pela resposta e extrai o bloco success
function getSuccess(raw) {
  const resp = readPB(raw);
  const successBuf = resp[1]?.[0];
  if (!successBuf) throw new Error('Campo success(1) não encontrado. Tamanho buffer: ' + raw.length);
  return readPB(pb(successBuf));
}

async function mpSearch(query) {
  // allV3 é o endpoint atual (allV2 foi deprecado)
  const raw = await mpRaw('/title_list/allV3');
  const success = getSuccess(raw);
  // allTitlesView = field 4 dentro do success
  const atv = success[4]?.[0];
  if (!atv) throw new Error('allTitlesView(4) não encontrado. Fields: ' + Object.keys(success).join(','));
  const titles = readPB(pb(atv))[1] || [];
  const q = query.toLowerCase();
  return titles.map(decodeTitle)
    .filter(t => t.name?.toLowerCase().includes(q))
    .slice(0, 20)
    .map(t => ({ id: String(t.titleId), title: t.name, coverUrl: t.portraitImageUrl || null, source: 'mangaplus' }));
}

async function mpGetTitle(titleId) {
  // title_detail_v3 é o endpoint atual
  const raw = await mpRaw(`/title_detail_v3?title_id=${titleId}`);
  const success = getSuccess(raw);
  // titleDetailView = field 8
  const tdv = success[8]?.[0];
  if (!tdv) throw new Error('titleDetailView(8) não encontrado. Fields: ' + Object.keys(success).join(','));
  const detail = readPB(pb(tdv));
  const titleInfo = detail[1]?.[0] ? decodeTitle(detail[1][0]) : {};
  const overview = detail[2]?.[0] ? s(detail[2][0]) : '';
  const firstChaps = (detail[6] || []).map(decodeChapter);
  const lastChaps = (detail[7] || []).map(decodeChapter);
  const seen = new Set();
  const chapters = [...firstChaps, ...lastChaps]
    .filter(c => c.chapterId && !seen.has(c.chapterId) && seen.add(c.chapterId))
    .map(c => ({ id: String(c.chapterId), title: c.subTitle || `Capítulo ${c.name}`, chapterNumber: c.name || String(c.chapterId), source: 'mangaplus' }));
  return { title: titleInfo.name || '', coverUrl: titleInfo.portraitImageUrl || null, description: overview, chapters };
}

async function mpGetPages(chapterId) {
  const raw = await mpRaw(`/manga_viewer?chapter_id=${chapterId}&split=yes&img_quality=super_high`);
  const success = getSuccess(raw);
  // mangaViewer = field 10
  const viewer = success[10]?.[0];
  if (!viewer) throw new Error('mangaViewer(10) não encontrado. Fields: ' + Object.keys(success).join(','));
  const pages = readPB(pb(viewer))[1] || [];
  return pages.map(pb => {
    const page = readPB(Buffer.from(pb));
    const mp = page[1]?.[0]; // mangaPage = field 1
    return mp ? decodePage(mp) : null;
  }).filter(p => p?.imageUrl);
}

function xorDecrypt(buf, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  return Buffer.from(buf.map((b, i) => b ^ key[i % key.length]));
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({ status: 'ok', version: '6.0-allV3' }));

// ─── DEBUG — mostra a estrutura real da resposta ───────────────────────────────
app.get('/debug', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const titleId = req.query.id || '700005';
  const endpoint = req.query.ep || `/title_detail_v3?title_id=${titleId}`;
  try {
    const raw = await mpRaw(endpoint);
    const resp = readPB(raw);
    const successBuf = resp[1]?.[0];
    const success = readPB(pb(successBuf));
    const tdvBuf = success[8]?.[0];
    const tdv = readPB(pb(tdvBuf));

    // Mostra cada field do titleDetailView com tipo e preview
    const fieldInfo = {};
    for (const [fn, vals] of Object.entries(tdv)) {
      fieldInfo[fn] = vals.map(v => {
        if (typeof v === 'number') return { type: 'varint', value: v };
        const str = Buffer.from(v).toString('utf8');
        const isPrintable = /^[\x20-\x7E\u00C0-\uFFFF]*$/.test(str);
        if (isPrintable && str.length < 200) return { type: 'string', value: str };
        // tenta parsear como sub-message
        try {
          const sub = readPB(Buffer.from(v));
          const subInfo = {};
          for (const [sf, svs] of Object.entries(sub)) {
            subInfo[sf] = svs.map(sv => {
              if (typeof sv === 'number') return sv;
              const ss = Buffer.from(sv).toString('utf8');
              return /^[\x20-\x7E\u00C0-\uFFFF]*$/.test(ss) ? ss.slice(0,80) : `<bytes ${sv.length}>`;
            });
          }
          return { type: 'message', fields: subInfo };
        } catch { return { type: 'bytes', length: v.length }; }
      });
    }
    res.json({ endpoint, size: raw.length, titleDetailViewFields: fieldInfo });
  } catch (e) {
    res.json({ error: e.message, endpoint });
  }
});

// ─── GET /search?q=... ────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH] "${q}"`);

  try {
    const results = await mpSearch(q);
    if (results.length > 0) { console.log(`[SEARCH] MangaPlus: ${results.length}`); return res.json({ results, source: 'mangaplus' }); }
    console.log('[SEARCH] MangaPlus: 0 resultados');
  } catch (e) { console.warn('[SEARCH] MangaPlus erro:', e.message); }

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
    } catch (e) { console.error('[MANGA] MangaPlus erro:', e.message); return res.json({ error: e.message, source: 'mangaplus_failed' }); }
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
        if (cd.data?.length > 0) { chapters = cd.data.map(ch => ({ id: ch.id, title: ch.attributes.title || `Capítulo ${ch.attributes.chapter}`, chapterNumber: ch.attributes.chapter || '0', lang, source: 'mangadex' })); break; }
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
        const pages = pageData.map(p => `${base}/image-proxy?url=${encodeURIComponent(p.imageUrl)}${p.encryptionKey ? '&key=' + encodeURIComponent(p.encryptionKey) : ''}`);
        console.log(`[CHAPTER] MangaPlus: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangaplus' });
      }
    } catch (e) { console.error('[CHAPTER] MangaPlus erro:', e.message); }
  }

  if (isUuid(id)) {
    try {
      const data = await fetchJSON(`https://api.mangadex.org/at-home/server/${id}`);
      const pages = (data.chapter?.data || []).map(f => `${data.baseUrl}/data/${data.chapter.hash}/${f}`);
      if (pages.length > 0) { console.log(`[CHAPTER] MangaDex: ${pages.length} páginas`); return res.json({ pages, source: 'mangadex' }); }
    } catch (e) { console.warn('[CHAPTER] MangaDex erro:', e.message); }
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

app.listen(PORT, () => console.log(`Manga Proxy v6 (allV3 + title_detail_v3) na porta ${PORT}`));
