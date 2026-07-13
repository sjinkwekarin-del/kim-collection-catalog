require('dotenv').config();
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

// Strips anything that could identify or link back to the supplier: @handles, t.me links, any URL,
// and standalone price lines (the price is already shown separately on the catalog).
function cleanDescription(caption) {
  if (!caption) return '';
  return caption
    .split('\n')
    .filter(line => !/t\.me\//i.test(line))
    .filter(line => !/@\w+/.test(line))
    .filter(line => !/https?:\/\//i.test(line))
    .filter(line => !/\bwww\.\S+/i.test(line))
    .filter(line => !/^\s*(price|cost)\s*[:\-]/i.test(line))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// --- Shared logic: turns a caption + a locally-saved photo into one or more catalog items.
// Used by both the manual bot webhook and the automatic channel listener, so both paths
// apply identical, already-tested pricing rules.

function processCaptionIntoItems(caption, localFile) {
  const priceMatches = extractAllPrices(caption);
  const db = loadDB();
  const createdItems = [];

  if (priceMatches.length > 1) {
    for (const match of priceMatches) {
      const line = lineAroundIndex(caption, match.index);
      const description = cleanDescription(stripPriceFromLine(line)) || cleanDescription(caption);
      const commissionAmount = Math.round(match.price * COMMISSION_RATE * 100) / 100;
      const item = {
        id: crypto.randomUUID(),
        imageFile: localFile,
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
    const price = priceMatches.length === 1 ? priceMatches[0].price : null;
    const description = cleanDescription(caption);
    const commissionAmount = price !== null ? Math.round(price * COMMISSION_RATE * 100) / 100 : null;
    const item = {
      id: crypto.randomUUID(),
      imageFile: localFile,
      price,
      description,
      commissionRate: COMMISSION_RATE,
      commissionAmount,
      receivedAt: new Date().toISOString(),
    };

    if (AUTO_PUBLISH && price !== null) {
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
  if (i.autoPublished) return `Published automatically: ${CURRENCY_SYMBOL}${i.price.toFixed(2)}. Live on the catalog now.`;
  if (i.price !== null) return `Received. Price parsed: ${CURRENCY_SYMBOL}${i.price.toFixed(2)}. Review and approve at your admin page.`;
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

app.post('/webhook/telegram/:secret', async (req, res) => {
  if (req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(403);
  res.sendStatus(200); // ack immediately, Telegram doesn't wait for the rest

  try {
    const message = req.body.message;
    if (!message || !message.photo || !message.photo.length) return;

    const caption = message.caption || '';

    // Multi-photo posts arrive as separate messages sharing a media_group_id, and only one of
    // them carries the caption. Skip the captionless ones so we don't create broken duplicate
    // entries - the one message with the caption is enough to represent the product.
    if (message.media_group_id && !caption) return;

    const largestPhoto = message.photo[message.photo.length - 1];
    const localFile = await downloadTelegramFile(largestPhoto.file_id);

    const createdItems = processCaptionIntoItems(caption, localFile);
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
      imageUrl: `/uploads/${p.imageFile}`,
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
