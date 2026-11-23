import React, { useEffect, useMemo, useRef, useState } from 'react';
import { Clock, Loader2, LocateFixed, MapPin, Navigation, Search, Sparkles, X } from 'lucide-react';
import { apiFetch } from '../lib/api';
import { BANGLADESH_AREAS, BANGLADESH_SEARCH_PLACES } from '../lib/i18n';
import {
  type AddressSuggestionOption,
  expandAddressSearchQueries,
  findLocalAddressSuggestions,
  matchCanonicalAreaFromHints,
  mergeAddressSuggestions,
} from '../lib/marketplace-logic';
import type { Lang } from '../types/marketplace';

const RECENT_ADDRESSES_KEY = 'foodora_recent_addresses_v1';

export interface SelectedAddressResult {
  shortName: string;
  shortNameBn?: string;
  displayName: string;
  lat: number;
  lng: number;
  isCustomAreaOnly?: boolean;
}

interface AddressSearchInputProps {
  lang: Lang;
  value?: string;
  placeholder?: string;
  showGpsButton?: boolean;
  locatingGps?: boolean;
  onUseGps?: () => void;
  onSelectAddress: (result: SelectedAddressResult) => void;
  currentCoords?: { lat: number; lng: number };
  compact?: boolean;
  autoFocus?: boolean;
}

function readRecentAddresses(): AddressSuggestionOption[] {
  if (typeof window === 'undefined') return [];
  try {
    const raw = window.localStorage.getItem(RECENT_ADDRESSES_KEY);
    if (!raw) return [];
    const parsed = JSON.parse(raw) as AddressSuggestionOption[];
    if (!Array.isArray(parsed)) return [];
    return parsed
      .filter((x) => x && typeof x.shortName === 'string' && Number.isFinite(x.lat) && Number.isFinite(x.lng))
      .slice(0, 4);
  } catch {
    return [];
  }
}

export function saveRecentAddress(item: {
  shortName: string;
  shortNameBn?: string;
  displayName: string;
  lat: number;
  lng: number;
}) {
  if (typeof window === 'undefined' || !item.shortName.trim()) return;
  try {
    const prev = readRecentAddresses();
    const nextEntry: AddressSuggestionOption = {
      shortName: item.shortName.trim(),
      shortNameBn: item.shortNameBn || item.shortName.trim(),
      displayName: item.displayName || item.shortName.trim(),
      subtitle: 'Recent',
      lat: item.lat,
      lng: item.lng,
      source: 'recent',
    };
    const filtered = prev.filter(
      (p) => p.shortName.toLowerCase() !== nextEntry.shortName.toLowerCase()
    );
    window.localStorage.setItem(
      RECENT_ADDRESSES_KEY,
      JSON.stringify([nextEntry, ...filtered].slice(0, 4))
    );
  } catch {
    // ignore storage errors
  }
}

async function fetchGooglePlaceSuggestions(
  query: string,
  lang: Lang
): Promise<AddressSuggestionOption[]> {
  try {
    const gMaps = (window as unknown as {
      google?: {
        maps?: {
          places?: {
            AutocompleteSuggestion?: {
              fetchAutocompleteSuggestions?: (req: {
                input: string;
                includedRegionCodes?: string[];
                language?: string;
              }) => Promise<{
                suggestions?: Array<{
                  placePrediction?: {
                    placeId?: string;
                    text?: { toString?: () => string };
                    mainText?: { toString?: () => string };
                    secondaryText?: { toString?: () => string };
                    toPlace?: () => {
                      fetchFields?: (opts: { fields: string[] }) => Promise<{
                        place?: {
                          displayName?: string;
                          formattedAddress?: string;
                          location?: { lat: number | (() => number); lng: number | (() => number) };
                        };
                      }>;
                    };
                  };
                }>;
              }>;
            };
          };
        };
      };
    }).google?.maps;

    const fetcher = gMaps?.places?.AutocompleteSuggestion?.fetchAutocompleteSuggestions;
    if (!fetcher) return [];

    const variants = expandAddressSearchQueries(query);
    const expandedQuery = variants[variants.length - 1] || query;

    const resp = await fetcher({
      input: expandedQuery,
      includedRegionCodes: ['bd'],
      language: lang,
    });

    const preds = (resp?.suggestions || [])
      .map((s) => s.placePrediction)
      .filter((p): p is NonNullable<typeof p> => Boolean(p && typeof p.toPlace === 'function'))
      .slice(0, 6);
    if (preds.length === 0) return [];

    const resolved = await Promise.all(
      preds.map(async (pred): Promise<AddressSuggestionOption | null> => {
        try {
          const place = pred.toPlace?.();
          if (!place || typeof place.fetchFields !== 'function') return null;
          const res = await Promise.race([
            place.fetchFields({ fields: ['location', 'displayName', 'formattedAddress'] }),
            new Promise<null>((resolve) => setTimeout(() => resolve(null), 2000)),
          ]);
          const loc = res?.place?.location;
          if (!loc) return null;
          const lat = typeof loc.lat === 'function' ? loc.lat() : loc.lat;
          const lng = typeof loc.lng === 'function' ? loc.lng() : loc.lng;
          if (!Number.isFinite(lat) || !Number.isFinite(lng)) return null;

          const desc =
            res?.place?.formattedAddress ||
            pred.text?.toString?.() ||
            matchCanonicalAreaFromHints([], lat, lng, BANGLADESH_AREAS);
          const mainText =
            res?.place?.displayName ||
            pred.mainText?.toString?.() ||
            desc.split(',')[0]?.trim() ||
            'Bangladesh';
          const secText = pred.secondaryText?.toString?.() || 'Google Places';

          return {
            shortName: mainText,
            displayName: desc.toLowerCase().includes('bangladesh') ? desc : `${desc}, Bangladesh`,
            subtitle: secText,
            lat,
            lng,
            source: 'map',
          };
        } catch {
          return null;
        }
      })
    );

    return resolved.filter((x): x is AddressSuggestionOption => Boolean(x));
  } catch {
    return [];
  }
}

export function AddressSearchInput({
  lang,
  value = '',
  placeholder,
  showGpsButton = true,
  locatingGps = false,
  onUseGps,
  onSelectAddress,
  currentCoords = { lat: 23.7949, lng: 90.4144 },
  compact = false,
  autoFocus = false,
}: AddressSearchInputProps) {
  const [query, setQuery] = useState(value);
  const [open, setOpen] = useState(false);
  const [searching, setSearching] = useState(false);
  const [remoteResults, setRemoteResults] = useState<AddressSuggestionOption[]>([]);
  const [recentList, setRecentList] = useState<AddressSuggestionOption[]>(() => readRecentAddresses());
  const [activeIndex, setActiveIndex] = useState<number>(-1);
  const containerRef = useRef<HTMLDivElement | null>(null);
  const seqRef = useRef(0);
  const skipNextDebounceRef = useRef(false);

  useEffect(() => {
    skipNextDebounceRef.current = true;
    setQuery(value);
  }, [value]);

  const localResults = useMemo(
    () => findLocalAddressSuggestions(query, BANGLADESH_SEARCH_PLACES, 6),
    [query]
  );

  const suggestions = useMemo(() => {
    if (!query.trim()) {
      return recentList;
    }
    return mergeAddressSuggestions(localResults, remoteResults, 12);
  }, [query, recentList, localResults, remoteResults]);

  const runSearch = async (text: string) => {
    const clean = text.trim();
    if (clean.length < 2) {
      setRemoteResults([]);
      setSearching(false);
      return;
    }
    const seq = ++seqRef.current;
    setSearching(true);
    try {
      const [googleHits, osmRes] = await Promise.all([
        fetchGooglePlaceSuggestions(clean, lang),
        apiFetch<{ places: AddressSuggestionOption[] }>(
          `/api/free/geocode?q=${encodeURIComponent(clean)}&lat=${currentCoords.lat}&lng=${currentCoords.lng}`
        ).catch(() => ({ places: [] })),
      ]);
      if (seq !== seqRef.current) return;
      const combined = mergeAddressSuggestions(
        googleHits,
        (osmRes.places || []).map((p) => ({ ...p, source: p.source || 'map' })),
        10
      );
      setRemoteResults(combined);
    } finally {
      if (seq === seqRef.current) {
        setSearching(false);
      }
    }
  };

  useEffect(() => {
    if (skipNextDebounceRef.current) {
      skipNextDebounceRef.current = false;
      setSearching(false);
      return;
    }
    const clean = query.trim();
    if (clean.length < 2) {
      setRemoteResults([]);
      setSearching(false);
      return;
    }
    const timer = setTimeout(() => {
      void runSearch(clean);
    }, 280);
    return () => clearTimeout(timer);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [query, lang]);

  useEffect(() => {
    const handleOutsideClick = (ev: MouseEvent) => {
      if (containerRef.current && !containerRef.current.contains(ev.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handleOutsideClick);
    return () => document.removeEventListener('mousedown', handleOutsideClick);
  }, []);

  const pickOption = (opt: AddressSuggestionOption) => {
    const picked: SelectedAddressResult = {
      shortName: opt.shortName,
      shortNameBn: opt.shortNameBn || opt.shortName,
      displayName: opt.displayName,
      lat: opt.lat,
      lng: opt.lng,
    };
    seqRef.current += 1;
    skipNextDebounceRef.current = true;
    saveRecentAddress(picked);
    setRecentList(readRecentAddresses());
    setSearching(false);
    setQuery(opt.displayName);
    setOpen(false);
    setActiveIndex(-1);
    onSelectAddress(picked);
  };

  const pickCustomTypedAddress = () => {
    const clean = query.trim();
    if (!clean) return;
    const picked: SelectedAddressResult = {
      shortName: clean,
      shortNameBn: clean,
      displayName: clean.toLowerCase().includes('bangladesh') ? clean : `${clean}, Bangladesh`,
      lat: currentCoords.lat,
      lng: currentCoords.lng,
      isCustomAreaOnly: true,
    };
    saveRecentAddress(picked);
    setRecentList(readRecentAddresses());
    setOpen(false);
    setActiveIndex(-1);
    onSelectAddress(picked);
  };

  const triggerSearchOrPick = () => {
    if (!query.trim()) return;
    setOpen(true);
    if (activeIndex >= 0 && suggestions[activeIndex]) {
      pickOption(suggestions[activeIndex]);
      return;
    }
    void runSearch(query);
  };

  const handleKeyDown = (e: React.KeyboardEvent<HTMLInputElement>) => {
    if (!open && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      setOpen(true);
      return;
    }
    if (e.key === 'Enter') {
      e.preventDefault();
      triggerSearchOrPick();
    } else if (e.key === 'ArrowDown') {
      e.preventDefault();
      setActiveIndex((prev) => (prev + 1 >= suggestions.length ? 0 : prev + 1));
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      setActiveIndex((prev) => (prev <= 0 ? suggestions.length - 1 : prev - 1));
    } else if (e.key === 'Escape') {
      setOpen(false);
      setActiveIndex(-1);
    }
  };

  const defaultPlaceholder =
    lang === 'bn'
      ? 'আপনার রোড, বাসা, এলাকা বা শহর লিখুন (যেমন: Road 11 Banani, Mirpur 10, Sylhet)...'
      : 'Type road, house, area or city (e.g. Road 11 Banani, Mirpur 10, Sylhet)...';

  return (
    <div ref={containerRef} className="relative w-full">
      <div
        role="search"
        className="flex flex-wrap sm:flex-nowrap items-center gap-2"
      >
        <div className="relative flex-1 min-w-[210px]">
          {searching ? (
            <Loader2 className="w-4 h-4 text-[#E21B70] animate-spin absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          ) : (
            <Search className="w-4 h-4 text-neutral-400 absolute left-3.5 top-1/2 -translate-y-1/2 pointer-events-none" />
          )}
          <input
            type="text"
            autoFocus={autoFocus}
            value={query}
            onFocus={() => {
              setRecentList(readRecentAddresses());
              setOpen(true);
            }}
            onChange={(e) => {
              setQuery(e.target.value);
              setOpen(true);
              setActiveIndex(-1);
            }}
            onKeyDown={handleKeyDown}
            placeholder={placeholder || defaultPlaceholder}
            aria-label={lang === 'bn' ? 'ঠিকানা খুঁজুন' : 'Search delivery address'}
            className={`w-full pl-10 pr-8 ${
              compact ? 'h-9 text-xs' : 'h-11 text-xs sm:text-sm'
            } rounded-xl border border-neutral-200 bg-[#FAFAFB] focus:bg-white text-[#2E3138] placeholder:text-neutral-400 focus:outline-none focus:border-[#E21B70] focus:ring-2 focus:ring-[#E21B70]/15 transition-all`}
          />
          {query && (
            <button
              type="button"
              onClick={() => {
                setQuery('');
                setRemoteResults([]);
                setActiveIndex(-1);
                setOpen(true);
              }}
              aria-label={lang === 'bn' ? 'সার্চ মুছুন' : 'Clear address search'}
              className="absolute right-2.5 top-1/2 -translate-y-1/2 p-1 rounded-full text-neutral-400 hover:text-neutral-700 hover:bg-neutral-200/60"
            >
              <X className="w-3.5 h-3.5" />
            </button>
          )}
        </div>

        <div className="flex items-center gap-2 shrink-0">
          <button
            type="button"
            onClick={triggerSearchOrPick}
            disabled={searching || !query.trim()}
            className={`${
              compact ? 'h-9 px-3 text-xs' : 'h-11 px-4 text-xs sm:text-sm'
            } rounded-xl bg-[#E21B70] hover:bg-[#C4135E] disabled:opacity-50 text-white font-semibold whitespace-nowrap inline-flex items-center gap-1.5 transition-colors shadow-xs`}
          >
            <Search className="w-3.5 h-3.5 shrink-0" />
            <span>
              {searching
                ? lang === 'bn'
                  ? 'খুঁজছে...'
                  : 'Searching...'
                : lang === 'bn'
                ? 'খুঁজুন'
                : 'Find Address'}
            </span>
          </button>

          {showGpsButton && onUseGps && (
            <button
              type="button"
              onClick={onUseGps}
              disabled={locatingGps}
              className={`${
                compact ? 'h-9 px-2.5 text-xs' : 'h-11 px-3.5 text-xs sm:text-sm'
              } rounded-xl border border-neutral-200 hover:border-[#E21B70] bg-white text-[#2E3138] font-semibold inline-flex items-center gap-1.5 whitespace-nowrap transition-colors`}
              title={lang === 'bn' ? 'বর্তমান GPS লোকেশন ব্যবহার করুন' : 'Detect current GPS location'}
            >
              {locatingGps ? (
                <Loader2 className="w-3.5 h-3.5 text-[#E21B70] animate-spin shrink-0" />
              ) : (
                <LocateFixed className="w-3.5 h-3.5 text-[#E21B70] shrink-0" />
              )}
              <span>
                {locatingGps
                  ? lang === 'bn'
                    ? 'খুঁজছে...'
                    : 'Locating...'
                  : lang === 'bn'
                  ? 'আমার অবস্থান'
                  : 'Locate Me'}
              </span>
            </button>
          )}
        </div>
      </div>

      {/* Autocomplete Suggestions Dropdown */}
      {open && (query.trim().length > 0 || recentList.length > 0) && (
        <div
          data-testid="address-suggestions-dropdown"
          className="absolute left-0 right-0 mt-1.5 z-50 rounded-xl border border-neutral-200 bg-white shadow-2xl overflow-hidden max-h-72 overflow-y-auto divide-y divide-neutral-100"
        >
          {!query.trim() && recentList.length > 0 && (
            <div className="px-3 py-1.5 bg-neutral-50 text-[10px] font-bold uppercase tracking-wider text-neutral-500 flex items-center gap-1.5">
              <Clock className="w-3 h-3" />
              <span>{lang === 'bn' ? 'সাম্প্রতিক ব্যবহৃত ঠিকানা' : 'Recent Locations'}</span>
            </div>
          )}

          {query.trim().length >= 2 && suggestions.length > 0 && (
            <button
              type="button"
              onClick={() => pickOption(suggestions[0])}
              className="w-full px-3.5 py-1.5 bg-[#FFF9FB] hover:bg-[#FFF0F6] text-[11px] font-semibold text-neutral-600 flex items-center justify-between gap-2 text-left transition-colors"
            >
              <span>
                {lang === 'bn' ? 'আপনি কি এটি খুঁজছেন (Did you mean):' : 'Did you mean:'}{' '}
                <strong className="text-[#E21B70] underline decoration-[#E21B70]/40 underline-offset-2">
                  {suggestions[0].shortName}
                </strong>
              </span>
              <span className="text-[10px] text-neutral-400">
                {suggestions.length} {lang === 'bn' ? 'টি লোকেশন' : 'options'}
              </span>
            </button>
          )}

          {suggestions.map((opt, idx) => {
            const isHighlighted = idx === activeIndex;
            const title = lang === 'bn' && opt.shortNameBn ? opt.shortNameBn : opt.shortName;
            return (
              <button
                key={`${opt.shortName}-${opt.lat}-${opt.lng}-${idx}`}
                type="button"
                onMouseEnter={() => setActiveIndex(idx)}
                onClick={() => pickOption(opt)}
                className={`w-full px-3.5 py-2.5 text-left transition-colors flex items-start justify-between gap-2.5 ${
                  isHighlighted ? 'bg-[#FFF0F6]' : 'hover:bg-[#FFF9FB]'
                }`}
              >
                <div className="flex items-start gap-2.5 min-w-0">
                  {opt.source === 'recent' ? (
                    <Clock className="w-4 h-4 text-neutral-400 shrink-0 mt-0.5" />
                  ) : opt.source === 'area' ? (
                    <Navigation className="w-4 h-4 text-[#E21B70] shrink-0 mt-0.5" />
                  ) : (
                    <MapPin className="w-4 h-4 text-[#E21B70] shrink-0 mt-0.5" />
                  )}
                  <div className="min-w-0">
                    <p className="text-xs font-bold text-[#2E3138] truncate">{title}</p>
                    <p className="text-[11px] text-neutral-500 truncate">{opt.displayName}</p>
                  </div>
                </div>
                {opt.subtitle && (
                  <span className="shrink-0 px-2 py-0.5 rounded-full text-[10px] font-semibold bg-neutral-100 text-neutral-600">
                    {opt.subtitle}
                  </span>
                )}
              </button>
            );
          })}

          {query.trim().length >= 2 && (
            <div className="bg-neutral-50/90 px-3.5 py-2 flex items-center justify-between gap-2">
              <div className="min-w-0">
                {suggestions.length === 0 && !searching && (
                  <p className="text-[11px] text-neutral-500 mb-0.5">
                    {lang === 'bn'
                      ? 'ম্যাপে সরাসরি না পেলে এটিকে আপনার এলাকা হিসেবে ব্যবহার করতে পারেন বা ম্যাপে পিন সরান:'
                      : 'No exact map match — you can use this text directly or drag the map pin:'}
                  </p>
                )}
                <button
                  type="button"
                  onClick={pickCustomTypedAddress}
                  className="inline-flex items-center gap-1.5 text-xs font-semibold text-[#E21B70] hover:underline"
                >
                  <Sparkles className="w-3.5 h-3.5 shrink-0" />
                  <span className="truncate">
                    {lang === 'bn'
                      ? `"${query.trim()}"-কে ডেলিভারি ঠিকানা হিসেবে সেট করুন`
                      : `Use "${query.trim()}" as delivery address`}
                  </span>
                </button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
