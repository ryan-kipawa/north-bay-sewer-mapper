/* ===================================================================
   North Bay Sewer Mapper — core engine (no DOM / no Leaflet)
   Geodesy, City of North Bay design criteria, network derivation and
   checks, SWMM5 .inp writer, and lidar DEM analysis.
   =================================================================== */
const NB = (function () {
  'use strict';

  /* ---------------- City of North Bay criteria ----------------
     Engineering Design Guidelines (2021): IDF Table 6.4, runoff
     coefficients Table 6.1, sanitary 450 L/cap/d, I/I allowances,
     min cover (storm 1.5 m, sanitary 1.8 m), min sizes, MH spacing. */
  const IDF = {
    '2': [536, 5.7, 0.7440], '5': [747, 5.3, 0.7588], '10': [880, 5.1, 0.7634],
    '25': [1055, 5.0, 0.7688], '50': [1176, 4.8, 0.7702], '100': [1309, 4.9, 0.7743]
  };
  // Land use -> runoff C (City Table 6.1); %imperv from C = 0.9*I + 0.2*(1-I)
  const LANDUSE = [
    ['asphalt', 'Asphalt / concrete / roofs', 0.90],
    ['commercial', 'Commercial', 0.80],
    ['industrial', 'Industrial', 0.70],
    ['multi', 'Townhouses / apartments', 0.60],
    ['granular', 'Granular', 0.60],
    ['institutional', 'Institutional', 0.55],
    ['sfd_small', 'Single family ≤400 m² lots / semi', 0.50],
    ['sfd_large', 'Single family ≥400 m² lots', 0.40],
    ['park', 'Grassed / parkland', 0.25]
  ].map(([k, label, C]) => ({ k, label, C, imp: Math.round(Math.max(0, Math.min(1, (C - 0.2) / 0.7)) * 100) }));

  const DEFAULT_SETTINGS = {
    minCoverStorm: 1.5, minCoverSan: 1.8, minDiaStorm: 300, minDiaSan: 200,
    n: 0.013, minVel: 0.6, spacingSmall: 120, spacingLarge: 150,
    cbDepth: 1.2, perCap: 450, iiRate: 0.44,
    rp: '5', dur: 240, r: 0.38, step: 5,
    hMax: 76.2, hMin: 12.7, hDecay: 4, hDry: 7,
    nImp: 0.013, nPerv: 0.25, dsImp: 1.5, dsPerv: 5, pctZero: 25,
    utmZone: 17
  };

  /* ---------------- Geodesy ---------------- */
  const RAD = Math.PI / 180;
  // GRS80 (NAD83). UTM forward/inverse (Snyder).
  const A = 6378137, F = 1 / 298.257222101, K0 = 0.9996;
  const E2 = F * (2 - F), EP2 = E2 / (1 - E2);
  function toUTM(lat, lon, zone = 17) {
    const lon0 = (zone * 6 - 183) * RAD, p = lat * RAD, l = lon * RAD;
    const sp = Math.sin(p), cp = Math.cos(p), tp = Math.tan(p);
    const N = A / Math.sqrt(1 - E2 * sp * sp), T = tp * tp, C = EP2 * cp * cp, Aa = cp * (l - lon0);
    const M = A * ((1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256) * p
      - (3 * E2 / 8 + 3 * E2 * E2 / 32 + 45 * E2 ** 3 / 1024) * Math.sin(2 * p)
      + (15 * E2 * E2 / 256 + 45 * E2 ** 3 / 1024) * Math.sin(4 * p)
      - (35 * E2 ** 3 / 3072) * Math.sin(6 * p));
    const x = K0 * N * (Aa + (1 - T + C) * Aa ** 3 / 6 + (5 - 18 * T + T * T + 72 * C - 58 * EP2) * Aa ** 5 / 120) + 500000;
    const y = K0 * (M + N * tp * (Aa * Aa / 2 + (5 - T + 9 * C + 4 * C * C) * Aa ** 4 / 24
      + (61 - 58 * T + T * T + 600 * C - 330 * EP2) * Aa ** 6 / 720));
    return [x, y];
  }
  function fromUTM(x, y, zone = 17) {
    const lon0 = (zone * 6 - 183) * RAD;
    x -= 500000;
    const M = y / K0;
    const mu = M / (A * (1 - E2 / 4 - 3 * E2 * E2 / 64 - 5 * E2 ** 3 / 256));
    const e1 = (1 - Math.sqrt(1 - E2)) / (1 + Math.sqrt(1 - E2));
    const p1 = mu + (3 * e1 / 2 - 27 * e1 ** 3 / 32) * Math.sin(2 * mu)
      + (21 * e1 * e1 / 16 - 55 * e1 ** 4 / 32) * Math.sin(4 * mu)
      + (151 * e1 ** 3 / 96) * Math.sin(6 * mu) + (1097 * e1 ** 4 / 512) * Math.sin(8 * mu);
    const s1 = Math.sin(p1), c1 = Math.cos(p1), t1 = Math.tan(p1);
    const N1 = A / Math.sqrt(1 - E2 * s1 * s1), T1 = t1 * t1, C1 = EP2 * c1 * c1;
    const R1 = A * (1 - E2) / Math.pow(1 - E2 * s1 * s1, 1.5), D = x / (N1 * K0);
    const lat = p1 - (N1 * t1 / R1) * (D * D / 2 - (5 + 3 * T1 + 10 * C1 - 4 * C1 * C1 - 9 * EP2) * D ** 4 / 24
      + (61 + 90 * T1 + 298 * C1 + 45 * T1 * T1 - 252 * EP2 - 3 * C1 * C1) * D ** 6 / 720);
    const lon = lon0 + (D - (1 + 2 * T1 + C1) * D ** 3 / 6
      + (5 - 2 * C1 + 28 * T1 - 3 * C1 * C1 + 8 * EP2 + 24 * T1 * T1) * D ** 5 / 120) / c1;
    return [lat / RAD, lon / RAD];
  }
  const RM = 6378137;
  function merc(lat, lng) { return [RM * lng * RAD, RM * Math.log(Math.tan(Math.PI / 4 + lat * RAD / 2))]; }
  function unmerc(x, y) { return [(2 * Math.atan(Math.exp(y / RM)) - Math.PI / 2) / RAD, x / RM / RAD]; }
  function dist(a, b) { // [lat,lng] metres (UTM, fine at city scale)
    const p = toUTM(a[0], a[1]), q = toUTM(b[0], b[1]);
    return Math.hypot(p[0] - q[0], p[1] - q[1]);
  }
  function pathLength(pts) { let s = 0; for (let i = 1; i < pts.length; i++) s += dist(pts[i - 1], pts[i]); return s; }
  function polyArea(pts) { // m², pts [[lat,lng]...]
    const u = pts.map(p => toUTM(p[0], p[1])); let s = 0;
    for (let i = 0; i < u.length; i++) { const a = u[i], b = u[(i + 1) % u.length]; s += a[0] * b[1] - b[0] * a[1]; }
    return Math.abs(s) / 2;
  }
  function bearing(a, b) { const p = toUTM(a[0], a[1]), q = toUTM(b[0], b[1]); return Math.atan2(q[0] - p[0], q[1] - p[1]) / RAD; }

  /* ---------------- Design storm (Chicago, Keifer & Chu) ---------------- */
  function chicago(rp, durMin, stepMin, r) {
    const [a, b, c] = IDF[rp];
    const tp = r * durMin;
    const inten = t => {
      if (t < tp) { const tb = (tp - t) / r; return a * ((1 - c) * tb + b) / Math.pow(tb + b, 1 + c); }
      const ta = (t - tp) / (1 - r); return a * ((1 - c) * ta + b) / Math.pow(ta + b, 1 + c);
    };
    const n = Math.round(durMin / stepMin), out = [];
    for (let k = 0; k < n; k++) {
      let s = 0; const sub = 100;
      for (let j = 0; j < sub; j++) s += inten(k * stepMin + (j + 0.5) * stepMin / sub);
      out.push(s / sub);
    }
    return out; // mm/h per step
  }
  function idfIntensity(rp, tdMin) { const [a, b, c] = IDF[rp]; return a / Math.pow(tdMin + b, c); }

  /* ---------------- Hydraulics helpers ---------------- */
  function minSlopeFor(diaMm, n, vel) { // full-pipe velocity criterion, m/m
    const D = diaMm / 1000, R = D / 4;
    return Math.pow(vel * n / Math.pow(R, 2 / 3), 2);
  }
  function fullFlow(diaMm, n, S) { // L/s
    if (!(S > 0)) return 0; const D = diaMm / 1000, R = D / 4, Ar = Math.PI * D * D / 4;
    return 1000 * Ar * Math.pow(R, 2 / 3) * Math.sqrt(S) / n;
  }

  /* ---------------- Network derivation + checks ---------------- */
  const num = v => (v === '' || v === null || v === undefined || !isFinite(+v)) ? null : +v;

  function derive(P, S) {
    S = Object.assign({}, DEFAULT_SETTINGS, S || {});
    const nodes = new Map(P.nodes.map(n => [n.id, n]));
    const out = new Map(), inn = new Map();
    P.nodes.forEach(n => { out.set(n.id, []); inn.set(n.id, []); });
    const L = P.links.map(l => {
      const pts = linkPts(l, nodes);
      const len = num(l.len) ?? (pts ? pathLength(pts) : null);
      const d = num(l.diam);
      return { l, len, d, pts };
    });
    L.forEach(o => { if (out.has(o.l.from)) out.get(o.l.from).push(o); if (inn.has(o.l.to)) inn.get(o.l.to).push(o); });
    const cover = n => n.sys === 'sanitary' ? S.minCoverSan : S.minCoverStorm;
    const inv = new Map(), invSrc = new Map();
    const maxD = id => {
      const ds = [...out.get(id), ...inn.get(id)].map(o => o.d).filter(x => x);
      return ds.length ? Math.max(...ds) / 1000 : 0.3;
    };
    // 1) entered / from pipes / estimated
    P.nodes.forEach(n => {
      const e = num(n.invert);
      if (e !== null) { inv.set(n.id, e); invSrc.set(n.id, 'entered'); return; }
      const c = [];
      out.get(n.id).forEach(o => { const v = num(o.l.upInv); if (v !== null) c.push(v); });
      inn.get(n.id).forEach(o => { const v = num(o.l.dnInv); if (v !== null) c.push(v); });
      if (c.length) { inv.set(n.id, Math.min(...c)); invSrc.set(n.id, 'from pipe inverts'); return; }
      const rim = num(n.rim);
      if (rim !== null) {
        let depth;
        if (n.kind === 'cb') depth = S.cbDepth;
        else if (n.kind === 'outfall') depth = 0;
        else depth = cover(n) + maxD(n.id);
        inv.set(n.id, rim - depth); invSrc.set(n.id, 'estimated');
        return;
      }
      inv.set(n.id, null); invSrc.set(n.id, 'missing');
    });
    // 2) topological order (upstream first); push estimated nodes down to keep min slope
    const order = topo(P.nodes.map(n => n.id), L, out, inn);
    order.forEach(id => {
      out.get(id).forEach(o => {
        const to = o.l.to; if (!nodes.has(to)) return;
        if (invSrc.get(to) !== 'estimated') return;
        const up = num(o.l.upInv) ?? inv.get(id);
        if (up === null || o.len === null) return;
        const need = up - minSlopeFor(o.d || 300, S.n, S.minVel) * o.len;
        if (inv.get(to) === null || inv.get(to) > need) { inv.set(to, need); }
      });
    });
    // 3) link geometry + checks
    const issues = [];
    const add = (sev, kind, id, msg) => issues.push({ sev, kind, id, msg });
    const ids = new Set();
    [...P.nodes, ...P.links, ...(P.subs || [])].forEach(f => { if (ids.has(f.id)) add('error', f.kind ? 'node' : 'link', f.id, 'Duplicate ID'); ids.add(f.id); });
    const links = new Map();
    L.forEach(o => {
      const l = o.l, fn = nodes.get(l.from), tn = nodes.get(l.to);
      const r = { len: o.len, d: o.d, up: null, dn: null, slope: null, inOff: 0, outOff: 0, minSlope: null, qfull: null, pts: o.pts };
      links.set(l.id, r);
      if (!fn || !tn) { add('error', 'link', l.id, 'Pipe is not connected to two nodes'); return; }
      if (fn.sys !== l.sys || tn.sys !== l.sys) add('warn', 'link', l.id, `System mismatch (${fn.sys} → ${tn.sys}, pipe is ${l.sys})`);
      const chan = !!l.channel || (l.shape && l.shape !== 'CIRCULAR');
      if (!o.d && !chan) add('warn', 'link', l.id, 'Diameter unknown — export uses the City minimum');
      const dmin = l.sys === 'sanitary' ? S.minDiaSan : S.minDiaStorm;
      if (o.d && o.d < dmin && fn.kind !== 'cb' && !chan) add('warn', 'link', l.id, `Diameter ${o.d} mm is below the City minimum ${dmin} mm`);
      r.up = num(l.upInv) ?? inv.get(l.from);
      r.dn = num(l.dnInv) ?? inv.get(l.to);
      const dd = o.d || dmin;
      r.minSlope = minSlopeFor(dd, num(l.n) ?? S.n, S.minVel);
      if (r.up !== null && r.dn !== null && o.len > 0) {
        r.slope = (r.up - r.dn) / o.len;
        r.qfull = fullFlow(dd, num(l.n) ?? S.n, r.slope);
        if (r.slope < 0) add('error', 'link', l.id, `Adverse slope ${(r.slope * 100).toFixed(2)} % — check direction or inverts`);
        else if (!chan && r.slope < r.minSlope * 0.98) add('warn', 'link', l.id, `Slope ${(r.slope * 100).toFixed(2)} % is below ${(r.minSlope * 100).toFixed(2)} % (full-flow velocity ${S.minVel} m/s)`);
      } else add('info', 'link', l.id, 'Slope unknown (missing inverts / rims)');
      const ni = inv.get(l.from), no = inv.get(l.to);
      if (r.up !== null && ni !== null) { r.inOff = r.up - ni; if (r.inOff < -0.005) { add('warn', 'link', l.id, 'Upstream pipe invert is below the node invert'); r.inOff = 0; } }
      if (r.dn !== null && no !== null) { r.outOff = r.dn - no; if (r.outOff < -0.005) { add('warn', 'link', l.id, 'Downstream pipe invert is below the node invert'); r.outOff = 0; } }
      const cv = fn.sys === 'sanitary' ? S.minCoverSan : S.minCoverStorm;
      if (!chan) [[fn, r.up], [tn, r.dn]].forEach(([n, iv]) => {
        const rim = num(n.rim);
        if (rim !== null && iv !== null && n.kind !== 'outfall' && n.kind !== 'cb') {
          const c = rim - iv - dd / 1000;
          if (c < cv - 0.05) add('warn', 'link', l.id, `Cover ${c.toFixed(2)} m at ${n.id} is less than ${cv} m`);
        }
      });
      const sp = (dd <= (l.sys === 'sanitary' ? 1200 : 450)) ? S.spacingSmall : S.spacingLarge;
      if (o.len > sp && fn.kind !== 'cb' && tn.kind !== 'outfall' && !chan) add('warn', 'link', l.id, `Length ${o.len.toFixed(0)} m exceeds ${sp} m MH spacing — a manhole may be missing`);
      if (o.d) out.get(l.to)?.forEach(d2 => { if (d2.d && d2.d < o.d && d2.l.sys === l.sys) add('warn', 'link', d2.l.id, `Smaller than upstream pipe ${l.id} (${d2.d} < ${o.d} mm)`); });
    });
    // nodes
    const reach = reachOutfall(P, out, inn, nodes);
    P.nodes.forEach(n => {
      const deg = out.get(n.id).length + inn.get(n.id).length;
      if (num(n.rim) === null) add('warn', 'node', n.id, 'Rim (ground) elevation missing');
      if (invSrc.get(n.id) === 'estimated') add('info', 'node', n.id, 'Invert estimated from min cover + min slope');
      if (!deg && n.kind !== 'outfall') add('warn', 'node', n.id, 'Not connected to any pipe');
      if (n.kind === 'outfall' && deg > 1) add('error', 'node', n.id, 'SWMM outfalls can connect to only one link');
      if (n.kind === 'outfall' && out.get(n.id).length) add('warn', 'node', n.id, 'Outfall has a pipe leaving it — flip direction?');
      if (deg && !reach.has(n.id) && n.kind !== 'outfall') add('warn', 'node', n.id, 'No downstream path to an outfall / storage');
    });
    (P.subs || []).forEach(s => {
      if (!s.outlet || !nodes.has(s.outlet)) add('error', 'sub', s.id, 'Outlet node missing');
      else if (nodes.get(s.outlet).sys !== s.sys) add('warn', 'sub', s.id, 'Outlet node is in the other system');
      if (!(subArea(s) > 0)) add('warn', 'sub', s.id, 'Area is zero');
      if (s.sys === 'storm' && num(s.imp) === null) add('warn', 'sub', s.id, 'Imperviousness not set — export uses 50 %');
      if (s.sys === 'storm' && num(s.width) === null) add('info', 'sub', s.id, `Width estimated as area / ${num(s.flowLen) || 40} m flow length`);
    });
    const rank = { error: 0, warn: 1, info: 2 };
    issues.sort((a, b) => rank[a.sev] - rank[b.sev]);
    return { inv, invSrc, links, issues, settings: S, out, inn };
  }
  function subArea(s) { const a = num(s.area); return a !== null ? a : (s.coords && s.coords.length > 2 ? polyArea(s.coords) / 10000 : 0); }
  function subWidth(s) { const w = num(s.width); if (w !== null) return w; return subArea(s) * 10000 / (num(s.flowLen) || 40); }
  function linkPts(l, nodes) {
    const a = nodes.get(l.from), b = nodes.get(l.to);
    if (!a || !b) return null;
    return [[a.lat, a.lng], ...(l.verts || []), [b.lat, b.lng]];
  }
  function topo(ids, L, out, inn) {
    const indeg = new Map(ids.map(id => [id, 0]));
    L.forEach(o => { if (indeg.has(o.l.to) && indeg.has(o.l.from)) indeg.set(o.l.to, indeg.get(o.l.to) + 1); });
    const q = ids.filter(id => indeg.get(id) === 0), order = [];
    while (q.length) {
      const id = q.shift(); order.push(id);
      out.get(id).forEach(o => { if (!indeg.has(o.l.to)) return; indeg.set(o.l.to, indeg.get(o.l.to) - 1); if (indeg.get(o.l.to) === 0) q.push(o.l.to); });
    }
    return order; // nodes in cycles are omitted
  }
  function reachOutfall(P, out, inn, nodes) {
    const ok = new Set(), q = [];
    P.nodes.forEach(n => { if (n.kind === 'outfall' || n.kind === 'storage' || n.kind === 'pump') { ok.add(n.id); q.push(n.id); } });
    while (q.length) { const id = q.shift(); inn.get(id).forEach(o => { if (nodes.has(o.l.from) && !ok.has(o.l.from)) { ok.add(o.l.from); q.push(o.l.from); } }); }
    return ok;
  }

  /* ---------------- SWMM .inp writer ---------------- */
  const f = (v, d = 3) => (v === null || v === undefined || !isFinite(v)) ? '0' : (+v).toFixed(d);
  const pad = (s, w) => { s = String(s); return s.length >= w ? s + ' ' : s + ' '.repeat(w - s.length); };
  const row = (...cols) => cols.map((c, i) => pad(c, i === 0 ? 18 : 12)).join('').trimEnd();
  const safeId = s => String(s).replace(/\s+/g, '_').replace(/[;"]/g, '');
  const hhmm = min => `${Math.floor(min / 60)}:${String(Math.round(min % 60)).padStart(2, '0')}`;

  function buildINP(P, S, system) {
    S = Object.assign({}, DEFAULT_SETTINGS, S || {});
    const D = derive(P, S);
    const nodes = P.nodes.filter(n => n.sys === system);
    const nodeIds = new Set(nodes.map(n => n.id));
    const links = P.links.filter(l => l.sys === system && nodeIds.has(l.from) && nodeIds.has(l.to));
    const subs = (P.subs || []).filter(s => s.sys === system && nodeIds.has(s.outlet));
    const zone = S.utmZone || 17;
    const U = p => toUTM(p[0], p[1], zone);
    const L = [];
    const today = new Date().toISOString().slice(0, 10);
    L.push('[TITLE]', `;;Project Title/Notes`, `North Bay ${system} sewer model — draft from North Bay Sewer Mapper (${today})`,
      `Coordinates: NAD83 / UTM zone ${zone}N (m). Elevations: datum of the DEM / drawings used — verify before use.`, '');
    const isStorm = system === 'storm';
    const durH = isStorm ? Math.ceil(S.dur / 60) + 6 : 24;
    const endDay = 1 + Math.floor(durH / 24), endH = durH % 24;
    L.push('[OPTIONS]', ';;Option             Value',
      'FLOW_UNITS           LPS', 'INFILTRATION         HORTON', 'FLOW_ROUTING         DYNWAVE', 'LINK_OFFSETS         DEPTH',
      'MIN_SLOPE            0', 'ALLOW_PONDING        NO', 'SKIP_STEADY_STATE    NO',
      'START_DATE           01/01/2026', 'START_TIME           00:00:00',
      'REPORT_START_DATE    01/01/2026', 'REPORT_START_TIME    00:00:00',
      `END_DATE             01/${String(endDay).padStart(2, '0')}/2026`, `END_TIME             ${String(endH).padStart(2, '0')}:00:00`,
      'DRY_DAYS             0', 'REPORT_STEP          00:01:00', 'WET_STEP             00:01:00', 'DRY_STEP             00:15:00',
      'ROUTING_STEP         0:00:05', 'INERTIAL_DAMPING     PARTIAL', 'NORMAL_FLOW_LIMITED  BOTH', 'FORCE_MAIN_EQUATION  H-W',
      'VARIABLE_STEP        0.75', 'MIN_SURFAREA         1.167', 'MAX_TRIALS           8', 'HEAD_TOLERANCE       0.0015', 'THREADS              1', '');
    const ts = `CHI_${S.rp}YR_${Math.round(S.dur / 60 * 10) / 10}H`.replace('.', 'p');
    if (isStorm) {
      L.push('[RAINGAGES]', ';;Name           Format    Interval SCF      Source',
        row('RG1', 'INTENSITY', hhmm(S.step), '1.0', 'TIMESERIES', ts), '');
    }
    if (isStorm && subs.length) {
      L.push('[SUBCATCHMENTS]', ';;Name           Rain Gage   Outlet      Area(ha)    %Imperv     Width(m)    %Slope      CurbLen');
      subs.forEach(s => {
        if (s.notes) L.push(';' + String(s.notes).replace(/\n/g, ' '));
        L.push(row(safeId(s.id), 'RG1', safeId(s.outlet), f(subArea(s), 4), f(num(s.imp) ?? 50, 1), f(subWidth(s), 1), f(num(s.slope) ?? 1, 2), '0'));
      });
      L.push('', '[SUBAREAS]', ';;Subcatchment   N-Imperv    N-Perv      S-Imperv    S-Perv      PctZero     RouteTo');
      subs.forEach(s => L.push(row(safeId(s.id), f(S.nImp, 3), f(S.nPerv, 3), f(S.dsImp, 2), f(S.dsPerv, 2), f(S.pctZero, 0), 'OUTLET')));
      L.push('', '[INFILTRATION]', ';;Subcatchment   MaxRate     MinRate     Decay       DryTime     MaxInfil');
      subs.forEach(s => L.push(row(safeId(s.id), f(S.hMax, 1), f(S.hMin, 1), f(S.hDecay, 2), f(S.hDry, 1), '0')));
      L.push('');
    }
    const junc = nodes.filter(n => n.kind !== 'outfall' && n.kind !== 'storage' && n.kind !== 'pump');
    const nodeDesc = n => {
      const bits = [];
      if (num(n.rim) !== null) bits.push(`rim ${(+n.rim).toFixed(2)}${n.rimSrc ? ' (' + n.rimSrc + ')' : ''}`);
      bits.push(`invert: ${D.invSrc.get(n.id)}`);
      if (n.conf) bits.push(`confidence ${n.conf}`);
      if (n.drawing) bits.push(`dwg ${n.drawing}`);
      if (n.evidence && n.evidence.length) bits.push('evidence: ' + n.evidence.join('/'));
      return ';' + bits.join('; ');
    };
    const maxDepth = n => { const rim = num(n.rim), iv = D.inv.get(n.id); return (rim !== null && iv !== null) ? Math.max(0, rim - iv) : 0; };
    if (junc.length) {
      L.push('[JUNCTIONS]', ';;Name           Elevation   MaxDepth    InitDepth   SurDepth    Aponded');
      junc.forEach(n => { L.push(nodeDesc(n)); L.push(row(safeId(n.id), f(D.inv.get(n.id)), f(maxDepth(n)), '0', '0', '0')); });
      L.push('');
    }
    const ofs = nodes.filter(n => n.kind === 'outfall');
    if (ofs.length) {
      L.push('[OUTFALLS]', ';;Name           Elevation   Type        Gated');
      ofs.forEach(n => { L.push(nodeDesc(n)); L.push(row(safeId(n.id), f(D.inv.get(n.id)), 'FREE', 'NO')); });
      L.push('');
    }
    const sto = nodes.filter(n => n.kind === 'storage' || n.kind === 'pump');
    if (sto.length) {
      L.push('[STORAGE]', ';;Name           Elev.       MaxDepth    InitDepth   Shape       Curve/Params            SurDepth  Fevap');
      sto.forEach(n => {
        L.push(nodeDesc(n) + (n.kind === 'pump' ? '; PUMP STATION wet well — add [PUMPS] link + pump curve manually' : ''));
        const md = maxDepth(n) || 3;
        L.push(row(safeId(n.id), f(D.inv.get(n.id)), f(md), '0', 'FUNCTIONAL', '0', '0', f(num(n.area) ?? (n.kind === 'pump' ? 10 : 500), 1), '0', '0'));
      });
      L.push('');
    }
    if (links.length) {
      L.push('[CONDUITS]', ';;Name           From Node   To Node     Length      Roughness   InOffset    OutOffset   InitFlow    MaxFlow');
      links.forEach(l => {
        const r = D.links.get(l.id);
        const bits = [];
        if (l.material) bits.push(l.material);
        if (l.conf) bits.push('confidence ' + l.conf);
        if (l.drawing) bits.push('dwg ' + l.drawing);
        if (!num(l.diam)) bits.push('DIAMETER ASSUMED');
        if (bits.length) L.push(';' + bits.join('; '));
        L.push(row(safeId(l.id), safeId(l.from), safeId(l.to), f(Math.max(r.len || 1, 1), 2), f(num(l.n) ?? S.n, 4), f(Math.max(0, r.inOff), 3), f(Math.max(0, r.outOff), 3), '0', '0'));
      });
      L.push('', '[XSECTIONS]', ';;Link           Shape       Geom1       Geom2       Geom3       Geom4       Barrels');
      links.forEach(l => {
        const dmin = l.sys === 'sanitary' ? S.minDiaSan : S.minDiaStorm;
        if (l.channel) L.push(row(safeId(l.id), 'TRAPEZOIDAL', f(l.channel.depth, 3), f(l.channel.bottom ?? 0.5, 3), f(l.channel.side ?? 2, 2), f(l.channel.side ?? 2, 2), '1'));
        else L.push(row(safeId(l.id), l.shape || 'CIRCULAR', f((num(l.diam) || dmin) / 1000, 3), '0', '0', '0', '1'));
      });
      L.push('');
    }
    if (!isStorm) {
      const dwf = new Map();
      nodes.forEach(n => { const q = (num(n.pop) || 0) * S.perCap / 86400 + (num(n.dwf) || 0); if (q > 0) dwf.set(n.id, q); });
      subs.forEach(s => {
        const q = (num(s.pop) || 0) * S.perCap / 86400 + subArea(s) * (num(s.ii) ?? S.iiRate);
        if (q > 0) dwf.set(s.outlet, (dwf.get(s.outlet) || 0) + q);
      });
      if (dwf.size) {
        L.push('[DWF]', `;;Node           Constituent Baseline(L/s)  ; ${S.perCap} L/cap/d + I/I allowance (City guideline design values)`);
        dwf.forEach((q, id) => L.push(row(safeId(id), 'FLOW', f(q, 4))));
        L.push('');
      }
    }
    if (isStorm) {
      const hy = chicago(S.rp, S.dur, S.step, S.r);
      L.push('[TIMESERIES]', `;;Chicago storm, City of North Bay IDF ${S.rp}-yr (a,b,c = ${IDF[S.rp].join(', ')}), r = ${S.r}, mm/h`);
      hy.forEach((v, k) => L.push(row(ts, hhmm(k * S.step), f(v, 2))));
      L.push(row(ts, hhmm(hy.length * S.step), '0'));
      L.push('');
    }
    L.push('[REPORT]', 'INPUT      NO', 'CONTROLS   NO', 'SUBCATCHMENTS ALL', 'NODES ALL', 'LINKS ALL', '');
    const xy = [];
    nodes.forEach(n => xy.push(U([n.lat, n.lng])));
    subs.forEach(s => s.coords.forEach(c => xy.push(U(c))));
    if (xy.length) {
      const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
      const m = 50;
      L.push('[MAP]', `DIMENSIONS ${f(Math.min(...xs) - m, 2)} ${f(Math.min(...ys) - m, 2)} ${f(Math.max(...xs) + m, 2)} ${f(Math.max(...ys) + m, 2)}`, 'Units      Meters', '');
    }
    L.push('[COORDINATES]', ';;Node           X-Coord            Y-Coord');
    nodes.forEach(n => { const p = U([n.lat, n.lng]); L.push(pad(safeId(n.id), 18) + pad(f(p[0], 3), 19) + f(p[1], 3)); });
    L.push('');
    const withV = links.filter(l => l.verts && l.verts.length);
    if (withV.length) {
      L.push('[VERTICES]', ';;Link           X-Coord            Y-Coord');
      withV.forEach(l => l.verts.forEach(v => { const p = U(v); L.push(pad(safeId(l.id), 18) + pad(f(p[0], 3), 19) + f(p[1], 3)); }));
      L.push('');
    }
    if (subs.length && isStorm) {
      L.push('[Polygons]', ';;Subcatchment   X-Coord            Y-Coord');
      subs.forEach(s => s.coords.forEach(c => { const p = U(c); L.push(pad(safeId(s.id), 18) + pad(f(p[0], 3), 19) + f(p[1], 3)); }));
      L.push('');
    }
    if (isStorm && xy.length) {
      const xs = xy.map(p => p[0]), ys = xy.map(p => p[1]);
      L.push('[SYMBOLS]', ';;Gage           X-Coord            Y-Coord', pad('RG1', 18) + pad(f(Math.min(...xs), 3), 19) + f(Math.max(...ys) + 30, 3), '');
    }
    const problems = D.issues.filter(i => i.sev !== 'info' && (
      (i.kind === 'node' && nodeIds.has(i.id)) || (i.kind === 'link' && links.some(l => l.id === i.id)) || (i.kind === 'sub' && subs.some(s => s.id === i.id))));
    const head = [`;; Generated by North Bay Sewer Mapper — DRAFT. ${nodes.length} nodes, ${links.length} conduits, ${isStorm ? subs.length + ' subcatchments' : subs.length + ' sewershed(s) as dry-weather flow'}.`];
    if (problems.length) {
      head.push(`;; ${problems.length} open issue(s) at export:`);
      problems.slice(0, 60).forEach(i => head.push(`;;   [${i.sev}] ${i.id}: ${i.msg}`));
    }
    return { text: head.join('\n') + '\n\n' + L.join('\n'), counts: { nodes: nodes.length, links: links.length, subs: subs.length }, problems };
  }

  /* ---------------- DEM grid analysis ----------------
     Grid: { w, h, z: Float32Array (NaN = nodata), x0, y0 (EPSG:3857 top-left),
             res (3857 m/cell), cell (ground m/cell), src } */
  function gridBounds(g) { const sw = unmerc(g.x0, g.y0 - g.h * g.res), ne = unmerc(g.x0 + g.w * g.res, g.y0); return [sw, ne]; }
  function gridPx(g, lat, lng) { const [mx, my] = merc(lat, lng); return [(mx - g.x0) / g.res - 0.5, (g.y0 - my) / g.res - 0.5]; }
  function gridLatLng(g, c, r) { return unmerc(g.x0 + (c + 0.5) * g.res, g.y0 - (r + 0.5) * g.res); }
  function sampleGrid(g, lat, lng) {
    const [x, y] = gridPx(g, lat, lng);
    const c0 = Math.floor(x), r0 = Math.floor(y);
    if (c0 < 0 || r0 < 0 || c0 >= g.w - 1 || r0 >= g.h - 1) {
      const c = Math.round(x), r = Math.round(y);
      if (c < 0 || r < 0 || c >= g.w || r >= g.h) return NaN;
      return g.z[r * g.w + c];
    }
    const fx = x - c0, fy = y - r0, i = r0 * g.w + c0, z = g.z;
    const v = [z[i], z[i + 1], z[i + g.w], z[i + g.w + 1]];
    if (v.some(Number.isNaN)) return z[Math.round(y) * g.w + Math.round(x)];
    return v[0] * (1 - fx) * (1 - fy) + v[1] * fx * (1 - fy) + v[2] * (1 - fx) * fy + v[3] * fx * fy;
  }
  const DX = [1, 1, 0, -1, -1, -1, 0, 1], DY = [0, 1, 1, 1, 0, -1, -1, -1];

  class Heap {
    constructor(cap) { this.k = new Float64Array(cap); this.v = new Int32Array(cap); this.n = 0; }
    push(key, val) {
      if (this.n === this.k.length) { const k = new Float64Array(this.n * 2), v = new Int32Array(this.n * 2); k.set(this.k); v.set(this.v); this.k = k; this.v = v; }
      let i = this.n++; const K = this.k, V = this.v;
      while (i > 0) { const p = (i - 1) >> 1; if (K[p] <= key) break; K[i] = K[p]; V[i] = V[p]; i = p; }
      K[i] = key; V[i] = val;
    }
    pop() {
      const K = this.k, V = this.v, top = V[0]; const key = K[--this.n], val = V[this.n];
      let i = 0;
      for (;;) { let c = 2 * i + 1; if (c >= this.n) break; if (c + 1 < this.n && K[c + 1] < K[c]) c++; if (K[c] >= key) break; K[i] = K[c]; V[i] = V[c]; i = c; }
      K[i] = key; V[i] = val; return top;
    }
  }

  function analyse(g) {
    const { w, h, z } = g, n = w * h, EPS = 1e-4;
    const fill = new Float64Array(n), closed = new Uint8Array(n), heap = new Heap(Math.max(1024, 2 * (w + h)));
    for (let i = 0; i < n; i++) if (Number.isNaN(z[i])) { closed[i] = 1; fill[i] = NaN; }
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c; if (closed[i]) continue;
      let edge = r === 0 || c === 0 || r === h - 1 || c === w - 1;
      if (!edge) for (let k = 0; k < 8; k++) if (Number.isNaN(z[i + DY[k] * w + DX[k]])) { edge = true; break; }
      if (edge) { closed[i] = 1; fill[i] = z[i]; heap.push(z[i], i); }
    }
    while (heap.n) {
      const i = heap.pop(), c = i % w, r = (i - c) / w;
      for (let k = 0; k < 8; k++) {
        const cc = c + DX[k], rr = r + DY[k];
        if (cc < 0 || rr < 0 || cc >= w || rr >= h) continue;
        const j = rr * w + cc; if (closed[j]) continue;
        closed[j] = 1; fill[j] = Math.max(z[j], fill[i] + EPS); heap.push(fill[j], j);
      }
    }
    // D8 receivers on the conditioned surface
    const rec = new Int32Array(n).fill(-1), D = [1, Math.SQRT2];
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const i = r * w + c; if (Number.isNaN(fill[i])) continue;
      let best = 0, bj = -1;
      for (let k = 0; k < 8; k++) {
        const cc = c + DX[k], rr = r + DY[k]; if (cc < 0 || rr < 0 || cc >= w || rr >= h) continue;
        const j = rr * w + cc; const fj = fill[j]; if (Number.isNaN(fj)) continue;
        const s = (fill[i] - fj) / D[k & 1];
        if (s > best) { best = s; bj = j; }
      }
      rec[i] = bj;
    }
    // accumulation (Kahn)
    const indeg = new Int32Array(n), acc = new Float32Array(n);
    for (let i = 0; i < n; i++) { if (!Number.isNaN(fill[i])) acc[i] = 1; if (rec[i] >= 0) indeg[rec[i]]++; }
    const q = new Int32Array(n); let qh = 0, qt = 0;
    for (let i = 0; i < n; i++) if (!Number.isNaN(fill[i]) && indeg[i] === 0) q[qt++] = i;
    while (qh < qt) { const i = q[qh++], j = rec[i]; if (j >= 0) { acc[j] += acc[i]; if (--indeg[j] === 0) q[qt++] = j; } }
    return { fill, rec, acc };
  }

  function sinks(g, A, minDepth = 0.05, minCells = 2) {
    const { w, h, z } = g, n = w * h, { fill } = A, lab = new Int32Array(n).fill(-1), out = [];
    const ca = g.cell * g.cell;
    for (let i = 0; i < n; i++) {
      if (lab[i] >= 0 || !(fill[i] - z[i] >= minDepth)) continue;
      const id = out.length, st = [i]; lab[i] = id;
      let cnt = 0, maxd = 0, vol = 0, low = i;
      while (st.length) {
        const k = st.pop(), d = fill[k] - z[k]; cnt++; vol += d * ca; if (d > maxd) maxd = d; if (z[k] < z[low]) low = k;
        const c = k % w, r = (k - c) / w;
        for (let m = 0; m < 8; m++) {
          const cc = c + DX[m], rr = r + DY[m]; if (cc < 0 || rr < 0 || cc >= w || rr >= h) continue;
          const j = rr * w + cc; if (lab[j] < 0 && fill[j] - z[j] >= minDepth * 0.5) { lab[j] = id; st.push(j); }
        }
      }
      out.push({ cells: cnt, area: cnt * ca, depth: maxd, vol, low, c: low % w, r: Math.floor(low / w) });
    }
    return out.filter(s => s.cells >= minCells).sort((a, b) => b.vol - a.vol);
  }

  function watershed(g, A, c0, r0, snapR = 4) {
    const { w, h } = g, { rec, acc } = A;
    let best = -1, bv = -1;
    for (let r = Math.max(0, r0 - snapR); r <= Math.min(h - 1, r0 + snapR); r++)
      for (let c = Math.max(0, c0 - snapR); c <= Math.min(w - 1, c0 + snapR); c++) {
        const i = r * w + c; if (acc[i] > bv) { bv = acc[i]; best = i; }
      }
    if (best < 0) return null;
    const n = w * h, mask = new Uint8Array(n), dist = new Float32Array(n), q = [best]; mask[best] = 1;
    // upstream: neighbours whose receiver is the current cell
    for (let qi = 0; qi < q.length; qi++) {
      const i = q[qi], c = i % w, r = (i - c) / w;
      for (let k = 0; k < 8; k++) {
        const cc = c + DX[k], rr = r + DY[k]; if (cc < 0 || rr < 0 || cc >= w || rr >= h) continue;
        const j = rr * w + cc; if (!mask[j] && rec[j] === i) { mask[j] = 1; dist[j] = dist[i] + g.cell * ((k & 1) ? Math.SQRT2 : 1); q.push(j); }
      }
    }
    let sl = 0, sn = 0, dsum = 0, dmax = 0;
    q.forEach(i => {
      dsum += dist[i]; if (dist[i] > dmax) dmax = dist[i];
      const c = i % w, r = (i - c) / w; if (c < 1 || r < 1 || c >= w - 1 || r >= h - 1) return;
      const Z = (dc, dr) => g.z[(r + dr) * w + c + dc];
      const zx = ((Z(1, -1) + 2 * Z(1, 0) + Z(1, 1)) - (Z(-1, -1) + 2 * Z(-1, 0) + Z(-1, 1))) / (8 * g.cell);
      const zy = ((Z(-1, 1) + 2 * Z(0, 1) + Z(1, 1)) - (Z(-1, -1) + 2 * Z(0, -1) + Z(1, -1))) / (8 * g.cell);
      const s = Math.hypot(zx, zy); if (isFinite(s)) { sl += s; sn++; }
    });
    const area = q.length * g.cell * g.cell;
    const ring = traceMask(mask, w, h);
    return { outlet: best, cells: q.length, area, slope: sn ? sl / sn * 100 : null, meanLen: q.length ? dsum / q.length : 0, maxLen: dmax, ring: simplify(ring, 1.2), mask };
  }

  // Moore-neighbour boundary trace of the component containing the first masked cell
  function traceMask(mask, w, h) {
    const M = (c, r) => c >= 0 && r >= 0 && c < w && r < h && mask[r * w + c] === 1;
    let s = -1; for (let i = 0; i < w * h; i++) if (mask[i]) { s = i; break; }
    if (s < 0) return [];
    const sc = s % w, sr = (s - sc) / w;
    // clockwise neighbourhood starting at W
    const NX = [-1, -1, 0, 1, 1, 1, 0, -1], NY = [0, -1, -1, -1, 0, 1, 1, 1];
    const ring = [[sc, sr]];
    let pc = sc, pr = sr, bdir = 0, atStart = false; // came from the west
    for (let guard = 0; guard < 4 * w * h; guard++) {
      let found = false;
      for (let t = 1; t <= 8; t++) {
        const d = (bdir + t) % 8, cc = pc + NX[d], rr = pr + NY[d];
        if (M(cc, rr)) {
          const prevd = (bdir + t - 1) % 8;
          // new backtrack = the empty neighbour just before, expressed relative to the new cell
          const bx = pc + NX[prevd], by = pr + NY[prevd];
          pc = cc; pr = rr;
          bdir = NX.findIndex((x, k) => pc + x === bx && pr + NY[k] === by);
          if (bdir < 0) bdir = (d + 4) % 8;
          found = true; break;
        }
      }
      if (!found) break; // isolated pixel
      // Jacob's stopping criterion: back at start and about to repeat the first move
      if (atStart && ring.length > 1 && pc === ring[1][0] && pr === ring[1][1]) break;
      atStart = pc === sc && pr === sr;
      ring.push([pc, pr]);
    }
    if (ring.length > 1) { const l = ring[ring.length - 1]; if (l[0] === sc && l[1] === sr) ring.pop(); }
    return ring;
  }
  function simplify(pts, tol) {
    if (pts.length < 4) return pts;
    const keep = new Uint8Array(pts.length); keep[0] = keep[pts.length - 1] = 1;
    const st = [[0, pts.length - 1]];
    while (st.length) {
      const [a, b] = st.pop(); let md = 0, mi = -1;
      const [x1, y1] = pts[a], [x2, y2] = pts[b], L = Math.hypot(x2 - x1, y2 - y1) || 1e-9;
      for (let i = a + 1; i < b; i++) {
        const d = Math.abs((y2 - y1) * pts[i][0] - (x2 - x1) * pts[i][1] + x2 * y1 - y2 * x1) / L;
        if (d > md) { md = d; mi = i; }
      }
      if (md > tol) { keep[mi] = 1; st.push([a, mi], [mi, b]); }
    }
    return pts.filter((_, i) => keep[i]);
  }

  function hillshade(g, zf = 2, az = 315, alt = 45) {
    const { w, h, z } = g, out = new Float32Array(w * h).fill(NaN);
    const zr = (90 - alt) * RAD, ar = (360 - az + 90) * RAD, cz = Math.cos(zr), sz = Math.sin(zr);
    for (let r = 1; r < h - 1; r++) for (let c = 1; c < w - 1; c++) {
      const Z = (dc, dr) => z[(r + dr) * w + c + dc];
      const a = Z(-1, -1), b = Z(0, -1), cc = Z(1, -1), d = Z(-1, 0), f = Z(1, 0), gg = Z(-1, 1), hh = Z(0, 1), ii = Z(1, 1);
      const dzdx = ((cc + 2 * f + ii) - (a + 2 * d + gg)) / (8 * g.cell);
      const dzdy = ((gg + 2 * hh + ii) - (a + 2 * b + cc)) / (8 * g.cell);
      const slope = Math.atan(zf * Math.hypot(dzdx, dzdy));
      let aspect = Math.atan2(dzdy, -dzdx); if (aspect < 0) aspect += 2 * Math.PI;
      out[r * w + c] = Math.max(0, cz * Math.cos(slope) + sz * Math.sin(slope) * Math.cos(ar - aspect));
    }
    return out;
  }
  function percentile(arr, p) {
    const v = []; for (let i = 0; i < arr.length; i += Math.max(1, Math.floor(arr.length / 20000))) if (!Number.isNaN(arr[i])) v.push(arr[i]);
    v.sort((a, b) => a - b); return v.length ? v[Math.min(v.length - 1, Math.floor(p * v.length))] : NaN;
  }
  // Resample any source raster into a 3857-aligned grid. srcSample(lat,lng) -> elevation|NaN
  function resampleTo3857(bbox, srcSample, targetGround, maxCells = 1100, src = 'local DEM') {
    const [s, w0, n, e] = bbox; // lat/lng
    const [x0, y1] = merc(s, w0), [x1, y0] = merc(n, e);
    const latc = (s + n) / 2, cosl = Math.cos(latc * RAD);
    let res = targetGround / cosl;
    const W0 = (x1 - x0) / res, H0 = (y0 - y1) / res;
    if (Math.max(W0, H0) > maxCells) res *= Math.max(W0, H0) / maxCells;
    const w = Math.max(2, Math.round((x1 - x0) / res)), h = Math.max(2, Math.round((y0 - y1) / res));
    const z = new Float32Array(w * h);
    for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) {
      const [lat, lng] = unmerc(x0 + (c + 0.5) * res, y0 - (r + 0.5) * res);
      z[r * w + c] = srcSample(lat, lng);
    }
    return { w, h, z, x0, y0, res, cell: res * cosl, src };
  }

  return {
    IDF, LANDUSE, DEFAULT_SETTINGS, toUTM, fromUTM, merc, unmerc, dist, pathLength, polyArea, bearing,
    chicago, idfIntensity, minSlopeFor, fullFlow, derive, buildINP, num, subArea, subWidth,
    gridBounds, gridPx, gridLatLng, sampleGrid, analyse, sinks, watershed, traceMask, simplify, hillshade, percentile, resampleTo3857
  };
})();
if (typeof module !== 'undefined') module.exports = NB;
