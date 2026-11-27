"""
app.py — stateless FastAPI server for Project Xanadu Resurrection.

Exactly two endpoints:
  POST /ask    -> text/event-stream: `hop` events, then one `answer` (or `error`)
  GET  /health -> {"ok": true}

No database, no disk writes. All state lives in the browser.
"""
import json
import os
from typing import List

from fastapi import FastAPI
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel, Field

from provenance import generate_answer


def _allowed_origins() -> List[str]:
    raw = (os.getenv("ALLOWED_ORIGIN") or "http://localhost:5173").strip()
    origins = [origin.strip() for origin in raw.split(",") if origin.strip()]
    return origins or ["http://localhost:5173"]


app = FastAPI(title="Xanadu Resurrection API", docs_url=None, redoc_url=None)

app.add_middleware(
    CORSMiddleware,
    allow_origins=_allowed_origins(),
    allow_credentials=False,
    allow_methods=["GET", "POST", "OPTIONS"],
    allow_headers=["*"],
)


# ----------------------------------------------------------- models

class SpanAddressModel(BaseModel):
    spanId: str
    docId: str
    docVersionId: str
    version: int
    start: int
    end: int
    exact: str
    prefix: str = ""
    suffix: str = ""


class SpanLinkModel(BaseModel):
    linkId: str
    linkType: str = "transclusion"
    fromDocVersionId: str
    fromStart: int
    fromEnd: int
    toDocVersionId: str
    toStart: int
    toEnd: int
    exactQuote: str = ""
    prefix: str = ""
    suffix: str = ""


class AskDocumentModel(BaseModel):
    docId: str
    title: str = ""
    version: int = 1
    content: str = ""


class AskRequest(BaseModel):
    question: str = ""
    documents: List[AskDocumentModel] = Field(default_factory=list)
    links: List[SpanLinkModel] = Field(default_factory=list)


class TraversalHopModel(BaseModel):
    step: int
    fromDocId: str
    toDocId: str
    spanId: str


class AnswerSentenceClaimModel(BaseModel):
    sentenceIndex: int
    text: str
    answerStart: int
    answerEnd: int
    citedSpans: List[SpanAddressModel]
    groundingStatus: str
    hallucinationConfidence: float
    stalenessStatus: str


class AIAnswerRecordModel(BaseModel):
    answerId: str
    question: str
    fullText: str
    traversal: List[TraversalHopModel]
    sentences: List[AnswerSentenceClaimModel]
    createdAt: str


# ----------------------------------------------------------- routes

def _sse(event: str, data: dict) -> str:
    return f"event: {event}\ndata: {json.dumps(data)}\n\n"


@app.get("/health")
async def health() -> dict:
    return {"ok": True}


@app.post("/ask")
async def ask(request: AskRequest) -> StreamingResponse:
    documents = [doc.model_dump() for doc in request.documents]
    links = [link.model_dump() for link in request.links]

    async def event_stream():
        try:
            async for event in generate_answer(request.question, documents, links):
                kind = event.get("type")
                if kind == "hop":
                    yield _sse("hop", event["hop"])
                elif kind == "answer":
                    answer = AIAnswerRecordModel.model_validate(event["answer"]).model_dump()
                    yield _sse("answer", answer)
                elif kind == "error":
                    yield _sse("error", {"message": event.get("message", "Unknown error")})
        except Exception as exc:  # noqa: BLE001 — never leave the client hanging
            yield _sse("error", {"message": f"Server error: {exc}"})

    return StreamingResponse(
        event_stream(),
        media_type="text/event-stream",
        headers={
            "Cache-Control": "no-cache",
            "Connection": "keep-alive",
            "X-Accel-Buffering": "no",
        },
    )
