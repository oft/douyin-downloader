"""Execute the extraction script against isolated DOM doubles, without a browser."""

import asyncio
import json
import shutil
from types import SimpleNamespace

import pytest

from core.api_client import DouyinAPIClient


@pytest.mark.parametrize("has_post_list", [True, False])
async def test_dom_ids_are_limited_to_author_post_cards_not_recommendations_or_html(has_post_list):
    node = shutil.which("node")
    if not node:
        pytest.skip("Node is only needed to run the offline extraction-script test")
    owned = ["7411111111111111111", "7422222222222222222"]
    foreign = [str(7433333333333333330 + index) for index in range(8)]

    async def evaluate(script):
        fixture = json.dumps({"owned": owned, "foreign": foreign, "hasList": has_post_list})
        code = """
            const fixture = FIXTURE;
            const link = id => ({getAttribute: () => '/video/' + id});
            const root = {querySelectorAll: () => fixture.owned.map(link)};
            globalThis.document = {
                querySelectorAll: selector => selector === 'a[href]'
                    ? fixture.foreign.map(link) : fixture.hasList ? [root] : [],
                documentElement: {innerHTML: JSON.stringify({
                    sidebar: fixture.foreign.map(group_id => ({group_id}))
                })}
            };
            process.stdout.write(JSON.stringify((SCRIPT)()));
        """.replace("FIXTURE", fixture).replace("SCRIPT", script)
        process = await asyncio.create_subprocess_exec(
            node, "-e", code, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.PIPE)
        stdout, stderr = await process.communicate()
        assert process.returncode == 0, stderr.decode()
        return json.loads(stdout)

    ids = await DouyinAPIClient({})._extract_aweme_ids_from_page(SimpleNamespace(evaluate=evaluate))
    assert ids == (owned if has_post_list else [])
