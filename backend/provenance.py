"""
AI Citation Engine: Graph retrieval, LLM prompting, Ghost Check.
"""
import os
import json
import re
import asyncio
from typing import List, Dict, AsyncGenerator, Any

import httpx
from xanadu import get_latest_version, get_all_documents, get_connection, walk_graph, get_version

# Configuration
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")
GEMINI_URL = "https://generativelanguage.googleapis.com/v1beta/models/gemini-2.5-flash:generateContent"

BFS_LIMIT = 2
MAX_SPANS = 10
MIN_OVERLAP = 5

async def generate_answer(conn, question: str) -> AsyncGenerator[Dict[str, Any], None]:
    """Main entry: BFS retrieval, prompt LLM, verify citations, yield SSE events."""
    # Step 1: Find best starting document (title match)
    docs = get_all_documents(conn)
    best_doc = None
    best_score = -1
    q_lower = question.lower()
    for d in docs:
        score = 0
        if d.title.lower() in q_lower:
            score = 10
        elif any(w in d.title.lower() for w in q_lower.split()):
            score = 5
        if score > best_score:
            best_score = score
            best_doc = d
    
    if not best_doc:
        yield {"type": "error", "error": "No matching document found"}
        return
    
    # Step 2: BFS retrieval
    spans = walk_graph(conn, best_doc.doc_id, max_hops=BFS_LIMIT, max_spans=MAX_SPANS)
    
    # Step 3: Emit hop events
    for i, span in enumerate(spans[:5]):  # Emit up to 5 hops
        yield {
            "type": "hop",
            "step": i + 1,
            "fromDocId": best_doc.doc_id,
            "toDocId": span.doc_id,
            "spanId": span.span_id
        }
    
    # Step 4: Build prompt
    prompt = build_prompt(spans, question)
    
    # Step 5: Call LLM
    try:
        llm_text = await call_llm(prompt)
    except Exception as e:
        yield {"type": "error", "error": f"LLM call failed: {str(e)}"}
        return
    
    # Step 6: Parse citations and verify
    parsed = parse_citations(llm_text)
    sentences = verify_sentences(parsed, spans, llm_text)
    
    # Step 7: Build answer record
    answer_id = f"ans_{best_doc.doc_id}_{int(asyncio.get_event_loop().time() * 1000)}"
    answer = {
        "answerId": answer_id,
        "question": question,
        "fullText": llm_text,
        "traversalPath": [
            {"step": i + 1, "fromDocId": best_doc.doc_id, "toDocId": s.doc_id, "spanId": s.span_id}
            for i, s in enumerate(spans[:5])
        ],
        "sentences": sentences,
        "isStale": any(s.get("stalenessStatus") == "outdated" for s in sentences)
    }
    
    yield {"type": "answer", "data": answer}

def build_prompt(spans, question: str) -> str:
    """Wrap spans in [SPAN ...] and instruct LLM to cite."""
    span_blocks = []
    for s in spans:
        span_blocks.append(f"[SPAN {s.span_id}]{s.exact}[/SPAN]")
    
    prompt = f"""You are a helpful assistant answering questions about a linked document system.

Available context spans:
{chr(10).join(span_blocks)}

Question: {question}

Instructions:
- Answer based ONLY on the provided context spans.
- Cite each claim using <cite span="spanId">claim text</cite> where spanId is from [SPAN ...] tags.
- If you cannot answer from the context, say so honestly.

Answer:"""
    return prompt

def parse_citations(text: str) -> List[Dict]:
    """Find all <cite> tags, strip them to clean text, split sentences, attach spanIds."""
    # Find all <cite span="...">...</cite> intervals
    cite_pattern = re.compile(r'<cite span="([^"]+)">(.*?)</cite>', re.DOTALL)
    citations = []
    for match in cite_pattern.finditer(text):
        span_id = match.group(1)
        claim_text = match.group(2)
        citations.append({
            "spanId": span_id,
            "claimText": claim_text,
            "start": match.start(),
            "end": match.end()
        })
    
    # Strip <cite> tags to get clean text
    clean_text = cite_pattern.sub(r'\2', text)
    
    # Split into sentences
    sentence_pattern = re.compile(r'(?<=[.!?])\s+')
    sentences = sentence_pattern.split(clean_text)
    
    # Attach spanIds to sentences based on overlapping positions
    result = []
    for i, sent in enumerate(sentences):
        # Find citations that fall within this sentence's character range in clean_text
        sent_start_in_clean = clean_text.find(sent)
        if sent_start_in_clean == -1:
            continue
        sent_end_in_clean = sent_start_in_clean + len(sent)
        
        attached_spans = []
        for c in citations:
            # The citation claim text position in original
            claim_pos = text.find(c["claimText"])
            if claim_pos != -1:
                # Check if overlap with sentence
                if sent_start_in_clean <= claim_pos < sent_end_in_clean:
                    attached_spans.append(c["spanId"])
        
        result.append({
            "sentenceIndex": i,
            "text": sent.strip(),
            "citedSpans": attached_spans
        })
    
    return result

def verify_sentences(parsed: List[Dict], spans, full_text: str) -> List[Dict]:
    """Check each sentence: has citation? overlaps hallucinated span?"""
    # Build span_id -> exact text map
    span_map = {s.span_id: s.exact for s in spans}
    
    # Try to use LettuceDetect if available
    detector = None
    try:
        from lettucedetect import HallucinationDetector
        detector = HallucinationDetector()
    except ImportError:
        pass
    
    # Simple ghost check: no cited span = unsupported
    results = []
    for p in parsed:
        grounding_status = "supported"
        hallucination_confidence = 0.0
        
        if not p["citedSpans"]:
            grounding_status = "unsupported"
            hallucination_confidence = 1.0
        else:
            # Check all cited spans exist
            if not all(sid in span_map for sid in p["citedSpans"]):
                grounding_status = "unsupported"
                hallucination_confidence = 0.8
            elif detector:
                # Try LettuceDetect
                try:
                    cited_texts = [span_map.get(sid, "") for sid in p["citedSpans"]]
                    result = detector.predict(
                        context=" ".join(cited_texts),
                        question="",
                        answer=p["text"],
                        output_format="spans"
                    )
                    if result and result.get("hallucination_confidence", 0) >= 0.5:
                        grounding_status = "unsupported"
                        hallucination_confidence = result["hallucination_confidence"]
                except Exception:
                    pass  # Fallback to citation-only check
        
        results.append({
            "sentenceIndex": p["sentenceIndex"],
            "text": p["text"],
            "answerStart": 0,
            "answerEnd": len(p["text"]),
            "citedSpans": [{"spanId": sid} for sid in p["citedSpans"]],
            "groundingStatus": grounding_status,
            "hallucinationConfidence": hallucination_confidence,
            "stalenessStatus": "fresh"
        })
    
    return results

async def call_llm(prompt: str) -> str:
    """Call Gemini API."""
    if not GEMINI_API_KEY or GEMINI_API_KEY == "your-key-here":
        raise ValueError("GEMINI_API_KEY not configured")
    
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{GEMINI_URL}?key={GEMINI_API_KEY}",
            json={
                "contents": [{"parts": [{"text": prompt}]}],
                "generationConfig": {
                    "temperature": 0.7,
                    "maxOutputTokens": 1024
                }
            },
            timeout=30.0
        )
        if resp.status_code != 200:
            raise Exception(f"Gemini API error: {resp.status_code} {resp.text}")
        
        data = resp.json()
        return data["candidates"][0]["content"]["parts"][0]["text"]