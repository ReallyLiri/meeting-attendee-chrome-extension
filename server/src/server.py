import os
import shutil
import tempfile
import logger as _
import logging
from fastapi import FastAPI, UploadFile, File, Header, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel
from typing import Optional
from uuid import uuid4
from datetime import datetime
import uvicorn
from model_audio import transcribe_and_write_json, ensure_model_ready
import asyncio
import aiofiles
from contextlib import asynccontextmanager

WORKING_DIR = os.environ.get("WORKING_DIR", "./data")
OUTPUT_DIR = os.environ.get("OUTPUT_DIR", "./output")
PORT = int(os.environ.get("PORT", 8017))

os.makedirs(WORKING_DIR, exist_ok=True)
os.makedirs(OUTPUT_DIR, exist_ok=True)

sessions = {}


@asynccontextmanager
async def lifespan(app: FastAPI):
    logging.info("Pre-initializing model in background...")
    asyncio.create_task(ensure_model_ready())
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


def _timestamp_str():
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


async def transcribe_chunk_async(audio_path: str, output_path: str):
    import model_audio

    loop = asyncio.get_event_loop()
    await loop.run_in_executor(
        None, model_audio.transcribe_and_write_json, audio_path, output_path
    )


async def merge_transcripts(transcript_files, out_path):
    import json

    merged = {"segments": []}
    for f in sorted(transcript_files):
        async with aiofiles.open(f, "r", encoding="utf-8") as infile:
            data = json.loads(await infile.read())
            if "segments" in data:
                merged["segments"].extend(data["segments"])
    async with aiofiles.open(out_path, "w", encoding="utf-8") as outfile:
        await outfile.write(json.dumps(merged, indent=2, ensure_ascii=False))
    # Cleanup partial transcript files
    for f in transcript_files:
        try:
            os.remove(f)
            logging.info(f"Deleted partial transcript file {f}")
        except Exception as e:
            logging.warning(f"Failed to delete partial transcript file {f}: {e}")


@app.post("/sessions/start")
def start_session(req: SessionStartRequest):
    logging.info(f"/sessions/start called with title: {req.title}")
    if not req.title:
        raise HTTPException(status_code=400, detail="Session title required")
    session_id = str(uuid4())
    norm_title = _normalize_title(req.title)
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
):
    mime_type = file.content_type
    logging.info(
        f"/sessions/{session_id}/chunk called. filename={file.filename}, content_type={mime_type}"
    )
    if not mime_type:
        raise HTTPException(
            status_code=400, detail="content_type missing from uploaded file"
        )
    mime_type_simple = mime_type.split(";")[0].strip()
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    ext = _get_ext_from_mime(mime_type_simple)
    ts = _timestamp_str()
    # Save audio chunk to WORKING_DIR (data), not output
    chunk_fname = f"audio_{ts}_{session_id}.{ext}"
    chunk_fpath = os.path.join(WORKING_DIR, chunk_fname)
    async with aiofiles.open(chunk_fpath, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            await out.write(chunk)
    sessions[session_id]["chunks"].append(chunk_fpath)
    # Partial transcript goes to WORKING_DIR (data)
    transcript_path = os.path.join(WORKING_DIR, f"transcript_{ts}_{session_id}.json")
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
):
    mime_type = file.content_type
    logging.info(
        f"/sessions/{session_id}/screenshot called. filename={file.filename}, content_type={mime_type}"
    )
    if not mime_type:
        raise HTTPException(
            status_code=400, detail="content_type missing from uploaded file"
        )
    mime_type_simple = mime_type.split(";")[0].strip()
    if session_id not in sessions:
        raise HTTPException(status_code=404, detail="Session not found")
    ext = _get_ext_from_mime(mime_type_simple)
    ts = _timestamp_str()
    norm_title = sessions[session_id]["norm_title"]
    session_dir = os.path.join(OUTPUT_DIR, norm_title)
    os.makedirs(session_dir, exist_ok=True)
    fname = f"screenshot_{ts}.{ext}"
    fpath = os.path.join(session_dir, fname)
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
