/// <reference lib="webworker" />

// Pyodide's official browser build is loaded in this isolated module worker.
// @ts-expect-error CDN modules do not ship through the local TypeScript resolver.
import { loadPyodide } from "https://cdn.jsdelivr.net/pyodide/v314.0.2/full/pyodide.mjs";

declare const self: DedicatedWorkerGlobalScope;

const pyodidePromise = loadPyodide({
  indexURL: "https://cdn.jsdelivr.net/pyodide/v314.0.2/full/",
});

const INSPECT_SCRIPT = String.raw`
import ast, doctest, json, pathlib, re

files = json.loads(payload_json)
config_path = next((path for path in sorted(files) if path.endswith(".ok")), None)
if not config_path:
    raise ValueError("压缩包中没有找到 .ok 配置")
config = json.loads(files[config_path])
src = [str(item).replace("\\", "/") for item in config.get("src", [])]
metadata = {}
answers = {}
source_nodes = {}

def literal_test(source):
    module = ast.parse(source)
    for node in module.body:
        if isinstance(node, ast.Assign) and any(isinstance(t, ast.Name) and t.id == "test" for t in node.targets):
            value = ast.literal_eval(node.value)
            return value if isinstance(value, dict) else None
    return None

def parse_wwpp(code):
    pending, result = [], []
    for example in doctest.DocTestParser().get_examples(code):
        source = example.source.rstrip()
        lines = source.splitlines()
        pending.append("\n".join([f">>> {lines[0]}"] + [f"... {line}" for line in lines[1:]]))
        wanted = example.want.strip()
        if wanted:
            result.append(("\n".join(pending), wanted))
            pending = []
    return result

for path, source in sorted(files.items()):
    if not path.startswith("tests/") or not path.endswith(".py"):
        continue
    try:
        test = literal_test(source)
    except Exception:
        continue
    if not test:
        continue
    question_id = pathlib.PurePosixPath(path).stem
    suites = [suite for suite in test.get("suites", []) if isinstance(suite, dict)]
    suite_types = {str(suite.get("type", "")) for suite in suites}
    if suite_types and suite_types <= {"concept"}:
        kind = "concept"
    elif "wwpp" in suite_types:
        kind = "wwpp"
    else:
        metadata[question_id] = {
            "id": question_id, "title": str(test.get("name") or question_id),
            "kind": "code", "cases": [], "sourcePath": None,
        }
        continue
    public_cases, case_number = [], 0
    for suite in suites:
        for case in suite.get("cases", []):
            if not isinstance(case, dict) or case.get("hidden"):
                continue
            if suite.get("type") == "concept":
                case_id = f"case-{case_number}"; case_number += 1
                public_cases.append({
                    "id": case_id,
                    "prompt": str(case.get("question", "")).strip(),
                    "choices": [str(choice) for choice in case.get("choices", [])],
                })
                answers[f"{question_id}:{case_id}"] = str(case.get("answer", "")).strip()
            elif suite.get("type") == "wwpp":
                for prompt, answer in parse_wwpp(str(case.get("code", ""))):
                    case_id = f"case-{case_number}"; case_number += 1
                    public_cases.append({"id": case_id, "prompt": prompt})
                    answers[f"{question_id}:{case_id}"] = answer
    metadata[question_id] = {
        "id": question_id, "title": str(test.get("name") or question_id),
        "kind": kind, "cases": public_cases, "sourcePath": None,
    }

for path in src:
    source = files.get(path)
    if not source or not path.endswith(".py"):
        continue
    try:
        module = ast.parse(source)
    except SyntaxError:
        continue
    for node in module.body:
        if isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
            source_nodes[node.name] = path
            doc = ast.get_docstring(node) or ""
            if ">>>" in doc and node.name not in metadata:
                metadata[node.name] = {
                    "id": node.name, "title": node.name.replace("_", " ").title(),
                    "kind": "code", "cases": [], "sourcePath": path,
                }

for question_id, item in metadata.items():
    item["sourcePath"] = source_nodes.get(question_id) or (src[0] if src else None)

defaults = [str(item) for item in config.get("default_tests", [])]
order = {name: index for index, name in enumerate(defaults)}
questions = sorted(metadata.values(), key=lambda item: (order.get(item["id"], 10000), item["id"]))
json.dumps({
    "config": {
        "name": str(config.get("name") or pathlib.PurePosixPath(config_path).stem),
        "endpoint": str(config.get("endpoint") or ""),
        "src": src,
        "default_tests": defaults,
    },
    "questions": questions,
    "answers": answers,
})
`;

const RUN_SCRIPT = String.raw`
import contextlib, io, json, os, runpy, sys, traceback

settings = json.loads(payload_json)
os.chdir("/workspace")
sys.path.insert(0, "/workspace")
args = ["ok", "--local", "--nointeract"]
if settings.get("question"):
    args += ["-q", settings["question"]]
sys.argv = args
stream = io.StringIO()
exit_code = 0
try:
    with contextlib.redirect_stdout(stream), contextlib.redirect_stderr(stream):
        runpy.run_path("/workspace/ok", run_name="__main__")
except SystemExit as exc:
    exit_code = int(exc.code or 0) if isinstance(exc.code, (int, type(None))) else 1
except BaseException:
    exit_code = 1
    stream.write(traceback.format_exc())
json.dumps({"output": stream.getvalue(), "exitCode": exit_code})
`;

async function clearWorkspace(pyodide: Awaited<typeof pyodidePromise>) {
  pyodide.runPython(`
import os, shutil
if os.path.exists("/workspace"):
    shutil.rmtree("/workspace")
os.makedirs("/workspace")
`);
}

self.onmessage = async (event) => {
  const { id, action, payload } = event.data;
  try {
    const pyodide = await pyodidePromise;
    if (action === "inspect") {
      pyodide.globals.set("payload_json", JSON.stringify(payload));
      const raw = await pyodide.runPythonAsync(INSPECT_SCRIPT);
      self.postMessage({ id, result: JSON.parse(String(raw)) });
      return;
    }
    if (action === "run") {
      await clearWorkspace(pyodide);
      for (const file of payload.files) {
        const path = `/workspace/${file.path}`;
        const parent = path.slice(0, path.lastIndexOf("/"));
        pyodide.FS.mkdirTree(parent);
        pyodide.FS.writeFile(path, file.data);
      }
      self.postMessage({ id, output: "正在浏览器中启动 Python 与 OK…\n" });
      pyodide.globals.set(
        "payload_json",
        JSON.stringify({ question: payload.question }),
      );
      const raw = await pyodide.runPythonAsync(RUN_SCRIPT);
      const result = JSON.parse(String(raw));
      if (result.output) self.postMessage({ id, output: result.output });
      self.postMessage({ id, result });
      return;
    }
    throw new Error("未知 Worker 操作");
  } catch (error) {
    self.postMessage({
      id,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

export {};
