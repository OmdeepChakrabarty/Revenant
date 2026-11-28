/**
 * xanadu.ts — the whole browser data layer for Project Xanadu Resurrection.
 *
 * 1. Canonical types (identical, field for field, to the backend Pydantic models).
 * 2. An APPEND-ONLY localStorage store (key `xanadu:v1`) seeded on first load.
 * 3. Seed corpus (documents that quote each other) and a recorded demo answer.
 * 4. Span staleness detection: diff-match-patch remapping + TextQuoteSelector fallback.
 * 5. The POST /ask Server-Sent-Events client.
 */
import { DiffMatchPatch } from "diff-match-patch-typescript";

/* ------------------------------------------------------------------ types */

export interface DocumentRecord {
  docId: string;
  title: string;
  latestVersion: number;
  createdAt: string;
  /** "removed" = soft-removed: kept in the store, hidden from graph/reader//ask. */
  status: "active" | "removed";
  /** "Use in questions" checkbox: excluded docs stay visible but are not sent to /ask. */
  useInQuestions: boolean;
}

export interface DocumentVersion {
  docVersionId: string;
  docId: string;
  version: number;
  content: string;
  contentHash: string;
  parentVersionId: string | null;
  createdAt: string;
}

export interface SpanAddress {
  spanId: string;
  docId: string;
  docVersionId: string;
  version: number;
  start: number;
  end: number;
  exact: string;
  prefix: string;
  suffix: string;
}

export interface SpanLink {
  linkId: string;
  linkType: "transclusion" | "wikilink" | "block_ref" | "citation";
  fromDocVersionId: string;
  fromStart: number;
  fromEnd: number;
  toDocVersionId: string;
  toStart: number;
  toEnd: number;
  exactQuote: string;
  prefix: string;
  suffix: string;
}

export interface AnswerSentenceClaim {
  sentenceIndex: number;
  text: string;
  answerStart: number;
  answerEnd: number;
  citedSpans: SpanAddress[];
  groundingStatus: "supported" | "unsupported";
  hallucinationConfidence: number;
  stalenessStatus: "fresh" | "outdated";
}

export interface TraversalHop {
  step: number;
  fromDocId: string;
  toDocId: string;
  spanId: string;
}

export interface AIAnswerRecord {
  answerId: string;
  question: string;
  fullText: string;
  traversal: TraversalHop[];
  sentences: AnswerSentenceClaim[];
  createdAt: string;
}

export interface XanaduStore {
  documents: DocumentRecord[];
  documentVersions: DocumentVersion[];
  spanLinks: SpanLink[];
  aiAnswers: AIAnswerRecord[];
}

export interface GraphNode {
  id: string;
  label: string;
  version: number;
  /** Excluded from questions: drawn dimmed instead of hidden. */
  dimmed?: boolean;
}

export interface GraphLink {
  source: string;
  target: string;
  linkId: string;
  spanId: string;
}

export interface GraphData {
  nodes: GraphNode[];
  links: GraphLink[];
}

/* ------------------------------------------------------------- addresses */

export const CONTEXT_WINDOW = 32;
const SEED_CREATED_AT = "2026-10-31T09:00:00.000Z";

export function makeSpan(
  docId: string,
  version: number,
  content: string,
  start: number,
  end: number,
): SpanAddress {
  return {
    spanId: `${docId}@v${version}:${start}-${end}`,
    docId,
    docVersionId: `${docId}@v${version}`,
    version,
    start,
    end,
    exact: content.slice(start, end),
    prefix: content.slice(Math.max(0, start - CONTEXT_WINDOW), start),
    suffix: content.slice(end, Math.min(content.length, end + CONTEXT_WINDOW)),
  };
}

/** Build a link by locating both quotes in their source documents. */
function makeLink(
  fromDocId: string,
  fromQuote: string,
  toDocId: string,
  toQuote: string,
): SpanLink {
  const fromDoc = SEED_DOCS.find((d) => d.docId === fromDocId);
  const toDoc = SEED_DOCS.find((d) => d.docId === toDocId);
  if (!fromDoc || !toDoc) throw new Error(`seed link targets unknown document`);
  const fromStart = fromDoc.content.indexOf(fromQuote);
  const toStart = toDoc.content.indexOf(toQuote);
  if (fromStart < 0 || toStart < 0) throw new Error(`seed link quote not found`);
  const from = makeSpan(fromDocId, 1, fromDoc.content, fromStart, fromStart + fromQuote.length);
  const to = makeSpan(toDocId, 1, toDoc.content, toStart, toStart + toQuote.length);
  return {
    linkId: `link_${fromDocId}_${fromStart}_${toDocId}_${toStart}`,
    linkType: "transclusion",
    fromDocVersionId: from.docVersionId,
    fromStart: from.start,
    fromEnd: from.end,
    toDocVersionId: to.docVersionId,
    toStart: to.start,
    toEnd: to.end,
    exactQuote: to.exact,
    prefix: to.prefix,
    suffix: to.suffix,
  };
}

/* ----------------------------------------------------------- seed corpus */

export interface SeedDoc {
  docId: string;
  title: string;
  content: string;
}

export const SEED_DOCS: SeedDoc[] = [
  {
    docId: "doc_xanadu_overview",
    title: "Xanadu: The Unfinished Dream",
    content:
      "Ted Nelson proposed Xanadu in 1960 and published the design in 1981 as a hypertext system where every document lives forever at a permanent address. Nothing is copied and nothing is deleted; a quotation is a pointer to the original characters, so the reader can always travel back to the source. Nelson called this the docuverse, and he insisted that the archive must remember every version ever written. The system was meant to pay authors for every transclusion, a micropayment idea the web never adopted. Xanadu failed commercially, but its central claim has returned with a vengeance now that language models quote text at scale. This volume collects the design notes, the critiques, and a working prototype that keeps every span addressable. The goal is not nostalgia. It is to ask what citations would look like if the network had remembered where every sentence came from.",
  },
  {
    docId: "doc_nelson_1981",
    title: "Nelson 1981 Paper",
    content:
      "The 1981 paper states the rule plainly: a link is not a copy, it is a promise that the original remains reachable. Nelson describes four link types — transclusion, wikilinks, block references, and citations — and argues that all four must resolve to character ranges inside an immutable version. He writes that the reader should be able to see the quoted passage in its original context with a single gesture, and that an author may revise a document without breaking any quotation already published. Permission to quote is not permission to fork. The paper also warns that a system which silently rewrites its own history becomes impossible to audit. Modern publishing systems mostly ignore that warning, storing only the newest text. The 1981 design instead keeps every version, addressable by document and version number, so that a citation made in 1981 still resolves in 2026.",
  },
  {
    docId: "doc_transclusion",
    title: "Transclusion and Span Addressing",
    content:
      "Transclusion means including one document inside another by reference rather than by copy. A transclusion is stored as a half-open character range, written document@version:start-end, with a short prefix and suffix to re-anchor the quotation if offsets drift. Because the address is pinned to a version, the quoted text can never change underneath a reader. Because the prefix and suffix travel with the address, the quotation can still be found after a later edit shifts its offsets. This prototype makes the address the primary key of every quotation. Ghost claims are then easy to see: a sentence either resolves to a real range in a real version or it does not. The same machinery lets a reader inspect an edited source and understand exactly what changed between the version that was cited and the version that exists now.",
  },
  {
    docId: "doc_web_critique",
    title: "The Modern Web Critique",
    content:
      "The web kept the link and threw away the archive. A URL points at the present, so a quotation made today may point at a different sentence tomorrow, and nothing in the protocol notices. Search engines cache pages but do not cite them at character level. Social platforms copy text into new contexts and detach it from its author. The result is a reading environment where provenance is a matter of trust rather than a matter of address. Xanadu's answer is unglamorous: keep the old versions, address the characters, and let the reader check. That answer is now cheap enough to implement in a browser with a few kilobytes of local storage. The critique is not that the web is broken, but that it optimized for reach and left verifiability to whoever cared enough to build it on top.",
  },
  {
    docId: "doc_ghost_claims",
    title: "Ghost Claims and Verifiable AI",
    content:
      "A ghost claim is a sentence that sounds like it came from a source but resolves to nothing. Language models produce them constantly, because fluent text and grounded text are different achievements. The proof engine in this prototype does not trust the model's confidence. It retrieves spans by walking the link graph, asks for inline citations in a strict format, drops any citation that names a span it was never given, and checks that the remaining citations match the source text verbatim. A sentence must also share at least thirty percent of its content words with the span it cites, which catches citations pasted onto unrelated prose. Everything that fails is rendered faded and labelled unsupported. The point is not to make the model honest. The point is to make dishonesty visible to a reader in one glance.",
  },
];

export const SEED_LINKS: SpanLink[] = [
  makeLink(
    "doc_xanadu_overview",
    "a quotation is a pointer to the original characters",
    "doc_transclusion",
    "Transclusion means including one document inside another by reference rather than by copy.",
  ),
  makeLink(
    "doc_nelson_1981",
    "a link is not a copy, it is a promise that the original remains reachable",
    "doc_xanadu_overview",
    "Nothing is copied and nothing is deleted",
  ),
  makeLink(
    "doc_transclusion",
    "This prototype makes the address the primary key of every quotation.",
    "doc_ghost_claims",
    "A ghost claim is a sentence that sounds like it came from a source but resolves to nothing.",
  ),
  makeLink(
    "doc_web_critique",
    "The web kept the link and threw away the archive.",
    "doc_nelson_1981",
    "an author may revise a document without breaking any quotation already published",
  ),
  makeLink(
    "doc_ghost_claims",
    "It retrieves spans by walking the link graph",
    "doc_nelson_1981",
    "Nelson describes four link types — transclusion, wikilinks, block references, and citations",
  ),
];

/* -------------------------------------------------------------- hashing */

/** SHA-256 of the content via crypto.subtle (AGENTS.md §1.1). */
export async function sha256Hex(content: string): Promise<string> {
  const bytes = new TextEncoder().encode(content);
  const subtle = globalThis.crypto?.subtle;
  if (subtle) {
    const digest = await subtle.digest("SHA-256", bytes);
    return [...new Uint8Array(digest)].map((b) => b.toString(16).padStart(2, "0")).join("");
  }
  // Fallback for non-secure contexts (http://LAN-IP) where crypto.subtle is absent.
  let h1 = 0x811c9dc5;
  let h2 = 0x01000193;
  for (const b of bytes) {
    h1 = Math.imul(h1 ^ b, 0x01000193) >>> 0;
    h2 = Math.imul(h2 + b, 0x85ebca6b) >>> 0;
  }
  return (h1.toString(16) + h2.toString(16)).padStart(16, "0").repeat(4).slice(0, 64);
}

/* ---------------------------------------------------------------- store */

export const STORAGE_KEY = "xanadu:v1";

export function createSeedStore(hashes: Record<string, string>): XanaduStore {
  return {
    documents: SEED_DOCS.map((d) => ({
      docId: d.docId,
      title: d.title,
      latestVersion: 1,
      createdAt: SEED_CREATED_AT,
      status: "active",
      useInQuestions: true,
    })),
    documentVersions: SEED_DOCS.map((d) => ({
      docVersionId: `${d.docId}@v1`,
      docId: d.docId,
      version: 1,
      content: d.content,
      contentHash: hashes[d.docId] ?? "",
      parentVersionId: null,
      createdAt: SEED_CREATED_AT,
    })),
    spanLinks: SEED_LINKS,
    aiAnswers: [DEMO_ANSWER],
  };
}

/** Fill in fields added after a store was first persisted (status/useInQuestions). */
function normalizeStore(store: XanaduStore): XanaduStore {
  let changed = false;
  const documents = store.documents.map((doc) => {
    const status = doc.status === "removed" ? "removed" : "active";
    const useInQuestions = doc.useInQuestions !== false;
    if (doc.status === status && doc.useInQuestions === useInQuestions) return doc;
    changed = true;
    return { ...doc, status, useInQuestions } as DocumentRecord;
  });
  return changed ? { ...store, documents } : store;
}

function isStore(value: unknown): value is XanaduStore {
  const s = value as XanaduStore | null;
  return (
    !!s &&
    Array.isArray(s.documents) &&
    Array.isArray(s.documentVersions) &&
    Array.isArray(s.spanLinks) &&
    Array.isArray(s.aiAnswers)
  );
}

/** Read from localStorage; returns null when empty/unavailable/corrupt. */
function readStore(): XanaduStore | null {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return null;
    const parsed: unknown = JSON.parse(raw);
    return isStore(parsed) ? normalizeStore(parsed) : null;
  } catch {
    return null;
  }
}

export const STORAGE_FULL_MESSAGE = "Storage is full. Remove or delete some sources.";

let lastStorageError: string | null = null;

/** Read and clear the outcome of the most recent store write. */
export function consumeStorageError(): string | null {
  const message = lastStorageError;
  lastStorageError = null;
  return message;
}

/**
 * Every write goes through here inside try/catch. A failed setItem leaves the
 * previously persisted store untouched, so nothing already saved is lost.
 */
export function saveStore(store: XanaduStore): boolean {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(store));
    lastStorageError = null;
    return true;
  } catch {
    lastStorageError = STORAGE_FULL_MESSAGE;
    return false;
  }
}

/** Rough quota usage: the JSON payload in UTF-16, as localStorage stores it. */
export function estimateStorageBytes(store: XanaduStore): number {
  const json = JSON.stringify(store);
  try {
    return new Blob([json]).size;
  } catch {
    return json.length * 2;
  }
}

/** Load the persisted store, or seed and persist one on first load. */
export async function loadOrSeedStore(): Promise<XanaduStore> {
  const existing = readStore();
  if (existing) return existing;
  const hashes: Record<string, string> = {};
  for (const doc of SEED_DOCS) hashes[doc.docId] = await sha256Hex(doc.content);
  const seeded = createSeedStore(hashes);
  saveStore(seeded);
  return seeded;
}

export function getLatestVersion(store: XanaduStore, docId: string): DocumentVersion | null {
  const doc = store.documents.find((d) => d.docId === docId);
  if (!doc) return null;
  return (
    store.documentVersions.find(
      (v) => v.docId === docId && v.version === doc.latestVersion,
    ) ?? null
  );
}

export function getVersion(store: XanaduStore, docVersionId: string): DocumentVersion | null {
  return store.documentVersions.find((v) => v.docVersionId === docVersionId) ?? null;
}

export function getVersionsForDoc(store: XanaduStore, docId: string): DocumentVersion[] {
  return store.documentVersions
    .filter((v) => v.docId === docId)
    .sort((a, b) => a.version - b.version);
}

/* -------------------------------------------------------- source status */

export type SourceAvailability = "active" | "removed" | "deleted";

export function activeDocuments(store: XanaduStore): DocumentRecord[] {
  return store.documents.filter((doc) => doc.status !== "removed");
}

/** A document that still exists and has not been soft-removed. */
export function isDocActive(store: XanaduStore, docId: string): boolean {
  const doc = store.documents.find((d) => d.docId === docId);
  return !!doc && doc.status !== "removed";
}

/** "deleted" = the record is gone; "removed" = soft-removed but restorable. */
export function sourceAvailability(store: XanaduStore, docId: string): SourceAvailability {
  const doc = store.documents.find((d) => d.docId === docId);
  if (!doc) return "deleted";
  return doc.status === "removed" ? "removed" : "active";
}

export function docIdForVersion(store: XanaduStore, docVersionId: string): string | null {
  return store.documentVersions.find((v) => v.docVersionId === docVersionId)?.docId ?? null;
}

/** Soft remove / restore. No version is touched. */
export function setDocStatus(
  store: XanaduStore,
  docId: string,
  status: DocumentRecord["status"],
): XanaduStore {
  const updated: XanaduStore = {
    ...store,
    documents: store.documents.map((doc) => (doc.docId === docId ? { ...doc, status } : doc)),
  };
  saveStore(updated);
  return updated;
}

export function setDocUseInQuestions(
  store: XanaduStore,
  docId: string,
  useInQuestions: boolean,
): XanaduStore {
  const updated: XanaduStore = {
    ...store,
    documents: store.documents.map((doc) =>
      doc.docId === docId ? { ...doc, useInQuestions } : doc,
    ),
  };
  saveStore(updated);
  return updated;
}

/**
 * The one user-confirmed exception to append-only history (AGENTS.md §1.1):
 * erase a document, every version of it, and every link touching it.
 * Saved answers are kept so their claims can show "Source deleted".
 */
export function deleteDocumentPermanently(store: XanaduStore, docId: string): XanaduStore {
  const updated: XanaduStore = {
    ...store,
    documents: store.documents.filter((doc) => doc.docId !== docId),
    documentVersions: store.documentVersions.filter((version) => version.docId !== docId),
    spanLinks: store.spanLinks.filter((link) => {
      const fromDocId = docIdForVersion(store, link.fromDocVersionId);
      const toDocId = docIdForVersion(store, link.toDocVersionId);
      return fromDocId !== docId && toDocId !== docId;
    }),
  };
  saveStore(updated);
  return updated;
}

/** Restore the 5 seed documents and their links. Saved answers are kept. */
export async function resetDemoData(store: XanaduStore): Promise<XanaduStore> {
  const hashes: Record<string, string> = {};
  for (const doc of SEED_DOCS) hashes[doc.docId] = await sha256Hex(doc.content);
  const seeded = createSeedStore(hashes);
  const updated: XanaduStore = {
    ...seeded,
    aiAnswers: store.aiAnswers.length > 0 ? store.aiAnswers : seeded.aiAnswers,
  };
  saveStore(updated);
  return updated;
}

/** APPEND a new version. History is never mutated or removed. */
export async function editDoc(
  store: XanaduStore,
  docId: string,
  content: string,
): Promise<{ store: XanaduStore; version: DocumentVersion }> {
  const doc = store.documents.find((d) => d.docId === docId);
  if (!doc) throw new Error(`Unknown document ${docId}`);
  const previous =
    store.documentVersions.find(
      (v) => v.docId === docId && v.version === doc.latestVersion,
    ) ?? null;
  if (!previous) throw new Error(`Document ${docId} has no latest version`);

  const version = doc.latestVersion + 1;
  const next: DocumentVersion = {
    docVersionId: `${docId}@v${version}`,
    docId,
    version,
    content,
    contentHash: await sha256Hex(content),
    parentVersionId: previous.docVersionId,
    createdAt: new Date().toISOString(),
  };

  const updated: XanaduStore = {
    ...store,
    documents: store.documents.map((d) =>
      d.docId === docId ? { ...d, latestVersion: version } : d,
    ),
    documentVersions: [...store.documentVersions, next],
  };
  saveStore(updated);
  return { store: updated, version: next };
}

/* --------------------------------------------------- markdown importer */

const WIKILINK_RE = /(!?)\[\[([^\]|#]+?)(?:#([^\]|]+?))?(?:\|([^\]]+?))?\]\]/g;

export interface ImportFile {
  name: string;
  content: string;
}

export interface ImportResult {
  store: XanaduStore;
  importedDocIds: string[];
  linkCount: number;
}

interface TextRange {
  start: number;
  end: number;
}

interface ResolvedDoc {
  docId: string;
  content: string;
  version: number;
}

const EXCERPT_LIMIT = 400;

function stripExtension(name: string): string {
  return name.replace(/^.*[\\/]/, "").replace(/\.(md|markdown|txt|text)$/i, "").trim();
}

function slugify(title: string): string {
  const slug = title.toLowerCase().replace(/[^a-z0-9]+/g, "_").replace(/^_+|_+$/g, "");
  return slug || "note";
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function uniqueDocId(store: XanaduStore, title: string): string {
  const base = `doc_${slugify(title)}`;
  let candidate = base;
  let suffix = 2;
  while (store.documents.some((doc) => doc.docId === candidate)) candidate = `${base}_${suffix++}`;
  return candidate;
}

function trimRange(content: string, start: number, end: number): TextRange {
  let left = Math.max(0, Math.min(start, content.length));
  let right = Math.max(left, Math.min(end, content.length));
  while (left < right && /\s/.test(content[left])) left += 1;
  while (right > left && /\s/.test(content[right - 1])) right -= 1;
  return { start: left, end: right };
}

/** Keep an excerpt to a sentence boundary when possible (spans stay verbatim). */
function capRange(content: string, range: TextRange, limit = EXCERPT_LIMIT): TextRange {
  if (range.end - range.start <= limit) return range;
  const slice = content.slice(range.start, range.start + limit);
  const boundary = Math.max(
    slice.lastIndexOf(". "),
    slice.lastIndexOf(".\n"),
    slice.lastIndexOf("! "),
    slice.lastIndexOf("? "),
  );
  const end = boundary > 80 ? range.start + boundary + 1 : range.start + limit;
  return trimRange(content, range.start, end);
}

/** First non-empty paragraph at or after `from`. */
function firstParagraph(content: string, from = 0): TextRange | null {
  const match = /\S[^\n]*(?:\n(?!\s*\n)\S[^\n]*)*/.exec(content.slice(from));
  if (!match) return null;
  const start = from + match.index;
  return capRange(content, trimRange(content, start, start + match[0].length));
}

/** Obsidian `#^block-id` -> the prose on that line (marker excluded when possible). */
function blockRange(content: string, blockId: string): TextRange | null {
  const marker = `^${blockId}`;
  const index = content.indexOf(marker);
  if (index < 0) return null;
  const lineStart = content.lastIndexOf("\n", index) + 1;
  const before = trimRange(content, lineStart, index);
  if (before.end > before.start) return capRange(content, before);
  const lineBreak = content.indexOf("\n", index);
  const lineEnd = lineBreak < 0 ? content.length : lineBreak;
  const after = trimRange(content, index + marker.length, lineEnd);
  if (after.end > after.start) return capRange(content, after);
  return capRange(content, trimRange(content, lineStart, lineEnd));
}

/** `[[Note#Heading]]` -> first paragraph under that heading. */
function headingRange(content: string, heading: string): TextRange | null {
  const pattern = new RegExp(`^#{1,6}\\s*${escapeRegExp(heading)}\\s*$`, "im");
  const match = pattern.exec(content);
  if (!match) return null;
  return firstParagraph(content, match.index + match[0].length);
}

/**
 * Import Markdown files as immutable v1 documents and turn every wikilink
 * (`[[Note]]`, `![[Embed]]`, `[[Note#Heading]]`, `[[Note#^block]]`) into a
 * span link, mirroring quartz's `wikilinkRegex` (AGENTS.md bonus feature).
 * Files whose targets are not being imported are skipped rather than guessed.
 */
export async function importMarkdownFiles(
  store: XanaduStore,
  files: ImportFile[],
): Promise<ImportResult> {
  let next = store;
  const imported: { docId: string; title: string; content: string }[] = [];

  for (const file of files) {
    const title = stripExtension(file.name) || `Imported note ${imported.length + 1}`;
    const content = (file.content ?? "").trim();
    if (!content) continue;
    const docId = uniqueDocId(next, title);
    const createdAt = new Date().toISOString();
    next = {
      ...next,
      documents: [
        ...next.documents,
        { docId, title, latestVersion: 1, createdAt, status: "active", useInQuestions: true },
      ],
      documentVersions: [
        ...next.documentVersions,
        {
          docVersionId: `${docId}@v1`,
          docId,
          version: 1,
          content,
          contentHash: await sha256Hex(content),
          parentVersionId: null,
          createdAt,
        },
      ],
    };
    imported.push({ docId, title, content });
  }

  if (imported.length === 0) return { store, importedDocIds: [], linkCount: 0 };

  const index = new Map<string, ResolvedDoc>();
  for (const doc of next.documents) {
    const latest = getLatestVersion(next, doc.docId);
    if (!latest) continue;
    const entry: ResolvedDoc = { docId: doc.docId, content: latest.content, version: latest.version };
    index.set(doc.title.trim().toLowerCase(), entry);
    index.set(doc.docId.toLowerCase(), entry);
    index.set(`doc_${slugify(doc.title)}`, entry);
  }
  const resolve = (raw: string): ResolvedDoc | null => {
    const key = raw.trim().toLowerCase();
    return index.get(key) ?? index.get(`doc_${slugify(key)}`) ?? null;
  };

  const links: SpanLink[] = [];
  for (const source of imported) {
    WIKILINK_RE.lastIndex = 0;
    let match: RegExpExecArray | null = WIKILINK_RE.exec(source.content);
    while (match) {
      const token = match[0];
      const embed = match[1] === "!";
      const fragment = (match[3] ?? "").trim();
      const target = resolve(match[2] ?? "");
      if (target) {
        const range = fragment.startsWith("^")
          ? blockRange(target.content, fragment.slice(1))
          : fragment
            ? headingRange(target.content, fragment)
            : null;
        const chosen = range ?? firstParagraph(target.content);
        if (chosen && chosen.end > chosen.start) {
          const span = makeSpan(target.docId, target.version, target.content, chosen.start, chosen.end);
          links.push({
            linkId: `link_${source.docId}_${match.index}_${target.docId}`,
            linkType: embed ? "transclusion" : fragment.startsWith("^") ? "block_ref" : "wikilink",
            fromDocVersionId: `${source.docId}@v1`,
            fromStart: match.index,
            fromEnd: match.index + token.length,
            toDocVersionId: span.docVersionId,
            toStart: span.start,
            toEnd: span.end,
            exactQuote: span.exact,
            prefix: span.prefix,
            suffix: span.suffix,
          });
        }
      }
      match = WIKILINK_RE.exec(source.content);
    }
  }

  const updated: XanaduStore = links.length
    ? { ...next, spanLinks: [...next.spanLinks, ...links] }
    : next;
  saveStore(updated);
  return { store: updated, importedDocIds: imported.map((doc) => doc.docId), linkCount: links.length };
}

export function saveAnswer(store: XanaduStore, answer: AIAnswerRecord): XanaduStore {
  const updated: XanaduStore = { ...store, aiAnswers: [...store.aiAnswers, answer] };
  saveStore(updated);
  return updated;
}

/* ------------------------------------------------------------ staleness */

export interface StaleCheck {
  stalenessStatus: "fresh" | "outdated";
  newStart: number;
  newEnd: number;
  currentText: string;
  reason: "unchanged" | "remapped" | "quote-anchored" | "mutated" | "missing";
}

const dmp = new DiffMatchPatch();

/**
 * Resolve a span against the newest content of its document.
 * 1. diff_main(old, new) + diff_xIndex to translate [start, end)
 * 2. if the slice no longer equals `exact`, fall back to a TextQuoteSelector
 *    ({exact, prefix, suffix}) search, scoring every candidate occurrence
 * 3. otherwise the span is mutated → "outdated"
 */
export function checkSpanStaleness(span: SpanAddress, store: XanaduStore): StaleCheck {
  if (sourceAvailability(store, span.docId) !== "active") {
    // A removed or deleted source can no longer verify a claim: count it as outdated.
    return {
      stalenessStatus: "outdated",
      newStart: span.start,
      newEnd: span.end,
      currentText: "",
      reason: "missing",
    };
  }

  const latest = getLatestVersion(store, span.docId);
  if (!latest) {
    return {
      stalenessStatus: "outdated",
      newStart: span.start,
      newEnd: span.end,
      currentText: "",
      reason: "missing",
    };
  }

  if (latest.version === span.version && latest.content.slice(span.start, span.end) === span.exact) {
    return {
      stalenessStatus: "fresh",
      newStart: span.start,
      newEnd: span.end,
      currentText: span.exact,
      reason: "unchanged",
    };
  }

  const oldContent = getVersion(store, span.docVersionId)?.content ?? latest.content;
  const diffs = dmp.diff_main(oldContent, latest.content);
  dmp.diff_cleanupSemantic(diffs);
  let newStart = dmp.diff_xIndex(diffs, span.start);
  let newEnd = dmp.diff_xIndex(diffs, span.end);

  if (latest.content.slice(newStart, newEnd) === span.exact) {
    return {
      stalenessStatus: "fresh",
      newStart,
      newEnd,
      currentText: span.exact,
      reason: "remapped",
    };
  }

  const anchored = findQuoteCandidate(span, latest.content);
  if (anchored) {
    newStart = anchored;
    newEnd = anchored + span.exact.length;
    return {
      stalenessStatus: "fresh",
      newStart,
      newEnd,
      currentText: span.exact,
      reason: "quote-anchored",
    };
  }

  return {
    stalenessStatus: "outdated",
    newStart,
    newEnd,
    currentText: latest.content.slice(newStart, newEnd),
    reason: "mutated",
  };
}

/**
 * Fuzzy TextQuoteSelector. A single surviving occurrence is unambiguous and is
 * accepted outright; when the quote repeats, the occurrence whose 32-char
 * prefix/suffix best matches the recorded context wins (>= 50%).
 */
function findQuoteCandidate(span: SpanAddress, content: string): number | null {
  if (!span.exact) return null;
  const occurrences: number[] = [];
  let from = content.indexOf(span.exact);
  while (from >= 0 && occurrences.length < 64) {
    occurrences.push(from);
    from = content.indexOf(span.exact, from + 1);
  }
  if (occurrences.length === 0) return null;
  if (occurrences.length === 1) return occurrences[0];

  let best: number | null = null;
  let bestScore = 0;
  for (const start of occurrences) {
    const score = contextScore(span, content, start);
    if (score > bestScore) {
      bestScore = score;
      best = start;
      if (score === 1) break;
    }
  }
  return bestScore >= 0.5 ? best : null;
}

function contextScore(span: SpanAddress, content: string, start: number): number {
  const before = content.slice(Math.max(0, start - CONTEXT_WINDOW), start);
  const after = content.slice(start + span.exact.length, start + span.exact.length + CONTEXT_WINDOW);
  const common = (a: string, b: string): number => {
    let n = 0;
    while (n < a.length && n < b.length && a[a.length - 1 - n] === b[b.length - 1 - n]) n++;
    return n;
  };
  const prefixCoverage = span.prefix.length + before.length === 0 ? 1 : common(before, span.prefix) / Math.max(span.prefix.length, 1);
  const suffixScore =
    span.suffix.length === 0
      ? 1
      : common(Array.from(after).reverse().join(""), Array.from(span.suffix).reverse().join("")) /
        span.suffix.length;
  return Math.min(1, (prefixCoverage + suffixScore) / 2);
}

/** Recompute every sentence's staleness against the current store. */
export function refreshAnswerStaleness(answer: AIAnswerRecord, store: XanaduStore): AIAnswerRecord {
  const sentences = answer.sentences.map((sentence) => {
    if (sentence.citedSpans.length === 0) {
      return {
        ...sentence,
        stalenessStatus: sentence.stalenessStatus === "outdated" ? "outdated" : "fresh",
      } as AnswerSentenceClaim;
    }
    const stale = sentence.citedSpans.some(
      (span) => checkSpanStaleness(span, store).stalenessStatus === "outdated",
    );
    return {
      ...sentence,
      stalenessStatus: stale ? "outdated" : "fresh",
    } as AnswerSentenceClaim;
  });
  return { ...answer, sentences };
}

export interface DiffSegment {
  op: "eq" | "del" | "ins";
  text: string;
}

/** Word-level diff used by the "Then vs. Now" view. */
export function diffSegments(before: string, after: string): DiffSegment[] {
  const diffs = dmp.diff_main(before, after);
  dmp.diff_cleanupSemantic(diffs);
  return diffs
    .filter(([, text]) => text.length > 0)
    .map(([op, text]) => ({ op: op === 0 ? "eq" : op < 0 ? "del" : "ins", text }));
}

/* ---------------------------------------------------------------- graph */

export function buildGraph(store: XanaduStore): GraphData {
  const versionToDoc = new Map(store.documentVersions.map((v) => [v.docVersionId, v.docId]));
  const isActive = (docId: string): boolean => isDocActive(store, docId);
  const nodes: GraphNode[] = store.documents
    .filter((d) => d.status !== "removed")
    .map((d) => ({
      id: d.docId,
      label: d.title,
      version: d.latestVersion,
      dimmed: d.useInQuestions === false,
    }));
  const links: GraphLink[] = [];
  for (const link of store.spanLinks) {
    const source = versionToDoc.get(link.fromDocVersionId);
    const target = versionToDoc.get(link.toDocVersionId);
    if (!source || !target || !isActive(source) || !isActive(target)) continue;
    links.push({
      source,
      target,
      linkId: link.linkId,
      spanId: `${target}@v1:${link.toStart}-${link.toEnd}`,
    });
  }
  return { nodes, links };
}

/* -------------------------------------------------------- ask streaming */

export const API_BASE = (
  (import.meta.env?.VITE_API_URL as string | undefined) ?? "http://localhost:8000"
).replace(/\/+$/, "");

export interface AskOptions {
  question: string;
  store: XanaduStore;
  onHop?: (hop: TraversalHop) => void;
  signal?: AbortSignal;
}

interface ParsedEvent {
  event: string;
  data: string;
}

function parseChunk(chunk: string): ParsedEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of chunk.split("\n")) {
    if (line.startsWith("event:")) event = line.slice(6).trim();
    else if (line.startsWith("data:")) data.push(line.slice(5).trimStart());
  }
  if (data.length === 0) return null;
  return { event, data: data.join("\n") };
}

/** POST the latest documents + links to /ask and consume the SSE stream. */
export async function askQuestion({ question, store, onHop, signal }: AskOptions): Promise<AIAnswerRecord> {
  // Removed and excluded sources never leave the browser (AGENTS.md /ask contract).
  const sendable = store.documents.filter(
    (doc) => doc.status !== "removed" && doc.useInQuestions !== false,
  );
  const sendableIds = new Set(sendable.map((doc) => doc.docId));
  const documents = sendable.map((doc) => {
    const latest = getLatestVersion(store, doc.docId);
    return {
      docId: doc.docId,
      title: doc.title,
      version: doc.latestVersion,
      content: latest?.content ?? "",
    };
  });
  const links = store.spanLinks.filter((link) => {
    const fromDocId = docIdForVersion(store, link.fromDocVersionId);
    const toDocId = docIdForVersion(store, link.toDocVersionId);
    return !!fromDocId && !!toDocId && sendableIds.has(fromDocId) && sendableIds.has(toDocId);
  });

  const timeout = new AbortController();
  const timer = window.setTimeout(() => timeout.abort(), 20000);
  const abort = () => timeout.abort();
  signal?.addEventListener("abort", abort);

  try {
    const response = await fetch(`${API_BASE}/ask`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ question, documents, links }),
      signal: timeout.signal,
    });
    if (!response.ok || !response.body) {
      throw new Error(`Backend returned ${response.status}`);
    }

    const reader = response.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";
    let answer: AIAnswerRecord | null = null;
    let streamError: string | null = null;

    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true }).replace(/\r\n/g, "\n");
      let boundary = buffer.indexOf("\n\n");
      while (boundary >= 0) {
        const raw = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        const parsed = parseChunk(raw);
        if (parsed) {
          try {
            const payload = JSON.parse(parsed.data) as Record<string, unknown>;
            if (parsed.event === "hop") {
              onHop?.(payload as unknown as TraversalHop);
            } else if (parsed.event === "answer") {
              answer = payload as unknown as AIAnswerRecord;
            } else if (parsed.event === "error") {
              streamError = String(payload.message ?? "Unknown backend error");
            }
          } catch {
            streamError = "Malformed event from backend";
          }
        }
        boundary = buffer.indexOf("\n\n");
      }
    }

    if (streamError) throw new Error(streamError);
    if (!answer) throw new Error("Backend closed the stream without an answer");
    return answer;
  } finally {
    window.clearTimeout(timer);
    signal?.removeEventListener("abort", abort);
  }
}

/* ------------------------------------------------------- demo recording */

function seedSpan(docId: string, quote: string): SpanAddress {
  const doc = SEED_DOCS.find((d) => d.docId === docId);
  if (!doc) throw new Error(`Unknown seed doc ${docId}`);
  const start = doc.content.indexOf(quote);
  if (start < 0) throw new Error(`Demo quote not found in ${docId}`);
  return makeSpan(docId, 1, doc.content, start, start + quote.length);
}

const DEMO_SENTENCES: Array<{
  text: string;
  spans: SpanAddress[];
  supported: boolean;
}> = [
  {
    text: "A citation points at characters inside one pinned version, so the quoted text cannot change underneath the reader.",
    spans: [
      seedSpan(
        "doc_transclusion",
        "Because the address is pinned to a version, the quoted text can never change underneath a reader.",
      ),
    ],
    supported: true,
  },
  {
    text: "The address also carries a prefix and a suffix, which lets the quotation be found again after a later edit shifts its offsets.",
    spans: [
      seedSpan(
        "doc_transclusion",
        "Because the prefix and suffix travel with the address, the quotation can still be found after a later edit shifts its offsets.",
      ),
    ],
    supported: true,
  },
  {
    text: "Nelson required that a reader can revise a document without breaking any quotation already published.",
    spans: [
      seedSpan(
        "doc_nelson_1981",
        "an author may revise a document without breaking any quotation already published",
      ),
    ],
    supported: true,
  },
  {
    text: "Every model answer is therefore guaranteed to be fully grounded in the archive.",
    spans: [],
    supported: false,
  },
];

function buildDemoAnswer(): AIAnswerRecord {
  let cursor = 0;
  const fullText = DEMO_SENTENCES.map((s) => s.text).join(" ");
  const sentences: AnswerSentenceClaim[] = DEMO_SENTENCES.map((s, index) => {
    const answerStart = cursor;
    cursor += s.text.length + (index === DEMO_SENTENCES.length - 1 ? 0 : 1);
    return {
      sentenceIndex: index,
      text: s.text,
      answerStart,
      answerEnd: answerStart + s.text.length,
      citedSpans: s.spans,
      groundingStatus: s.supported ? "supported" : "unsupported",
      hallucinationConfidence: s.supported ? 0 : 1,
      stalenessStatus: "fresh",
    };
  });

  return {
    answerId: "ans_demo_0001",
    question: "Why does a Xanadu citation survive an edit?",
    fullText,
    traversal: [
      {
        step: 1,
        fromDocId: "doc_xanadu_overview",
        toDocId: "doc_transclusion",
        spanId: DEMO_SENTENCES[0].spans[0].spanId,
      },
      {
        step: 2,
        fromDocId: "doc_transclusion",
        toDocId: "doc_nelson_1981",
        spanId: DEMO_SENTENCES[2].spans[0].spanId,
      },
      {
        step: 3,
        fromDocId: "doc_nelson_1981",
        toDocId: "doc_transclusion",
        spanId: DEMO_SENTENCES[1].spans[0].spanId,
      },
    ],
    sentences,
    createdAt: SEED_CREATED_AT,
  };
}

/** One recorded answer used when the backend is unavailable. */
export const DEMO_ANSWER: AIAnswerRecord = buildDemoAnswer();
