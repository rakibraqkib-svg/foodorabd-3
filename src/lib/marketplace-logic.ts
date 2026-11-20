export type DeliveryMode = 'platform' | 'restaurant' | 'third_party';
export const BUILTIN_PAYMENT_METHODS = ['bkash', 'nagad', 'sslcommerz', 'cod'] as const;
export type BuiltinPaymentMethod = (typeof BUILTIN_PAYMENT_METHODS)[number];
export type PaymentMethod = string;
export type OrderStatus =
  | 'confirmed'
  | 'accepted'
  | 'preparing'
  | 'ready'
  | 'rider_assigned'
  | 'picked_up'
  | 'on_the_way'
  | 'delivered'
  | 'cancelled';

export interface CartAddon {
  name: string;
  price: number;
}

export interface CartItemInput {
  foodItemId: number;
  restaurantId: number;
  name: string;
  nameBn: string;
  imageUrl: string;
  basePrice: number;
  discountPrice?: number | null;
  variationName?: string;
  variationDelta?: number;
  addons: CartAddon[];
  quantity: number;
  specialInstructions?: string;
}

export interface CouponInput {
  code: string;
  type: 'percentage' | 'fixed' | 'free_delivery';
  value: number;
  minOrder: number;
  maxDiscount: number;
  restaurantId?: number | null;
  isActive: boolean;
  usedCount: number;
  usageLimit: number;
}

export interface OrderFinancialParams {
  subtotal: number;
  discountAmount: number;
  deliveryFee: number;
  serviceFee: number;
  taxAmount?: number;
  commissionType: 'percentage' | 'fixed';
  commissionRate: number;
  fixedCommission: number;
}

export interface OrderFinancialBreakdown {
  subtotal: number;
  discountAmount: number;
  netFoodRevenue: number;
  deliveryFee: number;
  serviceFee: number;
  taxAmount: number;
  totalPayable: number;
  platformCommission: number;
  restaurantEarnings: number;
}

export function formatBdt(amount: number, lang: 'bn' | 'en' = 'bn'): string {
  const rounded = Math.round(amount);
  const formatted = rounded.toLocaleString('en-US');
  if (lang === 'bn') {
    return `৳${toBengaliDigits(formatted)}`;
  }
  return `৳${formatted}`;
}

export function toBengaliDigits(input: string | number): string {
  const bnDigits = ['০', '১', '২', '৩', '৪', '৫', '৬', '৭', '৮', '৯'];
  return String(input).replace(/\d/g, (d) => bnDigits[Number(d)] ?? d);
}

export function calculateCartItemUnitPrice(item: Pick<CartItemInput, 'basePrice' | 'discountPrice' | 'variationDelta' | 'addons'>): number {
  const effectiveBase =
    item.discountPrice !== null && item.discountPrice !== undefined && item.discountPrice > 0
      ? item.discountPrice
      : item.basePrice;
  const variationCost = item.variationDelta ?? 0;
  const addonsCost = item.addons.reduce((sum, addon) => sum + Math.max(0, addon.price), 0);
  return Math.max(0, effectiveBase + variationCost + addonsCost);
}

export function calculateCartSubtotal(items: CartItemInput[]): number {
  return items.reduce((sum, item) => {
    const qty = Math.max(1, Math.floor(item.quantity));
    return sum + calculateCartItemUnitPrice(item) * qty;
  }, 0);
}

export function canAddToSingleRestaurantCart(
  existingItems: Pick<CartItemInput, 'restaurantId'>[],
  incomingRestaurantId: number
): boolean {
  if (existingItems.length === 0) return true;
  return existingItems[0].restaurantId === incomingRestaurantId;
}

export function evaluateCoupon(
  coupon: CouponInput,
  subtotal: number,
  deliveryFee: number,
  restaurantId: number
): { valid: boolean; discountAmount: number; deliveryFeeAfterCoupon: number; reason?: string } {
  if (!coupon.isActive) {
    return { valid: false, discountAmount: 0, deliveryFeeAfterCoupon: deliveryFee, reason: 'Coupon is inactive' };
  }
  if (coupon.usedCount >= coupon.usageLimit) {
    return { valid: false, discountAmount: 0, deliveryFeeAfterCoupon: deliveryFee, reason: 'Coupon usage limit reached' };
  }
  if (coupon.restaurantId && coupon.restaurantId !== restaurantId) {
    return { valid: false, discountAmount: 0, deliveryFeeAfterCoupon: deliveryFee, reason: 'Coupon not valid for this restaurant' };
  }
  if (subtotal < coupon.minOrder) {
    return {
      valid: false,
      discountAmount: 0,
      deliveryFeeAfterCoupon: deliveryFee,
      reason: `Minimum order of ৳${coupon.minOrder} required`,
    };
  }

  if (coupon.type === 'free_delivery') {
    return {
      valid: true,
      discountAmount: 0,
      deliveryFeeAfterCoupon: 0,
    };
  }

  if (coupon.type === 'fixed') {
    const discount = Math.min(subtotal, Math.max(0, coupon.value));
    return {
      valid: true,
      discountAmount: discount,
      deliveryFeeAfterCoupon: deliveryFee,
    };
  }

  // Percentage discount with maxDiscount cap
  const rawPct = Math.round((subtotal * coupon.value) / 100);
  const capped = coupon.maxDiscount > 0 ? Math.min(rawPct, coupon.maxDiscount) : rawPct;
  const discount = Math.min(subtotal, Math.max(0, capped));
  return {
    valid: true,
    discountAmount: discount,
    deliveryFeeAfterCoupon: deliveryFee,
  };
}

export function calculateOrderFinancials(params: OrderFinancialParams): OrderFinancialBreakdown {
  const subtotal = Math.max(0, Math.round(params.subtotal));
  const discountAmount = Math.min(subtotal, Math.max(0, Math.round(params.discountAmount)));
  const netFoodRevenue = Math.max(0, subtotal - discountAmount);
  const deliveryFee = Math.max(0, Math.round(params.deliveryFee));
  const serviceFee = Math.max(0, Math.round(params.serviceFee));
  const taxAmount = Math.max(0, Math.round(params.taxAmount ?? 0));

  let platformCommission = 0;
  if (netFoodRevenue > 0) {
    if (params.commissionType === 'fixed') {
      platformCommission = Math.min(netFoodRevenue, Math.max(0, Math.round(params.fixedCommission)));
    } else {
      platformCommission = Math.round((netFoodRevenue * Math.max(0, params.commissionRate)) / 100);
    }
  }

  const restaurantEarnings = Math.max(0, netFoodRevenue - platformCommission);
  const totalPayable = netFoodRevenue + deliveryFee + serviceFee + taxAmount;

  return {
    subtotal,
    discountAmount,
    netFoodRevenue,
    deliveryFee,
    serviceFee,
    taxAmount,
    totalPayable,
    platformCommission,
    restaurantEarnings,
  };
}

const VALID_TRANSITIONS: Record<OrderStatus, OrderStatus[]> = {
  confirmed: ['accepted', 'preparing', 'cancelled'],
  accepted: ['preparing', 'ready', 'cancelled'],
  preparing: ['ready', 'cancelled'],
  ready: ['rider_assigned', 'picked_up', 'on_the_way', 'delivered', 'cancelled'],
  rider_assigned: ['picked_up', 'on_the_way', 'cancelled'],
  picked_up: ['on_the_way', 'delivered'],
  on_the_way: ['delivered'],
  delivered: [],
  cancelled: [],
};

export function canTransitionOrderStatus(from: OrderStatus, to: OrderStatus): boolean {
  if (from === to) return true;
  return VALID_TRANSITIONS[from]?.includes(to) ?? false;
}

export function haversineDistanceKm(
  lat1: number,
  lng1: number,
  lat2: number,
  lng2: number
): number {
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const R = 6371;
  const dLat = toRad(lat2 - lat1);
  const dLng = toRad(lng2 - lng1);
  const a =
    Math.sin(dLat / 2) * Math.sin(dLat / 2) +
    Math.cos(toRad(lat1)) * Math.cos(toRad(lat2)) * Math.sin(dLng / 2) * Math.sin(dLng / 2);
  const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
  return Math.round(R * c * 100) / 100;
}

export function estimateDeliveryFeeAndEta(
  distanceKm: number,
  baseFee: number,
  deliveryMode: DeliveryMode
): { fee: number; etaMinutes: number } {
  const extraKm = Math.max(0, distanceKm - 2);
  const modeSurcharge = deliveryMode === 'third_party' ? 10 : 0;
  const fee = Math.round(baseFee + extraKm * 12 + modeSurcharge);
  const etaMinutes = Math.max(12, Math.round(14 + distanceKm * 5.5));
  return { fee, etaMinutes };
}

export function mapOpenMeteoWeather(
  weatherCode: number,
  precipitationMm: number
): { labelEn: string; labelBn: string; isRaining: boolean; rainBufferMin: number } {
  const hasPrecip = precipitationMm > 0.2;
  if (weatherCode >= 95) {
    return { labelEn: 'Thunderstorm', labelBn: 'বজ্রবৃষ্টি', isRaining: true, rainBufferMin: 12 };
  }
  if ((weatherCode >= 51 && weatherCode <= 82) || hasPrecip) {
    return { labelEn: 'Rainy', labelBn: 'বৃষ্টি হচ্ছে', isRaining: true, rainBufferMin: 7 };
  }
  if (weatherCode === 45 || weatherCode === 48) {
    return { labelEn: 'Hazy / Fog', labelBn: 'কুয়াশাচ্ছন্ন', isRaining: false, rainBufferMin: 2 };
  }
  if (weatherCode >= 1 && weatherCode <= 3) {
    return { labelEn: 'Partly Cloudy', labelBn: 'আংশিক মেঘলা', isRaining: false, rainBufferMin: 0 };
  }
  return { labelEn: 'Clear Sky', labelBn: 'পরিষ্কার আকাশ', isRaining: false, rainBufferMin: 0 };
}

export function convertBdtToCurrency(amountBdt: number, ratePerBdt: number): number {
  if (!Number.isFinite(amountBdt) || !Number.isFinite(ratePerBdt) || amountBdt <= 0 || ratePerBdt <= 0) {
    return 0;
  }
  return Math.round(amountBdt * ratePerBdt * 100) / 100;
}

export interface VendorAnalyticsOrderInput {
  id: number;
  status: string;
  subtotal: number;
  discountAmount: number;
  totalAmount: number;
  restaurantEarnings: number;
  createdAt: string | Date;
  itemsSnapshotJson: Array<{
    foodItemId: number;
    name: string;
    nameBn: string;
    quantity: number;
    unitPrice: number;
    lineTotal: number;
  }>;
}

export interface VendorAnalyticsLedgerInput {
  orderId: number | null;
  entryType: string;
  grossAmount: number;
  netRestaurantAmount: number;
  createdAt: string | Date;
}

export interface VendorAnalyticsMenuItemInput {
  id: number;
  name: string;
  nameBn: string;
  category: string;
  imageUrl?: string;
}

export interface VendorPeriodPoint {
  key: string;
  label: string;
  orders: number;
  grossRevenue: number;
  netRevenue: number;
}

export interface TopSellingFoodItem {
  foodItemId: number;
  name: string;
  nameBn: string;
  category: string;
  quantitySold: number;
  revenue: number;
  orderCount: number;
}

export interface VendorAnalyticsSummary {
  dailySeries: VendorPeriodPoint[];
  monthlySeries: VendorPeriodPoint[];
  topSellingItems: TopSellingFoodItem[];
  totalOrders: number;
  deliveredOrders: number;
  grossRevenue: number;
  netVendorRevenue: number;
  avgOrderValue: number;
}

const MONTH_SHORT = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

export function buildVendorAnalytics(
  ordersList: VendorAnalyticsOrderInput[],
  _ledgerList: VendorAnalyticsLedgerInput[] = [],
  menuItems: VendorAnalyticsMenuItemInput[] = []
): VendorAnalyticsSummary {
  const menuMap = new Map<number, VendorAnalyticsMenuItemInput>();
  for (const m of menuItems) {
    menuMap.set(m.id, m);
  }

  const dailyMap = new Map<string, VendorPeriodPoint>();
  const monthlyMap = new Map<string, VendorPeriodPoint>();
  const itemMap = new Map<string, TopSellingFoodItem>();

  let totalOrders = 0;
  let deliveredOrders = 0;
  let grossRevenue = 0;
  let netVendorRevenue = 0;

  for (const order of ordersList) {
    if (order.status === 'cancelled') continue;
    totalOrders += 1;
    if (order.status === 'delivered') deliveredOrders += 1;

    const orderGross = Math.max(0, order.subtotal - (order.discountAmount || 0));
    const orderNet = Math.max(0, order.restaurantEarnings || 0);
    grossRevenue += orderGross;
    netVendorRevenue += orderNet;

    const d = new Date(order.createdAt);
    const validDate = Number.isNaN(d.getTime()) ? new Date() : d;
    const yyyy = validDate.getUTCFullYear();
    const mmNum = validDate.getUTCMonth();
    const ddNum = validDate.getUTCDate();
    const mm = String(mmNum + 1).padStart(2, '0');
    const dd = String(ddNum).padStart(2, '0');

    const dayKey = `${yyyy}-${mm}-${dd}`;
    const dayLabel = `${MONTH_SHORT[mmNum]} ${ddNum}`;
    const dayEntry = dailyMap.get(dayKey) ?? {
      key: dayKey,
      label: dayLabel,
      orders: 0,
      grossRevenue: 0,
      netRevenue: 0,
    };
    dayEntry.orders += 1;
    dayEntry.grossRevenue += orderGross;
    dayEntry.netRevenue += orderNet;
    dailyMap.set(dayKey, dayEntry);

    const monthKey = `${yyyy}-${mm}`;
    const monthLabel = `${MONTH_SHORT[mmNum]} ${String(yyyy).slice(-2)}`;
    const monthEntry = monthlyMap.get(monthKey) ?? {
      key: monthKey,
      label: monthLabel,
      orders: 0,
      grossRevenue: 0,
      netRevenue: 0,
    };
    monthEntry.orders += 1;
    monthEntry.grossRevenue += orderGross;
    monthEntry.netRevenue += orderNet;
    monthlyMap.set(monthKey, monthEntry);

    const seenInOrder = new Set<string>();
    const items = Array.isArray(order.itemsSnapshotJson) ? order.itemsSnapshotJson : [];
    for (const line of items) {
      const qty = Math.max(1, Number(line.quantity) || 1);
      const lineRev = Math.max(0, Number(line.lineTotal) || Number(line.unitPrice || 0) * qty);
      const itemKey = line.foodItemId ? `id:${line.foodItemId}` : `name:${line.name}`;
      const matchedMenu = line.foodItemId ? menuMap.get(line.foodItemId) : undefined;
      const existing = itemMap.get(itemKey) ?? {
        foodItemId: line.foodItemId || 0,
        name: matchedMenu?.name || line.name,
        nameBn: matchedMenu?.nameBn || line.nameBn || line.name,
        category: matchedMenu?.category || 'Menu Item',
        quantitySold: 0,
        revenue: 0,
        orderCount: 0,
      };
      existing.quantitySold += qty;
      existing.revenue += lineRev;
      if (!seenInOrder.has(itemKey)) {
        existing.orderCount += 1;
        seenInOrder.add(itemKey);
      }
      itemMap.set(itemKey, existing);
    }
  }

  const dailySeries = Array.from(dailyMap.values()).sort((a, b) => a.key.localeCompare(b.key));
  const monthlySeries = Array.from(monthlyMap.values()).sort((a, b) => a.key.localeCompare(b.key));
  const topSellingItems = Array.from(itemMap.values()).sort(
    (a, b) => b.quantitySold - a.quantitySold || b.revenue - a.revenue
  );

  return {
    dailySeries,
    monthlySeries,
    topSellingItems,
    totalOrders,
    deliveredOrders,
    grossRevenue,
    netVendorRevenue,
    avgOrderValue: totalOrders > 0 ? Math.round(grossRevenue / totalOrders) : 0,
  };
}

export interface LiveRiderEtaResult {
  remainingKm: number;
  etaMinutes: number;
  arrived: boolean;
}

export function calculateLiveRiderEta(
  riderLat: number,
  riderLng: number,
  destLat: number,
  destLng: number,
  status: string = 'on_the_way',
  speedKmPerHour: number = 22
): LiveRiderEtaResult {
  if (status === 'delivered') {
    return { remainingKm: 0, etaMinutes: 0, arrived: true };
  }
  if (
    !Number.isFinite(riderLat) ||
    !Number.isFinite(riderLng) ||
    !Number.isFinite(destLat) ||
    !Number.isFinite(destLng)
  ) {
    return { remainingKm: 0, etaMinutes: 15, arrived: false };
  }
  const remainingKm = haversineDistanceKm(riderLat, riderLng, destLat, destLng);
  const arrived = remainingKm <= 0.12;
  const safeSpeed = Math.max(8, speedKmPerHour);
  const travelMins = (remainingKm / safeSpeed) * 60;
  const etaMinutes = arrived ? 1 : Math.max(2, Math.round(travelMins + 2));
  return { remainingKm, etaMinutes, arrived };
}

export function advanceRiderAlongRoute(
  currentLat: number,
  currentLng: number,
  targetLat: number,
  targetLng: number,
  fraction: number = 0.35
): { lat: number; lng: number } {
  const dist = haversineDistanceKm(currentLat, currentLng, targetLat, targetLng);
  if (dist <= 0.08) {
    return {
      lat: Math.round(targetLat * 1e6) / 1e6,
      lng: Math.round(targetLng * 1e6) / 1e6,
    };
  }
  const step = Math.min(1, Math.max(0.05, fraction));
  const nextLat = currentLat + (targetLat - currentLat) * step;
  const nextLng = currentLng + (targetLng - currentLng) * step;
  return {
    lat: Math.round(nextLat * 1e6) / 1e6,
    lng: Math.round(nextLng * 1e6) / 1e6,
  };
}

export const PRIMARY_SUPER_ADMIN_EMAIL = 'rakibraqkib@gmail.com';
export const ADMIN_PIN_DEFAULT_EMAIL = 'raqkibrony@gmail.com';
export const PROTECTED_SUPER_ADMIN_EMAILS = [
  PRIMARY_SUPER_ADMIN_EMAIL,
  ADMIN_PIN_DEFAULT_EMAIL,
] as const;

export function isProtectedSuperAdminEmail(email: string): boolean {
  const normalized = email.trim().toLowerCase();
  return (PROTECTED_SUPER_ADMIN_EMAILS as readonly string[]).includes(normalized);
}

export function canActorModifyUserAccount(params: {
  actorUid: string;
  actorRole: string;
  targetUid: string;
  targetEmail: string;
  currentRole: string;
  nextRole: string;
  nextStatus: string;
}): { allowed: boolean; reason?: string } {
  const { actorUid, actorRole, targetUid, targetEmail, currentRole, nextRole, nextStatus } = params;
  if (actorRole !== 'admin' && actorRole !== 'super_admin') {
    return { allowed: false, reason: 'Only authorized Admin accounts can modify user roles.' };
  }
  if (isProtectedSuperAdminEmail(targetEmail)) {
    if (nextRole !== 'super_admin' || nextStatus === 'suspended') {
      return {
        allowed: false,
        reason: 'Primary Super Admin account is protected and cannot be demoted or suspended.',
      };
    }
  }
  if (actorUid === targetUid && nextStatus === 'suspended') {
    return { allowed: false, reason: 'You cannot suspend your own active admin account.' };
  }
  const touchesPrivilegedRole =
    currentRole === 'super_admin' ||
    currentRole === 'admin' ||
    nextRole === 'super_admin' ||
    nextRole === 'admin';
  if (touchesPrivilegedRole && actorRole !== 'super_admin') {
    return {
      allowed: false,
      reason: 'Only Super Admin can grant or modify Admin and Super Admin privileges.',
    };
  }
  return { allowed: true };
}

export type BroadcastTargetRole = 'all' | 'customer' | 'restaurant_owner' | 'rider' | 'admin';

export function validateBroadcastNotification(input: {
  targetRole: string;
  title: string;
  message: string;
  type?: string;
}):
  | {
      valid: true;
      targetRole: BroadcastTargetRole;
      title: string;
      message: string;
      type: 'system' | 'promo' | 'order';
    }
  | { valid: false; reason: string } {
  const allowedTargets: BroadcastTargetRole[] = [
    'all',
    'customer',
    'restaurant_owner',
    'rider',
    'admin',
  ];
  if (!allowedTargets.includes(input.targetRole as BroadcastTargetRole)) {
    return { valid: false, reason: 'Invalid broadcast target role.' };
  }
  const title = input.title.trim();
  const message = input.message.trim();
  if (title.length < 3 || title.length > 120) {
    return { valid: false, reason: 'Broadcast title must be between 3 and 120 characters.' };
  }
  if (message.length < 5 || message.length > 500) {
    return { valid: false, reason: 'Broadcast message must be between 5 and 500 characters.' };
  }
  const type = input.type === 'promo' || input.type === 'order' ? input.type : 'system';
  return {
    valid: true,
    targetRole: input.targetRole as BroadcastTargetRole,
    title,
    message,
    type,
  };
}

export interface StorefrontProductFilterInput {
  id: number;
  name: string;
  nameBn: string;
  category: string;
  description?: string;
  price: number;
  discountPrice: number | null;
  inStock: boolean;
  isAvailable: boolean;
  isPopular: boolean;
  isVisibleOnStorefront?: boolean;
  restaurantName: string;
  restaurantCuisine: string;
  deliveryMode: string;
}

export function isProductVisibleToCustomers(item: {
  isVisibleOnStorefront?: boolean;
  isAvailable?: boolean;
}): boolean {
  return item.isVisibleOnStorefront !== false && item.isAvailable !== false;
}

export function filterStorefrontProducts<T extends StorefrontProductFilterInput>(
  products: T[],
  opts: {
    cuisine?: string;
    query?: string;
    onlyDiscount?: boolean;
    deliveryFleet?: 'all' | 'platform' | 'third_party';
  } = {}
): T[] {
  const q = (opts.query || '').trim().toLowerCase();
  const cuisine = (opts.cuisine || 'All').trim().toLowerCase();
  const fleet = opts.deliveryFleet || 'all';

  return products
    .filter((item) => {
      if (!isProductVisibleToCustomers(item)) return false;
      if (cuisine && cuisine !== 'all') {
        const hay = `${item.category} ${item.restaurantCuisine} ${item.name}`.toLowerCase();
        if (!hay.includes(cuisine)) return false;
      }
      if (opts.onlyDiscount && !(item.discountPrice && item.discountPrice < item.price)) {
        return false;
      }
      if (fleet !== 'all' && item.deliveryMode !== fleet) {
        return false;
      }
      if (q) {
        const hay = `${item.name} ${item.nameBn} ${item.category} ${item.description || ''} ${item.restaurantName}`.toLowerCase();
        if (!hay.includes(q)) return false;
      }
      return true;
    })
    .sort((a, b) => {
      if (a.inStock !== b.inStock) return a.inStock ? -1 : 1;
      if (a.isPopular !== b.isPopular) return a.isPopular ? -1 : 1;
      return b.id - a.id;
    });
}

export interface PartnerProductInput {
  name?: unknown;
  nameBn?: unknown;
  category?: unknown;
  description?: unknown;
  imageUrl?: unknown;
  price?: unknown;
  discountPrice?: unknown;
  inStock?: unknown;
  isAvailable?: unknown;
  isPopular?: unknown;
  variations?: unknown;
  addons?: unknown;
}

export interface NormalizedPartnerProduct {
  name: string;
  nameBn: string;
  category: string;
  description: string;
  imageUrl: string;
  price: number;
  discountPrice: number | null;
  inStock: boolean;
  isAvailable: boolean;
  isPopular: boolean;
  variationsJson: Array<{ name: string; priceDelta: number }>;
  addonsJson: Array<{ name: string; price: number }>;
}

export function normalizePartnerProductInput(
  raw: PartnerProductInput,
  fallbackImageUrl: string
): { valid: true; product: NormalizedPartnerProduct } | { valid: false; reason: string } {
  const name = typeof raw.name === 'string' ? raw.name.trim() : '';
  if (name.length < 2 || name.length > 140) {
    return { valid: false, reason: 'Product name must be between 2 and 140 characters.' };
  }
  const nameBn =
    typeof raw.nameBn === 'string' && raw.nameBn.trim().length > 0 ? raw.nameBn.trim() : name;
  const category =
    typeof raw.category === 'string' && raw.category.trim().length >= 2
      ? raw.category.trim()
      : 'Popular';
  const description = typeof raw.description === 'string' ? raw.description.trim() : '';
  const imageUrl =
    typeof raw.imageUrl === 'string' && raw.imageUrl.trim().length > 0
      ? raw.imageUrl.trim()
      : fallbackImageUrl;
  const price = Math.round(Number(raw.price));
  if (!Number.isFinite(price) || price <= 0) {
    return { valid: false, reason: 'Product price must be a positive number in BDT.' };
  }
  let discountPrice: number | null = null;
  if (raw.discountPrice !== undefined && raw.discountPrice !== null && raw.discountPrice !== '') {
    const parsedDiscount = Math.round(Number(raw.discountPrice));
    if (!Number.isFinite(parsedDiscount) || parsedDiscount <= 0 || parsedDiscount >= price) {
      return {
        valid: false,
        reason: 'discountPrice must be a positive number lower than regular price.',
      };
    }
    discountPrice = parsedDiscount;
  }

  const variationsJson = Array.isArray(raw.variations)
    ? raw.variations
        .filter((v): v is { name: string; priceDelta?: number } => Boolean(v && typeof v === 'object' && typeof (v as { name?: unknown }).name === 'string'))
        .map((v) => ({
          name: v.name.trim() || 'Regular',
          priceDelta: Math.round(Number(v.priceDelta) || 0),
        }))
    : [];

  const addonsJson = Array.isArray(raw.addons)
    ? raw.addons
        .filter((a): a is { name: string; price?: number } => Boolean(a && typeof a === 'object' && typeof (a as { name?: unknown }).name === 'string'))
        .map((a) => ({
          name: a.name.trim(),
          price: Math.max(0, Math.round(Number(a.price) || 0)),
        }))
        .filter((a) => a.name.length > 0)
    : [];

  return {
    valid: true,
    product: {
      name,
      nameBn,
      category,
      description,
      imageUrl,
      price,
      discountPrice,
      inStock: raw.inStock === undefined ? true : Boolean(raw.inStock),
      isAvailable: raw.isAvailable === undefined ? true : Boolean(raw.isAvailable),
      isPopular: raw.isPopular === undefined ? false : Boolean(raw.isPopular),
      variationsJson: variationsJson.length > 0 ? variationsJson : [{ name: 'Regular', priceDelta: 0 }],
      addonsJson,
    },
  };
}

export type PaymentProviderType = 'mfs' | 'card' | 'wallet' | 'cod' | 'custom';
export type PaymentGatewayMode = 'sandbox' | 'live';

export interface PaymentGatewayRowLike {
  code: string;
  name: string;
  nameBn: string;
  providerType: string;
  mode: string;
  isActive: boolean;
  apiBaseUrl?: string | null;
  merchantId?: string | null;
  apiKey?: string | null;
  apiSecret?: string | null;
  webhookSecret?: string | null;
  instructions?: string | null;
  sortOrder?: number | null;
}

export const DEFAULT_PAYMENT_GATEWAYS: Array<{
  code: string;
  name: string;
  nameBn: string;
  providerType: PaymentProviderType;
  mode: PaymentGatewayMode;
  isActive: boolean;
  apiBaseUrl: string;
  instructions: string;
  sortOrder: number;
}> = [
  {
    code: 'bkash',
    name: 'bKash',
    nameBn: 'বিকাশ',
    providerType: 'mfs',
    mode: 'sandbox',
    isActive: true,
    apiBaseUrl: 'https://tokenized.sandbox.bka.sh/v1.2.0-beta',
    instructions: 'Pay securely via bKash tokenized checkout.',
    sortOrder: 1,
  },
  {
    code: 'nagad',
    name: 'Nagad',
    nameBn: 'নগদ',
    providerType: 'mfs',
    mode: 'sandbox',
    isActive: true,
    apiBaseUrl: 'https://api.mynagad.com/api/dfs',
    instructions: 'Fast MFS checkout with Nagad merchant wallet.',
    sortOrder: 2,
  },
  {
    code: 'sslcommerz',
    name: 'SSLCommerz / Card',
    nameBn: 'এসএসএলকমার্জ / কার্ড',
    providerType: 'card',
    mode: 'sandbox',
    isActive: true,
    apiBaseUrl: 'https://sandbox.sslcommerz.com',
    instructions: 'Visa, Mastercard, AMEX & Net Banking.',
    sortOrder: 3,
  },
  {
    code: 'cod',
    name: 'Cash on Delivery',
    nameBn: 'ক্যাশ অন ডেলিভারি',
    providerType: 'cod',
    mode: 'live',
    isActive: true,
    apiBaseUrl: '',
    instructions: 'Pay in cash to the rider at delivery.',
    sortOrder: 4,
  },
];

export function normalizeGatewayCode(input: string): string {
  return String(input || '')
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9_-]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
}

export function maskSecretValue(secret: string | null | undefined): string {
  const clean = typeof secret === 'string' ? secret.trim() : '';
  if (!clean) return '';
  if (clean.length <= 4) return '••••';
  return `••••${clean.slice(-4)}`;
}

export function isGatewayCredentialsConfigured(
  row: Pick<PaymentGatewayRowLike, 'code' | 'merchantId' | 'apiKey' | 'apiSecret'>,
  envConfigured = false
): boolean {
  if (normalizeGatewayCode(row.code) === 'cod') return true;
  const hasDbCreds = Boolean(
    (row.apiKey && row.apiKey.trim()) ||
      (row.apiSecret && row.apiSecret.trim()) ||
      (row.merchantId && row.merchantId.trim())
  );
  return hasDbCreds || envConfigured;
}

export function buildGatewayWebhookUrl(origin: string, code: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const cleanCode = normalizeGatewayCode(code) || 'custom';
  return `${cleanOrigin}/api/payments/webhook/${cleanCode}`;
}

export function toPublicPaymentGatewayView(
  row: PaymentGatewayRowLike,
  envConfigured = false
) {
  const providerType = (['mfs', 'card', 'wallet', 'cod', 'custom'].includes(row.providerType)
    ? row.providerType
    : 'custom') as PaymentProviderType;
  const mode = (row.mode === 'live' ? 'live' : 'sandbox') as PaymentGatewayMode;
  return {
    code: normalizeGatewayCode(row.code),
    name: row.name,
    nameBn: row.nameBn || row.name,
    providerType,
    mode,
    isActive: Boolean(row.isActive),
    instructions: row.instructions || '',
    sortOrder: Number(row.sortOrder ?? 10),
    isConfigured: isGatewayCredentialsConfigured(row, envConfigured),
  };
}

export function toAdminPaymentGatewayView(
  row: PaymentGatewayRowLike,
  origin: string,
  envConfigured = false
) {
  const pub = toPublicPaymentGatewayView(row, envConfigured);
  const apiKey = typeof row.apiKey === 'string' ? row.apiKey.trim() : '';
  const apiSecret = typeof row.apiSecret === 'string' ? row.apiSecret.trim() : '';
  const webhookSecret = typeof row.webhookSecret === 'string' ? row.webhookSecret.trim() : '';
  return {
    ...pub,
    apiBaseUrl: row.apiBaseUrl || '',
    merchantId: row.merchantId || '',
    hasApiKey: apiKey.length > 0,
    hasApiSecret: apiSecret.length > 0,
    hasWebhookSecret: webhookSecret.length > 0,
    apiKeyPreview: maskSecretValue(apiKey),
    apiSecretPreview: maskSecretValue(apiSecret),
    webhookSecretPreview: maskSecretValue(webhookSecret),
    webhookUrl: buildGatewayWebhookUrl(origin, pub.code),
  };
}

export function isGatewaySelectableAtCheckout(gateway: { isActive: boolean }): boolean {
  return Boolean(gateway.isActive);
}

export function isOwnerRestaurant(
  restaurantOwnerUid: string | null | undefined,
  actorUid: string | null | undefined
): boolean {
  if (!restaurantOwnerUid || !actorUid) return false;
  return restaurantOwnerUid.trim() === actorUid.trim();
}

export function partitionOwnedVsPartnerRestaurants<T extends { id: number; ownerUid: string }>(
  restaurants: T[],
  actorUid: string
): { own: T[]; partners: T[]; ordered: T[] } {
  const own: T[] = [];
  const partners: T[] = [];
  for (const r of restaurants) {
    if (isOwnerRestaurant(r.ownerUid, actorUid)) {
      own.push(r);
    } else {
      partners.push(r);
    }
  }
  return {
    own,
    partners,
    ordered: [...own, ...partners],
  };
}

export function escapeXml(input: string): string {
  return String(input || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

export function buildRobotsTxt(origin: string): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  return [
    'User-agent: *',
    'Allow: /',
    'Disallow: /api/admin/',
    'Disallow: /api/vendor/',
    'Disallow: /api/auth/',
    `Sitemap: ${cleanOrigin}/sitemap.xml`,
    '',
  ].join('\n');
}

export function buildSitemapXml(
  origin: string,
  restaurants: Array<{ slug: string; updatedAt?: string | Date | null }>
): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const today = new Date().toISOString().slice(0, 10);
  const urls: Array<{ loc: string; lastmod: string; changefreq: string; priority: string }> = [
    {
      loc: `${cleanOrigin}/`,
      lastmod: today,
      changefreq: 'daily',
      priority: '1.0',
    },
  ];

  const seenSlugs = new Set<string>();
  for (const r of restaurants) {
    const slug = String(r.slug || '').trim();
    if (!slug || seenSlugs.has(slug)) continue;
    seenSlugs.add(slug);
    let lastmod = today;
    if (r.updatedAt) {
      const d = new Date(r.updatedAt);
      if (!Number.isNaN(d.getTime())) {
        lastmod = d.toISOString().slice(0, 10);
      }
    }
    urls.push({
      loc: `${cleanOrigin}/?restaurant=${encodeURIComponent(slug)}`,
      lastmod,
      changefreq: 'daily',
      priority: '0.8',
    });
  }

  const urlNodes = urls
    .map(
      (u) =>
        `  <url>\n    <loc>${escapeXml(u.loc)}</loc>\n    <lastmod>${escapeXml(u.lastmod)}</lastmod>\n    <changefreq>${u.changefreq}</changefreq>\n    <priority>${u.priority}</priority>\n  </url>`
    )
    .join('\n');

  return `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urlNodes}\n</urlset>\n`;
}

export const BANGLADESH_COORDS_BOUNDS = {
  minLat: 20.5,
  maxLat: 26.7,
  minLng: 88.0,
  maxLng: 92.7,
} as const;

export function isWithinBangladesh(lat: number, lng: number): boolean {
  return (
    Number.isFinite(lat) &&
    Number.isFinite(lng) &&
    lat >= BANGLADESH_COORDS_BOUNDS.minLat &&
    lat <= BANGLADESH_COORDS_BOUNDS.maxLat &&
    lng >= BANGLADESH_COORDS_BOUNDS.minLng &&
    lng <= BANGLADESH_COORDS_BOUNDS.maxLng
  );
}

export function resolveNearestAreaFromList<T extends { name: string; lat: number; lng: number }>(
  lat: number,
  lng: number,
  areas: readonly T[]
): { area: T | null; distanceKm: number; label: string } {
  if (!areas || areas.length === 0) {
    return { area: null, distanceKm: 0, label: `${lat.toFixed(4)}, ${lng.toFixed(4)}` };
  }
  let best = areas[0];
  let bestDist = Infinity;
  for (const a of areas) {
    const d = haversineDistanceKm(lat, lng, a.lat, a.lng);
    if (d < bestDist) {
      bestDist = d;
      best = a;
    }
  }
  const thresholdKm = bestDist <= 18 ? best.name : `${best.name} (${lat.toFixed(3)}, ${lng.toFixed(3)})`;
  return { area: best, distanceKm: bestDist, label: thresholdKm };
}

export function buildOrderTrackingUrl(
  origin: string,
  orderId: number,
  trackingToken?: string | null
): string {
  const cleanOrigin = origin.replace(/\/+$/, '');
  const base = `${cleanOrigin}/?order=${encodeURIComponent(String(orderId))}`;
  const tok = String(trackingToken || '').trim();
  return tok ? `${base}&token=${encodeURIComponent(tok)}` : base;
}

export function doesEmailMatchOrder(orderEmail: string | null | undefined, queryEmail: string): boolean {
  const a = String(orderEmail || '').trim().toLowerCase();
  const b = String(queryEmail || '').trim().toLowerCase();
  return Boolean(a && b && a === b);
}

export function buildOrderTrackingEmailPayload(input: {
  origin: string;
  orderId: number;
  orderNumber: string;
  trackingToken?: string | null;
  customerName: string;
  customerEmail: string;
  restaurantName: string;
  deliveryArea: string;
  totalAmount: number;
  paymentMethod: string;
  status: string;
  statusNote?: string;
  riderName?: string | null;
}): {
  subject: string;
  trackingUrl: string;
  html: string;
  text: string;
} {
  const trackingUrl = buildOrderTrackingUrl(input.origin, input.orderId, input.trackingToken);
  const niceStatus = input.status.replace(/_/g, ' ').toUpperCase();
  const subject = `Foodora BD Order ${input.orderNumber} — ${niceStatus}`;
  const riderLine = input.riderName ? `<p><strong>Assigned Rider:</strong> ${escapeXml(input.riderName)}</p>` : '';
  const noteLine = input.statusNote ? `<p><strong>Update:</strong> ${escapeXml(input.statusNote)}</p>` : '';

  const html = `<!doctype html>
<html>
  <body style="font-family:Arial,sans-serif;background:#f7f7f7;padding:24px;color:#2E3138;">
    <div style="max-width:560px;margin:0 auto;background:#ffffff;border-radius:16px;padding:24px;border:1px solid #e5e7eb;">
      <h2 style="margin:0 0 8px;color:#E21B70;">Foodora BD — Live Order Tracking</h2>
      <p style="margin:0 0 16px;font-size:14px;">Hi ${escapeXml(input.customerName)},</p>
      <p style="margin:0 0 12px;font-size:14px;">Your order <strong>${escapeXml(input.orderNumber)}</strong> from <strong>${escapeXml(input.restaurantName)}</strong> is now <strong>${escapeXml(niceStatus)}</strong>.</p>
      <div style="background:#FFF0F6;border:1px solid #FBCFE8;border-radius:12px;padding:14px;font-size:13px;margin-bottom:16px;">
        <p style="margin:4px 0;"><strong>Delivery Area:</strong> ${escapeXml(input.deliveryArea)}</p>
        <p style="margin:4px 0;"><strong>Total Payable:</strong> ৳${input.totalAmount} (${escapeXml(input.paymentMethod.toUpperCase())})</p>
        ${riderLine}
        ${noteLine}
      </div>
      <a href="${escapeXml(trackingUrl)}" style="display:inline-block;background:#E21B70;color:#ffffff;text-decoration:none;font-weight:bold;padding:12px 20px;border-radius:10px;font-size:14px;">Track Order Live on Map</a>
      <p style="margin:16px 0 0;font-size:12px;color:#6b7280;word-break:break-all;">Or open: ${escapeXml(trackingUrl)}</p>
    </div>
  </body>
</html>`;

  const text = `Foodora BD — Order ${input.orderNumber} (${niceStatus})
Restaurant: ${input.restaurantName}
Delivery Area: ${input.deliveryArea}
Total: BDT ${input.totalAmount} (${input.paymentMethod.toUpperCase()})
${input.riderName ? `Rider: ${input.riderName}\n` : ''}${input.statusNote ? `Update: ${input.statusNote}\n` : ''}Track live: ${trackingUrl}`;

  return { subject, trackingUrl, html, text };
}

export const CUISINE_PRESET_OPTIONS: readonly string[] = [
  'Bangladeshi',
  'Biriyani',
  'Burger',
  'Pizza',
  'Kabab',
  'Chinese',
  'Bakery',
  'Drinks',
  'Seafood',
  'Fast Food',
  'Sweets & Desserts',
];

export const FOOD_CATEGORY_PRESET_OPTIONS: readonly string[] = [
  'Main Course',
  'Biriyani & Kacchi',
  'Burgers',
  'Pizza',
  'Kabab & Grill',
  'Bangladeshi',
  'Chinese & Momos',
  'Snacks & Appetizers',
  'Desserts & Bakery',
  'Drinks & Coffee',
  'Combo Meals',
];

export const VEHICLE_TYPE_PRESET_OPTIONS: readonly string[] = [
  'Motorbike',
  'Bicycle',
  'Scooter',
  'E-Bike / Van',
  'CNG / Auto',
  'Pickup Van',
];

export interface SelectOptionItem {
  value: string;
  label: string;
}

export function normalizeCustomOptionValue(raw: string): string {
  return String(raw || '')
    .trim()
    .replace(/\s+/g, ' ');
}

export function mergeCustomSelectOptions(
  presets: readonly SelectOptionItem[],
  customValues: readonly string[],
  currentValue?: string
): SelectOptionItem[] {
  const seen = new Set<string>();
  const out: SelectOptionItem[] = [];

  for (const item of presets) {
    const cleanVal = normalizeCustomOptionValue(item.value);
    if (!cleanVal) continue;
    const key = cleanVal.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: cleanVal, label: item.label || cleanVal });
  }

  for (const rawCustom of customValues) {
    const clean = normalizeCustomOptionValue(rawCustom);
    if (!clean) continue;
    const key = clean.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ value: clean, label: `${clean} (Custom)` });
  }

  const cleanCurrent = normalizeCustomOptionValue(currentValue || '');
  if (cleanCurrent && !seen.has(cleanCurrent.toLowerCase())) {
    out.push({ value: cleanCurrent, label: cleanCurrent });
  }

  return out;
}

export interface RiderCandidatePoint {
  uid: string;
  fullName: string;
  phone: string;
  vehicleType: string;
  zone: string;
  isAvailable: boolean;
  lat: number;
  lng: number;
  locationUpdatedAt: Date | string;
}

export interface StandbyRiderResult<T extends RiderCandidatePoint> {
  rider: T;
  distanceKm: number;
}

export function pickNearestStandbyRider<T extends RiderCandidatePoint>(
  candidates: readonly T[],
  targetLat: number,
  targetLng: number
): StandbyRiderResult<T> | null {
  if (!candidates || candidates.length === 0) return null;
  if (!Number.isFinite(targetLat) || !Number.isFinite(targetLng)) return null;

  const online = candidates.filter((c) => c.isAvailable && Number.isFinite(c.lat) && Number.isFinite(c.lng));
  const pool =
    online.length > 0
      ? online
      : candidates.filter((c) => Number.isFinite(c.lat) && Number.isFinite(c.lng));
  if (pool.length === 0) return null;

  let best = pool[0];
  let bestDist = haversineDistanceKm(best.lat, best.lng, targetLat, targetLng);
  for (let i = 1; i < pool.length; i += 1) {
    const d = haversineDistanceKm(pool[i].lat, pool[i].lng, targetLat, targetLng);
    if (d < bestDist) {
      best = pool[i];
      bestDist = d;
    }
  }
  return { rider: best, distanceKm: bestDist };
}

export interface OrderEtaSummaryInput {
  status: string;
  estimatedMinutes: number;
  restaurantLat?: number | null;
  restaurantLng?: number | null;
  deliveryLat: number;
  deliveryLng: number;
  riderLat?: number | null;
  riderLng?: number | null;
  standbyRiderLat?: number | null;
  standbyRiderLng?: number | null;
}

export interface OrderEtaSummary {
  etaMinutes: number;
  remainingKm: number;
  phase: 'awaiting_dispatch' | 'heading_to_restaurant' | 'heading_to_customer' | 'delivered' | 'cancelled';
}

export function computeOrderEtaSummary(input: OrderEtaSummaryInput): OrderEtaSummary {
  if (input.status === 'delivered') {
    return { etaMinutes: 0, remainingKm: 0, phase: 'delivered' };
  }
  if (input.status === 'cancelled') {
    return { etaMinutes: 0, remainingKm: 0, phase: 'cancelled' };
  }

  const hasRest =
    typeof input.restaurantLat === 'number' &&
    Number.isFinite(input.restaurantLat) &&
    typeof input.restaurantLng === 'number' &&
    Number.isFinite(input.restaurantLng);
  const hasRider =
    typeof input.riderLat === 'number' &&
    Number.isFinite(input.riderLat) &&
    typeof input.riderLng === 'number' &&
    Number.isFinite(input.riderLng);
  const hasStandby =
    typeof input.standbyRiderLat === 'number' &&
    Number.isFinite(input.standbyRiderLat) &&
    typeof input.standbyRiderLng === 'number' &&
    Number.isFinite(input.standbyRiderLng);

  const restToCustomerKm = hasRest
    ? haversineDistanceKm(
        input.restaurantLat as number,
        input.restaurantLng as number,
        input.deliveryLat,
        input.deliveryLng
      )
    : 2.5;

  if (hasRider) {
    if (input.status === 'rider_assigned' && hasRest) {
      const toRest = calculateLiveRiderEta(
        input.riderLat as number,
        input.riderLng as number,
        input.restaurantLat as number,
        input.restaurantLng as number,
        'rider_assigned'
      );
      const restDriveMin = Math.max(4, Math.round((restToCustomerKm / 22) * 60 + 2));
      return {
        etaMinutes: toRest.etaMinutes + restDriveMin,
        remainingKm: Math.round((toRest.remainingKm + restToCustomerKm) * 100) / 100,
        phase: 'heading_to_restaurant',
      };
    }

    const toDest = calculateLiveRiderEta(
      input.riderLat as number,
      input.riderLng as number,
      input.deliveryLat,
      input.deliveryLng,
      input.status
    );
    return {
      etaMinutes: toDest.etaMinutes,
      remainingKm: toDest.remainingKm,
      phase: 'heading_to_customer',
    };
  }

  const standbyToRestKm =
    hasStandby && hasRest
      ? haversineDistanceKm(
          input.standbyRiderLat as number,
          input.standbyRiderLng as number,
          input.restaurantLat as number,
          input.restaurantLng as number
        )
      : 0;

  const prepBuffer =
    input.status === 'ready'
      ? 4
      : input.status === 'preparing'
      ? 9
      : input.status === 'accepted'
      ? 12
      : 14;
  const routeBasedEta = Math.max(8, Math.round(prepBuffer + (restToCustomerKm / 22) * 60));
  const reasonableStoredEta =
    input.estimatedMinutes > 0 && input.estimatedMinutes <= 180
      ? input.estimatedMinutes
      : routeBasedEta;
  const etaMinutes = Math.max(6, Math.min(reasonableStoredEta, routeBasedEta + 6));
  const remainingKm = Math.round((standbyToRestKm + restToCustomerKm) * 100) / 100;

  return {
    etaMinutes,
    remainingKm,
    phase: 'awaiting_dispatch',
  };
}

export function buildRestaurantUnavailableMessage(
  restaurantName: string,
  status: string,
  isOpen: boolean,
  lang: 'bn' | 'en' = 'en'
): string {
  const safeName = restaurantName.trim() || (lang === 'bn' ? 'এই রেস্টুরেন্টটি' : 'This restaurant');
  if (status !== 'approved') {
    if (lang === 'bn') {
      return `${safeName} বর্তমানে অ্যাডমিন অনুমোদনের (${status}) অপেক্ষায় আছে, তাই এখন অর্ডার নেওয়া হচ্ছে না।`;
    }
    return `${safeName} is currently "${status}" and awaiting Admin approval before accepting orders.`;
  }
  if (!isOpen) {
    if (lang === 'bn') {
      return `${safeName} বর্তমানে বন্ধ (Closed) রাখা হয়েছে। পার্টনার/অ্যাডমিন ড্যাশবোর্ড থেকে Store Open চালু করুন অথবা অন্য খোলা রেস্টুরেন্ট থেকে অর্ডার করুন।`;
    }
    return `${safeName} is currently closed for orders (Store Open is turned OFF in Partner/Admin Dashboard). Please open another active restaurant or re-open the store.`;
  }
  return lang === 'bn' ? 'রেস্টুরেন্টটি অর্ডার নিতে প্রস্তুত।' : 'Restaurant is open for orders.';
}

export type AiHelpLangPreference = 'auto' | 'bn' | 'en';

export function buildAiHelpSystemInstruction(params: {
  langPreference?: AiHelpLangPreference;
  area?: string;
  viewType?: string;
  activeOrderNumber?: string;
}): string {
  const pref = params.langPreference || 'auto';
  const langRule =
    pref === 'bn'
      ? 'Always respond strictly in clear, natural Bengali (বাংলা script).'
      : pref === 'en'
      ? 'Always respond strictly in clear, helpful English.'
      : 'Detect the user language automatically: if they write in Bangla (বাংলা) or Banglish/Romanized Bengali, respond in clear, helpful Bangla (বাংলা). If they write in English, respond in English.';

  const contextNotes = [
    params.area ? `User selected area: ${params.area}, Bangladesh.` : '',
    params.viewType ? `Current screen: ${params.viewType}.` : '',
    params.activeOrderNumber ? `Active order number: ${params.activeOrderNumber}.` : '',
  ]
    .filter(Boolean)
    .join(' ');

  return [
    'You are the official Foodora BD AI Help Assistant for Bangladesh’s multi-vendor food delivery marketplace.',
    langRule,
    'Keep answers concise, practical, and easy to scan (2-5 short sentences or bullet steps). Never invent order IDs, prices, or live GPS coordinates.',
    'Platform knowledge:',
    '- Ordering: Customers can order directly from the homepage "Order Popular Food Now" dishes or open any restaurant menu, then pay via bKash, Nagad, SSLCommerz, or Cash on Delivery (COD).',
    '- Why "This restaurant is currently unavailable for orders" appears: It means either the restaurant has "Store Open" switched OFF (isOpen = false) in Vendor/Admin Dashboard, or its status is not "approved" yet (e.g. pending/suspended). Re-enabling "Store Open" in Partner/Admin Dashboard or picking an Open restaurant resolves it immediately.',
    '- Nationwide Map & Location: Users can search any city/thana across all 64 districts of Bangladesh, enter a custom area, drag/click the interactive Google Map pin, or press Back / click outside the map modal to return.',
    '- Live Rider Tracking & ETA: Users can click "Track Rider" in the header or look up orders via Checkout Email + Order Number to see live rider GPS coordinates, nearest standby rider, and estimated arrival time (ETA).',
    '- Partner & Rider Portals: Restaurant owners can register, add custom cuisines/categories/areas, and integrate Partner APIs; Riders anywhere in Bangladesh can apply to join and share live GPS locations.',
    contextNotes,
  ]
    .filter(Boolean)
    .join('\n');
}


