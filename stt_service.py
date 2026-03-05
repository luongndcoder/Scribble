"""
STT Microservice — Nvidia Parakeet CTC 0.6B Vietnamese
Flask server: accepts audio files → preprocesses → returns Vietnamese transcription.
Features: noise reduction, high-pass filter, normalization, VAD.
"""

import os
import sys
import tempfile
import logging
from pathlib import Path

# Load .env file BEFORE reading any os.environ
from dotenv import load_dotenv
load_dotenv()

from flask import Flask, request, jsonify
from flask_cors import CORS

logging.basicConfig(level=logging.INFO, format='%(asctime)s [STT] %(message)s')
logger = logging.getLogger(__name__)

app = Flask(__name__)
CORS(app)

# ─── Global model (loaded once at startup) ───
asr_model = None
vad_model = None
vad_utils = None
riva_auth = None

MODEL_NAME = os.environ.get('STT_MODEL', 'nvidia/parakeet-ctc-0.6b-vi')
ENABLE_PREPROCESSING = os.environ.get('STT_PREPROCESS', 'true').lower() == 'true'
STT_BACKEND = os.environ.get('STT_BACKEND', 'local')  # 'local' | 'nvidia'

# Nvidia Riva config
NVIDIA_API_KEY = os.environ.get('NVIDIA_API_KEY', '')
NVIDIA_FUNCTION_ID = os.environ.get('NVIDIA_FUNCTION_ID', 'f3dff2bb-99f9-403d-a5f1-f574e757deb0')
NVIDIA_RIVA_URL = os.environ.get('NVIDIA_RIVA_URL', 'grpc.nvcf.nvidia.com:443')


def load_model():
    """Load Parakeet model. Tries MPS (Apple Silicon GPU) first, falls back to CPU."""
    global asr_model
    import torch
    import nemo.collections.asr as nemo_asr

    if torch.cuda.is_available():
        device = 'cuda'
    elif hasattr(torch.backends, 'mps') and torch.backends.mps.is_available():
        device = 'mps'
    else:
        device = 'cpu'

    logger.info(f'Detected device: {device} | Loading model: {MODEL_NAME} ...')

    asr_model = nemo_asr.models.ASRModel.from_pretrained(model_name=MODEL_NAME)
    asr_model.eval()

    if device in ('mps', 'cuda'):
        try:
            asr_model = asr_model.to(device)
            import numpy as np
            import soundfile as sf
            dummy = np.zeros(16000, dtype=np.float32)
            tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
            sf.write(tmp.name, dummy, 16000)
            asr_model.transcribe([tmp.name])
            os.unlink(tmp.name)
            logger.info(f'✅ Model running on {device.upper()} (GPU acceleration enabled)')
        except Exception as e:
            logger.warning(f'⚠️  {device.upper()} failed ({e}), falling back to CPU')
            asr_model = asr_model.to('cpu')
            logger.info('✅ Model running on CPU')
    else:
        logger.info('✅ Model running on CPU')


def load_vad():
    """Load Silero VAD model for voice activity detection."""
    global vad_model, vad_utils
    try:
        import torch
        model, utils = torch.hub.load(
            repo_or_dir='snakers4/silero-vad', model='silero_vad',
            force_reload=False, onnx=False
        )
        vad_model = model
        vad_utils = utils
        logger.info('✅ Silero VAD loaded')
    except Exception as e:
        logger.warning(f'⚠️  VAD load failed ({e}), will skip VAD filtering')


# ─── Audio Preprocessing ───

def reduce_noise(audio_np, sr=16000):
    """Spectral gating noise reduction."""
    try:
        import noisereduce as nr
        cleaned = nr.reduce_noise(y=audio_np, sr=sr, prop_decrease=0.7, stationary=True)
        logger.info('  ✓ Noise reduction applied')
        return cleaned
    except Exception as e:
        logger.warning(f'  ⚠ Noise reduction failed: {e}')
        return audio_np


def high_pass_filter(audio_np, sr=16000, cutoff=80):
    """Remove low frequency noise (fans, AC) below cutoff Hz."""
    try:
        from scipy.signal import butter, sosfilt
        sos = butter(5, cutoff, btype='highpass', fs=sr, output='sos')
        filtered = sosfilt(sos, audio_np).astype(audio_np.dtype)
        logger.info(f'  ✓ High-pass filter ({cutoff}Hz) applied')
        return filtered
    except Exception as e:
        logger.warning(f'  ⚠ High-pass filter failed: {e}')
        return audio_np


def normalize_audio(audio_np, target_dbfs=-20.0):
    """Normalize audio volume to target dBFS."""
    import numpy as np
    rms = np.sqrt(np.mean(audio_np.astype(np.float64) ** 2))
    if rms < 1e-10:
        return audio_np
    target_rms = 10 ** (target_dbfs / 20.0)
    gain = target_rms / rms
    normalized = (audio_np * gain).clip(-1.0, 1.0).astype(audio_np.dtype)
    logger.info(f'  ✓ Normalized (gain={gain:.2f}x)')
    return normalized


def apply_vad(audio_np, sr=16000):
    """Use Silero VAD to keep only speech segments, skip silence."""
    if vad_model is None:
        return audio_np

    try:
        import torch
        import numpy as np
        get_speech_timestamps = vad_utils[0]

        tensor = torch.from_numpy(audio_np).float()
        if tensor.dim() > 1:
            tensor = tensor.mean(dim=1)

        timestamps = get_speech_timestamps(tensor, vad_model, sampling_rate=sr)

        if not timestamps:
            logger.info('  ✓ VAD: no speech detected in chunk')
            return audio_np

        speech_parts = [audio_np[ts['start']:ts['end']] for ts in timestamps]
        result = np.concatenate(speech_parts)
        kept_pct = len(result) / len(audio_np) * 100
        logger.info(f'  ✓ VAD: kept {len(timestamps)} segments ({kept_pct:.0f}% of audio)')
        return result
    except Exception as e:
        logger.warning(f'  ⚠ VAD failed: {e}')
        return audio_np


def preprocess_audio(wav_path):
    """Full preprocessing pipeline: noise reduce → high-pass → normalize → VAD."""
    import numpy as np
    import soundfile as sf

    audio_np, sr = sf.read(wav_path, dtype='float32')
    original_duration = len(audio_np) / sr

    logger.info(f'Preprocessing: {original_duration:.1f}s audio')

    audio_np = reduce_noise(audio_np, sr)
    audio_np = high_pass_filter(audio_np, sr)
    audio_np = normalize_audio(audio_np)
    audio_np = apply_vad(audio_np, sr)

    processed_duration = len(audio_np) / sr
    logger.info(f'Preprocessed: {original_duration:.1f}s → {processed_duration:.1f}s')

    processed_path = wav_path.replace('.wav', '_processed.wav')
    sf.write(processed_path, audio_np, sr)
    return processed_path


# ─── Audio Conversion ───

def convert_to_wav(input_path: str) -> str:
    """Convert any audio format to WAV 16kHz mono."""
    from pydub import AudioSegment

    file_size = os.path.getsize(input_path)
    audio = AudioSegment.from_file(input_path)
    logger.info(f'Audio: {len(audio)}ms, {audio.channels}ch, {audio.frame_rate}Hz, {audio.dBFS:.1f}dBFS ({file_size}B)')

    audio = audio.set_frame_rate(16000).set_channels(1).set_sample_width(2)

    if audio.dBFS < -50:
        logger.warning(f'⚠️  Audio very quiet ({audio.dBFS:.1f} dBFS)')

    wav_path = input_path.rsplit('.', 1)[0] + '_converted.wav'
    audio.export(wav_path, format='wav')
    return wav_path


# ─── Routes ───

@app.route('/health', methods=['GET'])
def health():
    return jsonify({
        'status': 'ok',
        'model': MODEL_NAME,
        'loaded': asr_model is not None,
        'preprocessing': ENABLE_PREPROCESSING,
        'vad': vad_model is not None,
        'backend': STT_BACKEND,
    })


@app.route('/config', methods=['GET'])
def get_config():
    return jsonify({
        'backend': STT_BACKEND,
        'preprocessing': ENABLE_PREPROCESSING,
        'nvidia_api_key': NVIDIA_API_KEY[:10] + '...' if NVIDIA_API_KEY else '',
        'nvidia_function_id': NVIDIA_FUNCTION_ID,
        'model': MODEL_NAME,
    })


@app.route('/config', methods=['POST'])
def set_config():
    global STT_BACKEND, ENABLE_PREPROCESSING, NVIDIA_API_KEY, NVIDIA_FUNCTION_ID
    data = request.get_json()

    if 'backend' in data:
        new_backend = data['backend']
        if new_backend == 'nvidia' and STT_BACKEND != 'nvidia':
            # Switching to nvidia — need to init Riva
            if data.get('nvidia_api_key'):
                NVIDIA_API_KEY = data['nvidia_api_key']
            init_nvidia_riva()
        STT_BACKEND = new_backend
        logger.info(f'Config: backend → {STT_BACKEND}')

    if 'preprocessing' in data:
        ENABLE_PREPROCESSING = bool(data['preprocessing'])
        if ENABLE_PREPROCESSING and vad_model is None:
            load_vad()
        logger.info(f'Config: preprocessing → {ENABLE_PREPROCESSING}')

    if 'nvidia_api_key' in data:
        NVIDIA_API_KEY = data['nvidia_api_key']
        if STT_BACKEND == 'nvidia':
            init_nvidia_riva()
        logger.info('Config: nvidia_api_key updated')

    if 'nvidia_function_id' in data:
        NVIDIA_FUNCTION_ID = data['nvidia_function_id']
        logger.info(f'Config: nvidia_function_id → {NVIDIA_FUNCTION_ID}')

    return jsonify({'ok': True, 'backend': STT_BACKEND, 'preprocessing': ENABLE_PREPROCESSING})


def transcribe_nvidia(wav_path):
    """Transcribe via Nvidia Riva cloud gRPC API."""
    import riva.client

    with open(wav_path, 'rb') as f:
        audio_data = f.read()

    asr_service = riva.client.ASRService(riva_auth)
    config = riva.client.RecognitionConfig(
        language_code='vi-VN',
        max_alternatives=1,
        enable_automatic_punctuation=True,
        audio_channel_count=1,
    )

    response = asr_service.offline_recognize(audio_data, config)

    text = ''
    for result in response.results:
        if result.alternatives:
            text += result.alternatives[0].transcript + ' '

    return text.strip()


def init_nvidia_riva():
    """Initialize Nvidia Riva gRPC connection."""
    global riva_auth
    try:
        import riva.client
        riva_auth = riva.client.Auth(
            ssl_cert=None,
            use_ssl=True,
            uri=NVIDIA_RIVA_URL,
            metadata_args=[
                ['function-id', NVIDIA_FUNCTION_ID],
                ['authorization', f'Bearer {NVIDIA_API_KEY}'],
            ]
        )
        logger.info(f'✅ Nvidia Riva connected ({NVIDIA_RIVA_URL})')
    except Exception as e:
        logger.error(f'❌ Nvidia Riva init failed: {e}')
        riva_auth = None


@app.route('/transcribe', methods=['POST'])
def transcribe():
    if 'audio' not in request.files:
        logger.warning(f'No audio field. Fields: {list(request.files.keys())}')
        return jsonify({'error': 'No audio file provided'}), 400

    audio_file = request.files['audio']
    if not audio_file.filename:
        return jsonify({'error': 'Empty filename'}), 400

    logger.info(f'Received: {audio_file.filename} ({audio_file.content_type})')

    suffix = Path(audio_file.filename).suffix or '.webm'
    tmp = tempfile.NamedTemporaryFile(delete=False, suffix=suffix, dir=tempfile.gettempdir())
    audio_file.save(tmp.name)
    tmp.close()

    wav_path = None
    processed_path = None
    try:
        wav_path = convert_to_wav(tmp.name)

        # Apply preprocessing if enabled
        transcribe_path = wav_path
        if ENABLE_PREPROCESSING:
            processed_path = preprocess_audio(wav_path)
            transcribe_path = processed_path

        # Choose backend
        text = ''
        segments = []

        if STT_BACKEND == 'nvidia' and riva_auth:
            text = transcribe_nvidia(transcribe_path)
        elif asr_model:
            output = asr_model.transcribe([transcribe_path])
            text = output[0].text if hasattr(output[0], 'text') else str(output[0])
            if hasattr(output[0], 'timestamp') and output[0].timestamp:
                seg_stamps = output[0].timestamp.get('segment', [])
                segments = [
                    {'start': s['start'], 'end': s['end'], 'text': s['segment']}
                    for s in seg_stamps
                ]
        else:
            return jsonify({'error': 'No STT backend available'}), 500

        if len(text) > 80:
            logger.info(f'Transcribed [{STT_BACKEND}]: {len(text)} chars | "{text[:80]}..."')
        else:
            logger.info(f'Transcribed [{STT_BACKEND}]: {len(text)} chars | "{text}"')

        return jsonify({'text': text.strip(), 'segments': segments})

    except Exception as e:
        logger.error(f'Transcription error: {e}')
        return jsonify({'error': str(e)}), 500

    finally:
        for f in [tmp.name, wav_path, processed_path]:
            if f:
                try:
                    os.unlink(f)
                except OSError:
                    pass


if __name__ == '__main__':
    port = int(os.environ.get('STT_PORT', 5555))

    # Load backend
    if STT_BACKEND == 'nvidia':
        init_nvidia_riva()
        logger.info('Backend: Nvidia Riva Cloud API')
    else:
        load_model()
        logger.info('Backend: Local Parakeet model')

    if ENABLE_PREPROCESSING:
        load_vad()
    else:
        logger.info('ℹ️  Preprocessing disabled (STT_PREPROCESS=false)')

    logger.info(f'STT service starting on port {port}')
    app.run(host='0.0.0.0', port=port, debug=False)
