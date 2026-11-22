import React, { useEffect, useMemo, useState } from 'react';
import { Plus } from 'lucide-react';
import {
  mergeCustomSelectOptions,
  normalizeCustomOptionValue,
  type SelectOptionItem,
} from '../lib/marketplace-logic';
import type { Lang } from '../types/marketplace';

interface SelectWithCustomProps {
  value: string;
  onChange: (nextValue: string) => void;
  presets: readonly SelectOptionItem[];
  storageKey: string;
  lang: Lang;
  ariaLabel?: string;
  placeholder?: string;
  customOptionLabel?: string;
  addButtonLabel?: string;
  required?: boolean;
  className?: string;
  selectClassName?: string;
  inputClassName?: string;
  onSelectPreset?: (value: string) => void;
  onAddCustom?: (value: string) => void;
}

const CUSTOM_SENTINEL = '__custom__';

function readStoredCustomOptions(storageKey: string): string[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(`foodora_custom_opts_${storageKey}`);
    if (!raw) return [];
    const parsed = JSON.parse(raw);
    return Array.isArray(parsed)
      ? parsed.map((v) => normalizeCustomOptionValue(String(v))).filter(Boolean)
      : [];
  } catch {
    return [];
  }
}

function writeStoredCustomOptions(storageKey: string, values: string[]) {
  if (typeof window === 'undefined') return;
  try {
    window.localStorage.setItem(`foodora_custom_opts_${storageKey}`, JSON.stringify(values));
  } catch {
    // ignore storage quota errors
  }
}

export function SelectWithCustom({
  value,
  onChange,
  presets,
  storageKey,
  lang,
  ariaLabel,
  placeholder,
  customOptionLabel,
  addButtonLabel,
  required = false,
  className = '',
  selectClassName = '',
  inputClassName = '',
  onSelectPreset,
  onAddCustom,
}: SelectWithCustomProps) {
  const [savedCustomValues, setSavedCustomValues] = useState<string[]>(() =>
    readStoredCustomOptions(storageKey)
  );
  const [customMode, setCustomMode] = useState(false);
  const [draftCustom, setDraftCustom] = useState('');

  useEffect(() => {
    setSavedCustomValues(readStoredCustomOptions(storageKey));
  }, [storageKey]);

  const knownOptions = useMemo(
    () => mergeCustomSelectOptions(presets, savedCustomValues),
    [presets, savedCustomValues]
  );

  const valueInKnown = useMemo(() => {
    const clean = normalizeCustomOptionValue(value).toLowerCase();
    return Boolean(clean && knownOptions.some((opt) => opt.value.toLowerCase() === clean));
  }, [value, knownOptions]);

  const showCustomInput = customMode || !valueInKnown;

  const matchedSelectValue = useMemo(() => {
    if (customMode || !valueInKnown) return CUSTOM_SENTINEL;
    const clean = normalizeCustomOptionValue(value).toLowerCase();
    return knownOptions.find((opt) => opt.value.toLowerCase() === clean)?.value || CUSTOM_SENTINEL;
  }, [customMode, valueInKnown, value, knownOptions]);

  const handleSaveCustom = () => {
    const candidate = normalizeCustomOptionValue(draftCustom || value);
    if (!candidate) return;
    const existsInPresets = presets.some(
      (p) => normalizeCustomOptionValue(p.value).toLowerCase() === candidate.toLowerCase()
    );
    if (!existsInPresets) {
      const next = Array.from(
        new Set([...savedCustomValues, candidate].map((v) => normalizeCustomOptionValue(v)))
      ).filter(Boolean);
      setSavedCustomValues(next);
      writeStoredCustomOptions(storageKey, next);
    }
    onChange(candidate);
    onAddCustom?.(candidate);
    setDraftCustom('');
    setCustomMode(false);
  };

  return (
    <div className={`space-y-1.5 ${className}`}>
      <select
        value={matchedSelectValue}
        aria-label={ariaLabel}
        onChange={(e) => {
          const picked = e.target.value;
          if (picked === CUSTOM_SENTINEL) {
            setCustomMode(true);
            setDraftCustom(valueInKnown ? '' : value);
            if (valueInKnown) onChange('');
            return;
          }
          setCustomMode(false);
          setDraftCustom('');
          onChange(picked);
          onSelectPreset?.(picked);
        }}
        className={
          selectClassName ||
          'w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg bg-white text-[#2E3138]'
        }
      >
        {(() => {
          const ungrouped: typeof knownOptions = [];
          const groups = new Map<string, typeof knownOptions>();
          for (const opt of knownOptions) {
            if (opt.group) {
              const bucket = groups.get(opt.group) || [];
              bucket.push(opt);
              groups.set(opt.group, bucket);
            } else {
              ungrouped.push(opt);
            }
          }
          return (
            <>
              {ungrouped.map((opt) => (
                <option key={opt.value} value={opt.value}>
                  {opt.label}
                </option>
              ))}
              {Array.from(groups.entries()).map(([groupLabel, items]) => (
                <optgroup key={groupLabel} label={groupLabel}>
                  {items.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </optgroup>
              ))}
            </>
          );
        })()}
        <option value={CUSTOM_SENTINEL}>
          {customOptionLabel ||
            (lang === 'bn' ? '+ কাস্টম / নতুন যোগ করুন...' : '+ Custom / Add New...')}
        </option>
      </select>

      {showCustomInput && (
        <div className="flex items-center gap-1.5">
          <input
            type="text"
            required={required}
            value={customMode ? draftCustom : value}
            onChange={(e) => {
              setDraftCustom(e.target.value);
              onChange(e.target.value);
            }}
            onKeyDown={(e) => {
              if (e.key === 'Enter') {
                e.preventDefault();
                handleSaveCustom();
              }
            }}
            placeholder={
              placeholder ||
              (lang === 'bn'
                ? 'কাস্টম নাম লিখুন (যেমন: ঢাকার নিজস্ব এলাকা)...'
                : 'Type custom option (e.g. Rampura, Dhaka)...')
            }
            className={
              inputClassName ||
              'flex-1 min-w-0 px-3 py-1.5 text-sm border border-[#E21B70]/40 bg-[#FFF9FB] rounded-lg focus:outline-none focus:border-[#E21B70]'
            }
          />
          <button
            type="button"
            onClick={handleSaveCustom}
            disabled={!normalizeCustomOptionValue(draftCustom || value)}
            className="px-3 py-1.5 rounded-lg bg-[#E21B70] hover:bg-[#C4135E] disabled:opacity-40 text-white text-xs font-semibold inline-flex items-center gap-1 shrink-0 transition-colors"
          >
            <Plus className="w-3.5 h-3.5" />
            <span>{addButtonLabel || (lang === 'bn' ? 'যোগ' : 'Add')}</span>
          </button>
        </div>
      )}
    </div>
  );
}
