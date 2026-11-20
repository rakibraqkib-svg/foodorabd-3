import React, { useEffect, useRef, useState } from 'react';
import {
  AlertCircle,
  Bot,
  Languages,
  Send,
  Sparkles,
  Trash2,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import type { AiHelpLangPreference } from '../lib/marketplace-logic';
import type { Lang } from '../types/marketplace';

interface AiChatMessage {
  id: string;
  role: 'user' | 'assistant';
  text: string;
}

interface AiHelpWidgetProps {
  uiLang: Lang;
  area: string;
  viewType: string;
  activeOrderNumber?: string;
  accentColor?: string;
}

const STARTER_PROMPTS = [
  {
    id: 'unavailable',
    labelEn: 'Why does a restaurant say unavailable?',
    labelBn: 'রেস্টুরেন্ট unavailable দেখায় কেন?',
  },
  {
    id: 'track',
    labelEn: 'How to track rider GPS & ETA?',
    labelBn: 'রাইডার কোথায় আছে ও সময় কীভাবে দেখবো?',
  },
  {
    id: 'map',
    labelEn: 'How to set custom delivery area on map?',
    labelBn: 'ম্যাপে কাস্টম এলাকা কীভাবে সেট করবো?',
  },
  {
    id: 'partner',
    labelEn: 'How to join as Restaurant Partner / Rider?',
    labelBn: 'রেস্টুরেন্ট পার্টনার বা রাইডার জব কীভাবে করবো?',
  },
];

export function AiHelpWidget({
  uiLang,
  area,
  viewType,
  activeOrderNumber,
  accentColor = '#E21B70',
}: AiHelpWidgetProps) {
  const [open, setOpen] = useState(false);
  const [langPref, setLangPref] = useState<AiHelpLangPreference>('auto');
  const [input, setInput] = useState('');
  const [sending, setSending] = useState(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [messages, setMessages] = useState<AiChatMessage[]>([]);
  const listEndRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    if (!open) return;
    listEndRef.current?.scrollIntoView({ behavior: 'smooth' });
  }, [messages, open, sending]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        setOpen(false);
      }
    };
    document.addEventListener('keydown', onKeyDown);
    return () => document.removeEventListener('keydown', onKeyDown);
  }, [open]);

  const sendQuestion = async (rawText: string) => {
    const trimmed = rawText.trim();
    if (!trimmed || sending) return;

    const userMsg: AiChatMessage = {
      id: `u-${Date.now()}`,
      role: 'user',
      text: trimmed,
    };

    const nextHistory = [...messages, userMsg];
    setMessages(nextHistory);
    setInput('');
    setErrorMsg(null);
    setSending(true);

    try {
      const res = await apiFetch<{ reply: string; model?: string }>('/api/ai/help', {
        method: 'POST',
        body: JSON.stringify({
          message: trimmed,
          langPreference: langPref,
          history: messages.slice(-8).map((m) => ({
            role: m.role === 'assistant' ? 'model' : 'user',
            text: m.text,
          })),
          context: {
            area,
            viewType,
            activeOrderNumber,
          },
        }),
      });

      setMessages((prev) => [
        ...prev,
        {
          id: `a-${Date.now()}`,
          role: 'assistant',
          text: res.reply,
        },
      ]);
    } catch (err: unknown) {
      setErrorMsg(
        err instanceof Error
          ? err.message
          : uiLang === 'bn'
          ? 'AI সহায়তা পাওয়া যায়নি। কিছুক্ষণ পর আবার চেষ্টা করুন।'
          : 'Could not reach AI Help right now. Please try again.'
      );
    } finally {
      setSending(false);
    }
  };

  const handleSubmit = (e: React.FormEvent) => {
    e.preventDefault();
    void sendQuestion(input);
  };

  const displayBn = langPref === 'bn' || (langPref === 'auto' && uiLang === 'bn');

  return (
    <>
      {/* Floating AI Help Launcher */}
      {!open && (
        <button
          type="button"
          data-testid="ai-help-launcher"
          onClick={() => setOpen(true)}
          aria-label="Open Bilingual AI Help (Bangla and English)"
          style={{ backgroundColor: accentColor }}
          className="fixed bottom-20 lg:bottom-6 right-4 sm:right-6 z-40 px-3.5 py-2.5 rounded-2xl text-white shadow-xl hover:opacity-95 transition-all inline-flex items-center gap-2 text-xs font-extrabold"
        >
          <Sparkles className="w-4 h-4 shrink-0" />
          <span>{uiLang === 'bn' ? 'AI সহায়তা · বাংলা/EN' : 'AI Help · বাংলা / EN'}</span>
        </button>
      )}

      {/* AI Help Drawer / Popover */}
      {open && (
        <div
          data-testid="ai-help-backdrop"
          onClick={() => setOpen(false)}
          className="fixed inset-0 z-50 bg-black/25 sm:bg-transparent flex items-end justify-end p-3 sm:p-6 pointer-events-auto"
        >
          <section
            data-testid="ai-help-panel"
            aria-label="Foodora BD Bilingual AI Help"
            onClick={(e) => e.stopPropagation()}
            className="bg-white w-full sm:w-[400px] max-h-[82vh] sm:max-h-[600px] rounded-2xl border border-neutral-200 shadow-2xl flex flex-col overflow-hidden"
          >
            {/* Header + Bangla / English / Auto Language Selector */}
            <div
              style={{ backgroundColor: '#2E3138' }}
              className="px-4 py-3 text-white flex items-center justify-between gap-2 shrink-0"
            >
              <div className="flex items-center gap-2 min-w-0">
                <span
                  style={{ backgroundColor: accentColor }}
                  className="w-8 h-8 rounded-xl flex items-center justify-center shrink-0"
                >
                  <Bot className="w-4 h-4 text-white" />
                </span>
                <div className="min-w-0">
                  <h3 className="text-sm font-bold leading-tight truncate">
                    {displayBn ? 'Foodora AI সহায়তা' : 'Foodora AI Help'}
                  </h3>
                  <p className="text-[11px] text-white/75 truncate">
                    {displayBn ? 'বাংলা ও ইংরেজিতে তাৎক্ষণিক সাহায্য' : 'Instant support in বাংলা & English'}
                  </p>
                </div>
              </div>

              <div className="flex items-center gap-1 shrink-0">
                {messages.length > 0 && (
                  <button
                    type="button"
                    onClick={() => {
                      setMessages([]);
                      setErrorMsg(null);
                    }}
                    aria-label="Clear chat"
                    title={displayBn ? 'চ্যাট মুছুন' : 'Clear chat'}
                    className="p-1.5 rounded-lg text-white/75 hover:text-white hover:bg-white/10"
                  >
                    <Trash2 className="w-3.5 h-3.5" />
                  </button>
                )}
                <button
                  type="button"
                  onClick={() => setOpen(false)}
                  aria-label="Close AI Help"
                  className="p-1.5 rounded-lg text-white/80 hover:text-white hover:bg-white/10"
                >
                  <X className="w-4 h-4" />
                </button>
              </div>
            </div>

            {/* Language Mode Bar */}
            <div className="px-3.5 py-2 bg-[#FAFAFB] border-b border-neutral-200 flex items-center justify-between gap-2 text-[11px] shrink-0">
              <span className="inline-flex items-center gap-1 font-semibold text-neutral-600">
                <Languages className="w-3.5 h-3.5 text-[#E21B70]" />
                <span>{displayBn ? 'উত্তরের ভাষা:' : 'Reply Language:'}</span>
              </span>
              <div
                role="group"
                aria-label="AI Help reply language"
                className="inline-flex rounded-lg border border-neutral-200 bg-white p-0.5"
              >
                {(
                  [
                    { key: 'auto', label: 'Auto' },
                    { key: 'bn', label: 'বাংলা' },
                    { key: 'en', label: 'EN' },
                  ] as const
                ).map((opt) => (
                  <button
                    key={opt.key}
                    type="button"
                    onClick={() => setLangPref(opt.key)}
                    className={`px-2 py-0.5 rounded-md font-bold transition-colors ${
                      langPref === opt.key
                        ? 'bg-[#E21B70] text-white'
                        : 'text-neutral-600 hover:text-[#2E3138]'
                    }`}
                  >
                    {opt.label}
                  </button>
                ))}
              </div>
            </div>

            {/* Messages Area */}
            <div className="flex-1 overflow-y-auto p-3.5 space-y-3 bg-[#FAFAFB]">
              {messages.length === 0 ? (
                <div className="space-y-3">
                  <div className="p-3 rounded-xl bg-white border border-neutral-200 text-xs text-neutral-700 leading-relaxed space-y-1">
                    <p className="font-bold text-[#2E3138]">
                      {displayBn
                        ? 'স্বাগতম! আমি কীভাবে সাহায্য করতে পারি?'
                        : 'Hello! How can I help you with Foodora BD?'}
                    </p>
                    <p className="text-[11px] text-neutral-500">
                      {displayBn
                        ? 'অর্ডার, রেস্টুরেন্ট বন্ধ থাকা, লাইভ রাইডার ট্র্যাকিং, ম্যাপ, পেমেন্ট বা পার্টনার অ্যাকাউন্ট নিয়ে বাংলা বা ইংরেজিতে যেকোনো প্রশ্ন করুন।'
                        : 'Ask in Bangla or English about ordering, unavailable restaurants, live rider GPS/ETA, map locations, payments, or partner/rider portals.'}
                    </p>
                  </div>

                  <div className="space-y-1.5">
                    <p className="text-[11px] font-bold text-neutral-500 px-0.5">
                      {displayBn ? 'জনপ্রিয় প্রশ্ন:' : 'Quick Help Questions:'}
                    </p>
                    <div className="flex flex-col gap-1.5">
                      {STARTER_PROMPTS.map((q) => {
                        const text = displayBn ? q.labelBn : q.labelEn;
                        return (
                          <button
                            key={q.id}
                            type="button"
                            onClick={() => void sendQuestion(text)}
                            className="text-left px-3 py-2 rounded-xl bg-white border border-neutral-200 hover:border-[#E21B70] hover:bg-[#FFF0F6]/50 text-xs font-semibold text-[#2E3138] transition-colors"
                          >
                            {text}
                          </button>
                        );
                      })}
                    </div>
                  </div>
                </div>
              ) : (
                messages.map((m) => (
                  <div
                    key={m.id}
                    className={`flex ${m.role === 'user' ? 'justify-end' : 'justify-start'}`}
                  >
                    <div
                      className={`max-w-[85%] rounded-2xl px-3.5 py-2.5 text-xs leading-relaxed whitespace-pre-wrap ${
                        m.role === 'user'
                          ? 'bg-[#E21B70] text-white rounded-br-sm'
                          : 'bg-white border border-neutral-200 text-[#2E3138] rounded-bl-sm shadow-2xs'
                      }`}
                    >
                      {m.text}
                    </div>
                  </div>
                ))
              )}

              {sending && (
                <div className="flex justify-start">
                  <div className="px-3.5 py-2.5 rounded-2xl rounded-bl-sm bg-white border border-neutral-200 text-xs text-neutral-500">
                    {displayBn ? 'উত্তর লিখছি...' : 'Thinking...'}
                  </div>
                </div>
              )}

              {errorMsg && (
                <div
                  role="alert"
                  className="p-2.5 rounded-xl bg-red-50 border border-red-200 text-xs text-red-700 flex items-start gap-2"
                >
                  <AlertCircle className="w-4 h-4 shrink-0 mt-0.5" />
                  <span>{errorMsg}</span>
                </div>
              )}

              <div ref={listEndRef} />
            </div>

            {/* Composer */}
            <form
              onSubmit={handleSubmit}
              className="p-2.5 bg-white border-t border-neutral-200 flex items-center gap-2 shrink-0"
            >
              <input
                type="text"
                value={input}
                onChange={(e) => setInput(e.target.value)}
                placeholder={
                  displayBn
                    ? 'বাংলা বা ইংরেজিতে প্রশ্ন লিখুন...'
                    : 'Ask in Bangla or English...'
                }
                className="flex-1 min-w-0 px-3 py-2 rounded-xl border border-neutral-200 text-xs focus:outline-none focus:border-[#E21B70]"
              />
              <button
                type="submit"
                disabled={sending || !input.trim()}
                aria-label="Send help question"
                style={{ backgroundColor: accentColor }}
                className="px-3 py-2 rounded-xl text-white text-xs font-bold inline-flex items-center gap-1 disabled:opacity-40 shrink-0"
              >
                <Send className="w-3.5 h-3.5" />
                <span>{displayBn ? 'পাঠান' : 'Send'}</span>
              </button>
            </form>
          </section>
        </div>
      )}
    </>
  );
}
