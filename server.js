const express = require('express');
const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ══════════════════════════════════════════════════════════════════════════════
//  HTTP HELPERS
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

// ── CORS ──────────────────────────────────────────────────────────────────────
app.use((req, res, next) => { res.setHeader('Access-Control-Allow-Origin', '*'); next(); });

// ══════════════════════════════════════════════════════════════════════════════
//  FLARESOLVERR — bypass Cloudflare para sites BR
//  URL configurável via env var FLARESOLVERR_URL
//  Estratégia: sessão persistente por domínio + cache de cookies (15 min)
//  Requests subsequentes ao mesmo domínio reutilizam o browser já aberto
// ══════════════════════════════════════════════════════════════════════════════

const _rawFlare = process.env.FLARESOLVERR_URL || 'https://flaresolverr-production-ed33.up.railway.app';
const FLARE_URL = (_rawFlare.startsWith('http') ? _rawFlare : 'https://' + _rawFlare).replace(/\/$/, '');
const FLARE_TIMEOUT = 60000; // 60s para resolver o desafio

// Sessões ativas por domínio: domain → { sessionId, userAgent, cookies, ts }
const flareSessions = {};
const FLARE_SESSION_TTL = 14 * 60 * 1000; // 14 minutos (Cloudflare cookie dura ~15min)

function getDomain(url) {
  try { return new URL(url).hostname; } catch { return url; }
}

// Chama o FlareSolverr e retorna { html, cookies, userAgent }
async function flareGet(url, useSession = true) {
  const domain = getDomain(url);
  const now = Date.now();

  // Reutiliza sessão ativa se válida
  let sessionId = null;
  if (useSession && flareSessions[domain] && (now - flareSessions[domain].ts) < FLARE_SESSION_TTL) {
    sessionId = flareSessions[domain].sessionId;
    console.log(`[FLARE] sessão reutilizada para ${domain} (${sessionId.slice(0, 8)}...)`);
  }

  const body = {
    cmd: 'request.get',
    url,
    maxTimeout: FLARE_TIMEOUT,
    ...(sessionId ? { session: sessionId } : {}),
  };

  const { buffer, status } = await fetchPOST(`${FLARE_URL}/v1`, body, {}, FLARE_TIMEOUT + 5000);
  if (status !== 200) throw new Error(`FlareSolverr HTTP ${status}`);

  const json = JSON.parse(buffer.toString('utf8'));
  if (json.status !== 'ok') throw new Error(`FlareSolverr: ${json.message || 'erro desconhecido'}`);

  const sol = json.solution;

  // Salva/atualiza sessão
  if (useSession) {
    // Se não tinha sessão, cria uma persistente para requests futuros
    if (!sessionId) {
      try {
        const createBody = { cmd: 'sessions.create' };
        const cr = await fetchPOST(`${FLARE_URL}/v1`, createBody, {}, 10000);
        const crJson = JSON.parse(cr.buffer.toString('utf8'));
        if (crJson.status === 'ok') {
          flareSessions[domain] = {
            sessionId: crJson.session,
            userAgent: sol.userAgent,
            cookies: sol.cookies,
            ts: now,
          };
          console.log(`[FLARE] nova sessão criada para ${domain}: ${crJson.session.slice(0, 8)}...`);
        }
      } catch (e) {
        console.warn(`[FLARE] falha ao criar sessão: ${e.message}`);
        // Salva sem sessão persistente (stateless)
        flareSessions[domain] = { sessionId: null, userAgent: sol.userAgent, cookies: sol.cookies, ts: now };
      }
    } else {
      flareSessions[domain].ts = now; // Renova timestamp
      flareSessions[domain].cookies = sol.cookies;
    }
  }

  console.log(`[FLARE] ✓ ${domain} | ${sol.status} | ${sol.response?.length || 0} chars`);
  return {
    html: sol.response || '',
    cookies: sol.cookies || [],
    userAgent: sol.userAgent || '',
    status: sol.status,
  };
}

// fetchRaw com cookies do FlareSolverr (para requests subsequentes rápidos)
async function flareRawWithCookies(url) {
  const domain = getDomain(url);
  const session = flareSessions[domain];
  if (!session) return flareGet(url); // sem sessão, usa FlareSolverr normal

  const cookieStr = session.cookies.map(c => `${c.name}=${c.value}`).join('; ');
  const { buffer, status } = await fetchRaw(url, {
    'User-Agent': session.userAgent,
    'Cookie': cookieStr,
    'Accept': 'text/html,application/xhtml+xml,*/*',
    'Accept-Language': 'pt-BR,pt;q=0.9',
    'Referer': `https://${domain}/`,
  });

  // Cookie expirou → re-resolve via FlareSolverr
  if (status === 403 || status === 503) {
    console.warn(`[FLARE] cookie expirado para ${domain}, re-resolvendo...`);
    delete flareSessions[domain];
    return flareGet(url);
  }

  return { html: buffer.toString('utf8'), status, cookies: session.cookies, userAgent: session.userAgent };
}

// Limpa sessões expiradas a cada 20 minutos
setInterval(async () => {
  const now = Date.now();
  for (const [domain, sess] of Object.entries(flareSessions)) {
    if ((now - sess.ts) > FLARE_SESSION_TTL) {
      console.log(`[FLARE] expirando sessão de ${domain}`);
      if (sess.sessionId) {
        try {
          await fetchPOST(`${FLARE_URL}/v1`, { cmd: 'sessions.destroy', session: sess.sessionId }, {}, 5000);
        } catch (_) {}
      }
      delete flareSessions[domain];
    }
  }
}, 20 * 60 * 1000);

// ══════════════════════════════════════════════════════════════════════════════
//  SCRAPERS PARA SITES BR (via FlareSolverr)
// ══════════════════════════════════════════════════════════════════════════════

// ── Helpers de parsing HTML ──────────────────────────────────────────────────

function htmlAttr(html, tag, attr, nth = 0) {
  const regex = new RegExp(`<${tag}[^>]+${attr}="([^"]*)"`, 'gi');
  let m, i = 0;
  while ((m = regex.exec(html)) !== null) { if (i++ === nth) return m[1]; }
  return null;
}

function htmlText(html, selector) {
  const m = html.match(new RegExp(`<${selector}[^>]*>([^<]*)<\/${selector}>`, 'i'));
  return m ? m[1].trim() : '';
}

function extractImgUrls(html) {
  const seen = new Set();
  const urls = [];
  // Padrão 1: Next.js __NEXT_DATA__
  const nextM = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
  if (nextM) {
    try {
      const nd = JSON.parse(nextM[1]);
      const all = JSON.stringify(nd).match(/https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?/gi) || [];
      for (const u of all) if (!seen.has(u) && isPageImg(u)) { seen.add(u); urls.push(u); }
      if (urls.length > 3) return urls.slice(0, 120);
    } catch (_) {}
  }
  // Padrão 2: scripts genéricos
  const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
  for (const sc of scripts) {
    const all = sc.match(/https:\/\/[^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?/gi) || [];
    for (const u of all) if (!seen.has(u) && isPageImg(u)) { seen.add(u); urls.push(u); }
    if (urls.length > 5) break;
  }
  // Padrão 3: img tags
  const imgs = html.match(/(?:src|data-src|data-lazy-src)="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi) || [];
  for (const m of imgs) {
    const u = m.replace(/(?:src|data-src|data-lazy-src)="|"$/gi, '');
    if (!seen.has(u) && isPageImg(u)) { seen.add(u); urls.push(u); }
  }
  return urls.slice(0, 120);
}

function isPageImg(url) {
  return url.length > 40
    && !url.includes('/thumb') && !url.includes('thumbnail')
    && !url.includes('/avatar') && !url.includes('/logo')
    && !url.includes('/banner') && !url.includes('/icon')
    && !url.includes('gravatar') && !url.includes('facebook');
}

// ── LerMangas ────────────────────────────────────────────────────────────────
// Site: https://lermangas.me  — WordPress/Madara theme

async function lerSearch(query) {
  const cached = getCachedSearch('lermangas', query);
  if (cached) { console.log('[LER] cache hit'); return cached; }
  try {
    const { html } = await flareGet(`https://lermangas.me/?s=${encodeURIComponent(query)}&post_type=wp-manga`);
    const results = [];
    const itemRx = /<div class="post-title"[^>]*>[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const imgRx = /<img[^>]+(?:src|data-src)="([^"]+)"[^>]*class="[^"]*img-responsive[^"]*"/gi;
    let m;
    const titles = [];
    while ((m = itemRx.exec(html)) !== null) {
      titles.push({ url: m[1], title: m[2].replace(/<[^>]+>/g, '').trim() });
    }
    // Pega covers
    const covers = [];
    let cm;
    const coverRx = /class="tab-thumb"[\s\S]*?<img[^>]+(?:src|data-src)="([^"]+)"/gi;
    while ((cm = coverRx.exec(html)) !== null) covers.push(cm[1]);

    for (let i = 0; i < Math.min(titles.length, 15); i++) {
      const { url, title } = titles[i];
      const slug = url.replace(/\/$/, '').split('/').pop();
      results.push({
        id: `ler:${slug}`,
        title,
        coverUrl: covers[i] || null,
        url,
        source: 'lermangas',
      });
    }
    console.log(`[LER] ${results.length} resultados`);
    setCachedSearch('lermangas', query, results);
    return results;
  } catch (e) { console.error('[LER] search erro:', e.message); return []; }
}

async function lerGetManga(slug) {
  try {
    const url = `https://lermangas.me/manga/${slug}/`;
    const { html } = await flareGet(url);

    // Título
    const titleM = html.match(/<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
      || html.match(/<title>([^<|]+)/i);
    const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : slug;

    // Cover
    const coverM = html.match(/class="summary-image"[\s\S]*?<img[^>]+(?:src|data-src)="([^"]+)"/i);
    const coverUrl = coverM ? coverM[1] : null;

    // Capítulos (Madara theme)
    const chapRx = /<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
    const chapters = [];
    let cm;
    let i = 0;
    while ((cm = chapRx.exec(html)) !== null) {
      const chUrl = cm[1];
      const chTitle = cm[2].replace(/<[^>]+>/g, '').trim();
      const numM = chTitle.match(/[\d.]+/);
      chapters.push({
        id: `ler:${Buffer.from(chUrl).toString('base64')}`,
        title: chTitle,
        chapterNumber: numM ? numM[0] : String(i),
        source: 'lermangas',
      });
      i++;
    }

    console.log(`[LER] "${title}" | ${chapters.length} caps`);
    return { title, coverUrl, description: '', chapters, source: 'lermangas' };
  } catch (e) {
    console.error('[LER] getManga erro:', e.message);
    return { title: slug, coverUrl: null, description: '', chapters: [], source: 'lermangas' };
  }
}

async function lerGetPages(b64url) {
  try {
    const chUrl = Buffer.from(b64url, 'base64').toString('utf8');
    const { html } = await flareRawWithCookies(chUrl);
    return extractImgUrls(html);
  } catch (e) { console.error('[LER] getPages erro:', e.message); return []; }
}

// ── Busca genérica via AJAX do Madara (mais confiável que HTML scraping)
async function madaraAjaxSearch(baseUrl, domain, sourcePrefix, query) {
  const cached = getCachedSearch(sourcePrefix, query);
  if (cached) { console.log(`[${sourcePrefix.toUpperCase()}] cache hit`); return cached; }
  try {
    const sess = flareSessions[domain];
    const cookieStr = sess ? sess.cookies.map(c => `${c.name}=${c.value}`).join('; ') : '';
    const ua = sess?.userAgent || 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36';
    let results = [];

    // 1a tentativa: endpoint AJAX do Madara (retorna JSON)
    try {
      const ajaxUrl = `${baseUrl}/wp-admin/admin-ajax.php`;
      const formBody = `action=madara_ajax_search&query=${encodeURIComponent(query)}`;
      const ajaxResp = await new Promise((resolve, reject) => {
        const urlObj = new URL(ajaxUrl);
        const opts = {
          hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            'Content-Length': Buffer.byteLength(formBody),
            'User-Agent': ua, 'Cookie': cookieStr,
            'Referer': baseUrl + '/',
            'X-Requested-With': 'XMLHttpRequest',
            'Accept': 'application/json, text/javascript, */*',
          }
        };
        const req = https.request(opts, (res) => {
          const chunks = [];
          res.on('data', ch => chunks.push(ch));
          res.on('end', () => resolve({ text: Buffer.concat(chunks).toString('utf8'), status: res.statusCode }));
        });
        req.on('error', reject);
        setTimeout(() => { req.destroy(); reject(new Error('Timeout AJAX')); }, 10000);
        req.write(formBody);
        req.end();
      });

      console.log(`[${sourcePrefix.toUpperCase()}] AJAX status=${ajaxResp.status} len=${ajaxResp.text.length}`);

      if (ajaxResp.status === 200 && ajaxResp.text.length > 100) {
        if (ajaxResp.text.trim().startsWith('[')) {
          const arr = JSON.parse(ajaxResp.text);
          for (const item of arr) {
            if (!item.title) continue;
            const slug = (item.url || '').replace(/\/$/, '').split('/').pop();
            results.push({
              id: `${sourcePrefix}:${slug}`,
              title: (item.title || '').replace(/<[^>]+>/g, '').trim(),
              coverUrl: item.thumbnail || item.image || null,
              url: item.url || null, source: sourcePrefix,
            });
          }
        } else if (ajaxResp.text.includes('<a')) {
          results = parseMadaraSearchResults(ajaxResp.text, domain, sourcePrefix);
        }
      }
    } catch (e) { console.warn(`[${sourcePrefix.toUpperCase()}] AJAX falhou: ${e.message}`); }

    // 2a tentativa: busca HTML via FlareSolverr (fallback)
    if (results.length === 0) {
      console.log(`[${sourcePrefix.toUpperCase()}] Tentando HTML via FlareSolverr...`);
      const searchUrl = `${baseUrl}/?s=${encodeURIComponent(query)}&post_type=wp-manga`;
      const { html } = await flareGet(searchUrl);
      console.log(`[${sourcePrefix.toUpperCase()}] HTML len=${html.length}`);
      results = parseMadaraSearchResults(html, domain, sourcePrefix);

      // Fallback: extrai qualquer link de manga do HTML
      if (results.length === 0 && html.length > 500) {
        const escapedDomain = domain.replace(/\./g, '\\.');
        const linkRx = new RegExp(`href="(https://${escapedDomain}/manga/[^"]+)"[^>]*>([^<]{3,80})`, 'gi');
        let lm;
        const seen = new Set();
        while ((lm = linkRx.exec(html)) !== null && results.length < 15) {
          const url = lm[1].split('?')[0];
          if (seen.has(url)) continue;
          seen.add(url);
          const slug = url.replace(/\/$/, '').split('/').pop();
          results.push({ id: `${sourcePrefix}:${slug}`, title: lm[2].trim(), coverUrl: null, url, source: sourcePrefix });
        }
      }
    }

    console.log(`[${sourcePrefix.toUpperCase()}] ${results.length} resultados`);
    if (results.length > 0) setCachedSearch(sourcePrefix, query, results);
    return results;
  } catch (e) {
    console.error(`[${sourcePrefix.toUpperCase()}] search erro:`, e.message);
    return [];
  }
}

async function tatakaeSearch(query) { return madaraAjaxSearch('https://tatakaescan.com', 'tatakaescan.com', 'tatakae', query); }
async function sakuraSearch(query) { return madaraAjaxSearch('https://sakuramangas.org', 'sakuramangas.org', 'sakura', query); }
async function taiyoSearch(query) { return madaraAjaxSearch('https://taiyo.moe', 'taiyo.moe', 'taiyo', query); }
async function kakuseiSearch(query) { return madaraAjaxSearch('https://kakuseiproject.com', 'kakuseiproject.com', 'kakusei', query); }

// ── Parser genérico Madara WordPress theme ────────────────────────────────────
// Todos esses sites usam o mesmo tema (WP Manga / Madara)
function parseMadaraSearchResults(html, domain, sourcePrefix) {
  const results = [];
  // Padrão do tema Madara: cards de manga
  const cardRx = /<div class="[^"]*post-title[^"]*"[\s\S]*?<a href="(https?:\/\/[^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  const coverRx = /<div class="[^"]*item-thumb[^"]*"[\s\S]*?<img[^>]+(?:src|data-src|data-srcset)="([^"\s]+)"/gi;

  const titles = [];
  let m;
  while ((m = cardRx.exec(html)) !== null) {
    const url = m[1];
    if (!url.includes(`${domain}/manga/`) && !url.includes(`${domain}/series/`)) continue;
    titles.push({ url, title: m[2].replace(/<[^>]+>/g, '').trim() });
  }

  const covers = [];
  let cv;
  while ((cv = coverRx.exec(html)) !== null) {
    const u = cv[1].split(' ')[0]; // data-srcset pode ter múltiplos
    covers.push(u);
  }

  for (let i = 0; i < Math.min(titles.length, 15); i++) {
    const { url, title } = titles[i];
    const slug = url.replace(/\/$/, '').split('/').pop();
    results.push({
      id: `${sourcePrefix}:${slug}`,
      title,
      coverUrl: covers[i] || null,
      url,
      source: sourcePrefix,
    });
  }
  return results;
}

// ── getManga e getPages genéricos para todos os sites Madara ─────────────────
async function madaraGetManga(mangaUrl, sourcePrefix) {
  try {
    const { html } = await flareGet(mangaUrl);
    const domain = getDomain(mangaUrl);

    const titleM = html.match(/<h1[^>]*class="[^"]*post-title[^"]*"[^>]*>([\s\S]*?)<\/h1>/i)
      || html.match(/<div class="post-title"[^>]*>[\s\S]*?<h[12][^>]*>([\s\S]*?)<\/h[12]>/i)
      || html.match(/<title>([^<|–-]+)/i);
    const title = titleM ? titleM[1].replace(/<[^>]+>/g, '').trim() : mangaUrl;

    const coverM = html.match(/class="summary-image"[\s\S]*?<img[^>]+(?:src|data-src)="([^"]+)"/i)
      || html.match(/<div class="[^"]*tab-summary[^"]*"[\s\S]*?<img[^>]+(?:src|data-src)="([^"]+)"/i);
    const coverUrl = coverM ? coverM[1] : null;

    // Capítulos — tenta lista inline e depois AJAX endpoint do Madara
    let chapters = parseMadaraChapters(html, mangaUrl, sourcePrefix);

    // Se não achou capítulos inline, tenta o AJAX do Madara (wp-admin/admin-ajax.php)
    if (chapters.length === 0) {
      try {
        const postIdM = html.match(/var manga_id\s*=\s*['"]*(\d+)/i)
          || html.match(/manga_id['"]\s*:\s*['"]*(\d+)/i)
          || html.match(/data-id="(\d+)"/i);
        if (postIdM) {
          const postId = postIdM[1];
          const ajaxUrl = `https://${domain}/wp-admin/admin-ajax.php`;
          const { buffer } = await fetchPOST(ajaxUrl, {},
            { 'Content-Type': 'application/x-www-form-urlencoded' }, 10000);
          // POST form-urlencoded
          const formBody = `action=manga_get_chapters&manga=${postId}`;
          const ajaxResp = await new Promise((resolve, reject) => {
            const data = formBody;
            const urlObj = new URL(ajaxUrl);
            const opts = {
              hostname: urlObj.hostname, path: urlObj.pathname, method: 'POST',
              headers: {
                'Content-Type': 'application/x-www-form-urlencoded',
                'Content-Length': Buffer.byteLength(data),
                'User-Agent': flareSessions[domain]?.userAgent || 'Mozilla/5.0',
                'Cookie': (flareSessions[domain]?.cookies || []).map(c => `${c.name}=${c.value}`).join('; '),
                'Referer': mangaUrl,
                'X-Requested-With': 'XMLHttpRequest',
              }
            };
            const req = https.request(opts, (res) => {
              const chunks = [];
              res.on('data', c => chunks.push(c));
              res.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
            });
            req.on('error', reject);
            req.write(data);
            req.end();
          });
          chapters = parseMadaraChapters(ajaxResp, mangaUrl, sourcePrefix);
          console.log(`[MADARA] AJAX: ${chapters.length} caps para ${title}`);
        }
      } catch (e) { console.warn(`[MADARA] AJAX erro: ${e.message}`); }
    }

    console.log(`[${sourcePrefix.toUpperCase()}] "${title}" | ${chapters.length} caps`);
    return { title, coverUrl, description: '', chapters, source: sourcePrefix };
  } catch (e) {
    console.error(`[${sourcePrefix.toUpperCase()}] getManga erro:`, e.message);
    return { title: mangaUrl, coverUrl: null, description: '', chapters: [], source: sourcePrefix };
  }
}

function parseMadaraChapters(html, baseUrl, sourcePrefix) {
  const chapters = [];
  const chapRx = /<li[^>]*class="[^"]*wp-manga-chapter[^"]*"[^>]*>[\s\S]*?<a href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi;
  let cm, i = 0;
  while ((cm = chapRx.exec(html)) !== null) {
    const chUrl = cm[1];
    const chTitle = cm[2].replace(/<[^>]+>/g, '').trim();
    const numM = chTitle.match(/[\d.]+/);
    chapters.push({
      id: `${sourcePrefix}:${Buffer.from(chUrl).toString('base64')}`,
      title: chTitle || `Capítulo ${i + 1}`,
      chapterNumber: numM ? numM[0] : String(i),
      source: sourcePrefix,
    });
    i++;
  }
  return chapters;
}

async function madaraGetPages(b64url, sourcePrefix) {
  try {
    const chUrl = Buffer.from(b64url, 'base64').toString('utf8');
    console.log(`[${sourcePrefix.toUpperCase()}] lendo: ${chUrl}`);
    const { html } = await flareRawWithCookies(chUrl);
    const pages = extractImgUrls(html);
    console.log(`[${sourcePrefix.toUpperCase()}] ${pages.length} páginas`);
    return pages;
  } catch (e) {
    console.error(`[${sourcePrefix.toUpperCase()}] getPages erro:`, e.message);
    return [];
  }
}

// Mapeamento source → funções
const BR_SOURCES = {
  lermangas: {
    search: lerSearch,
    getManga: (id) => {
      const slug = id.replace(/^ler:/, '');
      return lerGetManga(slug);
    },
    getPages: (b64) => lerGetPages(b64),
  },
  tatakae: {
    search: tatakaeSearch,
    getManga: (id) => {
      const slug = id.replace(/^tatakae:/, '');
      return madaraGetManga(`https://tatakaescan.com/manga/${slug}/`, 'tatakae');
    },
    getPages: (b64) => madaraGetPages(b64, 'tatakae'),
  },
  sakura: {
    search: sakuraSearch,
    getManga: (id) => {
      const slug = id.replace(/^sakura:/, '');
      return madaraGetManga(`https://sakuramangas.org/manga/${slug}/`, 'sakura');
    },
    getPages: (b64) => madaraGetPages(b64, 'sakura'),
  },
  taiyo: {
    search: taiyoSearch,
    getManga: (id) => {
      const slug = id.replace(/^taiyo:/, '');
      return madaraGetManga(`https://taiyo.moe/manga/${slug}/`, 'taiyo');
    },
    getPages: (b64) => madaraGetPages(b64, 'taiyo'),
  },
  kakusei: {
    search: kakuseiSearch,
    getManga: (id) => {
      const slug = id.replace(/^kakusei:/, '');
      return madaraGetManga(`https://kakuseiproject.com/manga/${slug}/`, 'kakusei');
    },
    getPages: (b64) => madaraGetPages(b64, 'kakusei'),
  },
};

function getBrSource(id, source) {
  if (source && BR_SOURCES[source]) return source;
  for (const prefix of Object.keys(BR_SOURCES)) {
    if (id && id.startsWith(`${prefix}:`)) return prefix;
  }
  return null;
}

// ══════════════════════════════════════════════════════════════════════════════
//  CACHE GERAL DE BUSCA  (evita re-buscar o mesmo termo)
//  searchCache[source][query] = { results, ts }
// ══════════════════════════════════════════════════════════════════════════════
const searchCache = {};
const SEARCH_TTL_MS = 10 * 60 * 1000; // 10 minutos

function getCachedSearch(source, query) {
  const key = query.toLowerCase().trim();
  const entry = searchCache[source]?.[key];
  if (entry && Date.now() - entry.ts < SEARCH_TTL_MS) return entry.results;
  return null;
}

function setCachedSearch(source, query, results) {
  const key = query.toLowerCase().trim();
  if (!searchCache[source]) searchCache[source] = {};
  searchCache[source][key] = { results, ts: Date.now() };
}

// ══════════════════════════════════════════════════════════════════════════════
//  CACHE DO COMICK
// ══════════════════════════════════════════════════════════════════════════════
const comickById = {};
const comickByTitle = {};

function titleKey(t) {
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
  const cached = getCachedSearch('mangaplus', query);
  if (cached) { console.log('[MP] cache hit'); return cached; }

  const q = query.toLowerCase().trim();
  if (MANGA_IDS[q]) {
    try {
      const detail = await mpGetTitle(MANGA_IDS[q]);
      if (detail.title) {
        const r = [{ id: String(MANGA_IDS[q]), title: detail.title, coverUrl: detail.coverUrl, source: 'mangaplus' }];
        setCachedSearch('mangaplus', query, r);
        return r;
      }
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
  setCachedSearch('mangaplus', query, results);
  return results;
}

// ══════════════════════════════════════════════════════════════════════════════
//  COMICK  (comick-source-api.notaspider.dev)
// ══════════════════════════════════════════════════════════════════════════════

const COMICK_BASE = 'https://comick-source-api.notaspider.dev/api';

async function comickSearch(query) {
  const cached = getCachedSearch('comick', query);
  if (cached) { console.log('[COMICK] cache hit'); return cached; }

  try {
    console.log(`[COMICK] Buscando: "${query}"`);
    const response = await fetchPOST(`${COMICK_BASE}/search`, { query, source: 'all' }, {}, 20000);
    const objects = parseJsonStream(response.buffer.toString('utf8'));
    const results = [];
    const seenIds = new Set();

    for (const obj of objects) {
      if (!obj.results || !Array.isArray(obj.results)) continue;
      const sourceId = (obj.source || 'unknown').toLowerCase().replace(/\s+/g, '');

      for (const item of obj.results) {
        if (!item.id || !item.title) continue;
        if (item.url) {
          comickById[item.id] = { url: item.url, title: item.title, coverUrl: item.coverImage || null, sourceId };
        }
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

    console.log(`[COMICK] ${results.length} resultados`);
    const sliced = results.slice(0, 20);
    setCachedSearch('comick', query, sliced);
    return sliced;
  } catch (e) {
    console.error('[COMICK] search erro:', e.message);
    return [];
  }
}

async function comickGetManga(mangaId, providedUrl) {
  try {
    console.log(`[COMICK] getManga id="${mangaId}"`);
    const urlsToTry = [];
    const seen = new Set();

    function addUrl(url, sourceId) {
      if (url && url.startsWith('http') && !seen.has(url)) {
        seen.add(url);
        urlsToTry.push({ url, sourceId });
      }
    }

    if (providedUrl) addUrl(providedUrl, 'provided');
    if (comickById[mangaId]) addUrl(comickById[mangaId].url, comickById[mangaId].sourceId);

    const myEntry = comickById[mangaId];
    if (myEntry) {
      const key = titleKey(myEntry.title);
      const siblings = comickByTitle[key] || [];
      for (const sib of siblings) {
        if (sib.id !== mangaId) addUrl(sib.url, sib.sourceId);
      }
    }

    if (/^[a-z0-9]{4,8}$/.test(mangaId)) {
      addUrl(`https://comix.to/title/${mangaId}`, 'comix-auto');
    }

    if (urlsToTry.length === 0) {
      const query = mangaId.replace(/-[a-f0-9]{8}$/, '').replace(/-/g, ' ').trim();
      console.log(`[COMICK] Rebuscando: "${query}"`);
      try {
        const response = await fetchPOST(`${COMICK_BASE}/search`, { query, source: 'all' }, {}, 20000);
        const objects = parseJsonStream(response.buffer.toString('utf8'));
        for (const obj of objects) {
          if (!obj.results) continue;
          const srcId = (obj.source || '').toLowerCase();
          for (const r of obj.results) addUrl(r.url, srcId);
        }
      } catch (e) { console.warn('[COMICK] rebusca erro:', e.message); }
    }

    console.log(`[COMICK] Tentando ${urlsToTry.length} URLs para "${mangaId}"`);

    for (const { url: mangaUrl, sourceId } of urlsToTry) {
      try {
        console.log(`[COMICK]   → ${sourceId}: ${mangaUrl}`);
        const chapResp = await fetchPOST(`${COMICK_BASE}/chapters`, { url: mangaUrl });
        const chapObjects = parseJsonStream(chapResp.buffer.toString('utf8'));

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
    const chapterUrl = Buffer.from(chapterHid, 'base64').toString('utf8');
    if (!chapterUrl.startsWith('http')) return [];
    console.log(`[COMICK] Lendo: ${chapterUrl}`);

    const { buffer, status } = await fetchRaw(chapterUrl, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,*/*',
    });
    if (status !== 200) { console.warn(`[COMICK] HTTP ${status}`); return []; }

    const html = buffer.toString('utf8');
    const seen = new Set();
    const pages = [];

    // Padrão 1: Next.js __NEXT_DATA__
    const nextMatch = html.match(/<script id="__NEXT_DATA__"[^>]*>([\s\S]*?)<\/script>/);
    if (nextMatch) {
      try {
        const nextData = JSON.parse(nextMatch[1]);
        const str = JSON.stringify(nextData);
        const urls = str.match(/https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)(?:\?[^"]*)?/gi) || [];
        for (const url of urls) {
          if (!seen.has(url) && !url.includes('thumb') && !url.includes('avatar') && !url.includes('logo') && url.length > 40) {
            seen.add(url);
            pages.push(url);
          }
        }
        if (pages.length > 0) { console.log(`[COMICK] ${pages.length} páginas via __NEXT_DATA__`); return pages.slice(0, 120); }
      } catch (_) {}
    }

    // Padrão 2: JSON em <script>
    const scripts = html.match(/<script[^>]*>([\s\S]*?)<\/script>/gi) || [];
    for (const script of scripts) {
      const urls = script.match(/https:\/\/[^"']+\.(?:jpg|jpeg|png|webp)(?:\?[^"']*)?/gi) || [];
      for (const url of urls) {
        if (!seen.has(url) && !url.includes('thumb') && !url.includes('avatar') && !url.includes('logo') && url.length > 40) {
          seen.add(url);
          pages.push(url);
        }
      }
      if (pages.length > 5) break;
    }

    // Padrão 3: <img src>
    if (pages.length < 3) {
      const imgs = html.match(/(?:src|data-src)="(https:\/\/[^"]+\.(?:jpg|jpeg|png|webp)[^"]*)"/gi) || [];
      for (const m of imgs) {
        const url = m.replace(/(?:src|data-src)="|"$/gi, '');
        if (!seen.has(url) && !url.includes('thumb') && !url.includes('avatar') && !url.includes('logo') && url.length > 40) {
          seen.add(url);
          pages.push(url);
        }
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
//  MANGADEX — completo com PT-BR primeiro, fallback EN
// ══════════════════════════════════════════════════════════════════════════════

async function mdxSearch(query, filterLang = null) {
  const cacheKey = filterLang ? `${query}__lang_${filterLang}` : query;
  const cached = getCachedSearch('mangadex', cacheKey);
  if (cached) { console.log('[MDX] cache hit'); return cached; }

  try {
    // Se filterLang especificado, filtra só mangás com tradução nesse idioma
    const langFilter = filterLang ? `&availableTranslatedLanguage[]=${filterLang}` : '';
    const data = await fetchJSON(
      `https://api.mangadex.org/manga?title=${encodeURIComponent(query)}&limit=20&order[relevance]=desc&includes[]=cover_art&contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica${langFilter}`,
      { 'User-Agent': 'MangaHook/1.0 (educational)' }
    );
    if (!data.data?.length) return [];
    const results = data.data.map(m => {
      const title = m.attributes.title['pt-br'] || m.attributes.title.en || Object.values(m.attributes.title)[0] || '';
      const cover = m.relationships.find(r => r.type === 'cover_art');
      const desc = m.attributes.description?.['pt-br'] || m.attributes.description?.en || '';
      const langs = m.attributes.availableTranslatedLanguages || [];
      return {
        id: m.id,
        title,
        coverUrl: cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes?.fileName}.512.jpg` : null,
        description: desc.slice(0, 200),
        status: m.attributes.status || '',
        year: m.attributes.year || null,
        hasPtBr: langs.includes('pt-br') || langs.includes('pt'),
        availableLangs: langs,
        source: 'mangadex'
      };
    });
    setCachedSearch('mangadex', cacheKey, results);
    return results;
  } catch (e) { console.warn('[MDX] search erro:', e.message); return []; }
}

// Busca todos os capítulos de um idioma específico com paginação automática
// IDs de grupos de scan brasileiros conhecidos no MangaDex
// Esses grupos têm prioridade na seleção de capítulos PT-BR
const MDX_BR_GROUPS = new Set([
  'b34e5f20-7a2b-4df4-b3ff-b31620fcdbc5', // Tatakae Scan
  '8d8946aa-781a-4c4e-bc2a-60e7a75cd4c4', // Sakura Mangas
  'a5a4b5b6-c5c6-4d4e-5e5f-6a6b7c7d8e8f', // LerMangas (placeholder - atualizar se encontrar)
  'caa26a46-9447-4c85-a3c5-4a5b3b5c6d6e', // Taiyo Scans (placeholder)
]);

async function mdxFetchChaptersForLang(mangaId, lang) {
  const allChapters = [];
  const ratings = 'contentRating[]=safe&contentRating[]=suggestive&contentRating[]=erotica';
  const langParam = `&translatedLanguage[]=${lang}`;
  // Inclui scanlation_group para poder priorizar grupos BR
  const includes = '&includes[]=scanlation_group';
  const limit = 500;
  let offset = 0;
  let total = null;

  while (true) {
    const url = `https://api.mangadex.org/manga/${mangaId}/feed?${langParam}&order[chapter]=asc&limit=${limit}&offset=${offset}&${ratings}${includes}`;
    const cd = await fetchJSON(url, { 'User-Agent': 'MangaHook/1.0 (educational)' });
    if (!cd.data?.length) break;
    allChapters.push(...cd.data);
    if (total === null) total = cd.total || 0;
    offset += cd.data.length;
    if (offset >= total || cd.data.length < limit) break;
    // Pequena pausa entre requests para não bater no rate limit do MDX (5 req/s)
    await new Promise(r => setTimeout(r, 250));
  }

  return allChapters;
}

// Verifica se um capítulo foi feito por um grupo BR conhecido
function isBrGroup(ch) {
  const groups = ch.relationships?.filter(r => r.type === 'scanlation_group') || [];
  return groups.some(g => MDX_BR_GROUPS.has(g.id));
}

// Deduplica capítulos: mesmo número → prioriza grupo BR, depois mais páginas
function deduplicateChapters(rawChapters) {
  const chapMap = new Map();
  for (const ch of rawChapters) {
    const num = ch.attributes.chapter ?? ch.attributes.title ?? ch.id;
    const existing = chapMap.get(num);
    if (!existing) { chapMap.set(num, ch); continue; }

    const newIsBr = isBrGroup(ch);
    const oldIsBr = isBrGroup(existing);
    const newPages = ch.attributes.pages || 0;
    const oldPages = existing.attributes.pages || 0;

    // Prefere grupo BR; se empate, prefere mais páginas
    if (newIsBr && !oldIsBr) { chapMap.set(num, ch); }
    else if (!newIsBr && oldIsBr) { /* mantém existing */ }
    else if (newPages > oldPages) { chapMap.set(num, ch); }
  }
  return [...chapMap.values()].sort((a, b) => {
    const na = parseFloat(a.attributes.chapter) || 0;
    const nb = parseFloat(b.attributes.chapter) || 0;
    return nb - na; // mais recente primeiro
  });
}

async function mdxGetManga(mangaId) {
  // Metadados
  const m = (await fetchJSON(
    `https://api.mangadex.org/manga/${mangaId}?includes[]=cover_art&includes[]=author`,
    { 'User-Agent': 'MangaHook/1.0 (educational)' }
  )).data;

  const title = m.attributes.title['pt-br'] || m.attributes.title.en || Object.values(m.attributes.title)[0] || '';
  const cover = m.relationships.find(r => r.type === 'cover_art');
  const coverUrl = cover ? `https://uploads.mangadex.org/covers/${m.id}/${cover.attributes?.fileName}.512.jpg` : null;
  const desc = m.attributes.description?.['pt-br'] || m.attributes.description?.en || '';
  const author = m.relationships.find(r => r.type === 'author');

  // Verifica idiomas disponíveis primeiro (evita requests inúteis)
  const availLangs = m.attributes.availableTranslatedLanguages || [];
  console.log(`[MDX] "${title}" | langs disponíveis: [${availLangs.join(', ')}]`);

  // Estratégia: PT-BR → PT → EN — NUNCA mistura idiomas
  let rawChapters = [];
  let usedLang = null;

  const langsToTry = ['pt-br', 'pt', 'en'].filter(l =>
    availLangs.length === 0 || availLangs.includes(l)
  );
  // Se nenhum dos preferidos está disponível, tenta EN de qualquer jeito como último recurso
  if (!langsToTry.includes('en')) langsToTry.push('en');

  for (const lang of langsToTry) {
    try {
      const data = await mdxFetchChaptersForLang(mangaId, lang);
      if (data.length > 0) {
        rawChapters = data;
        usedLang = lang;
        console.log(`[MDX] ${data.length} caps raw em "${lang}"`);
        break;
      }
    } catch (e) {
      console.warn(`[MDX] erro lang="${lang}":`, e.message);
    }
  }

  const sorted = deduplicateChapters(rawChapters);

  const chapters = sorted.map(ch => {
    const groups = (ch.relationships || [])
      .filter(r => r.type === 'scanlation_group')
      .map(r => r.attributes?.name || r.id)
      .filter(Boolean);
    return {
      id: ch.id,
      title: ch.attributes.title || `Capítulo ${ch.attributes.chapter || '?'}`,
      chapterNumber: ch.attributes.chapter || '0',
      volume: ch.attributes.volume || null,
      lang: usedLang,
      groups,
      source: 'mangadex'
    };
  });

  console.log(`[MDX] "${title}" | ${chapters.length} caps únicos em "${usedLang || 'nenhum'}"`);

  return {
    title,
    coverUrl,
    description: desc,
    author: author?.attributes?.name || '',
    status: m.attributes.status || '',
    year: m.attributes.year || null,
    availableLangs: availLangs,
    chapters,
    source: 'mangadex'
  };
}

async function mdxGetPages(chapterId) {
  const data = await fetchJSON(
    `https://api.mangadex.org/at-home/server/${chapterId}`,
    { 'User-Agent': 'MangaHook/1.0 (educational)' }
  );
  return (data.chapter?.data || []).map(f => `${data.baseUrl}/data/${data.chapter.hash}/${f}`);
}

// ══════════════════════════════════════════════════════════════════════════════
//  DYNASTY-SCANS  (dynasty-scans.com)
//  Usa o endpoint JSON não-oficial: /series/SLUG.json e /chapters/SLUG.json
// ══════════════════════════════════════════════════════════════════════════════

const DYNASTY_BASE = 'https://dynasty-scans.com';

const dynastyById = {}; // slug → { title, coverUrl }

async function dynastySearch(query) {
  const cached = getCachedSearch('dynasty', query);
  if (cached) { console.log('[DYNASTY] cache hit'); return cached; }

  try {
    console.log(`[DYNASTY] Buscando: "${query}"`);
    // Dynasty tem um endpoint de busca via query string
    const searchUrl = `${DYNASTY_BASE}/search?q=${encodeURIComponent(query)}&classes[]=Series&format=json`;
    const { buffer, status } = await fetchRaw(searchUrl, {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://dynasty-scans.com/',
    });

    if (status !== 200) return [];
    const json = JSON.parse(buffer.toString('utf8'));
    const results = [];

    for (const item of (json || [])) {
      if (!item.permalink || !item.name) continue;
      const slug = item.permalink.replace(/^\/series\//, '');
      dynastyById[slug] = { title: item.name, coverUrl: item.cover ? `${DYNASTY_BASE}${item.cover}` : null };
      results.push({
        id: `dynasty:${slug}`,
        title: item.name,
        coverUrl: item.cover ? `${DYNASTY_BASE}${item.cover}` : null,
        source: 'dynasty',
      });
    }

    console.log(`[DYNASTY] ${results.length} resultados`);
    setCachedSearch('dynasty', query, results);
    return results;
  } catch (e) {
    console.error('[DYNASTY] search erro:', e.message);
    return [];
  }
}

async function dynastyGetManga(slug) {
  try {
    console.log(`[DYNASTY] getManga slug="${slug}"`);
    const { buffer, status } = await fetchRaw(`${DYNASTY_BASE}/series/${slug}.json`, {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://dynasty-scans.com/',
    });

    if (status !== 200) throw new Error(`HTTP ${status}`);
    const data = JSON.parse(buffer.toString('utf8'));

    const chapters = (data.taggings || [])
      .filter(t => t.permalink && t.header == null) // exclui separadores
      .map((t, i) => ({
        id: `dynasty:${t.permalink.replace(/^\/chapters\//, '')}`,
        title: t.title || `Capítulo ${i + 1}`,
        chapterNumber: String(i + 1),
        source: 'dynasty',
      }))
      .reverse(); // mais recente primeiro

    const title = data.name || slug;
    const coverUrl = data.cover ? `${DYNASTY_BASE}${data.cover}` : null;
    dynastyById[slug] = { title, coverUrl };

    console.log(`[DYNASTY] "${title}" | ${chapters.length} capítulos`);
    return { title, coverUrl, description: data.description || '', chapters, source: 'dynasty' };
  } catch (e) {
    console.error('[DYNASTY] getManga erro:', e.message);
    return { title: slug, coverUrl: null, description: '', chapters: [], source: 'dynasty' };
  }
}

async function dynastyGetPages(chapterSlug) {
  try {
    console.log(`[DYNASTY] getPages slug="${chapterSlug}"`);
    const { buffer, status } = await fetchRaw(`${DYNASTY_BASE}/chapters/${chapterSlug}.json`, {
      'Accept': 'application/json',
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Referer': 'https://dynasty-scans.com/',
    });

    if (status !== 200) { console.warn(`[DYNASTY] HTTP ${status}`); return []; }
    const data = JSON.parse(buffer.toString('utf8'));

    const pages = (data.pages || [])
      .filter(p => p.url)
      .map(p => `${DYNASTY_BASE}${p.url}`);

    console.log(`[DYNASTY] ${pages.length} páginas`);
    return pages;
  } catch (e) {
    console.error('[DYNASTY] getPages erro:', e.message);
    return [];
  }
}

// ══════════════════════════════════════════════════════════════════════════════
//  ANILIST
// ══════════════════════════════════════════════════════════════════════════════

async function anilistSearch(query) {
  const cached = getCachedSearch('anilist', query);
  if (cached) { console.log('[ANILIST] cache hit'); return cached; }

  const gql = `query ($search: String) { Page(page: 1, perPage: 10) { media(search: $search, type: MANGA, sort: SEARCH_MATCH) { id title { romaji english native } coverImage { large extraLarge } bannerImage description(asHtml: false) averageScore genres status chapters startDate { year } } } }`;
  try {
    const { buffer, status } = await fetchPOST('https://graphql.anilist.co', { query: gql, variables: { search: query } });
    if (status !== 200) return [];
    const json = JSON.parse(buffer.toString());
    const results = (json.data?.Page?.media || []).map(m => ({
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
    setCachedSearch('anilist', query, results);
    return results;
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

function xorDecrypt(buf, hexKey) {
  const key = Buffer.from(hexKey, 'hex');
  return Buffer.from(buf.map((b, i) => b ^ key[i % key.length]));
}

// ══════════════════════════════════════════════════════════════════════════════
//  ROTAS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/', (req, res) => res.json({
  status: 'ok', version: '15.0',
  sources: ['mangaplus', 'comick', 'mangadex', 'dynasty', 'lermangas', 'tatakae', 'sakura', 'taiyo', 'kakusei', 'anilist'],
  flaresolverr: FLARE_URL,
  flareSessions: Object.fromEntries(Object.entries(flareSessions).map(([d,s]) => [d, s.sessionId ? 'ativa' : 'sem-sessao'])),
  comickCacheSize: Object.keys(comickById).length,
  searchCacheSize: Object.values(searchCache).reduce((n, s) => n + Object.keys(s).length, 0),
  endpoints: ['/', '/search', '/search-br', '/manga', '/chapter', '/image-proxy', '/titles', '/debug', '/meta', '/debug-comick', '/debug-chapter', '/flare-test']
}));

// ─── GET /search?q=...&source=...&lang=... ───────────────────────────────────
app.get('/search', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { q, source, lang } = req.query;
  if (!q) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH] "${q}" source="${source || 'auto'}" lang="${lang || 'any'}"`);

  if (source === 'comick') return res.json({ results: await comickSearch(q), source: 'comick' });
  if (source === 'anilist') return res.json({ results: await anilistSearch(q), source: 'anilist' });
  if (source === 'mangadex') return res.json({ results: await mdxSearch(q, lang || null), source: 'mangadex' });
  if (source === 'dynasty') return res.json({ results: await dynastySearch(q), source: 'dynasty' });
  // Sources BR via FlareSolverr
  if (source && BR_SOURCES[source]) {
    const r = await BR_SOURCES[source].search(q);
    return res.json({ results: r, source });
  }

  // Auto: MangaPlus → Comick → MangaDex → Dynasty → sites BR
  try {
    const mp = await mpSearch(q);
    if (mp.length > 0) { console.log(`[SEARCH] MangaPlus: ${mp.length}`); return res.json({ results: mp, source: 'mangaplus' }); }
  } catch (e) { console.warn('[SEARCH] MP erro:', e.message); }

  try {
    const ck = await comickSearch(q);
    if (ck.length > 0) { console.log(`[SEARCH] Comick: ${ck.length}`); return res.json({ results: ck, source: 'comick' }); }
  } catch (e) { console.warn('[SEARCH] Comick erro:', e.message); }

  try {
    const mdx = await mdxSearch(q, lang || null);
    if (mdx.length > 0) { console.log(`[SEARCH] MangaDex: ${mdx.length}`); return res.json({ results: mdx, source: 'mangadex' }); }
  } catch (e) { console.error('[SEARCH] MDX erro:', e.message); }

  try {
    const dy = await dynastySearch(q);
    if (dy.length > 0) { console.log(`[SEARCH] Dynasty: ${dy.length}`); return res.json({ results: dy, source: 'dynasty' }); }
  } catch (e) { console.error('[SEARCH] Dynasty erro:', e.message); }

  res.json({ results: [], source: 'none' });
});

// ─── GET /search-br?q=... ─────────────────────────────────────────────────────
// Busca APENAS no MangaDex filtrando por disponibilidade em PT-BR
// Ideal para o Flutter mostrar um filtro "Disponível em Português"
app.get('/search-br', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q obrigatório' });
  console.log(`[SEARCH-BR] "${q}"`);
  try {
    // Busca com filtro pt-br primeiro, fallback sem filtro marcando hasPtBr
    let results = await mdxSearch(q, 'pt-br');
    if (results.length === 0) {
      results = await mdxSearch(q);
      results = results.filter(r => r.hasPtBr);
    }
    console.log(`[SEARCH-BR] ${results.length} resultados PT-BR`);
    return res.json({ results, source: 'mangadex', lang: 'pt-br' });
  } catch (e) {
    console.error('[SEARCH-BR] erro:', e.message);
    res.json({ results: [], source: 'mangadex' });
  }
});

// ─── GET /manga?id=...&source=...&url=... ─────────────────────────────────────
app.get('/manga', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id, source, url } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[MANGA] id="${id}" source="${source}"`);

  // Dynasty: id = "dynasty:SLUG"
  if (source === 'dynasty' || id.startsWith('dynasty:')) {
    const slug = id.replace(/^dynasty:/, '');
    const d = await dynastyGetManga(slug);
    return res.json(d);
  }

  // Sites BR via FlareSolverr (id formato "source:slug")
  const brSrc = getBrSource(id, source);
  if (brSrc) {
    try {
      const d = await BR_SOURCES[brSrc].getManga(id);
      console.log(`[MANGA] ${brSrc}: "${d.title}" | ${d.chapters.length} caps`);
      return res.json(d);
    } catch (e) { console.error(`[MANGA] ${brSrc} erro:`, e.message); }
  }

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

  if (isUuid(id) || source === 'mangadex' || source === 'mangahook') {
    try {
      const d = await mdxGetManga(id);
      console.log(`[MANGA] MDX: "${d.title}" | ${d.chapters.length} caps`);
      return res.json(d);
    } catch (e) { return res.status(500).json({ error: e.message }); }
  }

  res.status(404).json({ error: 'Fonte não reconhecida' });
});

// ─── GET /chapter?id=...&source=... ──────────────────────────────────────────
app.get('/chapter', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id, source } = req.query;
  if (!id) return res.status(400).json({ error: 'id obrigatório' });
  console.log(`[CHAPTER] id="${id.slice(0, 50)}" source="${source}"`);

  // Dynasty: id = "dynasty:SLUG"
  if (source === 'dynasty' || id.startsWith('dynasty:')) {
    const slug = id.replace(/^dynasty:/, '');
    try {
      const pages = await dynastyGetPages(slug);
      if (pages.length > 0) {
        console.log(`[CHAPTER] Dynasty: ${pages.length} páginas`);
        return res.json({ pages, source: 'dynasty' });
      }
      return res.json({ pages: [], source: 'dynasty' });
    } catch (e) { console.error('[CHAPTER] Dynasty erro:', e.message); }
  }

  // Sites BR via FlareSolverr — id formato "source:BASE64"
  const brSrcCh = getBrSource(id, source);
  if (brSrcCh) {
    try {
      const b64 = id.replace(/^[a-z]+:/, '');
      const pages = await BR_SOURCES[brSrcCh].getPages(b64);
      console.log(`[CHAPTER] ${brSrcCh}: ${pages.length} páginas`);
      return res.json({ pages, source: brSrcCh });
    } catch (e) { console.error(`[CHAPTER] ${brSrcCh} erro:`, e.message); }
  }

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
      console.log(`[CHAPTER] Comick: ${pages.length} páginas`);
      return res.json({ pages, source: 'comick' });
    } catch (e) { console.error('[CHAPTER] Comick erro:', e.message); }
  }

  if (isUuid(id) || source === 'mangadex' || source === 'mangahook') {
    try {
      const pages = await mdxGetPages(id);
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
    const decodedUrl = decodeURIComponent(url);
    // Referer dinâmico dependendo do domínio
    const domain = getDomain(decodedUrl);
    const referer = decodedUrl.includes('dynasty-scans') ? 'https://dynasty-scans.com/'
      : decodedUrl.includes('mangaplus') ? 'https://mangaplus.shueisha.co.jp/'
      : decodedUrl.includes('mangadex') ? 'https://mangadex.org/'
      : `https://${domain}/`;
    // Se temos cookies do FlareSolverr para esse domínio, usa eles
    const flareSession = flareSessions[domain];
    const extraHeaders = flareSession ? {
      'Cookie': flareSession.cookies.map(c => `${c.name}=${c.value}`).join('; '),
      'User-Agent': flareSession.userAgent,
    } : {};
    const { buffer, status } = await fetchRaw(decodedUrl, { 'Referer': referer, ...extraHeaders });
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
  if (!id) return res.json({ ids_mapeados: MANGA_IDS, comick_cache_size: Object.keys(comickById).length });
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

  return res.json({ id, entry, titleKey: key, siblings: siblings.length, testedUrls: urlsToTest.length, results });
});

// ─── GET /debug-chapter?id=BASE64 ────────────────────────────────────────────
app.get('/debug-chapter', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { id } = req.query;
  if (!id) return res.status(400).json({ error: 'id (base64 da URL) obrigatório' });
  try {
    const url = Buffer.from(id, 'base64').toString('utf8');
    const { buffer, status } = await fetchRaw(url, {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36',
      'Accept': 'text/html,*/*',
    });
    const html = buffer.toString('utf8');
    const imgTags = (html.match(/<img[^>]+>/gi) || []).slice(0, 5);
    const scriptUrls = (html.match(/https:\/\/[^"']+\.(?:jpg|jpeg|png|webp)[^"']*/gi) || []).slice(0, 10);
    return res.json({
      url, httpStatus: status, htmlLength: html.length,
      hasNextData: html.includes('__NEXT_DATA__'),
      htmlSample: html.slice(0, 2000),
      imgTags, scriptUrls,
    });
  } catch (e) { res.status(500).json({ erro: e.message }); }
});


// ─── GET /flare-test?url=... ─────────────────────────────────────────────────
// Testa se o FlareSolverr consegue acessar uma URL
app.get('/flare-test', async (req, res) => {
  res.setHeader('Content-Type', 'application/json');
  const { url } = req.query;
  if (!url) {
    return res.json({
      flareUrl: FLARE_URL,
      activeSessions: Object.keys(flareSessions),
      tip: 'Adicione ?url=https://lermangas.me para testar'
    });
  }
  try {
    const start = Date.now();
    // Chama FlareSolverr diretamente para ver a resposta raw em caso de erro
    const targetUrl = decodeURIComponent(url);
    const body = { cmd: 'request.get', url: targetUrl, maxTimeout: FLARE_TIMEOUT };
    const { buffer, status } = await fetchPOST(`${FLARE_URL}/v1`, body, {}, FLARE_TIMEOUT + 5000);
    const rawJson = JSON.parse(buffer.toString('utf8'));
    const ms = Date.now() - start;
    if (rawJson.status === 'ok') {
      return res.json({
        ok: true, flareStatus: 'ok', httpStatus: rawJson.solution?.status,
        htmlLength: rawJson.solution?.response?.length || 0, ms,
        userAgent: rawJson.solution?.userAgent,
        cookies: rawJson.solution?.cookies?.length || 0,
        htmlSample: (rawJson.solution?.response || '').slice(0, 800),
      });
    } else {
      // Mostra a resposta completa do FlareSolverr para diagnóstico
      return res.json({
        ok: false, flareHttpStatus: status, ms,
        flareMessage: rawJson.message,
        flareStatus: rawJson.status,
        diagnosis: rawJson.message?.includes('Timeout') 
          ? 'Cloudflare Turnstile/CAPTCHA — FlareSolverr não consegue resolver este desafio automaticamente. O site usa proteção avançada.'
          : rawJson.message?.includes('ERR_NAME_NOT_RESOLVED')
          ? 'DNS não resolvido — verifique a URL'
          : 'Erro desconhecido do FlareSolverr',
      });
    }
  } catch (e) {
    return res.json({ ok: false, error: e.message, flareUrl: FLARE_URL });
  }
});

// ─── GET /cache-clear ────────────────────────────────────────────────────────

app.get('/cache-clear', (req, res) => {
  const { source } = req.query;
  if (source && searchCache[source]) {
    const count = Object.keys(searchCache[source]).length;
    delete searchCache[source];
    return res.json({ ok: true, cleared: source, entries: count });
  }
  const total = Object.values(searchCache).reduce((n, s) => n + Object.keys(s).length, 0);
  for (const k of Object.keys(searchCache)) delete searchCache[k];
  res.json({ ok: true, cleared: 'all', entries: total });
});

app.listen(PORT, () => console.log(`Proxy v15.0 na porta ${PORT}`));
