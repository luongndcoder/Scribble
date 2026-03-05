"""Quick test: verify Nvidia Riva API key + function-id work."""
import os
from dotenv import load_dotenv
load_dotenv()

import riva.client
import numpy as np
import soundfile as sf
import tempfile

API_KEY = os.environ.get('NVIDIA_API_KEY', '')
FUNC_ID = os.environ.get('NVIDIA_FUNCTION_ID', 'f3dff2bb-99f9-403d-a5f1-f574e757deb0')
RIVA_URL = 'grpc.nvcf.nvidia.com:443'

print(f'API Key: {API_KEY[:15]}...')
print(f'Function ID: {FUNC_ID}')
print(f'Server: {RIVA_URL}')

# Create a short test audio (1 second of silence)
audio = np.zeros(16000, dtype=np.float32)
tmp = tempfile.NamedTemporaryFile(suffix='.wav', delete=False)
sf.write(tmp.name, audio, 16000)

with open(tmp.name, 'rb') as f:
    audio_data = f.read()
os.unlink(tmp.name)

# Connect
auth = riva.client.Auth(
    ssl_cert=None,
    use_ssl=True,
    uri=RIVA_URL,
    metadata_args=[
        ['function-id', FUNC_ID],
        ['authorization', f'Bearer {API_KEY}'],
    ]
)

asr_service = riva.client.ASRService(auth)
config = riva.client.RecognitionConfig(
    language_code='vi-VN',
    max_alternatives=1,
    enable_automatic_punctuation=True,
    audio_channel_count=1,
)

print('Sending test request...')
try:
    response = asr_service.offline_recognize(audio_data, config)
    print(f'✅ Success! Results: {len(response.results)}')
    for r in response.results:
        if r.alternatives:
            print(f'  Text: "{r.alternatives[0].transcript}"')
except Exception as e:
    print(f'❌ Error: {e}')
    # Try alternative function-id (docs show slightly different ID)
    print('\nTrying alternative function-id: f3dff2bb-99f9-403d-a5f1-f574a757deb0 ...')
    auth2 = riva.client.Auth(
        ssl_cert=None,
        use_ssl=True,
        uri=RIVA_URL,
        metadata_args=[
            ['function-id', 'f3dff2bb-99f9-403d-a5f1-f574a757deb0'],
            ['authorization', f'Bearer {API_KEY}'],
        ]
    )
    try:
        asr2 = riva.client.ASRService(auth2)
        response2 = asr2.offline_recognize(audio_data, config)
        print(f'✅ Alternative ID works! Use this function-id.')
    except Exception as e2:
        print(f'❌ Alternative also failed: {e2}')
        print('\n⚠️  Your API key may not have access. Please:')
        print('  1. Go to https://build.nvidia.com/nvidia/parakeet-ctc-0_6b-vi')
        print('  2. Click "Get API Key" and generate a new key')
        print('  3. Accept the Terms of Service if prompted')
        print('  4. Update NVIDIA_API_KEY in .env')
