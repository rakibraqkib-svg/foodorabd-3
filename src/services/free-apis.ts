import {
  cleanMapAddressSegments,
  haversineDistanceKm,
  mapOpenMeteoWeather,
  matchCanonicalAreaFromHints,
} from '../lib/marketplace-logic.ts';
import { BANGLADESH_AREAS } from '../lib/i18n.ts';

interface CacheEntry<T> {
  value: T;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry<unknown>>();

function getCached<T>(key: string): T | null {
  const entry = cache.get(key);
  if (!entry) return null;
  if (Date.now() > entry.expiresAt) {
    cache.delete(key);
    return null;
  }
  return entry.value as T;
}

function setCached<T>(key: string, value: T, ttlMs: number): T {
  cache.set(key, { value, expiresAt: Date.now() + ttlMs });
  return value;
}

export interface DhakaWeatherSummary {
  tempC: number;
  windKmh: number;
  precipitationMm: number;
  weatherCode: number;
  labelEn: string;
  labelBn: string;
  isRaining: boolean;
  rainBufferMin: number;
  source: string;
}

export async function fetchDhakaWeather(lat: number, lng: number): Promise<DhakaWeatherSummary> {
  const key = `weather:${lat.toFixed(2)},${lng.toFixed(2)}`;
  const cached = getCached<DhakaWeatherSummary>(key);
  if (cached) return cached;

  try {
    const url = `https://api.open-meteo.com/v1/forecast?latitude=${lat}&longitude=${lng}&current=temperature_2m,precipitation,weather_code,wind_speed_10m&timezone=Asia%2FDhaka`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) throw new Error(`Open-Meteo HTTP ${res.status}`);
    const data = (await res.json()) as {
      current?: {
        temperature_2m?: number;
        precipitation?: number;
        weather_code?: number;
        wind_speed_10m?: number;
      };
    };
    const tempC = Math.round(data.current?.temperature_2m ?? 28);
    const precipitationMm = Number(data.current?.precipitation ?? 0);
    const weatherCode = Number(data.current?.weather_code ?? 0);
    const windKmh = Math.round(data.current?.wind_speed_10m ?? 8);
    const mapped = mapOpenMeteoWeather(weatherCode, precipitationMm);

    return setCached(
      key,
      {
        tempC,
        windKmh,
        precipitationMm,
        weatherCode,
        ...mapped,
        source: 'Open-Meteo',
      },
      15 * 60 * 1000
    );
  } catch {
    return {
      tempC: 28,
      windKmh: 9,
      precipitationMm: 0,
      weatherCode: 1,
      labelEn: 'Clear Sky',
      labelBn: 'পরিষ্কার আকাশ',
      isRaining: false,
      rainBufferMin: 0,
      source: 'Fallback',
    };
  }
}

export interface OsmPlaceSuggestion {
  displayName: string;
  shortName: string;
  lat: number;
  lng: number;
}

export async function searchOsmPlaces(query: string): Promise<OsmPlaceSuggestion[]> {
  const q = query.trim();
  if (!q) return [];
  const key = `osm-search:${q.toLowerCase()}`;
  const cached = getCached<OsmPlaceSuggestion[]>(key);
  if (cached) return cached;

  try {
    const queryWithCountry = q.toLowerCase().includes('bangladesh') ? q : `${q}, Bangladesh`;
    const url = `https://nominatim.openstreetmap.org/search?q=${encodeURIComponent(
      queryWithCountry
    )}&format=json&countrycodes=bd&limit=6`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FoodoraBD-Marketplace/1.0' },
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) throw new Error(`Nominatim HTTP ${res.status}`);
    const rows = (await res.json()) as Array<{
      display_name: string;
      lat: string;
      lon: string;
    }>;

    const mapped = rows.map((r) => ({
      displayName: r.display_name,
      shortName: r.display_name.split(',').slice(0, 2).join(', ').trim(),
      lat: Number(r.lat),
      lng: Number(r.lon),
    }));
    return setCached(key, mapped, 10 * 60 * 1000);
  } catch {
    return [];
  }
}

export async function reverseOsmGeocode(
  lat: number,
  lng: number,
  lang: 'en' | 'bn' = 'en'
): Promise<{ displayName: string; areaName: string; source: string }> {
  const key = `osm-rev-v2:${lang}:${lat.toFixed(4)},${lng.toFixed(4)}`;
  const cached = getCached<{ displayName: string; areaName: string; source: string }>(key);
  if (cached) return cached;

  try {
    const url = `https://nominatim.openstreetmap.org/reverse?lat=${lat}&lon=${lng}&format=json&addressdetails=1&zoom=18&accept-language=${
      lang === 'bn' ? 'bn,en' : 'en'
    }`;
    const res = await fetch(url, {
      headers: { 'User-Agent': 'FoodoraBD-Marketplace/1.0' },
      signal: AbortSignal.timeout(4000),
    });
    if (!res.ok) throw new Error(`Nominatim reverse HTTP ${res.status}`);
    const data = (await res.json()) as {
      display_name?: string;
      name?: string;
      address?: {
        amenity?: string;
        building?: string;
        house_number?: string;
        road?: string;
        neighbourhood?: string;
        quarter?: string;
        suburb?: string;
        city?: string;
        town?: string;
        village?: string;
        city_district?: string;
        county?: string;
        state_district?: string;
        state?: string;
      };
    };
    const addr = data.address;
    const houseOrBuilding = [addr?.house_number, addr?.road].filter(Boolean).join(' ').trim();
    const localHood =
      addr?.neighbourhood || addr?.quarter || addr?.suburb || addr?.village || addr?.town || '';
    const cityPart = addr?.city || addr?.town || addr?.county || '';

    const areaName = matchCanonicalAreaFromHints(
      [localHood, addr?.road || '', data.name || '', data.display_name || '', cityPart],
      lat,
      lng,
      BANGLADESH_AREAS
    );

    const structuredCandidates = [
      data.name || addr?.amenity || addr?.building || '',
      houseOrBuilding,
      localHood,
      areaName,
      cityPart,
    ].filter(Boolean);
    const cleanedSegments = cleanMapAddressSegments(
      structuredCandidates.length > 0 ? structuredCandidates.join(', ') : data.display_name || ''
    );

    const displayName =
      cleanedSegments.length > 0
        ? `${cleanedSegments.slice(0, 4).join(', ')}, Bangladesh`
        : `${areaName}, Bangladesh`;
    return setCached(key, { displayName, areaName, source: 'OpenStreetMap' }, 10 * 60 * 1000);
  } catch {
    const areaName = matchCanonicalAreaFromHints([], lat, lng, BANGLADESH_AREAS);
    return {
      displayName: `${areaName}, Bangladesh`,
      areaName,
      source: 'Fallback',
    };
  }
}

export interface OsrmRouteEstimate {
  distanceKm: number;
  drivingMinutes: number;
  source: 'OSRM' | 'Haversine';
}

export async function fetchOsrmRoute(
  fromLat: number,
  fromLng: number,
  toLat: number,
  toLng: number
): Promise<OsrmRouteEstimate> {
  const key = `osrm:${fromLat.toFixed(3)},${fromLng.toFixed(3)}->${toLat.toFixed(3)},${toLng.toFixed(3)}`;
  const cached = getCached<OsrmRouteEstimate>(key);
  if (cached) return cached;

  try {
    const url = `https://router.project-osrm.org/route/v1/driving/${fromLng},${fromLat};${toLng},${toLat}?overview=false`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) throw new Error(`OSRM HTTP ${res.status}`);
    const data = (await res.json()) as {
      code?: string;
      routes?: Array<{ distance: number; duration: number }>;
    };
    const route = data.routes?.[0];
    if (!route) throw new Error('No OSRM route');
    const distanceKm = Math.round((route.distance / 1000) * 100) / 100;
    const drivingMinutes = Math.max(5, Math.round(route.duration / 60));
    return setCached(key, { distanceKm, drivingMinutes, source: 'OSRM' }, 5 * 60 * 1000);
  } catch {
    const distanceKm = haversineDistanceKm(fromLat, fromLng, toLat, toLng);
    return {
      distanceKm,
      drivingMinutes: Math.max(6, Math.round(distanceKm * 4.2)),
      source: 'Haversine',
    };
  }
}

export interface BdtExchangeRates {
  base: 'BDT';
  rates: { USD: number; EUR: number; GBP: number; SAR: number };
  updatedAt: string;
  source: string;
}

export async function fetchBdtExchangeRates(): Promise<BdtExchangeRates> {
  const key = 'fx:BDT';
  const cached = getCached<BdtExchangeRates>(key);
  if (cached) return cached;

  try {
    const res = await fetch('https://open.er-api.com/v6/latest/BDT', {
      signal: AbortSignal.timeout(3500),
    });
    if (!res.ok) throw new Error(`FX HTTP ${res.status}`);
    const data = (await res.json()) as {
      time_last_update_utc?: string;
      rates?: Record<string, number>;
    };
    const r = data.rates || {};
    return setCached(
      key,
      {
        base: 'BDT',
        rates: {
          USD: Number(r.USD ?? 0.00833),
          EUR: Number(r.EUR ?? 0.0077),
          GBP: Number(r.GBP ?? 0.0065),
          SAR: Number(r.SAR ?? 0.0312),
        },
        updatedAt: data.time_last_update_utc || new Date().toUTCString(),
        source: 'ExchangeRate-API',
      },
      60 * 60 * 1000
    );
  } catch {
    return {
      base: 'BDT',
      rates: { USD: 0.00833, EUR: 0.0077, GBP: 0.0065, SAR: 0.0312 },
      updatedAt: new Date().toUTCString(),
      source: 'Fallback',
    };
  }
}

export interface MealInspirationItem {
  id: string;
  name: string;
  category: string;
  cuisine: string;
  instructions: string;
  thumbUrl: string;
}

export async function searchMealDbDishes(query: string): Promise<MealInspirationItem[]> {
  const q = query.trim() || 'biryani';
  const key = `mealdb:${q.toLowerCase()}`;
  const cached = getCached<MealInspirationItem[]>(key);
  if (cached) return cached;

  try {
    const url = `https://www.themealdb.com/api/json/v1/1/search.php?s=${encodeURIComponent(q)}`;
    const res = await fetch(url, { signal: AbortSignal.timeout(3500) });
    if (!res.ok) throw new Error(`MealDB HTTP ${res.status}`);
    const data = (await res.json()) as {
      meals?: Array<{
        idMeal: string;
        strMeal: string;
        strCategory: string;
        strArea: string;
        strInstructions: string;
        strMealThumb: string;
      }> | null;
    };
    const meals = (data.meals || []).slice(0, 6).map((m) => ({
      id: m.idMeal,
      name: m.strMeal,
      category: m.strCategory || 'Main Course',
      cuisine: m.strArea || 'International',
      instructions: (m.strInstructions || '').slice(0, 140).replace(/\s+/g, ' ').trim(),
      thumbUrl: m.strMealThumb,
    }));
    return setCached(key, meals, 30 * 60 * 1000);
  } catch {
    return [];
  }
}
