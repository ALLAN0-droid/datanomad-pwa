# DataNomad — Offline AI Toolkit (working PWA)

This is a real, functioning progressive web app — not a mockup:

- **Real on-device inference.** The Translate tab loads an actual MarianMT
  model (`Xenova/opus-mt-en-es`, ~90MB) via [transformers.js](https://github.com/xenova/transformers.js)
  and runs it in-browser with WASM. After the first download, translation
  works with the device in airplane mode.
- **Real offline storage.** Every translation, lesson result, and screening
  check is written to IndexedDB, not memory — it survives a closed tab or a
  reboot.
- **Real service worker.** `sw.js` precaches the app shell on install and
  serves it with zero network requests on repeat visits, per the standard
  PWA offline pattern.
- **Real sync backend included.** See [`backend/`](backend/) — a minimal
  Cloudflare Worker + KV store you can deploy in about 2 minutes. Once it's
  live, open the app's **Settings** panel, paste in the Worker URL, and
  every queued record POSTs there automatically whenever `navigator.onLine`
  goes true. No backend configured yet, and queued items are honestly
  labeled "ready to upload" locally rather than faking a network call.

## Why this can't just run in the chat preview

Service workers and installable PWAs require a real origin served over
HTTPS (or `localhost`) — browsers won't register a service worker inside a
sandboxed iframe, which is how the in-chat preview renders HTML. None of
that is a DataNomad limitation; it's a browser security rule for every PWA.
To see the install prompt, offline reload, and background sync actually
work, it needs to run from real hosting.

## Run it locally (2 minutes)

```bash
cd datanomad-pwa
python3 -m http.server 8080
# open http://localhost:8080 in Chrome or Edge
```

Open DevTools → Application → Service Workers to confirm it registered, and
try toggling "Offline" there after your first visit — the shell still loads.

## Deploy for real (free options)

**GitHub Pages**
1. Push this folder to a GitHub repo.
2. Repo Settings → Pages → Deploy from branch → `main` / root.
3. Visit the `github.io` URL Pages gives you — it's HTTPS by default, so
   the service worker and install prompt both work immediately.

**Netlify**
1. Drag this folder onto [app.netlify.com/drop](https://app.netlify.com/drop).
2. Done — Netlify serves it over HTTPS instantly.

Either way, open the deployed URL on a phone and you'll get a real "Add to
Home Screen" / install prompt, because the manifest and service worker are
both valid.

## Swapping in a different language pair

Change one line in `app.js`:

```js
translator = await pipeline('translation', 'Xenova/opus-mt-en-es', ...)
```

Any Helsinki-NLP OPUS-MT pair mirrored under the `Xenova/` org on Hugging
Face works the same way — e.g. `opus-mt-en-fr`, `opus-mt-en-ar`,
`opus-mt-en-de`. Search "Xenova opus-mt" on huggingface.co for the full list.

## Wiring up the real backend

1. Deploy the Worker in [`backend/`](backend/) (see its README — about 2
   minutes, free Cloudflare account).
2. Open the deployed app → **Settings** → paste the Worker's `/sync` URL →
   Save. Stored in `localStorage`, no code changes needed.
3. Visit `<your-worker-url>/dashboard` to watch records arrive as you use
   the Translate, Lessons, and Diagnostics tabs while online.
