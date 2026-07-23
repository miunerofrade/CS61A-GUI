import asyncio
import json
from pathlib import Path

from cs61a_gui.catalog import CatalogService
from cs61a_gui.registry import Registry


def test_parses_and_sorts_official_catalog(tmp_path: Path):
    service = CatalogService(tmp_path, tmp_path / "cache", Registry(tmp_path))
    items = service.parse_catalog(
        """
        <a href="/proj/hog/">Hog</a>
        <a href="/lab/lab10/">Lab 10: SQL</a>
        <a href="/lab/lab02/">Lab 02: HOF</a>
        <a href="/hw/hw01/">HW 01: Functions</a>
        <a href="/lab/sol-lab02/">Solutions</a>
        <a href="https://example.com/lab/lab99/">Not official</a>
        """
    )
    assert [item["id"] for item in items] == [
        "lab:lab02",
        "lab:lab10",
        "hw:hw01",
        "proj:hog",
    ]
    assert items[-1]["downloadUrl"] == "https://cs61a.org/proj/hog/hog.zip"


def test_marks_local_assignment_as_installed(
    tmp_path: Path, workspace: Path, registry: Registry
):
    service = CatalogService(workspace, tmp_path / "cache", registry)
    local = next(iter(registry.assignments.values()))
    raw = [
        {
            "id": "hw:hw99",
            "name": "Homework 99",
            "category": "hw",
            "slug": "hw99",
            "pageUrl": local.source_url,
            "downloadUrl": local.download_url,
        }
    ]
    service.cache_path.parent.mkdir(parents=True)
    service.cache_path.write_text(
        '{"fetchedAt":"2999-01-01T00:00:00+00:00","items":'
        + json.dumps(raw)
        + "}",
        encoding="utf-8",
    )
    items = asyncio.run(service.get())
    assert items[0]["installed"] is True
    assert items[0]["assignmentId"] == local.id
