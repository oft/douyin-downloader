"""Optional real-browser check: ../.venv/bin/python tests/browser_check.py from video-web."""
import asyncio
import json
import os
from pathlib import Path

from playwright.async_api import async_playwright


async def main():
    base = os.environ.get("VIDEO_TEST_URL", "https://douyin.home.zqzyz.com")
    async with async_playwright() as playwright:
        browser = await playwright.chromium.launch(channel="chrome", headless=True)
        context = await browser.new_context(
            viewport={"width": 390, "height": 844}, is_mobile=True,
            has_touch=True, device_scale_factor=1,
        )
        page = await context.new_page()
        errors = []
        page.on("pageerror", lambda error: errors.append(str(error)))
        await page.goto(base, wait_until="domcontentloaded")
        await page.wait_for_selector(".slide", timeout=30000)
        await page.wait_for_function(
            "() => [...document.querySelectorAll('video')].some(v=>v.currentTime>0 && !v.paused)",
            timeout=30000,
        )
        metrics = await page.evaluate("""()=>({
          width:innerWidth, height:innerHeight,
          scrollWidth:document.documentElement.scrollWidth,
          feedHeight:document.getElementById('feed').clientHeight,
          slideHeight:document.querySelector('.slide').clientHeight,
          playing:[...document.querySelectorAll('video')].filter(v=>!v.paused).length,
          videoSources:[...document.querySelectorAll('video')].filter(v=>v.hasAttribute('src')).length
        })""")
        assert metrics["width"] == metrics["scrollWidth"] == 390, metrics
        assert metrics["feedHeight"] == metrics["slideHeight"] == 782, metrics
        assert metrics["playing"] == 1 and metrics["videoSources"] <= 3, metrics
        assert await page.locator("#sound-hint").is_visible()
        await page.locator("#sound-hint").tap()
        assert await page.locator("video").first.evaluate("v=>v.muted") is False
        assert await page.evaluate("localStorage.getItem('video-web:muted')") == "false"
        assert not await page.locator("#sound-hint").is_visible()
        print(json.dumps({"mobile": metrics}), flush=True)
        await page.screenshot(path="/private/tmp/douyin-video-mobile.png")
        await page.locator(".slide").first.locator(".play-hit").tap()
        await page.wait_for_function("() => document.querySelector('video').paused")
        await page.locator(".slide").first.locator(".play-hit").tap()
        await page.wait_for_function("() => !document.querySelector('video').paused")

        session = await context.new_cdp_session(page)
        await session.send("Input.dispatchTouchEvent", {
            "type": "touchStart", "touchPoints": [{"x": 170, "y": 650}],
        })
        for y in [600, 530, 440, 340, 240, 140]:
            await session.send("Input.dispatchTouchEvent", {
                "type": "touchMove", "touchPoints": [{"x": 170, "y": y}],
            })
            await page.wait_for_timeout(35)
        await session.send("Input.dispatchTouchEvent", {"type": "touchEnd", "touchPoints": []})
        await page.wait_for_function("() => document.getElementById('feed').scrollTop >= 780")
        await page.wait_for_function("() => document.querySelector('video').paused")
        await page.wait_for_function("() => [...document.querySelectorAll('video')].filter(v=>!v.paused).length===1")
        swipe = await page.evaluate("""()=>({
          scrollTop:document.getElementById('feed').scrollTop,
          height:document.getElementById('feed').clientHeight,
          playing:[...document.querySelectorAll('video')].filter(v=>!v.paused).length
        })""")
        print(json.dumps({"touchSwipe": swipe, "tapPauseResume": True}), flush=True)

        index = await page.evaluate("Math.round(document.getElementById('feed').scrollTop/document.getElementById('feed').clientHeight)")
        current = page.locator(".slide").nth(index)
        save = current.locator('[data-action="save"]')
        await save.click()
        assert await save.get_attribute("aria-pressed") == "true"
        await page.locator("#saved-button").click()
        await page.wait_for_selector(".slide")
        await page.wait_for_function("() => document.querySelectorAll('.slide').length===1")
        assert await page.locator('.slide [data-action="save"]').get_attribute("aria-pressed") == "true"
        # A new video inherits enabled sound. Toggling mute twice preserves that choice.
        assert await page.locator("video").first.evaluate("v=>v.muted") is False
        await page.locator("#sound-button").click()
        assert await page.locator("video").first.evaluate("v=>v.muted") is True
        await page.locator("#sound-button").click()
        assert await page.locator("video").first.evaluate("v=>v.muted") is False
        await page.wait_for_function("() => Number.isFinite(document.querySelector('video').duration)")
        await page.locator(".progress").first.fill("500")
        await page.wait_for_function("() => {const v=document.querySelector('video'); return v.currentTime/v.duration>=0.49;}")
        print(json.dumps({"favorites": True, "sound": True, "seek": True}), flush=True)

        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_selector(".slide")
        await page.wait_for_function("() => [...document.querySelectorAll('video')].some(v=>!v.paused)")
        assert await page.evaluate("localStorage.getItem('video-web:muted')") == "false"
        if await page.locator("#sound-hint").is_visible():
            await page.locator("#sound-hint").tap()
        await page.wait_for_function("() => [...document.querySelectorAll('video')].some(v=>!v.paused && !v.muted)")
        await page.locator("#sound-button").click()
        await page.reload(wait_until="domcontentloaded")
        await page.wait_for_selector(".slide")
        await page.wait_for_function("() => [...document.querySelectorAll('video')].some(v=>!v.paused)")
        assert await page.evaluate("localStorage.getItem('video-web:muted')") == "true"
        assert not await page.locator("#sound-hint").is_visible()
        print(json.dumps({"soundChoiceSurvivesReload": True, "explicitMuteRespected": True}), flush=True)

        await page.locator("#search-button").click()
        await page.locator("#search-input").fill("__video_web_no_matching_work_9f46__")
        await page.locator('#search-form button[type="submit"]').click()
        await page.wait_for_function("() => document.getElementById('state-title').textContent==='还没有找到视频'")
        await page.locator("#authors-button").click()
        await page.wait_for_selector(".author-row")
        assert await page.locator(".author-row").count() > 0
        await page.locator('#authors-dialog [data-close]').click()
        assert not errors, errors
        print(json.dumps({"searchEmptyState": True, "authorBrowser": True, "pageErrors": errors}), flush=True)

        desktop = await browser.new_context(viewport={"width": 1440, "height": 1000})
        desktop_page = await desktop.new_page()
        await desktop_page.goto(base, wait_until="domcontentloaded")
        await desktop_page.wait_for_selector(".slide")
        assert await desktop_page.locator(".desktop-controls").is_visible()
        await desktop_page.screenshot(path="/private/tmp/douyin-video-desktop.png")
        await desktop_page.evaluate("""() => {
          const feed = document.getElementById('feed');
          new MutationObserver(() => {
            if (feed.classList.contains('is-moving')) window.switchStarted = performance.now();
            else if (window.switchStarted) window.switchDuration = performance.now() - window.switchStarted;
          }).observe(feed, {attributes:true, attributeFilter:['class']});
        }""")
        await desktop_page.keyboard.press("ArrowDown")
        await desktop_page.wait_for_function("() => window.switchDuration>0")
        transition_ms = await desktop_page.evaluate("window.switchDuration")
        assert transition_ms < 300, transition_ms
        assert await desktop_page.evaluate("Math.round(document.getElementById('feed').scrollTop/document.getElementById('feed').clientHeight)") == 1
        await desktop_page.locator("#feed").hover()
        # Multiple wheel inertia events belong to one gesture, even with a very large delta.
        for delta in [1500, 800, 300, 100, 40, 15]:
            await desktop_page.mouse.wheel(0, delta)
            await desktop_page.wait_for_timeout(35)
        await desktop_page.wait_for_function("() => !document.getElementById('feed').classList.contains('is-moving')")
        assert await desktop_page.evaluate("Math.round(document.getElementById('feed').scrollTop/document.getElementById('feed').clientHeight)") == 2
        print(json.dumps({"desktop": True, "keyboardNavigation": True, "transitionMs": round(transition_ms), "wheelOneVideoPerGesture": True}), flush=True)

        # Deterministically exercise browsers that require a new gesture after a reload.
        blocked_context = await browser.new_context(viewport={"width": 390, "height": 844})
        await blocked_context.add_init_script("""(() => {
          localStorage.setItem('video-web:muted', 'false');
          let gestureReceived = false;
          document.addEventListener('click', () => { gestureReceived = true; }, true);
          const originalPlay = HTMLMediaElement.prototype.play;
          HTMLMediaElement.prototype.play = function() {
            if (!this.muted && !gestureReceived)
              return Promise.reject(new DOMException('Gesture required by test', 'NotAllowedError'));
            return originalPlay.call(this);
          };
        })();""")
        blocked_page = await blocked_context.new_page()
        await blocked_page.goto(base, wait_until="domcontentloaded")
        await blocked_page.wait_for_selector("#sound-hint:visible")
        await blocked_page.wait_for_function("() => [...document.querySelectorAll('video')].some(v=>!v.paused && v.muted)")
        assert await blocked_page.evaluate("localStorage.getItem('video-web:muted')") == "false"
        await blocked_page.locator("#sound-hint").click()
        await blocked_page.wait_for_function("() => [...document.querySelectorAll('video')].some(v=>!v.paused && !v.muted)")
        print(json.dumps({"autoplayDeniedFallback": True, "enableSoundGesture": True}), flush=True)
        Path("/private/tmp/douyin-video-browser-acceptance.json").write_text(
            json.dumps({"mobile": metrics, "touchSwipe": swipe, "pageErrors": errors,
                        "favorites": True, "sound": True, "seek": True, "desktop": True,
                        "soundChoiceSurvivesReload": True, "explicitMuteRespected": True,
                        "autoplayDeniedFallback": True, "enableSoundGesture": True,
                        "transitionMs": round(transition_ms), "wheelOneVideoPerGesture": True}, indent=2)
        )
        await browser.close()


if __name__ == "__main__":
    asyncio.run(main())
