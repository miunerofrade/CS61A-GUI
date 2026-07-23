from __future__ import annotations

import io
import shutil
import stat
import tempfile
import zipfile
from pathlib import Path, PurePosixPath
from typing import Any


MAX_ARCHIVE_SIZE = 100 * 1024 * 1024
MAX_EXPANDED_SIZE = 500 * 1024 * 1024
MAX_ENTRIES = 10_000


class UnsafeArchive(ValueError):
    pass


def inspect_archive(data: bytes, workspace: Path) -> dict[str, Any]:
    if len(data) > MAX_ARCHIVE_SIZE:
        raise UnsafeArchive("ZIP 文件超过 100 MB")
    try:
        archive = zipfile.ZipFile(io.BytesIO(data))
    except zipfile.BadZipFile as exc:
        raise UnsafeArchive("不是有效的 ZIP 文件") from exc
    with archive:
        infos = archive.infolist()
        if not infos or len(infos) > MAX_ENTRIES:
            raise UnsafeArchive("ZIP 文件为空或文件数量过多")
        expanded = sum(item.file_size for item in infos)
        if expanded > MAX_EXPANDED_SIZE:
            raise UnsafeArchive("ZIP 解压后超过 500 MB")

        roots: set[str] = set()
        configs: list[str] = []
        for item in infos:
            normalized = item.filename.replace("\\", "/")
            path = PurePosixPath(normalized)
            if (
                path.is_absolute()
                or not path.parts
                or any(part in {"", ".", ".."} for part in path.parts)
                or path.parts[0].endswith(":")
            ):
                raise UnsafeArchive(f"ZIP 包含不安全路径：{item.filename}")
            mode = item.external_attr >> 16
            if stat.S_ISLNK(mode):
                raise UnsafeArchive("ZIP 包含符号链接")
            roots.add(path.parts[0])
            if path.suffix == ".ok":
                configs.append(normalized)

        if len(roots) != 1:
            raise UnsafeArchive("ZIP 必须只包含一个顶层作业目录")
        root_name = next(iter(roots))
        if not configs:
            raise UnsafeArchive("ZIP 中没有找到 .ok 配置")
        destination = (workspace / root_name).resolve()
        if not destination.is_relative_to(workspace.resolve()):
            raise UnsafeArchive("目标目录不安全")
        return {
            "root": root_name,
            "entries": len(infos),
            "expandedBytes": expanded,
            "configs": configs,
            "conflict": destination.exists(),
        }


def import_archive(data: bytes, workspace: Path) -> dict[str, Any]:
    preview = inspect_archive(data, workspace)
    if preview["conflict"]:
        raise FileExistsError(f"目录 {preview['root']} 已存在，不会覆盖")

    with tempfile.TemporaryDirectory(prefix="cs61a-import-") as temp_dir:
        temp_root = Path(temp_dir)
        with zipfile.ZipFile(io.BytesIO(data)) as archive:
            for item in archive.infolist():
                target = (temp_root / item.filename).resolve()
                if not target.is_relative_to(temp_root.resolve()):
                    raise UnsafeArchive("ZIP 路径越界")
                if item.is_dir():
                    target.mkdir(parents=True, exist_ok=True)
                else:
                    target.parent.mkdir(parents=True, exist_ok=True)
                    with archive.open(item) as source, target.open("wb") as destination:
                        shutil.copyfileobj(source, destination)
        source_root = temp_root / preview["root"]
        shutil.move(str(source_root), str(workspace / preview["root"]))
    return preview
