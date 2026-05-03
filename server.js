const express = require('express');
const https = require('https');
const http = require('http');

const app = express();
const PORT = process.env.PORT || 3000;
const FLARESOLVERR_URL = process.env.FLARESOLVERR_URL || null;

// ─── HTTP helpers ─────────────────────────────────────────────────────────────

function fetchRaw(url, referer) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const headers = {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      'Accept-Language': 'en-US,en;q=0.9',
    };
    if (referer) headers['Referer'] = referer;
    lib.get(url, { headers }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRaw(res.headers.location, referer).then(resolve).catch(reject);
      }
      let data = '';
      res.on('data', c => data += c);
      res.on('end', () => resolve({ html: data, status: res.statusCode }));
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

async function fetchWithFlare(url, referer) {
  if (FLARESOLVERR_URL) {
    try {
      const payload = JSON.stringify({ cmd: 'request.get', url, maxTimeout: 60000 });
      const result = await postJSON(FLARESOLVERR_URL + '/v1', payload);
      if (result?.solution?.response) {
        return { html: result.solution.response, status: result.solution.status };
      }
    } catch (e) {
      console.warn('[Flare] erro:', e.message);
    }
  }
  return fetchRaw(url, referer);
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

function isCloudflareBlock(html) {
  return html.includes('cf-browser-verification') || 
         html.includes('Just a moment') || 
         html.includes('Checking your browser') ||
         html.includes('cf_chl_');
}

function isUuid(str) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(str);
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
// GET /search?q=...
// ─────────────────────────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH] "${query}"`);

  // Fonte 1: WeebCentral via FlareSolverr
  try {
    const url = `https://weebcentral.com/search?query=${encodeURIComponent(query)}&type=series`;
    const { html } = await fetchWithFlare(url);
    if (!isCloudflareBlock(html)) {
      const results = parseWeebSearch(html);
      if (results.length > 0) {
        console.log(`[SEARCH] WeebCentral: ${results.length}`);
        return res.json({ results, source: 'weebcentral' });
      }
    } else {
      console.warn('[SEARCH] WeebCentral: Cloudflare block');
    }
  } catch (e) {
    console.warn(`[SEARCH] WeebCentral erro: ${e.message}`);
  }

  // Fonte 2: MangaDex API
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
  } catch (e) {
    console.error(`[SEARCH] MangaDex erro: ${e.message}`);
  }

  res.json({ results: [], source: 'none' });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manga?id=...&source=...
// ─────────────────────────────────────────────────────────────────────────────
app.get('/manga', async (req, res) => {
  const { id, source } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[MANGA] id="${id}" source="${source}"`);

  // WeebCentral
  if (!source || source === 'weebcentral') {
    try {
      const url = id.startsWith('http') ? id : `https://weebcentral.com/series/${id}`;
      const { html } = await fetchWithFlare(url);
      if (!isCloudflareBlock(html)) {
        return res.json({ ...parseWeebManga(html), source: 'weebcentral' });
      }
    } catch (e) {
      console.error(`[MANGA] WeebCentral erro: ${e.message}`);
    }
  }

  // MangaDex
  try {
    const detail = await fetchJSON(`https://api.mangadex.org/manga/${id}?includes[]=cover_art`);
    const m = detail.data;
    const title = m.attributes.title.en || m.attributes.title['pt-br'] || Object.values(m.attributes.title)[0] || '';
    const cover = m.relationships.find(r => r.type === 'cover_art');
    const coverUrl = cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes?.fileName}.512.jpg` : null;

    // Busca capítulos em PT-BR e EN
    let chapters = [];
    for (const lang of ['pt-br', 'en']) {
      try {
        const chapData = await fetchJSON(
          `https://api.mangadex.org/manga/${id}/feed?translatedLanguage[]=${lang}&order[chapter]=desc&limit=100`
        );
        if (chapData.data?.length > 0) {
          chapters = chapData.data.map(ch => ({
            id: ch.id,
            title: ch.attributes.title || `Capítulo ${ch.attributes.chapter}`,
            chapterNumber: ch.attributes.chapter || '0',
            lang,
            source: 'mangadex',
          }));
          break;
        }
      } catch (_) {}
    }

    return res.json({ title, coverUrl, description: m.attributes.description?.en || m.attributes.description?.['pt-br'] || '', chapters, source: 'mangadex' });
  } catch (e) {
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /chapter?id=...&source=...&url=...
// Para One Piece e títulos sem páginas no MangaDex:
//   usa WeebCentral via FlareSolverr buscando pelo título
// ─────────────────────────────────────────────────────────────────────────────
app.get('/chapter', async (req, res) => {
  const { id, url: chUrl, source, title, chapterNumber } = req.query;
  console.log(`[CHAPTER] id="${id}" source="${source}" title="${title}" ch="${chapterNumber}"`);

  // 1. MangaDex direto (funciona para a maioria dos títulos)
  if (id && (source === 'mangadex' || isUuid(id))) {
    try {
      const data = await fetchJSON(`https://api.mangadex.org/at-home/server/${id}`);
      const base = data.baseUrl, hash = data.chapter?.hash;
      const pages = (data.chapter?.data || []).map(f => `${base}/data/${hash}/${f}`);
      if (pages.length > 0) {
        console.log(`[CHAPTER] MangaDex: ${pages.length} páginas`);
        return res.json({ pages, source: 'mangadex' });
      }
      console.warn('[CHAPTER] MangaDex: 0 páginas (DMCA), tentando WeebCentral');
    } catch (e) {
      console.warn(`[CHAPTER] MangaDex erro: ${e.message}`);
    }
  }

  // 2. WeebCentral via FlareSolverr
  //    Precisa do título do mangá e número do capítulo para achar no WeebCentral
  if (title && chapterNumber) {
    try {
      // Busca o mangá no WeebCentral
      const searchUrl = `https://weebcentral.com/search?query=${encodeURIComponent(title)}&type=series`;
      const { html: searchHtml } = await fetchWithFlare(searchUrl);

      if (!isCloudflareBlock(searchHtml)) {
        const results = parseWeebSearch(searchHtml);
        if (results.length > 0) {
          const seriesId = results[0].id;
          // Abre a página da série
          const seriesUrl = `https://weebcentral.com/series/${seriesId}`;
          const { html: seriesHtml } = await fetchWithFlare(seriesUrl);

          if (!isCloudflareBlock(seriesHtml)) {
            const manga = parseWeebManga(seriesHtml);
            // Acha o capítulo pelo número
            const chapter = manga.chapters.find(c =>
              parseFloat(c.chapterNumber) === parseFloat(chapterNumber)
            ) || manga.chapters[0];

            if (chapter) {
              // Pega as páginas do capítulo
              const imgUrl = `https://weebcentral.com/chapters/${chapter.id}/images?is_prev=False&current_page=1&reading_style=long_strip`;
              const { html: imgHtml } = await fetchWithFlare(imgUrl, seriesUrl);
              const pages = parseWeebPages(imgHtml);
              if (pages.length > 0) {
                console.log(`[CHAPTER] WeebCentral: ${pages.length} páginas`);
                return res.json({ pages, source: 'weebcentral' });
              }
            }
          }
        }
      }
    } catch (e) {
      console.error(`[CHAPTER] WeebCentral erro: ${e.message}`);
    }
  }

  // 3. URL direta
  if (chUrl) {
    try {
      const { html } = await fetchWithFlare(chUrl);
      const pages = parseWeebPages(html);
      if (pages.length > 0) return res.json({ pages, source: 'url' });
    } catch (e) {
      console.error(`[CHAPTER] URL erro: ${e.message}`);
    }
  }

  res.json({ pages: [], source: 'none', error: 'Nenhuma fonte retornou páginas. Tente passar title= e chapterNumber= na requisição.' });
});

// ─── Parsers WeebCentral ──────────────────────────────────────────────────────

function parseWeebSearch(html) {
  const results = [];
  const re = /href="https:\/\/weebcentral\.com\/series\/([A-Z0-9]{26})"[^>]*>([\s\S]*?)(?=href="|<\/(?:li|section|ul))/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const id = m[1];
    const block = m[2];
    const titleM = block.match(/<strong[^>]*>([^<]+)<\/strong>/) || block.match(/alt="([^"]{3,80})"/);
    const imgM = block.match(/src="(https:\/\/[^"]+\.(?:jpg|png|webp)[^"]*)"/);
    if (titleM) {
      results.push({
        id, title: titleM[1].trim(),
        coverUrl: imgM ? imgM[1] : null,
        url: `https://weebcentral.com/series/${id}`,
        source: 'weebcentral',
      });
    }
  }
  return [...new Map(results.map(r => [r.id, r])).values()];
}

function parseWeebManga(html) {
  const title = (html.match(/<h1[^>]*>([^<]+)<\/h1>/) || [])[1]?.trim() || '';
  const coverM = html.match(/class="[^"]*lazy[^"]*"[^>]*src="([^"]+)"/) ||
                 html.match(/<img[^>]*src="(https:\/\/[^"]*(?:cover|thumb)[^"]+)"/i);
  const coverUrl = coverM ? coverM[1] : null;
  const descM = html.match(/class="[^"]*description[^"]*"[^>]*>([\s\S]*?)<\/(?:p|div)>/);
  const description = descM ? descM[1].replace(/<[^>]+>/g, '').trim() : '';

  const chapters = [];
  const re = /href="https:\/\/weebcentral\.com\/chapters\/([A-Z0-9]{26})"[^>]*>([\s\S]*?)(?=href="|<\/(?:li|section))/g;
  let m;
  while ((m = re.exec(html)) !== null) {
    const chapId = m[1];
    const block = m[2];
    const numM = block.match(/Chapter\s+(\d+\.?\d*)/i) || block.match(/(\d+\.?\d*)/);
    if (chapId) {
      chapters.push({
        id: chapId,
        title: `Capítulo ${numM ? numM[1] : '?'}`,
        chapterNumber: numM ? numM[1] : '0',
        source: 'weebcentral',
      });
    }
  }
  return { title, coverUrl, description, chapters };
}

function parseWeebPages(html) {
  const pages = [];
  const re = /<img[^>]*src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
  let m;
  while ((m = re.exec(html)) !== null) {
    const u = m[1];
    if (!u.includes('icon') && !u.includes('logo') && !u.includes('avatar') && !u.includes('favicon')) {
      pages.push(u);
    }
  }
  const re2 = /data-src="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi;
  while ((m = re2.exec(html)) !== null) pages.push(m[1]);
  return [...new Set(pages)];
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Manga Proxy na porta ${PORT} | FlareSolverr: ${FLARESOLVERR_URL || 'não configurado'}`);
});
