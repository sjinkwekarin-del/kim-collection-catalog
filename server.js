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
  // Symbol before the number: €45, $12.50, £8
  const leadingSymbol = caption.match(/(?:€|\$|£)\s?(\d+(?:[.,]\d{1,2})?)/);
  if (leadingSymbol) return parseFloat(leadingSymbol[1].replace(',', '.'));
  // Symbol after the number: 45€, 12.50$
  const trailingSymbol = caption.match(/(\d+(?:[.,]\d{1,2})?)\s?(?:€|\$|£)/);
  if (trailingSymbol) return parseFloat(trailingSymbol[1].replace(',', '.'));
  // Currency code after the number: 25 EUR, 30 USD
  const trailingCode = caption.match(/(\d+(?:[.,]\d{1,2})?)\s?(?:EUR|USD|GBP)\b/i);
  if (trailingCode) return parseFloat(trailingCode[1].replace(',', '.'));
  return null;
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

// --- Telegram file download ---

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

// --- Webhook: receives forwarded supplier posts ---

app.post('/webhook/telegram/:secret', async (req, res) => {
  if (req.params.secret !== WEBHOOK_SECRET) return res.sendStatus(403);
  res.sendStatus(200); // ack immediately, Telegram doesn't wait for the rest

  try {
    const message = req.body.message;
    if (!message || !message.photo || !message.photo.length) return;

    const caption = message.caption || '';
    const largestPhoto = message.photo[message.photo.length - 1];
    const localFile = await downloadTelegramFile(largestPhoto.file_id);

    const price = extractPrice(caption);
    const description = cleanDescription(caption);
    const commissionAmount = price !== null ? Math.round(price * COMMISSION_RATE * 100) / 100 : null;

    const db = loadDB();
    const item = {
      id: crypto.randomUUID(),
      imageFile: localFile,
      price,
      description,
      commissionRate: COMMISSION_RATE,
      commissionAmount,
      receivedAt: new Date().toISOString(),
    };
    db.pending.push(item);
    saveDB(db);

    const priceLabel = price !== null ? `${CURRENCY_SYMBOL}${price.toFixed(2)}` : 'not detected - add manually';
    await sendTelegramMessage(
      message.chat.id,
      `Received. Price parsed: ${priceLabel}. Review and approve at your admin page.`
    );
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

app.listen(PORT, () => console.log(`Kim Collection catalog running on port ${PORT}`));

module.exports = { extractPrice, cleanDescription }; // exported for local testing only
