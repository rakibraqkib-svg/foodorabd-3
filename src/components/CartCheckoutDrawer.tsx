import React, { useEffect, useState } from 'react';
import {
  AlertCircle,
  Bike,
  CreditCard,
  Mail,
  ShieldCheck,
  ShoppingBag,
  Store,
  Tag,
  Trash2,
  Truck,
  UtensilsCrossed,
  X,
} from 'lucide-react';
import { apiFetch } from '../lib/api';
import {
  buildRestaurantUnavailableMessage,
  calculateCartItemUnitPrice,
  calculateCartSubtotal,
  calculateOrderFinancials,
  type CartItemInput,
  convertBdtToCurrency,
  DEFAULT_PAYMENT_GATEWAYS,
  type DeliveryMode,
  formatBdt,
  formatResolvedMapAddress,
  isGatewaySelectableAtCheckout,
  type PaymentMethod,
  toPublicPaymentGatewayView,
} from '../lib/marketplace-logic';
import { BANGLADESH_AREAS, getBangladeshAreaSelectPresets } from '../lib/i18n';
import { AddressSearchInput, saveRecentAddress } from './AddressSearchInput';
import { DhakaMapPicker } from './DhakaMapPicker';
import { SelectWithCustom } from './SelectWithCustom';
import type { Lang, PublicPaymentGateway, Restaurant } from '../types/marketplace';

interface CartCheckoutDrawerProps {
  open: boolean;
  onClose: () => void;
  cartItems: CartItemInput[];
  restaurant: Restaurant | null;
  lang: Lang;
  mapsApiKey: string;
  paymentGateways?: PublicPaymentGateway[];
  selectedArea: { name: string; lat: number; lng: number; displayName?: string };
  customerName: string;
  customerEmail?: string;
  onUpdateQty: (idx: number, delta: number) => void;
  onRemoveItem: (idx: number) => void;
  onClearCart: () => void;
  onOrderCreated: (
    orderId: number,
    trackingToken?: string,
    meta?: { orderNumber?: string; restaurantName?: string; estimatedMinutes?: number }
  ) => void;
}

const DEFAULT_FOOD_THUMB = '/src/assets/images/food_kacchi_biriyani_1794831373742.jpg';

function CartItemThumbnail({
  src,
  fallbackSrc,
  alt,
  sizeClass = 'w-14 h-14',
}: {
  src?: string;
  fallbackSrc?: string;
  alt: string;
  sizeClass?: string;
}) {
  const primary = (src || '').trim();
  const secondary = (fallbackSrc || '').trim() || DEFAULT_FOOD_THUMB;
  const [activeSrc, setActiveSrc] = useState<string>(primary || secondary);
  const [failed, setFailed] = useState(false);

  useEffect(() => {
    setActiveSrc(primary || secondary);
    setFailed(false);
  }, [primary, secondary]);

  if (!activeSrc || failed) {
    return (
      <div
        className={`${sizeClass} rounded-xl bg-[#FFF0F6] border border-pink-200 text-[#E21B70] flex items-center justify-center shrink-0`}
      >
        <UtensilsCrossed className="w-5 h-5" />
      </div>
    );
  }
  return (
    <img
      src={activeSrc}
      alt={alt}
      referrerPolicy="no-referrer"
      onError={() => {
        if (activeSrc !== secondary && secondary) {
          setActiveSrc(secondary);
        } else if (activeSrc !== DEFAULT_FOOD_THUMB) {
          setActiveSrc(DEFAULT_FOOD_THUMB);
        } else {
          setFailed(true);
        }
      }}
      className={`${sizeClass} rounded-xl object-cover border border-neutral-200 bg-neutral-50 shrink-0`}
    />
  );
}

export function CartCheckoutDrawer({
  open,
  onClose,
  cartItems,
  restaurant,
  lang,
  mapsApiKey,
  paymentGateways,
  selectedArea,
  customerName,
  customerEmail,
  onUpdateQty,
  onRemoveItem,
  onClearCart,
  onOrderCreated,
}: CartCheckoutDrawerProps) {
  const activeGateways = React.useMemo(() => {
    const source =
      paymentGateways && paymentGateways.length > 0
        ? paymentGateways
        : DEFAULT_PAYMENT_GATEWAYS.map((g) => toPublicPaymentGatewayView(g, false));
    const filtered = source.filter(isGatewaySelectableAtCheckout);
    return filtered.length > 0
      ? filtered
      : DEFAULT_PAYMENT_GATEWAYS.map((g) => toPublicPaymentGatewayView(g, false));
  }, [paymentGateways]);

  const [step, setStep] = useState<'cart' | 'checkout'>('cart');
  const [couponInput, setCouponInput] = useState('');
  const [appliedCoupon, setAppliedCoupon] = useState<{
    code: string;
    discountAmount: number;
    freeDelivery: boolean;
  } | null>(null);
  const [couponError, setCouponError] = useState<string | null>(null);

  const [name, setName] = useState(customerName || '');
  const [phone, setPhone] = useState('');
  const [email, setEmail] = useState(customerEmail || '');
  const [area, setArea] = useState(selectedArea.name);
  const [addressLine, setAddressLine] = useState(
    () =>
      formatResolvedMapAddress({
        displayName: selectedArea.displayName,
        areaName: selectedArea.name,
        lat: selectedArea.lat,
        lng: selectedArea.lng,
      }) || `${selectedArea.name}, Bangladesh`
  );
  const [coords, setCoords] = useState({ lat: selectedArea.lat, lng: selectedArea.lng });
  const [instructions, setInstructions] = useState('');
  const [deliveryMode, setDeliveryMode] = useState<DeliveryMode>(restaurant?.deliveryMode || 'platform');
  const [paymentMethod, setPaymentMethod] = useState<PaymentMethod>(() => activeGateways[0]?.code || 'bkash');
  const [quoteFee, setQuoteFee] = useState<number>(restaurant?.deliveryFee ?? 49);
  const [quoteEta, setQuoteEta] = useState<number>(restaurant?.deliveryTimeMin ?? 25);
  const [quoteDistanceKm, setQuoteDistanceKm] = useState<number | null>(null);
  const [quoteWeather, setQuoteWeather] = useState<string>('');
  const [usdRate, setUsdRate] = useState<number>(0.00833);
  const [submitting, setSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState<string | null>(null);

  useEffect(() => {
    if (!activeGateways.some((g) => g.code === paymentMethod)) {
      setPaymentMethod(activeGateways[0]?.code || 'cod');
    }
  }, [activeGateways, paymentMethod]);

  useEffect(() => {
    setArea(selectedArea.name);
    setCoords({ lat: selectedArea.lat, lng: selectedArea.lng });
    const resolved = formatResolvedMapAddress({
      displayName: selectedArea.displayName,
      areaName: selectedArea.name,
      lat: selectedArea.lat,
      lng: selectedArea.lng,
    });
    if (resolved) {
      setAddressLine(resolved);
    }
  }, [selectedArea]);

  useEffect(() => {
    setName(customerName || '');
  }, [customerName]);

  useEffect(() => {
    setEmail(customerEmail || '');
  }, [customerEmail]);

  useEffect(() => {
    if (restaurant) {
      setDeliveryMode(restaurant.deliveryMode || 'platform');
      setQuoteFee(restaurant.deliveryFee ?? 49);
      setQuoteEta(restaurant.deliveryTimeMin ?? 25);
      setAppliedCoupon(null);
      setCouponError(null);
    }
  }, [restaurant?.id]);

  useEffect(() => {
    if (cartItems.length === 0) {
      setStep('cart');
      setAppliedCoupon(null);
      setCouponError(null);
    }
  }, [cartItems.length]);

  useEffect(() => {
    if (!open) return;
    apiFetch<{ rates?: { USD?: number } }>('/api/free/rates')
      .then((res) => {
        if (res.rates?.USD) setUsdRate(res.rates.USD);
      })
      .catch(() => {
        // fallback rate preserved
      });
  }, [open]);

  useEffect(() => {
    if (!restaurant) return;
    apiFetch<{
      quote: {
        fee: number;
        etaMinutes: number;
        distanceKm?: number;
        weatherLabel?: string;
        rainBufferMin?: number;
      };
    }>('/api/delivery/quote', {
      method: 'POST',
      body: JSON.stringify({
        restaurantId: restaurant.id,
        dropoffLat: coords.lat,
        dropoffLng: coords.lng,
        deliveryMode,
      }),
    })
      .then((res) => {
        setQuoteFee(res.quote.fee);
        setQuoteEta(res.quote.etaMinutes);
        setQuoteDistanceKm(typeof res.quote.distanceKm === 'number' ? res.quote.distanceKm : null);
        setQuoteWeather(res.quote.weatherLabel || '');
      })
      .catch(() => {
        setQuoteFee(restaurant.deliveryFee);
      });
  }, [restaurant, coords.lat, coords.lng, deliveryMode]);

  if (!open) return null;

  const subtotal = calculateCartSubtotal(cartItems);
  const effectiveDeliveryFee = appliedCoupon?.freeDelivery ? 0 : quoteFee;
  const financials = calculateOrderFinancials({
    subtotal,
    discountAmount: appliedCoupon?.discountAmount ?? 0,
    deliveryFee: effectiveDeliveryFee,
    serviceFee: 10,
    commissionType: restaurant?.commissionType || 'percentage',
    commissionRate: Number(restaurant?.commissionRate ?? 15),
    fixedCommission: restaurant?.fixedCommission ?? 0,
  });

  const handleApplyCoupon = async () => {
    if (!restaurant || !couponInput.trim()) return;
    setCouponError(null);
    try {
      const res = await apiFetch<{
        valid: boolean;
        discountAmount: number;
        deliveryFeeAfterCoupon: number;
        reason?: string;
        coupon?: { code: string; type: string };
      }>('/api/coupons/validate', {
        method: 'POST',
        body: JSON.stringify({
          code: couponInput.trim(),
          subtotal,
          deliveryFee: quoteFee,
          restaurantId: restaurant.id,
        }),
      });
      if (!res.valid) {
        setCouponError(res.reason || 'Invalid coupon');
        setAppliedCoupon(null);
        return;
      }
      setAppliedCoupon({
        code: res.coupon?.code || couponInput.trim().toUpperCase(),
        discountAmount: res.discountAmount,
        freeDelivery: res.deliveryFeeAfterCoupon === 0 && quoteFee > 0,
      });
    } catch (err: unknown) {
      setCouponError(err instanceof Error ? err.message : 'Coupon check failed');
    }
  };

  const handlePlaceOrder = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!restaurant || cartItems.length === 0) return;
    setSubmitting(true);
    setSubmitError(null);

    try {
      const res = await apiFetch<{
        order: {
          id: number;
          trackingToken?: string;
          orderNumber?: string;
          restaurantName?: string;
          estimatedMinutes?: number;
        };
      }>('/api/orders', {
        method: 'POST',
        body: JSON.stringify({
          restaurantId: restaurant.id,
          customerName: name,
          customerPhone: phone,
          customerEmail: email.trim(),
          deliveryAddress: addressLine,
          deliveryArea: area.trim() || 'Bangladesh',
          deliveryLat: coords.lat,
          deliveryLng: coords.lng,
          deliveryInstructions: instructions,
          deliveryMode,
          paymentMethod,
          couponCode: appliedCoupon?.code || '',
          items: cartItems.map((i) => ({
            foodItemId: i.foodItemId,
            quantity: i.quantity,
            variationName: i.variationName,
            addons: i.addons.map((a) => a.name),
            specialInstructions: i.specialInstructions,
          })),
        }),
      });
      onClearCart();
      setStep('cart');
      onOrderCreated(res.order.id, res.order.trackingToken, {
        orderNumber: res.order.orderNumber,
        restaurantName: res.order.restaurantName || restaurant.name,
        estimatedMinutes: res.order.estimatedMinutes ?? quoteEta,
      });
    } catch (err: unknown) {
      setSubmitError(err instanceof Error ? err.message : 'Order submission failed');
    } finally {
      setSubmitting(false);
    }
  };

  return (
    <div
      onClick={onClose}
      className="fixed inset-0 z-50 flex justify-end bg-black/45"
    >
      <div
        onClick={(e) => e.stopPropagation()}
        className="bg-white w-full max-w-md h-full flex flex-col shadow-2xl"
      >
        <div className="p-4 border-b border-neutral-200 flex items-center justify-between">
          <div className="flex items-center gap-2">
            <ShoppingBag className="w-5 h-5 text-[#E21B70]" />
            <h2 className="font-bold text-[#2E3138] text-base">
              {step === 'cart'
                ? lang === 'bn'
                  ? 'আপনার কার্ট'
                  : 'Your Cart'
                : lang === 'bn'
                ? 'চেকআউট ও পেমেন্ট'
                : 'Checkout & Payment'}
            </h2>
          </div>
          <button
            type="button"
            aria-label="Close cart drawer"
            onClick={onClose}
            className="p-1.5 rounded-lg text-neutral-500 hover:bg-neutral-100"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {cartItems.length === 0 ? (
          <div className="flex-1 flex flex-col items-center justify-center p-8 text-center">
            <ShoppingBag className="w-12 h-12 text-neutral-300 mb-3" />
            <p className="font-semibold text-[#2E3138]">
              {lang === 'bn' ? 'আপনার কার্ট খালি' : 'Your cart is empty'}
            </p>
            <p className="text-xs text-neutral-500 mt-1">
              {lang === 'bn'
                ? 'অর্ডার করতে পছন্দের রেস্টুরেন্ট থেকে খাবার যোগ করুন।'
                : 'Add dishes from any restaurant to begin.'}
            </p>
          </div>
        ) : step === 'cart' ? (
          <>
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              {restaurant && (
                <div className="pb-3 border-b border-neutral-100">
                  <p className="text-xs text-neutral-500">
                    {lang === 'bn' ? 'রেস্টুরেন্ট' : 'Ordering from'}
                  </p>
                  <p className="font-bold text-[#2E3138]">
                    {lang === 'bn' ? restaurant.nameBn : restaurant.name}
                  </p>
                </div>
              )}

              <div className="space-y-3">
                {cartItems.map((item, idx) => {
                  const unit = calculateCartItemUnitPrice(item);
                  return (
                    <div
                      key={`${item.foodItemId}-${idx}`}
                      className="flex items-start justify-between gap-3 p-3 rounded-xl border border-neutral-200"
                    >
                      <CartItemThumbnail
                        src={item.imageUrl}
                        fallbackSrc={restaurant?.coverUrl}
                        alt={lang === 'bn' ? item.nameBn : item.name}
                        sizeClass="w-14 h-14"
                      />
                      <div className="min-w-0 flex-1">
                        <p className="font-semibold text-sm text-[#2E3138] truncate">
                          {lang === 'bn' ? item.nameBn : item.name}
                        </p>
                        {item.variationName && (
                          <p className="text-xs text-neutral-500">{item.variationName}</p>
                        )}
                        {item.addons.length > 0 && (
                          <p className="text-xs text-neutral-500">
                            + {item.addons.map((a) => a.name).join(', ')}
                          </p>
                        )}
                        <p className="text-sm font-bold text-[#E21B70] mt-1 tabular-nums">
                          {formatBdt(unit * item.quantity, lang)}
                        </p>
                      </div>

                      <div className="flex items-center gap-1.5 shrink-0">
                        <button
                          type="button"
                          aria-label={`Decrease quantity of ${item.name}`}
                          onClick={() => onUpdateQty(idx, -1)}
                          className="w-7 h-7 rounded-md border border-neutral-200 text-xs font-bold hover:bg-neutral-100"
                        >
                          −
                        </button>
                        <span className="w-6 text-center text-xs font-semibold tabular-nums">
                          {item.quantity}
                        </span>
                        <button
                          type="button"
                          aria-label={`Increase quantity of ${item.name}`}
                          onClick={() => onUpdateQty(idx, 1)}
                          className="w-7 h-7 rounded-md border border-neutral-200 text-xs font-bold hover:bg-neutral-100"
                        >
                          +
                        </button>
                        <button
                          type="button"
                          aria-label={`Remove ${item.name}`}
                          onClick={() => onRemoveItem(idx)}
                          className="p-1.5 text-neutral-400 hover:text-red-600"
                        >
                          <Trash2 className="w-3.5 h-3.5" />
                        </button>
                      </div>
                    </div>
                  );
                })}
              </div>

              {/* Coupon Input */}
              <div className="pt-2">
                <label className="block text-xs font-semibold text-neutral-700 mb-1.5">
                  {lang === 'bn' ? 'প্রোমো কোড (যেমন: FOODORA50 / FREEDEL)' : 'Promo Coupon (FOODORA50 / FREEDEL)'}
                </label>
                <div className="flex gap-2">
                  <div className="relative flex-1">
                    <Tag className="w-3.5 h-3.5 text-neutral-400 absolute left-3 top-1/2 -translate-y-1/2" />
                    <input
                      type="text"
                      value={couponInput}
                      onChange={(e) => setCouponInput(e.target.value)}
                      placeholder="FOODORA50"
                      className="w-full pl-8 pr-3 py-2 text-sm border border-neutral-200 rounded-lg uppercase focus:outline-none focus:border-[#E21B70]"
                    />
                  </div>
                  <button
                    type="button"
                    onClick={handleApplyCoupon}
                    className="px-4 py-2 rounded-lg bg-[#2E3138] text-white text-xs font-semibold hover:bg-black"
                  >
                    {lang === 'bn' ? 'প্রয়োগ' : 'Apply'}
                  </button>
                </div>
                {couponError && <p className="text-xs text-red-600 mt-1">{couponError}</p>}
                {appliedCoupon && (
                  <p className="text-xs text-emerald-700 font-medium mt-1">
                    Applied {appliedCoupon.code}: −{formatBdt(appliedCoupon.discountAmount, lang)}
                    {appliedCoupon.freeDelivery ? ' + Free Delivery' : ''}
                  </p>
                )}
              </div>
            </div>

            <div className="p-4 border-t border-neutral-200 bg-neutral-50 space-y-2 text-sm tabular-nums">
              <div className="flex justify-between text-neutral-600">
                <span>{lang === 'bn' ? 'সাবটোটাল' : 'Subtotal'}</span>
                <span>{formatBdt(financials.subtotal, lang)}</span>
              </div>
              {financials.discountAmount > 0 && (
                <div className="flex justify-between text-emerald-700 font-medium">
                  <span>{lang === 'bn' ? 'ডিসকাউন্ট' : 'Discount'}</span>
                  <span>−{formatBdt(financials.discountAmount, lang)}</span>
                </div>
              )}
              <div className="flex justify-between text-neutral-600">
                <span>{lang === 'bn' ? 'ডেলিভারি ফি' : 'Delivery Fee'}</span>
                <span>{formatBdt(financials.deliveryFee, lang)}</span>
              </div>
              <div className="flex justify-between text-neutral-600">
                <span>{lang === 'bn' ? 'সার্ভিস চার্জ' : 'Service Fee'}</span>
                <span>{formatBdt(financials.serviceFee, lang)}</span>
              </div>
              <div className="flex justify-between font-bold text-base text-[#2E3138] pt-2 border-t border-neutral-200">
                <span>{lang === 'bn' ? 'সর্বমোট' : 'Total Payable'}</span>
                <div className="text-right">
                  <span className="text-[#E21B70]">{formatBdt(financials.totalPayable, lang)}</span>
                  <p className="text-[11px] font-medium text-neutral-500">
                    ≈ ${convertBdtToCurrency(financials.totalPayable, usdRate).toFixed(2)} USD
                  </p>
                </div>
              </div>

              {restaurant && (restaurant.status !== 'approved' || !restaurant.isOpen) && (
                <div
                  role="alert"
                  className="p-2.5 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2"
                >
                  <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <span>
                    {buildRestaurantUnavailableMessage(
                      restaurant.name,
                      restaurant.status,
                      restaurant.isOpen,
                      lang
                    )}
                  </span>
                </div>
              )}

              {restaurant && subtotal < restaurant.minOrder && (
                <p className="text-xs text-amber-700 font-medium">
                  {lang === 'bn'
                    ? `ন্যূনতম অর্ডার ${formatBdt(restaurant.minOrder, lang)}`
                    : `Minimum order is ${formatBdt(restaurant.minOrder, lang)}`}
                </p>
              )}

              <button
                type="button"
                disabled={Boolean(
                  restaurant &&
                    (subtotal < restaurant.minOrder ||
                      restaurant.status !== 'approved' ||
                      !restaurant.isOpen)
                )}
                onClick={() => setStep('checkout')}
                className="w-full py-3 rounded-xl bg-[#E21B70] hover:bg-[#C4135E] text-white font-semibold text-sm disabled:opacity-50 transition-colors mt-2"
              >
                {lang === 'bn' ? 'চেকআউট করুন' : 'Continue to Checkout'}
              </button>
            </div>
          </>
        ) : (
          <form onSubmit={handlePlaceOrder} className="flex-1 flex flex-col overflow-hidden">
            <div className="flex-1 overflow-y-auto p-4 space-y-4">
              <button
                type="button"
                onClick={() => setStep('cart')}
                className="text-xs font-semibold text-[#E21B70] hover:underline"
              >
                ← {lang === 'bn' ? 'কার্টে ফিরুন' : 'Back to Cart'}
              </button>

              {/* Ordered Products Summary with Thumbnails */}
              <div
                data-testid="checkout-items-summary"
                className="rounded-xl border border-neutral-200 bg-neutral-50/80 p-3 space-y-2.5"
              >
                <div className="flex items-center justify-between text-xs font-bold text-[#2E3138]">
                  <span>
                    {lang === 'bn'
                      ? `অর্ডার আইটেম (${cartItems.reduce((s, i) => s + i.quantity, 0)})`
                      : `Your Order Items (${cartItems.reduce((s, i) => s + i.quantity, 0)})`}
                  </span>
                  {restaurant && (
                    <span className="text-[11px] font-semibold text-neutral-500 truncate max-w-[180px]">
                      {lang === 'bn' ? restaurant.nameBn : restaurant.name}
                    </span>
                  )}
                </div>
                <div className="space-y-2 max-h-44 overflow-y-auto pr-0.5">
                  {cartItems.map((item, idx) => {
                    const unit = calculateCartItemUnitPrice(item);
                    const itemTitle = lang === 'bn' ? item.nameBn : item.name;
                    return (
                      <div
                        key={`checkout-item-${item.foodItemId}-${idx}`}
                        className="flex items-center gap-2.5 bg-white p-2 rounded-lg border border-neutral-200/80"
                      >
                        <CartItemThumbnail
                          src={item.imageUrl}
                          fallbackSrc={restaurant?.coverUrl}
                          alt={itemTitle}
                          sizeClass="w-11 h-11"
                        />
                        <div className="min-w-0 flex-1">
                          <p className="text-xs font-semibold text-[#2E3138] truncate">
                            <span className="text-[#E21B70] font-bold mr-1">{item.quantity}x</span>
                            {itemTitle}
                          </p>
                          {(item.variationName || item.addons.length > 0) && (
                            <p className="text-[11px] text-neutral-500 truncate">
                              {[
                                item.variationName,
                                item.addons.length > 0
                                  ? `+ ${item.addons.map((a) => a.name).join(', ')}`
                                  : '',
                              ]
                                .filter(Boolean)
                                .join(' · ')}
                            </p>
                          )}
                        </div>
                        <span className="text-xs font-bold text-[#2E3138] tabular-nums shrink-0">
                          {formatBdt(unit * item.quantity, lang)}
                        </span>
                      </div>
                    );
                  })}
                </div>
              </div>

              {restaurant && (restaurant.status !== 'approved' || !restaurant.isOpen) && (
                <div
                  role="alert"
                  className="p-3 rounded-lg bg-amber-50 border border-amber-200 text-xs text-amber-900 flex items-start gap-2"
                >
                  <AlertCircle className="w-4 h-4 text-amber-600 shrink-0 mt-0.5" />
                  <span>
                    {buildRestaurantUnavailableMessage(
                      restaurant.name,
                      restaurant.status,
                      restaurant.isOpen,
                      lang
                    )}
                  </span>
                </div>
              )}

              <div className="grid grid-cols-2 gap-3">
                <div>
                  <label className="block text-xs font-semibold text-neutral-700 mb-1">
                    {lang === 'bn' ? 'নাম' : 'Full Name'}
                  </label>
                  <input
                    required
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={lang === 'bn' ? 'আপনার নাম লিখুন' : 'e.g. Tanvir Hasan'}
                    className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg"
                  />
                </div>
                <div>
                  <label className="block text-xs font-semibold text-neutral-700 mb-1">
                    {lang === 'bn' ? 'ফোন নম্বর' : 'Phone'}
                  </label>
                  <input
                    required
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                    placeholder="+8801XXXXXXXXX"
                    className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg"
                  />
                </div>
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  <span className="inline-flex items-center gap-1">
                    <Mail className="w-3.5 h-3.5 text-[#E21B70]" />
                    {lang === 'bn'
                      ? 'ইমেইল ঠিকানা (অর্ডারের প্রতিটি আপডেট ও ট্র্যাকিং লিংক ইমেইলে পাবেন)'
                      : 'Email Address (Live order & rider updates sent here)'}
                  </span>
                </label>
                <input
                  required
                  type="email"
                  value={email}
                  onChange={(e) => setEmail(e.target.value)}
                  placeholder="you@example.com"
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg"
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'বাংলাদেশের ডেলিভারি শহর / এলাকা' : 'Delivery City / Area (All Bangladesh)'}
                </label>
                <SelectWithCustom
                  required
                  lang={lang}
                  value={area}
                  onChange={setArea}
                  storageKey="bd_areas"
                  ariaLabel="Checkout delivery city or area"
                  placeholder={
                    lang === 'bn'
                      ? 'আপনার এলাকা বা জেলার নাম লিখুন (যেমন: বগুড়া সদর)'
                      : 'Enter your area, thana or district (e.g. Rampura, Dhaka)'
                  }
                  customOptionLabel={
                    lang === 'bn'
                      ? '+ কাস্টম এলাকা / উপজেলা যোগ করুন...'
                      : '+ Add Custom Area in Bangladesh...'
                  }
                  presets={getBangladeshAreaSelectPresets(lang)}
                  onSelectPreset={(val) => {
                    const found = BANGLADESH_AREAS.find((a) => a.name === val);
                    if (found) {
                      setCoords({ lat: found.lat, lng: found.lng });
                      const formatted = formatResolvedMapAddress({
                        areaName: found.name,
                        lat: found.lat,
                        lng: found.lng,
                      });
                      if (formatted) setAddressLine(formatted);
                    }
                  }}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'দ্রুত ঠিকানা খুঁজুন (রোড, বাসা বা এলাকা)' : 'Find & Auto-Pin Address'}
                </label>
                <AddressSearchInput
                  compact
                  lang={lang}
                  showGpsButton={false}
                  currentCoords={coords}
                  onSelectAddress={(picked) => {
                    setCoords({ lat: picked.lat, lng: picked.lng });
                    setArea(picked.shortName);
                    const formatted =
                      formatResolvedMapAddress({
                        displayName: picked.displayName,
                        areaName: picked.shortName,
                        lat: picked.lat,
                        lng: picked.lng,
                      }) || picked.displayName;
                    if (formatted) {
                      setAddressLine(formatted);
                    }
                    saveRecentAddress(picked);
                  }}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'বিস্তারিত ঠিকানা' : 'Street Address'}
                </label>
                <input
                  required
                  value={addressLine}
                  onChange={(e) => setAddressLine(e.target.value)}
                  placeholder={
                    lang === 'bn'
                      ? 'বাসা/ফ্ল্যাট নং, রোড, ব্লক (যেমন: বাসা ১৪, রোড ১১, বনানী)'
                      : 'House / Flat no, Road, Block (e.g. House 14, Road 11, Banani)'
                  }
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg"
                />
              </div>

              <div>
                <p className="text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'ম্যাপ পিন নির্ধারণ করুন' : 'Pin Delivery Location'}
                </p>
                <DhakaMapPicker
                  mapsApiKey={mapsApiKey}
                  lang={lang}
                  center={coords}
                  markerLabel={area || 'Delivery Pin'}
                  pinType="user"
                  userName={name || customerName}
                  secondaryPoint={
                    restaurant ? { lat: restaurant.lat, lng: restaurant.lng, label: restaurant.name } : undefined
                  }
                  interactive
                  heightClass="h-[180px]"
                  onSelectLocation={(c) => {
                    setCoords({ lat: c.lat, lng: c.lng });
                    if (c.areaName) {
                      setArea(c.areaName);
                    }
                    const formatted = formatResolvedMapAddress({
                      displayName: c.displayName,
                      areaName: c.areaName,
                      lat: c.lat,
                      lng: c.lng,
                    });
                    if (formatted) {
                      setAddressLine(formatted);
                    }
                  }}
                />
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1.5">
                  {lang === 'bn' ? 'ডেলিভারি সিস্টেম' : 'Delivery Provider'}
                </label>
                <div className="grid grid-cols-3 gap-2">
                  {[
                    { id: 'platform' as const, label: 'Foodora Rider', icon: Bike },
                    { id: 'third_party' as const, label: 'Pathao Courier', icon: Truck },
                    { id: 'restaurant' as const, label: 'Restaurant', icon: Store },
                  ].map((opt) => {
                    const Icon = opt.icon;
                    return (
                      <button
                        key={opt.id}
                        type="button"
                        onClick={() => setDeliveryMode(opt.id)}
                        className={`p-2.5 rounded-xl border text-center text-xs font-semibold flex flex-col items-center gap-1 ${
                          deliveryMode === opt.id
                            ? 'border-[#E21B70] bg-[#FFF0F6] text-[#E21B70]'
                            : 'border-neutral-200 text-neutral-700'
                        }`}
                      >
                        <Icon className="w-4 h-4" />
                        <span>{opt.label}</span>
                      </button>
                    );
                  })}
                </div>
                <p className="text-[11px] text-neutral-500 mt-1.5 tabular-nums">
                  {lang === 'bn' ? 'আনুমানিক সময়:' : 'Estimated arrival:'} ~{quoteEta} mins
                  {quoteDistanceKm !== null ? ` · ${quoteDistanceKm.toFixed(1)} km road route` : ''}
                  {quoteWeather ? ` · ${quoteWeather}` : ''} · {formatBdt(effectiveDeliveryFee, lang)}
                </p>
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1.5">
                  {lang === 'bn' ? 'পেমেন্ট পদ্ধতি' : 'Payment Method'}
                </label>
                <div className="grid grid-cols-2 gap-2">
                  {activeGateways.map((pm) => {
                    const selected = paymentMethod === pm.code;
                    return (
                      <button
                        key={pm.code}
                        type="button"
                        onClick={() => setPaymentMethod(pm.code)}
                        className={`px-3 py-2.5 rounded-xl border text-xs font-semibold flex items-center justify-between gap-1.5 text-left ${
                          selected
                            ? 'border-[#E21B70] bg-[#FFF0F6] text-[#E21B70]'
                            : 'border-neutral-200 text-neutral-700 hover:border-neutral-300'
                        }`}
                      >
                        <span className="inline-flex items-center gap-1.5 min-w-0">
                          <CreditCard className="w-3.5 h-3.5 shrink-0" />
                          <span className="truncate">{lang === 'bn' ? pm.nameBn : pm.name}</span>
                        </span>
                        {pm.code !== 'cod' && (
                          <span
                            className={`text-[9px] uppercase font-bold px-1.5 py-0.5 rounded shrink-0 ${
                              pm.mode === 'live' && pm.isConfigured
                                ? 'bg-emerald-50 text-emerald-700'
                                : 'bg-neutral-100 text-neutral-500'
                            }`}
                          >
                            {pm.mode === 'live' && pm.isConfigured ? 'Live' : 'Test'}
                          </span>
                        )}
                      </button>
                    );
                  })}
                </div>
                {(() => {
                  const chosen = activeGateways.find((g) => g.code === paymentMethod);
                  return chosen?.instructions ? (
                    <p className="text-[11px] text-neutral-500 mt-1.5">{chosen.instructions}</p>
                  ) : null;
                })()}
              </div>

              <div>
                <label className="block text-xs font-semibold text-neutral-700 mb-1">
                  {lang === 'bn' ? 'ডেলিভারি নির্দেশনা' : 'Delivery Instructions'}
                </label>
                <input
                  value={instructions}
                  onChange={(e) => setInstructions(e.target.value)}
                  placeholder={lang === 'bn' ? 'গেটে পৌঁছে কল দেবেন...' : 'Ring bell / Call at main gate'}
                  className="w-full px-3 py-2 text-sm border border-neutral-200 rounded-lg"
                />
              </div>

              {submitError && (
                <div className="p-3 rounded-lg bg-red-50 border border-red-200 text-xs text-red-700">
                  {submitError}
                </div>
              )}
            </div>

            <div className="p-4 border-t border-neutral-200 bg-white">
              <div className="flex items-center justify-between text-xs text-neutral-500 mb-2">
                <span className="inline-flex items-center gap-1">
                  <ShieldCheck className="w-3.5 h-3.5 text-emerald-600" />
                  {lang === 'bn' ? 'সার্ভার-যাচাইকৃত নিরাপদ পেমেন্ট' : 'Server-verified checkout'}
                </span>
                <div className="text-right tabular-nums">
                  <span className="font-bold text-sm text-[#2E3138]">
                    {formatBdt(financials.totalPayable, lang)}
                  </span>
                  <span className="ml-1.5 text-[11px] text-neutral-400">
                    (${convertBdtToCurrency(financials.totalPayable, usdRate).toFixed(2)})
                  </span>
                </div>
              </div>
              <button
                type="submit"
                disabled={
                  submitting ||
                  Boolean(
                    restaurant && (restaurant.status !== 'approved' || !restaurant.isOpen)
                  )
                }
                className="w-full py-3 rounded-xl bg-[#E21B70] hover:bg-[#C4135E] text-white font-semibold text-sm disabled:opacity-50 transition-colors"
              >
                {submitting
                  ? lang === 'bn'
                    ? 'অর্ডার প্রসেস হচ্ছে...'
                    : 'Placing Order...'
                  : lang === 'bn'
                  ? 'অর্ডার নিশ্চিত করুন'
                  : 'Place Order Now'}
              </button>
            </div>
          </form>
        )}
      </div>
    </div>
  );
}
