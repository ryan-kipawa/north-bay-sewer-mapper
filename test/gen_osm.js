// Synthetic Overpass JSON for the same town used in infer.test.js
const lat0 = 46.300, lng0 = -79.470, k = 111320, cs = Math.cos(lat0 * Math.PI / 180);
const ll = (x, y) => ({ lat: +(lat0 + y / k).toFixed(7), lon: +(lng0 + x / (k * cs)).toFixed(7) });
const xs = [0, 120, 240, 360, 480, 600, 720, 840, 960], ys = [100, 200, 300, 400, 500, 600, 700];
const el = []; let id = 1;
ys.forEach(y => { const g = []; xs.forEach((x, i) => { g.push(ll(x, y)); if (i < xs.length - 1) g.push(ll(x + 60, y)); }); el.push({ type: 'way', id: id++, tags: { highway: 'residential', name: `Street ${y / 100}` }, geometry: g }); });
xs.forEach(x => { const g = []; ys.forEach((y, i) => { g.push(ll(x, y)); if (i < ys.length - 1) g.push(ll(x, y + 50)); }); el.push({ type: 'way', id: id++, tags: { highway: x === 960 ? 'unclassified' : 'residential', name: `Avenue ${x / 120}` }, geometry: g }); });
ys.forEach(y => { for (let x = 10; x < 940; x += 22) { if (x > 470 && x < 610 && y >= 300 && y <= 400) continue; if (xs.some(xx => Math.abs(xx - x) < 12)) continue; [y + 20, y > 100 ? y - 20 : null].forEach(cy => { if (cy === null) return; el.push({ type: 'way', id: id++, tags: { building: 'house' }, geometry: [[-6, -5], [6, -5], [6, 5], [-6, 5], [-6, -5]].map(([dx, dy]) => ll(x + dx, cy + dy)) }); }); } });
el.push({ type: 'way', id: id++, tags: { waterway: 'stream', name: 'Test Creek' }, geometry: [ll(-50, 45), ll(1100, 45)] });
el.push({ type: 'node', id: id++, tags: { man_made: 'wastewater_plant', name: 'Test WPCP' }, ...ll(1000, 60) });
process.stdout.write(JSON.stringify({ elements: el }));
