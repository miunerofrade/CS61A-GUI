from __future__ import annotations

import asyncio
import os
import re
import shutil
import sys
import tempfile
import uuid
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any

from .registry import Assignment


MAX_OUTPUT = 1_000_000
RUN_TIMEOUT = 60
IGNORED_NAMES = {
    ".ok_storage",
    ".ok_history",
    ".ok_messages",
    "__pycache__",
    ".git",
    ".cs61a-gui",
}


@dataclass
class RunState:
    id: str
    assignment_id: str
    question_id: str | None
    status: str = "queued"
    output: str = ""
    result: dict[str, Any] | None = None
    queue: asyncio.Queue = field(default_factory=asyncio.Queue)
    process: asyncio.subprocess.Process | None = None
    task: asyncio.Task | None = None


class RunManager:
    def __init__(self):
        self.runs: dict[str, RunState] = {}
        self.semaphore = asyncio.Semaphore(2)

    def start(self, assignment: Assignment, question_id: str | None) -> RunState:
        run_id = uuid.uuid4().hex
        state = RunState(run_id, assignment.id, question_id)
        self.runs[run_id] = state
        state.task = asyncio.create_task(self._execute(state, assignment))
        return state

    async def _execute(self, state: RunState, assignment: Assignment) -> None:
        await state.queue.put({"type": "status", "status": "queued"})
        try:
            async with self.semaphore:
                state.status = "running"
                await state.queue.put({"type": "status", "status": "running"})
                with tempfile.TemporaryDirectory(prefix="cs61a-ok-") as temp_dir:
                    sandbox = Path(temp_dir) / assignment.directory.name
                    shutil.copytree(
                        assignment.directory,
                        sandbox,
                        ignore=shutil.ignore_patterns(*IGNORED_NAMES, "*.pyc"),
                    )
                    command = [
                        sys.executable,
                        "ok",
                        "--local",
                        "--nointeract",
                        "--timeout",
                        "10",
                    ]
                    if state.question_id:
                        command.extend(["-q", state.question_id])
                    creationflags = (
                        getattr(__import__("subprocess"), "CREATE_NEW_PROCESS_GROUP", 0)
                        if os.name == "nt"
                        else 0
                    )
                    state.process = await asyncio.create_subprocess_exec(
                        *command,
                        cwd=sandbox,
                        stdout=asyncio.subprocess.PIPE,
                        stderr=asyncio.subprocess.STDOUT,
                        creationflags=creationflags,
                    )
                    try:
                        await asyncio.wait_for(self._collect_output(state), RUN_TIMEOUT)
                        return_code = await state.process.wait()
                        result = parse_ok_output(state.output, return_code)
                    except asyncio.TimeoutError:
                        await self._stop_process(state.process)
                        result = parse_ok_output(state.output, -1)
                        result["status"] = "timeout"
                        result["summary"] = "测试运行超过 60 秒，已终止"
                    state.result = result
                    state.status = result["status"]
                    await state.queue.put({"type": "complete", "result": result})
        except asyncio.CancelledError:
            if state.process:
                await self._stop_process(state.process)
            state.status = "cancelled"
            state.result = {
                "status": "cancelled",
                "summary": "测试已取消",
                "passed": 0,
                "failed": 0,
                "details": [],
                "raw": state.output,
            }
            await state.queue.put({"type": "complete", "result": state.result})
        except Exception as exc:
            state.status = "error"
            state.result = {
                "status": "error",
                "summary": f"无法运行 OK：{exc}",
                "passed": 0,
                "failed": 0,
                "details": [],
                "raw": state.output,
            }
            await state.queue.put({"type": "complete", "result": state.result})

    async def _collect_output(self, state: RunState) -> None:
        assert state.process and state.process.stdout
        while True:
            line = await state.process.stdout.readline()
            if not line:
                break
            text = line.decode("utf-8", errors="replace")
            if len(state.output) < MAX_OUTPUT:
                state.output += text[: MAX_OUTPUT - len(state.output)]
            await state.queue.put({"type": "output", "text": text})

    async def cancel(self, run_id: str) -> None:
        state = self.runs[run_id]
        if state.task and not state.task.done():
            state.task.cancel()

    @staticmethod
    async def _stop_process(process: asyncio.subprocess.Process) -> None:
        if process.returncode is not None:
            return
        process.terminate()
        try:
            await asyncio.wait_for(process.wait(), 2)
        except asyncio.TimeoutError:
            process.kill()
            await process.wait()


def parse_ok_output(output: str, return_code: int) -> dict[str, Any]:
    passed = 0
    failed = 0
    passed_match = re.search(r"(\d+)\s+test cases?\s+passed", output, re.IGNORECASE)
    if passed_match:
        passed = int(passed_match.group(1))
    failed_match = re.search(r"(\d+)\s+(?:test cases?\s+)?failed", output, re.IGNORECASE)
    if failed_match:
        failed = int(failed_match.group(1))
    if "No cases failed" in output:
        status = "passed"
        summary = f"{passed or 1} 个测试通过"
    elif "# Error:" in output or failed or "FAILED" in output:
        status = "failed"
        summary = "测试未通过"
    elif "Traceback (most recent call last)" in output or return_code != 0:
        status = "error"
        summary = "OK 运行异常"
    else:
        status = "passed" if return_code == 0 else "error"
        summary = "测试完成" if return_code == 0 else "测试运行失败"

    details: list[dict[str, str]] = []
    blocks = re.split(r"\n-{20,}\n", output)
    for block in blocks:
        if "# Error:" not in block and "Traceback" not in block:
            continue
        expected_match = re.search(
            r"#[ \t]+(?:Error:[ \t]*)?expected[ \t]*\r?\n"
            r"(?P<expected>.*?)(?=[ \t]*#[ \t]+but got)",
            block,
            re.IGNORECASE | re.DOTALL,
        )
        got_match = re.search(
            r"#[ \t]+but got[ \t]*\r?\n"
            r"(?P<got>(?:[ \t]*#.*(?:\r?\n|$))*)",
            block,
            re.IGNORECASE,
        )
        details.append(
            {
                "title": block.strip().splitlines()[0] if block.strip() else "失败详情",
                "expected": _clean_comment_block(expected_match.group("expected"))
                if expected_match
                else "",
                "actual": _clean_comment_block(got_match.group("got")) if got_match else "",
                "traceback": block.strip(),
            }
        )
    return {
        "status": status,
        "summary": summary,
        "passed": passed,
        "failed": failed,
        "details": details,
        "raw": output,
    }


def _clean_comment_block(value: str) -> str:
    return "\n".join(re.sub(r"^\s*#\s?", "", line) for line in value.splitlines()).strip()
