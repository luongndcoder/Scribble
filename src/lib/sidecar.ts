/**
 * Sidecar connectivity — adapts to Tauri (desktop) or Web (docker/browser) mode.
 *
 * Desktop (Tauri): connects to local sidecar at 127.0.0.1:8765
 * Web (Docker):    uses relative URLs proxied by Nginx (/api/*)
 */

const IS_TAURI = typeof window !== 'undefined' && '__TAURI__' in window;

const SIDECAR_HTTP_BASES = IS_TAURI
  ? ['http://127.0.0.1:8765', 'http://localhost:8765'] as const
  : ['/api'] as const;

const SIDECAR_WS_BASES = IS_TAURI
  ? ['ws://127.0.0.1:8765', 'ws://localhost:8765'] as const
  : [`ws://${window.location.host}`] as const;

export { SIDECAR_HTTP_BASES, SIDECAR_WS_BASES, IS_TAURI };

function normalizePath(path: string): string {
  if (!path) return '/';
  return path.startsWith('/') ? path : `/${path}`;
}

export function sidecarUrl(base: string, path: string): string {
  return `${base}${normalizePath(path)}`;
}

export async function fetchSidecar(path: string, init?: RequestInit): Promise<Response> {
  const normalized = normalizePath(path);
  let lastErr: unknown = null;

  for (const base of SIDECAR_HTTP_BASES) {
    try {
      return await fetch(`${base}${normalized}`, init);
    } catch (err) {
      lastErr = err;
    }
  }

  throw lastErr ?? new Error(`Sidecar unavailable for path ${normalized}`);
}

export async function waitForSidecarReady(timeoutMs = 7000): Promise<string | null> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    for (const base of SIDECAR_HTTP_BASES) {
      try {
        const res = await fetch(`${base}/health`, { cache: 'no-store' });
        if (res.ok) return base;
      } catch { }
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  return null;
}

export async function readResponseError(res: Response): Promise<string> {
  try {
    const asJson = await res.clone().json();
    if (asJson?.error) return String(asJson.error);
  } catch { }
  try {
    const asText = await res.text();
    if (asText?.trim()) return asText.trim();
  } catch { }
  return `${res.status} ${res.statusText}`.trim();
}
