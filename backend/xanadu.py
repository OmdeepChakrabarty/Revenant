"""
Xanadu Core: Immutable document store, span slicing, link graph, Obsidian import.
"""
import sqlite3
import hashlib
import re
from typing import List, Dict, Optional, Any
from dataclasses import dataclass, asdict

DB_PATH = "xanadu.db"

@dataclass
class DocumentRecord:
    doc_id: str
    title: str
    latest_version: int
    created_at: str

@dataclass
class DocumentVersion:
    doc_version_id: str
    doc_id: str
    version: int
    content: str
    content_hash: str
    parent_version_id: Optional[str]
    created_at: str

@dataclass
class SpanAddress:
    span_id: str
    doc_id: str
    doc_version_id: str
    version: int
    start: int
    end: int
    exact: str

@dataclass
class SpanLink:
    link_id: str
    link_type: str
    from_doc_version_id: str
    from_start: int
    from_end: int
    to_doc_version_id: str
    to_start: int
    to_end: int
    exact_quote: str

def init_db(conn: sqlite3.Connection):
    """Create tables if they don't exist."""
    conn.executescript("""
        CREATE TABLE IF NOT EXISTS documents (
            doc_id TEXT PRIMARY KEY,
            title TEXT NOT NULL,
            latest_version INTEGER NOT NULL DEFAULT 1,
            created_at TEXT NOT NULL
        );
        CREATE TABLE IF NOT EXISTS document_versions (
            doc_version_id TEXT PRIMARY KEY,
            doc_id TEXT NOT NULL,
            version INTEGER NOT NULL,
            content TEXT NOT NULL,
            content_hash TEXT NOT NULL,
            parent_version_id TEXT,
            created_at TEXT NOT NULL,
            FOREIGN KEY (doc_id) REFERENCES documents(doc_id)
        );
        CREATE TABLE IF NOT EXISTS span_links (
            link_id TEXT PRIMARY KEY,
            link_type TEXT NOT NULL,
            from_doc_version_id TEXT NOT NULL,
            from_start INTEGER NOT NULL,
            from_end INTEGER NOT NULL,
            to_doc_version_id TEXT NOT NULL,
            to_start INTEGER NOT NULL,
            to_end INTEGER NOT NULL,
            exact_quote TEXT NOT NULL,
            FOREIGN KEY (from_doc_version_id) REFERENCES document_versions(doc_version_id),
            FOREIGN KEY (to_doc_version_id) REFERENCES document_versions(doc_version_id)
        );
        CREATE TABLE IF NOT EXISTS ai_answers (
            answer_id TEXT PRIMARY KEY,
            question TEXT NOT NULL,
            full_text TEXT NOT NULL,
            traversal_json TEXT NOT NULL,
            sentences_json TEXT NOT NULL,
            created_at TEXT NOT NULL
        );
    """)
    conn.commit()

def _sha256(content: str) -> str:
    return hashlib.sha256(content.encode("utf-8")).hexdigest()

def _now() -> str:
    from datetime import datetime
    return datetime.utcnow().isoformat() + "Z"

def create_document(conn: sqlite3.Connection, title: str, content: str) -> str:
    """Create a new document with version 1."""
    doc_id = f"doc_{title.lower().replace(' ', '_')}"
    doc_version_id = f"{doc_id}@v1"
    content_hash = _sha256(content)
    created_at = _now()
    
    conn.execute(
        "INSERT INTO documents (doc_id, title, latest_version, created_at) VALUES (?, ?, 1, ?)",
        (doc_id, title, created_at)
    )
    conn.execute(
        "INSERT INTO document_versions (doc_version_id, doc_id, version, content, content_hash, parent_version_id, created_at) VALUES (?, ?, 1, ?, ?, NULL, ?)",
        (doc_version_id, doc_id, content, content_hash, created_at)
    )
    conn.commit()
    return doc_id

def edit_document(conn: sqlite3.Connection, doc_id: str, new_content: str) -> str:
    """Append new version (never overwrite). Returns new doc_version_id."""
    cur = conn.execute("SELECT latest_version FROM documents WHERE doc_id = ?", (doc_id,))
    row = cur.fetchone()
    if not row:
        raise ValueError(f"Document {doc_id} not found")
    new_version = row[0] + 1
    doc_version_id = f"{doc_id}@v{new_version}"
    content_hash = _sha256(new_content)
    parent_version_id = f"{doc_id}@v{row[0]}"
    created_at = _now()
    
    conn.execute(
        "UPDATE documents SET latest_version = ? WHERE doc_id = ?",
        (new_version, doc_id)
    )
    conn.execute(
        "INSERT INTO document_versions (doc_version_id, doc_id, version, content, content_hash, parent_version_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)",
        (doc_version_id, doc_id, new_version, new_content, content_hash, parent_version_id, created_at)
    )
    conn.commit()
    return doc_version_id

def get_document(conn: sqlite3.Connection, doc_id: str) -> Optional[DocumentRecord]:
    """Get latest document record."""
    cur = conn.execute("SELECT doc_id, title, latest_version, created_at FROM documents WHERE doc_id = ?", (doc_id,))
    row = cur.fetchone()
    if not row:
        return None
    return DocumentRecord(doc_id=row[0], title=row[1], latest_version=row[2], created_at=row[3])

def get_all_documents(conn: sqlite3.Connection) -> List[DocumentRecord]:
    """List all documents."""
    cur = conn.execute("SELECT doc_id, title, latest_version, created_at FROM documents")
    return [DocumentRecord(doc_id=r[0], title=r[1], latest_version=r[2], created_at=r[3]) for r in cur.fetchall()]

def get_version(conn: sqlite3.Connection, doc_version_id: str) -> Optional[DocumentVersion]:
    """Get a specific version."""
    cur = conn.execute("SELECT doc_version_id, doc_id, version, content, content_hash, parent_version_id, created_at FROM document_versions WHERE doc_version_id = ?", (doc_version_id,))
    row = cur.fetchone()
    if not row:
        return None
    return DocumentVersion(doc_version_id=row[0], doc_id=row[1], version=row[2], content=row[3], content_hash=row[4], parent_version_id=row[5], created_at=row[6])

def get_latest_version(conn: sqlite3.Connection, doc_id: str) -> Optional[DocumentVersion]:
    """Get the latest version of a document."""
    doc = get_document(conn, doc_id)
    if not doc:
        return None
    return get_version(conn, f"{doc_id}@v{doc.latest_version}")

def slice_span(conn: sqlite3.Connection, doc_version_id: str, start: int, end: int) -> SpanAddress:
    """Create a span address from a document version."""
    ver = get_version(conn, doc_version_id)
    if not ver:
        raise ValueError(f"Version {doc_version_id} not found")
    # Parse doc_id and version from doc_version_id
    doc_id, version_str = doc_version_id.rsplit("@v", 1)
    version = int(version_str)
    exact = ver.content[start:end]
    return SpanAddress(
        span_id=f"{doc_id}@v{version}:{start}-{end}",
        doc_id=doc_id,
        doc_version_id=doc_version_id,
        version=version,
        start=start,
        end=end,
        exact=exact
    )

def _parse_wikilinks(content: str, doc_id: str, doc_version_id: str) -> List[Dict]:
    """Parse [[DocName]] style links from content."""
    # Match [[Title]] or [[Title#Heading]]
    pattern = r'\[\[([^\]|]+)(?:#([^\]|]+))?\]\]'
    links = []
    for match in re.finditer(pattern, content):
        target_title = match.group(1).strip()
        links.append({
            "target_title": target_title,
            "start": match.start(),
            "end": match.end()
        })
    return links

def _create_span_link(conn: sqlite3.Connection, from_doc_version_id: str, from_start: int, from_end: int, to_doc_version_id: str, to_start: int, to_end: int, exact_quote: str):
    """Insert a span link."""
    from_doc_id, from_v = from_doc_version_id.rsplit("@v", 1)
    to_doc_id, to_v = to_doc_version_id.rsplit("@v", 1)
    link_id = f"link_{from_doc_id}_{from_start}_{to_doc_id}_{to_start}"
    conn.execute(
        "INSERT OR IGNORE INTO span_links (link_id, link_type, from_doc_version_id, from_start, from_end, to_doc_version_id, to_start, to_end, exact_quote) VALUES (?, 'transclusion', ?, ?, ?, ?, ?, ?, ?)",
        (link_id, from_doc_version_id, from_start, from_end, to_doc_version_id, to_start, to_end, exact_quote)
    )

def get_graph(conn: sqlite3.Connection) -> Dict[str, Any]:
    """Return nodes and links for ForceGraph2D."""
    docs = get_all_documents(conn)
    nodes = [{"id": d.doc_id, "label": d.title} for d in docs]
    
    links = []
    cur = conn.execute("SELECT link_id, from_doc_version_id, from_start, from_end, to_doc_version_id, to_start, to_end, exact_quote FROM span_links")
    for row in cur.fetchall():
        from_doc_version_id = row["from_doc_version_id"]
        to_doc_version_id = row["to_doc_version_id"]
        from_doc_id = from_doc_version_id.rsplit("@v", 1)[0]
        to_doc_id = to_doc_version_id.rsplit("@v", 1)[0]
        links.append({
            "source": from_doc_id,
            "target": to_doc_id,
            "label": "transclusion"
        })
    return {"nodes": nodes, "links": links}

def walk_graph(conn: sqlite3.Connection, start_doc_id: str, max_hops: int = 2, max_spans: int = 10) -> List[SpanAddress]:
    """BFS traversal from start_doc_id, returning up to max_spans."""
    visited = set()
    queue = [(start_doc_id, 0)]
    spans = []
    
    while queue and len(spans) < max_spans:
        doc_id, hop = queue.pop(0)
        if doc_id in visited or hop > max_hops:
            continue
        visited.add(doc_id)
        
        # Get all links from this doc
        cur = conn.execute(
            "SELECT to_doc_version_id, to_start, to_end FROM span_links sl JOIN document_versions dv ON sl.from_doc_version_id = dv.doc_version_id WHERE dv.doc_id = ?",
            (doc_id,)
        )
        for row in cur.fetchall():
            to_doc_version_id = row[0]
            to_start = row[1]
            to_end = row[2]
            span = slice_span(conn, to_doc_version_id, to_start, to_end)
            spans.append(span)
            
            to_doc_id = to_doc_version_id.rsplit("@v", 1)[0]
            if to_doc_id not in visited and hop + 1 <= max_hops:
                queue.append((to_doc_id, hop + 1))
    
    return spans

def seed_documents(conn: sqlite3.Connection):
    """Seed 5 linked sample documents."""
    docs = [
        ("Xanadu Overview", "Xanadu is a hypermedia system invented by Ted Nelson in 1981. It enables [[Link Types]] through transclusion. See [[Nelson 1981 Paper]] for original design."),
        ("Nelson 1981 Paper", "The 1981 paper describes [[Xanadu Overview]] as a system for non-sequential writing. It introduces the concept of [[Hypertext Definition]]."),
        ("Hypertext Definition", "Hypertext is text displayed on a computer or other electronic device with references (hyperlinks) to other text that the reader can immediately access. See [[Modern Web Critique]]."),
        ("Modern Web Critique", "The modern web diverges from [[Nelson 1981 Paper]] ideals. Links are one-way, not bidirectional like in [[Link Types]]."),
        ("Link Types", "Xanadu supports transclusion, wikilinks, block references, and citations. Each link type enables different [[Hypertext Definition]] patterns.")
    ]
    
    for title, content in docs:
        doc_id = create_document(conn, title, content)
    
    # Parse wikilinks and create span_links
    all_docs = {d.title: d.doc_id for d in get_all_documents(conn)}
    
    for doc in get_all_documents(conn):
        ver = get_latest_version(conn, doc.doc_id)
        if not ver:
            continue
        wikilinks = _parse_wikilinks(ver.content, doc.doc_id, ver.doc_version_id)
        
        for wl in wikilinks:
            target_title = wl["target_title"]
            if target_title in all_docs:
                target_doc_id = all_docs[target_title]
                target_ver = get_latest_version(conn, target_doc_id)
                if target_ver:
                    # Link to first 50 chars of target content as the "span"
                    to_start = 0
                    to_end = min(50, len(target_ver.content))
                    exact = target_ver.content[to_start:to_end]
                    _create_span_link(
                        conn, ver.doc_version_id, wl["start"], wl["end"],
                        target_ver.doc_version_id, to_start, to_end,
                        exact
                    )
    
    conn.commit()

def get_connection() -> sqlite3.Connection:
    """Get a database connection."""
    conn = sqlite3.connect(DB_PATH)
    conn.row_factory = sqlite3.Row
    return conn