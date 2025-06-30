import argparse
import asyncio
import json
import logging
import os
import shutil
import subprocess
import tempfile
import threading
from typing import Optional
import logger as _

import torch
import whisperx
from whisperx.diarize import DiarizationPipeline

HF_TOKEN: Optional[str] = os.environ.get("HF_TOKEN")
MODEL_DIR: Optional[str] = os.environ.get("MODEL_DIR")

WHISPERX_MODEL: str = "large-v2"

device: str
compute_type: str
if torch.cuda.is_available():
    device = "cuda"
    compute_type = "float16"
else:
    device = "cpu"
    compute_type = "int8"

batch_size: int = 16

_model_lock = threading.Lock()
_model_ready_event = threading.Event()

_whisper_model = None
_diarize_model = None


async def ensure_model_ready() -> None:
    if _model_ready_event.is_set():
        return
    loop = asyncio.get_event_loop()
    await loop.run_in_executor(None, _init_model_once)


def _init_model_once() -> None:
    if _model_ready_event.is_set():
        return
    with _model_lock:
        if _model_ready_event.is_set():
            return
        if shutil.which("ffmpeg") is None:
            raise RuntimeError(
                "ffmpeg not found. Please install ffmpeg and ensure it is in your PATH."
            )
        model_kwargs = {"device": device, "compute_type": compute_type}
        if MODEL_DIR:
            os.makedirs(MODEL_DIR, exist_ok=True)
            model_kwargs["download_root"] = MODEL_DIR
        global _whisper_model, _diarize_model
        logging.info(
            f"Loading WhisperX model (device={device}, compute_type={compute_type}, model_dir={MODEL_DIR})..."
        )
        _whisper_model = whisperx.load_model(WHISPERX_MODEL, **model_kwargs)
        logging.info("WhisperX model loaded.")
        logging.info("Loading diarization pipeline...")
        _diarize_model = DiarizationPipeline(use_auth_token=HF_TOKEN, device=device)
        logging.info("Diarization pipeline loaded.")
        _model_ready_event.set()


def _transcribe_audio(audio_path: str, prev_embeddings=None):
    global _whisper_model, _diarize_model
    logging.info(f"Loading audio from: {audio_path}")
    audio = whisperx.load_audio(audio_path)
    logging.info("Running transcription...")
    result = _whisper_model.transcribe(audio, batch_size=batch_size)
    logging.info("Transcription complete. Running alignment...")
    align_model, align_metadata = whisperx.load_align_model(
        language_code=result["language"], device=device
    )
    result = whisperx.align(
        result["segments"],
        align_model,
        align_metadata,
        audio,
        device,
        return_char_alignments=False,
    )
    logging.info("Alignment complete. Running diarization...")
    diarize_segments = _diarize_model(audio, return_embeddings=False)
    logging.info("Diarization complete. Assigning speakers...")
    result = whisperx.assign_word_speakers(diarize_segments, result)
    logging.info("Speaker assignment complete.")
    result.pop("word_segments", None)
    for segment in result.get("segments", []):
        segment.pop("words", None)
    return result


def _concat_audio_files_in_dir(directory: str) -> str:
    logging.info(f"Concatenating audio files in directory: {directory}")
    files = sorted(
        [
            os.path.join(directory, f)
            for f in os.listdir(directory)
            if os.path.isfile(os.path.join(directory, f))
        ]
    )
    if not files:
        raise ValueError(f"No files found in directory: {directory}")
    with tempfile.NamedTemporaryFile(
        mode="w", delete=False, suffix=".txt"
    ) as list_file:
        for f in files:
            list_file.write(f"file '{f}'\n")
        list_file_path = list_file.name
    temp_out = tempfile.NamedTemporaryFile(
        suffix=os.path.splitext(files[0])[1], delete=False
    )
    temp_out_path = temp_out.name
    temp_out.close()
    cmd = [
        "ffmpeg",
        "-y",
        "-f",
        "concat",
        "-safe",
        "0",
        "-i",
        list_file_path,
        "-c",
        "copy",
        temp_out_path,
    ]
    logging.info(f"Running ffmpeg to concatenate files: {' '.join(cmd)}")
    subprocess.run(cmd, check=True)
    os.unlink(list_file_path)
    logging.info(f"Concatenation complete: {temp_out_path}")
    return temp_out_path


def _get_output_json_path(audio_path: str) -> str:
    base = os.path.abspath(audio_path)
    return base + ".transcription.json"


async def transcribe_and_write_json(
    input_path: str, output_path: str, prev_embeddings=None
):
    await ensure_model_ready()
    temp_concat_path: Optional[str] = None
    try:
        if os.path.isdir(input_path):
            temp_concat_path = _concat_audio_files_in_dir(input_path)
            result = _transcribe_audio(temp_concat_path)
        else:
            result = _transcribe_audio(input_path)
        logging.info(f"Writing transcription to: {output_path}")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
        return result
    finally:
        if temp_concat_path and os.path.exists(temp_concat_path):
            logging.info(f"Removing temporary concatenated file: {temp_concat_path}")
            os.remove(temp_concat_path)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(
        description="Transcribe and diarize audio with WhisperX."
    )
    parser.add_argument(
        "audio_path", help="Path to audio file or directory of audio files"
    )
    args = parser.parse_args()
    output_path = _get_output_json_path(args.audio_path)
    transcribe_and_write_json(args.audio_path, output_path)
