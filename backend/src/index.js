/**
 * DataNomad sync backend — Cloudflare Worker + Workers KV.
 *
 * Endpoints:
 *   POST /sync       Accepts one queued record from a field device, stores it.
 *   GET  /records     Returns the most recent records as JSON (for the dashboard, or your own tooling).
 *   GET  /dashboard    A minimal HTML admin view — see what's synced from the field.
 *   GET  /health      Plain health check.
 *
 * Storage: Workers KV, keyed by `record:<timestamp>:<random>` so listing
 * naturally sorts newest-first when reversed. Fine for a demo / small
 * deployment; swap for D1 (SQLite at the edge) if you need real queries.
 */

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type',
};

function json(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...CORS_HEADERS },
  });
}

function html(body, status = 200) {
  return new Response(body, {
    status,
    headers: { 'Content-Type': 'text/html;charset=UTF-8', ...CORS_HEADERS },
  });
}

export default {
  async fetch(request, env) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: CORS_HEADERS });
    }

    if (url.pathname === '/health') {
      return json({ ok: true, service: 'datanomad-sync' });
    }

    if (url.pathname === '/sync' && request.method === 'POST') {
      return handleSync(request, env);
    }

    if (url.pathname === '/records' && request.method === 'GET') {
      return handleRecords(request, env);
    }

    if (url.pathname === '/dashboard' && request.method === 'GET') {
      return handleDashboard();
    }

    if (url.pathname === '/' || url.pathname === '') {
      return json({
        service: 'datanomad-sync',
        endpoints: ['/sync (POST)', '/records (GET)', '/dashboard (GET)', '/health (GET)'],
      });
    }

    return json({ error: 'Not found' }, 404);
  },
};

async function handleSync(request, env) {
  let record;
  try {
    record = await request.json();
  } catch {
    return json({ error: 'Invalid JSON body' }, 400);
  }

  if (!record || typeof record.type !== 'string') {
    return json({ error: 'Record must include a "type" field' }, 400);
  }

  const receivedAt = new Date().toISOString();
  const key = `record:${Date.now()}:${crypto.randomUUID().slice(0, 8)}`;

  const stored = {
    id: key,
    type: record.type,
    payload: record.payload ?? null,
    deviceTimestamp: record.timestamp ?? null,
    receivedAt,
  };

  await env.DATANOMAD_KV.put(key, JSON.stringify(stored));

  return json({ ok: true, stored });
}

async function handleRecords(request, env) {
  const url = new URL(request.url);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 200);

  const list = await env.DATANOMAD_KV.list({ prefix: 'record:', limit: 1000 });
  const keys = list.keys.map(k => k.name).sort().reverse().slice(0, limit);

  const records = await Promise.all(
    keys.map(async (k) => {
      const val = await env.DATANOMAD_KV.get(k);
      return val ? JSON.parse(val) : null;
    })
  );

  return json({ count: records.length, records: records.filter(Boolean) });
}

async function handleDashboard() {
  return html(`<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>DataNomad — Sync Dashboard</title>
<style>
  :root{ --night:#1B2430; --paper:#F1ECE0; --signal:#E2793D; --steady:#7C9473; --ink-soft:#565349; }
  *{ box-sizing:border-box; }
  body{ margin:0; font-family:'Space Grotesk', system-ui, sans-serif; background:var(--paper); color:var(--night); }
  header{ background:var(--night); color:var(--paper); padding:20px 28px; display:flex; justify-content:space-between; align-items:center; }
  header h1{ font-size:18px; margin:0; }
  header .sub{ font-family:monospace; font-size:12px; opacity:0.6; }
  main{ max-width:920px; margin:0 auto; padding:28px; }
  table{ width:100%; border-collapse:collapse; background:#fff; border-radius:6px; overflow:hidden; box-shadow:0 1px 3px rgba(0,0,0,0.06); }
  th, td{ text-align:left; padding:10px 14px; font-size:13.5px; border-bottom:1px solid rgba(35,38,43,0.08); }
  th{ font-family:monospace; text-transform:uppercase; font-size:10.5px; letter-spacing:0.05em; color:var(--ink-soft); background:rgba(220,208,180,0.3); }
  .type{ font-family:monospace; font-size:11px; padding:2px 8px; border-radius:20px; background:rgba(124,148,115,0.15); color:#4f6349; display:inline-block; }
  .empty{ padding:40px; text-align:center; color:var(--ink-soft); font-size:14px; }
  .refresh{ font-family:monospace; font-size:12px; background:none; border:1px solid rgba(241,236,224,0.3); color:var(--paper); padding:6px 12px; border-radius:3px; cursor:pointer; }
</style>
</head>
<body>
<header>
  <div>
    <h1>DataNomad — synced records</h1>
    <div class="sub">live view of what field devices have uploaded</div>
  </div>
  <button class="refresh" onclick="load()">Refresh</button>
</header>
<main>
  <table id="tbl" style="display:none;">
    <thead><tr><th>Type</th><th>Summary</th><th>Device time</th><th>Received</th></tr></thead>
    <tbody id="rows"></tbody>
  </table>
  <div id="empty" class="empty">No records synced yet.</div>
</main>
<script>
function summarize(r){
  const p = r.payload || {};
  if(r.type === 'translation') return \`"\${p.input || ''}" → "\${p.output || ''}"\`;
  if(r.type === 'lesson') return \`\${p.question || ''} — \${p.correct ? 'correct' : 'missed'}\`;
  if(r.type === 'screening') return \`\${p.flagCount ?? '?'} of \${p.total ?? '?'} flags\${p.highRisk ? ' (follow-up)' : ''}\`;
  return JSON.stringify(p);
}
async function load(){
  const res = await fetch('/records?limit=100');
  const data = await res.json();
  const rows = document.getElementById('rows');
  const tbl = document.getElementById('tbl');
  const empty = document.getElementById('empty');
  if(!data.records || data.records.length === 0){
    tbl.style.display = 'none'; empty.style.display = 'block'; return;
  }
  tbl.style.display = 'table'; empty.style.display = 'none';
  rows.innerHTML = data.records.map(r => \`
    <tr>
      <td><span class="type">\${r.type}</span></td>
      <td>\${summarize(r)}</td>
      <td>\${r.deviceTimestamp ? new Date(r.deviceTimestamp).toLocaleString() : '—'}</td>
      <td>\${new Date(r.receivedAt).toLocaleString()}</td>
    </tr>\`).join('');
}
load();
</script>
</body>
</html>`);
}
