import asyncio
import json
import logging
import os
import shutil
import warnings
from contextlib import asynccontextmanager
from datetime import datetime
from typing import Optional, Dict, Any, List
from uuid import uuid4

import aiofiles
import uvicorn
import logger as _
from fastapi import FastAPI, UploadFile, File, Header, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel

from server.src import transcribe

warnings.filterwarnings(
    "ignore", message="resource_tracker: There appear to be .* leaked semaphore objects"
)

WORKING_DIR: str = os.environ.get("WORKING_DIR", "./data")
OUTPUT_DIR: str = os.environ.get("OUTPUT_DIR", "./output")
PORT: int = int(os.environ.get("PORT", 8017))

os.makedirs(WORKING_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

sessions: Dict[str, Dict[str, Any]] = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.info("Pre-initializing model in background...")
    asyncio.create_task(transcribe.ensure_model_ready())
    yield


app = FastAPI(lifespan=lifespan)

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


def _timestamp_str() -> str:
    return datetime.now().strftime("%Y.%m.%d.%H.%M")


def _get_ext_from_mime(mime: str) -> str:
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


async def transcribe_chunk_async(audio_path: str, output_path: str) -> None:
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None, transcribe.transcribe_and_write_json, audio_path, output_path
    )


async def merge_transcripts(transcript_files: List[str], out_path: str) -> None:
    merged: Dict[str, Any] = {"segments": []}
    for f in sorted(transcript_files):
        async with aiofiles.open(f, "r", encoding="utf-8") as infile:
            data = json.loads(await infile.read())
            if "segments" in data:
                merged["segments"].extend(data["segments"])
    async with aiofiles.open(out_path, "w", encoding="utf-8") as outfile:
        await outfile.write(json.dumps(merged, indent=2, ensure_ascii=False))
    for f in transcript_files:
        try:
            os.remove(f)
            logging.info(f"Deleted partial transcript file {f}")
        except Exception as e:
            logging.warning(f"Failed to delete partial transcript file {f}: {e}")


@app.post("/sessions/start")
def start_session(req: SessionStartRequest) -> Dict[str, str]:
    logging.info(f"/sessions/start called with title: {req.title}")
    if not req.title:
        raise HTTPException(status_code=400, detail="Session title required")
    session_id: str = str(uuid4())
    norm_title: str = _normalize_title(req.title)
    sessions[session_id] = {
        "title": req.title,
        "norm_title": norm_title,
        "chunks": [],
        "screenshots": [],
        "transcript_files": [],
        "transcription_tasks": [],
    }
    logging.info(f"Started session {session_id} with title '{req.title}'")
    return {"session_id": session_id}


@app.post("/sessions/{session_id}/chunk")
async def upload_chunk(
        session_id: str,
        file: UploadFile = File(...),
        mime_type: Optional[str] = Header(None),
) -> Dict[str, str]:
    mime_type = file.content_type
    logging.info(
        f"/sessions/{session_id}/chunk called. filename={file.filename}, content_type={mime_type}"
    )
    if not mime_type:
        raise HTTPException(
            status_code=400, detail="content_type missing from uploaded file"
        )
    mime_type_simple: str = mime_type.split(";")[0].strip()
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    ext: str = _get_ext_from_mime(mime_type_simple)
    ts: str = _timestamp_str()
    chunk_fname: str = f"audio_{ts}_{session_id}.{ext}"
    chunk_fpath: str = os.path.join(WORKING_DIR, chunk_fname)
    async with aiofiles.open(chunk_fpath, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            await out.write(chunk)
    sessions[session_id]["chunks"].append(chunk_fpath)
    transcript_path: str = os.path.join(
        WORKING_DIR, f"transcript_{ts}_{session_id}.json"
    )
    task = asyncio.create_task(transcribe_chunk_async(chunk_fpath, transcript_path))
    sessions[session_id]["transcript_files"].append(transcript_path)
    sessions[session_id]["transcription_tasks"].append(task)
    logging.info(
        f"Received chunk for session {session_id}: {chunk_fpath}, dispatched transcription to {transcript_path}"
    )
    return {"status": "ok", "path": os.path.relpath(chunk_fpath, WORKING_DIR)}


@app.post("/sessions/{session_id}/screenshot")
def upload_screenshot(
        session_id: str,
        file: UploadFile = File(...),
        mime_type: Optional[str] = Header(None),
) -> Dict[str, str]:
    mime_type = file.content_type
    logging.info(
        f"/sessions/{session_id}/screenshot called. filename={file.filename}, content_type={mime_type}"
    )
    if not mime_type:
        raise HTTPException(
            status_code=400, detail="content_type missing from uploaded file"
        )
    mime_type_simple: str = mime_type.split(";")[0].strip()
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    ext: str = _get_ext_from_mime(mime_type_simple)
    ts: str = _timestamp_str()
    norm_title: str = sessions[session_id]["norm_title"]
    session_dir: str = os.path.join(OUTPUT_DIR, norm_title)
    os.makedirs(session_dir, exist_ok=True)
    fname: str = f"screenshot_{ts}.{ext}"
    fpath: str = os.path.join(session_dir, fname)
    with open(fpath, "wb") as out:
        shutil.copyfileobj(file.file, out)
    sessions[session_id]["screenshots"].append(fpath)
    logging.info(f"Received screenshot for session {session_id}: {fpath}")
    return {"status": "ok", "path": os.path.relpath(fpath, OUTPUT_DIR)}


@app.post("/sessions/{session_id}/end")
async def end_session(session_id: str, background_tasks: BackgroundTasks):
    logging.info(f"/sessions/{session_id}/end called.")
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    session = sessions[session_id]
    norm_title = session["norm_title"]
    session_dir = os.path.join(OUTPUT_DIR, norm_title)
    os.makedirs(session_dir, exist_ok=True)
    out_path = os.path.join(session_dir, "transcription.json")

    # Wait for all transcription tasks to finish, then merge
    async def finalize():
        await asyncio.gather(*session["transcription_tasks"], return_exceptions=True)
        await merge_transcripts(session["transcript_files"], out_path)
        logging.info(f"Merged transcripts for session {session_id} into {out_path}")

    background_tasks.add_task(finalize)
    logging.info(f"Session {session_id} ended. Finalization task dispatched.")
    return {"status": "ok", "output": os.path.relpath(out_path, OUTPUT_DIR)}


if __name__ == "__main__":
    logging.info(f"Starting FastAPI server on port {PORT}")
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=True)
