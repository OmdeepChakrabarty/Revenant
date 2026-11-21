# AGENTS.md — Project Xanadu Resurrection (Kiroween 2026)

> **Instructions for Kiro:** Follow these rules in every session. Place this file at the repository root as `AGENTS.md` so Kiro loads it automatically as workspace steering ([Kiro Steering Docs](https://kiro.dev/docs/steering/)).

## 1. Mission & Non-Negotiable Rules

You are helping build a **Project Xanadu-inspired linked document and verifiable AI citation system** for the **Kiroween 2026** hackathon (**Resurrection** category).

1. **Never Overwrite Document History (Immutable I-Space):** `document_versions` is strictly INSERT-only. Editing a document MUST create a new version `docId@v{n+1}` with `parent_version_id` and `sha256(content)`. Never `UPDATE` or `DELETE` historical versions.
2. **Never Copy Quoted Text (Span Addressing):** All quotes, transclusions, and AI citations MUST use the canonical half-open 0-based character address format:
   `{docId}@v{version}:{start}-{end}`
   along with `{exact, prefix, suffix}` (32-char context window) for fallback anchoring.
3. **Strict 7-File Simplicity Cap:** Keep the entire application inside the **7 code files** listed in Section 2 (3 Python backend + 4 React/TypeScript frontend). Do NOT add extra service layers, ORMs, Dockerfiles, paid vector databases, or unnecessary abstractions unless explicitly asked.
4. **Free-Tier Only:** Everything must run locally and on free tiers (SQLite, CPU-friendly models, no paid APIs required to run the core demo).
5. **Permissive Licenses & Kiroween Compliance:**
   * Only install **MIT / Apache-2.0 / BSD** packages. **Never** add GPL/AGPL or unlicensed code.
   * **Never** add `/.kiro` to `.gitignore`.
   * Keep root `LICENSE` (MIT) and `COMPONENTS.md` up to date if any new open-source library is added.

---

## 2. Exact Project File Map (7 Code Files Only)

```text
xanadu-resurrection/
├── AGENTS.md                        # This file (always loaded by Kiro)
├── COMPONENTS.md                    # Third-party attribution ledger
├── LICENSE                          # MIT License (root)
├── .kiro/                           # Specs, steering, hooks (committed to git)
├── backend/                         # Python 3.11+ / FastAPI / SQLite
│   ├── xanadu.py                    # Core Xanadu: DB schema, immutable versions, spans, links, importer
│   ├── provenance.py                # AI Proof Engine: graph retriever (SSE), <cite> LLM, LettuceDetect
│   └── app.py                       # FastAPI server, 5 endpoints, CORS, auto-seed sample docs
└── frontend/                        # Vite / React / TypeScript / Tailwind CSS
    └── src/
        ├── xanadu.ts                # Shared TS types, REST/SSE client, diff-match-patch remapper
        ├── GraphView.tsx            # Feature 4: react-force-graph animated hop graph
        ├── ReaderAndProof.tsx       # Features 1, 2 & 4: Doc editor, Proof UI, react-xarrows bridges
        └── App.tsx                  # 3-pane workspace shell & shared state
```

---

## 3. Canonical Data & API Contracts

Keep backend Pydantic/SQLite fields and frontend TypeScript fields **100% identical** (camelCase in JSON responses):

### SQLite Schema (`backend/xanadu.py`)
* `documents (doc_id TEXT PK, title TEXT, latest_version INT, created_at TEXT)`
* `document_versions (doc_version_id TEXT PK, doc_id TEXT, version INT, content TEXT, content_hash TEXT, parent_version_id TEXT, created_at TEXT)`
* `span_links (link_id TEXT PK, link_type TEXT, from_doc_version_id TEXT, from_start INT, from_end INT, to_doc_version_id TEXT, to_start INT, to_end INT, exact_quote TEXT, prefix TEXT, suffix TEXT)`
* `ai_answers (answer_id TEXT PK, question TEXT, full_text TEXT, traversal_json TEXT, sentences_json TEXT, created_at TEXT)`

### Core JSON Shapes (`frontend/src/xanadu.ts` & `backend/app.py`)
```typescript
export interface SpanAddress {
  spanId: string;        // "${docId}@v${version}:${start}-${end}"
  docId: string;
  docVersionId: string;  // "${docId}@v${version}"
  version: number;
  start: number;         // 0-based inclusive
  end: number;           // 0-based exclusive
  exact: string;
  prefix: string;        // 32 chars before start
  suffix: string;        // 32 chars after end
}

export interface AnswerSentenceClaim {
  sentenceIndex: number;
  text: string;
  answerStart: number;
  answerEnd: number;
  citedSpans: SpanAddress[];
  groundingStatus: "supported" | "unsupported"; // "unsupported" = Ghost Claim
  hallucinationConfidence: number;              // 0.0 to 1.0 from LettuceDetect
  stalenessStatus: "fresh" | "outdated";
}
```

### API Endpoints (`backend/app.py`)
1. `GET /docs` — List documents with latest version content and version history.
2. `POST /docs/{doc_id}/edit` — Body `{ content: string }` -> appends `v+1` (never overwrites), returns new `DocumentVersion`.
3. `GET /graph` — Returns `{ nodes: [...], links: [...] }` for `ForceGraph2D`.
4. `POST /ask` — Body `{ question: string }` -> **Server-Sent Events (`text/event-stream`)**:
   * Emits `event: hop` with `{"step": 1, "fromDocId": "a", "toDocId": "b", "spanId": "b@v1:10-80"}` for each link traversed.
   * Emits `event: answer` with the final verified `AIAnswerRecord` JSON.
5. `GET /answers/{answer_id}` — Returns the saved `AIAnswerRecord` plus latest version texts of all cited documents so the frontend can compute staleness immediately.

---

## 4. Approved Libraries & Exact Integration Points

Always use these vetted libraries—do **not** substitute heavy frameworks or copyleft packages:

* **Feature 1 — Stale-Answer Detection (`frontend/src/xanadu.ts`):**
  * Package: [`diff-match-patch-typescript`](https://github.com/nonoroazoro/diff-match-patch-typescript) (Apache-2.0).
  * Logic: Run `diff_main(oldContent, newContent)` and translate offsets via `diff_xIndex(diffs, start)` / `diff_xIndex(diffs, end)`. If `newContent.slice(newStart, newEnd) !== span.exact`, run a fuzzy `TextQuoteSelector` (`{exact, prefix, suffix}`) fallback adapted from [`hypothesis/client`](https://github.com/hypothesis/client) (`src/annotator/anchoring/`). If still mutated or missing, flag the sentence and answer as `"outdated"`.
* **Feature 2 — Ghost Claims (`backend/provenance.py`):**
  * Prompt: Adapt [`patterns/agents/prompts/citations_agent.md`](https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/prompts/citations_agent.md) from [`anthropics/claude-cookbooks`](https://github.com/anthropics/claude-cookbooks) (MIT). Wrap every retrieved span as `[SPAN docId@v:start-end]...[/SPAN]` and instruct the LLM to tag claims with `<cite span="docId@v:start-end">...</cite>`.
  * Verifier: Package [`lettucedetect`](https://github.com/KRLabsOrg/LettuceDetect) (MIT). Use the lightweight CPU-friendly `TinyLettuce` model via `HallucinationDetector.predict(context=cited_texts, question=question, answer=clean_answer, output_format="spans")`.
  * Rule: Drop any `<cite>` referencing an unretrieved `spanId`. Mark a sentence `"unsupported"` (Ghost Claim) if it has **no valid `<cite>`** OR **overlaps a LettuceDetect hallucinated span (`confidence >= 0.5`)**.
* **Feature 4 — Animated Link Traversal & Span Bridges:**
  * Macro Graph (`frontend/src/GraphView.tsx`): [`react-force-graph-2d`](https://github.com/vasturiano/react-force-graph) (MIT). Highlight the active node with a glowing halo in `nodeCanvasObject` and trigger `fgRef.current.emitParticle(link)` on every incoming SSE `hop` event.
  * Micro Span Bridges (`frontend/src/ReaderAndProof.tsx`): [`react-xarrows`](https://github.com/Eliav2/react-xarrows) (MIT). Wrap panes in `<Xwrapper>`, assign `id="claim-{i}"` to answer sentences and `id={spanId}` to source `<mark>` spans, and draw `<Xarrow start={claimId} end={spanId} animateDrawing={0.3} />`. **Important:** Call `useXarrow()` inside a `requestAnimationFrame`-throttled `onScroll` handler so lines stay locked while scrolling.
* **Bonus — Obsidian Importer (`backend/xanadu.py`):**
  * Adapt `wikilinkRegex` (`[[Note]]`, `![[Embed]]`, `#^block-id`) from [`jackyzha0/quartz`](https://github.com/jackyzha0/quartz) (`quartz/plugins/transformers/ofm.ts`, MIT) to parse uploaded Markdown files into `span_links`.

---

## 5. Build Order & Verification Checklist

Build strictly in this order and verify each milestone before moving on:

1. **Step 1 (`backend/xanadu.py` + `backend/app.py`):** Create SQLite tables, immutable `edit_doc`, span slicing, and seed 5–6 linked sample documents on startup.
   * *Verify:* Editing a doc increments `version` to `2` while `GET` on `@v1` still returns the original text unchanged.
2. **Step 2 (`backend/provenance.py` + `/ask` SSE):** Implement graph-walking retrieval with SSE `hop` events, `<cite>` generation, and `LettuceDetect` (`TinyLettuce`) sentence verification.
   * *Verify:* `curl -N -X POST /ask` streams at least 2 `event: hop` lines followed by `event: answer` containing both `"supported"` and `"unsupported"` test cases.
3. **Step 3 (`frontend/src/xanadu.ts` + `GraphView.tsx`):** Connect SSE client, build `checkSpanStaleness`, and animate `ForceGraph2D` particles on live hops.
4. **Step 4 (`frontend/src/ReaderAndProof.tsx` + `App.tsx`):** Render clickable grounded sentences with `<Xarrow>` bridges to source `<mark>` spans, faded `"unsupported"` Ghost Claims, and an inline **Save as v+1** editor that immediately flips an existing answer to `"Outdated"` with a *"Then vs. Now"* diff view.
