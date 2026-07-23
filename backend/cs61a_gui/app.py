from __future__ import annotations

import asyncio
import json
import os
from pathlib import Path
from typing import AsyncIterator
from urllib.parse import urlparse

import httpx
from fastapi import FastAPI, File, HTTPException, Request, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import FileResponse, JSONResponse, Response, StreamingResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

from .catalog import CatalogError, CatalogService
from .content import ContentService
from .importer import UnsafeArchive, import_archive, inspect_archive
from .registry import Registry
from .runner import RunManager
from .storage import FileConflict, FileStore
from .translation import TranslationError, TranslationService


PACKAGE_FILE = Path(__file__).resolve()
DEFAULT_WORKSPACE = PACKAGE_FILE.parents[3]
GUI_ROOT = PACKAGE_FILE.parents[2]


class SaveRequest(BaseModel):
    content: str
    baseHash: str
    force: bool = False


class TheoryRequest(BaseModel):
    assignmentId: str
    questionId: str
    caseId: str
    answer: str


class RunRequest(BaseModel):
    assignmentId: str
    questionId: str | None = None


class TranslateRequest(BaseModel):
    html: str


def create_app(workspace: Path | None = None) -> FastAPI:
    root = (
        workspace
        or Path(os.environ.get("CS61A_WORKSPACE", str(DEFAULT_WORKSPACE)))
    ).resolve()
    registry = Registry(root)
    registry.refresh()
    data_dir = GUI_ROOT / ".data"
    cache_dir = GUI_ROOT / ".cache"
    store = FileStore(registry, data_dir)
    content = ContentService(cache_dir)
    translations = TranslationService(cache_dir)
    catalog = CatalogService(root, cache_dir, registry)
    runs = RunManager()

    app = FastAPI(title="CS61A GUI", version="0.1.0")
    app.state.workspace = root
    app.state.registry = registry
    app.state.store = store
    app.state.content = content
    app.state.translations = translations
    app.state.catalog = catalog
    app.state.runs = runs
    app.add_middleware(
        CORSMiddleware,
        allow_origins=["http://127.0.0.1:5173", "http://localhost:5173"],
        allow_methods=["*"],
        allow_headers=["*"],
    )

    @app.get("/api/health")
    async def health() -> dict:
        return {"ok": True, "workspace": str(root)}

    @app.get("/api/assignments")
    async def assignments() -> dict:
        return {"assignments": [item.public() for item in registry.assignments.values()]}

    @app.post("/api/assignments/refresh")
    async def refresh_assignments() -> dict:
        found = registry.refresh()
        return {"assignments": [item.public() for item in found]}

    @app.get("/api/catalog")
    async def official_catalog(refresh: bool = False) -> dict:
        try:
            return {"items": await catalog.get(refresh=refresh)}
        except CatalogError as exc:
            raise HTTPException(502, str(exc)) from exc

    @app.post("/api/catalog/{catalog_id}/install")
    async def install_official_assignment(catalog_id: str) -> dict:
        try:
            return await catalog.install(catalog_id)
        except CatalogError as exc:
            raise HTTPException(502, str(exc)) from exc
        except FileExistsError as exc:
            raise HTTPException(409, str(exc)) from exc
        except UnsafeArchive as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.get("/api/assignments/{assignment_id}/content")
    async def assignment_content(assignment_id: str, refresh: bool = False) -> dict:
        try:
            assignment = registry.assignment(assignment_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return await content.get(assignment, refresh=refresh)

    @app.get("/api/files/{file_id}")
    async def read_file(file_id: str) -> dict:
        try:
            return store.read(file_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except (OSError, UnicodeDecodeError) as exc:
            raise HTTPException(422, f"无法读取文件：{exc}") from exc

    @app.put("/api/files/{file_id}")
    async def save_file(file_id: str, payload: SaveRequest):
        try:
            return store.save(file_id, payload.content, payload.baseHash, payload.force)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except FileConflict as exc:
            return JSONResponse({"detail": str(exc)}, status_code=409)
        except (OSError, PermissionError) as exc:
            raise HTTPException(422, f"无法保存文件：{exc}") from exc

    @app.post("/api/files/{file_id}/restore")
    async def restore_file(file_id: str) -> dict:
        try:
            return store.restore(file_id)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        except FileNotFoundError as exc:
            raise HTTPException(404, str(exc)) from exc
        except OSError as exc:
            raise HTTPException(422, f"无法恢复文件：{exc}") from exc

    @app.post("/api/imports/preview")
    async def preview_import(file: UploadFile = File(...)) -> dict:
        try:
            return inspect_archive(await file.read(), root)
        except UnsafeArchive as exc:
            raise HTTPException(422, str(exc)) from exc

    @app.post("/api/imports")
    async def import_zip(file: UploadFile = File(...)) -> dict:
        try:
            result = import_archive(await file.read(), root)
            registry.refresh()
            return result
        except UnsafeArchive as exc:
            raise HTTPException(422, str(exc)) from exc
        except FileExistsError as exc:
            raise HTTPException(409, str(exc)) from exc

    @app.post("/api/theory/check")
    async def check_theory(payload: TheoryRequest) -> dict:
        try:
            correct = registry.check_theory(
                payload.assignmentId,
                payload.questionId,
                payload.caseId,
                payload.answer,
            )
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        return {
            "correct": correct,
            "feedback": "回答正确" if correct else "还不正确，请再试一次",
        }

    @app.post("/api/translate")
    async def translate_problem(payload: TranslateRequest) -> dict:
        try:
            return await translations.translate_html(payload.html)
        except TranslationError as exc:
            raise HTTPException(502, str(exc)) from exc

    @app.post("/api/runs")
    async def start_run(payload: RunRequest) -> dict:
        try:
            assignment = registry.assignment(payload.assignmentId)
        except KeyError as exc:
            raise HTTPException(404, str(exc)) from exc
        if payload.questionId and payload.questionId not in {
            item.id for item in assignment.questions
        }:
            raise HTTPException(404, "Unknown question")
        state = runs.start(assignment, payload.questionId)
        return {"id": state.id, "status": state.status}

    @app.get("/api/runs/{run_id}/events")
    async def run_events(run_id: str, request: Request) -> StreamingResponse:
        if run_id not in runs.runs:
            raise HTTPException(404, "Unknown run")
        state = runs.runs[run_id]

        async def events() -> AsyncIterator[str]:
            if state.result is not None:
                yield f"data: {json.dumps({'type': 'complete', 'result': state.result}, ensure_ascii=False)}\n\n"
                return
            while True:
                if await request.is_disconnected():
                    return
                try:
                    event = await asyncio.wait_for(state.queue.get(), 15)
                except asyncio.TimeoutError:
                    yield ": keep-alive\n\n"
                    continue
                yield f"data: {json.dumps(event, ensure_ascii=False)}\n\n"
                if event.get("type") == "complete":
                    return

        return StreamingResponse(events(), media_type="text/event-stream")

    @app.delete("/api/runs/{run_id}")
    async def cancel_run(run_id: str) -> dict:
        if run_id not in runs.runs:
            raise HTTPException(404, "Unknown run")
        await runs.cancel(run_id)
        return {"ok": True}

    @app.get("/api/course")
    async def proxy_course_resource(url: str) -> Response:
        parsed = urlparse(url)
        if parsed.scheme != "https" or parsed.hostname != "cs61a.org":
            raise HTTPException(403, "只允许读取 CS61A 官方资源")
        try:
            async with httpx.AsyncClient(
                timeout=60.0,
                follow_redirects=True,
                headers={"User-Agent": "CS61A-GUI/1.0"},
            ) as client:
                upstream = await client.get(url)
                upstream.raise_for_status()
        except httpx.HTTPError as exc:
            raise HTTPException(502, "无法读取 CS61A 官方资源") from exc
        if urlparse(str(upstream.url)).hostname != "cs61a.org":
            raise HTTPException(403, "官方资源重定向到了不受信任的站点")
        if len(upstream.content) > 50 * 1024 * 1024:
            raise HTTPException(413, "官方资源超过 50 MB")
        return Response(
            upstream.content,
            media_type=upstream.headers.get("content-type", "application/octet-stream"),
            headers={"Cache-Control": "public, max-age=3600"},
        )

    frontend_dist = GUI_ROOT / "frontend" / "dist"
    assets = frontend_dist / "assets"
    if assets.is_dir():
        app.mount("/assets", StaticFiles(directory=assets), name="assets")

    @app.get("/{path:path}", include_in_schema=False)
    async def frontend(path: str):
        if path.startswith("api/"):
            raise HTTPException(404)
        index = frontend_dist / "index.html"
        requested = frontend_dist / path
        if path and requested.is_file() and requested.resolve().is_relative_to(frontend_dist):
            return FileResponse(requested)
        if index.is_file():
            return FileResponse(index)
        raise HTTPException(404, "前端尚未构建，请先运行 npm run build")

    return app


app = create_app()


def main() -> None:
    import threading
    import uvicorn
    import webbrowser

    if os.environ.get("CS61A_NO_BROWSER") != "1":
        threading.Timer(1.0, lambda: webbrowser.open("http://127.0.0.1:8761")).start()

    uvicorn.run(
        "cs61a_gui.app:app",
        host="127.0.0.1",
        port=8761,
        reload=False,
    )
