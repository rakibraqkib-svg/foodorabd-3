import React, { useEffect, useRef, useState } from 'react';
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

export interface ExtraRiderMapPin {
  id: number;
  label: string;
  lat: number;
  lng: number;
  isAvailable: boolean;
  selected?: boolean;
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
        {secondaryPoint && (
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
        {riderPoint && (
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
        {extraRiders?.map((er) => (
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
        {secondaryPoint && (
          <RouteOverlay
            origin={{ lat: secondaryPoint.lat, lng: secondaryPoint.lng }}
            destination={center}
            skipFitBounds={Boolean(riderPoint)}
          />
        )}
        <TrackingBoundsAndRiderVector
          center={center}
          secondaryPoint={secondaryPoint}
          riderPoint={riderPoint}
          riderTarget={riderTarget}
        />
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

function FallbackDhakaMap({
  lang,
  center,
  markerLabel,
  pinType,
  userName,
  restaurantName,
  secondaryPoint,
  riderPoint,
  extraRiders,
  onSelectRiderPin,
  interactive,
  heightClass,
  onSelectLocation,
}: Omit<DhakaMapPickerProps, 'mapsApiKey'>) {
  const [showOsm, setShowOsm] = useState(false);
  const reverseSeqRef = useRef(0);
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

  const allPoints: Array<{ lat: number; lng: number }> = [
    center,
    ...(secondaryPoint ? [secondaryPoint] : []),
    ...(riderPoint ? [riderPoint] : []),
    ...(extraRiders || []),
  ];
  const allInsideDhaka = allPoints.every((pt) => isPointInsideDhakaMetro(pt.lat, pt.lng));

  // Scale either to Dhaka metro or All-Bangladesh depending on coordinates present
  const bounds = allInsideDhaka
    ? { minLat: 23.71, maxLat: 23.89, minLng: 90.34, maxLng: 90.47 }
    : { minLat: 20.6, maxLat: 26.5, minLng: 88.1, maxLng: 92.6 };

  const toXY = (lat: number, lng: number) => {
    const x = Math.min(93, Math.max(7, ((lng - bounds.minLng) / (bounds.maxLng - bounds.minLng)) * 100));
    const y = Math.min(89, Math.max(10, (1 - (lat - bounds.minLat) / (bounds.maxLat - bounds.minLat)) * 100));
    return { x, y };
  };

  const emitFallbackPoint = (lat: number, lng: number, preferredAreaName?: string) => {
    if (!onSelectLocation) return;
    const nearest = resolveNearestAreaFromList(lat, lng, BANGLADESH_AREAS);
    const immediateName =
      preferredAreaName ||
      (nearest.area && nearest.distanceKm <= 6
        ? nearest.area.name
        : `Pinned (${lat.toFixed(4)}, ${lng.toFixed(4)})`);
    const immediateDisplayName =
      preferredAreaName
        ? `${preferredAreaName}, Bangladesh`
        : nearest.area && nearest.distanceKm <= 6
        ? `${nearest.area.name}, Bangladesh`
        : `Pinned (${lat.toFixed(4)}, ${lng.toFixed(4)}), Bangladesh`;
    onSelectLocation({
      lat,
      lng,
      areaName: immediateName,
      displayName: immediateDisplayName,
    });
    const seq = ++reverseSeqRef.current;
    apiFetch<{ displayName: string; areaName: string }>(
      `/api/free/reverse-geocode?lat=${lat}&lng=${lng}&lang=${lang}`
    )
      .then((res) => {
        if (seq !== reverseSeqRef.current) return;
        const cleanArea =
          preferredAreaName ||
          matchCanonicalAreaFromHints([res.areaName, res.displayName], lat, lng, BANGLADESH_AREAS) ||
          immediateName;
        onSelectLocation({
          lat,
          lng,
          areaName: cleanArea,
          displayName: res.displayName || immediateDisplayName,
        });
      })
      .catch(() => {});
  };

  const fromClientPoint = (ev: React.MouseEvent<HTMLDivElement>) => {
    if (!interactive || !onSelectLocation) return;
    const rect = ev.currentTarget.getBoundingClientRect();
    const pctX = ((ev.clientX - rect.left) / Math.max(1, rect.width)) * 100;
    const pctY = ((ev.clientY - rect.top) / Math.max(1, rect.height)) * 100;
    const lng = bounds.minLng + (pctX / 100) * (bounds.maxLng - bounds.minLng);
    const lat = bounds.minLat + (1 - pctY / 100) * (bounds.maxLat - bounds.minLat);
    emitFallbackPoint(lat, lng);
  };

  const p1 = toXY(center.lat, center.lng);
  const p2 = secondaryPoint ? toXY(secondaryPoint.lat, secondaryPoint.lng) : null;
  const pRider = riderPoint ? toXY(riderPoint.lat, riderPoint.lng) : null;

  const pinButtons = allInsideDhaka
    ? DHAKA_AREAS
    : BANGLADESH_AREAS.filter((a) => MAJOR_BD_CITY_NAMES.has(a.name));

  return (
    <div
      onClick={fromClientPoint}
      className={`relative w-full overflow-hidden rounded-xl border border-neutral-200 bg-[#F8FAFC] ${interactive ? 'cursor-crosshair' : ''} ${heightClass || 'h-[260px]'}`}
    >
      {/* Map Grid or OpenStreetMap Embed Alternative */}
      {showOsm ? (
        <iframe
          title="OpenStreetMap Free Alternative"
          className="absolute inset-0 w-full h-full border-0 pointer-events-auto"
          src={`https://www.openstreetmap.org/export/embed.html?bbox=${center.lng - 0.02},${center.lat - 0.02},${center.lng + 0.02},${center.lat + 0.02}&layer=mapnik&marker=${center.lat},${center.lng}`}
        />
      ) : (
        <svg
          className="absolute inset-0 w-full h-full pointer-events-none"
          viewBox="0 0 100 100"
          preserveAspectRatio="none"
        >
          <defs>
            <pattern id="bdGrid" width="12.5" height="12.5" patternUnits="userSpaceOnUse">
              <path d="M 12.5 0 L 0 0 0 12.5" fill="none" stroke="#E2E8F0" strokeWidth="0.4" />
            </pattern>
          </defs>
          <rect width="100" height="100" fill="url(#bdGrid)" />
          <path
            d={allInsideDhaka ? 'M 55 48 Q 62 52 68 46 Q 74 42 78 50' : 'M 42 15 Q 50 45 48 75 Q 52 86 68 92'}
            fill="none"
            stroke="#CBD5E1"
            strokeWidth="2.2"
            strokeLinecap="round"
          />
          {p2 && (
            <line
              x1={p2.x}
              y1={p2.y}
              x2={p1.x}
              y2={p1.y}
              stroke="#E21B70"
              strokeWidth="1.2"
              strokeDasharray="2.5 1.5"
            />
          )}
          {pRider && (
            <line
              x1={pRider.x}
              y1={pRider.y}
              x2={p1.x}
              y2={p1.y}
              stroke="#059669"
              strokeWidth="1.4"
              strokeDasharray="1.8 1.2"
            />
          )}
        </svg>
      )}

      {/* Mode Badge */}
      <span className="pointer-events-none absolute top-2 left-2 z-10 px-2 py-0.5 rounded bg-white/90 border border-neutral-200 text-[10px] font-bold text-neutral-600">
        {allInsideDhaka ? 'Dhaka Metro View' : 'Bangladesh Map View'}
      </span>

      {/* Clickable Quick Area / City Pins */}
      {interactive &&
        pinButtons.map((area) => {
          const pos = toXY(area.lat, area.lng);
          const tol = allInsideDhaka ? 0.008 : 0.08;
          const isClose =
            Math.abs(area.lat - center.lat) < tol && Math.abs(area.lng - center.lng) < tol;
          return (
            <button
              key={area.name}
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                emitFallbackPoint(area.lat, area.lng, area.name);
              }}
              style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
              className={`absolute -translate-x-1/2 -translate-y-1/2 px-2 py-0.5 rounded-md text-[10px] font-semibold transition-colors ${
                isClose
                  ? 'bg-[#E21B70] text-white shadow-sm z-20'
                  : 'bg-white/95 text-[#2E3138] border border-neutral-200 hover:border-[#E21B70] z-10'
              }`}
            >
              {area.name}
            </button>
          );
        })}

      {/* Primary Pin (Red for User, Black for Vendor/Restaurant) */}
      <div
        style={{ left: `${p1.x}%`, top: `${p1.y}%` }}
        className="absolute -translate-x-1/2 -translate-y-full z-20 flex flex-col items-center pointer-events-none"
      >
        <span
          className={`px-2 py-0.5 rounded text-white text-[10px] font-semibold shadow-sm whitespace-nowrap mb-0.5 ${
            pinAppearance.primaryRole === 'vendor' ? 'bg-[#111827]' : 'bg-[#DC2626]'
          }`}
        >
          {pinAppearance.primaryLabel}
        </span>
        <MapPin
          className={`w-5 h-5 ${
            pinAppearance.primaryRole === 'vendor'
              ? 'text-[#111827] fill-[#111827]/25'
              : 'text-[#DC2626] fill-[#DC2626]/25'
          }`}
        />
      </div>

      {/* Restaurant / Origin Pin (Black) */}
      {p2 && secondaryPoint && (
        <div
          style={{ left: `${p2.x}%`, top: `${p2.y}%` }}
          className="absolute -translate-x-1/2 -translate-y-full z-20 flex flex-col items-center pointer-events-none"
        >
          <span className="px-2 py-0.5 rounded bg-[#111827] text-white text-[10px] font-semibold shadow-sm whitespace-nowrap mb-0.5">
            {pinAppearance.secondaryLabel || secondaryPoint.label}
          </span>
          <MapPin className="w-5 h-5 text-[#111827] fill-[#111827]/25" />
        </div>
      )}

      {/* Single Rider Live Marker */}
      {pRider && riderPoint && (
        <div
          style={{ left: `${pRider.x}%`, top: `${pRider.y}%` }}
          className="absolute -translate-x-1/2 -translate-y-1/2 z-30 flex items-center gap-1 px-2.5 py-1 rounded-full bg-emerald-600 text-white text-[10px] font-bold shadow-md border border-white"
        >
          <span className="w-2 h-2 rounded-full bg-emerald-200 animate-pulse" />
          <Bike className="w-3 h-3 shrink-0" />
          <span className="whitespace-nowrap">{riderPoint.label}</span>
        </div>
      )}

      {/* Multi-Rider Fleet Pins (Admin Fleet Control) */}
      {extraRiders?.map((er) => {
        const pos = toXY(er.lat, er.lng);
        return (
          <button
            key={er.id}
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              onSelectRiderPin?.(er.id);
            }}
            style={{ left: `${pos.x}%`, top: `${pos.y}%` }}
            className={`absolute -translate-x-1/2 -translate-y-1/2 flex items-center gap-1 px-2 py-1 rounded-full text-[10px] font-bold shadow-md border transition-transform ${
              er.selected
                ? 'bg-[#E21B70] text-white border-white z-40 scale-110'
                : er.isAvailable
                ? 'bg-emerald-600 text-white border-white z-30 hover:scale-105'
                : 'bg-neutral-600 text-white border-white z-20 hover:scale-105'
            }`}
          >
            <Bike className="w-3 h-3 shrink-0" />
            <span className="whitespace-nowrap">{er.label}</span>
          </button>
        );
      })}

      <div className="absolute bottom-2 left-2 right-2 flex items-center justify-between gap-2 bg-white/95 border border-neutral-200 rounded-lg px-3 py-1.5 text-xs text-neutral-600">
        <span className="font-mono-nums truncate">
          {center.lat.toFixed(4)}, {center.lng.toFixed(4)}
          {distance !== null ? ` · ${distance.toFixed(1)} km` : ''}
          {riderPoint ? ` · Rider ${riderPoint.lat.toFixed(4)}, ${riderPoint.lng.toFixed(4)}` : ''}
        </span>
        <div className="flex items-center gap-2">
          <button
            type="button"
            onClick={(ev) => {
              ev.stopPropagation();
              setShowOsm(!showOsm);
            }}
            className="inline-flex items-center gap-1 bg-neutral-100 hover:bg-neutral-200 text-neutral-700 font-semibold px-2 py-0.5 rounded text-[11px] border border-neutral-300"
            title="Toggle OpenStreetMap vs Vector Grid"
          >
            <span>{showOsm ? '⚡ Vector Map' : '🌍 OpenStreetMap'}</span>
          </button>
          {interactive && (
            <button
              type="button"
              onClick={(ev) => {
                ev.stopPropagation();
                if (navigator.geolocation) {
                  navigator.geolocation.getCurrentPosition(
                    (pos) => emitFallbackPoint(pos.coords.latitude, pos.coords.longitude),
                    () => emitFallbackPoint(23.7949, 90.4144, 'Gulshan 2')
                  );
                } else {
                  emitFallbackPoint(23.7949, 90.4144, 'Gulshan 2');
                }
              }}
              className="inline-flex items-center gap-1 text-[#E21B70] font-semibold hover:underline whitespace-nowrap shrink-0"
            >
              <LocateFixed className="w-3.5 h-3.5" />
              <span>GPS</span>
            </button>
          )}
        </div>
      </div>
    </div>
  );
}

export function DhakaMapPicker(props: DhakaMapPickerProps) {
  const effectiveApiKey =
    props.mapsApiKey || (import.meta.env.VITE_GOOGLE_MAPS_API_KEY as string | undefined) || '';

  const [useFallback, setUseFallback] = useState(!effectiveApiKey);
  const [activeMethod, setActiveMethod] = useState<'gps' | 'google_maps' | 'wifi' | 'cell_tower' | 'pin'>('google_maps');
  const [positioningNote, setPositioningNote] = useState<string>('');
  const [showGuide, setShowGuide] = useState(false);
  const [detecting, setDetecting] = useState(false);

  useEffect(() => {
    if (!effectiveApiKey) {
      setUseFallback(true);
      return;
    }
    const handleAuthFailure = () => {
      setUseFallback(true);
      setPositioningNote(
        props.lang === 'bn'
          ? '⚠️ গুগল ম্যাপস লোড হয়নি বা এপিআই রেস্ট্রিকশন সমস্যা (ফলব্যাক ভেক্টর ম্যাপ সক্রিয়)'
          : '⚠️ Google Maps auth/loading failure detected. Switched to high-speed vector fallback map.'
      );
    };
    window.addEventListener('gm_authFailure', handleAuthFailure);

    const handleQuotaExceeded = () => {
      setUseFallback(true);
      setPositioningNote(
        props.lang === 'bn'
          ? '⚠️ গুগল ম্যাপস কোটা পূর্ণ হয়েছে (ফলব্যাক ভেক্টর ম্যাপ সক্রিয়)'
          : '⚠️ Google Maps quota reached. Switched to high-speed vector fallback map.'
      );
    };
    window.addEventListener('gmp-quota-exceeded', handleQuotaExceeded);

    // Safety timeout: if Google Maps API doesn't load within 5 seconds, fall back to vector map gracefully
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
        extraRiders={props.extraRiders}
        onSelectRiderPin={props.onSelectRiderPin}
        interactive={props.interactive}
        heightClass={props.heightClass}
        onSelectLocation={handleSelectLocation}
      />
    ) : (
      <APIProvider apiKey={effectiveApiKey} language={props.lang} region="BD" libraries={['places']}>
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
            <button
              type="button"
              onClick={() => setUseFallback(!useFallback)}
              className="inline-flex items-center gap-1 px-2.5 py-1 rounded-lg border font-semibold text-[11px] bg-white border-neutral-200 hover:border-[#E21B70] text-[#E21B70]"
              title="Toggle Google Maps vs Instant Vector Map"
            >
              <span>{useFallback ? (props.lang === 'bn' ? '🗺️ গুগল ম্যাপস' : '🗺️ Google Maps') : (props.lang === 'bn' ? '⚡ ১০০% ফ্রি ম্যাপ' : '⚡ 100% Free Map')}</span>
            </button>

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
