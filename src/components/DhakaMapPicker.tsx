import React, { useEffect, useRef, useState } from 'react';
import L from 'leaflet';
import 'leaflet/dist/leaflet.css';
import {
  AdvancedMarker,
  APIProvider,
  APILoadingStatus,
  Map as GoogleMap,
  useApiLoadingStatus,
  useMap,
  useMapsLibrary,
} from '@vis.gl/react-google-maps';
import {
  Bike,
  ChevronDown,
  ChevronUp,
  Info,
  LocateFixed,
  MapPin,
  Radio,
  Satellite,
  Wifi,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import { BANGLADESH_AREAS, DHAKA_AREAS } from '../lib/i18n';
import {
  haversineDistanceKm,
  matchCanonicalAreaFromHints,
  resolveMapPinAppearance,
  resolveNearestAreaFromList,
} from '../lib/marketplace-logic';
import type { Lang } from '../types/marketplace';

const GMP_BLOCK_KEY = 'foodora_gmp_quota_blocked_until';
const MAP_PREF_KEY = 'foodora_preferred_map_mode';

function escapeHtml(raw: string): string {
  return String(raw || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isGoogleMapsBlockedInSession(): boolean {
  if (typeof window === 'undefined') return false;
  if ((window as unknown as { __foodoraGmpBlocked?: boolean }).__foodoraGmpBlocked) {
    return true;
  }
  try {
    const until = Number(sessionStorage.getItem(GMP_BLOCK_KEY) || '0');
    return Number.isFinite(until) && until > Date.now();
  } catch {
    return false;
  }
}

function setGoogleMapsBlockedInSession(blocked: boolean) {
  if (typeof window === 'undefined') return;
  (window as unknown as { __foodoraGmpBlocked?: boolean }).__foodoraGmpBlocked = blocked;
  try {
    if (blocked) {
      sessionStorage.setItem(GMP_BLOCK_KEY, String(Date.now() + 30 * 60 * 1000));
    } else {
      sessionStorage.removeItem(GMP_BLOCK_KEY);
    }
  } catch {
    // ignore
  }
}

function getPreferredMapMode(): 'google' | 'osm' | null {
  if (typeof window === 'undefined') return null;
  try {
    const v = localStorage.getItem(MAP_PREF_KEY);
    return v === 'osm' || v === 'google' ? v : null;
  } catch {
    return null;
  }
}

function setPreferredMapMode(mode: 'google' | 'osm') {
  if (typeof window === 'undefined') return;
  try {
    localStorage.setItem(MAP_PREF_KEY, mode);
  } catch {
    // ignore
  }
}

export interface ExtraRiderMapPin {
  id: number;
  label: string;
  lat: number;
  lng: number;
  isAvailable: boolean;
  selected?: boolean;
}

class GoogleMapErrorBoundary extends React.Component<
  { children: React.ReactNode; onCrash: () => void },
  { hasError: boolean }
> {
  constructor(props: { children: React.ReactNode; onCrash: () => void }) {
    super(props);
    this.state = { hasError: false };
  }

  static getDerivedStateFromError(): { hasError: boolean } {
    return { hasError: true };
  }

  componentDidCatch() {
    this.props.onCrash();
  }

  render() {
    if (this.state.hasError) return null;
    return this.props.children;
  }
}

interface DhakaMapPickerProps {
  mapsApiKey: string;
  lang: Lang;
  center: { lat: number; lng: number };
  markerLabel?: string;
  pinType?: 'user' | 'vendor';
  userName?: string;
  restaurantName?: string;
  secondaryPoint?: { lat: number; lng: number; label: string };
  riderPoint?: { lat: number; lng: number; label: string };
  riderTarget?: { lat: number; lng: number };
  extraRiders?: ExtraRiderMapPin[];
  onSelectRiderPin?: (riderId: number) => void;
  interactive?: boolean;
  heightClass?: string;
  onSelectLocation?: (coords: {
    lat: number;
    lng: number;
    areaName?: string;
    displayName?: string;
  }) => void;
}

interface MapPolylineLike {
  setMap: (map: unknown) => void;
  setOptions: (opts: Record<string, unknown>) => void;
}

const MAJOR_BD_CITY_NAMES = new Set([
  'Dhaka',
  'Gulshan 2',
  'Chattogram',
  'Sylhet',
  'Rajshahi',
  'Khulna',
  'Barishal',
  'Rangpur',
  'Mymensingh',
  "Cox's Bazar",
]);

function isPointInsideDhakaMetro(lat: number, lng: number): boolean {
  return lat >= 23.66 && lat <= 23.92 && lng >= 90.28 && lng <= 90.52;
}

function MapPinMarkerBadge({
  label,
  role,
}: {
  label: string;
  role: 'user' | 'vendor';
}) {
  const isVendor = role === 'vendor';
  return (
    <div className="flex flex-col items-center pointer-events-none select-none">
      <span
        className={`px-2 py-0.5 rounded-md border text-white text-[11px] font-bold shadow-md whitespace-nowrap mb-1 leading-tight ${
          isVendor ? 'bg-[#111827] border-black' : 'bg-[#DC2626] border-[#991B1B]'
        }`}
      >
        {label}
      </span>
      <svg
        width="28"
        height="36"
        viewBox="0 0 28 36"
        fill="none"
        xmlns="http://www.w3.org/2000/svg"
        className="drop-shadow-md"
      >
        <path
          d="M14 1.5C7.09644 1.5 1.5 7.09644 1.5 14C1.5 23.25 14 34.5 14 34.5C14 34.5 26.5 23.25 26.5 14C26.5 7.09644 20.9036 1.5 14 1.5Z"
          fill={isVendor ? '#111827' : '#DC2626'}
          stroke={isVendor ? '#000000' : '#991B1B'}
          strokeWidth="2"
        />
        <circle cx="14" cy="13.5" r="4.8" fill="#FFFFFF" />
      </svg>
    </div>
  );
}

function RouteOverlay({
  origin,
  destination,
  skipFitBounds = false,
}: {
  origin: { lat: number; lng: number };
  destination: { lat: number; lng: number };
  skipFitBounds?: boolean;
}) {
  const map = useMap();
  const routesLib = useMapsLibrary('routes');
  const polylinesRef = useRef<MapPolylineLike[]>([]);
  const originLat = origin.lat;
  const originLng = origin.lng;
  const destLat = destination.lat;
  const destLng = destination.lng;

  useEffect(() => {
    if (!map || !routesLib) return;
    polylinesRef.current.forEach((p) => p.setMap(null));
    polylinesRef.current = [];

    const request = {
      origin: { lat: originLat, lng: originLng },
      destination: { lat: destLat, lng: destLng },
      travelMode: 'DRIVING',
      fields: ['path', 'viewport'],
    };

    const RouteCls = (
      routesLib as unknown as {
        Route?: { computeRoutes: (req: unknown) => Promise<{ routes: any[] }> };
      }
    ).Route;
    if (!RouteCls || typeof RouteCls.computeRoutes !== 'function') return;

    RouteCls.computeRoutes(request)
      .then(({ routes }) => {
        if (!routes || routes.length === 0) return;
        const primary = routes[0];
        if (typeof primary.createPolylines === 'function') {
          const lines = primary.createPolylines() as MapPolylineLike[];
          lines.forEach((p) => {
            p.setOptions({ strokeColor: '#E21B70', strokeWeight: 5 });
            p.setMap(map);
          });
          polylinesRef.current = lines;
        }
        if (primary.viewport && !skipFitBounds) {
          map.fitBounds(primary.viewport);
        }
      })
      .catch(() => {
        // Fallback silently if routes API quota/network unavailable
      });

    return () => {
      polylinesRef.current.forEach((p) => p.setMap(null));
      polylinesRef.current = [];
    };
  }, [map, routesLib, originLat, originLng, destLat, destLng, skipFitBounds]);

  return null;
}

function TrackingBoundsAndRiderVector({
  center,
  secondaryPoint,
  riderPoint,
  riderTarget,
}: {
  center: { lat: number; lng: number };
  secondaryPoint?: { lat: number; lng: number };
  riderPoint?: { lat: number; lng: number };
  riderTarget?: { lat: number; lng: number };
}) {
  const map = useMap();
  const coreLib = useMapsLibrary('core');
  const mapsLib = useMapsLibrary('maps');
  const riderLineRef = useRef<MapPolylineLike | null>(null);
  const fittedKeyRef = useRef<string>('');

  const cLat = center.lat;
  const cLng = center.lng;
  const sLat = secondaryPoint?.lat;
  const sLng = secondaryPoint?.lng;
  const rLat = riderPoint?.lat;
  const rLng = riderPoint?.lng;
  const tLat = riderTarget?.lat ?? cLat;
  const tLng = riderTarget?.lng ?? cLng;

  useEffect(() => {
    if (!map || !mapsLib || typeof rLat !== 'number' || typeof rLng !== 'number') {
      if (riderLineRef.current) {
        riderLineRef.current.setMap(null);
        riderLineRef.current = null;
      }
      return;
    }

    const PolylineCtor = (
      mapsLib as unknown as {
        Polyline?: new (opts: Record<string, unknown>) => MapPolylineLike;
      }
    ).Polyline;
    if (!PolylineCtor) return;

    const path = [
      { lat: rLat, lng: rLng },
      { lat: tLat, lng: tLng },
    ];

    if (!riderLineRef.current) {
      riderLineRef.current = new PolylineCtor({
        path,
        geodesic: true,
        strokeColor: '#059669',
        strokeOpacity: 0.85,
        strokeWeight: 3.5,
        map,
      });
    } else {
      riderLineRef.current.setOptions({ path, map });
    }

    return () => {
      if (riderLineRef.current) {
        riderLineRef.current.setMap(null);
        riderLineRef.current = null;
      }
    };
  }, [map, mapsLib, rLat, rLng, tLat, tLng]);

  useEffect(() => {
    if (!map || !coreLib || typeof rLat !== 'number' || typeof rLng !== 'number') return;

    const LatLngBoundsCtor = (
      coreLib as unknown as {
        LatLngBounds?: new () => {
          extend: (pt: { lat: number; lng: number }) => void;
        };
      }
    ).LatLngBounds;
    if (!LatLngBoundsCtor) return;

    const endpointKey = `${cLat.toFixed(4)},${cLng.toFixed(4)}|${sLat?.toFixed(4) ?? ''},${sLng?.toFixed(4) ?? ''}|hasRider`;
    const currentBounds = map.getBounds();
    const riderOutsideView =
      currentBounds && typeof currentBounds.contains === 'function'
        ? !currentBounds.contains({ lat: rLat, lng: rLng })
        : false;

    if (fittedKeyRef.current !== endpointKey || riderOutsideView) {
      const bounds = new LatLngBoundsCtor();
      bounds.extend({ lat: cLat, lng: cLng });
      bounds.extend({ lat: rLat, lng: rLng });
      if (typeof sLat === 'number' && typeof sLng === 'number') {
        bounds.extend({ lat: sLat, lng: sLng });
      }
      (map as unknown as { fitBounds: (b: unknown, padding?: number) => void }).fitBounds(
        bounds,
        48
      );
      fittedKeyRef.current = endpointKey;
    }
  }, [map, coreLib, cLat, cLng, sLat, sLng, rLat, rLng]);

  return null;
}

function MapCenterSync({
  center,
  skipPanRef,
}: {
  center: { lat: number; lng: number };
  skipPanRef: React.MutableRefObject<{ lat: number; lng: number } | null>;
}) {
  const map = useMap();
  const prevRef = useRef<{ lat: number; lng: number } | null>(null);

  useEffect(() => {
    if (!map) return;
    if (
      skipPanRef.current &&
      Math.abs(skipPanRef.current.lat - center.lat) < 1e-6 &&
      Math.abs(skipPanRef.current.lng - center.lng) < 1e-6
    ) {
      skipPanRef.current = null;
      prevRef.current = { lat: center.lat, lng: center.lng };
      return;
    }
    if (
      prevRef.current &&
      prevRef.current.lat === center.lat &&
      prevRef.current.lng === center.lng
    ) {
      return;
    }
    prevRef.current = { lat: center.lat, lng: center.lng };
    map.panTo(center);
  }, [map, center.lat, center.lng, skipPanRef]);

  return null;
}

function GoogleMapInner({
  lang,
  center,
  markerLabel,
  pinType,
  userName,
  restaurantName,
  secondaryPoint,
  riderPoint,
  riderTarget,
  extraRiders,
  onSelectRiderPin,
  interactive,
  heightClass,
  onSelectLocation,
}: Omit<DhakaMapPickerProps, 'mapsApiKey'>) {
  const status = useApiLoadingStatus();
  const skipPanRef = useRef<{ lat: number; lng: number } | null>(null);
  const reverseSeqRef = useRef(0);
  const [resolving, setResolving] = useState(false);
  const pinAppearance = resolveMapPinAppearance({
    pinType,
    userName,
    restaurantName,
    markerLabel,
    secondaryLabel: secondaryPoint?.label,
  });

  const emitLocation = (lat: number, lng: number, shouldSkipPan = true) => {
    if (!onSelectLocation || !Number.isFinite(lat) || !Number.isFinite(lng)) return;
    if (shouldSkipPan) {
      skipPanRef.current = { lat, lng };
    }
    const nearest = resolveNearestAreaFromList(lat, lng, BANGLADESH_AREAS);
    const immediateName =
      nearest.area && nearest.distanceKm <= 6
        ? nearest.area.name
        : `Pinned (${lat.toFixed(4)}, ${lng.toFixed(4)})`;
    const immediateDisplayName =
      nearest.area && nearest.distanceKm <= 6
        ? `${nearest.area.name}, Bangladesh`
        : `Pinned (${lat.toFixed(4)}, ${lng.toFixed(4)}), Bangladesh`;

    onSelectLocation({
      lat,
      lng,
      areaName: immediateName,
      displayName: immediateDisplayName,
    });

    const seq = ++reverseSeqRef.current;
    setResolving(true);

    const resolveViaBackend = () =>
      apiFetch<{ displayName: string; areaName: string }>(
        `/api/free/reverse-geocode?lat=${lat}&lng=${lng}&lang=${lang}`
      )
        .then((res) => {
          if (seq !== reverseSeqRef.current) return;
          const cleanArea = matchCanonicalAreaFromHints(
            [res.areaName, res.displayName],
            lat,
            lng,
            BANGLADESH_AREAS
          );
          skipPanRef.current = { lat, lng };
          onSelectLocation({
            lat,
            lng,
            areaName: cleanArea || immediateName,
            displayName: res.displayName || immediateDisplayName,
          });
        })
        .catch(() => {
          // Keep immediate canonical nearest area/label if reverse geocode is unavailable
        })
        .finally(() => {
          if (seq === reverseSeqRef.current) {
            setResolving(false);
          }
        });

    void resolveViaBackend();
  };

  useEffect(() => {
    if (status === APILoadingStatus.FAILED || status === APILoadingStatus.AUTH_FAILURE) {
      window.dispatchEvent(new CustomEvent('gm_authFailure'));
    }
  }, [status]);

  if (status === APILoadingStatus.FAILED || status === APILoadingStatus.AUTH_FAILURE) {
    return (
      <FallbackDhakaMap
        lang={lang}
        center={center}
        markerLabel={markerLabel}
        pinType={pinType}
        userName={userName}
        restaurantName={restaurantName}
        secondaryPoint={secondaryPoint}
        riderPoint={riderPoint}
        extraRiders={extraRiders}
        onSelectRiderPin={onSelectRiderPin}
        interactive={interactive}
        heightClass={heightClass}
        onSelectLocation={onSelectLocation}
      />
    );
  }

  const showBangladeshZoom = Boolean(
    (extraRiders && extraRiders.length > 0) || !isPointInsideDhakaMetro(center.lat, center.lng)
  );
  const isGoogleMapsReady =
    status === APILoadingStatus.LOADED &&
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { google?: { maps?: { marker?: { AdvancedMarkerElement?: unknown } } } }).google?.maps?.marker?.AdvancedMarkerElement);

  return (
    <div
      className={`relative w-full overflow-hidden rounded-xl border border-neutral-200 ${heightClass || 'h-[260px]'}`}
    >
      <GoogleMap
        defaultCenter={center}
        defaultZoom={showBangladeshZoom ? 7 : 14}
        mapId="DEMO_MAP_ID"
        gestureHandling="greedy"
        clickableIcons={false}
        disableDefaultUI={false}
        internalUsageAttributionIds={['gmp_mcp_codeassist_v1_aistudio']}
        className="w-full h-full"
        onClick={(ev) => {
          if (!interactive || !ev.detail?.latLng) return;
          const rawLatLng = ev.detail.latLng as unknown as {
            lat: number | (() => number);
            lng: number | (() => number);
          };
          const lat = typeof rawLatLng.lat === 'function' ? rawLatLng.lat() : rawLatLng.lat;
          const lng = typeof rawLatLng.lng === 'function' ? rawLatLng.lng() : rawLatLng.lng;
          emitLocation(lat, lng);
        }}
      >
        <MapCenterSync center={center} skipPanRef={skipPanRef} />
        {isGoogleMapsReady && (
          <AdvancedMarker
            position={center}
            title={pinAppearance.primaryLabel}
            draggable={Boolean(interactive)}
            onDragEnd={(ev) => {
              if (interactive && ev.latLng) {
                emitLocation(ev.latLng.lat(), ev.latLng.lng());
              }
            }}
          >
            <MapPinMarkerBadge
              label={pinAppearance.primaryLabel}
              role={pinAppearance.primaryRole}
            />
          </AdvancedMarker>
        )}
        {isGoogleMapsReady && secondaryPoint && (
          <AdvancedMarker
            position={{ lat: secondaryPoint.lat, lng: secondaryPoint.lng }}
            title={pinAppearance.secondaryLabel || secondaryPoint.label}
          >
            <MapPinMarkerBadge
              label={pinAppearance.secondaryLabel || secondaryPoint.label}
              role="vendor"
            />
          </AdvancedMarker>
        )}
        {isGoogleMapsReady && riderPoint && (
          <AdvancedMarker
            position={{ lat: riderPoint.lat, lng: riderPoint.lng }}
            title={riderPoint.label}
          >
            <div className="relative flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-600 text-white text-[11px] font-bold shadow-lg border-2 border-white">
              <span className="w-2 h-2 rounded-full bg-emerald-200 animate-ping absolute -top-0.5 -right-0.5" />
              <Bike className="w-3.5 h-3.5 shrink-0" />
              <span>{riderPoint.label}</span>
            </div>
          </AdvancedMarker>
        )}
        {isGoogleMapsReady &&
          extraRiders?.map((er) => (
            <AdvancedMarker
              key={er.id}
              position={{ lat: er.lat, lng: er.lng }}
              title={er.label}
              onClick={() => onSelectRiderPin?.(er.id)}
            >
              <div
                className={`flex items-center gap-1 px-2.5 py-1 rounded-full text-[11px] font-bold shadow-md border-2 ${
                  er.selected
                    ? 'bg-[#E21B70] text-white border-white scale-110'
                    : er.isAvailable
                    ? 'bg-emerald-600 text-white border-white'
                    : 'bg-neutral-600 text-white border-white'
                }`}
              >
                <Bike className="w-3 h-3 shrink-0" />
                <span>{er.label}</span>
              </div>
            </AdvancedMarker>
          ))}
        {isGoogleMapsReady && secondaryPoint && (
          <RouteOverlay
            origin={{ lat: secondaryPoint.lat, lng: secondaryPoint.lng }}
            destination={center}
            skipFitBounds={Boolean(riderPoint)}
          />
        )}
        {isGoogleMapsReady && (
          <TrackingBoundsAndRiderVector
            center={center}
            secondaryPoint={secondaryPoint}
            riderPoint={riderPoint}
            riderTarget={riderTarget}
          />
        )}
      </GoogleMap>
      {interactive && (
        <div className="absolute bottom-2.5 left-2.5 right-12 flex items-center justify-between gap-2 bg-white/95 backdrop-blur-xs border border-neutral-200 rounded-lg px-2.5 py-1.5 text-[11px] font-medium text-neutral-700 shadow-xs">
          <span className="truncate">
            {resolving
              ? lang === 'bn'
                ? 'ঠিকানা নির্ধারণ হচ্ছে...'
                : 'Setting pinned location...'
              : markerLabel
              ? `${markerLabel} · `
              : lang === 'bn'
              ? 'ম্যাপে ক্লিক বা পিন টানুন · '
              : 'Click map or drag pin · '}
            <span className="font-mono-nums text-neutral-500">
              {center.lat.toFixed(4)}, {center.lng.toFixed(4)}
            </span>
          </span>
          <button
            type="button"
            onClick={() => {
              if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                  (pos) => emitLocation(pos.coords.latitude, pos.coords.longitude, false),
                  () => emitLocation(23.7949, 90.4144, false)
                );
              }
            }}
            className="inline-flex items-center gap-1 text-[#E21B70] font-bold hover:underline whitespace-nowrap shrink-0"
          >
            <LocateFixed className="w-3.5 h-3.5" />
            <span>GPS</span>
          </button>
        </div>
      )}
    </div>
  );
}

function buildLeafletPinHtml(label: string, role: 'user' | 'vendor'): string {
  const isVendor = role === 'vendor';
  const fill = isVendor ? '#111827' : '#DC2626';
  const stroke = isVendor ? '#000000' : '#991B1B';
  return `
    <div style="display:flex;flex-direction:column;align-items:center;transform:translate(-50%,-100%);pointer-events:auto;">
      <span style="padding:2px 8px;border-radius:6px;background:${fill};border:1px solid ${stroke};color:#ffffff;font-size:11px;font-weight:700;white-space:nowrap;box-shadow:0 2px 6px rgba(0,0,0,0.28);margin-bottom:3px;line-height:1.25;">${escapeHtml(label)}</span>
      <svg width="26" height="34" viewBox="0 0 28 36" fill="none" xmlns="http://www.w3.org/2000/svg" style="filter:drop-shadow(0 2px 4px rgba(0,0,0,0.32));">
        <path d="M14 1.5C7.09644 1.5 1.5 7.09644 1.5 14C1.5 23.25 14 34.5 14 34.5C14 34.5 26.5 23.25 26.5 14C26.5 7.09644 20.9036 1.5 14 1.5Z" fill="${fill}" stroke="${stroke}" stroke-width="2"/>
        <circle cx="14" cy="13.5" r="4.8" fill="#FFFFFF"/>
      </svg>
    </div>
  `;
}

function buildLeafletRiderHtml(label: string, selected = false, isAvailable = true): string {
  const bg = selected ? '#E21B70' : isAvailable ? '#059669' : '#4B5563';
  return `
    <div style="display:inline-flex;align-items:center;gap:4px;padding:3px 9px;border-radius:9999px;background:${bg};color:#fff;font-size:11px;font-weight:700;border:2px solid #fff;box-shadow:0 2px 8px rgba(0,0,0,0.28);white-space:nowrap;transform:translate(-50%,-50%);">
      <span style="width:7px;height:7px;border-radius:9999px;background:#A7F3D0;display:inline-block;"></span>
      <span>🛵 ${escapeHtml(label)}</span>
    </div>
  `;
}

function FallbackDhakaMap({
  lang,
  center,
  markerLabel,
  pinType,
  userName,
  restaurantName,
  secondaryPoint,
  riderPoint,
  riderTarget,
  extraRiders,
  onSelectRiderPin,
  interactive,
  heightClass,
  onSelectLocation,
}: Omit<DhakaMapPickerProps, 'mapsApiKey'>) {
  const containerRef = useRef<HTMLDivElement | null>(null);
  const mapRef = useRef<L.Map | null>(null);
  const layersRef = useRef<L.LayerGroup | null>(null);
  const fittedKeyRef = useRef<string>('');
  const onSelectRef = useRef(onSelectLocation);
  const onSelectRiderRef = useRef(onSelectRiderPin);
  onSelectRef.current = onSelectLocation;
  onSelectRiderRef.current = onSelectRiderPin;

  const reverseSeqRef = useRef(0);
  const [resolving, setResolving] = useState(false);

  const pinAppearance = resolveMapPinAppearance({
    pinType,
    userName,
    restaurantName,
    markerLabel,
    secondaryLabel: secondaryPoint?.label,
  });

  const distance = secondaryPoint
    ? haversineDistanceKm(center.lat, center.lng, secondaryPoint.lat, secondaryPoint.lng)
    : null;

  const allInsideDhaka = [
    center,
    ...(secondaryPoint ? [secondaryPoint] : []),
    ...(riderPoint ? [riderPoint] : []),
    ...(extraRiders || []),
  ].every((pt) => isPointInsideDhakaMetro(pt.lat, pt.lng));

  const emitOsmLocation = (lat: number, lng: number, preferredAreaName?: string) => {
    const cb = onSelectRef.current;
    if (!cb || !Number.isFinite(lat) || !Number.isFinite(lng)) return;

    const nearest = resolveNearestAreaFromList(lat, lng, BANGLADESH_AREAS);
    const immediateName =
      preferredAreaName ||
      (nearest.area && nearest.distanceKm <= 6
        ? nearest.area.name
        : `Pinned (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
    const immediateDisplayName = preferredAreaName
      ? `${preferredAreaName}, Bangladesh`
      : nearest.area && nearest.distanceKm <= 6
      ? `${nearest.area.name}, Bangladesh`
      : `Pinned (${lat.toFixed(4)}, ${lng.toFixed(4)}), Bangladesh`;

    cb({
      lat,
      lng,
      areaName: immediateName,
      displayName: immediateDisplayName,
    });

    const seq = ++reverseSeqRef.current;
    setResolving(true);
    apiFetch<{ displayName: string; areaName: string }>(
      `/api/free/reverse-geocode?lat=${lat}&lng=${lng}&lang=${lang}`
    )
      .then((res) => {
        if (seq !== reverseSeqRef.current) return;
        const cleanArea =
          preferredAreaName ||
          matchCanonicalAreaFromHints([res.areaName, res.displayName], lat, lng, BANGLADESH_AREAS) ||
          immediateName;
        onSelectRef.current?.({
          lat,
          lng,
          areaName: cleanArea,
          displayName: res.displayName || immediateDisplayName,
        });
      })
      .catch(() => {})
      .finally(() => {
        if (seq === reverseSeqRef.current) {
          setResolving(false);
        }
      });
  };

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;

    const initialZoom =
      (extraRiders && extraRiders.length > 0) || !isPointInsideDhakaMetro(center.lat, center.lng)
        ? 8
        : 15;

    const map = L.map(el, {
      center: [center.lat, center.lng],
      zoom: initialZoom,
      zoomControl: true,
      attributionControl: false,
    });

    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
      maxZoom: 19,
      subdomains: ['a', 'b', 'c'],
    }).addTo(map);

    const group = L.layerGroup().addTo(map);
    mapRef.current = map;
    layersRef.current = group;

    const resizeObserver =
      typeof ResizeObserver !== 'undefined'
        ? new ResizeObserver(() => {
            map.invalidateSize({ animate: false });
          })
        : null;
    resizeObserver?.observe(el);

    return () => {
      resizeObserver?.disconnect();
      map.remove();
      mapRef.current = null;
      layersRef.current = null;
      fittedKeyRef.current = '';
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    const map = mapRef.current;
    if (!map) return;
    const handleClick = (ev: L.LeafletMouseEvent) => {
      if (!interactive) return;
      emitOsmLocation(ev.latlng.lat, ev.latlng.lng);
    };
    map.on('click', handleClick);
    return () => {
      map.off('click', handleClick);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [interactive, lang]);

  useEffect(() => {
    const map = mapRef.current;
    const group = layersRef.current;
    if (!map || !group) return;

    group.clearLayers();

    if (secondaryPoint) {
      L.polyline(
        [
          [secondaryPoint.lat, secondaryPoint.lng],
          [center.lat, center.lng],
        ],
        { color: '#E21B70', weight: 4, opacity: 0.85, dashArray: '8 6' }
      ).addTo(group);
    }

    if (riderPoint) {
      const target = riderTarget || center;
      L.polyline(
        [
          [riderPoint.lat, riderPoint.lng],
          [target.lat, target.lng],
        ],
        { color: '#059669', weight: 3.5, opacity: 0.85 }
      ).addTo(group);
    }

    const primaryIcon = L.divIcon({
      className: 'foodora-osm-pin-wrapper !bg-transparent !border-0',
      html: buildLeafletPinHtml(pinAppearance.primaryLabel, pinAppearance.primaryRole),
      iconSize: [0, 0],
      iconAnchor: [0, 0],
    });
    const primaryMarker = L.marker([center.lat, center.lng], {
      icon: primaryIcon,
      draggable: Boolean(interactive),
      title: pinAppearance.primaryLabel,
    }).addTo(group);

    if (interactive) {
      primaryMarker.on('dragend', () => {
        const ll = primaryMarker.getLatLng();
        emitOsmLocation(ll.lat, ll.lng);
      });
    }

    if (secondaryPoint) {
      const vendorIcon = L.divIcon({
        className: 'foodora-osm-pin-wrapper !bg-transparent !border-0',
        html: buildLeafletPinHtml(
          pinAppearance.secondaryLabel || secondaryPoint.label,
          'vendor'
        ),
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      L.marker([secondaryPoint.lat, secondaryPoint.lng], {
        icon: vendorIcon,
        title: pinAppearance.secondaryLabel || secondaryPoint.label,
      }).addTo(group);
    }

    if (riderPoint) {
      const riderIcon = L.divIcon({
        className: 'foodora-osm-rider-wrapper !bg-transparent !border-0',
        html: buildLeafletRiderHtml(riderPoint.label, false, true),
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      L.marker([riderPoint.lat, riderPoint.lng], {
        icon: riderIcon,
        title: riderPoint.label,
      }).addTo(group);
    }

    extraRiders?.forEach((er) => {
      const erIcon = L.divIcon({
        className: 'foodora-osm-rider-wrapper !bg-transparent !border-0',
        html: buildLeafletRiderHtml(er.label, Boolean(er.selected), er.isAvailable),
        iconSize: [0, 0],
        iconAnchor: [0, 0],
      });
      const m = L.marker([er.lat, er.lng], {
        icon: erIcon,
        title: er.label,
      }).addTo(group);
      m.on('click', () => {
        onSelectRiderRef.current?.(er.id);
      });
    });

    const multiPoints: Array<[number, number]> = [[center.lat, center.lng]];
    if (secondaryPoint) multiPoints.push([secondaryPoint.lat, secondaryPoint.lng]);
    if (riderPoint) multiPoints.push([riderPoint.lat, riderPoint.lng]);
    if (extraRiders && extraRiders.length > 0) {
      extraRiders.forEach((er) => multiPoints.push([er.lat, er.lng]));
    }

    if (multiPoints.length > 1) {
      const boundsKey = multiPoints.map((pt) => `${pt[0].toFixed(4)},${pt[1].toFixed(4)}`).join('|');
      if (fittedKeyRef.current !== boundsKey) {
        map.fitBounds(L.latLngBounds(multiPoints), { padding: [42, 42], maxZoom: 15 });
        fittedKeyRef.current = boundsKey;
      }
    } else {
      const singleKey = `single:${center.lat.toFixed(5)},${center.lng.toFixed(5)}`;
      if (fittedKeyRef.current !== singleKey) {
        map.setView(
          [center.lat, center.lng],
          Math.max(map.getZoom(), isPointInsideDhakaMetro(center.lat, center.lng) ? 15 : 13),
          { animate: true }
        );
        fittedKeyRef.current = singleKey;
      }
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    center.lat,
    center.lng,
    pinAppearance.primaryLabel,
    pinAppearance.primaryRole,
    pinAppearance.secondaryLabel,
    secondaryPoint?.lat,
    secondaryPoint?.lng,
    secondaryPoint?.label,
    riderPoint?.lat,
    riderPoint?.lng,
    riderPoint?.label,
    riderTarget?.lat,
    riderTarget?.lng,
    extraRiders,
    interactive,
  ]);

  const pinButtons = allInsideDhaka
    ? DHAKA_AREAS.slice(0, 6)
    : BANGLADESH_AREAS.filter((a) => MAJOR_BD_CITY_NAMES.has(a.name)).slice(0, 6);

  return (
    <div
      data-testid="osm-free-map"
      className={`relative w-full overflow-hidden rounded-xl border border-neutral-200 bg-[#EEF2F6] ${heightClass || 'h-[260px]'}`}
    >
      <div ref={containerRef} className="w-full h-full z-0" />

      <span className="pointer-events-none absolute top-2 right-2 z-[400] px-2 py-0.5 rounded-md bg-white/95 border border-emerald-200 text-[10px] font-bold text-emerald-700 shadow-xs">
        🌍 OpenStreetMap · Free
      </span>

      {interactive && (
        <div className="absolute top-2 left-12 right-36 z-[400] hidden sm:flex items-center gap-1 overflow-x-auto no-scrollbar pointer-events-auto">
          {pinButtons.map((area) => {
            const isClose =
              Math.abs(area.lat - center.lat) < 0.008 && Math.abs(area.lng - center.lng) < 0.008;
            return (
              <button
                key={area.name}
                type="button"
                onClick={(ev) => {
                  ev.stopPropagation();
                  emitOsmLocation(area.lat, area.lng, area.name);
                }}
                className={`px-2 py-0.5 rounded-md text-[10px] font-semibold whitespace-nowrap shadow-xs transition-colors ${
                  isClose
                    ? 'bg-[#E21B70] text-white'
                    : 'bg-white/95 text-[#2E3138] border border-neutral-200 hover:border-[#E21B70]'
                }`}
              >
                {area.name}
              </button>
            );
          })}
        </div>
      )}

      <div className="absolute bottom-2 left-2 right-2 z-[400] flex items-center justify-between gap-2 bg-white/95 backdrop-blur-xs border border-neutral-200 rounded-lg px-3 py-1.5 text-xs text-neutral-600 shadow-xs">
        <span className="truncate">
          {resolving ? (
            <span className="font-medium text-[#E21B70]">
              {lang === 'bn' ? 'ঠিকানা নির্ধারণ হচ্ছে...' : 'Resolving street address...'}
            </span>
          ) : (
            <span className="font-mono-nums">
              {interactive
                ? lang === 'bn'
                  ? 'ম্যাপে ক্লিক বা পিন টানুন · '
                  : 'Tap map or drag pin · '
                : ''}
              {center.lat.toFixed(4)}, {center.lng.toFixed(4)}
              {distance !== null ? ` · ${distance.toFixed(1)} km` : ''}
              {riderPoint ? ` · Rider ${riderPoint.lat.toFixed(4)}, ${riderPoint.lng.toFixed(4)}` : ''}
            </span>
          )}
        </span>
        {interactive && (
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              if (navigator.geolocation) {
                navigator.geolocation.getCurrentPosition(
                  (pos) => emitOsmLocation(pos.coords.latitude, pos.coords.longitude),
                  () => emitOsmLocation(23.7949, 90.4144, 'Gulshan 2')
                );
              } else {
                emitOsmLocation(23.7949, 90.4144, 'Gulshan 2');
              }
            }}
            className="inline-flex items-center gap-1 text-[#E21B70] font-bold hover:underline whitespace-nowrap shrink-0"
          >
            <LocateFixed className="w-3.5 h-3.5" />
            <span>GPS</span>
          </button>
        )}
      </div>
    </div>
  );
}

export function DhakaMapPicker(props: DhakaMapPickerProps) {
  const effectiveApiKey =
    props.mapsApiKey || (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || '';

  const [useFallback, setUseFallback] = useState<boolean>(() => {
    if (!effectiveApiKey) return true;
    if (isGoogleMapsBlockedInSession()) return true;
    return getPreferredMapMode() === 'osm';
  });
  const [activeMethod, setActiveMethod] = useState<'gps' | 'google_maps' | 'wifi' | 'cell_tower' | 'pin'>('google_maps');
  const [positioningNote, setPositioningNote] = useState<string>('');
  const [showGuide, setShowGuide] = useState(false);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    if (!effectiveApiKey || isGoogleMapsBlockedInSession()) {
      setUseFallback(true);
      return;
    }
    const handleAuthFailure = () => {
      setGoogleMapsBlockedInSession(true);
      setUseFallback(true);
      setPositioningNote(
        props.lang === 'bn'
          ? '⚠️ গুগল ম্যাপস লোড হয়নি বা এপিআই রেস্ট্রিকশন সমস্যা — ফ্রি OpenStreetMap চালু হয়েছে'
          : '⚠️ Google Maps auth/loading error detected — switched to free interactive OpenStreetMap.'
      );
    };
    window.addEventListener('gm_authFailure', handleAuthFailure);

    const handleQuotaExceeded = () => {
      setGoogleMapsBlockedInSession(true);
      setUseFallback(true);
      setPositioningNote(
        props.lang === 'bn'
          ? '⚠️ গুগল ম্যাপস দৈনিক কোটা পূর্ণ হয়েছে — ফ্রি OpenStreetMap চালু হয়েছে'
          : '⚠️ Google Maps quota reached — switched to unlimited free OpenStreetMap.'
      );
    };
    window.addEventListener('gmp-quota-exceeded', handleQuotaExceeded);

    const timer = setTimeout(() => {
      if (typeof window !== 'undefined' && !(window as any).google?.maps && !useFallback) {
        setUseFallback(true);
      }
    }, 5000);

    return () => {
      window.removeEventListener('gm_authFailure', handleAuthFailure);
      window.removeEventListener('gmp-quota-exceeded', handleQuotaExceeded);
      clearTimeout(timer);
    };
  }, [effectiveApiKey, props.lang, useFallback]);

  const handleSelectLocation = (coords: {
    lat: number;
    lng: number;
    areaName?: string;
    displayName?: string;
  }) => {
    setActiveMethod('pin');
    setPositioningNote(
      props.lang === 'bn'
        ? `📍 ম্যাপ পিন: গ্রাহক নির্ধারিত সুনির্দিষ্ট ঠিকানা (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`
        : `📍 Location Pin: Doorstep pinpoint (${coords.lat.toFixed(4)}, ${coords.lng.toFixed(4)})`
    );
    props.onSelectLocation?.(coords);
  };

  const handleDetectGps = () => {
    if (!navigator.geolocation) {
      setPositioningNote(
        props.lang === 'bn' ? 'ব্রাউজারে GPS সাপোর্ট নেই' : 'Geolocation not supported in browser'
      );
      return;
    }
    setDetecting(true);
    setPositioningNote(
      props.lang === 'bn' ? 'স্যাটেলাইট জিপিএস সিগন্যাল খোঁজা হচ্ছে...' : 'Acquiring GPS / GNSS satellite signal...'
    );
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDetecting(false);
        setActiveMethod('gps');
        const acc = Math.round(pos.coords.accuracy);
        setPositioningNote(
          props.lang === 'bn'
            ? `🛰️ GPS / GNSS স্যাটেলাইট লক (নির্ভুলতা: ±${acc} মি)`
            : `🛰️ GPS / GNSS Satellite Locked (accuracy: ±${acc}m)`
        );
        props.onSelectLocation?.({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
      },
      () => {
        setDetecting(false);
        setPositioningNote(
          props.lang === 'bn'
            ? 'জিপিএস সিগন্যাল পাওয়া যায়নি, ডিফল্ট লোকেশন সক্রিয়'
            : 'Satellite fix timed out, falling back to default location'
        );
        props.onSelectLocation?.({
          lat: 23.7949,
          lng: 90.4144,
          areaName: 'Gulshan 2',
        });
      },
      { enableHighAccuracy: true, timeout: 10000, maximumAge: 0 }
    );
  };

  const handleDetectWifiOrCell = () => {
    if (!navigator.geolocation) {
      setPositioningNote(
        props.lang === 'bn' ? 'ব্রাউজারে নেটওয়ার্ক লোকেশন সাপোর্ট নেই' : 'Network location not supported'
      );
      return;
    }
    setDetecting(true);
    setPositioningNote(
      props.lang === 'bn'
        ? 'ওয়াইফাই / মোবাইল টাওয়ার অবস্থান যাচাই হচ্ছে...'
        : 'Estimating location via Wi-Fi / Cell tower...'
    );
    navigator.geolocation.getCurrentPosition(
      (pos) => {
        setDetecting(false);
        setActiveMethod('wifi');
        const acc = Math.round(pos.coords.accuracy);
        setPositioningNote(
          props.lang === 'bn'
            ? `📶 ওয়াইফাই / সেলুলার টাওয়ার অবস্থান (±${acc} মি)`
            : `📶 Wi-Fi / Cell Tower Network Estimated (±${acc}m)`
        );
        props.onSelectLocation?.({
          lat: pos.coords.latitude,
          lng: pos.coords.longitude,
        });
      },
      () => {
        setDetecting(false);
        setPositioningNote(
          props.lang === 'bn'
            ? 'নেটওয়ার্ক পজিশনিং ব্যর্থ, ম্যাপ পিন দিয়ে নির্বাচন করুন'
            : 'Network estimate unavailable, please drag map pin'
        );
      },
      { enableHighAccuracy: false, timeout: 8000, maximumAge: 60000 }
    );
  };

  const handleMapsCrashOrAuthFailure = () => {
    setGoogleMapsBlockedInSession(true);
    setPreferredMapMode('osm');
    setUseFallback(true);
    setPositioningNote(
      props.lang === 'bn'
        ? '⚠️ গুগল ম্যাপস লোড হয়নি বা এপিআই কী চালু নেই — ফ্রি OpenStreetMap চালু হয়েছে'
        : '⚠️ Google Maps failed to authenticate/activate — switched safely to OpenStreetMap.'
    );
  };

  const mapContent =
    !effectiveApiKey || useFallback ? (
      <FallbackDhakaMap
        lang={props.lang}
        center={props.center}
        markerLabel={props.markerLabel}
        pinType={props.pinType}
        userName={props.userName}
        restaurantName={props.restaurantName}
        secondaryPoint={props.secondaryPoint}
        riderPoint={props.riderPoint}
        riderTarget={props.riderTarget}
        extraRiders={props.extraRiders}
        onSelectRiderPin={props.onSelectRiderPin}
        interactive={props.interactive}
        heightClass={props.heightClass}
        onSelectLocation={handleSelectLocation}
      />
    ) : (
      <GoogleMapErrorBoundary onCrash={handleMapsCrashOrAuthFailure}>
        <APIProvider
          apiKey={effectiveApiKey}
          language={props.lang}
          region="BD"
          libraries={['places', 'marker']}
          onError={handleMapsCrashOrAuthFailure}
        >
          <GoogleMapInner
            lang={props.lang}
            center={props.center}
            markerLabel={props.markerLabel}
            pinType={props.pinType}
            userName={props.userName}
            restaurantName={props.restaurantName}
            secondaryPoint={props.secondaryPoint}
            riderPoint={props.riderPoint}
            riderTarget={props.riderTarget}
            extraRiders={props.extraRiders}
            onSelectRiderPin={props.onSelectRiderPin}
            interactive={props.interactive}
            heightClass={props.heightClass}
            onSelectLocation={handleSelectLocation}
          />
        </APIProvider>
      </GoogleMapErrorBoundary>
    );

  if (!props.interactive) {
    return mapContent;
  }

  return (
    <div className="space-y-2">
      {mapContent}

      {/* Clean Single-Row Positioning Controls & Expandable 5-Method Guide */}
      <div className="rounded-xl border border-neutral-200 bg-neutral-50/90 px-3 py-2 space-y-2 text-xs">
        <div className="flex flex-wrap items-center justify-between gap-2">
          <div className="flex items-center gap-1.5">
            {effectiveApiKey && (
              <button
                type="button"
                onClick={() => {
                  const nextFallback = !useFallback;
                  if (!nextFallback) {
                    setGoogleMapsBlockedInSession(false);
                    setPreferredMapMode('google');
                  } else {
                    setPreferredMapMode('osm');
                  }
                  setUseFallback(nextFallback);
                }}
                className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border font-semibold text-[11px] bg-white border-neutral-200 hover:border-[#E21B70] text-[#E21B70]"
                title="Switch between Google Maps and Free OpenStreetMap"
              >
                <span>
                  {useFallback
                    ? props.lang === 'bn'
                      ? '🗺️ গুগল ম্যাপস চেষ্টা করুন'
                      : '🗺️ Try Google Maps'
                    : props.lang === 'bn'
                    ? '🌍 ফ্রি OpenStreetMap'
                    : '🌍 Free OpenStreetMap'}
                </span>
              </button>
            )}

            <button
              type="button"
              disabled={detecting}
              onClick={handleDetectGps}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border font-semibold text-[11px] transition-colors disabled:opacity-50 ${
                activeMethod === 'gps'
                  ? 'bg-emerald-600 border-emerald-600 text-white'
                  : 'bg-white border-neutral-200 hover:border-emerald-500 text-neutral-700'
              }`}
              title="GPS / GNSS Satellite Positioning"
            >
              <Satellite className="w-3 h-3 shrink-0" />
              <span>{props.lang === 'bn' ? 'GPS' : 'GPS'}</span>
            </button>

            <button
              type="button"
              disabled={detecting}
              onClick={handleDetectWifiOrCell}
              className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border font-semibold text-[11px] transition-colors disabled:opacity-50 ${
                activeMethod === 'wifi' || activeMethod === 'cell_tower'
                  ? 'bg-blue-600 border-blue-600 text-white'
                  : 'bg-white border-neutral-200 hover:border-blue-500 text-neutral-700'
              }`}
              title="Wi-Fi / Cell Tower Positioning"
            >
              <Wifi className="w-3 h-3 shrink-0" />
              <span>{props.lang === 'bn' ? 'ওয়াইফাই / সেল' : 'Wi-Fi / Cell'}</span>
            </button>

            <span className="hidden sm:inline-flex items-center gap-1 px-2 py-1 text-[11px] text-neutral-500">
              <MapPin className="w-3 h-3 text-[#E21B70] shrink-0" />
              <span>
                {activeMethod === 'gps'
                  ? 'GPS/GNSS'
                  : activeMethod === 'wifi'
                  ? 'Wi-Fi'
                  : activeMethod === 'cell_tower'
                  ? 'Cell Tower'
                  : activeMethod === 'pin'
                  ? 'Location Pin'
                  : effectiveApiKey && !useFallback
                  ? 'Google Maps'
                  : 'Map Pin'}
              </span>
            </span>
          </div>

          <button
            type="button"
            onClick={() => setShowGuide((v) => !v)}
            className="inline-flex items-center gap-1 px-2 py-1 rounded-lg hover:bg-neutral-200/60 text-neutral-600 hover:text-[#2E3138] text-[11px] font-medium transition-colors"
            title="View all 5 location positioning methods"
          >
            <Info className="w-3 h-3 shrink-0 text-[#E21B70]" />
            <span>{props.lang === 'bn' ? 'লোকেশন পদ্ধতি' : 'Methods Guide'}</span>
            {showGuide ? <ChevronUp className="w-3 h-3 shrink-0" /> : <ChevronDown className="w-3 h-3 shrink-0" />}
          </button>
        </div>

        {/* Live status feedback line */}
        {positioningNote && (
          <p className="text-[11px] text-neutral-700 font-medium flex items-center gap-1.5 pt-0.5">
            <span className="w-1.5 h-1.5 rounded-full bg-[#E21B70] shrink-0" />
            <span>{positioningNote}</span>
          </p>
        )}

        {/* Expandable Location Positioning Methods Details (Exact User Specifications) */}
        {showGuide && (
          <div className="pt-2 border-t border-neutral-200 space-y-1.5 text-[11px] text-neutral-700 bg-white rounded-lg p-2.5">
            <p className="font-bold text-[#2E3138] text-xs">
              {props.lang === 'bn' ? 'সিস্টেমের ৫টি লোকেশন ও পজিশনিং পদ্ধতি:' : '5 Integrated Location Positioning Mechanisms:'}
            </p>
            <div className="grid grid-cols-1 sm:grid-cols-2 gap-2 text-[11px] leading-relaxed">
              <div className="p-1.5 rounded bg-emerald-50/70 border border-emerald-200">
                <p className="font-bold text-emerald-800 flex items-center gap-1">
                  <Satellite className="w-3 h-3 shrink-0" />
                  <span>GPS / GNSS (স্যাটেলাইট)</span>
                </p>
                <p className="text-neutral-600">
                  {props.lang === 'bn'
                    ? 'স্যাটেলাইট থেকে আপনার বর্তমান অবস্থান ও latitude-longitude নির্ণয় করে।'
                    : 'Determines precise geographical latitude & longitude directly from global satellites.'}
                </p>
              </div>

              <div className="p-1.5 rounded bg-pink-50/70 border border-pink-200">
                <p className="font-bold text-[#E21B70] flex items-center gap-1">
                  <MapPin className="w-3 h-3 shrink-0" />
                  <span>Google Maps Platform</span>
                </p>
                <p className="text-neutral-600">
                  {props.lang === 'bn'
                    ? 'অনেক ক্ষেত্রে ম্যাপ দেখানো, রাস্তা, লোকেশন ও address selection-এর জন্য Google Maps services ব্যবহার করে।'
                    : 'Renders map views, driving roads, place search, and reverse geocoding services.'}
                </p>
              </div>

              <div className="p-1.5 rounded bg-blue-50/70 border border-blue-200">
                <p className="font-bold text-blue-800 flex items-center gap-1">
                  <Wifi className="w-3 h-3 shrink-0" />
                  <span>Wi-Fi positioning</span>
                </p>
                <p className="text-neutral-600">
                  {props.lang === 'bn'
                    ? 'আশেপাশের Wi-Fi নেটওয়ার্ক থেকে location estimate করতে পারে।'
                    : 'Estimates indoor and urban location by triangulating nearby Wi-Fi network signals.'}
                </p>
              </div>

              <div className="p-1.5 rounded bg-amber-50/70 border border-amber-200">
                <p className="font-bold text-amber-800 flex items-center gap-1">
                  <Radio className="w-3 h-3 shrink-0" />
                  <span>Cell tower (Mobile network)</span>
                </p>
                <p className="text-neutral-600">
                  {props.lang === 'bn'
                    ? 'মোবাইল নেটওয়ার্কের tower থেকেও আনুমানিক অবস্থান শনাক্ত করা সম্ভব।'
                    : 'Detects coarse geographic location from cellular carrier base-station towers.'}
                </p>
              </div>
            </div>

            <div className="p-1.5 rounded bg-neutral-100 border border-neutral-300">
              <p className="font-bold text-neutral-800 flex items-center gap-1">
                <MapPin className="w-3 h-3 text-[#E21B70] shrink-0" />
                <span>Location pin (ম্যাপ পিন)</span>
              </p>
              <p className="text-neutral-600">
                {props.lang === 'bn'
                  ? 'গ্রাহক নিজে ম্যাপে pin সরিয়ে delivery address নির্ধারণ করতে পারেন।'
                  : 'Customer can manually drag or tap the pin on the map to accurately pinpoint delivery doorstep.'}
              </p>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
