const express = require('express');
const https   = require('https');
const http    = require('http');

const app  = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════════════════════
//  CACHE EM MEMÓRIA
// ══════════════════════════════════════════════════════════════════════════════

const _cache = new Map();
const TTL_SHORT = 10 * 60 * 1000;   // 10 min — títulos/capítulos
const TTL_LONG  = 60 * 60 * 1000;   // 60 min — buscas genéricas (home)

// Termos que a home busca no startup — serão pré-aquecidos
const HOME_QUERIES  = ['romance', 'action', 'horror', 'adventure', 'popular', 'trending', 'seinen', 'shounen'];
const HOME_QUERY_SET = new Set(HOME_QUERIES);

function cached(key, fn, ttl = TTL_SHORT) {
  const hit = _cache.get(key);
  if (hit && Date.now() - hit.ts < hit.ttl) {
    console.log(`[CACHE] HIT ${key}`);
    return Promise.resolve(hit.value);
  }
  return fn().then(v => { _cache.set(key, { value: v, ts: Date.now(), ttl }); return v; });
}

setInterval(() => {
  const now = Date.now();
  for (const [k, v] of _cache.entries()) {
    if (now - v.ts > v.ttl) _cache.delete(k);
  }
}, 20 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════════════════
//  HTTP HELPERS
// ══════════════════════════════════════════════════════════════════════════════

const DEFAULT_TIMEOUT = 8000;

function fetchRaw(url, headers = {}, timeoutMs = DEFAULT_TIMEOUT) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'okhttp/4.9.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRaw(res.headers.location, headers, timeoutMs).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), status: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout ${timeoutMs}ms: ${url}`)); });
  });
}

function fetchJSON(url, headers = {}, timeoutMs = DEFAULT_TIMEOUT) {
  return fetchRaw(url, { Accept: 'application/json', ...headers }, timeoutMs)
    .then(r => JSON.parse(r.buffer.toString('utf8')));
}

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ══════════════════════════════════════════════════════════════════════════════
//  MANGADEX  (fonte principal — busca, metadata e leitura)
// ══════════════════════════════════════════════════════════════════════════════

const MDX    = 'https://api.mangadex.org';
const COVERS = 'https://uploads.mangadex.org/covers';

function mdxCoverUrl(mangaId, fileName) {
  return fileName ? `${COVERS}/${mangaId}/${fileName}.512.jpg` : null;
}

function mdxExtractTitle(attrs) {
  return attrs.title['pt-br'] || attrs.title.en || Object.values(attrs.title)[0] || '';
}

function mdxExtractDesc(attrs) {
  return attrs.description?.['pt-br'] || attrs.description?.en || '';
}

// ── Busca ─────────────────────────────────────────────────────────────────────
// Filtra para só retornar mangás que tenham tradução pt-br OU en disponível.
// availableTranslatedLanguage garante que o MangaDex só retorne títulos
// que tenham pelo menos um capítulo traduzido nessas línguas.
async function mdxSearch(query, ttl = TTL_SHORT) {
  return cached(`mdx:search:${query}`, async () => {
    const url =
      `${MDX}/manga?title=${encodeURIComponent(query)}&limit=20` +
      `&order[relevance]=desc` +
      `&includes[]=cover_art` +
      `&contentRating[]=safe&contentRating[]=suggestive` +
      `&availableTranslatedLanguage[]=pt-br` +
      `&availableTranslatedLanguage[]=en`;

    const data = await fetchJSON(url);
    if (!data.data?.length) return [];

    return data.data.map(m => {
      const cover = m.relationships.find(r => r.type === 'cover_art');
      return {
        id:       m.id,
        title:    mdxExtractTitle(m.attributes),
        coverUrl: mdxCoverUrl(m.id, cover?.attributes?.fileName),
        source:   'mangadex',
      };
    });
  }, ttl);
}

// ── Detalhes do manga (título, capa, sinopse, capítulos) ──────────────────────
async function mdxGetManga(mangaId) {
  return cached(`mdx:manga:${mangaId}`, async () => {
    // Busca metadata e capítulos pt-br em paralelo
    const [metaRes, chapPtRes] = await Promise.allSettled([
      fetchJSON(`${MDX}/manga/${mangaId}?includes[]=cover_art`),
      fetchJSON(`${MDX}/manga/${mangaId}/feed?translatedLanguage[]=pt-br&order[chapter]=asc&limit=500`),
    ]);

    if (metaRes.status === 'rejected') throw metaRes.reason;
    const m = metaRes.value.data;
    const cover = m.relationships.find(r => r.type === 'cover_art');

    let chapters = [];
    let lang = 'pt-br';

    if (chapPtRes.status === 'fulfilled' && chapPtRes.value.data?.length > 0) {
      chapters = chapPtRes.value.data.map(ch => ({
        id:            ch.id,
        title:         ch.attributes.title || `Capítulo ${ch.attributes.chapter}`,
        chapterNumber: ch.attributes.chapter || '0',
        lang:          'pt-br',
        source:        'mangadex',
      }));
    } else {
      // Fallback inglês
      lang = 'en';
      try {
        const enData = await fetchJSON(
          `${MDX}/manga/${mangaId}/feed?translatedLanguage[]=en&order[chapter]=asc&limit=500`
        );
        chapters = (enData.data || []).map(ch => ({
          id:            ch.id,
          title:         ch.attributes.title || `Chapter ${ch.attributes.chapter}`,
          chapterNumber: ch.attributes.chapter || '0',
          lang:          'en',
          source:        'mangadex',
        }));
      } catch (_) {}
    }

    return {
      title:       mdxExtractTitle(m.attributes),
      coverUrl:    mdxCoverUrl(m.id, cover?.attributes?.fileName),
      description: mdxExtractDesc(m.attributes),
      lang,
      chapters,
      source: 'mangadex',
    };
  });
}

// ── Páginas de um capítulo ────────────────────────────────────────────────────
async function mdxGetPages(chapterId) {
  return cached(`mdx:pages:${chapterId}`, async () => {
    const data = await fetchJSON(`${MDX}/at-home/server/${chapterId}`);
    return (data.chapter?.data || []).map(f => `${data.baseUrl}/data/${data.chapter.hash}/${f}`);
  });
}

// ══════════════════════════════════════════════════════════════════════════════
//  ANILIST — DESATIVADO
//  Metadata extra: score, gêneros, personagens, banner.
//  Para reativar: descomente este bloco + a rota /meta no final.
// ══════════════════════════════════════════════════════════════════════════════

/*
function fetchPOST(url, body, headers = {}, timeoutMs = DEFAULT_TIMEOUT) {
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
        'User-Agent': 'Mozilla/5.0',
        ...headers,
      },
    };
    const req = https.request(options, (res) => {
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), status: res.statusCode }));
    });
    req.on('error', reject);
    req.setTimeout(timeoutMs, () => { req.destroy(); reject(new Error(`Timeout ${timeoutMs}ms`)); });
    req.write(data);
    req.end();
  });
}

async function anilistGetMeta(anilistId) {
  return cached(`al:meta:${anilistId}`, async () => {
    const gql = `query ($id: Int) { Media(id: $id, type: MANGA) {
      id title { romaji english native }
      coverImage { extraLarge large } bannerImage
      description(asHtml: false) averageScore genres status chapters
      startDate { year }
      characters(sort: ROLE, page: 1, perPage: 6) { nodes { name { full } image { medium } } }
    } }`;
    try {
      const res = await fetchPOST('https://graphql.anilist.co', { query: gql, variables: { id: Number(anilistId) } });
      const json = JSON.parse(res.buffer.toString());
      const m = json.data?.Media;
      if (!m) return null;
      return {
        anilistId:     m.id,
        title:         m.title.english || m.title.romaji || '',
        coverUrl:      m.coverImage?.extraLarge || m.coverImage?.large || null,
        bannerUrl:     m.bannerImage || null,
        description:   m.description || '',
        score:         m.averageScore || null,
        genres:        m.genres || [],
        status:        m.status || '',
        totalChapters: m.chapters || null,
        year:          m.startDate?.year || null,
        characters:    (m.characters?.nodes || []).map(c => ({
          name:  c.name?.full || '',
          image: c.image?.medium || null,
        })),
      };
    } catch (e) { return null; }
  });
}
*/

// ══════════════════════════════════════════════════════════════════════════════
//  MANGAPLUS — DESATIVADO
//  Capítulos semanais oficiais Shueisha (One Piece, JJK, etc).
//  Conteúdo em inglês/japonês apenas — sem pt-br oficial.
//  Para reativar: cole o bloco completo da v13 aqui.
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
//  COMICK — DESATIVADO
//  Aggregador instável (timeouts frequentes).
//  Para reativar: cole o bloco completo da v13 aqui.
// ══════════════════════════════════════════════════════════════════════════════

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({
  status:    'ok',
  version:   '14.0-ptbr',
  sources:   ['mangadex'],
  endpoints: ['/', '/search', '/manga', '/chapter'],
}));

// ─── GET /search?q=... ────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q obrigatório' });

  const ttl = HOME_QUERY_SET.has(q.toLowerCase().trim()) ? TTL_LONG : TTL_SHORT;
  console.log(`[SEARCH] "${q}"`);

  try {
    const results = await mdxSearch(q, ttl);
    console.log(`[SEARCH] ${results.length} resultados`);
    return res.json({ results, source: 'mangadex' });
  } catch (e) {
    console.error('[SEARCH] erro:', e.message);
    return res.json({ results: [], source: 'none' });
  }
});

// ─── GET /manga?id=... ────────────────────────────────────────────────────────
app.get('/manga', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[MANGA] id="${id}"`);

  try {
    const d = await mdxGetManga(id);
    console.log(`[MANGA] "${d.title}" | ${d.chapters.length} caps | lang=${d.lang}`);
    return res.json(d);
  } catch (e) {
    console.error('[MANGA] erro:', e.message);
    return res.status(500).json({ error: e.message });
  }
});

// ─── GET /chapter?id=... ──────────────────────────────────────────────────────
app.get('/chapter', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[CHAPTER] id="${id}"`);

  try {
    const pages = await mdxGetPages(id);
    console.log(`[CHAPTER] ${pages.length} páginas`);
    return res.json({ pages, source: 'mangadex' });
  } catch (e) {
    console.error('[CHAPTER] erro:', e.message);
    return res.json({ pages: [], source: 'none' });
  }
});

// ─── GET /meta?id=<anilist_id> ────────────────────────────────────────────────
// Descomente quando reativar o bloco Anilist acima.
/*
app.get('/meta', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  const meta = await anilistGetMeta(id);
  if (!meta) return res.status(404).json({ error: 'não encontrado' });
  return res.json(meta);
});
*/

// ══════════════════════════════════════════════════════════════════════════════
//  WARM CACHE — pré-aquece os termos da home no startup
// ══════════════════════════════════════════════════════════════════════════════

async function warmCache() {
  console.log(`[CACHE] Aquecendo ${HOME_QUERIES.length} queries da home...`);
  await Promise.allSettled(HOME_QUERIES.map(q => mdxSearch(q, TTL_LONG)));
  console.log('[CACHE] Aquecimento concluído.');
}

app.listen(PORT, () => {
  console.log(`Proxy v14.0-ptbr na porta ${PORT}`);
  setTimeout(warmCache, 2000);
});
