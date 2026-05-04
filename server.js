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

// Parse de stream NDJSON (múltiplos JSONs concatenados)
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
//  COMICK  (comick-source-api.notaspider.dev — stream NDJSON)
// ══════════════════════════════════════════════════════════════════════════════

const COMICK_BASE = 'https://comick-source-api.notaspider.dev/api';

async function comickSearch(query) {
  try {
    console.log(`[COMICK] Buscando: "${query}"`);
    const response = await fetchPOST(`${COMICK_BASE}/search`, { query, source: 'all' });
    const objects = parseJsonStream(response.buffer.toString('utf8'));
    const results = [];
    for (const obj of objects) {
      if (obj.results && Array.isArray(obj.results)) {
        for (const item of obj.results) {
          if (item.id && item.title) {
            results.push({
              id: item.id,
              title: item.title,
              coverUrl: item.coverImage || null,
              url: item.url || null,      // ← URL real do capítulo/manga
              latestChapter: item.latestChapter,
              source: 'comick',
            });
          }
        }
      }
    }
    console.log(`[COMICK] ${results.length} resultados`);
    return results.slice(0, 20);
  } catch (e) {
    console.error('[COMICK] search erro:', e.message);
    return [];
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// comickGetManga recebe:
//   - mangaId  = o id do resultado da busca (ex: "emqg8", "solo-leveling-mg1")
//   - mangaUrl = a URL real que veio no campo "url" do resultado (ex: "https://comix.to/title/emqg8-...")
//
// O Flutter DEVE passar mangaUrl via query param "url" quando tiver.
// Ex: /manga?id=emqg8&source=comick&url=https%3A%2F%2Fcomix.to%2Ftitle%2Femqg8-...
// ─────────────────────────────────────────────────────────────────────────────
async function comickGetManga(mangaId, mangaUrl) {
  try {
    console.log(`[COMICK] getManga id="${mangaId}" url="${mangaUrl}"`);

    // Se não veio URL, tenta montar a partir do ID ou buscar
    if (!mangaUrl) {
      // IDs curtos (ex: emqg8, wmkdr) = Comix.to
      if (/^[a-z0-9]{4,8}$/.test(mangaId)) {
        mangaUrl = `https://comix.to/title/${mangaId}`;
        console.log(`[COMICK] URL montada (comix): ${mangaUrl}`);
      }
      // IDs com hífen (ex: solo-leveling-mg1) = MangaLoom ou MangaPark
      else if (mangaId.includes('-')) {
        // Tenta buscar para achar a URL certa
        const searchResp = await fetchPOST(`${COMICK_BASE}/search`, { query: mangaId.replace(/-/g, ' '), source: 'all' });
        const objects = parseJsonStream(searchResp.buffer.toString('utf8'));
        for (const obj of objects) {
          if (obj.results) {
            const match = obj.results.find(r => r.id === mangaId || r.url?.includes(mangaId));
            if (match && match.url) { mangaUrl = match.url; break; }
            // Pega o primeiro se não achou match exato
            if (!mangaUrl && obj.results[0]?.url) mangaUrl = obj.results[0].url;
          }
        }
        console.log(`[COMICK] URL via busca: ${mangaUrl}`);
      }
    }

    if (!mangaUrl) {
      console.warn('[COMICK] sem URL para buscar capítulos');
      return { title: mangaId, chapters: [], source: 'comick' };
    }

    // Busca capítulos pela URL real
    const chapResp = await fetchPOST(`${COMICK_BASE}/chapters`, { url: mangaUrl });
    const chapObjects = parseJsonStream(chapResp.buffer.toString('utf8'));

    let chapters = [];
    let title = mangaId;
    for (const obj of chapObjects) {
      if (obj.chapters && Array.isArray(obj.chapters) && obj.chapters.length > 0) {
        title = obj.title || mangaId;
        chapters = obj.chapters.map(c => ({
          // ID = base64 da URL do capítulo (para decodificar em comickGetPages)
          id: Buffer.from(c.url || '').toString('base64'),
          title: c.title || `Capítulo ${c.number}`,
          chapterNumber: String(c.number || '0'),
          source: 'comick',
        })).filter(c => c.id);
        console.log(`[COMICK] ${chapters.length} capítulos`);
        break;
      }
    }

    return { title, coverUrl: null, description: '', chapters, source: 'comick' };
  } catch (e) {
    console.error('[COMICK] getManga erro:', e.message);
    return { title: mangaId, chapters: [], source: 'comick' };
  }
}

async function comickGetPages(chapterHid) {
  try {
    // chapterHid = base64 da URL do capítulo
    const chapterUrl = Buffer.from(chapterHid, 'base64').toString('utf8');
    console.log(`[COMICK] Lendo capítulo: ${chapterUrl}`);

    const { buffer, status } = await fetchRaw(chapterUrl, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,*/*',
    });

    if (status !== 200) {
      console.warn(`[COMICK] HTTP ${status} para ${chapterUrl}`);
      return [];
    }

    const html = buffer.toString('utf8');

    // Tenta extrair URLs de imagem do HTML da página de leitura
    const seen = new Set();
    const pages = [];

    // Padrão 1: arrays JSON com URLs de imagem embutidos no JS
    const jsonArrayMatches = html.match(/"(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)"(?=[,\]])/gi) || [];
    for (const m of jsonArrayMatches) {
      const url = m.replace(/^"|"$/g, '');
      if (!seen.has(url) && !url.includes('thumb') && !url.includes('avatar')) {
        seen.add(url);
        pages.push(url);
      }
    }

    // Padrão 2: tags <img> com src ou data-src
    const imgMatches = html.match(/(?:src|data-src)="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi) || [];
    for (const m of imgMatches) {
      const url = m.replace(/(?:src|data-src)="|"$/g, '');
      if (!seen.has(url) && !url.includes('thumb') && !url.includes('avatar') && !url.includes('logo')) {
        seen.add(url);
        pages.push(url);
      }
    }

    console.log(`[COMICK] ${pages.length} páginas extraídas`);
    return pages.slice(0, 120);
  } catch (e) {
    console.error('[COMICK] getPages erro:', e.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ANILIST
// ══════════════════════════════════════════════════════════════════════════════

async function anilistSearch(query) {
  const gql = `query ($search: String) { Page(page: 1, perPage: 10) { media(search: $search, type: MANGA, sort: SEARCH_MATCH) { id title { romaji english native } coverImage { large extraLarge } bannerImage description(asHtml: false) averageScore genres status chapters startDate { year } } } }`;
  try {
    const { buffer, status } = await fetchPOST('https://graphql.anilist.co', { query: gql, variables: { search: query } });
    if (status !== 200) return [];
    const json = JSON.parse(buffer.toString());
    return (json.data?.Page?.media || []).map(m => ({
      id: `al:${m.id}`, anilistId: m.id,
      title: m.title.english || m.title.romaji || m.title.native || '',
      coverUrl: m.coverImage?.extraLarge || m.coverImage?.large || null,
      bannerUrl: m.bannerImage || null,
      description: m.description || '',
      score: m.averageScore || null,
      genres: m.genres || [],
      status: m.status || '',
      totalChapters: m.chapters || null,
      year: m.startDate?.year || null,
      source: 'anilist',
    }));
  } catch (e) { console.warn('[ANILIST] erro:', e.message); return []; }
}

async function anilistGetMeta(anilistId) {
  const gql = `query ($id: Int) { Media(id: $id, type: MANGA) { id title { romaji english native } coverImage { extraLarge large } bannerImage description(asHtml: false) averageScore genres status chapters startDate { year } characters(sort: ROLE, page: 1, perPage: 6) { nodes { name { full } image { medium } } } } }`;
  try {
    const { buffer } = await fetchPOST('https://graphql.anilist.co', { query: gql, variables: { id: Number(anilistId) } });
    const json = JSON.parse(buffer.toString());
    const m = json.data?.Media;
    if (!m) return null;
    return {
      anilistId: m.id,
      title: m.title.english || m.title.romaji || '',
      coverUrl: m.coverImage?.extraLarge || m.coverImage?.large || null,
      bannerUrl: m.bannerImage || null,
      description: m.description || '',
      score: m.averageScore || null,
      genres: m.genres || [],
      status: m.status || '',
      totalChapters: m.chapters || null,
      year: m.startDate?.year || null,
      characters: (m.characters?.nodes || []).map(c => ({ name: c.name?.full || '', image: c.image?.medium || null })),
    };
  } catch (e) { return null; }
}

// ══════════════════════════════════════════════════════════════════════════════
//  MANGADEX
// ══════════════════════════════════════════════════════════════════════════════

async function mdxSearch(query) {
  try {
    const data = await fetchJSON(`https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=20&order[relevance]=desc&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive`);
    if (!data.data?.length) return [];
    return data.data.map(m => {
      const title = m.attributes.title.en || m.attributes.title['pt-br'] || Object.values(m.attributes.title)[0] || '';
      const cover = m.relationships.find(r => r.type === 'cover_art');
      return { id: m.id, title, coverUrl: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes?.fileName}.512.jpg` : null, source: 'mangadex' };
    });
  } catch (e) { return []; }
}

function xorDecrypt(buf, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  return Buffer.from(buf.map((b, i) => b ^ key[i % key.length]));
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({
  status: 'ok', version: '12.0-comick-url',
  sources: ['mangaplus', 'comick', 'mangadex', 'anilist'],
  endpoints: ['/', '/search', '/manga', '/chapter', '/image-proxy', '/titles', '/debug', '/meta']
}));

// ─── GET /search?q=... ────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { q, source } = req.query;
  if (!q) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH] "${q}" source="${source || 'auto'}"`);

  if (source === 'comick') return res.json({ results: await comickSearch(q), source: 'comick' });
  if (source === 'anilist') return res.json({ results: await anilistSearch(q), source: 'anilist' });
  if (source === 'mangadex') return res.json({ results: await mdxSearch(q), source: 'mangadex' });

  // Auto: MangaPlus → Comick → MangaDex
  try {
    const mp = await mpSearch(q);
    if (mp.length > 0) { console.log(`[SEARCH] MangaPlus: ${mp.length}`); return res.json({ results: mp, source: 'mangaplus' }); }
  } catch (e) { console.warn('[SEARCH] MP erro:', e.message); }

  try {
    const ck = await comickSearch(q);
    if (ck.length > 0) { console.log(`[SEARCH] Comick: ${ck.length}`); return res.json({ results: ck, source: 'comick' }); }
  } catch (e) { console.warn('[SEARCH] Comick erro:', e.message); }

  try {
    const mdx = await mdxSearch(q);
    if (mdx.length > 0) { console.log(`[SEARCH] MangaDex: ${mdx.length}`); return res.json({ results: mdx, source: 'mangadex' }); }
  } catch (e) { console.error('[SEARCH] MDX erro:', e.message); }

  res.json({ results: [], source: 'none' });
});

// ─── GET /manga?id=...&source=...&url=... ─────────────────────────────────────
// Para Comick: passe &url=<url_do_resultado_da_busca> para evitar rebusca
app.get('/manga', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id, source, url } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[MANGA] id="${id}" source="${source}" url="${url || '-'}"`);

  if (source === 'mangaplus' || /^\d{5,7}$/.test(id)) {
    try {
      const d = await mpGetTitle(id);
      console.log(`[MANGA] MP: "${d.title}" | ${d.chapters.length} caps`);
      return res.json({ ...d, source: 'mangaplus' });
    } catch (e) { console.error('[MANGA] MP erro:', e.message); }
  }

  if (source === 'comick') {
    const d = await comickGetManga(id, url ? decodeURIComponent(url) : null);
    console.log(`[MANGA] Comick: "${d.title}" | ${d.chapters.length} caps`);
    return res.json(d);
  }

  if (isUuid(id) || source === 'mangadex') {
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
  }

  res.status(404).json({ error: 'Fonte não reconhecida' });
});

// ─── GET /chapter?id=...&source=... ──────────────────────────────────────────
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
        console.log(`[CHAPTER] MP: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangaplus' });
      }
    } catch (e) { console.error('[CHAPTER] MP erro:', e.message); }
  }

  if (source === 'comick') {
    try {
      const pages = await comickGetPages(id);
      if (pages.length > 0) { console.log(`[CHAPTER] Comick: ${pages.length} páginas`); return res.json({ pages, source: 'comick' }); }
    } catch (e) { console.error('[CHAPTER] Comick erro:', e.message); }
  }

  if (isUuid(id)) {
    try {
      const data = await fetchJSON(`https://api.mangadex.org/at-home/server/${id}`);
      const pages = (data.chapter?.data || []).map(f => `${data.baseUrl}/data/${data.chapter.hash}/${f}`);
      if (pages.length > 0) { console.log(`[CHAPTER] MDX: ${pages.length} páginas`); return res.json({ pages, source: 'mangadex' }); }
    } catch (e) { console.warn('[CHAPTER] MDX erro:', e.message); }
  }

  res.json({ pages: [], source: 'none' });
});

// ─── GET /image-proxy?url=...&key=... ────────────────────────────────────────
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

// ─── GET /meta?q=... ou /meta?id=... ─────────────────────────────────────────
app.get('/meta', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { q, id } = req.query;
  if (id) {
    const meta = await anilistGetMeta(id);
    if (!meta) return res.status(404).json({ error: 'não encontrado' });
    return res.json(meta);
  }
  if (q) return res.json({ results: await anilistSearch(q) });
  res.status(400).json({ error: 'q ou id obrigatório' });
});

// ─── GET /titles ──────────────────────────────────────────────────────────────
app.get('/titles', (req, res) => {
  const unique = {};
  for (const [name, id] of Object.entries(MANGA_IDS)) {
    if (!unique[id]) unique[id] = { id: String(id), name };
  }
  res.json({ total: Object.keys(unique).length, titles: Object.values(unique) });
});

// ─── GET /debug?id=... ───────────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.json({ ids_mapeados: MANGA_IDS });
  try {
    const d = await mpGetTitle(id);
    res.json({ ok: true, titulo: d.title, capitulos: d.chapters.length, capa: d.coverUrl });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

app.listen(PORT, () => console.log(`Proxy v12.0 na porta ${PORT}`));
