import JSZip from "jszip";
import {
  findStoredFile,
  getStoredAssignment,
  listStoredAssignments,
  putStoredAssignment,
  sha256,
  type StoredAssignment,
} from "./localStore";
import {
  parseOkOutput,
  pythonBridge,
  type InspectionResult,
} from "./pythonBridge";
import type {
  Assignment,
  AssignmentContent,
  CatalogItem,
  FileDocument,
  RunResult,
  TranslationResult,
} from "./types";

const MAX_ARCHIVE_BYTES = 50 * 1024 * 1024;
const MAX_EXPANDED_BYTES = 200 * 1024 * 1024;
const MAX_ENTRIES = 4_000;
const TEXT_EXTENSIONS = new Set([
  "",
  ".ok",
  ".py",
  ".scm",
  ".scheme",
  ".sql",
  ".txt",
  ".md",
  ".json",
  ".csv",
]);

interface ArchivePreview {
  root: string;
  entries: number;
  expandedBytes: number;
  configs: string[];
  conflict: boolean;
}

interface RunState {
  id: string;
  status: string;
  output: string;
  result: RunResult | null;
  listeners: Set<
    (event: { type: string; status?: string; text?: string; result?: RunResult }) => void
  >;
  cancelled: boolean;
}

const runs = new Map<string, RunState>();

function extension(path: string): string {
  const name = path.split("/").at(-1) || "";
  const index = name.lastIndexOf(".");
  return index < 0 ? "" : name.slice(index).toLowerCase();
}

function normalizePath(value: string): string {
  const normalized = value.replaceAll("\\", "/").replace(/^\.\/+/, "");
  const parts = normalized.split("/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    /^[a-z]:/i.test(normalized) ||
    parts.some((part) => part === "..")
  ) {
    throw new Error(`压缩包包含不安全路径：${value}`);
  }
  return parts.filter((part) => part && part !== ".").join("/");
}

function languageFor(path: string): string {
  const suffix = extension(path);
  if (suffix === ".py") return "python";
  if (suffix === ".scm" || suffix === ".scheme") return "scheme";
  if (suffix === ".sql") return "sql";
  return "plaintext";
}

function sourceUrl(endpoint: string, slug: string): string {
  const endpointSlug = endpoint.split("/").filter(Boolean).at(-1) || slug;
  if (/^lab\d+$/i.test(endpointSlug)) return `https://cs61a.org/lab/${endpointSlug}/`;
  if (/^hw\d+$/i.test(endpointSlug)) return `https://cs61a.org/hw/${endpointSlug}/`;
  return `https://cs61a.org/proj/${endpointSlug}/`;
}

function emit(
  state: RunState,
  event: { type: string; status?: string; text?: string; result?: RunResult },
) {
  for (const listener of state.listeners) listener(event);
}

async function fetchCourse(url: string): Promise<Response> {
  const proxy = `/api/course?url=${encodeURIComponent(url)}`;
  try {
    const response = await fetch(proxy);
    if (response.ok) return response;
  } catch {
    // Static mirrors and local development may not expose the optional proxy.
  }
  const direct = await fetch(url);
  if (!direct.ok) throw new Error(`官方资源下载失败 (${direct.status})`);
  return direct;
}

async function loadZip(file: Blob) {
  if (file.size > MAX_ARCHIVE_BYTES) throw new Error("压缩包不能超过 50 MB");
  const zip = await JSZip.loadAsync(file, { createFolders: false });
  const entries = Object.values(zip.files);
  if (entries.length > MAX_ENTRIES) throw new Error("压缩包文件数量过多");
  for (const entry of entries) {
    normalizePath(entry.name);
    const permissions =
      typeof entry.unixPermissions === "number" ? entry.unixPermissions : 0;
    if ((permissions & 0o170000) === 0o120000) {
      throw new Error("压缩包不能包含符号链接");
    }
  }
  const configs = entries
    .filter((entry) => !entry.dir && entry.name.toLowerCase().endsWith(".ok"))
    .map((entry) => normalizePath(entry.name))
    .sort((left, right) => left.split("/").length - right.split("/").length);
  if (!configs.length) throw new Error("压缩包中没有找到 .ok 配置");
  const config = configs[0];
  const rootPrefix = config.includes("/")
    ? config.slice(0, config.lastIndexOf("/") + 1)
    : "";
  const root =
    rootPrefix.split("/").filter(Boolean).at(-1) ||
    config.split("/").at(-1)!.replace(/\.ok$/i, "");
  return { zip, entries, configs, config, rootPrefix, root };
}

async function archivePreview(file: Blob): Promise<ArchivePreview> {
  const loaded = await loadZip(file);
  let expandedBytes = 0;
  let count = 0;
  for (const entry of loaded.entries) {
    if (entry.dir) continue;
    const bytes = await entry.async("uint8array");
    expandedBytes += bytes.byteLength;
    count += 1;
    if (expandedBytes > MAX_EXPANDED_BYTES) {
      throw new Error("压缩包解压后不能超过 200 MB");
    }
  }
  const existing = await listStoredAssignments();
  return {
    root: loaded.root,
    entries: count,
    expandedBytes,
    configs: loaded.configs,
    conflict: existing.some(
      (item) => item.assignment.directory.toLowerCase() === loaded.root.toLowerCase(),
    ),
  };
}

async function importArchive(file: Blob): Promise<{ root: string }> {
  const preview = await archivePreview(file);
  if (preview.conflict) throw new Error(`目录 ${preview.root} 已存在`);
  const loaded = await loadZip(file);
  const archive: Record<string, Uint8Array> = {};
  const inspectionFiles: Record<string, string> = {};
  for (const entry of loaded.entries) {
    if (entry.dir) continue;
    const fullPath = normalizePath(entry.name);
    if (loaded.rootPrefix && !fullPath.startsWith(loaded.rootPrefix)) continue;
    const path = fullPath.slice(loaded.rootPrefix.length);
    if (!path) continue;
    const bytes = await entry.async("uint8array");
    archive[path] = bytes;
    if (TEXT_EXTENSIONS.has(extension(path)) || path === "ok") {
      inspectionFiles[path] = new TextDecoder().decode(bytes);
    }
  }
  const inspected = await pythonBridge.request<InspectionResult>(
    "inspect",
    inspectionFiles,
    { timeout: 45_000 },
  );
  const stable = inspected.config.endpoint || `${loaded.root}:${loaded.config}`;
  const assignmentId = `a-${(await sha256(stable)).slice(0, 14)}`;
  const files: StoredAssignment["files"] = {};
  const sourceIdByPath = new Map<string, string>();
  for (const [index, path] of inspected.config.src.entries()) {
    const id = `${assignmentId}:file:${index}`;
    sourceIdByPath.set(path, id);
    const content = inspectionFiles[path] ?? new TextDecoder().decode(archive[path] || []);
    files[id] = {
      id,
      path,
      name: path.split("/").at(-1) || path,
      language: languageFor(path),
      content,
      hash: await sha256(content),
      backup: null,
    };
  }
  const url = sourceUrl(inspected.config.endpoint, loaded.root);
  const assignment: Assignment = {
    id: assignmentId,
    name: inspected.config.name,
    directory: loaded.root,
    endpoint: inspected.config.endpoint,
    sourceUrl: url,
    downloadUrl: `${url}${url.split("/").filter(Boolean).at(-1)}.zip`,
    files: Object.values(files).map(({ id, name, language }) => ({
      id,
      name,
      language,
    })),
    questions: inspected.questions.map((question) => ({
      id: question.id,
      title: question.title,
      kind: question.kind,
      cases: question.cases,
      sourceHint:
        (question.sourcePath && sourceIdByPath.get(question.sourcePath)) ||
        Object.keys(files)[0] ||
        null,
    })),
    defaultTests: inspected.config.default_tests || [],
  };
  await putStoredAssignment({
    id: assignmentId,
    assignment,
    files,
    archive,
    answers: inspected.answers,
    content: null,
    installedAt: new Date().toISOString(),
  });
  return { root: loaded.root };
}

function fallbackContent(workspace: StoredAssignment): AssignmentContent {
  const sections: Record<string, string> = {};
  for (const question of workspace.assignment.questions) {
    const prompts = question.cases
      .map(
        (item) =>
          `<pre><code>${item.prompt
            .replaceAll("&", "&amp;")
            .replaceAll("<", "&lt;")
            .replaceAll(">", "&gt;")}</code></pre>`,
      )
      .join("");
    sections[question.id] =
      `<h2>${question.title}</h2>` +
      (prompts || "<p>题目要求请参考源码中的函数文档字符串。</p>");
  }
  return {
    title: workspace.assignment.name,
    sourceUrl: workspace.assignment.sourceUrl,
    source: "local",
    stale: false,
    fetchedAt: null,
    overviewHtml:
      "<p>官方题面暂时无法读取。编辑、浏览器本地保存和测试仍然可用。</p>",
    sections,
  };
}

function parseOfficialContent(
  assignment: Assignment,
  documentText: string,
): AssignmentContent {
  const document = new DOMParser().parseFromString(documentText, "text/html");
  const main =
    document.querySelector("main") || document.querySelector("#content") || document.body;
  main.querySelectorAll("script,style,nav,form,button").forEach((node) => node.remove());
  main.querySelectorAll<HTMLElement>("[href],[src]").forEach((node) => {
    for (const attribute of ["href", "src"]) {
      const value = node.getAttribute(attribute);
      if (!value) continue;
      try {
        node.setAttribute(attribute, new URL(value, assignment.sourceUrl).href);
      } catch {
        node.removeAttribute(attribute);
      }
    }
  });
  const headings = Array.from(main.querySelectorAll<HTMLElement>("h2,h3,h4"));
  const sections: Record<string, string> = {};
  for (const question of assignment.questions) {
    const normalized = question.id.replaceAll(/[-_]/g, " ").toLowerCase();
    const heading =
      headings.find((candidate) => {
        let sibling: Element | null = candidate;
        let text = "";
        while (sibling && text.length < 8_000) {
          text += ` ${sibling.textContent || ""}`;
          sibling = sibling.nextElementSibling;
          if (sibling?.matches("h2,h3,h4")) break;
        }
        return (
          new RegExp(`\\bok\\s+-q\\s+${question.id.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`).test(
            text,
          ) || candidate.textContent?.toLowerCase().includes(normalized)
        );
      }) || null;
    if (!heading) continue;
    const level = Number(heading.tagName.slice(1));
    const container = document.createElement("div");
    let current: Element | null = heading;
    while (current) {
      if (
        current !== heading &&
        /^H[1-6]$/.test(current.tagName) &&
        Number(current.tagName.slice(1)) <= level
      )
        break;
      container.append(current.cloneNode(true));
      current = current.nextElementSibling;
    }
    if (question.kind !== "code") {
      container.querySelectorAll(".solution").forEach((node) => node.remove());
    }
    sections[question.id] = container.innerHTML;
  }
  return {
    title: document.querySelector("h1")?.textContent?.trim() || assignment.name,
    sourceUrl: assignment.sourceUrl,
    source: "official",
    stale: false,
    fetchedAt: new Date().toISOString(),
    overviewHtml: main.innerHTML,
    sections,
  };
}

async function translateHtml(html: string): Promise<TranslationResult> {
  const document = new DOMParser().parseFromString(`<main>${html}</main>`, "text/html");
  const root = document.querySelector("main")!;
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT);
  const nodes: Text[] = [];
  while (walker.nextNode()) {
    const node = walker.currentNode as Text;
    if (
      node.data.trim() &&
      !node.parentElement?.closest("code,pre,kbd,samp,script,style")
    )
      nodes.push(node);
  }
  for (const node of nodes) {
    const original = node.data.trim();
    if (!/[A-Za-z]{2}/.test(original)) continue;
    const response = await fetch(
      `https://api.mymemory.translated.net/get?q=${encodeURIComponent(
        original.slice(0, 480),
      )}&langpair=en|zh-CN`,
    );
    if (!response.ok) throw new Error("翻译服务暂时不可用");
    const payload = await response.json();
    const translated = String(payload.responseData?.translatedText || original);
    node.data = node.data.replace(original, translated);
  }
  return {
    html: root.innerHTML,
    provider: "MyMemory",
    sourceLanguage: "en",
    targetLanguage: "zh-CN",
  };
}

type RawCatalogItem = Omit<CatalogItem, "installed" | "assignmentId">;

function parseCatalog(documentText: string): RawCatalogItem[] {
  const document = new DOMParser().parseFromString(documentText, "text/html");
  const found = new Map<string, RawCatalogItem>();
  for (const link of document.querySelectorAll<HTMLAnchorElement>("a[href]")) {
    let url: URL;
    try {
      url = new URL(link.href, "https://cs61a.org/");
    } catch {
      continue;
    }
    if (url.hostname !== "cs61a.org") continue;
    const match = url.pathname.match(/^\/(lab|hw|proj)\/([a-zA-Z0-9_-]+)\/?$/);
    if (!match || match[2].toLowerCase().startsWith("sol-")) continue;
    const [, category, slug] = match;
    const id = `${category.toLowerCase()}:${slug.toLowerCase()}`;
    const pageUrl = `https://cs61a.org/${category.toLowerCase()}/${slug}/`;
    found.set(id, {
      id,
      name: link.textContent?.trim().replace(/\s+/g, " ") || slug,
      category: category.toLowerCase() as CatalogItem["category"],
      slug,
      pageUrl,
      downloadUrl: `${pageUrl}${slug}.zip`,
    });
  }
  const categoryOrder = { lab: 0, hw: 1, proj: 2 };
  return Array.from(found.values()).sort(
    (left, right) =>
      categoryOrder[left.category] - categoryOrder[right.category] ||
      left.slug.localeCompare(right.slug, undefined, { numeric: true }),
  );
}

async function rawCatalog(refresh: boolean): Promise<RawCatalogItem[]> {
  const cacheKey = "cs61a-catalog:v1";
  if (!refresh) {
    try {
      const cached = JSON.parse(localStorage.getItem(cacheKey) || "null");
      if (
        cached?.fetchedAt &&
        Date.now() - Number(cached.fetchedAt) < 60 * 60 * 1000 &&
        Array.isArray(cached.items)
      )
        return cached.items;
    } catch {
      localStorage.removeItem(cacheKey);
    }
  }
  try {
    const response = await fetchCourse("https://cs61a.org/");
    const parsed = parseCatalog(await response.text());
    if (parsed.length) {
      localStorage.setItem(
        cacheKey,
        JSON.stringify({ fetchedAt: Date.now(), items: parsed }),
      );
      return parsed;
    }
  } catch {
    // The bundled snapshot keeps the app usable when the official site is offline.
  }
  const response = await fetch("/catalog.json");
  if (!response.ok) throw new Error("无法加载作业目录");
  return (await response.json()) as RawCatalogItem[];
}

async function catalog(refresh = false): Promise<CatalogItem[]> {
  const raw = (await rawCatalog(refresh)) as Omit<
    CatalogItem,
    "installed" | "assignmentId"
  >[];
  const installed = await listStoredAssignments();
  return raw.map((item) => {
    const match = installed.find(
      (workspace) =>
        workspace.assignment.sourceUrl.replace(/\/$/, "").toLowerCase() ===
        item.pageUrl.replace(/\/$/, "").toLowerCase(),
    );
    return {
      ...item,
      installed: Boolean(match),
      assignmentId: match?.id || null,
    };
  });
}

export const api = {
  async assignments(_refresh = false): Promise<Assignment[]> {
    return (await listStoredAssignments()).map((item) => item.assignment);
  },

  async content(assignmentId: string): Promise<AssignmentContent> {
    const workspace = await getStoredAssignment(assignmentId);
    if (!workspace) throw new Error("没有找到这份本地作业");
    if (workspace.content) return workspace.content;
    try {
      const response = await fetchCourse(workspace.assignment.sourceUrl);
      const content = parseOfficialContent(
        workspace.assignment,
        await response.text(),
      );
      workspace.content = content;
      await putStoredAssignment(workspace);
      return content;
    } catch {
      return fallbackContent(workspace);
    }
  },

  catalog(refresh = false): Promise<CatalogItem[]> {
    return catalog(refresh);
  },

  async installCatalogItem(catalogId: string): Promise<{ assignment: string }> {
    const item = (await catalog()).find((candidate) => candidate.id === catalogId);
    if (!item) throw new Error("官方目录中没有找到该作业");
    if (item.installed) throw new Error("该作业已经安装");
    const response = await fetchCourse(item.downloadUrl);
    const result = await importArchive(await response.blob());
    return { assignment: result.root };
  },

  translate(html: string): Promise<TranslationResult> {
    return translateHtml(html);
  },

  async file(fileId: string): Promise<FileDocument> {
    const found = await findStoredFile(fileId);
    if (!found) throw new Error("没有找到源码文件");
    const { backup: _backup, path: _path, ...document } = found.file;
    return document;
  },

  async saveFile(
    fileId: string,
    content: string,
    baseHash: string,
    force = false,
  ): Promise<FileDocument> {
    const found = await findStoredFile(fileId);
    if (!found) throw new Error("没有找到源码文件");
    if (!force && found.file.hash !== baseHash) {
      const error = new Error("文件内容版本冲突");
      Object.assign(error, { status: 409 });
      throw error;
    }
    found.file.backup = found.file.content;
    found.file.content = content;
    found.file.hash = await sha256(content);
    found.workspace.archive[found.file.path] = new TextEncoder().encode(content);
    await putStoredAssignment(found.workspace);
    const { backup: _backup, path: _path, ...document } = found.file;
    return document;
  },

  async restoreFile(fileId: string): Promise<FileDocument> {
    const found = await findStoredFile(fileId);
    if (!found || found.file.backup === null) throw new Error("没有可恢复的备份");
    const current = found.file.content;
    found.file.content = found.file.backup;
    found.file.backup = current;
    found.file.hash = await sha256(found.file.content);
    found.workspace.archive[found.file.path] = new TextEncoder().encode(
      found.file.content,
    );
    await putStoredAssignment(found.workspace);
    const { backup: _backup, path: _path, ...document } = found.file;
    return document;
  },

  async checkTheory(payload: {
    assignmentId: string;
    questionId: string;
    caseId: string;
    answer: string;
  }): Promise<{ correct: boolean; feedback: string }> {
    const workspace = await getStoredAssignment(payload.assignmentId);
    const expected = workspace?.answers[`${payload.questionId}:${payload.caseId}`];
    if (expected === undefined) throw new Error("没有找到这道公开题目的答案");
    const normalize = (value: string) =>
      value
        .replaceAll("\r\n", "\n")
        .trim()
        .split("\n")
        .map((line) => line.trimEnd())
        .join("\n")
        .toLocaleLowerCase();
    const correct = normalize(payload.answer) === normalize(expected);
    return {
      correct,
      feedback: correct ? "回答正确" : "还不正确，请再试一次",
    };
  },

  previewImport(file: File): Promise<ArchivePreview> {
    return archivePreview(file);
  },

  importZip(file: File): Promise<{ root: string }> {
    return importArchive(file);
  },

  async startRun(
    assignmentId: string,
    questionId: string | null,
  ): Promise<{ id: string; status: string }> {
    const workspace = await getStoredAssignment(assignmentId);
    if (!workspace) throw new Error("没有找到这份本地作业");
    const id = crypto.randomUUID();
    const state: RunState = {
      id,
      status: "queued",
      output: "",
      result: null,
      listeners: new Set(),
      cancelled: false,
    };
    runs.set(id, state);
    queueMicrotask(async () => {
      state.status = "running";
      emit(state, { type: "status", status: "running" });
      try {
        const result = await pythonBridge.request<{ output: string; exitCode: number }>(
          "run",
          {
            question: questionId,
            files: Object.entries(workspace.archive).map(([path, data]) => ({
              path,
              data,
            })),
          },
          {
            timeout: 65_000,
            onOutput: (text) => {
              state.output = (state.output + text).slice(-1_000_000);
              emit(state, { type: "output", text });
            },
          },
        );
        if (state.cancelled) return;
        state.result = parseOkOutput(state.output || result.output, result.exitCode);
      } catch (error) {
        const message = (error as Error).message;
        state.result = {
          status: state.cancelled
            ? "cancelled"
            : message.includes("超时")
              ? "timeout"
              : "error",
          summary: state.cancelled ? "测试已取消" : message,
          passed: 0,
          failed: 0,
          details: [],
          raw: state.output,
        };
      }
      state.status = state.result.status;
      emit(state, { type: "complete", result: state.result });
    });
    return { id, status: "queued" };
  },

  async cancelRun(runId: string): Promise<{ ok: boolean }> {
    const state = runs.get(runId);
    if (!state) return { ok: false };
    state.cancelled = true;
    pythonBridge.cancel();
    return { ok: true };
  },

  subscribeRun(
    runId: string,
    onEvent: (event: {
      type: string;
      status?: string;
      text?: string;
      result?: RunResult;
    }) => void,
  ): { close: () => void } {
    const state = runs.get(runId);
    if (!state) throw new Error("没有找到测试任务");
    state.listeners.add(onEvent);
    onEvent({ type: "status", status: state.status });
    if (state.output) onEvent({ type: "output", text: state.output });
    if (state.result) onEvent({ type: "complete", result: state.result });
    return { close: () => state.listeners.delete(onEvent) };
  },
};
