import asyncio, json, re, zipfile
from playwright.async_api import async_playwright
import os, subprocess
from PIL import Image
for k, c in {'gray': (105,105,108), 'soil': (150,112,72), 'gray2': (100,102,104)}.items():
    if not os.path.exists(f'test/tile_{k}.png'): Image.new('RGB', (256,256), c).save(f'test/tile_{k}.png')
if not os.path.exists('test/osm.json'): open('test/osm.json','w').write(subprocess.check_output(['node','test/gen_osm.js']).decode())
STUB = open('test/lstub.js').read()
OSM = open('test/osm.json').read()
T = {k: open(f'test/tile_{k}.png','rb').read() for k in ['gray','soil','gray2']}
REL = {30001:'2025-10-01', 30002:'2024-08-01', 30003:'2021-05-10'}
CONFIG = json.dumps({str(n): {"itemTitle": f"World Imagery (Wayback {d})", "itemURL": f"https://wayback.maptiles.arcgis.com/arcgis/rest/services/World_Imagery/WMTS/1.0.0/default028mm/MapServer/tile/{n}/{{level}}/{{row}}/{{col}}", "metadataLayerUrl": f"https://metadata.maptiles.arcgis.com/arcgis/rest/services/M{n}/MapServer"} for n,d in REL.items()})
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1400,'height':900}, accept_downloads=True)
        errs = []; pg.on('pageerror', lambda e: errs.append('PAGEERROR '+str(e)))
        hits = {}
        async def route(r):
            u = r.request.url; host = u.split('/')[2] if '://' in u else ''
            hits[host] = hits.get(host,0)+1
            hdr = {'Access-Control-Allow-Origin':'*'}
            if 'leaflet' in u and u.endswith('.js'): return await r.fulfill(body=STUB, content_type='application/javascript')
            if u.startswith('file://'): return await r.continue_()
            if 'overpass' in u: return await r.fulfill(body=OSM, content_type='application/json', headers=hdr)
            if 'waybackconfig' in u: return await r.fulfill(body=CONFIG, content_type='application/json', headers=hdr)
            m = re.search(r'/tilemap/(\d+)/', u)
            if m: return await r.fulfill(body=json.dumps({"data":[1],"select":[int(m.group(1))]}), content_type='application/json', headers=hdr)
            m = re.search(r'/tile/(\d+)/', u)
            if m and 'wayback' in u:
                n = int(m.group(1)); return await r.fulfill(body=T['soil'] if n==30002 else T['gray'] if n==30001 else T['gray2'], content_type='image/png', headers=hdr)
            m = re.search(r'/M(\d+)/MapServer/identify', u)
            if m: return await r.fulfill(body=json.dumps({"results":[{"attributes":{"SRC_DATE2": {30001:1727740800000,30002:1720051200000,30003:1620000000000}[int(m.group(1))], "SAMP_RES":0.3,"NICE_DESC":"Maxar"}}]}), content_type='application/json', headers=hdr)
            return await r.abort()
        await pg.route('**/*', route)
        await pg.goto('file://' + __import__('os').path.abspath('index.html')); await pg.wait_for_timeout(800)
        out = await pg.evaluate('''async () => {
          const lat0=46.300,lng0=-79.470,k=111320,cs=Math.cos(lat0*Math.PI/180);
          const bb=[lat0, lng0-0.0002, lat0+800/k, lng0+1000/(k*cs)+0.0002];
          window.studyBbox = () => bb; map.getZoom = () => 16;
          // synthetic lidar grid covering bbox
          const [x0,y1]=NB.merc(bb[0]-0.001,bb[1]-0.001), [x1,y0]=NB.merc(bb[2]+0.001,bb[3]+0.001), res=1.45;
          const w=Math.round((x1-x0)/res), h=Math.round((y0-y1)/res), z=new Float32Array(w*h);
          for(let r=0;r<h;r++)for(let c=0;c<w;c++){ const [la,lo]=NB.unmerc(x0+(c+.5)*res,y0-(r+.5)*res); const x=(lo-lng0)*k*cs, y=(la-lat0)*k; let v=200+0.025*y+0.004*x; const dx=Math.abs(x-960); if(dx>4&&dx<11&&y>100) v-=0.6; z[r*w+c]=v; }
          setGrid({w,h,z,x0,y0,res,cell:res*cs,src:'synthetic lidar',quality:'lidar'});
          await new Promise(r=>setTimeout(r,300));
          showPanelTab('auto');
          await runAuto();
          const o = {};
          o.steps = [...document.querySelectorAll('#steps .li')].map(e=>e.className.split(' ').pop()+' | '+e.innerText.replace(/\\n/g,' ').slice(0,260));
          o.counts = {nodes:S.P.nodes.length, links:S.P.links.length, subs:S.P.subs.length};
          o.acc = document.querySelector('#accuracy table')?.innerText;
          o.queue = document.querySelector('#queue').innerText.slice(0,400);
          o.events = document.querySelectorAll('#events .li').length;
          o.evidence = S.P.links.filter(l=>(l.evidence||[]).some(e=>e.startsWith('exposed'))).length;
          // review some
          for (let i=0;i<8;i++) queueAct(i%3===2?'flip':'ok');
          queueAct('no');
          o.validate = NBI.validate(S.P);
          o.acc2 = document.querySelector('#accuracy').innerText.slice(-400);
          o.issueKinds = (()=>{const m={}; S.derived.issues.filter(i=>i.sev!=='info').forEach(i=>{const k=i.sev+' '+i.msg.replace(/[\d.-]+/g,'#').replace(/(SA|ST|OF|SO)-#/g,'X'); m[k]=(m[k]||0)+1}); return m;})();
          o.issues = S.derived.issues.filter(i=>i.sev!=='info').length + ' non-info issues; errors: ' + S.derived.issues.filter(i=>i.sev==='error').map(i=>i.id+' '+i.msg).slice(0,5).join(' | ');
          // calibration rerun
          S.P.links.filter(l=>l.verified && l.upInv!=='').forEach(l=>{ l.upInv = +(l.upInv-0.5).toFixed(3); l.dnInv = l.dnInv!==''? +(l.dnInv-0.5).toFixed(3):''; });
          afterChange();
          const before = S.P.links.filter(l=>l.verified).length;
          document.querySelector('#calib').click(); await new Promise(r=>setTimeout(r,200));
          while (AUTO.running) await new Promise(r=>setTimeout(r,200));
          o.afterCalib = {noPath: S.derived.issues.filter(i=>/No downstream/.test(i.msg)).length, errors: S.derived.issues.filter(i=>i.sev==='error').length, verifiedKept: S.P.links.filter(l=>l.verified).length, before, extraCover:S.inferSettings.extraCover, links:S.P.links.length, rejectedEdges:(S.P.removedInferred||[]).length, dupEdges: (()=>{const m={};S.P.links.forEach(l=>{if(l.edge){m[l.sys+l.edge]=(m[l.sys+l.edge]||0)+1}});return Object.values(m).filter(v=>v>1).length})()};
          const np = S.derived.issues.filter(i=>/No downstream/.test(i.msg)).map(i=>i.id);
          const nodes = new Map(S.P.nodes.map(n=>[n.id,n]));
          o.noPathSample = np.slice(0,6).map(id=>{ const outs=S.P.links.filter(l=>l.from===id).map(l=>l.id+'>'+l.to+(l.verified?'(v)':'')); const n=nodes.get(id); return id+' '+n.kind+' '+n.sys+' vid='+n.vid+' outs='+outs.join(','); });
          o.removed = S.P.removedInferred;
          o.outlets = S.P.nodes.filter(n=>n.kind==='outfall'||n.kind==='pump').map(n=>n.id+':'+n.sys+':'+n.notes).slice(0,12);
          return o;
        }''')
        print(json.dumps(out, indent=1))
        await pg.evaluate("showPanelTab('export')")
        async with pg.expect_download() as dl: await pg.click('#ensStorm')
        d = await dl.value; await d.save_as('test/ens.zip')
        z = zipfile.ZipFile('test/ens.zip'); print('zip files', len(z.namelist()), z.namelist()[:3], 'testzip', z.testzip())
        print('zip r01 head', z.read(z.namelist()[0]).decode()[:200])
        async with pg.expect_download() as dl: await pg.click('#expUnc')
        d = await dl.value; await d.save_as('test/unc.csv'); print(open('test/unc.csv').read()[:400])
        await pg.evaluate("showPanelTab('auto')"); await pg.wait_for_timeout(200)
        await pg.screenshot(path='test/shot_auto.png', full_page=False)
        await pg.evaluate("document.querySelector('#tabsBody').scrollTop = 1200"); await pg.wait_for_timeout(100)
        await pg.screenshot(path='test/shot_auto2.png')
        print('hosts', hits)
        print('\\n'.join(errs) or 'NO PAGE ERRORS')
        await b.close()
asyncio.run(main())
