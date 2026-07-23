from __future__ import annotations

import json
from pathlib import Path

import pytest

from cs61a_gui.registry import Registry


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    assignment = tmp_path / "hw99"
    tests = assignment / "tests"
    tests.mkdir(parents=True)
    (assignment / "ok").write_text("placeholder", encoding="utf-8")
    (assignment / "hw99.py").write_text(
        '''def square(x):
    """Return x squared.

    >>> square(3)
    9
    """
    return x * x
''',
        encoding="utf-8",
    )
    (assignment / "notes.scm").write_text("(define (answer) 42)\n", encoding="utf-8")
    (assignment / "hw99.ok").write_text(
        json.dumps(
            {
                "name": "Homework 99",
                "endpoint": "cal/cs61a/su26/hw99",
                "src": ["hw99.py", "notes.scm"],
                "default_tests": ["concept-check", "wwpd-check", "square"],
            }
        ),
        encoding="utf-8",
    )
    (tests / "concept-check.py").write_text(
        """test = {
  'name': 'Concept Check',
  'suites': [{
    'type': 'concept',
    'cases': [{
      'question': 'Which value?',
      'choices': ['41', '42'],
      'answer': '42',
      'hidden': False
    }]
  }]
}
""",
        encoding="utf-8",
    )
    (tests / "wwpd-check.py").write_text(
        """test = {
  'name': 'WWPD Check',
  'suites': [{
    'type': 'wwpp',
    'cases': [{
      'code': r\"\"\"
      >>> x = 5
      >>> x + 1
      6
      >>> print('hi')
      hi
      \"\"\",
      'hidden': False
    }]
  }]
}
""",
        encoding="utf-8",
    )
    return tmp_path


@pytest.fixture
def registry(workspace: Path) -> Registry:
    value = Registry(workspace)
    value.refresh()
    return value

