import whisperx
import os
from whisperx.diarize import DiarizationPipeline
from typing import BinaryIO
import torch

HF_TOKEN = os.environ.get('HF_TOKEN')
MODEL_DIR = os.environ.get('MODEL_DIR')

if torch.cuda.is_available():
    device = "cuda"
    compute_type = "float16"
else:
    device = "cpu"
    compute_type = "int8"

batch_size = 16

def model_init():
    model_kwargs = {"device": device, "compute_type": compute_type}
    if MODEL_DIR:
        model_kwargs["download_root"] = MODEL_DIR
    model = whisperx.load_model("large-v2", **model_kwargs)
    diarize_model = DiarizationPipeline(use_auth_token=HF_TOKEN, device=device)
    return model, diarize_model

def transcribe_audio(audio_stream: BinaryIO, model, diarize_model):
    import tempfile
    with tempfile.NamedTemporaryFile(suffix=".wav", delete=True) as tmp:
        tmp.write(audio_stream.read())
        tmp.flush()
        tmp.seek(0)
        audio = whisperx.load_audio(tmp.name)
    result = model.transcribe(audio, batch_size=batch_size)
    align_model, align_metadata = whisperx.load_align_model(language_code=result["language"], device=device)
    result = whisperx.align(result["segments"], align_model, align_metadata, audio, device, return_char_alignments=False)
    diarize_segments = diarize_model(audio)
    result = whisperx.assign_word_speakers(diarize_segments, result)
    return result

if __name__ == "__main__":
    import argparse
    parser = argparse.ArgumentParser(description="Transcribe and diarize audio with WhisperX.")
    parser.add_argument("audio_file", help="Path to audio file")
    args = parser.parse_args()
    model, diarize_model = model_init()
    with open(args.audio_file, "rb") as f:
        result = transcribe_audio(f, model, diarize_model)
        import pprint
        pprint.pprint(result)
