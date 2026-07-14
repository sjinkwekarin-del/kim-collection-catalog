require('dotenv').config();

// Render's default DNS resolver has been intermittently failing to resolve certain domains
// (including t.me). Pointing Node at well-known public DNS servers works around that.
try {
  const dns = require('dns');
  dns.setServers(['8.8.8.8', '1.1.1.1']);
} catch (err) {
  console.error('Could not set custom DNS servers:', err.message);
}

const express = require('express');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const app = express();
app.use(express.json());

const BOT_TOKEN = process.env.BOT_TOKEN;
const WEBHOOK_SECRET = process.env.WEBHOOK_SECRET || 'change_this_to_something_random';
const ADMIN_USER = process.env.ADMIN_USER || 'admin';
const ADMIN_PASS = process.env.ADMIN_PASS || 'admin';
const CURRENCY_SYMBOL = process.env.CURRENCY_SYMBOL || '€';
const COMMISSION_RATE = parseFloat(process.env.COMMISSION_RATE || '0.20');
const AUTO_PUBLISH = process.env.AUTO_PUBLISH === 'true';
const PORT = process.env.PORT || 3000;

const DATA_DIR = path.join(__dirname, 'data');
const DB_FILE = path.join(DATA_DIR, 'products.json');
const UPLOADS_DIR = path.join(__dirname, 'uploads');

if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(UPLOADS_DIR)) fs.mkdirSync(UPLOADS_DIR, { recursive: true });
if (!fs.existsSync(DB_FILE)) fs.writeFileSync(DB_FILE, JSON.stringify({ pending: [], published: [] }, null, 2));

function loadDB() {
  return JSON.parse(fs.readFileSync(DB_FILE, 'utf-8'));
}
function saveDB(db) {
  fs.writeFileSync(DB_FILE, JSON.stringify(db, null, 2));
}

// --- Parsing helpers ---

// Pulls a price out of a caption regardless of whether the symbol comes before or after the number.
function extractPrice(caption) {
  if (!caption) return null;
  const leadingSymbol = caption.match(/(?:€|\$|£)\s?(\d+(?:[.,]\d{1,2})?)/);
  if (leadingSymbol) return parseFloat(leadingSymbol[1].replace(',', '.'));
  const trailingSymbol = caption.match(/(\d+(?:[.,]\d{1,2})?)\s?(?:€|\$|£)/);
  if (trailingSymbol) return parseFloat(trailingSymbol[1].replace(',', '.'));
  const trailingCode = caption.match(/(\d+(?:[.,]\d{1,2})?)\s?(?:EUR|USD|GBP)\b/i);
  if (trailingCode) return parseFloat(trailingCode[1].replace(',', '.'));
  return null;
}

// Finds every price mentioned in a caption, each paired with the text around it (so a caption
// listing several items - "Shoes 28$, bag 30$" - can become several catalog entries instead of one.
function extractAllPrices(caption) {
  if (!caption) return [];
  const pattern = /(?:€|\$|£)\s?(\d+(?:[.,]\d{1,2})?)|(\d+(?:[.,]\d{1,2})?)\s?(?:€|\$|£)|(\d+(?:[.,]\d{1,2})?)\s?(?:EUR|USD|GBP)\b/gi;
  const matches = [];
  let m;
  while ((m = pattern.exec(caption)) !== null) {
    const raw = m[1] || m[2] || m[3];
    matches.push({ price: parseFloat(raw.replace(',', '.')), index: m.index });
  }
  return matches;
}

// Removes the price mention itself from a line, so the client-facing description doesn't
// repeat the number next to the separately-shown price.
function stripPriceFromLine(line) {
  return line
    .replace(/(?:€|\$|£)\s?\d+(?:[.,]\d{1,2})?/g, '')
    .replace(/\d+(?:[.,]\d{1,2})?\s?(?:€|\$|£)/g, '')
    .replace(/\d+(?:[.,]\d{1,2})?\s?(?:EUR|USD|GBP)\b/gi, '')
    .trim();
}
function lineAroundIndex(caption, index) {
  const lines = caption.split('\n');
  let pos = 0;
  for (const line of lines) {
    if (index <= pos + line.length) return line;
    pos += line.length + 1;
  }
  return lines[lines.length - 1] || '';
}

// Strips anything that could identify or link back to the supplier - links, WhatsApp/Instagram
// contact mentions, @handles - while keeping the rest of each line's text intact. Channel/brand
// names are handled separately (added deliberately, not stripped here).
function cleanDescription(caption) {
  if (!caption) return '';
  return caption
    .split('\n')
    .map(line => {
      let cleaned = line;
      // Full links always go - these reveal the exact channel/contact address.
      cleaned = cleaned.replace(/https?:\/\/\S+/gi, '');
      cleaned = cleaned.replace(/\bwww\.\S+/gi, '');
      cleaned = cleaned.replace(/t\.me\/\S+/gi, '');
      // WhatsApp/Instagram mentions plus whatever contact detail immediately follows them.
      cleaned = cleaned.replace(/whatsapp\s*[:\-]?\s*[\+\d][\d\s\-()]{5,}/gi, '');
      cleaned = cleaned.replace(/instagram\s*[:\-]?\s*@?[\w.]+/gi, '');
      // Any bare mention of those words left over, or a standalone @handle.
      cleaned = cleaned.replace(/\b(whatsapp|instagram)\b/gi, '');
      cleaned = cleaned.replace(/@\w+/g, '');
      return cleaned;
    })
    .filter(line => !/^\s*(price|cost)\s*[:\-]/i.test(line))
    .join(' ')
    .replace(/[:\-–]\s*(?=[:\-–]|\s*$)/g, '') // dangling punctuation left behind after removals
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Shared logic: turns a caption + a locally-saved photo into one or more catalog items.
// Used by both the manual bot webhook and the automatic channel listener, so both paths
// apply identical, already-tested pricing rules.

// Appends the channel/brand name to a description, e.g. "Round Lab Cleanser — Aslife Samet".
// Only the name is added, never a link or contact detail.
function withChannelName(description, channelName) {
  if (!channelName) return description;
  return description ? `${description} — ${channelName}` : channelName;
}

function processCaptionIntoItems(caption, localFiles, channelName) {
  const priceMatches = extractAllPrices(caption);
  const db = loadDB();
  const createdItems = [];

  if (priceMatches.length > 1) {
    // Multiple different prices in one caption - genuinely ambiguous which photo(s) belong to
    // which price. Always goes to the review queue regardless of AUTO_PUBLISH - guessing wrong
    // here means a client sees the wrong price on the wrong item, which is worse than asking
    // for a quick manual check. Every split item gets the full photo set so it's easy to review.
    for (const match of priceMatches) {
      const line = lineAroundIndex(caption, match.index);
      const rawDescription = cleanDescription(stripPriceFromLine(line)) || cleanDescription(caption);
      const description = withChannelName(rawDescription, channelName);
      const commissionAmount = Math.round(match.price * COMMISSION_RATE * 100) / 100;
      const item = {
        id: crypto.randomUUID(),
        imageFiles: localFiles,
        price: match.price,
        description,
        commissionRate: COMMISSION_RATE,
        commissionAmount,
        receivedAt: new Date().toISOString(),
      };
      db.pending.push(item);
      createdItems.push(item);
    }
  } else {
    // The clean, common case: one price (or none detected) for the whole photo set - the
    // pattern described as "many photos, one description, one price". Fully automated: this
    // publishes even when price or description is missing, since that's a data-quality gap,
    // not a correctness conflict (unlike the multi-price case above).
    const price = priceMatches.length === 1 ? priceMatches[0].price : null;
    const description = withChannelName(cleanDescription(caption), channelName);
    const commissionAmount = price !== null ? Math.round(price * COMMISSION_RATE * 100) / 100 : null;
    const item = {
      id: crypto.randomUUID(),
      imageFiles: localFiles,
      price,
      description,
      commissionRate: COMMISSION_RATE,
      commissionAmount,
      receivedAt: new Date().toISOString(),
    };

    if (AUTO_PUBLISH) {
      item.publishedAt = new Date().toISOString();
      item.autoPublished = true;
      db.published.push(item);
    } else {
      db.pending.push(item);
    }
    createdItems.push(item);
  }

  saveDB(db);
  return createdItems;
}

function summarizeItems(createdItems) {
  if (createdItems.length > 1) {
    return `Found ${createdItems.length} products in that post: ${createdItems.map(i => i.price !== null ? `${CURRENCY_SYMBOL}${i.price.toFixed(2)}` : 'price not detected').join(', ')}. Sent to your review queue.`;
  }
  const i = createdItems[0];
  const priceLabel = i.price !== null ? `${CURRENCY_SYMBOL}${i.price.toFixed(2)}` : 'no price detected';
  if (i.autoPublished) return `Published automatically (${priceLabel}). Live on the catalog now.`;
  if (i.price !== null) return `Received. Price parsed: ${priceLabel}. Review and approve at your admin page.`;
  return 'Received. Price not detected - add manually at your admin page.';
}

// --- Telegram file download (bot API - used for the manual forward-to-bot path) ---

async function downloadTelegramFile(fileId) {
  const getFileRes = await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/getFile?file_id=${fileId}`);
  const getFileJson = await getFileRes.json();
  if (!getFileJson.ok) throw new Error('Telegram getFile failed: ' + JSON.stringify(getFileJson));
  const filePath = getFileJson.result.file_path;

  const fileRes = await fetch(`https://api.telegram.org/file/bot${BOT_TOKEN}/${filePath}`);
  const buffer = Buffer.from(await fileRes.arrayBuffer());

  const ext = path.extname(filePath) || '.jpg';
  const localName = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(UPLOADS_DIR, localName), buffer);
  return localName;
}

async function sendTelegramMessage(chatId, text) {
  await fetch(`https://api.telegram.org/bot${BOT_TOKEN}/sendMessage`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ chat_id: chatId, text }),
  });
}

// --- Webhook: receives forwarded supplier posts (manual path) ---

// Multi-photo posts arrive as several separate Telegram messages sharing one media_group_id,
// with the caption usually on only one of them. This buffers messages in the same group for a
// short window so all their photos end up on one catalog item, instead of creating broken
// duplicates or only capturing a single photo from the batch.
const albumBuffers = new Map(); // media_group_id -> { photoIds: [], caption, chatId, timer }
const ALBUM_DEBOUNCE_MS = 2500;

function getForwardChannelName(message) {
  // When a channel post is forwarded, Telegram includes forward_from_chat with the channel's
  // display name (and/or username). If the source hid the forward origin, this simply won't
  // be present - that's fine, the item just won't get a channel name tag in that case.
  const chat = message.forward_from_chat;
  if (!chat) return null;
  return chat.title || chat.username || null;
}

async function flushAlbumBuffer(groupId) {
  const buf = albumBuffers.get(groupId);
  if (!buf) return;
  albumBuffers.delete(groupId);
  try {
    const localFiles = [];
    for (const fileId of buf.photoIds) {
      localFiles.push(await downloadTelegramFile(fileId));
    }
    const createdItems = processCaptionIntoItems(buf.caption, localFiles, buf.channelName);
    await sendTelegramMessage(buf.chatId, summarizeItems(createdItems));
  } catch (err) {
    console.error('Album processing error:', err);
  }
}

app.post('/webhook/telegram/:secret', async (req, res) => {
  if (req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(403);
  res.sendStatus(200); // ack immediately, Telegram doesn't wait for the rest

  try {
    const message = req.body.message;
    if (!message || !message.photo || !message.photo.length) return;

    const largestPhoto = message.photo[message.photo.length - 1];
    const caption = message.caption || '';
    const channelName = getForwardChannelName(message);

    if (message.media_group_id) {
      const groupId = message.media_group_id;
      let buf = albumBuffers.get(groupId);
      if (!buf) {
        buf = { photoIds: [], caption: '', chatId: message.chat.id, channelName: null };
        albumBuffers.set(groupId, buf);
      }
      buf.photoIds.push(largestPhoto.file_id);
      if (caption) buf.caption = caption;
      if (channelName) buf.channelName = channelName;
      if (buf.timer) clearTimeout(buf.timer);
      buf.timer = setTimeout(() => flushAlbumBuffer(groupId), ALBUM_DEBOUNCE_MS);
      return;
    }

    // Single photo, not part of an album.
    const localFile = await downloadTelegramFile(largestPhoto.file_id);
    const createdItems = processCaptionIntoItems(caption, [localFile], channelName);
    await sendTelegramMessage(message.chat.id, summarizeItems(createdItems));
  } catch (err) {
    console.error('Webhook processing error:', err);
  }
});

// --- Admin auth ---

function requireAdmin(req, res, next) {
  const header = req.headers.authorization || '';
  const [scheme, encoded] = header.split(' ');
  if (scheme !== 'Basic' || !encoded) {
    res.set('WWW-Authenticate', 'Basic realm="Kim Collection Admin"');
    return res.sendStatus(401);
  }
  const [user, pass] = Buffer.from(encoded, 'base64').toString().split(':');
  if (user !== ADMIN_USER || pass !== ADMIN_PASS) {
    res.set('WWW-Authenticate', 'Basic realm="Kim Collection Admin"');
    return res.sendStatus(401);
  }
  next();
}

app.get('/admin', requireAdmin, (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'admin.html'));
});

app.get('/api/pending', requireAdmin, (req, res) => {
  const db = loadDB();
  res.json(db.pending);
});

// Temporary diagnostic route - checks whether this server can reach Telegram at all.
// Safe to remove later once the channel poller is confirmed working.
app.get('/debug/telegram-check', requireAdmin, async (req, res) => {
  try {
    const start = Date.now();
    const response = await fetch('https://t.me/s/enesinbutigi2', {
      headers: {
        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
      },
    });
    const elapsed = Date.now() - start;
    const bodyPreview = (await response.text()).slice(0, 200);
    res.json({ ok: true, status: response.status, elapsedMs: elapsed, bodyPreview });
  } catch (err) {
    res.json({
      ok: false,
      errorMessage: err.message,
      errorCause: err.cause ? String(err.cause) : null,
      errorStack: err.stack,
    });
  }
});

app.get('/api/published', requireAdmin, (req, res) => {
  const db = loadDB();
  res.json(db.published); // includes commissionAmount - this is your internal margin ledger
});

app.post('/api/approve/:id', requireAdmin, (req, res) => {
  const db = loadDB();
  const idx = db.pending.findIndex(p => p.id === req.params.id);
  if (idx === -1) return res.sendStatus(404);

  const item = db.pending[idx];
  if (req.body.price !== undefined) {
    item.price = parseFloat(req.body.price);
    item.commissionAmount = Math.round(item.price * item.commissionRate * 100) / 100;
  }
  if (req.body.description !== undefined) {
    item.description = req.body.description;
  }
  item.publishedAt = new Date().toISOString();

  db.pending.splice(idx, 1);
  db.published.push(item);
  saveDB(db);
  res.json({ ok: true });
});

app.post('/api/reject/:id', requireAdmin, (req, res) => {
  const db = loadDB();
  db.pending = db.pending.filter(p => p.id !== req.params.id);
  saveDB(db);
  res.json({ ok: true });
});

// --- Public catalog API: no supplier info, ever ---

app.get('/api/products', (req, res) => {
  const db = loadDB();
  const publicView = db.published
    .slice()
    .reverse()
    .map(p => ({
      id: p.id,
      imageUrls: (p.imageFiles || (p.imageFile ? [p.imageFile] : [])).map(f => `/uploads/${f}`),
      price: p.price,
      description: p.description,
    }));
  res.json({ currencySymbol: CURRENCY_SYMBOL, products: publicView });
});

app.use('/uploads', express.static(UPLOADS_DIR));
app.use(express.static(path.join(__dirname, 'public')));

// Start the automatic channel poller, if configured. Safe to leave unconfigured - the manual
// forward-to-bot flow above works completely on its own either way.
const { startChannelPoller } = require('./channel-poller');
startChannelPoller({
  uploadsDir: UPLOADS_DIR,
  dataDir: DATA_DIR,
  processCaptionIntoItems,
  summarizeItems,
});

app.listen(PORT, () => console.log(`Kim Collection catalog running on port ${PORT}`));

module.exports = { extractPrice, cleanDescription }; // exported for local testing only
