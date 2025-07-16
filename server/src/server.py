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
from fastapi import FastAPI, UploadFile, File, Header, HTTPException, BackgroundTasks
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import HTMLResponse, FileResponse
from fastapi.staticfiles import StaticFiles
from pydantic import BaseModel

import transcribe

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

app.mount("/static", StaticFiles(directory="static"), name="static")


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


@app.get("/", response_class=HTMLResponse)
@app.get("/index.html", response_class=HTMLResponse)
async def serve_index():
    return FileResponse("static/index.html")


@app.get("/api/meetings")
async def get_meetings():
    meetings = []
    
    if not os.path.exists(OUTPUT_DIR):
        return {"meetings": meetings}
    
    for meeting_dir in os.listdir(OUTPUT_DIR):
        meeting_path = os.path.join(OUTPUT_DIR, meeting_dir)
        if not os.path.isdir(meeting_path):
            continue
            
        transcription_path = os.path.join(meeting_path, "transcription.json")
        if not os.path.exists(transcription_path):
            continue
            
        try:
            async with aiofiles.open(transcription_path, "r", encoding="utf-8") as f:
                transcription_data = json.loads(await f.read())
                
            session = transcription_data.get("session", {})
            title = session.get("title", meeting_dir)
            start_time = session.get("start_time", 0)
            
            screenshots = []
            for file in os.listdir(meeting_path):
                if file.startswith("screenshot_") and file.endswith(".png"):
                    screenshots.append(file)
            
            screenshots.sort()
            middle_screenshot = None
            if screenshots:
                middle_index = len(screenshots) // 2
                middle_screenshot = screenshots[middle_index]
            
            meetings.append({
                "id": meeting_dir,
                "title": title,
                "date": start_time,
                "screenshot": middle_screenshot
            })
        except Exception as e:
            logging.error(f"Error processing meeting {meeting_dir}: {e}")
            continue
    
    meetings.sort(key=lambda x: x["date"], reverse=True)
    return {"meetings": meetings}


@app.get("/api/meetings/{meeting_id}/transcription")
async def get_transcription(meeting_id: str):
    meeting_path = os.path.join(OUTPUT_DIR, meeting_id)
    transcription_path = os.path.join(meeting_path, "transcription.json")
    
    if not os.path.exists(transcription_path):
        raise HTTPException(status_code=404, detail="Transcription not found")
    
    try:
        async with aiofiles.open(transcription_path, "r", encoding="utf-8") as f:
            transcription_data = json.loads(await f.read())
        
        # Merge consecutive segments from the same speaker
        if "segments" in transcription_data and transcription_data["segments"]:
            merged_segments = []
            current_segment = None
            
            for segment in transcription_data["segments"]:
                if current_segment is None:
                    current_segment = segment.copy()
                elif current_segment["speaker"] == segment["speaker"]:
                    # Merge with current segment
                    current_segment["end"] = segment["end"]
                    current_segment["text"] += "\n" + segment["text"]
                else:
                    # Different speaker, save current and start new
                    merged_segments.append(current_segment)
                    current_segment = segment.copy()
            
            # Don't forget the last segment
            if current_segment is not None:
                merged_segments.append(current_segment)
            
            transcription_data["segments"] = merged_segments
        
        return transcription_data
    except Exception as e:
        logging.error(f"Error reading transcription for {meeting_id}: {e}")
        raise HTTPException(status_code=500, detail="Error reading transcription")


@app.get("/api/meetings/{meeting_id}/screenshot")
async def get_screenshot(meeting_id: str):
    meeting_path = os.path.join(OUTPUT_DIR, meeting_id)
    
    if not os.path.exists(meeting_path):
        raise HTTPException(status_code=404, detail="Meeting not found")
    
    screenshots = []
    for file in os.listdir(meeting_path):
        if file.startswith("screenshot_") and file.endswith(".png"):
            screenshots.append(file)
    
    if not screenshots:
        raise HTTPException(status_code=404, detail="No screenshots found")
    
    screenshots.sort()
    middle_index = len(screenshots) // 2
    screenshot_path = os.path.join(meeting_path, screenshots[middle_index])
    
    return FileResponse(screenshot_path, media_type="image/png")


@app.get("/api/meetings/{meeting_id}/screenshots")
async def get_screenshots_list(meeting_id: str):
    meeting_path = os.path.join(OUTPUT_DIR, meeting_id)
    
    if not os.path.exists(meeting_path):
        raise HTTPException(status_code=404, detail="Meeting not found")
    
    transcription_path = os.path.join(meeting_path, "transcription.json")
    if not os.path.exists(transcription_path):
        raise HTTPException(status_code=404, detail="Transcription not found")
    
    try:
        async with aiofiles.open(transcription_path, "r", encoding="utf-8") as f:
            transcription_data = json.loads(await f.read())
        
        session = transcription_data.get("session", {})
        start_time = session.get("start_time", 0)
        
        screenshots = []
        for file in os.listdir(meeting_path):
            if file.startswith("screenshot_") and file.endswith(".png"):
                # Parse timestamp from filename like "screenshot_2025.07.16.12.15.png"
                timestamp_str = file.replace("screenshot_", "").replace(".png", "")
                try:
                    # Convert timestamp format 2025.07.16.12.15 to datetime
                    parts = timestamp_str.split(".")
                    if len(parts) >= 5:
                        year, month, day, hour, minute = map(int, parts[:5])
                        from datetime import datetime
                        screenshot_time = datetime(year, month, day, hour, minute)
                        screenshot_epoch = screenshot_time.timestamp()
                        
                        screenshots.append({
                            "filename": file,
                            "timestamp": screenshot_epoch,
                            "relative_time": screenshot_epoch - start_time
                        })
                except (ValueError, IndexError):
                    # If parsing fails, use file modification time as fallback
                    file_path = os.path.join(meeting_path, file)
                    file_mtime = os.path.getmtime(file_path)
                    screenshots.append({
                        "filename": file,
                        "timestamp": file_mtime,
                        "relative_time": file_mtime - start_time
                    })
        
        # Sort by timestamp
        screenshots.sort(key=lambda x: x["timestamp"])
        
        return {"screenshots": screenshots}
    except Exception as e:
        logging.error(f"Error reading screenshots for {meeting_id}: {e}")
        raise HTTPException(status_code=500, detail="Error reading screenshots")


@app.get("/api/meetings/{meeting_id}/screenshots/{filename}")
async def get_screenshot_file(meeting_id: str, filename: str):
    meeting_path = os.path.join(OUTPUT_DIR, meeting_id)
    screenshot_path = os.path.join(meeting_path, filename)
    
    if not os.path.exists(screenshot_path) or not filename.startswith("screenshot_"):
        raise HTTPException(status_code=404, detail="Screenshot not found")
    
    return FileResponse(screenshot_path, media_type="image/png")


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
        "start_time": datetime.now().timestamp(),
        "chunks": [],
        "screenshots": [],
    }
    logging.info(f"Started session {session_id} with title '{req.title}'")
    return {"session_id": session_id}


@app.post("/sessions/{session_id}/chunk")
async def upload_chunk(
    session_id: str,
    file: UploadFile = File(...),
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
    chunk_dir: str = os.path.join(WORKING_DIR, session_id)
    os.makedirs(chunk_dir, exist_ok=True)
    chunk_fname: str = f"audio_{ts}_{session_id}.{ext}"
    chunk_fpath: str = os.path.join(chunk_dir, chunk_fname)
    async with aiofiles.open(chunk_fpath, "wb") as out:
        while True:
            chunk = await file.read(1024 * 1024)
            if not chunk:
                break
            await out.write(chunk)
    sessions[session_id]["chunks"].append(chunk_fpath)
    logging.info(f"Saved audio chunk for session {session_id}: {chunk_fpath}")
    return {"status": "ok", "path": os.path.relpath(chunk_fpath, WORKING_DIR)}


@app.post("/sessions/{session_id}/screenshot")
def upload_screenshot(
    session_id: str,
    file: UploadFile = File(...),
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

    async def finalize():
        chunk_dir = os.path.join(WORKING_DIR, session_id)
        logging.info(
            f"Starting combination of {len(session['chunks'])} audio chunks for session {session_id}"
        )
        concat_path = os.path.join(chunk_dir, f"concat_{session_id}.webm")
        with open(concat_path, "wb") as outfile:
            for chunk_path in session["chunks"]:
                with open(chunk_path, "rb") as infile:
                    outfile.write(infile.read())
        logging.info(
            f"Finished combination of audio chunks for session {session_id}, combined audio written to {concat_path}"
        )

        success = False
        try:
            logging.info(f"Starting transcription for {concat_path} -> {out_path}")
            await transcribe.transcribe_and_write_json(session, concat_path, out_path)
            logging.info(f"Finished transcription for {concat_path} -> {out_path}")
            success = True
        except Exception as e:
            logging.error(f"Transcription failed for {concat_path}: {e}", exc_info=True)

        if success:
            import shutil

            try:
                shutil.rmtree(chunk_dir)
                logging.info(f"Deleted session chunk directory {chunk_dir}")
            except Exception as e:
                logging.warning(
                    f"Failed to delete session chunk directory {chunk_dir}: {e}"
                )
        else:
            logging.info(
                f"Preserved session chunk directory {chunk_dir} for debugging."
            )
        logging.info(f"Session {session_id} finalized.")

    background_tasks.add_task(finalize)
    logging.info(f"Session {session_id} ended. Finalization task dispatched.")
    return {"status": "ok", "output": os.path.relpath(out_path, OUTPUT_DIR)}


if __name__ == "__main__":
    logging.info(f"Starting FastAPI server on port {PORT}")
    uvicorn.run("server:app", host="0.0.0.0", port=PORT, reload=True)
