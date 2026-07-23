export type QuestionKind = "code" | "concept" | "wwpp";

export interface SourceFile {
  id: string;
  name: string;
  language: string;
}

export interface TheoryCase {
  id: string;
  prompt: string;
  choices?: string[];
}

export interface Question {
  id: string;
  title: string;
  kind: QuestionKind;
  cases: TheoryCase[];
  sourceHint: string | null;
}

export interface Assignment {
  id: string;
  name: string;
  directory: string;
  endpoint: string;
  sourceUrl: string;
  downloadUrl: string;
  files: SourceFile[];
  questions: Question[];
  defaultTests: string[];
}

export interface CatalogItem {
  id: string;
  name: string;
  category: "lab" | "hw" | "proj";
  slug: string;
  pageUrl: string;
  downloadUrl: string;
  released?: boolean;
  installed: boolean;
  assignmentId: string | null;
}

export interface FileDocument extends SourceFile {
  content: string;
  hash: string;
}

export interface AssignmentContent {
  title: string;
  sourceUrl: string;
  source: "official" | "local";
  stale: boolean;
  fetchedAt: string | null;
  overviewHtml: string;
  sections: Record<string, string>;
}

export interface TranslationResult {
  html: string;
  provider: string;
  sourceLanguage: string;
  targetLanguage: string;
}

export interface RunDetail {
  title: string;
  expected: string;
  actual: string;
  traceback: string;
}

export interface RunResult {
  status: "passed" | "failed" | "error" | "timeout" | "cancelled";
  summary: string;
  passed: number;
  failed: number;
  details: RunDetail[];
  raw: string;
}
