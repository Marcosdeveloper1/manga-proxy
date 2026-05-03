const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Browser compartilhado ────────────────────────────────────────────────────
let browser = null;

async function getBrowser() {
  if (!browser || !browser.connected) {
    browser = await puppeteer.launch({
      headless: 'new',
      args: [
        '--no-sandbox',
        '--disable-setuid-sandbox',
        '--disable-dev-shm-usage',
        '--disable-gpu',
        '--no-first-run',
        '--no-zygote',
        '--single-process',
      ],
    });
  }
  return browser;
}

async function fetchWithPuppeteer(url) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/webp,*/*;q=0.8',
      'Referer': 'https://www.google.com/',
    });
    await page.goto(url, { waitUntil: 'networkidle2', timeout: 45000 });
    // Aguarda o Cloudflare challenge resolver (se tiver)
    await new Promise(r => setTimeout(r, 4000));
    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

// ─── Helper: fetch JSON simples (sem Puppeteer) ───────────────────────────────
const https = require('https');
const http = require('http');

function fetchJSON(url) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    lib.get(url, {
      headers: {
        'User-Agent': 'MangaReaderApp/1.0',
        'Accept': 'application/json',
      }
    }, (res) => {
      let data = '';
      res.on('data', chunk => data += chunk);
      res.on('end', () => {
        try { resolve(JSON.parse(data)); }
        catch (e) { reject(new Error('JSON parse error')); }
      });
    }).on('error', reject);
  });
}

// ─── Middleware CORS ──────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  next();
});

// ─── Health check ─────────────────────────────────────────────────────────────
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Manga Proxy rodando!' });
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /search?q=naruto
// Fonte 1: MangaDex API (sem Cloudflare, JSON oficial)
// Fonte 2: MangaKakalot via Puppeteer (fallback)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Parâmetro q é obrigatório' });

  console.log(`[SEARCH] query="${query}"`);

  // ── Fonte 1: MangaDex ────────────────────────────────────────────────────
  try {
    const mdUrl = `https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=20&order[relevance]=desc&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica`;
    console.log(`[SEARCH] Tentando MangaDex...`);
    const data = await fetchJSON(mdUrl);

    if (data.data && data.data.length > 0) {
      const results = data.data.map(manga => {
        const title =
          manga.attributes.title.en ||
          manga.attributes.title.pt_br ||
          manga.attributes.title['pt-br'] ||
          Object.values(manga.attributes.title)[0] ||
          'Sem título';

        const coverRel = manga.relationships.find(r => r.type === 'cover_art');
        const coverUrl = coverRel
          ? `https://uploads.mangadex.org/covers/${manga.id}/${coverRel.attributes?.fileName}.512.jpg`
          : null;

        const desc =
          manga.attributes.description?.en ||
          manga.attributes.description?.['pt-br'] ||
          '';

        return {
          id: manga.id,
          title,
          coverUrl,
          description: desc,
          source: 'mangadex',
          status: manga.attributes.status,
        };
      });

      console.log(`[SEARCH] MangaDex retornou ${results.length} resultados`);
      return res.json({ results, source: 'mangadex' });
    }
  } catch (e) {
    console.warn(`[SEARCH] MangaDex falhou: ${e.message}`);
  }

  // ── Fonte 2: MangaKakalot via Puppeteer ──────────────────────────────────
  try {
    const url = `https://mangakakalot.gg/search/${encodeURIComponent(query)}`;
    console.log(`[SEARCH] Fallback Puppeteer: ${url}`);
    const html = await fetchWithPuppeteer(url);
    const results = parseKakalotSearch(html);
    console.log(`[SEARCH] Kakalot retornou ${results.length} resultados`);
    return res.json({ results, source: 'mangakakalot' });
  } catch (e) {
    console.error(`[SEARCH] Fallback também falhou: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /manga?id=<mangadex-uuid ou mangakakalot-slug>
// ─────────────────────────────────────────────────────────────────────────────
app.get('/manga', async (req, res) => {
  const id = req.query.id;
  const source = req.query.source || 'mangadex';
  if (!id) return res.status(400).json({ error: 'Parâmetro id é obrigatório' });

  console.log(`[MANGA] id="${id}" source="${source}"`);

  // ── MangaDex ─────────────────────────────────────────────────────────────
  if (source === 'mangadex') {
    try {
      // Detalhes do mangá
      const detailUrl = `https://api.mangadex.org/manga/${id}?includes[]=cover_art&includes[]=author`;
      const detail = await fetchJSON(detailUrl);
      const manga = detail.data;

      const title =
        manga.attributes.title.en ||
        manga.attributes.title['pt-br'] ||
        Object.values(manga.attributes.title)[0] || '';

      const coverRel = manga.relationships.find(r => r.type === 'cover_art');
      const coverUrl = coverRel
        ? `https://uploads.mangadex.org/covers/${manga.id}/${coverRel.attributes?.fileName}.512.jpg`
        : null;

      const desc =
        manga.attributes.description?.en ||
        manga.attributes.description?.['pt-br'] || '';

      // Capítulos (en ou pt-br)
      let chapters = [];
      let offset = 0;
      let total = Infinity;
      while (chapters.length < total) {
        const chapUrl = `https://api.mangadex.org/manga/${id}/feed?translatedLanguage[]=en&translatedLanguage[]=pt-br&order[chapter]=desc&limit=100&offset=${offset}`;
        const chapData = await fetchJSON(chapUrl);
        total = chapData.total || 0;
        if (!chapData.data || chapData.data.length === 0) break;
        chapters = chapters.concat(chapData.data.map(ch => ({
          id: ch.id,
          title: ch.attributes.title || `Capítulo ${ch.attributes.chapter}`,
          chapterNumber: ch.attributes.chapter || '0',
          volume: ch.attributes.volume,
          lang: ch.attributes.translatedLanguage,
          source: 'mangadex',
        })));
        offset += 100;
        if (offset >= total) break;
      }

      return res.json({ title, coverUrl, description: desc, chapters, source: 'mangadex' });
    } catch (e) {
      console.error(`[MANGA] MangaDex erro: ${e.message}`);
    }
  }

  // ── MangaKakalot via Puppeteer ────────────────────────────────────────────
  try {
    const url = id.startsWith('http') ? id : `https://mangakakalot.gg/${id}`;
    console.log(`[MANGA] Puppeteer: ${url}`);
    const html = await fetchWithPuppeteer(url);
    const data = parseKakalotManga(html);
    return res.json({ ...data, source: 'mangakakalot' });
  } catch (e) {
    console.error(`[MANGA] Kakalot erro: ${e.message}`);
    return res.status(500).json({ error: e.message });
  }
});

// ─────────────────────────────────────────────────────────────────────────────
// GET /chapter?id=<uuid>           (MangaDex)
// GET /chapter?url=<url completa>  (MangaKakalot)
// ─────────────────────────────────────────────────────────────────────────────
app.get('/chapter', async (req, res) => {
  const { id, url } = req.query;

  // ── MangaDex: retorna URLs das páginas via API oficial ────────────────────
  if (id) {
    console.log(`[CHAPTER] MangaDex id="${id}"`);
    try {
      const data = await fetchJSON(`https://api.mangadex.org/at-home/server/${id}`);
      const base = data.baseUrl;
      const hash = data.chapter?.hash;
      const pages = (data.chapter?.data || []).map(
        filename => `${base}/data/${hash}/${filename}`
      );
      return res.json({ pages, source: 'mangadex' });
    } catch (e) {
      console.error(`[CHAPTER] MangaDex erro: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  }

  // ── MangaKakalot: scraping com Puppeteer ─────────────────────────────────
  if (url) {
    console.log(`[CHAPTER] Puppeteer: ${url}`);
    try {
      const html = await fetchWithPuppeteer(url);
      const pages = parseKakalotChapter(html);
      return res.json({ pages, source: 'mangakakalot' });
    } catch (e) {
      console.error(`[CHAPTER] Kakalot erro: ${e.message}`);
      return res.status(500).json({ error: e.message });
    }
  }

  return res.status(400).json({ error: 'Forneça id (MangaDex) ou url (MangaKakalot)' });
});

// ─── Parsers MangaKakalot ─────────────────────────────────────────────────────

function parseKakalotSearch(html) {
  const results = [];
  const itemRegex = /<div[^>]*class="[^"]*story_item[^"]*"[^>]*>([\s\S]*?)<\/div>\s*<\/div>/g;
  let match;
  while ((match = itemRegex.exec(html)) !== null) {
    const block = match[1];
    const hrefMatch = block.match(/href="([^"]+)"/);
    const titleMatch = block.match(/class="[^"]*item-title[^"]*"[^>]*>([^<]+)</);
    const imgMatch = block.match(/<img[^>]*src="([^"]+)"/);
    if (hrefMatch && titleMatch) {
      const href = hrefMatch[1];
      const id = href.replace('https://mangakakalot.gg/', '').replace(/^\//, '');
      results.push({
        id,
        title: titleMatch[1].trim(),
        coverUrl: imgMatch ? imgMatch[1] : null,
        url: href,
        source: 'mangakakalot',
      });
    }
  }
  // fallback simples
  if (results.length === 0) {
    const linkRegex = /href="(https:\/\/mangakakalot\.gg\/[^"]+)"[^>]*>\s*([^<]{3,80})</g;
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const title = match[2].trim();
      if (title && !title.includes('{') && !href.includes('search')) {
        results.push({ id: href.replace('https://mangakakalot.gg/', ''), title, coverUrl: null, url: href, source: 'mangakakalot' });
      }
    }
  }
  return results;
}

function parseKakalotManga(html) {
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const title = titleMatch ? titleMatch[1].trim() : '';
  const coverMatch = html.match(/<img[^>]*class="[^"]*manga-info-pic[^"]*"[^>]*src="([^"]+)"/);
  const coverUrl = coverMatch ? coverMatch[1] : null;
  const descMatch = html.match(/id="panel-story-info-description"[^>]*>([\s\S]*?)<\/div>/);
  const description = descMatch
    ? descMatch[1].replace(/<[^>]+>/g, '').replace(/Description\s*:/i, '').trim()
    : '';
  const chapters = [];
  const chapterRegex = /href="(https:\/\/mangakakalot\.gg\/chapter\/[^"]+)"[^>]*>\s*([^<]+)</g;
  let match;
  while ((match = chapterRegex.exec(html)) !== null) {
    const chUrl = match[1];
    const chTitle = match[2].trim();
    if (chTitle.toLowerCase().includes('chapter') || chTitle.match(/^\d/)) {
      const numMatch = chTitle.match(/(\d+\.?\d*)/);
      chapters.push({ id: chUrl, title: chTitle, chapterNumber: numMatch ? numMatch[1] : '0', url: chUrl, source: 'mangakakalot' });
    }
  }
  return { title, coverUrl, description, chapters };
}

function parseKakalotChapter(html) {
  const pages = [];
  const imgRegex = /<img[^>]*class="[^"]*reader-content[^"]*"[^>]*src="([^"]+)"/g;
  let match;
  while ((match = imgRegex.exec(html)) !== null) pages.push(match[1]);
  if (pages.length === 0) {
    const cdnRegex = /src="(https:\/\/[^"]*(?:s\d+\.mkklcdn|cdn)[^"]*\.(?:jpg|png|webp))"/g;
    while ((match = cdnRegex.exec(html)) !== null) pages.push(match[1]);
  }
  return [...new Set(pages)];
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Manga Proxy rodando na porta ${PORT}`);
});
