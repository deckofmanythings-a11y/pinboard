'use strict';
/* Pinboard — multi-user corkboard.
   Persistence: SECURITY DEFINER RPCs on the raided-hex Supabase project (pb_* tables).
   Live sync:   Realtime broadcast + presence on channel "pb:<board uuid>".
   The board uuid in ?b= is the share secret. */

const SB_URL = 'https://uaoxvhihwiygrajicend.supabase.co';
const SB_KEY = 'sb_publishable_91Zn_uJ9anW46vAClx6-bQ__wLL4fXl';
const BUCKET = 'pb-photos';
const WORLD_W = 4000, WORLD_H = 2600;
const MIN_S = 0.12, MAX_S = 2.5;

const POSTIT_COLORS = ['#fff176', '#ffb3c8', '#a7d8ff', '#c5ef9f', '#ffc97a', '#e3c4ff'];
const CARD_COLORS   = ['#fdfcf5', '#f2deb0', '#dcecf7', '#fbe3e3'];
const PIN_COLORS    = ['#d7263d', '#2a6fdb', '#f4b400', '#1f9d55', '#8e44ad', '#f2f2f2', '#2b2b2b'];
const YARN_COLORS   = ['#c0262d', '#1f4fbf', '#1d8a3a', '#e0a800', '#222222', '#f2f2f2'];
const USER_COLORS   = ['#e6194b', '#3cb44b', '#4363d8', '#f58231', '#911eb4', '#2bb5d6', '#f032e6', '#9a6324', '#469990', '#808000'];

const DEFAULTS = {
  postit:      { w: 200, h: 200 },
  card:        { w: 320, h: 200 },
  photo:       { w: 264, h: 300 },
  placeholder: { w: 264, h: 300 },
};

const sb = supabase.createClient(SB_URL, SB_KEY, { auth: { persistSession: false, autoRefreshToken: false } });

/* ---------- tiny helpers ---------- */
const $ = s => document.querySelector(s);
const uuid = () => crypto.randomUUID();
const clamp = (v, a, b) => Math.max(a, Math.min(b, v));
const isColor = c => typeof c === 'string' && /^#[0-9a-f]{3,8}$/i.test(c);
const safeColor = (c, d) => isColor(c) ? c : d;
const isUuid = s => typeof s === 'string' && /^[0-9a-f-]{36}$/i.test(s);
const store = {
  get(k, d) { try { const v = localStorage.getItem(k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch {} },
};
let toastTimer;
function toast(msg, err = false, ms = 2600) {
  const t = $('#toast');
  t.textContent = msg; t.classList.toggle('err', err); t.classList.add('show');
  clearTimeout(toastTimer); toastTimer = setTimeout(() => t.classList.remove('show'), ms);
}
function imgUrl(path) {
  return `${SB_URL}/storage/v1/object/public/${BUCKET}/${String(path).split('/').map(encodeURIComponent).join('/')}`;
}

/* ---------- state ---------- */
const params = new URLSearchParams(location.search);
const boardId = isUuid(params.get('b')) ? params.get('b').toLowerCase() : null;

const S = {
  board: null,
  items: new Map(),
  strings: new Map(),
  view: { x: 0, y: 0, s: 0.5 },
  sel: null,          // {type:'item'|'string', id}
  editing: null,      // {id, field, el}
  drag: null,
  yarnColor: store.get('pb_yarn', YARN_COLORS[0]),
  lastPostit: POSTIT_COLORS[0],
  channel: null,
  loaded: false,
  peers: {},
  multi: new Set(),   // multi-selection of item ids (S.sel is null while this is in use)
  tool: 'pan',        // 'pan' | 'select' — what dragging empty cork does
};
const savedMe = store.get('pb_me', null);
const me = {
  id: uuid(),
  name: savedMe?.name || '',
  color: safeColor(savedMe?.color, USER_COLORS[Math.floor(Math.random() * USER_COLORS.length)]),
};

const viewport = $('#viewport'), world = $('#world'), cork = $('#cork');
const itemsEl = $('#items'), pinsEl = $('#pins'), yarnSvg = $('#yarn'), cursorsEl = $('#cursors');
world.style.width = cork.style.width = WORLD_W + 'px';
world.style.height = cork.style.height = WORLD_H + 'px';
yarnSvg.setAttribute('width', WORLD_W); yarnSvg.setAttribute('height', WORLD_H);

/* ---------- geometry ---------- */
function pinOffset(it) { return it.kind === 'photo' || it.kind === 'placeholder' ? 6 : 15; }
function pinPos(it) {
  const r = (it.rot || 0) * Math.PI / 180;
  const cx = it.x + it.w / 2, cy = it.y + it.h / 2, d = it.h / 2 - pinOffset(it);
  return { x: cx + d * Math.sin(r), y: cy - d * Math.cos(r) };
}
function yarnD(a, b, sag) {
  const dist = Math.hypot(b.x - a.x, b.y - a.y);
  const drop = (sag ?? Math.min(70, 8 + dist * 0.09));
  const mx = (a.x + b.x) / 2, my = (a.y + b.y) / 2 + drop;
  return `M${a.x.toFixed(1)},${a.y.toFixed(1)} Q${mx.toFixed(1)},${my.toFixed(1)} ${b.x.toFixed(1)},${b.y.toFixed(1)}`;
}
function toWorld(cx, cy) {
  const r = viewport.getBoundingClientRect();
  return { x: (cx - r.left - S.view.x) / S.view.s, y: (cy - r.top - S.view.y) / S.view.s };
}
function viewCenterWorld() {
  const r = viewport.getBoundingClientRect();
  return toWorld(r.left + r.width / 2, r.top + r.height / 2);
}
function applyView() {
  world.style.transform = `translate(${S.view.x}px,${S.view.y}px) scale(${S.view.s})`;
  if (S.sel?.type === 'string') schedule(null);   // resize yarn-end handles for the new zoom
  positionSelbar();
}
function zoomAt(cx, cy, ns) {
  ns = clamp(ns, MIN_S, MAX_S);
  const r = viewport.getBoundingClientRect();
  const mx = cx - r.left, my = cy - r.top;
  S.view.x = mx - (mx - S.view.x) * (ns / S.view.s);
  S.view.y = my - (my - S.view.y) * (ns / S.view.s);
  S.view.s = ns;
  applyView(); renderCursors();
}
function fitView() {
  const r = viewport.getBoundingClientRect();
  let x0 = 0, y0 = 0, x1 = WORLD_W, y1 = WORLD_H;
  if (!S.items.size && boardId) {   // empty board: start at a comfortable working zoom, centred
    S.view.s = 0.8;
    S.view.x = r.width / 2 - WORLD_W / 2 * 0.8; S.view.y = r.height / 2 - WORLD_H / 2 * 0.8;
    applyView(); renderCursors(); return;
  }
  if (S.items.size) {
    x0 = y0 = Infinity; x1 = y1 = -Infinity;
    for (const it of S.items.values()) {
      x0 = Math.min(x0, it.x); y0 = Math.min(y0, it.y);
      x1 = Math.max(x1, it.x + it.w); y1 = Math.max(y1, it.y + it.h);
    }
    const pad = 160; x0 -= pad; y0 -= pad; x1 += pad; y1 += pad;
  }
  const s = clamp(Math.min(r.width / (x1 - x0), r.height / (y1 - y0)), MIN_S, 1.1);
  S.view.s = s;
  S.view.x = (r.width - (x1 - x0) * s) / 2 - x0 * s;
  S.view.y = (r.height - (y1 - y0) * s) / 2 - y0 * s;
  applyView(); renderCursors();
}
function maxZ() { let m = 0; for (const it of S.items.values()) m = Math.max(m, it.z || 0); return m; }

/* ---------- rendering ---------- */
const CAMERA_SVG = `<svg viewBox="0 0 64 52" fill="currentColor"><path d="M22 4h20l4 7h10a6 6 0 0 1 6 6v27a6 6 0 0 1-6 6H8a6 6 0 0 1-6-6V17a6 6 0 0 1 6-6h10z"/><circle cx="32" cy="30" r="12" fill="#e9e3d4"/><circle cx="32" cy="30" r="7"/></svg>`;

function buildItemEl(it) {
  const el = document.createElement('div');
  el.className = 'item k-' + it.kind;
  el.id = 'it-' + it.id;
  el.dataset.id = it.id;
  el.dataset.kind = it.kind;
  let inner = '';
  if (it.kind === 'postit') inner = `<div class="paper"><div class="txt body" data-field="body" data-ph="Double-click to write…"></div></div>`;
  else if (it.kind === 'card') inner = `<div class="paper"><div class="txt title" data-field="title" data-ph="Title"></div><div class="txt body" data-field="body" data-ph="Double-click to write…"></div></div>`;
  else if (it.kind === 'photo') inner = `<div class="paper"><div class="photo-wrap loading"><img alt="" draggable="false"></div><div class="txt caption" data-field="title" data-ph="caption"></div></div>`;
  else inner = `<div class="paper"><div class="ph-box" title="Double-click or drop a photo here">${CAMERA_SVG}<div class="ph-q">?</div><div class="stamp">PHOTO NEEDED</div></div><div class="txt caption" data-field="title" data-ph="what's needed?"></div></div>`;
  el.innerHTML = inner + '<div class="rs" title="Resize"></div>';
  const img = el.querySelector('img');
  if (img) img.addEventListener('load', () => img.parentElement.classList.remove('loading'));
  return el;
}

function renderItem(it) {
  let el = document.getElementById('it-' + it.id);
  if (el && el.dataset.kind !== it.kind) { el.remove(); el = null; }
  if (!el) { el = buildItemEl(it); itemsEl.appendChild(el); }
  el.style.left = it.x + 'px'; el.style.top = it.y + 'px';
  el.style.width = it.w + 'px'; el.style.height = it.h + 'px';
  el.style.transform = `rotate(${it.rot || 0}deg)`;
  el.style.zIndex = it.z || 0;
  el.style.setProperty('--paper', safeColor(it.color, it.kind === 'card' ? CARD_COLORS[0] : POSTIT_COLORS[0]));
  el.classList.toggle('sel', isSelected(it.id));
  for (const f of el.querySelectorAll('[data-field]')) {
    const field = f.dataset.field;
    if (S.editing && S.editing.id === it.id && S.editing.field === field) continue;
    const v = it[field] || '';
    if (f.textContent !== v) f.textContent = v;
  }
  const img = el.querySelector('img');
  if (img && it.image_path) {
    const u = imgUrl(it.image_path);
    if (img.dataset.src !== u) { img.dataset.src = u; img.parentElement.classList.add('loading'); img.src = u; }
  }
  let pin = document.getElementById('pin-' + it.id);
  if (!pin) {
    pin = document.createElement('div');
    pin.className = 'pin'; pin.id = 'pin-' + it.id; pin.dataset.id = it.id;
    pin.title = 'Drag onto another note to tie yarn';
    pinsEl.appendChild(pin);
  }
  const p = pinPos(it);
  pin.style.left = p.x + 'px'; pin.style.top = p.y + 'px';
  pin.style.zIndex = it.z || 0;
  pin.style.setProperty('--pc', safeColor(it.pin_color, PIN_COLORS[0]));
}
function removeItemEl(id) {
  document.getElementById('it-' + id)?.remove();
  document.getElementById('pin-' + id)?.remove();
}

function renderStrings() {
  const out = [];
  const rt = S.drag?.type === 'retie' ? S.drag : null;
  let ends = '';
  for (const s of S.strings.values()) {
    const a = S.items.get(s.from_item), b = S.items.get(s.to_item);
    if (!a || !b) continue;
    let pa = pinPos(a), pb = pinPos(b);
    if (rt && rt.sid === s.id) { if (rt.end === 'from') pa = rt.to; else pb = rt.to; }
    const sel = S.sel?.type === 'string' && S.sel.id === s.id;
    out.push(yarnGroup(s.id, pa, pb, safeColor(s.color, YARN_COLORS[0]), sel, !!(rt && rt.sid === s.id)));
    if (sel && !rt) {
      // grab handles a little way along the strand from each pin: drag one to re-tie that end
      const hr = Math.max(9, 7 / S.view.s).toFixed(1);   // stays finger-sized when zoomed out
      const ha = alongYarn(pa, pb, 22 + hr * 1.4), hb = alongYarn(pb, pa, 22 + hr * 1.4);
      ends += `<circle class="y-end" data-sid="${s.id}" data-end="from" cx="${ha.x.toFixed(1)}" cy="${ha.y.toFixed(1)}" r="${hr}" stroke-width="${(hr / 4.5).toFixed(1)}"><title>Drag to re-tie this end</title></circle>` +
              `<circle class="y-end" data-sid="${s.id}" data-end="to" cx="${hb.x.toFixed(1)}" cy="${hb.y.toFixed(1)}" r="${hr}" stroke-width="${(hr / 4.5).toFixed(1)}"><title>Drag to re-tie this end</title></circle>`;
    }
  }
  out.push(ends);
  if (S.drag?.type === 'yarn') {
    const a = S.items.get(S.drag.from);
    if (a) out.push(yarnGroup('', pinPos(a), S.drag.to, S.yarnColor, false, true));
  }
  yarnSvg.innerHTML = out.join('');
}
/** Point roughly `len` px along the sagging strand from p toward q (matches yarnD's curve). */
function alongYarn(p, q, len) {
  const dist = Math.hypot(q.x - p.x, q.y - p.y) || 1;
  const drop = Math.min(70, 8 + dist * 0.09);
  const c = { x: (p.x + q.x) / 2, y: (p.y + q.y) / 2 + drop };
  const t = Math.min(0.45, len / dist), u = 1 - t;
  return { x: u * u * p.x + 2 * u * t * c.x + t * t * q.x, y: u * u * p.y + 2 * u * t * c.y + t * t * q.y };
}
function yarnGroup(id, a, b, color, sel, temp) {
  const d = yarnD(a, b);
  const sd = yarnD({ x: a.x + 4, y: a.y + 7 }, { x: b.x + 4, y: b.y + 7 }, Math.min(70, 8 + Math.hypot(b.x - a.x, b.y - a.y) * 0.09) + 6);
  return `<g class="yarn${sel ? ' sel' : ''}${temp ? ' temp' : ''}" data-sid="${id}">` +
    `<path class="y-shadow" d="${sd}"/><path class="y-main" d="${d}" stroke="${color}"/>` +
    `<path class="y-fiber" d="${d}"/><path class="y-fiber2" d="${d}"/>` +
    (temp ? '' : `<path class="y-hit" d="${d}"/>`) + `</g>`;
}

let rafPending = false;
const dirty = new Set();
let stringsDirty = false;
function schedule(id, strings = true) {
  if (id) dirty.add(id);
  if (strings) stringsDirty = true;
  if (rafPending) return;
  rafPending = true;
  requestAnimationFrame(() => {
    rafPending = false;
    for (const i of dirty) { const it = S.items.get(i); if (it) renderItem(it); }
    dirty.clear();
    if (stringsDirty) { stringsDirty = false; renderStrings(); }
    positionSelbar();
  });
}
function renderAll() {
  for (const el of [...itemsEl.children]) if (!S.items.has(el.dataset.id)) removeItemEl(el.dataset.id);
  for (const it of S.items.values()) renderItem(it);
  renderStrings(); renderSelbar();
}

/* ---------- persistence + broadcast ---------- */
const FIELDS = ['id', 'kind', 'x', 'y', 'w', 'h', 'rot', 'z', 'color', 'pin_color', 'title', 'body', 'image_path', 'created_by'];
function wire(it) { const o = {}; for (const f of FIELDS) o[f] = it[f] ?? null; return o; }
function bcast(event, payload) {
  if (!S.channel) return;
  S.channel.send({ type: 'broadcast', event, payload: { ...payload, by: me.id } }).catch(() => {});
}
/* Writes for one item run strictly in order (insert -> updates -> delete), otherwise
   a slow first INSERT can land after a later UPDATE and wipe it. */
const chains = new Map();
function enqueue(id, fn) {
  const p = (chains.get(id) || Promise.resolve()).then(fn).catch(e => toast('Couldn\'t save: ' + (e.message || e), true));
  chains.set(id, p);
  p.then(() => { if (chains.get(id) === p) chains.delete(id); });
  return p;
}
async function rpcOrThrow(fn, args) {
  const { error } = await sb.rpc(fn, args);
  if (error) throw error;
}
const saveTimers = new Map();
function persistItem(it, delay = 0) {
  clearTimeout(saveTimers.get(it.id));
  saveTimers.set(it.id, setTimeout(() => {
    saveTimers.delete(it.id);
    enqueue(it.id, () => {
      const cur = S.items.get(it.id); if (!cur) return;   // read latest state at send time
      return rpcOrThrow('pb_upsert_item', { p_board: boardId, p_item: wire(cur) });
    });
  }, delay));
}
/** Commit a local change: tell peers now, save to DB (debounced when delay>0). */
function commit(it, { live = false, delay = 0 } = {}) {
  bcast('item', { item: wire(it), live });
  if (!live) persistItem(it, delay);
}
const liveThrottle = new Map();
function commitLive(it) {
  const now = performance.now();
  if (now - (liveThrottle.get(it.id) || 0) < 45) return;
  liveThrottle.set(it.id, now);
  commit(it, { live: true });
}

function addItem(kind, at, extra = {}) {
  const d = DEFAULTS[kind];
  const c = at || freeSpotNear(viewCenterWorld());
  const it = {
    id: uuid(), kind, w: d.w, h: d.h,
    rot: Math.round((Math.random() * 8 - 4) * 10) / 10,
    z: maxZ() + 1,
    color: kind === 'postit' ? S.lastPostit : kind === 'card' ? CARD_COLORS[0] : null,
    pin_color: PIN_COLORS[Math.floor(Math.random() * 3)],
    title: '', body: '', image_path: null, created_by: me.name,
    ...extra,
  };
  it.x = clamp(Math.round(c.x - it.w / 2 + (at ? 0 : Math.random() * 16 - 8)), 0, WORLD_W - it.w);
  it.y = clamp(Math.round(c.y - it.h / 2 + (at ? 0 : Math.random() * 16 - 8)), 0, WORLD_H - it.h);
  S.items.set(it.id, it);
  renderItem(it);
  select({ type: 'item', id: it.id });
  commit(it);
  return it;
}
/** Walk outward from p until no existing item's centre is close, so new notes don't stack. */
function freeSpotNear(p) {
  const busy = q => [...S.items.values()].some(o => Math.abs(o.x + o.w / 2 - q.x) < 200 && Math.abs(o.y + o.h / 2 - q.y) < 190);
  if (!busy(p)) return p;
  for (let ring = 1; ring < 12; ring++)
    for (let i = 0; i < ring * 8; i++) {
      const a = (i / (ring * 8)) * Math.PI * 2;
      const q = { x: p.x + Math.cos(a) * ring * 270, y: p.y + Math.sin(a) * ring * 240 };
      if (q.x > 120 && q.y > 120 && q.x < WORLD_W - 120 && q.y < WORLD_H - 120 && !busy(q)) return q;
    }
  return p;
}
function deleteItem(id) {
  if (!S.items.has(id)) return;
  S.items.delete(id);
  for (const [sid, s] of S.strings) if (s.from_item === id || s.to_item === id) S.strings.delete(sid);
  removeItemEl(id);
  if (S.sel?.id === id) select(null);
  if (S.multi.delete(id)) renderSelbar();
  renderStrings();
  bcast('item_del', { id });
  clearTimeout(saveTimers.get(id)); saveTimers.delete(id);
  enqueue(id, () => rpcOrThrow('pb_delete_item', { p_board: boardId, p_id: id }));
}
function addString(from, to) {
  if (from === to) return;
  for (const s of S.strings.values())
    if ((s.from_item === from && s.to_item === to) || (s.from_item === to && s.to_item === from)) { toast('Already tied together'); return; }
  const s = { id: uuid(), from_item: from, to_item: to, color: S.yarnColor };
  S.strings.set(s.id, s);
  renderStrings();
  bcast('string', { string: s });
  saveString(s);
}
function saveString(s) {
  // both ends must exist in the DB first, so wait behind their pending writes
  enqueue(s.id, () => Promise.all([chains.get(s.from_item), chains.get(s.to_item)]).then(() =>
    rpcOrThrow('pb_add_string', { p_board: boardId, p_id: s.id, p_from: s.from_item, p_to: s.to_item, p_color: s.color })));
}
function deleteString(id) {
  if (!S.strings.delete(id)) return;
  if (S.sel?.id === id) select(null);
  renderStrings();
  bcast('string_del', { id });
  enqueue(id, () => rpcOrThrow('pb_delete_string', { p_board: boardId, p_id: id }));
}
function recolorString(id, color) {
  const s = S.strings.get(id); if (!s) return;
  // strings are immutable server-side: replace with a new one of the new colour
  S.strings.delete(id);
  bcast('string_del', { id });
  enqueue(id, () => rpcOrThrow('pb_delete_string', { p_board: boardId, p_id: id }));
  const n = { id: uuid(), from_item: s.from_item, to_item: s.to_item, color };
  S.strings.set(n.id, n);
  bcast('string', { string: n });
  saveString(n);
  S.sel = { type: 'string', id: n.id };
  renderStrings(); renderSelbar();
}

/** Move one end of a strand to a different item (strands are immutable server-side: replace it). */
function retieString(id, end, target) {
  const s = S.strings.get(id); if (!s) return;
  const from = end === 'from' ? target : s.from_item, to = end === 'to' ? target : s.to_item;
  if (from === to || (from === s.from_item && to === s.to_item)) return;
  for (const o of S.strings.values())
    if (o.id !== id && ((o.from_item === from && o.to_item === to) || (o.from_item === to && o.to_item === from))) { toast('Already tied together'); return; }
  S.strings.delete(id);
  bcast('string_del', { id });
  enqueue(id, () => rpcOrThrow('pb_delete_string', { p_board: boardId, p_id: id }));
  const n = { id: uuid(), from_item: from, to_item: to, color: s.color };
  S.strings.set(n.id, n);
  bcast('string', { string: n });
  saveString(n);
  S.sel = { type: 'string', id: n.id };
}

/* ---------- photos ---------- */
async function downscale(file, max = 1600) {
  const bmp = await createImageBitmap(file).catch(() => null);
  if (!bmp) throw new Error('not an image I can read');
  const k = Math.min(1, max / Math.max(bmp.width, bmp.height));
  const w = Math.round(bmp.width * k), h = Math.round(bmp.height * k);
  const cv = document.createElement('canvas'); cv.width = w; cv.height = h;
  const ctx = cv.getContext('2d'); ctx.fillStyle = '#fff'; ctx.fillRect(0, 0, w, h); ctx.drawImage(bmp, 0, 0, w, h);
  const blob = await new Promise(r => cv.toBlob(r, 'image/jpeg', 0.86));
  return { blob, w, h };
}
async function uploadImage(file) {
  const { blob, w, h } = await downscale(file);
  const path = `${boardId}/${uuid()}.jpg`;
  const { error } = await sb.storage.from(BUCKET).upload(path, blob, { contentType: 'image/jpeg', cacheControl: '31536000', upsert: false });
  if (error) throw error;
  return { path, w, h };
}
function photoSize(w, h, width = 264) {
  const inner = width - 24;
  const ih = clamp(Math.round(inner * h / w), 120, 420);
  return { w: width, h: ih + 12 + 52 };
}
async function addPhotos(files, at) {
  const imgs = [...files].filter(f => f.type.startsWith('image/'));
  let i = 0;
  for (const f of imgs) {
    toast(imgs.length > 1 ? `Uploading photo ${i + 1} of ${imgs.length}…` : 'Uploading photo…', false, 20000);
    try {
      const up = await uploadImage(f);
      const pos = at ? { x: at.x + i * 40, y: at.y + i * 40 } : null;
      addItem('photo', pos, { image_path: up.path, ...photoSize(up.w, up.h) });
      toast('Pinned!');
    } catch (e) { toast('Upload failed: ' + (e.message || e), true); }
    i++;
  }
}
async function fillPhoto(id, file) {
  toast('Uploading photo…', false, 20000);
  try {
    const up = await uploadImage(file);
    const it = S.items.get(id); if (!it) return;
    const sz = photoSize(up.w, up.h, it.w);
    const cx = it.x + it.w / 2;
    Object.assign(it, { kind: 'photo', image_path: up.path, w: sz.w, h: sz.h, x: Math.round(cx - sz.w / 2) });
    renderItem(it); renderStrings(); renderSelbar();
    commit(it);
    toast('Pinned!');
  } catch (e) { toast('Upload failed: ' + (e.message || e), true); }
}
let pickTarget = null;   // null => new photos at view centre; id => fill that item
function pickPhoto(target = null) { pickTarget = target; const fp = $('#filePick'); fp.multiple = !target; fp.value = ''; fp.click(); }
$('#filePick').addEventListener('change', e => {
  const files = e.target.files; if (!files.length) return;
  if (pickTarget) fillPhoto(pickTarget, files[0]); else addPhotos(files);
});

/* ---------- selection + selbar ---------- */
function isSelected(id) { return S.multi.has(id) || (S.sel?.type === 'item' && S.sel.id === id); }
/** Ids of every selected item (single or multi). */
function selIds() { return S.multi.size ? [...S.multi].filter(id => S.items.has(id)) : S.sel?.type === 'item' ? [S.sel.id] : []; }
function clearMulti() {
  if (!S.multi.size) return;
  const old = [...S.multi]; S.multi = new Set();
  for (const id of old) { const it = S.items.get(id); if (it) renderItem(it); }
}
/** Select a set of items; one id collapses to a normal single selection. */
function selectItems(ids) {
  ids = [...new Set(ids)].filter(id => S.items.has(id));
  if (ids.length <= 1) { clearMulti(); select(ids.length ? { type: 'item', id: ids[0] } : null); return; }
  const prev = S.sel; S.sel = null;
  if (prev?.type === 'item') { const it = S.items.get(prev.id); if (it) renderItem(it); }
  if (prev?.type === 'string') renderStrings();
  clearMulti();
  S.multi = new Set(ids);
  for (const id of ids) renderItem(S.items.get(id));
  renderSelbar();
}
function select(sel) {
  clearMulti();
  const prev = S.sel;
  S.sel = sel;
  if (prev?.type === 'item') { const it = S.items.get(prev.id); if (it) renderItem(it); }
  if (sel?.type === 'item') { const it = S.items.get(sel.id); if (it) renderItem(it); }
  if (prev?.type === 'string' || sel?.type === 'string') renderStrings();
  renderSelbar();
}
function swatch(color, on, attr, sq) {
  return `<button type="button" class="sw${on ? ' on' : ''}${sq ? ' sq' : ''}" style="background:${color}" ${attr}="${color}" title="${color}"></button>`;
}
function renderSelbar() {
  const bar = $('#selbar');
  const sel = S.sel;
  if (S.multi.size) {
    bar.innerHTML = `<span class="count">${S.multi.size} items</span><div class="div"></div>` +
      `<button class="ic" data-act="mrotl" title="Rotate each left">↺</button><button class="ic" data-act="mrotr" title="Rotate each right">↻</button>` +
      `<button class="ic" data-act="mback" title="Send to back">⤓</button>` +
      `<button class="ic danger" data-act="mdel" title="Delete all (Del)">🗑</button>`;
    bar.hidden = false; positionSelbar(); return;
  }
  if (!sel || (sel.type === 'item' && !S.items.has(sel.id)) || (sel.type === 'string' && !S.strings.has(sel.id))) {
    bar.hidden = true; return;
  }
  let h = '';
  if (sel.type === 'item') {
    const it = S.items.get(sel.id);
    if (it.kind === 'postit' || it.kind === 'card') {
      const cs = it.kind === 'postit' ? POSTIT_COLORS : CARD_COLORS;
      h += `<div class="grp">${cs.map(c => swatch(c, c === it.color, 'data-color', true)).join('')}</div><div class="div"></div>`;
    }
    if (it.kind === 'photo' || it.kind === 'placeholder')
      h += `<button class="ic" data-act="photo" title="${it.kind === 'photo' ? 'Replace photo' : 'Add the photo'}">📷 ${it.kind === 'photo' ? 'Replace' : 'Add photo'}</button><div class="div"></div>`;
    if (it.kind === 'photo')
      h += `<button class="ic" data-act="unphoto" title="Turn back into a placeholder">⬚</button><div class="div"></div>`;
    h += `<div class="grp">${PIN_COLORS.map(c => swatch(c, c === it.pin_color, 'data-pin')).join('')}</div><div class="div"></div>`;
    h += `<button class="ic" data-act="rotl" title="Rotate left">↺</button><button class="ic" data-act="rotr" title="Rotate right">↻</button>`;
    h += `<button class="ic" data-act="back" title="Send to back">⤓</button>`;
    h += `<button class="ic danger" data-act="del" title="Delete (Del)">🗑</button>`;
  } else {
    const s = S.strings.get(sel.id);
    h += `<div class="grp">${YARN_COLORS.map(c => swatch(c, c === s.color, 'data-ycolor')).join('')}</div><div class="div"></div>`;
    h += `<button class="ic danger" data-act="delstr" title="Cut yarn (Del)">✂ Cut</button>`;
  }
  bar.innerHTML = h;
  bar.hidden = false;
  positionSelbar();
}
function positionSelbar() {
  const bar = $('#selbar');
  if (bar.hidden || (!S.sel && !S.multi.size)) return;
  let r;
  if (S.multi.size) {
    let l = Infinity, t = Infinity, rr = -Infinity, b = -Infinity;
    for (const id of S.multi) {
      const q = document.getElementById('it-' + id)?.getBoundingClientRect(); if (!q) continue;
      l = Math.min(l, q.left); t = Math.min(t, q.top); rr = Math.max(rr, q.right); b = Math.max(b, q.bottom);
    }
    if (l === Infinity) return;
    r = { left: l, top: t, right: rr, bottom: b, width: rr - l, height: b - t };
  } else if (S.sel.type === 'item') r = document.getElementById('it-' + S.sel.id)?.getBoundingClientRect();
  else r = yarnSvg.querySelector(`[data-sid="${S.sel.id}"] .y-main`)?.getBoundingClientRect();
  if (!r) return;
  const bw = bar.offsetWidth, bh = bar.offsetHeight;
  let x = r.left + r.width / 2 - bw / 2, y = r.top - bh - 18;
  if (y < 60) y = r.bottom + 16;
  x = clamp(x, 8, innerWidth - bw - 8); y = clamp(y, 60, innerHeight - bh - 8);
  bar.style.left = x + 'px'; bar.style.top = y + 'px';
}
$('#selbar').addEventListener('pointerdown', e => e.stopPropagation());
$('#selbar').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (S.multi.size) {
    const ids = selIds();
    if (b.dataset.act === 'mdel') { ids.forEach(deleteItem); select(null); return; }
    let mn = Infinity; for (const o of S.items.values()) mn = Math.min(mn, o.z || 0);
    for (const id of ids) {
      const it = S.items.get(id);
      if (b.dataset.act === 'mrotl') it.rot = Math.round(((it.rot || 0) - 4) * 10) / 10;
      else if (b.dataset.act === 'mrotr') it.rot = Math.round(((it.rot || 0) + 4) * 10) / 10;
      else if (b.dataset.act === 'mback') it.z = --mn;
      else return;
      renderItem(it); commit(it);
    }
    renderStrings(); positionSelbar();
    return;
  }
  if (!S.sel) return;
  if (S.sel.type === 'string') {
    if (b.dataset.ycolor) recolorString(S.sel.id, b.dataset.ycolor);
    if (b.dataset.act === 'delstr') deleteString(S.sel.id);
    return;
  }
  const it = S.items.get(S.sel.id); if (!it) return;
  if (b.dataset.color) { it.color = b.dataset.color; if (it.kind === 'postit') S.lastPostit = it.color; }
  else if (b.dataset.pin) it.pin_color = b.dataset.pin;
  else switch (b.dataset.act) {
    case 'rotl': it.rot = Math.round(((it.rot || 0) - 4) * 10) / 10; break;
    case 'rotr': it.rot = Math.round(((it.rot || 0) + 4) * 10) / 10; break;
    case 'back': {
      let mn = Infinity; for (const o of S.items.values()) mn = Math.min(mn, o.z || 0);
      it.z = mn - 1; break;
    }
    case 'photo': pickPhoto(it.id); return;
    case 'unphoto': it.kind = 'placeholder'; it.image_path = null; break;
    case 'del': deleteItem(it.id); return;
    default: return;
  }
  renderItem(it); renderStrings(); renderSelbar();
  commit(it);
});

/* ---------- text editing ---------- */
function startEdit(id, field) {
  const it = S.items.get(id); if (!it) return;
  const el = document.querySelector(`#it-${id} [data-field="${field}"]`); if (!el) return;
  endEdit();
  S.editing = { id, field, el };
  try { el.contentEditable = 'plaintext-only'; } catch { el.contentEditable = 'true'; }
  if (el.contentEditable !== 'plaintext-only') el.contentEditable = 'true';
  el.focus();
  const range = document.createRange(); range.selectNodeContents(el); range.collapse(false);
  const s = getSelection(); s.removeAllRanges(); s.addRange(range);
  el.oninput = () => {
    const cur = S.items.get(id); if (!cur) return;
    cur[field] = el.innerText.replace(/\n$/, '').slice(0, field === 'body' ? 5000 : 300);
    commit(cur, { delay: 500 });
  };
  el.onkeydown = e => {
    if (e.key === 'Escape' || (e.key === 'Enter' && field !== 'body' && !e.shiftKey)) { e.preventDefault(); el.blur(); }
    e.stopPropagation();
  };
  el.onblur = () => endEdit();
}
function endEdit() {
  const ed = S.editing; if (!ed) return;
  S.editing = null;
  ed.el.removeAttribute('contenteditable');
  ed.el.oninput = ed.el.onkeydown = ed.el.onblur = null;
  const it = S.items.get(ed.id);
  if (it) { renderItem(it); persistItem(it, 0); }
}

/* ---------- pointer interaction ---------- */
const pointers = new Map();
function hitItemAt(cx, cy, exclude) {
  for (const el of document.elementsFromPoint(cx, cy)) {
    const t = el.closest?.('.item,.pin');
    if (t && t.dataset.id !== exclude && S.items.has(t.dataset.id)) return t.dataset.id;
  }
  return null;
}

viewport.addEventListener('pointerdown', e => {
  if (e.button !== 0 && e.pointerType === 'mouse') {
    if (e.button === 1) startPan(e);
    return;
  }
  pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  if (pointers.size === 2 && (S.drag?.type === 'pan' || !S.drag)) { startPinch(); return; }
  if (S.drag) return;

  const t = e.target;
  if (S.editing && S.editing.el.contains(t)) return;   // let the text cursor work
  const w = toWorld(e.clientX, e.clientY);

  const pin = t.closest('.pin');
  if (pin) {
    S.drag = { type: 'yarn', from: pin.dataset.id, to: w, sx: e.clientX, sy: e.clientY, moved: false };
    viewport.setPointerCapture(e.pointerId);
    return;
  }
  const end = t.closest('.y-end');
  if (end && S.strings.has(end.dataset.sid)) {
    const st = S.strings.get(end.dataset.sid);
    S.drag = { type: 'retie', sid: st.id, end: end.dataset.end, fixed: end.dataset.end === 'from' ? st.to_item : st.from_item, to: w, moved: false };
    viewport.setPointerCapture(e.pointerId);
    renderStrings();
    return;
  }
  const yarn = t.closest('.yarn');
  if (yarn && yarn.dataset.sid) { endEdit(); select({ type: 'string', id: yarn.dataset.sid }); return; }

  const additive = e.shiftKey || e.ctrlKey || e.metaKey;
  const itemEl = t.closest('.item');
  if (itemEl) {
    const it = S.items.get(itemEl.dataset.id); if (!it) return;
    if (S.editing && S.editing.id !== it.id) endEdit();
    if (additive) {                       // shift/ctrl-click toggles it in the selection
      const ids = new Set(selIds());
      if (ids.has(it.id)) { ids.delete(it.id); selectItems([...ids]); return; }
      ids.add(it.id); selectItems([...ids]);
    } else if (!isSelected(it.id)) select({ type: 'item', id: it.id });
    if (t.closest('.rs') && !S.multi.size) {
      S.drag = { type: 'resize', id: it.id, w0: it.w, h0: it.h, sx: w.x, sy: w.y, moved: false };
    } else {
      // move everything selected; the grabbed item comes to the front
      const top = maxZ(), z0 = it.z;
      if ((it.z || 0) < top || [...S.items.values()].filter(o => o.z === top).length > 1) it.z = top + 1;
      const ids = selIds().includes(it.id) ? selIds() : [it.id];
      const orig = new Map(ids.map(id => { const o = S.items.get(id); return [id, { x: o.x, y: o.y }]; }));
      S.drag = { type: 'move', id: it.id, ids, orig, sx: w.x, sy: w.y, cx: e.clientX, cy: e.clientY, moved: false, zBumped: it.z !== z0 };
    }
    renderItem(it);
    viewport.setPointerCapture(e.pointerId);
    return;
  }
  endEdit();
  if (additive || S.tool === 'select') {   // rubber-band selection on empty cork
    S.drag = { type: 'box', sx: w.x, sy: w.y, x: w.x, y: w.y, add: additive ? selIds() : [] };
    if (!additive) select(null);
    viewport.setPointerCapture(e.pointerId);
    return;
  }
  select(null);
  startPan(e);
});

const marquee = document.createElement('div');
marquee.id = 'marquee'; marquee.hidden = true;
world.appendChild(marquee);
function boxRect(d) {
  return { x0: Math.min(d.sx, d.x), y0: Math.min(d.sy, d.y), x1: Math.max(d.sx, d.x), y1: Math.max(d.sy, d.y) };
}
function drawMarquee(d) {
  const r = boxRect(d);
  marquee.hidden = false;
  Object.assign(marquee.style, { left: r.x0 + 'px', top: r.y0 + 'px', width: (r.x1 - r.x0) + 'px', height: (r.y1 - r.y0) + 'px', borderWidth: (1.5 / S.view.s) + 'px' });
}
function itemsInBox(d) {
  const r = boxRect(d);
  return [...S.items.values()].filter(it => it.x < r.x1 && it.x + it.w > r.x0 && it.y < r.y1 && it.y + it.h > r.y0).map(it => it.id);
}

function startPan(e) {
  S.drag = { type: 'pan', sx: e.clientX, sy: e.clientY, vx: S.view.x, vy: S.view.y };
  viewport.classList.add('panning');
  viewport.setPointerCapture(e.pointerId);
}
function startPinch() {
  const [a, b] = [...pointers.values()];
  S.drag = { type: 'pinch', d0: Math.hypot(a.x - b.x, a.y - b.y), s0: S.view.s, mx: (a.x + b.x) / 2, my: (a.y + b.y) / 2, vx: S.view.x, vy: S.view.y };
}

let lastCursorSent = 0;
viewport.addEventListener('pointermove', e => {
  if (pointers.has(e.pointerId)) pointers.set(e.pointerId, { x: e.clientX, y: e.clientY });
  const w = toWorld(e.clientX, e.clientY);
  const now = performance.now();
  if (S.channel && now - lastCursorSent > 50 && e.pointerType === 'mouse') {
    lastCursorSent = now;
    S.channel.send({ type: 'broadcast', event: 'cursor', payload: { id: me.id, x: Math.round(w.x), y: Math.round(w.y), name: me.name, color: me.color } }).catch(() => {});
  }
  const d = S.drag; if (!d) return;
  switch (d.type) {
    case 'pan':
      S.view.x = d.vx + (e.clientX - d.sx); S.view.y = d.vy + (e.clientY - d.sy); applyView(); break;
    case 'pinch': {
      if (pointers.size < 2) return;
      const [a, b] = [...pointers.values()];
      const ns = clamp(d.s0 * Math.hypot(a.x - b.x, a.y - b.y) / d.d0, MIN_S, MAX_S);
      const r = viewport.getBoundingClientRect();
      const mx = (a.x + b.x) / 2 - r.left, my = (a.y + b.y) / 2 - r.top, m0x = d.mx - r.left, m0y = d.my - r.top;
      S.view.s = ns;
      S.view.x = mx - (m0x - d.vx) * (ns / d.s0);
      S.view.y = my - (m0y - d.vy) * (ns / d.s0);
      applyView(); break;
    }
    case 'move': {
      if (!d.moved && Math.hypot(e.clientX - d.cx, e.clientY - d.cy) < 3) return;
      d.moved = true;
      const dx = w.x - d.sx, dy = w.y - d.sy;
      for (const id of d.ids) {
        const it = S.items.get(id), o = d.orig.get(id); if (!it || !o) continue;
        it.x = clamp(Math.round(o.x + dx), -it.w / 2, WORLD_W - it.w / 2);
        it.y = clamp(Math.round(o.y + dy), -it.h / 4, WORLD_H - it.h / 2);
        schedule(it.id); commitLive(it);
      }
      break;
    }
    case 'box':
      d.x = w.x; d.y = w.y; drawMarquee(d); break;
    case 'retie':
      d.moved = true; d.to = w; schedule(null); break;
    case 'resize': {
      d.moved = true;
      const it = S.items.get(d.id); if (!it) return;
      it.w = clamp(Math.round(d.w0 + w.x - d.sx), 120, 900);
      it.h = clamp(Math.round(d.h0 + w.y - d.sy), 110, 900);
      schedule(it.id); commitLive(it); break;
    }
    case 'yarn':
      if (Math.hypot(e.clientX - d.sx, e.clientY - d.sy) > 4) d.moved = true;
      d.to = w; schedule(null); break;
  }
});

function endPointer(e) {
  pointers.delete(e.pointerId);
  const d = S.drag; if (!d) return;
  if (d.type === 'pinch') { if (pointers.size === 0) S.drag = null; return; }
  S.drag = null;
  viewport.classList.remove('panning');
  if (d.type === 'move' && d.moved) {
    for (const id of d.ids) { const it = S.items.get(id); if (it) { commit(it); renderItem(it); } }
    renderStrings();
  } else if (d.type === 'resize' && d.moved) {
    const it = S.items.get(d.id); if (it) { commit(it); renderItem(it); renderStrings(); }
  } else if (d.type === 'box') {
    marquee.hidden = true;
    selectItems([...d.add, ...itemsInBox(d)]);
  } else if (d.type === 'retie') {
    if (d.moved && e.type === 'pointerup') {
      const target = hitItemAt(e.clientX, e.clientY, d.fixed);
      if (target) retieString(d.sid, d.end, target);
    }
    renderStrings(); renderSelbar();
  } else if (d.type === 'move' && d.zBumped) {
    const it = S.items.get(d.id); if (it) commit(it);  // brought to front
  } else if (d.type === 'yarn') {
    if (d.moved && e.type === 'pointerup') {
      const target = hitItemAt(e.clientX, e.clientY, d.from);
      if (target) addString(d.from, target);
    } else if (!d.moved) select({ type: 'item', id: d.from });
    renderStrings();
  }
  positionSelbar();
}
viewport.addEventListener('pointerup', endPointer);
viewport.addEventListener('pointercancel', endPointer);

viewport.addEventListener('dblclick', e => {
  const itemEl = e.target.closest('.item'); if (!itemEl) return;
  const it = S.items.get(itemEl.dataset.id); if (!it) return;
  if (e.target.closest('.ph-box')) { pickPhoto(it.id); return; }
  let f = e.target.closest('[data-field]')?.dataset.field;
  if (!f) f = it.kind === 'card' ? (e.target.closest('.photo-wrap') ? null : 'body') : it.kind === 'postit' ? 'body' : 'title';
  if (f) startEdit(it.id, f);
});

viewport.addEventListener('wheel', e => {
  e.preventDefault();
  if (e.ctrlKey || e.deltaMode !== 0 || Math.abs(e.deltaY) >= 40 && Math.abs(e.deltaX) < 2) {
    zoomAt(e.clientX, e.clientY, S.view.s * Math.exp(-e.deltaY * (e.ctrlKey ? 0.01 : 0.0015)));
  } else {   // trackpad two-finger scroll pans
    S.view.x -= e.deltaX; S.view.y -= e.deltaY; applyView();
  }
}, { passive: false });

/* drag & drop + paste */
viewport.addEventListener('dragover', e => {
  if (![...e.dataTransfer.types].includes('Files')) return;
  e.preventDefault();
  document.querySelectorAll('.ph-box.drop').forEach(b => b.classList.remove('drop'));
  e.target.closest?.('.k-placeholder')?.querySelector('.ph-box')?.classList.add('drop');
});
viewport.addEventListener('dragleave', () => document.querySelectorAll('.ph-box.drop').forEach(b => b.classList.remove('drop')));
viewport.addEventListener('drop', e => {
  e.preventDefault();
  document.querySelectorAll('.ph-box.drop').forEach(b => b.classList.remove('drop'));
  const files = [...e.dataTransfer.files].filter(f => f.type.startsWith('image/'));
  if (!files.length) return;
  const target = e.target.closest?.('.item');
  const it = target && S.items.get(target.dataset.id);
  if (it && (it.kind === 'placeholder' || it.kind === 'photo')) { fillPhoto(it.id, files[0]); return; }
  const w = toWorld(e.clientX, e.clientY);
  addPhotos(files, w);
});
document.addEventListener('paste', e => {
  if (!S.loaded || S.editing || e.target.closest?.('input,textarea,[contenteditable]')) return;
  const files = [...(e.clipboardData?.files || [])].filter(f => f.type.startsWith('image/'));
  if (files.length) {
    e.preventDefault();
    const it = S.sel?.type === 'item' && S.items.get(S.sel.id);
    if (it && it.kind === 'placeholder') fillPhoto(it.id, files[0]); else addPhotos(files);
    return;
  }
  const text = e.clipboardData?.getData('text/plain')?.trim();
  if (text) { e.preventDefault(); addItem('postit', null, { body: text.slice(0, 5000) }); }
});

document.addEventListener('keydown', e => {
  if (!S.loaded || S.editing || e.target.closest?.('input,textarea,[contenteditable]')) return;
  const ids = selIds();
  if ((e.key === 'Delete' || e.key === 'Backspace') && (S.sel || ids.length)) {
    e.preventDefault();
    if (S.sel?.type === 'string') deleteString(S.sel.id);
    else { ids.forEach(deleteItem); select(null); }
  } else if (e.key === 'Escape') select(null);
  else if (e.key.startsWith('Arrow') && ids.length) {   // nudge: 10px, Shift 50px, Alt 1px
    e.preventDefault();
    const step = e.shiftKey ? 50 : e.altKey ? 1 : 10;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    for (const id of ids) {
      const it = S.items.get(id);
      it.x = clamp(it.x + dx, -it.w / 2, WORLD_W - it.w / 2);
      it.y = clamp(it.y + dy, -it.h / 4, WORLD_H - it.h / 2);
      renderItem(it); commit(it, { delay: 350 });
    }
    renderStrings(); positionSelbar();
  } else if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'a') {
    e.preventDefault(); selectItems([...S.items.keys()]);
  } else if (e.key.toLowerCase() === 'v' && !e.ctrlKey && !e.metaKey) setTool('select');
  else if (e.key.toLowerCase() === 'h' && !e.ctrlKey && !e.metaKey) setTool('pan');
  else if (e.key === 'Enter' && S.sel?.type === 'item') {
    e.preventDefault();
    const it = S.items.get(S.sel.id);
    startEdit(it.id, it.kind === 'postit' || it.kind === 'card' ? 'body' : 'title');
  }
});

/* ---------- toolbar ---------- */
$('#toolbar').addEventListener('click', e => {
  const b = e.target.closest('button'); if (!b) return;
  if (b.dataset.tool) return setTool(S.tool === 'select' ? 'pan' : 'select');
  if (b.dataset.add === 'photo') return pickPhoto(null);
  if (b.dataset.add) {
    endEdit();
    const it = addItem(b.dataset.add);
    startEdit(it.id, it.kind === 'card' || it.kind === 'placeholder' ? 'title' : 'body');
    return;
  }
  if (b.dataset.yarn) {
    S.yarnColor = b.dataset.yarn; store.set('pb_yarn', S.yarnColor); renderYarnPicker();
    if (S.sel?.type === 'string') recolorString(S.sel.id, S.yarnColor);
    return;
  }
  const r = viewport.getBoundingClientRect();
  if (b.dataset.zoom === 'in') zoomAt(r.left + r.width / 2, r.top + r.height / 2, S.view.s * 1.25);
  if (b.dataset.zoom === 'out') zoomAt(r.left + r.width / 2, r.top + r.height / 2, S.view.s / 1.25);
  if (b.dataset.zoom === 'fit') fitView();
});
function setTool(tool) {
  S.tool = tool;
  const b = $('#toolbar [data-tool]');
  b.classList.toggle('on', tool === 'select');
  b.title = tool === 'select' ? 'Select tool is on: drag on the cork to box-select (V). Click again to go back to panning (H).' : 'Select tool: drag on the cork to box-select several items (V)';
  viewport.classList.toggle('selecting', tool === 'select');
}
function renderYarnPicker() {
  $('#yarnColors').innerHTML = YARN_COLORS.map(c => swatch(c, c === S.yarnColor, 'data-yarn')).join('');
}

/* ---------- presence + cursors ---------- */
const remoteCursors = new Map();   // id -> {x,y,name,color,el,t}
const CURSOR_SVG = c => `<svg viewBox="0 0 20 20"><path d="M2 1l15 8-6.5 1.6L7.5 17z" fill="${c}" stroke="#fff" stroke-width="1.4" stroke-linejoin="round"/></svg>`;
function renderCursors() {
  for (const c of remoteCursors.values()) {
    c.el.style.transform = `translate(${c.x}px,${c.y}px) scale(${1 / S.view.s})`;
  }
}
function updateCursor(p) {
  if (!p || p.id === me.id || !S.peers[p.id]) return;
  let c = remoteCursors.get(p.id);
  if (!c) {
    const el = document.createElement('div'); el.className = 'cursor';
    cursorsEl.appendChild(el);
    c = { el }; remoteCursors.set(p.id, c);
  }
  const color = safeColor(p.color, '#888');
  if (c.color !== color || c.name !== p.name) {
    c.el.innerHTML = CURSOR_SVG(color) + '<span></span>';
    const sp = c.el.querySelector('span'); sp.textContent = String(p.name || '?').slice(0, 40); sp.style.background = color;
    c.color = color; c.name = p.name;
  }
  c.x = +p.x || 0; c.y = +p.y || 0; c.t = Date.now();
  c.el.style.opacity = 1;
  c.el.style.transform = `translate(${c.x}px,${c.y}px) scale(${1 / S.view.s})`;
}
setInterval(() => {
  const now = Date.now();
  for (const [id, c] of remoteCursors) {
    if (!S.peers[id]) { c.el.remove(); remoteCursors.delete(id); }
    else if (now - c.t > 6000) c.el.style.opacity = 0;
  }
}, 1000);

function renderPeers() {
  const box = $('#peers'); box.innerHTML = '';
  const list = Object.entries(S.peers);
  for (const [id, p] of list) {
    const d = document.createElement('div'); d.className = 'peer';
    d.style.background = safeColor(p.color, '#888');
    const nm = String(p.name || '?');
    d.textContent = nm.trim().slice(0, 1).toUpperCase() || '?';
    d.title = nm + (id === me.id ? ' (you)' : '');
    box.appendChild(d);
  }
}
const heldTimers = new Map();
function markHeld(id, by) {
  const el = document.getElementById('it-' + id); if (!el) return;
  const p = S.peers[by]; if (!p) return;
  el.style.setProperty('--held', safeColor(p.color, '#888'));
  el.classList.add('held');
  clearTimeout(heldTimers.get(id));
  heldTimers.set(id, setTimeout(() => el.classList.remove('held'), 600));
}
function setConn(state) {
  const c = $('#conn'); c.className = 'conn ' + (state === true ? 'ok' : state === false ? 'bad' : '');
  c.title = state === true ? 'Live' : state === false ? 'Reconnecting…' : 'Connecting…';
}

/* ---------- remote events ---------- */
function sanitizeItem(raw) {
  if (!raw || !isUuid(raw.id) || !DEFAULTS[raw.kind]) return null;
  const num = (v, d) => Number.isFinite(+v) ? +v : d;
  return {
    id: raw.id, kind: raw.kind,
    x: num(raw.x, 0), y: num(raw.y, 0), w: clamp(num(raw.w, 200), 60, 2000), h: clamp(num(raw.h, 200), 60, 2000),
    rot: clamp(num(raw.rot, 0), -360, 360), z: Math.round(num(raw.z, 0)),
    color: isColor(raw.color) ? raw.color : null, pin_color: isColor(raw.pin_color) ? raw.pin_color : null,
    title: raw.title == null ? '' : String(raw.title), body: raw.body == null ? '' : String(raw.body),
    image_path: typeof raw.image_path === 'string' && raw.image_path.startsWith(boardId + '/') ? raw.image_path : null,
    created_by: raw.created_by ? String(raw.created_by) : null,
  };
}
function onRemoteItem({ item, live, by }) {
  const it = sanitizeItem(item); if (!it) return;
  const d = S.drag;
  if (d && (d.type === 'move' || d.type === 'resize') && (d.ids || [d.id]).includes(it.id)) return;   // I'm holding it
  const cur = S.items.get(it.id);
  if (cur && S.editing?.id === it.id) it[S.editing.field] = cur[S.editing.field];
  S.items.set(it.id, it);
  renderItem(it); schedule(null);
  if (S.sel?.id === it.id) renderSelbar(); else if (S.multi.has(it.id)) positionSelbar();
  if (live) markHeld(it.id, by);
}
function onRemoteItemDel({ id }) {
  if (!S.items.has(id)) return;
  if (S.editing?.id === id) { S.editing = null; }
  S.items.delete(id);
  for (const [sid, s] of S.strings) if (s.from_item === id || s.to_item === id) S.strings.delete(sid);
  removeItemEl(id);
  if (S.sel?.id === id) select(null);
  if (S.multi.delete(id)) selectItems([...S.multi]);
  renderStrings();
}
function onRemoteString({ string: s }) {
  if (!s || !isUuid(s.id) || !isUuid(s.from_item) || !isUuid(s.to_item)) return;
  S.strings.set(s.id, { id: s.id, from_item: s.from_item, to_item: s.to_item, color: safeColor(s.color, YARN_COLORS[0]) });
  renderStrings();
}
function onRemoteStringDel({ id }) {
  if (!S.strings.delete(id)) return;
  if (S.sel?.id === id) select(null);
  renderStrings();
}

/* ---------- board load + realtime ---------- */
async function loadBoard() {
  const { data, error } = await sb.rpc('pb_get_board', { p_board: boardId });
  if (error) { toast('Couldn\'t load board: ' + error.message, true, 6000); return false; }
  if (!data) { $('#notFound').hidden = false; return false; }
  S.board = data.board;
  const titleEl = $('#boardTitle');
  if (document.activeElement !== titleEl) titleEl.value = S.board.title;
  document.title = S.board.title + ' · Pinboard';
  const keep = new Set([...(S.drag?.ids || []), S.drag?.id, S.editing?.id].filter(Boolean));
  const items = new Map();
  for (const raw of data.items || []) {
    const it = sanitizeItem(raw); if (!it) continue;
    // keep my local copy if I'm holding it or have an unsaved write for it in flight
    const mine = keep.has(it.id) || saveTimers.has(it.id) || chains.has(it.id);
    items.set(it.id, mine && S.items.has(it.id) ? S.items.get(it.id) : it);
  }
  for (const [id, it] of S.items) if (!items.has(id) && (saveTimers.has(id) || chains.has(id))) items.set(id, it);
  S.items = items;
  const strings = new Map((data.strings || []).map(s => [s.id, { id: s.id, from_item: s.from_item, to_item: s.to_item, color: safeColor(s.color, YARN_COLORS[0]) }]));
  for (const [id, s] of S.strings) if (chains.has(id)) { if (strings.has(id) || S.strings.has(id)) strings.set(id, s); }
  for (const id of [...strings.keys()]) if (chains.has(id) && !S.strings.has(id)) strings.delete(id);   // pending local cut
  S.strings = strings;
  renderAll();
  rememberBoard();
  return true;
}
function rememberBoard() {
  const list = store.get('pb_recent', []).filter(b => b.id !== boardId);
  list.unshift({ id: boardId, title: S.board?.title || 'Untitled board', at: Date.now() });
  store.set('pb_recent', list.slice(0, 12));
}
function connect() {
  const ch = sb.channel('pb:' + boardId, { config: { broadcast: { self: false }, presence: { key: me.id } } });
  ch.on('broadcast', { event: 'item' }, ({ payload }) => onRemoteItem(payload))
    .on('broadcast', { event: 'item_del' }, ({ payload }) => onRemoteItemDel(payload))
    .on('broadcast', { event: 'string' }, ({ payload }) => onRemoteString(payload))
    .on('broadcast', { event: 'string_del' }, ({ payload }) => onRemoteStringDel(payload))
    .on('broadcast', { event: 'cursor' }, ({ payload }) => updateCursor(payload))
    .on('broadcast', { event: 'board' }, ({ payload }) => {
      if (!S.board || typeof payload.title !== 'string') return;
      S.board.title = payload.title;
      if (document.activeElement !== $('#boardTitle')) $('#boardTitle').value = payload.title;
      document.title = payload.title + ' · Pinboard';
    })
    .on('presence', { event: 'sync' }, () => {
      const st = ch.presenceState();
      S.peers = {};
      for (const [key, metas] of Object.entries(st)) if (metas[0]) S.peers[key] = { name: metas[0].name, color: metas[0].color };
      renderPeers();
    });
  let firstSub = true;
  ch.subscribe(async status => {
    if (status === 'SUBSCRIBED') {
      setConn(true);
      await ch.track({ name: me.name, color: me.color });
      if (!firstSub) loadBoard();   // catch up on anything missed while disconnected
      firstSub = false;
    } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT' || status === 'CLOSED') setConn(false);
  });
  S.channel = ch;
}
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible' && S.loaded && !S.drag && !S.editing) loadBoard();
});

/* ---------- board title ---------- */
$('#boardTitle').addEventListener('change', async e => {
  const title = e.target.value.trim().slice(0, 120) || 'Untitled board';
  e.target.value = title; S.board.title = title; document.title = title + ' · Pinboard';
  bcast('board', { title });
  rememberBoard();
  const { error } = await sb.rpc('pb_rename_board', { p_board: boardId, p_title: title });
  if (error) toast('Couldn\'t rename: ' + error.message, true);
});
$('#boardTitle').addEventListener('keydown', e => { if (e.key === 'Enter') e.target.blur(); });

$('#shareBtn').addEventListener('click', async () => {
  const url = location.origin + location.pathname + '?b=' + boardId;
  try { await navigator.clipboard.writeText(url); toast('Link copied — anyone with it can join and edit'); }
  catch { prompt('Copy this link:', url); }
});

/* ---------- identity ---------- */
function askName() {
  return new Promise(resolve => {
    const modal = $('#nameModal');
    $('#nameInput').value = me.name;
    let color = me.color;
    const paint = () => { $('#meColors').innerHTML = USER_COLORS.map(c => swatch(c, c === color, 'data-mc')).join(''); };
    paint();
    $('#meColors').onclick = e => { const b = e.target.closest('[data-mc]'); if (b) { color = b.dataset.mc; paint(); } };
    modal.hidden = false;
    setTimeout(() => $('#nameInput').focus(), 30);
    $('#nameForm').onsubmit = e => {
      e.preventDefault();
      me.name = $('#nameInput').value.trim().slice(0, 40) || 'Anonymous';
      me.color = color;
      store.set('pb_me', { name: me.name, color: me.color });
      modal.hidden = true;
      paintMe();
      resolve();
    };
  });
}
function paintMe() {
  const chip = $('#meChip');
  chip.innerHTML = '<i></i><span></span>';
  chip.querySelector('i').style.background = me.color;
  chip.querySelector('span').textContent = me.name;
  chip.title = 'Change your name or colour';
}
$('#meChip').addEventListener('click', async () => {
  await askName();
  if (S.channel) S.channel.track({ name: me.name, color: me.color });
});

/* ---------- landing ---------- */
function showLanding() {
  $('#landing').hidden = false;
  // show an empty decorative board behind the card
  requestAnimationFrame(fitView);
  const recent = store.get('pb_recent', []);
  if (recent.length) {
    $('#recentWrap').hidden = false;
    const ul = $('#recent'); ul.innerHTML = '';
    for (const b of recent) {
      if (!isUuid(b.id)) continue;
      const li = document.createElement('li'); const a = document.createElement('a');
      a.href = '?b=' + b.id; a.textContent = b.title || 'Untitled board';
      li.appendChild(a); ul.appendChild(li);
    }
  }
  $('#newBoardForm').onsubmit = async e => {
    e.preventDefault();
    const btn = e.submitter; if (btn) btn.disabled = true;
    const { data, error } = await sb.rpc('pb_create_board', { p_title: $('#newBoardTitle').value });
    if (error || !data) { toast('Couldn\'t create board: ' + (error?.message || 'unknown'), true); if (btn) btn.disabled = false; return; }
    location.search = '?b=' + data;
  };
  setTimeout(() => $('#newBoardTitle').focus(), 50);
}

/* ---------- boot ---------- */
async function boot() {
  renderYarnPicker();
  applyView();
  addEventListener('resize', positionSelbar);
  if (!boardId) { showLanding(); return; }
  if (!me.name) await askName(); else paintMe();
  ['#boardTitle', '#meChip', '#shareBtn', '#toolbar', '#hint'].forEach(s => $(s).hidden = false);
  setConn(null);
  const ok = await loadBoard();
  if (!ok) return;
  S.loaded = true;
  fitView();
  connect();
  setTimeout(() => { $('#hint').hidden = true; }, 15000);
}
boot();
