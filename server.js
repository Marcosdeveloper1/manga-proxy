const express = require('express');
const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────
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

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ══════════════════════════════════════════════════════════════════════════════
//  PROTOBUF READER MANUAL
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

// ─── MangaPlus ────────────────────────────────────────────────────────────────
const MP_WEB = 'https://jumpg-webapi.tokyo-cdn.com/api';
const MP_APP = 'https://jumpg-api.tokyo-cdn.com/api';

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

// Usa a web API (jumpg-webapi) — funciona para title_detail e manga_viewer
async function mpRaw(path) {
  const { buffer, status } = await fetchRaw(`${MP_WEB}${path}`, mpHeaders());
  if (status !== 200) throw new Error(`HTTP ${status} para ${path}`);
  return buffer;
}

// Usa a app API (jumpg-api) — necessária para title_list/allV3
async function mpAppRaw(path) {
  const { buffer, status } = await fetchRaw(`${MP_APP}${path}`, mpHeaders());
  if (status !== 200) throw new Error(`HTTP ${status} para ${path}`);
  return buffer;
}

function getSuccess(raw) {
  const resp = readPB(raw);
  const successBuf = resp[1]?.[0];
  if (!successBuf) throw new Error('Campo success(1) não encontrado. Tamanho buffer: ' + raw.length);
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

async function mpSearch(query) {
  // ── Tenta allV3 na app API com title_type=0 (todos os títulos) ──────────────
  // O parâmetro correto é title_type, NÃO language
  const endpoints = [
    '/title_list/allV3?title_type=0',
    '/title_list/allV3?title_type=1',  // serializando
    '/title_list/allV3',               // sem parâmetro
    '/title_list/allV2',               // fallback v2
  ];

  for (const ep of endpoints) {
    try {
      console.log(`[SEARCH MP] Tentando: ${ep}`);
      const raw = await mpAppRaw(ep);
      const success = getSuccess(raw);

      // allV3 usa campo 4 (AllTitlesViewV3), allV2 usa campo 4 também
      const atv = success[4]?.[0];
      if (!atv) {
        console.log(`[SEARCH MP] ${ep}: sem campo 4. Fields: ${Object.keys(success).join(',')}`);
        continue;
      }

      const parsed = readPB(pb(atv));
      // Títulos ficam no campo 1
      const titles = parsed[1] || [];
      if (titles.length === 0) {
        console.log(`[SEARCH MP] ${ep}: campo 4 vazio`);
        continue;
      }

      const q = query.toLowerCase();
      const results = titles.map(decodeTitle)
        .filter(t => t.name?.toLowerCase().includes(q))
        .slice(0, 20)
        .map(t => ({
          id: String(t.titleId),
          title: t.name,
          coverUrl: t.portraitImageUrl || null,
          source: 'mangaplus',
        }));

      console.log(`[SEARCH MP] ${ep}: ${titles.length} títulos total, ${results.length} matches para "${query}"`);
      if (results.length > 0) return results;

    } catch (e) {
      console.warn(`[SEARCH MP] ${ep} erro: ${e.message}`);
    }
  }

  // ── Fallback: title_detail de IDs conhecidos ──────────────────────────────
  // Se o allV3 falhar, tenta buscar pelos IDs fixos dos títulos mais populares
  const POPULAR_IDS = {
    'one piece': 700005,
    'naruto': 100102,
    'boruto': 100186,
    'demon slayer': 100197,
    'jujutsu kaisen': 100136,
    'chainsaw man': 100191,
    'dandadan': 100268,
    'dan da dan': 100268,
    'blue lock': 100227,
    'my hero academia': 100103,
    'black clover': 100109,
    'dragon ball': 100010,
  };

  const q = query.toLowerCase();
  for (const [key, id] of Object.entries(POPULAR_IDS)) {
    if (key.includes(q) || q.includes(key.split(' ')[0])) {
      console.log(`[SEARCH MP] Fallback ID fixo: ${key} → ${id}`);
      try {
        const detail = await mpGetTitle(id);
        if (detail.title) {
          return [{ id: String(id), title: detail.title, coverUrl: detail.coverUrl, source: 'mangaplus' }];
        }
      } catch (e) {
        console.warn(`[SEARCH MP] ID fixo ${id} erro: ${e.message}`);
      }
    }
  }

  return [];
}

async function mpGetTitle(titleId) {
  const raw = await mpRaw(`/title_detail_v3?title_id=${titleId}&language=0`);
  const success = getSuccess(raw);
  const tdv = success[8]?.[0];
  if (!tdv) throw new Error('titleDetailView(8) não encontrado. Fields: ' + Object.keys(success).join(','));
  const detail = readPB(pb(tdv));
  const titleInfo = detail[1]?.[0] ? decodeTitle(detail[1][0]) : {};
  const chapters = [];
  const seen = new Set();
  for (const groupBuf of (detail[28] || [])) {
    const group = readPB(pb(groupBuf));
    const firsts = (group[2] || []).map(decodeChapter);
    const lasts  = (group[4] || []).map(decodeChapter);
    for (const c of [...firsts, ...lasts]) {
      if (!c.chapterId || seen.has(c.chapterId)) continue;
      seen.add(c.chapterId);
      chapters.push({
        id: String(c.chapterId),
        title: c.subTitle || `Capítulo ${c.name}`,
        chapterNumber: c.name || String(c.chapterId),
        source: 'mangaplus',
      });
    }
  }
  return {
    title: titleInfo.name || '',
    coverUrl: titleInfo.portraitImageUrl || null,
    description: titleInfo.author || '',
    chapters,
  };
}

async function mpGetPages(chapterId) {
  const raw = await mpRaw(`/manga_viewer?chapter_id=${chapterId}&split=yes&img_quality=super_high`);
  const success = getSuccess(raw);
  const viewer = success[10]?.[0];
  if (!viewer) throw new Error('mangaViewer(10) não encontrado. Fields: ' + Object.keys(success).join(','));
  const pages = readPB(pb(viewer))[1] || [];
  return pages.map(p => {
    const page = readPB(Buffer.from(p));
    const mp = page[1]?.[0];
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

app.get('/', (req, res) => res.json({ status: 'ok', version: '8.0-allV3-fix' }));

// ─── GET /search?q=... ────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH] "${q}"`);

  try {
    const results = await mpSearch(q);
    if (results.length > 0) {
      console.log(`[SEARCH] MangaPlus: ${results.length} resultados`);
      return res.json({ results, source: 'mangaplus' });
    }
    console.log('[SEARCH] MangaPlus: 0 resultados, tentando MangaDex');
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
        const cd = await fetchJSON(`https://api.mangadex.org/manga/${id}/feed?translatedLanguage[]=${lang}&order[chapter]=desc&limit=100`);
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
    if (status !== 200) return res.status(status).send('Erro ' + status);
    const result = key ? xorDecrypt(buffer, decodeURIComponent(key)) : buffer;
    res.setHeader('Content-Type', 'image/jpeg');
    res.setHeader('Cache-Control', 'public, max-age=86400');
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.send(result);
  } catch (e) { res.status(500).send('Erro: ' + e.message); }
});

// ─── DEBUG ────────────────────────────────────────────────────────────────────
app.get('/debug-allv3', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const results = {};
  const eps = [
    '/title_list/allV3?title_type=0',
    '/title_list/allV3?title_type=1',
    '/title_list/allV3',
    '/title_list/allV2',
  ];
  for (const ep of eps) {
    try {
      const raw = await mpAppRaw(ep);
      const resp = readPB(raw);
      const successBuf = resp[1]?.[0];
      results[ep] = { size: raw.length, hasSuccess: !!successBuf, hex10: raw.slice(0,10).toString('hex') };
    } catch (e) {
      results[ep] = { error: e.message };
    }
  }
  res.json(results);
});

app.listen(PORT, () => console.log(`Manga Proxy v8.0 na porta ${PORT}`));
