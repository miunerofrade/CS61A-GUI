from __future__ import annotations

import json
import re
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup

from .importer import MAX_ARCHIVE_SIZE, import_archive
from .registry import Registry


COURSE_HOME = "https://cs61a.org/"
CATALOG_TTL = timedelta(hours=1)
ASSIGNMENT_PATH = re.compile(
    r"^/(lab|hw|proj)/([a-zA-Z0-9_-]+)/?$", re.IGNORECASE
)


class CatalogError(RuntimeError):
    pass


class CatalogService:
    def __init__(self, workspace: Path, cache_dir: Path, registry: Registry):
        self.workspace = workspace
        self.cache_path = cache_dir / "catalog.json"
        self.registry = registry

    async def get(self, refresh: bool = False) -> list[dict]:
        raw_items: list[dict] | None = None
        if not refresh:
            raw_items = self._read_cache()
        if raw_items is None:
            raw_items = await self._fetch_catalog()
            self.cache_path.parent.mkdir(parents=True, exist_ok=True)
            self.cache_path.write_text(
                json.dumps(
                    {
                        "fetchedAt": datetime.now(timezone.utc).isoformat(),
                        "items": raw_items,
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
        installed = {
            assignment.source_url.rstrip("/").casefold(): assignment.id
            for assignment in self.registry.assignments.values()
        }
        return [
            {
                **item,
                "installed": item["pageUrl"].rstrip("/").casefold() in installed,
                "assignmentId": installed.get(item["pageUrl"].rstrip("/").casefold()),
            }
            for item in raw_items
        ]

    async def install(self, catalog_id: str) -> dict:
        items = await self.get()
        try:
            item = next(entry for entry in items if entry["id"] == catalog_id)
        except StopIteration as exc:
            raise CatalogError("官方目录中没有找到该作业") from exc
        if item["installed"]:
            raise FileExistsError("该作业已经安装")

        download_url = item["downloadUrl"]
        parsed = urlparse(download_url)
        if parsed.scheme != "https" or parsed.hostname != "cs61a.org":
            raise CatalogError("下载地址不属于 CS61A 官方站点")

        try:
            async with httpx.AsyncClient(
                timeout=60.0,
                follow_redirects=True,
                headers={"User-Agent": "CS61A-GUI/0.2"},
            ) as client:
                async with client.stream("GET", download_url) as response:
                    response.raise_for_status()
                    content_length = int(response.headers.get("content-length", "0") or "0")
                    if content_length > MAX_ARCHIVE_SIZE:
                        raise CatalogError("官方安装包超过允许大小")
                    chunks: list[bytes] = []
                    total = 0
                    async for chunk in response.aiter_bytes():
                        total += len(chunk)
                        if total > MAX_ARCHIVE_SIZE:
                            raise CatalogError("官方安装包超过允许大小")
                        chunks.append(chunk)
            result = import_archive(b"".join(chunks), self.workspace)
        except httpx.HTTPError as exc:
            raise CatalogError("无法从 CS61A 官网下载安装包") from exc
        self.registry.refresh()
        return {"catalogId": catalog_id, "assignment": result["root"]}

    async def _fetch_catalog(self) -> list[dict]:
        try:
            async with httpx.AsyncClient(
                timeout=10.0,
                follow_redirects=True,
                headers={"User-Agent": "CS61A-GUI/0.2"},
            ) as client:
                response = await client.get(COURSE_HOME)
                response.raise_for_status()
        except httpx.HTTPError as exc:
            cached = self._read_cache(ignore_ttl=True)
            if cached is not None:
                return cached
            raise CatalogError("无法读取 CS61A 官方作业目录") from exc
        return self.parse_catalog(response.text)

    @staticmethod
    def parse_catalog(document: str) -> list[dict]:
        soup = BeautifulSoup(document, "html.parser")
        found: dict[str, dict] = {}
        for link in soup.find_all("a", href=True):
            absolute = urljoin(COURSE_HOME, str(link["href"]))
            parsed = urlparse(absolute)
            if parsed.hostname != "cs61a.org":
                continue
            match = ASSIGNMENT_PATH.fullmatch(parsed.path)
            if not match:
                continue
            category, slug = match.groups()
            if slug.lower().startswith("sol-"):
                continue
            page_url = f"https://cs61a.org/{category.lower()}/{slug}/"
            catalog_id = f"{category.lower()}:{slug.lower()}"
            title = " ".join(link.get_text(" ", strip=True).split())
            if not title:
                title = slug
            found[catalog_id] = {
                "id": catalog_id,
                "name": title,
                "category": category.lower(),
                "slug": slug,
                "pageUrl": page_url,
                "downloadUrl": f"{page_url}{slug}.zip",
            }
        order = {"lab": 0, "hw": 1, "proj": 2}
        return sorted(
            found.values(),
            key=lambda item: (
                order.get(item["category"], 9),
                CatalogService._natural_key(item["slug"]),
            ),
        )

    def _read_cache(self, ignore_ttl: bool = False) -> list[dict] | None:
        if not self.cache_path.is_file():
            return None
        try:
            payload = json.loads(self.cache_path.read_text(encoding="utf-8"))
            fetched = datetime.fromisoformat(payload["fetchedAt"])
            items = payload["items"]
            if not isinstance(items, list):
                return None
            if ignore_ttl or datetime.now(timezone.utc) - fetched <= CATALOG_TTL:
                return items
        except (OSError, ValueError, KeyError, json.JSONDecodeError):
            return None
        return None

    @staticmethod
    def _natural_key(value: str) -> tuple:
        return tuple(
            int(part) if part.isdigit() else part.casefold()
            for part in re.split(r"(\d+)", value)
        )

