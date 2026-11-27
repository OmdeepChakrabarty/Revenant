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
  askQuestion,
  buildGraph,
  DEMO_ANSWER,
  editDoc,
  loadOrSeedStore,
  refreshAnswerStaleness,
  saveAnswer,
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

  const saveDocument = useCallback(
    async (docId: string, content: string) => {
      if (!store) return;
      const { store: next } = await editDoc(store, docId, content);
      setStore(next);
      setAnswer((previous) => (previous ? refreshAnswerStaleness(previous, next) : previous));
    },
    [store],
  );

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
        <span className="badge" title="Every edit appends a new immutable version">
          {store.documents.length} docs · {store.documentVersions.length} versions · {store.spanLinks.length} spans
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
        <button className="btn btn-primary" type="submit" disabled={loading || !question.trim()}>
          {loading ? "Tracing…" : "Ask the archive"}
        </button>
      </form>

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
    </div>
  );
}

createRoot(document.getElementById("root")!).render(<App />);
