const express = require('express');
const puppeteer = require('puppeteer');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Browser compartilhado (abre uma vez, reutiliza) ──────────────────────────
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
        '--single-process', // necessário no Railway/Render
      ],
    });
  }
  return browser;
}

// Faz uma requisição com Puppeteer (bypassa Cloudflare)
async function fetchWithPuppeteer(url) {
  const b = await getBrowser();
  const page = await b.newPage();
  try {
    await page.setUserAgent(
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 ' +
      '(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
    );
    await page.setExtraHTTPHeaders({ 'Accept-Language': 'en-US,en;q=0.9' });

    await page.goto(url, {
      waitUntil: 'networkidle2',
      timeout: 30000,
    });

    // Espera um pouco a mais caso tenha challenge do Cloudflare
    await new Promise(r => setTimeout(r, 2000));

    const html = await page.content();
    return html;
  } finally {
    await page.close();
  }
}

// ─── Middleware ───────────────────────────────────────────────────────────────
app.use((req, res, next) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Content-Type', 'application/json');
  next();
});

// ─── Rotas ────────────────────────────────────────────────────────────────────

// Health check — usado pelo Railway para saber se o servidor está vivo
app.get('/', (req, res) => {
  res.json({ status: 'ok', message: 'Manga Proxy rodando!' });
});

// GET /search?q=naruto
// Busca mangás no MangaKakalot.gg
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.status(400).json({ error: 'Parâmetro q é obrigatório' });

  try {
    const url = `https://mangakakalot.gg/search/${encodeURIComponent(query)}`;
    console.log(`[SEARCH] ${url}`);

    const html = await fetchWithPuppeteer(url);
    const results = parseSearchResults(html);
    res.json({ results });
  } catch (e) {
    console.error('[SEARCH ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /manga?id=manga-oa952286
// Detalhes e lista de capítulos de um mangá
app.get('/manga', async (req, res) => {
  const id = req.query.id;
  if (!id) return res.status(400).json({ error: 'Parâmetro id é obrigatório' });

  try {
    const url = id.startsWith('http') ? id : `https://mangakakalot.gg/${id}`;
    console.log(`[MANGA] ${url}`);

    const html = await fetchWithPuppeteer(url);
    const data = parseMangaDetails(html);
    res.json(data);
  } catch (e) {
    console.error('[MANGA ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// GET /chapter?url=https://mangakakalot.gg/...
// Páginas de um capítulo
app.get('/chapter', async (req, res) => {
  const chapterUrl = req.query.url;
  if (!chapterUrl) return res.status(400).json({ error: 'Parâmetro url é obrigatório' });

  try {
    console.log(`[CHAPTER] ${chapterUrl}`);
    const html = await fetchWithPuppeteer(chapterUrl);
    const pages = parseChapterPages(html);
    res.json({ pages });
  } catch (e) {
    console.error('[CHAPTER ERROR]', e.message);
    res.status(500).json({ error: e.message });
  }
});

// ─── Parsers de HTML ──────────────────────────────────────────────────────────
// (scraping simples com regex — sem dependência extra de cheerio)

function parseSearchResults(html) {
  const results = [];

  // Pega todos os blocos de resultado
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
      });
    }
  }

  // Fallback mais simples se o regex acima não pegar nada
  if (results.length === 0) {
    const linkRegex = /href="(https:\/\/mangakakalot\.gg\/[^"]+)"[^>]*>\s*([^<]{3,80})</g;
    while ((match = linkRegex.exec(html)) !== null) {
      const href = match[1];
      const title = match[2].trim();
      if (title && !title.includes('{') && !href.includes('search')) {
        const id = href.replace('https://mangakakalot.gg/', '');
        results.push({ id, title, coverUrl: null, url: href });
      }
    }
  }

  return results;
}

function parseMangaDetails(html) {
  // Título
  const titleMatch = html.match(/<h1[^>]*>([^<]+)<\/h1>/);
  const title = titleMatch ? titleMatch[1].trim() : '';

  // Capa
  const coverMatch = html.match(/<img[^>]*class="[^"]*manga-info-pic[^"]*"[^>]*src="([^"]+)"/);
  const coverUrl = coverMatch ? coverMatch[1] : null;

  // Descrição
  const descMatch = html.match(/id="panel-story-info-description"[^>]*>([\s\S]*?)<\/div>/);
  const description = descMatch
    ? descMatch[1].replace(/<[^>]+>/g, '').replace(/Description\s*:/i, '').trim()
    : '';

  // Capítulos
  const chapters = [];
  const chapterRegex = /href="(https:\/\/mangakakalot\.gg\/chapter\/[^"]+)"[^>]*>\s*([^<]+)</g;
  let match;
  while ((match = chapterRegex.exec(html)) !== null) {
    const url = match[1];
    const chapterTitle = match[2].trim();
    if (chapterTitle.toLowerCase().includes('chapter') || chapterTitle.match(/^\d/)) {
      const numMatch = chapterTitle.match(/(\d+\.?\d*)/);
      chapters.push({
        id: url,
        title: chapterTitle,
        chapterNumber: numMatch ? numMatch[1] : '0',
        url,
      });
    }
  }

  return { title, coverUrl, description, chapters };
}

function parseChapterPages(html) {
  const pages = [];
  // Imagens do leitor de capítulo
  const imgRegex = /<img[^>]*class="[^"]*reader-content[^"]*"[^>]*src="([^"]+)"/g;
  let match;
  while ((match = imgRegex.exec(html)) !== null) {
    pages.push(match[1]);
  }

  // Fallback: qualquer imagem grande do domínio de CDN
  if (pages.length === 0) {
    const cdnRegex = /src="(https:\/\/[^"]*(?:s\d+\.mkklcdn|cdn)[^"]*\.(?:jpg|png|webp))"/g;
    while ((match = cdnRegex.exec(html)) !== null) {
      pages.push(match[1]);
    }
  }

  return [...new Set(pages)]; // remove duplicatas
}

// ─── Start ────────────────────────────────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`Manga Proxy rodando na porta ${PORT}`);
});
