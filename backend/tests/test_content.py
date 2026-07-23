from pathlib import Path

from cs61a_gui.content import ContentService
from cs61a_gui.registry import Registry


def test_official_theory_section_removes_embedded_solution(
    tmp_path: Path, registry: Registry
):
    assignment = next(iter(registry.assignments.values()))
    document = """
    <html><body><main>
      <h1>Homework</h1>
      <h3>Concept Check</h3>
      <pre><code>python3 ok -q concept-check -u</code></pre>
      <p>Question text</p>
      <div class="alt prompt-1">______</div>
      <div class="solution prompt-1">secret answer</div>
      <h3>Next</h3>
    </main></body></html>
    """
    result = ContentService(tmp_path)._parse_official(assignment, document)
    section = result["sections"]["concept-check"]
    assert "Question text" in section
    assert "secret answer" not in section

