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
//  CACHE DO COMICK
//  comickById[id]      = { url, title, coverUrl, sourceId }
//  comickByTitle[key]  = [{ id, url, sourceId }, ...]  ← TODOS os IDs do mesmo título
//  Isso permite que /manga?id=emqg8 tente mgeko, flamecomics etc. quando Comix falha
// ══════════════════════════════════════════════════════════════════════════════
const comickById = {};
const comickByTitle = {};

function titleKey(t) {
  // "Solo Leveling" e "Solo Leveling (Novel)" ficam em chaves diferentes — OK
  return (t || '').toLowerCase().replace(/[^a-z0-9]/g, '').slice(0, 40);
}

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
//  COMICK  (comick-source-api.notaspider.dev)
// ══════════════════════════════════════════════════════════════════════════════

const COMICK_BASE = 'https://comick-source-api.notaspider.dev/api';

async function comickSearch(query) {
  try {
    console.log(`[COMICK] Buscando: "${query}"`);
    const response = await fetchPOST(`${COMICK_BASE}/search`, { query, source: 'all' });
    const objects = parseJsonStream(response.buffer.toString('utf8'));
    const results = [];
    const seenIds = new Set();

    for (const obj of objects) {
      if (!obj.results || !Array.isArray(obj.results)) continue;
      const sourceId = (obj.source || 'unknown').toLowerCase().replace(/\s+/g, '');

      for (const item of obj.results) {
        if (!item.id || !item.title) continue;

        // Salva entry por ID
        if (item.url) {
          comickById[item.id] = { url: item.url, title: item.title, coverUrl: item.coverImage || null, sourceId };
        }

        // Índice por título normalizado — agrupa todos os IDs do mesmo manga
        const key = titleKey(item.title);
        if (key) {
          if (!comickByTitle[key]) comickByTitle[key] = [];
          if (!comickByTitle[key].find(e => e.id === item.id)) {
            comickByTitle[key].push({ id: item.id, url: item.url, sourceId });
          }
        }

        if (seenIds.has(item.id)) continue;
        seenIds.add(item.id);
        results.push({
          id: item.id,
          title: item.title,
          coverUrl: item.coverImage || null,
          url: item.url || null,
          latestChapter: item.latestChapter || null,
          source: 'comick',
        });
      }
    }

    console.log(`[COMICK] ${results.length} resultados | ${Object.keys(comickById).length} IDs no cache`);
    return results.slice(0, 20);
  } catch (e) {
    console.error('[COMICK] search erro:', e.message);
    return [];
  }
}

async function comickGetManga(mangaId, providedUrl) {
  try {
    console.log(`[COMICK] getManga id="${mangaId}"`);

    // Monta lista de URLs para tentar, em ordem de prioridade
    const urlsToTry = [];
    const seen = new Set();

    function addUrl(url, sourceId) {
      if (url && url.startsWith('http') && !seen.has(url)) {
        seen.add(url);
        urlsToTry.push({ url, sourceId });
      }
    }

    // 1) URL fornecida direto pelo Flutter
    if (providedUrl) addUrl(providedUrl, 'provided');

    // 2) URL direta do ID no cache
    if (comickById[mangaId]) addUrl(comickById[mangaId].url, comickById[mangaId].sourceId);

    // 3) TODOS os outros IDs com o mesmo título — cross-source lookup!
    const myEntry = comickById[mangaId];
    if (myEntry) {
      const key = titleKey(myEntry.title);
      const siblings = comickByTitle[key] || [];
      for (const sib of siblings) {
        if (sib.id !== mangaId) addUrl(sib.url, sib.sourceId);
      }
    }

    // 4) Fallback automático para IDs curtos do Comix
    if (/^[a-z0-9]{4,8}$/.test(mangaId)) {
      addUrl(`https://comix.to/title/${mangaId}`, 'comix-auto');
    }

    // 5) Rebusca se ainda está vazio
    if (urlsToTry.length === 0) {
      const query = mangaId.replace(/-[a-f0-9]{8}$/, '').replace(/-/g, ' ').trim();
      console.log(`[COMICK] Rebuscando: "${query}"`);
      try {
        const response = await fetchPOST(`${COMICK_BASE}/search`, { query, source: 'all' });
        const objects = parseJsonStream(response.buffer.toString('utf8'));
        for (const obj of objects) {
          if (!obj.results) continue;
          const srcId = (obj.source || '').toLowerCase();
          for (const r of obj.results) addUrl(r.url, srcId);
        }
      } catch (e) { console.warn('[COMICK] rebusca erro:', e.message); }
    }

    console.log(`[COMICK] Tentando ${urlsToTry.length} URLs para "${mangaId}"`);

    // Tenta cada URL até achar capítulos
    for (const { url: mangaUrl, sourceId } of urlsToTry) {
      try {
        console.log(`[COMICK]   → ${sourceId}: ${mangaUrl}`);
        const chapResp = await fetchPOST(`${COMICK_BASE}/chapters`, { url: mangaUrl });
        const chapText = chapResp.buffer.toString('utf8');
        const chapObjects = parseJsonStream(chapText);

        let chapters = [];
        let title = comickById[mangaId]?.title || mangaId;
        let coverUrl = comickById[mangaId]?.coverUrl || null;

        for (const obj of chapObjects) {
          if (obj.title) title = obj.title;
          if (obj.coverImage) coverUrl = obj.coverImage;

          const list = obj.chapters || obj.items || obj.data || [];
          if (Array.isArray(list) && list.length > 0) {
            chapters = list
              .filter(c => c.url || c.id)
              .map(c => ({
                id: Buffer.from(c.url || String(c.id) || '').toString('base64'),
                title: c.title || `Capítulo ${c.chap || c.number}`,
                chapterNumber: String(c.chap || c.number || '0'),
                source: 'comick',
              }));
            break;
          }
        }

        if (chapters.length > 0) {
          console.log(`[COMICK] ✓ ${chapters.length} capítulos via ${sourceId}`);
          return { title, coverUrl, description: '', chapters, source: 'comick' };
        }

        console.log(`[COMICK]   ✗ ${sourceId}: 0 capítulos`);
      } catch (e) {
        console.warn(`[COMICK]   ✗ ${sourceId} erro: ${e.message}`);
      }
    }

    console.warn(`[COMICK] Todas as ${urlsToTry.length} URLs falharam para "${mangaId}"`);
    return { title: comickById[mangaId]?.title || mangaId, coverUrl: comickById[mangaId]?.coverUrl || null, description: '', chapters: [], source: 'comick' };
  } catch (e) {
    console.error('[COMICK] getManga erro:', e.message);
    return { title: mangaId, coverUrl: null, description: '', chapters: [], source: 'comick' };
  }
}

async function comickGetPages(chapterHid) {
  try {
    // chapterHid = base64 da URL do capítulo
    const chapterUrl = Buffer.from(chapterHid, 'base64').toString('utf8');
    if (!chapterUrl.startsWith('http')) {
      console.warn(`[COMICK] ID não é base64 válido: ${chapterHid}`);
      return [];
    }
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
    const seen = new Set();
    const pages = [];

    // Padrão 1: JSON embutido no script com arrays de imagens
    const scriptMatches = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const script of scriptMatches) {
      const imgArrays = script.match(/"(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?)"/g) || [];
      for (const m of imgArrays) {
        const url = m.slice(1, -1);
        if (!seen.has(url) && !url.includes('thumb') && !url.includes('avatar') && !url.includes('logo') && url.length > 40) {
          seen.add(url);
          pages.push(url);
        }
      }
      if (pages.length > 5) break; // Achou imagens suficientes no script
    }

    // Padrão 2: tags <img> com src ou data-src (fallback)
    if (pages.length < 3) {
      const imgMatches = html.match(/(?:src|data-src)="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi) || [];
      for (const m of imgMatches) {
        const url = m.replace(/(?:src|data-src)="|"$/gi, '');
        if (!seen.has(url) && !url.includes('thumb') && !url.includes('avatar') && !url.includes('logo') && url.length > 40) {
          seen.add(url);
          pages.push(url);
        }
      }
    }

    console.log(`[COMICK] ${pages.length} páginas extraídas de ${chapterUrl}`);
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
  status: 'ok', version: '13.0-comick-cache',
  sources: ['mangaplus', 'comick', 'mangadex', 'anilist'],
  comickCacheSize: Object.keys(comickUrlCache).length,
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
// Comick: o parâmetro &url= é opcional mas acelera se passado
app.get('/manga', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id, source, url } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[MANGA] id="${id}" source="${source}" url="${url ? url.slice(0, 60) + '...' : '-'}"`);

  if (source === 'mangaplus' || /^\d{5,7}$/.test(id)) {
    try {
      const d = await mpGetTitle(id);
      console.log(`[MANGA] MP: "${d.title}" | ${d.chapters.length} caps`);
      return res.json({ ...d, source: 'mangaplus' });
    } catch (e) { console.error('[MANGA] MP erro:', e.message); }
  }

  if (source === 'comick') {
    const providedUrl = url ? decodeURIComponent(url) : null;
    const d = await comickGetManga(id, providedUrl);
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
            chapters = cd.data.map(ch => ({
              id: ch.id,
              title: ch.attributes.title || `Capítulo ${ch.attributes.chapter}`,
              chapterNumber: ch.attributes.chapter || '0',
              lang,
              source: 'mangadex'
            }));
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
  console.log(`[CHAPTER] id="${id.slice(0, 30)}..." source="${source}"`);

  if (source === 'mangaplus' || /^\d{6,10}$/.test(id)) {
    try {
      const pageData = await mpGetPages(id);
      if (pageData.length > 0) {
        const base = `${req.protocol}://${req.get('host')}`;
        const pages = pageData.map(p =>
          `${base}/image-proxy?url=${encodeURIComponent(p.imageUrl)}${p.encryptionKey ? '&key=' + encodeURIComponent(p.encryptionKey) : ''}`
        );
        console.log(`[CHAPTER] MP: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangaplus' });
      }
    } catch (e) { console.error('[CHAPTER] MP erro:', e.message); }
  }

  if (source === 'comick') {
    try {
      const pages = await comickGetPages(id);
      if (pages.length > 0) {
        console.log(`[CHAPTER] Comick: ${pages.length} páginas`);
        return res.json({ pages, source: 'comick' });
      }
      console.warn('[CHAPTER] Comick: 0 páginas');
      return res.json({ pages: [], source: 'comick' });
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
  if (!id) return res.json({ ids_mapeados: MANGA_IDS, comick_cache: Object.keys(comickUrlCache) });
  try {
    const d = await mpGetTitle(id);
    res.json({ ok: true, titulo: d.title, capitulos: d.chapters.length, capa: d.coverUrl });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

// ─── GET /debug-comick?id=... ───────────────────────────────────────────────
app.get('/debug-comick', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id } = req.query;
  if (!id) return res.status(400).json({
    error: 'id obrigatório',
    cachedIds: Object.keys(comickById).slice(0, 30),
    titleKeys: Object.keys(comickByTitle).slice(0, 20),
  });

  const entry = comickById[id];
  const key = entry ? titleKey(entry.title) : null;
  const siblings = key ? (comickByTitle[key] || []) : [];

  // Testa todas as URLs relacionadas
  const urlsToTest = [];
  if (entry?.url) urlsToTest.push({ url: entry.url, sourceId: entry.sourceId });
  for (const sib of siblings) {
    if (sib.id !== id && sib.url && !urlsToTest.find(u => u.url === sib.url)) {
      urlsToTest.push({ url: sib.url, sourceId: sib.sourceId });
    }
  }

  const results = [];
  for (const { url, sourceId } of urlsToTest.slice(0, 8)) {
    try {
      const chapResp = await fetchPOST(`${COMICK_BASE}/chapters`, { url });
      const chapText = chapResp.buffer.toString('utf8');
      const objects = parseJsonStream(chapText);
      const chapterCount = objects.reduce((n, o) => {
        const list = o.chapters || o.items || o.data || [];
        return n + (Array.isArray(list) ? list.length : 0);
      }, 0);
      results.push({ sourceId, url, rawSample: chapText.slice(0, 150), chapterCount });
    } catch (e) {
      results.push({ sourceId, url, erro: e.message, chapterCount: 0 });
    }
  }

  return res.json({
    id, entry, titleKey: key, siblings: siblings.length,
    testedUrls: urlsToTest.length, results,
  });
});


// ─── GET /debug?id=... ───────────────────────────────────────────────────────
app.get('/debug', async (req, res) => {
  const { id } = req.query;
  if (!id) return res.json({ ids_mapeados: MANGA_IDS, comick_cache: Object.keys(comickUrlCache) });
  try {
    const d = await mpGetTitle(id);
    res.json({ ok: true, titulo: d.title, capitulos: d.chapters.length, capa: d.coverUrl });
  } catch (e) { res.json({ ok: false, erro: e.message }); }
});

// ─── GET /debug-comick?id=... — testa todas as URLs cacheadas do ID ─────────
app.get('/debug-comick', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório', cacheKeys: Object.keys(comickAllUrls).slice(0, 20) });

  const allUrls = comickAllUrls[id] || [];
  const mainUrl = comickUrlCache[id] || null;
  const results = [];

  for (const { url: mangaUrl, sourceId } of allUrls) {
    try {
      const chapResp = await fetchPOST(`${COMICK_BASE}/chapters`, { url: mangaUrl });
      const chapText = chapResp.buffer.toString('utf8');
      const objects = parseJsonStream(chapText);
      const chapterCount = objects.reduce((n, o) => {
        const list = o.chapters || o.items || o.data || [];
        return n + (Array.isArray(list) ? list.length : 0);
      }, 0);
      results.push({ sourceId, url: mangaUrl, rawSample: chapText.slice(0, 200), chapterCount });
    } catch (e) {
      results.push({ sourceId, url: mangaUrl, erro: e.message, chapterCount: 0 });
    }
  }

  // Se não tem nada no cache, tenta montar URL automática
  if (allUrls.length === 0 && /^[a-z0-9]{4,8}$/.test(id)) {
    const autoUrl = `https://comix.to/title/${id}`;
    try {
      const chapResp = await fetchPOST(`${COMICK_BASE}/chapters`, { url: autoUrl });
      const chapText = chapResp.buffer.toString('utf8');
      results.push({ sourceId: 'comix-auto', url: autoUrl, rawSample: chapText.slice(0, 200), chapterCount: 0 });
    } catch (e) {
      results.push({ sourceId: 'comix-auto', url: autoUrl, erro: e.message });
    }
  }

  return res.json({ id, mainUrl, cachedUrls: allUrls, results });
});

app.listen(PORT, () => console.log(`Proxy v13.0 na porta ${PORT}`));
