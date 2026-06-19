/**
 * The dashboard's single-page frontend, embedded as a string so it ships in the
 * bundle with no asset pipeline. Vanilla JS, polls /api/state. Deliberately thin
 * (§5.3): a control surface, not a terminal.
 *
 * Layout: mobile-first STACKED CARDS. Each session is a card with a header
 * (id + status pill), metadata rows, a prominent full-width primary "Attach
 * (mosh)" action, and a compact secondary action row (log / cmd / kill).
 * Pending approvals render as attention-grabbing cards at the top. On iPad /
 * wide viewports the cards reflow into a responsive multi-column grid.
 *
 * HARD CONSTRAINT: this whole document lives inside a TS backtick template, so
 * the embedded <script> must NEVER use a backtick or the ${'$'}{ sequence —
 * string concatenation with + only.
 */
export const DASHBOARD_HTML = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1, viewport-fit=cover" />
<meta name="color-scheme" content="dark" />
<meta name="apple-mobile-web-app-capable" content="yes" />
<title>Switchboard</title>
<style>
  :root {
    color-scheme: dark;
    --bg: #0f1115;
    --bg-elev: #151821;
    --bg-elev2: #1c2027;
    --line: #262a33;
    --line-soft: #21262d;
    --text: #e6e6e6;
    --muted: #8b949e;
    --muted2: #6e7681;
    --green: #3fb950;
    --amber: #d29922;
    --blue: #58a6ff;
    --red: #f85149;
    --green-bg: #163a2b;
    --amber-bg: #3d2f12;
    --blue-bg: #12283d;
    --safe-top: env(safe-area-inset-top, 0px);
    --safe-bottom: env(safe-area-inset-bottom, 0px);
    --safe-left: env(safe-area-inset-left, 0px);
    --safe-right: env(safe-area-inset-right, 0px);
  }
  * { box-sizing: border-box; }
  html { -webkit-text-size-adjust: 100%; }
  body {
    margin: 0;
    font: 15px/1.5 -apple-system, system-ui, "Segoe UI", sans-serif;
    background: var(--bg);
    color: var(--text);
    -webkit-font-smoothing: antialiased;
    padding-bottom: calc(24px + var(--safe-bottom));
    overscroll-behavior-y: contain;
  }

  /* ---- header ---- */
  header {
    position: sticky;
    top: 0;
    z-index: 20;
    display: flex;
    align-items: center;
    gap: 10px;
    padding: calc(12px + var(--safe-top)) calc(16px + var(--safe-right)) 12px calc(16px + var(--safe-left));
    background: rgba(15, 17, 21, 0.85);
    -webkit-backdrop-filter: saturate(160%) blur(12px);
    backdrop-filter: saturate(160%) blur(12px);
    border-bottom: 1px solid var(--line);
  }
  header .dot {
    width: 9px; height: 9px; border-radius: 50%;
    background: var(--green);
    box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.5);
    flex: none;
  }
  header.live .dot { animation: pulse 2.5s ease-out infinite; }
  @keyframes pulse {
    0% { box-shadow: 0 0 0 0 rgba(63, 185, 80, 0.45); }
    70% { box-shadow: 0 0 0 7px rgba(63, 185, 80, 0); }
    100% { box-shadow: 0 0 0 0 rgba(63, 185, 80, 0); }
  }
  header h1 { font-size: 17px; margin: 0; font-weight: 650; letter-spacing: -0.01em; }
  header #meta { color: var(--muted); font-size: 13px; margin-left: auto; text-align: right; font-variant-numeric: tabular-nums; }
  @media (prefers-reduced-motion: reduce) {
    header.live .dot { animation: none; }
    * { transition: none !important; }
  }

  /* ---- layout ---- */
  main {
    padding: 16px calc(16px + var(--safe-right)) 0 calc(16px + var(--safe-left));
    max-width: 1180px;
    margin: 0 auto;
  }
  section { margin-bottom: 26px; }
  h2 {
    font-size: 12px; text-transform: uppercase; letter-spacing: .07em;
    color: var(--muted); margin: 0 0 12px; font-weight: 600;
    display: flex; align-items: center; gap: 8px;
  }
  h2 .count {
    background: var(--bg-elev2); color: var(--muted);
    border-radius: 999px; padding: 1px 8px; font-size: 11px; letter-spacing: 0;
    font-variant-numeric: tabular-nums;
  }
  h2.alert { color: var(--amber); }
  h2.alert .count { background: var(--amber-bg); color: var(--amber); }

  .empty {
    color: var(--muted2);
    padding: 20px 14px; text-align: center;
    border: 1px dashed var(--line-soft); border-radius: 12px;
    background: var(--bg-elev);
  }

  /* ---- tab bar (Native / Sandboxed) ---- */
  #tabs {
    display: flex; gap: 6px;
    max-width: 1180px; margin: 0 auto;
    padding: 12px calc(16px + var(--safe-right)) 0 calc(16px + var(--safe-left));
  }
  #tabs button {
    min-height: 40px; padding: 0 16px; font-weight: 600; font-size: 14px;
    background: transparent; border: 1px solid transparent; color: var(--muted);
    border-radius: 10px; position: relative;
  }
  #tabs button.active { background: var(--bg-elev); border-color: var(--line); color: var(--text); }
  #tabs button[hidden] { display: none; }
  #tabs .tab-badge {
    background: var(--amber-bg); color: var(--amber);
    border-radius: 999px; padding: 0 7px; margin-left: 7px; font-size: 11px;
    font-variant-numeric: tabular-nums; min-width: 18px; line-height: 18px; display: inline-block;
  }
  #tabs .tab-badge[hidden] { display: none; }

  /* ---- sandboxed spawn form ---- */
  .ic-form {
    background: var(--bg-elev); border: 1px solid var(--line-soft);
    border-radius: 14px; padding: 14px; display: flex; flex-direction: column; gap: 10px;
  }
  .ic-form label { font-size: 11px; text-transform: uppercase; letter-spacing: .05em; color: var(--muted2); }
  .ic-form select, .ic-form textarea {
    font: inherit; font-size: 14px; width: 100%;
    background: var(--bg-elev2); color: var(--text);
    border: 1px solid var(--line); border-radius: 10px; padding: 10px 12px;
  }
  .ic-form textarea { min-height: 64px; resize: vertical; }
  .ic-form .spawn { background: var(--blue-bg); border-color: #1f6feb; color: var(--blue); font-weight: 650; }
  @media (hover: hover) { .ic-form .spawn:hover { background: #16385c; border-color: #2f81f7; } }
  .card.session .ic-note { color: var(--muted2); font-size: 12px; }

  /* ---- grid of cards ---- */
  .grid {
    display: grid;
    grid-template-columns: 1fr;
    gap: 12px;
  }

  /* ---- card ---- */
  .card {
    background: var(--bg-elev);
    border: 1px solid var(--line-soft);
    border-radius: 14px;
    padding: 14px;
    display: flex;
    flex-direction: column;
    gap: 12px;
  }
  .card-head {
    display: flex; align-items: center; gap: 10px;
    min-width: 0;
  }
  .card-head .sid {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 14px; font-weight: 600;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
    min-width: 0;
  }

  /* ---- status pill ---- */
  .pill {
    display: inline-flex; align-items: center; gap: 6px;
    padding: 3px 10px; border-radius: 999px;
    font-size: 12px; font-weight: 600; letter-spacing: .01em;
    white-space: nowrap; flex: none;
  }
  .pill::before { content: ""; width: 6px; height: 6px; border-radius: 50%; background: currentColor; }
  .pill.running { background: var(--green-bg); color: var(--green); }
  .pill.awaiting_approval { background: var(--amber-bg); color: var(--amber); }
  .pill.done, .pill.killed, .pill.failed { background: var(--bg-elev2); color: var(--muted); }
  .pill.failed { color: var(--red); }
  .pill.starting { background: var(--blue-bg); color: var(--blue); }

  /* ---- metadata rows ---- */
  .meta-rows { display: flex; flex-direction: column; gap: 6px; }
  .meta-row {
    display: flex; align-items: baseline; gap: 10px;
    font-size: 13px; min-width: 0;
  }
  .meta-row .k {
    color: var(--muted2); flex: none; width: 84px;
    text-transform: uppercase; letter-spacing: .04em; font-size: 11px;
  }
  .meta-row .v {
    color: var(--text); min-width: 0;
    overflow: hidden; text-overflow: ellipsis; word-break: break-word;
    font-variant-numeric: tabular-nums;
  }
  .meta-row .v.path {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12px; color: var(--muted);
  }

  /* ---- buttons ---- */
  button, a.btn {
    font: inherit; font-size: 14px; font-weight: 500;
    background: var(--bg-elev2); color: var(--text);
    border: 1px solid var(--line); border-radius: 10px;
    cursor: pointer; -webkit-tap-highlight-color: transparent;
    display: inline-flex; align-items: center; justify-content: center; gap: 7px;
    min-height: 44px; padding: 0 14px;
    transition: background .12s ease, border-color .12s ease, transform .06s ease;
    text-decoration: none; user-select: none;
  }
  button:active, a.btn:active { transform: scale(0.985); }
  @media (hover: hover) {
    button:hover, a.btn:hover { background: var(--line); border-color: #3a4150; }
  }

  /* primary full-width attach */
  a.btn.attach {
    background: var(--blue-bg); border-color: #1f6feb; color: var(--blue);
    width: 100%; font-weight: 650; min-height: 48px; font-size: 15px;
  }
  @media (hover: hover) {
    a.btn.attach:hover { background: #16385c; border-color: #2f81f7; }
  }
  a.btn.attach .hint {
    font-size: 11px; font-weight: 600; letter-spacing: .04em;
    color: var(--blue); opacity: .7; text-transform: uppercase;
    border: 1px solid currentColor; border-radius: 6px; padding: 1px 6px;
  }

  /* secondary action row */
  .acts { display: flex; gap: 8px; }
  .acts button { flex: 1; padding: 0 8px; }
  button.kill {
    background: #2a141a; border-color: #5c2a2f; color: var(--red);
  }
  @media (hover: hover) { button.kill:hover { background: #3a1620; border-color: #b62324; } }
  button.rc { background: var(--blue-bg); border-color: #1f6feb; color: var(--blue); }
  @media (hover: hover) { button.rc:hover { background: #16385c; border-color: #2f81f7; } }

  /* ---- approval card ---- */
  .card.approval {
    border-color: #5a4410;
    background: linear-gradient(180deg, #1c160a 0%, #15130c 100%);
    box-shadow: 0 0 0 1px rgba(210, 153, 34, 0.08), 0 6px 22px -12px rgba(210, 153, 34, 0.35);
  }
  .card.approval .tool { font-size: 15px; font-weight: 650; }
  .card.approval .sub { color: var(--muted); font-size: 12px; margin-top: 2px; }
  .card.approval pre.req {
    margin: 0; background: #0a0c10; border: 1px solid var(--line-soft);
    border-radius: 10px; padding: 10px 12px; overflow: auto;
    font-size: 12px; max-height: 140px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    color: var(--muted); white-space: pre-wrap; word-break: break-word;
  }
  .card.approval .acts button { min-height: 46px; font-weight: 600; }
  button.approve { background: var(--green-bg); border-color: #2ea043; color: var(--green); }
  button.deny { background: #2a141a; border-color: #5c2a2f; color: var(--red); }
  @media (hover: hover) {
    button.approve:hover { background: #18452f; border-color: #3fb950; }
    button.deny:hover { background: #3a1620; border-color: #b62324; }
  }

  /* ---- log viewer ---- */
  #logwrap {
    position: fixed; inset: 0; z-index: 40;
    display: none; flex-direction: column;
    background: rgba(8, 9, 12, 0.72);
    -webkit-backdrop-filter: blur(4px); backdrop-filter: blur(4px);
    padding: calc(8px + var(--safe-top)) calc(8px + var(--safe-right)) calc(8px + var(--safe-bottom)) calc(8px + var(--safe-left));
  }
  #logwrap.open { display: flex; }
  .log-panel {
    margin: auto; width: 100%; max-width: 920px; max-height: 100%;
    display: flex; flex-direction: column;
    background: var(--bg-elev); border: 1px solid var(--line);
    border-radius: 14px; overflow: hidden;
    box-shadow: 0 24px 60px -20px rgba(0,0,0,0.7);
  }
  .log-head {
    display: flex; align-items: center; gap: 10px;
    padding: 12px 14px; border-bottom: 1px solid var(--line-soft);
  }
  .log-head .t {
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-weight: 600; font-size: 14px;
    overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
  }
  .log-head button.close { margin-left: auto; min-height: 40px; min-width: 44px; padding: 0 12px; }
  pre#log {
    margin: 0; flex: 1; overflow: auto;
    background: #0a0c10; padding: 12px 14px;
    font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
    font-size: 12.5px; line-height: 1.45; color: var(--text);
    white-space: pre; -webkit-overflow-scrolling: touch;
  }

  /* ---- toast (copy feedback) ---- */
  #toast {
    position: fixed; left: 50%; transform: translateX(-50%) translateY(20px);
    bottom: calc(20px + var(--safe-bottom)); z-index: 60;
    background: var(--bg-elev2); border: 1px solid var(--line);
    color: var(--text); padding: 10px 16px; border-radius: 10px;
    font-size: 13px; opacity: 0; pointer-events: none;
    transition: opacity .2s ease, transform .2s ease; max-width: 90vw;
    box-shadow: 0 10px 30px -10px rgba(0,0,0,0.6);
  }
  #toast.show { opacity: 1; transform: translateX(-50%) translateY(0); }

  /* ---- responsive: iPad / wide reflow into multi-column grid ---- */
  @media (min-width: 720px) {
    .grid { grid-template-columns: repeat(2, 1fr); gap: 14px; }
  }
  @media (min-width: 1080px) {
    .grid.sessions-grid { grid-template-columns: repeat(3, 1fr); }
  }
  /* iPhone landscape: a touch more breathing room without going full grid */
  @media (max-width: 719px) and (orientation: landscape) {
    .grid { grid-template-columns: repeat(2, 1fr); }
  }
</style>
</head>
<body>
<header id="hdr"><span class="dot"></span><h1>Switchboard</h1><span id="meta">connecting…</span></header>
<nav id="tabs">
  <button id="tab-btn-native" class="active" type="button">Native</button>
  <button id="tab-btn-sandboxed" type="button" hidden>Sandboxed<span class="tab-badge" id="ic-badge" hidden>0</span></button>
</nav>
<main>
  <div id="tab-native">
    <section id="approvals-section" hidden>
      <h2 class="alert">Pending approvals <span class="count" id="ap-count">0</span></h2>
      <div class="grid" id="approvals"></div>
    </section>
    <section>
      <h2>Sessions <span class="count" id="sess-count">0</span></h2>
      <div class="grid sessions-grid" id="sessions"><div class="empty">no sessions</div></div>
    </section>
    <section id="coord-section" hidden>
      <h2>Coordinations <span class="count" id="coord-count">0</span></h2>
      <div class="grid" id="coords"></div>
    </section>
  </div>
  <div id="tab-sandboxed" hidden>
    <section>
      <h2>New sandboxed session</h2>
      <div class="ic-form">
        <div>
          <label for="ic-persona">Persona</label>
          <select id="ic-persona"><option value="">(default)</option></select>
        </div>
        <div>
          <label for="ic-task">Task</label>
          <textarea id="ic-task" placeholder="e.g. triage CVEs affecting the deps in this workspace"></textarea>
        </div>
        <button class="spawn" id="ic-spawn" type="button">Spawn sandboxed session</button>
      </div>
    </section>
    <section id="ic-esc-section" hidden>
      <h2 class="alert">Sandbox escalations <span class="count" id="ic-esc-count">0</span></h2>
      <div class="grid" id="ic-escalations"></div>
    </section>
    <section>
      <h2>Sandboxed sessions <span class="count" id="ic-sess-count">0</span></h2>
      <div class="grid sessions-grid" id="ic-sessions"><div class="empty">no sandboxed sessions</div></div>
    </section>
  </div>
</main>

<div id="logwrap" role="dialog" aria-modal="true" aria-label="Session log">
  <div class="log-panel">
    <div class="log-head">
      <span class="t" id="logtitle">Log</span>
      <button class="close" id="logclose" type="button">Close</button>
    </div>
    <pre id="log"></pre>
  </div>
</div>

<div id="toast" role="status" aria-live="polite"></div>

<script>
var LOG_LINES = 300;
var POLL_MS = 2500;
var $ = function (s) { return document.querySelector(s); };

var openLog = null;          // session id whose log is open ('ic:'+id for a sandbox digest), or null
var promptFav = 'switchboard'; // overridden by /api/state config
var tab = 'native';          // active tab: 'native' | 'sandboxed'
var icPersonasLoaded = false; // persona <select> populated once

function age(ms) {
  if (ms < 0) ms = 0;
  var s = Math.floor(ms / 1000);
  if (s < 60) return s + 's';
  var m = Math.floor(s / 60);
  if (m < 60) return m + 'm';
  var h = Math.floor(m / 60);
  return h < 24 ? h + 'h' : Math.floor(h / 24) + 'd';
}

var SB_TOKEN = (function () {
  try {
    var u = new URLSearchParams(location.search);
    var fromUrl = u.get('token');
    var t = fromUrl || sessionStorage.getItem('sbtoken') || '';
    if (t) sessionStorage.setItem('sbtoken', t);
    if (fromUrl) history.replaceState(null, '', location.pathname); // keep the token out of the address bar/history
    return t;
  } catch (e) { return ''; }
})();

function api(path, opts) {
  opts = opts || {};
  if (SB_TOKEN) {
    opts.headers = Object.assign({}, opts.headers || {}, { 'Authorization': 'Bearer ' + SB_TOKEN });
  }
  return fetch(path, opts).then(function (r) { return r.json(); });
}

function esc(s) {
  return String(s).replace(/[&<>]/g, function (c) {
    return c === '&' ? '&amp;' : c === '<' ? '&lt;' : '&gt;';
  });
}

function toast(msg) {
  var t = $('#toast');
  t.textContent = msg;
  t.classList.add('show');
  clearTimeout(toast._t);
  toast._t = setTimeout(function () { t.classList.remove('show'); }, 2200);
}

function copyText(text, label) {
  function fell() { window.prompt('Copy the command below:', text); }
  if (navigator.clipboard && navigator.clipboard.writeText) {
    navigator.clipboard.writeText(text).then(
      function () { toast((label || 'Copied') + ' to clipboard'); },
      fell
    );
  } else {
    fell();
  }
}

/* ---- approvals ---- */
function decide(id, decision, scope) {
  return api('/api/approvals/' + encodeURIComponent(id) + '/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: decision, scope: scope || 'once' })
  }).then(refresh);
}

/* ---- session actions ---- */
function kill(id) {
  if (!window.confirm('Kill ' + id + '?')) return;
  api('/api/sessions/' + encodeURIComponent(id) + '/kill', { method: 'POST' }).then(refresh);
}
function attachCmd(id) {
  api('/api/sessions/' + encodeURIComponent(id) + '/attach').then(function (r) {
    copyText(r.command, 'Attach command');
  });
}
function reconnectRc(id) {
  // Re-issue /remote-control into the native pane: re-enables Remote Control and
  // re-surfaces its reconnect link when the phone client has gone stale.
  api('/api/sessions/' + encodeURIComponent(id) + '/remote-control', { method: 'POST' }).then(function (r) {
    toast(r && r.sent ? 'Sent /remote-control to ' + id : (r && r.error) || 'Failed');
  });
}
function convert(id, target) {
  // Convert a gated streaming session into a native full-CLI session in place
  // (continue anywhere). DELIBERATE downgrade: the session becomes ungated (the CLI
  // handles permissions in-TTY), so confirm before doing it.
  var label = target === 'remote_control' ? 'phone CLI (remote-control)' : 'full local CLI';
  if (!window.confirm('Convert ' + id + ' to ' + label + '? This UNGATES the session — the CLI handles permissions in the terminal, not Switchboard. The conversation is preserved.')) return;
  api('/api/sessions/' + encodeURIComponent(id) + '/convert', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ target: target || 'local' })
  }).then(function (r) {
    toast(r && r.error ? r.error : 'Converted ' + id + ' → ' + label + ' (attach to continue)');
    refresh();
  });
}

/* ---- log viewer ---- */
function showLog(id) {
  openLog = id;
  $('#logwrap').classList.add('open');
  document.body.style.overflow = 'hidden';
  $('#log').textContent = 'loading…';
  refreshLog();
}
function closeLog() {
  openLog = null;
  $('#logwrap').classList.remove('open');
  document.body.style.overflow = '';
}
function refreshLog() {
  if (!openLog) return;
  var id = openLog;
  var pre = $('#log');
  // Preserve scroll position; only stick to bottom if already near the bottom.
  var atBottom = pre.scrollTop + pre.clientHeight >= pre.scrollHeight - 24;
  // A sandboxed session has no pane/transcript — show its bridge digest instead.
  if (id.indexOf('ic:') === 0) {
    var sid = id.slice(3);
    api('/api/ironcurtain/sessions/' + encodeURIComponent(sid) + '/digest').then(function (r) {
      if (openLog !== id) return;
      $('#logtitle').textContent = 'Digest — ' + sid;
      pre.textContent = (r && r.digest) || '(no digest)';
      if (atBottom) pre.scrollTop = pre.scrollHeight;
    });
    return;
  }
  api('/api/sessions/' + encodeURIComponent(id) + '/log?lines=' + LOG_LINES).then(function (r) {
    if (openLog !== id) return; // closed or switched while in-flight
    $('#logtitle').textContent = 'Log — ' + id;
    pre.textContent = r.log || '(empty)';
    if (atBottom) pre.scrollTop = pre.scrollHeight;
  });
}

/* ---- approval card build / update ---- */
function approvalCard(a) {
  var d = document.createElement('div');
  d.className = 'card approval';
  d.dataset.id = a.id;
  d.innerHTML =
    '<div>' +
      '<div class="tool"></div>' +
      '<div class="sub"></div>' +
    '</div>' +
    '<pre class="req"></pre>' +
    '<div class="acts">' +
      '<button class="approve" type="button">Approve</button>' +
      '<button class="approve session" type="button">Approve for session</button>' +
      '<button class="deny" type="button">Deny</button>' +
    '</div>';
  d.querySelector('.approve:not(.session)').onclick = function () { decide(a.id, 'approved', 'once'); };
  d.querySelector('.approve.session').onclick = function () { decide(a.id, 'approved', 'session'); };
  d.querySelector('.deny').onclick = function () { decide(a.id, 'denied'); };
  return d;
}
function fillApproval(d, a) {
  // textContent assignment is inherently XSS-safe; esc() also applied where the
  // value lands in markup-adjacent fields per the escaping invariant.
  d.querySelector('.tool').textContent = a.toolName;
  d.querySelector('.sub').textContent =
    'session ' + a.sessionId + ' · id ' + String(a.id).slice(0, 8);
  var req = '';
  try { req = JSON.stringify(a.request); } catch (e) { req = String(a.request); }
  if (req == null) req = '';
  if (req.length > 200) req = req.slice(0, 200) + '…';
  d.querySelector('.req').textContent = req;
}

/* ---- session card build / update ---- */
function sessionCard(s) {
  var d = document.createElement('div');
  d.className = 'card session';
  d.dataset.id = s.id;
  d.innerHTML =
    '<div class="card-head">' +
      '<span class="sid"></span>' +
      '<span class="pill" data-pill></span>' +
    '</div>' +
    '<div class="meta-rows">' +
      '<div class="meta-row"><span class="k">client</span><span class="v" data-client></span></div>' +
      '<div class="meta-row"><span class="k">mode</span><span class="v" data-mode></span></div>' +
      '<div class="meta-row"><span class="k">age</span><span class="v" data-age></span></div>' +
      '<div class="meta-row"><span class="k">dir</span><span class="v path" data-dir></span></div>' +
    '</div>' +
    '<div data-attach-slot></div>' +
    '<div class="acts" data-acts></div>';
  return d;
}
function fillSession(d, s, now) {
  var live = ['done', 'killed', 'failed'].indexOf(s.status) === -1;

  d.querySelector('.sid').textContent = s.id;
  d.querySelector('.sid').title = s.id;

  var pill = d.querySelector('[data-pill]');
  pill.className = 'pill ' + esc(s.status);
  pill.textContent = s.status;

  d.querySelector('[data-client]').textContent = s.client;
  d.querySelector('[data-mode]').textContent = s.mode;
  d.querySelector('[data-age]').textContent = age(now - s.createdAt);
  var dir = d.querySelector('[data-dir]');
  dir.textContent = s.workingDir;
  dir.title = s.workingDir;

  // ---- primary attach (live only): one-tap Prompt mosh deep link ----
  var slot = d.querySelector('[data-attach-slot]');
  if (live) {
    var a = slot.querySelector('a.attach');
    if (!a) {
      slot.innerHTML = '';
      a = document.createElement('a');
      a.className = 'btn attach';
      a.innerHTML = '<span>Attach</span><span class="hint">mosh</span>';
      slot.appendChild(a);
    }
    // promptFav is escaped on the way into the URL by encodeURIComponent.
    a.href = 'prompt-favorite://' + encodeURIComponent(promptFav);
  } else if (slot.firstChild) {
    slot.innerHTML = '';
  }

  // ---- secondary action row ----
  var acts = d.querySelector('[data-acts]');
  // "Reconnect" (re-run /remote-control) only on a live NATIVE console pane.
  var canRc = live && s.backend === 'claude_cli_console';
  // "Full CLI"/"Phone" (convert to native) only on a live GATED streaming session
  // that captured an SDK session id to resume.
  var canConvert = live && s.backend === 'claude_sdk_stream' && !!s.claudeSessionId;
  // Rebuild only when the live-state / button-set changes.
  var want = (live ? 'live' : 'dead') + (canRc ? '+rc' : '') + (canConvert ? '+cv' : '');
  if (acts.dataset.state !== want) {
    acts.dataset.state = want;
    acts.innerHTML = '';
    var mk = function (label, cls, fn, title) {
      var b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      if (cls) b.className = cls;
      if (title) b.title = title;
      b.onclick = fn;
      acts.appendChild(b);
      return b;
    };
    mk('Log', '', function () { showLog(s.id); });
    mk('Cmd', '', function () { attachCmd(s.id); });
    if (canRc) mk('Reconnect', 'rc', function () { reconnectRc(s.id); }, 'Re-run /remote-control on the host');
    if (canConvert) {
      mk('Full CLI', 'convert', function () { convert(s.id, 'local'); }, 'Continue this session in a native local CLI (ungates it)');
      mk('→ Phone', 'convert', function () { convert(s.id, 'remote_control'); }, 'Continue as claude --remote-control (ungates it)');
    }
    if (live) mk('Kill', 'kill', function () { kill(s.id); });
  } else {
    // handlers may close over a stale id after reconcile reuse — rebind cheaply.
    // Order MUST match the mk() sequence above (Log, Cmd, [Reconnect], [Full CLI, Phone], [Kill]).
    var btns = acts.querySelectorAll('button');
    var i = 0;
    if (btns[i]) btns[i++].onclick = function () { showLog(s.id); };
    if (btns[i]) btns[i++].onclick = function () { attachCmd(s.id); };
    if (canRc && btns[i]) btns[i++].onclick = function () { reconnectRc(s.id); };
    if (canConvert && btns[i]) btns[i++].onclick = function () { convert(s.id, 'local'); };
    if (canConvert && btns[i]) btns[i++].onclick = function () { convert(s.id, 'remote_control'); };
    if (live && btns[i]) btns[i++].onclick = function () { kill(s.id); };
  }
}

/* ---- coordination card build / update ---- */
function coordCard(c) {
  var d = document.createElement('div');
  d.className = 'card';
  d.dataset.id = c.id;
  d.innerHTML =
    '<div class="card-head">' +
      '<span class="sid"></span>' +
      '<span class="pill" data-phase></span>' +
    '</div>' +
    '<div class="meta-rows">' +
      '<div class="meta-row"><span class="k">decider</span><span class="v" data-decider></span></div>' +
      '<div class="meta-row"><span class="k">parts</span><span class="v" data-parts></span></div>' +
    '</div>';
  return d;
}
function fillCoord(d, c) {
  d.querySelector('.sid').textContent = c.id;
  var ph = d.querySelector('[data-phase]');
  ph.className = 'pill ' + (c.phase === 'done' ? 'done' : 'running');
  ph.textContent = c.phase;
  d.querySelector('[data-decider]').textContent = c.decider || '—';
  var list = (c.participants && c.participants.length) ? c.participants : (c.planned || []);
  var parts = list.map(function (p) {
    return (p.role || '?') + ':' + (p.client || '?') + (p.status ? ' (' + p.status + ')' : '');
  }).join(', ');
  d.querySelector('[data-parts]').textContent = parts || '—';
}

/* ---- sandboxed (ironcurtain) tab ---- */
function selectTab(name) {
  tab = name;
  $('#tab-btn-native').classList.toggle('active', name === 'native');
  $('#tab-btn-sandboxed').classList.toggle('active', name === 'sandboxed');
  $('#tab-native').hidden = name !== 'native';
  $('#tab-sandboxed').hidden = name !== 'sandboxed';
  if (name === 'native') refresh(); else refreshIc();
}

function decideIc(approvalId, decision) {
  return api('/api/ironcurtain/escalations/' + encodeURIComponent(approvalId) + '/decide', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ decision: decision })
  }).then(function (r) {
    if (r && r.error && !r.decided) toast(r.error);
    refreshIc();
  });
}

function spawnIc() {
  var persona = $('#ic-persona').value;
  var task = $('#ic-task').value.trim();
  var body = {};
  if (persona) body.persona = persona;
  if (task) body.task = task;
  api('/api/ironcurtain/sessions', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  }).then(function (r) {
    if (r && r.error) { toast(r.error); return; }
    toast('Spawned ' + (r.id || 'sandboxed session'));
    $('#ic-task').value = '';
    refreshIc();
  });
}

function showIcDigest(id) {
  openLog = 'ic:' + id;
  $('#logwrap').classList.add('open');
  document.body.style.overflow = 'hidden';
  $('#log').textContent = 'loading…';
  refreshLog();
}

function icEscCard(e) {
  var d = document.createElement('div');
  d.className = 'card approval';
  d.dataset.id = e.approvalId;
  d.innerHTML =
    '<div><div class="tool"></div><div class="sub"></div></div>' +
    '<pre class="req"></pre>' +
    '<div class="acts">' +
      '<button class="approve" type="button">Approve</button>' +
      '<button class="deny" type="button">Deny</button>' +
    '</div>';
  // approvalId is the reconcile key, so a reused node always carries the same id —
  // the closure can never go stale (unlike sessionCard's mode-dependent buttons).
  d.querySelector('.approve').onclick = function () { decideIc(e.approvalId, 'approved'); };
  d.querySelector('.deny').onclick = function () { decideIc(e.approvalId, 'denied'); };
  return d;
}
function fillIcEsc(d, e) {
  d.querySelector('.tool').textContent = esc(e.server) + ' / ' + esc(e.tool);
  d.querySelector('.sub').textContent =
    'session ' + e.sessionId + (e.sessionLabel != null ? ' · label ' + e.sessionLabel : '') +
    (e.reason ? ' · ' + e.reason : '');
  var req = '';
  try { req = JSON.stringify(e.arguments); } catch (x) { req = String(e.arguments); }
  if (req == null) req = '';
  if (req.length > 400) req = req.slice(0, 400) + '…';
  d.querySelector('.req').textContent = req;
}

function icSessionCard(s) {
  var d = document.createElement('div');
  d.className = 'card session';
  d.dataset.id = s.id;
  d.innerHTML =
    '<div class="card-head"><span class="sid"></span><span class="pill" data-pill></span></div>' +
    '<div class="meta-rows">' +
      '<div class="meta-row"><span class="k">persona</span><span class="v" data-persona></span></div>' +
      '<div class="meta-row"><span class="k">label</span><span class="v" data-label></span></div>' +
      '<div class="meta-row"><span class="k">escalations</span><span class="v" data-esc></span></div>' +
      '<div class="meta-row"><span class="k">age</span><span class="v" data-age></span></div>' +
    '</div>' +
    '<div class="acts"><button type="button" data-digest>Digest</button></div>';
  return d;
}
function fillIcSession(d, s, now) {
  d.querySelector('.sid').textContent = s.id;
  d.querySelector('.sid').title = s.id;
  var pill = d.querySelector('[data-pill]');
  pill.className = 'pill ' + esc(s.status);
  pill.textContent = s.status;
  d.querySelector('[data-persona]').textContent = s.persona || '(default)';
  d.querySelector('[data-label]').textContent = (s.label != null ? String(s.label) : '—');
  d.querySelector('[data-esc]').textContent = String(s.escalationsPending || 0);
  d.querySelector('[data-age]').textContent = age(now - s.createdAt);
  // id is the reconcile key (stable per node), but rebind cheaply for parity.
  d.querySelector('[data-digest]').onclick = function () { showIcDigest(s.id); };
}

function setIcBadge(n) {
  var badge = $('#ic-badge');
  if (n > 0) { badge.textContent = n; badge.hidden = false; } else { badge.hidden = true; }
}

function refreshIc() {
  return api('/api/ironcurtain/state').then(function (st) {
    if (!st || !st.enabled) return;
    if (!icPersonasLoaded && st.personas) {
      var sel = $('#ic-persona');
      for (var i = 0; i < st.personas.length; i++) {
        var p = st.personas[i];
        var opt = document.createElement('option');
        opt.value = p.name;
        opt.textContent = p.name + (p.description ? ' — ' + p.description : '');
        sel.appendChild(opt);
      }
      icPersonasLoaded = true;
    }
    var escs = st.escalations || [];
    var sessions = st.sessions || [];
    setIcBadge(escs.length);

    $('#ic-esc-section').hidden = escs.length === 0;
    $('#ic-esc-count').textContent = escs.length;
    reconcile($('#ic-escalations'), escs,
      function (e) { return e.approvalId; },
      function (e) { return icEscCard(e); },
      function (node, e) { fillIcEsc(node, e); });

    $('#ic-sess-count').textContent = sessions.length;
    var wrap = $('#ic-sessions');
    var emptyEl = wrap.querySelector('.empty');
    if (sessions.length === 0) {
      if (!emptyEl) { wrap.innerHTML = '<div class="empty">no sandboxed sessions</div>'; }
      var c = wrap.firstElementChild;
      while (c) {
        var next = c.nextElementSibling;
        if (!c.classList.contains('empty')) wrap.removeChild(c);
        c = next;
      }
    } else {
      if (emptyEl) emptyEl.remove();
      var now = st.now;
      reconcile(wrap, sessions,
        function (s) { return s.id; },
        function (s) { return icSessionCard(s); },
        function (node, s) { fillIcSession(node, s, now); });
    }
    refreshLog();
  }).catch(function () { /* keep last view; the next tick retries */ });
}

/* ---- keyed reconcile: update in place, no full DOM blow-away ---- */
function reconcile(container, items, keyFn, makeFn, fillFn) {
  var existing = {};
  var child = container.firstElementChild;
  while (child) {
    if (child.dataset && child.dataset.id != null) existing[child.dataset.id] = child;
    child = child.nextElementSibling;
  }
  var seen = {};
  var prev = null;
  for (var i = 0; i < items.length; i++) {
    var it = items[i];
    var key = String(keyFn(it));
    seen[key] = true;
    var node = existing[key];
    if (!node) {
      node = makeFn(it);
      node.dataset.id = key;
    }
    fillFn(node, it);
    // place node right after prev to preserve server ordering
    var ref = prev ? prev.nextSibling : container.firstChild;
    if (node !== ref) container.insertBefore(node, ref);
    prev = node;
  }
  // remove anything no longer present
  for (var k in existing) {
    if (!seen[k]) container.removeChild(existing[k]);
  }
}

/* ---- main refresh ---- */
var hadError = false;
function refresh() {
  return api('/api/state').then(function (st) {
    hadError = false;
    $('#hdr').classList.add('live');
    if (st.attach && st.attach.promptFavorite) promptFav = st.attach.promptFavorite;

    var nSess = st.sessions.length;
    var nAp = st.approvals.length;
    $('#meta').textContent = nSess + ' sessions · ' + nAp + ' awaiting';
    $('#sess-count').textContent = nSess;
    $('#ap-count').textContent = nAp;

    // approvals
    var apSection = $('#approvals-section');
    var apWrap = $('#approvals');
    apSection.hidden = nAp === 0;
    reconcile(apWrap, st.approvals,
      function (a) { return a.id; },
      function (a) { return approvalCard(a); },
      function (node, a) { fillApproval(node, a); });

    // sessions
    var sessWrap = $('#sessions');
    var emptyEl = sessWrap.querySelector('.empty');
    if (nSess === 0) {
      if (!emptyEl) { sessWrap.innerHTML = '<div class="empty">no sessions</div>'; }
      // drop any leftover cards
      var c = sessWrap.firstElementChild;
      while (c) {
        var next = c.nextElementSibling;
        if (!c.classList.contains('empty')) sessWrap.removeChild(c);
        c = next;
      }
    } else {
      if (emptyEl) emptyEl.remove();
      var now = st.now;
      reconcile(sessWrap, st.sessions,
        function (s) { return s.id; },
        function (s) { return sessionCard(s); },
        function (node, s) { fillSession(node, s, now); });
    }

    // coordinations (display-only): topology, phase, decider, participant sessions
    var coords = st.coordinations || [];
    $('#coord-section').hidden = coords.length === 0;
    $('#coord-count').textContent = coords.length;
    reconcile($('#coords'), coords,
      function (c) { return c.id; },
      function (c) { return coordCard(c); },
      function (node, c) { fillCoord(node, c); });

    // keep an open log fresh
    refreshLog();
  }).catch(function () {
    hadError = true;
    $('#hdr').classList.remove('live');
    $('#meta').textContent = 'reconnecting…';
  });
}

/* ---- wire static controls ---- */
$('#logclose').onclick = closeLog;
$('#logwrap').addEventListener('click', function (e) {
  if (e.target === $('#logwrap')) closeLog(); // tap backdrop to dismiss
});
document.addEventListener('keydown', function (e) {
  if (e.key === 'Escape' && openLog) closeLog();
});
$('#tab-btn-native').onclick = function () { selectTab('native'); };
$('#tab-btn-sandboxed').onclick = function () { selectTab('sandboxed'); };
$('#ic-spawn').onclick = spawnIc;

// Reveal the Sandboxed tab only when the ironcurtain backend is enabled; seed the
// pending-escalation badge so it shows even before the tab is first opened.
api('/api/ironcurtain/state').then(function (st) {
  if (st && st.enabled) {
    $('#tab-btn-sandboxed').hidden = false;
    setIcBadge((st.escalations || []).length);
  }
}).catch(function () { /* backend off — leave the tab hidden */ });

refresh();
// One loop; only the ACTIVE tab polls (the inactive tab's badge is stale until
// selected — acceptable for this thin surface; Signal is the real-time alert path).
setInterval(function () { if (tab === 'native') refresh(); else refreshIc(); }, POLL_MS);
</script>
</body>
</html>`;
