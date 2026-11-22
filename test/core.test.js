const NB = require('../src/core.js');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
// UTM roundtrip + known value (North Bay City Hall approx 46.3091,-79.4608)
const [x, y] = NB.toUTM(46.3091, -79.4608);
console.log('UTM', x.toFixed(2), y.toFixed(2));
const [la, lo] = NB.fromUTM(x, y);
assert(Math.abs(la - 46.3091) < 1e-7 && Math.abs(lo + 79.4608) < 1e-7, 'UTM roundtrip');
assert(x > 600000 && x < 640000 && y > 5120000 && y < 5140000, 'UTM plausible for North Bay');
// Merc roundtrip
const m = NB.merc(46.3, -79.4); const u = NB.unmerc(...m);
assert(Math.abs(u[0] - 46.3) < 1e-9 && Math.abs(u[1] + 79.4) < 1e-9, 'merc roundtrip');
// distance ~ 111 m per 0.001 deg lat
const d = NB.dist([46.3, -79.4], [46.301, -79.4]); console.log('dist', d);
assert(Math.abs(d - 111.15) < 0.5, 'distance');
// Chicago storm total == IDF depth for full duration
for (const rp of ['2', '5', '100']) {
  const hy = NB.chicago(rp, 240, 5, 0.38);
  const tot = hy.reduce((s, v) => s + v * 5 / 60, 0);
  const idf = NB.idfIntensity(rp, 240) * 4;
  console.log(rp, 'yr chicago depth', tot.toFixed(2), 'idf', idf.toFixed(2), 'peak', Math.max(...hy).toFixed(1));
  assert(Math.abs(tot - idf) / idf < 0.01, `chicago ${rp} volume matches IDF`);
  // 5-min peak block ~ IDF 5 min intensity
  assert(Math.abs(Math.max(...hy) - NB.idfIntensity(rp, 5)) / NB.idfIntensity(rp, 5) < 0.06, `chicago ${rp} peak ~ 5-min IDF`);
}
// min slope 200 mm, n .013, 0.6 m/s
const s200 = NB.minSlopeFor(200, 0.013, 0.6); console.log('min slope 200', (s200 * 100).toFixed(3), '%');
assert(Math.abs(s200 - 0.0033) < 0.0002, 'min slope 200mm ~0.33%');
// Network + INP
const P = {
  nodes: [
    { id: 'ST-001', kind: 'mh', sys: 'storm', lat: 46.3100, lng: -79.4600, rim: 205.0, rimSrc: 'test' },
    { id: 'ST-002', kind: 'mh', sys: 'storm', lat: 46.3092, lng: -79.4600, rim: 203.5 },
    { id: 'CB-001', kind: 'cb', sys: 'storm', lat: 46.3100, lng: -79.4602, rim: 204.9 },
    { id: 'OF-001', kind: 'outfall', sys: 'storm', lat: 46.3085, lng: -79.4600, rim: 199.0, invert: 198.8 },
    { id: 'SA-001', kind: 'mh', sys: 'sanitary', lat: 46.3100, lng: -79.4598, rim: 205.0, pop: 120 },
    { id: 'SA-002', kind: 'mh', sys: 'sanitary', lat: 46.3092, lng: -79.4598, rim: 203.4, invert: 200.2 },
    { id: 'SA-OUT', kind: 'outfall', sys: 'sanitary', lat: 46.3086, lng: -79.4598, rim: 202, invert: 199.9 },
  ],
  links: [
    { id: 'C-ST-001', from: 'ST-001', to: 'ST-002', sys: 'storm', diam: 300 },
    { id: 'C-ST-002', from: 'ST-002', to: 'OF-001', sys: 'storm', diam: 375 },
    { id: 'C-CB-001', from: 'CB-001', to: 'ST-001', sys: 'storm', diam: 200 },
    { id: 'C-SA-001', from: 'SA-001', to: 'SA-002', sys: 'sanitary', diam: 200, upInv: 202.9 },
    { id: 'C-SA-002', from: 'SA-002', to: 'SA-OUT', sys: 'sanitary', diam: 250 },
  ],
  subs: [{ id: 'S-001', sys: 'storm', outlet: 'CB-001', area: 0.42, imp: 43, width: 60, slope: 2, coords: [[46.3102, -79.4605], [46.3102, -79.4598], [46.3098, -79.4598], [46.3098, -79.4605]] },
         { id: 'SS-001', sys: 'sanitary', outlet: 'SA-001', area: 2, pop: 200, coords: [[46.3102, -79.4605], [46.3102, -79.4598], [46.3098, -79.4598]] }]
};
const D = NB.derive(P, {});
console.log(D.issues.map(i => `${i.sev} ${i.id} ${i.msg}`).join('\n'));
console.log([...D.inv].map(([k, v]) => k + '=' + (v && v.toFixed(3)) + ' ' + D.invSrc.get(k)).join('\n'));
assert(D.invSrc.get('ST-001') === 'estimated', 'estimated invert');
assert(Math.abs(D.inv.get('ST-001') - (205 - 1.5 - 0.3)) < 1e-9, 'est invert = rim - cover - maxD');
const r = D.links.get('C-ST-001'); assert(r.slope > 0, 'positive slope storm');
const s = NB.buildINP(P, {}, 'storm');
require('fs').writeFileSync(__dirname + '/storm.inp', s.text);
const sa = NB.buildINP(P, {}, 'sanitary');
require('fs').writeFileSync(__dirname + '/san.inp', sa.text);
assert(/\[DWF\][\s\S]*SA-001\s+FLOW\s+([\d.]+)/.test(sa.text), 'DWF present');
const q = +sa.text.match(/SA-001\s+FLOW\s+([\d.]+)/)[1]; const qexp = 120 * 450 / 86400 + 200 * 450 / 86400 + 2 * 0.44;
assert(Math.abs(q - qexp) < 1e-3, `DWF value ${q} ~ ${qexp.toFixed(4)}`);
// DEM: synthetic bowl + slope
const w = 60, h = 50, z = new Float32Array(w * h);
for (let r = 0; r < h; r++) for (let c = 0; c < w; c++) z[r * w + c] = 200 + 0.05 * c + 0.02 * Math.abs(r - 25) - (Math.hypot(c - 30, r - 20) < 4 ? 0.3 : 0);
const [x0, y0] = NB.merc(46.31, -79.47);
const g = { w, h, z, x0, y0, res: 1.4, cell: 1.4 * Math.cos(46.31 * Math.PI / 180) };
console.time('analyse'); const A = NB.analyse(g); console.timeEnd('analyse');
const sk = NB.sinks(g, A, 0.05);
console.log('sinks', sk.slice(0, 3).map(s => [s.c, s.r, s.depth.toFixed(2), s.area.toFixed(1)]));
assert(sk.length >= 1 && Math.abs(sk[0].c - 30) <= 4 && Math.abs(sk[0].r - 20) <= 4, 'sink found at bowl');
const ws = NB.watershed(g, A, 0, 25, 3);
console.log('watershed cells', ws.cells, 'area', ws.area.toFixed(0), 'ring', ws.ring.length, 'slope', ws.slope.toFixed(2), 'meanLen', ws.meanLen.toFixed(1));
assert(ws.cells > 100, 'watershed has area');
assert(ws.ring.length >= 4, 'ring traced');
// big grid perf
const W = 900, H = 900, Z = new Float32Array(W * H); for (let i = 0; i < W * H; i++) Z[i] = 200 + Math.sin(i % W / 40) + Math.cos(Math.floor(i / W) / 33) + Math.random() * 0.05;
console.time('analyse 900²'); const A2 = NB.analyse({ w: W, h: H, z: Z, x0, y0, res: 1, cell: 0.7 }); console.timeEnd('analyse 900²');
console.time('sinks'); const s2 = NB.sinks({ w: W, h: H, z: Z, cell: 0.7 }, A2, 0.05); console.timeEnd('sinks'); console.log('n sinks', s2.length);
// trace mask: square
const mk = new Uint8Array(100); for (let r = 2; r < 7; r++) for (let c = 3; c < 8; c++) mk[r * 10 + c] = 1;
const ring = NB.traceMask(mk, 10, 10); console.log('ring', JSON.stringify(ring));
assert(ring.length === 16, 'square ring has 16 boundary cells');
// L-shape trace
const mk2 = new Uint8Array(100); [[2,2],[3,2],[4,2],[2,3],[2,4],[3,4]].forEach(([c,r])=>mk2[r*10+c]=1);
console.log('L ring', JSON.stringify(NB.traceMask(mk2, 10, 10)));

// pinch shape: two blobs joined at start corner
const mk3 = new Uint8Array(100); [[2,2],[3,2],[2,3],[3,3],[1,1],[0,1],[1,0]].forEach(([c,r])=>mk3[r*10+c]=1);
const r3 = NB.traceMask(mk3,10,10); console.log('pinch ring', JSON.stringify(r3));
assert(r3.some(p=>p[0]===3&&p[1]===3), 'pinch: traced through to second blob');
