const express = require('express');
const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════════════════════
//  HTTP HELPERS & UTILS
// ══════════════════════════════════════════════════════════════════════════════

function fetchRaw(url, headers = {}, timeoutMs = 15000) {
  return new Promise((resolve, reject) => {
    const lib = url.startsWith('https') ? https : http;
    const req = lib.get(url, { headers: { 'User-Agent': 'okhttp/4.9.0', ...headers } }, (res) => {
      if (res.statusCode >= 300 && res.statusCode < 400 && res.headers.location) {
        return fetchRaw(res.headers.location, headers, timeoutMs).then(resolve).catch(reject);
      }
      const chunks = [];
      res.on('data', c => chunks.push(c));
      res.on('end', () => resolve({ buffer: Buffer.concat(chunks), status: res.statusCode }));
    }).on('error', reject);
    setTimeout(() => { req.destroy(); reject(new Error(`Timeout ${timeoutMs}ms: ${url}`)); }, timeoutMs);
  });
}

function fetchJSON(url, headers = {}) {
  return fetchRaw(url, { Accept: 'application/json', ...headers })
    .then(r => JSON.parse(r.buffer.toString('utf8')));
}

function fetchPOST(url, body, headers = {}, timeoutMs = 12000) {
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
    setTimeout(() => { req.destroy(); reject(new Error(`Timeout POST ${timeoutMs}ms`)); }, timeoutMs);
    req.write(data);
    req.end();
  });
}

function isUuid(s) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(s);
}

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

app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ══════════════════════════════════════════════════════════════════════════════
//  FLARESOLVERR ENGINE
// ══════════════════════════════════════════════════════════════════════════════

const FLARE_URL = (process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-ed33.up.railway.app').replace(/\/$/, '');
const FLARE_TIMEOUT = 60000; 
const flareSessions = {};
const FLARE_SESSION_TTL = 14 * 60 * 1000;

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

async function flareGet(url, useSession = true) {
  const domain = getDomain(url);
  const now = Date.now();
  let sessionId = null;

  if (useSession && flareSessions[domain] && (now - flareSessions[domain].ts) < FLARE_SESSION_TTL) {
    sessionId = flareSessions[domain].sessionId;
  }

  const body = { cmd: 'request.get', url, maxTimeout: FLARE_TIMEOUT, ...(sessionId ? { session: sessionId } : {}) };

  const { buffer, status } = await fetchPOST(`${FLARE_URL}/v1`, body, {}, FLARE_TIMEOUT + 5000);
  const json = JSON.parse(buffer.toString('utf8'));
  const sol = json.solution;

  if (useSession && !sessionId) {
    try {
      const cr = await fetchPOST(`${FLARE_URL}/v1`, { cmd: 'sessions.create' }, {}, 10000);
      const crJson = JSON.parse(cr.buffer.toString('utf8'));
      if (crJson.status === 'ok') {
        flareSessions[domain] = { sessionId: crJson.session, userAgent: sol.userAgent, cookies: sol.cookies, ts: now };
      }
    } catch (e) {
      flareSessions[domain] = { sessionId: null, userAgent: sol.userAgent, cookies: sol.cookies, ts: now };
    }
  } else if (sessionId) {
    flareSessions[domain].ts = now;
    flareSessions[domain].cookies = sol.cookies;
  }

  return { html: sol.response || '', cookies: sol.cookies || [], userAgent: sol.userAgent || '', status: sol.status };
}

async function flareRawWithCookies(url) {
  const domain = getDomain(url);
  const session = flareSessions[domain];
  if (!session) return flareGet(url);

  const cookieStr = session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const { buffer, status } = await fetchRaw(url, {
    'User-Agent': session.userAgent,
    'Cookie': cookieStr,
    'Referer': `https://${domain}/`,
  });

  if (status === 403 || status === 503) {
    delete flareSessions[domain];
    return flareGet(url);
  }

  return { html: buffer.toString('utf8'), status, cookies: session.cookies, userAgent: session.userAgent };
}

// ══════════════════════════════════════════════════════════════════════════════
//  BR SCRAPERS (MADARA THEME)
// ══════════════════════════════════════════════════════════════════════════════

function extractImgUrls(html) {
  const seen = new Set();
  const urls = [];
  const imgs = html.match(/(?:src|data-src|data-lazy-src)="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi) || [];
  for (const m of imgs) {
    const u = m.replace(/(?:src|data-src|data-lazy-src)="|"$/gi, '');
    if (!seen.has(u) && u.length > 40 && !u.includes('logo')) { seen.add(u); urls.push(u); }
  }
  return urls.slice(0, 150);
}

function parseMadaraSearchResults(html, domain, sourcePrefix) {
  const results = [];
  const cardRx = /<div class="[^"]*post-title[^"]*"[\s\S]*?<a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const coverRx = /<div class="[^"]*item-thumb[^"]*"[\s\S]*?<img[^>]+(?:src|data-src|data-srcset)="([^"\s]+)"/gi;
  
  let m, titles = [];
  while ((m = cardRx.exec(html)) !== null) {
    titles.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, '').trim() });
  }
  
  let cv, covers = [];
  while ((cv = coverRx.exec(html)) !== null) { covers.push(cv[1].split(' ')[0]); }

  for (let i = 0; i < Math.min(titles.length, 15); i++) {
    const slug = titles[i].url.replace(/\/$/, '').split('/').pop();
    results.push({ id: `${sourcePrefix}:${slug}`, title: titles[i].title, coverUrl: covers[i] || null, source: sourcePrefix });
  }
  return results;
}

async function madaraGetManga(mangaUrl, sourcePrefix) {
  const { html } = await flareGet(mangaUrl);
  const titleM = html.match(/<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i) || html.match(/<title>([^<]+)/i);
  const chapters = [];
  const chapRx = /<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let cm;
  while ((cm = chapRx.exec(html)) !== null) {
    chapters.push({
      id: `${sourcePrefix}:${Buffer.from(cm[1]).toString('base64')}`,
      title: cm[2].replace(/<[^>]+>/g, '').trim(),
      source: sourcePrefix
    });
  }
  return { title: titleM ? titleM[1].trim() : 'Manga', chapters, source: sourcePrefix };
}

const BR_SOURCES = {
  lermangas: {
    search: async (q) => {
      const { html } = await flareGet(`https://lermangas.me/?s=${encodeURIComponent(q)}&post_type=wp-manga`);
      return parseMadaraSearchResults(html, 'lermangas.me', 'lermangas');
    },
    getManga: (id) => madaraGetManga(`https://lermangas.me/manga/${id.split(':').pop()}/`, 'lermangas'),
    getPages: async (b64) => {
      const { html } = await flareRawWithCookies(Buffer.from(b64, 'base64').toString('utf8'));
      return extractImgUrls(html);
    }
  },
  tatakae: {
    search: async (q) => {
      const { html } = await flareGet(`https://tatakaescan.com/?s=${encodeURIComponent(q)}&post_type=wp-manga`);
      return parseMadaraSearchResults(html, 'tatakaescan.com', 'tatakae');
    },
    getManga: (id) => madaraGetManga(`https://tatakaescan.com/manga/${id.split(':').pop()}/`, 'tatakae'),
    getPages: async (b64) => {
      const { html } = await flareRawWithCookies(Buffer.from(b64, 'base64').toString('utf8'));
      return extractImgUrls(html);
    }
  }
};

function getBrSource(id, source) {
  if (source && BR_SOURCES[source]) return source;
  const prefix = id?.split(':')[0];
  return BR_SOURCES[prefix] ? prefix : null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS PRINCIPAIS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/search', async (req, res) => {
  const { q, source } = req.query;
  if (!q) return res.status(400).json({ error: 'Falta query' });

  if (source && BR_SOURCES[source]) {
    return res.json({ results: await BR_SOURCES[source].search(q), source });
  }
  
  // Fallback para busca automática se não especificar fonte
  const results = await BR_SOURCES.lermangas.search(q);
  res.json({ results, source: 'lermangas' });
});

app.get('/manga', async (req, res) => {
  const { id, source } = req.query;
  const br = getBrSource(id, source);
  if (br) return res.json(await BR_SOURCES[br].getManga(id));
  res.status(404).json({ error: 'Não encontrado' });
});

app.get('/chapter', async (req, res) => {
  const { id, source } = req.query;
  const br = getBrSource(id, source);
  if (br) {
    const pages = await BR_SOURCES[br].getPages(id.split(':').pop());
    return res.json({ pages, source: br });
  }
  res.status(404).json({ error: 'Capítulo não encontrado' });
});

app.listen(PORT, () => console.log(`Servidor rodando na porta ${PORT}`));
