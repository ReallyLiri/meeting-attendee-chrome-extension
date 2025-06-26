import os
import whisperx
from whisperx.diarize import DiarizationPipeline
import torch
import tempfile
import subprocess
import shutil
import json
import server.src.logging as _

HF_TOKEN = os.environ.get("HF_TOKEN")
MODEL_DIR = os.environ.get("MODEL_DIR")

if torch.cuda.is_available():
    device = "cuda"
    compute_type = "float16"
else:
    device = "cpu"
    compute_type = "int8"

batch_size = 16


def _model_init():
    if shutil.which("ffmpeg") is None:
        raise RuntimeError(
            "ffmpeg not found. Please install ffmpeg and ensure it is in your PATH."
        )
    model_kwargs = {"device": device, "compute_type": compute_type}
    if MODEL_DIR:
        model_kwargs["download_root"] = MODEL_DIR
    import logging

    logging.info(
        f"Loading WhisperX model (device={device}, compute_type={compute_type}, model_dir={MODEL_DIR})..."
    )
    model = whisperx.load_model("large-v2", **model_kwargs)
    logging.info("WhisperX model loaded.")
    logging.info("Loading diarization pipeline...")
    diarize_model = DiarizationPipeline(use_auth_token=HF_TOKEN, device=device)
    logging.info("Diarization pipeline loaded.")
    return model, diarize_model


def _transcribe_audio(audio_path: str, model, diarize_model):
    import logging

    logging.info(f"Loading audio from: {audio_path}")
    audio = whisperx.load_audio(audio_path)
    logging.info("Running transcription...")
    result = model.transcribe(audio, batch_size=batch_size)
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
    diarize_segments = diarize_model(audio)
    logging.info("Diarization complete. Assigning speakers...")
    result = whisperx.assign_word_speakers(diarize_segments, result)
    logging.info("Speaker assignment complete.")
    return result


def _concat_audio_files_in_dir(directory: str) -> str:
    import logging

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


def transcribe_and_write_json(input_path: str, output_path: str):
    import logging

    model, diarize_model = _model_init()
    temp_concat_path = None
    try:
        if os.path.isdir(input_path):
            temp_concat_path = _concat_audio_files_in_dir(input_path)
            result = _transcribe_audio(temp_concat_path, model, diarize_model)
        else:
            result = _transcribe_audio(input_path, model, diarize_model)
        logging.info(f"Writing transcription to: {output_path}")
        with open(output_path, "w", encoding="utf-8") as f:
            json.dump(result, f, indent=2, ensure_ascii=False)
    finally:
        if temp_concat_path and os.path.exists(temp_concat_path):
            logging.info(f"Removing temporary concatenated file: {temp_concat_path}")
            os.remove(temp_concat_path)


if __name__ == "__main__":
    import argparse

    parser = argparse.ArgumentParser(
        description="Transcribe and diarize audio with WhisperX."
    )
    parser.add_argument(
        "audio_path", help="Path to audio file or directory of audio files"
    )
    args = parser.parse_args()
    output_path = _get_output_json_path(args.audio_path)
    transcribe_and_write_json(args.audio_path, output_path)
