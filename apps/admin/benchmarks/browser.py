"""Read-only real Chrome benchmark; --url points at a local preview or deployed service."""
import argparse
import asyncio
import json
import statistics
import time

from playwright.async_api import async_playwright


async def main():
    parser = argparse.ArgumentParser()
    parser.add_argument('--url', default='http://127.0.0.1:3012')
    args = parser.parse_args()
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel='chrome', headless=True)
        runs = []
        for _ in range(5):
            context = await browser.new_context(viewport={'width': 390, 'height': 844},
                                                is_mobile=True, has_touch=True)
            page = await context.new_page()
            errors = []
            page.on('pageerror', lambda error: errors.append(str(error)))
            await page.add_init_script("""window.benchTasks=[];
                new PerformanceObserver(list=>window.benchTasks.push(...list.getEntries().map(x=>x.duration)))
                .observe({type:'longtask',buffered:true});""")
            started = time.perf_counter()
            await page.goto(args.url, wait_until='domcontentloaded')
            await page.wait_for_function("()=>[...document.querySelectorAll('video')].some(v=>v.currentTime>0&&!v.paused)", timeout=60000)
            first_play = (time.perf_counter() - started) * 1000
            # Visit later cards using the same visible controls as the user.
            switches = []
            for _ in range(3):
                started = time.perf_counter()
                await page.keyboard.press('ArrowDown')
                await page.wait_for_timeout(250)
                await page.wait_for_function("()=>[...document.querySelectorAll('video')].some(v=>v.currentTime>0&&!v.paused)", timeout=30000)
                switches.append(round((time.perf_counter() - started) * 1000, 1))
            metrics = await page.evaluate("""()=>({cards:document.querySelectorAll('.slide').length,
                sources:[...document.querySelectorAll('video')].filter(v=>v.hasAttribute('src')).length,
                playing:[...document.querySelectorAll('video')].filter(v=>!v.paused).length,
                longTasks:window.benchTasks,
                api:performance.getEntriesByType('resource').filter(x=>x.name.includes('/api/catalog/')).map(x=>({path:new URL(x.name).pathname,durationMs:Math.round(x.duration)}))})""")
            assert metrics['playing'] == 1 and metrics['sources'] <= 3, metrics
            assert not errors, errors
            runs.append({'firstPlayMs': round(first_play, 1), 'switchMs': switches, **metrics})
            await context.close()
        await browser.close()
        print(json.dumps({'runs': runs, 'firstPlayMedianMs': statistics.median(r['firstPlayMs'] for r in runs),
                          'note': 'Real local library; concurrent downloads and media choice vary. Switch includes a fixed 250ms observation wait.'}, indent=2))


asyncio.run(main())
