from __future__ import annotations

import hashlib
import json
import re
from pathlib import Path

import httpx
from bs4 import BeautifulSoup, NavigableString, Tag


MAX_HTML_LENGTH = 200_000
MAX_TRANSLATABLE_TEXT = 30_000
SEGMENT_LIMIT = 450


class TranslationError(RuntimeError):
    pass


class TranslationService:
    """Translate prose while preserving code and HTML structure."""

    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir / "translations"

    async def translate_html(self, fragment: str) -> dict[str, str]:
        if not fragment.strip():
            raise TranslationError("没有可翻译的题面")
        if len(fragment) > MAX_HTML_LENGTH:
            raise TranslationError("题面过长，无法一次翻译")

        cache_key = hashlib.sha256(("en-zh-v1:" + fragment).encode("utf-8")).hexdigest()
        cache_path = self.cache_dir / f"{cache_key}.json"
        if cache_path.is_file():
            try:
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
                if isinstance(cached.get("html"), str):
                    return cached
            except (OSError, json.JSONDecodeError):
                pass

        soup = BeautifulSoup(fragment, "html.parser")
        nodes = [
            node
            for node in soup.find_all(string=True)
            if self._should_translate(node)
        ]
        total = sum(len(str(node).strip()) for node in nodes)
        if total > MAX_TRANSLATABLE_TEXT:
            raise TranslationError("题面文字过长，请切换到单道题后再翻译")

        async with httpx.AsyncClient(
            timeout=12.0,
            follow_redirects=True,
            headers={"User-Agent": "CS61A-GUI/0.2"},
        ) as client:
            for node in nodes:
                original = str(node)
                translated = await self._translate_text(client, original.strip())
                leading = original[: len(original) - len(original.lstrip())]
                trailing = original[len(original.rstrip()) :]
                node.replace_with(NavigableString(f"{leading}{translated}{trailing}"))

        result = {
            "html": str(soup),
            "provider": "MyMemory",
            "sourceLanguage": "en",
            "targetLanguage": "zh-CN",
        }
        self.cache_dir.mkdir(parents=True, exist_ok=True)
        cache_path.write_text(json.dumps(result, ensure_ascii=False), encoding="utf-8")
        return result

    async def _translate_text(self, client: httpx.AsyncClient, text: str) -> str:
        if not text or not re.search(r"[A-Za-z]", text):
            return text
        chunks = self._split_text(text)
        translated: list[str] = []
        for chunk in chunks:
            try:
                response = await client.get(
                    "https://api.mymemory.translated.net/get",
                    params={"q": chunk, "langpair": "en|zh-CN"},
                )
                response.raise_for_status()
                payload = response.json()
                value = payload.get("responseData", {}).get("translatedText")
                if not isinstance(value, str) or not value.strip():
                    raise TranslationError("翻译服务没有返回结果")
                translated.append(value.strip())
            except (httpx.HTTPError, ValueError, KeyError) as exc:
                raise TranslationError("公共翻译服务暂时不可用，请稍后重试") from exc
        return " ".join(translated)

    @staticmethod
    def _split_text(text: str) -> list[str]:
        if len(text) <= SEGMENT_LIMIT:
            return [text]
        sentences = re.split(r"(?<=[.!?])\s+", text)
        chunks: list[str] = []
        current = ""
        for sentence in sentences:
            if len(sentence) > SEGMENT_LIMIT:
                if current:
                    chunks.append(current)
                    current = ""
                chunks.extend(
                    sentence[index : index + SEGMENT_LIMIT]
                    for index in range(0, len(sentence), SEGMENT_LIMIT)
                )
            elif not current:
                current = sentence
            elif len(current) + 1 + len(sentence) <= SEGMENT_LIMIT:
                current = f"{current} {sentence}"
            else:
                chunks.append(current)
                current = sentence
        if current:
            chunks.append(current)
        return chunks

    @staticmethod
    def _should_translate(node: NavigableString) -> bool:
        if not str(node).strip() or not re.search(r"[A-Za-z]", str(node)):
            return False
        parent = node.parent
        if not isinstance(parent, Tag):
            return False
        if parent.name in {"code", "pre", "script", "style", "textarea"}:
            return False
        if parent.find_parent(["code", "pre", "script", "style", "textarea"]):
            return False
        return True

