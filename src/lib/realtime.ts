import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getOrderAlertChimeNotes,
  ORDER_SOUND_STORAGE_KEY,
  parseOrderSoundPreference,
  shouldPlayDedupedOrderChime,
} from './marketplace-logic';

export interface ClientRealtimeMessage {
  type:
    | 'connected'
    | 'order:created'
    | 'order:updated'
    | 'rider:location'
    | 'notification:created';
  payload: Record<string, any>;
  ts?: number;
}

const ORDER_SOUND_CHANGED_EVENT = 'foodora:order-sound-changed';
const AUDIO_UNLOCK_STATE_EVENT = 'foodora:audio-unlock-state';
const LOCAL_REALTIME_CHANNEL = 'foodora_bd_realtime_v1';
const LOCAL_REALTIME_STORAGE_KEY = 'foodora_bd_realtime_ping_v1';

export function isOrderSoundEnabled(): boolean {
  if (typeof window === 'undefined') return true;
  try {
    return parseOrderSoundPreference(window.localStorage.getItem(ORDER_SOUND_STORAGE_KEY));
  } catch {
    return true;
  }
}

export function setOrderSoundEnabled(enabled: boolean): void {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(ORDER_SOUND_STORAGE_KEY, enabled ? 'true' : 'false');
    window.dispatchEvent(new CustomEvent<boolean>(ORDER_SOUND_CHANGED_EVENT, { detail: enabled }));
  } catch {
    // ignore storage errors
  }
}

export function useOrderSoundSetting(): [boolean, (next: boolean) => void] {
  const [enabled, setEnabledState] = useState<boolean>(() => isOrderSoundEnabled());

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handleCustom = (ev: Event) => {
      const detail = (ev as CustomEvent<boolean>).detail;
      setEnabledState(typeof detail === 'boolean' ? detail : isOrderSoundEnabled());
    };
    const handleStorage = (ev: StorageEvent) => {
      if (ev.key === null || ev.key === ORDER_SOUND_STORAGE_KEY) {
        setEnabledState(isOrderSoundEnabled());
      }
    };
    window.addEventListener(ORDER_SOUND_CHANGED_EVENT, handleCustom);
    window.addEventListener('storage', handleStorage);
    return () => {
      window.removeEventListener(ORDER_SOUND_CHANGED_EVENT, handleCustom);
      window.removeEventListener('storage', handleStorage);
    };
  }, []);

  const updateEnabled = useCallback((next: boolean) => {
    setEnabledState(next);
    setOrderSoundEnabled(next);
  }, []);

  return [enabled, updateEnabled];
}

let sharedAudioCtx: AudioContext | null = null;
let audioUnlockInstalled = false;
let pendingBlockedChime: 'new_order' | 'status_update' | null = null;
let audioUnlockRequired = false;
const orderChimeDedupCache = new Map<string, number>();

function notifyAudioUnlockState(needed: boolean) {
  audioUnlockRequired = needed;
  if (typeof window !== 'undefined') {
    window.dispatchEvent(new CustomEvent<boolean>(AUDIO_UNLOCK_STATE_EVENT, { detail: needed }));
  }
}

function ensureAudioContext(): AudioContext | null {
  if (typeof window === 'undefined') return null;
  const AudioCtx =
    window.AudioContext ||
    (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
  if (!AudioCtx) return null;
  if (!sharedAudioCtx) {
    sharedAudioCtx = new AudioCtx();
  }
  return sharedAudioCtx;
}

function warmUpAudioContext(ctx: AudioContext): void {
  try {
    const buffer = ctx.createBuffer(1, 1, 22050);
    const source = ctx.createBufferSource();
    source.buffer = buffer;
    source.connect(ctx.destination);
    source.start(0);
  } catch {
    // ignore warm-up errors
  }
}

function installGlobalAudioUnlocker(): void {
  if (typeof window === 'undefined' || audioUnlockInstalled) return;
  audioUnlockInstalled = true;
  const unlock = async () => {
    try {
      const ctx = ensureAudioContext();
      if (!ctx) return;
      if (ctx.state === 'suspended') {
        await ctx.resume().catch(() => {});
      }
      if (ctx.state === 'running') {
        warmUpAudioContext(ctx);
        if (audioUnlockRequired) {
          notifyAudioUnlockState(false);
        }
        if (pendingBlockedChime) {
          const kind = pendingBlockedChime;
          pendingBlockedChime = null;
          void playOrderAlertChime(kind, { force: true });
        }
      }
    } catch {
      // ignore
    }
  };
  window.addEventListener('pointerdown', unlock, { passive: true });
  window.addEventListener('mousedown', unlock, { passive: true });
  window.addEventListener('touchstart', unlock, { passive: true });
  window.addEventListener('keydown', unlock, { passive: true });
  window.addEventListener('click', unlock, { passive: true });
}

if (typeof window !== 'undefined') {
  installGlobalAudioUnlocker();
}

export function useAudioUnlockPrompt(): {
  needsUnlock: boolean;
  unlockAudio: () => Promise<boolean>;
} {
  const [needsUnlock, setNeedsUnlock] = useState<boolean>(() => audioUnlockRequired);

  useEffect(() => {
    if (typeof window === 'undefined') return;
    const handler = (ev: Event) => {
      const detail = (ev as CustomEvent<boolean>).detail;
      setNeedsUnlock(Boolean(detail));
    };
    window.addEventListener(AUDIO_UNLOCK_STATE_EVENT, handler);
    return () => window.removeEventListener(AUDIO_UNLOCK_STATE_EVENT, handler);
  }, []);

  const unlockAudio = useCallback(async () => {
    const kind = pendingBlockedChime || 'new_order';
    pendingBlockedChime = null;
    notifyAudioUnlockState(false);
    return playOrderAlertChime(kind, { force: true });
  }, []);

  return { needsUnlock, unlockAudio };
}

export async function playOrderAlertChime(
  kind: 'new_order' | 'status_update' = 'new_order',
  options?: { force?: boolean; dedupKey?: string }
): Promise<boolean> {
  if (typeof window === 'undefined') return false;
  if (!options?.force && !isOrderSoundEnabled()) return false;
  if (
    options?.dedupKey &&
    !shouldPlayDedupedOrderChime(options.dedupKey, orderChimeDedupCache, Date.now(), 4000)
  ) {
    return false;
  }
  try {
    installGlobalAudioUnlocker();
    const ctx = ensureAudioContext();
    if (!ctx) return false;
    if (ctx.state === 'suspended') {
      await ctx.resume().catch(() => {});
    }
    if (ctx.state !== 'running') {
      pendingBlockedChime = kind;
      notifyAudioUnlockState(true);
      return false;
    }
    if (audioUnlockRequired) {
      notifyAudioUnlockState(false);
    }

    const now = ctx.currentTime + 0.01;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.95, now);
    masterGain.connect(ctx.destination);

    const notes = getOrderAlertChimeNotes(kind);
    notes.forEach((note) => {
      const startAt = now + note.delaySec;
      const stopAt = startAt + note.durationSec + 0.03;

      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.type = 'sine';
      osc.frequency.setValueAtTime(note.freq, startAt);
      gain.gain.setValueAtTime(0.0001, startAt);
      gain.gain.exponentialRampToValueAtTime(note.gain, startAt + 0.014);
      gain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.durationSec);
      osc.connect(gain);
      gain.connect(masterGain);
      osc.start(startAt);
      osc.stop(stopAt);

      if (note.harmonicRatio && note.harmonicGain) {
        const overtone = ctx.createOscillator();
        const overtoneGain = ctx.createGain();
        overtone.type = 'triangle';
        overtone.frequency.setValueAtTime(note.freq * note.harmonicRatio, startAt);
        overtoneGain.gain.setValueAtTime(0.0001, startAt);
        overtoneGain.gain.exponentialRampToValueAtTime(note.harmonicGain, startAt + 0.01);
        overtoneGain.gain.exponentialRampToValueAtTime(0.0001, startAt + note.durationSec * 0.65);
        overtone.connect(overtoneGain);
        overtoneGain.connect(masterGain);
        overtone.start(startAt);
        overtone.stop(stopAt);
      }
    });
    return true;
  } catch {
    pendingBlockedChime = kind;
    notifyAudioUnlockState(true);
    return false;
  }
}

export function emitLocalRealtimeSignal(
  type: ClientRealtimeMessage['type'],
  payload: Record<string, any>
): void {
  if (typeof window === 'undefined') return;
  const msg: ClientRealtimeMessage = { type, payload, ts: Date.now() };
  try {
    if (typeof BroadcastChannel !== 'undefined') {
      const ch = new BroadcastChannel(LOCAL_REALTIME_CHANNEL);
      ch.postMessage(msg);
      ch.close();
    }
  } catch {
    // ignore BroadcastChannel errors
  }
  try {
    window.localStorage.setItem(LOCAL_REALTIME_STORAGE_KEY, JSON.stringify(msg));
  } catch {
    // ignore storage errors
  }
}

export function useRealtimeEvents(options: {
  enabled?: boolean;
  token?: string | null;
  orderId?: number | null;
  trackingToken?: string | null;
  pollFallbackMs?: number;
  onEvent: (event: ClientRealtimeMessage) => void;
  onSync?: () => void;
}) {
  const {
    enabled = true,
    token = null,
    orderId = null,
    trackingToken = null,
    pollFallbackMs = 4000,
    onEvent,
    onSync,
  } = options;

  const onEventRef = useRef(onEvent);
  const onSyncRef = useRef(onSync);
  onEventRef.current = onEvent;
  onSyncRef.current = onSync;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let sse: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let wsConsecutiveFailures = 0;
    let liveConnected = false;

    const dispatchClientMessage = (parsed: ClientRealtimeMessage) => {
      if (parsed && parsed.type && parsed.type !== 'connected') {
        onEventRef.current(parsed);
      }
    };

    const handleMessageText = (raw: string) => {
      try {
        const parsed = JSON.parse(raw) as ClientRealtimeMessage;
        dispatchClientMessage(parsed);
      } catch {
        // ignore malformed frames
      }
    };

    // Only attempt live WebSocket/SSE stream if we have an auth token or watch order
    if (token || orderId || trackingToken) {
      const params = new URLSearchParams();
      if (token) params.set('token', token);
      if (orderId) params.set('orderId', String(orderId));
      if (trackingToken) params.set('trackingToken', trackingToken);
      const qs = params.toString();

      const connectSseFallback = () => {
        if (disposed || sse || typeof EventSource === 'undefined') return;
        sse = new EventSource(`/api/realtime/stream?${qs}`);
        sse.onopen = () => {
          liveConnected = true;
        };
        sse.onmessage = (ev) => {
          handleMessageText(ev.data);
        };
        sse.onerror = () => {
          liveConnected = false;
        };
      };

      const connectWs = () => {
        if (disposed) return;
        // Switch to SSE immediately after first WS close so updates never stall
        if (wsConsecutiveFailures >= 1) {
          connectSseFallback();
          return;
        }
        const wsProto = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        const url = `${wsProto}//${window.location.host}/ws?${qs}`;
        const openedAt = Date.now();
        let opened = false;
        try {
          ws = new WebSocket(url);
        } catch {
          wsConsecutiveFailures += 1;
          connectSseFallback();
          return;
        }

        ws.onopen = () => {
          if (disposed) {
            try {
              ws?.close();
            } catch {
              // ignore
            }
            return;
          }
          opened = true;
          liveConnected = true;
          wsConsecutiveFailures = 0;
        };

        ws.onmessage = (ev) => {
          if (typeof ev.data === 'string') {
            handleMessageText(ev.data);
          }
        };

        ws.onclose = () => {
          liveConnected = false;
          if (disposed) return;
          const lifetime = Date.now() - openedAt;
          if (!opened || lifetime < 1500) {
            wsConsecutiveFailures += 1;
          }
          if (wsConsecutiveFailures >= 1) {
            connectSseFallback();
            return;
          }
          reconnectTimer = setTimeout(connectWs, 1200);
        };

        ws.onerror = () => {
          // onclose will trigger SSE fallback
        };
      };

      connectWs();
    }

    // Instant cross-tab local sync (e.g., Customer tab -> Admin/Vendor tab in same browser)
    let bc: BroadcastChannel | null = null;
    try {
      if (typeof BroadcastChannel !== 'undefined') {
        bc = new BroadcastChannel(LOCAL_REALTIME_CHANNEL);
        bc.onmessage = (ev) => {
          if (!disposed && ev.data) {
            dispatchClientMessage(ev.data as ClientRealtimeMessage);
          }
        };
      }
    } catch {
      // ignore
    }

    const handleStorageSync = (ev: StorageEvent) => {
      if (!disposed && ev.key === LOCAL_REALTIME_STORAGE_KEY && ev.newValue) {
        handleMessageText(ev.newValue);
      }
    };
    window.addEventListener('storage', handleStorageSync);

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        onSyncRef.current?.();
      }
    };
    window.addEventListener('focus', handleVisibilityOrFocus);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);

    // Continuous fast polling safety net so all screens auto-update without manual browser reload
    const effectiveInterval = Math.max(3000, pollFallbackMs);
    let ticks = 0;
    const syncInterval =
      pollFallbackMs > 0
        ? setInterval(() => {
            if (document.visibilityState !== 'visible') return;
            ticks += 1;
            onSyncRef.current?.();
          }, effectiveInterval)
        : null;

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (syncInterval) clearInterval(syncInterval);
      window.removeEventListener('storage', handleStorageSync);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      if (bc) {
        try {
          bc.close();
        } catch {
          // ignore
        }
      }
      if (ws) {
        const socketToClose = ws;
        socketToClose.onmessage = null;
        socketToClose.onerror = null;
        socketToClose.onclose = null;
        if (socketToClose.readyState === WebSocket.OPEN) {
          try {
            socketToClose.close();
          } catch {
            // ignore
          }
        } else if (socketToClose.readyState === WebSocket.CONNECTING) {
          // Avoid Chromium "WebSocket is closed before the connection is established" warning
          socketToClose.onopen = () => {
            try {
              socketToClose.close();
            } catch {
              // ignore
            }
          };
        }
      }
      if (sse) {
        try {
          sse.close();
        } catch {
          // ignore
        }
      }
    };
  }, [enabled, token, orderId, trackingToken, pollFallbackMs]);
}
