import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowLeft,
  Bell,
  Bike,
  Briefcase,
  CheckCircle2,
  Clock,
  ExternalLink,
  History,
  LocateFixed,
  MapPin,
  Navigation,
  PackageCheck,
  Phone,
  Radio,
  RefreshCw,
  Search,
  Store,
  Wallet,
  X,
} from 'lucide-react';
import { apiFetch, getAuthToken, setAuthToken } from '../lib/api';
import { BANGLADESH_AREAS, DHAKA_DELIVERY_ZONES, getBangladeshAreaSelectPresets } from '../lib/i18n';
import {
  advanceRiderAlongRoute,
  calculateLiveRiderEta,
  detectOrderBatchChanges,
  formatBdt,
  VEHICLE_TYPE_PRESET_OPTIONS,
} from '../lib/marketplace-logic';
import { emitLocalRealtimeSignal, playOrderAlertChime, useRealtimeEvents } from '../lib/realtime';
import { DhakaMapPicker } from './DhakaMapPicker';
import { SelectWithCustom } from './SelectWithCustom';
import type { AppUser, Lang, OrderRecord, RiderJob, RiderRecord } from '../types/marketplace';

interface RiderDashboardProps {
  user: AppUser | null;
  lang: Lang;
  mapsApiKey: string;
  initialOnboarding?: boolean;
  onRefreshUser: () => Promise<void>;
  onTrackOrder: (orderId: number) => void;
  onBack: () => void;
}

type RiderHubTab = 'dispatch' | 'map' | 'earnings' | 'jobs';

const DELIVERY_STEPS: Array<{
  key: 'rider_assigned' | 'picked_up' | 'on_the_way' | 'delivered';
  en: string;
  bn: string;
}> = [
  { key: 'rider_assigned', en: 'Assigned', bn: 'গৃহীত' },
  { key: 'picked_up', en: 'Picked Up', bn: 'পিকআপ' },
  { key: 'on_the_way', en: 'On The Way', bn: 'পথে আছেন' },
  { key: 'delivered', en: 'Delivered', bn: 'সম্পন্ন' },
];

export function RiderDashboard({
  user,
  lang,
  mapsApiKey,
  initialOnboarding = false,
  onRefreshUser,
  onTrackOrder,
  onBack,
}: RiderDashboardProps) {
  const [rider, setRider] = useState<RiderRecord | null>(null);
  const [availableOrders, setAvailableOrders] = useState<OrderRecord[]>([]);
  const [assignedOrders, setAssignedOrders] = useState<OrderRecord[]>([]);
  const [loading, setLoading] = useState(true);
  const [refreshing, setRefreshing] = useState(false);
  const [showJobForm, setShowJobForm] = useState(initialOnboarding);
  const [activeTab, setActiveTab] = useState<RiderHubTab>('dispatch');

  // Search & action feedback state
  const [queueSearch, setQueueSearch] = useState('');
  const [historySearch, setHistorySearch] = useState('');
  const [actionError, setActionError] = useState<string | null>(null);
  const [actionSuccess, setActionSuccess] = useState<string | null>(null);
  const [acceptingOrderId, setAcceptingOrderId] = useState<number | null>(null);
  const [updatingOrderId, setUpdatingOrderId] = useState<number | null>(null);

  // Live GPS & availability state
  const [sharingGps, setSharingGps] = useState(false);
  const [syncingLoc, setSyncingLoc] = useState(false);
  const [gpsStatusMsg, setGpsStatusMsg] = useState<string | null>(null);
  const [selectedSyncZone, setSelectedSyncZone] = useState<string>(BANGLADESH_AREAS[0].name);
  const [customSyncZone, setCustomSyncZone] = useState<string>('');
  const watchIdRef = useRef<number | null>(null);

  // Onboarding / Public Job Application form
  const [fullName, setFullName] = useState(user?.isSandbox ? '' : user?.fullName || '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState(
    user && !user.isSandbox && user.email ? user.email : ''
  );
  const [password, setPassword] = useState('');
  const [vehicleType, setVehicleType] = useState('Motorbike');
  const [zone, setZone] = useState(BANGLADESH_AREAS[0].name);
  const [customZone, setCustomZone] = useState('');
  const [nidNumber, setNidNumber] = useState('');
  const [applyCoords, setApplyCoords] = useState({
    lat: BANGLADESH_AREAS[0].lat,
    lng: BANGLADESH_AREAS[0].lng,
  });
  const [registering, setRegistering] = useState(false);
  const [registerError, setRegisterError] = useState<string | null>(null);

  // Open Restaurant Rider Jobs Board
  const [riderJobs, setRiderJobs] = useState<RiderJob[]>([]);
  const [applyingJob, setApplyingJob] = useState<RiderJob | null>(null);
  const [jobAppFullName, setJobAppFullName] = useState(user?.isSandbox ? '' : user?.fullName || '');
  const [jobAppPhone, setJobAppPhone] = useState('');
  const [jobAppEmail, setJobAppEmail] = useState(user && !user.isSandbox && user.email ? user.email : '');
  const [jobAppVehicle, setJobAppVehicle] = useState('Motorbike');
  const [jobAppZone, setJobAppZone] = useState(BANGLADESH_AREAS[0].name);
  const [jobAppNid, setJobAppNid] = useState('');
  const [jobAppNote, setJobAppNote] = useState('');
  const [submittingJobApp, setSubmittingJobApp] = useState(false);
  const [jobAppFeedback, setJobAppFeedback] = useState<string | null>(null);
  const [jobAppError, setJobAppError] = useState<string | null>(null);

  const loadOpenJobs = useCallback(async () => {
    try {
      const res = await apiFetch<{ jobs: RiderJob[] }>('/api/rider-jobs');
      setRiderJobs(res.jobs || []);
    } catch {
      // non-blocking
    }
  }, []);

  useEffect(() => {
    void loadOpenJobs();
  }, [loadOpenJobs]);

  useEffect(() => {
    setShowJobForm(initialOnboarding);
  }, [initialOnboarding]);

  const canAccessRiderApi =
    Boolean(user) &&
    (user!.role === 'rider' || user!.role === 'admin' || user!.role === 'super_admin');

  const [liveDeliveryAlert, setLiveDeliveryAlert] = useState<string | null>(null);
  const availableSnapshotRef = useRef<Map<number, { status: string; paymentStatus?: string }> | null>(
    null
  );
  const assignedSnapshotRef = useRef<Map<number, { status: string; paymentStatus?: string }> | null>(
    null
  );

  const loadWorkspace = useCallback(
    async (silent = false) => {
      if (!canAccessRiderApi || showJobForm) {
        setLoading(false);
        return;
      }
      if (!silent) setLoading(true);
      else setRefreshing(true);
      try {
        const res = await apiFetch<{
          rider: RiderRecord | null;
          availableOrders: OrderRecord[];
          assignedOrders: OrderRecord[];
        }>('/api/rider/workspace');

        const availChanges = detectOrderBatchChanges(
          availableSnapshotRef.current,
          res.availableOrders
        );
        availableSnapshotRef.current = availChanges.nextMap;

        const assignedChanges = detectOrderBatchChanges(
          assignedSnapshotRef.current,
          res.assignedOrders
        );
        assignedSnapshotRef.current = assignedChanges.nextMap;

        if (availChanges.newOrders.length > 0) {
          const freshReady = availChanges.newOrders[0];
          setLiveDeliveryAlert(
            lang === 'bn'
              ? `নতুন ডেলিভারি অর্ডার এসেছে: ${freshReady.orderNumber} (${freshReady.restaurantName})`
              : `New delivery order available: ${freshReady.orderNumber} (${freshReady.restaurantName})`
          );
          void playOrderAlertChime('new_order', { dedupKey: `order_created_${freshReady.id}` });
        } else if (assignedChanges.newOrders.length > 0) {
          const newlyAssigned = assignedChanges.newOrders[0];
          setLiveDeliveryAlert(
            lang === 'bn'
              ? `নতুন ডেলিভারি অ্যাসাইন হয়েছে: ${newlyAssigned.orderNumber} (${newlyAssigned.restaurantName})`
              : `New delivery assigned to you: ${newlyAssigned.orderNumber} (${newlyAssigned.restaurantName})`
          );
          void playOrderAlertChime('new_order', { dedupKey: `order_created_${newlyAssigned.id}` });
        } else if (assignedChanges.updatedOrders.length > 0) {
          const changed = assignedChanges.updatedOrders[0];
          setLiveDeliveryAlert(
            lang === 'bn'
              ? `অর্ডার আপডেট: ${changed.orderNumber} (${changed.status.replace(/_/g, ' ')})`
              : `Order update: ${changed.orderNumber} (${changed.status.replace(/_/g, ' ')})`
          );
          void playOrderAlertChime('status_update', {
            dedupKey: `order_status_${changed.id}_${changed.status}`,
          });
        }

        setRider(res.rider);
        setAvailableOrders(res.availableOrders);
        setAssignedOrders(res.assignedOrders);
      } catch (err) {
        console.error('Failed to load rider workspace:', err);
      } finally {
        setLoading(false);
        setRefreshing(false);
      }
    },
    [canAccessRiderApi, showJobForm, lang]
  );

  useEffect(() => {
    availableSnapshotRef.current = null;
    assignedSnapshotRef.current = null;
    setLiveDeliveryAlert(null);
  }, [user?.uid]);

  useEffect(() => {
    loadWorkspace(false);
  }, [loadWorkspace]);

  useRealtimeEvents({
    enabled: canAccessRiderApi && !showJobForm,
    token: getAuthToken(),
    pollFallbackMs: 6000,
    onSync: () => loadWorkspace(true),
    onEvent: (ev) => {
      if (ev.type === 'order:created' || ev.type === 'order:updated' || ev.type === 'notification:created') {
        loadWorkspace(true);
      }
    },
  });

  const persistRiderLocation = useCallback(
    async (
      coords: { lat: number; lng: number; isAvailable?: boolean; zone?: string },
      statusNote?: string
    ) => {
      setSyncingLoc(true);
      setActionError(null);
      try {
        const res = await apiFetch<{ rider: RiderRecord }>('/api/rider/location', {
          method: 'PATCH',
          body: JSON.stringify(coords),
        });
        setRider(res.rider);
        if (statusNote) setGpsStatusMsg(statusNote);
      } catch (err: unknown) {
        setGpsStatusMsg(err instanceof Error ? err.message : 'Failed to update rider location');
      } finally {
        setSyncingLoc(false);
      }
    },
    []
  );

  useEffect(() => {
    if (!sharingGps) {
      if (watchIdRef.current !== null && typeof navigator !== 'undefined' && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
      return;
    }

    if (typeof navigator === 'undefined' || !navigator.geolocation) {
      setGpsStatusMsg(
        lang === 'bn'
          ? 'এই ব্রাউজারে GPS উপলব্ধ নয় — ম্যাপ বা এলাকা বাটন দিয়ে লোকেশন আপডেট করুন।'
          : 'Browser Geolocation unavailable — tap map or use area quick-sync.'
      );
      setSharingGps(false);
      return;
    }

    const id = navigator.geolocation.watchPosition(
      (pos) => {
        persistRiderLocation(
          { lat: pos.coords.latitude, lng: pos.coords.longitude, isAvailable: true },
          lang === 'bn' ? 'লাইভ GPS সিঙ্ক হয়েছে' : 'Live browser GPS synced'
        );
      },
      () => {
        setGpsStatusMsg(
          lang === 'bn'
            ? 'GPS অনুমতি পাওয়া যায়নি — ম্যাপ বা এলাকা নির্বাচন করে লোকেশন দিন।'
            : 'GPS permission declined — use the interactive map or area quick-sync.'
        );
        setSharingGps(false);
      },
      { enableHighAccuracy: true, maximumAge: 5000, timeout: 10000 }
    );
    watchIdRef.current = id;

    return () => {
      if (watchIdRef.current !== null && navigator.geolocation) {
        navigator.geolocation.clearWatch(watchIdRef.current);
        watchIdRef.current = null;
      }
    };
  }, [sharingGps, persistRiderLocation, lang]);

  const resolvedApplyZone = zone === '__custom__' ? customZone.trim() : zone;

  const handleRegisterRider = async (e: React.FormEvent) => {
    e.preventDefault();
    setRegistering(true);
    setRegisterError(null);
    try {
      const targetZone = resolvedApplyZone || 'Bangladesh';
      if (user && !user.isSandbox && user.role !== 'admin' && user.role !== 'super_admin') {
        const res = await apiFetch<{ rider: RiderRecord; token?: string }>('/api/riders/register', {
          method: 'POST',
          body: JSON.stringify({
            fullName: fullName.trim(),
            phone: phone.trim(),
            email: (email || user.email).trim(),
            vehicleType,
            zone: targetZone,
            nidNumber: nidNumber.trim(),
            lat: applyCoords.lat,
            lng: applyCoords.lng,
          }),
        });
        if (res.token) setAuthToken(res.token);
        setRider(res.rider);
      } else {
        const res = await apiFetch<{ token: string; rider: RiderRecord }>('/api/riders/apply', {
          method: 'POST',
          body: JSON.stringify({
            fullName: fullName.trim(),
            phone: phone.trim(),
            email: email.trim(),
            password: password.trim() || undefined,
            vehicleType,
            zone: targetZone,
            nidNumber: nidNumber.trim(),
            lat: applyCoords.lat,
            lng: applyCoords.lng,
          }),
        });
        setAuthToken(res.token);
        setRider(res.rider);
      }
      setShowJobForm(false);
      await onRefreshUser();
      await loadWorkspace(false);
    } catch (err: unknown) {
      setRegisterError(err instanceof Error ? err.message : 'Rider registration failed');
    } finally {
      setRegistering(false);
    }
  };

  const handleSubmitJobApplication = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!applyingJob) return;
    setSubmittingJobApp(true);
    setJobAppError(null);
    try {
      await apiFetch(`/api/rider-jobs/${applyingJob.id}/apply`, {
        method: 'POST',
        body: JSON.stringify({
          fullName: jobAppFullName.trim(),
          phone: jobAppPhone.trim(),
          email: jobAppEmail.trim(),
          vehicleType: jobAppVehicle.trim() || 'Motorbike',
          zone: jobAppZone.trim() || applyingJob.zone,
          nidNumber: jobAppNid.trim(),
          experienceNote: jobAppNote.trim(),
        }),
      });
      setJobAppFeedback(
        lang === 'bn'
          ? `${applyingJob.restaurantName}-এর রাইডার জবে আপনার আবেদন জমা হয়েছে!`
          : `Application submitted to ${applyingJob.restaurantName}!`
      );
      setApplyingJob(null);
      setJobAppNote('');
    } catch (err: unknown) {
      setJobAppError(err instanceof Error ? err.message : 'Could not submit application');
    } finally {
      setSubmittingJobApp(false);
    }
  };

  const handleAcceptOrder = async (orderId: number) => {
    setAcceptingOrderId(orderId);
    setActionError(null);
    setActionSuccess(null);
    try {
      await apiFetch(`/api/rider/orders/${orderId}/accept`, { method: 'POST' });
      emitLocalRealtimeSignal('order:updated', { orderId, status: 'rider_assigned' });
      setActionSuccess(
        lang === 'bn'
          ? 'ডেলিভারি অর্ডার গ্রহণ করা হয়েছে! রেস্টুরেন্ট থেকে পিকআপ করুন।'
          : 'Delivery job accepted! Head to the restaurant for pickup.'
      );
      await loadWorkspace(true);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Could not accept order');
    } finally {
      setAcceptingOrderId(null);
    }
  };

  const handleUpdateStatus = async (
    orderId: number,
    status: 'picked_up' | 'on_the_way' | 'delivered'
  ) => {
    setUpdatingOrderId(orderId);
    setActionError(null);
    setActionSuccess(null);
    try {
      await apiFetch(`/api/rider/orders/${orderId}/status`, {
        method: 'PATCH',
        body: JSON.stringify({ status }),
      });
      emitLocalRealtimeSignal('order:updated', { orderId, status });
      const label =
        status === 'picked_up'
          ? lang === 'bn'
            ? 'পিকআপ সম্পন্ন হিসেবে আপডেট হয়েছে।'
            : 'Marked as Picked Up from restaurant.'
          : status === 'on_the_way'
          ? lang === 'bn'
            ? 'কাস্টমারের পথে যাত্রা শুরু হয়েছে।'
            : 'Marked as On The Way to customer.'
          : lang === 'bn'
          ? 'ডেলিভারি সফলভাবে সম্পন্ন হয়েছে!'
          : 'Delivery completed! Earnings credited.';
      setActionSuccess(label);
      await loadWorkspace(true);
    } catch (err: unknown) {
      setActionError(err instanceof Error ? err.message : 'Failed to update delivery status');
    } finally {
      setUpdatingOrderId(null);
    }
  };

  const handleMoveAlongOrderRoute = async (ord: OrderRecord) => {
    if (!rider) return;
    const toRestaurant =
      ord.status === 'rider_assigned' &&
      typeof ord.restaurantLat === 'number' &&
      typeof ord.restaurantLng === 'number';
    const targetLat = toRestaurant && ord.restaurantLat ? ord.restaurantLat : ord.deliveryLat;
    const targetLng = toRestaurant && ord.restaurantLng ? ord.restaurantLng : ord.deliveryLng;

    const next = advanceRiderAlongRoute(rider.currentLat, rider.currentLng, targetLat, targetLng, 0.35);
    await persistRiderLocation(
      { lat: next.lat, lng: next.lng },
      lang === 'bn'
        ? `রাইডার লোকেশন আপডেট: ${next.lat.toFixed(4)}, ${next.lng.toFixed(4)}`
        : `Moved rider toward ${toRestaurant ? ord.restaurantName : ord.deliveryArea} (${next.lat.toFixed(4)}, ${next.lng.toFixed(4)})`
    );
  };

  const activeDeliveries = useMemo(
    () =>
      assignedOrders.filter((o) =>
        ['rider_assigned', 'picked_up', 'on_the_way'].includes(o.status)
      ),
    [assignedOrders]
  );

  const pastDeliveries = useMemo(
    () =>
      assignedOrders.filter(
        (o) => !['rider_assigned', 'picked_up', 'on_the_way'].includes(o.status)
      ),
    [assignedOrders]
  );

  const filteredAvailableOrders = useMemo(() => {
    const q = queueSearch.trim().toLowerCase();
    if (!q) return availableOrders;
    return availableOrders.filter((o) =>
      [o.orderNumber, o.restaurantName, o.deliveryArea, o.deliveryAddress]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [availableOrders, queueSearch]);

  const filteredHistoryOrders = useMemo(() => {
    const q = historySearch.trim().toLowerCase();
    if (!q) return pastDeliveries;
    return pastDeliveries.filter((o) =>
      [o.orderNumber, o.restaurantName, o.deliveryArea, o.customerName, o.status]
        .join(' ')
        .toLowerCase()
        .includes(q)
    );
  }, [pastDeliveries, historySearch]);

  if (loading) {
    return (
      <div className="max-w-7xl mx-auto px-4 sm:px-6 py-8 space-y-4">
        <div className="h-24 rounded-2xl bg-white border border-neutral-200 animate-pulse" />
        <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
          {[1, 2, 3, 4].map((i) => (
            <div key={i} className="h-20 rounded-xl bg-white border border-neutral-200 animate-pulse" />
          ))}
        </div>
        <div className="h-56 rounded-2xl bg-white border border-neutral-200 flex items-center justify-center text-sm text-neutral-500">
          {lang === 'bn' ? 'রাইডার ড্যাশবোর্ড লোড হচ্ছে...' : 'Loading Rider Workspace...'}
        </div>
      </div>
    );
  }

  const primaryActiveOrder = activeDeliveries[0];
  const riderCoords = {
    lat: rider?.currentLat ?? 23.7949,
    lng: rider?.currentLng ?? 90.4043,
  };

  const showOnboardingView = showJobForm || (!rider && !canAccessRiderApi);

  const codCompletedCount = pastDeliveries.filter(
    (o) => o.status === 'delivered' && o.paymentMethod === 'cod'
  ).length;
  const prepaidCompletedCount = pastDeliveries.filter(
    (o) => o.status === 'delivered' && o.paymentMethod !== 'cod'
  ).length;

  return (
    <div className="max-w-7xl mx-auto px-4 sm:px-6 py-6 space-y-5">
      {/* Top Contextual Breadcrumb & Mode Switch */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex items-center gap-2 text-sm font-medium text-neutral-600 hover:text-[#E21B70] whitespace-nowrap shrink-0"
        >
          <ArrowLeft className="w-4 h-4" />
          <span>{lang === 'bn' ? 'মার্কেটপ্লেসে ফিরুন' : 'Back to Storefront'}</span>
        </button>

        {canAccessRiderApi && (
          <div className="flex items-center gap-2 shrink-0">
            <button
              type="button"
              onClick={() => {
                void loadWorkspace(true);
                void loadOpenJobs();
              }}
              disabled={refreshing}
              className="px-3 py-1.5 rounded-lg border border-neutral-200 bg-white text-xs font-semibold text-neutral-700 hover:border-[#E21B70] inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 disabled:opacity-50"
            >
              <RefreshCw className={`w-3.5 h-3.5 ${refreshing ? 'animate-spin' : ''}`} />
              <span>{lang === 'bn' ? 'সিঙ্ক' : 'Sync'}</span>
            </button>
            <button
              type="button"
              onClick={() => setShowJobForm((v) => !v)}
              className="px-3 py-1.5 rounded-lg border border-neutral-200 bg-white text-xs font-semibold text-[#2E3138] hover:border-[#E21B70] whitespace-nowrap shrink-0"
            >
              {showOnboardingView
                ? lang === 'bn'
                  ? 'রাইডার ড্যাশবোর্ড দেখুন'
                  : 'View Rider Dashboard'
                : lang === 'bn'
                ? 'নতুন রাইডার আবেদন'
                : 'Fleet Job Form'}
            </button>
          </div>
        )}
      </div>

      {showOnboardingView ? (
        <div className="space-y-6">
          <form
            onSubmit={handleRegisterRider}
            className="bg-white rounded-2xl border border-neutral-200 p-6 max-w-2xl mx-auto space-y-4"
          >
            <div>
              <p className="text-xs font-semibold text-[#E21B70]">
                {lang === 'bn' ? 'রাইডার জব · সারা বাংলাদেশ' : 'Delivery Rider Onboarding · All Bangladesh'}
              </p>
              <h1 className="text-2xl font-bold text-[#2E3138] mt-1">
                {lang === 'bn'
                  ? 'Foodora BD ডেলিভারি রাইডার জবে যোগ দিন'
                  : 'Join Foodora BD Delivery Fleet Anywhere in Bangladesh'}
              </h1>
              <p className="text-xs text-neutral-500 mt-1">
                {lang === 'bn'
                  ? 'ঢাকা, চট্টগ্রাম, সিলেট, রাজশাহী, খুলনা, বরিশাল, রংপুর, ময়মনসিংহ বা যেকোনো জেলা থেকে জব জয়েন করুন।'
                  : 'Apply from any district or area in Bangladesh and start receiving live delivery dispatches immediately.'}
              </p>
            </div>

            <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'পুরো নাম' : 'Full Name'}
                </label>
                <input
                  required
                  value={fullName}
                  onChange={(e) => setFullName(e.target.value)}
                  placeholder="e.g. Tanvir Ahmed"
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'মোবাইল নম্বর' : 'Phone'}
                </label>
                <input
                  required
                  value={phone}
                  onChange={(e) => setPhone(e.target.value)}
                  placeholder="+88017..."
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'ইমেইল (রাইডার লগইন)' : 'Email Address (Rider Login)'}
                </label>
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="rider@example.com"
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'পাসওয়ার্ড (ঐচ্ছিক)' : 'Account Password (Optional)'}
                </label>
                <input
                  type="password"
                  minLength={6}
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  placeholder="Min 6 characters"
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg"
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'যানবাহনের ধরন' : 'Vehicle Type'}
                </label>
                <SelectWithCustom
                  required
                  lang={lang}
                  value={vehicleType}
                  onChange={setVehicleType}
                  storageKey="rider_vehicles"
                  ariaLabel="Rider vehicle type"
                  placeholder={
                    lang === 'bn'
                      ? 'কাস্টম যানবাহন লিখুন (যেমন: E-Cargo Bike)'
                      : 'Custom vehicle (e.g. Cargo Bike / Pickup)'
                  }
                  customOptionLabel={
                    lang === 'bn' ? '+ কাস্টম যানবাহন যোগ...' : '+ Add Custom Vehicle...'
                  }
                  presets={VEHICLE_TYPE_PRESET_OPTIONS.map((v) => ({ value: v, label: v }))}
                />
              </div>
              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'কাজের শহর / এলাকা' : 'Working City / Zone'}
                </label>
                <SelectWithCustom
                  required
                  lang={lang}
                  value={zone === '__custom__' ? customZone : zone}
                  onChange={(val) => {
                    const found = BANGLADESH_AREAS.find((a) => a.name === val);
                    if (found) {
                      setZone(found.name);
                      setCustomZone('');
                    } else {
                      setZone('__custom__');
                      setCustomZone(val);
                    }
                  }}
                  storageKey="bd_areas"
                  ariaLabel="Working city or zone in Bangladesh"
                  placeholder={
                    lang === 'bn'
                      ? 'কাস্টম জেলা/এলাকা লিখুন (যেমন: জিন্দাবাজার, সিলেট)'
                      : 'e.g. Zindabazar, Sylhet or Coxs Bazar Town'
                  }
                  customOptionLabel={
                    lang === 'bn'
                      ? '+ কাস্টম এলাকা যোগ করুন...'
                      : '+ Add Custom Area in Bangladesh...'
                  }
                  presets={getBangladeshAreaSelectPresets(lang)}
                  onSelectPreset={(val) => {
                    const found = BANGLADESH_AREAS.find((a) => a.name === val);
                    if (found) setApplyCoords({ lat: found.lat, lng: found.lng });
                  }}
                />
              </div>
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-700 mb-1">
                {lang === 'bn' ? 'জাতীয় পরিচয়পত্র (NID) নম্বর' : 'NID Number'}
              </label>
              <input
                required
                value={nidNumber}
                onChange={(e) => setNidNumber(e.target.value)}
                placeholder="10, 13, or 17 digit NID"
                className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg"
              />
            </div>

            <div>
              <label className="block text-xs font-semibold text-neutral-700 mb-1">
                {lang === 'bn'
                  ? 'আপনার শুরুর GPS লোকেশন ম্যাপে পিন করুন'
                  : 'Pin Your Starting GPS Location Anywhere in Bangladesh'}
              </label>
              <DhakaMapPicker
                mapsApiKey={mapsApiKey}
                lang={lang}
                center={applyCoords}
                markerLabel={resolvedApplyZone || 'Rider Start Pin'}
                pinType="user"
                userName={fullName || user?.fullName}
                interactive
                heightClass="h-[200px]"
                onSelectLocation={(loc) => {
                  setApplyCoords({ lat: loc.lat, lng: loc.lng });
                  if (loc.areaName && loc.areaName !== 'Current GPS') {
                    const preset = BANGLADESH_AREAS.find((a) => a.name === loc.areaName);
                    if (preset) {
                      setZone(preset.name);
                    } else {
                      setZone('__custom__');
                      setCustomZone(loc.areaName);
                    }
                  }
                }}
              />
            </div>

            {registerError && (
              <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {registerError}
              </div>
            )}

            <button
              type="submit"
              disabled={registering}
              className="w-full py-2.5 rounded-xl bg-[#E21B70] hover:bg-[#C4135E] text-white text-xs font-semibold disabled:opacity-50"
            >
              {registering
                ? lang === 'bn'
                  ? 'আবেদন জমা হচ্ছে...'
                  : 'Activating Rider Job...'
                : lang === 'bn'
                ? 'রাইডার জব জয়েন ও সক্রিয় করুন'
                : 'Apply & Activate Rider Job Now'}
            </button>
          </form>
        </div>
      ) : (
        <div className="space-y-5">
          {/* Live Delivery Alert Banner */}
          {liveDeliveryAlert && (
            <div
              role="status"
              className="rounded-xl bg-[#FFF0F6] border border-[#E21B70]/30 px-4 py-3 flex items-center justify-between gap-3"
            >
              <div className="flex items-center gap-2.5 text-xs font-semibold text-[#2E3138]">
                <Bell className="w-4 h-4 text-[#E21B70] shrink-0" />
                <span>{liveDeliveryAlert}</span>
              </div>
              <button
                type="button"
                onClick={() => setLiveDeliveryAlert(null)}
                aria-label="Dismiss delivery alert"
                className="p-1 rounded hover:bg-white text-neutral-500"
              >
                <X className="w-4 h-4" />
              </button>
            </div>
          )}

          {/* Action Feedback / Errors */}
          {(actionError || actionSuccess) && (
            <div
              className={`rounded-xl px-4 py-3 text-xs font-semibold flex items-center justify-between gap-3 border ${
                actionError
                  ? 'bg-red-50 border-red-200 text-red-700'
                  : 'bg-emerald-50 border-emerald-200 text-emerald-800'
              }`}
            >
              <span>{actionError || actionSuccess}</span>
              <button
                type="button"
                onClick={() => {
                  setActionError(null);
                  setActionSuccess(null);
                }}
                aria-label="Dismiss message"
                className="p-1 rounded hover:bg-white/70"
              >
                <X className="w-3.5 h-3.5" />
              </button>
            </div>
          )}

          {/* Rider Hub Identity & Instant Duty Switch Header */}
          <div className="bg-white rounded-2xl border border-neutral-200 p-5 flex flex-wrap items-center justify-between gap-4">
            <div className="flex items-center gap-3.5">
              <div className="w-12 h-12 rounded-xl bg-[#FFF0F6] text-[#E21B70] flex items-center justify-center shrink-0">
                <Bike className="w-6 h-6" />
              </div>
              <div>
                <h1 className="text-xl font-bold text-[#2E3138]">
                  {rider?.fullName || user?.fullName || (lang === 'bn' ? 'রাইডার হাব' : 'Rider Hub')}
                </h1>
                <div className="flex flex-wrap items-center gap-1.5 text-xs text-neutral-500 mt-0.5">
                  <span
                    className={`font-semibold ${
                      rider?.isAvailable ? 'text-emerald-700' : 'text-neutral-600'
                    }`}
                  >
                    {rider?.isAvailable
                      ? lang === 'bn'
                        ? 'অনলাইন (সক্রিয়)'
                        : 'Online'
                      : lang === 'bn'
                      ? 'অফলাইন'
                      : 'Offline'}
                  </span>
                  <span aria-hidden="true">·</span>
                  <span>{rider?.vehicleType || 'Motorbike'}</span>
                  <span aria-hidden="true">·</span>
                  <span>{rider?.zone || 'Bangladesh'}</span>
                  <span aria-hidden="true">·</span>
                  <span className="font-mono tabular-nums">
                    {riderCoords.lat.toFixed(4)}, {riderCoords.lng.toFixed(4)}
                  </span>
                </div>
              </div>
            </div>

            <div className="flex flex-wrap items-center gap-2.5">
              {rider && (
                <button
                  type="button"
                  disabled={syncingLoc}
                  onClick={() =>
                    persistRiderLocation(
                      {
                        lat: rider.currentLat,
                        lng: rider.currentLng,
                        isAvailable: !rider.isAvailable,
                      },
                      !rider.isAvailable
                        ? lang === 'bn'
                          ? 'আপনি এখন অনলাইন — নতুন ডেলিভারি গ্রহণ করতে পারবেন।'
                          : 'You are now Online and visible for dispatch.'
                        : lang === 'bn'
                        ? 'আপনি এখন অফলাইন আছেন।'
                        : 'You are now Offline.'
                    )
                  }
                  className={`px-4 py-2.5 rounded-xl text-xs font-semibold border transition-colors whitespace-nowrap shrink-0 ${
                    rider.isAvailable
                      ? 'bg-emerald-600 text-white border-emerald-600 hover:bg-emerald-700'
                      : 'bg-[#2E3138] text-white border-[#2E3138] hover:bg-black'
                  }`}
                >
                  {rider.isAvailable
                    ? lang === 'bn'
                      ? 'অনলাইন আছেন · অফলাইন করুন'
                      : 'Online · Go Offline'
                    : lang === 'bn'
                    ? 'অফলাইন · অনলাইন করুন'
                    : 'Offline · Go Online'}
                </button>
              )}
              <button
                type="button"
                onClick={() => setSharingGps((v) => !v)}
                className={`px-3.5 py-2.5 rounded-xl text-xs font-semibold border transition-colors inline-flex items-center gap-1.5 whitespace-nowrap shrink-0 ${
                  sharingGps
                    ? 'bg-[#FFF0F6] text-[#E21B70] border-[#E21B70]/40'
                    : 'bg-white text-[#2E3138] border-neutral-200 hover:border-[#E21B70]'
                }`}
              >
                <Radio className="w-3.5 h-3.5" />
                <span>
                  {sharingGps
                    ? lang === 'bn'
                      ? 'GPS চালু · বন্ধ করুন'
                      : 'Live GPS On · Stop'
                    : lang === 'bn'
                    ? 'লাইভ GPS চালু করুন'
                    : 'Start Live GPS'}
                </span>
              </button>
            </div>
          </div>

          {/* 4-Column Tabular KPI Strip */}
          <div className="grid grid-cols-2 lg:grid-cols-4 gap-3.5 tabular-nums">
            <div className="bg-white rounded-xl border border-neutral-200 p-4">
              <p className="text-xs text-neutral-500">
                {lang === 'bn' ? 'চলমান ডেলিভারি' : 'Active Deliveries'}
              </p>
              <p className="text-2xl font-bold text-[#E21B70] mt-1 font-mono">
                {activeDeliveries.length}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4">
              <p className="text-xs text-neutral-500">
                {lang === 'bn' ? 'উন্মুক্ত অর্ডার কিউ' : 'Open Dispatch Queue'}
              </p>
              <p className="text-2xl font-bold text-[#2E3138] mt-1 font-mono">
                {availableOrders.length}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4">
              <p className="text-xs text-neutral-500">
                {lang === 'bn' ? 'সম্পন্ন ডেলিভারি' : 'Completed Deliveries'}
              </p>
              <p className="text-2xl font-bold text-emerald-700 mt-1 font-mono">
                {rider?.totalDeliveries ?? 0}
              </p>
            </div>
            <div className="bg-white rounded-xl border border-neutral-200 p-4">
              <p className="text-xs text-neutral-500">
                {lang === 'bn' ? 'মোট আয়' : 'Total Earnings'}
              </p>
              <p className="text-2xl font-bold text-[#2E3138] mt-1 font-mono">
                {formatBdt(rider?.totalEarnings ?? 0, lang)}
              </p>
            </div>
          </div>

          {/* Workspace Segmented Navigation Tabs */}
          <div className="flex flex-wrap items-center gap-1.5 p-1.5 bg-neutral-100 rounded-xl border border-neutral-200/80">
            <button
              type="button"
              onClick={() => setActiveTab('dispatch')}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'dispatch'
                  ? 'bg-white text-[#2E3138] shadow-xs'
                  : 'text-neutral-600 hover:text-[#2E3138]'
              }`}
            >
              <Navigation className="w-3.5 h-3.5 text-[#E21B70]" />
              <span>
                {lang === 'bn' ? 'অর্ডার ও ডিসপ্যাচ' : 'Active & Dispatch'} (
                {activeDeliveries.length + availableOrders.length})
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('map')}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'map'
                  ? 'bg-white text-[#2E3138] shadow-xs'
                  : 'text-neutral-600 hover:text-[#2E3138]'
              }`}
            >
              <LocateFixed className="w-3.5 h-3.5 text-[#E21B70]" />
              <span>{lang === 'bn' ? 'লাইভ GPS ও ম্যাপ' : 'Live GPS & Map'}</span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('earnings')}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'earnings'
                  ? 'bg-white text-[#2E3138] shadow-xs'
                  : 'text-neutral-600 hover:text-[#2E3138]'
              }`}
            >
              <History className="w-3.5 h-3.5 text-[#E21B70]" />
              <span>
                {lang === 'bn' ? 'হিস্ট্রি ও আয়' : 'History & Earnings'} ({pastDeliveries.length})
              </span>
            </button>
            <button
              type="button"
              onClick={() => setActiveTab('jobs')}
              className={`px-3.5 py-2 rounded-lg text-xs font-semibold inline-flex items-center gap-1.5 transition-colors whitespace-nowrap shrink-0 ${
                activeTab === 'jobs'
                  ? 'bg-white text-[#2E3138] shadow-xs'
                  : 'text-neutral-600 hover:text-[#2E3138]'
              }`}
            >
              <Briefcase className="w-3.5 h-3.5 text-[#E21B70]" />
              <span>
                {lang === 'bn' ? 'রাইডার জব বোর্ড' : 'Rider Jobs'} ({riderJobs.length})
              </span>
            </button>
          </div>

          {/* ---------------- TAB 1: ACTIVE DELIVERY & DISPATCH QUEUE ---------------- */}
          {activeTab === 'dispatch' && (
            <div className="space-y-6">
              {/* Active Delivery Section */}
              <section className="space-y-3">
                <div className="flex items-center justify-between gap-2">
                  <h2 className="text-base font-bold text-[#2E3138] flex items-center gap-2">
                    <PackageCheck className="w-4 h-4 text-[#E21B70]" />
                    <span>
                      {lang === 'bn'
                        ? `চলমান ডেলিভারি টাস্ক (${activeDeliveries.length})`
                        : `Active Delivery Tasks (${activeDeliveries.length})`}
                    </span>
                  </h2>
                </div>

                {activeDeliveries.length === 0 ? (
                  <div className="bg-white rounded-2xl border border-neutral-200 p-6 flex flex-wrap items-center justify-between gap-4">
                    <div>
                      <p className="text-sm font-semibold text-[#2E3138]">
                        {lang === 'bn'
                          ? 'এই মুহূর্তে কোনো সক্রিয় ডেলিভারি চলমান নেই'
                          : 'No active delivery assigned right now'}
                      </p>
                      <p className="text-xs text-neutral-500 mt-0.5">
                        {lang === 'bn'
                          ? 'নিচের উন্মুক্ত অর্ডার তালিকা থেকে যেকোনো একটি ডেলিভারি গ্রহণ করুন।'
                          : 'Accept a waiting order from the Open Dispatch Queue below to begin.'}
                      </p>
                    </div>
                    {rider && !rider.isAvailable && (
                      <button
                        type="button"
                        onClick={() =>
                          persistRiderLocation({
                            lat: rider.currentLat,
                            lng: rider.currentLng,
                            isAvailable: true,
                          })
                        }
                        className="px-4 py-2 rounded-xl bg-emerald-600 text-white text-xs font-semibold hover:bg-emerald-700 whitespace-nowrap"
                      >
                        {lang === 'bn' ? 'এখনই অনলাইন হোন' : 'Go Online Now'}
                      </button>
                    )}
                  </div>
                ) : (
                  <div className="space-y-4">
                    {activeDeliveries.map((ord) => {
                      const stepIdx = DELIVERY_STEPS.findIndex((s) => s.key === ord.status);
                      const etaInfo = calculateLiveRiderEta(
                        riderCoords.lat,
                        riderCoords.lng,
                        ord.deliveryLat,
                        ord.deliveryLng,
                        ord.status
                      );
                      const isPickupPhase = ord.status === 'rider_assigned';
                      const pickupMapsUrl =
                        typeof ord.restaurantLat === 'number' && typeof ord.restaurantLng === 'number'
                          ? `https://www.google.com/maps/dir/?api=1&destination=${ord.restaurantLat},${ord.restaurantLng}`
                          : `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(ord.restaurantName)}`;
                      const dropoffMapsUrl = `https://www.google.com/maps/dir/?api=1&destination=${ord.deliveryLat},${ord.deliveryLng}`;
                      const isBusy = updatingOrderId === ord.id;

                      return (
                        <div
                          key={ord.id}
                          className="bg-white rounded-2xl border border-neutral-200 p-5 space-y-4"
                        >
                          {/* Top Row: Order ID + Payout/Payment + Live ETA */}
                          <div className="flex flex-wrap items-start justify-between gap-3 pb-3 border-b border-neutral-100">
                            <div>
                              <div className="flex flex-wrap items-center gap-2 text-xs text-neutral-500 font-mono tabular-nums">
                                <span className="font-bold text-[#2E3138]">{ord.orderNumber}</span>
                                <span aria-hidden="true">·</span>
                                <span>
                                  {etaInfo.remainingKm.toFixed(2)} km · ~{etaInfo.etaMinutes} min ETA
                                </span>
                              </div>
                              <h3 className="text-base font-bold text-[#2E3138] mt-1">
                                {ord.restaurantName} → {ord.deliveryArea}
                              </h3>
                            </div>

                            <div className="text-right tabular-nums">
                              <p
                                className={`text-xs font-bold ${
                                  ord.paymentMethod === 'cod' ? 'text-amber-700' : 'text-emerald-700'
                                }`}
                              >
                                {ord.paymentMethod === 'cod'
                                  ? lang === 'bn'
                                    ? `ক্যাশ সংগ্রহ: ${formatBdt(ord.totalAmount, lang)}`
                                    : `Collect Cash (COD): ${formatBdt(ord.totalAmount, lang)}`
                                  : lang === 'bn'
                                  ? `প্রিপেইড (${ord.paymentMethod.toUpperCase()})`
                                  : `Prepaid (${ord.paymentMethod.toUpperCase()})`}
                              </p>
                              <p className="text-xs text-neutral-500 mt-0.5">
                                {lang === 'bn' ? 'রাইডার ফি:' : 'Delivery Fee:'}{' '}
                                <span className="font-semibold text-[#E21B70]">
                                  +{formatBdt(Math.max(40, ord.deliveryFee), lang)}
                                </span>
                              </p>
                            </div>
                          </div>

                          {/* Visual 4-Step Delivery Progress */}
                          <div className="grid grid-cols-4 gap-2">
                            {DELIVERY_STEPS.map((step, idx) => {
                              const done = stepIdx >= idx;
                              return (
                                <div key={step.key} className="space-y-1">
                                  <div
                                    className={`h-1.5 rounded-full transition-colors ${
                                      done ? 'bg-[#E21B70]' : 'bg-neutral-200'
                                    }`}
                                  />
                                  <p
                                    className={`text-[11px] font-semibold truncate ${
                                      done ? 'text-[#2E3138]' : 'text-neutral-400'
                                    }`}
                                  >
                                    {idx + 1}. {lang === 'bn' ? step.bn : step.en}
                                  </p>
                                </div>
                              );
                            })}
                          </div>

                          {/* Pickup & Dropoff Side-by-Side Guide */}
                          <div className="grid grid-cols-1 md:grid-cols-2 gap-4 pt-1">
                            <div
                              className={`p-3.5 rounded-xl border ${
                                isPickupPhase
                                  ? 'border-[#E21B70]/40 bg-[#FFF8FB]'
                                  : 'border-neutral-200 bg-[#FAFAFB]'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-semibold text-neutral-500 flex items-center gap-1.5">
                                  <Store className="w-3.5 h-3.5 text-[#E21B70]" />
                                  {lang === 'bn' ? 'পিকআপ (রেস্টুরেন্ট)' : '1. Pickup (Restaurant)'}
                                </span>
                                <a
                                  href={pickupMapsUrl}
                                  target="_blank"
                                  rel="noreferrer"
                                  className="text-[11px] font-semibold text-[#E21B70] hover:underline inline-flex items-center gap-1"
                                >
                                  <span>{lang === 'bn' ? 'গুগল ম্যাপ' : 'Navigate'}</span>
                                  <ExternalLink className="w-3 h-3" />
                                </a>
                              </div>
                              <p className="text-sm font-bold text-[#2E3138] mt-1">
                                {ord.restaurantName}
                              </p>
                              <p className="text-xs text-neutral-600 mt-0.5">
                                {(ord.itemsSnapshotJson || [])
                                  .map((it) => `${it.quantity}× ${it.name}`)
                                  .join(', ')}
                              </p>
                            </div>

                            <div
                              className={`p-3.5 rounded-xl border ${
                                !isPickupPhase
                                  ? 'border-[#E21B70]/40 bg-[#FFF8FB]'
                                  : 'border-neutral-200 bg-[#FAFAFB]'
                              }`}
                            >
                              <div className="flex items-center justify-between gap-2">
                                <span className="text-[11px] font-semibold text-neutral-500 flex items-center gap-1.5">
                                  <MapPin className="w-3.5 h-3.5 text-[#E21B70]" />
                                  {lang === 'bn' ? 'ডেলিভারি (কাস্টমার)' : '2. Dropoff (Customer)'}
                                </span>
                                <div className="flex items-center gap-2.5">
                                  {ord.customerPhone && (
                                    <a
                                      href={`tel:${ord.customerPhone}`}
                                      className="text-[11px] font-semibold text-emerald-700 hover:underline inline-flex items-center gap-1"
                                    >
                                      <Phone className="w-3 h-3" />
                                      <span>{lang === 'bn' ? 'কল করুন' : 'Call'}</span>
                                    </a>
                                  )}
                                  <a
                                    href={dropoffMapsUrl}
                                    target="_blank"
                                    rel="noreferrer"
                                    className="text-[11px] font-semibold text-[#E21B70] hover:underline inline-flex items-center gap-1"
                                  >
                                    <span>{lang === 'bn' ? 'গুগল ম্যাপ' : 'Navigate'}</span>
                                    <ExternalLink className="w-3 h-3" />
                                  </a>
                                </div>
                              </div>
                              <p className="text-sm font-bold text-[#2E3138] mt-1">
                                {ord.customerName} · {ord.customerPhone}
                              </p>
                              <p className="text-xs text-neutral-600 mt-0.5">
                                {ord.deliveryArea} — {ord.deliveryAddress}
                              </p>
                              {ord.deliveryInstructions && (
                                <p className="text-[11px] text-amber-800 mt-1">
                                  Note: {ord.deliveryInstructions}
                                </p>
                              )}
                            </div>
                          </div>

                          {/* Primary Step-Forward & Map Controls */}
                          <div className="flex flex-wrap items-center justify-between gap-3 pt-1">
                            <div className="flex flex-wrap items-center gap-2">
                              {rider && (
                                <button
                                  type="button"
                                  disabled={syncingLoc}
                                  onClick={() => handleMoveAlongOrderRoute(ord)}
                                  className="px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-emerald-800 hover:bg-emerald-100 text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                                >
                                  <Navigation className="w-3.5 h-3.5" />
                                  <span>{lang === 'bn' ? 'রুটে এগিয়ে যান' : 'Move Along Route'}</span>
                                </button>
                              )}
                              <button
                                type="button"
                                onClick={() => onTrackOrder(ord.id)}
                                className="px-3 py-2 rounded-xl border border-neutral-200 text-xs font-semibold text-[#2E3138] hover:border-[#E21B70] whitespace-nowrap"
                              >
                                {lang === 'bn' ? 'লাইভ রুট ম্যাপ' : 'Live Route Map'}
                              </button>
                            </div>

                            <div className="flex flex-wrap items-center gap-2">
                              {ord.status === 'rider_assigned' && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleUpdateStatus(ord.id, 'picked_up')}
                                  className="px-4 py-2.5 rounded-xl bg-[#2E3138] hover:bg-black text-white text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
                                >
                                  {isBusy
                                    ? lang === 'bn'
                                      ? 'আপডেট হচ্ছে...'
                                      : 'Updating...'
                                    : lang === 'bn'
                                    ? 'রেস্টুরেন্ট থেকে পিকআপ সম্পন্ন'
                                    : 'Mark Picked Up'}
                                </button>
                              )}
                              {ord.status === 'picked_up' && (
                                <button
                                  type="button"
                                  disabled={isBusy}
                                  onClick={() => handleUpdateStatus(ord.id, 'on_the_way')}
                                  className="px-4 py-2.5 rounded-xl bg-[#E21B70] hover:bg-[#C4135E] text-white text-xs font-semibold disabled:opacity-50 whitespace-nowrap"
                                >
                                  {isBusy
                                    ? lang === 'bn'
                                      ? 'আপডেট হচ্ছে...'
                                      : 'Updating...'
                                    : lang === 'bn'
                                    ? 'কাস্টমারের পথে রওনা দিন'
                                    : 'Start Delivery (On The Way)'}
                                </button>
                              )}
                              <button
                                type="button"
                                disabled={isBusy}
                                onClick={() => handleUpdateStatus(ord.id, 'delivered')}
                                className="px-4 py-2.5 rounded-xl bg-emerald-600 hover:bg-emerald-700 text-white text-xs font-semibold inline-flex items-center gap-1.5 disabled:opacity-50 whitespace-nowrap"
                              >
                                <CheckCircle2 className="w-4 h-4" />
                                <span>
                                  {isBusy
                                    ? lang === 'bn'
                                      ? 'সম্পন্ন হচ্ছে...'
                                      : 'Completing...'
                                    : lang === 'bn'
                                    ? 'ডেলিভারি সম্পন্ন করুন'
                                    : 'Complete & Mark Delivered'}
                                </span>
                              </button>
                            </div>
                          </div>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>

              {/* Available Platform Dispatch Queue */}
              <section className="space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-base font-bold text-[#2E3138] flex items-center gap-2">
                    <Clock className="w-4 h-4 text-[#E21B70]" />
                    <span>
                      {lang === 'bn'
                        ? `ডেলিভারির জন্য উন্মুক্ত অর্ডার (${filteredAvailableOrders.length})`
                        : `Open Dispatch Queue (${filteredAvailableOrders.length})`}
                    </span>
                  </h2>
                  <div className="relative w-full sm:w-72">
                    <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      value={queueSearch}
                      onChange={(e) => setQueueSearch(e.target.value)}
                      placeholder={
                        lang === 'bn'
                          ? 'রেস্টুরেন্ট, এলাকা বা অর্ডার খুঁজুন...'
                          : 'Filter by restaurant, area, order #...'
                      }
                      className="w-full pl-8 pr-3 py-1.5 text-xs bg-white border border-neutral-200 rounded-lg"
                    />
                  </div>
                </div>

                {filteredAvailableOrders.length === 0 ? (
                  <div className="bg-white rounded-2xl border border-neutral-200 p-6 text-sm text-neutral-500">
                    {queueSearch.trim()
                      ? lang === 'bn'
                        ? 'আপনার সার্চের সাথে কোনো অর্ডার মেলেনি।'
                        : 'No queued orders match your filter.'
                      : lang === 'bn'
                      ? 'এই মুহূর্তে কোনো নতুন পেন্ডিং ডেলিভারি নেই। অনলাইন থাকুন — অর্ডার আসলে অ্যালার্ট পাবেন।'
                      : 'No unassigned Foodora Rider orders waiting right now. Stay online to receive instant alerts.'}
                  </div>
                ) : (
                  <div className="grid grid-cols-1 md:grid-cols-2 gap-4">
                    {filteredAvailableOrders.map((ord) => {
                      const eta = calculateLiveRiderEta(
                        riderCoords.lat,
                        riderCoords.lng,
                        ord.deliveryLat,
                        ord.deliveryLng,
                        'ready'
                      );
                      const accepting = acceptingOrderId === ord.id;
                      return (
                        <div
                          key={ord.id}
                          className="bg-white rounded-2xl border border-neutral-200 p-4 flex flex-col justify-between gap-3"
                        >
                          <div className="space-y-1.5">
                            <div className="flex items-center justify-between text-xs text-neutral-500 font-mono tabular-nums">
                              <span>
                                {ord.orderNumber} · {eta.remainingKm.toFixed(1)} km
                              </span>
                              <span className="font-bold text-[#E21B70]">
                                +{formatBdt(Math.max(40, ord.deliveryFee), lang)} fee
                              </span>
                            </div>
                            <h3 className="font-bold text-sm text-[#2E3138]">{ord.restaurantName}</h3>
                            <p className="text-xs text-neutral-600 flex items-start gap-1.5">
                              <MapPin className="w-3.5 h-3.5 text-neutral-400 shrink-0 mt-0.5" />
                              <span>
                                {ord.deliveryArea} — {ord.deliveryAddress}
                              </span>
                            </p>
                            <p className="text-[11px] text-neutral-500">
                              {ord.paymentMethod === 'cod'
                                ? `${lang === 'bn' ? 'ক্যাশ অন ডেলিভারি' : 'Cash on Delivery'} (${formatBdt(ord.totalAmount, lang)})`
                                : `${lang === 'bn' ? 'প্রিপেইড' : 'Prepaid'} (${ord.paymentMethod.toUpperCase()})`}
                            </p>
                          </div>
                          <button
                            type="button"
                            disabled={accepting}
                            onClick={() => handleAcceptOrder(ord.id)}
                            className="w-full py-2.5 rounded-xl bg-[#E21B70] hover:bg-[#C4135E] text-white text-xs font-semibold disabled:opacity-50"
                          >
                            {accepting
                              ? lang === 'bn'
                                ? 'গ্রহণ করা হচ্ছে...'
                                : 'Accepting...'
                              : lang === 'bn'
                              ? 'ডেলিভারি গ্রহণ করুন'
                              : 'Accept Delivery Job'}
                          </button>
                        </div>
                      );
                    })}
                  </div>
                )}
              </section>
            </div>
          )}

          {/* ---------------- TAB 2: LIVE GPS & ROUTE MAP ---------------- */}
          {activeTab === 'map' && rider && (
            <section className="bg-white rounded-2xl border border-neutral-200 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-[#2E3138] flex items-center gap-2">
                    <Radio className={`w-4 h-4 ${sharingGps ? 'text-emerald-600' : 'text-[#E21B70]'}`} />
                    <span>
                      {lang === 'bn' ? 'লাইভ রাইডার GPS লোকেশন ও রুট' : 'Live Rider GPS & Route Map'}
                    </span>
                  </h2>
                  <p className="text-xs text-neutral-500 mt-0.5 font-mono tabular-nums">
                    {lang === 'bn' ? 'বর্তমান অবস্থান:' : 'Current Position:'}{' '}
                    {riderCoords.lat.toFixed(5)}, {riderCoords.lng.toFixed(5)}
                    {rider.locationUpdatedAt
                      ? ` · ${lang === 'bn' ? 'সর্বশেষ সিঙ্ক' : 'Synced'} ${new Date(
                          rider.locationUpdatedAt
                        ).toLocaleTimeString()}`
                      : ''}
                  </p>
                </div>

                <div className="flex flex-wrap items-center gap-2">
                  <select
                    value={selectedSyncZone}
                    aria-label="Select Bangladesh city or area to sync rider GPS"
                    onChange={(e) => setSelectedSyncZone(e.target.value)}
                    className="px-3 py-2 text-xs border border-neutral-200 rounded-lg bg-white font-semibold"
                  >
                    {DHAKA_DELIVERY_ZONES.map((z) => (
                      <optgroup key={z.code} label={`${z.code} — ${z.name}`}>
                        {z.areas.map((a) => (
                          <option key={a.name} value={a.name}>
                            {a.name} ({a.nameBn})
                          </option>
                        ))}
                      </optgroup>
                    ))}
                    <optgroup label={lang === 'bn' ? 'অন্যান্য বাংলাদেশ শহর' : 'Nationwide Bangladesh Cities'}>
                      {BANGLADESH_AREAS.filter((a) => !a.zoneCode).map((a) => (
                        <option key={a.name} value={a.name}>
                          {a.name} ({a.division})
                        </option>
                      ))}
                    </optgroup>
                    <option value="__custom__">Custom Area...</option>
                  </select>
                  {selectedSyncZone === '__custom__' && (
                    <input
                      value={customSyncZone}
                      onChange={(e) => setCustomSyncZone(e.target.value)}
                      placeholder="Custom BD city/area"
                      className="px-2.5 py-2 text-xs border border-neutral-200 rounded-lg bg-white w-36"
                    />
                  )}
                  <button
                    type="button"
                    disabled={syncingLoc}
                    onClick={() => {
                      if (selectedSyncZone === '__custom__') {
                        const clean = customSyncZone.trim();
                        if (!clean) return;
                        persistRiderLocation(
                          { lat: riderCoords.lat, lng: riderCoords.lng, zone: clean },
                          `Working zone updated to ${clean}`
                        );
                      } else {
                        const found = BANGLADESH_AREAS.find((a) => a.name === selectedSyncZone);
                        if (found) {
                          persistRiderLocation(
                            { lat: found.lat, lng: found.lng, zone: found.name },
                            lang === 'bn'
                              ? `${found.name} লোকেশনে সিঙ্ক হয়েছে`
                              : `Rider location set to ${found.name}`
                          );
                        }
                      }
                    }}
                    className="px-3 py-2 rounded-lg border border-neutral-200 hover:border-[#E21B70] text-xs font-semibold inline-flex items-center gap-1.5 whitespace-nowrap"
                  >
                    <LocateFixed className="w-3.5 h-3.5 text-[#E21B70]" />
                    <span>{lang === 'bn' ? 'এলাকায় সিঙ্ক' : 'Sync Area'}</span>
                  </button>
                </div>
              </div>

              {gpsStatusMsg && (
                <div className="px-3 py-2 rounded-xl bg-emerald-50 border border-emerald-200 text-xs font-medium text-emerald-800">
                  {gpsStatusMsg}
                </div>
              )}

              <DhakaMapPicker
                mapsApiKey={mapsApiKey}
                lang={lang}
                center={
                  primaryActiveOrder
                    ? { lat: primaryActiveOrder.deliveryLat, lng: primaryActiveOrder.deliveryLng }
                    : riderCoords
                }
                markerLabel={
                  primaryActiveOrder
                    ? `${primaryActiveOrder.deliveryArea} (Dropoff)`
                    : `${rider.fullName} (Position)`
                }
                pinType="user"
                userName={primaryActiveOrder ? primaryActiveOrder.customerName : rider.fullName}
                secondaryPoint={
                  primaryActiveOrder &&
                  typeof primaryActiveOrder.restaurantLat === 'number' &&
                  typeof primaryActiveOrder.restaurantLng === 'number'
                    ? {
                        lat: primaryActiveOrder.restaurantLat,
                        lng: primaryActiveOrder.restaurantLng,
                        label: primaryActiveOrder.restaurantName,
                      }
                    : undefined
                }
                riderPoint={{
                  lat: riderCoords.lat,
                  lng: riderCoords.lng,
                  label: `${rider.fullName} (You)`,
                }}
                interactive
                heightClass="h-[340px]"
                onSelectLocation={(loc) => {
                  persistRiderLocation(
                    {
                      lat: loc.lat,
                      lng: loc.lng,
                      zone:
                        loc.areaName && loc.areaName !== 'Current GPS' ? loc.areaName : undefined,
                    },
                    lang === 'bn'
                      ? `লোকেশন আপডেট হয়েছে (${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)})`
                      : `Rider pin moved to ${loc.areaName || `${loc.lat.toFixed(4)}, ${loc.lng.toFixed(4)}`}`
                  );
                }}
              />
            </section>
          )}

          {/* ---------------- TAB 3: HISTORY & EARNINGS ---------------- */}
          {activeTab === 'earnings' && (
            <section className="space-y-4">
              <div className="grid grid-cols-1 sm:grid-cols-3 gap-3.5 tabular-nums">
                <div className="bg-white rounded-xl border border-neutral-200 p-4">
                  <p className="text-xs text-neutral-500">
                    {lang === 'bn' ? 'মোট অর্জিত আয়' : 'Lifetime Rider Earnings'}
                  </p>
                  <p className="text-xl font-bold text-[#E21B70] mt-1 font-mono">
                    {formatBdt(rider?.totalEarnings ?? 0, lang)}
                  </p>
                </div>
                <div className="bg-white rounded-xl border border-neutral-200 p-4">
                  <p className="text-xs text-neutral-500">
                    {lang === 'bn' ? 'ক্যাশ অন ডেলিভারি সম্পন্ন' : 'Completed COD Orders'}
                  </p>
                  <p className="text-xl font-bold text-[#2E3138] mt-1 font-mono">
                    {codCompletedCount}
                  </p>
                </div>
                <div className="bg-white rounded-xl border border-neutral-200 p-4">
                  <p className="text-xs text-neutral-500">
                    {lang === 'bn' ? 'প্রিপেইড ডেলিভারি সম্পন্ন' : 'Completed Prepaid Orders'}
                  </p>
                  <p className="text-xl font-bold text-emerald-700 mt-1 font-mono">
                    {prepaidCompletedCount}
                  </p>
                </div>
              </div>

              <div className="bg-white rounded-2xl border border-neutral-200 p-5 space-y-3">
                <div className="flex flex-wrap items-center justify-between gap-3">
                  <h2 className="text-base font-bold text-[#2E3138] flex items-center gap-2">
                    <Wallet className="w-4 h-4 text-[#E21B70]" />
                    <span>
                      {lang === 'bn'
                        ? `ডেলিভারি হিস্ট্রি (${filteredHistoryOrders.length})`
                        : `Completed & Past Deliveries (${filteredHistoryOrders.length})`}
                    </span>
                  </h2>
                  <div className="relative w-full sm:w-64">
                    <Search className="w-3.5 h-3.5 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      value={historySearch}
                      onChange={(e) => setHistorySearch(e.target.value)}
                      placeholder={lang === 'bn' ? 'অর্ডার বা এলাকা খুঁজুন...' : 'Search past deliveries...'}
                      className="w-full pl-8 pr-3 py-1.5 text-xs border border-neutral-200 rounded-lg"
                    />
                  </div>
                </div>

                {filteredHistoryOrders.length === 0 ? (
                  <p className="text-xs text-neutral-500 py-4">
                    {lang === 'bn'
                      ? 'এখনো কোনো সম্পন্ন ডেলিভারি হিস্ট্রি নেই।'
                      : 'No completed deliveries recorded in your history yet.'}
                  </p>
                ) : (
                  <div className="divide-y divide-neutral-100">
                    {filteredHistoryOrders.map((ord) => (
                      <div
                        key={ord.id}
                        className="py-3 flex flex-wrap items-center justify-between gap-3"
                      >
                        <div className="space-y-0.5">
                          <div className="flex items-center gap-2 text-xs text-neutral-500 font-mono tabular-nums">
                            <span className="font-semibold text-[#2E3138]">{ord.orderNumber}</span>
                            <span aria-hidden="true">·</span>
                            <span>{new Date(ord.createdAt).toLocaleDateString()}</span>
                            <span aria-hidden="true">·</span>
                            <span className="text-emerald-700 font-semibold uppercase">
                              {ord.status.replace(/_/g, ' ')}
                            </span>
                          </div>
                          <p className="text-sm font-semibold text-[#2E3138]">
                            {ord.restaurantName} → {ord.deliveryArea}
                          </p>
                          <p className="text-xs text-neutral-500">
                            {ord.customerName} · {ord.paymentMethod.toUpperCase()}
                          </p>
                        </div>

                        <div className="flex items-center gap-3 tabular-nums">
                          <div className="text-right">
                            <p className="text-xs font-bold text-[#E21B70] font-mono">
                              +{formatBdt(Math.max(40, ord.deliveryFee), lang)}
                            </p>
                            <p className="text-[11px] text-neutral-500">
                              Order {formatBdt(ord.totalAmount, lang)}
                            </p>
                          </div>
                          <button
                            type="button"
                            onClick={() => onTrackOrder(ord.id)}
                            className="px-3 py-1.5 rounded-lg border border-neutral-200 text-xs font-semibold hover:border-[#E21B70]"
                          >
                            {lang === 'bn' ? 'বিস্তারিত' : 'Details'}
                          </button>
                        </div>
                      </div>
                    ))}
                  </div>
                )}
              </div>
            </section>
          )}

          {/* ---------------- TAB 4: OPEN RESTAURANT RIDER JOBS BOARD ---------------- */}
          {activeTab === 'jobs' && (
            <section className="bg-white rounded-2xl border border-neutral-200 p-5 space-y-4">
              <div className="flex flex-wrap items-center justify-between gap-3">
                <div>
                  <h2 className="text-base font-bold text-[#2E3138] flex items-center gap-2">
                    <Briefcase className="w-4 h-4 text-[#E21B70]" />
                    <span>
                      {lang === 'bn'
                        ? `রেস্টুরেন্টের উন্মুক্ত রাইডার জব (${riderJobs.length})`
                        : `Open Restaurant Rider Jobs (${riderJobs.length})`}
                    </span>
                  </h2>
                  <p className="text-xs text-neutral-500 mt-0.5">
                    {lang === 'bn'
                      ? 'রেস্টুরেন্ট মালিকদের পোস্ট করা স্থায়ী বা পার্ট-টাইম রাইডার চাকরিতে সরাসরি আবেদন করুন।'
                      : 'Apply directly to delivery rider positions posted by partner restaurants.'}
                  </p>
                </div>
                {jobAppFeedback && (
                  <div className="px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-700">
                    {jobAppFeedback}
                  </div>
                )}
              </div>

              {riderJobs.length === 0 ? (
                <p className="text-xs text-neutral-500 py-3">
                  {lang === 'bn'
                    ? 'এই মুহূর্তে কোনো রেস্টুরেন্ট জব পোস্ট করেনি — আপনি ফ্লিট রাইডার হিসেবে অর্ডার ডেলিভারি করতে পারেন।'
                    : 'No restaurant-specific rider jobs posted right now — continue accepting open platform deliveries.'}
                </p>
              ) : (
                <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
                  {riderJobs.map((job) => (
                    <div
                      key={job.id}
                      className="rounded-xl border border-neutral-200 p-4 flex flex-col justify-between gap-3 bg-[#FAFAFB]"
                    >
                      <div className="space-y-1.5">
                        <div className="flex items-start justify-between gap-2 text-[11px]">
                          <span className="font-bold text-[#E21B70]">{job.restaurantName}</span>
                          <span className="font-semibold text-neutral-600 tabular-nums">
                            {job.vacancies} {lang === 'bn' ? 'জন নিয়োগ' : 'openings'}
                          </span>
                        </div>
                        <h3 className="text-sm font-bold text-[#2E3138]">
                          {lang === 'bn' ? job.titleBn : job.title}
                        </h3>
                        <p className="text-xs text-neutral-600">
                          {job.zone} · {job.vehicleType}
                        </p>
                        <p className="text-xs font-semibold text-[#2E3138] tabular-nums">
                          {job.salaryRange}
                        </p>
                        <p className="text-[11px] text-neutral-500">{job.shiftHours}</p>
                        {job.description && (
                          <p className="text-[11px] text-neutral-600 line-clamp-2 pt-1">
                            {job.description}
                          </p>
                        )}
                      </div>
                      <button
                        type="button"
                        onClick={() => {
                          setApplyingJob(job);
                          setJobAppZone(job.zone || BANGLADESH_AREAS[0].name);
                          setJobAppError(null);
                        }}
                        className="w-full py-2 rounded-xl bg-[#2E3138] hover:bg-[#E21B70] text-white text-xs font-semibold transition-colors"
                      >
                        {lang === 'bn' ? 'এই জবে আবেদন করুন' : 'Apply for Rider Job'}
                      </button>
                    </div>
                  ))}
                </div>
              )}
            </section>
          )}
        </div>
      )}

      {/* Onboarding view also includes the Open Restaurant Rider Jobs Board below */}
      {showOnboardingView && (
        <section className="bg-white rounded-2xl border border-neutral-200 p-5 space-y-4">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div>
              <h2 className="text-base font-bold text-[#2E3138] flex items-center gap-2">
                <Briefcase className="w-4 h-4 text-[#E21B70]" />
                <span>
                  {lang === 'bn'
                    ? `রেস্টুরেন্টের উন্মুক্ত রাইডার জব (${riderJobs.length})`
                    : `Open Restaurant Rider Jobs (${riderJobs.length})`}
                </span>
              </h2>
              <p className="text-xs text-neutral-500 mt-0.5">
                {lang === 'bn'
                  ? 'রেস্টুরেন্ট মালিকদের পোস্ট করা রাইডার চাকরিতে সরাসরি আবেদন করুন।'
                  : 'Apply directly to delivery rider positions posted by partner restaurants.'}
              </p>
            </div>
            {jobAppFeedback && (
              <div className="px-3 py-1.5 rounded-lg bg-emerald-50 border border-emerald-200 text-xs font-semibold text-emerald-700">
                {jobAppFeedback}
              </div>
            )}
          </div>

          {riderJobs.length === 0 ? (
            <p className="text-xs text-neutral-500 py-3">
              {lang === 'bn'
                ? 'এই মুহূর্তে কোনো রেস্টুরেন্ট জব পোস্ট করেনি — উপরের ফর্মে সরাসরি ফ্লিট রাইডার হিসেবে যুক্ত হতে পারেন।'
                : 'No restaurant-specific rider jobs posted right now — you can join the platform fleet directly above.'}
            </p>
          ) : (
            <div className="grid grid-cols-1 md:grid-cols-2 lg:grid-cols-3 gap-4">
              {riderJobs.map((job) => (
                <div
                  key={job.id}
                  className="rounded-xl border border-neutral-200 p-4 flex flex-col justify-between gap-3 bg-[#FAFAFB]"
                >
                  <div className="space-y-1.5">
                    <div className="flex items-start justify-between gap-2 text-[11px]">
                      <span className="font-bold text-[#E21B70]">{job.restaurantName}</span>
                      <span className="font-semibold text-neutral-600 tabular-nums">
                        {job.vacancies} {lang === 'bn' ? 'জন নিয়োগ' : 'openings'}
                      </span>
                    </div>
                    <h3 className="text-sm font-bold text-[#2E3138]">
                      {lang === 'bn' ? job.titleBn : job.title}
                    </h3>
                    <p className="text-xs text-neutral-600">
                      {job.zone} · {job.vehicleType}
                    </p>
                    <p className="text-xs font-semibold text-[#2E3138] tabular-nums">
                      {job.salaryRange}
                    </p>
                    <p className="text-[11px] text-neutral-500">{job.shiftHours}</p>
                    {job.description && (
                      <p className="text-[11px] text-neutral-600 line-clamp-2 pt-1">
                        {job.description}
                      </p>
                    )}
                  </div>
                  <button
                    type="button"
                    onClick={() => {
                      setApplyingJob(job);
                      setJobAppZone(job.zone || BANGLADESH_AREAS[0].name);
                      setJobAppError(null);
                    }}
                    className="w-full py-2 rounded-xl bg-[#2E3138] hover:bg-[#E21B70] text-white text-xs font-semibold transition-colors"
                  >
                    {lang === 'bn' ? 'এই জবে আবেদন করুন' : 'Apply for Rider Job'}
                  </button>
                </div>
              ))}
            </div>
          )}
        </section>
      )}

      {applyingJob && (
        <div className="fixed inset-0 z-50 bg-black/50 flex items-center justify-center p-4">
          <form
            onSubmit={handleSubmitJobApplication}
            className="bg-white rounded-2xl border border-neutral-200 max-w-md w-full p-5 space-y-3"
          >
            <div className="flex items-center justify-between">
              <div>
                <h3 className="text-sm font-bold text-[#2E3138]">
                  {lang === 'bn' ? applyingJob.titleBn : applyingJob.title}
                </h3>
                <p className="text-xs text-[#E21B70] font-semibold">
                  {applyingJob.restaurantName} · {applyingJob.zone}
                </p>
              </div>
              <button
                type="button"
                onClick={() => setApplyingJob(null)}
                aria-label="Close application modal"
                className="p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100"
              >
                <X className="w-4 h-4" />
              </button>
            </div>

            <div className="space-y-2.5 text-xs">
              <div>
                <label className="block font-semibold text-neutral-700 mb-1">Full Name</label>
                <input
                  required
                  value={jobAppFullName}
                  onChange={(e) => setJobAppFullName(e.target.value)}
                  placeholder="Your full name"
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm"
                />
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-semibold text-neutral-700 mb-1">Phone</label>
                  <input
                    required
                    value={jobAppPhone}
                    onChange={(e) => setJobAppPhone(e.target.value)}
                    placeholder="+88017..."
                    className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-neutral-700 mb-1">Email</label>
                  <input
                    required
                    type="email"
                    value={jobAppEmail}
                    onChange={(e) => setJobAppEmail(e.target.value)}
                    placeholder="you@example.com"
                    className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm"
                  />
                </div>
              </div>
              <div className="grid grid-cols-2 gap-2.5">
                <div>
                  <label className="block font-semibold text-neutral-700 mb-1">Vehicle</label>
                  <input
                    required
                    value={jobAppVehicle}
                    onChange={(e) => setJobAppVehicle(e.target.value)}
                    placeholder="Motorbike / Bicycle"
                    className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm"
                  />
                </div>
                <div>
                  <label className="block font-semibold text-neutral-700 mb-1">Area / Zone</label>
                  <input
                    required
                    value={jobAppZone}
                    onChange={(e) => setJobAppZone(e.target.value)}
                    placeholder="Gulshan, Dhaka"
                    className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm"
                  />
                </div>
              </div>
              <div>
                <label className="block font-semibold text-neutral-700 mb-1">
                  NID Number (Optional)
                </label>
                <input
                  value={jobAppNid}
                  onChange={(e) => setJobAppNid(e.target.value)}
                  placeholder="National ID"
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm"
                />
              </div>
              <div>
                <label className="block font-semibold text-neutral-700 mb-1">
                  Experience / Note
                </label>
                <textarea
                  rows={2}
                  value={jobAppNote}
                  onChange={(e) => setJobAppNote(e.target.value)}
                  placeholder="Years of delivery experience or preferred shift..."
                  className="w-full px-3 py-2 border border-neutral-200 rounded-lg text-sm"
                />
              </div>
            </div>

            {jobAppError && (
              <div className="p-2.5 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                {jobAppError}
              </div>
            )}

            <div className="flex justify-end gap-2 pt-1">
              <button
                type="button"
                onClick={() => setApplyingJob(null)}
                className="px-4 py-2 rounded-xl border border-neutral-200 text-xs font-semibold text-neutral-700"
              >
                Cancel
              </button>
              <button
                type="submit"
                disabled={submittingJobApp}
                className="px-4 py-2 rounded-xl bg-[#E21B70] text-white text-xs font-semibold disabled:opacity-50"
              >
                {submittingJobApp ? 'Submitting...' : 'Submit Application'}
              </button>
            </div>
          </form>
        </div>
      )}
    </div>
  );
}
