"""Read-only management UI smoke check against an isolated preview."""
import asyncio
import json
import os
import time

from playwright.async_api import async_playwright


async def main():
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel='chrome', headless=True)
        page = await browser.new_page(viewport={'width': 1440, 'height': 960})
        errors = []
        page.on('pageerror', lambda error: errors.append(str(error)))
        started = time.perf_counter()
        await page.goto(os.environ.get('LIBRARY_TEST_URL', 'http://127.0.0.1:3011'))
        await page.wait_for_selector('.work-card')
        initial = round((time.perf_counter() - started) * 1000, 1)
        await page.locator('.thumb[data-work]').first.click()
        await page.wait_for_selector('#modal video')
        await page.keyboard.press('Escape')
        await page.locator('[data-view="authors"]').click()
        await page.wait_for_selector('.author-entry')
        await page.locator('[data-view="works"]').click()
        await page.wait_for_selector('.work-card')
        # A slower old search must be cancelled and must never overwrite the latest search.
        async def delay(route):
            if 'bench_slow' in route.request.url:
                await asyncio.sleep(.6)
            await route.continue_()
        await page.route('**/api/catalog/works?**', delay)
        aborted = []
        page.on('requestfailed', lambda request: aborted.append(request.url))
        await page.locator('#search').fill('bench_slow')
        await page.wait_for_timeout(300)
        await page.locator('#search').fill('bench_latest_no_match')
        await page.wait_for_function("()=>document.querySelector('#results').getAttribute('aria-busy')==='false' && location.hash.includes('bench_latest')")
        await page.wait_for_timeout(700)
        assert '没有符合条件' in await page.locator('#results').inner_text()
        assert any('bench_slow' in url for url in aborted), aborted
        assert not errors, errors
        print(json.dumps({'initialListMs': initial, 'preview': True, 'authors': True,
                          'supersededRequestAborted': True, 'pageErrors': errors}))
        await browser.close()


asyncio.run(main())
