from pathlib import Path

import pytest

from cs61a_gui.translation import TranslationService


@pytest.mark.asyncio
async def test_translates_prose_but_preserves_code(tmp_path: Path, monkeypatch):
    service = TranslationService(tmp_path)

    async def fake_translate(_client, text: str) -> str:
        return f"中文：{text}"

    monkeypatch.setattr(service, "_translate_text", fake_translate)
    result = await service.translate_html(
        "<h2>Write a function</h2><p>Return the result.</p>"
        "<pre><code>def answer(): return 42</code></pre>"
    )
    assert "中文：Write a function" in result["html"]
    assert "中文：Return the result." in result["html"]
    assert "def answer(): return 42" in result["html"]
    assert "中文：def answer" not in result["html"]


def test_splits_long_translation_segments(tmp_path: Path):
    service = TranslationService(tmp_path)
    text = "One sentence. " * 80
    chunks = service._split_text(text)
    assert len(chunks) > 1
    assert all(len(chunk) <= 450 for chunk in chunks)

