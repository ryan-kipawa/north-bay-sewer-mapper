/* ===================================================================
   North Bay Sewer Mapper — app, part 1: state, map, imagery, terrain
   =================================================================== */
'use strict';
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => [...r.querySelectorAll(s)];
const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const fmt = (v, d = 2) => (v === null || v === undefined || !isFinite(v)) ? '—' : (+v).toFixed(d);
const NB_CENTER = [46.3091, -79.4608];

/* ---------- endpoints ---------- */
const EP = {
  esri: 'https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  clarity: 'https://clarity.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}',
  osm: 'https://tile.openstreetmap.org/{z}/{x}/{y}.png',
  roads: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Transportation/MapServer/tile/{z}/{y}/{x}',
  labels: 'https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}',
  wbConfig: 'https://s3-us-west-2.amazonaws.com/config.maptiles.arcgis.com/waybackconfig.json',
  wbTilemap: 'https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/MapServer/tilemap',
  onImg1317: 'https://ws.geoservices.lrc.gov.on.ca/arcgis5/rest/services/AerialImagery/GEO_Imagery_Data_Service_2013to2017/ImageServer',
  onImg1822: 'https://ws.geoservices.lrc.gov.on.ca/arcgis5/rest/services/AerialImagery/GEO_Imagery_Data_Service_2018to2022/ImageServer',
  onDTM: 'https://ws.geoservices.lrc.gov.on.ca/arcgis5/rest/services/Elevation/Ontario_DTM_LidarDerived/ImageServer',
  hsEsri: 'https://server.arcgisonline.com/ArcGIS/rest/services/Elevation/World_Hillshade/MapServer/tile/{z}/{y}/{x}',
  nrcanWMS: 'https://datacube.services.geo.ca/ows/elevation',
  openMeteo: 'https://api.open-meteo.com/v1/elevation',
  overpass: 'https://overpass-api.de/api/interpreter',
  nominatim: 'https://nominatim.openstreetmap.org/search',
  dwg: 'https://northbay.ca/content/CADDrawings/'
};

/* ---------- state ---------- */
const S = {
  P: { nodes: [], links: [], subs: [] },
  settings: Object.assign({}, NB.DEFAULT_SETTINGS),
  mode: 'pan', draft: null, sel: null,
  imgA: 'esri', imgB: '', cmp: 'swipe', swipeX: 0.5, fade: 0.6,
  releases: [], relByNum: new Map(), capture: new Map(),
  grid: null, A: null, demLayers: {}, demOn: { relief: true, flow: false, sinks: false },
  derived: null, undo: [], lastDiam: { storm: '', sanitary: '' }, osm: null, dwg: null,
  issueSev: { error: true, warn: true, info: false }
};
const store = {
  get(k, d) { try { const v = localStorage.getItem('nbsm.' + k); return v ? JSON.parse(v) : d; } catch { return d; } },
  set(k, v) { try { localStorage.setItem('nbsm.' + k, JSON.stringify(v)); } catch { /* storage unavailable */ } }
};

/* ---------- utils ---------- */
function toast(msg, opts = {}) {
  const t = document.createElement('div'); t.className = 't' + (opts.err ? ' err' : '');
  t.innerHTML = msg;
  if (opts.action) { const b = document.createElement('button'); b.className = 'btn sm'; b.textContent = opts.action[0]; b.onclick = () => { opts.action[1](); t.remove(); }; t.appendChild(b); }
  const box = $('#toast'); box.appendChild(t);
  while (box.children.length > 4) box.firstChild.remove();
  setTimeout(() => t.remove(), opts.ms || (opts.err ? 7000 : 3500));
}
async function fetchT(url, opt = {}, ms = 15000) {
  const ac = new AbortController(); const tm = setTimeout(() => ac.abort(), ms);
  try { const r = await fetch(url, Object.assign({ signal: ac.signal }, opt)); if (!r.ok) throw new Error('HTTP ' + r.status); return r; }
  finally { clearTimeout(tm); }
}
const fetchJSON = (u, ms, opt) => fetchT(u, opt, ms).then(r => r.json());
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
async function pool(items, n, fn) { const out = new Array(items.length); let i = 0; await Promise.all(Array.from({ length: Math.min(n, items.length) }, async () => { while (i < items.length) { const k = i++; try { out[k] = await fn(items[k], k); } catch (e) { out[k] = null; } } })); return out; }
function download(name, text, type = 'text/plain') {
  const b = new Blob([text], { type }); const a = document.createElement('a');
  a.href = URL.createObjectURL(b); a.download = name; document.body.appendChild(a); a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}
function loadScript(src) { return new Promise((res, rej) => { const s = document.createElement('script'); s.src = src; s.onload = res; s.onerror = () => rej(new Error('Could not load ' + src)); document.head.appendChild(s); }); }
let _gt = null;
async function loadGeoTIFF() {
  if (window.GeoTIFF) return window.GeoTIFF;
  if (_gt) return _gt;
  try { _gt = await import('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/+esm'); return _gt; }
  catch { await loadScript('https://cdn.jsdelivr.net/npm/geotiff@2.1.3/dist-browser/geotiff.js'); return (_gt = window.GeoTIFF); }
}
async function loadPdfJs() {
  if (window.pdfjsLib) return window.pdfjsLib;
  await loadScript('https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js');
  window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
  return window.pdfjsLib;
}
function streetLinks(lat, lng) {
  const a = lat.toFixed(6), o = lng.toFixed(6);
  return [
    ['Google Street View', `https://www.google.com/maps/@?api=1&map_action=pano&viewpoint=${a},${o}`],
    ['Google Maps satellite', `https://www.google.com/maps/@${a},${o},80m/data=!3m1!1e3`],
    ['Google Earth (historical imagery)', `https://earth.google.com/web/@${a},${o},250a,300d,35y,0h,0t,0r`],
    ['Mapillary street photos', `https://www.mapillary.com/app/?lat=${a}&lng=${o}&z=18`],
    ['Bing Maps aerial (other vintage)', `https://www.bing.com/maps?cp=${a}~${o}&lvl=19&style=a`],
    ['Apple Maps satellite', `https://maps.apple.com/?ll=${a},${o}&z=19&t=k`],
    ['Esri Wayback app', `https://livingatlas.arcgis.com/wayback/#mapCenter=${o}%2C${a}%2C19`],
    ['OpenStreetMap', `https://www.openstreetmap.org/#map=19/${a}/${o}`]
  ];
}
const linksHTML = (lat, lng) => '<div class="links">' + streetLinks(lat, lng).map(([t, u]) => `<a href="${u}" target="_blank" rel="noopener">${t}</a>`).join('') + '</div>';

/* ---------- map ---------- */
const map = L.map('map', { zoomControl: true, maxZoom: 22, doubleClickZoom: true, boxZoom: true }).setView(store.get('view', { c: NB_CENTER, z: 16 }).c, store.get('view', { c: NB_CENTER, z: 16 }).z);
map.attributionControl.setPrefix('');
[['imgB', 250], ['drawing', 380], ['analysis', 390], ['clues', 420], ['subs', 430], ['links', 440], ['temp', 650]].forEach(([n, z]) => { map.createPane(n).style.zIndex = z; });
map.getPane('drawing').style.pointerEvents = 'none';
map.getPane('analysis').style.pointerEvents = 'none';
L.control.scale({ imperial: false, position: 'bottomright' }).addTo(map);
map.on('moveend', debounce(() => store.set('view', { c: [map.getCenter().lat, map.getCenter().lng], z: map.getZoom() }), 500));

/* ArcGIS ImageServer exportImage as tiles */
const ArcImage = L.TileLayer.extend({
  getTileUrl(c) {
    const W = 20037508.342789244, size = 2 * W / Math.pow(2, c.z), minx = -W + c.x * size, maxy = W - c.y * size;
    let u = `${this.options.base}/exportImage?bbox=${minx},${maxy - size},${minx + size},${maxy}&bboxSR=3857&imageSR=3857&size=256,256&format=${this.options.fmt || 'jpgpng'}&transparent=true&f=image`;
    if (this.options.rule) u += '&renderingRule=' + encodeURIComponent(JSON.stringify(this.options.rule));
    return u;
  }
});
const arcImage = (base, o) => new ArcImage('', Object.assign({ base, maxZoom: 22, maxNativeZoom: 21, tileSize: 256 }, o));

/* ---------- imagery sources ---------- */
const SOURCES = {
  esri: { name: 'Esri World Imagery (current)', make: p => L.tileLayer(EP.esri, { pane: p, maxZoom: 22, maxNativeZoom: 19, attribution: 'Imagery © Esri, Maxar, Earthstar Geographics' }) },
  clarity: { name: 'Esri Clarity (sometimes a different capture)', make: p => L.tileLayer(EP.clarity, { pane: p, maxZoom: 22, maxNativeZoom: 19, attribution: 'Imagery © Esri' }) },
  on1317: { name: 'Ontario GEO 2013–17 (COOP 2016, spring leaf-off)', make: p => arcImage(EP.onImg1317, { pane: p, attribution: 'Imagery © King’s Printer for Ontario' }) },
  on1822: { name: 'Ontario GEO 2018–22 (COOP 2021, spring leaf-off — may be restricted)', make: p => arcImage(EP.onImg1822, { pane: p, attribution: 'Imagery © King’s Printer for Ontario' }) },
  osm: { name: 'OpenStreetMap (street map)', make: p => L.tileLayer(EP.osm, { pane: p, maxZoom: 22, maxNativeZoom: 19, attribution: '© OpenStreetMap contributors' }) }
};
function srcName(id) {
  if (!id) return '—';
  if (id.startsWith('wb:')) { const r = S.relByNum.get(+id.slice(3)); const c = S.capture.get(+id.slice(3)); return r ? `Wayback ${r.date}${c && c.date ? ' · captured ' + c.date : ''}` : 'Wayback ' + id.slice(3); }
  return SOURCES[id]?.name || id;
}
function makeImagery(id, pane) {
  let lyr;
  if (id.startsWith('wb:')) {
    const r = S.relByNum.get(+id.slice(3));
    const url = r ? r.url : `https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/${id.slice(3)}/{z}/{y}/{x}`;
    lyr = L.tileLayer(url, { pane, maxZoom: 22, maxNativeZoom: 19, attribution: 'Wayback imagery © Esri and providers' });
  } else lyr = SOURCES[id].make(pane);
  let ok = 0, bad = 0;
  lyr.on('tileload', () => { ok++; tileMon(true); }).on('tileerror', () => { bad++; tileMon(false); if (bad === 6 && ok === 0 && TM.ok > 0) toast(`${esc(srcName(id))}: tiles are not loading here (service down, restricted, or no coverage).`, { err: true }); });
  return lyr;
}
const TM = { ok: 0, bad: 0, shown: false };
function tileMon(good) {
  if (good) { TM.ok++; $('#blockedBanner')?.remove(); return; }
  TM.bad++;
  if (TM.ok === 0 && TM.bad >= 8 && !TM.shown) {
    TM.shown = true;
    const d = document.createElement('div'); d.id = 'blockedBanner';
    d.innerHTML = `<b>Map imagery is blocked here.</b> This usually means the file is open inside an app preview (such as the Claude app) that blocks outside map tiles and data. Download the file and open it in Chrome, Edge, Firefox or Safari on a computer — or host it on a website — and the imagery, lidar and OpenStreetMap data will load.${location.protocol.startsWith('http') || location.protocol === 'file:' ? '<br><span class="small">If you are already in a normal browser, check your internet connection or any network filter.</span>' : ''}`;
    $('#mapwrap').appendChild(d);
  }
}
let layerA = null, layerB = null;
function setImagery() {
  if (layerA) map.removeLayer(layerA); if (layerB) map.removeLayer(layerB);
  layerA = makeImagery(S.imgA, 'tilePane').addTo(map); layerA.setZIndex(1);
  layerB = S.imgB ? makeImagery(S.imgB, 'imgB').addTo(map) : null;
  $('#srcA').value = S.imgA; $('#srcB').value = S.imgB;
  $('#srcAinfo').textContent = srcName(S.imgA);
  $('#labA').textContent = 'A · ' + srcName(S.imgA); $('#labB').textContent = 'B · ' + srcName(S.imgB);
  updateCompare();
}
function fillSourceSelects() {
  const base = Object.entries(SOURCES).map(([k, v]) => `<option value="${k}">${esc(v.name)}</option>`).join('');
  const wb = S.releases.length ? `<optgroup label="Esri Wayback releases (publication date)">${S.releases.map(r => `<option value="wb:${r.num}">Wayback ${r.date}${S.capture.get(r.num)?.date ? ' · captured ' + S.capture.get(r.num).date : ''}</option>`).join('')}</optgroup>` : '';
  $('#srcA').innerHTML = base + wb; $('#srcB').innerHTML = '<option value="">— none —</option>' + base + wb;
  $('#srcA').value = S.imgA; $('#srcB').value = S.imgB;
}

/* ---------- compare: swipe / fade / blink ---------- */
let blinkT = null;
function updateCompare() {
  const pane = map.getPane('imgB'), sw = $('#swipe');
  clearInterval(blinkT); pane.style.opacity = ''; pane.style.visibility = ''; pane.style.clip = '';
  $('#fadeRow').style.display = S.cmp === 'opacity' && S.imgB ? 'block' : 'none';
  if (!S.imgB) { sw.style.display = 'none'; return; }
  if (S.cmp === 'swipe') { sw.style.display = 'block'; clipB(); }
  else {
    sw.style.display = 'none';
    if (S.cmp === 'opacity') pane.style.opacity = S.fade;
    if (S.cmp === 'blink') { let on = true; blinkT = setInterval(() => { on = !on; pane.style.visibility = on ? '' : 'hidden'; }, 800); }
  }
}
function clipB() {
  if (!S.imgB || S.cmp !== 'swipe') return;
  const size = map.getSize(), x = Math.round(size.x * S.swipeX);
  $('#swipe').style.left = x + 'px';
  const nw = map.containerPointToLayerPoint([0, 0]), se = map.containerPointToLayerPoint(size), cx = map.containerPointToLayerPoint([x, 0]).x;
  map.getPane('imgB').style.clip = `rect(${nw.y}px, ${se.x}px, ${se.y}px, ${cx}px)`;
}
map.on('move zoom resize viewreset zoomend', clipB);
(function swipeDrag() {
  const h = $('#swipe .handle'); let drag = false;
  const mv = e => { if (!drag) return; const r = $('#map').getBoundingClientRect(); S.swipeX = Math.min(0.98, Math.max(0.02, (e.clientX - r.left) / r.width)); clipB(); };
  h.addEventListener('pointerdown', e => { drag = true; h.setPointerCapture(e.pointerId); map.dragging.disable(); e.preventDefault(); e.stopPropagation(); });
  h.addEventListener('pointermove', mv);
  h.addEventListener('pointerup', () => { drag = false; map.dragging.enable(); });
  L.DomEvent.disableClickPropagation($('#swipe'));
})();

/* ---------- reference overlays ---------- */
const refLayers = {};
$$('[data-ov]').forEach(ch => ch.addEventListener('click', () => {
  const k = ch.dataset.ov; ch.classList.toggle('on');
  if (ch.classList.contains('on')) refLayers[k] = L.tileLayer(EP[k], { pane: 'overlayPane', maxZoom: 22, maxNativeZoom: 19, attribution: '© Esri' }).addTo(map);
  else { map.removeLayer(refLayers[k]); delete refLayers[k]; }
}));

/* ---------- Wayback ---------- */
async function loadWayback() {
  try {
    const j = await fetchJSON(EP.wbConfig, 20000);
    S.releases = Object.entries(j).map(([num, v]) => {
      const m = (v.itemTitle || '').match(/(\d{4}-\d{2}-\d{2})/);
      return { num: +num, date: m ? m[1] : null, url: (v.itemURL || '').replace('{level}', '{z}').replace('{row}', '{y}').replace('{col}', '{x}'), meta: v.metadataLayerUrl };
    }).filter(r => r.date && r.url).sort((a, b) => b.date.localeCompare(a.date));
    S.releases.forEach(r => S.relByNum.set(r.num, r));
    fillSourceSelects();
  } catch (e) {
    $('#scanStatus').textContent = 'Wayback catalogue unavailable: ' + e.message;
  }
}
function tileXY(lat, lng, z) {
  const n = 2 ** z, x = Math.floor((lng + 180) / 360 * n);
  const y = Math.floor((1 - Math.log(Math.tan(lat * Math.PI / 180) + 1 / Math.cos(lat * Math.PI / 180)) / Math.PI) / 2 * n);
  return { x, y };
}
function parseDateVal(v) {
  if (v === null || v === undefined || v === 'Null' || v === '') return null;
  if (typeof v === 'number') {
    if (v > 1e11 || v < -1e11) return new Date(v);
    if (v > 19000000 && v < 21000000) { const s = String(Math.round(v)); return new Date(+s.slice(0, 4), +s.slice(4, 6) - 1, +s.slice(6, 8)); }
    return null;
  }
  const s = String(v).trim(); const m = s.match(/^(\d{4})(\d{2})(\d{2})$/);
  if (m) return new Date(+m[1], +m[2] - 1, +m[3]);
  const d = new Date(s); return isNaN(d) ? null : d;
}
function parseMeta(a) {
  const ent = Object.entries(a || {}), find = re => ent.find(([k]) => re.test(k.toUpperCase().replace(/\s+/g, '_')));
  const dv = find(/SRC_DATE2/) || find(/SRC_DATE|SOURCE_DATE/) || find(/DATE/);
  const rv = find(/SAMP_RES|SRC_RES|RESOLUTION/), pv = find(/NICE_DESC|SRC_DESC|NICE_NAME|PROVIDER/), av = find(/SRC_ACC|ACCURACY/);
  const d = dv ? parseDateVal(dv[1]) : null;
  return { date: d ? d.toISOString().slice(0, 10) : null, month: d ? d.getMonth() + 1 : null, res: rv ? parseFloat(rv[1]) : null, prov: pv ? pv[1] : null, acc: av ? parseFloat(av[1]) : null };
}
async function captureMeta(rel, lat, lng, z) {
  if (!rel.meta) return null;
  const r = 360 / (256 * 2 ** z), half = r * 200;
  const base = `${rel.meta}/identify?f=json&geometry=${lng},${lat}&geometryType=esriGeometryPoint&sr=4326&tolerance=0&mapExtent=${lng - half},${lat - half},${lng + half},${lat + half}&imageDisplay=400,400,96&returnGeometry=false`;
  let j = await fetchJSON(base + '&layers=visible', 12000);
  if (!j.results || !j.results.length) j = await fetchJSON(base + '&layers=all', 12000);
  const metas = (j.results || []).map(x => parseMeta(x.attributes)).filter(m => m.date);
  if (!metas.length) return null;
  metas.sort((a, b) => (a.res ?? 99) - (b.res ?? 99));
  return metas[0];
}
function seasonTag(m) {
  if (!m) return '';
  if (m === 4 || m === 5) return '<span class="tag t-season">spring</span>';
  if (m >= 6 && m <= 10) return '<span class="tag t-con">construction</span>';
  if (m === 11) return '<span class="tag t-season">late fall</span>';
  return '<span class="tag t-win">winter</span>';
}
async function scanDates() {
  if (!S.releases.length) { await loadWayback(); if (!S.releases.length) return; }
  const c = map.getCenter(), z = Math.min(Math.max(map.getZoom(), 12), 19), t = tileXY(c.lat, c.lng, z);
  const st = $('#scanStatus'); st.textContent = 'Scanning…'; $('#dateList').innerHTML = '';
  const found = []; let i = 0, guard = 0;
  try {
    while (i < S.releases.length && guard++ < 250) {
      const r = S.releases[i];
      const j = await fetchJSON(`${EP.wbTilemap}/${r.num}/${z}/${t.y}/${t.x}`, 10000);
      if (!j || !j.data || !j.data[0]) break;
      const sel = j.select && j.select.length ? +j.select[0] : r.num;
      const idx = S.releases.findIndex(q => q.num === sel);
      const rel = idx >= 0 ? S.releases[idx] : r;
      if (!found.includes(rel)) found.push(rel);
      st.textContent = `Scanning… ${found.length} version(s)`;
      i = (idx >= 0 ? Math.max(idx, i) : i) + 1;
    }
  } catch (e) {
    st.textContent = 'Change scan unavailable (' + e.message + ') — listing all releases instead.';
    S.releases.slice(0, 40).forEach(r => found.push(r));
  }
  if (!found.length) { st.textContent = 'No Wayback imagery at this spot.'; return; }
  st.textContent = `${found.length} distinct version(s) — reading capture dates…`;
  renderDateList(found);
  await pool(found, 5, async r => { const m = await captureMeta(r, c.lat, c.lng, z); if (m) S.capture.set(r.num, m); renderDateList(found); });
  st.textContent = `${found.length} distinct version(s) at z${z}.`;
  fillSourceSelects();
}
function renderDateList(found) {
  $('#dateList').innerHTML = found.map(r => {
    const m = S.capture.get(r.num);
    return `<div class="li" data-num="${r.num}"><div class="grow"><b>${m?.date ? 'Captured ' + m.date : 'Released ' + r.date}</b> ${seasonTag(m?.month)}
      <div class="muted">${m?.date ? 'Wayback ' + r.date + ' · ' : ''}${m?.prov ? esc(m.prov) + ' · ' : ''}${m?.res ? m.res.toFixed(2) + ' m/px' : ''}</div></div>
      <button class="btn sm" data-set="A">A</button><button class="btn sm" data-set="B">B</button></div>`;
  }).join('');
}
$('#dateList').addEventListener('click', e => {
  const li = e.target.closest('.li'); if (!li) return;
  const id = 'wb:' + li.dataset.num, which = e.target.dataset.set || 'A';
  if (which === 'A') S.imgA = id; else { S.imgB = id; }
  setImagery();
});

/* ---------- elevation ---------- */
async function getElevation(lat, lng) {
  if (S.grid) { const z = NB.sampleGrid(S.grid, lat, lng); if (isFinite(z)) return { z, src: S.grid.src }; }
  try {
    const g = encodeURIComponent(JSON.stringify({ x: lng, y: lat, spatialReference: { wkid: 4326 } }));
    const j = await fetchJSON(`${EP.onDTM}/identify?geometry=${g}&geometryType=esriGeometryPoint&returnGeometry=false&returnCatalogItems=false&f=json`, 10000);
    const v = parseFloat(j.value); if (isFinite(v) && v > -500 && v < 3000) return { z: v, src: 'Ontario lidar DTM' };
  } catch { /* fall through */ }
  try {
    const j = await fetchJSON(`${EP.openMeteo}?latitude=${lat}&longitude=${lng}`, 8000);
    const v = j.elevation && j.elevation[0]; if (isFinite(v)) return { z: v, src: 'Copernicus 90 m (coarse)' };
  } catch { /* none */ }
  return null;
}
async function getElevations(pts) { // [[lat,lng]] -> [{z,src}|null]
  if (S.grid) { const r = pts.map(p => { const z = NB.sampleGrid(S.grid, p[0], p[1]); return isFinite(z) ? { z, src: S.grid.src } : null; }); if (r.every(Boolean)) return r; }
  const r = await pool(pts, 6, p => getElevation(p[0], p[1]));
  return r;
}

/* ---------- hillshade overlays ---------- */
const hsLayers = {};
const HS = {
  'hs-ontario': () => arcImage(EP.onDTM, { pane: 'analysis', fmt: 'png', rule: { rasterFunction: 'Hillshade', rasterFunctionArguments: { Azimuth: 315, Altitude: 45, ZFactor: 3 }, variableName: 'DEM' }, attribution: 'Lidar DTM © King’s Printer for Ontario' }),
  'hs-nrcan': () => L.tileLayer.wms(EP.nrcanWMS, { pane: 'analysis', layers: 'dtm-hillshade', format: 'image/png', transparent: true, version: '1.3.0', maxZoom: 22, attribution: 'HRDEM © NRCan' }),
  'hs-esri': () => L.tileLayer(EP.hsEsri, { pane: 'analysis', maxZoom: 22, maxNativeZoom: 16, attribution: '© Esri' })
};
$$('[data-hs]').forEach(ch => ch.addEventListener('click', () => {
  const k = ch.dataset.hs; ch.classList.toggle('on');
  if (ch.classList.contains('on')) { hsLayers[k] = HS[k]().addTo(map); hsLayers[k].setOpacity($('#hsOpacity').value / 100); let ok = 0, bad = 0; hsLayers[k].on('tileload', () => ok++).on('tileerror', () => { if (++bad === 6 && !ok) toast(`${ch.textContent} hillshade is not loading for this area.`, { err: true }); }); }
  else { map.removeLayer(hsLayers[k]); delete hsLayers[k]; }
}));
$('#hsOpacity').addEventListener('input', e => Object.values(hsLayers).forEach(l => l.setOpacity(e.target.value / 100)));

/* ---------- DEM grid: fetch / load / render ---------- */
// Bare-earth elevation grid for a lat/lng box from the provincial / federal services, else coarse terrain tiles.
async function demFromServices(sb, wb, nb, eb, status = () => {}, allowCoarse = true) {
  const cosl = Math.cos((sb + nb) / 2 * Math.PI / 180);
  const [x0, y1] = NB.merc(sb, wb), [x1, y0] = NB.merc(nb, eb);
  const res = Math.max(0.5 / cosl, (x1 - x0) / 1100, (y0 - y1) / 1100);
  const w = Math.round((x1 - x0) / res), h = Math.round((y0 - y1) / res);
  const sources = [
    ['Ontario lidar DTM', `${EP.onDTM}/exportImage?bbox=${x0},${y1},${x1},${y0}&bboxSR=3857&imageSR=3857&size=${w},${h}&format=tiff&pixelType=F32&noData=-9999&noDataInterpretation=esriNoDataMatchAny&interpolation=RSP_BilinearInterpolation&f=image`],
    ['NRCan HRDEM', `${EP.nrcanWMS}?SERVICE=WCS&VERSION=1.0.0&REQUEST=GetCoverage&COVERAGE=dtm&CRS=EPSG:3857&RESPONSE_CRS=EPSG:3857&BBOX=${x0},${y1},${x1},${y0}&WIDTH=${w}&HEIGHT=${h}&FORMAT=image/geotiff`]
  ];
  const errs = [];
  for (const [name, url] of sources) {
    status(`Requesting ${w}×${h} elevation cells (${(res * cosl).toFixed(2)} m) from ${name}…`);
    try {
      const r = await fetchT(url, {}, 90000), buf = await r.arrayBuffer();
      const b0 = new Uint8Array(buf.slice(0, 4));
      if (!((b0[0] === 0x49 && b0[1] === 0x49) || (b0[0] === 0x4d && b0[1] === 0x4d))) { let msg = 'not a GeoTIFF'; try { msg = JSON.parse(new TextDecoder().decode(buf.slice(0, 800))).error?.message || msg; } catch { /* xml */ } throw new Error(msg); }
      const GT = await loadGeoTIFF(), tiff = await GT.fromArrayBuffer(buf), img = await tiff.getImage();
      const W = img.getWidth(), H = img.getHeight(), ras = await img.readRasters({ interleave: true });
      const z = new Float32Array(W * H); let valid = 0;
      for (let i = 0; i < W * H; i++) { const v = ras[i]; if (v > -1000 && v < 5000 && isFinite(v)) { z[i] = v; valid++; } else z[i] = NaN; }
      if (valid < W * H * 0.05) throw new Error('no coverage here');
      const rx = (x1 - x0) / W;
      return { w: W, h: H, z, x0, y0, res: rx, cell: rx * cosl, src: name, quality: 'lidar' };
    } catch (e) { errs.push(`${name}: ${e.message}`); }
  }
  if (allowCoarse) {
    status('Lidar services unavailable — using coarse terrain tiles (~20–30 m source)…');
    try { return await terrainTiles(sb, wb, nb, eb); } catch (e) { errs.push('Terrain tiles: ' + e.message); }
  }
  throw new Error(errs.join('; '));
}
async function terrainTiles(sb, wb, nb, eb, z = 15) {
  const t0 = tileXY(nb, wb, z), t1 = tileXY(sb, eb, z), nx = t1.x - t0.x + 1, ny = t1.y - t0.y + 1;
  if (nx * ny > 64) throw new Error('area too large');
  const W = nx * 256, H = ny * 256, zz = new Float32Array(W * H).fill(NaN);
  await pool([...Array(nx * ny).keys()], 6, async k => {
    const tx = t0.x + (k % nx), ty = t0.y + Math.floor(k / nx);
    const img = await loadImg(`https://s3.amazonaws.com/elevation-tiles-prod/terrarium/${z}/${tx}/${ty}.png`);
    const c = document.createElement('canvas'); c.width = c.height = 256; const g = c.getContext('2d'); g.drawImage(img, 0, 0);
    const d = g.getImageData(0, 0, 256, 256).data, ox = (k % nx) * 256, oy = Math.floor(k / nx) * 256;
    for (let r = 0; r < 256; r++) for (let q = 0; q < 256; q++) { const i = (r * 256 + q) * 4; zz[(oy + r) * W + ox + q] = d[i] * 256 + d[i + 1] + d[i + 2] / 256 - 32768; }
  });
  const Wm = 20037508.342789244, size = 2 * Wm / 2 ** z, x0 = -Wm + t0.x * size, y0 = Wm - t0.y * size, res = size / 256;
  const cosl = Math.cos((sb + nb) / 2 * Math.PI / 180);
  return { w: W, h: H, z: zz, x0, y0, res, cell: res * cosl, src: 'Terrain tiles (coarse)', quality: 'coarse' };
}
function loadImg(url) { return new Promise((res, rej) => { const im = new Image(); im.crossOrigin = 'anonymous'; im.onload = () => res(im); im.onerror = () => rej(new Error('image failed: ' + url.split('/').slice(2, 3))); im.src = url; }); }
async function fetchViewDEM() {
  const b = map.getBounds(), c = map.getCenter(), cosl = Math.cos(c.lat * Math.PI / 180);
  const ground = Math.max(b.getEast() - b.getWest(), (b.getNorth() - b.getSouth()) / cosl) * 111320 * cosl;
  if (ground > 3500) { toast('Zoom in so the view is under ~3 km across, then try again.', { err: true }); return; }
  const st = $('#demStatus');
  try { setGrid(await demFromServices(b.getSouth(), b.getWest(), b.getNorth(), b.getEast(), m => { st.textContent = m; }, true)); }
  catch (e) { st.innerHTML = `Could not get elevations for this view (${esc(e.message)}).<br>Alternative: download DTM tiles from the <a href="https://geohub.lio.gov.on.ca/datasets/mnrf::ontario-digital-terrain-model-lidar-derived" target="_blank" rel="noopener">Ontario GeoHub</a> or <a href="https://open.canada.ca/data/en/dataset/957782bf-847c-4644-a757-e383c0057995" target="_blank" rel="noopener">NRCan HRDEM</a>, then use “Load GeoTIFF”.`; }
}
/* projections for local GeoTIFFs */
function lccFns() { // EPSG:3979 NAD83(CSRS) / Canada Atlas Lambert
  const a = 6378137, f = 1 / 298.257222101, e = Math.sqrt(f * (2 - f)), R = Math.PI / 180;
  const p1 = 49 * R, p2 = 77 * R, p0 = 49 * R, l0 = -95 * R;
  const m = p => Math.cos(p) / Math.sqrt(1 - e * e * Math.sin(p) ** 2);
  const t = p => Math.tan(Math.PI / 4 - p / 2) / Math.pow((1 - e * Math.sin(p)) / (1 + e * Math.sin(p)), e / 2);
  const n = (Math.log(m(p1)) - Math.log(m(p2))) / (Math.log(t(p1)) - Math.log(t(p2))), F = m(p1) / (n * Math.pow(t(p1), n)), r0 = a * F * Math.pow(t(p0), n);
  return {
    fwd(lat, lng) { const r = a * F * Math.pow(t(lat * R), n), th = n * (lng * R - l0); return [r * Math.sin(th), r0 - r * Math.cos(th)]; },
    inv(x, y) {
      const r = Math.sign(n) * Math.hypot(x, r0 - y), th = Math.atan2(x, r0 - y), tt = Math.pow(r / (a * F), 1 / n);
      let p = Math.PI / 2 - 2 * Math.atan(tt);
      for (let k = 0; k < 8; k++) p = Math.PI / 2 - 2 * Math.atan(tt * Math.pow((1 - e * Math.sin(p)) / (1 + e * Math.sin(p)), e / 2));
      return [p / R, (th / n + l0) / R];
    }
  };
}
function crsFor(epsg) {
  let zone = null;
  if (epsg >= 26901 && epsg <= 26923) zone = epsg - 26900;
  else if (epsg >= 32601 && epsg <= 32660) zone = epsg - 32600;
  else if ({ 2955: 11, 2956: 12, 2957: 13, 2958: 17, 2959: 18, 2960: 19, 2961: 20, 2962: 21, 3158: 14, 3159: 15, 3160: 16 }[epsg]) zone = { 2955: 11, 2956: 12, 2957: 13, 2958: 17, 2959: 18, 2960: 19, 2961: 20, 2962: 21, 3158: 14, 3159: 15, 3160: 16 }[epsg];
  if (zone) return { name: `UTM ${zone}N`, fwd: (la, lo) => NB.toUTM(la, lo, zone), inv: (x, y) => NB.fromUTM(x, y, zone) };
  if (epsg === 3857 || epsg === 900913) return { name: 'Web Mercator', fwd: (la, lo) => NB.merc(la, lo), inv: (x, y) => NB.unmerc(x, y) };
  if (epsg === 4326 || epsg === 4269 || epsg === 4617) return { name: 'Geographic', fwd: (la, lo) => [lo, la], inv: (x, y) => [y, x] };
  if (epsg === 3979) { const L2 = lccFns(); return { name: 'Canada Atlas Lambert', fwd: L2.fwd, inv: L2.inv }; }
  return null;
}
async function loadLocalDEM(file) {
  const st = $('#demStatus'); st.textContent = 'Reading ' + file.name + '…';
  try {
    const GT = await loadGeoTIFF(), tiff = await GT.fromArrayBuffer(await file.arrayBuffer()), img = await tiff.getImage();
    const keys = img.getGeoKeys() || {}, epsg = keys.ProjectedCSTypeGeoKey || keys.GeographicTypeGeoKey;
    const crs = crsFor(epsg);
    if (!crs) throw new Error(`Unsupported coordinate system (EPSG ${epsg || 'unknown'}). Use UTM, Lambert 3979, Web Mercator or geographic.`);
    const W = img.getWidth(), H = img.getHeight(), [ox, oy] = img.getOrigin(), [rx, ry] = img.getResolution();
    const nd = img.getGDALNoData();
    // raster extent in lat/lng
    const corners = [[ox, oy], [ox + W * rx, oy], [ox, oy + H * ry], [ox + W * rx, oy + H * ry]].map(([x, y]) => crs.inv(x, y));
    const lats = corners.map(c => c[0]), lngs = corners.map(c => c[1]);
    let bb = [Math.min(...lats), Math.min(...lngs), Math.max(...lats), Math.max(...lngs)];
    const vb = map.getBounds();
    const inter = [Math.max(bb[0], vb.getSouth()), Math.max(bb[1], vb.getWest()), Math.min(bb[2], vb.getNorth()), Math.min(bb[3], vb.getEast())];
    if (inter[0] < inter[2] && inter[1] < inter[3]) bb = inter; else { map.fitBounds([[bb[0], bb[1]], [bb[2], bb[3]]]); }
    // read window covering bb
    const pc = bb => [[bb[0], bb[1]], [bb[0], bb[3]], [bb[2], bb[1]], [bb[2], bb[3]]].map(([la, lo]) => crs.fwd(la, lo));
    const pp = pc(bb), cs = pp.map(p => (p[0] - ox) / rx), rs = pp.map(p => (p[1] - oy) / ry);
    const c0 = Math.max(0, Math.floor(Math.min(...cs)) - 2), c1 = Math.min(W, Math.ceil(Math.max(...cs)) + 2);
    const r0 = Math.max(0, Math.floor(Math.min(...rs)) - 2), r1 = Math.min(H, Math.ceil(Math.max(...rs)) + 2);
    const ww = c1 - c0, hh = r1 - r0, sc = Math.max(1, Math.max(ww, hh) / 1400);
    const ow = Math.max(2, Math.round(ww / sc)), oh = Math.max(2, Math.round(hh / sc));
    const ras = await img.readRasters({ window: [c0, r0, c1, r1], width: ow, height: oh, interleave: true });
    const prx = rx * ww / ow, pry = ry * hh / oh, gox = ox + c0 * rx, goy = oy + r0 * ry;
    const sample = (lat, lng) => {
      const [x, y] = crs.fwd(lat, lng), c = (x - gox) / prx - 0.5, r = (y - goy) / pry - 0.5;
      const ci = Math.round(c), ri = Math.round(r);
      if (ci < 0 || ri < 0 || ci >= ow || ri >= oh) return NaN;
      const v = ras[ri * ow + ci];
      return (nd !== null && v === nd) || !(v > -1000 && v < 5000) ? NaN : v;
    };
    const groundRes = Math.abs(crs.name === 'Geographic' ? prx * 111320 * Math.cos((bb[0] + bb[2]) / 2 * Math.PI / 180) : prx);
    const g = NB.resampleTo3857(bb, sample, Math.max(0.5, groundRes), 1100, file.name);
    g.quality = groundRes <= 3 ? 'lidar' : 'coarse';
    setGrid(g);
  } catch (e) { st.textContent = 'Could not read DEM: ' + e.message; }
}
function setGrid(g) {
  S.grid = g; S.A = null; S.shed = null;
  let mn = Infinity, mx = -Infinity, nv = 0; for (const v of g.z) if (!Number.isNaN(v)) { nv++; if (v < mn) mn = v; if (v > mx) mx = v; }
  $('#demStatus').innerHTML = `<b>${esc(g.src)}</b>: ${g.w}×${g.h} cells at ${g.cell.toFixed(2)} m · elevation ${mn.toFixed(1)}–${mx.toFixed(1)} m. <span class="muted">Rim elevations now come from this grid inside its area.</span>`;
  $('#demTools').style.display = 'block';
  setTimeout(() => { S.A = NB.analyse(g); renderDem(); }, 30);
  renderDem();
}
function demCanvas(fn) {
  const g = S.grid, cv = document.createElement('canvas'); cv.width = g.w; cv.height = g.h;
  const ctx = cv.getContext('2d'), im = ctx.createImageData(g.w, g.h); fn(im.data); ctx.putImageData(im, 0, 0);
  return cv.toDataURL('image/png');
}
function ramp(t) { // low teal -> green -> sand -> brown
  const st = [[0, [32, 110, 140]], [0.3, [96, 160, 110]], [0.6, [222, 205, 140]], [0.85, [176, 120, 72]], [1, [120, 80, 60]]];
  t = Math.max(0, Math.min(1, t)); let i = 0; while (i < st.length - 2 && t > st[i + 1][0]) i++;
  const [a, ca] = st[i], [b, cb] = st[i + 1], u = (t - a) / (b - a); return ca.map((v, k) => v + (cb[k] - v) * u);
}
function flowThreshold() { const v = +$('#flowThr').value; return Math.round(20 * Math.pow(10, v / 100 * 3.3)); } // m²
function sinkDepth() { return +$('#sinkDep').value / 100; }
function renderDem() {
  const g = S.grid; Object.values(S.demLayers).forEach(l => map.removeLayer(l)); S.demLayers = {};
  if (!g) return;
  const bounds = NB.gridBounds(g), op = $('#demOpacity').value / 100;
  $('#flowThrV').textContent = flowThreshold() >= 10000 ? (flowThreshold() / 10000).toFixed(2) + ' ha' : flowThreshold() + ' m²';
  $('#sinkDepV').textContent = (sinkDepth() * 100).toFixed(0) + ' cm';
  if (S.demOn.relief) {
    const hs = NB.hillshade(g, +$('#zfac').value), lo = NB.percentile(g.z, 0.02), hi = NB.percentile(g.z, 0.98), ci = +$('#contourCi').value;
    const url = demCanvas(d => {
      for (let r = 0; r < g.h; r++) for (let c = 0; c < g.w; c++) {
        const i = r * g.w + c, z = g.z[i], o = i * 4; if (Number.isNaN(z)) { d[o + 3] = 0; continue; }
        const col = ramp((z - lo) / (hi - lo || 1)), s = Number.isNaN(hs[i]) ? 0.8 : 0.45 + 0.6 * hs[i];
        let R = col[0] * s, G = col[1] * s, B = col[2] * s;
        if (ci > 0 && c < g.w - 1 && r < g.h - 1) {
          const k = Math.floor(z / ci), zr = g.z[i + 1], zd = g.z[i + g.w];
          if ((!Number.isNaN(zr) && Math.floor(zr / ci) !== k) || (!Number.isNaN(zd) && Math.floor(zd / ci) !== k)) {
            const major = Math.floor(Math.max(z, zr || z, zd || z) / ci) % 5 === 0; const m = major ? 0.25 : 0.55; R *= m; G *= m; B *= m;
          }
        }
        d[o] = R; d[o + 1] = G; d[o + 2] = B; d[o + 3] = 255;
      }
    });
    S.demLayers.relief = L.imageOverlay(url, bounds, { pane: 'analysis', opacity: op, className: 'analysis-img' }).addTo(map);
  }
  if (!S.A) { $('#demStatus').insertAdjacentHTML('beforeend', ' <span class="muted" id="anaWait">Analysing drainage…</span>'); return; }
  $('#anaWait')?.remove();
  if (S.demOn.flow) {
    const thr = flowThreshold() / (g.cell * g.cell), acc = S.A.acc;
    const url = demCanvas(d => {
      for (let i = 0; i < g.w * g.h; i++) {
        const a = acc[i]; if (a < thr) continue; const t = Math.min(1, Math.log(a / thr) / Math.log(400));
        const o = i * 4; d[o] = 20; d[o + 1] = 90 + 120 * t; d[o + 2] = 255; d[o + 3] = 150 + 105 * t;
      }
    });
    S.demLayers.flow = L.imageOverlay(url, bounds, { pane: 'analysis', opacity: 1, className: 'analysis-img' }).addTo(map);
  }
  if (S.demOn.sinks) {
    const list = NB.sinks(g, S.A, sinkDepth(), 3).slice(0, 250), grp = L.layerGroup();
    list.forEach((s, k) => {
      const ll = NB.gridLatLng(g, s.c, s.r);
      const m = L.circleMarker(ll, { pane: 'clues', radius: Math.min(14, 4 + Math.sqrt(s.area) / 2), color: '#d9480f', weight: 2, fillColor: '#ff922b', fillOpacity: 0.35 });
      m.bindPopup(() => `<div class="pop"><h4>Low spot #${k + 1}</h4><div class="kv"><span>Depth</span><span>${(s.depth * 100).toFixed(0)} cm</span><span>Area</span><span>${s.area.toFixed(0)} m²</span><span>Volume</span><span>${s.vol.toFixed(1)} m³</span><span>Ground</span><span>${fmt(g.z[s.low])} m</span></div>
        <p class="muted" style="margin:6px 0">On a road this is a likely catch basin; in a yard, a rear-yard CB or ponding area.</p>
        <button class="btn sm" onclick="APP.addNodeAt('cb','storm',${ll[0]},${ll[1]})">Add catch basin here</button>${linksHTML(ll[0], ll[1])}</div>`);
      grp.addLayer(m);
    });
    S.demLayers.sinks = grp.addTo(map);
    $('#demStatus').querySelector('.sinkn')?.remove();
    $('#demStatus').insertAdjacentHTML('beforeend', `<div class="sinkn muted">${list.length} low spot(s) ≥ ${(sinkDepth() * 100).toFixed(0)} cm shown.</div>`);
  }
  if (S.shed) drawShed();
}
$$('[data-dl]').forEach(ch => ch.addEventListener('click', () => { ch.classList.toggle('on'); S.demOn[ch.dataset.dl] = ch.classList.contains('on'); renderDem(); }));
['contourCi', 'zfac'].forEach(id => $('#' + id).addEventListener('change', renderDem));
['flowThr', 'sinkDep'].forEach(id => $('#' + id).addEventListener('input', debounce(renderDem, 250)));
$('#demOpacity').addEventListener('input', e => { if (S.demLayers.relief) S.demLayers.relief.setOpacity(e.target.value / 100); });
$('#fetchDem').addEventListener('click', fetchViewDEM);
$('#demFile').addEventListener('change', e => { if (e.target.files[0]) loadLocalDEM(e.target.files[0]); e.target.value = ''; });
$('#clearDem').addEventListener('click', () => { S.grid = null; S.A = null; S.shed = null; renderDem(); drawShed(); $('#demTools').style.display = 'none'; $('#demStatus').textContent = ''; });

/* ---------- catchment from a point ---------- */
let shedLayer = null;
function runShed(ll) {
  const g = S.grid; if (!g || !S.A) { toast('Analyse the terrain first (Terrain tab).', { err: true }); return; }
  const [x, y] = NB.gridPx(g, ll.lat, ll.lng), c = Math.round(x), r = Math.round(y);
  if (c < 0 || r < 0 || c >= g.w || r >= g.h) { toast('That point is outside the analysed area.', { err: true }); return; }
  const ws = NB.watershed(g, S.A, c, r, Math.max(2, Math.round(3 / g.cell)));
  if (!ws || ws.cells < 3) { toast('No upstream area found there.'); return; }
  const oc = ws.outlet % g.w, orr = Math.floor(ws.outlet / g.w);
  S.shed = Object.assign(ws, { outLL: NB.gridLatLng(g, oc, orr), ringLL: ws.ring.map(([cc, rr]) => NB.gridLatLng(g, cc, rr)) });
  drawShed(); showPanelTab('terrain');
}
function drawShed() {
  if (shedLayer) { map.removeLayer(shedLayer); shedLayer = null; }
  const box = $('#shedCard'); if (!S.shed) { box.innerHTML = ''; return; }
  const s = S.shed, ha = s.area / 10000, W = s.area / Math.max(5, s.meanLen);
  shedLayer = L.layerGroup([L.polygon(s.ringLL, { pane: 'temp', color: '#7048e8', weight: 2, fillOpacity: 0.12, dashArray: '5 4', interactive: false }),
    L.circleMarker(s.outLL, { pane: 'temp', radius: 5, color: '#7048e8', fillOpacity: 1, interactive: false })]).addTo(map);
  box.innerHTML = `<div class="card" style="margin:10px 0 0;border-color:#cfc4f7"><h3>Surface catchment</h3>
    <div class="kv"><span>Area</span><span>${ha.toFixed(3)} ha</span><span>Mean slope</span><span>${fmt(s.slope, 2)} %</span><span>Mean flow path</span><span>${s.meanLen.toFixed(0)} m</span><span>Longest path</span><span>${s.maxLen.toFixed(0)} m</span><span>Width (A / mean path)</span><span>${W.toFixed(0)} m</span></div>
    <p class="muted" style="margin:6px 0">Bare-earth surface drainage only — curbs, buildings and pipes are not in the terrain, so check the boundary against the imagery.</p>
    <div class="row"><button class="btn sm primary" id="shedMake">Create storm subcatchment</button><button class="btn sm" id="shedDrop">Discard</button></div></div>`;
  $('#shedMake').onclick = () => {
    const out = nearestNode(s.outLL, 'storm', 40);
    APP.createSub('storm', s.ringLL, { area: +ha.toFixed(4), slope: s.slope !== null ? +s.slope.toFixed(2) : '', width: Math.round(W), outlet: out ? out.id : '', notes: `From lidar catchment (${S.grid.src})` });
    S.shed = null; drawShed();
  };
  $('#shedDrop').onclick = () => { S.shed = null; drawShed(); };
}

/* ---------- profile ---------- */
async function runProfile(pts) {
  const out = $('#profileOut'); out.innerHTML = '<span class="muted">Sampling elevations…</span>'; showPanelTab('terrain');
  const total = NB.pathLength(pts), n = Math.min(120, Math.max(20, Math.round(total / 3)));
  const cum = [0]; for (let i = 1; i < pts.length; i++) cum.push(cum[i - 1] + NB.dist(pts[i - 1], pts[i]));
  const samp = [];
  for (let k = 0; k <= n; k++) {
    const d = total * k / n; let i = 1; while (i < pts.length - 1 && cum[i] < d) i++;
    const t = (d - cum[i - 1]) / ((cum[i] - cum[i - 1]) || 1);
    samp.push({ d, ll: [pts[i - 1][0] + (pts[i][0] - pts[i - 1][0]) * t, pts[i - 1][1] + (pts[i][1] - pts[i - 1][1]) * t] });
  }
  let el = await getElevations(samp.map(s => s.ll));
  if (el.filter(Boolean).length < samp.length * 0.5) {
    try { const la = samp.map(s => s.ll[0].toFixed(6)).join(','), lo = samp.map(s => s.ll[1].toFixed(6)).join(','); const j = await fetchJSON(`${EP.openMeteo}?latitude=${la}&longitude=${lo}`, 15000); el = j.elevation.map(z => ({ z, src: 'Copernicus 90 m (coarse)' })); } catch { /* keep */ }
  }
  const data = samp.map((s, k) => ({ d: s.d, z: el[k] ? el[k].z : null, ll: s.ll })).filter(p => p.z !== null);
  if (data.length < 2) { out.innerHTML = '<span class="muted">No elevations available here.</span>'; return; }
  const src = (el.find(Boolean) || {}).src || '';
  out.innerHTML = `<canvas class="chart" id="profCv"></canvas><div class="muted" id="profInfo" style="margin-top:4px"></div>`;
  drawProfile($('#profCv'), data);
  const z0 = data[0].z, z1 = data[data.length - 1].z;
  let lo = data[0]; data.forEach(p => { if (p.z < lo.z) lo = p; });
  $('#profInfo').innerHTML = `${total.toFixed(0)} m · start ${z0.toFixed(2)} m → end ${z1.toFixed(2)} m · average grade ${((z1 - z0) / total * 100).toFixed(2)} % · lowest ${lo.z.toFixed(2)} m at ${lo.d.toFixed(0)} m <a href="#" id="profLow">show</a> · source: ${esc(src)}`;
  $('#profLow').onclick = e => { e.preventDefault(); map.setView(lo.ll, Math.max(map.getZoom(), 18)); L.popup().setLatLng(lo.ll).setContent(`<div class="pop"><h4>Profile low point</h4>${lo.z.toFixed(2)} m${linksHTML(lo.ll[0], lo.ll[1])}</div>`).openOn(map); };
}
function drawProfile(cv, data) {
  const dpr = window.devicePixelRatio || 1, W = cv.clientWidth, H = cv.clientHeight; cv.width = W * dpr; cv.height = H * dpr;
  const c = cv.getContext('2d'); c.scale(dpr, dpr);
  const pad = { l: 44, r: 8, t: 10, b: 20 }, zs = data.map(p => p.z), mn = Math.min(...zs), mx = Math.max(...zs), sp = Math.max(0.5, mx - mn);
  const X = d => pad.l + d / data[data.length - 1].d * (W - pad.l - pad.r), Y = z => pad.t + (1 - (z - mn + sp * 0.08) / (sp * 1.16)) * (H - pad.t - pad.b);
  c.font = '10px IBM Plex Mono, monospace'; c.fillStyle = '#7b838d'; c.strokeStyle = '#eee8dc';
  for (let k = 0; k <= 4; k++) { const z = mn - sp * 0.08 + sp * 1.16 * k / 4; c.beginPath(); c.moveTo(pad.l, Y(z)); c.lineTo(W - pad.r, Y(z)); c.stroke(); c.fillText(z.toFixed(1), 2, Y(z) + 3); }
  c.fillText('0', pad.l, H - 5); const L1 = data[data.length - 1].d; c.fillText(L1.toFixed(0) + ' m', W - pad.r - 40, H - 5);
  c.beginPath(); data.forEach((p, i) => i ? c.lineTo(X(p.d), Y(p.z)) : c.moveTo(X(p.d), Y(p.z)));
  c.lineTo(X(L1), H - pad.b); c.lineTo(X(0), H - pad.b); c.closePath(); c.fillStyle = 'rgba(176,120,72,.18)'; c.fill();
  c.beginPath(); data.forEach((p, i) => i ? c.lineTo(X(p.d), Y(p.z)) : c.moveTo(X(p.d), Y(p.z))); c.strokeStyle = '#8a5a2b'; c.lineWidth = 1.6; c.stroke();
}
