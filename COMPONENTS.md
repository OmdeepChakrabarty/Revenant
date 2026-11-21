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

## A. Best Stack Combination

| Layer / Feature | Selected Component | Language / Runtime | License | How Spans Are Represented & Connected |
| :--- | :--- | :--- | :--- | :--- |
| **Feature 1: Stale-Answer Detection** | [`nonoroazoro/diff-match-patch-typescript`](https://github.com/nonoroazoro/diff-match-patch-typescript) + W3C `TextQuoteSelector` pattern from [`hypothesis/client`](https://github.com/hypothesis/client) | TypeScript (Frontend & Node/Bun API) | Apache-2.0 & BSD-2-Clause | Immutable document versions (`docId@v`) store exact `[startOffset, endOffset)` character intervals plus `{exact, prefix, suffix}` selectors. On edit (`v` -> `v+1`), `diff_main` + `diff_xIndex` remap `[start, end)` to the new version and flag any answer citation whose slice mutated as `"outdated"`. |
| **Feature 2: Ghost Claims (Unsourced Claims)** | [`KRLabsOrg/LettuceDetect`](https://github.com/KRLabsOrg/LettuceDetect) + citation prompt pattern from [`anthropics/claude-cookbooks`](https://github.com/anthropics/claude-cookbooks) | Python (FastAPI Backend, CPU-friendly `TinyLettuce` / `ModernBERT`) | MIT | `HallucinationDetector.predict(..., output_format="spans")` returns character spans `[{start, end, confidence, text}]` in the AI answer that lack support in the cited source spans. Any answer sentence overlapping an unsupported span (or missing a `<cite>` tag) is styled faded and badged `"unsupported"`. |
| **Feature 4: Animated Link Traversal View** | [`vasturiano/react-force-graph`](https://github.com/vasturiano/react-force-graph) (macro graph) + [`Eliav2/react-xarrows`](https://github.com/Eliav2/react-xarrows) (micro span bridge) | TypeScript / React | MIT | `ForceGraph2D` renders document nodes and transclusion links, firing `emitParticle(link)` as the AI streams retrieval events. Side-by-side transcluded `<mark id="span-...">` DOM elements are connected by animated `<Xarrow>` SVG bridges. |
| **Bonus: Obsidian Vault Importer** | [`jackyzha0/quartz`](https://github.com/jackyzha0/quartz) (`ofm.ts` / `links.ts` patterns) | TypeScript | MIT | Parses `[[Note#Heading]]`, `[[Note#^block-id]]`, and `![[Embed]]` syntax into explicit character-range transclusion links in the immutable store. |

**Why They Fit Together:**
- **Unified Coordinate System:** Every component operates on half-open UTF-16/UTF-8 character offsets `[start, end)` pinned to an immutable `docVersionId`.
- **Zero Paid API Dependency:** `diff-match-patch-typescript`, `react-force-graph`, and `react-xarrows` run 100% client-side in the browser; `LettuceDetect` runs locally on CPU/free-tier Colab/Spaces via `TinyLettuce` (17M–68M parameters) or `ModernBERT-base` with a built-in FastAPI server (`lettucedetect_api`).

---

## B. Minimal Data Model (TypeScript Interfaces)

```typescript
// 1. Immutable Document & Version Store (Xanadu I-Space / V-Space inspired)
export interface DocumentRecord {
  docId: string;              // e.g., "doc_xanadu_1981"
  title: string;
  latestVersion: number;      // monotonically increasing integer (1, 2, 3...)
  createdAt: string;          // ISO-8601 timestamp
}

export interface DocumentVersion {
  docVersionId: string;       // "${docId}@v${version}" (immutable primary key)
  docId: string;
  version: number;
  content: string;            // immutable raw text (I-space content)
  contentHash: string;        // SHA-256 of content
  parentVersionId?: string;   // previous version "${docId}@v${version - 1}"
  createdAt: string;
}

// 2. Span Addressing (Pinned to an Immutable DocumentVersion)
export interface SpanAddress {
  spanId: string;             // deterministic ID: "${docId}@v${version}:${start}-${end}"
  docId: string;
  docVersionId: string;       // e.g., "doc_xanadu_1981@v1"
  version: number;
  start: number;              // 0-based inclusive character offset (TextPositionSelector)
  end: number;                // 0-based exclusive character offset
  exact: string;              // verbatim text slice at creation (TextQuoteSelector)
  prefix: string;             // 32 chars before start for fuzzy fallback anchoring
  suffix: string;             // 32 chars after end for fuzzy fallback anchoring
}

// 3. Transclusion / Wikilink Edge (Graph & Side-by-Side View)
export interface SpanLink {
  linkId: string;
  type: "transclusion" | "wikilink" | "block_ref" | "citation";
  fromSpan: SpanAddress;      // quoting / referencing span
  toSpan: SpanAddress;        // quoted / target source span
}

// 4. AI Answer with Sentence Attribution, Ghost Claims & Stale Detection
export interface AnswerSentenceClaim {
  sentenceIndex: number;
  text: string;
  answerStart: number;        // char offset inside AI answer text
  answerEnd: number;
  citedSpans: SpanAddress[];  // empty [] if LLM emitted no citation
  groundingStatus: "supported" | "unsupported"; // "unsupported" = Ghost Claim
  hallucinationConfidence: number; // from LettuceDetect (0.0 to 1.0)
  stalenessStatus: "fresh" | "outdated"; // "outdated" if any citedSpan mutated in latestVersion
  remappedSpans?: {
    originalSpanId: string;
    latestDocVersionId: string;
    newStart: number;
    newEnd: number;
    currentText: string;
    isMutated: boolean;       // true when currentText !== exact
  }[];
}

export interface AIAnswerRecord {
  answerId: string;
  question: string;
  fullText: string;
  createdAt: string;
  traversalPath: {            // drives Feature 4 animated graph hops
    step: number;
    fromDocId: string | null;
    toDocId: string;
    spanId: string;
    timestampMs: number;
  }[];
  sentences: AnswerSentenceClaim[];
  isStale: boolean;           // true if sentences.some(s => s.stalenessStatus === "outdated")
}
```

---

## C. Top 3 Technical & Rules Risks + Fallbacks

1. **Risk 1 — Heavy PyTorch / Transformer Cold-Start on Free-Tier CPU Hosting (Feature 2):**
   - *Why it happens:* Loading `ModernBERT` in [`KRLabsOrg/LettuceDetect`](https://github.com/KRLabsOrg/LettuceDetect) can exceed 512 MB RAM on constrained free tiers.
   - *Fallback Pick:* Use the 17M-parameter `TinyLettuce` model inside [`KRLabsOrg/LettuceDetect`](https://github.com/KRLabsOrg/LettuceDetect) (`docs/TINYLETTUCE.md`), or fall back to single-pass structured citation prompts from [`anthropics/claude-cookbooks`](https://github.com/anthropics/claude-cookbooks) ([`patterns/agents/prompts/citations_agent.md`](https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/prompts/citations_agent.md)) combined with deterministic exact-substring verification against `SpanAddress.exact`.
2. **Risk 2 — Complete Paragraph Rewrites Breaking Offset Remapping (Feature 1):**
   - *Why it happens:* Character-index remapping via `diff_xIndex` in [`nonoroazoro/diff-match-patch-typescript`](https://github.com/nonoroazoro/diff-match-patch-typescript) shifts offsets accurately for insertions/deletions outside a span, but if an author cuts and moves a paragraph to another section of the document, pure offset diffing treats it as deleted.
   - *Fallback Pick:* Use the fuzzy `TextQuoteSelector` (`{exact, prefix, suffix}`) matcher in [`hypothesis/client`](https://github.com/hypothesis/client) (`src/annotator/anchoring/`) or CRDT `RelativePosition` anchors in [`yjs/yjs`](https://github.com/yjs/yjs) (`createRelativePositionFromTypeIndex` / `createAbsolutePositionFromRelativePosition`) to track moved spans.
3. **Risk 3 — DOM Scroll Desynchronization of SVG Bridges in Side-by-Side View (Feature 4):**
   - *Why it happens:* When scrolling independent document panes, SVG overlay arrows in [`Eliav2/react-xarrows`](https://github.com/Eliav2/react-xarrows) can lag behind the scroll container if updates are not throttled on `onScroll`.
   - *Fallback Pick:* Call the `useXarrow()` hook inside a `requestAnimationFrame`-throttled `onScroll` handler on both document panes, or fall back to [`jacomyal/sigma.js`](https://github.com/jacomyal/sigma.js/) WebGL canvas rendering for all inter-document links.

---

## D. Third-Party Attribution & License Ledger

Include this section in your repository documentation and reference it in your Devpost submission write-up to satisfy the disclosure requirement of the [Kiroween 2026 Official Rules](https://kiroween.devpost.com/rules):

- **`nonoroazoro/diff-match-patch-typescript`** — [https://github.com/nonoroazoro/diff-match-patch-typescript](https://github.com/nonoroazoro/diff-match-patch-typescript)
  - *Author:* Nonoroazoro (TypeScript port of [`google/diff-match-patch`](https://github.com/google/diff-match-patch) by Neil Fraser / Google Inc.)
  - *License:* Apache-2.0
  - *Reused Scope:* `diff_main`, `diff_xIndex`, and `match_main` methods for character-offset remapping and stale-span detection across immutable document versions.
- **`hypothesis/client`** — [https://github.com/hypothesis/client](https://github.com/hypothesis/client) (and [`tilgovi/dom-anchor-text-quote`](https://github.com/tilgovi/dom-anchor-text-quote))
  - *Author:* Hypothes.is Project & Contributors (Randall Leeds, Robert Knight, et al.)
  - *License:* BSD-2-Clause (`hypothesis/client`) / MIT (`dom-anchor-text-quote`)
  - *Reused Scope:* W3C Web Annotation `TextPositionSelector` and `TextQuoteSelector` (`{exact, prefix, suffix}`) anchoring patterns in `src/annotator/anchoring/`.
- **`yjs/yjs`** — [https://github.com/yjs/yjs](https://github.com/yjs/yjs)
  - *Author:* Kevin Jahns (`@dmonad`) & Contributors
  - *License:* MIT
  - *Reused Scope:* Optional CRDT `RelativePosition` (`createRelativePositionFromTypeIndex`, `createAbsolutePositionFromRelativePosition`) and `Snapshot` patterns for edit-surviving span anchors.
- **`KRLabsOrg/LettuceDetect`** — [https://github.com/KRLabsOrg/LettuceDetect](https://github.com/KRLabsOrg/LettuceDetect)
  - *Author:* Ádám Kovács, Gábor Recski, & KRLabsOrg Contributors
  - *License:* MIT
  - *Reused Scope:* `HallucinationDetector.predict(..., output_format="spans")` in `lettucedetect/models/inference.py` and FastAPI wrapper in `lettucedetect_api/` for span-level ghost-claim detection.
- **`Liyan06/MiniCheck`** — [https://github.com/Liyan06/MiniCheck](https://github.com/Liyan06/MiniCheck)
  - *Author:* Liyan Tang, Philippe Laban, Greg Durrett
  - *License:* Apache-2.0
  - *Reused Scope:* Optional sentence-level grounding verification interface (`MiniCheck.score` in `minicheck/minicheck.py`).
- **`anthropics/claude-cookbooks`** — [https://github.com/anthropics/claude-cookbooks](https://github.com/anthropics/claude-cookbooks)
  - *Author:* Anthropic, PBC & Contributors
  - *License:* MIT
  - *Reused Scope:* Citation agent prompt pattern ([`patterns/agents/prompts/citations_agent.md`](https://github.com/anthropics/anthropic-cookbook/blob/main/patterns/agents/prompts/citations_agent.md)) for non-destructive inline span citation tagging.
- **`vasturiano/react-force-graph`** — [https://github.com/vasturiano/react-force-graph](https://github.com/vasturiano/react-force-graph)
  - *Author:* Vasco Asturiano (`@vasturiano`)
  - *License:* MIT
  - *Reused Scope:* `ForceGraph2D` component, `linkDirectionalParticles`, `nodeCanvasObject`, and `emitParticle(link)` API for real-time AI link-traversal animation.
- **`Eliav2/react-xarrows`** — [https://github.com/Eliav2/react-xarrows](https://github.com/Eliav2/react-xarrows)
  - *Author:* Eliav (`@Eliav2`) & Contributors
  - *License:* MIT
  - *Reused Scope:* `Xarrow`, `Xwrapper`, and `useXarrow` hook in `src/` for drawing animated SVG transclusion bridges between DOM `<mark>` spans across side-by-side documents.
- **`jacomyal/sigma.js`** — [https://github.com/jacomyal/sigma.js/](https://github.com/jacomyal/sigma.js/)
  - *Author:* Alexis Jacomy, Benoît Simard, Guillaume Plique (OuestWare & Sciences Po médialab)
  - *License:* MIT
  - *Reused Scope:* Fallback WebGL graph rendering and `nodeReducer`/`edgeReducer` highlighting patterns.
- **`jackyzha0/quartz`** — [https://github.com/jackyzha0/quartz](https://github.com/jackyzha0/quartz) (and [`tscolari/obsidian-graph-mcp`](https://github.com/tscolari/obsidian-graph-mcp))
  - *Author:* Jacky Zhao (`@jackyzha0`) & Contributors; Tiago Scolari (`@tscolari`)
  - *License:* MIT
  - *Reused Scope:* Obsidian Flavored Markdown `[[wikilink]]`, `![[embed]]`, and `#^block-id` regex and backlink graph resolution logic from `quartz/plugins/transformers/ofm.ts` and `internal/vault/parser.go`.
