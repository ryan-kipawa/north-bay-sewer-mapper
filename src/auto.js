/* ===================================================================
   North Bay Sewer Mapper — automatic inference workflow (UI)
   =================================================================== */
map.createPane('mosaic').style.zIndex = 255;
const AUTO = { bbox: null, osm: null, grid: null, res: null, scan: null, mosaicLayer: null, flagLayer: null, events: [], queue: [], qi: 0 };

/* ---------- study area ---------- */
function studyBbox() {
  const b = map.getBounds(), c = map.getCenter(), cosl = Math.cos(c.lat * Math.PI / 180), M = 2500;
  let s = b.getSouth(), n = b.getNorth(), w = b.getWest(), e = b.getEast();
  const hm = (n - s) * 111320, wm = (e - w) * 111320 * cosl;
  if (hm > M) { const d = M / 111320 / 2; s = c.lat - d; n = c.lat + d; }
  if (wm > M) { const d = M / (111320 * cosl) / 2; w = c.lng - d; e = c.lng + d; }
  return [s, w, n, e];
}
function bboxText(bb) { const cosl = Math.cos((bb[0] + bb[2]) / 2 * Math.PI / 180); return `${((bb[3] - bb[1]) * 111320 * cosl / 1000).toFixed(2)} × ${((bb[2] - bb[0]) * 111320 / 1000).toFixed(2)} km`; }
let areaRect = null;
function showArea(bb) { if (areaRect) map.removeLayer(areaRect); areaRect = L.rectangle([[bb[0], bb[1]], [bb[2], bb[3]]], { pane: 'temp', color: '#1c2128', weight: 1.5, dashArray: '4 4', fill: false, interactive: false }).addTo(map); }
map.on('moveend', () => { if (!AUTO.running) $('#areaInfo').textContent = 'Current view: ' + bboxText(studyBbox()) + (map.getZoom() < 14 ? ' — zoom in to a neighbourhood' : ''); });

/* ---------- step list ---------- */
const STEPS = [['osm', 'Streets, buildings, water (OpenStreetMap)'], ['dem', 'Bare-earth elevation (lidar)'], ['infer', 'Infer storm + sanitary networks'], ['img', 'Construction imagery scan + mosaic'], ['done', 'Review queue ready']];
function stepUI(k, state, msg) {
  const el = $(`#step-${k}`); if (!el) return;
  el.querySelector('.st').textContent = { wait: '○', run: '◐', ok: '●', warn: '◑', err: '✕', skip: '–' }[state] || '○';
  el.className = 'li step ' + state; if (msg !== undefined) el.querySelector('.msg').innerHTML = msg;
}
function renderSteps() { $('#steps').innerHTML = STEPS.map(([k, l]) => `<div class="li step wait" id="step-${k}" style="cursor:default"><span class="st">○</span><div class="grow"><b>${l}</b><div class="muted msg"></div></div></div>`).join(''); }

/* ---------- OpenStreetMap ---------- */
async function fetchOSMFor(bb) {
  const B = bb.join(',');
  const q = `[out:json][timeout:150];(way["highway"](${B});way["building"](${B});way["amenity"="parking"](${B});way["waterway"](${B});way["natural"~"^(water|coastline)$"](${B});nwr["man_made"~"^(wastewater_plant|pumping_station)$"](${B});nwr["pumping_station"](${B}););out geom;rel["natural"="water"](${B});out geom(${B});`;
  const j = await fetchJSON(EP.overpass, 160000, { method: 'POST', body: 'data=' + encodeURIComponent(q), headers: { 'Content-Type': 'application/x-www-form-urlencoded' } });
  const roads = [], buildings = [], parking = [], waters = [], plants = [];
  const key = g => `${g.lat.toFixed(7)},${g.lon.toFixed(7)}`;
  const ctr = g => { const a = g.filter(Boolean); return [a.reduce((s, p) => s + p.lat, 0) / a.length, a.reduce((s, p) => s + p.lon, 0) / a.length]; };
  (j.elements || []).forEach(el => {
    const t = el.tags || {};
    const sew = t.man_made === 'wastewater_plant' ? 'wwtp' : ((t.man_made === 'pumping_station' || t.pumping_station) && (t.pumping_station === 'sewage' || t.substance === 'sewage' || /sewage|wastewater|sanitary|lift/i.test(t.name || ''))) ? 'pump' : null;
    if (el.type === 'way' && el.geometry && el.geometry.every(Boolean)) {
      const geom = el.geometry.map(g => [g.lat, g.lon]);
      if (sew) plants.push({ lat: ctr(el.geometry)[0], lng: ctr(el.geometry)[1], kind: sew, name: t.name || '' });
      else if (t.highway) roads.push({ id: el.id, tags: t, name: t.name || '', nodes: el.geometry.map(key), geom });
      else if (t.building) { if (geom.length > 3) buildings.push({ tags: t, geom }); }
      else if (t.amenity === 'parking') { if (geom.length > 3) parking.push({ tags: t, geom }); }
      else if (t.waterway || t.natural === 'water' || t.natural === 'coastline') waters.push(geom);
    } else if (el.type === 'relation' && el.members) {
      el.members.forEach(m => { if (m.geometry) { const g = m.geometry.filter(Boolean).map(p => [p.lat, p.lon]); if (g.length > 1) waters.push(g); } });
    } else if (el.type === 'node' && sew) plants.push({ lat: el.lat, lng: el.lon, kind: sew, name: t.name || '' });
  });
  return { roads, buildings, parking, waters, plants };
}

/* ---------- pipeline ---------- */
async function runAuto(opts = {}) {
  if (AUTO.running) return;
  if (map.getZoom() < 13) { toast('Zoom in to a neighbourhood first (the study area is the current view, up to 2.5 km across).', { err: true }); return; }
  AUTO.running = true; $('#runAuto').disabled = true; renderSteps();
  const bb = opts.reuse && AUTO.bbox ? AUTO.bbox : studyBbox(); AUTO.bbox = bb; showArea(bb);
  try {
    // 1 OSM
    if (!(opts.reuse && AUTO.osm)) {
      stepUI('osm', 'run', 'Querying Overpass…');
      AUTO.osm = await fetchOSMFor(bb);
    }
    const o = AUTO.osm;
    stepUI('osm', o.roads.length ? 'ok' : 'err', `${o.roads.length} street ways · ${o.buildings.length} buildings · ${o.waters.length} water lines · ${o.plants.length} sewage facilities`);
    if (!o.roads.length) throw new Error('No streets found in this area.');
    // 2 DEM
    const covers = g => { if (!g) return false; const [sw, ne] = NB.gridBounds(g); return sw[0] <= bb[0] + 1e-4 && sw[1] <= bb[1] + 1e-4 && ne[0] >= bb[2] - 1e-4 && ne[1] >= bb[3] - 1e-4; };
    let g = covers(S.grid) ? S.grid : null;
    if (!g && $('#useDem').checked) {
      stepUI('dem', 'run', 'Requesting elevations…');
      try { g = await demFromServices(bb[0], bb[1], bb[2], bb[3], m => stepUI('dem', 'run', esc(m)), true); setGrid(g); }
      catch (e) { stepUI('dem', 'err', 'No elevations: ' + esc(e.message) + '. Inference continues without terrain (much lower confidence). Load a GeoTIFF on the Terrain tab and re-run.'); g = null; }
    }
    const quality = g ? (g.quality || 'lidar') : 'none';
    if (g) stepUI('dem', quality === 'lidar' ? 'ok' : 'warn', `${esc(g.src)} · ${g.cell.toFixed(1)} m cells${quality !== 'lidar' ? ' — coarse: directions and depths are much less certain, ditch detection off' : ''}`);
    else if (!$('#useDem').checked) stepUI('dem', 'skip', 'Skipped');
    // 3 inference
    stepUI('infer', 'run', 'Routing, sizing, subcatchments…'); await new Promise(r => setTimeout(r, 30));
    const zAt = g ? (la, lo) => NB.sampleGrid(g, la, lo) : null;
    const t0 = performance.now();
    const excluded = new Set((S.P.removedInferred || []).map(k => k.replace(/[ab]$/, '')));
    // checked pipes fix the flow direction of their street
    const fixedDir = new Map();
    S.P.links.forEach(l => { if (!l.inferred || !l.verified || !l.edge || /[ab]$/.test(l.edge) || l.edge.startsWith('out:')) return; const f = getNode(l.from); if (f && f.vid) fixedDir.set(l.sys + '|' + l.edge, f.vid); });
    const res = NBI.infer({ bbox: bb, roads: o.roads, buildings: o.buildings, parking: o.parking, waters: o.waters, plants: o.plants, zAt, demQuality: quality, demName: g ? g.src : '', excluded, fixedDir }, Object.assign({}, S.inferSettings, { perCap: S.settings.perCap, iiRate: S.settings.iiRate, stormRp: S.settings.rp }));
    AUTO.res = res;
    mergeInferred(res);
    stepUI('infer', 'ok', `${res.links.length} pipes/ditches, ${res.nodes.length} nodes, ${res.subs.length} subcatchments in ${((performance.now() - t0) / 1000).toFixed(1)} s<br>${res.log.map(esc).join('<br>')}`);
    renderAccuracy();
    // 4 imagery
    if ($('#useImg').checked) {
      stepUI('img', 'run', 'Finding imagery versions…');
      try { await exposureScan(bb, res, m => stepUI('img', 'run', m)); stepUI('img', 'ok', `${AUTO.events.length} street exposure(s) found across ${AUTO.scan.versions} imagery version(s) · mosaic on the map`); }
      catch (e) { stepUI('img', 'err', esc(e.message)); }
    } else stepUI('img', 'skip', 'Skipped');
    buildQueue(); stepUI('done', 'ok', `${AUTO.queue.length} items to review, most uncertain and most important first.`);
    renderQueue(); renderAccuracy(); renderEvents();
    map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]]);
  } catch (e) {
    toast('Inference stopped: ' + esc(e.message), { err: true });
    const k = STEPS.find(([k]) => $(`#step-${k}`)?.classList.contains('run')); if (k) stepUI(k[0], 'err', esc(e.message));
  } finally { AUTO.running = false; $('#runAuto').disabled = false; }
}
function mergeInferred(res) {
  mutate(() => {
    const P = S.P, keepLink = l => !l.inferred || l.verified;
    const removed = new Set(P.removedInferred || []);
    const kept = P.links.filter(keepLink), keptEdges = new Set(kept.filter(l => l.edge).map(l => l.sys + '|' + l.edge));
    const keptNodeIds = new Set(kept.flatMap(l => [l.from, l.to]));
    P.nodes = P.nodes.filter(n => !n.inferred || n.verified || keptNodeIds.has(n.id));
    P.links = kept; P.subs = P.subs.filter(s => !s.inferred || s.verified);
    const byVid = new Map(P.nodes.filter(n => n.vid).map(n => [n.sys + '|' + n.vid, n]));
    const used = new Set([...P.nodes, ...P.links, ...P.subs].map(f => f.id));
    const ren = new Map();
    const fresh = id => { if (!used.has(id)) { used.add(id); return id; } const [p] = id.split(/-(?=\d+$)/); let k = 1; let c; do { c = `${p}-${String(k++).padStart(4, '0')}`; } while (used.has(c)); used.add(c); return c; };
    res.nodes.forEach(n => { const ex = n.vid && byVid.get(n.sys + '|' + n.vid); if (ex) { ren.set(n.id, ex.id); return; } const id = fresh(n.id); ren.set(n.id, id); P.nodes.push(Object.assign({}, n, { id })); });
    res.links.forEach(l => {
      if (keptEdges.has(l.sys + '|' + l.edge) || removed.has(l.sys + '|' + l.edge)) return;
      const id = fresh(l.id), from = ren.get(l.from) || l.from, to = ren.get(l.to) || l.to;
      P.links.push(Object.assign({}, l, { id, from, to, inf: Object.assign({}, l.inf, { from, to }) }));
    });
    res.subs.forEach(s => P.subs.push(Object.assign({}, s, { id: fresh(s.id), outlet: ren.get(s.outlet) || s.outlet })));
    // drop inferred nodes left without links
    const linked = new Set(P.links.flatMap(l => [l.from, l.to]));
    P.nodes = P.nodes.filter(n => !n.inferred || linked.has(n.id) || n.verified);
  });
}

/* ---------- accuracy panel ---------- */
const pct = v => v === null || v === undefined || !isFinite(v) ? '—' : Math.round(v * 100) + ' %';
const pcls = v => v === null || v === undefined ? '' : v >= 0.9 ? 'good' : v >= 0.7 ? 'fair' : 'poor';
function renderAccuracy() {
  const box = $('#accuracy'); const st = NBI.expectedAccuracy({ links: S.P.links }, { hasDem: !!S.grid, coarse: S.grid && S.grid.quality !== 'lidar' });
  const V = NBI.validate(S.P);
  if (!st.storm && !st.sanitary) { box.innerHTML = '<div class="muted">Run the inference to see expected accuracy.</div>'; return; }
  const row = (lab, k, vk, note) => `<tr><td>${lab}${note ? ` <span class="muted">${note}</span>` : ''}</td>${['storm', 'sanitary'].map(sy => { const v = st[sy] ? st[sy][k] : null; return `<td class="${pcls(v)}">${pct(v)}</td>`; }).join('')}<td class="${pcls(vk !== undefined ? V[vk] : null)}">${vk && V.n ? pct(V[vk]) : '—'}</td></tr>`;
  box.innerHTML = `<table class="acc"><thead><tr><th></th><th>Storm</th><th>Sanitary</th><th>Measured</th></tr></thead><tbody>
    ${row('Pipe exists on street', 'exist', 'exist')}
    ${row('Flow direction', 'dir', 'dir')}
    ${row('Size exact', 'sizeExact', 'sizeExact', 'prior')}
    ${row('Size ±1 standard size', 'sizeWithin1', 'sizeWithin1', 'prior')}
    ${row('Invert within 0.5 m', 'inv05', 'inv05')}
    ${row('Invert within 1.0 m', 'inv10')}
    </tbody></table>
    <div class="muted" style="margin-top:6px">Storm/Sanitary columns are the model's own probabilities (sizes use a prior until checked). <b>Measured</b> compares the inference with ${V.n} pipe(s) you have confirmed or corrected${V.n ? ` (${V.sized || 0} with sizes, ${V.invN || 0} inverts${V.invBias !== null ? `, invert bias ${V.invBias > 0 ? '+' : ''}${V.invBias.toFixed(2)} m` : ''})` : ''}. Check 20–30 pipes against City drawings to get a trustworthy measured column.</div>
    <div class="row" style="margin-top:8px"><button class="btn sm" id="calib" ${V.n >= 5 ? '' : 'disabled'}>Apply calibration &amp; re-infer</button><span class="muted small">${V.n >= 5 ? '' : 'needs ≥ 5 checked pipes'}</span></div>`;
  $('#calib').onclick = () => {
    const s = S.inferSettings; if (V.invBias !== null) s.extraCover = +((s.extraCover || 0) - V.invBias).toFixed(2);
    if (V.sizeBias !== undefined && V.sizeBias !== null) s.sizeBias = Math.round((s.sizeBias || 0) + V.sizeBias);
    store.set('inferSettings', s); toast(`Calibrated: depth offset ${s.extraCover} m, size shift ${s.sizeBias} step(s). Re-running…`); runAuto({ reuse: true });
  };
}

/* ---------- review queue ---------- */
function reasons(l) {
  const r = [], i = l.inf || {};
  if (i.pExist < 0.75) r.push(i.ditch ? 'Ditch detection was marginal' : l.sys === 'storm' ? 'Few buildings / no curb evidence — street may have ditches or no storm sewer' : 'Few or no buildings front this street — sewer may not exist here');
  if (i.pDir < 0.75) r.push(i.grade === null ? 'No terrain: flow direction unknown' : `Street grade ${(i.grade * 100).toFixed(2)} % — flow could run either way`);
  if (/deep/.test(l.notes)) r.push('Very deep run — possible pumping station or different route');
  const fn = getNode(l.to); if (fn && /assumed|outside/.test(fn.notes)) r.push(`Outlet: ${fn.notes}`);
  if (!r.length) r.push('Spot check');
  return r;
}
function buildQueue() {
  AUTO.queue = S.P.links.filter(l => l.inferred && !l.verified && l.inf && !l.inf.outletPipe).map(l => {
    const i = l.inf, p = Math.min(i.pExist ?? 0.5, i.pDir ?? 0.5), imp = 1 + Math.log10(1 + (i.area || 0) * 5 + (i.pop || 0) / 20);
    return { id: l.id, score: (1 - p) * imp + (/deep/.test(l.notes) ? 0.5 : 0) };
  }).sort((a, b) => b.score - a.score).map(x => x.id);
  AUTO.qi = 0;
}
function renderQueue() {
  const box = $('#queue'); const tot = S.P.links.filter(l => l.inferred && !l.inf?.outletPipe).length, done = S.P.links.filter(l => l.inferred && l.verified).length;
  while (AUTO.qi < AUTO.queue.length && !(getLink(AUTO.queue[AUTO.qi]) && !getLink(AUTO.queue[AUTO.qi]).verified)) AUTO.qi++;
  const l = getLink(AUTO.queue[AUTO.qi]);
  const prog = `<div class="muted">${done} of ${tot} inferred pipes checked${(S.P.removedInferred || []).length ? ` · ${(S.P.removedInferred || []).length} rejected` : ''}</div>`;
  if (!l) { box.innerHTML = prog + '<div class="muted" style="margin-top:6px">Queue empty.</div>'; return; }
  const i = l.inf, bar = (lab, v) => `<div class="pbar"><span>${lab}</span><i style="width:${Math.round(v * 100)}%" class="${pcls(v)}"></i><b>${pct(v)}</b></div>`;
  const evs = (l.evidence || []).filter(e => e.startsWith('exposed')).map(esc).join(', ');
  box.innerHTML = `${prog}<div class="card" style="margin:8px 0 0;border-color:#e8c88a">
    <div class="row"><b style="flex:1">${esc(l.id)} <span class="tag ${l.sys === 'sanitary' ? 't-san' : 't-storm'}">${l.sys}</span></b><span class="muted small">${AUTO.qi + 1} / ${AUTO.queue.length}</span></div>
    <div class="small">${esc(i.street || '')} · ${esc(l.from)} → ${esc(l.to)} · ${i.ditch ? 'roadside ditch' : (l.diam || '?') + ' mm'} · ${fmt(l.len, 0)} m</div>
    ${bar('Exists', i.pExist)}${bar('Direction', i.pDir)}
    <ul class="small" style="margin:6px 0;padding-left:16px">${reasons(l).map(r => `<li>${esc(r)}</li>`).join('')}</ul>
    ${evs ? `<div class="small">Imagery: ${evs}</div>` : ''}
    <div class="row" style="margin-top:8px"><button class="btn sm primary" data-q="ok">✓ Correct <span class="muted">Y</span></button><button class="btn sm" data-q="flip">⇄ Flip <span class="muted">F</span></button><button class="btn sm danger" data-q="no">✗ No pipe <span class="muted">N</span></button><button class="btn sm" data-q="skip">Skip <span class="muted">S</span></button><button class="btn sm" data-q="edit">Edit</button></div>
    <div class="muted small" style="margin-top:6px">Editing size or inverts from a drawing also counts as a check.</div></div>`;
  S.sel = { t: 'link', id: l.id }; render();
  const m = linkMid(l); if (m) map.setView(m, Math.max(map.getZoom(), 18), { animate: false });
}
function queueAct(a) {
  const l = getLink(AUTO.queue[AUTO.qi]); if (!l) return;
  if (a === 'ok') mutate(() => { l.verified = true; l.conf = 'high'; });
  if (a === 'flip') { flipLink(l.id); const l2 = getLink(l.id); mutate(() => { l2.verified = true; l2.conf = 'high'; }); }
  if (a === 'no') mutate(() => { S.P.removedInferred = [...new Set([...(S.P.removedInferred || []), l.sys + '|' + l.edge])]; S.P.links = S.P.links.filter(x => x.id !== l.id); S.sel = null; });
  if (a === 'edit') { showPanelTab('model'); select('link', l.id); return; }
  if (a === 'no' && !AUTO.toldReroute) { AUTO.toldReroute = true; toast('Rejected streets are excluded from routing the next time you press “Infer sewer network”, so flow is re-routed around them.', { ms: 6000 }); }
  AUTO.qi++; renderQueue(); renderAccuracy();
}
$('#queue').addEventListener('click', e => { const b = e.target.closest('[data-q]'); if (b) queueAct(b.dataset.q); });
document.addEventListener('keydown', e => {
  if (!$('#tab-auto').classList.contains('on') || /INPUT|TEXTAREA|SELECT/.test(e.target.tagName) || e.ctrlKey || e.metaKey) return;
  const k = e.key.toLowerCase(); const m = { y: 'ok', f: 'flip', n: 'no', s: 'skip' }[k]; if (m) { e.preventDefault(); queueAct(m); }
});

/* ---------- construction exposure scan + stitched mosaic ---------- */
async function wbVersionsAt(lat, lng, z, maxN) {
  const t = tileXY(lat, lng, z), found = []; let i = 0, guard = 0;
  while (i < S.releases.length && guard++ < 120 && found.length < maxN) {
    const r = S.releases[i];
    const j = await fetchJSON(`${EP.wbTilemap}/${r.num}/${z}/${t.y}/${t.x}`, 10000);
    if (!j || !j.data || !j.data[0]) break;
    const sel = j.select && j.select.length ? +j.select[0] : r.num, idx = S.releases.findIndex(q => q.num === sel);
    const rel = idx >= 0 ? S.releases[idx] : r; if (!found.includes(rel)) found.push(rel);
    i = (idx >= 0 ? Math.max(idx, i) : i) + 1;
  }
  return found;
}
async function exposureScan(bb, res, status) {
  if (!S.releases.length) await loadWayback();
  if (!S.releases.length) throw new Error('Esri Wayback catalogue unavailable');
  // zoom: as fine as possible within ~120 tiles
  let z = 18, t0, t1, nx, ny;
  for (;;) { t0 = tileXY(bb[2], bb[1], z); t1 = tileXY(bb[0], bb[3], z); nx = t1.x - t0.x + 1; ny = t1.y - t0.y + 1; if (nx * ny <= 120 || z <= 16) break; z--; }
  // candidate versions: union of the distinct versions at five sample points
  const pts = [[(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2], [bb[0] * 0.75 + bb[2] * 0.25, bb[1] * 0.75 + bb[3] * 0.25], [bb[0] * 0.25 + bb[2] * 0.75, bb[1] * 0.75 + bb[3] * 0.25], [bb[0] * 0.75 + bb[2] * 0.25, bb[1] * 0.25 + bb[3] * 0.75], [bb[0] * 0.25 + bb[2] * 0.75, bb[1] * 0.25 + bb[3] * 0.75]];
  const vs = new Map();
  for (const [la, lo] of pts) { status(`Finding imagery versions (${vs.size} so far)…`); try { (await wbVersionsAt(la, lo, z, 14)).forEach(r => vs.set(r.num, r)); } catch (e) { if (!vs.size) throw new Error('Wayback version lookup failed: ' + e.message); } }
  const versions = [...vs.values()].sort((a, b) => b.date.localeCompare(a.date)).slice(0, 14);
  const c = [(bb[0] + bb[2]) / 2, (bb[1] + bb[3]) / 2];
  await pool(versions, 5, async r => { if (!S.capture.has(r.num)) { try { const m = await captureMeta(r, c[0], c[1], z); if (m) S.capture.set(r.num, m); } catch { /* optional */ } } });
  const label = r => S.capture.get(r.num)?.date || ('≤ ' + r.date);
  // road mask helper (graph edges drawn at road width)
  const G = res.graph, W = 20037508.342789244, size = 2 * W / 2 ** z, mpp = size / 256 * Math.cos(c[0] * Math.PI / 180);
  const edgesPx = G.E.map(ed => ({ ed, pts: ed.geom.map(p => { const [mx, my] = NB.merc(p[0], p[1]); return [(mx + W) / size * 256, (W - my) / size * 256]; }), wpx: Math.max(3, ((ed.cls === 'service' ? 5 : 9) + 3) / mpp) }));
  const big = document.createElement('canvas'); big.width = nx * 256; big.height = ny * 256; const bg = big.getContext('2d');
  const flag = document.createElement('canvas'); flag.width = big.width; flag.height = big.height; const fg = flag.getContext('2d');
  const colorFor = r => { const yr = +(label(r).match(/\d{4}/) || [2015])[0]; const t = Math.max(0, Math.min(1, (yr - 2014) / 12)); return `hsl(${Math.round(260 - 230 * t)},90%,52%)`; };
  const hits = []; // {tile, rel, px:[...]}
  let done = 0, tainted = false, nimg = 0;
  const tiles = []; for (let j = 0; j < ny; j++) for (let i = 0; i < nx; i++) tiles.push([i, j]);
  await pool(tiles, 4, async ([i, j]) => {
    const tx = t0.x + i, ty = t0.y + j;
    const mask = document.createElement('canvas'); mask.width = mask.height = 256; const mg = mask.getContext('2d');
    mg.strokeStyle = '#fff'; mg.lineCap = 'round'; mg.lineJoin = 'round';
    edgesPx.forEach(({ pts: p, wpx }) => { mg.lineWidth = wpx; mg.beginPath(); p.forEach(([x, y], k) => { const X = x - tx * 256, Y = y - ty * 256; k ? mg.lineTo(X, Y) : mg.moveTo(X, Y); }); mg.stroke(); });
    const md = mg.getImageData(0, 0, 256, 256).data; const roadIdx = []; for (let p = 0; p < 65536; p++) if (md[p * 4] > 128) roadIdx.push(p);
    const imgs = [];
    for (const r of versions) {
      try {
        const im = await loadImg(r.url.replace('{z}', z).replace('{y}', ty).replace('{x}', tx)); nimg++;
        const cv = document.createElement('canvas'); cv.width = cv.height = 256; const g = cv.getContext('2d'); g.drawImage(im, 0, 0);
        let d; try { d = g.getImageData(0, 0, 256, 256).data; } catch { tainted = true; return; }
        let h = 0; for (let p = 0; p < d.length; p += 997) h = (h * 31 + d[p]) | 0;
        if (imgs.some(x => x.h === h)) continue;
        imgs.push({ r, cv, d, h, snow: NBI.isSnowy(d) });
      } catch { /* missing tile for that version */ }
    }
    if (!imgs.length) return;
    // per-pixel temporal median on road pixels
    const use = imgs.filter(x => !x.snow), n = use.length, score = use.map(() => new Float32Array(roadIdx.length));
    if (n >= 2 && roadIdx.length > 50) {
      const tmp = new Uint8Array(n);
      roadIdx.forEach((p, k) => {
        const med = [0, 1, 2].map(ch => { for (let q = 0; q < n; q++) tmp[q] = use[q].d[p * 4 + ch]; const a = Array.from(tmp).sort((x, y) => x - y); return a[n >> 1]; });
        use.forEach((x, q) => { const r = x.d[p * 4], g = x.d[p * 4 + 1], b = x.d[p * 4 + 2]; const dev = Math.abs(r - med[0]) + Math.abs(g - med[1]) + Math.abs(b - med[2]); score[q][k] = NBI.soilScore(r, g, b) * (dev > 60 ? 1 : 0.25); });
      });
    }
    // choose the tile version with the most exposed road; mark flagged pixels
    let best = 0, bf = -1;
    use.forEach((x, q) => {
      let cnt = 0; const px = []; score[q].forEach((v, k) => { if (v > 0.35) { cnt++; px.push(roadIdx[k]); } });
      const f = roadIdx.length ? cnt / roadIdx.length : 0;
      if (cnt >= 40 && f >= 0.03) { hits.push({ tx, ty, r: x.r, px, f }); if (f > bf) { bf = f; best = q; } }
    });
    const show = bf > 0 ? use[best] : imgs[0];
    bg.drawImage(show.cv, i * 256, j * 256);
    hits.filter(h => h.tx === tx && h.ty === ty).forEach(h => { fg.fillStyle = colorFor(h.r); h.px.forEach(p => fg.fillRect(i * 256 + (p % 256), j * 256 + Math.floor(p / 256), 1, 1)); });
    if (bf > 0) { bg.fillStyle = 'rgba(0,0,0,.55)'; bg.fillRect(i * 256 + 2, j * 256 + 2, 92, 16); bg.fillStyle = '#fff'; bg.font = '600 11px IBM Plex Sans, sans-serif'; bg.fillText(label(use[best].r), i * 256 + 6, j * 256 + 14); }
    done++; status(`Scanning tiles ${done}/${tiles.length} · ${nimg} images · ${hits.length} exposures`);
  });
  if (tainted) throw new Error('The imagery server does not allow pixel analysis from this page (CORS). The mosaic needs a normal browser.');
  // overlays
  const nw = NB.unmerc(-W + t0.x * size, W - t0.y * size), se = NB.unmerc(-W + (t1.x + 1) * size, W - (t1.y + 1) * size);
  const bounds = [[se[0], nw[1]], [nw[0], se[1]]];
  if (AUTO.mosaicLayer) map.removeLayer(AUTO.mosaicLayer); if (AUTO.flagLayer) map.removeLayer(AUTO.flagLayer);
  AUTO.mosaicLayer = L.imageOverlay(big.toDataURL('image/jpeg', 0.85), bounds, { pane: 'mosaic', opacity: 1 });
  AUTO.flagLayer = L.imageOverlay(flag.toDataURL('image/png'), bounds, { pane: 'analysis', opacity: 0.9, className: 'analysis-img' });
  if ($('#showMosaic').classList.contains('on')) { AUTO.mosaicLayer.addTo(map); AUTO.flagLayer.addTo(map); }
  AUTO.scan = { z, t0, versions: versions.length, big, size, label };
  // street-level events: share of each street's length crossing flagged pixels, by version
  const flagged = new Map(); hits.forEach(h => { const k = h.r.num; if (!flagged.has(k)) flagged.set(k, { r: h.r, set: new Set() }); const s = flagged.get(k).set; h.px.forEach(p => s.add(((h.ty - t0.y) * 256 + Math.floor(p / 256)) * 100000 + (h.tx - t0.x) * 256 + (p % 256))); });
  const events = [];
  edgesPx.forEach(({ ed, pts: p }) => {
    let samples = 0; const cnt = new Map();
    for (let k = 1; k < p.length; k++) { const [x0, y0] = p[k - 1], [x1, y1] = p[k], L1 = Math.hypot(x1 - x0, y1 - y0), nS = Math.max(1, Math.round(L1 / (3 / mpp)));
      for (let q = 0; q <= nS; q++) { const X = Math.round(x0 + (x1 - x0) * q / nS) - t0.x * 256, Y = Math.round(y0 + (y1 - y0) * q / nS) - t0.y * 256; samples++;
        flagged.forEach((v, num) => { for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (v.set.has((Y + dy) * 100000 + X + dx)) { cnt.set(num, (cnt.get(num) || 0) + 1); return; } }); } }
    cnt.forEach((c2, num) => { const f = c2 / samples; if (f >= 0.15) events.push({ edge: ed.key, street: ed.name || '(unnamed)', rel: flagged.get(num).r, f, mid: ed.geom[Math.floor(ed.geom.length / 2)] }); });
  });
  AUTO.events = events.sort((a, b) => b.f - a.f);
  // evidence on inferred links of those streets
  mutate(() => { events.forEach(ev => S.P.links.filter(l => l.edge && l.edge.replace(/[ab]$/, '') === ev.edge).forEach(l => { const tag = `exposed ${label(ev.rel)}`; l.evidence = [...new Set([...(l.evidence || []), tag])]; if (l.inf) l.inf.pExist = Math.min(0.97, (l.inf.pExist || 0.5) + 0.05); })); });
}
function renderEvents() {
  const box = $('#events'); if (!AUTO.scan) { box.innerHTML = '<div class="muted">Run with the imagery scan to see exposed streets.</div>'; return; }
  const byStreet = new Map(); AUTO.events.forEach(e => { const k = e.street + '|' + e.rel.num; if (!byStreet.has(k) || byStreet.get(k).f < e.f) byStreet.set(k, e); });
  const list = [...byStreet.values()];
  box.innerHTML = list.length ? list.slice(0, 80).map((e, i) => `<div class="li" data-ev="${i}"><canvas width="64" height="64" class="thumb"></canvas><div class="grow"><b>${esc(e.street)}</b><div class="muted">${esc(AUTO.scan.label(e.rel))} · ${Math.round(e.f * 100)} % of segment</div></div></div>`).join('') : '<div class="muted">No exposed road surface detected in the available imagery versions.</div>';
  $$('#events .li').forEach((el, i) => {
    const e = list[i], cv = el.querySelector('canvas'); try {
      const [mx, my] = NB.merc(e.mid[0], e.mid[1]), Wm = 20037508.342789244, X = (mx + Wm) / AUTO.scan.size * 256 - AUTO.scan.t0.x * 256, Y = (Wm - my) / AUTO.scan.size * 256 - AUTO.scan.t0.y * 256;
      cv.getContext('2d').drawImage(AUTO.scan.big, X - 32, Y - 32, 64, 64, 0, 0, 64, 64);
    } catch { /* thumb optional */ }
    el.onclick = () => { S.imgA = 'wb:' + e.rel.num; S.imgB = 'esri'; S.cmp = 'swipe'; setImagery(); map.setView(e.mid, 19); };
  });
}

/* ---------- ensemble export (store-only zip) ---------- */
const CRC = (() => { const t = new Uint32Array(256); for (let n = 0; n < 256; n++) { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xEDB88320 ^ (c >>> 1) : c >>> 1; t[n] = c >>> 0; } return t; })();
function crc32(u8) { let c = 0xFFFFFFFF; for (let i = 0; i < u8.length; i++) c = CRC[(c ^ u8[i]) & 255] ^ (c >>> 8); return (c ^ 0xFFFFFFFF) >>> 0; }
function zip(files) {
  const enc = new TextEncoder(), parts = [], central = []; let off = 0;
  files.forEach(([name, text]) => {
    const n = enc.encode(name), d = enc.encode(text), c = crc32(d);
    const h = new DataView(new ArrayBuffer(30)); h.setUint32(0, 0x04034b50, true); h.setUint16(4, 20, true); h.setUint32(14, c, true); h.setUint32(18, d.length, true); h.setUint32(22, d.length, true); h.setUint16(26, n.length, true);
    parts.push(new Uint8Array(h.buffer), n, d);
    const cd = new DataView(new ArrayBuffer(46)); cd.setUint32(0, 0x02014b50, true); cd.setUint16(4, 20, true); cd.setUint16(6, 20, true); cd.setUint32(16, c, true); cd.setUint32(20, d.length, true); cd.setUint32(24, d.length, true); cd.setUint16(28, n.length, true); cd.setUint32(42, off, true);
    central.push(new Uint8Array(cd.buffer), n); off += 30 + n.length + d.length;
  });
  const csize = central.reduce((s, a) => s + a.length, 0), e = new DataView(new ArrayBuffer(22));
  e.setUint32(0, 0x06054b50, true); e.setUint16(8, files.length, true); e.setUint16(10, files.length, true); e.setUint32(12, csize, true); e.setUint32(16, off, true);
  return new Blob([...parts, ...central, new Uint8Array(e.buffer)], { type: 'application/zip' });
}
function exportEnsemble(system, n) {
  if (!S.P.links.some(l => l.sys === system)) { toast(`No ${system} network yet.`, { err: true }); return; }
  const files = [], st = stamp();
  for (let k = 1; k <= n; k++) files.push([`northbay_${system}_r${String(k).padStart(2, '0')}.inp`, NB.buildINP(NBI.sampleRealisation(S.P, 1000 + k), S.settings, system).text]);
  files.push([`northbay_${system}_base.inp`, NB.buildINP(S.P, S.settings, system).text]);
  files.push(['README.txt', `North Bay ${system} ensemble — ${n} realisations sampled from the inferred uncertainty.\nEach unchecked pipe: size drawn from {-2..+2} standard sizes around the estimate (5/15/45/25/10 %), node inverts shifted by a normal error (σ from the terrain quality), subcatchment imperviousness ±15 % and width ×exp(N(0,0.3)).\nChecked (verified) pipes are kept fixed. Run all files and compare peak flows, surcharge and flooding to see which results are robust.\n`]);
  const b = zip(files), a = document.createElement('a'); a.href = URL.createObjectURL(b); a.download = `northbay_${system}_ensemble_${st}.zip`; document.body.appendChild(a); a.click(); setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1500);
}
function exportUncertainty() {
  const q = v => { const s = String(v ?? ''); return /[",\n]/.test(s) ? '"' + s.replace(/"/g, '""') + '"' : s; };
  const cols = ['id', 'system', 'from', 'to', 'street', 'diameter_mm', 'inferred_diameter_mm', 'up_invert', 'dn_invert', 'invert_sigma_m', 'p_exists', 'p_direction', 'grade', 'design_flow_lps', 'contrib_area_ha', 'population', 'verified', 'evidence', 'notes'];
  const rows = S.P.links.filter(l => l.inf).map(l => [l.id, l.sys, l.from, l.to, l.inf.street || '', l.diam, l.inf.diam ?? '', l.upInv, l.dnInv, l.inf.invSigma, l.inf.pExist, l.inf.pDir, l.inf.grade, l.inf.q, l.inf.area, l.inf.pop, l.verified ? 'yes' : '', (l.evidence || []).join('/'), l.notes].map(q).join(','));
  download(`northbay_pipe_uncertainty_${stamp()}.csv`, cols.join(',') + '\n' + rows.join('\n'), 'text/csv');
}

/* ---------- wiring ---------- */
S.inferSettings = Object.assign({}, store.get('inferSettings', {}));
$('#runAuto').addEventListener('click', () => runAuto());
$('#showMosaic').addEventListener('click', e => { e.target.classList.toggle('on'); const on = e.target.classList.contains('on'); [AUTO.mosaicLayer, AUTO.flagLayer].forEach(l => { if (l) on ? l.addTo(map) : map.removeLayer(l); }); });
$('#clearInferred').addEventListener('click', () => { mutate(() => { S.P.links = S.P.links.filter(l => !l.inferred || l.verified); const linked = new Set(S.P.links.flatMap(l => [l.from, l.to])); S.P.nodes = S.P.nodes.filter(n => !n.inferred || linked.has(n.id)); S.P.subs = S.P.subs.filter(s => !s.inferred); }); AUTO.queue = []; renderQueue(); renderAccuracy(); });
$('#ensStorm').onclick = () => exportEnsemble('storm', +$('#ensN').value || 10);
$('#ensSan').onclick = () => exportEnsemble('sanitary', +$('#ensN').value || 10);
$('#expUnc').onclick = exportUncertainty;
renderSteps(); renderAccuracy(); renderQueue();
$('#areaInfo').textContent = 'Current view: ' + bboxText(studyBbox());
