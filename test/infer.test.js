global.NB = require('../src/core.js');
const NBI = require('../src/infer.js');
const assert = (c, m) => { if (!c) { console.error('FAIL', m); process.exitCode = 1; } else console.log('ok  ', m); };
const lat0 = 46.300, lng0 = -79.470, k = 111320, cs = Math.cos(lat0 * Math.PI / 180);
const ll = (x, y) => [lat0 + y / k, lng0 + x / (k * cs)];
const W = 1000, H = 800;
const ruralX = 960; // rural road with ditches
function zAt(lat, lng) {
  const x = (lng - lng0) * k * cs, y = (lat - lat0) * k;
  let z = 200 + 0.025 * y + 0.004 * x;           // rises north (lake to the south)
  const dx = Math.abs(x - ruralX); if (dx > 4 && dx < 11 && y > 100) z -= 0.6; // ditches both sides
  return z;
}
// streets: E-W at y = 100..700 step 100 ; N-S at x = 0..960 step 120 (+ rural at 960)
const xs = [0, 120, 240, 360, 480, 600, 720, 840, 960], ys = [100, 200, 300, 400, 500, 600, 700];
const id = (x, y) => `n${x}_${y}`, roads = [];
let wid = 1;
ys.forEach(y => { const nodes = [], geom = []; xs.forEach((x, i) => { nodes.push(id(x, y)); geom.push(ll(x, y)); if (i < xs.length - 1) { nodes.push(id(x + 60, y)); geom.push(ll(x + 60, y)); } }); roads.push({ id: wid++, tags: { highway: 'residential', name: `E-W ${y}` }, nodes, geom }); });
xs.forEach(x => { const nodes = [], geom = []; ys.forEach((y, i) => { nodes.push(id(x, y)); geom.push(ll(x, y)); if (i < ys.length - 1) { nodes.push(id(x, y + 50)); geom.push(ll(x, y + 50)); } }); roads.push({ id: wid++, tags: { highway: x === ruralX ? 'unclassified' : 'residential', name: `N-S ${x}` }, nodes, geom }); });
// lakeshore road
roads.push({ id: wid++, tags: { highway: 'tertiary', name: 'Lakeshore' }, nodes: [id(0, 100), 'L1', 'L2', id(960, 100)].slice(0, 2).concat([]), geom: [] });
roads.pop();
// buildings: houses along E-W streets (both sides), not along rural road; park block x 480-600, y 300-400 empty
const buildings = [];
const house = (cx, cy) => { const g = [[-6, -5], [6, -5], [6, 5], [-6, 5], [-6, -5]].map(([dx, dy]) => ll(cx + dx, cy + dy)); buildings.push({ tags: { building: 'house' }, geom: g }); };
ys.forEach(y => { for (let x = 10; x < 940; x += 22) { if (x > 470 && x < 610 && y >= 300 && y <= 400) continue; if (xs.some(xx => Math.abs(xx - x) < 12)) continue; house(x, y + 20); if (y > 100) house(x, y - 20); } });
const waters = [[ll(-50, 45), ll(1100, 45)]];
const plants = [{ lat: ll(1000, 60)[0], lng: ll(1000, 60)[1], kind: 'wwtp', name: 'WPCP' }];
const bbox = [lat0, lng0 - 0.0002, lat0 + H / k, lng0 + W / (k * cs) + 0.0002];
console.time('infer');
const res = NBI.infer({ bbox, roads, buildings, waters, plants, zAt, demQuality: 'lidar', demName: 'synthetic lidar' }, {});
console.timeEnd('infer');
console.log(res.log.join('\n'), res.allocInfo);
const st = res.links.filter(l => l.sys === 'storm'), sa = res.links.filter(l => l.sys === 'sanitary');
console.log('storm links', st.length, 'san links', sa.length, 'nodes', res.nodes.length, 'subs', res.subs.length);
// directions: storm should drain south (to lower y), check fraction of links with dn rim <= up rim
const node = new Map(res.nodes.map(n => [n.id, n]));
const down = st.filter(l => !l.inf.outletPipe && +node.get(l.from).rim >= +node.get(l.to).rim - 0.01).length / st.filter(l => !l.inf.outletPipe).length;
console.log('storm downhill fraction', down.toFixed(3));
assert(down > 0.9, 'storm pipes run downhill');
const ditches = st.filter(l => l.inf.ditch);
console.log('ditch links', ditches.length, ditches.slice(0, 2).map(l => [l.id, l.upInv, l.dnInv, l.channel]));
assert(ditches.length >= 4, 'rural road modelled as ditch');
const outf = res.nodes.filter(n => n.kind === 'outfall');
console.log('outfalls', outf.map(n => n.id + ' ' + n.notes));
outf.forEach(o => assert(res.links.filter(l => l.to === o.id || l.from === o.id).length === 1, `outfall ${o.id} has one link`));
const sanOut = res.nodes.filter(n => n.sys === 'sanitary' && (n.kind === 'outfall' || n.kind === 'pump'));
console.log('san outlets', sanOut.map(n => n.id + ' ' + n.notes));
assert(sanOut.some(n => /Wastewater/.test(n.notes)), 'sanitary reaches the WPCP');
const pops = res.nodes.reduce((s, n) => s + (+n.pop || 0), 0); console.log('pop assigned', pops.toFixed(0), 'houses', buildings.length);
assert(Math.abs(pops - buildings.length * 2.24) / (buildings.length * 2.24) < 0.1, 'population conserved');
const subA = res.subs.reduce((s, x) => s + x.area, 0); console.log('sub area ha', subA.toFixed(2), 'bbox ha', (W * H / 1e4).toFixed(1), 'imp avg', (res.subs.reduce((s, x) => s + x.imp * x.area, 0) / subA).toFixed(1));
assert(subA > 50 && subA < 90, 'subcatchments cover most of the area');
assert(res.subs.every(s => node.has(s.outlet)), 'every subcatchment has an outlet node');
// sizes increase downstream
const byFrom = new Map(); res.links.forEach(l => { if (!byFrom.has(l.from)) byFrom.set(l.from, []); byFrom.get(l.from).push(l); });
let dec = 0, tot = 0; res.links.forEach(l => { if (!l.diam) return; (byFrom.get(l.to) || []).forEach(m => { if (m.diam && m.sys === l.sys) { tot++; if (+m.diam < +l.diam) dec++; } }); });
console.log('downstream decreases', dec, '/', tot);
assert(dec === 0, 'no downstream size decrease');
const sizes = {}; res.links.forEach(l => { if (l.diam) sizes[l.sys + ' ' + l.diam] = (sizes[l.sys + ' ' + l.diam] || 0) + 1; }); console.log(sizes);
console.log('stats', JSON.stringify(res.stats, null, 0));
// SWMM export of the inferred model
const P = { nodes: res.nodes, links: res.links, subs: res.subs };
const D = NB.derive(P, {});
const errs = D.issues.filter(i => i.sev === 'error'); console.log('derive errors', errs.length, errs.slice(0, 5));
assert(errs.length === 0, 'no model errors');
const warns = {}; D.issues.filter(i => i.sev === 'warn').forEach(i => { const k = i.msg.replace(/[\d.]+/g, '#'); warns[k] = (warns[k] || 0) + 1; }); console.log(warns);
const inp = NB.buildINP(P, {}, 'storm'); require('fs').writeFileSync(__dirname + '/inferred_storm.inp', inp.text);
const inp2 = NB.buildINP(P, {}, 'sanitary'); require('fs').writeFileSync(__dirname + '/inferred_san.inp', inp2.text);
console.log('inp sizes', inp.text.length, inp2.text.length);
// ensemble
const R1 = NBI.sampleRealisation(P, 1), R2 = NBI.sampleRealisation(P, 2);
const diff = R1.links.filter((l, i) => l.diam !== R2.links[i].diam).length; console.log('ensemble diam differences', diff);
assert(diff > 0, 'ensemble varies');
// validation
P.links.slice(0, 20).forEach((l, i) => { l.verified = true; if (i % 4 === 0 && l.diam) l.diam = NBI.DIAMS[NBI.DIAMS.indexOf(+l.diam) + 1]; if (l.upInv !== '') l.upInv = +(l.upInv - 0.6).toFixed(2); });
console.log('validate', NBI.validate(P));
const up = st.filter(l => !l.inf.outletPipe && +node.get(l.from).rim < +node.get(l.to).rim - 0.01);
console.log('UPHILL sample', up.slice(0, 12).map(l => `${l.id} ${l.edge} ${node.get(l.from).rim}->${node.get(l.to).rim} g=${l.inf.grade} ${l.inf.street} pDir=${l.inf.pDir}`));
const D2 = NB.derive({ nodes: res.nodes, links: res.links, subs: res.subs }, {});
D2.issues.filter(i => /Adverse/.test(i.msg)).forEach(i => { const l = res.links.find(x => x.id === i.id); console.log('ADV', i.id, i.msg, JSON.stringify({ from: l.from, to: l.to, up: l.upInv, dn: l.dnInv, len: l.len, ditch: l.inf.ditch, notes: l.notes, fromN: res.nodes.find(n => n.id === l.from)?.kind, toN: res.nodes.find(n => n.id === l.to) })); });
