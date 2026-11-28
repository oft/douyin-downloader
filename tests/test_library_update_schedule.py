import asyncio
import importlib.util
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import AsyncMock

import aiosqlite
import pytest

SCRIPT = Path(__file__).resolve().parents[1] / "apps" / "admin" / "scripts" / "update_schedule.py"
spec = importlib.util.spec_from_file_location("library_update_schedule", SCRIPT)
schedule_module = importlib.util.module_from_spec(spec)
spec.loader.exec_module(schedule_module)

FIRST = "https://www.douyin.com/user/first"
SECOND = "https://www.douyin.com/user/second"
THIRD = "https://www.douyin.com/user/third"
FOURTH = "https://www.douyin.com/user/fourth"


@pytest.fixture
async def schedule(tmp_path):
    instance = schedule_module.UpdateSchedule(tmp_path / "library.db")
    try:
        yield instance
    finally:
        await instance.close()


async def test_never_attempted_first_then_oldest_stable_without_modifying_input(schedule):
    links = [FIRST, SECOND, THIRD, FOURTH]
    await schedule.run(SECOND, AsyncMock(return_value=SimpleNamespace(failed=0)))
    await schedule.run(FIRST, AsyncMock(return_value=SimpleNamespace(failed=0)))
    assert await schedule.order(links) == [THIRD, FOURTH, SECOND, FIRST]
    assert links == [FIRST, SECOND, THIRD, FOURTH]


async def test_existing_download_history_seeds_initial_order(schedule):
    db = await schedule._connect()
    await db.execute("CREATE TABLE download_history (url TEXT, download_time INTEGER)")
    await db.executemany("INSERT INTO download_history VALUES (?, ?)", [
        (FIRST, 100), (FIRST + "?from=old", 300), (SECOND, 200),
    ])
    await db.commit()
    assert await schedule.order([FIRST, SECOND, THIRD]) == [THIRD, SECOND, FIRST]


async def test_history_and_state_survive_restarting_the_runner(schedule):
    await schedule.run(FIRST, AsyncMock(return_value=None))
    await schedule.close()
    restarted = schedule_module.UpdateSchedule(schedule.database_path)
    try:
        assert await restarted.order([FIRST, SECOND]) == [SECOND, FIRST]
        db = await restarted._connect()
        async with db.execute("SELECT status FROM library_update_state") as cursor:
            assert await cursor.fetchone() == ("failed",)
    finally:
        await restarted.close()


@pytest.mark.parametrize("outcome,expected", [
    (None, "failed"),
    (SimpleNamespace(failed=0), "finished"),
    (SimpleNamespace(failed=1), "partial"),
    (SimpleNamespace(failed=0, incomplete_reason="page failed"), "partial"),
    (RuntimeError("network failure"), "failed"),
    (asyncio.CancelledError(), "interrupted"),
])
async def test_outcomes_preserve_attempt_and_rotate_even_failed_or_stopped(schedule, outcome, expected):
    operation = AsyncMock(side_effect=outcome) if isinstance(outcome, BaseException) else AsyncMock(return_value=outcome)
    if isinstance(outcome, BaseException):
        with pytest.raises(type(outcome)):
            await schedule.run(FIRST, operation)
    else:
        assert await schedule.run(FIRST, operation) is outcome
    assert await schedule.order([FIRST, SECOND]) == [SECOND, FIRST]
    db = await schedule._connect()
    async with db.execute(
        "SELECT status, last_attempt_us, last_finished_us FROM library_update_state"
    ) as cursor:
        status, started, finished = await cursor.fetchone()
    assert status == expected and finished >= started > 0


async def test_cancellation_in_flight_keeps_remaining_authors_first(schedule):
    started = asyncio.Event()
    async def download():
        started.set()
        await asyncio.Event().wait()
    task = asyncio.create_task(schedule.run(FIRST, download))
    await started.wait()
    # A separate reader can see the committed start before the download finishes.
    async with aiosqlite.connect(schedule.database_path) as db:
        async with db.execute("SELECT status FROM library_update_state") as cursor:
            assert await cursor.fetchone() == ("running",)
    task.cancel()
    with pytest.raises(asyncio.CancelledError):
        await task
    assert await schedule.order([FIRST, SECOND, THIRD]) == [SECOND, THIRD, FIRST]


async def test_author_aliases_share_state_but_different_authors_do_not(schedule):
    alias = FIRST + "/?from=share"
    await schedule.run(alias, AsyncMock(return_value=None))
    assert await schedule.order([FIRST, SECOND]) == [SECOND, FIRST]
    assert schedule_module.target_key(FIRST) == schedule_module.target_key(alias)
    assert schedule_module.target_key(FIRST) != schedule_module.target_key(SECOND)


async def test_hard_exit_running_record_still_rotates_on_next_start(schedule):
    db = await schedule._connect()
    await db.execute("INSERT INTO library_update_state VALUES (?, ?, NULL, 'running')",
                     (schedule_module.target_key(FIRST), 123))
    await db.commit()
    assert await schedule.order([FIRST, SECOND]) == [SECOND, FIRST]
