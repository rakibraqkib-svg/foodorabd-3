import { createRoot } from 'react-dom/client';
import App from './App.tsx';
import './index.css';

const GMP_BLOCK_KEY = 'foodora_gmp_quota_blocked_until';

function markGoogleMapsBlocked(kind: 'quota' | 'auth') {
  (window as unknown as { __foodoraGmpBlocked?: boolean }).__foodoraGmpBlocked = true;
  try {
    sessionStorage.setItem(GMP_BLOCK_KEY, String(Date.now() + 30 * 60 * 1000));
  } catch {
    // ignore private storage restrictions
  }
  window.dispatchEvent(new CustomEvent(kind === 'quota' ? 'gmp-quota-exceeded' : 'gm_authFailure'));
}

// Google Maps Platform Quota / Auth failure global listeners
(window as unknown as { gm_authFailure?: () => void }).gm_authFailure = () => {
  markGoogleMapsBlocked('auth');
};

const origError = console.error;
console.error = (...args: unknown[]) => {
  origError.apply(console, args);
  const msg = args.map((a) => String(a)).join(' ');
  if (msg.includes('OverQuotaMapError') || msg.includes('QuotaExceededError')) {
    markGoogleMapsBlocked('quota');
  } else if (
    msg.includes('ApiNotActivatedMapError') ||
    msg.includes('InvalidKeyMapError') ||
    msg.includes('BillingNotEnabledMapError') ||
    msg.includes('ExpiredKeyMapError') ||
    msg.includes('DeletedApiProjectMapError') ||
    msg.includes('ApiProjectMapError') ||
    msg.includes('RefererNotAllowedMapError')
  ) {
    markGoogleMapsBlocked('auth');
  }
};

window.addEventListener('error', (ev) => {
  const src = String(ev.filename || '');
  const msg = String(ev.message || '');
  if (
    src.includes('maps.googleapis.com') ||
    (msg.includes('IntersectionObserver') && src.includes('maps.googleapis.com'))
  ) {
    ev.preventDefault();
    markGoogleMapsBlocked('auth');
  }
});

window.addEventListener('unhandledrejection', (ev) => {
  const reason = ev.reason;
  const text = `${String(reason?.message || reason || '')} ${String(reason?.stack || '')}`;
  if (
    text.includes('maps.googleapis.com') ||
    text.includes('ApiNotActivatedMapError') ||
    (text.includes('IntersectionObserver') && text.includes('marker'))
  ) {
    ev.preventDefault();
    markGoogleMapsBlocked('auth');
  }
});

createRoot(document.getElementById('root')!).render(<App />);
