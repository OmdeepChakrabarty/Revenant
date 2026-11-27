"""
xanadu.py — pure, stateless span and link-graph helpers.

No database, no disk writes: every function here takes the documents and links
that arrived in the POST /ask body and returns plain dicts.
"""
import re
from typing import Any, Dict, Iterable, List, Optional, Tuple

CONTEXT_WINDOW = 32
MAX_HOPS = 2
MAX_SPANS = 6

STOP_WORDS = {
    "the", "a", "an", "and", "or", "but", "if", "of", "to", "in", "on", "at",
    "for", "with", "by", "from", "as", "is", "are", "was", "were", "be", "been",
    "being", "it", "its", "this", "that", "these", "those", "which", "who",
    "whom", "whose", "what", "when", "where", "why", "how", "not", "no", "do",
    "does", "did", "can", "could", "should", "would", "may", "might", "must",
    "will", "shall", "have", "has", "had", "than", "then", "there", "their",
    "they", "them", "he", "she", "his", "her", "we", "our", "you", "your", "i",
    "so", "such", "into", "about", "over", "under", "also", "any", "all", "one",
    "more", "most", "some", "only", "because", "while", "after", "before",
}


# ------------------------------------------------------------------ spans

def make_span(doc_id: str, version: int, content: str, start: int, end: int) -> Dict[str, Any]:
    """Build the canonical half-open span address, clamped to the content."""
    start = max(0, min(int(start), len(content)))
    end = max(start, min(int(end), len(content)))
    return {
        "spanId": f"{doc_id}@v{version}:{start}-{end}",
        "docId": doc_id,
        "docVersionId": f"{doc_id}@v{version}",
        "version": int(version),
        "start": start,
        "end": end,
        "exact": content[start:end],
        "prefix": content[max(0, start - CONTEXT_WINDOW):start],
        "suffix": content[end:end + CONTEXT_WINDOW],
    }


def parse_span_id(span_id: str) -> Optional[Tuple[str, int, int, int]]:
    """Parse `docId@vN:start-end` -> (docId, version, start, end)."""
    match = re.match(r"^(?P<doc>.+)@v(?P<ver>\d+):(?P<start>\d+)-(?P<end>\d+)$", span_id or "")
    if not match:
        return None
    return (
        match.group("doc"),
        int(match.group("ver")),
        int(match.group("start")),
        int(match.group("end")),
    )


def doc_id_of(doc_version_id: str) -> str:
    """`doc@v3` -> `doc`."""
    return (doc_version_id or "").rsplit("@v", 1)[0]


# ---------------------------------------------------------------- text

def split_sentences(text: str) -> List[str]:
    return [chunk.strip() for chunk in re.split(r"(?<=[.!?])\s+", text or "") if chunk.strip()]


def prose_text(text: str) -> str:
    """Drop Markdown heading lines so cited spans quote prose, not `##` noise."""
    lines = [line for line in (text or "").split("\n") if not re.match(r"^\s{0,3}#{1,6}\s", line)]
    return "\n".join(lines)


def content_words(text: str) -> set:
    """Lowercased, stop-word-free content words (>= 3 chars)."""
    words = re.findall(r"[a-z0-9']+", (text or "").lower())
    return {w for w in words if len(w) >= 3 and w not in STOP_WORDS}


def overlap_ratio(sentence: str, cited_text: str) -> float:
    """Share of the sentence's content words that appear in the cited text."""
    words = content_words(sentence)
    if not words:
        return 0.0
    return len(words & content_words(cited_text)) / len(words)


# --------------------------------------------------------- retrieval

def latest_documents(documents: Iterable[Dict[str, Any]]) -> Dict[str, Dict[str, Any]]:
    """Index the request documents by id, keeping the highest version sent."""
    index: Dict[str, Dict[str, Any]] = {}
    for doc in documents or []:
        doc_id = str(doc.get("docId", "")).strip()
        if not doc_id:
            continue
        version = int(doc.get("version", 1) or 1)
        current = index.get(doc_id)
        if current is None or version >= int(current["version"]):
            index[doc_id] = {
                "docId": doc_id,
                "title": str(doc.get("title") or doc_id),
                "version": version,
                "content": str(doc.get("content") or ""),
            }
    return index


def find_start_doc(documents: Dict[str, Dict[str, Any]], question: str) -> Optional[str]:
    """Pick the document whose title/body best matches the question."""
    if not documents:
        return None
    terms = content_words(question)
    best_id: Optional[str] = None
    best_score = -1.0
    for doc_id, doc in documents.items():
        title_words = content_words(doc["title"])
        body_words = content_words(doc["content"])
        score = 3.0 * len(terms & title_words) + 1.0 * len(terms & body_words)
        if score > best_score:
            best_score = score
            best_id = doc_id
    return best_id


def _own_spans(doc: Dict[str, Any], question: str, limit: int = 2) -> List[Dict[str, Any]]:
    """Up to `limit` relevant sentence spans from a single document."""
    terms = content_words(question)
    candidates: List[Tuple[float, int, int]] = []
    cursor = 0
    for sentence in split_sentences(prose_text(doc["content"])):
        start = doc["content"].find(sentence, cursor)
        if start < 0:
            start = doc["content"].find(sentence)
        if start < 0:
            continue
        end = start + len(sentence)
        cursor = end
        score = len(terms & content_words(sentence))
        candidates.append((score, start, end))
    if not candidates:
        return []
    if terms:
        candidates.sort(key=lambda c: (-c[0], c[1]))
    else:
        candidates.sort(key=lambda c: c[1])
    chosen = sorted(candidates[:limit], key=lambda c: c[1])
    return [make_span(doc["docId"], doc["version"], doc["content"], s, e) for _, s, e in chosen]


def walk_graph(
    documents: Dict[str, Dict[str, Any]],
    links: Iterable[Dict[str, Any]],
    start_doc_id: str,
    question: str = "",
    max_hops: int = MAX_HOPS,
    max_spans: int = MAX_SPANS,
) -> List[Dict[str, Any]]:
    """
    Retrieve spans by walking the link graph breadth-first.

    Each returned entry is `{"hop": {step, fromDocId, toDocId, spanId}, "span": SpanAddress}`.
    The first entries are spans read inside the starting document, then every
    traversed link contributes one entry, so a two-document request with one
    link always yields at least two hops.
    """
    start = documents.get(start_doc_id)
    if not start:
        return []

    retrieved: List[Dict[str, Any]] = []
    seen_spans: set = set()

    def add(from_doc: str, span: Dict[str, Any]) -> bool:
        if span["spanId"] in seen_spans or len(retrieved) >= max_spans:
            return False
        seen_spans.add(span["spanId"])
        retrieved.append({
            "hop": {
                "step": len(retrieved) + 1,
                "fromDocId": from_doc,
                "toDocId": span["docId"],
                "spanId": span["spanId"],
            },
            "span": span,
        })
        return True

    for span in _own_spans(start, question):
        add(start_doc_id, span)

    outgoing = list(links or [])
    visited_docs = {start_doc_id}
    frontier = [start_doc_id]
    for depth in range(max_hops):
        next_frontier: List[str] = []
        for from_doc in frontier:
            for link in outgoing:
                from_link_doc = doc_id_of(str(link.get("fromDocVersionId", "")))
                target_doc = doc_id_of(str(link.get("toDocVersionId", "")))
                if from_link_doc != from_doc or target_doc not in documents:
                    continue
                target = documents[target_doc]
                span = make_span(
                    target_doc,
                    target["version"],
                    target["content"],
                    int(link.get("toStart", 0) or 0),
                    int(link.get("toEnd", 0) or 0),
                )
                if add(from_doc, span) and target_doc not in visited_docs:
                    visited_docs.add(target_doc)
                    next_frontier.append(target_doc)
        if not next_frontier or len(retrieved) >= max_spans:
            break
        frontier = next_frontier
        if depth + 1 >= max_hops:
            break

    return retrieved
