# Email Enquiry Dashboard

A clean, simple dashboard that shows a business exactly what's happening with its email enquiries. Every enquiry is **scored automatically as hot, warm or cold**, so the business can see straight away who's ready to buy and who's still waiting for a reply.

![Dashboard](docs/dashboard.png)

You set it up once and run it for **as many businesses as you like**. Each business gets its own branded dashboard, login, inbox connection and lead-scoring rules.

## What the business sees

- **Hot / Warm / Cold tiles.** How many open leads are in each group and how many are waiting for a reply. Click a tile to filter the list.
- **Lead mix bar.** The split between hot, warm and cold leads.
- **Key numbers.** New enquiries (compared with the previous period), how many are waiting for a reply and how many are past the reply target, typical reply time, and won deals with win rate and value.
- **Enquiries per day.** A chart split by temperature. Hover over a day for the numbers, or open it as a table.
- **Reply to these next.** Hot leads and the longest-waiting leads come first.
- **Board or list of every enquiry**, with search and filters.
- **Enquiry detail panel.** Shows the full conversation and *why* the lead is hot, warm or cold, with points for each signal. From here the business can reply by email or call in one click, change the stage (New → Contacted → Quoted → Won/Lost), set the temperature by hand, record a deal value and add notes.
![Enquiry detail](docs/enquiry-detail.png)

- **Add enquiry.** Logs leads that came in by phone or in person.
- Works on phones and supports dark mode.

## How leads are scored

Each enquiry starts at 20 points and gains or loses points for what it contains:

| Signal | Points |
|---|---|
| Buying words (quote, price, book, deposit…) | +12 to +30 |
| Urgency (ASAP, urgent, this week…) | +18 |
| Mentions the business's own services | +8 to +15 |
| Mentions a budget | +15 (−10 if below the business's minimum) |
| Leaves a phone number | +10 |
| Mentions a specific date or timeframe | +8 |
| Detailed message / very short message | +6 / −8 |
| Writes from a business email domain | +5 |
| Sends follow-up emails | +10 each (max +20) |
| Early-stage words (just browsing, next year…) | −15 |
| No contact for 1 / 2 / 4+ weeks | −10 / −20 / −30 |

By default, **Hot is 60 or more, Warm is 30–59 and Cold is under 30**. For each business you can change these cut-offs and the word lists (services, buying words, urgency words, spam words, senders to ignore) in its settings. Spam such as SEO pitches and guest-post offers is filed away automatically.

## Getting enquiries in

There are two ways, and you can use both:

1. **Connect the inbox over IMAP.** In the business's settings there are one-click presets for Gmail, Microsoft 365, Yahoo, iCloud, Zoho and GoDaddy. Use an *app password*. The inbox is checked every few minutes. If you also give it the Sent folder, replies are picked up automatically, so reply times track themselves.
2. **Forwarding or website form.** Each business has a private inbound address. You can point Postmark, Mailgun, Zapier or Make at it, or use it as the `action` of the business's website contact form. The settings page shows a copy-paste form example.

Follow-up emails from the same person are added to their existing enquiry instead of creating a new one, and duplicate emails are ignored.

## Running it

You need Node.js 22.5 or newer.

```bash
npm install
npm run seed      # optional: creates a demo business with sample enquiries
npm start
```

Then open http://localhost:3000/admin. The admin password is printed in the terminal; set `ADMIN_PASSWORD` to choose your own. See `.env.example` for the other settings.

**Setting up a client:** go to Admin → **New business**, choose a name and brand colour (tick *sample enquiries* if you want to demo it first), and send the client the dashboard link and access code you're shown. Then open **Settings** to connect their inbox and adjust the scoring words to match what they sell.

### Deploying

The app is one Node process with a SQLite file, so any small VPS or container host works (Railway, Render, Fly.io, a DigitalOcean droplet, and so on):

```bash
docker build -t enquiries .
docker run -p 3000:3000 -v enquiries-data:/data -e ADMIN_PASSWORD=... enquiries
```

Keep the data directory on persistent storage, and back it up. It holds the database and the key that encrypts the stored inbox passwords. Serve it over HTTPS (most hosts do this for you).

## Project layout

```
src/server.js     web server, API and login
src/scoring.js    hot / warm / cold scoring rules
src/enquiries.js  storing enquiries, threading, dashboard numbers
src/inbox.js      IMAP inbox + Sent folder sync
src/settings.js   default settings for each business
src/demo.js       sample data
public/           dashboard, admin and login pages (plain HTML/CSS/JS, no build step)
test/             tests (npm test)
```
