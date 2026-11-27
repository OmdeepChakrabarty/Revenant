/**
 * ReaderAndProof.tsx — Features 1, 2 and 4 (micro view).
 *
 * ReaderPane: immutable version history + inline "Save as v+1" editor, with
 * every cited span highlighted as a <mark id={spanId}>.
 * ProofPane: sentence-level grounded claims, faded Ghost Claims and the
 * "Then vs. Now" diff once a cited source has moved on.
 * SpanBridges: react-xarrows bridges between `claim-{i}` and `{spanId}`.
 */
import { useEffect, useMemo, useState } from "react";
import type { ReactNode } from "react";
import Xarrow, { useXarrow } from "react-xarrows";
import {
  checkSpanStaleness,
  diffSegments,
  getLatestVersion,
  getVersion,
  getVersionsForDoc,
} from "./xanadu";
import type { AIAnswerRecord, SpanAddress, StaleCheck, TraversalHop, XanaduStore } from "./xanadu";

export type AnswerSource = "recorded" | "live" | "fallback";

export interface CitedSpanEntry {
  span: SpanAddress;
  check: StaleCheck;
}

interface ReaderPaneProps {
  store: XanaduStore;
  activeDocId: string;
  citations: Map<string, CitedSpanEntry>;
  selectedSpanId: string | null;
  onSelectDoc: (docId: string) => void;
  onSelectSpan: (spanId: string) => void;
  onSave: (docId: string, content: string) => Promise<void>;
}

interface MarkRange {
  spanId: string;
  start: number;
  end: number;
}

function renderWithMarks(
  content: string,
  marks: MarkRange[],
  selectedSpanId: string | null,
  onSelectSpan: (spanId: string) => void,
) {
  const nodes: ReactNode[] = [];
  let cursor = 0;
  const sorted = [...marks].sort((a, b) => a.start - b.start);
  sorted.forEach((mark, index) => {
    if (mark.start < cursor || mark.end > content.length || mark.start >= mark.end) return;
    if (mark.start > cursor) nodes.push(content.slice(cursor, mark.start));
    nodes.push(
      <mark
        key={`${mark.spanId}-${index}`}
        id={mark.spanId}
        className={selectedSpanId === mark.spanId ? "active" : undefined}
        title={mark.spanId}
        onClick={() => onSelectSpan(mark.spanId)}
      >
        {content.slice(mark.start, mark.end)}
      </mark>,
    );
    cursor = mark.end;
  });
  if (cursor < content.length) nodes.push(content.slice(cursor));
  return nodes;
}

export function ReaderPane({
  store,
  activeDocId,
  citations,
  selectedSpanId,
  onSelectDoc,
  onSelectSpan,
  onSave,
}: ReaderPaneProps) {
  const versions = useMemo(() => getVersionsForDoc(store, activeDocId), [store, activeDocId]);
  const latest = versions[versions.length - 1];
  const [viewVersion, setViewVersion] = useState(latest?.version ?? 1);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(latest?.content ?? "");
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    if (!latest) return;
    setViewVersion(latest.version);
    if (!editing) setDraft(latest.content);
  }, [latest, editing]);

  const viewing = versions.find((v) => v.version === viewVersion) ?? latest;
  const citingSpans = [...citations.values()].filter((entry) => entry.span.docId === activeDocId);

  const marks: MarkRange[] = citingSpans.flatMap((entry) => {
    if (!viewing) return [];
    if (viewing.version !== latest?.version) {
      // Historical view: show the mark exactly where it was addressed.
      if (entry.span.docVersionId !== viewing.docVersionId) return [];
      return [{ spanId: entry.span.spanId, start: entry.span.start, end: entry.span.end }];
    }
    // Latest view: follow the remapped offsets, unless the text mutated.
    if (entry.check.stalenessStatus === "outdated") return [];
    return [{ spanId: entry.span.spanId, start: entry.check.newStart, end: entry.check.newEnd }];
  });

  const save = async () => {
    if (!latest || saving) return;
    setSaving(true);
    try {
      await onSave(activeDocId, draft);
      setEditing(false);
    } finally {
      setSaving(false);
    }
  };

  return (
    <section className="pane">
      <div className="pane-head">
        <h2>Reader · I-Space</h2>
        <span className="mono muted">{versions.length} immutable version{versions.length === 1 ? "" : "s"}</span>
      </div>
      <div className="pane-body">
        <div className="doc-list">
          {store.documents.map((doc) => (
            <button
              key={doc.docId}
              className={`doc-item${doc.docId === activeDocId ? " active" : ""}`}
              onClick={() => onSelectDoc(doc.docId)}
            >
              <span className="t">{doc.title}</span>
              <span className="m">{doc.docId} · v{doc.latestVersion}</span>
            </button>
          ))}
        </div>

        <div className="divider" />

        {!viewing ? (
          <div className="empty">Select a document to read it.</div>
        ) : (
          <>
            <div style={{ display: "flex", alignItems: "flex-start", gap: 8, flexWrap: "wrap" }}>
              <div style={{ flex: 1, minWidth: 160 }}>
                <h3 className="doc-title">{store.documents.find((d) => d.docId === activeDocId)?.title}</h3>
                <div className="mono muted">{viewing.docVersionId}</div>
              </div>
              {!editing && latest && (
                <button
                  className="btn btn-sm"
                  onClick={() => {
                    setDraft(latest.content);
                    setEditing(true);
                  }}
                >
                  Edit
                </button>
              )}
            </div>

            <div style={{ display: "flex", gap: 5, flexWrap: "wrap", margin: "9px 0 12px" }}>
              {versions.map((version) => (
                <button
                  key={version.docVersionId}
                  className={`btn btn-sm${version.version === viewVersion ? " btn-primary" : ""}`}
                  onClick={() => setViewVersion(version.version)}
                  title={version.contentHash}
                >
                  v{version.version}
                </button>
              ))}
              {viewVersion !== latest?.version && <span className="badge">read-only history</span>}
            </div>

            {editing ? (
              <>
                <textarea
                  className="editor"
                  value={draft}
                  onChange={(event) => setDraft(event.target.value)}
                  spellCheck={false}
                  aria-label="Document editor"
                />
                <div className="editor-actions">
                  <button className="btn btn-primary" onClick={save} disabled={saving || draft === latest?.content}>
                    {saving ? "Appending…" : `Save as v${(latest?.version ?? 1) + 1}`}
                  </button>
                  <button className="btn" onClick={() => setEditing(false)} disabled={saving}>
                    Cancel
                  </button>
                  <span className="small muted">
                    {citingSpans.length > 0
                      ? "Tip: change the highlighted passage to watch the answer go stale."
                      : "History is append-only; nothing is overwritten."}
                  </span>
                </div>
              </>
            ) : (
              <div className="doc-text">
                {renderWithMarks(viewing.content, marks, selectedSpanId, onSelectSpan)}
              </div>
            )}

            <div className="divider" />
            <p className="section-title">Provenance</p>
            <div className="small muted">
              SHA-256 · <span className="mono">{viewing.contentHash.slice(0, 24)}…</span>
              <br />
              parent · <span className="mono">{viewing.parentVersionId ?? "genesis (v1)"}</span>
            </div>
          </>
        )}
      </div>
    </section>
  );
}

/* --------------------------------------------------------------- proof */

interface ProofPaneProps {
  answer: AIAnswerRecord | null;
  store: XanaduStore;
  source: AnswerSource;
  loading: boolean;
  error: string | null;
  hop: TraversalHop | null;
  selectedSpanId: string | null;
  onSelectSpan: (spanId: string) => void;
}

function statusLabel(sentence: AIAnswerRecord["sentences"][number]): string {
  if (sentence.stalenessStatus === "outdated") return "outdated";
  return sentence.groundingStatus;
}

export function ProofPane({
  answer,
  store,
  source,
  loading,
  error,
  hop,
  selectedSpanId,
  onSelectSpan,
}: ProofPaneProps) {
  const [selectedSentence, setSelectedSentence] = useState<number | null>(null);

  const staleDocs = useMemo(() => {
    const map = new Map<string, { citedVersionId: string; latestVersionId: string }>();
    if (!answer) return map;
    for (const sentence of answer.sentences) {
      if (sentence.stalenessStatus !== "outdated") continue;
      for (const span of sentence.citedSpans) {
        const latest = getLatestVersion(store, span.docId);
        if (!latest || latest.docVersionId === span.docVersionId) continue;
        map.set(span.docId, {
          citedVersionId: span.docVersionId,
          latestVersionId: latest.docVersionId,
        });
      }
    }
    return map;
  }, [answer, store]);

  const badgeClass =
    source === "live" ? "badge badge-live" : source === "fallback" ? "badge badge-demo" : "badge";
  const badgeText =
    source === "live" ? "Live backend" : source === "fallback" ? "Demo · backend unreachable" : "Recorded demo";

  return (
    <section className="pane">
      <div className="pane-head">
        <h2>Proof · V-Space</h2>
        <span className={badgeClass}>
          <span className="dot" />
          {badgeText}
        </span>
      </div>
      <div className="pane-body">
        {error && <div className="error-box">{error}</div>}

        {loading && (
          <div className="small muted pulsing" style={{ marginBottom: 10 }}>
            Walking the link graph… {hop ? `hop ${hop.step} → ${hop.toDocId}` : "selecting a start document"}
          </div>
        )}

        {!answer ? (
          <div className="empty">
            {loading ? "Streaming spans…" : "Ask a question to generate a cited answer."}
          </div>
        ) : (
          <>
            <p className="section-title">Question</p>
            <p style={{ margin: "0 0 12px", fontSize: 14 }}>{answer.question}</p>

            {answer.traversal.length > 0 && (
              <>
                <p className="section-title">Traversal · {answer.traversal.length} hops</p>
                <div className="hop-list" style={{ marginBottom: 14 }}>
                  {answer.traversal.map((step) => (
                    <div
                      key={`${step.step}-${step.spanId}`}
                      className="hop"
                      style={hop?.step === step.step ? { borderColor: "rgba(125,211,252,0.5)", color: "#cfe9f7" } : undefined}
                    >
                      <b>{step.step}</b>
                      <span>{step.fromDocId.replace("doc_", "")}</span>
                      <span className="arrow">→</span>
                      <span>{step.toDocId.replace("doc_", "")}</span>
                      <span style={{ marginLeft: "auto" }}>{step.spanId.split(":")[1]}</span>
                    </div>
                  ))}
                </div>
              </>
            )}

            <p className="section-title">Verified sentences</p>
            <div id="claim-list">
              {answer.sentences.map((sentence) => {
                const label = statusLabel(sentence);
                const ghost = sentence.groundingStatus === "unsupported";
                return (
                  <div
                    key={sentence.sentenceIndex}
                    id={`claim-${sentence.sentenceIndex}`}
                    className={[
                      "sentence",
                      ghost ? "ghost" : "",
                      selectedSentence === sentence.sentenceIndex ? "selected" : "",
                    ]
                      .filter(Boolean)
                      .join(" ")}
                    onClick={() => {
                      setSelectedSentence(sentence.sentenceIndex);
                      const first = sentence.citedSpans[0];
                      if (first) onSelectSpan(first.spanId);
                    }}
                  >
                    <span className={`s-flag ${label === "supported" ? "s-ok" : label === "outdated" ? "s-stale" : "s-bad"}`}>
                      {label}
                    </span>
                    <div>{sentence.text}</div>
                    <div style={{ marginTop: 4 }}>
                      {sentence.citedSpans.map((span) => (
                        <span
                          key={span.spanId}
                          className="cite-chip"
                          title={`${span.spanId}\n${span.exact}`}
                          style={
                            selectedSpanId === span.spanId
                              ? { borderColor: "rgba(125,211,252,0.8)", background: "rgba(125,211,252,0.2)" }
                              : undefined
                          }
                          onClick={(event) => {
                            event.stopPropagation();
                            onSelectSpan(span.spanId);
                          }}
                        >
                          v{span.version}:{span.start}-{span.end}
                        </span>
                      ))}
                      {ghost && <span className="small muted" style={{ marginLeft: 6 }}>no retrievable source</span>}
                    </div>
                  </div>
                );
              })}
            </div>

            {staleDocs.size > 0 && (
              <>
                <div className="divider" />
                <p className="section-title">Outdated · Then vs. Now</p>
                {[...staleDocs.entries()].map(([docId, info]) => {
                  const before = getVersion(store, info.citedVersionId);
                  const after = getLatestVersion(store, docId);
                  if (!before || !after) return null;
                  return (
                    <div key={docId} style={{ marginBottom: 14 }}>
                      <div className="small" style={{ marginBottom: 6 }}>
                        {store.documents.find((d) => d.docId === docId)?.title ?? docId}
                      </div>
                      <div className="diff-grid">
                        <div className="diff-col diff-old">
                          <h4>Then · {before.docVersionId}</h4>
                          <div className="diff-box">{before.content}</div>
                        </div>
                        <div className="diff-col diff-new">
                          <h4>Now · {after.docVersionId}</h4>
                          <div className="diff-box">
                            {diffSegments(before.content, after.content).map((segment, index) =>
                              segment.op === "del" ? (
                                <del key={index}>{segment.text}</del>
                              ) : segment.op === "ins" ? (
                                <ins key={index}>{segment.text}</ins>
                              ) : (
                                <span key={index}>{segment.text}</span>
                              ),
                            )}
                          </div>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </>
            )}
          </>
        )}
      </div>
    </section>
  );
}

/* -------------------------------------------------------------- bridges */

interface SpanBridgesProps {
  answer: AIAnswerRecord | null;
  visibleSpanIds: string[];
}

/**
 * Draws one animated SVG bridge per visible citation. Must live inside the
 * <Xwrapper>. useXarrow() is called from a requestAnimationFrame-throttled
 * capture-phase scroll listener so bridges stay locked while panes scroll.
 */
export function SpanBridges({ answer, visibleSpanIds }: SpanBridgesProps) {
  const updateXarrow = useXarrow();
  const spanKey = visibleSpanIds.join("|");
  const visible = useMemo(() => new Set(visibleSpanIds), [spanKey]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    let frame = 0;
    const schedule = () => {
      if (frame) return;
      frame = requestAnimationFrame(() => {
        frame = 0;
        updateXarrow();
      });
    };
    window.addEventListener("scroll", schedule, true);
    window.addEventListener("resize", schedule);
    const settle = window.setTimeout(schedule, 150);
    return () => {
      window.removeEventListener("scroll", schedule, true);
      window.removeEventListener("resize", schedule);
      window.clearTimeout(settle);
      if (frame) cancelAnimationFrame(frame);
    };
  }, [updateXarrow]);

  useEffect(() => {
    const frame = requestAnimationFrame(() => updateXarrow());
    return () => cancelAnimationFrame(frame);
  }, [answer, spanKey, updateXarrow]);

  if (!answer) return null;

  return (
    <>
      {answer.sentences.flatMap((sentence) =>
        sentence.citedSpans
          .filter((span) => visible.has(span.spanId))
          .map((span) => (
            <Xarrow
              key={`${sentence.sentenceIndex}-${span.spanId}`}
              start={`claim-${sentence.sentenceIndex}`}
              end={span.spanId}
              color={sentence.groundingStatus === "supported" ? "rgba(125,211,252,0.5)" : "rgba(248,113,113,0.4)"}
              strokeWidth={1.3}
              path="smooth"
              animateDrawing={0.3}
              headSize={4}
              zIndex={5}
            />
          )),
      )}
    </>
  );
}

/** Small helper the shell uses to keep a citation lookup table memoised. */
export function buildCitationMap(
  answer: AIAnswerRecord | null,
  store: XanaduStore | null,
): Map<string, CitedSpanEntry> {
  const map = new Map<string, CitedSpanEntry>();
  if (!answer || !store) return map;
  for (const sentence of answer.sentences) {
    for (const span of sentence.citedSpans) {
      if (map.has(span.spanId)) continue;
      map.set(span.spanId, { span, check: checkSpanStaleness(span, store) });
    }
  }
  return map;
}
