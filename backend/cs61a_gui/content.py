from __future__ import annotations

import html
import json
import re
from datetime import datetime, timezone
from pathlib import Path
from urllib.parse import urljoin, urlparse

import httpx
from bs4 import BeautifulSoup, Tag

from .registry import Assignment

CACHE_VERSION = 2


class ContentService:
    def __init__(self, cache_dir: Path):
        self.cache_dir = cache_dir / "content"

    async def get(self, assignment: Assignment, refresh: bool = False) -> dict:
        cache_path = self.cache_dir / f"{assignment.id}.json"
        if not refresh and cache_path.is_file():
            try:
                cached = json.loads(cache_path.read_text(encoding="utf-8"))
                if cached.get("cacheVersion") == CACHE_VERSION:
                    return cached
            except (OSError, json.JSONDecodeError):
                pass

        try:
            async with httpx.AsyncClient(
                timeout=6.0, follow_redirects=True, headers={"User-Agent": "CS61A-GUI/0.1"}
            ) as client:
                response = await client.get(assignment.source_url)
                response.raise_for_status()
            result = self._parse_official(assignment, response.text)
            self.cache_dir.mkdir(parents=True, exist_ok=True)
            cache_path.write_text(
                json.dumps(result, ensure_ascii=False), encoding="utf-8"
            )
            return result
        except (httpx.HTTPError, OSError, ValueError):
            if cache_path.is_file():
                try:
                    cached = json.loads(cache_path.read_text(encoding="utf-8"))
                    if cached.get("cacheVersion") == CACHE_VERSION:
                        cached["stale"] = True
                        return cached
                except (OSError, json.JSONDecodeError):
                    pass
            return self._fallback(assignment)

    def _parse_official(self, assignment: Assignment, document: str) -> dict:
        soup = BeautifulSoup(document, "html.parser")
        main = soup.find("main") or soup.find(id="content") or soup.body
        if not isinstance(main, Tag):
            raise ValueError("Official page has no content")

        for node in main.find_all(["script", "style", "nav", "form", "button"]):
            node.decompose()
        for node in main.find_all(True):
            for attribute in list(node.attrs):
                if attribute.lower().startswith("on"):
                    del node.attrs[attribute]
            for attribute in ("href", "src"):
                if attribute not in node.attrs:
                    continue
                value = str(node.attrs[attribute])
                absolute = urljoin(assignment.source_url, value)
                if urlparse(absolute).scheme in {"http", "https"}:
                    node.attrs[attribute] = absolute
                else:
                    del node.attrs[attribute]

        sections: dict[str, str] = {}
        for question in assignment.questions:
            heading = self._find_heading(main, question.id)
            if heading is not None:
                section = self._heading_section(heading)
                if question.kind in {"concept", "wwpp"}:
                    section_soup = BeautifulSoup(section, "html.parser")
                    for answer in section_soup.select(".solution"):
                        answer.decompose()
                    section = str(section_soup)
                sections[question.id] = section
            else:
                local_section = self._local_question_section(assignment, question.id, question.title)
                if local_section:
                    sections[question.id] = local_section

        title = soup.find("h1")
        return {
            "title": title.get_text(" ", strip=True) if title else assignment.name,
            "cacheVersion": CACHE_VERSION,
            "sourceUrl": assignment.source_url,
            "source": "official",
            "stale": False,
            "fetchedAt": datetime.now(timezone.utc).isoformat(),
            "overviewHtml": self._sanitize_fragment(str(main)),
            "sections": sections,
        }

    def _find_heading(self, main: Tag, question_id: str) -> Tag | None:
        pattern = re.compile(rf"\bok\s+-q\s+{re.escape(question_id)}\b")
        match = main.find(string=pattern)
        if match:
            heading = match.find_previous(["h2", "h3", "h4"])
            if isinstance(heading, Tag):
                return heading
        normalized = question_id.replace("_", " ").replace("-", " ").casefold()
        for heading in main.find_all(["h2", "h3", "h4"]):
            if normalized in heading.get_text(" ", strip=True).casefold():
                return heading
        return None

    def _heading_section(self, heading: Tag) -> str:
        level = int(heading.name[1])
        parts = [str(heading)]
        for sibling in heading.next_siblings:
            if isinstance(sibling, Tag) and re.fullmatch(r"h[1-6]", sibling.name or ""):
                if int(sibling.name[1]) <= level:
                    break
            parts.append(str(sibling))
        return self._sanitize_fragment("".join(parts))

    @staticmethod
    def _sanitize_fragment(fragment: str) -> str:
        # The source tree was already sanitized. This removes any surviving XML comments.
        return re.sub(r"<!--.*?-->", "", fragment, flags=re.DOTALL)

    def _fallback(self, assignment: Assignment) -> dict:
        sections: dict[str, str] = {}
        source_texts: list[str] = []
        for source in assignment.files:
            try:
                source_texts.append(source.path.read_text(encoding="utf-8"))
            except OSError:
                continue
        for question in assignment.questions:
            excerpt = next(
                (found for text in source_texts if (found := self._docstring_excerpt(text, question.id))),
                "",
            )
            if excerpt:
                sections[question.id] = (
                    f"<h2>{html.escape(question.title)}</h2>"
                    f"<pre><code>{html.escape(excerpt)}</code></pre>"
                )
            elif question.cases:
                prompts = "".join(
                    f"<pre><code>{html.escape(str(case.get('prompt', '')))}</code></pre>"
                    for case in question.cases
                )
                sections[question.id] = f"<h2>{html.escape(question.title)}</h2>{prompts}"
        return {
            "title": assignment.name,
            "cacheVersion": CACHE_VERSION,
            "sourceUrl": assignment.source_url,
            "source": "local",
            "stale": False,
            "fetchedAt": None,
            "overviewHtml": (
                "<p>官方题面暂时不可用。当前内容来自本地源码和公开测试，"
                "代码编辑与 OK 测试仍可正常使用。</p>"
            ),
            "sections": sections,
        }

    def _local_question_section(
        self, assignment: Assignment, question_id: str, title: str
    ) -> str:
        for source in assignment.files:
            try:
                text = source.path.read_text(encoding="utf-8")
            except OSError:
                continue
            excerpt = self._docstring_excerpt(text, question_id)
            if excerpt:
                return (
                    f"<h2>{html.escape(title)}</h2>"
                    "<p>此题内容来自本地源码。</p>"
                    f"<pre><code>{html.escape(excerpt)}</code></pre>"
                )
        return ""

    @staticmethod
    def _docstring_excerpt(source: str, question_id: str) -> str:
        try:
            import ast

            module = ast.parse(source)
        except SyntaxError:
            return ""
        for node in module.body:
            if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                if node.name == question_id:
                    segment = ast.get_source_segment(source, node)
                    return segment or ""
        return ""
