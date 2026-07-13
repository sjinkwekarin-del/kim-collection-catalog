// Watches one or more PUBLIC Telegram channels for new posts, using Telegram's own public web
// preview (t.me/s/<channel>) - no login, no account, no session. This only works for channels
// that are public (have a t.me/channelname link). Private channels aren't reachable this way.
//
// Trade-off: this checks periodically rather than reacting instantly. A new post might take up
// to POLL_INTERVAL_MINUTES to show up in your review queue or catalog.
//
// Configure with TELEGRAM_CHANNELS (comma-separated channel usernames, no @, e.g.
// "enesinbutigi2,anothersupplier") to turn this on. Leave unset to skip it entirely - the
// manual forward-to-bot flow works completely fine on its own either way.

const cheerio = require('cheerio');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

function loadState(stateFile) {
  if (!fs.existsSync(stateFile)) return {};
  try {
    return JSON.parse(fs.readFileSync(stateFile, 'utf-8'));
  } catch {
    return {};
  }
}

function saveState(stateFile, state) {
  fs.writeFileSync(stateFile, JSON.stringify(state, null, 2));
}

function htmlToPlainText(html) {
  if (!html) return '';
  const withBreaks = html.replace(/<br\s*\/?>/gi, '\n');
  const $ = cheerio.load(`<div>${withBreaks}</div>`);
  return $('div').text();
}

function parseMessages(html) {
  const $ = cheerio.load(html);
  const messages = [];

  $('.tgme_widget_message').each((_, el) => {
    const dataPost = $(el).attr('data-post');
    if (!dataPost) return;
    const id = parseInt(dataPost.split('/').pop(), 10);
    if (!id) return;

    const photoUrls = [];
    $(el).find('[style*="background-image"]').each((_, photoEl) => {
      const style = $(photoEl).attr('style') || '';
      const match = style.match(/background-image:\s*url\(['"]?(.*?)['"]?\)/);
      if (match) photoUrls.push(match[1]);
    });

    const captionHtml = $(el).find('.tgme_widget_message_text').first().html();
    const caption = htmlToPlainText(captionHtml);

    messages.push({ id, photoUrls, caption });
  });

  return messages.sort((a, b) => a.id - b.id);
}

async function downloadImage(url, uploadsDir) {
  const res = await fetch(url, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  const buffer = Buffer.from(await res.arrayBuffer());
  const ext = path.extname(new URL(url).pathname) || '.jpg';
  const localName = `${crypto.randomUUID()}${ext}`;
  fs.writeFileSync(path.join(uploadsDir, localName), buffer);
  return localName;
}

async function pollChannel(channel, { uploadsDir, state, processCaptionIntoItems, summarizeItems, onNotify }) {
  const res = await fetch(`https://t.me/s/${channel}`, {
    headers: {
      'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
    },
  });
  if (!res.ok) {
    console.error(`Channel poller: could not reach t.me/s/${channel} (status ${res.status})`);
    return;
  }
  const html = await res.text();
  const messages = parseMessages(html);
  if (!messages.length) return;

  const lastSeenId = state[channel];
  const maxId = Math.max(...messages.map(m => m.id));

  if (lastSeenId === undefined) {
    state[channel] = maxId;
    console.log(`Channel poller: baseline set for "${channel}" (starting from post ${maxId}). ` +
      `Existing posts in this channel won't be imported - only new ones from here.`);
    return;
  }

  const newMessages = messages.filter(m => m.id > lastSeenId && m.photoUrls.length > 0);

  for (const msg of newMessages) {
    try {
      const localFile = await downloadImage(msg.photoUrls[0], uploadsDir);
      const createdItems = processCaptionIntoItems(msg.caption, localFile);
      const summary = summarizeItems(createdItems);
      console.log(`Channel poller ["${channel}" post ${msg.id}]: ${summary}`);
      if (onNotify) onNotify(`[${channel}] ${summary}`);
    } catch (err) {
      console.error(`Channel poller: failed processing post ${msg.id} from "${channel}":`, err.message);
    }
  }

  state[channel] = maxId;
}

function startChannelPoller({ uploadsDir, dataDir, processCaptionIntoItems, summarizeItems, onNotify }) {
  const channelsEnv = process.env.TELEGRAM_CHANNELS;
  if (!channelsEnv) {
    console.log('Channel poller not started - TELEGRAM_CHANNELS not set. Manual forward-to-bot still works normally.');
    return;
  }

  const channels = channelsEnv.split(',').map(c => c.trim().replace(/^@/, '')).filter(Boolean);
  const intervalMinutes = parseFloat(process.env.POLL_INTERVAL_MINUTES || '3');
  const stateFile = path.join(dataDir, 'poller-state.json');

  console.log(`Channel poller starting. Watching: ${channels.join(', ')} (every ${intervalMinutes} min)`);

  const runOnce = async () => {
    const state = loadState(stateFile);
    for (const channel of channels) {
      try {
        await pollChannel(channel, { uploadsDir, state, processCaptionIntoItems, summarizeItems, onNotify });
      } catch (err) {
        console.error(`Channel poller: error polling "${channel}":`, err.message, err.cause ? `| cause: ${err.cause}` : '');
      }
    }
    saveState(stateFile, state);
  };

  runOnce();
  setInterval(runOnce, intervalMinutes * 60 * 1000);
}

module.exports = { startChannelPoller, parseMessages, htmlToPlainText };
