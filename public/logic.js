const datasetEl = document.getElementById('dataset');
const pastedEl  = document.getElementById('pasted');
const doEmbedEl = document.getElementById('doEmbed');
const sysEl     = document.getElementById('sys');

const thinkingPanel = document.getElementById('thinkingPanel');
const logEl = document.getElementById('log');
const schemaPanel = document.getElementById('schemaPanel');
const schemaOut = document.getElementById('schemaOut');

const searchPanel = document.getElementById('searchPanel');
const searchBox = document.getElementById('searchBox');
const searchResults = document.getElementById('searchResults');

const chartsPanel = document.getElementById('chartsPanel');
const chartsEl = document.getElementById('charts');
const sysReplanEl = document.getElementById('sysReplan');

const tablesPanel = document.getElementById('tablesPanel');
const tablesEl = document.getElementById('tables');
const btnExport = document.getElementById('btnExport');

// Enter to run
datasetEl.addEventListener('keydown', (e) => { if (e.key === 'Enter') runDataset(); });
// Ctrl/Cmd+Enter for textarea
pastedEl.addEventListener('keydown', (e) => { if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) runDataset(); });

// Replan charts from memory
sysReplanEl.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const sys = (sysReplanEl.value || '').trim();
  const res = await fetch('/replan_charts', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ sys })
  });
  if (!res.ok) { appendLog(`✖ Replan error: ${res.status} ${res.statusText}`); return; }
  const { specs } = await res.json();
  renderChartsFromSpecs(specs);
});

// Semantic search
searchBox.addEventListener('keydown', async (e) => {
  if (e.key !== 'Enter') return;
  const q = (searchBox.value || '').trim();
  if (!q) return;
  const queries = q.split(';').map(s => s.trim()).filter(Boolean);
  searchResults.innerHTML = 'Searching…';
  let payload, endpoint;
  if (queries.length > 1) {
    endpoint = '/vector_search_multi';
    payload = { queries, k: 5 };
  } else {
    endpoint = '/vector_search';
    payload = { q, k: 5 };
  }
  const res = await fetch(endpoint, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(payload)
  });
  if (!res.ok) { searchResults.innerHTML = `✖ ${res.status} ${res.statusText}`; return; }
  const data = await res.json();
  if (data.warn && data.debug) {
    searchResults.innerHTML = `<div>⚠ ${escapeHtml(data.warn)}<br/><span class="small">${escapeHtml(data.debug)}</span></div>`;
    return;
  }
  renderSearchResults(data);
});

// Export CSV
btnExport.addEventListener('click', async () => {
  if (!window.__lastTable) return;
  const { columns, rows } = window.__lastTable;
  const res = await fetch('/export_csv', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ columns, rows })
  });
  if (!res.ok) { appendLog(`✖ Export error: ${res.status} ${res.statusText}`); return; }
  const blob = await res.blob();
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = 'data.csv';
  document.body.appendChild(a); a.click(); a.remove();
  URL.revokeObjectURL(url);
});

async function runDataset() {
  thinkingPanel.hidden = false;
  schemaPanel.hidden = true;
  tablesPanel.hidden = true;
  searchPanel.hidden = true;
  chartsPanel.hidden = true;

  logEl.textContent = '';
  schemaOut.textContent = '';
  tablesEl.innerHTML = '';
  chartsEl.innerHTML = '';
  searchResults.innerHTML = '';

  const body = {
    url: (datasetEl.value || '').trim() || undefined,
    text: (pastedEl.value || '').trim() || undefined,
    sys: (sysEl.value || '').trim() || undefined,
    embed: !!doEmbedEl.checked
  };

  appendLog(`→ Starting${body.url ? ' URL: ' + body.url : ' pasted data'}`);

  const res = await fetch('/dataset_stream', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });

  if (!res.ok || !res.body) {
    appendLog(`✖ Error: ${res.status} ${res.statusText}`);
    return;
  }

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = '';

  while (true) {
    const { value, done } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });

    let idx;
    while ((idx = buffer.indexOf('\n\n')) >= 0) {
      const chunk = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      const lines = chunk.split('\n');
      let event = 'message';
      let data = '';
      for (const ln of lines) {
        if (ln.startsWith('event:')) event = ln.slice(6).trim();
        if (ln.startsWith('data:')) data += ln.slice(5).trim();
      }
      handleEvent(event, data);
    }
  }
  appendLog('✓ Done');
}

function handleEvent(event, dataStr) {
  let payload = {};
  try { payload = dataStr ? JSON.parse(dataStr) : {}; }
  catch { appendLog(`(parse) ${event}: ${dataStr}`); return; }

  if (event === 'log') {
    appendLog(payload.msg);
  } else if (event === 'warn') {
    appendLog(`⚠ ${payload.msg}`);
  } else if (event === 'schema') {
    schemaPanel.hidden = false;
    schemaOut.textContent = JSON.stringify(payload, null, 2);
    // show search (above table) regardless of embedding result
    searchPanel.hidden = false;
  } else if (event === 'insights') {
    chartsPanel.hidden = false;
    renderChartsFromSpecs(payload.specs || []);
  } else if (event === 'table') {
    // Always render table LAST (under others)
    window.__lastTable = payload.table;
    tablesPanel.hidden = false;
    tablesEl.innerHTML = renderNamedTable(payload.table);
  } else if (event === 'vectorized') {
    appendLog(`Embedded rows: ${payload.count}`);
  } else if (event === 'error') {
    appendLog(`✖ ${payload.msg}`);
  }
}

function renderChartsFromSpecs(specs) {
  const { React, ReactDOM, BarCountChart, LineMetricChart, PieSimple } = window.__charts || {};
  if (!React) return;
  chartsEl.innerHTML = '';
  const root = ReactDOM.createRoot(chartsEl);

  const table = window.__lastTable;
  const items = [];
  if (Array.isArray(specs) && specs.length && table) {
    const { rows } = table;
    for (const s of specs) {
      if (!s || !s.type || !s.x) continue;
      const title = s.title || `${s.type} of ${s.y || 'count'} by ${s.x}`;
      if (s.type === "bar" && (!s.y || s.agg === "count")) {
        const data = groupCount(rows, s.x);
        items.push(window.__charts.React.createElement(BarCountChart, { key: title, title, data, xKey: s.x }));
      } else if (s.type === "line" && s.y) {
        const grouped = groupAgg(rows, s.x, s.y, s.agg || "mean");
        items.push(window.__charts.React.createElement(LineMetricChart, { key: title, title, data: grouped, xKey: s.x, yKey: s.y }));
      } else if (s.type === "pie" && s.y) {
        const grouped = groupAgg(rows, s.x, s.y, s.agg || "sum");
        items.push(window.__charts.React.createElement(PieSimple, { key: title, title, data: grouped, nameKey: s.x, valKey: s.y }));
      }
    }
  }
  root.render(window.__charts.React.createElement(window.__charts.React.Fragment, null, items));
}

/* ---------- Aggregation helpers ---------- */
function groupCount(rows, key) {
  const map = new Map();
  rows.forEach(r => {
    const k = (r[key] ?? "").toString().trim() || "(blank)";
    map.set(k, (map.get(k) || 0) + 1);
  });
  const arr = [...map.entries()].map(([k,count]) => ({ [key]: k, count }));
  arr.sort((a,b)=>b.count-a.count);
  return arr.slice(0, 40);
}
function groupAgg(rows, x, y, agg) {
  const map = new Map();
  for (const r of rows) {
    const k = (r[x] ?? "").toString().trim() || "(blank)";
    const raw = r[y];
    const v = typeof raw === "number" ? raw : parseFloat(String(raw).replace(/,/g,""));
    if (Number.isNaN(v)) continue;
    const cur = map.get(k) || { sum:0, n:0 };
    cur.sum += v; cur.n += 1;
    map.set(k, cur);
  }
  const arr = [...map.entries()].map(([k, s]) => ({
    [x]: k,
    [y]: agg === "mean" ? s.sum / s.n : s.sum
  }));
  arr.sort((a,b)=> (b[y]??0) - (a[y]??0));
  return arr.slice(0, 40);
}

/* ---------- UI helpers ---------- */
function appendLog(line) {
  const ts = new Date().toLocaleTimeString();
  logEl.innerHTML += `<b>[${ts}]</b> ${escapeHtml(line)}\n`;
  logEl.scrollTop = logEl.scrollHeight;
}

function renderNamedTable(t) {
  const head = '<tr>' + t.columns.map(h=>`<th>${escapeHtml(h)}</th>`).join('') + '</tr>';
  const body = (t.rows || []).slice(0, 300).map(r => {
    return '<tr>' + t.columns.map(c => {
      const val = r[c];
      if (c === 'url' && val) return `<td><a href="${escapeAttr(String(val))}" target="_blank" rel="noreferrer">${escapeHtml(String(val))}</a></td>`;
      return `<td>${escapeHtml(String(val ?? ""))}</td>`;
    }).join('') + '</tr>';
  }).join('');
  return `
  <div class="source-card">
    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:8px">
      <strong>${escapeHtml(t.name)}</strong>
      <a href="${escapeAttr(t.url)}" target="_blank" rel="noreferrer">open source</a>
    </div>
    <div style="overflow:auto">
      <table>${head}${body}</table>
    </div>
  </div>`;
}

function renderSearchResults(data) {
  if (Array.isArray(data.results)) {
    searchResults.innerHTML = data.results.map(item => {
      const r = item.result;
      if (r && r.matches) return blockForMatches(item.q, r.matches);
      if (r && r.warn)  return `<div><b>${escapeHtml(item.q)}</b><br/>⚠ ${escapeHtml(r.warn)}${r.debug ? `<br/><span class="small">${escapeHtml(r.debug)}</span>`:''}</div>`;
      return `<div><b>${escapeHtml(item.q)}</b><br/>No results.</div>`;
    }).join('<hr/>');
  } else if (data && data.matches) {
    searchResults.innerHTML = blockForMatches(null, data.matches);
  } else if (data && data.warn) {
    searchResults.innerHTML = `⚠ ${escapeHtml(data.warn)}${data.debug ? `<br/><span class="small">${escapeHtml(data.debug)}</span>`:''}`;
  } else {
    searchResults.innerHTML = 'No results.';
  }
}

function blockForMatches(title, matches) {
  const items = matches.map(m => {
    const p = m.metadata || {};
    const src = p.url ? `<a href="${escapeAttr(String(p.url))}" target="_blank" rel="noreferrer">source</a>` : '';
    const prev = p.preview ? escapeHtml(String(p.preview)) : '';
    return `<div style="margin:8px 0">
      <div><b>score:</b> ${Number(m.score).toFixed(3)} ${src ? `• ${src}` : ''}</div>
      <div class="small">${prev}</div>
    </div>`;
  }).join('');
  return `<div>${title ? `<div><b>${escapeHtml(title)}</b></div>` : ''}${items || 'No matches.'}</div>`;
}

function escapeHtml(s){return (s||'').replace(/[&<>"']/g,m=>({ '&':'&amp;','<':'&lt;','>':'&gt;','"':'&quot;' }[m]))}
function escapeAttr(s){return String(s).replace(/"/g, '&quot;')}
