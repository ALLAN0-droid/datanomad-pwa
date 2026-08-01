// ============================================================
// DataNomad — app.js
// Real on-device inference (transformers.js) + real offline
// queueing (IndexedDB) + real service-worker-backed caching.
//
// The sync backend URL is configured at runtime from the Settings
// panel (stored in localStorage — this app runs from real hosting,
// not a sandboxed preview, so localStorage is fair game here). If
// nothing's configured yet, DEFAULT_SYNC_ENDPOINT is used, which is
// null out of the box. Until an endpoint is set, "sync" marks queued
// records as ready-to-upload locally rather than claiming a fake
// network success.
// ============================================================

const DEFAULT_SYNC_ENDPOINT = null; // e.g. "https://datanomad-sync.yoursubdomain.workers.dev/sync"
const ENDPOINT_STORAGE_KEY = 'datanomad_sync_endpoint';

function getSyncEndpoint() {
  return localStorage.getItem(ENDPOINT_STORAGE_KEY) || DEFAULT_SYNC_ENDPOINT;
}

function setSyncEndpoint(url) {
  if (url) localStorage.setItem(ENDPOINT_STORAGE_KEY, url);
  else localStorage.removeItem(ENDPOINT_STORAGE_KEY);
  renderEndpointStatus();
}

function renderEndpointStatus() {
  const endpoint = getSyncEndpoint();
  const statusEl = document.getElementById('syncEndpointStatus');
  const inputEl = document.getElementById('syncEndpointInput');
  if (inputEl && document.activeElement !== inputEl) inputEl.value = endpoint || '';
  if (!statusEl) return;
  if (endpoint) {
    statusEl.textContent = 'configured';
    statusEl.classList.add('configured');
  } else {
    statusEl.textContent = 'not configured';
    statusEl.classList.remove('configured');
  }
}

// ---------- Service worker ----------
if ('serviceWorker' in navigator) {
  window.addEventListener('load', () => {
    navigator.serviceWorker.register('sw.js').catch(err => {
      console.warn('Service worker registration failed:', err);
    });
  });
}

// ---------- IndexedDB queue ----------
const DB_NAME = 'datanomad';
const STORE = 'queue';

function openDB() {
  return new Promise((resolve, reject) => {
    const req = indexedDB.open(DB_NAME, 1);
    req.onupgradeneeded = () => {
      const db = req.result;
      if (!db.objectStoreNames.contains(STORE)) {
        db.createObjectStore(STORE, { keyPath: 'id', autoIncrement: true });
      }
    };
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function addToQueue(type, payload) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    tx.objectStore(STORE).add({
      type, payload, timestamp: new Date().toISOString(), synced: false
    });
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }).then(renderQueue);
}

async function getAllQueue() {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readonly');
    const req = tx.objectStore(STORE).getAll();
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

async function markSynced(id) {
  const db = await openDB();
  return new Promise((resolve, reject) => {
    const tx = db.transaction(STORE, 'readwrite');
    const store = tx.objectStore(STORE);
    const getReq = store.get(id);
    getReq.onsuccess = () => {
      const rec = getReq.result;
      if (rec) { rec.synced = true; store.put(rec); }
    };
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
  }).then(renderQueue);
}

async function renderQueue() {
  const items = (await getAllQueue()).reverse();
  const list = document.getElementById('queueList');
  const badge = document.getElementById('queueBadge');
  const pending = items.filter(i => !i.synced).length;
  badge.textContent = pending;

  if (items.length === 0) {
    list.innerHTML = '<p class="empty-note">Nothing queued yet.</p>';
    return;
  }
  list.innerHTML = items.slice(0, 8).map(i => `
    <div class="queue-item">
      <div>
        <div class="type">${i.type}</div>
        <div>${describeRecord(i)}</div>
      </div>
      <div class="state ${i.synced ? 'synced' : 'pending'}">${i.synced ? (getSyncEndpoint() ? 'synced to server' : 'ready to upload') : 'pending'}</div>
    </div>
  `).join('');
}

function describeRecord(rec) {
  if (rec.type === 'translation') return `"${rec.payload.input}" → "${rec.payload.output}"`;
  if (rec.type === 'lesson') return `${rec.payload.question} — ${rec.payload.correct ? 'correct' : 'missed'}`;
  if (rec.type === 'screening') return `${rec.payload.flagCount} of ${rec.payload.total} flags`;
  return '';
}

// ---------- Connection status + sync trigger ----------
function updateStatus() {
  const online = navigator.onLine;
  const dot = document.getElementById('statusDot');
  const text = document.getElementById('statusText');
  dot.className = 'dot ' + (online ? 'online' : 'offline');
  text.textContent = online ? 'Online — syncing queue' : 'Offline — working on device';
  if (online) trySync();
}
window.addEventListener('online', updateStatus);
window.addEventListener('offline', updateStatus);

async function trySync() {
  const endpoint = getSyncEndpoint();
  const items = await getAllQueue();
  const pending = items.filter(i => !i.synced);

  for (const rec of pending) {
    if (endpoint) {
      try {
        const res = await fetch(endpoint, {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(rec)
        });
        if (!res.ok) throw new Error(`Server responded ${res.status}`);
      } catch (e) {
        console.warn('Sync failed, will retry later:', e);
        continue; // leave unsynced, try again next time we come online
      }
    }
    // No endpoint configured: mark as locally ready-to-upload rather
    // than pretending a network call succeeded.
    await markSynced(rec.id);
  }
}

// ---------- Tabs ----------
document.querySelectorAll('.tab').forEach(tab => {
  tab.addEventListener('click', () => {
    document.querySelectorAll('.tab').forEach(t => t.classList.remove('active'));
    document.querySelectorAll('.panel').forEach(p => p.classList.remove('active'));
    tab.classList.add('active');
    document.getElementById('panel-' + tab.dataset.tab).classList.add('active');
  });
});

// ============================================================
// TRANSLATE — real on-device MarianMT model via transformers.js
// ============================================================
let translator = null;

async function loadModel() {
  const statusEl = document.getElementById('modelStatus');
  const bar = document.getElementById('progressBar');
  const fill = document.getElementById('progressFill');
  const loadBtn = document.getElementById('loadModelBtn');

  loadBtn.disabled = true;
  bar.style.display = 'block';
  statusEl.textContent = 'Downloading model (first time only)…';

  try {
    const { pipeline } = await import('https://cdn.jsdelivr.net/npm/@xenova/transformers@2.17.2');
    translator = await pipeline('translation', 'Xenova/opus-mt-en-es', {
      progress_callback: (p) => {
        if (p.status === 'progress' && p.total) {
          const pct = Math.round((p.loaded / p.total) * 100);
          fill.style.width = pct + '%';
          statusEl.textContent = `Downloading ${p.file || 'model'}… ${pct}%`;
        }
      }
    });
    statusEl.textContent = 'Model cached on this device — ready to translate offline.';
    fill.style.width = '100%';
  } catch (err) {
    console.error(err);
    statusEl.textContent = 'Could not load the model. Check your connection and try again.';
  } finally {
    loadBtn.disabled = false;
  }
}

async function runTranslate() {
  const input = document.getElementById('srcText').value.trim();
  const output = document.getElementById('translateOutput');
  if (!input) return;

  if (!translator) {
    output.textContent = 'Load the model first (button above) — one-time download, then works offline.';
    return;
  }

  output.textContent = 'Translating…';
  const result = await translator(input);
  const text = result[0].translation_text;
  output.textContent = text;

  await addToQueue('translation', { input, output: text });
}

document.getElementById('loadModelBtn').addEventListener('click', loadModel);
document.getElementById('translateBtn').addEventListener('click', runTranslate);

// ============================================================
// LESSONS — offline quiz module
// ============================================================
const LESSONS = [
  {
    q: 'Boiling water for how long makes it safe to drink?',
    options: ['A few seconds', 'At least 1 minute at a rolling boil', 'It does not need boiling', 'Only in winter'],
    correct: 1
  },
  {
    q: 'Which storage method best protects seed grain from pests?',
    options: ['Open sacks in direct sun', 'Sealed containers with dry seed', 'Loose piles on the floor', 'Wet cloth wrapping'],
    correct: 1
  },
  {
    q: 'A child with diarrhea for more than 2 days should:',
    options: ['Wait it out at home', 'Stop all fluids', 'Be seen by a health worker', 'Only eat dry bread'],
    correct: 2
  }
];

function renderLessons() {
  const list = document.getElementById('lessonsList');
  list.innerHTML = LESSONS.map((lesson, li) => `
    <div class="lesson-card">
      <h3>Question ${li + 1}</h3>
      <p>${lesson.q}</p>
      ${lesson.options.map((opt, oi) => `
        <button class="opt" data-lesson="${li}" data-opt="${oi}">${opt}</button>
      `).join('')}
    </div>
  `).join('');

  list.querySelectorAll('.opt').forEach(btn => {
    btn.addEventListener('click', async () => {
      const li = +btn.dataset.lesson;
      const oi = +btn.dataset.opt;
      const lesson = LESSONS[li];
      const card = btn.closest('.lesson-card');
      const isCorrect = oi === lesson.correct;

      card.querySelectorAll('.opt').forEach((b, i) => {
        b.disabled = true;
        if (i === lesson.correct) b.classList.add('correct');
        else if (i === oi) b.classList.add('wrong');
      });

      await addToQueue('lesson', { question: lesson.q, correct: isCorrect });
    });
  });
}

// ============================================================
// DIAGNOSTICS — deterministic on-device screening checklist
// ============================================================
const SYMPTOMS = [
  'Fever for more than 3 days',
  'Persistent cough for more than 2 weeks',
  'Unexplained weight loss',
  'Night sweats',
  'Difficulty breathing',
  'Diarrhea for more than 3 days'
];

function renderChecks() {
  const list = document.getElementById('checksList');
  list.innerHTML = SYMPTOMS.map((s, i) => `
    <div class="check-row">
      <input type="checkbox" id="sym${i}">
      <label for="sym${i}">${s}</label>
    </div>
  `).join('');
}

document.getElementById('runCheckBtn').addEventListener('click', async () => {
  const checked = SYMPTOMS.map((s, i) => document.getElementById('sym' + i).checked);
  const flagCount = checked.filter(Boolean).length;
  const resultEl = document.getElementById('diagResult');

  const highRisk = flagCount >= 2;
  resultEl.innerHTML = `
    <div class="result-box ${highRisk ? 'result-high' : 'result-low'}">
      <h4>${highRisk ? 'Recommend follow-up' : 'Low immediate concern'}</h4>
      <p>${flagCount} of ${SYMPTOMS.length} flags checked. ${highRisk
        ? 'This case has been queued for a health worker to review — not a diagnosis.'
        : 'Continue routine monitoring. Queued locally for the record.'}</p>
    </div>
  `;

  await addToQueue('screening', { flagCount, total: SYMPTOMS.length, highRisk });
});

// ---------- Settings ----------
document.getElementById('saveEndpointBtn').addEventListener('click', () => {
  const val = document.getElementById('syncEndpointInput').value.trim();
  setSyncEndpoint(val || null);
  if (navigator.onLine) trySync();
});

// ---------- Init ----------
renderLessons();
renderChecks();
renderQueue();
renderEndpointStatus();
updateStatus();
