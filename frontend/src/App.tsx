/**
 * App.tsx — the 3-pane workspace shell.
 *
 * Left: document graph (macro link traversal). Middle: immutable reader/editor.
 * Right: verified proof view (micro span bridges). Shared state lives here.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { createRoot } from "react-dom/client";
import { Xwrapper } from "react-xarrows";
import GraphView from "./GraphView";
import { ProofPane, ReaderPane, SpanBridges, buildCitationMap } from "./ReaderAndProof";
import type { AnswerSource } from "./ReaderAndProof";
import {
  activeDocuments,
  askQuestion,
  buildGraph,
  deleteDocumentPermanently,
  DEMO_ANSWER,
  editDoc,
  getVersionsForDoc,
  importMarkdownFiles,
  loadOrSeedStore,
  refreshAnswerStaleness,
  resetDemoData,
  saveAnswer,
  setDocStatus,
  setDocUseInQuestions,
} from "./xanadu";
import type { AIAnswerRecord, TraversalHop, XanaduStore } from "./xanadu";

const DEFAULT_QUESTION = "Why does a Xanadu citation survive an edit?";

function errorMessage(error: unknown): string {
  if (error instanceof DOMException && error.name === "AbortError") return "request timed out";
  if (error instanceof Error) return error.message;
  return "unknown error";
}

function App() {
  const [store, setStore] = useState<XanaduStore | null>(null);
  const [activeDocId, setActiveDocId] = useState("doc_xanadu_overview");
  const [answer, setAnswer] = useState<AIAnswerRecord | null>(null);
  const [source, setSource] = useState<AnswerSource>("recorded");
  const [question, setQuestion] = useState(DEFAULT_QUESTION);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [hop, setHop] = useState<TraversalHop | null>(null);
  const [selectedSpanId, setSelectedSpanId] = useState<string | null>(null);
  const [importing, setImporting] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [sourcesOpen, setSourcesOpen] = useState(false);
  const timers = useRef<number[]>([]);

  const clearTimers = useCallback(() => {
    timers.current.forEach((id) => window.clearTimeout(id));
    timers.current = [];
  }, []);

  useEffect(() => clearTimers, [clearTimers]);

  // Load the append-only store (seeded on first run).
  useEffect(() => {
    let alive = true;
    loadOrSeedStore()
      .then((loaded) => {
        if (!alive) return;
        setStore(loaded);
        const saved = loaded.aiAnswers[loaded.aiAnswers.length - 1] ?? null;
        if (saved) {
          const refreshed = refreshAnswerStaleness(saved, loaded);
          setAnswer(refreshed);
          setSource("recorded");
          const firstCited = refreshed.sentences.flatMap((s) => s.citedSpans)[0];
          if (firstCited) setActiveDocId(firstCited.docId);
        }
      })
      .catch(() => {
        if (alive) setError("Local storage is unavailable; the workspace could not be seeded.");
      });
    return () => {
      alive = false;
    };
  }, []);

  const activeDocs = useMemo(() => (store ? activeDocuments(store) : []), [store]);

  const applyStore = useCallback((next: XanaduStore) => {
    setStore(next);
    setAnswer((previous) => (previous ? refreshAnswerStaleness(previous, next) : previous));
  }, []);

  const replayDemo = useCallback(
    (message: string) => {
      clearTimers();
      const demo = store ? refreshAnswerStaleness(DEMO_ANSWER, store) : DEMO_ANSWER;
      setAnswer(demo);
      setSource("fallback");
      setError(message);
      setHop(null);
      const firstCited = demo.sentences.flatMap((s) => s.citedSpans)[0];
      if (firstCited) setActiveDocId(firstCited.docId);
      demo.traversal.forEach((step, index) => {
        timers.current.push(window.setTimeout(() => setHop(step), 450 + index * 520));
      });
    },
    [clearTimers, store],
  );

  const ask = useCallback(async () => {
    const text = question.trim();
    if (!store || !text || loading) return;
    setLoading(true);
    setError(null);
    setHop(null);
    setSelectedSpanId(null);
    try {
      const result = await askQuestion({ question: text, store, onHop: (event) => setHop(event) });
      const refreshed = refreshAnswerStaleness(result, store);
      setStore((previous) => (previous ? saveAnswer(previous, refreshed) : previous));
      setAnswer(refreshed);
      setSource("live");
      const firstCited = refreshed.sentences.flatMap((s) => s.citedSpans)[0];
      if (firstCited) setActiveDocId(firstCited.docId);
    } catch (caught) {
      replayDemo(`Backend unavailable (${errorMessage(caught)}). Replaying the recorded demo answer.`);
    } finally {
      setLoading(false);
    }
  }, [loading, question, replayDemo, store]);

  const importFiles = useCallback(
    async (files: File[]) => {
      if (!store || files.length === 0) return;
      setImporting(true);
      setError(null);
      setNotice(null);
      try {
        const payload = await Promise.all(
          files.map(async (file) => ({ name: file.name, content: await file.text() })),
        );
        const result = await importMarkdownFiles(store, payload);
        if (result.importedDocIds.length === 0) {
          setNotice("Those files had no text in them — nothing was imported.");
          return;
        }
        applyStore(result.store);
        setActiveDocId(result.importedDocIds[0]);
        const docs = `${result.importedDocIds.length} document${result.importedDocIds.length === 1 ? "" : "s"}`;
        const links = result.linkCount > 0
          ? ` and ${result.linkCount} span link${result.linkCount === 1 ? "" : "s"}`
          : "";
        setNotice(`Imported ${docs}${links}. Ask a question to test them.`);
      } catch (caught) {
        setError(`Import failed: ${errorMessage(caught)}`);
      } finally {
        setImporting(false);
      }
    },
    [applyStore, store],
  );

  const saveDocument = useCallback(
    async (docId: string, content: string) => {
      if (!store) return;
      const { store: next } = await editDoc(store, docId, content);
      applyStore(next);
    },
    [applyStore, store],
  );

  const toggleSourceUse = useCallback(
    (docId: string, use: boolean) => {
      if (!store) return;
      applyStore(setDocUseInQuestions(store, docId, use));
    },
    [applyStore, store],
  );

  const removeSource = useCallback(
    (docId: string) => {
      if (!store) return;
      applyStore(setDocStatus(store, docId, "removed"));
    },
    [applyStore, store],
  );

  const restoreSource = useCallback(
    (docId: string) => {
      if (!store) return;
      applyStore(setDocStatus(store, docId, "active"));
    },
    [applyStore, store],
  );

  const deleteSource = useCallback(
    (docId: string) => {
      if (!store) return;
      applyStore(deleteDocumentPermanently(store, docId));
    },
    [applyStore, store],
  );

  const resetSources = useCallback(async () => {
    if (!store) return;
    applyStore(await resetDemoData(store));
  }, [applyStore, store]);

  const openSource = useCallback((docId: string) => {
    setActiveDocId(docId);
    setSelectedSpanId(null);
    setSourcesOpen(false);
  }, []);


  const graph = useMemo(
    () => (store ? buildGraph(store) : { nodes: [], links: [] }),
    [store],
  );
  const citations = useMemo(() => buildCitationMap(answer, store), [answer, store]);

  const visibleSpanIds = useMemo(() => {
    if (!answer) return [];
    return [...citations.entries()]
      .filter(([, entry]) => entry.span.docId === activeDocId && entry.check.stalenessStatus !== "outdated")
      .map(([spanId]) => spanId);
  }, [answer, citations, activeDocId]);

  if (!store) {
    return (
      <div className="app">
        <header className="topbar">
          <div className="brand">
            <h1>
              Xanadu <span>Resurrection</span>
            </h1>
            <p>Immutable I-Space · verifiable AI citations</p>
          </div>
        </header>
        <div style={{ padding: 24 }} className="muted">
          {error ?? "Loading the docuverse…"}
        </div>
      </div>
    );
  }

  return (
    <div className="app">
      <header className="topbar">
        <div className="brand">
          <h1>
            Xanadu <span>Resurrection</span>
          </h1>
          <p>Immutable I-Space · span-addressed citations · ghost-claim verification</p>
        </div>
        <div className="topbar-spacer" />
        <button
          className="btn btn-sm"
          onClick={() => setSourcesOpen(true)}
          aria-haspopup="dialog"
          aria-expanded={sourcesOpen}
          title="Exclude, remove, restore or delete sources"
        >
          Sources ({activeDocs.length})
        </button>
        <label
          className="btn btn-sm import-btn"
          title="Import Markdown files. [[wikilinks]] and ![[embeds]] become span links."
        >
          {importing ? "Importing…" : "Import Markdown"}
          <input
            type="file"
            multiple
            accept=".md,.markdown,.txt,text/markdown,text/plain"
            disabled={importing}
            onChange={(event) => {
              const files = Array.from(event.currentTarget.files ?? []);
              event.currentTarget.value = "";
              void importFiles(files);
            }}
          />
        </label>
        <span className="badge" title="Every edit appends a new immutable version">
          {activeDocs.length} sources · {store.documentVersions.length} versions · {store.spanLinks.length} spans
        </span>
      </header>

      <form
        className="question-row"
        onSubmit={(event) => {
          event.preventDefault();
          void ask();
        }}
      >
        <input
          value={question}
          onChange={(event) => setQuestion(event.target.value)}
          placeholder={DEFAULT_QUESTION}
          aria-label="Question"
        />
        <button
          className="btn btn-primary"
          type="submit"
          disabled={loading || !question.trim()}
        >
          {loading ? "Tracing…" : "Ask the archive"}
        </button>
      </form>

      {notice && <div className="notice">{notice}</div>}

      <div className="pane-grid">
        <Xwrapper>
        <section className="pane">
          <div className="pane-head">
            <h2>Link graph</h2>
            <span className="mono muted">hop stream</span>
          </div>
          <div className="pane-body tight">
            <GraphView
              graph={graph}
              activeNodeId={activeDocId}
              hop={hop}
              onSelectNode={setActiveDocId}
            />
            <p className="small muted" style={{ marginTop: 10 }}>
              Nodes are documents; edges are span links. Asking a question streams retrieval hops and
              fires a particle along each traversed link.
            </p>
            <div className="hop-list">
              {answer?.traversal.slice(0, 4).map((step) => (
                <div key={`${step.step}-${step.spanId}`} className="hop">
                  <b>{step.step}</b>
                  <span>{step.fromDocId.replace("doc_", "")}</span>
                  <span className="arrow">→</span>
                  <span>{step.toDocId.replace("doc_", "")}</span>
                </div>
              ))}
            </div>
          </div>
        </section>

        <ReaderPane
          key={activeDocId}
          store={store}
          activeDocId={activeDocId}
          citations={citations}
          selectedSpanId={selectedSpanId}
          onSelectDoc={setActiveDocId}
          onSelectSpan={setSelectedSpanId}
          onSave={saveDocument}
        />

        <ProofPane
          answer={answer}
          store={store}
          source={source}
          loading={loading}
          error={error}
          hop={hop}
          selectedSpanId={selectedSpanId}
          onSelectSpan={setSelectedSpanId}
        />

          <SpanBridges answer={answer} visibleSpanIds={visibleSpanIds} />
        </Xwrapper>
      </div>

      {sourcesOpen && (
        <SourcesPanel
          store={store}
          onClose={() => setSourcesOpen(false)}
          onOpenDoc={openSource}
          onToggleUse={toggleSourceUse}
          onRemove={removeSource}
          onRestore={restoreSource}
          onDelete={deleteSource}
          onReset={resetSources}
        />
      )}
    </div>
  );
}

/* ------------------------------------------------------------ sources */

type SourcesConfirm =
  | { kind: "delete"; docId: string; title: string; versions: number }
  | { kind: "reset" }
  | null;

interface SourcesPanelProps {
  store: XanaduStore;
  onClose: () => void;
  onOpenDoc: (docId: string) => void;
  onToggleUse: (docId: string, use: boolean) => void;
  onRemove: (docId: string) => void;
  onRestore: (docId: string) => void;
  onDelete: (docId: string) => void;
  onReset: () => void;
}

function docSizeKb(store: XanaduStore, docId: string): number {
  const bytes = getVersionsForDoc(store, docId).reduce(
    (sum, version) => sum + version.content.length * 2,
    0,
  );
  return Math.max(0.1, Math.round((bytes / 1024) * 10) / 10);
}

function SourcesPanel({
  store,
  onClose,
  onOpenDoc,
  onToggleUse,
  onRemove,
  onRestore,
  onDelete,
  onReset,
}: SourcesPanelProps) {
  const [confirm, setConfirm] = useState<SourcesConfirm>(null);
  const active = store.documents.filter((doc) => doc.status !== "removed");
  const removed = store.documents.filter((doc) => doc.status === "removed");

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key !== "Escape") return;
      if (confirm) setConfirm(null);
      else onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [confirm, onClose]);

  return (
    <div className="sources-scrim" role="presentation" onClick={onClose}>
      <div
        className="sources-panel"
        role="dialog"
        aria-modal="true"
        aria-label="Sources"
        onClick={(event) => event.stopPropagation()}
      >
        <div className="sources-head">
          <div>
            <h2>Sources</h2>
            <p className="small muted" style={{ margin: 0 }}>
              {active.length} active · {removed.length} removed
            </p>
          </div>
          <button className="btn btn-sm" onClick={onClose}>
            Close
          </button>
        </div>

        <div className="sources-body">
          <p className="section-title">Active sources</p>
          {active.length === 0 ? (
            <div className="empty">No active sources yet. Import a document or reset the demo data.</div>
          ) : (
            active.map((doc) => {
              const versions = getVersionsForDoc(store, doc.docId).length;
              const excluded = doc.useInQuestions === false;
              return (
                <div key={doc.docId} className={`source-row${excluded ? " off" : ""}`}>
                  <div className="source-main">
                    <span className="source-title">{doc.title}</span>
                    <span className="source-meta">
                      {versions} version{versions === 1 ? "" : "s"} · {docSizeKb(store, doc.docId)} KB ·{" "}
                      {excluded ? "excluded from questions" : "active"}
                    </span>
                  </div>
                  <div className="source-actions">
                    <label className="check" title="Excluded sources are not sent to /ask">
                      <input
                        type="checkbox"
                        checked={!excluded}
                        onChange={(event) => onToggleUse(doc.docId, event.target.checked)}
                      />
                      Use in questions
                    </label>
                    <button className="btn btn-sm" onClick={() => onOpenDoc(doc.docId)}>
                      Open
                    </button>
                    <button className="btn btn-sm" onClick={() => onRemove(doc.docId)}>
                      Remove
                    </button>
                  </div>
                </div>
              );
            })
          )}

          <p className="section-title" style={{ marginTop: 18 }}>
            Removed · {removed.length}
          </p>
          {removed.length === 0 ? (
            <p className="small muted" style={{ margin: 0 }}>
              Nothing removed. Removed sources are hidden from the graph, the Reader and questions, but
              their history is kept.
            </p>
          ) : (
            removed.map((doc) => {
              const versions = getVersionsForDoc(store, doc.docId).length;
              return (
                <div key={doc.docId} className="source-row removed">
                  <div className="source-main">
                    <span className="source-title">{doc.title}</span>
                    <span className="source-meta">
                      {versions} version{versions === 1 ? "" : "s"} · {docSizeKb(store, doc.docId)} KB ·
                      removed
                    </span>
                  </div>
                  <div className="source-actions">
                    <button className="btn btn-sm" onClick={() => onRestore(doc.docId)}>
                      Restore
                    </button>
                    <button
                      className="btn btn-sm btn-danger"
                      onClick={() =>
                        setConfirm({
                          kind: "delete",
                          docId: doc.docId,
                          title: doc.title,
                          versions,
                        })
                      }
                    >
                      Delete permanently
                    </button>
                  </div>
                </div>
              );
            })
          )}

          <div className="divider" />
          <button className="btn btn-sm" onClick={() => setConfirm({ kind: "reset" })}>
            Reset demo data
          </button>
        </div>

        {confirm && (
          <div className="confirm-layer">
            <div className="confirm-box" role="alertdialog" aria-modal="true" aria-label="Confirm">
              <p className="confirm-title">
                {confirm.kind === "delete" ? "Delete source permanently?" : "Reset demo data?"}
              </p>
              <p className="small muted" style={{ marginTop: 0 }}>
                {confirm.kind === "delete"
                  ? `“${confirm.title}”, its ${confirm.versions} version${confirm.versions === 1 ? "" : "s"} and every link touching it will be erased. Saved answers keep their quote text but will report “Source deleted”.`
                  : "The archive returns to the 5 seed documents and their links. Imported documents are dropped. Saved answers are kept."}
              </p>
              <div className="confirm-actions">
                <button className="btn btn-sm" onClick={() => setConfirm(null)}>
                  Cancel
                </button>
                <button
                  className="btn btn-sm btn-danger"
                  onClick={() => {
                    if (confirm.kind === "delete") onDelete(confirm.docId);
                    else void onReset();
                    setConfirm(null);
                  }}
                >
                  {confirm.kind === "delete" ? "Delete permanently" : "Reset demo data"}
                </button>
              </div>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
