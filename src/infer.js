/* ===================================================================
   North Bay Sewer Mapper — automatic network inference (no DOM)
   Street graph from OSM -> gravity routing over lidar -> design-flow
   sizing (City of North Bay criteria) -> inverts -> subcatchments,
   with a probability / spread attached to every inferred attribute.
   =================================================================== */
const NBI = (function () {
  'use strict';
  const NUM = v => (v === '' || v === null || v === undefined || !isFinite(+v)) ? null : +v;
  const DIAMS = [200, 250, 300, 375, 450, 525, 600, 675, 750, 825, 900, 975, 1050, 1200, 1350, 1500, 1650, 1800, 2100, 2400, 2700, 3000];
  const sig = x => 1 / (1 + Math.exp(-x));
  const clamp = (v, a, b) => Math.max(a, Math.min(b, v));

  const DEFAULTS = {
    maxSpacing: 110,          // m between manholes (City max 120 m)
    pph: 2.24,                // persons per occupied dwelling, North Bay 2021 (52,662 / 23,467)
    iciLpsPerHa: 0.32,        // ICI sanitary flow per gross ha (assumption, editable)
    iciGrossFactor: 3,        // gross site area ≈ 3 × building footprint (assumption)
    inletTime: 10,            // min, rational method
    stormRp: '5',             // City design storm for minor system
    unmappedImp: 0.08,        // driveways/patios not in OSM, fraction of pervious area
    coverStorm: 1.5,          // City minimum cover, storm (m)
    coverSan: 1.8,            // City minimum cover, sanitary (m)
    sanDepth: 2.7,            // typical sanitary invert depth to serve basements (assumption, calibrate)
    perCap: 450,              // L/cap/d, City design flow
    iiRate: 0.44,             // L/s/ha, City allowance for areas > 20 years old
    extraCover: 0,            // calibration: added to assumed invert depth (m)
    sizeBias: 0,              // calibration: standard-size steps added to design size
    outfallPenalty: 150,      // m-equivalent cost to open an outfall
    boundaryPenalty: 400,     // m-equivalent cost to leave the study area
    adversePenalty: 400,      // m-equivalent cost per m of uphill
    ditchDrop: 0.35,          // m below road edge to call a roadside ditch
    waterDist: 70,            // m from a road vertex to water to allow a storm outfall
    serviceDist: 80           // m from a building to its street sewer
  };

  /* ---------- local metric projection ---------- */
  function proj(lat0, lng0) {
    const k = 111320, c = Math.cos(lat0 * Math.PI / 180);
    return { f: (lat, lng) => [(lng - lng0) * k * c, (lat - lat0) * k], i: (x, y) => [lat0 + y / k, lng0 + x / (k * c)] };
  }
  function segDist(px, py, ax, ay, bx, by) {
    const dx = bx - ax, dy = by - ay, L2 = dx * dx + dy * dy;
    let t = L2 ? ((px - ax) * dx + (py - ay) * dy) / L2 : 0; t = clamp(t, 0, 1);
    const x = ax + t * dx, y = ay + t * dy; return [Math.hypot(px - x, py - y), t];
  }
  class Grid { // bucket index of segments/points in metric coords
    constructor(cell) { this.c = cell; this.m = new Map(); }
    key(i, j) { return i * 100003 + j; }
    addSeg(ax, ay, bx, by, item) {
      const c = this.c, i0 = Math.floor(Math.min(ax, bx) / c), i1 = Math.floor(Math.max(ax, bx) / c), j0 = Math.floor(Math.min(ay, by) / c), j1 = Math.floor(Math.max(ay, by) / c);
      for (let i = i0; i <= i1; i++) for (let j = j0; j <= j1; j++) { const k = this.key(i, j); if (!this.m.has(k)) this.m.set(k, []); this.m.get(k).push(item); }
    }
    near(x, y, r) {
      const c = this.c, out = new Set();
      for (let i = Math.floor((x - r) / c); i <= Math.floor((x + r) / c); i++) for (let j = Math.floor((y - r) / c); j <= Math.floor((y + r) / c); j++) { const a = this.m.get(this.key(i, j)); if (a) a.forEach(v => out.add(v)); }
      return out;
    }
  }
  function polyArea(xy) { let s = 0; for (let i = 0; i < xy.length; i++) { const a = xy[i], b = xy[(i + 1) % xy.length]; s += a[0] * b[1] - b[0] * a[1]; } return Math.abs(s) / 2; }
  function pip(x, y, xy) { let c = false; for (let i = 0, j = xy.length - 1; i < xy.length; j = i++) { const [xi, yi] = xy[i], [xj, yj] = xy[j]; if (((yi > y) !== (yj > y)) && (x < (xj - xi) * (y - yi) / (yj - yi) + xi)) c = !c; } return c; }

  /* ---------- road selection ---------- */
  const ROAD_W = { motorway: 0, trunk: 14, primary: 13, secondary: 12, tertiary: 10, unclassified: 8, residential: 8, living_street: 7, service: 5, pedestrian: 6 };
  function roadClass(t) {
    let h = t.highway || ''; h = h.replace(/_link$/, '');
    if (!(h in ROAD_W) || h === 'motorway') return null;
    if (h === 'service' && !(t.service === 'alley' || (t.name && !t.service))) return null;
    if (h === 'pedestrian' && !t.name) return null;
    if (t.area === 'yes' || t.construction || t.proposed) return null;
    return h;
  }

  /* ---------- building -> dwellings / ICI ---------- */
  const NONRES = /^(commercial|retail|industrial|office|warehouse|school|university|college|hospital|church|chapel|civic|public|government|supermarket|hotel|fire_station|sports_centre|kindergarten|train_station|transportation|manufacture|service)$/;
  const NOFLOW = /^(garage|garages|shed|carport|roof|hut|cabin|greenhouse|kiosk|ruins|construction|storage_tank|container|bunker|tent|boathouse|shelter)$/;
  function classifyBuilding(t, area) {
    const b = t.building || 'yes', lv = NUM(t['building:levels']) || null;
    if (NOFLOW.test(b) || area < 35) return { dw: 0, ici: 0, kind: 'none' };
    if (t.amenity || t.shop || t.office || t.craft || NONRES.test(b)) return { dw: 0, ici: area, kind: 'ici' };
    if (b === 'house' || b === 'detached' || b === 'bungalow' || b === 'farm') return { dw: 1, ici: 0, kind: 'res' };
    if (b === 'semidetached_house') return { dw: area > 160 ? 2 : 1, ici: 0, kind: 'res' };
    if (b === 'terrace') return { dw: Math.max(2, Math.round(area / 70)), ici: 0, kind: 'res' };
    if (b === 'apartments' || b === 'dormitory') return { dw: Math.max(2, Math.round(area * (lv || 3) * 0.8 / 85)), ici: 0, kind: 'res' };
    if (b === 'residential' || b === 'yes') {
      if (area <= 320) return { dw: 1, ici: 0, kind: 'res' };
      if (b === 'residential' || lv) return { dw: Math.max(2, Math.round(area * (lv || 2) * 0.8 / 85)), ici: 0, kind: 'res' };
      return { dw: 0, ici: area, kind: 'ici' };
    }
    return { dw: 0, ici: area, kind: 'ici' };
  }

  /* ---------- street graph ---------- */
  function buildGraph(roads, bbox, P, maxSpacing) {
    const [s, w, n, e] = bbox, inB = (la, lo) => la >= s && la <= n && lo >= w && lo <= e;
    const use = new Map();
    roads.forEach(r => r.nodes.forEach((id, k) => use.set(id, (use.get(id) || 0) + (k === 0 || k === r.nodes.length - 1 ? 2 : 1))));
    const V = new Map(), E = [];
    const vtx = (id, la, lo) => { if (!V.has(id)) { const [x, y] = P.f(la, lo); V.set(id, { id, lat: la, lng: lo, x, y, adj: [], z: NaN, boundary: !inB(la, lo) }); } return V.get(id); };
    let synth = 0;
    roads.forEach(r => {
      let start = 0;
      for (let k = 1; k < r.nodes.length; k++) {
        if (k < r.nodes.length - 1 && use.get(r.nodes[k]) < 2) continue;
        const pts = r.geom.slice(start, k + 1), ids = r.nodes.slice(start, k + 1); start = k;
        if (!pts.some(p => inB(p[0], p[1]))) continue;
        const xy = pts.map(p => P.f(p[0], p[1])), cum = [0];
        for (let i = 1; i < xy.length; i++) cum.push(cum[i - 1] + Math.hypot(xy[i][0] - xy[i - 1][0], xy[i][1] - xy[i - 1][1]));
        const len = cum[cum.length - 1]; if (len < 1) continue;
        const nPc = Math.ceil(len / maxSpacing);
        let prev = vtx(ids[0], pts[0][0], pts[0][1]);
        for (let q = 1; q <= nPc; q++) {
          const d0 = len * (q - 1) / nPc, d1 = len * q / nPc;
          let nv;
          if (q === nPc) nv = vtx(ids[ids.length - 1], pts[pts.length - 1][0], pts[pts.length - 1][1]);
          else {
            let i = 0; while (i < xy.length - 2 && cum[i + 1] < d1) i++;
            const t = (d1 - cum[i]) / ((cum[i + 1] - cum[i]) || 1), x = xy[i][0] + (xy[i + 1][0] - xy[i][0]) * t, y = xy[i][1] + (xy[i + 1][1] - xy[i][1]) * t;
            const [la, lo] = P.i(x, y); nv = vtx('s' + (synth++), la, lo);
          }
          const inner = []; for (let i = 1; i < pts.length - 1; i++) if (cum[i] > d0 + 0.5 && cum[i] < d1 - 0.5) inner.push(pts[i]);
          const geom = [[prev.lat, prev.lng], ...inner, [nv.lat, nv.lng]];
          const ed = { id: E.length, key: `${r.id}:${ids[0]}:${q}`, a: prev.id, b: nv.id, len: d1 - d0, cls: r.cls, name: r.name || '', geom, way: r.id };
          if (ed.a !== ed.b) { E.push(ed); prev.adj.push(ed.id); nv.adj.push(ed.id); }
          prev = nv;
        }
      }
    });
    return { V, E };
  }

  /* ---------- lidar cross-sections: roadside ditches ---------- */
  function ditchScan(ed, V, P, zAt) {
    const a = V.get(ed.a), b = V.get(ed.b), ax = a.x, ay = a.y, bx = b.x, by = b.y, L = Math.hypot(bx - ax, by - ay);
    if (L < 30) return null;
    const ux = (bx - ax) / L, uy = (by - ay) / L, nx = -uy, ny = ux, st = [];
    for (let s = 12; s <= L - 12; s += 10) {
      const cx = ax + ux * s, cy = ay + uy * s, Z = o => { const [la, lo] = P.i(cx + nx * o, cy + ny * o); return zAt(la, lo); };
      const z0 = [Z(-1), Z(0), Z(1)].filter(isFinite).sort((p, q) => p - q)[1] ?? Z(0);
      if (!isFinite(z0)) continue;
      const side = sgn => { let mn = Infinity, mo = 0; for (let o = 4; o <= 14; o++) { const z = Z(sgn * o); if (z < mn) { mn = z; mo = o; } } const far = Z(sgn * 17); return { drop: z0 - mn, rises: isFinite(far) && far > mn + 0.1, mo, mn }; };
      const l = side(-1), r = side(1);
      const isD = s2 => s2.drop > 0 && s2.rises;
      st.push({ s, z0, l, r, ditchL: isD(l), ditchR: isD(r) });
    }
    if (!st.length) return null;
    return { st, L };
  }

  /* ---------- Dijkstra routing toward outlets ---------- */
  function route(G, edgesOK, outlets, S) {
    const { V, E } = G, dist = new Map(), down = new Map(), smin = 0.002;
    const heap = []; const push = (d, id) => { heap.push([d, id]); let i = heap.length - 1; while (i > 0) { const p = (i - 1) >> 1; if (heap[p][0] <= heap[i][0]) break; [heap[p], heap[i]] = [heap[i], heap[p]]; i = p; } };
    const pop = () => { const top = heap[0], last = heap.pop(); if (heap.length) { heap[0] = last; let i = 0; for (;;) { let c = 2 * i + 1; if (c >= heap.length) break; if (c + 1 < heap.length && heap[c + 1][0] < heap[c][0]) c++; if (heap[c][0] >= heap[i][0]) break; [heap[c], heap[i]] = [heap[i], heap[c]]; i = c; } } return top; };
    outlets.forEach(([id, pen]) => { if (!dist.has(id) || dist.get(id) > pen) { dist.set(id, pen); push(pen, id); } });
    const done = new Set();
    while (heap.length) {
      const [d, v] = pop(); if (done.has(v)) continue; done.add(v);
      const vv = V.get(v);
      vv.adj.forEach(eid => {
        const e = E[eid], u = e.a === v ? e.b : e.a, uu = V.get(u);
        if (!edgesOK(eid, u, v)) return; // flow would run u -> v
        const rise = (isFinite(vv.z) && isFinite(uu.z)) ? (vv.z - uu.z) + smin * e.len : 0;
        const c = d + e.len + S.adversePenalty * Math.max(0, rise);
        if (!dist.has(u) || c < dist.get(u)) { dist.set(u, c); down.set(u, { v, e: eid }); push(c, u); }
      });
    }
    return { dist, down };
  }

  /* ---------- main ---------- */
  function infer(inp, settings) {
    const S = Object.assign({}, DEFAULTS, settings || {});
    const [s, w, n, e] = inp.bbox, P = proj((s + n) / 2, (w + e) / 2), zAt = inp.zAt || (() => NaN);
    const coarse = inp.demQuality !== 'lidar', hasDem = inp.demQuality && inp.demQuality !== 'none';
    const log = [];
    // roads
    const roads = (inp.roads || []).map(r => ({ ...r, cls: roadClass(r.tags || {}) })).filter(r => r.cls && r.nodes && r.geom && r.nodes.length === r.geom.length && r.nodes.length > 1);
    const G = buildGraph(roads, inp.bbox, P, S.maxSpacing);
    G.V.forEach(v => { v.z = zAt(v.lat, v.lng); });
    log.push(`${roads.length} road ways → ${G.V.size} vertices, ${G.E.length} segments`);
    // segment index
    const segIdx = new Grid(60);
    G.E.forEach(ed => { const xy = ed.geom.map(p => P.f(p[0], p[1])); ed.xy = xy; for (let i = 1; i < xy.length; i++) segIdx.addSeg(xy[i - 1][0], xy[i - 1][1], xy[i][0], xy[i][1], ed.id); });
    const nearestEdge = (x, y, r, filt) => { let best = -1, bd = r; segIdx.near(x, y, r).forEach(id => { if (filt && !filt(id)) return; const xy = G.E[id].xy; for (let i = 1; i < xy.length; i++) { const [d] = segDist(x, y, xy[i - 1][0], xy[i - 1][1], xy[i][0], xy[i][1]); if (d < bd) { bd = d; best = id; } } }); return [best, bd]; };
    // buildings -> nearest street
    G.E.forEach(ed => { ed.bldg = 0; ed.dw = 0; ed.ici = 0; ed.front = 0; });
    const B = (inp.buildings || []).map(b => { const xy = b.geom.map(p => P.f(p[0], p[1])); const area = polyArea(xy); const cx = xy.reduce((a, p) => a + p[0], 0) / xy.length, cy = xy.reduce((a, p) => a + p[1], 0) / xy.length; return { xy, area, cx, cy, cls: classifyBuilding(b.tags || {}, area) }; });
    let totDw = 0;
    B.forEach(b => {
      if (b.cls.kind === 'none') return;
      const [eid] = nearestEdge(b.cx, b.cy, S.serviceDist); if (eid < 0) return;
      const ed = G.E[eid]; ed.bldg++; ed.dw += b.cls.dw; ed.ici += b.cls.ici; totDw += b.cls.dw;
    });
    log.push(`${B.length} buildings, ≈${totDw} dwellings (≈${Math.round(totDw * S.pph)} people)`);
    // lidar ditch detection
    let nDitch = 0;
    G.E.forEach(ed => {
      ed.frontDensity = ed.bldg / Math.max(ed.len, 20) * 100; // buildings per 100 m of street
      ed.ditch = 0; ed.ditchInfo = null;
      if (hasDem && !coarse) {
        const sc = ditchScan(ed, G.V, P, zAt);
        if (sc) {
          const f = sc.st.filter(x => (x.ditchL && x.l.drop > S.ditchDrop) || (x.ditchR && x.r.drop > S.ditchDrop)).length / sc.st.length;
          ed.ditch = f; ed.ditchInfo = sc; if (f > 0.5) nDitch++;
        }
      }
    });
    if (hasDem && !coarse) log.push(`${nDitch} segments with roadside ditches (rural cross-section)`);
    // presence probabilities
    G.E.forEach(ed => {
      const urban = sig((ed.frontDensity - 1.5) / 0.8);
      const arterial = /primary|secondary|tertiary/.test(ed.cls) ? 0.15 : 0;
      ed.pSan = clamp(0.08 + 0.9 * sig((ed.bldg - 0.5) / 0.35), 0.05, 0.97);
      if (hasDem && !coarse) ed.pStorm = clamp((0.25 + 0.7 * Math.max(urban, arterial * 3)) * (1 - 0.85 * ed.ditch), 0.05, 0.95);
      else ed.pStorm = clamp(0.3 + 0.55 * Math.max(urban, arterial * 3), 0.1, 0.85);
    });
    // outlets
    const water = (inp.waters || []).map(l => l.map(p => P.f(p[0], p[1])));
    const wIdx = new Grid(80); water.forEach((l, k) => { for (let i = 1; i < l.length; i++) wIdx.addSeg(l[i - 1][0], l[i - 1][1], l[i][0], l[i][1], k * 100000 + i); });
    const waterDist = (x, y, r) => { let bd = Infinity; wIdx.near(x, y, r).forEach(code => { const l = water[Math.floor(code / 100000)], i = code % 100000; const [d] = segDist(x, y, l[i - 1][0], l[i - 1][1], l[i][0], l[i][1]); if (d < bd) bd = d; }); return bd; };
    const stormOut = [], sanOut = [];
    G.V.forEach(v => {
      v.wd = waterDist(v.x, v.y, S.waterDist);
      if (v.wd < S.waterDist) stormOut.push([v.id, S.outfallPenalty * 0.5 + v.wd]);
      if (v.boundary) { stormOut.push([v.id, S.boundaryPenalty]); sanOut.push([v.id, S.boundaryPenalty]); }
    });
    const plants = (inp.plants || []).map(p => ({ ...p, xy: P.f(p.lat, p.lng) }));
    const plantV = [];
    plants.forEach(p => {
      let best = null, bd = 400; G.V.forEach(v => { const d = Math.hypot(v.x - p.xy[0], v.y - p.xy[1]); if (d < bd) { bd = d; best = v; } });
      if (best) { sanOut.push([best.id, 0]); plantV.push({ v: best.id, kind: p.kind, name: p.name || '' }); }
    });
    // ensure every connected component has an outlet: add its lowest vertex
    const comp = new Map(); let nc = 0;
    G.V.forEach(v => { if (comp.has(v.id)) return; const q = [v.id]; comp.set(v.id, nc); while (q.length) { const id = q.pop(); G.V.get(id).adj.forEach(eid => { const ed = G.E[eid], u = ed.a === id ? ed.b : ed.a; if (!comp.has(u)) { comp.set(u, nc); q.push(u); } }); } nc++; });
    const lowest = new Map(); G.V.forEach(v => { const c = comp.get(v.id), z = isFinite(v.z) ? v.z : 0; if (!lowest.has(c) || z < lowest.get(c)[1]) lowest.set(c, [v.id, z]); });
    lowest.forEach(([id]) => { stormOut.push([id, S.boundaryPenalty * 2]); sanOut.push([id, S.boundaryPenalty * 2]); });

    const out = { nodes: [], links: [], subs: [], log, stats: {}, graph: G, proj: P };
    const idf = { '2': [536, 5.7, 0.7440], '5': [747, 5.3, 0.7588], '10': [880, 5.1, 0.7634], '25': [1055, 5.0, 0.7688], '50': [1176, 4.8, 0.7702], '100': [1309, 4.9, 0.7743] }[S.stormRp] || [747, 5.3, 0.7588];
    const nSan = 0.013;
    const qFull = (d, sl) => { const D = d / 1000; return 1000 * Math.PI * D * D / 4 * Math.pow(D / 4, 2 / 3) * Math.sqrt(Math.max(sl, 1e-5)) / nSan; };
    const minS = d => Math.pow(0.6 * nSan / Math.pow(d / 4000, 2 / 3), 2);
    const pick = (q, sl, dmin) => { for (const d of DIAMS) { if (d < dmin) continue; if (qFull(d, Math.max(sl, minS(d))) >= q) return d; } return DIAMS[DIAMS.length - 1]; };
    const step = (d, k) => { const i = DIAMS.indexOf(d); return DIAMS[clamp(i + k, 0, DIAMS.length - 1)]; };
    const dirScale = !hasDem ? Infinity : coarse ? 0.012 : 0.004;
    const invSigma = !hasDem ? { storm: 2.0, sanitary: 2.0 } : coarse ? { storm: 1.2, sanitary: 1.4 } : { storm: 0.6, sanitary: 0.8 };

    let nid = { ST: 0, SA: 0, OF: 0, SO: 0, DI: 0, PS: 0 };
    const mkNodeId = p => `${p}-${String(++nid[p]).padStart(4, '0')}`;

    G.E.forEach(ed => { ed.servA = ed.bldg > 0 ? Math.min(ed.len * 80, 2 * ed.len * 45) / 10000 : 0; ed.subA = 0; ed.subCA = 0; });
    const subsOut = [];
    ['sanitary', 'storm'].forEach(sys => {
      const pOf = ed => sys === 'sanitary' ? ed.pSan : ed.pStorm;
      const excl = inp.excluded || new Set(), fixed = inp.fixedDir || new Map();
      const okE = (eid, u) => { const k = sys + '|' + G.E[eid].key; if (excl.has(k)) return false; if (u !== undefined && fixed.has(k) && fixed.get(k) !== u) return false; return true; };
      const R = route(G, okE, sys === 'sanitary' ? sanOut : stormOut, S);
      // sewer-carrying streets + the connectors on their path to an outlet
      const need = new Set();
      G.E.forEach(ed => { if (pOf(ed) >= 0.5 && okE(ed.id)) need.add(ed.id); });
      [...need].forEach(eid => { const ed = G.E[eid]; [ed.a, ed.b].forEach(v0 => { let v = v0, guard = 0; while (R.down.has(v) && guard++ < 5000) { const d = R.down.get(v); need.add(d.e); v = d.v; } }); });
      if (!need.size) return;
      // link topology: tree edges flow u -> down[u]; other streets split at a summit into two dead-end runs
      const all = [];
      need.forEach(eid => {
        const ed = G.E[eid];
        if (R.down.get(ed.a)?.e === eid) all.push({ eid, up: ed.a, dn: ed.b, geom: ed.geom, len: ed.len, frac: 1 });
        else if (R.down.get(ed.b)?.e === eid) all.push({ eid, up: ed.b, dn: ed.a, geom: ed.geom.slice().reverse(), len: ed.len, frac: 1 });
        else {
          const a = G.V.get(ed.a), b = G.V.get(ed.b), sv = 'h' + sys[0] + eid;
          // summit = highest geometry point inside the street (fallback midpoint)
          let hm = [(a.lat + b.lat) / 2, (a.lng + b.lng) / 2], hz = zAt(hm[0], hm[1]);
          for (let k = 1; k < 8; k++) { const t = k / 8, p = [a.lat + (b.lat - a.lat) * t, a.lng + (b.lng - a.lng) * t], z = zAt(p[0], p[1]); if (isFinite(z) && (!isFinite(hz) || z > hz)) { hz = z; hm = p; } }
          const za = a.z, zb = b.z;
          if (!isFinite(hz) || (isFinite(za) && isFinite(zb) && hz <= Math.max(za, zb) + 0.05)) {
            // street slopes one way: a terminal manhole just inside the high end, one run to the low end
            const hi = (isFinite(za) && isFinite(zb) && za > zb) ? a : b, lo = hi === a ? b : a, t = Math.min(0.5, 4 / Math.max(ed.len, 8));
            const sp = [hi.lat + (lo.lat - hi.lat) * t, hi.lng + (lo.lng - hi.lng) * t], [sx, sy] = P.f(sp[0], sp[1]);
            G.V.set(sv, { id: sv, lat: sp[0], lng: sp[1], x: sx, y: sy, adj: [], z: zAt(sp[0], sp[1]), boundary: false, summit: true });
            const geom = hi === a ? ed.geom : ed.geom.slice().reverse();
            all.push({ eid, up: sv, dn: lo.id, geom: [sp, ...geom.slice(1)], len: Math.max(1, ed.len * (1 - t)), frac: 1 });
            return;
          }
          const [hx, hy] = P.f(hm[0], hm[1]);
          G.V.set(sv, { id: sv, lat: hm[0], lng: hm[1], x: hx, y: hy, adj: [], z: hz, boundary: false, summit: true });
          const la = Math.hypot(hx - a.x, hy - a.y), lb = Math.hypot(hx - b.x, hy - b.y), tot = la + lb || 1;
          all.push({ eid, up: sv, dn: ed.a, geom: [hm, [a.lat, a.lng]], len: Math.max(1, ed.len * la / tot), frac: la / tot, half: 'a' });
          all.push({ eid, up: sv, dn: ed.b, geom: [hm, [b.lat, b.lng]], len: Math.max(1, ed.len * lb / tot), frac: lb / tot, half: 'b' });
        }
      });
      // upstream-first order (Kahn on link graph)
      const outOf = new Map(), indeg = new Map();
      all.forEach(L => { if (!outOf.has(L.up)) outOf.set(L.up, []); outOf.get(L.up).push(L); });
      all.forEach(L => indeg.set(L, 0));
      all.forEach(L => (outOf.get(L.dn) || []).forEach(M => indeg.set(M, indeg.get(M) + 1)));
      const q = all.filter(L => indeg.get(L) === 0), order = [];
      while (q.length) { const L = q.shift(); order.push(L); (outOf.get(L.dn) || []).forEach(M => { indeg.set(M, indeg.get(M) - 1); if (indeg.get(M) === 0) q.push(M); }); }
      all.forEach(L => { if (!order.includes(L)) order.push(L); });
      // storm: subcatchments now, so sizing can use real areas
      if (sys === 'storm' && inp.allocate !== false) {
        const al = allocateEdges(G, P, [...need], inp, S);
        al.subs.forEach(sb => subsOut.push(sb));
        out.allocInfo = al.info;
      }
      // flows and sizes
      const inflow = new Map(), zero = () => ({ A: 0, CA: 0, pop: 0, iciA: 0, iiA: 0, tc: 0 });
      order.forEach(L => {
        const ed = G.E[L.eid], u = inflow.get(L.up) || zero();
        const T = { A: u.A + ed.subA * L.frac, CA: u.CA + ed.subCA * L.frac, pop: u.pop + ed.dw * S.pph * L.frac, iciA: u.iciA + ed.ici * S.iciGrossFactor / 10000 * L.frac, iiA: u.iiA + ed.servA * L.frac, tc: Math.max(u.tc, S.inletTime) };
        const a = G.V.get(L.up), b = G.V.get(L.dn), gz = (isFinite(a.z) && isFinite(b.z)) ? (a.z - b.z) / L.len : NaN, sl = isFinite(gz) ? Math.max(gz, 0) : 0;
        let qd, d;
        if (sys === 'storm') {
          const i = idf[0] / Math.pow(T.tc + idf[1], idf[2]);
          qd = 2.778 * i * Math.max(T.CA, 0.01); d = pick(qd, sl, 300);
          const v = qFull(d, Math.max(sl, minS(d))) / 1000 / (Math.PI * (d / 1000) ** 2 / 4);
          T.tc += L.len / Math.max(0.6, Math.min(v, 3)) / 60;
        } else {
          const Pk = T.pop / 1000, M = clamp(1 + 14 / (4 + Math.sqrt(Math.max(Pk, 0.001))), 2.0, 4.0);
          qd = T.pop * S.perCap / 86400 * M + T.iciA * S.iciLpsPerHa * 3 + T.iiA * S.iiRate; d = pick(qd, sl, 200);
        }
        d = step(d, Math.round(S.sizeBias));
        const dn = inflow.get(L.dn) || zero();
        inflow.set(L.dn, { A: dn.A + T.A, CA: dn.CA + T.CA, pop: dn.pop + T.pop, iciA: dn.iciA + T.iciA, iiA: dn.iiA + T.iiA, tc: Math.max(dn.tc, T.tc) });
        Object.assign(L, { q: qd, d, gz, T });
      });
      // a pipe is never smaller than the largest pipe entering its upstream node
      const maxIn = new Map();
      order.forEach(L => { const m = maxIn.get(L.up) || 0; if (L.d < m && !(sys === 'storm' && G.E[L.eid].ditch > 0.5)) L.d = m; maxIn.set(L.dn, Math.max(maxIn.get(L.dn) || 0, L.d)); });
      // inverts, upstream first
      const nodeInv = new Map();
      order.forEach(L => {
        const a = G.V.get(L.up), b = G.V.get(L.dn), D = L.d / 1000, ed = G.E[L.eid];
        const ditch = sys === 'storm' && ed.ditch > 0.5 && ed.ditchInfo;
        const depth0 = sys === 'sanitary' ? Math.max(S.coverSan + D, S.sanDepth) + S.extraCover : S.coverStorm + D + 0.2 + S.extraCover;
        let up = null, dn = null;
        if (ditch) {
          const st = ed.ditchInfo.st, bot = x => Math.min(x.ditchL ? x.l.mn : Infinity, x.ditchR ? x.r.mn : Infinity);
          const zs = st.map(bot).filter(isFinite), med = arr => arr.slice().sort((p, q2) => p - q2)[Math.floor(arr.length / 2)];
          if (zs.length) {
            let zu = med(zs.slice(0, 3)), zd = med(zs.slice(-3)); if (L.up !== ed.a) [zu, zd] = [zd, zu];
            const dep = st.reduce((s2, x) => s2 + Math.max(x.ditchL ? x.l.drop : 0, x.ditchR ? x.r.drop : 0), 0) / st.length;
            L.channel = { depth: Math.max(0.3, dep) }; up = zu; dn = Math.min(zd, zu - 0.0005 * L.len);
          }
        }
        if (!L.channel) {
          if (isFinite(a.z)) up = a.z - depth0;
          const din = nodeInv.get(L.up); if (din !== undefined && din !== null) up = up === null ? din : Math.min(up, din);
          if (up !== null) { dn = up - Math.max(isFinite(L.gz) ? L.gz : 0, minS(L.d)) * L.len; if (isFinite(b.z)) dn = Math.min(dn, b.z - depth0); }
        }
        L.upInv = up; L.dnInv = dn;
        if (dn !== null) { const cur = nodeInv.get(L.dn); nodeInv.set(L.dn, cur === undefined || cur === null ? dn : Math.min(cur, dn)); }
      });
      // emit
      const vmap = new Map(), outlets = new Map((sys === 'sanitary' ? sanOut : stormOut).map(x => [x[0], x[1]]));
      const nodeFor = vid => {
        if (vmap.has(vid)) return vmap.get(vid);
        const v = G.V.get(vid), plant = plantV.find(p => p.v === vid), isOutlet = !R.down.has(vid) && outlets.has(vid);
        let kind = 'mh', pref = sys === 'sanitary' ? 'SA' : 'ST', note = v.summit ? 'Start of run (street high point)' : '';
        if (isOutlet) {
          if (sys === 'sanitary') { kind = plant && plant.kind === 'pump' ? 'pump' : 'outfall'; pref = kind === 'pump' ? 'PS' : 'SO'; note = plant ? `${plant.kind === 'pump' ? 'Pumping station' : 'Wastewater plant'} ${plant.name}`.trim() : v.boundary ? 'Continues outside the study area' : 'Low point — outlet assumed'; }
          else { kind = 'outfall'; pref = 'OF'; note = v.wd < S.waterDist ? `Outfall to water (${v.wd.toFixed(0)} m away)` : v.boundary ? 'Continues outside the study area' : 'Low point — outlet assumed'; }
        }
        const ll = sys === 'storm' ? P.i(v.x + 1.6, v.y + 1.6) : [v.lat, v.lng];
        const node = { id: mkNodeId(pref), kind, sys, lat: ll[0], lng: ll[1], rim: isFinite(v.z) ? +v.z.toFixed(2) : '', rimSrc: isFinite(v.z) ? (inp.demName || 'DEM') : '', invert: '', conf: 'med', evidence: ['inferred'], seen: '', drawing: '', notes: note, inferred: true, vid, inf: {} };
        vmap.set(vid, node); out.nodes.push(node); return node;
      };
      order.forEach(L => {
        const ed = G.E[L.eid], fn = nodeFor(L.up), tn = nodeFor(L.dn), ditch = !!L.channel;
        const pDir = isFinite(L.gz) && isFinite(dirScale) ? clamp(sig(L.gz / dirScale), 0.05, 0.98) : 0.5;
        const pEx = sys === 'sanitary' ? (ed.pSan >= 0.5 ? ed.pSan : 0.55) : ditch ? clamp(ed.ditch, 0.5, 0.95) : (ed.pStorm >= 0.5 ? ed.pStorm : 0.5);
        const id = `${sys === 'sanitary' ? 'C-SA' : ditch ? 'D-ST' : 'C-ST'}-${String(out.links.length + 1).padStart(4, '0')}`;
        const depth = isFinite(+fn.rim) && fn.rim !== '' && L.upInv !== null ? (+fn.rim - L.upInv) : null;
        const notes = [];
        if (ditch) notes.push(`Roadside ditch from lidar (${(ed.ditch * 100).toFixed(0)} % of cross-sections)`);
        else if (sys === 'storm') notes.push(`Design ${L.q.toFixed(0)} L/s (${S.stormRp}-yr rational, ${L.T.A.toFixed(2)} ha, tc ${L.T.tc.toFixed(0)} min)`);
        else notes.push(`Design ${L.q.toFixed(1)} L/s (${Math.round(L.T.pop)} people, Harmon peaking)`);
        if (depth !== null && depth > 6) notes.push(`${depth.toFixed(1)} m deep — a pumping station or another route is likely`);
        if (ed.name) notes.push(ed.name);
        const sg = ditch ? 0.2 : invSigma[sys];
        const link = {
          id, from: fn.id, to: tn.id, sys, diam: ditch ? '' : L.d, shape: ditch ? 'TRAPEZOIDAL' : 'CIRCULAR', material: '', n: ditch ? 0.035 : '',
          upInv: L.upInv !== null ? +L.upInv.toFixed(3) : '', dnInv: L.dnInv !== null ? +L.dnInv.toFixed(3) : '', len: +L.len.toFixed(1),
          conf: '', drawing: '', notes: notes.join(' · '), verts: (L.geom || []).slice(1, -1), inferred: true, edge: ed.key + (L.half || ''),
          channel: L.channel ? { depth: +L.channel.depth.toFixed(2), bottom: 0.5, side: 2 } : null,
          inf: { diam: ditch ? null : L.d, upInv: L.upInv, dnInv: L.dnInv, from: fn.id, to: tn.id, pExist: +pEx.toFixed(3), pDir: +pDir.toFixed(3), grade: isFinite(L.gz) ? +L.gz.toFixed(4) : null, q: +L.q.toFixed(2), area: +L.T.A.toFixed(3), pop: Math.round(L.T.pop), invSigma: sg, ditch, street: ed.name }
        };
        const p = Math.min(pEx, pDir); link.conf = p >= 0.85 ? 'high' : p >= 0.6 ? 'med' : 'low';
        out.links.push(link);
        if (sys === 'sanitary') { const add = ed.dw * S.pph * L.frac; if (add > 0) fn.pop = Math.round(((NUM(fn.pop) || 0) + add) * 10) / 10; }
      });
      // SWMM outfalls take one link: give shared outlets a junction + short outfall pipe
      [...vmap.values()].forEach(node => {
        if (node.kind !== 'outfall') return;
        const inc = out.links.filter(l => l.to === node.id);
        if (inc.length <= 1) return;
        const v = G.V.get(node.vid), ll = P.i(v.x + 4, v.y - 4);
        const of = Object.assign({}, node, { id: mkNodeId(sys === 'sanitary' ? 'SO' : 'OF'), lat: ll[0], lng: ll[1], inf: {}, vid: null });
        node.kind = 'mh'; node.id = mkNodeId(sys === 'sanitary' ? 'SA' : 'ST'); node.notes = 'Junction before outlet';
        inc.forEach(l => { l.to = node.id; l.inf.to = node.id; });
        const jInv = Math.min(...inc.map(l => NUM(l.dnInv)).filter(v => v !== null));
        of.invert = isFinite(jInv) ? +(jInv - 0.03).toFixed(3) : '';
        out.nodes.push(of);
        out.links.push({ id: `${sys === 'sanitary' ? 'C-SA' : 'C-ST'}-${String(out.links.length + 1).padStart(4, '0')}`, from: node.id, to: of.id, sys, diam: Math.max(...inc.map(l => NUM(l.diam) || 300)), shape: 'CIRCULAR', material: '', n: '', upInv: isFinite(jInv) ? +jInv.toFixed(3) : '', dnInv: isFinite(jInv) ? +(jInv - 0.03).toFixed(3) : '', len: 6, conf: 'med', drawing: '', notes: 'Outlet pipe', verts: [], inferred: true, edge: 'out:' + of.id, channel: null, inf: { diam: null, from: node.id, to: of.id, pExist: 0.7, pDir: 0.95, invSigma: invSigma[sys], outletPipe: true } });
      });
    });
    // subcatchment outlet = downstream node of its street's storm link (lowest end for split streets)
    const nodeById = new Map(out.nodes.map(n2 => [n2.id, n2]));
    const linksByEdge = new Map(); out.links.forEach(l => { if (l.sys !== 'storm') return; const k2 = l.edge.replace(/[ab]$/, ''); if (!linksByEdge.has(k2)) linksByEdge.set(k2, []); linksByEdge.get(k2).push(l); });
    subsOut.forEach(sb => { const ls = linksByEdge.get(sb.edge) || []; let best = null; ls.forEach(l => { const r = NUM(nodeById.get(l.to)?.rim); if (!best || (r !== null && r < best[1])) best = [l.to, r ?? Infinity]; }); sb.outlet = best ? best[0] : ''; });
    out.subs = subsOut.filter(sb => sb.outlet);
    out.nodes.forEach(n => { const ls = out.links.filter(l => l.from === n.id || l.to === n.id); const p = ls.length ? Math.max(...ls.map(l => l.inf.pExist)) : 0.5; n.inf.pExist = +p.toFixed(3); n.conf = p >= 0.85 ? 'high' : p >= 0.6 ? 'med' : 'low'; });
    out.stats = expectedAccuracy(out, { hasDem, coarse });
    return out;
  }

  /* ---------- subcatchments by raster allocation ----------
     Cells drain over the lidar surface to the first road cell they reach;
     without lidar each cell goes to the nearest storm street. */
  function allocateEdges(G, P, edgeIds, inp, S, cellM = 4) {
    const [s, w, n, e] = inp.bbox, [x0, y0] = P.f(s, w), [x1, y1] = P.f(n, e);
    let cm = cellM; while (((x1 - x0) / cm) * ((y1 - y0) / cm) > 400000) cm *= 1.25;
    const W = Math.max(2, Math.ceil((x1 - x0) / cm)), H = Math.max(2, Math.ceil((y1 - y0) / cm)), N = W * H;
    const cx = c => x0 + (c + 0.5) * cm, cy = r => y1 - (r + 0.5) * cm;
    const elig = new Set(edgeIds), idx = new Grid(40);
    edgeIds.forEach(id => { const xy = G.E[id].xy; for (let i = 1; i < xy.length; i++) idx.addSeg(xy[i - 1][0], xy[i - 1][1], xy[i][0], xy[i][1], id); });
    const nearest = (x, y, r) => { let best = -1, bd = r; idx.near(x, y, r).forEach(id => { const xy = G.E[id].xy; for (let i = 1; i < xy.length; i++) { const [d] = segDist(x, y, xy[i - 1][0], xy[i - 1][1], xy[i][0], xy[i][1]); if (d < bd) { bd = d; best = id; } } }); return [best, bd]; };
    const lab = new Int32Array(N).fill(-1), imp = new Uint8Array(N);
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) {
      const i = r * W + c, [eid, d] = nearest(cx(c), cy(r), 12);
      if (eid >= 0 && d <= (ROAD_W[G.E[eid].cls] || 8) / 2 + cm * 0.5) { lab[i] = eid; imp[i] = 1; }
    }
    (inp.buildings || []).concat(inp.parking || []).forEach(b => {
      const xy = b.geom.map(p => P.f(p[0], p[1])), xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
      const c0 = Math.max(0, Math.floor((Math.min(...xs) - x0) / cm)), c1 = Math.min(W - 1, Math.floor((Math.max(...xs) - x0) / cm));
      const r0 = Math.max(0, Math.floor((y1 - Math.max(...ys)) / cm)), r1 = Math.min(H - 1, Math.floor((y1 - Math.min(...ys)) / cm));
      for (let r = r0; r <= r1; r++) for (let c = c0; c <= c1; c++) if (pip(cx(c), cy(r), xy)) imp[r * W + c] = 1;
    });
    let usedDem = false;
    if (inp.zAt && inp.demQuality === 'lidar' && typeof NB !== 'undefined') {
      const z = new Float32Array(N); let ok = 0;
      for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const [la, lo] = P.i(cx(c), cy(r)); const v = inp.zAt(la, lo); z[r * W + c] = isFinite(v) ? v : NaN; if (isFinite(v)) ok++; }
      if (ok > N * 0.6) {
        const A = NB.analyse({ w: W, h: H, z, cell: cm });
        for (let i = 0; i < N; i++) {
          if (lab[i] !== -1) continue;
          const path = []; let k = i;
          while (k >= 0 && lab[k] === -1 && path.length < 150) { path.push(k); k = A.rec[k]; }
          const L = (k >= 0 && lab[k] >= 0) ? lab[k] : -2;
          path.forEach(p => { lab[p] = L; });
        }
        usedDem = true;
      }
    }
    for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) { const i = r * W + c; if (lab[i] < 0) { const [eid] = nearest(cx(c), cy(r), 90); lab[i] = eid; } }
    const per = new Map();
    for (let i = 0; i < N; i++) { const L = lab[i]; if (L < 0 || !elig.has(L)) continue; if (!per.has(L)) per.set(L, { cells: [], imp: 0 }); const o = per.get(L); o.cells.push(i); o.imp += imp[i]; }
    const subs = []; let k = 0, totA = 0, totImp = 0;
    per.forEach((o, eid) => {
      const ed = G.E[eid], A = o.cells.length * cm * cm; if (A < 150) return;
      let cmin = W, cmax = 0, rmin = H, rmax = 0; o.cells.forEach(i => { const c = i % W, r = (i - c) / W; if (c < cmin) cmin = c; if (c > cmax) cmax = c; if (r < rmin) rmin = r; if (r > rmax) rmax = r; });
      const ww = cmax - cmin + 3, hh = rmax - rmin + 3, mask = new Uint8Array(ww * hh);
      o.cells.forEach(i => { const c = i % W, r = (i - c) / W; mask[(r - rmin + 1) * ww + (c - cmin + 1)] = 1; });
      const ring = NB.simplify(NB.traceMask(mask, ww, hh), 1.0).map(([c, r]) => P.i(cx(c + cmin - 1), cy(r + rmin - 1)));
      if (ring.length < 3) return;
      const impF = o.imp / o.cells.length, impAdj = impF + (1 - impF) * S.unmappedImp;
      let sl = '';
      if (inp.zAt && inp.demQuality !== 'none') {
        const zs = o.cells.filter((_, j) => j % 7 === 0).map(i => { const c = i % W, r = (i - c) / W; return inp.zAt(...P.i(cx(c), cy(r))); }).filter(isFinite);
        if (zs.length > 4) { zs.sort((p, q) => p - q); const span = zs[Math.floor(zs.length * 0.9)] - zs[Math.floor(zs.length * 0.1)]; sl = +clamp(span / Math.max(20, Math.sqrt(A)) * 100, 0.3, 25).toFixed(2); }
      }
      const width = Math.round(clamp(2 * ed.len, Math.sqrt(A) * 0.5, A / 8));
      ed.subA = A / 10000; ed.subCA = ed.subA * (0.2 + 0.7 * impAdj); totA += A; totImp += impAdj * A;
      subs.push({ id: `S-${String(++k).padStart(4, '0')}`, sys: 'storm', coords: ring, outlet: '', landuse: '', imp: Math.round(impAdj * 100), area: +(A / 10000).toFixed(4), width, flowLen: '', slope: sl, pop: '', ii: '', notes: `Inferred from ${usedDem ? 'lidar surface drainage to streets' : 'nearest street'}; mapped impervious ${(impF * 100).toFixed(0)} % + ${(S.unmappedImp * 100).toFixed(0)} % allowance for unmapped driveways`, inferred: true, edge: ed.key });
    });
    return { subs, info: { usedDem, cell: cm, area: totA / 10000, imp: totA ? totImp / totA : 0 } };
  }

  /* ---------- accuracy: prior expectations and validation ---------- */
  const SIZE_PRIOR = { exact: 0.45, within1: 0.85 }; // until validated against drawings
  function normCdf(x) { const t = 1 / (1 + 0.2316419 * Math.abs(x)), d = 0.3989423 * Math.exp(-x * x / 2); const p = d * t * (0.3193815 + t * (-0.3565638 + t * (1.781478 + t * (-1.821256 + t * 1.330274)))); return x > 0 ? 1 - p : p; }
  function expectedAccuracy(out, q) {
    const L = out.links.filter(l => l.inferred), m = a => a.length ? a.reduce((s, v) => s + v, 0) / a.length : null;
    const bySys = sys => {
      const ls = L.filter(l => l.sys === sys); if (!ls.length) return null;
      const sg = (ls.find(l => !l.inf.ditch) || ls[0]).inf.invSigma;
      return {
        links: ls.length, length: Math.round(ls.reduce((s, l) => s + (l.len || 0), 0)),
        exist: m(ls.map(l => l.inf.pExist)), dir: m(ls.map(l => l.inf.pDir)),
        sizeExact: SIZE_PRIOR.exact, sizeWithin1: SIZE_PRIOR.within1,
        inv05: 2 * normCdf(0.5 / sg) - 1, inv10: 2 * normCdf(1.0 / sg) - 1
      };
    };
    return { storm: bySys('storm'), sanitary: bySys('sanitary'), dem: q.hasDem ? (q.coarse ? 'coarse' : 'lidar') : 'none' };
  }
  function validate(P) {
    const V = P.links.filter(l => l.inferred && l.verified && l.inf);
    const r = { n: V.length, dir: null, sizeExact: null, sizeWithin1: null, invMAE: null, invBias: null, inv05: null, exist: null };
    if (!V.length) return r;
    const dirOk = V.filter(l => l.inf.from === l.from), r1 = [], r2 = [];
    r.dir = dirOk.length / V.length;
    const sized = V.filter(l => NUM(l.diam) && l.inf.diam);
    if (sized.length) {
      const idx = d => DIAMS.reduce((bi, x, i) => Math.abs(x - d) < Math.abs(DIAMS[bi] - d) ? i : bi, 0);
      const k = sized.map(l => idx(+l.diam) - idx(l.inf.diam));
      r.sizeExact = k.filter(x => x === 0).length / k.length; r.sizeWithin1 = k.filter(x => Math.abs(x) <= 1).length / k.length; r.sizeBias = k.reduce((s, x) => s + x, 0) / k.length; r.sized = sized.length;
    }
    V.forEach(l => {
      const same = l.inf.from === l.from;
      [['upInv', same ? 'upInv' : 'dnInv'], ['dnInv', same ? 'dnInv' : 'upInv']].forEach(([cur, inf]) => { const a = NUM(l[cur]), b = NUM(l.inf[inf]); if (a !== null && b !== null) { r1.push(a - b); } });
    });
    if (r1.length) { r.invMAE = r1.reduce((s, v) => s + Math.abs(v), 0) / r1.length; r.invBias = r1.reduce((s, v) => s + v, 0) / r1.length; r.inv05 = r1.filter(v => Math.abs(v) <= 0.5).length / r1.length; r.invN = r1.length; }
    const ex = P.links.filter(l => l.inferred && l.verified); const removed = (P.removedInferred || []).length;
    r.exist = ex.length / (ex.length + removed);
    void r2;
    return r;
  }

  /* ---------- ensemble sampling for uncertainty propagation ---------- */
  function rng(seed) { let s = seed >>> 0; return () => { s = (s * 1664525 + 1013904223) >>> 0; return s / 4294967296; }; }
  function gauss(R) { let u = 0, v = 0; while (u === 0) u = R(); v = R(); return Math.sqrt(-2 * Math.log(u)) * Math.cos(2 * Math.PI * v); }
  function sampleRealisation(Pm, seed) {
    const R = rng(seed), P = JSON.parse(JSON.stringify(Pm));
    const cum = [[-2, 0.05], [-1, 0.20], [0, 0.65], [1, 0.90], [2, 1.0]]; // size steps relative to the estimate
    const shift = new Map();
    P.links.forEach(l => {
      if (!l.inferred || l.verified || !l.inf) return;
      if (l.inf.diam) { const u = R(); const k = cum.find(c => u <= c[1])[0]; const i = DIAMS.indexOf(+l.diam); if (i >= 0) l.diam = DIAMS[clamp(i + k, 0, DIAMS.length - 1)]; }
      const sg = l.inf.invSigma || 0.5; const key = l.from;
      if (!shift.has(key)) shift.set(key, gauss(R) * sg);
      const du = shift.get(key), dd = shift.has(l.to) ? shift.get(l.to) : (shift.set(l.to, gauss(R) * sg), shift.get(l.to));
      if (NUM(l.upInv) !== null) l.upInv = +(l.upInv + du).toFixed(3);
      if (NUM(l.dnInv) !== null) l.dnInv = +(Math.min(l.dnInv + dd, l.upInv - 0.0005 * (l.len || 50))).toFixed(3);
    });
    P.subs.forEach(s => { if (!s.inferred) return; s.imp = clamp(Math.round(NUM(s.imp) * (1 + 0.15 * gauss(R))), 0, 100); s.width = Math.round(NUM(s.width) * Math.exp(0.3 * gauss(R))); });
    return P;
  }

  /* ---------- construction-exposure pixel scoring (used on imagery tiles) ---------- */
  function soilScore(r, g, b) { // high for brown/tan soil or fresh granular; low for asphalt/grass/snow
    const mx = Math.max(r, g, b), mn = Math.min(r, g, b), v = mx / 255, sat = mx ? (mx - mn) / mx : 0;
    if (v < 0.25 || v > 0.92) return 0;
    const warm = (r - b) / 255, green = (g - r) / 255;
    if (green > 0.02) return 0; // vegetation
    return clamp((warm - 0.06) * 6, 0, 1) * clamp((sat - 0.12) * 5, 0, 1);
  }
  function isSnowy(data) { let bright = 0, n = 0; for (let i = 0; i < data.length; i += 16) { const r = data[i], g = data[i + 1], b = data[i + 2]; n++; if (r > 205 && g > 205 && b > 205) bright++; } return bright / n > 0.35; }

  return { DEFAULTS, DIAMS, infer, validate, expectedAccuracy, sampleRealisation, soilScore, isSnowy, classifyBuilding, roadClass, proj, normCdf };
})();
if (typeof module !== 'undefined') module.exports = NBI;
