import React, { createContext, useCallback, useContext, useEffect, useState } from 'react';
import { isEmbeddedIframe, supabase, SUPABASE_PUBLIC_CONFIG } from '../lib/supabase';
import { apiFetch, getAuthToken, setAuthToken } from '../lib/api';
import { isSandboxAuthToken } from '../lib/marketplace-logic';
import type { AppUser } from '../types/marketplace';

interface AuthContextValue {
  user: AppUser | null;
  loading: boolean;
  error: string | null;
  googleRedirectUrl: string | null;
  clearError: () => void;
  clearGoogleRedirectUrl: () => void;
  signInWithGoogle: () => Promise<boolean>;
  signInWithEmail: (email: string, password: string) => Promise<AppUser>;
  registerWithEmail: (
    fullName: string,
    email: string,
    password: string,
    role?: 'customer' | 'restaurant_owner' | 'rider'
  ) => Promise<AppUser>;
  unlockAdminWithPin: (pin: string, email?: string) => Promise<AppUser>;
  requestPasswordReset: (email: string) => Promise<{
    ok: boolean;
    mode: string;
    isAdminAccount?: boolean;
    previewCode?: string;
    message: string;
  }>;
  confirmPasswordReset: (email: string, code: string, newPassword: string) => Promise<AppUser>;
  passwordRecoveryPending: boolean;
  completeSupabasePasswordRecovery: (newPassword: string) => Promise<void>;
  dismissPasswordRecovery: () => void;
  signInSandboxPersona: (role: 'customer' | 'restaurant_owner' | 'rider') => Promise<AppUser>;
  signOut: () => Promise<void>;
  refreshUser: () => Promise<void>;
}

const SIGNED_OUT_FLAG = 'foodora_bd_signed_out_v1';

const AuthContext = createContext<AuthContextValue | null>(null);

function formatSupabaseAuthError(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err || '');
  const lower = msg.toLowerCase();
  if (lower.includes('provider is not enabled') || lower.includes('unsupported provider')) {
    return 'Google provider is not enabled yet in Supabase Authentication -> Providers -> Google.';
  }
  if (lower.includes('redirect') || lower.includes('url')) {
    return `${msg} Add ${typeof window !== 'undefined' ? window.location.origin : 'your domain'} to Supabase Authentication -> URL Configuration -> Redirect URLs.`;
  }
  return msg || 'Sign-in failed. Please try Email & Password below.';
}

export function AuthProvider({ children }: { children: React.ReactNode }) {
  const [user, setUser] = useState<AppUser | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [googleRedirectUrl, setGoogleRedirectUrl] = useState<string | null>(null);
  const [passwordRecoveryPending, setPasswordRecoveryPending] = useState(false);

  const clearError = useCallback(() => setError(null), []);
  const clearGoogleRedirectUrl = useCallback(() => setGoogleRedirectUrl(null), []);

  const syncTokenWithBackend = useCallback(async (accessToken: string): Promise<AppUser> => {
    setAuthToken(accessToken);
    try {
      sessionStorage.removeItem(SIGNED_OUT_FLAG);
    } catch {
      // ignore
    }
    const res = await apiFetch<{ user: AppUser }>('/api/auth/sync', { method: 'POST' });
    setUser(res.user);
    return res.user;
  }, []);

  useEffect(() => {
    let mounted = true;

    async function bootstrapSession() {
      let hasOAuthCallbackParams = false;
      try {
        if (typeof window !== 'undefined') {
          const searchParams = new URLSearchParams(window.location.search);
          const hashParams = new URLSearchParams(window.location.hash.replace(/^#/, ''));
          hasOAuthCallbackParams = Boolean(
            searchParams.get('code') ||
              hashParams.get('access_token') ||
              searchParams.get('type') === 'recovery' ||
              hashParams.get('type') === 'recovery'
          );
          const oauthErrDesc =
            searchParams.get('error_description') ||
            hashParams.get('error_description') ||
            searchParams.get('error') ||
            hashParams.get('error');
          if (oauthErrDesc) {
            setError(formatSupabaseAuthError(oauthErrDesc));
            window.history.replaceState({}, document.title, window.location.pathname);
          }
        }
      } catch (err) {
        console.warn('OAuth callback URL parse failed:', err);
      }

      // 1. Respect explicit sign-out unless user just returned from an OAuth callback
      let explicitlySignedOut = false;
      try {
        explicitlySignedOut = sessionStorage.getItem(SIGNED_OUT_FLAG) === '1';
      } catch {
        explicitlySignedOut = false;
      }
      if (explicitlySignedOut && !hasOAuthCallbackParams) {
        if (mounted) {
          setUser(null);
          setLoading(false);
        }
        return;
      }

      // 2. If user is not mid-OAuth-callback and has a saved real email/password (fbd.) token, restore it FIRST
      const savedToken = getAuthToken();
      if (!hasOAuthCallbackParams && savedToken && !isSandboxAuthToken(savedToken)) {
        try {
          const res = await apiFetch<{ user: AppUser }>('/api/auth/sync', { method: 'POST' });
          if (res.user && !res.user.isSandbox) {
            if (mounted) {
              setUser(res.user);
              setLoading(false);
            }
            return;
          }
          setAuthToken(null);
        } catch {
          setAuthToken(null);
        }
      } else if (savedToken && isSandboxAuthToken(savedToken)) {
        // Never auto-restore demo/sandbox tokens across page loads
        setAuthToken(null);
      }

      // 3. Check active Supabase OAuth / session (e.g., fresh Google OAuth login or saved Google session)
      try {
        const { data: sessionData } = await supabase.auth.getSession();
        const supaToken = sessionData.session?.access_token;
        if (supaToken) {
          await syncTokenWithBackend(supaToken);
          if (typeof window !== 'undefined' && window.location.search.includes('code=')) {
            window.history.replaceState({}, document.title, window.location.pathname);
          }
          if (mounted) setLoading(false);
          return;
        }
      } catch (err) {
        console.warn('Supabase session check failed:', err);
      }

      // 4. Start as Guest when no real session exists (never auto-login demo accounts)
      if (mounted) {
        setUser(null);
        setLoading(false);
      }
    }

    bootstrapSession();

    const { data: authListener } = supabase.auth.onAuthStateChange(async (event, session) => {
      if (!mounted) return;
      if (event === 'PASSWORD_RECOVERY') {
        setPasswordRecoveryPending(true);
      }
      // Do not overwrite an active local email/PIN/sandbox token with background Supabase token refreshes
      const currentToken = getAuthToken();
      if (
        event !== 'PASSWORD_RECOVERY' &&
        currentToken &&
        (currentToken.startsWith('fbd.') || currentToken.startsWith('sbx.'))
      ) {
        return;
      }
      if (
        session?.access_token &&
        (event === 'SIGNED_IN' || event === 'TOKEN_REFRESHED' || event === 'PASSWORD_RECOVERY')
      ) {
        try {
          await syncTokenWithBackend(session.access_token);
          setGoogleRedirectUrl(null);
        } catch (err) {
          console.error('Supabase user sync failed:', err);
        } finally {
          if (mounted) setLoading(false);
        }
      }
    });

    return () => {
      mounted = false;
      authListener.subscription.unsubscribe();
    };
  }, [syncTokenWithBackend]);

  const signInWithGoogle = useCallback(async (): Promise<boolean> => {
    setError(null);
    setGoogleRedirectUrl(null);
    try {
      // Pre-check if Google provider is enabled in Supabase project to prevent 400 Unsupported Provider page
      try {
        const settingsRes = await fetch(`${SUPABASE_PUBLIC_CONFIG.url}/auth/v1/settings`, {
          headers: { apikey: SUPABASE_PUBLIC_CONFIG.anonKey },
        });
        if (settingsRes.ok) {
          const settings = await settingsRes.json();
          if (settings?.external?.google === false) {
            setError(
              'Google provider is not enabled yet in your Supabase project (Authentication -> Providers -> Google). Please use Email & Password below to create an account or sign in.'
            );
            return false;
          }
        }
      } catch {
        // Continue if settings fetch is blocked
      }

      const redirectTo = typeof window !== 'undefined' ? window.location.origin : undefined;
      const embedded = isEmbeddedIframe();

      const { data, error: oauthErr } = await supabase.auth.signInWithOAuth({
        provider: 'google',
        options: {
          redirectTo,
          queryParams: {
            access_type: 'offline',
            prompt: 'select_account',
          },
          skipBrowserRedirect: embedded,
        },
      });

      if (oauthErr) {
        setError(formatSupabaseAuthError(oauthErr));
        return false;
      }

      if (embedded && data?.url) {
        // Inside an iframe, Google blocks X-Frame-Options: DENY; show direct top-level link
        setGoogleRedirectUrl(data.url);
        return false;
      }

      // On Vercel / top-level browser tab, Supabase navigates to Google OAuth cleanly
      return true;
    } catch (err: unknown) {
      setError(formatSupabaseAuthError(err));
      return false;
    }
  }, []);

  const signInWithEmail = useCallback(async (email: string, password: string): Promise<AppUser> => {
    setError(null);
    try {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      const res = await apiFetch<{ token: string; user: AppUser }>('/api/auth/login', {
        method: 'POST',
        body: JSON.stringify({ email, password }),
      });
      try {
        sessionStorage.removeItem(SIGNED_OUT_FLAG);
      } catch {
        // ignore
      }
      setAuthToken(res.token);
      setUser(res.user);
      return res.user;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Login failed';
      setError(msg);
      throw err;
    }
  }, []);

  const registerWithEmail = useCallback(
    async (
      fullName: string,
      email: string,
      password: string,
      role: 'customer' | 'restaurant_owner' | 'rider' = 'customer'
    ): Promise<AppUser> => {
      setError(null);
      try {
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
        const res = await apiFetch<{ token: string; user: AppUser }>('/api/auth/register', {
          method: 'POST',
          body: JSON.stringify({ fullName, email, password, role }),
        });
        try {
          sessionStorage.removeItem(SIGNED_OUT_FLAG);
        } catch {
          // ignore
        }
        setAuthToken(res.token);
        setUser(res.user);
        return res.user;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Registration failed';
        setError(msg);
        throw err;
      }
    },
    []
  );

  const unlockAdminWithPin = useCallback(async (pin: string, email?: string): Promise<AppUser> => {
    setError(null);
    try {
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      const res = await apiFetch<{ token: string; user: AppUser }>('/api/auth/admin-pin', {
        method: 'POST',
        body: JSON.stringify({ pin, email: email?.trim() || undefined }),
      });
      try {
        sessionStorage.removeItem(SIGNED_OUT_FLAG);
      } catch {
        // ignore
      }
      setAuthToken(res.token);
      setUser(res.user);
      return res.user;
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Admin PIN verification failed';
      setError(msg);
      throw err;
    }
  }, []);

  const requestPasswordReset = useCallback(async (email: string) => {
    setError(null);
    try {
      const redirectTo = typeof window !== 'undefined' ? window.location.origin : undefined;
      return await apiFetch<{
        ok: boolean;
        mode: string;
        isAdminAccount?: boolean;
        previewCode?: string;
        message: string;
      }>('/api/auth/forgot-password', {
        method: 'POST',
        body: JSON.stringify({ email, redirectTo }),
      });
    } catch (err: unknown) {
      const msg = err instanceof Error ? err.message : 'Failed to request password reset';
      setError(msg);
      throw err;
    }
  }, []);

  const confirmPasswordReset = useCallback(
    async (email: string, code: string, newPassword: string): Promise<AppUser> => {
      setError(null);
      try {
        await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
        const res = await apiFetch<{ ok: boolean; token: string; user: AppUser }>(
          '/api/auth/reset-password',
          {
            method: 'POST',
            body: JSON.stringify({ email, code, newPassword }),
          }
        );
        try {
          sessionStorage.removeItem(SIGNED_OUT_FLAG);
        } catch {
          // ignore
        }
        setAuthToken(res.token);
        setUser(res.user);
        return res.user;
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : 'Password reset failed';
        setError(msg);
        throw err;
      }
    },
    []
  );

  const completeSupabasePasswordRecovery = useCallback(async (newPassword: string) => {
    setError(null);
    const { error: updErr } = await supabase.auth.updateUser({ password: newPassword });
    if (updErr) {
      setError(updErr.message);
      throw updErr;
    }
    try {
      await apiFetch('/api/auth/sync-password', {
        method: 'POST',
        body: JSON.stringify({ newPassword }),
      });
    } catch {
      // non-fatal
    }
    setPasswordRecoveryPending(false);
  }, []);

  const dismissPasswordRecovery = useCallback(() => {
    setPasswordRecoveryPending(false);
  }, []);

  const signInSandboxPersona = useCallback(
    async (role: 'customer' | 'restaurant_owner' | 'rider') => {
      setError(null);
      await supabase.auth.signOut({ scope: 'local' }).catch(() => {});
      try {
        sessionStorage.removeItem(SIGNED_OUT_FLAG);
      } catch {
        // ignore
      }
      const res = await apiFetch<{ token: string; user: AppUser }>('/api/auth/sandbox-session', {
        method: 'POST',
        body: JSON.stringify({ role }),
      });
      // Keep demo sandbox sessions in memory only so revisiting/reloading starts logged out
      setAuthToken(res.token, false);
      setUser(res.user);
      return res.user;
    },
    []
  );

  const signOut = useCallback(async () => {
    setError(null);
    setGoogleRedirectUrl(null);
    try {
      sessionStorage.setItem(SIGNED_OUT_FLAG, '1');
    } catch {
      // ignore
    }
    setAuthToken(null);
    setUser(null);
    try {
      await supabase.auth.signOut();
    } catch {
      // ignore
    }
  }, []);

  const refreshUser = useCallback(async () => {
    const res = await apiFetch<{ user: AppUser }>('/api/auth/sync', { method: 'POST' });
    setUser(res.user);
  }, []);

  return (
    <AuthContext.Provider
      value={{
        user,
        loading,
        error,
        googleRedirectUrl,
        clearError,
        clearGoogleRedirectUrl,
        signInWithGoogle,
        signInWithEmail,
        registerWithEmail,
        unlockAdminWithPin,
        requestPasswordReset,
        confirmPasswordReset,
        passwordRecoveryPending,
        completeSupabasePasswordRecovery,
        dismissPasswordRecovery,
        signInSandboxPersona,
        signOut,
        refreshUser,
      }}
    >
      {children}
    </AuthContext.Provider>
  );
}

export function useAuth() {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
