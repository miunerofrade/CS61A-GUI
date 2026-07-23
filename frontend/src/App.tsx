import Editor, { type OnMount } from "@monaco-editor/react";
import DOMPurify from "dompurify";
import {
  BookOpen,
  Box,
  Check,
  CheckCircle2,
  ChevronDown,
  ChevronRight,
  ChevronUp,
  Circle,
  Clock3,
  CloudDownload,
  Code2,
  ExternalLink,
  FileArchive,
  FileCode2,
  Languages,
  LoaderCircle,
  LockKeyhole,
  PanelBottomClose,
  PanelBottomOpen,
  PanelRightClose,
  PanelRightOpen,
  Play,
  RefreshCw,
  RotateCcw,
  Save,
  Square,
  TestTube2,
  XCircle,
} from "lucide-react";
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { api } from "./api";
import type {
  Assignment,
  AssignmentContent,
  CatalogItem,
  FileDocument,
  Question,
  RunResult,
  TheoryCase,
} from "./types";

type Feedback = { correct: boolean; feedback: string };

const progressKey = (assignmentId: string, questionId: string, caseId: string) =>
  `cs61a-progress:${assignmentId}:${questionId}:${caseId}`;

function App() {
  const [assignments, setAssignments] = useState<Assignment[]>([]);
  const [catalog, setCatalog] = useState<CatalogItem[]>([]);
  const [selectedAssignmentId, setSelectedAssignmentId] = useState("");
  const [selectedQuestionId, setSelectedQuestionId] = useState("");
  const [content, setContent] = useState<AssignmentContent | null>(null);
  const [document, setDocument] = useState<FileDocument | null>(null);
  const [editorValue, setEditorValue] = useState("");
  const [dirty, setDirty] = useState(false);
  const [loading, setLoading] = useState(true);
  const [catalogLoading, setCatalogLoading] = useState(true);
  const [installingId, setInstallingId] = useState("");
  const [notice, setNotice] = useState("");
  const [translatedHtml, setTranslatedHtml] = useState("");
  const [showTranslation, setShowTranslation] = useState(false);
  const [translating, setTranslating] = useState(false);
  const [runId, setRunId] = useState("");
  const [runStatus, setRunStatus] = useState("");
  const [runOutput, setRunOutput] = useState("");
  const [runResult, setRunResult] = useState<RunResult | null>(null);
  const [resultsOpen, setResultsOpen] = useState(
    () => window.localStorage.getItem("cs61a-layout:results-open") === "true",
  );
  const [editorCollapsed, setEditorCollapsed] = useState(false);
  const importRef = useRef<HTMLInputElement>(null);
  const editorRef = useRef<Parameters<OnMount>[0] | null>(null);

  const selectedAssignment = useMemo(
    () => assignments.find((item) => item.id === selectedAssignmentId) ?? null,
    [assignments, selectedAssignmentId],
  );
  const selectedQuestion = useMemo(
    () =>
      selectedAssignment?.questions.find(
        (item) => item.id === selectedQuestionId,
      ) ?? null,
    [selectedAssignment, selectedQuestionId],
  );
  const lockedCatalog = useMemo(
    () => catalog.filter((item) => !item.installed),
    [catalog],
  );

  const loadAssignments = useCallback(async (refresh = false) => {
    setLoading(true);
    try {
      const found = await api.assignments(refresh);
      setAssignments(found);
      setSelectedAssignmentId((current) =>
        found.some((item) => item.id === current) ? current : found[0]?.id || "",
      );
      setNotice(refresh ? `已发现 ${found.length} 份作业` : "");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadAssignments();
  }, [loadAssignments]);

  const loadCatalog = useCallback(async (refresh = false) => {
    setCatalogLoading(true);
    try {
      setCatalog(await api.catalog(refresh));
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setCatalogLoading(false);
    }
  }, []);

  useEffect(() => {
    void loadCatalog();
  }, [loadCatalog]);

  useEffect(() => {
    if (!selectedAssignment) return;
    setSelectedQuestionId((current) =>
      selectedAssignment.questions.some((item) => item.id === current)
        ? current
        : selectedAssignment.questions[0]?.id || "",
    );
    setContent(null);
    void api
      .content(selectedAssignment.id)
      .then(setContent)
      .catch((error) => setNotice((error as Error).message));
  }, [selectedAssignment]);

  useEffect(() => {
    setTranslatedHtml("");
    setShowTranslation(false);
  }, [selectedAssignmentId, selectedQuestionId]);

  useEffect(() => {
    window.localStorage.setItem("cs61a-layout:results-open", String(resultsOpen));
  }, [resultsOpen]);

  useEffect(() => {
    if (!selectedQuestion) return;
    const saved = window.localStorage.getItem(
      `cs61a-layout:editor-collapsed:${selectedQuestion.kind}`,
    );
    setEditorCollapsed(
      saved === null ? selectedQuestion.kind !== "code" : saved === "true",
    );
  }, [selectedQuestion?.id, selectedQuestion?.kind]);

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setResultsOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, []);

  const openFile = useCallback(
    async (fileId: string) => {
      if (dirty && document) {
        const proceed = window.confirm("当前文件尚未保存，确定切换文件吗？");
        if (!proceed) return;
      }
      try {
        const next = await api.file(fileId);
        setDocument(next);
        setEditorValue(next.content);
        setDirty(false);
      } catch (error) {
        setNotice((error as Error).message);
      }
    },
    [dirty, document],
  );

  useEffect(() => {
    if (!selectedAssignment || !selectedQuestion || selectedQuestion.kind !== "code") {
      setDocument(null);
      setEditorValue("");
      setDirty(false);
      return;
    }
    const fileId = selectedQuestion.sourceHint || selectedAssignment.files[0]?.id;
    if (fileId) void openFile(fileId);
  }, [selectedAssignment, selectedQuestion]); // eslint-disable-line react-hooks/exhaustive-deps

  const save = useCallback(
    async (force = false) => {
      if (!document) return null;
      try {
        const saved = await api.saveFile(
          document.id,
          editorValue,
          document.hash,
          force,
        );
        setDocument(saved);
        setEditorValue(saved.content);
        setDirty(false);
        setNotice(`已保存 ${saved.name}`);
        return saved;
      } catch (error) {
        const typed = error as Error & { status?: number };
        if (
          typed.status === 409 &&
          window.confirm("文件已在外部修改。要用编辑器中的内容覆盖吗？")
        ) {
          return save(true);
        }
        setNotice(typed.message);
        return null;
      }
    },
    [document, editorValue],
  );

  useEffect(() => {
    const listener = (event: KeyboardEvent) => {
      if ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === "s") {
        event.preventDefault();
        void save();
      }
    };
    window.addEventListener("keydown", listener);
    return () => window.removeEventListener("keydown", listener);
  }, [save]);

  const restore = async () => {
    if (!document || !window.confirm("恢复上一次保存前的版本？当前版本会成为新的备份。"))
      return;
    try {
      const restored = await api.restoreFile(document.id);
      setDocument(restored);
      setEditorValue(restored.content);
      setDirty(false);
      setNotice(`已恢复 ${restored.name}`);
    } catch (error) {
      setNotice((error as Error).message);
    }
  };

  const startRun = async (wholeAssignment: boolean) => {
    if (!selectedAssignment) return;
    if (document && (dirty || editorValue !== document.content)) {
      const saved = await save();
      if (!saved) return;
    }
    setResultsOpen(true);
    setRunResult(null);
    setRunOutput("");
    setRunStatus("queued");
    try {
      const started = await api.startRun(
        selectedAssignment.id,
        wholeAssignment ? null : selectedQuestion?.id || null,
      );
      setRunId(started.id);
      api.subscribeRun(started.id, (event) => {
        if (event.type === "status" && event.status) setRunStatus(event.status);
        if (event.type === "output" && event.text)
          setRunOutput((current) => (current + event.text).slice(-1_000_000));
        if (event.type === "complete" && event.result) {
          setRunResult(event.result);
          setRunStatus(event.result.status);
          setRunId("");
        }
      });
    } catch (error) {
      setNotice((error as Error).message);
      setRunStatus("error");
    }
  };

  const cancelRun = async () => {
    if (!runId) return;
    await api.cancelRun(runId);
  };

  const importZip = async (file: File) => {
    try {
      const preview = await api.previewImport(file);
      if (preview.conflict) {
        setNotice(`目录 ${preview.root} 已存在，不会覆盖`);
        return;
      }
      const size = (preview.expandedBytes / 1024 / 1024).toFixed(1);
      if (
        !window.confirm(
          `导入 ${preview.root}？包含 ${preview.entries} 个文件，解压后约 ${size} MB。`,
        )
      )
        return;
      await api.importZip(file);
      await Promise.all([loadAssignments(true), loadCatalog(true)]);
      setNotice(`已导入 ${preview.root}`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      if (importRef.current) importRef.current.value = "";
    }
  };

  const installOfficial = async (item: CatalogItem) => {
    setInstallingId(item.id);
    setNotice(`正在下载 ${item.name}…`);
    try {
      await api.installCatalogItem(item.id);
      await Promise.all([loadAssignments(true), loadCatalog(true)]);
      setNotice(`${item.name} 已下载并安装`);
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setInstallingId("");
    }
  };

  const onEditorMount: OnMount = (editor) => {
    editorRef.current = editor;
    editor.addCommand(2048 | 49, () => void save());
  };

  const selectedHtml =
    (selectedQuestion && content?.sections[selectedQuestion.id]) ||
    content?.overviewHtml ||
    "<p>正在加载题目…</p>";
  const displayedHtml = showTranslation && translatedHtml ? translatedHtml : selectedHtml;

  const toggleTranslation = async () => {
    if (translatedHtml) {
      setShowTranslation((value) => !value);
      return;
    }
    setTranslating(true);
    try {
      const result = await api.translate(selectedHtml);
      setTranslatedHtml(result.html);
      setShowTranslation(true);
      setNotice("题面已由 MyMemory 翻译，可随时切回英文原文");
    } catch (error) {
      setNotice((error as Error).message);
    } finally {
      setTranslating(false);
    }
  };

  return (
    <div className="app-shell">
      <header className="topbar">
        <div className="brand">
          <div className="brand-mark" aria-label="CS 61A">
            <small>CS</small>
            <strong>61A</strong>
          </div>
          <div className="brand-copy">
            <strong>Workspace</strong>
            <span>Local learning studio</span>
          </div>
        </div>
        <div className="top-actions">
          {notice && <span className="notice">{notice}</span>}
          <button
            className="button ghost"
            onClick={() => void Promise.all([loadAssignments(true), loadCatalog(true)])}
          >
            <RefreshCw size={16} /> 刷新作业
          </button>
          <button className="button" onClick={() => importRef.current?.click()}>
            <FileArchive size={16} /> 导入 ZIP
          </button>
          <input
            ref={importRef}
            hidden
            type="file"
            accept=".zip,application/zip"
            onChange={(event) => {
              const file = event.target.files?.[0];
              if (file) void importZip(file);
            }}
          />
        </div>
      </header>

      <main className={`workspace ${editorCollapsed ? "editor-collapsed" : ""}`}>
        <aside className="sidebar">
          <div className="sidebar-heading">
            <span>课程作业</span>
            <span className="count">{assignments.length + lockedCatalog.length}</span>
          </div>
          {loading ? (
            <div className="sidebar-empty">
              <LoaderCircle className="spin" size={20} /> 正在扫描…
            </div>
          ) : assignments.length === 0 ? (
            <div className="sidebar-empty">
              <Box size={24} />
              <p>没有发现标准 OK 作业</p>
              <small>将作业解压到仓库，或导入 ZIP。</small>
            </div>
          ) : (
            assignments.map((assignment) => (
              <AssignmentTree
                key={assignment.id}
                assignment={assignment}
                selectedAssignmentId={selectedAssignmentId}
                selectedQuestionId={selectedQuestionId}
                onSelect={(questionId) => {
                  setSelectedAssignmentId(assignment.id);
                  setSelectedQuestionId(questionId);
                }}
              />
            ))
          )}
          {catalogLoading && !lockedCatalog.length && (
            <div className="catalog-loading">
              <LoaderCircle className="spin" size={14} /> 正在读取官方作业…
            </div>
          )}
          {lockedCatalog.length > 0 && (
            <div className="locked-section">
              <div className="locked-heading">尚未安装</div>
              {lockedCatalog.map((item) => {
                const released = item.released !== false;
                return (
                <div
                  key={item.id}
                  className={`locked-assignment ${released ? "" : "unreleased"}`}
                >
                  <button
                    className="locked-install"
                    disabled={!released || Boolean(installingId)}
                    onClick={() => released && void installOfficial(item)}
                    title={
                      released
                        ? `从 ${item.downloadUrl} 下载并安装`
                        : "该作业尚未在官网发布"
                    }
                  >
                    <span className="locked-icon">
                      {installingId === item.id ? (
                        <LoaderCircle className="spin" size={16} />
                      ) : !released ? (
                        <Clock3 size={15} />
                      ) : (
                        <LockKeyhole size={15} />
                      )}
                    </span>
                    <span>
                      <strong>{item.name}</strong>
                      <small>
                        {item.category === "lab"
                          ? "Lab"
                          : item.category === "hw"
                            ? "Homework"
                            : "Project"}{" "}
                        · {released ? "点击安装" : "尚未发布"}
                      </small>
                    </span>
                    {released ? <CloudDownload size={15} /> : <Clock3 size={14} />}
                  </button>
                  <a
                    className="assignment-official"
                    href={released ? item.pageUrl : "https://cs61a.org/"}
                    target="_blank"
                    rel="noreferrer"
                    title={released ? "打开作业官网" : "查看 CS61A 课程官网"}
                    aria-label={`打开 ${item.name} 官方网站`}
                  >
                    <ExternalLink size={14} />
                  </a>
                </div>
                );
              })}
            </div>
          )}
        </aside>

        <section className="problem-pane">
          {selectedAssignment && selectedQuestion ? (
            <>
              <div className="pane-toolbar problem-toolbar">
                <div>
                  <span className={`kind-chip ${selectedQuestion.kind}`}>
                    {selectedQuestion.kind === "code"
                      ? "编程题"
                      : selectedQuestion.kind === "concept"
                        ? "概念题"
                        : "WWPD"}
                  </span>
                  <h1>{selectedQuestion.title}</h1>
                </div>
                <div className="problem-actions">
                  <button
                    className="panel-toggle"
                    type="button"
                    onClick={() =>
                      setEditorCollapsed((value) => {
                        const next = !value;
                        window.localStorage.setItem(
                          `cs61a-layout:editor-collapsed:${selectedQuestion.kind}`,
                          String(next),
                        );
                        return next;
                      })
                    }
                    title={editorCollapsed ? "展开编辑区" : "收起编辑区"}
                    aria-label={editorCollapsed ? "展开编辑区" : "收起编辑区"}
                    aria-pressed={!editorCollapsed}
                  >
                    {editorCollapsed ? (
                      <PanelRightOpen size={16} />
                    ) : (
                      <PanelRightClose size={16} />
                    )}
                    <span>{editorCollapsed ? "展开编辑区" : "收起编辑区"}</span>
                  </button>
                  <button
                    className={`translate-button ${showTranslation ? "active" : ""}`}
                    disabled={translating || !content}
                    onClick={() => void toggleTranslation()}
                    title={showTranslation ? "查看英文原文" : "翻译为中文"}
                  >
                    {translating ? (
                      <LoaderCircle className="spin" size={15} />
                    ) : (
                      <Languages size={15} />
                    )}
                    {translating
                      ? "翻译中"
                      : showTranslation
                        ? "英文原文"
                        : "翻译题面"}
                  </button>
                  <a
                    className="icon-link"
                    href={selectedAssignment.sourceUrl}
                    target="_blank"
                    rel="noreferrer"
                    title="打开官方题面"
                  >
                    <ExternalLink size={17} />
                  </a>
                </div>
              </div>
              <div className="problem-scroll">
                {content?.source === "local" && (
                  <div className="source-warning">
                    当前显示本地回退内容；代码和测试不受影响。
                  </div>
                )}
                <article
                  className="course-content"
                  dangerouslySetInnerHTML={{
                    __html: DOMPurify.sanitize(displayedHtml, {
                      USE_PROFILES: { html: true },
                    }),
                  }}
                />
                {showTranslation && (
                  <div className="translation-note">
                    机器翻译仅供辅助理解，代码、函数名和测试要求以英文原文为准。
                  </div>
                )}
                {selectedQuestion.kind !== "code" && (
                  <TheoryPanel
                    assignmentId={selectedAssignment.id}
                    question={selectedQuestion}
                  />
                )}
              </div>
            </>
          ) : (
            <EmptyPane />
          )}
        </section>

        {!editorCollapsed && <section className="editor-pane">
          {selectedQuestion?.kind === "code" && selectedAssignment ? (
            <>
              <div className="pane-toolbar editor-toolbar">
                <div className="file-tabs">
                  {selectedAssignment.files.map((file) => (
                    <button
                      key={file.id}
                      className={`file-tab ${document?.id === file.id ? "active" : ""}`}
                      onClick={() => void openFile(file.id)}
                    >
                      <FileCode2 size={14} /> {file.name}
                      {document?.id === file.id && dirty && <i />}
                    </button>
                  ))}
                </div>
                <div className="editor-actions">
                  <button className="icon-button" title="恢复备份" onClick={restore}>
                    <RotateCcw size={16} />
                  </button>
                  <button className="button compact" onClick={() => void save()}>
                    <Save size={15} /> 保存
                  </button>
                </div>
              </div>
              <div className="editor-wrap">
                {document ? (
                  <Editor
                    height="100%"
                    language={document.language}
                    value={editorValue}
                    onChange={(value) => {
                      setEditorValue(value ?? "");
                      setDirty((value ?? "") !== document.content);
                    }}
                    onMount={onEditorMount}
                    theme="vs-dark"
                    options={{
                      fontSize: 16,
                      fontFamily:
                        "'JetBrainsMono NFM', 'JetBrains Mono', 'SFMono-Regular', Consolas, monospace",
                      fontLigatures: true,
                      minimap: { enabled: false },
                      padding: { top: 18 },
                      scrollBeyondLastLine: false,
                      smoothScrolling: true,
                      tabSize: 4,
                      automaticLayout: true,
                    }}
                  />
                ) : (
                  <div className="editor-loading">
                    <LoaderCircle className="spin" /> 正在打开源码…
                  </div>
                )}
              </div>
            </>
          ) : (
            <div className="theory-side">
              <BookOpen size={34} />
              <h2>阅读与作答</h2>
              <p>这道题不需要修改源码。请在题面下方完成回答。</p>
            </div>
          )}
        </section>}
      </main>

      <section className={`results-panel ${resultsOpen ? "open" : ""}`}>
        <button
          className="results-handle"
          onClick={() => setResultsOpen((value) => !value)}
          title={`${resultsOpen ? "收起" : "展开"} OK 测试面板 (Ctrl+J)`}
          aria-expanded={resultsOpen}
        >
          <span>
            {resultsOpen ? (
              <PanelBottomClose size={16} />
            ) : (
              <PanelBottomOpen size={16} />
            )}
            OK 测试
            {runStatus && <StatusPill status={runStatus} />}
          </span>
          <span className="results-handle-actions">
            <kbd>Ctrl+J</kbd>
            {resultsOpen ? <ChevronDown size={17} /> : <ChevronUp size={17} />}
          </span>
        </button>
        {resultsOpen && (
          <div className="results-body">
            <div className="run-actions">
              <button
                className="button primary"
                disabled={!selectedQuestion || Boolean(runId)}
                onClick={() => void startRun(false)}
              >
                {runId ? <LoaderCircle className="spin" size={16} /> : <Play size={16} />}
                测试当前题
              </button>
              <button
                className="button"
                disabled={!selectedAssignment || Boolean(runId)}
                onClick={() => void startRun(true)}
              >
                <TestTube2 size={16} /> 测试整份作业
              </button>
              {runId && (
                <button className="button danger" onClick={() => void cancelRun()}>
                  <Square size={14} /> 取消
                </button>
              )}
            </div>
            <ResultView result={runResult} output={runOutput} status={runStatus} />
          </div>
        )}
      </section>
    </div>
  );
}

function AssignmentTree({
  assignment,
  selectedAssignmentId,
  selectedQuestionId,
  onSelect,
}: {
  assignment: Assignment;
  selectedAssignmentId: string;
  selectedQuestionId: string;
  onSelect: (questionId: string) => void;
}) {
  const active = selectedAssignmentId === assignment.id;
  const [open, setOpen] = useState(active);
  useEffect(() => {
    if (active) setOpen(true);
  }, [active]);
  return (
    <div className={`assignment-tree ${active ? "active" : ""}`}>
      <div className="assignment-header">
        <button
          className="assignment-row"
          onClick={() => {
            setOpen((value) => !value);
            if (!active && assignment.questions[0]) onSelect(assignment.questions[0].id);
          }}
        >
          {open ? <ChevronDown size={15} /> : <ChevronRight size={15} />}
          <span className="assignment-icon">
            <Code2 size={16} />
          </span>
          <span>
            <strong>{assignment.name}</strong>
            <small>{assignment.directory}</small>
          </span>
        </button>
        <a
          className="assignment-official"
          href={assignment.sourceUrl}
          target="_blank"
          rel="noreferrer"
          title="打开官方网站"
          aria-label={`打开 ${assignment.name} 官方网站`}
        >
          <ExternalLink size={14} />
        </a>
      </div>
      {open && (
        <div className="question-list">
          {assignment.questions.map((question, index) => (
            <button
              key={question.id}
              className={
                active && selectedQuestionId === question.id ? "selected" : ""
              }
              onClick={() => onSelect(question.id)}
            >
              <span className="question-index">{String(index + 1).padStart(2, "0")}</span>
              <span>{question.title}</span>
              {question.kind === "code" ? (
                <Code2 size={13} />
              ) : (
                <Circle size={11} />
              )}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}

function TheoryPanel({
  assignmentId,
  question,
}: {
  assignmentId: string;
  question: Question;
}) {
  if (!question.cases.length) {
    return <div className="source-warning">本地测试中没有可交互的公开题目。</div>;
  }
  return (
    <div className="theory-panel">
      <h2>你的回答</h2>
      {question.cases.map((testCase, index) => (
        <TheoryCaseCard
          key={testCase.id}
          assignmentId={assignmentId}
          question={question}
          testCase={testCase}
          index={index}
        />
      ))}
    </div>
  );
}

function TheoryCaseCard({
  assignmentId,
  question,
  testCase,
  index,
}: {
  assignmentId: string;
  question: Question;
  testCase: TheoryCase;
  index: number;
}) {
  const key = progressKey(assignmentId, question.id, testCase.id);
  const [answer, setAnswer] = useState(() => localStorage.getItem(`${key}:answer`) || "");
  const [feedback, setFeedback] = useState<Feedback | null>(() => {
    const saved = localStorage.getItem(`${key}:feedback`);
    return saved ? (JSON.parse(saved) as Feedback) : null;
  });

  const check = async () => {
    const result = await api.checkTheory({
      assignmentId,
      questionId: question.id,
      caseId: testCase.id,
      answer,
    });
    setFeedback(result);
    localStorage.setItem(`${key}:answer`, answer);
    localStorage.setItem(`${key}:feedback`, JSON.stringify(result));
  };

  return (
    <div className="theory-card">
      <div className="case-number">{index + 1}</div>
      <pre>{testCase.prompt}</pre>
      {testCase.choices?.length ? (
        <div className="choices">
          {testCase.choices.map((choice) => (
            <label key={choice}>
              <input
                type="radio"
                name={key}
                value={choice}
                checked={answer === choice}
                onChange={(event) => {
                  setAnswer(event.target.value);
                  setFeedback(null);
                }}
              />
              <span>{choice}</span>
            </label>
          ))}
        </div>
      ) : (
        <textarea
          rows={4}
          value={answer}
          placeholder="按 Python 显示格式输入结果，每行一个输出…"
          onChange={(event) => {
            setAnswer(event.target.value);
            setFeedback(null);
          }}
        />
      )}
      <div className="theory-submit">
        <button className="button compact" disabled={!answer.trim()} onClick={() => void check()}>
          <Check size={15} /> 检查回答
        </button>
        {feedback && (
          <span className={feedback.correct ? "feedback-good" : "feedback-bad"}>
            {feedback.correct ? <Check size={16} /> : <XCircle size={16} />}
            {feedback.feedback}
          </span>
        )}
      </div>
    </div>
  );
}

function StatusPill({ status }: { status: string }) {
  const labels: Record<string, string> = {
    queued: "等待中",
    running: "运行中",
    passed: "已通过",
    failed: "未通过",
    timeout: "已超时",
    cancelled: "已取消",
    error: "运行异常",
  };
  return <i className={`status-pill ${status}`}>{labels[status] || status}</i>;
}

function ResultView({
  result,
  output,
  status,
}: {
  result: RunResult | null;
  output: string;
  status: string;
}) {
  if (!result && !output) {
    return (
      <div className="result-placeholder">
        <TestTube2 size={24} />
        <span>保存代码后运行当前题，结果会显示在这里。</span>
      </div>
    );
  }
  return (
    <div className="result-content">
      {result && (
        <div className={`result-summary ${result.status}`}>
          {result.status === "passed" ? (
            <CheckCircle2 size={22} />
          ) : (
            <XCircle size={22} />
          )}
          <div>
            <strong>{result.summary}</strong>
            <span>
              {result.passed} 通过 · {result.failed} 失败
            </span>
          </div>
        </div>
      )}
      {!result && status === "running" && (
        <div className="running-label">
          <LoaderCircle className="spin" size={18} /> OK 正在测试…
        </div>
      )}
      {result?.details.map((detail, index) => (
        <details key={index} open>
          <summary>{detail.title || `失败 ${index + 1}`}</summary>
          {(detail.expected || detail.actual) && (
            <div className="comparison">
              <div>
                <span>期望</span>
                <pre>{detail.expected}</pre>
              </div>
              <div>
                <span>实际</span>
                <pre>{detail.actual}</pre>
              </div>
            </div>
          )}
          <pre className="traceback">{detail.traceback}</pre>
        </details>
      ))}
      <details className="raw-output" open={!result || result.status !== "passed"}>
        <summary>原始输出</summary>
        <pre>{result?.raw || output}</pre>
      </details>
    </div>
  );
}

function EmptyPane() {
  return (
    <div className="empty-pane">
      <div className="empty-orbit">
        <BookOpen size={38} />
      </div>
      <h2>选择一道题开始</h2>
      <p>题面、源码和 OK 测试会在同一个工作区中协同显示。</p>
    </div>
  );
}

export default App;
