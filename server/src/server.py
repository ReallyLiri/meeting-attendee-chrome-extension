import os
import shutil
import tempfile
import logging
import server.src.logging as _
from fastapi import FastAPI, UploadFile, File, Header, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from uuid import uuid4
from datetime import datetime
import uvicorn
from server.src.model_audio import transcribe_and_write_json

WORKING_DIR = os.environ.get("WORKING_DIR", "./data")
OUTPUT_DIR = os.environ.get("OUTPUT_DIR", "./output")
PORT = int(os.environ.get("PORT", 8017))

os.makedirs(WORKING_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

sessions = {}
app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


def _normalize_title(title: str) -> str:
    return "".join(
        c if c.isalnum() or c in ("-", "_") else "_"
        for c in title.strip().replace(" ", "_")
    )


def _timestamp_str():
    return datetime.now().strftime("%Y.%m.%d.%H.%M")


def _get_ext_from_mime(mime: str) -> str:
    import mimetypes

    ext = mimetypes.guess_extension(mime)
    if ext:
        return ext.lstrip(".")
    if mime == "audio/webm":
        return "webm"
    if mime == "audio/ogg":
        return "ogg"
    if mime == "audio/mp4":
        return "mp4"
    if mime == "image/png":
        return "png"
    if mime == "image/jpeg":
        return "jpg"
    raise HTTPException(
        status_code=400, detail=f"Unknown or unsupported MIME type: {mime}"
    )


class SessionStartRequest(BaseModel):
    title: str


@app.post("/sessions/start")
def start_session(req: SessionStartRequest):
    if not req.title:
        raise HTTPException(status_code=400, detail="Session title required")
    session_id = str(uuid4())
    norm_title = _normalize_title(req.title)
    sessions[session_id] = {
        "title": req.title,
        "norm_title": norm_title,
        "chunks": [],
        "screenshots": [],
    }
    logging.info(f"Started session {session_id} with title '{req.title}'")
    return {"session_id": session_id}


@app.post("/sessions/{session_id}/chunk")
def upload_chunk(
    session_id: str,
    file: UploadFile = File(...),
    mime_type: Optional[str] = Header(None),
):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    if not mime_type:
        raise HTTPException(status_code=400, detail="mime_type header required")
    ext = _get_ext_from_mime(mime_type)
    ts = _timestamp_str()
    norm_title = sessions[session_id]["norm_title"]
    fname = f"{norm_title}_{ts}.{ext}"
    fpath = os.path.join(WORKING_DIR, fname)
    with open(fpath, "wb") as out:
        shutil.copyfileobj(file.file, out)
    sessions[session_id]["chunks"].append(fpath)
    logging.info(f"Received chunk for session {session_id}: {fpath}")
    return {"status": "ok", "path": fname}


@app.post("/sessions/{session_id}/screenshot")
def upload_screenshot(
    session_id: str,
    file: UploadFile = File(...),
    mime_type: Optional[str] = Header(None),
):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    if not mime_type:
        raise HTTPException(status_code=400, detail="mime_type header required")
    ext = _get_ext_from_mime(mime_type)
    ts = _timestamp_str()
    norm_title = sessions[session_id]["norm_title"]
    fname = f"{norm_title}_{ts}.{ext}"
    fpath = os.path.join(WORKING_DIR, fname)
    with open(fpath, "wb") as out:
        shutil.copyfileobj(file.file, out)
    sessions[session_id]["screenshots"].append(fpath)
    logging.info(f"Received screenshot for session {session_id}: {fpath}")
    return {"status": "ok", "path": fname}


@app.post("/sessions/{session_id}/end")
def end_session(session_id: str, background_tasks: BackgroundTasks):
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = sessions[session_id]
    chunk_dir = tempfile.mkdtemp(dir=WORKING_DIR)
    for chunk_path in session["chunks"]:
        shutil.copy(chunk_path, chunk_dir)
    out_path = os.path.join(
        OUTPUT_DIR, f"{session['norm_title']}_{_timestamp_str()}.json"
    )
    background_tasks.add_task(
        transcribe_session_task, chunk_dir, out_path, session["chunks"]
    )
    logging.info(f"Session {session_id} ended. Transcription task dispatched.")
    return {"status": "ok", "output": out_path}


def transcribe_session_task(chunk_dir, out_path, chunk_files):
    try:
        transcribe_and_write_json(chunk_dir, out_path)
        logging.info(f"Transcription written to {out_path}")
        for f in chunk_files:
            try:
                os.remove(f)
                logging.info(f"Deleted chunk file {f}")
            except Exception as e:
                logging.warning(f"Failed to delete chunk file {f}: {e}")
        shutil.rmtree(chunk_dir)
    except Exception as e:
        logging.error(f"Transcription task failed: {e}")


if __name__ == "__main__":
    logging.info(f"Starting FastAPI server on port {PORT}")
    uvicorn.run("server.src.server:app", host="0.0.0.0", port=PORT, reload=False)
