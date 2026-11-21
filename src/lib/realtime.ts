import { useCallback, useEffect, useRef, useState } from 'react';
import {
  getOrderAlertChimeNotes,
  ORDER_SOUND_STORAGE_KEY,
  parseOrderSoundPreference,
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

export function playOrderAlertChime(
  kind: 'new_order' | 'status_update' = 'new_order',
  options?: { force?: boolean }
): boolean {
  if (typeof window === 'undefined') return false;
  if (!options?.force && !isOrderSoundEnabled()) return false;
  try {
    const AudioCtx =
      window.AudioContext ||
      (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
    if (!AudioCtx) return false;
    if (!sharedAudioCtx) {
      sharedAudioCtx = new AudioCtx();
    }
    if (sharedAudioCtx.state === 'suspended') {
      void sharedAudioCtx.resume().catch(() => {});
    }
    const ctx = sharedAudioCtx;
    const now = ctx.currentTime;
    const masterGain = ctx.createGain();
    masterGain.gain.setValueAtTime(0.95, now);
    masterGain.connect(ctx.destination);

    const notes = getOrderAlertChimeNotes(kind);
    notes.forEach((note) => {
      const startAt = now + note.delaySec;
      const stopAt = startAt + note.durationSec + 0.03;

      // Warm fundamental bell tone
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

      // Gentle octave shimmer overtone for a pleasant chime timbre
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
    // ignore autoplay restriction when user hasn't interacted yet
    return false;
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
    pollFallbackMs = 15000,
    onEvent,
    onSync,
  } = options;

  const onEventRef = useRef(onEvent);
  const onSyncRef = useRef(onSync);
  onEventRef.current = onEvent;
  onSyncRef.current = onSync;

  useEffect(() => {
    if (!enabled || typeof window === 'undefined') return;
    if (!token && !orderId) return;

    let disposed = false;
    let ws: WebSocket | null = null;
    let sse: EventSource | null = null;
    let reconnectTimer: ReturnType<typeof setTimeout> | null = null;
    let wsConsecutiveFailures = 0;
    let liveConnected = false;

    const params = new URLSearchParams();
    if (token) params.set('token', token);
    if (orderId) params.set('orderId', String(orderId));
    if (trackingToken) params.set('trackingToken', trackingToken);
    const qs = params.toString();

    const handleMessageText = (raw: string) => {
      try {
        const parsed = JSON.parse(raw) as ClientRealtimeMessage;
        if (parsed && parsed.type && parsed.type !== 'connected') {
          onEventRef.current(parsed);
        }
      } catch {
        // ignore malformed frames
      }
    };

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
      if (wsConsecutiveFailures >= 2) {
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
        const delay = Math.min(8000, 1000 * Math.pow(2, wsConsecutiveFailures));
        reconnectTimer = setTimeout(connectWs, delay);
      };

      ws.onerror = () => {
        // onclose will trigger fallback/reconnect
      };
    };

    connectWs();

    const handleVisibilityOrFocus = () => {
      if (document.visibilityState === 'visible') {
        onSyncRef.current?.();
      }
    };
    window.addEventListener('focus', handleVisibilityOrFocus);
    document.addEventListener('visibilitychange', handleVisibilityOrFocus);

    const syncInterval =
      pollFallbackMs > 0
        ? setInterval(() => {
            if (!liveConnected && document.visibilityState === 'visible') {
              onSyncRef.current?.();
            }
          }, pollFallbackMs)
        : null;

    return () => {
      disposed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (syncInterval) clearInterval(syncInterval);
      window.removeEventListener('focus', handleVisibilityOrFocus);
      document.removeEventListener('visibilitychange', handleVisibilityOrFocus);
      if (ws) {
        try {
          ws.close();
        } catch {
          // ignore
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
