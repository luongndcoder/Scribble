import { readResponseError } from './sidecar';

export interface SseEventPayload {
  event: string;
  data: string;
  json?: any;
}

interface ConsumeSseOptions {
  onEvent?: (payload: SseEventPayload) => void;
  onToken?: (token: string, payload: SseEventPayload) => void;
  onErrorEvent?: (message: string, payload: SseEventPayload) => void;
}

function createSseParser(onDispatch: (payload: SseEventPayload) => void) {
  let buffer = '';
  let currentEvent = 'message';
  let currentData: string[] = [];

  const dispatch = () => {
    if (!currentData.length) {
      currentEvent = 'message';
      return;
    }

    const data = currentData.join('\n');
    const payload: SseEventPayload = { event: currentEvent || 'message', data };
    try {
      payload.json = JSON.parse(data);
    } catch { }

    onDispatch(payload);
    currentEvent = 'message';
    currentData = [];
  };

  const processLine = (line: string) => {
    if (line === '') {
      dispatch();
      return;
    }
    if (line.startsWith(':')) return;
    if (line.startsWith('event:')) {
      currentEvent = line.slice(6).trim() || 'message';
      return;
    }
    if (line.startsWith('data:')) {
      currentData.push(line.slice(5).trimStart());
    }
  };

  const push = (chunk: string, flush = false) => {
    buffer += chunk;
    while (true) {
      const idx = buffer.search(/\r?\n/);
      if (idx < 0) break;

      const line = buffer.slice(0, idx);
      const newlineLen = buffer[idx] === '\r' && buffer[idx + 1] === '\n' ? 2 : 1;
      buffer = buffer.slice(idx + newlineLen);
      processLine(line);
    }

    if (flush) {
      if (buffer.length > 0) {
        processLine(buffer);
        buffer = '';
      }
      dispatch();
    }
  };

  return { push };
}

export async function consumeSseResponse(
  res: Response,
  options: ConsumeSseOptions = {},
): Promise<void> {
  if (!res.ok) {
    throw new Error(await readResponseError(res));
  }

  const parser = createSseParser((payload) => {
    options.onEvent?.(payload);

    const token = payload.json?.token;
    if (typeof token === 'string' && token) {
      options.onToken?.(token, payload);
    }

    if (payload.event === 'error') {
      const msg = payload.json?.error || payload.data || 'Unknown SSE error';
      options.onErrorEvent?.(String(msg), payload);
    }
  });

  const reader = res.body?.getReader?.();
  if (!reader) {
    // WKWebView can return null body for streaming responses; fallback to full text.
    parser.push(await res.text(), true);
    return;
  }

  const decoder = new TextDecoder();
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    parser.push(decoder.decode(value, { stream: true }));
  }
  parser.push('', true);
}
