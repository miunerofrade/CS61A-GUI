from __future__ import annotations

import ast
import doctest
import hashlib
import json
import re
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any


SKIP_PARTS = {
    ".git",
    ".venv",
    "node_modules",
    "__pycache__",
    ".pytest_cache",
    ".cs61a-gui",
}


def stable_id(prefix: str, value: str, length: int = 14) -> str:
    digest = hashlib.sha256(value.encode("utf-8")).hexdigest()[:length]
    return f"{prefix}-{digest}"


def language_for(path: Path) -> str:
    return {
        ".py": "python",
        ".scm": "scheme",
        ".ss": "scheme",
        ".sql": "sql",
        ".js": "javascript",
        ".ts": "typescript",
    }.get(path.suffix.lower(), "plaintext")


@dataclass
class TheoryAnswer:
    assignment_id: str
    question_id: str
    case_id: str
    answer: str


@dataclass
class SourceFile:
    id: str
    name: str
    path: Path
    language: str

    def public(self) -> dict[str, str]:
        return {"id": self.id, "name": self.name, "language": self.language}


@dataclass
class Question:
    id: str
    title: str
    kind: str
    cases: list[dict[str, Any]] = field(default_factory=list)
    source_hint: str | None = None

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "title": self.title,
            "kind": self.kind,
            "cases": self.cases,
            "sourceHint": self.source_hint,
        }


@dataclass
class Assignment:
    id: str
    name: str
    directory: Path
    relative_directory: str
    config_path: Path
    endpoint: str
    source_url: str
    download_url: str
    files: list[SourceFile]
    questions: list[Question]
    default_tests: list[str]

    def public(self) -> dict[str, Any]:
        return {
            "id": self.id,
            "name": self.name,
            "directory": self.relative_directory,
            "endpoint": self.endpoint,
            "sourceUrl": self.source_url,
            "downloadUrl": self.download_url,
            "files": [item.public() for item in self.files],
            "questions": [item.public() for item in self.questions],
            "defaultTests": self.default_tests,
        }


class Registry:
    def __init__(self, workspace: Path):
        self.workspace = workspace.resolve()
        self.assignments: dict[str, Assignment] = {}
        self.files: dict[str, tuple[Assignment, SourceFile]] = {}
        self.answers: dict[tuple[str, str, str], TheoryAnswer] = {}

    def refresh(self) -> list[Assignment]:
        assignments: dict[str, Assignment] = {}
        files: dict[str, tuple[Assignment, SourceFile]] = {}
        answers: dict[tuple[str, str, str], TheoryAnswer] = {}

        for config_path in sorted(self.workspace.rglob("*.ok")):
            if any(part in SKIP_PARTS or part == "gui" for part in config_path.parts):
                continue
            if not (config_path.parent / "ok").is_file():
                continue
            try:
                config = json.loads(config_path.read_text(encoding="utf-8"))
            except (OSError, json.JSONDecodeError):
                continue
            if not isinstance(config, dict) or not isinstance(config.get("src"), list):
                continue

            relative_dir = config_path.parent.relative_to(self.workspace).as_posix()
            assignment_id = stable_id("a", relative_dir)
            endpoint = str(config.get("endpoint", ""))
            slug = endpoint.rstrip("/").split("/")[-1] or config_path.stem
            source_url = self._source_url(slug)
            download_url = f"{source_url.rstrip('/')}/{slug}.zip"

            source_files: list[SourceFile] = []
            for source_name in config.get("src", []):
                if not isinstance(source_name, str):
                    continue
                source_path = (config_path.parent / source_name).resolve()
                if not source_path.is_relative_to(config_path.parent.resolve()):
                    continue
                file_id = stable_id("f", f"{relative_dir}/{source_name}", 18)
                source_files.append(
                    SourceFile(file_id, source_name, source_path, language_for(source_path))
                )

            test_metadata, discovered_answers = self._read_test_metadata(
                config_path.parent, assignment_id
            )
            self._add_source_doctests(test_metadata, source_files)
            default_tests = [
                str(item) for item in config.get("default_tests", []) if isinstance(item, str)
            ]
            question_ids = list(default_tests)
            for test_id in test_metadata:
                if test_id not in question_ids:
                    question_ids.append(test_id)

            questions: list[Question] = []
            for question_id in question_ids:
                metadata = test_metadata.get(question_id, {})
                title = str(metadata.get("title") or question_id.replace("_", " ").title())
                kind = str(metadata.get("kind") or "code")
                cases = list(metadata.get("cases") or [])
                source_hint = self._source_hint(question_id, source_files)
                questions.append(Question(question_id, title, kind, cases, source_hint))

            assignment = Assignment(
                id=assignment_id,
                name=str(config.get("name") or config_path.stem),
                directory=config_path.parent.resolve(),
                relative_directory=relative_dir,
                config_path=config_path.resolve(),
                endpoint=endpoint,
                source_url=source_url,
                download_url=download_url,
                files=source_files,
                questions=questions,
                default_tests=default_tests,
            )
            assignments[assignment_id] = assignment
            for source_file in source_files:
                files[source_file.id] = (assignment, source_file)
            for answer in discovered_answers:
                answers[(answer.assignment_id, answer.question_id, answer.case_id)] = answer

        self.assignments = assignments
        self.files = files
        self.answers = answers
        return list(assignments.values())

    def _source_url(self, slug: str) -> str:
        if re.fullmatch(r"lab\d+", slug, re.IGNORECASE):
            category = "lab"
        elif re.fullmatch(r"hw\d+", slug, re.IGNORECASE):
            category = "hw"
        else:
            category = "proj"
        return f"https://cs61a.org/{category}/{slug}/"

    def _source_hint(self, question_id: str, files: list[SourceFile]) -> str | None:
        python_pattern = re.compile(
            rf"^\s*(?:def|class)\s+{re.escape(question_id)}\b", re.MULTILINE
        )
        scheme_pattern = re.compile(
            rf"\(define\s+\(?{re.escape(question_id)}\b", re.MULTILINE
        )
        for source_file in files:
            try:
                text = source_file.path.read_text(encoding="utf-8")
            except OSError:
                continue
            if python_pattern.search(text) or scheme_pattern.search(text):
                return source_file.id
        return files[0].id if files else None

    def _read_test_metadata(
        self, directory: Path, assignment_id: str
    ) -> tuple[dict[str, dict[str, Any]], list[TheoryAnswer]]:
        metadata: dict[str, dict[str, Any]] = {}
        answers: list[TheoryAnswer] = []
        tests_dir = directory / "tests"
        if not tests_dir.is_dir():
            return metadata, answers

        for path in sorted(tests_dir.glob("*.py")):
            if path.name == "__init__.py":
                continue
            try:
                module = ast.parse(path.read_text(encoding="utf-8"))
                test_dict = self._literal_test_dict(module)
            except (OSError, SyntaxError, ValueError):
                continue
            if not test_dict:
                continue
            question_id = path.stem
            suites = test_dict.get("suites", [])
            suite_types = {
                str(suite.get("type", ""))
                for suite in suites
                if isinstance(suite, dict)
            }
            if suite_types and suite_types <= {"concept"}:
                kind = "concept"
            elif "wwpp" in suite_types:
                kind = "wwpp"
            else:
                metadata[question_id] = {
                    "title": str(test_dict.get("name") or question_id),
                    "kind": "code",
                    "cases": [],
                }
                continue

            public_cases: list[dict[str, Any]] = []
            case_number = 0
            for suite in suites:
                if not isinstance(suite, dict):
                    continue
                suite_type = str(suite.get("type", ""))
                for case in suite.get("cases", []):
                    if not isinstance(case, dict) or case.get("hidden"):
                        continue
                    if suite_type == "concept":
                        case_id = f"case-{case_number}"
                        case_number += 1
                        public_cases.append(
                            {
                                "id": case_id,
                                "prompt": str(case.get("question", "")).strip(),
                                "choices": [
                                    str(choice) for choice in case.get("choices", [])
                                ],
                            }
                        )
                        answers.append(
                            TheoryAnswer(
                                assignment_id,
                                question_id,
                                case_id,
                                str(case.get("answer", "")).strip(),
                            )
                        )
                    elif suite_type == "wwpp":
                        parsed_cases = self._parse_wwpp(str(case.get("code", "")))
                        for prompt, answer in parsed_cases:
                            case_id = f"case-{case_number}"
                            case_number += 1
                            public_cases.append({"id": case_id, "prompt": prompt})
                            answers.append(
                                TheoryAnswer(
                                    assignment_id,
                                    question_id,
                                    case_id,
                                    answer,
                                )
                            )
            metadata[question_id] = {
                "title": str(test_dict.get("name") or question_id),
                "kind": kind,
                "cases": public_cases,
            }
        return metadata, answers

    @staticmethod
    def _add_source_doctests(
        metadata: dict[str, dict[str, Any]], source_files: list[SourceFile]
    ) -> None:
        for source_file in source_files:
            if source_file.path.suffix.lower() != ".py":
                continue
            try:
                module = ast.parse(source_file.path.read_text(encoding="utf-8"))
            except (OSError, SyntaxError):
                continue
            for node in module.body:
                if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
                    continue
                docstring = ast.get_docstring(node) or ""
                if ">>>" not in docstring or node.name in metadata:
                    continue
                metadata[node.name] = {
                    "title": node.name.replace("_", " ").title(),
                    "kind": "code",
                    "cases": [],
                }

    @staticmethod
    def _literal_test_dict(module: ast.Module) -> dict[str, Any] | None:
        for node in module.body:
            if (
                isinstance(node, ast.Assign)
                and any(isinstance(target, ast.Name) and target.id == "test" for target in node.targets)
            ):
                value = ast.literal_eval(node.value)
                return value if isinstance(value, dict) else None
        return None

    @staticmethod
    def _parse_wwpp(code: str) -> list[tuple[str, str]]:
        parser = doctest.DocTestParser()
        try:
            examples = parser.get_examples(code)
        except ValueError:
            return []
        pending: list[str] = []
        result: list[tuple[str, str]] = []
        for example in examples:
            source = example.source.rstrip()
            rendered = "\n".join(
                [f">>> {source.splitlines()[0]}"]
                + [f"... {line}" for line in source.splitlines()[1:]]
            )
            pending.append(rendered)
            wanted = example.want.strip()
            if wanted:
                result.append(("\n".join(pending), wanted))
                pending = []
        return result

    def assignment(self, assignment_id: str) -> Assignment:
        try:
            return self.assignments[assignment_id]
        except KeyError as exc:
            raise KeyError("Unknown assignment") from exc

    def source_file(self, file_id: str) -> tuple[Assignment, SourceFile]:
        try:
            return self.files[file_id]
        except KeyError as exc:
            raise KeyError("Unknown source file") from exc

    def check_theory(
        self, assignment_id: str, question_id: str, case_id: str, response: str
    ) -> bool:
        try:
            expected = self.answers[(assignment_id, question_id, case_id)].answer
        except KeyError as exc:
            raise KeyError("Unknown theory case") from exc
        return self._normalize_answer(response) == self._normalize_answer(expected)

    @staticmethod
    def _normalize_answer(value: str) -> str:
        lines = [line.rstrip() for line in value.replace("\r\n", "\n").strip().splitlines()]
        return "\n".join(lines).casefold()
