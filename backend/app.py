"""
FastAPI server for Xanadu: 5 endpoints, CORS, auto-seed.
"""
import os
import json
from datetime import datetime
from typing import List, Optional

from fastapi import FastAPI, HTTPException, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import StreamingResponse
from pydantic import BaseModel

from xanadu import (
    init_db, get_all_documents, get_latest_version, get_version,
    edit_document, get_graph, get_connection, seed_documents, DocumentRecord
)

# Load environment
from dotenv import load_dotenv
load_dotenv()

ALLOWED_ORIGIN = os.getenv("ALLOWED_ORIGIN", "http://localhost:5173")
GEMINI_API_KEY = os.getenv("GEMINI_API_KEY", "")

app = FastAPI(title="Xanadu API", docs_url=None, redoc_url=None)

# CORS
app.add_middleware(
    CORSMiddleware,
    allow_origins=[ALLOWED_ORIGIN],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

# Pydantic models
class EditRequest(BaseModel):
    content: str

class AskRequest(BaseModel):
    question: str

class DocumentResponse(BaseModel):
    docId: str
    title: str
    latestVersion: int
    createdAt: str

class VersionResponse(BaseModel):
    docVersionId: str
    docId: str
    version: int
    content: str
    contentHash: str
    parentVersionId: Optional[str]
    createdAt: str

class GraphResponse(BaseModel):
    nodes: List[dict]
    links: List[dict]

def _doc_to_response(doc: DocumentRecord) -> DocumentResponse:
    return DocumentResponse(
        docId=doc.doc_id,
        title=doc.title,
        latestVersion=doc.latest_version,
        createdAt=doc.created_at
    )

def _ver_to_response(ver) -> VersionResponse:
    return VersionResponse(
        docVersionId=ver.doc_version_id,
        docId=ver.doc_id,
        version=ver.version,
        content=ver.content,
        contentHash=ver.content_hash,
        parentVersionId=ver.parent_version_id,
        createdAt=ver.created_at
    )

@app.on_event("startup")
async def startup():
    """Initialize DB and seed sample documents."""
    conn = get_connection()
    init_db(conn)
    # Check if already seeded
    cur = conn.execute("SELECT COUNT(*) FROM documents")
    if cur.fetchone()[0] == 0:
        seed_documents(conn)
    conn.close()

@app.get("/documents", response_model=List[DocumentResponse])
async def list_documents():
    """List all documents with latest version content."""
    conn = get_connection()
    try:
        docs = get_all_documents(conn)
        return [_doc_to_response(d) for d in docs]
    finally:
        conn.close()

@app.get("/documents/{doc_id}/versions")
async def get_doc_versions(doc_id: str):
    """Get all versions of a document."""
    conn = get_connection()
    try:
        cur = conn.execute(
            "SELECT doc_version_id, doc_id, version, content, content_hash, parent_version_id, created_at FROM document_versions WHERE doc_id = ? ORDER BY version",
            (doc_id,)
        )
        versions = [dict(row) for row in cur.fetchall()]
        return {"docId": doc_id, "versions": versions}
    finally:
        conn.close()

@app.post("/documents/{doc_id}/edit", response_model=VersionResponse)
async def edit_doc(doc_id: str, req: EditRequest):
    """Append a new version (v+1) - never overwrite."""
    conn = get_connection()
    try:
        doc_version_id = edit_document(conn, doc_id, req.content)
        ver = get_version(conn, doc_version_id)
        if not ver:
            raise HTTPException(status_code=500, detail="Failed to create version")
        return _ver_to_response(ver)
    finally:
        conn.close()

@app.get("/graph", response_model=GraphResponse)
async def get_graph_data():
    """Return nodes and links for ForceGraph2D."""
    conn = get_connection()
    try:
        return get_graph(conn)
    finally:
        conn.close()

# Provenance imports (will be added in Step 2)
from provenance import generate_answer

@app.post("/ask")
async def ask_question(req: AskRequest):
    """Stream AI answer with SSE."""
    if not GEMINI_API_KEY or GEMINI_API_KEY == "your-key-here":
        async def error_stream():
            yield f"event: error\ndata: {json.dumps({'error': 'GEMINI_API_KEY missing or not configured'})}\n\n"
        return StreamingResponse(error_stream(), media_type="text/event-stream")
    
    conn = get_connection()
    try:
        async def event_stream():
            async for event in generate_answer(conn, req.question):
                if event.get("type") == "hop":
                    yield f"event: hop\ndata: {json.dumps(event)}\n\n"
                elif event.get("type") == "answer":
                    yield f"event: answer\ndata: {json.dumps(event['data'])}\n\n"
                elif event.get("type") == "error":
                    yield f"event: error\ndata: {json.dumps({'error': event.get('error')})}\n\n"
        return StreamingResponse(event_stream(), media_type="text/event-stream")
    finally:
        conn.close()

@app.get("/answers/{answer_id}")
async def get_answer(answer_id: str):
    """Get a saved answer."""
    conn = get_connection()
    try:
        cur = conn.execute(
            "SELECT answer_id, question, full_text, traversal_json, sentences_json, created_at FROM ai_answers WHERE answer_id = ?",
            (answer_id,)
        )
        row = cur.fetchone()
        if not row:
            raise HTTPException(status_code=404, detail="Answer not found")
        return {
            "answerId": row[0],
            "question": row[1],
            "fullText": row[2],
            "traversalPath": json.loads(row[3]),
            "sentences": json.loads(row[4]),
            "createdAt": row[5]
        }
    finally:
        conn.close()