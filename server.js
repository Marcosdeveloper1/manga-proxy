const express = require('express');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── FlareSolverr (opcional) ──────────────────────────────────────────────────
// Se tiver o FlareSolverr rodando em algum lugar, coloque a URL como
// variável de ambiente FLARESOLVERR_URL no Railway.
// Ex: https://flaresolverr-xxxxx.up.railway.app
// Sem ele, usa fetch normal (pode não passar Cloudflare pesado).
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || null;

async function fetchPage(targetUrl, referer) {
  if (FLARESOLVERR_URL) {
    try {
      const payload = JSON.stringify({ cmd: 'request.get', url: targetUrl, maxTimeout: 60000 });
      const result = await postJSON(FLARESOLVERR_URL + '/v1', payload);
      if (result?.solution?.response) return result.solution.response;
    } catch (e) {
      console.warn('[FlareSolverr] erro, usando fetch direto:', e.message);
    }
  }
  return fetchRaw(targetUrl, referer);
}

function fetchRaw(url, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (referer) headers['Referer'] = referer;
    lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRaw(res.headers.location, referer).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => resolve(data));
    }).on('error', reject);
  });
}

function postJSON(url, body) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const u = new URL(url);
    const opts = {
      hostname: u.hostname, port: u.port || (url.startsWith('https') ? 443 : 80),
      path: u.pathname, method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) },
    };
    const req = lib.request(opts, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    });
    req.on('error', reject);
    req.write(body);
    req.end();
  });
}

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, { headers: { 'User-Agent': 'MangaApp/1.0', 'Accept': 'application/json' } }, (res) => {
      let d = '';
      res.on('data', c => d += c);
      res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } });
    }).on('error', reject);
  });
}

// ─── CORS ─────────────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  next();
});

// ─── Health ───────────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', flaresolverr: !!FLARESOLVERR_URL });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /search?q=naruto
// Fonte 1: WeebCentral (sucessor MangaSee/MangaLife, catálogo enorme)
// Fonte 2: MangaDex API (fallback sem Cloudflare)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH] "${query}"`);

  // Fonte 1: WeebCentral
  try {
    const url = `https://weebcentral.com/search?query=${encodeURIComponent(query)}&type=series`;
    const html = await fetchPage(url);
    if (html.includes('cf-browser-verification') || html.includes('Just a moment')) {
      throw new Error('Cloudflare block');
    }
    const results = parseWeebSearch(html);
    if (results.length > 0) {
      console.log(`[SEARCH] WeebCentral ok: ${results.length}`);
      return res.json({ results, source: 'weebcentral' });
    }
  } catch (e) {
    console.warn(`[SEARCH] WeebCentral falhou: ${e.message}`);
  }

  // Fonte 2: MangaDex
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
      console.log(`[SEARCH] MangaDex ok: ${results.length}`);
      return res.json({ results, source: 'mangadex' });
    }
  } catch (e) {
    console.error(`[SEARCH] MangaDex falhou: ${e.message}`);
  }

  res.json({ results: [], source: 'none' });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manga?id=<id>&source=weebcentral|mangadex
// ─────────────────────────────────────────────────────────────────────────────
app.get('/manga', async (req, res) => {
  const { id, source } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[MANGA] id="${id}" source="${source}"`);

  if (!source || source === 'weebcentral') {
    try {
      const url = id.startsWith('http') ? id : `https://weebcentral.com/series/${id}`;
      const html = await fetchPage(url);
      if (!html.includes('cf-browser-verification') && !html.includes('Just a moment')) {
        return res.json({ ...parseWeebManga(html, id), source: 'weebcentral' });
      }
    } catch (e) {
      console.error(`[MANGA] WeebCentral erro: ${e.message}`);
    }
  }

  // MangaDex fallback
  try {
    const detail = await fetchJSON(`https://api.mangadex.org/manga/${id}?includes[]=cover_art`);
    const m = detail.data;
    const title = m.attributes.title.en || Object.values(m.attributes.title)[0] || '';
    const cover = m.relationships.find(r => r.type === 'cover_art');
    const coverUrl = cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes?.fileName}.512.jpg` : null;
    const chapData = await fetchJSON(`https://api.mangadex.org/manga/${id}/feed?translatedLanguage[]=en&order[chapter]=desc&limit=100`);
    const chapters = (chapData.data || []).map(ch => ({
      id: ch.id,
      title: ch.attributes.title || `Capítulo ${ch.attributes.chapter}`,
      chapterNumber: ch.attributes.chapter || '0',
      source: 'mangadex',
    }));
    return res.json({ title, coverUrl, description: m.attributes.description?.en || '', chapters, source: 'mangadex' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /chapter?id=<id>&source=weebcentral|mangadex
// GET /chapter?url=<url_completa>
// ─────────────────────────────────────────────────────────────────────────────
app.get('/chapter', async (req, res) => {
  const { id, url: chUrl, source } = req.query;
  console.log(`[CHAPTER] id="${id}" source="${source}"`);

  // WeebCentral: tem endpoint JSON nativo para imagens!
  if (id && (!source || source === 'weebcentral')) {
    try {
      // Endpoint oficial do WeebCentral para imagens do capítulo
      const imgUrl = `https://weebcentral.com/chapters/${id}/images?is_prev=False&current_page=1&reading_style=long_strip`;
      const html = await fetchPage(imgUrl, `https://weebcentral.com/chapters/${id}`);
      const pages = parseWeebPages(html);
      if (pages.length > 0) {
        console.log(`[CHAPTER] WeebCentral: ${pages.length} páginas`);
        return res.json({ pages, source: 'weebcentral' });
      }
    } catch (e) {
      console.error(`[CHAPTER] WeebCentral erro: ${e.message}`);
    }
  }

  // URL direta (qualquer fonte)
  if (chUrl) {
    try {
      const html = await fetchPage(chUrl);
      const pages = parseWeebPages(html);
      return res.json({ pages, source: 'url' });
    } catch (e) {
      console.error(`[CHAPTER] URL erro: ${e.message}`);
    }
  }

  // MangaDex
  if (id && (source === 'mangadex' || isUuid(id))) {
    try {
      const data = await fetchJSON(`https://api.mangadex.org/at-home/server/${id}`);
      const base = data.baseUrl, hash = data.chapter?.hash;
      const pages = (data.chapter?.data || []).map(f => `${base}/data/${hash}/${f}`);
      return res.json({ pages, source: 'mangadex' });
    } catch (e) {
      return res.status(500).json({ error: e.message });
    }
  }

  res.status(400).json({ error: 'Forneça id ou url' });
});

// ─── Parsers ──────────────────────────────────────────────────────────────────

function parseWeebSearch(html) {
  const results = [];
  // WeebCentral usa links /series/<ULID>
  const re = /href="https:\/\/weebcentral\.com\/series\/([^"\/\?]+)"[^>]*>([\s\S]*?)(?=href="|<\/section|<\/ul)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const block = m[2];
    if (!id || id.length < 10) continue; // ULID tem ~26 chars
    const titleM = block.match(/<strong[^>]*>([^<]+)<\/strong>/) || block.match(/alt="([^"]{3,80})"/);
    const imgM = block.match(/src="(https:\/\/[^"]+\.(?:jpg|png|webp)[^"]*)"/);
    if (titleM) {
      results.push({
        id,
        title: titleM[1].trim(),
        coverUrl: imgM ? imgM[1] : null,
        url: `https://weebcentral.com/series/${id}`,
        source: 'weebcentral',
      });
    }
  }
  return [...new Map(results.map(r => [r.id, r])).values()]; // deduplica
}

function parseWeebManga(html, seriesId) {
  const title = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1]?.trim() || '';
  const cover = (html.match(/class="[^"]*lazy[^"]*"[^>]*src="([^"]+)"/) ||
                 html.match(/<img[^>]*src="(https:\/\/[^"]*cover[^"]+)"/i) || [])[1] || null;
  const descM = html.match(/class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/);
  const description = descM ? descM[1].replace(/<[^>]+>/g, '').trim() : '';

  const chapters = [];
  const re = /href="https:\/\/weebcentral\.com\/chapters\/([^"\/\?]+)"[^>]*>([\s\S]*?)(?=href="|<\/li|<\/section)/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const chapId = m[1];
    const block = m[2];
    const numM = block.match(/Chapter\s+(\d+\.?\d*)/i) || block.match(/(\d+\.?\d*)/);
    const chapterNumber = numM ? numM[1] : '0';
    if (chapId && chapId.length > 5 && !chapId.includes('?')) {
      chapters.push({ id: chapId, title: `Capítulo ${chapterNumber}`, chapterNumber, source: 'weebcentral' });
    }
  }
  return { title, coverUrl: cover, description, chapters };
}

function parseWeebPages(html) {
  const pages = [];
  // Imagens do leitor
  const re = /<img[^>]*src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const url = m[1];
    // Filtra ícones/logos (geralmente pequenos, com "icon", "logo", "avatar")
    if (!url.includes('icon') && !url.includes('logo') && !url.includes('avatar')) {
      pages.push(url);
    }
  }
  // data-src (lazy loading)
  const re2 = /data-src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
  while ((m = re2.exec(html)) !== null) pages.push(m[1]);
  return [...new Set(pages)];
}

function isUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Manga Proxy na porta ${PORT} | FlareSolverr: ${FLARESOLVERR_URL || 'não configurado'}`);
});
