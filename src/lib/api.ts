import { isSandboxAuthToken, shouldPersistAuthToken } from './marketplace-logic';

const TOKEN_STORAGE_KEY = 'foodora_bd_auth_token_v1';

let activeToken: string | null = (() => {
  try {
    if (typeof window === 'undefined') return null;
    const saved = localStorage.getItem(TOKEN_STORAGE_KEY);
    if (saved && isSandboxAuthToken(saved)) {
      localStorage.removeItem(TOKEN_STORAGE_KEY);
      return null;
    }
    return saved;
  } catch {
    return null;
  }
})();

export function setAuthToken(token: string | null, persist = true) {
  activeToken = token;
  try {
    if (typeof window !== 'undefined') {
      if (token && persist && shouldPersistAuthToken(token)) {
        localStorage.setItem(TOKEN_STORAGE_KEY, token);
      } else {
        localStorage.removeItem(TOKEN_STORAGE_KEY);
      }
    }
  } catch {
    // ignore storage errors
  }
}

export function getAuthToken(): string | null {
  return activeToken;
}

export async function apiFetch<T>(url: string, options: RequestInit = {}): Promise<T> {
  const headers = new Headers(options.headers || {});
  if (!headers.has('Content-Type') && options.body) {
    headers.set('Content-Type', 'application/json');
  }
  if (activeToken) {
    headers.set('Authorization', `Bearer ${activeToken}`);
  }

  const res = await fetch(url, {
    ...options,
    headers,
  });

  const rawText = await res.text().catch(() => '');
  let data: Record<string, any> = {};
  if (rawText) {
    try {
      data = JSON.parse(rawText);
    } catch {
      data = {};
    }
  }

  if (!res.ok) {
    const snippet = rawText && !rawText.trim().startsWith('<') ? rawText.trim().slice(0, 180) : '';
    throw new Error(data.error || snippet || `Request failed (${res.status})`);
  }
  return data as T;
}
