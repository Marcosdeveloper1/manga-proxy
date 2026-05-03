const express = require('express');
const https = require('https');
const http = require('http');
const { randomUUID } = require('crypto');

const app = express();
const PORT = process.env.PORT || 3000;

// ─── Helpers HTTP ─────────────────────────────────────────────────────────────
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

// Helper para POST (necessário para busca no Mangá Livre)
async function fetchPOST(url, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const data = JSON.stringify(body);
    const urlObj = new URL(url);
    const options = {
      hostname: urlObj.hostname,
      path: urlObj.pathname,
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Content-Length': Buffer.byteLength(data),
        'X-Requested-With': 'XMLHttpRequest',
        'User-Agent': 'Mozilla/5.0',
        ...headers
      }
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

// ─── Mangá Livre ──────────────────────────────────────────────────────────────
async function mlSearch(query) {
  try {
    const { buffer, status } = await fetchPOST('https://mangalivre.net/api/search', { search: query });
    if (status !== 200) return [];
    const data = JSON.parse(buffer.toString());
    const series = data.series || data.data || [];
    return series.map(s => ({
      id: String(s.id_series || s.id),
      title: s.name || s.title,
      coverUrl: s.cover || s.image,
      source: 'mangalivre'
    }));
  } catch (e) { return []; }
}

async function mlGetManga(seriesId) {
  const { buffer } = await fetchRaw(`https://mangalivre.net/api/chapters/${seriesId}`, { 'X-Requested-With': 'XMLHttpRequest' });
  const data = JSON.parse(buffer.toString());
  const chapters = (data.chapters || []).map(c => ({
    id: String(c.id_release || c.id),
    title: c.chapter_name || `Capítulo ${c.number}`,
    chapterNumber: String(c.number),
    source: 'mangalivre'
  }));
  return { title: data.name || 'Mangá Livre', coverUrl: data.cover, description: data.description || '', chapters, source: 'mangalivre' };
}

async function mlGetPages(releaseId) {
  const { buffer } = await fetchRaw(`https://mangalivre.net/api/pages/${releaseId}`, { 'X-Requested-With': 'XMLHttpRequest' });
  const data = JSON.parse(buffer.toString());
  const pages = data.images || data.pages || [];
  return pages.map(p => p.legacy || p.online || p.avif || p.url);
}

// [Mantenha aqui as funções readPB, mpSearch, mpGetTitle, mpGetPages, etc. do server.js original]

// ══════════════════════════════════════════════════════════════════════════════
// ROTAS ATUALIZADAS
// ══════════════════════════════════════════════════════════════════════════════

app.get('/search', async (req, res) => {
  const { q } = req.query;
  if (!q) return res.status(400).json({ error: 'q obrigatório' });

  // 1. MangaPlus
  try {
    const mp = await mpSearch(q);
    if (mp.length > 0) return res.json({ results: mp, source: 'mangaplus' });
  } catch (e) {}

  // 2. Mangá Livre
  try {
    const ml = await mlSearch(q);
    if (ml.length > 0) return res.json({ results: ml, source: 'mangalivre' });
  } catch (e) {}

  // 3. MangaDex
  try {
    const dex = await fetchJSON(`https://api.mangadex.org/manga?title=${encodeURIComponent(q)}&limit=20&includes[]=cover_art`);
    if (dex.data?.length > 0) {
      const results = dex.data.map(m => ({
        id: m.id,
        title: m.attributes.title.en || Object.values(m.attributes.title)[0],
        coverUrl: `https://uploads.mangadex.org/covers/${m.id}/${m.relationships.find(r => r.type === 'cover_art')?.attributes?.fileName}.512.jpg`,
        source: 'mangadex'
      }));
      return res.json({ results, source: 'mangadex' });
    }
  } catch (e) {}

  res.json({ results: [], source: 'none' });
});

app.get('/manga', async (req, res) => {
  const { id, source } = req.query;
  if (source === 'mangalivre') return res.json(await mlGetManga(id));
  if (source === 'mangaplus' || /^\d+$/.test(id)) return res.json(await mpGetTitle(id));
  // Fallback MangaDex...
});

app.get('/chapter', async (req, res) => {
  const { id, source } = req.query;
  if (source === 'mangalivre') return res.json({ pages: await mlGetPages(id), source: 'mangalivre' });
  if (source === 'mangaplus' || /^\d+$/.test(id)) {
    const pages = (await mpGetPages(id)).map(p =>
      `${req.protocol}://${req.get('host')}/image-proxy?url=${encodeURIComponent(p.imageUrl)}&key=${encodeURIComponent(p.encryptionKey)}`);
    return res.json({ pages, source: 'mangaplus' });
  }
  // Fallback MangaDex...
});

app.listen(PORT, () => console.log(`Proxy v9.0 (Mangá Livre ON) na porta ${PORT}`));
