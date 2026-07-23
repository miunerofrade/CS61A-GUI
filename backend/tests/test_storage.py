from __future__ import annotations

from pathlib import Path

import pytest

from cs61a_gui.registry import Registry
from cs61a_gui.storage import FileConflict, FileStore


def test_atomic_save_conflict_and_restore(
    tmp_path: Path, registry: Registry
):
    store = FileStore(registry, tmp_path / "data")
    assignment = next(iter(registry.assignments.values()))
    source = assignment.files[0]
    original = store.read(source.id)

    saved = store.save(
        source.id,
        original["content"].replace("x * x", "x ** 2"),
        original["hash"],
    )
    assert "x ** 2" in saved["content"]

    with pytest.raises(FileConflict):
        store.save(source.id, original["content"], original["hash"])

    restored = store.restore(source.id)
    assert restored["content"] == original["content"]

