# Kim Collection — Supplier-to-Catalog Pipeline

Forward a supplier's post to your bot → approve it → it appears on your client catalog page.
No supplier name, links, or contact info ever reaches the client-facing page or API — that data
never gets stored for those items, and the public endpoint only ever returns image, price, and
description.

Client price = supplier's price exactly, as forwarded. Your 20% cut is calculated automatically
and stored privately in the admin view for your own bookkeeping — it never appears anywhere a
client can see.

## How it works day to day

1. Supplier posts a product photo + price in their channel.
2. You forward that message to your own bot (private chat, just you and the bot).
3. Bot replies confirming the price it detected.
4. You go to `your-site.com/admin`, check the photo/price/description, edit anything the parser
   got wrong, and click **Approve & publish**.
5. It's now live on `your-site.com` for clients.

## One-time setup

### 1. Create your bot
- Open Telegram, message **@BotFather**.
- Send `/newbot`, follow the prompts, name it whatever you like (e.g. "Kim Collection Intake").
- BotFather gives you a **token** — looks like `123456789:AAExample-Token`. Save it, you'll need it below.

### 2. Deploy the backend
This is a standard Node.js app. Render's free tier works well for this volume.

- Create a GitHub repo and push this folder to it (or upload the zip directly if your host supports it).
- On [render.com](https://render.com): New → Web Service → connect your repo.
- Build command: `npm install`
- Start command: `npm start`
- Add environment variables (Render dashboard → Environment):
  - `BOT_TOKEN` — from step 1
  - `WEBHOOK_SECRET` — make up a long random string (e.g. run `openssl rand -hex 20` locally, or any password generator)
  - `ADMIN_USER` — your login name for the admin page
  - `ADMIN_PASS` — a strong password for the admin page
  - `CURRENCY_SYMBOL` — `€` (default, change if needed)
  - `COMMISSION_RATE` — `0.20` (your 20% cut, adjust if this ever changes)
- Deploy. Render gives you a URL like `https://kim-collection-catalog.onrender.com`.

**Note on the free tier:** free Render services sleep after inactivity and take ~30 seconds to
wake on the next request. Fine for a catalog people check occasionally; if that lag bothers you,
their $7/mo starter tier keeps it always-on.

### 3. Point Telegram at your bot
Run this once (replace the bracketed parts), from any terminal or even a browser address bar:

```
https://api.telegram.org/bot<YOUR_BOT_TOKEN>/setWebhook?url=https://<YOUR_RENDER_URL>/webhook/telegram/<YOUR_WEBHOOK_SECRET>
```

You should get back `{"ok":true,"result":true,...}`. That's it — Telegram now pushes anything sent
to your bot to your server.

### 4. Test it
- Forward any photo with a caption (with a price in it, e.g. "Round Lab cleanser €18.50") to your bot.
- You should get a reply confirming the price it found.
- Visit `your-render-url.com/admin`, log in with `ADMIN_USER`/`ADMIN_PASS`.
- You'll see the item waiting. Edit if needed, click Approve & publish.
- Visit `your-render-url.com/` — the item is now on the client catalog.

## What the price parser catches

It reads captions and looks for:
- Symbol before the number: `€45`, `$12.50`, `£8`
- Symbol after the number: `45€`
- Currency code after the number: `25 EUR`

It also strips out any line containing `@handles`, `t.me/` links, `www.` links, or `http(s)://`
links, and any line that starts with "Price:" or "Cost:" (since the price is shown separately).

**It won't be perfect every time.** Suppliers format captions inconsistently. That's exactly why
there's an approval step — nothing goes live without you checking it first, and you can edit the
price or description right there in the admin page before publishing.

## Your commission ledger

`your-render-url.com/api/published` (needs your admin login) returns the full list of published
items including `commissionAmount` for each — your 20% on that item. Useful for copying into your
margin tracking at the end of the week/month. Clients never see this endpoint or field.

## Files

```
server.js          Backend: webhook, parsing, admin API, public API
public/index.html   Client catalog (rose-gold branded)
public/admin.html   Your approval queue
data/products.json  Local database (pending + published items)
uploads/            Downloaded product photos
.env.example        Copy to .env for local testing (Render uses its own env var settings, not this file)
```

## Local testing (optional, before deploying)

```
npm install
cp .env.example .env
# edit .env with a real BOT_TOKEN if you want to test actual Telegram messages
npm start
```
Visit `http://localhost:3000` for the catalog and `http://localhost:3000/admin` for the queue.

## Automatic channel watching (skip the manual forwarding)

This is optional, and separate from the bot above. Instead of forwarding each post yourself, this
checks the supplier's public channel directly using Telegram's own public web preview - no login,
no account access, nothing installed on your Telegram. It only works for **public** channels (ones
with a `t.me/channelname` link, like the one you tested with).

**Trade-off to know upfront:** this checks periodically (every few minutes, configurable) rather
than reacting the instant something's posted. If you need something added right away, forwarding
to the bot still works too, any time.

### 1. Add the channel(s) to Render
In Render's Environment tab, add:
- `TELEGRAM_CHANNELS` → the channel's username, without the `@`. For `t.me/enesinbutigi2`, that's
  just `enesinbutigi2`. Add more than one by separating with commas: `enesinbutigi2,othersupplier`
- `POLL_INTERVAL_MINUTES` → how often to check, in minutes. `3` is a reasonable default.

Save - Render redeploys automatically.

### 2. Check the logs
In Render's Logs tab, you should see:
```
Channel poller starting. Watching: enesinbutigi2 (every 3 min)
Channel poller: baseline set for "enesinbutigi2" (starting from post 1234). Existing posts in this channel won't be imported - only new ones from here.
```
That baseline message is expected and only happens once per channel - it deliberately skips
importing the channel's whole back-catalog, and only picks up posts from that point forward.

### 3. Wait for the next post
Once the supplier posts something new, within `POLL_INTERVAL_MINUTES` you'll see a log line like:
```
Channel poller ["enesinbutigi2" post 1235]: Received. Price parsed: €18.50. Review and approve at your admin page.
```
Check your admin page - it'll be waiting there, same as if you'd forwarded it yourself. If
`AUTO_PUBLISH=true` and it's a single clean price, it goes straight to the live catalog instead.

### If a supplier's channel is private
This method can't reach it - private channels aren't in the public web preview at all. For those,
forwarding to the bot is still the way to add their posts.

## Limits worth knowing

## Limits worth knowing

- Free Render tier sleeps when idle — first load after a quiet period is slow, not broken.
- The database is a JSON file on disk. Fine at this scale (dozens to low hundreds of items). If you
  ever need this to survive Render restarts reliably at larger volume, that's a sign to move to a
  real database — happy to help with that when it comes up.
- This handles viewing only, not checkout. Clients see the catalog and presumably contact you
  directly to buy, same as now.
