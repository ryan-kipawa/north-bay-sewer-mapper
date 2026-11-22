import asyncio, json, sys
from playwright.async_api import async_playwright
STUB = open('./test/lstub.js').read()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1400,'height':900}, accept_downloads=True)
        errs = []
        pg.on('pageerror', lambda e: errs.append('PAGEERROR ' + str(e)))
        pg.on('console', lambda m: errs.append('CONSOLE ' + m.type + ' ' + m.text) if m.type in ('error','warning') else None)
        async def route(r):
            u = r.request.url
            if 'leaflet' in u and u.endswith('.js'): await r.fulfill(body=STUB, content_type='application/javascript')
            elif u.startswith('file://'): await r.continue_()
            else: await r.abort()
        await pg.route('**/*', route)
        await pg.goto('file://' + __import__('os').path.abspath('index.html'))
        await pg.wait_for_timeout(800)
        res = await pg.evaluate('''async () => {
          const out = {};
          // build a small network via internal functions
          addNode('mh','storm',[46.3100,-79.4600]);
          addNode('mh','storm',[46.3092,-79.4600]);
          addNode('outfall','storm',[46.3085,-79.4600]);
          addNode('cb','storm',[46.3100,-79.4602]);
          addNode('mh','sanitary',[46.3100,-79.4598]);
          addNode('mh','sanitary',[46.3092,-79.4598]);
          addNode('outfall','sanitary',[46.3086,-79.4598]);
          S.P.nodes.forEach((n,i)=>{ n.rim = 205 - i*0.8; n.rimSrc='test'; });
          createLink('ST-001','ST-002',[[46.3096,-79.46005]]);
          createLink('ST-002','OF-001');
          createLink('CB-001','ST-001');
          createLink('SA-001','SA-002'); createLink('SA-002','SO-001');
          createSub('storm', [[46.3102,-79.4605],[46.3102,-79.4598],[46.3098,-79.4598],[46.3098,-79.4605]]);
          createSub('sanitary', [[46.3102,-79.4605],[46.3102,-79.4598],[46.3098,-79.4598]], {pop: 150});
          out.nodes = S.P.nodes.map(n=>n.id); out.links = S.P.links.map(l=>l.id+':'+l.from+'>'+l.to); out.subs = S.P.subs.map(s=>s.id+'>'+s.outlet);
          // editor for each type
          select('node','ST-001'); out.edNode = document.querySelector('#editor').innerText.slice(0,120);
          select('link','C-ST-001'); out.edLink = document.querySelector('#editor').innerText.slice(0,200);
          select('sub','S-001'); out.edSub = document.querySelector('#editor').innerText.slice(0,200);
          // change a field via the form
          select('link','C-ST-001');
          const d = document.querySelector('#editor [data-f=diam]'); d.value = 375; d.dispatchEvent(new Event('change',{bubbles:true}));
          out.diam = getLink('C-ST-001').diam;
          // rename node
          select('node','ST-002'); const idf = document.querySelector('#editor [data-f=id]'); idf.value='MH-9'; idf.dispatchEvent(new Event('change',{bubbles:true}));
          out.renamed = S.P.links.filter(l=>l.from==='MH-9'||l.to==='MH-9').map(l=>l.id);
          splitLink('C-ST-002'); out.afterSplit = S.P.links.map(l=>l.id+':'+l.from+'>'+l.to);
          flipLink('C-CB-001'); flipLink('C-CB-001');
          undo();
          out.issues = S.derived.issues.map(i=>i.sev+' '+i.id+' '+i.msg);
          out.summary = document.querySelector('#summary').innerText;
          const r = NB.buildINP(S.P, S.settings, 'storm'); out.inpHead = r.text.split('\\n').slice(0,6);
          out.inpSections = r.text.split('\\n').filter(x=>x.startsWith('['));
          const r2 = NB.buildINP(S.P, S.settings, 'sanitary'); out.sanSections = r2.text.split('\\n').filter(x=>x.startsWith('[')); out.dwf = r2.text.split('\\n').filter(x=>/FLOW/.test(x) && !x.startsWith(';'));
          // geojson round trip
          const gj = toGeoJSON(); out.gjCount = gj.features.length;
          // modes
          ['add:mh:storm','pipe','sub:storm','profile','street','pan'].forEach(m=>setMode(m));
          mapClick({latlng:{lat:46.311,lng:-79.461}});
          // DEM synthetic grid
          const w=120,h=100,z=new Float32Array(w*h);
          for(let r=0;r<h;r++)for(let c=0;c<w;c++) z[r*w+c]=200+0.03*c+0.01*Math.abs(r-50)-(Math.hypot(c-60,r-40)<5?0.25:0);
          const [x0,y0]=NB.merc(46.3105,-79.4612);
          setGrid({w,h,z,x0,y0,res:1.4,cell:1.4*Math.cos(46.31*Math.PI/180),src:'synthetic'});
          await new Promise(r=>setTimeout(r,200));
          S.demOn.flow = true; S.demOn.sinks = true; renderDem();
          out.dem = document.querySelector('#demStatus').innerText;
          const ll = NB.gridLatLng(S.grid, 5, 50); runShed({lat:ll[0], lng:ll[1]});
          out.shed = document.querySelector('#shedCard').innerText.slice(0,200);
          document.querySelector('#shedMake').click();
          out.subsAfterShed = S.P.subs.map(s=>s.id+' '+NB.subArea(s).toFixed(3)+'ha w='+s.width+' slope='+s.slope);
          out.elev = await getElevation(ll[0], ll[1]);
          await runProfile([[46.3100,-79.4610],[46.3095,-79.4590]]);
          out.profile = document.querySelector('#profileOut').innerText;
          select('sub', S.P.subs[S.P.subs.length-1].id);
          document.querySelector('#editor [data-a=subterrain]')?.click();
          out.subSlope = S.P.subs[S.P.subs.length-1].slope;
          // tabs & guide
          ['imagery','terrain','clues','model','export','guide'].forEach(t=>showPanelTab(t));
          out.storm = document.querySelector('#stormInfo').innerText;
          out.proj = document.querySelectorAll('#projList .li').length;
          out.wb = document.querySelector('#scanStatus').innerText;
          return out;
        }''')
        print(json.dumps(res, indent=1, default=str))
        # export downloads
        await pg.evaluate("showPanelTab('export')")
        async with pg.expect_download() as dl:
            await pg.click('#expSan')
        d = await dl.value; await d.save_as('./test/app_san.inp')
        print('download', d.suggested_filename)
        for t in ['imagery','terrain','clues','model','export','guide']:
            await pg.evaluate(f"showPanelTab('{t}')"); await pg.wait_for_timeout(100)
            await pg.screenshot(path=f'./test/shot_{t}.png')
        await pg.evaluate("select('link','C-ST-001'); setMode('pipe'); S.draft={from:'ST-001',verts:[]}; updateHint();")
        await pg.screenshot(path='./test/shot_edit.png')
        await pg.set_viewport_size({'width':390,'height':844})
        await pg.evaluate("setMode('pan'); showPanelTab('model')")
        await pg.wait_for_timeout(300)
        await pg.screenshot(path='./test/shot_mobile.png')
        print('\n'.join(errs) or 'NO ERRORS')
        await b.close()
asyncio.run(main())
