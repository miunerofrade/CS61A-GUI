import type { RunResult } from "./types";

interface WorkerReply<T> {
  id: number;
  result?: T;
  error?: string;
  output?: string;
}

interface PendingRequest<T> {
  resolve: (value: T) => void;
  reject: (error: Error) => void;
  onOutput?: (text: string) => void;
  timer?: number;
}

export interface InspectionResult {
  config: {
    name: string;
    endpoint: string;
    src: string[];
    default_tests?: string[];
  };
  questions: Array<{
    id: string;
    title: string;
    kind: "code" | "concept" | "wwpp";
    cases: Array<{ id: string; prompt: string; choices?: string[] }>;
    sourcePath: string | null;
  }>;
  answers: Record<string, string>;
}

class PythonBridge {
  private worker: Worker | null = null;
  private sequence = 0;
  private pending = new Map<number, PendingRequest<unknown>>();

  private getWorker(): Worker {
    if (this.worker) return this.worker;
    this.worker = new Worker(new URL("./python.worker.ts", import.meta.url), {
      type: "module",
    });
    this.worker.onmessage = (event: MessageEvent<WorkerReply<unknown>>) => {
      const request = this.pending.get(event.data.id);
      if (!request) return;
      if (event.data.output) {
        request.onOutput?.(event.data.output);
        return;
      }
      this.pending.delete(event.data.id);
      if (request.timer) window.clearTimeout(request.timer);
      if (event.data.error) request.reject(new Error(event.data.error));
      else request.resolve(event.data.result);
    };
    this.worker.onerror = (event) => {
      this.failAll(new Error(event.message || "浏览器 Python 运行器加载失败"));
    };
    return this.worker;
  }

  private failAll(error: Error) {
    for (const request of this.pending.values()) request.reject(error);
    this.pending.clear();
    this.worker?.terminate();
    this.worker = null;
  }

  request<T>(
    action: "inspect" | "run",
    payload: unknown,
    options: { timeout?: number; onOutput?: (text: string) => void } = {},
  ): Promise<T> {
    const id = ++this.sequence;
    return new Promise<T>((resolve, reject) => {
      const pending: PendingRequest<T> = { resolve, reject, onOutput: options.onOutput };
      if (options.timeout) {
        pending.timer = window.setTimeout(() => {
          this.failAll(new Error("测试运行超时，已终止浏览器 Python Worker"));
        }, options.timeout);
      }
      this.pending.set(id, pending as PendingRequest<unknown>);
      this.getWorker().postMessage({ id, action, payload });
    });
  }

  cancel() {
    this.failAll(new Error("测试已取消"));
  }
}

export const pythonBridge = new PythonBridge();

export function parseOkOutput(output: string, exitCode: number): RunResult {
  const passedMatch = output.match(/(\d+)\s+test cases?\s+passed/i);
  const failedMatch = output.match(/(\d+)\s+(?:test cases?\s+)?failed/i);
  const passed = passedMatch ? Number(passedMatch[1]) : 0;
  const failed = failedMatch ? Number(failedMatch[1]) : 0;
  let status: RunResult["status"];
  let summary: string;
  if (output.includes("No cases failed")) {
    status = "passed";
    summary = `${passed || 1} 个测试通过`;
  } else if (/# Error:|FAILED/i.test(output) || failed) {
    status = "failed";
    summary = "测试未通过";
  } else if (/Traceback \(most recent call last\)/.test(output) || exitCode !== 0) {
    status = "error";
    summary = "浏览器 OK 运行异常";
  } else {
    status = "passed";
    summary = "测试完成";
  }
  return {
    status,
    summary,
    passed,
    failed,
    details: [],
    raw: output,
  };
}
