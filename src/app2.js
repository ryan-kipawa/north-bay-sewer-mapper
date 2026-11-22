/* ===================================================================
   North Bay Sewer Mapper — app, part 2: model, tools, clues, export
   =================================================================== */
const SYS_COL = { storm: '#1f63c6', sanitary: '#9a4a1c' };
const KINDS = { mh: 'Maintenance hole', cb: 'Catch basin', outfall: 'Outfall', storage: 'Storage / pond', pump: 'Pump station (wet well)', unknown: 'Unknown lid' };
const PREFIX = (kind, sys) => ({ mh: sys === 'sanitary' ? 'SA' : 'ST', cb: 'CB', outfall: sys === 'sanitary' ? 'SO' : 'OF', storage: 'SU', pump: 'PS', unknown: 'UK' }[kind] || 'N');
const EVIDENCE = ['imagery', 'street view', 'drawing', 'OSM', 'lidar low spot', 'melt ring', 'construction', 'field'];
const DIAMS = [150, 200, 250, 300, 375, 450, 525, 600, 675, 750, 825, 900, 975, 1050, 1200, 1350, 1500, 1800, 2100, 2400];
const MATERIALS = ['PVC', 'Concrete', 'Reinforced concrete', 'Vitrified clay', 'Asbestos cement', 'HDPE', 'Corrugated steel', 'Ductile iron', 'Unknown'];

/* ---------- ids & lookup ---------- */
function nextId(prefix) {
  let mx = 0; const re = new RegExp('^' + prefix.replace(/[-]/g, '\\-') + '-(\\d+)$');
  [...S.P.nodes, ...S.P.links, ...S.P.subs].forEach(f => { const m = String(f.id).match(re); if (m) mx = Math.max(mx, +m[1]); });
  return `${prefix}-${String(mx + 1).padStart(3, '0')}`;
}
const getNode = id => S.P.nodes.find(n => n.id === id);
const getLink = id => S.P.links.find(l => l.id === id);
const getSub = id => S.P.subs.find(s => s.id === id);
const getSel = () => !S.sel ? null : S.sel.t === 'node' ? getNode(S.sel.id) : S.sel.t === 'link' ? getLink(S.sel.id) : getSub(S.sel.id);
function centroid(coords) { let a = 0, b = 0; coords.forEach(c => { a += c[0]; b += c[1]; }); return [a / coords.length, b / coords.length]; }
function nearestNode(ll, sys, maxD = 30, filter) {
  const p = Array.isArray(ll) ? ll : [ll.lat, ll.lng]; let best = null, bd = maxD;
  S.P.nodes.forEach(n => { if (sys && n.sys !== sys) return; if (filter && !filter(n)) return; const d = NB.dist(p, [n.lat, n.lng]); if (d < bd) { bd = d; best = n; } });
  return best;
}

/* ---------- change management ---------- */
function mutate(fn) { S.undo.push(JSON.stringify(S.P)); if (S.undo.length > 30) S.undo.shift(); fn(); afterChange(); }
function afterChange() {
  if (S.sel && !getSel()) S.sel = null;
  S.derived = NB.derive(S.P, S.settings);
  store.set('project', S.P);
  render(); renderEditor(); renderIssues(); renderSummary(); renderFeatList();
  if (typeof renderAccuracy === 'function') renderAccuracy();
}
function undo() { const s = S.undo.pop(); if (!s) { toast('Nothing to undo'); return; } S.P = JSON.parse(s); afterChange(); toast('Undone'); }

/* ---------- rendering ---------- */
const G = { subs: L.layerGroup().addTo(map), links: L.layerGroup().addTo(map), nodes: L.layerGroup().addTo(map), temp: L.layerGroup().addTo(map) };
function nodeColor(n) { if (n.kind === 'cb') return n.sys === 'storm' ? '#0b8f9b' : SYS_COL.sanitary; if (n.kind === 'outfall') return n.sys === 'storm' ? '#2b7a4b' : '#6b3a1c'; if (n.kind === 'unknown') return '#6b7280'; return SYS_COL[n.sys]; }
function nodeIcon(n, sel, sev) {
  const col = nodeColor(n), dash = n.conf === 'low' ? 'stroke-dasharray="2.5 2"' : '';
  let sh;
  switch (n.kind) {
    case 'cb': sh = `<rect x="-5.5" y="-5.5" width="11" height="11" rx="1.5" fill="${col}" stroke="#fff" stroke-width="1.6" ${dash}/><path d="M-3-3v6M0-3v6M3-3v6" stroke="#fff" stroke-width=".9"/>`; break;
    case 'outfall': sh = `<path d="M0-7L7 5H-7Z" fill="${col}" stroke="#fff" stroke-width="1.6" stroke-linejoin="round" ${dash}/>`; break;
    case 'storage': sh = `<rect x="-7" y="-6" width="14" height="12" rx="3" fill="${col}" stroke="#fff" stroke-width="1.6" ${dash}/><path d="M-4.5 1q1.5-2 3 0t3 0 3 0" stroke="#fff" fill="none" stroke-width="1"/>`; break;
    case 'pump': sh = `<circle r="7" fill="${col}" stroke="#fff" stroke-width="1.6" ${dash}/><text y="3.3" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="sans-serif">P</text>`; break;
    case 'unknown': sh = `<circle r="6.5" fill="${col}" stroke="#fff" stroke-width="1.6" ${dash}/><text y="3.3" text-anchor="middle" font-size="9" font-weight="700" fill="#fff" font-family="sans-serif">?</text>`; break;
    default: sh = `<circle r="6.5" fill="${col}" stroke="#fff" stroke-width="1.6" ${dash}/><path d="M-3.5 0h7M0-3.5v7" stroke="#fff" stroke-width="1"/>`;
  }
  const ring = sel ? '<circle r="11" fill="none" stroke="#f59f00" stroke-width="2.5"/>' : '';
  const dot = sev ? `<circle cx="7" cy="-7" r="3" fill="${sev === 'error' ? '#c0392b' : '#e8a33a'}" stroke="#fff" stroke-width="1"/>` : '';
  return L.divIcon({ className: 'nb-node', iconSize: [28, 28], iconAnchor: [14, 14], html: `<svg width="28" height="28" viewBox="-14 -14 28 28">${ring}${sh}${dot}</svg>` });
}
function arrowIcon(deg, col) {
  return L.divIcon({ className: 'nb-arrow', iconSize: [14, 14], iconAnchor: [7, 7], html: `<svg width="14" height="14" viewBox="-7 -7 14 14" style="transform:rotate(${deg}deg)"><path d="M-4 3L0-4L4 3" fill="none" stroke="${col}" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"/><path d="M-4 3L0-4L4 3" fill="none" stroke="#fff" stroke-width=".8" stroke-linecap="round" stroke-linejoin="round"/></svg>` });
}
function render() {
  G.subs.clearLayers(); G.links.clearLayers(); G.nodes.clearLayers();
  const D = S.derived, sev = new Map();
  D.issues.forEach(i => { if (i.sev === 'info') return; const k = i.kind + ':' + i.id; if (sev.get(k) !== 'error') sev.set(k, i.sev); });
  const isSel = (t, id) => S.sel && S.sel.t === t && S.sel.id === id;
  const labels = map.getZoom() >= 19;
  S.P.subs.forEach(s => {
    const col = SYS_COL[s.sys], sel = isSel('sub', s.id);
    const pg = L.polygon(s.coords, { pane: 'subs', color: sel ? '#f59f00' : col, weight: sel ? 3 : 1.5, fillOpacity: s.sys === 'storm' ? 0.12 : 0.08, dashArray: s.sys === 'sanitary' ? '6 4' : null, bubblingMouseEvents: false });
    pg.on('click', e => { L.DomEvent.stop(e); onFeatureClick('sub', s.id, e.latlng); });
    G.subs.addLayer(pg);
    const o = getNode(s.outlet);
    if (o) G.subs.addLayer(L.polyline([centroid(s.coords), [o.lat, o.lng]], { pane: 'subs', color: col, weight: 1, dashArray: '2 4', interactive: false }));
  });
  const nodes = new Map(S.P.nodes.map(n => [n.id, n]));
  S.P.links.forEach(l => {
    const a = nodes.get(l.from), b = nodes.get(l.to); if (!a || !b) return;
    const pts = [[a.lat, a.lng], ...(l.verts || []), [b.lat, b.lng]], col = SYS_COL[l.sys] || '#555', sel = isSel('link', l.id);
    const w = 2.5 + Math.min(5, (NB.num(l.diam) || 250) / 220), s = sev.get('link:' + l.id);
    if (sel) G.links.addLayer(L.polyline(pts, { pane: 'links', color: '#f59f00', weight: w + 6, opacity: 0.8, interactive: false }));
    if (s) G.links.addLayer(L.polyline(pts, { pane: 'links', color: s === 'error' ? '#c0392b' : '#e8a33a', weight: w + 4, opacity: 0.55, interactive: false }));
    const pl = L.polyline(pts, { pane: 'links', color: col, weight: w, opacity: 0.95, dashArray: l.conf === 'low' ? '7 6' : null, bubblingMouseEvents: false });
    pl.on('click', e => { L.DomEvent.stop(e); onFeatureClick('link', l.id, e.latlng); });
    G.links.addLayer(pl);
    // arrow at middle of the longest segment
    let bi = 0, bl = -1; for (let i = 1; i < pts.length; i++) { const d = NB.dist(pts[i - 1], pts[i]); if (d > bl) { bl = d; bi = i; } }
    const p = pts[bi - 1], q = pts[bi], m1 = NB.merc(p[0], p[1]), m2 = NB.merc(q[0], q[1]);
    const deg = Math.atan2(m2[0] - m1[0], m2[1] - m1[1]) * 180 / Math.PI;
    G.links.addLayer(L.marker([(p[0] + q[0]) / 2, (p[1] + q[1]) / 2], { icon: arrowIcon(deg, col), pane: 'links', interactive: false, keyboard: false }));
  });
  S.P.nodes.forEach(n => {
    const m = L.marker([n.lat, n.lng], { icon: nodeIcon(n, isSel('node', n.id), sev.get('node:' + n.id)), draggable: S.mode === 'pan', keyboard: false, riseOnHover: true, zIndexOffset: n.kind === 'cb' ? 0 : 100 });
    m.on('click', e => { L.DomEvent.stop(e); onFeatureClick('node', n.id, e.latlng); });
    m.on('dragend', e => { const ll = e.target.getLatLng(); mutate(() => { n.lat = ll.lat; n.lng = ll.lng; }); if (n.rimSrc !== 'entered') refreshRim(n.id, true); });
    if (labels) m.bindTooltip(esc(n.id), { permanent: true, direction: 'right', offset: [8, 0], className: 'nb-lab' });
    G.nodes.addLayer(m);
  });
}
let _lastLab = map.getZoom() >= 19;
map.on('zoomend', () => { const l = map.getZoom() >= 19; if (l !== _lastLab) { _lastLab = l; render(); } });

/* ---------- create / edit ---------- */
let _noElevT = 0;
async function refreshRim(id, quiet) {
  const n = getNode(id); if (!n) return;
  const r = await getElevation(n.lat, n.lng);
  if (!r) {
    if (!quiet) toast(`No elevation available for ${esc(id)}.`, { err: true });
    else if (Date.now() - _noElevT > 30000) { _noElevT = Date.now(); toast('Elevation services are not responding — rim elevations are left blank. Use “Fill missing rims” later or type them in.', { err: true }); }
    return;
  }
  const cur = getNode(id); if (!cur) return;
  mutate(() => { cur.rim = +r.z.toFixed(2); cur.rimSrc = r.src; });
}
function currentSeen() {
  if (S.imgA.startsWith('wb:')) { const c = S.capture.get(+S.imgA.slice(3)); const r = S.relByNum.get(+S.imgA.slice(3)); return c?.date ? `imagery ${c.date}` : r ? `Wayback ${r.date}` : ''; }
  return S.imgA === 'esri' ? '' : srcName(S.imgA);
}
function addNode(kind, sys, ll, extra = {}) {
  const id = nextId(PREFIX(kind, sys));
  const n = Object.assign({ id, kind, sys, lat: ll[0], lng: ll[1], rim: '', rimSrc: '', invert: '', conf: 'med', evidence: [], seen: currentSeen(), drawing: '', notes: '' }, extra);
  mutate(() => S.P.nodes.push(n));
  refreshRim(id, true);
  return n;
}
function createLink(from, to, verts = []) {
  const a = getNode(from), b = getNode(to); if (!a || !b || from === to) return;
  if (S.P.links.some(l => (l.from === from && l.to === to))) { toast('Those nodes are already connected.'); return; }
  const sys = a.kind === 'cb' && b.sys ? b.sys : a.sys;
  const id = nextId('C-' + (sys === 'sanitary' ? 'SA' : 'ST'));
  const diam = a.kind === 'cb' ? 200 : (S.lastDiam[sys] || '');
  mutate(() => S.P.links.push({ id, from, to, sys, diam, shape: 'CIRCULAR', material: '', n: '', upInv: '', dnInv: '', len: '', conf: a.conf === 'low' || b.conf === 'low' ? 'low' : 'med', drawing: '', notes: '', verts }));
  const ra = NB.num(a.rim), rb = NB.num(b.rim);
  if (ra !== null && rb !== null && rb > ra + 0.3 && b.kind !== 'outfall') toast(`${esc(id)} was drawn uphill (${ra.toFixed(1)} → ${rb.toFixed(1)} m ground). Gravity sewers usually run downhill.`, { action: ['Flip', () => flipLink(id)], ms: 8000 });
  select('link', id);
}
function flipLink(id) {
  const l = getLink(id); if (!l) return;
  mutate(() => {
    [l.from, l.to] = [l.to, l.from]; [l.upInv, l.dnInv] = [l.dnInv, l.upInv]; l.verts = (l.verts || []).slice().reverse();
    // inferred inverts followed the old direction; let the checks re-estimate them
    if (l.inferred) {
      l.verified = true; l.conf = 'high';
      if (NB.num(l.upInv) !== null && NB.num(l.dnInv) !== null && +l.upInv < +l.dnInv) {
        // restart from the new upstream node's invert and fall at minimum slope
        const iv = S.derived.inv.get(l.from), r = S.derived.links.get(l.id);
        if (iv !== null && iv !== undefined && r && r.len) { l.upInv = +iv.toFixed(3); l.dnInv = +(iv - (r.minSlope || 0.004) * r.len).toFixed(3); } else { l.upInv = ''; l.dnInv = ''; }
      }
    }
  });
}
function splitLink(id) {
  const l = getLink(id), a = getNode(l?.from), b = getNode(l?.to); if (!l || !a || !b) return;
  const pts = [[a.lat, a.lng], ...(l.verts || []), [b.lat, b.lng]], tot = NB.pathLength(pts);
  let acc = 0, mid = null, k = 1;
  for (; k < pts.length; k++) { const d = NB.dist(pts[k - 1], pts[k]); if (acc + d >= tot / 2) { const t = (tot / 2 - acc) / d; mid = [pts[k - 1][0] + (pts[k][0] - pts[k - 1][0]) * t, pts[k - 1][1] + (pts[k][1] - pts[k - 1][1]) * t]; break; } acc += d; }
  const nid = nextId(PREFIX('mh', l.sys));
  const l2id = nextId('C-' + (l.sys === 'sanitary' ? 'SA' : 'ST'));
  mutate(() => {
    S.P.nodes.push({ id: nid, kind: 'mh', sys: l.sys, lat: mid[0], lng: mid[1], rim: '', rimSrc: '', invert: '', conf: 'low', evidence: [], seen: '', drawing: l.drawing || '', notes: `Inserted on ${l.id}` });
    const v1 = (l.verts || []).slice(0, k - 1), v2 = (l.verts || []).slice(k - 1);
    S.P.links.push(Object.assign({}, l, { id: l2id, from: nid, to: l.to, upInv: '', verts: v2, len: '' }));
    Object.assign(l, { to: nid, dnInv: '', verts: v1, len: '' });
  });
  refreshRim(nid, true); select('node', nid);
}
function createSub(sys, coords, props = {}) {
  const id = nextId(sys === 'sanitary' ? 'SS' : 'S');
  let outlet = props.outlet;
  if (!outlet) { const o = nearestNode(centroid(coords), sys, 400); outlet = o ? o.id : ''; }
  mutate(() => S.P.subs.push(Object.assign({ id, sys, coords, outlet, landuse: '', imp: '', area: '', width: '', flowLen: '', slope: '', pop: '', ii: '', notes: '' }, props, { outlet })));
  select('sub', id);
}
function deleteSel() {
  const s = S.sel; if (!s) return;
  mutate(() => {
    if (s.t === 'node') { S.P.nodes = S.P.nodes.filter(n => n.id !== s.id); S.P.links = S.P.links.filter(l => l.from !== s.id && l.to !== s.id); S.P.subs.forEach(x => { if (x.outlet === s.id) x.outlet = ''; }); }
    if (s.t === 'link') { const l = getLink(s.id); if (l && l.inferred && l.edge) S.P.removedInferred = [...new Set([...(S.P.removedInferred || []), l.sys + '|' + l.edge])]; S.P.links = S.P.links.filter(l2 => l2.id !== s.id); }
    if (s.t === 'sub') S.P.subs = S.P.subs.filter(x => x.id !== s.id);
    S.sel = null;
  });
}
function renameFeature(t, oldId, newId) {
  newId = String(newId).trim().replace(/\s+/g, '_');
  if (!newId || newId === oldId) return;
  if ([...S.P.nodes, ...S.P.links, ...S.P.subs].some(f => f.id === newId)) { toast(`ID ${esc(newId)} is already used.`, { err: true }); renderEditor(); return; }
  mutate(() => {
    const f = t === 'node' ? getNode(oldId) : t === 'link' ? getLink(oldId) : getSub(oldId); f.id = newId;
    if (t === 'node') { S.P.links.forEach(l => { if (l.from === oldId) l.from = newId; if (l.to === oldId) l.to = newId; }); S.P.subs.forEach(s => { if (s.outlet === oldId) s.outlet = newId; }); }
    S.sel = { t, id: newId };
  });
}
function select(t, id, pan) {
  S.sel = t ? { t, id } : null; render(); renderEditor();
  if (t) { showPanelTab('model'); if (pan) { const f = getSel(); const ll = t === 'node' ? [f.lat, f.lng] : t === 'link' ? linkMid(f) : centroid(f.coords); if (ll) map.panTo(ll); } }
}
function linkMid(l) { const a = getNode(l.from), b = getNode(l.to); return a && b ? [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2] : null; }

/* ---------- editor ---------- */
const opt = (v, l, cur) => `<option value="${esc(v)}"${String(cur) === String(v) ? ' selected' : ''}>${esc(l)}</option>`;
const inp = (f, v, a = '') => `<input data-f="${f}" value="${esc(v ?? '')}" ${a}>`;
function dwgLink(d) { return d ? String(d).split(/[,;\s]+/).filter(Boolean).map(x => `<a href="${EP.dwg}${encodeURIComponent(x)}.pdf" target="_blank" rel="noopener">${esc(x)}</a>`).join(' ') : ''; }
function renderEditor() {
  const box = $('#editor'), f = getSel();
  if (!f) { box.innerHTML = `<div class="card"><h3>Nothing selected</h3><p class="muted" style="margin:0">Place maintenance holes, catch basins and outfalls with the toolbar, then join them with <b>Pipe</b> (upstream first). Click any feature to edit it.</p></div>`; return; }
  const D = S.derived, t = S.sel.t, sysTag = s => `<span class="tag ${s === 'sanitary' ? 't-san' : 't-storm'}">${s === 'sanitary' ? 'SANITARY' : 'STORM'}</span>`;
  const badge = f.inferred ? (f.verified ? ' <span class="tag t-season">checked</span>' : ` <span class="tag t-warn">inferred${f.inf && f.inf.pExist ? ' · p ' + Math.round(Math.min(f.inf.pExist, f.inf.pDir ?? 1) * 100) + ' %' : ''}</span>`) : '';
  let h = `<div class="card" style="border-color:#e8c88a"><div class="row" style="margin-bottom:8px"><h3 style="flex:1;margin:0">${sysTag(f.sys)} ${esc(f.id)}${badge}</h3><button class="btn sm" data-a="zoom">Zoom</button><button class="btn sm" data-a="close">✕</button></div><div class="grid2">`;
  if (t === 'node') {
    const inv = D.inv.get(f.id), src = D.invSrc.get(f.id), rim = NB.num(f.rim);
    h += `<label class="f">ID${inp('id', f.id, 'type="text"')}</label>
      <label class="f">Type<select data-f="kind">${Object.entries(KINDS).map(([k, l]) => opt(k, l, f.kind)).join('')}</select></label>
      <label class="f">System<select data-f="sys">${opt('storm', 'Storm', f.sys)}${opt('sanitary', 'Sanitary', f.sys)}</select></label>
      <label class="f">Confidence<select data-f="conf">${opt('high', 'High — confirmed', f.conf)}${opt('med', 'Medium', f.conf)}${opt('low', 'Low — guess', f.conf)}</select></label>
      <label class="f">Rim / ground (m)${inp('rim', f.rim, 'type="number" step="0.01"')}</label>
      <label class="f">Invert (m)${inp('invert', f.invert, `type="number" step="0.01" placeholder="${inv !== null && inv !== undefined ? 'est ' + inv.toFixed(2) : ''}"`)}</label>
      <div class="muted wide">Rim: ${esc(f.rimSrc || (rim !== null ? 'entered' : 'missing'))} · invert ${inv !== null && inv !== undefined ? inv.toFixed(2) + ' m (' + esc(src) + ')' : 'unknown'}${rim !== null && inv !== null && inv !== undefined ? ' · depth ' + (rim - inv).toFixed(2) + ' m' : ''}</div>`;
    if (f.sys === 'sanitary') h += `<label class="f">Population served${inp('pop', f.pop, 'type="number" step="1"')}</label><label class="f">Extra dry-weather flow (L/s)${inp('dwf', f.dwf, 'type="number" step="0.01"')}</label>`;
    if (f.kind === 'storage' || f.kind === 'pump') h += `<label class="f">Surface area (m²)${inp('area', f.area, 'type="number" step="1"')}</label><span></span>`;
    h += `<label class="f wide">Seen on / source${inp('seen', f.seen, 'type="text" placeholder="e.g. imagery 2021-05-02; Street View Aug 2019"')}</label>
      <label class="f wide">Drawing no. ${dwgLink(f.drawing)}${inp('drawing', f.drawing, 'type="text" placeholder="e.g. A-93"')}</label>
      <div class="wide row">${EVIDENCE.map(e => `<span class="chip${(f.evidence || []).includes(e) ? ' on' : ''}" data-ev="${esc(e)}">${esc(e)}</span>`).join('')}</div>
      <label class="f wide">Notes<textarea data-f="notes">${esc(f.notes)}</textarea></label></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-a="rim">Refresh rim</button><button class="btn sm" data-a="pipe">Pipe from here</button><button class="btn sm" data-a="street">Street-level links</button><button class="btn sm danger" data-a="del">Delete</button></div>
      <div id="edLinks" class="pop"></div>`;
  } else if (t === 'link') {
    const r = D.links.get(f.id) || {};
    h += `<label class="f">ID${inp('id', f.id, 'type="text"')}</label>
      <label class="f">System<select data-f="sys">${opt('storm', 'Storm', f.sys)}${opt('sanitary', 'Sanitary', f.sys)}</select></label>
      <div class="wide small">From <a href="#" data-go="${esc(f.from)}">${esc(f.from)}</a> → <a href="#" data-go="${esc(f.to)}">${esc(f.to)}</a> <button class="btn sm" data-a="flip">Flip direction</button></div>
      <label class="f">Diameter (mm)<input data-f="diam" list="diams" type="number" step="25" value="${esc(f.diam)}" placeholder="unknown"></label>
      <label class="f">Material<input data-f="material" list="mats" type="text" value="${esc(f.material)}"></label>
      <label class="f">Upstream invert (m)${inp('upInv', f.upInv, `type="number" step="0.01" placeholder="${fmt(r.up)}"`)}</label>
      <label class="f">Downstream invert (m)${inp('dnInv', f.dnInv, `type="number" step="0.01" placeholder="${fmt(r.dn)}"`)}</label>
      <label class="f">Length (m)${inp('len', f.len, `type="number" step="0.1" placeholder="${fmt(r.len, 1)} (map)"`)}</label>
      <label class="f">Manning n${inp('n', f.n, `type="number" step="0.001" placeholder="${S.settings.n}"`)}</label>
      <label class="f">Shape<select data-f="shape">${['CIRCULAR', 'EGG', 'HORSESHOE'].map(s => opt(s, s.toLowerCase(), f.shape || 'CIRCULAR')).join('')}</select></label>
      <label class="f">Confidence<select data-f="conf">${opt('high', 'High — confirmed', f.conf)}${opt('med', 'Medium', f.conf)}${opt('low', 'Low — guess', f.conf)}</select></label>
      <label class="f wide">Drawing no. ${dwgLink(f.drawing)}${inp('drawing', f.drawing, 'type="text" placeholder="e.g. A-93"')}</label>
      <div class="wide kv"><span>Slope</span><span>${r.slope !== null && r.slope !== undefined ? (r.slope * 100).toFixed(3) + ' %' : '—'}</span><span>Min slope (${S.settings.minVel} m/s full)</span><span>${r.minSlope ? (r.minSlope * 100).toFixed(3) + ' %' : '—'}</span><span>Full-flow capacity</span><span>${r.qfull ? r.qfull.toFixed(1) + ' L/s' : '—'}</span><span>Offsets in / out</span><span>${fmt(r.inOff)} / ${fmt(r.outOff)} m</span></div>
      <label class="f wide">Notes<textarea data-f="notes">${esc(f.notes)}</textarea></label></div>
      <div class="row" style="margin-top:8px"><button class="btn sm" data-a="split">Insert MH at midpoint</button><button class="btn sm danger" data-a="del">Delete</button></div>`;
  } else {
    const c = centroid(f.coords);
    const cand = S.P.nodes.filter(n => n.sys === f.sys).map(n => [n, NB.dist(c, [n.lat, n.lng])]).sort((a, b) => a[1] - b[1]).slice(0, 40);
    if (f.outlet && !cand.some(([n]) => n.id === f.outlet) && getNode(f.outlet)) cand.unshift([getNode(f.outlet), 0]);
    const autoA = NB.polyArea(f.coords) / 10000;
    h += `<label class="f">ID${inp('id', f.id, 'type="text"')}</label>
      <label class="f">Type<select data-f="sys">${opt('storm', 'Storm subcatchment', f.sys)}${opt('sanitary', 'Sanitary sewershed', f.sys)}</select></label>
      <label class="f wide">Outlet node<select data-f="outlet"><option value="">— choose —</option>${cand.map(([n, d]) => opt(n.id, `${n.id} (${KINDS[n.kind]}, ${d.toFixed(0)} m)`, f.outlet)).join('')}</select></label>
      <label class="f">Area (ha)${inp('area', f.area, `type="number" step="0.001" placeholder="${autoA.toFixed(3)} (map)"`)}</label>`;
    if (f.sys === 'storm') {
      h += `<label class="f">Land use (City Table 6.1)<select data-f="landuse"><option value="">—</option>${NB.LANDUSE.map(u => opt(u.k, `${u.label} (C ${u.C} → ${u.imp}%)`, f.landuse)).join('')}</select></label>
      <label class="f">% impervious${inp('imp', f.imp, 'type="number" step="1" min="0" max="100" placeholder="50"')}</label>
      <label class="f">Slope (%)${inp('slope', f.slope, 'type="number" step="0.1"')}</label>
      <label class="f">Overland flow length (m)${inp('flowLen', f.flowLen, 'type="number" step="1" placeholder="40"')}</label>
      <label class="f">Width (m)${inp('width', f.width, `type="number" step="1" placeholder="${NB.subWidth(f).toFixed(0)} (auto)"`)}</label>`;
    } else {
      h += `<label class="f">Population${inp('pop', f.pop, 'type="number" step="1"')}</label>
      <label class="f">I/I allowance (L/s/ha)<select data-f="ii">${opt('', `default (${S.settings.iiRate})`, f.ii)}${opt('0.28', '0.28 — built in last 20 yrs', f.ii)}${opt('0.44', '0.44 — older than 20 yrs', f.ii)}${opt('2.0', '2.0 — West Ferris area', f.ii)}</select></label>`;
    }
    h += `<label class="f wide">Notes<textarea data-f="notes">${esc(f.notes)}</textarea></label></div>
      <div class="row" style="margin-top:8px">${S.grid ? '<button class="btn sm" data-a="subterrain">Slope from lidar</button>' : ''}<button class="btn sm danger" data-a="del">Delete</button></div>`;
  }
  h += `</div><datalist id="diams">${DIAMS.map(d => `<option value="${d}">`).join('')}</datalist><datalist id="mats">${MATERIALS.map(d => `<option value="${d}">`).join('')}</datalist>`;
  box.innerHTML = h;
}
$('#editor').addEventListener('change', e => {
  const el = e.target, k = el.dataset.f, f = getSel(); if (!k || !f) return;
  let v = el.value;
  if (k === 'id') { renameFeature(S.sel.t, f.id, v); return; }
  if (el.type === 'number' && v !== '') v = +v;
  mutate(() => {
    f[k] = v;
    if (f.inferred && ['diam', 'upInv', 'dnInv', 'from', 'to'].includes(k)) { f.verified = true; f.conf = 'high'; }
    if (k === 'rim') f.rimSrc = v === '' ? '' : 'entered';
    if (k === 'diam' && v) S.lastDiam[f.sys] = v;
    if (k === 'landuse') { const u = NB.LANDUSE.find(x => x.k === v); if (u) f.imp = u.imp; }
  });
});
$('#editor').addEventListener('click', e => {
  const ev = e.target.closest('[data-ev]'), a = e.target.closest('[data-a]'), go = e.target.closest('[data-go]'), f = getSel();
  if (go) { e.preventDefault(); select('node', go.dataset.go, true); return; }
  if (ev && f) { mutate(() => { const s = new Set(f.evidence || []); s.has(ev.dataset.ev) ? s.delete(ev.dataset.ev) : s.add(ev.dataset.ev); f.evidence = [...s]; }); return; }
  if (!a) return;
  const act = a.dataset.a;
  if (act === 'close') return select(null);
  if (act === 'del') return deleteSel();
  if (act === 'zoom' && f) { if (S.sel.t === 'node') map.setView([f.lat, f.lng], Math.max(19, map.getZoom())); else if (S.sel.t === 'link') { const m = linkMid(f); if (m) map.setView(m, Math.max(18, map.getZoom())); } else map.fitBounds(L.polygon(f.coords).getBounds(), { maxZoom: 19 }); }
  if (act === 'rim') refreshRim(f.id);
  if (act === 'pipe') { setMode('pipe'); S.draft = { from: f.id, verts: [] }; updateHint(); }
  if (act === 'street') $('#edLinks').innerHTML = linksHTML(f.lat, f.lng);
  if (act === 'flip') flipLink(f.id);
  if (act === 'split') splitLink(f.id);
  if (act === 'subterrain') subFromTerrain(f);
});
function subFromTerrain(s) {
  const g = S.grid, poly = s.coords; let sum = 0, n = 0;
  const px = poly.map(p => NB.gridPx(g, p[0], p[1]));
  const xs = px.map(p => p[0]), ys = px.map(p => p[1]);
  const inside = (x, y) => { let c = false; for (let i = 0, j = px.length - 1; i < px.length; j = i++) { const [xi, yi] = px[i], [xj, yj] = px[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; };
  for (let r = Math.max(1, Math.floor(Math.min(...ys))); r <= Math.min(g.h - 2, Math.ceil(Math.max(...ys))); r++)
    for (let c = Math.max(1, Math.floor(Math.min(...xs))); c <= Math.min(g.w - 2, Math.ceil(Math.max(...xs))); c++) {
      if (!inside(c, r)) continue; const Z = (dc, dr) => g.z[(r + dr) * g.w + c + dc];
      const zx = (Z(1, 0) - Z(-1, 0)) / (2 * g.cell), zy = (Z(0, 1) - Z(0, -1)) / (2 * g.cell), sl = Math.hypot(zx, zy);
      if (isFinite(sl)) { sum += sl; n++; }
    }
  if (!n) { toast('The area is outside the analysed lidar grid.', { err: true }); return; }
  mutate(() => { s.slope = +(sum / n * 100).toFixed(2); });
  toast(`Mean slope ${(sum / n * 100).toFixed(2)} % from ${n} lidar cells.`);
}

/* ---------- toolbar & modes ---------- */
const IC = {
  pan: '<svg viewBox="0 0 20 20"><path d="M5 3l10 6-4.2 1.2L13 15l-1.8.9-2.3-4.8L5.5 14z" fill="currentColor"/></svg>',
  st: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5" fill="${SYS_COL.storm}" stroke="#fff" stroke-width="1.5"/><path d="M6.5 10h7M10 6.5v7" stroke="#fff"/></svg>`,
  sa: `<svg viewBox="0 0 20 20"><circle cx="10" cy="10" r="6.5" fill="${SYS_COL.sanitary}" stroke="#fff" stroke-width="1.5"/><path d="M6.5 10h7M10 6.5v7" stroke="#fff"/></svg>`,
  cb: '<svg viewBox="0 0 20 20"><rect x="4.5" y="4.5" width="11" height="11" rx="1.5" fill="#0b8f9b" stroke="#fff" stroke-width="1.5"/><path d="M7.5 7v6M10 7v6M12.5 7v6" stroke="#fff" stroke-width=".9"/></svg>',
  of: '<svg viewBox="0 0 20 20"><path d="M10 3.5l7 12H3z" fill="#2b7a4b" stroke="#fff" stroke-width="1.5" stroke-linejoin="round"/></svg>',
  more: '<svg viewBox="0 0 20 20"><circle cx="5" cy="10" r="1.6" fill="currentColor"/><circle cx="10" cy="10" r="1.6" fill="currentColor"/><circle cx="15" cy="10" r="1.6" fill="currentColor"/></svg>',
  pipe: '<svg viewBox="0 0 20 20"><path d="M4.5 15.5L15.5 4.5" stroke="currentColor" stroke-width="2.4" stroke-linecap="round"/><circle cx="4.5" cy="15.5" r="2.3" fill="currentColor"/><circle cx="15.5" cy="4.5" r="2.3" fill="currentColor"/></svg>',
  sub: '<svg viewBox="0 0 20 20"><path d="M4 6l7-3 5.5 5-2 8.5L6 15z" fill="rgba(31,99,198,.18)" stroke="currentColor" stroke-width="1.6" stroke-linejoin="round"/></svg>',
  street: '<svg viewBox="0 0 20 20"><circle cx="10" cy="5" r="2.3" fill="currentColor"/><path d="M7 9.5h6l-1 4.5h-1.2l-.4 3.5H9.6L9.2 14H8z" fill="currentColor"/></svg>'
};
const TOOLS = [
  ['pan', 'Select', IC.pan], ['add:mh:storm', 'Storm MH', IC.st], ['add:mh:sanitary', 'San. MH', IC.sa], ['add:cb:storm', 'Catch basin', IC.cb], ['add:outfall:storm', 'Outfall', IC.of], ['more', 'More', IC.more], ['|'],
  ['pipe', 'Pipe', IC.pipe], ['sub:storm', 'Area', IC.sub], ['|'], ['street', 'Street', IC.street]
];
const MORE = [
  ['add:storage:storm', 'Storage / stormwater pond'], ['add:pump:sanitary', 'Sanitary pump station'], ['add:outfall:sanitary', 'Sanitary outlet (to WPCP)'],
  ['add:cb:sanitary', 'Sanitary cleanout / inlet'], ['add:unknown:storm', 'Unknown lid (classify later)'], ['sub:sanitary', 'Sanitary sewershed (area)'], ['profile', 'Ground profile'], ['shed', 'Catchment from a point (lidar)']
];
function buildToolbar() {
  $('#toolbar').innerHTML = TOOLS.map(t => t[0] === '|' ? '<span class="div"></span>' : `<button data-m="${t[0]}" title="${t[1]}">${t[2]}<span>${t[1]}</span></button>`).join('');
  $('#otherMenu').innerHTML = MORE.map(([m, l]) => `<button data-m="${m}">${l}</button>`).join('');
  L.DomEvent.disableClickPropagation($('#toolbar')); L.DomEvent.disableScrollPropagation($('#toolbar')); L.DomEvent.disableClickPropagation($('#otherMenu'));
  $('#toolbar').addEventListener('click', e => {
    const b = e.target.closest('button'); if (!b) return;
    if (b.dataset.m === 'more') { const m = $('#otherMenu'), r = b.getBoundingClientRect(), wr = $('#mapwrap').getBoundingClientRect(); m.style.display = m.style.display === 'block' ? 'none' : 'block'; m.style.left = Math.min(r.left - wr.left, wr.width - 240) + 'px'; m.style.top = (r.bottom - wr.top + 4) + 'px'; return; }
    setMode(b.dataset.m === S.mode && b.dataset.m !== 'pan' ? 'pan' : b.dataset.m);
  });
  $('#otherMenu').addEventListener('click', e => { const b = e.target.closest('button'); if (!b) return; $('#otherMenu').style.display = 'none'; setMode(b.dataset.m); });
}
function setMode(m) {
  if (m === 'shed' && !S.A) { toast('Run “Analyse view” on the Terrain tab first.', { err: true }); showPanelTab('terrain'); return; }
  S.mode = m; S.draft = null; G.temp.clearLayers(); $('#otherMenu').style.display = 'none';
  $$('#toolbar button').forEach(b => b.classList.toggle('on', b.dataset.m === m || (b.dataset.m === 'more' && MORE.some(x => x[0] === m))));
  const multi = m === 'pipe' || m.startsWith('sub') || m === 'profile';
  multi ? map.doubleClickZoom.disable() : map.doubleClickZoom.enable();
  $('#map').style.cursor = m === 'pan' ? '' : 'crosshair';
  $('#refCrop').style.display = m === 'georef' ? 'block' : 'none';
  render(); updateHint();
}
function updateHint() {
  const h = $('#hint'), m = S.mode, d = S.draft; let msg = '', btns = '';
  if (m.startsWith('add:')) { const [, k, s] = m.split(':'); msg = `Click to place: <b>${KINDS[k]}</b> (${s}). Rim elevation fills in from lidar.`; }
  else if (m === 'pipe') msg = !d || !d.from ? 'Click the <b>upstream</b> node.' : `From <b>${esc(d.from)}</b>: click the map for bends, then the <b>downstream</b> node.`;
  else if (m.startsWith('sub')) { msg = `Click around the ${m === 'sub:sanitary' ? 'sewershed' : 'drainage area'}; double-click or Finish to close.`; btns = '<button class="btn sm" data-h="finish">Finish</button>'; }
  else if (m === 'profile') { msg = 'Click along the street; double-click or Finish.'; btns = '<button class="btn sm" data-h="finish">Finish</button>'; }
  else if (m === 'street') msg = 'Click anywhere for street-level photo and imagery links.';
  else if (m === 'shed') msg = 'Click a catch basin or low point to trace its surface catchment.';
  else if (m === 'georef') msg = `Click point <b>${(S.dwg?.dst.length || 0) + 1}</b> of 3 on the map (shown at right).`;
  if (!msg) { h.style.display = 'none'; return; }
  h.innerHTML = `<span>${msg}</span>${btns}<button class="btn sm" data-h="cancel">${m === 'pan' ? 'OK' : 'Done'}</button>`; h.style.display = 'flex';
}
$('#hint').addEventListener('click', e => { const b = e.target.closest('[data-h]'); if (!b) return; if (b.dataset.h === 'finish') finishDraft(); else { if (S.mode === 'georef') cancelGeoref(); setMode('pan'); } });
L.DomEvent.disableClickPropagation($('#hint'));
function drawDraft() {
  G.temp.clearLayers(); const d = S.draft; if (!d) return;
  if (S.mode === 'pipe' && d.from) { const a = getNode(d.from); if (a) G.temp.addLayer(L.polyline([[a.lat, a.lng], ...d.verts], { pane: 'temp', color: '#f59f00', weight: 3, dashArray: '6 5', interactive: false })); }
  if (d.pts) { G.temp.addLayer(L.polyline(d.pts, { pane: 'temp', color: '#f59f00', weight: 2.5, dashArray: '6 5', interactive: false })); d.pts.forEach(p => G.temp.addLayer(L.circleMarker(p, { pane: 'temp', radius: 3.5, color: '#f59f00', fillOpacity: 1, interactive: false }))); }
}
function finishDraft() {
  const d = S.draft, m = S.mode;
  if (m.startsWith('sub')) { if (!d || d.pts.length < 3) { toast('Click at least 3 points.'); return; } const sys = m === 'sub:sanitary' ? 'sanitary' : 'storm'; const pts = d.pts; S.draft = null; G.temp.clearLayers(); createSub(sys, pts); updateHint(); }
  else if (m === 'profile') { if (!d || d.pts.length < 2) { toast('Click at least 2 points.'); return; } const pts = d.pts; S.draft = null; runProfile(pts); setMode('pan'); }
}
function onFeatureClick(t, id, ll) {
  const m = S.mode;
  if (m === 'pipe' && t === 'node') {
    if (!S.draft || !S.draft.from) { S.draft = { from: id, verts: [] }; drawDraft(); updateHint(); return; }
    const d = S.draft; S.draft = null; G.temp.clearLayers(); createLink(d.from, id, d.verts); updateHint(); return;
  }
  if ((m.startsWith('sub') || m === 'profile') && t === 'node') { const n = getNode(id); mapClick({ latlng: L.latLng(n.lat, n.lng) }); return; }
  if (m === 'street' || m === 'shed' || m === 'georef' || m.startsWith('sub') || m === 'profile') { mapClick({ latlng: ll }); return; }
  select(t, id);
}
function mapClick(e) {
  const m = S.mode, ll = [e.latlng.lat, e.latlng.lng]; $('#otherMenu').style.display = 'none';
  if (m.startsWith('add:')) { const [, k, s] = m.split(':'); addNode(k, s, ll); return; }
  if (m === 'pipe') { if (S.draft && S.draft.from) { S.draft.verts.push(ll); drawDraft(); } else toast('Click a node to start the pipe.'); return; }
  if (m.startsWith('sub') || m === 'profile') {
    S.draft = S.draft || { pts: [] };
    const p0 = S.draft.pts[0];
    if (m.startsWith('sub') && p0 && S.draft.pts.length >= 3 && map.latLngToContainerPoint(p0).distanceTo(e.containerPoint || map.latLngToContainerPoint(e.latlng)) < 12) { finishDraft(); return; }
    S.draft.pts.push(ll); drawDraft(); return;
  }
  if (m === 'street') { L.popup().setLatLng(e.latlng).setContent(`<div class="pop"><h4>Street-level &amp; other imagery</h4><div class="muted mono">${ll[0].toFixed(6)}, ${ll[1].toFixed(6)}</div>${linksHTML(ll[0], ll[1])}</div>`).openOn(map); return; }
  if (m === 'shed') { runShed(e.latlng); return; }
  if (m === 'georef') { georefClick(ll); return; }
  if (m === 'pan' && S.sel) select(null);
}
map.on('click', mapClick);
map.on('dblclick', e => { if (S.mode.startsWith('sub') || S.mode === 'profile') { L.DomEvent.stop(e); if (S.draft && S.draft.pts.length) { S.draft.pts.pop(); } finishDraft(); } });

/* ---------- issues, summary, list ---------- */
function renderIssues() {
  const D = S.derived, list = D.issues.filter(i => S.issueSev[i.sev]);
  const ne = D.issues.filter(i => i.sev === 'error').length;
  $('#issueBadge').innerHTML = ne ? `<span class="badge">${ne}</span>` : '';
  $('#issues').innerHTML = list.length ? list.slice(0, 400).map(i => `<div class="li" data-k="${i.kind}" data-id="${esc(i.id)}"><span class="tag t-${i.sev === 'error' ? 'err' : i.sev === 'warn' ? 'warn' : 'info'}">${i.sev}</span><div class="grow"><b>${esc(i.id)}</b> ${esc(i.msg)}</div></div>`).join('') : '<div class="muted">No issues in the selected categories.</div>';
}
$('#issues').addEventListener('click', e => { const li = e.target.closest('.li'); if (li) select(li.dataset.k, li.dataset.id, true); });
$$('#issueFilter .chip').forEach(c => c.addEventListener('click', () => { c.classList.toggle('on'); S.issueSev[c.dataset.sev] = c.classList.contains('on'); renderIssues(); }));
function renderSummary() {
  const P = S.P, D = S.derived, cnt = (sys, k) => P.nodes.filter(n => n.sys === sys && (!k || n.kind === k)).length;
  const len = sys => P.links.filter(l => l.sys === sys).reduce((s, l) => s + (D.links.get(l.id)?.len || 0), 0);
  const byD = sys => { const m = new Map(); P.links.filter(l => l.sys === sys).forEach(l => { const k = NB.num(l.diam) || '?'; m.set(k, (m.get(k) || 0) + (D.links.get(l.id)?.len || 0)); }); return [...m].sort((a, b) => (a[0] === '?') - (b[0] === '?') || a[0] - b[0]).map(([d, L1]) => `${d}${d === '?' ? '' : ' mm'}: ${L1.toFixed(0)} m`).join(' · '); };
  const conf = P.nodes.length ? Math.round(100 * P.nodes.filter(n => n.conf === 'high').length / P.nodes.length) : 0;
  $('#summary').innerHTML = `<div class="kv">
    <span><span class="tag t-storm">STORM</span></span><span>${cnt('storm', 'mh')} MH · ${cnt('storm', 'cb')} CB · ${cnt('storm', 'outfall')} outfall · ${P.links.filter(l => l.sys === 'storm').length} pipes (${len('storm').toFixed(0)} m) · ${P.subs.filter(s => s.sys === 'storm').length} areas</span>
    <span><span class="tag t-san">SANITARY</span></span><span>${cnt('sanitary', 'mh')} MH · ${cnt('sanitary', 'pump')} PS · ${cnt('sanitary', 'outfall')} outlet · ${P.links.filter(l => l.sys === 'sanitary').length} pipes (${len('sanitary').toFixed(0)} m) · ${P.subs.filter(s => s.sys === 'sanitary').length} sewersheds</span>
    <span>Confirmed nodes</span><span>${conf} %</span></div>
    ${P.links.length ? `<div class="muted" style="margin-top:6px">Storm by size — ${byD('storm') || 'none'}<br>Sanitary by size — ${byD('sanitary') || 'none'}</div>` : ''}`;
}
function renderFeatList() {
  const q = $('#featFilter').value.trim().toLowerCase();
  const rows = [
    ...S.P.nodes.map(n => ({ t: 'node', id: n.id, txt: `${KINDS[n.kind]} · ${n.sys}${NB.num(n.rim) !== null ? ' · rim ' + (+n.rim).toFixed(2) : ''}`, s: n.sys, hay: `${n.id} ${n.kind} ${KINDS[n.kind]} ${n.sys} ${n.notes} ${n.drawing} ${n.seen}` })),
    ...S.P.links.map(l => ({ t: 'link', id: l.id, txt: `${l.from} → ${l.to} · ${l.diam || '?'} mm`, s: l.sys, hay: `${l.id} pipe ${l.sys} ${l.from} ${l.to} ${l.material} ${l.notes} ${l.drawing}` })),
    ...S.P.subs.map(s => ({ t: 'sub', id: s.id, txt: `area → ${s.outlet || '?'} · ${NB.subArea(s).toFixed(2)} ha`, s: s.sys, hay: `${s.id} area ${s.sys} ${s.outlet} ${s.notes}` }))
  ].filter(r => !q || r.hay.toLowerCase().includes(q));
  $('#featList').innerHTML = rows.length ? rows.slice(0, 500).map(r => `<div class="li" data-k="${r.t}" data-id="${esc(r.id)}"><span class="tag ${r.s === 'sanitary' ? 't-san' : 't-storm'}">${r.t}</span><div class="grow"><b>${esc(r.id)}</b> <span class="muted">${esc(r.txt)}</span></div></div>`).join('') : '<div class="muted">No features yet.</div>';
}
$('#featList').addEventListener('click', e => { const li = e.target.closest('.li'); if (li) select(li.dataset.k, li.dataset.id, true); });
$('#featFilter').addEventListener('input', debounce(renderFeatList, 150));
$('#undoBtn').addEventListener('click', undo);
$('#fillRims').addEventListener('click', async () => {
  const miss = S.P.nodes.filter(n => NB.num(n.rim) === null); if (!miss.length) { toast('All nodes have rim elevations.'); return; }
  toast(`Fetching ${miss.length} rim elevation(s)…`);
  const r = await pool(miss, 5, n => getElevation(n.lat, n.lng));
  mutate(() => miss.forEach((n, i) => { const cur = getNode(n.id); if (cur && r[i]) { cur.rim = +r[i].z.toFixed(2); cur.rimSrc = r[i].src; } }));
  toast(`Filled ${r.filter(Boolean).length} of ${miss.length}.`);
});
let clearArm = 0;
$('#clearAll').addEventListener('click', e => {
  if (Date.now() - clearArm > 4000) { clearArm = Date.now(); e.target.textContent = 'Click again to clear'; setTimeout(() => e.target.textContent = 'Clear model…', 4000); return; }
  mutate(() => { S.P = { nodes: [], links: [], subs: [] }; S.sel = null; }); e.target.textContent = 'Clear model…'; toast('Model cleared — Undo restores it.');
});

/* ---------- OSM clues ---------- */
const osmLayer = L.layerGroup().addTo(map);
function osmClass(t) {
  if (t.man_made === 'manhole' || t.manhole) {
    const k = (t.manhole || t['manhole:type'] || t.utility || '').toLowerCase();
    if (/drain|storm|rain/.test(k)) return ['manhole', 'storm MH', '#1f63c6'];
    if (/sewer|sanitary|waste/.test(k)) return ['manhole', 'sewer MH', '#9a4a1c'];
    if (/telecom|power|gas|water|heat|electric/.test(k)) return ['other', `${k} manhole (not sewer)`, '#9aa0a6'];
    return ['manhole', 'manhole (type?)', '#495057'];
  }
  if (t.man_made === 'storm_drain' || t.storm_drain) return ['inlet', 'storm drain / inlet', '#0b8f9b'];
  if (t.man_made === 'outfall') return ['outfall', 'outfall', '#2b7a4b'];
  if (t.tunnel === 'culvert' || t.waterway === 'culvert') return ['culvert', 'culvert', '#e8590c'];
  if (t.waterway === 'ditch' || t.waterway === 'drain') return ['ditch', t.waterway, '#4dabf7'];
  if (t.waterway) return ['stream', t.waterway, '#1971c2'];
  if (t.man_made === 'wastewater_plant') return ['facility', 'wastewater plant', '#7048e8'];
  if (t.man_made === 'pumping_station' || t.pumping_station) return ['facility', 'pumping station' + (t.pumping_station ? ' (' + t.pumping_station + ')' : ''), '#7048e8'];
  return ['pond', 'basin / pond', '#15aabf'];
}
async function loadOSM() {
  if (map.getZoom() < 14) { toast('Zoom in to street level first (zoom 14+).', { err: true }); return; }
  const b = map.getBounds(), bb = `${b.getSouth()},${b.getWest()},${b.getNorth()},${b.getEast()}`, st = $('#osmStatus');
  st.textContent = 'Querying OpenStreetMap…';
  const q = `[out:json][timeout:40];(node["man_made"="manhole"](${bb});node["manhole"](${bb});nwr["man_made"="storm_drain"](${bb});node["storm_drain"](${bb});nwr["man_made"="outfall"](${bb});way["waterway"~"^(stream|ditch|drain|canal|river|culvert)$"](${bb});way["tunnel"="culvert"](${bb});nwr["man_made"~"^(wastewater_plant|pumping_station)$"](${bb});nwr["pumping_station"](${bb});nwr["landuse"="basin"](${bb});nwr["basin"](${bb});nwr["water"~"^(pond|basin|reservoir|stormwater)$"](${bb}););out geom;`;
  try {
    const j = await fetchJSON(EP.overpass, 50000, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
    osmLayer.clearLayers(); S.osm = j.elements || []; const counts = {};
    S.osm.forEach((el, i) => {
      const t = el.tags || {}, [cat, label, col] = osmClass(t); counts[label] = (counts[label] || 0) + 1;
      const pop = () => `<div class="pop"><h4>OSM: ${esc(label)}</h4><table>${Object.entries(t).slice(0, 14).map(([k, v]) => `<tr><td>${esc(k)}</td><td>${esc(v)}</td></tr>`).join('')}</table>
        ${el.type === 'node' ? `<div class="row" style="margin-top:6px"><button class="btn sm" onclick="APP.osmAdd(${i},'mh','storm')">+ storm MH</button><button class="btn sm" onclick="APP.osmAdd(${i},'mh','sanitary')">+ san. MH</button><button class="btn sm" onclick="APP.osmAdd(${i},'cb','storm')">+ CB</button><button class="btn sm" onclick="APP.osmAdd(${i},'outfall','storm')">+ outfall</button></div>` : ''}
        <a href="https://www.openstreetmap.org/${el.type}/${el.id}" target="_blank" rel="noopener">View on OSM</a></div>`;
      if (el.type === 'node') osmLayer.addLayer(L.circleMarker([el.lat, el.lon], { pane: 'clues', radius: cat === 'manhole' ? 6 : 5, color: '#fff', weight: 1.5, fillColor: col, fillOpacity: 0.9 }).bindPopup(pop));
      else if (el.geometry) {
        const pts = el.geometry.map(g => [g.lat, g.lon]); const closed = pts.length > 3 && pts[0][0] === pts[pts.length - 1][0] && pts[0][1] === pts[pts.length - 1][1];
        if ((cat === 'pond' || cat === 'facility') && closed) osmLayer.addLayer(L.polygon(pts, { pane: 'clues', color: col, weight: 1.5, fillOpacity: 0.2 }).bindPopup(pop));
        else osmLayer.addLayer(L.polyline(pts, { pane: 'clues', color: col, weight: cat === 'culvert' ? 5 : 2.5, dashArray: cat === 'ditch' ? '5 4' : null, opacity: 0.9 }).bindPopup(pop));
      }
    });
    st.innerHTML = S.osm.length ? Object.entries(counts).map(([k, v]) => `${v} ${esc(k)}`).join(' · ') : 'Nothing mapped in OSM for this view.';
  } catch (e) { st.textContent = 'OpenStreetMap query failed: ' + e.message + '. Try again in a minute (the public server rate-limits).'; }
}
$('#osmLoad').addEventListener('click', loadOSM);
$('#osmShow').addEventListener('click', e => { e.target.classList.toggle('on'); e.target.classList.contains('on') ? osmLayer.addTo(map) : map.removeLayer(osmLayer); });

/* ---------- projects ---------- */
const ICIP = 'https://northbay.ca/projects/icip-sidewalk-program/';
const PROJECTS = [
  { name: 'Making Over Main Street', yrs: '2023–2024', st: ['Main Street', 'Ferguson Street'], scope: 'Main St (Sherbrooke–Cassells) and Ferguson St (Main–Oak) rebuilt; watermain, sanitary and storm reviewed and repaired. 375 mm sanitary on Ferguson replaced April 2024.', url: 'https://northbay.ca/projects/main-street-revitalization/' },
  { name: 'McKeown Avenue widening', yrs: '2024–2026', st: ['McKeown Avenue'], scope: 'Gormanville Rd to the McKeown Plaza entrance; sewers, watermain and services replaced (large concrete trunk storm kept). Trunk sanitary repair in 2026.', url: 'https://northbay.ca/projects/mckeown-avenue-improvements/' },
  { name: 'Seymour Street reconstruction', yrs: '2025–2026', st: ['Seymour Street'], scope: 'Began August 2025 and continues through the 2026 season: road, infrastructure and intersection work.', url: 'https://northbay.ca/projects/seymour-street-reconstruction/' },
  { name: 'Commerce Cres & Wallace Rd sidewalks + storm', yrs: '2025–2026', st: ['Commerce Crescent', 'Wallace Road'], scope: 'Sidewalks with storm sewer improvements (Wallace: Lake Heights–Commerce; Commerce: Wallace–Seymour). Started May 2025.', url: ICIP },
  { name: 'Premier Road sidewalk + storm', yrs: '2025', st: ['Premier Road'], scope: 'Fowler St to Champlain Park.', url: ICIP },
  { name: 'Trout Lake Rd & Laurentian roundabout', yrs: '2025–2026', st: ['Trout Lake Road'], scope: 'Road reconstruction with a roundabout at Laurentian Ave and associated storm sewer works (per tender listings).', url: '' },
  { name: 'Stockdale / Shirreff sidewalks + storm', yrs: '2027 (planned)', st: ['Stockdale Road', 'Shirreff Avenue'], scope: 'Stockdale: Airport–Shirreff; Shirreff: Stockdale to existing sidewalk.', url: ICIP, plan: 1 },
  { name: 'Norwood / Beattie sidewalks + storm', yrs: '2027 (planned)', st: ['Norwood Avenue', 'Beattie Street'], scope: 'Norwood: Algonquin–Beattie; Beattie: Maplewood–Norwood.', url: ICIP, plan: 1 },
  { name: 'Dane Avenue sidewalk + storm', yrs: '2028 (planned)', st: ['Dane Avenue'], scope: 'Chapais to Frost.', url: ICIP, plan: 1 },
  { name: 'Frost / Albert sidewalks + storm', yrs: '2029 (planned)', st: ['Frost Avenue', 'Albert Avenue'], scope: 'Frost: Dane–Angus; Albert: Frost–O’Brien.', url: ICIP, plan: 1 },
  { name: 'Oak / John / Pearce sidewalks + storm', yrs: '2030 (planned)', st: ['Oak Street', 'John Street', 'Pearce Street'], scope: 'Oak: Wyld–Main; John: Oak–Main; Pearce: Greenhill–Pipeline.', url: ICIP, plan: 1 },
  { name: 'Sage Road sidewalk + storm', yrs: '2031–2032 (planned)', st: ['Sage Road'], scope: 'Rita to Shallot.', url: ICIP, plan: 1 }
];
const projLayer = L.layerGroup().addTo(map);
async function geocode(q, shapes) {
  try {
    const u = `${EP.nominatim}?format=jsonv2&limit=8${shapes ? '&polygon_geojson=1' : ''}&countrycodes=ca&viewbox=-79.65,46.45,-79.30,46.18&bounded=1&q=${encodeURIComponent(q)}`;
    const r = await fetchJSON(u, 15000); if (r.length) return r;
  } catch { /* fall back to Photon */ }
  const j = await fetchJSON(`https://photon.komoot.io/api/?q=${encodeURIComponent(q)}&lat=46.31&lon=-79.46&limit=8&bbox=-79.65,46.18,-79.30,46.45`, 15000);
  return (j.features || []).map(f => {
    const [lon, lat] = f.geometry.coordinates, p = f.properties || {}, ex = p.extent;
    const geojson = ex ? { type: 'LineString', coordinates: [[ex[0], ex[1]], [ex[2], ex[3]]] } : f.geometry;
    return { lat, lon, geojson, display_name: [p.name, p.street, p.city].filter(Boolean).join(', ') };
  });
}
const geocodeStreet = name => geocode(name + ', North Bay, Ontario', true);
async function findProject(i, thenScan) {
  const p = PROJECTS[i]; projLayer.clearLayers(); const bounds = L.latLngBounds([]);
  for (const s of p.st) {
    try {
      const res = await geocodeStreet(s);
      res.forEach(r => {
        if (!r.geojson) return;
        const gj = L.geoJSON(r.geojson, { pane: 'clues', style: { color: p.plan ? '#7048e8' : '#e8590c', weight: 9, opacity: 0.45 }, pointToLayer: (f, ll) => L.circleMarker(ll, { pane: 'clues', radius: 6 }) });
        gj.bindPopup(`<div class="pop"><h4>${esc(p.name)}</h4><span class="tag t-con">${esc(p.yrs)}</span><p class="small">${esc(p.scope)}</p></div>`);
        projLayer.addLayer(gj); bounds.extend(gj.getBounds());
      });
    } catch (e) { toast(`Could not locate ${esc(s)}: ${esc(e.message)}`, { err: true }); }
  }
  if (bounds.isValid()) { map.fitBounds(bounds, { maxZoom: 17 }); if (thenScan) { showPanelTab('imagery'); setTimeout(scanDates, 600); } }
  else toast('Street not found.', { err: true });
}
function renderProjects() {
  $('#projList').innerHTML = PROJECTS.map((p, i) => `<div class="li" style="cursor:default"><div class="grow"><b>${esc(p.name)}</b> <span class="tag ${p.plan ? 't-info' : 't-con'}">${esc(p.yrs)}</span>
    <div class="muted">${esc(p.scope)}</div><div class="row" style="margin-top:4px"><button class="btn sm" data-pi="${i}">Show on map</button>${p.plan ? '' : `<button class="btn sm" data-ps="${i}">Imagery dates here</button>`}${p.url ? `<a class="small" href="${p.url}" target="_blank" rel="noopener">City page</a>` : ''}</div></div></div>`).join('');
}
$('#projList').addEventListener('click', e => { const a = e.target.closest('[data-pi]'), b = e.target.closest('[data-ps]'); if (a) findProject(+a.dataset.pi); if (b) findProject(+b.dataset.ps, true); });

/* ---------- drawings: open + overlay ---------- */
$('#dwgOpen').addEventListener('submit', e => {
  e.preventDefault(); const v = $('#dwgNo').value.trim(); if (!v) return;
  const a = document.createElement('a'); a.href = EP.dwg + encodeURIComponent(v) + '.pdf'; a.target = '_blank'; a.rel = 'noopener'; document.body.appendChild(a); a.click(); a.remove();
});
let dwgK = 1;
async function loadDrawingFile(file) {
  try {
    if (S.dwg?.el) S.dwg.el.remove();
    S.dwg = { name: file.name, src: [], dst: [], visible: true, opacity: $('#dwgOpacity').value / 100 };
    if (/\.pdf$/i.test(file.name) || file.type === 'application/pdf') {
      toast('Rendering PDF…');
      const pdfjs = await loadPdfJs(); S.dwg.pdf = await pdfjs.getDocument({ data: new Uint8Array(await file.arrayBuffer()) }).promise;
      $('#pageLab').style.display = S.dwg.pdf.numPages > 1 ? '' : 'none'; $('#dwgPage').max = S.dwg.pdf.numPages; $('#dwgPage').value = 1;
      await renderPdfPage(1);
    } else { $('#pageLab').style.display = 'none'; await setDwgImage(URL.createObjectURL(file)); }
    openDwgModal();
  } catch (e) { toast('Could not open drawing: ' + esc(e.message), { err: true }); }
}
async function renderPdfPage(n) {
  const page = await S.dwg.pdf.getPage(n), v1 = page.getViewport({ scale: 1 }), sc = Math.min(5, 4200 / Math.max(v1.width, v1.height));
  const vp = page.getViewport({ scale: sc }), cv = document.createElement('canvas'); cv.width = Math.round(vp.width); cv.height = Math.round(vp.height);
  await page.render({ canvasContext: cv.getContext('2d'), viewport: vp }).promise;
  const blob = await new Promise(r => cv.toBlob(r, 'image/png'));
  S.dwg.src = []; await setDwgImage(URL.createObjectURL(blob));
}
function setDwgImage(url) {
  return new Promise((res, rej) => { const im = new Image(); im.onload = () => { S.dwg.url = url; S.dwg.w = im.naturalWidth; S.dwg.h = im.naturalHeight; S.dwg.img = im; $('#dwgImg').src = url; res(); }; im.onerror = () => rej(new Error('image failed to load')); im.src = url; });
}
function openDwgModal() { $('#modal').hidden = false; dwgFit(); drawGcps(); }
function dwgFit() { const v = $('#dwgView'); dwgK = Math.min((v.clientWidth - 20) / S.dwg.w, (v.clientHeight - 20) / S.dwg.h); dwgZoom(1); }
function dwgZoom(f, cx, cy) {
  const v = $('#dwgView'), old = dwgK; dwgK = Math.max(0.02, Math.min(4, dwgK * f));
  const img = $('#dwgImg'); img.style.width = S.dwg.w * dwgK + 'px'; img.style.height = S.dwg.h * dwgK + 'px';
  if (cx !== undefined) { v.scrollLeft = (v.scrollLeft + cx) * dwgK / old - cx; v.scrollTop = (v.scrollTop + cy) * dwgK / old - cy; }
  drawGcps();
}
function drawGcps() {
  const inner = $('#dwgView .inner'); $$('.gcp', inner).forEach(x => x.remove());
  S.dwg.src.forEach(([u, v], i) => { const d = document.createElement('div'); d.className = 'gcp'; d.textContent = i + 1; d.style.left = u * dwgK + 'px'; d.style.top = v * dwgK + 'px'; inner.appendChild(d); });
  $('#dwgNext').disabled = S.dwg.src.length < 3;
  $('#dwgMsg').innerHTML = S.dwg.src.length < 3 ? `Click point <b>${S.dwg.src.length + 1}</b> of 3 — pick features you can also find on the imagery (manholes, curb returns, building corners), spread far apart.` : 'Three points set. Next, click the same three places on the map.';
}
$('#dwgImg').addEventListener('click', e => {
  if (S.dwg.src.length >= 3) return; const r = e.target.getBoundingClientRect();
  S.dwg.src.push([(e.clientX - r.left) / r.width * S.dwg.w, (e.clientY - r.top) / r.height * S.dwg.h]); drawGcps();
});
$('#dwgView').addEventListener('wheel', e => { if (!e.ctrlKey && !e.metaKey) return; e.preventDefault(); const r = $('#dwgView').getBoundingClientRect(); dwgZoom(e.deltaY < 0 ? 1.2 : 1 / 1.2, e.clientX - r.left, e.clientY - r.top); }, { passive: false });
$('#dwgZoomIn').onclick = () => dwgZoom(1.4); $('#dwgZoomOut').onclick = () => dwgZoom(1 / 1.4); $('#dwgZoomFit').onclick = dwgFit;
$('#dwgUndoPt').onclick = () => { S.dwg.src.pop(); drawGcps(); };
$('#dwgPage').onchange = async e => { await renderPdfPage(+e.target.value); dwgFit(); };
$('#dwgCancel').onclick = () => { $('#modal').hidden = true; if (!S.dwg?.el) S.dwg = null; };
$('#dwgNext').onclick = () => { $('#modal').hidden = true; S.dwg.dst = []; setMode('georef'); drawRefCrop(); };
function drawRefCrop() {
  const d = S.dwg, k = d.dst.length; if (k >= 3) return;
  const cv = $('#refCrop canvas'), c = cv.getContext('2d'), [u, v] = d.src[k], R = Math.max(150, Math.min(d.w, d.h) / 12);
  c.fillStyle = '#fff'; c.fillRect(0, 0, 360, 360); c.drawImage(d.img, u - R, v - R, 2 * R, 2 * R, 0, 0, 360, 360);
  c.strokeStyle = '#e8322b'; c.lineWidth = 3; c.beginPath(); c.arc(180, 180, 22, 0, 7); c.moveTo(180, 140); c.lineTo(180, 220); c.moveTo(140, 180); c.lineTo(220, 180); c.stroke();
  $('#refCrop div').textContent = `Point ${k + 1} of 3 — click this spot on the map`;
}
function georefClick(ll) {
  const d = S.dwg; d.dst.push(ll);
  G.temp.addLayer(L.marker(ll, { pane: 'temp', interactive: false, icon: L.divIcon({ className: 'nb-gcp', iconSize: [26, 26], iconAnchor: [13, 13], html: `<div class="gcp" style="position:static;margin:0">${d.dst.length}</div>` }) }));
  if (d.dst.length < 3) { drawRefCrop(); updateHint(); return; }
  const [p1, p2, p3] = d.src, area = Math.abs((p2[0] - p1[0]) * (p3[1] - p1[1]) - (p3[0] - p1[0]) * (p2[1] - p1[1]));
  if (area < d.w * d.h * 0.002) toast('The three points are nearly in a line — the fit may be poor. Use “Re-match points” with points spread apart.', { err: true });
  showDwg(); setMode('pan'); $('#dwgCtl').style.display = 'block'; showPanelTab('clues');
  toast('Drawing placed. Trace manholes and pipes on top; adjust opacity on the Clues tab.');
}
function cancelGeoref() { if (S.dwg && !S.dwg.el) S.dwg = null; }
function solve3(M, b) {
  const det = m => m[0][0] * (m[1][1] * m[2][2] - m[1][2] * m[2][1]) - m[0][1] * (m[1][0] * m[2][2] - m[1][2] * m[2][0]) + m[0][2] * (m[1][0] * m[2][1] - m[1][1] * m[2][0]);
  const D = det(M); return [0, 1, 2].map(k => det(M.map((r, i) => r.map((v, j) => j === k ? b[i] : v))) / D);
}
function showDwg() {
  const d = S.dwg; if (d.el) d.el.remove();
  const el = document.createElement('img'); el.src = d.url; el.className = 'dwg-overlay leaflet-zoom-hide';
  el.style.width = d.w + 'px'; el.style.height = d.h + 'px'; el.style.opacity = d.opacity;
  map.getPane('drawing').appendChild(el); d.el = el; placeDwg();
}
function placeDwg() {
  const d = S.dwg; if (!d || !d.el || d.dst.length < 3) return;
  const P = d.dst.map(ll => map.latLngToLayerPoint(ll)), M = d.src.map(([u, v]) => [u, v, 1]);
  const [a, c, e] = solve3(M, P.map(p => p.x)), [b, dd, f] = solve3(M, P.map(p => p.y));
  d.el.style.transform = `matrix(${a},${b},${c},${dd},${e},${f})`;
  d.el.style.display = d.visible ? '' : 'none';
}
map.on('zoomend viewreset', placeDwg);
$('#dwgFile').addEventListener('change', e => { if (e.target.files[0]) loadDrawingFile(e.target.files[0]); e.target.value = ''; });
$('#dwgOpacity').addEventListener('input', e => { if (S.dwg) { S.dwg.opacity = e.target.value / 100; if (S.dwg.el) S.dwg.el.style.opacity = S.dwg.opacity; } });
$('#dwgShow').addEventListener('click', e => { if (!S.dwg) return; e.target.classList.toggle('on'); S.dwg.visible = e.target.classList.contains('on'); placeDwg(); });
$('#dwgRepick').addEventListener('click', () => { if (!S.dwg) return; S.dwg.src = []; S.dwg.dst = []; openDwgModal(); });
$('#dwgRemove').addEventListener('click', () => { if (S.dwg?.el) S.dwg.el.remove(); S.dwg = null; $('#dwgCtl').style.display = 'none'; });
$('#streetBtn').addEventListener('click', () => setMode('street'));
$('#shedBtn').addEventListener('click', () => setMode('shed'));
$('#profileBtn').addEventListener('click', () => setMode('profile'));

/* ---------- export ---------- */
const SETTINGS_FORM = [
  ['minCoverStorm', 'Min cover storm (m)', 0.1], ['minCoverSan', 'Min cover sanitary (m)', 0.1], ['minDiaStorm', 'Min dia. storm (mm)', 25], ['minDiaSan', 'Min dia. sanitary (mm)', 25],
  ['n', 'Manning n (pipes)', 0.001], ['minVel', 'Min full-flow velocity (m/s)', 0.05], ['spacingSmall', 'Max MH spacing (m)', 5], ['cbDepth', 'Assumed CB depth (m)', 0.1],
  ['perCap', 'Sanitary flow (L/cap/d)', 10], ['iiRate', 'Default I/I (L/s/ha)', 0.01],
  ['nImp', 'n impervious', 0.001], ['nPerv', 'n pervious', 0.01], ['dsImp', 'Depression storage imp. (mm)', 0.1], ['dsPerv', 'Depression storage perv. (mm)', 0.1], ['pctZero', '% imperv. with no storage', 1],
  ['hMax', 'Horton max rate (mm/h)', 0.1], ['hMin', 'Horton min rate (mm/h)', 0.1], ['hDecay', 'Horton decay (1/h)', 0.1], ['hDry', 'Horton dry time (days)', 0.5]
];
function renderSettings() {
  $('#settingsForm').innerHTML = SETTINGS_FORM.map(([k, l, st]) => `<label class="f">${l}<input type="number" step="${st}" data-s="${k}" value="${S.settings[k]}"></label>`).join('') +
    '<div class="muted wide" style="grid-column:1/-1">City guideline values: min cover 1.5 m storm / 1.8 m sanitary; min 300 mm storm / 200 mm sanitary; n = 0.013; MH spacing 120 m (to 450 mm storm / 1200 mm sanitary); 450 L/cap/d; I/I 0.28 (newer) / 0.44 (older) / 2.0 (West Ferris) L/s/ha. Horton and surface values are generic SWMM starting points — calibrate.</div>';
  $('#sRp').value = S.settings.rp; $('#sDur').value = S.settings.dur; $('#sR').value = S.settings.r;
}
$('#settingsForm').addEventListener('change', e => { const k = e.target.dataset.s; if (!k || e.target.value === '') return; S.settings[k] = +e.target.value; store.set('settings', S.settings); afterChange(); });
['sRp', 'sDur', 'sR'].forEach(id => $('#' + id).addEventListener('change', () => { S.settings.rp = $('#sRp').value; S.settings.dur = +$('#sDur').value; S.settings.r = Math.min(0.9, Math.max(0.1, +$('#sR').value || 0.38)); store.set('settings', S.settings); drawStorm(); }));
function drawStorm() {
  const cv = $('#stormChart'); if (!cv.clientWidth) return;
  const st = S.settings, hy = NB.chicago(st.rp, st.dur, st.step, st.r), dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight;
  cv.width = W * dpr; cv.height = H * dpr; const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const mx = Math.max(...hy), pl = 34, pb = 18, bw = (W - pl - 6) / hy.length;
  c.font = '10px IBM Plex Mono, monospace'; c.fillStyle = '#7b838d'; c.strokeStyle = '#eee8dc';
  for (let k = 0; k <= 4; k++) { const y = 8 + (H - pb - 8) * (1 - k / 4); c.beginPath(); c.moveTo(pl, y); c.lineTo(W - 6, y); c.stroke(); c.fillText((mx * k / 4).toFixed(0), 2, y + 3); }
  c.fillStyle = '#1f63c6'; hy.forEach((v, i) => { const h = (H - pb - 8) * v / mx; c.fillRect(pl + i * bw, H - pb - h, Math.max(1, bw - 0.5), h); });
  c.fillStyle = '#7b838d'; c.fillText('mm/h', 2, H - 5); c.fillText(`${st.dur / 60} h`, W - 34, H - 5);
  const tot = hy.reduce((s, v) => s + v * st.step / 60, 0);
  $('#stormInfo').textContent = `${st.rp}-year, ${st.dur / 60} h Chicago storm · total ${tot.toFixed(1)} mm · peak ${mx.toFixed(1)} mm/h (5-min) · IDF a=${NB.IDF[st.rp][0]}, b=${NB.IDF[st.rp][1]}, c=${NB.IDF[st.rp][2]}`;
}
function stamp() { return new Date().toISOString().slice(0, 10).replace(/-/g, ''); }
function doExport(system) {
  const nNodes = S.P.nodes.filter(n => n.sys === system).length;
  if (!nNodes) { toast(`No ${system} nodes to export yet.`, { err: true }); return; }
  const r = NB.buildINP(S.P, S.settings, system), name = `northbay_${system}_${stamp()}.inp`;
  try { download(name, r.text); } catch { /* fallback below */ }
  const er = r.problems.filter(p => p.sev === 'error').length, wr = r.problems.length - er;
  $('#expOut').innerHTML = `<div class="card" style="margin:0"><b>${name}</b> — ${r.counts.nodes} nodes, ${r.counts.links} conduits, ${system === 'storm' ? r.counts.subs + ' subcatchments' : r.counts.subs + ' sewershed(s) added to dry-weather flow'}.
    ${r.problems.length ? `<div class="small" style="margin-top:4px"><span class="tag t-err">${er} errors</span> <span class="tag t-warn">${wr} warnings</span> listed at the top of the file.</div>` : '<div class="small">No open errors or warnings.</div>'}
    <div class="row" style="margin-top:6px"><button class="btn sm" id="copyInp">Copy text</button><button class="btn sm" id="dlAgain">Download again</button></div>
    <textarea readonly style="margin-top:6px;height:160px;font:11px var(--mono)">${esc(r.text.split('\n').slice(0, 300).join('\n'))}</textarea></div>`;
  $('#copyInp').onclick = () => navigator.clipboard.writeText(r.text).then(() => toast('Copied'), () => toast('Clipboard blocked — select the text instead.', { err: true }));
  $('#dlAgain').onclick = () => download(name, r.text);
}
$('#expStorm').onclick = () => doExport('storm');
$('#expSan').onclick = () => doExport('sanitary');
function toGeoJSON() {
  const F = [];
  S.P.nodes.forEach(n => F.push({ type: 'Feature', geometry: { type: 'Point', coordinates: [n.lng, n.lat] }, properties: Object.assign({ _type: 'node' }, n) }));
  S.P.links.forEach(l => { const a = getNode(l.from), b = getNode(l.to); if (!a || !b) return; F.push({ type: 'Feature', geometry: { type: 'LineString', coordinates: [[a.lng, a.lat], ...(l.verts || []).map(v => [v[1], v[0]]), [b.lng, b.lat]] }, properties: Object.assign({ _type: 'link' }, l, { verts: undefined }) }); });
  S.P.subs.forEach(s => F.push({ type: 'Feature', geometry: { type: 'Polygon', coordinates: [[...s.coords.map(c => [c[1], c[0]]), [s.coords[0][1], s.coords[0][0]]]] }, properties: Object.assign({ _type: 'sub' }, s, { coords: undefined }) }));
  return { type: 'FeatureCollection', nbsm: { version: 1, settings: S.settings, exported: new Date().toISOString() }, features: F };
}
$('#expGeo').onclick = () => download(`northbay_sewers_${stamp()}.geojson`, JSON.stringify(toGeoJSON(), null, 1), 'application/geo+json');
$('#expCsv').onclick = () => {
  const D = S.derived, cols = ['id', 'kind', 'system', 'lat', 'lng', 'utm17_e', 'utm17_n', 'rim', 'rim_source', 'invert_entered', 'invert_used', 'invert_source', 'confidence', 'evidence', 'seen', 'drawing', 'notes'];
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const rows = S.P.nodes.map(n => { const [e, nn] = NB.toUTM(n.lat, n.lng); const iv = D.inv.get(n.id); return [n.id, n.kind, n.sys, n.lat.toFixed(7), n.lng.toFixed(7), e.toFixed(2), nn.toFixed(2), n.rim, n.rimSrc, n.invert, iv !== null && iv !== undefined ? iv.toFixed(3) : '', D.invSrc.get(n.id), n.conf, (n.evidence || []).join('/'), n.seen, n.drawing, n.notes].map(q).join(','); });
  download(`northbay_nodes_${stamp()}.csv`, cols.join(',') + '\n' + rows.join('\n'), 'text/csv');
};
$('#impGeo').addEventListener('change', async e => {
  const file = e.target.files[0]; e.target.value = ''; if (!file) return;
  try {
    const j = JSON.parse(await file.text()); const P = { nodes: [], links: [], subs: [] }; let plain = 0;
    (j.features || []).forEach(f => {
      const p = Object.assign({}, f.properties || {}), t = p._type; delete p._type; const g = f.geometry; if (!g) return;
      if (t === 'node' || (!t && g.type === 'Point')) {
        if (!t) { plain++; p.id = p.id || nextIdIn(P, 'UK'); p.kind = 'unknown'; p.sys = 'storm'; p.evidence = []; p.conf = 'low'; }
        P.nodes.push(Object.assign(p, { lng: g.coordinates[0], lat: g.coordinates[1] }));
      } else if (t === 'link') { p.verts = g.coordinates.slice(1, -1).map(c => [c[1], c[0]]); P.links.push(p); }
      else if (t === 'sub') { const ring = g.coordinates[0].map(c => [c[1], c[0]]); ring.pop(); p.coords = ring; P.subs.push(p); }
    });
    mutate(() => { S.P = P; if (j.nbsm?.settings) Object.assign(S.settings, j.nbsm.settings); });
    renderSettings(); drawStorm();
    if (S.P.nodes.length) map.fitBounds(L.latLngBounds(S.P.nodes.map(n => [n.lat, n.lng])), { maxZoom: 18 });
    toast(`Imported ${P.nodes.length} nodes, ${P.links.length} pipes, ${P.subs.length} areas${plain ? ` (${plain} plain points as “unknown lid”)` : ''}.`);
  } catch (err) { toast('Import failed: ' + esc(err.message), { err: true }); }
});
function nextIdIn(P, prefix) { return `${prefix}-${String(P.nodes.length + 1).padStart(3, '0')}`; }

/* ---------- guide ---------- */
function renderGuide() {
  $('#tab-guide').innerHTML = `
  <div class="card"><h3>How the inference works</h3><ul class="small" style="margin:0;padding-left:18px">
    <li><b>Where pipes are</b>: every street with buildings fronting it gets a sanitary sewer. Storm sewers go on curb-and-gutter streets. Where lidar cross-sections show roadside ditches 0.35 m or deeper, the street is modelled as an open ditch with lidar inverts instead.</li>
    <li><b>Which way they flow</b>: gravity routing over the lidar ground surface to outfalls (streets within 70 m of water), the treatment plant or pumping stations from OpenStreetMap, or the edge of the study area. Uphill runs are heavily penalised. A street that is not on a main route is split at its high point into two runs.</li>
    <li><b>Manholes</b>: at every intersection, bend and street end, plus extra ones so spacing stays under 110 m (City maximum 120 m).</li>
    <li><b>Sizes</b>: storm uses the rational method with the City's 5-year IDF and lidar-drained subcatchments. Sanitary uses 2.24 people per dwelling (2021 Census), 450 L/cap/d, Harmon peaking and the City I/I allowance. Each pipe gets the smallest standard size that carries the flow at the ground slope. Real pipes are often a size larger, so treat sizes as a prior until calibrated.</li>
    <li><b>Inverts</b>: ground minus assumed depth (storm 1.5 m cover + pipe; sanitary at least 2.7 m to serve basements), kept at or above minimum slope going downstream.</li>
    <li><b>Probabilities</b>: existence comes from building frontage and ditch evidence; direction from the street grade relative to terrain error; inverts carry a normal error set by terrain quality. These are the model's own estimates. The <b>Measured</b> column on the Auto tab shows real accuracy once you check pipes against drawings.</li></ul></div>
  <div class="card"><h3>Manual workflow</h3><ol class="small" style="margin:0;padding-left:18px">
    <li><b>Drawings first.</b> Look up your streets in the City's plan &amp; profile index (Clues tab). Overlay the plan sheet, trace maintenance holes and pipes, and copy sizes and inverts from the profile into each pipe.</li>
    <li><b>Fill gaps from imagery.</b> Find lids on spring leaf-off imagery (COOP 2016 / 2021, spring Wayback captures). Confirm storm vs sanitary on Street View, where lids are often lettered.</li>
    <li><b>Use construction seasons.</b> “Find dates here” highlights May–Oct captures. Open trenches, pipe stockpiles and fresh trench patches show alignments and depths.</li>
    <li><b>Terrain.</b> Rim elevations fill in from lidar. Low spots on roads mark catch basins; the catchment tool gives contributing area, slope and width for inlets.</li>
    <li><b>Check and export.</b> Work through the red items on the Model tab, then export storm and sanitary .inp files.</li></ol></div>
  <div class="card"><h3>Reading the clues</h3><ul class="small" style="margin:0;padding-left:18px">
    <li><b>Maintenance holes</b>: round covers in the roadway, usually 0.6–0.8 m across, often in lines at regular spacing. The City's maximum spacing is 120 m on smaller pipes, so a longer gap usually means a buried or paved-over lid.</li>
    <li><b>Storm vs sanitary</b>: covers are often cast with STORM or SANITARY. Once a few lids on a street are confirmed, the offset of each system from the centreline usually repeats along it.</li>
    <li><b>Catch basins</b>: rectangular grates at the curb, at low points and just upstream of intersections. City spacing is 40–90 m depending on grade. Each lead (min. 200 mm) runs to the nearest storm MH.</li>
    <li><b>Winter imagery</b>: snow-free rings over manholes usually mean warm sanitary flow; storm lids tend to stay snow-covered.</li>
    <li><b>Construction</b>: green PVC is typical for gravity sewers, blue PVC for watermain, and large concrete pipe for storm trunks. Stacked MH barrels and trench boxes mark the sewer line.</li>
    <li><b>Trench patches</b>: long rectangular asphalt patches follow past main replacements. Short curb-to-centre patches are service connections and show which side the main is on.</li>
    <li><b>Outfalls</b>: follow storm trunks downhill to headwalls on Chippewa Creek, the other creeks, Trout Lake and Lake Nipissing. Rural-section streets with ditches and culverts may have no storm sewer.</li>
    <li><b>Pump stations</b>: small kiosks or buildings with a wet-well hatch. Downstream of one there is usually a force main, not a gravity sewer.</li></ul></div>
  <div class="card"><h3>Datums &amp; accuracy</h3><p class="small" style="margin:0">Ontario lidar DTMs are referenced to CGVD2013 or CGVD28 depending on the project, and older City drawings may use either datum or a local benchmark. Check a few drawing rim elevations against the lidar before mixing sources — differences of tens of centimetres are common. Wayback capture dates come from Esri metadata and can be approximate. Elevations from the 90 m Copernicus fallback are only for orientation, not design.</p></div>
  <div class="card"><h3>Sources</h3><div class="pop"><div class="links small">
    <a href="https://northbay.ca/services-payments/building-development/plan-profile-drawings" target="_blank" rel="noopener">City of North Bay — plan &amp; profile drawings</a>
    <a href="https://northbay.ca/media/qebp5ujh/city-of-north-bay-engineering-design-guidelines-2021.pdf" target="_blank" rel="noopener">City of North Bay — Engineering Design Guidelines 2021</a>
    <a href="https://data-northbaygis.hub.arcgis.com" target="_blank" rel="noopener">Explore North Bay GIS portal</a>
    <a href="https://geohub.lio.gov.on.ca/datasets/mnrf::ontario-digital-terrain-model-lidar-derived" target="_blank" rel="noopener">Ontario Digital Terrain Model (lidar)</a>
    <a href="https://open.canada.ca/data/en/dataset/957782bf-847c-4644-a757-e383c0057995" target="_blank" rel="noopener">NRCan High Resolution DEM (HRDEM)</a>
    <a href="https://geohub.lio.gov.on.ca/datasets/lio::central-ontario-orthophotography-project-coop-2021-1km-index/about" target="_blank" rel="noopener">COOP 2021 orthophotography (20 cm, spring leaf-off)</a>
    <a href="https://livingatlas.arcgis.com/wayback/" target="_blank" rel="noopener">Esri World Imagery Wayback</a>
    <a href="https://www.openstreetmap.org/" target="_blank" rel="noopener">OpenStreetMap (Overpass API)</a></div></div></div>
  <div class="card"><h3>Not for locates</h3><p class="small" style="margin:0">This is a planning and modelling aid. Before any digging, request locates through Ontario One Call.</p></div>
  <div class="card"><h3>Keyboard</h3><div class="kv"><span>Esc</span><span>cancel / back to Select</span><span>Enter</span><span>finish area or profile</span><span>Delete</span><span>delete selected</span><span>Ctrl/⌘ Z</span><span>undo</span></div></div>`;
}

/* ---------- panel, search, coords ---------- */
function showPanelTab(name) {
  $$('#tabs button').forEach(b => b.classList.toggle('on', b.dataset.tab === name));
  $$('.tab').forEach(t => t.classList.toggle('on', t.id === 'tab-' + name));
  if (name === 'export') drawStorm();
  const p = $('#panel'); if (p.classList.contains('peek')) { p.classList.remove('peek'); setTimeout(() => map.invalidateSize(), 220); }
}
$('#tabs').addEventListener('click', e => { const b = e.target.closest('button'); if (b) showPanelTab(b.dataset.tab); });
$('#sheetToggle').addEventListener('click', () => {
  const p = $('#panel'); if (p.classList.contains('peek')) p.classList.remove('peek'); else if (p.classList.contains('full')) { p.classList.remove('full'); p.classList.add('peek'); } else p.classList.add('full');
  $('#sheetToggle').textContent = p.classList.contains('full') ? '▾' : '▴'; setTimeout(() => map.invalidateSize(), 220);
});
$('#dismissStart').addEventListener('click', () => { $('#startCard').style.display = 'none'; store.set('startDismissed2', true); });
const searchLayer = L.layerGroup().addTo(map);
$('#search').addEventListener('submit', async e => {
  e.preventDefault(); const q = $('#q').value.trim(); if (!q) return;
  try {
    const res = await geocode(/north bay/i.test(q) ? q : q + ', North Bay, Ontario');
    if (!res.length) { toast('Nothing found in North Bay for that search.', { err: true }); return; }
    const r = res[0]; searchLayer.clearLayers();
    const ll = [+r.lat, +r.lon]; map.setView(ll, 18);
    L.circleMarker(ll, { pane: 'temp', radius: 8, color: '#f59f00', weight: 3, fillOpacity: 0 }).addTo(searchLayer).bindPopup(`<div class="pop"><h4>${esc(r.display_name.split(',').slice(0, 3).join(','))}</h4>${linksHTML(ll[0], ll[1])}</div>`).openPopup();
  } catch (err) { toast('Search failed: ' + esc(err.message), { err: true }); }
});
map.on('mousemove', e => {
  const { lat, lng } = e.latlng, [x, y] = NB.toUTM(lat, lng);
  let z = ''; if (S.grid) { const v = NB.sampleGrid(S.grid, lat, lng); if (isFinite(v)) z = ` · z ${v.toFixed(2)} m`; }
  $('#coords').textContent = `${lat.toFixed(6)}, ${lng.toFixed(6)} · UTM17 ${x.toFixed(1)} E ${y.toFixed(1)} N${z}`;
});
function updateExtLinks() { const c = map.getCenter(); $('#extLinks').innerHTML = `<div class="muted">At the map centre:</div>${linksHTML(c.lat, c.lng)}`; }
map.on('moveend', debounce(updateExtLinks, 300));
document.addEventListener('keydown', e => {
  const tgt = e.target, typing = /INPUT|TEXTAREA|SELECT/.test(tgt.tagName);
  if (e.key === 'Escape') { if (!$('#modal').hidden) { $('#dwgCancel').click(); return; } if (S.draft && (S.draft.from || (S.draft.pts && S.draft.pts.length))) { S.draft = null; G.temp.clearLayers(); updateHint(); } else { if (S.mode === 'georef') cancelGeoref(); setMode('pan'); } }
  if (typing) return;
  if (e.key === 'Enter') finishDraft();
  if ((e.key === 'Delete' || e.key === 'Backspace') && S.sel) { e.preventDefault(); deleteSel(); }
  if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') { e.preventDefault(); undo(); }
});
$('#srcA').addEventListener('change', e => { S.imgA = e.target.value; setImagery(); });
$('#srcB').addEventListener('change', e => { S.imgB = e.target.value; setImagery(); });
$('#swapAB').addEventListener('click', () => { if (!S.imgB) return; [S.imgA, S.imgB] = [S.imgB, S.imgA]; setImagery(); });
$$('#cmpModes .chip').forEach(c => c.addEventListener('click', () => { $$('#cmpModes .chip').forEach(x => x.classList.remove('on')); c.classList.add('on'); S.cmp = c.dataset.cmp; updateCompare(); }));
$('#fade').addEventListener('input', e => { S.fade = e.target.value / 100; updateCompare(); });
$('#scanDates').addEventListener('click', scanDates);
window.addEventListener('resize', debounce(() => { drawStorm(); clipB(); }, 200));

/* ---------- public hooks for popups ---------- */
window.APP = {
  addNodeAt(kind, sys, lat, lng) { map.closePopup(); addNode(kind, sys, [lat, lng], { evidence: ['lidar low spot'], conf: 'low' }); },
  createSub,
  osmAdd(i, kind, sys) { const el = S.osm[i]; map.closePopup(); addNode(kind, sys, [el.lat, el.lon], { evidence: ['OSM'], notes: `OSM node ${el.id}` }); }
};

/* ---------- init ---------- */
(function init() {
  const saved = store.get('project', null); if (saved && saved.nodes) S.P = Object.assign({ nodes: [], links: [], subs: [] }, saved);
  Object.assign(S.settings, store.get('settings', {}));
  if (store.get('startDismissed2', false)) $('#startCard').style.display = 'none';
  if (window.matchMedia('(max-width:760px)').matches) $('#panel').classList.add('peek');
  buildToolbar(); renderGuide(); renderProjects(); renderSettings(); fillSourceSelects(); setImagery(); updateExtLinks();
  afterChange(); setMode('pan'); loadWayback();
})();
