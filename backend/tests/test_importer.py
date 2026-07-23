from __future__ import annotations

import io
import zipfile
from pathlib import Path

import pytest

from cs61a_gui.importer import UnsafeArchive, import_archive, inspect_archive


def make_zip(entries: dict[str, bytes]) -> bytes:
    buffer = io.BytesIO()
    with zipfile.ZipFile(buffer, "w") as archive:
        for name, content in entries.items():
            archive.writestr(name, content)
    return buffer.getvalue()


def test_preview_and_import(tmp_path: Path):
    data = make_zip(
        {
            "lab88/lab88.ok": b'{"name":"Lab 88","src":["lab88.py"]}',
            "lab88/lab88.py": b"answer = 42\n",
            "lab88/ok": b"ok",
        }
    )
    preview = inspect_archive(data, tmp_path)
    assert preview["root"] == "lab88"
    assert preview["conflict"] is False
    import_archive(data, tmp_path)
    assert (tmp_path / "lab88" / "lab88.py").is_file()


@pytest.mark.parametrize("bad_name", ["../evil.py", "/absolute.py", "lab/../../evil.py"])
def test_rejects_path_traversal(tmp_path: Path, bad_name: str):
    data = make_zip({"lab/lab.ok": b"{}", bad_name: b"bad"})
    with pytest.raises(UnsafeArchive):
        inspect_archive(data, tmp_path)


def test_refuses_existing_directory(tmp_path: Path):
    data = make_zip({"lab/lab.ok": b"{}", "lab/ok": b"ok"})
    (tmp_path / "lab").mkdir()
    with pytest.raises(FileExistsError):
        import_archive(data, tmp_path)

