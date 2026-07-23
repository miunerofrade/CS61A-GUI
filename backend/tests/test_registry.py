from __future__ import annotations

import json
from pathlib import Path

from cs61a_gui.registry import Registry


def test_discovers_generic_assignment_and_languages(registry: Registry):
    assignment = next(iter(registry.assignments.values()))
    assert assignment.name == "Homework 99"
    assert assignment.source_url == "https://cs61a.org/hw/hw99/"
    assert [item.language for item in assignment.files] == ["python", "scheme"]
    assert [item.id for item in assignment.questions] == [
        "concept-check",
        "wwpd-check",
        "square",
    ]
    assert assignment.questions[-1].source_hint == assignment.files[0].id


def test_parses_theory_without_exposing_answers(registry: Registry):
    assignment = next(iter(registry.assignments.values()))
    concept = assignment.questions[0].public()
    assert concept["kind"] == "concept"
    assert concept["cases"][0]["choices"] == ["41", "42"]
    assert "answer" not in concept["cases"][0]
    assert registry.check_theory(
        assignment.id, "concept-check", "case-0", "42"
    )
    assert not registry.check_theory(
        assignment.id, "concept-check", "case-0", "41"
    )


def test_splits_wwpd_examples(registry: Registry):
    assignment = next(iter(registry.assignments.values()))
    wwpd = assignment.questions[1]
    assert len(wwpd.cases) == 2
    assert "x = 5" in wwpd.cases[0]["prompt"]
    assert "6" not in wwpd.cases[0]["prompt"]
    assert registry.check_theory(assignment.id, wwpd.id, "case-0", "6")
    assert registry.check_theory(assignment.id, wwpd.id, "case-1", "hi")


def test_workspace_named_gui_still_discovers_assignments(tmp_path: Path):
    workspace = tmp_path / "gui"
    assignment = workspace / "lab00"
    assignment.mkdir(parents=True)
    (assignment / "ok").write_text("placeholder", encoding="utf-8")
    (assignment / "lab00.py").write_text("answer = 42\n", encoding="utf-8")
    (assignment / "lab00.ok").write_text(
        json.dumps(
            {
                "name": "Lab 00",
                "endpoint": "cal/cs61a/su26/lab00",
                "src": ["lab00.py"],
            }
        ),
        encoding="utf-8",
    )

    registry = Registry(workspace)
    assert [item.name for item in registry.refresh()] == ["Lab 00"]
