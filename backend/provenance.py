"""
provenance.py — the AI Proof Engine (stateless).

Flow: locate a starting document -> walk the link graph -> stream one `hop`
event per retrieved span -> ask the LLM for `<cite>`-tagged claims -> verify
every sentence against the retrieved spans -> stream the answer record.
"""
import os
import re
import uuid
from datetime import datetime, timezone
from typing import Any, AsyncGenerator, Dict, List, Tuple

import httpx

from xanadu import (
    find_start_doc,
    latest_documents,
    overlap_ratio,
    split_sentences,
    walk_graph,
)

MIN_OVERLAP = 0.3
CITE_RE = re.compile(r'<cite\s+span="([^"]+)"\s*>(.*?)</cite>', re.DOTALL)
DEFAULT_MODEL = "gemini-2.5-flash"
GEMINI_ENDPOINT = "https://generativelanguage.googleapis.com/v1beta/models/{model}:generateContent"


def _env(name: str, default: str = "") -> str:
    return (os.getenv(name) or default).strip()


def build_prompt(retrieved: List[Dict[str, Any]], question: str) -> str:
    """Citation-agent prompt pattern: spans wrapped as [SPAN id]...[/SPAN]."""
    blocks = []
    for item in retrieved:
        span = item["span"]
        blocks.append(f'[SPAN {span["spanId"]}]{span["exact"]}[/SPAN]')
    context = "\n".join(blocks) if blocks else "(no spans retrieved)"
    return (
        "You answer questions about a linked document archive.\n\n"
        "Available source spans:\n"
        f"{context}\n\n"
        f"Question: {question}\n\n"
        "Rules:\n"
        "1. Use ONLY the text inside the [SPAN ...] blocks.\n"
        "2. Every factual sentence must carry an inline citation of exactly this form: "
        '<cite span="docId@vN:start-end">wording from that span</cite>, '
        "where docId@vN:start-end is copied verbatim from a [SPAN ...] tag.\n"
        "3. Never cite a span that is not listed above.\n"
        "4. Keep the answer to at most four sentences.\n"
        "5. If the spans do not answer the question, say so without citing anything.\n\n"
        "Answer:"
    )


async def call_llm(prompt: str) -> str:
    """One REST call, no SDK (free-tier Gemini by default)."""
    api_key = _env("LLM_API_KEY")
    if not api_key:
        raise RuntimeError("LLM_API_KEY is not configured")
    model = _env("LLM_MODEL", DEFAULT_MODEL)
    url = GEMINI_ENDPOINT.format(model=model)
    async with httpx.AsyncClient(timeout=25.0) as client:
        response = await client.post(
            url,
            headers={"x-goog-api-key": api_key, "Content-Type": "application/json"},
            json={
                "contents": [{"role": "user", "parts": [{"text": prompt}]}],
                "generationConfig": {"temperature": 0.2, "maxOutputTokens": 512},
            },
        )
    if response.status_code != 200:
        raise RuntimeError(f"LLM error {response.status_code}: {response.text[:200]}")
    payload = response.json()
    candidates = payload.get("candidates") or []
    if not candidates:
        raise RuntimeError("LLM returned no candidates")
    parts = candidates[0].get("content", {}).get("parts") or []
    text = "".join(part.get("text", "") for part in parts).strip()
    if not text:
        raise RuntimeError("LLM returned an empty answer")
    return text


def build_fake_answer(retrieved: List[Dict[str, Any]]) -> str:
    """
    Deterministic LLM_MODE=fake answer: two cited sentences plus one uncited
    (ghost) sentence, so the verifier is always exercised both ways.
    """
    sentences: List[str] = []
    for item in retrieved[:2]:
        span = item["span"]
        quote = split_sentences(span["exact"])[:1]
        if not quote:
            continue
        sentences.append(f'<cite span="{span["spanId"]}">{quote[0]}</cite>')
    if not sentences:
        sentences.append("The archive did not return any usable spans for this question.")
    sentences.append(
        "This proves that every generated sentence is fully grounded, "
        "because a permanent archive can never lose a citation."
    )
    return " ".join(sentences)


def strip_cites(text: str) -> Tuple[str, List[Tuple[str, int, int]]]:
    """Remove <cite> tags, returning clean text and cite positions in that text."""
    clean: List[str] = []
    citations: List[Tuple[str, int, int]] = []
    cursor = 0
    length = 0
    for match in CITE_RE.finditer(text):
        plain = text[cursor:match.start()]
        clean.append(plain)
        length += len(plain)
        inner = match.group(2)
        start = length
        clean.append(inner)
        length += len(inner)
        citations.append((match.group(1), start, length))
        cursor = match.end()
    clean.append(text[cursor:])
    return "".join(clean), citations


def sentence_ranges(text: str) -> List[Tuple[str, int, int]]:
    """Split clean text into (sentence, start, end) with exact offsets."""
    ranges: List[Tuple[str, int, int]] = []
    for match in re.finditer(r"[^.!?]*[.!?]+|[^.!?]+$", text):
        raw = match.group(0)
        stripped = raw.strip()
        if not stripped:
            continue
        offset = match.start() + (len(raw) - len(raw.lstrip()))
        ranges.append((stripped, offset, offset + len(stripped)))
    return ranges


def verify_answer(
    raw_text: str,
    retrieved: List[Dict[str, Any]],
    documents: Dict[str, Dict[str, Any]],
) -> Tuple[str, List[Dict[str, Any]]]:
    """
    GHOST_MODE=simple verification.

    A sentence is supported only when it keeps at least one cite naming a
    retrieved span, that span's exact text still appears verbatim in its
    document, and at least MIN_OVERLAP of the sentence's content words come
    from the cited text. Cites naming unretrieved spans are dropped.
    """
    clean_text, citations = strip_cites(raw_text)
    by_id = {item["span"]["spanId"]: item["span"] for item in retrieved}

    sentences: List[Dict[str, Any]] = []
    for index, (sentence, start, end) in enumerate(sentence_ranges(clean_text)):
        kept_ids: List[str] = []
        for span_id, cite_start, cite_end in citations:
            if cite_start >= end or cite_end <= start:
                continue
            if span_id in by_id and span_id not in kept_ids:
                kept_ids.append(span_id)

        cited_spans = [by_id[span_id] for span_id in kept_ids]
        supported = bool(cited_spans)
        if supported:
            for span in cited_spans:
                source = documents.get(span["docId"])
                if source is None or not span["exact"] or span["exact"] not in source["content"]:
                    supported = False
                    break
        if supported:
            best = max(overlap_ratio(sentence, span["exact"]) for span in cited_spans)
            supported = best >= MIN_OVERLAP

        sentences.append({
            "sentenceIndex": index,
            "text": sentence,
            "answerStart": start,
            "answerEnd": end,
            "citedSpans": cited_spans,
            "groundingStatus": "supported" if supported else "unsupported",
            "hallucinationConfidence": 0.0 if supported else 1.0,
            "stalenessStatus": "fresh",
        })

    return clean_text, sentences


def _now() -> str:
    return datetime.now(timezone.utc).isoformat().replace("+00:00", "Z")


async def generate_answer(
    question: str,
    documents_payload: List[Dict[str, Any]],
    links: List[Dict[str, Any]],
) -> AsyncGenerator[Dict[str, Any], None]:
    """Yield `hop` events, then one `answer` event, or one `error` event."""
    documents = latest_documents(documents_payload)
    if not documents:
        yield {"type": "error", "message": "No documents were supplied in the request body."}
        return

    question = (question or "").strip()
    if not question:
        yield {"type": "error", "message": "The question was empty."}
        return

    start_doc_id = find_start_doc(documents, question)
    if not start_doc_id:
        yield {"type": "error", "message": "No starting document could be selected."}
        return

    retrieved = walk_graph(documents, links, start_doc_id, question)
    if not retrieved:
        yield {"type": "error", "message": f"Document {start_doc_id} has no readable spans."}
        return

    traversal: List[Dict[str, Any]] = []
    for item in retrieved:
        hop = item["hop"]
        traversal.append(hop)
        yield {"type": "hop", "hop": hop}

    mode = _env("LLM_MODE", "live").lower()
    try:
        if mode == "fake" or not _env("LLM_API_KEY"):
            if mode != "fake":
                yield {
                    "type": "error",
                    "message": "LLM_API_KEY is not set. Set LLM_MODE=fake for the offline demo.",
                }
                return
            raw_text = build_fake_answer(retrieved)
        else:
            raw_text = await call_llm(build_prompt(retrieved, question))
    except Exception as exc:  # noqa: BLE001 — surfaced to the client as an SSE error
        yield {"type": "error", "message": str(exc)}
        return

    full_text, sentences = verify_answer(raw_text, retrieved, documents)
    if not sentences:
        yield {"type": "error", "message": "The model returned no verifiable sentences."}
        return

    answer = {
        "answerId": f"ans_{uuid.uuid4().hex[:12]}",
        "question": question,
        "fullText": full_text,
        "traversal": traversal,
        "sentences": sentences,
        "createdAt": _now(),
    }
    yield {"type": "answer", "answer": answer}
