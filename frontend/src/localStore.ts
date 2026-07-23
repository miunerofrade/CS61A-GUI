import type { Assignment, AssignmentContent, FileDocument } from "./types";

const DATABASE_NAME = "cs61a-gui";
const DATABASE_VERSION = 1;
const STORE_NAME = "assignments";

export interface StoredFile extends FileDocument {
  path: string;
  backup: string | null;
}

export interface StoredAssignment {
  id: string;
  assignment: Assignment;
  files: Record<string, StoredFile>;
  archive: Record<string, Uint8Array>;
  answers: Record<string, string>;
  content: AssignmentContent | null;
  installedAt: string;
}

let databasePromise: Promise<IDBDatabase> | null = null;

function database(): Promise<IDBDatabase> {
  if (databasePromise) return databasePromise;
  databasePromise = new Promise((resolve, reject) => {
    const request = indexedDB.open(DATABASE_NAME, DATABASE_VERSION);
    request.onupgradeneeded = () => {
      if (!request.result.objectStoreNames.contains(STORE_NAME)) {
        request.result.createObjectStore(STORE_NAME, { keyPath: "id" });
      }
    };
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  return databasePromise;
}

function transaction<T>(
  mode: IDBTransactionMode,
  operation: (store: IDBObjectStore) => IDBRequest<T>,
): Promise<T> {
  return database().then(
    (db) =>
      new Promise<T>((resolve, reject) => {
        const tx = db.transaction(STORE_NAME, mode);
        const request = operation(tx.objectStore(STORE_NAME));
        request.onsuccess = () => resolve(request.result);
        request.onerror = () => reject(request.error);
      }),
  );
}

export async function listStoredAssignments(): Promise<StoredAssignment[]> {
  const result = await transaction<StoredAssignment[]>("readonly", (store) =>
    store.getAll(),
  );
  return result.sort((left, right) =>
    left.assignment.name.localeCompare(right.assignment.name, undefined, {
      numeric: true,
    }),
  );
}

export function getStoredAssignment(id: string): Promise<StoredAssignment | undefined> {
  return transaction<StoredAssignment | undefined>("readonly", (store) =>
    store.get(id),
  );
}

export function putStoredAssignment(value: StoredAssignment): Promise<IDBValidKey> {
  return transaction<IDBValidKey>("readwrite", (store) => store.put(value));
}

export function deleteStoredAssignment(id: string): Promise<undefined> {
  return transaction<undefined>("readwrite", (store) => store.delete(id));
}

export async function findStoredFile(
  fileId: string,
): Promise<{ workspace: StoredAssignment; file: StoredFile } | null> {
  for (const workspace of await listStoredAssignments()) {
    const file = workspace.files[fileId];
    if (file) return { workspace, file };
  }
  return null;
}

export async function sha256(value: string | ArrayBuffer): Promise<string> {
  const bytes =
    typeof value === "string" ? new TextEncoder().encode(value) : new Uint8Array(value);
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest))
    .map((part) => part.toString(16).padStart(2, "0"))
    .join("");
}
