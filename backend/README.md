# DataNomad sync backend

A minimal, real backend for the DataNomad PWA — a Cloudflare Worker backed
by Workers KV. Free tier covers this comfortably (100k requests/day, 1GB KV
storage). No server to patch or pay for.

## What it does

- `POST /sync` — the PWA calls this with each queued record
  (`{ type, payload, timestamp }`). Stored in KV, returns the stored copy.
- `GET /records?limit=50` — JSON list of recent records, newest first.
- `GET /dashboard` — a small HTML page (served by the Worker itself, no
  separate hosting needed) that shows what's synced from the field.
- `GET /health` — plain liveness check.

## Deploy it (about 2 minutes)

You'll need a free [Cloudflare account](https://dash.cloudflare.com/sign-up).

```bash
cd backend
npm install
npx wrangler login          # opens a browser to authorize

# create the KV namespace that stores records
npx wrangler kv namespace create DATANOMAD_KV
# copy the "id" it prints into wrangler.toml, replacing REPLACE_WITH_YOUR_KV_NAMESPACE_ID

npx wrangler deploy
```

Wrangler will print your live URL, something like:

```
https://datanomad-sync.<your-subdomain>.workers.dev
```

Visit `<that-url>/dashboard` — it'll show "No records synced yet," which is
correct until the app sends something.

## Connect the PWA to it

Open the deployed DataNomad app, go to the **Settings** panel at the bottom
of the screen, paste in:

```
https://datanomad-sync.<your-subdomain>.workers.dev/sync
```

and tap Save. It's stored in the browser's `localStorage`, so you don't
need to edit any code. From then on, every queued record that reaches the
device while online gets POSTed there for real, and you'll see it appear at
`/dashboard` within a few seconds.

## Notes on this being a "minimal" backend

- No auth on `/sync` or `/records` — anyone with the URL can write or read.
  Fine for a prototype/demo; before a real field deployment, add at minimum
  an API key header check (a few lines in `handleSync`/`handleRecords`) or
  put the Worker behind Cloudflare Access.
- KV is eventually consistent and not built for complex queries. If you
  outgrow "list the last N records," migrate to
  [D1](https://developers.cloudflare.com/d1/) (SQLite at the edge, same
  deploy model) — the `handleSync`/`handleRecords` functions are the only
  things that would need to change.
- No delete/export endpoints yet — add them the same way as `/records`.
