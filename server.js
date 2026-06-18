// The Tiny Island Times — server.js
// Zero npm dependencies — uses only Node's built-in modules (Node 18+ for global fetch).
// Posts are stored in a Supabase Postgres table; images in Supabase Storage.
// This keeps the app itself free to host (no disk needed) while still being
// a single, simple file.

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const url = require('url');

const PORT = process.env.PORT || 3000;
const ROOT = __dirname;

// Set these in your hosting environment's variables.
const ADMIN_PASSWORD = process.env.ADMIN_PASSWORD || 'changeme';
const SUPABASE_URL = process.env.SUPABASE_URL || ''; // e.g. https://abcxyz.supabase.co
const SUPABASE_SECRET_KEY = process.env.SUPABASE_SECRET_KEY || ''; // service_role / sb_secret key — server-side only, never sent to the browser
const SUPABASE_BUCKET = process.env.SUPABASE_BUCKET || 'article-images';

// Umami analytics — only added to public-facing pages (home, articles, 404),
// deliberately left off /admin pages so your own publishing visits don't
// skew the numbers. Override via env var if you ever change Umami sites.
const ANALYTICS_SCRIPT = process.env.ANALYTICS_SCRIPT || '<script defer src="https://cloud.umami.is/script.js" data-website-id="5bd77b7e-756b-4391-9b19-b5f21082aeb4"></script>';

if (!SUPABASE_URL || !SUPABASE_SECRET_KEY) {
  console.warn('WARNING: SUPABASE_URL and/or SUPABASE_SECRET_KEY are not set. The site will not be able to read or save posts until these are configured.');
}

function supabaseHeaders(extra = {}) {
  return {
    apikey: SUPABASE_SECRET_KEY,
    Authorization: `Bearer ${SUPABASE_SECRET_KEY}`,
    ...extra,
  };
}

// --- Helpers ---

// --- Storage layer: Supabase Postgres table "posts" via the auto-generated REST API ---
// Table schema (see README / MIGRATION.md for the exact SQL to run in the Supabase SQL editor):
//   id text primary key, slug text unique, title text, kicker text, dek text,
//   author text, body text, header_image text, header_caption text,
//   mid_image text, mid_caption text, tags text[],
//   layout text default 'standard', listicle_items jsonb default '[]', created_at timestamptz

async function readPosts() {
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?select=*&order=created_at.desc`, {
      headers: supabaseHeaders(),
    });
    if (!res.ok) {
      console.error('readPosts failed:', res.status, await res.text());
      return [];
    }
    const rows = await res.json();
    return rows.map(rowToPost);
  } catch (e) {
    console.error('readPosts error:', e);
    return [];
  }
}

function rowToPost(row) {
  return {
    id: row.id,
    slug: row.slug,
    title: row.title,
    kicker: row.kicker,
    dek: row.dek,
    author: row.author,
    body: row.body,
    headerImage: row.header_image,
    headerCaption: row.header_caption || '',
    midImage: row.mid_image,
    midCaption: row.mid_caption || '',
    layout: row.layout || 'standard',
    listicleItems: Array.isArray(row.listicle_items) ? row.listicle_items : [],
    tags: Array.isArray(row.tags) ? row.tags : [],
    createdAt: row.created_at,
  };
}

function postToRow(post) {
  return {
    id: post.id,
    slug: post.slug,
    title: post.title,
    kicker: post.kicker,
    dek: post.dek,
    author: post.author,
    body: post.body,
    header_image: post.headerImage,
    header_caption: post.headerCaption || '',
    mid_image: post.midImage,
    mid_caption: post.midCaption || '',
    layout: post.layout || 'standard',
    listicle_items: Array.isArray(post.listicleItems) ? post.listicleItems : [],
    tags: Array.isArray(post.tags) ? post.tags : [],
    created_at: post.createdAt,
  };
}

// Turn a comma-separated string like "Politics, royals,  Westminster" into
// a clean array of unique tags, trimmed and de-duplicated case-insensitively
// (keeping the first-seen casing) so "politics" and "Politics" collapse together.
function parseTags(input) {
  if (!input) return [];
  const seen = new Map();
  input.split(',').forEach(raw => {
    const tag = raw.trim();
    if (!tag) return;
    const key = tag.toLowerCase();
    if (!seen.has(key)) seen.set(key, tag);
  });
  return Array.from(seen.values());
}

async function insertPost(post) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts`, {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(postToRow(post)),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to save post: ${res.status} ${text}`);
  }
}

async function deletePostById(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?id=eq.${encodeURIComponent(id)}`, {
    method: 'DELETE',
    headers: supabaseHeaders(),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to delete post: ${res.status} ${text}`);
  }
}

async function findPostById(id) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?id=eq.${encodeURIComponent(id)}&select=*`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? rowToPost(rows[0]) : null;
}

async function updatePost(id, updates) {
  const row = postToRow(updates);
  delete row.id; // never change the primary key on update
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?id=eq.${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: supabaseHeaders({ 'Content-Type': 'application/json', Prefer: 'return=minimal' }),
    body: JSON.stringify(row),
  });
  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Failed to update post: ${res.status} ${text}`);
  }
}

async function findPostBySlug(slug) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?slug=eq.${encodeURIComponent(slug)}&select=*`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) return null;
  const rows = await res.json();
  return rows.length ? rowToPost(rows[0]) : null;
}

async function slugExists(slug) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/posts?slug=eq.${encodeURIComponent(slug)}&select=slug`, {
    headers: supabaseHeaders(),
  });
  if (!res.ok) return false;
  const rows = await res.json();
  return rows.length > 0;
}

function slugify(title) {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/(^-|-$)/g, '')
    .slice(0, 60) || 'post';
}

function escapeHtml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#039;');
}

// Convert plain text (paragraphs separated by blank lines) into safe <p> tags.
function textToParagraphs(text) {
  return text
    .split(/\n\s*\n/)
    .map(p => p.trim())
    .filter(Boolean)
    .map(p => `<p>${escapeHtml(p).replace(/\n/g, '<br>')}</p>`)
    .join('\n');
}

function formatDate(iso) {
  const d = new Date(iso);
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
}

// RSS <pubDate> requires RFC 822 format, which is what Date.toUTCString() gives us.
function formatRssDate(iso) {
  return new Date(iso).toUTCString();
}

function escapeXml(str) {
  if (!str) return '';
  return str
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

function sendXml(res, status, xml) {
  res.writeHead(status, { 'Content-Type': 'application/rss+xml; charset=utf-8' });
  res.end(xml);
}

function sendXmlGeneric(res, status, xml) {
  res.writeHead(status, { 'Content-Type': 'application/xml; charset=utf-8' });
  res.end(xml);
}

function sendHtml(res, status, html) {
  res.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8' });
  res.end(html);
}

function sendJson(res, status, obj) {
  res.writeHead(status, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(obj));
}

function sendNotFound(res) {
  sendHtml(res, 404, renderLayout('Not found', `
    <div class="wrap">
      <p class="kicker">404 — DISPATCH LOST IN TRANSIT</p>
      <h1>This story didn't make the print run.</h1>
      <p><a href="/">Back to the front page</a></p>
    </div>
  `, { ogDescription: "This story didn't make the print run.", extraHead: ANALYTICS_SCRIPT }));
}

function serveStaticFile(res, filePath, contentType) {
  fs.readFile(filePath, (err, data) => {
    if (err) return sendNotFound(res);
    res.writeHead(200, { 'Content-Type': contentType });
    res.end(data);
  });
}

// --- Cookie-based admin auth (simple, single-password) ---

function parseCookies(req) {
  const header = req.headers.cookie;
  const out = {};
  if (!header) return out;
  header.split(';').forEach(pair => {
    const idx = pair.indexOf('=');
    if (idx === -1) return;
    out[pair.slice(0, idx).trim()] = decodeURIComponent(pair.slice(idx + 1).trim());
  });
  return out;
}

const SESSION_SECRET = crypto.randomBytes(32).toString('hex'); // regenerated each server start
function makeSessionToken() {
  return crypto.createHmac('sha256', SESSION_SECRET).update('admin-session').digest('hex');
}
const VALID_SESSION_TOKEN = makeSessionToken();

function safeCompare(a, b) {
  const bufA = Buffer.from(String(a));
  const bufB = Buffer.from(String(b));
  if (bufA.length !== bufB.length) {
    // Still run a comparison of equal length to avoid leaking length via timing.
    crypto.timingSafeEqual(bufA, Buffer.alloc(bufA.length));
    return false;
  }
  return crypto.timingSafeEqual(bufA, bufB);
}

function isAuthed(req) {
  const cookies = parseCookies(req);
  return !!cookies.session && safeCompare(cookies.session, VALID_SESSION_TOKEN);
}

// --- Multipart form parsing (for image uploads), no dependencies ---

function parseMultipart(req, callback, maxBytes) {
  const contentType = req.headers['content-type'] || '';
  const match = contentType.match(/boundary=(?:"([^"]+)"|([^;]+))/);
  if (!match) return callback(new Error('No boundary found'), null);
  const boundary = '--' + (match[1] || match[2]);

  const MAX_BYTES = maxBytes || 15 * 1024 * 1024; // default 15MB; callers with many images pass a higher cap
  let totalBytes = 0;
  let tooLarge = false;

  const chunks = [];
  req.on('data', chunk => {
    totalBytes += chunk.length;
    if (totalBytes > MAX_BYTES) {
      tooLarge = true;
      req.destroy();
      return;
    }
    chunks.push(chunk);
  });
  req.on('end', () => {
    if (tooLarge) return callback(new Error('Upload too large (15MB limit)'), null);
    try {
      const buffer = Buffer.concat(chunks);
      const boundaryBuf = Buffer.from(boundary);
      const parts = [];
      let start = buffer.indexOf(boundaryBuf);
      while (start !== -1) {
        const next = buffer.indexOf(boundaryBuf, start + boundaryBuf.length);
        if (next === -1) break;
        const partBuf = buffer.slice(start + boundaryBuf.length, next);
        parts.push(partBuf);
        start = next;
      }

      const fields = {};
      const files = {};

      for (let part of parts) {
        // Strip leading CRLF and trailing CRLF
        if (part.slice(0, 2).toString() === '\r\n') part = part.slice(2);
        if (part.slice(-2).toString() === '\r\n') part = part.slice(0, -2);
        if (part.length === 0) continue;
        if (part.toString() === '--' || part.toString().startsWith('--')) continue;

        const headerEnd = part.indexOf('\r\n\r\n');
        if (headerEnd === -1) continue;
        const headerStr = part.slice(0, headerEnd).toString('utf8');
        const body = part.slice(headerEnd + 4);

        const nameMatch = headerStr.match(/name="([^"]+)"/);
        const filenameMatch = headerStr.match(/filename="([^"]*)"/);
        const contentTypeMatch = headerStr.match(/Content-Type:\s*(.+)/i);

        if (!nameMatch) continue;
        const fieldName = nameMatch[1];

        if (filenameMatch && filenameMatch[1]) {
          files[fieldName] = {
            filename: filenameMatch[1],
            contentType: contentTypeMatch ? contentTypeMatch[1].trim() : 'application/octet-stream',
            data: body,
          };
        } else if (filenameMatch && !filenameMatch[1]) {
          // Empty file input, skip
        } else {
          fields[fieldName] = body.toString('utf8');
        }
      }

      callback(null, { fields, files });
    } catch (e) {
      callback(e, null);
    }
  });
  req.on('error', err => callback(err, null));
}

async function saveUploadedFile(file) {
  if (!file || !file.data || file.data.length === 0) return null;
  const ext = path.extname(file.filename) || guessExtFromMime(file.contentType);
  const safeExt = ['.jpg', '.jpeg', '.png', '.gif', '.webp'].includes(ext.toLowerCase()) ? ext.toLowerCase() : '.jpg';
  const id = crypto.randomBytes(8).toString('hex');
  const outName = `${id}${safeExt}`;

  const res = await fetch(`${SUPABASE_URL}/storage/v1/object/${SUPABASE_BUCKET}/${outName}`, {
    method: 'POST',
    headers: supabaseHeaders({ 'Content-Type': file.contentType || 'application/octet-stream' }),
    body: file.data,
  });

  if (!res.ok) {
    const text = await res.text();
    throw new Error(`Image upload failed: ${res.status} ${text}`);
  }

  // Public bucket convention — see Supabase Storage docs for "Serving assets".
  return `${SUPABASE_URL}/storage/v1/object/public/${SUPABASE_BUCKET}/${outName}`;
}

function guessExtFromMime(mime) {
  if (!mime) return '.jpg';
  if (mime.includes('png')) return '.png';
  if (mime.includes('gif')) return '.gif';
  if (mime.includes('webp')) return '.webp';
  return '.jpg';
}

function parseBodyUrlEncoded(req, callback) {
  let body = '';
  req.on('data', chunk => (body += chunk));
  req.on('end', () => {
    const params = new url.URLSearchParams(body);
    const fields = {};
    for (const [k, v] of params) fields[k] = v;
    callback(null, { fields, files: {} });
  });
}

// --- Templates ---

const SITE_URL = process.env.SITE_URL || 'https://tinyislandtimes.onrender.com';
const DEFAULT_OG_DESCRIPTION = 'The Truthiest News Around.';
const DEFAULT_OG_IMAGE = `${SITE_URL}/og-default.png`;

function renderLayout(title, bodyHtml, options = {}) {
  const {
    extraHead = '',
    ogDescription = DEFAULT_OG_DESCRIPTION,
    ogImage = DEFAULT_OG_IMAGE,
    ogUrl = SITE_URL,
    ogType = 'website',
  } = options;

  const fullTitle = `${escapeHtml(title)} — The Tiny Island Times`;
  const safeDescription = escapeHtml(ogDescription);

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<meta name="theme-color" content="#A8231F">
<title>${fullTitle}</title>
<meta name="description" content="${safeDescription}">

<meta property="og:title" content="${fullTitle}">
<meta property="og:description" content="${safeDescription}">
<meta property="og:image" content="${ogImage}">
<meta property="og:url" content="${ogUrl}">
<meta property="og:type" content="${ogType}">
<meta property="og:site_name" content="The Tiny Island Times">

<meta name="twitter:card" content="summary_large_image">
<meta name="twitter:title" content="${fullTitle}">
<meta name="twitter:description" content="${safeDescription}">
<meta name="twitter:image" content="${ogImage}">

<link rel="stylesheet" href="/style.css">
<link rel="icon" href="/favicon.ico" sizes="any">
<link rel="apple-touch-icon" href="/favicon-180.png">
<link rel="alternate" type="application/rss+xml" title="The Tiny Island Times RSS Feed" href="/rss.xml">
<link rel="canonical" href="${ogUrl}">
${extraHead}
</head>
<body>
<header class="masthead">
  <div class="wrap masthead-inner">
    <div class="masthead-strip">
      <span>${new Date().toLocaleDateString('en-GB', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' }).toUpperCase()}</span>
      <span class="masthead-divider">·</span>
      <span>UNITED KINGDOM</span>
    </div>
    <a href="/" class="masthead-title"><img src="/logo.png" alt="The Tiny Island Times" class="masthead-logo"></a>
    <div class="masthead-tagline">The Truthiest News Around</div>
    <a href="https://www.facebook.com/share/1DR8xdfRyp/?mibextid=wwXIfr" target="_blank" rel="noopener" class="fb-follow-btn" aria-label="Follow The Tiny Island Times on Facebook">
      <svg class="fb-follow-icon" xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" aria-hidden="true"><path d="M24 12.073C24 5.405 18.627 0 12 0S0 5.405 0 12.073C0 18.1 4.388 23.094 10.125 24v-8.437H7.078v-3.49h3.047V9.41c0-3.025 1.792-4.697 4.533-4.697 1.312 0 2.686.235 2.686.235v2.97h-1.513c-1.491 0-1.956.93-1.956 1.886v2.269h3.328l-.532 3.49h-2.796V24C19.612 23.094 24 18.1 24 12.073z"/></svg>
      Follow us on Facebook
    </a>
    <form action="/search" method="GET" class="masthead-search" role="search">
      <input type="search" name="q" placeholder="Search The Tiny Island Times" aria-label="Search The Tiny Island Times" class="masthead-search-input">
      <button type="submit" class="masthead-search-btn">Search</button>
    </form>
  </div>
</header>
<main>
${bodyHtml}
</main>
<footer class="site-footer">
  <div class="wrap">
    <p>The Tiny Island Times publishes the stories that matter then sort of plays around with them a bit. Unflinching journalism that follows you down the street and smacks you over the head with an air fryer filled with crisps. Your rancid, shameful window to the world.</p>
    <p><a href="/rss.xml">RSS feed</a> · <a href="/sitemap.xml">Sitemap</a> · <a href="/admin">Admin</a></p>
  </div>
</footer>
</body>
</html>`;
}

const POSTS_PER_PAGE = 10;

function renderStoryCard(post, fallbackKicker = 'IN THE NEWS') {
  const excerpt = buildExcerpt(post);
  return `
    <article class="grid-story">
      <a href="/article/${post.slug}" class="grid-link">
        ${post.headerImage ? `<img class="grid-image" src="${post.headerImage}" alt="${escapeHtml(post.title)}" loading="lazy">` : ''}
        <p class="kicker">${escapeHtml(post.kicker || fallbackKicker)}</p>
        <h2 class="grid-headline">${escapeHtml(post.title)}</h2>
        <p class="byline">By ${escapeHtml(post.author || 'Staff Reporter')} · ${formatDate(post.createdAt)}</p>
        ${excerpt ? `<p class="card-excerpt">${excerpt}</p>` : ''}
      </a>
    </article>
  `;
}

function renderHomepage(posts, page = 1) {
  if (posts.length === 0) {
    return renderLayout('Home', `
      <div class="wrap empty-state">
        <p class="kicker">A QUIET DAY IN THE NEWSROOM</p>
        <h1>Nothing's been filed yet.</h1>
        <p>Once a story is published, it'll appear here for the nation to misread as fact.</p>
      </div>
    `, { extraHead: ANALYTICS_SCRIPT });
  }

  const totalPages = Math.max(1, Math.ceil(posts.length / POSTS_PER_PAGE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const pagePosts = posts.slice((currentPage - 1) * POSTS_PER_PAGE, currentPage * POSTS_PER_PAGE);

  // Page 1 gets the full "front page" treatment: a lead story, then two
  // secondary stories side by side, then the regular grid. Later pages
  // skip the lead/secondary treatment entirely, since "page 2's top story"
  // isn't really a lead story — it just goes straight into the grid.
  const isFrontPage = currentPage === 1;
  const lead = isFrontPage ? pagePosts[0] : null;
  const secondary = isFrontPage ? pagePosts.slice(1, 3) : [];
  const rest = isFrontPage ? pagePosts.slice(3) : pagePosts;

  const leadHtml = lead ? `
    <article class="lead-story">
      <a href="/article/${lead.slug}" class="lead-link">
        ${lead.headerImage ? `<img class="lead-image" src="${lead.headerImage}" alt="${escapeHtml(lead.title)}">` : ''}
        <p class="kicker">${escapeHtml(lead.kicker || 'TOP STORY')}</p>
        <h1 class="lead-headline">${escapeHtml(lead.title)}</h1>
        <p class="byline">By ${escapeHtml(lead.author || 'Staff Reporter')} · ${formatDate(lead.createdAt)}</p>
        <p class="lead-dek">${escapeHtml(lead.dek || '')}</p>
        ${buildExcerpt(lead) ? `<p class="card-excerpt card-excerpt-lead">${buildExcerpt(lead)}</p>` : ''}
      </a>
    </article>
  ` : '';

  const secondaryHtml = secondary.length > 0 ? `
    <div class="secondary-row">
      ${secondary.map(post => `
        <article class="secondary-story">
          <a href="/article/${post.slug}" class="secondary-link">
            ${post.headerImage ? `<img class="secondary-image" src="${post.headerImage}" alt="${escapeHtml(post.title)}" loading="lazy">` : ''}
            <p class="kicker">${escapeHtml(post.kicker || 'ALSO TODAY')}</p>
            <h2 class="secondary-headline">${escapeHtml(post.title)}</h2>
            <p class="byline">By ${escapeHtml(post.author || 'Staff Reporter')} · ${formatDate(post.createdAt)}</p>
            ${buildExcerpt(post) ? `<p class="card-excerpt">${buildExcerpt(post)}</p>` : ''}
          </a>
        </article>
      `).join('\n')}
    </div>
  ` : '';

const gridHtml = rest.map(post => renderStoryCard(post)).join('\n');

  const paginationHtml = totalPages > 1 ? `
    <nav class="pagination" aria-label="Pagination">
      ${currentPage > 1 ? `<a href="/?page=${currentPage - 1}" class="page-link">&larr; Newer</a>` : '<span class="page-link page-link-disabled">&larr; Newer</span>'}
      <span class="page-status">Page ${currentPage} of ${totalPages}</span>
      ${currentPage < totalPages ? `<a href="/?page=${currentPage + 1}" class="page-link">Older &rarr;</a>` : '<span class="page-link page-link-disabled">Older &rarr;</span>'}
    </nav>
  ` : '';

  return renderLayout('Home', `
    <div class="wrap">
      ${leadHtml}
      ${secondaryHtml ? `<hr class="rule">${secondaryHtml}` : ''}
      <hr class="rule">
      <div class="story-grid">
        ${gridHtml}
      </div>
      ${paginationHtml}
    </div>
  `, {
    ogImage: `${SITE_URL}/og-default.png`,
    ogUrl: currentPage > 1 ? `${SITE_URL}/?page=${currentPage}` : SITE_URL,
    extraHead: ANALYTICS_SCRIPT,
  });
}

function renderTagPage(tagName, posts, page = 1) {
  const totalPages = Math.max(1, Math.ceil(posts.length / POSTS_PER_PAGE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const pagePosts = posts.slice((currentPage - 1) * POSTS_PER_PAGE, currentPage * POSTS_PER_PAGE);
  const tagSlug = slugify(tagName);

  const gridHtml = pagePosts.length > 0
    ? pagePosts.map(post => renderStoryCard(post)).join('\n')
    : `<p class="empty-tag-message">No stories tagged ${escapeHtml(tagName)} yet.</p>`;

  const paginationHtml = totalPages > 1 ? `
    <nav class="pagination" aria-label="Pagination">
      ${currentPage > 1 ? `<a href="/tag/${tagSlug}?page=${currentPage - 1}" class="page-link">&larr; Newer</a>` : '<span class="page-link page-link-disabled">&larr; Newer</span>'}
      <span class="page-status">Page ${currentPage} of ${totalPages}</span>
      ${currentPage < totalPages ? `<a href="/tag/${tagSlug}?page=${currentPage + 1}" class="page-link">Older &rarr;</a>` : '<span class="page-link page-link-disabled">Older &rarr;</span>'}
    </nav>
  ` : '';

  return renderLayout(`${tagName} — Tag`, `
    <div class="wrap">
      <p class="kicker">BROWSING BY TAG</p>
      <h1 class="tag-page-heading">${escapeHtml(tagName)}</h1>
      <p class="tag-page-count">${posts.length} ${posts.length === 1 ? 'story' : 'stories'}</p>
      <hr class="rule">
      <div class="story-grid">
        ${gridHtml}
      </div>
      ${paginationHtml}
    </div>
  `, {
    ogImage: `${SITE_URL}/og-default.png`,
    ogUrl: `${SITE_URL}/tag/${tagSlug}`,
    extraHead: ANALYTICS_SCRIPT,
  });
}

function searchPosts(posts, query) {
  const q = query.trim().toLowerCase();
  if (!q) return [];
  return posts.filter(post => {
    const haystack = [post.title, post.dek, post.body, post.author, ...(post.tags || [])]
      .filter(Boolean)
      .join(' ')
      .toLowerCase();
    return haystack.includes(q);
  });
}

function renderSearchPage(query, results, page = 1) {
  const totalPages = Math.max(1, Math.ceil(results.length / POSTS_PER_PAGE));
  const currentPage = Math.min(Math.max(1, page), totalPages);
  const pageResults = results.slice((currentPage - 1) * POSTS_PER_PAGE, currentPage * POSTS_PER_PAGE);
  const encodedQuery = encodeURIComponent(query);

  const gridHtml = pageResults.length > 0
    ? pageResults.map(post => renderStoryCard(post)).join('\n')
    : `<p class="empty-tag-message">No stories matching "${escapeHtml(query)}".</p>`;

  const paginationHtml = totalPages > 1 ? `
    <nav class="pagination" aria-label="Pagination">
      ${currentPage > 1 ? `<a href="/search?q=${encodedQuery}&page=${currentPage - 1}" class="page-link">&larr; Newer</a>` : '<span class="page-link page-link-disabled">&larr; Newer</span>'}
      <span class="page-status">Page ${currentPage} of ${totalPages}</span>
      ${currentPage < totalPages ? `<a href="/search?q=${encodedQuery}&page=${currentPage + 1}" class="page-link">Older &rarr;</a>` : '<span class="page-link page-link-disabled">Older &rarr;</span>'}
    </nav>
  ` : '';

  return renderLayout(query ? `Search: ${query}` : 'Search', `
    <div class="wrap">
      <p class="kicker">SEARCH RESULTS</p>
      <h1 class="tag-page-heading">${query ? `"${escapeHtml(query)}"` : 'Search The Tiny Island Times'}</h1>
      ${query ? `<p class="tag-page-count">${results.length} ${results.length === 1 ? 'result' : 'results'}</p>` : ''}
      <hr class="rule">
      <div class="story-grid">
        ${gridHtml}
      </div>
      ${paginationHtml}
    </div>
  `, { extraHead: ANALYTICS_SCRIPT });
}

// Builds a short plain-text teaser for story cards on the homepage/tag/search
// pages. Pulls from the standard body text, or — for listicles, which store
// their content in listicleItems rather than body — from the first item's
// heading and body, so a listicle still gets a sensible preview whether or
// not it has its own intro text.
function getExcerptSource(post) {
  if (post.layout === 'listicle' && Array.isArray(post.listicleItems) && post.listicleItems.length > 0) {
    const first = post.listicleItems[0];
    const heading = first.heading ? `${first.heading}. ` : '';
    return `${heading}${first.body || ''}`.trim();
  }
  return post.body || '';
}

function buildExcerpt(post) {
  const source = getExcerptSource(post);
  if (!source) return '';
  // Collapse to a single line of plain text — no markup, no blank-line breaks —
  // since the excerpt is clamped visually by CSS rather than cut at a paragraph.
  return escapeHtml(source.replace(/\s+/g, ' ').trim());
}

function pickRelatedPosts(post, allPosts, limit = 3) {
  const others = allPosts.filter(p => p.id !== post.id);
  const postTags = new Set((post.tags || []).map(t => t.toLowerCase()));

  if (postTags.size > 0) {
    const scored = others
      .map(p => {
        const shared = (p.tags || []).filter(t => postTags.has(t.toLowerCase())).length;
        return { post: p, shared };
      })
      .filter(x => x.shared > 0)
      .sort((a, b) => b.shared - a.shared || new Date(b.post.createdAt) - new Date(a.post.createdAt));
    if (scored.length > 0) {
      return scored.slice(0, limit).map(x => x.post);
    }
  }

  // Fallback: just the most recent other posts (already sorted by readPosts).
  return others.slice(0, limit);
}

function renderArticle(post, allPosts = []) {
  if (!post) return null;
  const paragraphs = textToParagraphs(post.body || '');
  // Match each whole <p>...</p> block so we never cut a tag in half.
  const paraArr = paragraphs.match(/<p>[\s\S]*?<\/p>/g) || [paragraphs];
  let bodyWithMidImage = paragraphs;

  if (post.midImage && paraArr.length > 1) {
    const splitPoint = Math.ceil(paraArr.length / 2);
    const before = paraArr.slice(0, splitPoint).join('\n');
    const after = paraArr.slice(splitPoint).join('\n');
    const cap = post.midCaption ? `<figcaption class="image-caption">${escapeHtml(post.midCaption)}</figcaption>` : '';
    bodyWithMidImage = `${before}\n<figure class="mid-image"><img src="${post.midImage}" alt="${escapeHtml(post.title)}" loading="lazy">${cap}</figure>\n${after}`;
  } else if (post.midImage) {
    const cap = post.midCaption ? `<figcaption class="image-caption">${escapeHtml(post.midCaption)}</figcaption>` : '';
    bodyWithMidImage = `${paragraphs}\n<figure class="mid-image"><img src="${post.midImage}" alt="${escapeHtml(post.title)}" loading="lazy">${cap}</figure>`;
  }

  const tagsHtml = (post.tags && post.tags.length > 0) ? `
    <ul class="tag-list">
      ${post.tags.map(t => `<li><a href="/tag/${encodeURIComponent(slugify(t))}" class="tag-chip">${escapeHtml(t)}</a></li>`).join('\n')}
    </ul>
  ` : '';

  const articleUrl = `${SITE_URL}/article/${post.slug}`;
  const shareText = encodeURIComponent(post.title);
  const shareUrl = encodeURIComponent(articleUrl);
  const shareHtml = `
    <div class="share-row">
      <span class="share-label">Share:</span>
      <a class="share-link" href="https://twitter.com/intent/tweet?text=${shareText}&url=${shareUrl}" target="_blank" rel="noopener">X</a>
      <a class="share-link" href="https://www.facebook.com/sharer/sharer.php?u=${shareUrl}" target="_blank" rel="noopener">Facebook</a>
      <a class="share-link" href="https://wa.me/?text=${shareText}%20${shareUrl}" target="_blank" rel="noopener">WhatsApp</a>
    </div>
  `;

  const related = pickRelatedPosts(post, allPosts);
  const relatedHtml = related.length > 0 ? `
    <div class="related-stories">
      <h2 class="related-heading">More from The Tiny Island Times</h2>
      <ul class="related-list">
        ${related.map(p => `
          <li class="related-item">
            <a href="/article/${p.slug}">${escapeHtml(p.title)}</a>
          </li>
        `).join('\n')}
      </ul>
    </div>
  ` : '';

  const structuredData = {
    '@context': 'https://schema.org',
    '@type': 'NewsArticle',
    headline: post.title,
    description: post.dek || DEFAULT_OG_DESCRIPTION,
    datePublished: post.createdAt,
    author: { '@type': 'Person', name: post.author || 'Staff Reporter' },
    publisher: { '@type': 'Organization', name: 'The Tiny Island Times', logo: { '@type': 'ImageObject', url: `${SITE_URL}/logo.png` } },
    mainEntityOfPage: articleUrl,
    ...(post.headerImage ? { image: [post.headerImage] } : {}),
  };
  const structuredDataScript = `<script type="application/ld+json">${JSON.stringify(structuredData).replace(/<\/script/gi, '<\\/script')}</script>`;

  const headerImageHtml = post.headerImage
    ? `<figure class="article-header-figure"><img class="article-header-image" src="${post.headerImage}" alt="${escapeHtml(post.title)}">${post.headerCaption ? `<figcaption class="image-caption">${escapeHtml(post.headerCaption)}</figcaption>` : ''}</figure>`
    : '';

  let mainContentHtml;
  if (post.layout === 'listicle' && Array.isArray(post.listicleItems) && post.listicleItems.length > 0) {
    const itemsHtml = post.listicleItems.map((item, i) => {
      const imageHtml = item.image
        ? `<figure class="listicle-image"><img src="${item.image}" alt="${escapeHtml(item.heading || post.title)}" loading="lazy">${item.caption ? `<figcaption class="image-caption">${escapeHtml(item.caption)}</figcaption>` : ''}</figure>`
        : '';
      const itemBodyHtml = item.body ? textToParagraphs(item.body) : '';
      return `
        <section class="listicle-item">
          <h2 class="listicle-heading"><span class="listicle-number">${i + 1}.</span> ${escapeHtml(item.heading || '')}</h2>
          <div class="listicle-item-body">${itemBodyHtml}</div>
          ${imageHtml}
        </section>
      `;
    }).join('\n');
    mainContentHtml = `<div class="article-body listicle-wrap">${itemsHtml}</div>`;
  } else {
    mainContentHtml = `<div class="article-body">${bodyWithMidImage}</div>`;
  }

  return renderLayout(post.title, `
    <article class="wrap article-page">
      <p class="kicker">${escapeHtml(post.kicker || 'DISPATCH')}</p>
      <h1 class="article-headline">${escapeHtml(post.title)}</h1>
      <p class="article-dek">${escapeHtml(post.dek || '')}</p>
      <p class="byline">By ${escapeHtml(post.author || 'Staff Reporter')} · ${formatDate(post.createdAt)}</p>
      ${headerImageHtml}
      ${mainContentHtml}
      ${tagsHtml}
      ${shareHtml}
      <hr class="rule">
      ${relatedHtml}
      <p><a href="/">&larr; Back to the front page</a></p>
    </article>
  `, {
    ogDescription: post.dek || DEFAULT_OG_DESCRIPTION,
    ogImage: post.headerImage || DEFAULT_OG_IMAGE,
    ogUrl: articleUrl,
    ogType: 'article',
    extraHead: ANALYTICS_SCRIPT + structuredDataScript,
  });
}

// Renders a message as a sequence of words that grow larger and tilt more
// wildly as they go along, with small Union Jack flags sprinkled between
// them — used for the "something broke" error page. Deterministic (no
// Math.random) so the same message always renders the same way, just
// visually chaotic.
function renderChaosMessage(message) {
  const words = message.split(' ');
  const rotations = [-3, 4, -6, 7, -9, 11, -13, 15, -17, 19, -21, 23, -25, 27];
  const flagEvery = 3; // insert a flag after every N words

  const parts = words.map((word, i) => {
    const scale = Math.round((1 + i * 0.16) * 100) / 100; // grows steadily larger
    const rotation = rotations[i % rotations.length];
    const span = `<span class="chaos-word" style="font-size:${scale}em; transform: rotate(${rotation}deg);">${escapeHtml(word)}</span>`;
    const flag = ((i + 1) % flagEvery === 0) ? ' <span class="chaos-flag" aria-hidden="true">🇬🇧</span> ' : ' ';
    return span + flag;
  }).join('');

  return `<div class="chaos-message" role="alert" aria-label="${escapeHtml(message)}">${parts}</div>`;
}

function renderRssFeed(posts) {
  const items = posts.slice(0, 20).map(post => {
    const link = `${SITE_URL}/article/${post.slug}`;
    const description = post.dek || (post.body || '').slice(0, 280);
    return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${link}</link>
      <guid isPermaLink="true">${link}</guid>
      <pubDate>${formatRssDate(post.createdAt)}</pubDate>
      <description>${escapeXml(description)}</description>
      ${(post.tags || []).map(t => `<category>${escapeXml(t)}</category>`).join('\n      ')}
    </item>`;
  }).join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0">
  <channel>
    <title>The Tiny Island Times</title>
    <link>${SITE_URL}</link>
    <description>The Truthiest News Around.</description>
    <language>en-gb</language>
    ${items}
  </channel>
</rss>`;
}

function renderSitemap(posts) {
  const uniqueTagSlugs = new Set();
  posts.forEach(post => (post.tags || []).forEach(t => uniqueTagSlugs.add(slugify(t))));

  const urls = [
    `<url><loc>${SITE_URL}/</loc><changefreq>daily</changefreq></url>`,
    ...posts.map(post => `<url><loc>${SITE_URL}/article/${post.slug}</loc><lastmod>${new Date(post.createdAt).toISOString().slice(0, 10)}</lastmod></url>`),
    ...Array.from(uniqueTagSlugs).map(slug => `<url><loc>${SITE_URL}/tag/${slug}</loc></url>`),
  ].join('\n  ');

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
  ${urls}
</urlset>`;
}

function renderLogin(error) {
  return renderLayout('Admin login', `
    <div class="wrap admin-wrap">
      <p class="kicker">STAFF ONLY</p>
      <h1>Admin login</h1>
      ${error ? `<p class="error-msg">${escapeHtml(error)}</p>` : ''}
      <form method="POST" action="/admin/login" class="admin-form">
        <label for="password">Password</label>
        <input type="password" id="password" name="password" autofocus required>
        <button type="submit" class="btn-primary">Log in</button>
      </form>
    </div>
  `);
}

function renderAdmin(posts, message, errorMessage) {
  const postRows = posts.map(post => `
    <li class="admin-post-row">
      <a href="/article/${post.slug}" target="_blank" class="admin-post-title">${escapeHtml(post.title)}</a>
      <span class="admin-post-date">${formatDate(post.createdAt)}</span>
      <a href="/admin/edit/${post.id}" class="btn-edit">Edit</a>
      <form method="POST" action="/admin/delete/${post.id}" class="inline-form" onsubmit="return confirm('Delete this story for good?');">
        <button type="submit" class="btn-delete">Delete</button>
      </form>
    </li>
  `).join('\n');

  return renderLayout('Admin', `
    <div class="wrap admin-wrap">
      <p class="kicker">STAFF ONLY</p>
      <nav class="admin-tabs">
        <a href="/admin" class="admin-tab admin-tab-active">Standard article</a>
        <a href="/admin/listicle" class="admin-tab">Listicle</a>
      </nav>
      <h1>Publish a new story</h1>
      ${message ? `<p class="success-msg">${escapeHtml(message)}</p>` : ''}
      ${errorMessage ? `<p class="error-msg">${escapeHtml(errorMessage)}</p>` : ''}

      <form method="POST" action="/admin/publish" enctype="multipart/form-data" class="admin-form" id="publish-form">
        <p class="draft-status" id="draft-status" hidden></p>

        <label for="title">Headline</label>
        <input type="text" id="title" name="title" required placeholder="e.g. Westminster Confirms It Has No Idea Either">

        <label for="kicker">Kicker (small tag above headline, optional)</label>
        <input type="text" id="kicker" name="kicker" placeholder="e.g. EXCLUSIVE / WESTMINSTER / BREAKING">

        <label for="dek">Sub-headline (one line, optional)</label>
        <input type="text" id="dek" name="dek" placeholder="A short line that sets up the joke">

        <label for="author">Byline (optional)</label>
        <input type="text" id="author" name="author" placeholder="Staff Reporter">

        <label for="tags">Tags (optional, separate with commas)</label>
        <input type="text" id="tags" name="tags" placeholder="e.g. Politics, Royals, Westminster">

        <label for="body">Story text</label>
        <textarea id="body" name="body" rows="14" required placeholder="Paste your Freewrite text here. Leave a blank line between paragraphs."></textarea>

        <label for="headerImage">Header image (optional)</label>
        <input type="file" id="headerImage" name="headerImage" accept="image/*">
        <label for="headerCaption" class="caption-label">Image subheading (optional, shown in italics under the image)</label>
        <input type="text" id="headerCaption" name="headerCaption" placeholder="e.g. The Prime Minister, yesterday">

        <label for="midImage">Mid-article image (optional)</label>
        <input type="file" id="midImage" name="midImage" accept="image/*">
        <label for="midCaption" class="caption-label">Image subheading (optional, shown in italics under the image)</label>
        <input type="text" id="midCaption" name="midCaption" placeholder="e.g. An air fryer, earlier">

        <button type="submit" class="btn-primary btn-large">Publish</button>
      </form>

      <script>
        (function() {
          var DRAFT_KEY = 'tinyislandtimes-draft-new-post';
          var fieldIds = ['title', 'kicker', 'dek', 'author', 'tags', 'body', 'headerCaption', 'midCaption'];
          var form = document.getElementById('publish-form');
          var statusEl = document.getElementById('draft-status');

          function showStatus(text) {
            statusEl.textContent = text;
            statusEl.hidden = false;
          }

          function saveDraft() {
            var draft = {};
            fieldIds.forEach(function(id) {
              var el = document.getElementById(id);
              if (el) draft[id] = el.value;
            });
            try {
              localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
            } catch (e) { /* storage unavailable, fail silently */ }
          }

          function clearDraft() {
            try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
          }

          function restoreDraft() {
            var raw;
            try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return; }
            if (!raw) return;
            var draft;
            try { draft = JSON.parse(raw); } catch (e) { return; }
            var hasContent = false;
            fieldIds.forEach(function(id) {
              var el = document.getElementById(id);
              if (el && draft[id]) {
                el.value = draft[id];
                hasContent = true;
              }
            });
            if (hasContent) {
              showStatus('Restored an unsaved draft from this device. Check it over before publishing.');
            }
          }

          restoreDraft();

          fieldIds.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('input', saveDraft);
          });

          ${message ? 'clearDraft();' : ''}
        })();
      </script>

      <hr class="rule">

      <h2>Published stories</h2>
      ${posts.length === 0 ? '<p>Nothing published yet.</p>' : `<ul class="admin-post-list">${postRows}</ul>`}

      <p><a href="/admin/logout">Log out</a></p>
    </div>
  `);
}

function renderListicleForm(message, errorMessage, post) {
  const isEdit = !!post;
  const action = isEdit ? `/admin/edit-listicle/${post.id}` : '/admin/publish-listicle';
  const items = isEdit && Array.isArray(post.listicleItems) ? post.listicleItems : [];

  // When editing, render existing items server-side so their current image URLs
  // travel with the form (as hidden fields) and can be kept if not replaced.
  const existingItemsHtml = items.map((item, i) => `
    <div class="listicle-item-block">
      <div class="listicle-item-head">
        <span class="listicle-item-num">Item <span class="num-label">${i + 1}</span></span>
        <button type="button" class="btn-remove-item">Remove</button>
      </div>
      <label>Item heading</label>
      <input type="text" class="item-heading" name="item_${i}_heading" value="${escapeHtml(item.heading || '')}">
      <label>Item body text</label>
      <textarea class="item-body" name="item_${i}_body" rows="4">${escapeHtml(item.body || '')}</textarea>
      <label>Item image (optional)</label>
      ${item.image ? `<p class="current-image-note">Current: <a href="${item.image}" target="_blank">view image</a>. Choose a new file to replace it, leave blank to keep it, or tick remove.</p><label class="remove-image-label"><input type="checkbox" class="item-remove-image" name="item_${i}_removeImage" value="1"> Remove current image</label>` : ''}
      <input type="hidden" class="item-existing-image" name="item_${i}_existingImage" value="${escapeHtml(item.image || '')}">
      <input type="file" class="item-image" name="item_${i}_image" accept="image/*">
      <label class="caption-label">Image subheading (optional, shown in italics under the image)</label>
      <input type="text" class="item-caption" name="item_${i}_caption" value="${escapeHtml(item.caption || '')}">
    </div>
  `).join('\n');

  const headerImageNote = (isEdit && post.headerImage)
    ? `<p class="current-image-note">Current: <a href="${post.headerImage}" target="_blank">view image</a>. Choose a new file to replace it, leave blank to keep it, or tick remove.</p><label class="remove-image-label"><input type="checkbox" name="removeHeaderImage" value="1"> Remove current header image</label>`
    : '';

  return renderLayout(isEdit ? 'Edit listicle' : 'New listicle', `
    <div class="wrap admin-wrap">
      <p class="kicker">STAFF ONLY</p>
      <nav class="admin-tabs">
        <a href="/admin" class="admin-tab">Standard article</a>
        <a href="/admin/listicle" class="admin-tab${isEdit ? '' : ' admin-tab-active'}">Listicle</a>
      </nav>
      <h1>${isEdit ? 'Edit listicle' : 'Publish a listicle'}</h1>
      ${isEdit ? '' : '<p class="listicle-intro">For ranked or numbered articles — each item gets a heading, body text, and an optional image with its own subheading. Add as many items as you like. (e.g. "14 Cake Flavours That Would Suck".)</p>'}
      ${message ? `<p class="success-msg">${escapeHtml(message)}</p>` : ''}
      ${errorMessage ? `<p class="error-msg">${escapeHtml(errorMessage)}</p>` : ''}

      <form method="POST" action="${action}" enctype="multipart/form-data" class="admin-form" id="listicle-form">
        <p class="draft-status" id="draft-status" hidden></p>

        <label for="title">Headline</label>
        <input type="text" id="title" name="title" required placeholder="e.g. 14 Cake Flavours That Would Suck" value="${isEdit ? escapeHtml(post.title) : ''}">

        <label for="kicker">Kicker (small tag above headline, optional)</label>
        <input type="text" id="kicker" name="kicker" placeholder="e.g. RANKED / HOT TAKE" value="${isEdit ? escapeHtml(post.kicker || '') : ''}">

        <label for="dek">Sub-headline (one line, optional)</label>
        <input type="text" id="dek" name="dek" placeholder="A short line that sets up the joke" value="${isEdit ? escapeHtml(post.dek || '') : ''}">

        <label for="author">Byline (optional)</label>
        <input type="text" id="author" name="author" placeholder="Staff Reporter" value="${isEdit ? escapeHtml(post.author || '') : ''}">

        <label for="tags">Tags (optional, separate with commas)</label>
        <input type="text" id="tags" name="tags" placeholder="e.g. Food, Opinion" value="${isEdit ? escapeHtml((post.tags || []).join(', ')) : ''}">

        <label for="headerImage">Header image (optional)</label>
        ${headerImageNote}
        <input type="file" id="headerImage" name="headerImage" accept="image/*">
        <label for="headerCaption" class="caption-label">Image subheading (optional, shown in italics under the image)</label>
        <input type="text" id="headerCaption" name="headerCaption" placeholder="e.g. A cake, unfortunately" value="${isEdit ? escapeHtml(post.headerCaption || '') : ''}">

        <hr class="rule">
        <h2>List items</h2>

        <div id="listicle-items">${existingItemsHtml}</div>

        <input type="hidden" id="itemCount" name="itemCount" value="${items.length}">
        <button type="button" class="btn-secondary" id="add-item-btn">+ Add another item</button>

        <button type="submit" class="btn-primary btn-large">${isEdit ? 'Save changes' : 'Publish listicle'}</button>
      </form>

      <template id="item-template">
        <div class="listicle-item-block">
          <div class="listicle-item-head">
            <span class="listicle-item-num">Item <span class="num-label"></span></span>
            <button type="button" class="btn-remove-item">Remove</button>
          </div>
          <label>Item heading</label>
          <input type="text" class="item-heading" placeholder="e.g. Wet Cardboard Surprise">
          <label>Item body text</label>
          <textarea class="item-body" rows="4" placeholder="Why this cake flavour would suck. Leave a blank line between paragraphs."></textarea>
          <label>Item image (optional)</label>
          <input type="file" class="item-image" accept="image/*">
          <label class="caption-label">Image subheading (optional, shown in italics under the image)</label>
          <input type="text" class="item-caption" placeholder="e.g. The offending bake">
        </div>
      </template>

      <hr class="rule">
      <p>${isEdit ? '<a href="/admin">&larr; Back without saving</a>' : '<a href="/admin/logout">Log out</a>'}</p>

      <script>
        (function() {
          var IS_EDIT = ${isEdit ? 'true' : 'false'};
          var DRAFT_KEY = ${isEdit ? `'tinyislandtimes-draft-listicle-edit-${post.id}'` : `'tinyislandtimes-draft-listicle'`};
          var topFields = ['title', 'kicker', 'dek', 'author', 'tags', 'headerCaption'];
          var container = document.getElementById('listicle-items');
          var template = document.getElementById('item-template');
          var countInput = document.getElementById('itemCount');
          var form = document.getElementById('listicle-form');
          var statusEl = document.getElementById('draft-status');

          function showStatus(text) {
            statusEl.textContent = text;
            statusEl.hidden = false;
          }

          // Renumber items visually and assign correct field names for submission.
          // Existing items carry hidden "existingImage" / remove-checkbox fields that
          // must be renamed in lockstep so the server reads them per-index.
          function renumber() {
            var blocks = container.querySelectorAll('.listicle-item-block');
            blocks.forEach(function(block, i) {
              block.querySelector('.num-label').textContent = (i + 1);
              block.querySelector('.item-heading').name = 'item_' + i + '_heading';
              block.querySelector('.item-body').name = 'item_' + i + '_body';
              block.querySelector('.item-image').name = 'item_' + i + '_image';
              block.querySelector('.item-caption').name = 'item_' + i + '_caption';
              var existing = block.querySelector('.item-existing-image');
              if (existing) existing.name = 'item_' + i + '_existingImage';
              var removeChk = block.querySelector('.item-remove-image');
              if (removeChk) removeChk.name = 'item_' + i + '_removeImage';
            });
            countInput.value = blocks.length;
          }

          function wireBlock(block) {
            block.querySelector('.btn-remove-item').addEventListener('click', function() {
              block.remove();
              renumber();
              saveDraft();
            });
            ['.item-heading', '.item-body', '.item-caption'].forEach(function(sel) {
              var el = block.querySelector(sel);
              if (el) el.addEventListener('input', saveDraft);
            });
          }

          function addItem(values) {
            var clone = template.content.firstElementChild.cloneNode(true);
            if (values) {
              clone.querySelector('.item-heading').value = values.heading || '';
              clone.querySelector('.item-body').value = values.body || '';
              clone.querySelector('.item-caption').value = values.caption || '';
            }
            container.appendChild(clone);
            wireBlock(clone);
            renumber();
          }

          function saveDraft() {
            // In edit mode we don't persist drafts to localStorage — the form is already
            // server-pre-filled from the saved post, and stale drafts would fight that.
            if (IS_EDIT) return;
            var draft = { top: {}, items: [] };
            topFields.forEach(function(id) {
              var el = document.getElementById(id);
              if (el) draft.top[id] = el.value;
            });
            container.querySelectorAll('.listicle-item-block').forEach(function(block) {
              draft.items.push({
                heading: block.querySelector('.item-heading').value,
                body: block.querySelector('.item-body').value,
                caption: block.querySelector('.item-caption').value
              });
            });
            try { localStorage.setItem(DRAFT_KEY, JSON.stringify(draft)); } catch (e) {}
          }

          function clearDraft() {
            try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
          }

          function restoreDraft() {
            if (IS_EDIT) return false;
            var raw;
            try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return false; }
            if (!raw) return false;
            var draft;
            try { draft = JSON.parse(raw); } catch (e) { return false; }
            var hasContent = false;
            if (draft.top) {
              topFields.forEach(function(id) {
                var el = document.getElementById(id);
                if (el && draft.top[id]) { el.value = draft.top[id]; hasContent = true; }
              });
            }
            if (draft.items && draft.items.length) {
              draft.items.forEach(function(item) {
                addItem(item);
                if (item.heading || item.body || item.caption) hasContent = true;
              });
            }
            return hasContent;
          }

          // Wire any server-rendered existing item blocks (edit mode).
          container.querySelectorAll('.listicle-item-block').forEach(wireBlock);

          document.getElementById('add-item-btn').addEventListener('click', function() {
            addItem();
            saveDraft();
          });

          topFields.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('input', saveDraft);
          });

          if (!IS_EDIT) {
            // On load (create mode): restore a saved draft if present, otherwise start with one empty item.
            var restored = restoreDraft();
            if (restored) {
              showStatus('Restored an unsaved listicle draft from this device. Check it over before publishing. (Item images need to be re-attached.)');
            }
            if (container.querySelectorAll('.listicle-item-block').length === 0) {
              addItem();
            }
          }

          ${message ? 'clearDraft();' : ''}
        })();
      </script>
    </div>
  `);
}

function renderEditForm(post, errorMessage) {
  return renderLayout('Edit story', `
    <div class="wrap admin-wrap">
      <p class="kicker">STAFF ONLY</p>
      <h1>Edit story</h1>
      ${errorMessage ? `<p class="error-msg">${escapeHtml(errorMessage)}</p>` : ''}

      <form method="POST" action="/admin/edit/${post.id}" enctype="multipart/form-data" class="admin-form" id="edit-form">
        <p class="draft-status" id="draft-status" hidden></p>

        <label for="title">Headline</label>
        <input type="text" id="title" name="title" required value="${escapeHtml(post.title)}">

        <label for="kicker">Kicker (small tag above headline, optional)</label>
        <input type="text" id="kicker" name="kicker" value="${escapeHtml(post.kicker || '')}">

        <label for="dek">Sub-headline (one line, optional)</label>
        <input type="text" id="dek" name="dek" value="${escapeHtml(post.dek || '')}">

        <label for="author">Byline (optional)</label>
        <input type="text" id="author" name="author" value="${escapeHtml(post.author || '')}">

        <label for="tags">Tags (optional, separate with commas)</label>
        <input type="text" id="tags" name="tags" value="${escapeHtml((post.tags || []).join(', '))}">

        <label for="body">Story text</label>
        <textarea id="body" name="body" rows="14" required>${escapeHtml(post.body)}</textarea>

        <label for="headerImage">Header image</label>
        ${post.headerImage ? `<p class="current-image-note">Current: <a href="${post.headerImage}" target="_blank">view image</a>. Choose a new file below to replace it, or leave blank to keep it.</p>` : ''}
        <input type="file" id="headerImage" name="headerImage" accept="image/*">
        <label for="headerCaption" class="caption-label">Image subheading (optional, shown in italics under the image)</label>
        <input type="text" id="headerCaption" name="headerCaption" value="${escapeHtml(post.headerCaption || '')}">

        <label for="midImage">Mid-article image</label>
        ${post.midImage ? `<p class="current-image-note">Current: <a href="${post.midImage}" target="_blank">view image</a>. Choose a new file below to replace it, or leave blank to keep it.</p>` : ''}
        <input type="file" id="midImage" name="midImage" accept="image/*">
        <label for="midCaption" class="caption-label">Image subheading (optional, shown in italics under the image)</label>
        <input type="text" id="midCaption" name="midCaption" value="${escapeHtml(post.midCaption || '')}">

        <button type="submit" class="btn-primary btn-large">Save changes</button>
      </form>

      <script>
        (function() {
          var DRAFT_KEY = 'tinyislandtimes-draft-edit-${post.id}';
          var fieldIds = ['title', 'kicker', 'dek', 'author', 'tags', 'body', 'headerCaption', 'midCaption'];
          var statusEl = document.getElementById('draft-status');
          var savedValues = {
            title: ${JSON.stringify(post.title)},
            kicker: ${JSON.stringify(post.kicker || '')},
            dek: ${JSON.stringify(post.dek || '')},
            author: ${JSON.stringify(post.author || '')},
            tags: ${JSON.stringify((post.tags || []).join(', '))},
            body: ${JSON.stringify(post.body)},
            headerCaption: ${JSON.stringify(post.headerCaption || '')},
            midCaption: ${JSON.stringify(post.midCaption || '')}
          };

          function showStatus(text) {
            statusEl.textContent = text;
            statusEl.hidden = false;
          }

          function saveDraft() {
            var draft = {};
            fieldIds.forEach(function(id) {
              var el = document.getElementById(id);
              if (el) draft[id] = el.value;
            });
            try {
              localStorage.setItem(DRAFT_KEY, JSON.stringify(draft));
            } catch (e) {}
          }

          function clearDraft() {
            try { localStorage.removeItem(DRAFT_KEY); } catch (e) {}
          }

          function restoreDraft() {
            var raw;
            try { raw = localStorage.getItem(DRAFT_KEY); } catch (e) { return; }
            if (!raw) return;
            var draft;
            try { draft = JSON.parse(raw); } catch (e) { return; }
            function normalize(s) { return (s || '').replace(/\\r\\n/g, '\\n'); }
            var hasUnsavedChanges = false;
            fieldIds.forEach(function(id) {
              if (draft[id] !== undefined && normalize(draft[id]) !== normalize(savedValues[id])) {
                hasUnsavedChanges = true;
              }
            });
            if (hasUnsavedChanges) {
              fieldIds.forEach(function(id) {
                var el = document.getElementById(id);
                if (el && draft[id] !== undefined) el.value = draft[id];
              });
              showStatus('Restored unsaved edits from this device. Check them over before saving.');
            } else {
              clearDraft();
            }
          }

          restoreDraft();

          fieldIds.forEach(function(id) {
            var el = document.getElementById(id);
            if (el) el.addEventListener('input', saveDraft);
          });
        })();
      </script>

      <hr class="rule">

      <p><a href="/admin">&larr; Back without saving</a></p>
    </div>
  `);
}

// --- Route handlers ---

async function handlePublish(req, res) {
  parseMultipart(req, async (err, result) => {
    if (err) {
      const message = err.message.includes('too large')
        ? 'That upload was too large. Each photo should be under about 15MB combined — try a smaller image.'
        : 'Something went wrong reading the form. Please try again.';
      return sendHtml(res, 400, renderAdmin(await readPosts(), null, message));
    }
    const { fields, files } = result;
    const title = (fields.title || '').trim();
    const body = (fields.body || '').replace(/\r\n/g, '\n').trim();

    if (!title || !body) {
      return sendHtml(res, 400, renderAdmin(await readPosts(), null, 'Headline and story text are both required.'));
    }

    try {
      const headerImage = files.headerImage ? await saveUploadedFile(files.headerImage) : null;
      const midImage = files.midImage ? await saveUploadedFile(files.midImage) : null;

      const baseSlug = slugify(title);
      let slug = baseSlug;
      let counter = 2;
      while (await slugExists(slug)) {
        slug = `${baseSlug}-${counter}`;
        counter++;
      }

      const newPost = {
        id: crypto.randomBytes(6).toString('hex'),
        slug,
        title,
        kicker: (fields.kicker || '').trim(),
        dek: (fields.dek || '').trim(),
        author: (fields.author || '').trim() || 'Staff Reporter',
        tags: parseTags(fields.tags),
        body,
        headerImage,
        headerCaption: (fields.headerCaption || '').trim(),
        midImage,
        midCaption: (fields.midCaption || '').trim(),
        layout: 'standard',
        listicleItems: [],
        createdAt: new Date().toISOString(),
      };

      await insertPost(newPost);
      const posts = await readPosts();
      sendHtml(res, 200, renderAdmin(posts, `Published: "${title}"`));
    } catch (e) {
      console.error('Publish failed:', e);
      const posts = await readPosts();
      sendHtml(res, 500, renderAdmin(posts, null, 'Publishing failed — there may be a connection problem with storage. Your story was not saved; please try again in a moment.'));
    }
  });
}

async function handlePublishListicle(req, res) {
  parseMultipart(req, async (err, result) => {
    if (err) {
      const message = err.message.includes('too large')
        ? 'That upload was too large. Keep total images under about 40MB — try smaller photos.'
        : 'Something went wrong reading the form. Please try again.';
      return sendHtml(res, 400, renderListicleForm(null, message));
    }

    const { fields, files } = result;
    const title = (fields.title || '').trim();
    const itemCount = parseInt(fields.itemCount, 10) || 0;

    if (!title) {
      return sendHtml(res, 400, renderListicleForm(null, 'A headline is required.'));
    }
    if (itemCount < 1) {
      return sendHtml(res, 400, renderListicleForm(null, 'A listicle needs at least one item.'));
    }

    // Gather items first (without uploading) so we can validate before touching storage.
    const rawItems = [];
    for (let i = 0; i < itemCount; i++) {
      const heading = (fields[`item_${i}_heading`] || '').trim();
      const itemBody = (fields[`item_${i}_body`] || '').replace(/\r\n/g, '\n').trim();
      const caption = (fields[`item_${i}_caption`] || '').trim();
      const imageFile = files[`item_${i}_image`];
      // Skip an item only if it's entirely empty (no heading, body, or image).
      if (!heading && !itemBody && !(imageFile && imageFile.data && imageFile.data.length > 0)) continue;
      rawItems.push({ heading, body: itemBody, caption, imageFile });
    }

    if (rawItems.length === 0) {
      return sendHtml(res, 400, renderListicleForm(null, 'Every item was empty — add a heading or body text to at least one.'));
    }

    try {
      const headerImage = files.headerImage ? await saveUploadedFile(files.headerImage) : null;

      const listicleItems = [];
      for (const item of rawItems) {
        const image = (item.imageFile && item.imageFile.data && item.imageFile.data.length > 0)
          ? await saveUploadedFile(item.imageFile)
          : null;
        listicleItems.push({
          heading: item.heading,
          body: item.body,
          caption: item.caption,
          image,
        });
      }

      const baseSlug = slugify(title);
      let slug = baseSlug;
      let counter = 2;
      while (await slugExists(slug)) {
        slug = `${baseSlug}-${counter}`;
        counter++;
      }

      const newPost = {
        id: crypto.randomBytes(6).toString('hex'),
        slug,
        title,
        kicker: (fields.kicker || '').trim(),
        dek: (fields.dek || '').trim(),
        author: (fields.author || '').trim() || 'Staff Reporter',
        tags: parseTags(fields.tags),
        body: '', // listicles store content in listicleItems, not body
        headerImage,
        headerCaption: (fields.headerCaption || '').trim(),
        midImage: null,
        midCaption: '',
        layout: 'listicle',
        listicleItems,
        createdAt: new Date().toISOString(),
      };

      await insertPost(newPost);
      const posts = await readPosts();
      sendHtml(res, 200, renderAdmin(posts, `Published listicle: "${title}"`));
    } catch (e) {
      console.error('Listicle publish failed:', e);
      sendHtml(res, 500, renderListicleForm(null, 'Publishing failed — there may be a connection problem with storage. Your listicle was not saved; please try again in a moment.'));
    }
  }, 60 * 1024 * 1024);
}

async function handleListicleEditSubmit(req, res, id) {
  parseMultipart(req, async (err, result) => {
    const existing = await findPostById(id);
    if (!existing) return sendNotFound(res);

    if (err) {
      const message = err.message.includes('too large')
        ? 'That upload was too large. Keep total images under about 40MB — try smaller photos.'
        : 'Something went wrong reading the form. Please try again.';
      return sendHtml(res, 400, renderListicleForm(null, message, existing));
    }

    const { fields, files } = result;
    const title = (fields.title || '').trim();
    const itemCount = parseInt(fields.itemCount, 10) || 0;

    if (!title) {
      return sendHtml(res, 400, renderListicleForm(null, 'A headline is required.', existing));
    }
    if (itemCount < 1) {
      return sendHtml(res, 400, renderListicleForm(null, 'A listicle needs at least one item.', existing));
    }

    // Collect each item, resolving its image: a newly uploaded file wins; otherwise
    // keep the carried-over existing image unless the remove box was ticked.
    const rawItems = [];
    for (let i = 0; i < itemCount; i++) {
      const heading = (fields[`item_${i}_heading`] || '').trim();
      const itemBody = (fields[`item_${i}_body`] || '').replace(/\r\n/g, '\n').trim();
      const caption = (fields[`item_${i}_caption`] || '').trim();
      const existingImage = (fields[`item_${i}_existingImage`] || '').trim();
      const removeImage = fields[`item_${i}_removeImage`] === '1';
      const imageFile = files[`item_${i}_image`];
      const hasNewImage = imageFile && imageFile.data && imageFile.data.length > 0;
      // Skip only if entirely empty (no text and no image of any kind).
      if (!heading && !itemBody && !hasNewImage && !(existingImage && !removeImage)) continue;
      rawItems.push({ heading, body: itemBody, caption, existingImage, removeImage, imageFile, hasNewImage });
    }

    if (rawItems.length === 0) {
      return sendHtml(res, 400, renderListicleForm(null, 'Every item was empty — add a heading or body text to at least one.', existing));
    }

    try {
      // Header image: new upload replaces, remove box clears, otherwise keep.
      let headerImage = existing.headerImage;
      if (files.headerImage && files.headerImage.data.length > 0) {
        headerImage = await saveUploadedFile(files.headerImage);
      } else if (fields.removeHeaderImage === '1') {
        headerImage = null;
      }

      const listicleItems = [];
      for (const item of rawItems) {
        let image;
        if (item.hasNewImage) {
          image = await saveUploadedFile(item.imageFile);
        } else if (item.removeImage) {
          image = null;
        } else {
          image = item.existingImage || null;
        }
        listicleItems.push({
          heading: item.heading,
          body: item.body,
          caption: item.caption,
          image,
        });
      }

      const updated = {
        ...existing,
        title,
        kicker: (fields.kicker || '').trim(),
        dek: (fields.dek || '').trim(),
        author: (fields.author || '').trim() || 'Staff Reporter',
        tags: parseTags(fields.tags),
        body: '',
        headerImage,
        headerCaption: (fields.headerCaption || '').trim(),
        midImage: null,
        midCaption: '',
        layout: 'listicle',
        listicleItems,
        // slug and createdAt deliberately unchanged, so existing links and order stay stable
      };

      await updatePost(id, updated);
      const posts = await readPosts();
      sendHtml(res, 200, renderAdmin(posts, `Updated listicle: "${title}"`));
    } catch (e) {
      console.error('Listicle edit failed:', e);
      sendHtml(res, 500, renderListicleForm(null, 'Saving failed — there may be a connection problem with storage. Please try again in a moment.', existing));
    }
  }, 60 * 1024 * 1024);
}

async function handleEditSubmit(req, res, id) {
  parseMultipart(req, async (err, result) => {
    if (err) {
      const message = err.message.includes('too large')
        ? 'That upload was too large. Each photo should be under about 15MB combined — try a smaller image.'
        : 'Something went wrong reading the form. Please try again.';
      const existing = await findPostById(id);
      if (!existing) return sendNotFound(res);
      return sendHtml(res, 400, renderEditForm(existing, message));
    }

    const existing = await findPostById(id);
    if (!existing) return sendNotFound(res);

    const { fields, files } = result;
    const title = (fields.title || '').trim();
    const body = (fields.body || '').replace(/\r\n/g, '\n').trim();

    if (!title || !body) {
      return sendHtml(res, 400, renderEditForm(existing, 'Headline and story text are both required.'));
    }

    try {
      // Only replace an image if a new file was actually chosen; otherwise keep the existing one.
      const headerImage = (files.headerImage && files.headerImage.data.length > 0)
        ? await saveUploadedFile(files.headerImage)
        : existing.headerImage;
      const midImage = (files.midImage && files.midImage.data.length > 0)
        ? await saveUploadedFile(files.midImage)
        : existing.midImage;

      const updated = {
        ...existing,
        title,
        kicker: (fields.kicker || '').trim(),
        dek: (fields.dek || '').trim(),
        author: (fields.author || '').trim() || 'Staff Reporter',
        tags: parseTags(fields.tags),
        body,
        headerImage,
        headerCaption: (fields.headerCaption || '').trim(),
        midImage,
        midCaption: (fields.midCaption || '').trim(),
        // slug and createdAt deliberately unchanged, so existing links and publish order both stay stable
      };

      await updatePost(id, updated);
      const posts = await readPosts();
      sendHtml(res, 200, renderAdmin(posts, `Updated: "${title}"`));
    } catch (e) {
      console.error('Edit failed:', e);
      sendHtml(res, 500, renderEditForm(existing, 'Saving failed — there may be a connection problem with storage. Please try again in a moment.'));
    }
  });
}

async function handleDelete(req, res, id) {
  try {
    await deletePostById(id);
  } catch (e) {
    console.error('Delete failed:', e);
  }
  res.writeHead(302, { Location: '/admin' });
  res.end();
}

// --- Server ---

const server = http.createServer(async (req, res) => {
  try {
    const parsedUrl = url.parse(req.url, true);
    const pathname = decodeURIComponent(parsedUrl.pathname);

    // Static assets
    if (pathname === '/style.css') {
      return serveStaticFile(res, path.join(ROOT, 'style.css'), 'text/css');
    }

    if (pathname === '/og-default.png') {
      return serveStaticFile(res, path.join(ROOT, 'og-default.png'), 'image/png');
    }

    if (pathname === '/logo.png') {
      return serveStaticFile(res, path.join(ROOT, 'logo.png'), 'image/png');
    }

    if (pathname === '/favicon.ico') {
      return serveStaticFile(res, path.join(ROOT, 'favicon.ico'), 'image/x-icon');
    }

    if (pathname === '/favicon-180.png') {
      return serveStaticFile(res, path.join(ROOT, 'favicon-180.png'), 'image/png');
    }

    // Public homepage
    if (pathname === '/' && req.method === 'GET') {
      const posts = await readPosts();
      const page = parseInt(parsedUrl.query.page, 10) || 1;
      return sendHtml(res, 200, renderHomepage(posts, page));
    }

    // RSS feed
    if (pathname === '/rss.xml' && req.method === 'GET') {
      const posts = await readPosts();
      return sendXml(res, 200, renderRssFeed(posts));
    }

    // robots.txt — point crawlers at the sitemap, keep /admin out of the index
    if (pathname === '/robots.txt' && req.method === 'GET') {
      res.writeHead(200, { 'Content-Type': 'text/plain; charset=utf-8' });
      return res.end(`User-agent: *\nDisallow: /admin\nSitemap: ${SITE_URL}/sitemap.xml\n`);
    }

    // sitemap.xml — homepage plus every published article
    if (pathname === '/sitemap.xml' && req.method === 'GET') {
      const posts = await readPosts();
      return sendXmlGeneric(res, 200, renderSitemap(posts));
    }

    // Search
    if (pathname === '/search' && req.method === 'GET') {
      const query = (parsedUrl.query.q || '').toString();
      const allPosts = await readPosts();
      const results = searchPosts(allPosts, query);
      const page = parseInt(parsedUrl.query.page, 10) || 1;
      return sendHtml(res, 200, renderSearchPage(query, results, page));
    }

    // Tag browse page
    if (pathname.startsWith('/tag/') && req.method === 'GET') {
      const tagSlug = decodeURIComponent(pathname.replace('/tag/', ''));
      const allPosts = await readPosts();
      const matchingPosts = allPosts.filter(post =>
        (post.tags || []).some(t => slugify(t) === tagSlug)
      );
      if (matchingPosts.length === 0) return sendNotFound(res);
      // Use the original-cased tag text from the first matching post for display
      const displayTag = matchingPosts[0].tags.find(t => slugify(t) === tagSlug);
      const page = parseInt(parsedUrl.query.page, 10) || 1;
      return sendHtml(res, 200, renderTagPage(displayTag, matchingPosts, page));
    }

    // Article page
    if (pathname.startsWith('/article/') && req.method === 'GET') {
      const slug = pathname.replace('/article/', '');
      const post = await findPostBySlug(slug);
      if (!post) return sendNotFound(res);
      const allPosts = await readPosts();
      return sendHtml(res, 200, renderArticle(post, allPosts));
    }

    // Admin login page
    if (pathname === '/admin/login' && req.method === 'GET') {
      return sendHtml(res, 200, renderLogin(null));
    }

    if (pathname === '/admin/login' && req.method === 'POST') {
      return parseBodyUrlEncoded(req, (err, result) => {
        const { fields } = result;
        if (safeCompare(fields.password || '', ADMIN_PASSWORD)) {
          res.writeHead(302, {
            Location: '/admin',
            'Set-Cookie': `session=${VALID_SESSION_TOKEN}; HttpOnly; Path=/; Max-Age=2592000`,
          });
          return res.end();
        }
        return sendHtml(res, 401, renderLogin('Incorrect password.'));
      });
    }

    if (pathname === '/admin/logout') {
      res.writeHead(302, {
        Location: '/',
        'Set-Cookie': 'session=; HttpOnly; Path=/; Max-Age=0',
      });
      return res.end();
    }

    // Everything else under /admin requires auth
    if (pathname.startsWith('/admin')) {
      if (!isAuthed(req)) {
        res.writeHead(302, { Location: '/admin/login' });
        return res.end();
      }

      if (pathname === '/admin' && req.method === 'GET') {
        const posts = await readPosts();
        return sendHtml(res, 200, renderAdmin(posts, null));
      }

      if (pathname === '/admin/publish' && req.method === 'POST') {
        return handlePublish(req, res);
      }

      if (pathname === '/admin/listicle' && req.method === 'GET') {
        return sendHtml(res, 200, renderListicleForm(null, null));
      }

      if (pathname === '/admin/publish-listicle' && req.method === 'POST') {
        return handlePublishListicle(req, res);
      }

      if (pathname.startsWith('/admin/edit/') && req.method === 'GET') {
        const id = pathname.replace('/admin/edit/', '');
        const post = await findPostById(id);
        if (!post) return sendNotFound(res);
        // Listicles open in the listicle form; standard posts in the standard editor.
        if (post.layout === 'listicle') {
          return sendHtml(res, 200, renderListicleForm(null, null, post));
        }
        return sendHtml(res, 200, renderEditForm(post, null));
      }

      if (pathname.startsWith('/admin/edit/') && req.method === 'POST') {
        const id = pathname.replace('/admin/edit/', '');
        return handleEditSubmit(req, res, id);
      }

      if (pathname.startsWith('/admin/edit-listicle/') && req.method === 'POST') {
        const id = pathname.replace('/admin/edit-listicle/', '');
        return handleListicleEditSubmit(req, res, id);
      }

      if (pathname.startsWith('/admin/delete/') && req.method === 'POST') {
        const id = pathname.replace('/admin/delete/', '');
        return handleDelete(req, res, id);
      }
    }

    return sendNotFound(res);
  } catch (e) {
    console.error('Unhandled server error:', e);
    return sendHtml(res, 500, renderLayout('Something went wrong', `
      <div class="wrap error-page">
        <p class="kicker">PRESSES JAMMED</p>
        ${renderChaosMessage("We seem to have lost the plot! Come back later, idiot.")}
        <p style="margin-top: 48px;"><a href="/">Back to the front page</a></p>
      </div>
    `));
  }
});

server.listen(PORT, () => {
  console.log(`The Tiny Island Times is running at http://localhost:${PORT}`);
  console.log(`Admin password is currently: ${ADMIN_PASSWORD === 'changeme' ? '"changeme" — set ADMIN_PASSWORD env variable before deploying!' : '(set via environment variable)'}`);
});
