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
