from __future__ import annotations

import hashlib
import os
import shutil
import tempfile
from pathlib import Path

from .registry import Assignment, Registry, SourceFile


class FileConflict(Exception):
    pass


def content_hash(content: bytes) -> str:
    return hashlib.sha256(content).hexdigest()


class FileStore:
    def __init__(self, registry: Registry, data_dir: Path):
        self.registry = registry
        self.backup_dir = data_dir / "backups"

    def read(self, file_id: str) -> dict[str, str]:
        _, source = self.registry.source_file(file_id)
        data = source.path.read_bytes()
        return {
            "id": source.id,
            "name": source.name,
            "language": source.language,
            "content": data.decode("utf-8"),
            "hash": content_hash(data),
        }

    def save(
        self, file_id: str, content: str, base_hash: str, force: bool = False
    ) -> dict[str, str]:
        assignment, source = self.registry.source_file(file_id)
        self._assert_safe(assignment, source)
        old_data = source.path.read_bytes()
        if not force and content_hash(old_data) != base_hash:
            raise FileConflict("文件已被其他程序修改")

        backup = self._backup_path(assignment, source)
        backup.parent.mkdir(parents=True, exist_ok=True)
        shutil.copy2(source.path, backup)
        new_data = content.encode("utf-8")
        self._atomic_write(source.path, new_data)
        return self.read(file_id)

    def restore(self, file_id: str) -> dict[str, str]:
        assignment, source = self.registry.source_file(file_id)
        self._assert_safe(assignment, source)
        backup = self._backup_path(assignment, source)
        if not backup.is_file():
            raise FileNotFoundError("没有可恢复的备份")
        current = source.path.read_bytes()
        previous = backup.read_bytes()
        self._atomic_write(source.path, previous)
        self._atomic_write(backup, current)
        return self.read(file_id)

    def _backup_path(self, assignment: Assignment, source: SourceFile) -> Path:
        return self.backup_dir / assignment.id / f"{source.id}.bak"

    @staticmethod
    def _assert_safe(assignment: Assignment, source: SourceFile) -> None:
        resolved = source.path.resolve()
        if not resolved.is_relative_to(assignment.directory.resolve()):
            raise PermissionError("源码路径超出作业目录")

    @staticmethod
    def _atomic_write(path: Path, data: bytes) -> None:
        descriptor, temp_name = tempfile.mkstemp(
            prefix=f".{path.name}.", suffix=".tmp", dir=path.parent
        )
        try:
            with os.fdopen(descriptor, "wb") as handle:
                handle.write(data)
                handle.flush()
                os.fsync(handle.fileno())
            os.replace(temp_name, path)
        finally:
            if os.path.exists(temp_name):
                os.unlink(temp_name)
