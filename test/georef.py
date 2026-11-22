import asyncio
from playwright.async_api import async_playwright
STUB = open('./test/lstub.js').read()
async def main():
    async with async_playwright() as p:
        b = await p.chromium.launch(executable_path='/usr/bin/google-chrome', args=['--no-sandbox'])
        pg = await b.new_page(viewport={'width':1400,'height':900})
        errs=[]; pg.on('pageerror', lambda e: errs.append(str(e)))
        async def route(r):
            u=r.request.url
            if 'leaflet' in u and u.endswith('.js'): await r.fulfill(body=STUB, content_type='application/javascript')
            elif u.startswith('file://') : await r.continue_()
            else: await r.abort()
        await pg.route('**/*', route)
        await pg.goto('file://' + __import__('os').path.abspath('index.html')); await pg.wait_for_timeout(500)
        await pg.evaluate("showPanelTab('clues')")
        await pg.set_input_files('#dwgFile', 'test/shot_guide.png'); await pg.wait_for_timeout(500)
        print('modal hidden?', await pg.evaluate("document.querySelector('#modal').hidden"))
        box = await pg.query_selector('#dwgImg'); bb = await box.bounding_box(); print('img box', bb)
        for fx,fy in [(0.1,0.1),(0.9,0.15),(0.5,0.9)]:
            await pg.mouse.click(bb['x']+bb['width']*fx, bb['y']+bb['height']*fy)
        print('src', await pg.evaluate("S.dwg.src.map(p=>p.map(v=>Math.round(v)))"), 'next enabled', await pg.evaluate("!document.querySelector('#dwgNext').disabled"))
        await pg.click('#dwgZoomIn'); await pg.click('#dwgZoomFit')
        await pg.screenshot(path='test/shot_modal.png')
        await pg.click('#dwgNext')
        print('mode', await pg.evaluate("S.mode"))
        await pg.screenshot(path='test/shot_georef.png')
        r = await pg.evaluate("""(()=>{ const M=[[0,0,1],[100,0,1],[0,50,1]]; // affine x=2u+0.5v+10, y=-u+3v+5
          const X=M.map(([u,v])=>2*u+0.5*v+10), Y=M.map(([u,v])=>-u+3*v+5); return [solve3(M,X), solve3(M,Y)]; })()""")
        print('solve3', r)
        print('errors', errs or 'none')
        await b.close()
asyncio.run(main())
