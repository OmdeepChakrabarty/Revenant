# COMPONENTS.md — Project Xanadu Resurrection (Kiroween 2026)

## 0. Kiroween 2026 Rules Verdict & Third-Party Code Disclosure

**Official Rules Source:** [Kiroween 2026 Official Rules (Devpost)](https://kiroween.devpost.com/rules)

### Rules Verdict on Reusing Open-Source Components
- **Allowed:** Yes. Standard open-source libraries, frameworks, and starter templates are explicitly permitted under the **New Projects Only** and **Intellectual Property** clauses of the [Kiroween 2026 Official Rules](https://kiroween.devpost.com/rules), provided you comply with their open-source licenses and build new software during the Submission Period (**October 30, 2026, 9:00 AM PT – December 4, 2026, 2:00 PM PT**) that enhances and builds upon the underlying libraries.
- **Required Disclosures in Your Submission & Kiro Write-Up:**
  1. **Root License Visibility:** Include a permissive OSI-approved `LICENSE` file (e.g., `MIT`) at the root of your public GitHub repository so GitHub detects and displays it in the repository's **About** section.
  2. **Keep `/.kiro` Tracked in Git:** Commit your `/.kiro` directory (specs, hooks, steering) at the repository root and ensure `/.kiro` is **never** added to `.gitignore`.
  3. **Declare Pre-Existing / Third-Party Components:** Include this `COMPONENTS.md` file in your repository and reference it in your Devpost submission description to disclose all reused open-source packages and adapted algorithms.
  4. **Document Kiro Feature Usage:** In your Devpost Kiro write-up, explicitly address how you used Kiro (IDE/CLI/Web/Crew, Spec-driven development vs. vibe coding, Agent hooks, Steering docs, MCP, Custom agents, Property-based testing, and Kiro powers) to integrate and extend these components.

### Verbatim Rule Citations (<15 words each)
- **(a) Open-source libraries allowed:**
  > "Participants may use standard development resources, including frameworks, libraries" ([Kiroween 2026 Official Rules](https://kiroween.devpost.com/rules))
- **(b) Disclosure & license compliance:**
  > "must disclose any other pre-existing code or work incorporated into" ([Kiroween 2026 Official Rules](https://kiroween.devpost.com/rules))
- **(c) Built during submission period:**
  > "Projects must be newly created by the Entrant after the start of the Hackathon" ([Kiroween 2026 Official Rules](https://kiroween.devpost.com/rules))
- **(d) AI tools & Kiro usage requirement:**
  > "Entrants must build a working software application using Kiro (IDE, CLI, Web" ([Kiroween 2026 Official Rules](https://kiroween.devpost.com/rules))

---

## A. Stack Actually Used

Everything below is installed and imported by the shipped code. The app is three
Python files, four TypeScript/React files, one `index.html` and one
`requirements.txt`; the backend is stateless and owns no database.

| Layer / Feature | Component | License | Exact Integration Point |
| :--- | :--- | :--- | :--- |
| **Feature 1: Stale-Answer Detection** | [`nonoroazoro/diff-match-patch-typescript`](https://github.com/nonoroazoro/diff-match-patch-typescript) | Apache-2.0 | `frontend/src/xanadu.ts` → `checkSpanStaleness()`, `diffSegments()`; `DiffMatchPatch.diff_main` / `diff_xIndex` remap `[start, end)` onto the newest version. |
| **Feature 1 (fallback)** | [`hypothesis/client`](https://github.com/hypothesis/client) `TextQuoteSelector` pattern (**adapted algorithm, no dependency**) | BSD-2-Clause | `frontend/src/xanadu.ts` → `findQuoteCandidate()` / `contextScore()`; a unique occurrence or the best-scoring 32-char prefix/suffix match re-anchors the quote. |
| **Feature 2: Ghost Claims** | [`anthropics/claude-cookbooks`](https://github.com/anthropics/claude-cookbooks) citation prompt (**adapted prompt, no dependency**) | MIT | `backend/provenance.py` → `build_prompt()` wraps spans as `[SPAN id]…[/SPAN]` and demands `<cite span="…">` tags; `verify_answer()` performs the deterministic `GHOST_MODE=simple` check (`MIN_OVERLAP = 0.3`). |
| **Feature 4: Macro graph** | [`vasturiano/react-force-graph`](https://github.com/vasturiano/react-force-graph) (`react-force-graph-2d`) | MIT | `frontend/src/GraphView.tsx` → `ForceGraph2D`, `nodeCanvasObject` halo, `emitParticle(link)` per SSE hop. |
| **Feature 4: Micro bridges** | [`Eliav2/react-xarrows`](https://github.com/Eliav2/react-xarrows) | MIT | `frontend/src/ReaderAndProof.tsx` → `SpanBridges` (`<Xarrow animateDrawing={0.3}>`) plus `useXarrow()` inside a `requestAnimationFrame`-throttled capture-phase scroll listener. |
| **UI runtime** | [`facebook/react`](https://github.com/facebook/react) / `react-dom` | MIT | `frontend/src/App.tsx` mounts with `createRoot`. |
| **Build tooling** | [`vitejs/vite`](https://github.com/vitejs/vite), `@vitejs/plugin-react`, `typescript`, `@types/react`, `@types/react-dom` | MIT / MIT / Apache-2.0 / MIT / MIT | `frontend/vite.config.ts`, `frontend/tsconfig.json`, `npm run build`. |
| **API runtime** | [`fastapi/fastapi`](https://github.com/fastapi/fastapi), `pydantic`, `httpx`, `uvicorn` | MIT / MIT / BSD-3-Clause / BSD-3-Clause | `backend/app.py` (two routes), `backend/provenance.py` (`httpx.AsyncClient` REST call), `backend/requirements.txt`. |

### Deliberately not used
These appeared in earlier drafts and were removed because they are heavy,
copyleft, or simply unnecessary:

- `lettucedetect` / `torch` / `transformers` — multi-gigabyte Vercel bundle; the
  deterministic verifier in `provenance.py` replaces it.
- `yjs` — CRDT anchors are unnecessary once versions are immutable and spans are
  version-pinned.
- `sigma.js` — `react-force-graph-2d` already covers the canvas rendering.
- `jackyzha0/quartz` importer — a bonus feature, intentionally out of scope.
- `python-dotenv`, `python-multipart`, `pytest`, `diff-match-patch` (Python) —
  unused; configuration comes from real environment variables only.
- SQLite (`sqlite3`) and the previous `/documents` endpoints — the backend is
  stateless by design; all state lives in the browser.

---

## B. Canonical Data Model

Kept byte-for-byte identical between `frontend/src/xanadu.ts` and the Pydantic
models in `backend/app.py` (camelCase on both sides).

```typescript
export interface DocumentRecord {
  docId: string;
  title: string;
  latestVersion: number;
  createdAt: string;
}

export interface DocumentVersion {      // APPEND-ONLY: never mutated, never deleted
  docVersionId: string;                  // `${docId}@v${version}`
  docId: string;
  version: number;
  content: string;
  contentHash: string;                   // SHA-256 via crypto.subtle
  parentVersionId: string | null;
  createdAt: string;
}

export interface SpanAddress {           // half-open, 0-based, version-pinned
  spanId: string;                        // `${docId}@v${version}:${start}-${end}`
  docId: string;
  docVersionId: string;
  version: number;
  start: number;
  end: number;
  exact: string;
  prefix: string;                        // 32 chars before start
  suffix: string;                        // 32 chars after end
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
  citedSpans: SpanAddress[];             // empty [] => Ghost Claim
  groundingStatus: "supported" | "unsupported";
  hallucinationConfidence: number;       // simple mode: 0.0 / 1.0
  stalenessStatus: "fresh" | "outdated"; // recomputed in the browser
}

export interface AIAnswerRecord {
  answerId: string;
  question: string;
  fullText: string;
  traversal: { step: number; fromDocId: string; toDocId: string; spanId: string }[];
  sentences: AnswerSentenceClaim[];
  createdAt: string;
}
```

The backend never stores an answer; `POST /ask` streams `hop` events and one
`answer` event, and the browser appends it to `aiAnswers` in `localStorage`.

---

## C. Reused Algorithms (no code copied verbatim)

1. **`TextQuoteSelector` anchoring** — the `{exact, prefix, suffix}` selector
   shape and the "unique match wins, otherwise score the context" strategy are
   adapted from [`hypothesis/client`](https://github.com/hypothesis/client)
   (`src/annotator/anchoring/`), BSD-2-Clause. Reimplemented in
   `checkSpanStaleness()`.
2. **Citation-agent prompt** — the "wrap sources, demand inline span citations,
   verify afterwards" structure follows
   [`anthropics/claude-cookbooks`](https://github.com/anthropics/claude-cookbooks)
   `patterns/agents/prompts/citations_agent.md`, MIT. Adapted in `build_prompt()`.
3. **Diff/patch offset translation** — `diff_main` + `diff_xIndex` semantics come
   from [`google/diff-match-patch`](https://github.com/google/diff-match-patch)
   (Apache-2.0) through its TypeScript port.

---

## D. Third-Party Attribution & License Ledger

Include this section in your repository documentation and reference it in your
Devpost submission write-up to satisfy the disclosure requirement of the
[Kiroween 2026 Official Rules](https://kiroween.devpost.com/rules).

| Package | Version | License | Reused scope |
| :--- | :--- | :--- | :--- |
| `react` | 19.3.1 | MIT | UI runtime |
| `react-dom` | 19.3.1 | MIT | `createRoot` mount |
| `react-force-graph-2d` | 1.29.2 | MIT | `ForceGraph2D`, `nodeCanvasObject`, `emitParticle` |
| `react-xarrows` | 2.2.1 | MIT | `Xarrow`, `Xwrapper`, `useXarrow` |
| `diff-match-patch-typescript` | 1.1.3 | Apache-2.0 | `DiffMatchPatch.diff_main`, `diff_xIndex`, `diff_cleanupSemantic` |
| `vite` | 8.4.0 | MIT | dev server + production build |
| `@vitejs/plugin-react` | 6.3.0 | MIT | React transform |
| `typescript` | 7.0.2 | Apache-2.0 | type checking / `tsc --noEmit` |
| `@types/react` | 19.3.3 | MIT | types |
| `@types/react-dom` | 19.3.0 | MIT | types |
| `fastapi` | 0.165.0 | MIT | `POST /ask`, `GET /health`, CORS |
| `pydantic` | 2.14.4 | MIT | request/response contracts |
| `httpx` | 0.29.0 | BSD-3-Clause | single REST call to the LLM |
| `uvicorn` | 0.54.0 | BSD-3-Clause | local ASGI server |

Adapted (not installed): `hypothesis/client` (BSD-2-Clause),
`anthropics/claude-cookbooks` (MIT), `google/diff-match-patch` (Apache-2.0).
