import type {
  Assignment,
  AssignmentContent,
  CatalogItem,
  FileDocument,
  RunResult,
  TranslationResult,
} from "./types";

async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const response = await fetch(url, init);
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(payload?.detail || `请求失败 (${response.status})`);
    Object.assign(error, { status: response.status, payload });
    throw error;
  }
  return payload as T;
}

export const serverApi = {
  async assignments(refresh = false): Promise<Assignment[]> {
    const result = await request<{ assignments: Assignment[] }>(
      refresh ? "/api/assignments/refresh" : "/api/assignments",
      refresh ? { method: "POST" } : undefined,
    );
    return result.assignments;
  },

  content(assignmentId: string): Promise<AssignmentContent> {
    return request(`/api/assignments/${assignmentId}/content`);
  },

  async catalog(refresh = false): Promise<CatalogItem[]> {
    const query = refresh ? "?refresh=true" : "";
    const result = await request<{ items: CatalogItem[] }>(`/api/catalog${query}`);
    return result.items;
  },

  installCatalogItem(catalogId: string): Promise<{ assignment: string }> {
    return request(`/api/catalog/${encodeURIComponent(catalogId)}/install`, {
      method: "POST",
    });
  },

  translate(html: string): Promise<TranslationResult> {
    return request("/api/translate", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ html }),
    });
  },

  file(fileId: string): Promise<FileDocument> {
    return request(`/api/files/${fileId}`);
  },

  saveFile(
    fileId: string,
    content: string,
    baseHash: string,
    force = false,
  ): Promise<FileDocument> {
    return request(`/api/files/${fileId}`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ content, baseHash, force }),
    });
  },

  restoreFile(fileId: string): Promise<FileDocument> {
    return request(`/api/files/${fileId}/restore`, { method: "POST" });
  },

  checkTheory(payload: {
    assignmentId: string;
    questionId: string;
    caseId: string;
    answer: string;
  }): Promise<{ correct: boolean; feedback: string }> {
    return request("/api/theory/check", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  },

  async previewImport(file: File) {
    const form = new FormData();
    form.append("file", file);
    return request<{
      root: string;
      entries: number;
      expandedBytes: number;
      configs: string[];
      conflict: boolean;
    }>("/api/imports/preview", { method: "POST", body: form });
  },

  async importZip(file: File) {
    const form = new FormData();
    form.append("file", file);
    return request<{ root: string }>("/api/imports", {
      method: "POST",
      body: form,
    });
  },

  startRun(
    assignmentId: string,
    questionId: string | null,
  ): Promise<{ id: string; status: string }> {
    return request("/api/runs", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ assignmentId, questionId }),
    });
  },

  cancelRun(runId: string): Promise<{ ok: boolean }> {
    return request(`/api/runs/${runId}`, { method: "DELETE" });
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
    const source = new EventSource(`/api/runs/${runId}/events`);
    source.onmessage = (message) => {
      const event = JSON.parse(message.data);
      onEvent(event);
      if (event.type === "complete") source.close();
    };
    return source;
  },
};
