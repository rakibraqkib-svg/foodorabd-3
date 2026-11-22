import test from 'node:test';
import assert from 'node:assert/strict';
import {
  buildVendorAnalytics,
  calculateCartItemUnitPrice,
  calculateCartSubtotal,
  calculateLiveRiderEta,
  calculateOrderFinancials,
  canActorModifyUserAccount,
  canAddToSingleRestaurantCart,
  canTransitionOrderStatus,
  convertBdtToCurrency,
  estimateDeliveryFeeAndEta,
  evaluateCoupon,
  formatBdt,
  haversineDistanceKm,
  isProtectedSuperAdminEmail,
  mapOpenMeteoWeather,
  advanceRiderAlongRoute,
  validateBroadcastNotification,
  isProductVisibleToCustomers,
  filterStorefrontProducts,
  normalizePartnerProductInput,
  normalizeGatewayCode,
  maskSecretValue,
  toAdminPaymentGatewayView,
  toPublicPaymentGatewayView,
  partitionOwnedVsPartnerRestaurants,
  buildRobotsTxt,
  buildSitemapXml,
  isWithinBangladesh,
  resolveNearestAreaFromList,
  buildOrderTrackingUrl,
  doesEmailMatchOrder,
  buildOrderTrackingEmailPayload,
  normalizeCustomOptionValue,
  mergeCustomSelectOptions,
  pickNearestStandbyRider,
  computeOrderEtaSummary,
  buildRestaurantUnavailableMessage,
  buildAiHelpSystemInstruction,
  parseOrderSoundPreference,
  getOrderAlertChimeNotes,
  isSandboxAuthToken,
  shouldPersistAuthToken,
  shouldRestoreTrackedOrderShortcut,
  formatResolvedMapAddress,
  shouldPlayDedupedOrderChime,
  collectMerchantOrderAlertRecipients,
  buildMerchantOrderAlertEmailPayload,
  detectOrderBatchChanges,
  isGooglePlusCodeSegment,
  isAdministrativeNoiseSegment,
  cleanMapAddressSegments,
  matchCanonicalAreaFromHints,
  extractCleanGoogleGeocodeAddress,
} from './marketplace-logic';
import { DEFAULT_STOREFRONT_CONFIG, mergeStorefrontConfig } from './storefront-config';
import { BANGLADESH_AREAS, DHAKA_DELIVERY_ZONES } from './i18n';

test('cart unit price and subtotal include discount price, variation delta, and add-ons', () => {
  const item = {
    foodItemId: 1,
    restaurantId: 10,
    name: 'Mutton Kacchi',
    nameBn: 'মাটন কাচ্চি',
    imageUrl: '/img.jpg',
    basePrice: 450,
    discountPrice: 400,
    variationName: 'Full',
    variationDelta: 150,
    addons: [
      { name: 'Borhani', price: 60 },
      { name: 'Jali Kabab', price: 80 },
    ],
    quantity: 2,
  };

  // (400 + 150 + 60 + 80) = 690 per unit; * 2 = 1380
  assert.equal(calculateCartItemUnitPrice(item), 690);
  assert.equal(calculateCartSubtotal([item]), 1380);
});

test('single-restaurant cart constraint blocks mixing different restaurants', () => {
  assert.equal(canAddToSingleRestaurantCart([], 5), true);
  assert.equal(canAddToSingleRestaurantCart([{ restaurantId: 5 }], 5), true);
  assert.equal(canAddToSingleRestaurantCart([{ restaurantId: 5 }], 9), false);
});

test('coupon evaluation handles percentage cap, minimum order, and free delivery', () => {
  const pctCoupon = {
    code: 'FOODORA50',
    type: 'percentage' as const,
    value: 50,
    minOrder: 300,
    maxDiscount: 150,
    restaurantId: null,
    isActive: true,
    usedCount: 10,
    usageLimit: 100,
  };

  const underMin = evaluateCoupon(pctCoupon, 250, 49, 1);
  assert.equal(underMin.valid, false);
  assert.equal(underMin.discountAmount, 0);

  const validOrder = evaluateCoupon(pctCoupon, 600, 49, 1);
  assert.equal(validOrder.valid, true);
  assert.equal(validOrder.discountAmount, 150); // capped at maxDiscount 150
  assert.equal(validOrder.deliveryFeeAfterCoupon, 49);

  const freeDel = evaluateCoupon(
    { ...pctCoupon, code: 'FREEDEL', type: 'free_delivery', value: 0, minOrder: 200 },
    400,
    59,
    1
  );
  assert.equal(freeDel.valid, true);
  assert.equal(freeDel.deliveryFeeAfterCoupon, 0);
});

test('order financial commission calculation isolates food revenue from delivery and service fees', () => {
  // User prompt example: Food subtotal ৳1,000, 15% commission = ৳150, Restaurant = ৳850, Delivery = ৳60, Service = ৳10, Total = ৳1,070
  const result = calculateOrderFinancials({
    subtotal: 1000,
    discountAmount: 0,
    deliveryFee: 60,
    serviceFee: 10,
    commissionType: 'percentage',
    commissionRate: 15,
    fixedCommission: 0,
  });

  assert.equal(result.netFoodRevenue, 1000);
  assert.equal(result.platformCommission, 150);
  assert.equal(result.restaurantEarnings, 850);
  assert.equal(result.totalPayable, 1070);

  // Fixed commission mode
  const fixedResult = calculateOrderFinancials({
    subtotal: 500,
    discountAmount: 50,
    deliveryFee: 45,
    serviceFee: 10,
    commissionType: 'fixed',
    commissionRate: 15,
    fixedCommission: 60,
  });
  assert.equal(fixedResult.netFoodRevenue, 450);
  assert.equal(fixedResult.platformCommission, 60);
  assert.equal(fixedResult.restaurantEarnings, 390);
  assert.equal(fixedResult.totalPayable, 505);
});

test('order status transition state machine prevents illegal jumps', () => {
  assert.equal(canTransitionOrderStatus('confirmed', 'accepted'), true);
  assert.equal(canTransitionOrderStatus('preparing', 'ready'), true);
  assert.equal(canTransitionOrderStatus('delivered', 'cancelled'), false);
  assert.equal(canTransitionOrderStatus('cancelled', 'preparing'), false);
});

test('haversine distance and delivery fee ETA work for Dhaka coordinates', () => {
  // Gulshan 2 to Banani (~1.5 km)
  const km = haversineDistanceKm(23.7949, 90.4144, 23.7937, 90.4066);
  assert.ok(km > 0.5 && km < 2.5);
  const quote = estimateDeliveryFeeAndEta(km, 49, 'platform');
  assert.equal(quote.fee, 49);
  assert.ok(quote.etaMinutes >= 15);
  assert.equal(formatBdt(1070, 'bn'), '৳১,০৭০');
  assert.equal(formatBdt(1070, 'en'), '৳1,070');
});

test('weather mapping and BDT currency conversion behave deterministically', () => {
  const clear = mapOpenMeteoWeather(0, 0);
  assert.equal(clear.isRaining, false);
  assert.equal(clear.rainBufferMin, 0);

  const rainy = mapOpenMeteoWeather(63, 1.4);
  assert.equal(rainy.isRaining, true);
  assert.equal(rainy.rainBufferMin, 7);

  const storm = mapOpenMeteoWeather(95, 4.0);
  assert.equal(storm.isRaining, true);
  assert.equal(storm.rainBufferMin, 12);

  assert.equal(convertBdtToCurrency(1200, 0.00833), 10);
  assert.equal(convertBdtToCurrency(-10, 0.0083), 0);
});

test('vendor analytics aggregates daily/monthly order trends, revenue, and top-selling items', () => {
  const summary = buildVendorAnalytics(
    [
      {
        id: 1,
        status: 'delivered',
        subtotal: 900,
        discountAmount: 100,
        totalAmount: 859,
        restaurantEarnings: 680,
        createdAt: '2026-10-10T12:00:00Z',
        itemsSnapshotJson: [
          { foodItemId: 101, name: 'Kacchi Biryani', nameBn: 'কাচ্চি বিরিয়ানি', quantity: 2, unitPrice: 450, lineTotal: 900 },
        ],
      },
      {
        id: 2,
        status: 'preparing',
        subtotal: 500,
        discountAmount: 0,
        totalAmount: 559,
        restaurantEarnings: 425,
        createdAt: '2026-11-16T14:00:00Z',
        itemsSnapshotJson: [
          { foodItemId: 101, name: 'Kacchi Biryani', nameBn: 'কাচ্চি বিরিয়ানি', quantity: 1, unitPrice: 450, lineTotal: 450 },
          { foodItemId: 102, name: 'Borhani', nameBn: 'বোরহানি', quantity: 1, unitPrice: 50, lineTotal: 50 },
        ],
      },
      {
        id: 3,
        status: 'cancelled',
        subtotal: 700,
        discountAmount: 0,
        totalAmount: 750,
        restaurantEarnings: 595,
        createdAt: '2026-11-16T15:00:00Z',
        itemsSnapshotJson: [
          { foodItemId: 102, name: 'Borhani', nameBn: 'বোরহানি', quantity: 10, unitPrice: 70, lineTotal: 700 },
        ],
      },
    ],
    [],
    [
      { id: 101, name: 'Kacchi Biryani', nameBn: 'কাচ্চি বিরিয়ানি', category: 'Biryani' },
      { id: 102, name: 'Borhani', nameBn: 'বোরহানি', category: 'Drinks' },
    ]
  );

  assert.equal(summary.totalOrders, 2);
  assert.equal(summary.deliveredOrders, 1);
  assert.equal(summary.grossRevenue, 1300);
  assert.equal(summary.netVendorRevenue, 1105);
  assert.equal(summary.avgOrderValue, 650);
  assert.equal(summary.dailySeries.length, 2);
  assert.equal(summary.monthlySeries.length, 2);
  assert.equal(summary.topSellingItems[0].foodItemId, 101);
  assert.equal(summary.topSellingItems[0].quantitySold, 3);
  assert.equal(summary.topSellingItems[0].category, 'Biryani');
  assert.equal(summary.topSellingItems[1].quantitySold, 1);
});

test('mergeStorefrontConfig preserves defaults and applies partial admin overrides safely', () => {
  const baseline = mergeStorefrontConfig(null);
  assert.deepEqual(baseline, DEFAULT_STOREFRONT_CONFIG);

  const custom = mergeStorefrontConfig({
    announcementBarEnabled: true,
    showHero: false,
    accentColor: '#0F766E',
    heroTitleEn: 'Eid Special Dhaka Delivery',
    brandPrefix: '   ', // blank strings fall back to default safely
  });

  assert.equal(custom.announcementBarEnabled, true);
  assert.equal(custom.showHero, false);
  assert.equal(custom.accentColor, '#0F766E');
  assert.equal(custom.heroTitleEn, 'Eid Special Dhaka Delivery');
  assert.equal(custom.brandPrefix, DEFAULT_STOREFRONT_CONFIG.brandPrefix);
  assert.equal(custom.showDailyDeals, true);
});

test('calculateLiveRiderEta and advanceRiderAlongRoute track rider movement accurately', () => {
  // From Banani (23.7937, 90.4066) toward Gulshan 2 (23.7949, 90.4144)
  const initialEta = calculateLiveRiderEta(23.7937, 90.4066, 23.7949, 90.4144, 'on_the_way', 22);
  assert.ok(initialEta.remainingKm > 0.5 && initialEta.remainingKm < 1.5);
  assert.ok(initialEta.etaMinutes >= 2);
  assert.equal(initialEta.arrived, false);

  const stepped = advanceRiderAlongRoute(23.7937, 90.4066, 23.7949, 90.4144, 0.5);
  const nextEta = calculateLiveRiderEta(stepped.lat, stepped.lng, 23.7949, 90.4144, 'on_the_way', 22);
  assert.ok(nextEta.remainingKm < initialEta.remainingKm);

  const deliveredEta = calculateLiveRiderEta(23.7937, 90.4066, 23.7949, 90.4144, 'delivered');
  assert.equal(deliveredEta.remainingKm, 0);
  assert.equal(deliveredEta.etaMinutes, 0);
  assert.equal(deliveredEta.arrived, true);

  const snapped = advanceRiderAlongRoute(23.79485, 90.41435, 23.7949, 90.4144, 0.35);
  assert.equal(snapped.lat, 23.7949);
  assert.equal(snapped.lng, 90.4144);
});

test('canActorModifyUserAccount enforces super admin governance and protects primary owner', () => {
  // Customer/rider/vendor cannot modify roles
  const nonAdmin = canActorModifyUserAccount({
    actorUid: 'u1',
    actorRole: 'customer',
    targetUid: 'u2',
    targetEmail: 'other@foodora.bd',
    currentRole: 'customer',
    nextRole: 'super_admin',
    nextStatus: 'active',
  });
  assert.equal(nonAdmin.allowed, false);

  // Regular admin cannot grant super_admin or touch existing super_admin
  const regularAdminPromote = canActorModifyUserAccount({
    actorUid: 'a1',
    actorRole: 'admin',
    targetUid: 'u2',
    targetEmail: 'other@foodora.bd',
    currentRole: 'customer',
    nextRole: 'super_admin',
    nextStatus: 'active',
  });
  assert.equal(regularAdminPromote.allowed, false);

  // Primary super admin rakibraqkib@gmail.com cannot be demoted or suspended even by another super_admin
  const demotePrimary = canActorModifyUserAccount({
    actorUid: 'demo-admin-uid',
    actorRole: 'super_admin',
    targetUid: 'owner-uid',
    targetEmail: 'rakibraqkib@gmail.com',
    currentRole: 'super_admin',
    nextRole: 'customer',
    nextStatus: 'active',
  });
  assert.equal(demotePrimary.allowed, false);

  // Secondary super admin raqkibrony@gmail.com is also protected from demotion or suspension
  assert.equal(isProtectedSuperAdminEmail('RAQKIBRONY@gmail.com '), true);
  assert.equal(isProtectedSuperAdminEmail('customer@foodora.bd'), false);
  const demoteAdminPinOwner = canActorModifyUserAccount({
    actorUid: 'demo-admin-uid',
    actorRole: 'super_admin',
    targetUid: 'owner-2-uid',
    targetEmail: 'raqkibrony@gmail.com',
    currentRole: 'super_admin',
    nextRole: 'customer',
    nextStatus: 'suspended',
  });
  assert.equal(demoteAdminPinOwner.allowed, false);

  // Super admin can promote/demote other admin accounts
  const superAdminAssign = canActorModifyUserAccount({
    actorUid: 'owner-uid',
    actorRole: 'super_admin',
    targetUid: 'u2',
    targetEmail: 'ops@foodora.bd',
    currentRole: 'customer',
    nextRole: 'admin',
    nextStatus: 'active',
  });
  assert.equal(superAdminAssign.allowed, true);
});

test('validateBroadcastNotification enforces title/message lengths and allowed target roles', () => {
  const badRole = validateBroadcastNotification({
    targetRole: 'invalid_role',
    title: 'System Notice',
    message: 'Scheduled maintenance complete.',
  });
  assert.equal(badRole.valid, false);

  const shortMsg = validateBroadcastNotification({
    targetRole: 'all',
    title: 'Hi',
    message: 'Ok',
  });
  assert.equal(shortMsg.valid, false);

  const valid = validateBroadcastNotification({
    targetRole: 'rider',
    title: '  Eid Bonus Active  ',
    message: '  Earn extra ৳30 per delivery in Gulshan & Banani tonight.  ',
    type: 'promo',
  });
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.targetRole, 'rider');
    assert.equal(valid.title, 'Eid Bonus Active');
    assert.equal(valid.type, 'promo');
  }
});

test('filterStorefrontProducts hides admin-hidden items and prioritizes featured in-stock items', () => {
  const sample = [
    {
      id: 1,
      name: 'Hidden Burger',
      nameBn: 'হিডেন বার্গার',
      category: 'Burger',
      price: 300,
      discountPrice: null,
      inStock: true,
      isAvailable: true,
      isPopular: true,
      isVisibleOnStorefront: false,
      restaurantName: 'Chillox',
      restaurantCuisine: 'Burger',
      deliveryMode: 'platform',
    },
    {
      id: 2,
      name: 'Classic Kacchi',
      nameBn: 'ক্লাসিক কাচ্চি',
      category: 'Biriyani',
      price: 450,
      discountPrice: 390,
      inStock: true,
      isAvailable: true,
      isPopular: true,
      isVisibleOnStorefront: true,
      restaurantName: "Sultan's Dine",
      restaurantCuisine: 'Biriyani',
      deliveryMode: 'platform',
    },
    {
      id: 3,
      name: 'Beef Tehari',
      nameBn: 'বিফ তেহারি',
      category: 'Biriyani',
      price: 250,
      discountPrice: null,
      inStock: true,
      isAvailable: true,
      isPopular: false,
      isVisibleOnStorefront: true,
      restaurantName: 'Tehari Ghar',
      restaurantCuisine: 'Biriyani',
      deliveryMode: 'third_party',
    },
  ];

  assert.equal(isProductVisibleToCustomers(sample[0]), false);
  assert.equal(isProductVisibleToCustomers(sample[1]), true);

  const visibleAll = filterStorefrontProducts(sample);
  assert.equal(visibleAll.length, 2);
  assert.equal(visibleAll[0].id, 2);

  const onlyDiscounts = filterStorefrontProducts(sample, { onlyDiscount: true });
  assert.equal(onlyDiscounts.length, 1);
  assert.equal(onlyDiscounts[0].id, 2);

  const thirdPartyOnly = filterStorefrontProducts(sample, { deliveryFleet: 'third_party' });
  assert.equal(thirdPartyOnly.length, 1);
  assert.equal(thirdPartyOnly[0].id, 3);
});

test('normalizePartnerProductInput validates and applies safe defaults for external partner API', () => {
  const invalidPrice = normalizePartnerProductInput({ name: 'Burger', price: 0 }, '/fallback.jpg');
  assert.equal(invalidPrice.valid, false);

  const badDiscount = normalizePartnerProductInput(
    { name: 'Burger', price: 300, discountPrice: 350 },
    '/fallback.jpg'
  );
  assert.equal(badDiscount.valid, false);

  const ok = normalizePartnerProductInput(
    {
      name: 'Smoky Naga Burger',
      category: 'Burger',
      price: 340,
      discountPrice: 290,
      addons: [{ name: 'Extra Cheese', price: 45 }],
    },
    '/fallback.jpg'
  );
  assert.equal(ok.valid, true);
  if (ok.valid) {
    assert.equal(ok.product.nameBn, 'Smoky Naga Burger');
    assert.equal(ok.product.imageUrl, '/fallback.jpg');
    assert.equal(ok.product.variationsJson[0].name, 'Regular');
    assert.equal(ok.product.addonsJson[0].price, 45);
  }
});

test('payment gateway normalization, secret masking, and public/admin view sanitization', () => {
  assert.equal(normalizeGatewayCode('  Rocket MFS! '), 'rocket_mfs');
  assert.equal(maskSecretValue(''), '');
  assert.equal(maskSecretValue('abc'), '••••');
  assert.equal(maskSecretValue('live_secret_9981'), '••••9981');

  const row = {
    code: 'rocket',
    name: 'DBBL Rocket',
    nameBn: 'রকেট',
    providerType: 'mfs',
    mode: 'live',
    isActive: true,
    apiBaseUrl: 'https://api.rocket.example/v1',
    merchantId: 'MRC-101',
    apiKey: 'key_abcdef1234',
    apiSecret: 'sec_super_secret_9876',
    webhookSecret: 'wh_token_5544',
    instructions: 'Enter PIN in Rocket popup',
    sortOrder: 5,
  };

  const pubView = toPublicPaymentGatewayView(row);
  assert.equal('apiKey' in pubView, false);
  assert.equal('apiSecret' in pubView, false);
  assert.equal('webhookSecret' in pubView, false);
  assert.equal(pubView.isConfigured, true);

  const adminView = toAdminPaymentGatewayView(row, 'https://foodorabd.example/');
  assert.equal(adminView.hasApiKey, true);
  assert.equal(adminView.apiKeyPreview, '••••1234');
  assert.equal(adminView.apiSecretPreview, '••••9876');
  assert.equal(adminView.webhookUrl, 'https://foodorabd.example/api/payments/webhook/rocket');
  assert.equal('apiKey' in adminView, false);
  assert.equal('apiSecret' in adminView, false);
});

test('partitionOwnedVsPartnerRestaurants separates owner stores from partners and prioritizes own stores', () => {
  const list = [
    { id: 1, ownerUid: 'partner-uid-1', name: 'Partner Kitchen' },
    { id: 2, ownerUid: 'owner-uid', name: 'My Own Cafe' },
    { id: 3, ownerUid: 'partner-uid-2', name: 'Partner Pizza' },
  ];
  const partitioned = partitionOwnedVsPartnerRestaurants(list, 'owner-uid');
  assert.equal(partitioned.own.length, 1);
  assert.equal(partitioned.own[0].id, 2);
  assert.equal(partitioned.partners.length, 2);
  assert.equal(partitioned.ordered[0].id, 2);
});

test('buildRobotsTxt and buildSitemapXml emit valid SEO crawl files with escaped slugs', () => {
  const robots = buildRobotsTxt('https://foodora.example/');
  assert.ok(robots.includes('User-agent: *'));
  assert.ok(robots.includes('Disallow: /api/admin/'));
  assert.ok(robots.includes('Sitemap: https://foodora.example/sitemap.xml'));

  const xml = buildSitemapXml('https://foodora.example/', [
    { slug: 'sultans-dine', updatedAt: '2026-11-18T10:00:00Z' },
    { slug: 'sultans-dine', updatedAt: '2026-11-18T10:00:00Z' }, // deduplicated
    { slug: 'my-own-kitchen&grill', updatedAt: '2026-11-19T00:00:00Z' },
  ]);
  assert.ok(xml.includes('<loc>https://foodora.example/</loc>'));
  assert.ok(xml.includes('<loc>https://foodora.example/?restaurant=sultans-dine</loc>'));
  assert.ok(xml.includes('%26'));
  assert.equal(xml.match(/sultans-dine/g)?.length, 1);
});

test('isWithinBangladesh and resolveNearestAreaFromList support nationwide BD cities', () => {
  // Dhaka, Sylhet, Chattogram, Cox's Bazar
  assert.equal(isWithinBangladesh(23.7949, 90.4144), true);
  assert.equal(isWithinBangladesh(24.8949, 91.8687), true);
  assert.equal(isWithinBangladesh(22.3569, 91.7832), true);
  assert.equal(isWithinBangladesh(21.4272, 92.0058), true);

  // Outside Bangladesh bounds (London / Singapore / NaN)
  assert.equal(isWithinBangladesh(51.5074, -0.1278), false);
  assert.equal(isWithinBangladesh(1.3521, 103.8198), false);
  assert.equal(isWithinBangladesh(Number.NaN, 90.4), false);

  const bdCities = [
    { name: 'Gulshan 2', lat: 23.7949, lng: 90.4144 },
    { name: 'Sylhet (Zindabazar)', lat: 24.8949, lng: 91.8687 },
    { name: 'Chattogram (GEC / Agrabad)', lat: 22.3569, lng: 91.7832 },
  ];
  const nearSylhet = resolveNearestAreaFromList(24.901, 91.872, bdCities);
  assert.equal(nearSylhet.area?.name, 'Sylhet (Zindabazar)');
  assert.equal(nearSylhet.label, 'Sylhet (Zindabazar)');

  // Far rural coordinate (>18km away from nearest preset) appends coordinate precision
  const farRural = resolveNearestAreaFromList(24.25, 91.4, bdCities);
  assert.ok(farRural.distanceKm > 18);
  assert.ok(farRural.label.includes('('));
});

test('buildOrderTrackingUrl and doesEmailMatchOrder handle tokens and case-insensitive email lookup', () => {
  assert.equal(
    buildOrderTrackingUrl('https://foodorabd1.vercel.app/', 42, 'tok_abc123'),
    'https://foodorabd1.vercel.app/?order=42&token=tok_abc123'
  );
  assert.equal(
    buildOrderTrackingUrl('https://foodorabd1.vercel.app', 42, null),
    'https://foodorabd1.vercel.app/?order=42'
  );

  assert.equal(doesEmailMatchOrder('Customer@Example.com ', 'customer@example.com'), true);
  assert.equal(doesEmailMatchOrder('a@b.com', 'c@b.com'), false);
  assert.equal(doesEmailMatchOrder('', 'c@b.com'), false);
});

test('buildOrderTrackingEmailPayload formats itemized invoice, tracking URL, escaped customer text, and rider info', () => {
  const payload = buildOrderTrackingEmailPayload({
    origin: 'https://foodorabd1.vercel.app/',
    orderId: 99,
    orderNumber: 'FD-2026-9900',
    trackingToken: 'sec_tok_99',
    customerName: 'Nadia <Rahman>',
    customerEmail: 'nadia@example.com',
    restaurantName: 'Panshi & Sons',
    deliveryArea: 'Sylhet (Zindabazar)',
    deliveryAddress: 'House 12, Road 3, Zindabazar',
    subtotal: 720,
    discountAmount: 50,
    couponCode: 'FOODORA50',
    deliveryFee: 49,
    serviceFee: 10,
    taxAmount: 51,
    totalAmount: 780,
    paymentMethod: 'bkash',
    paymentStatus: 'paid',
    status: 'on_the_way',
    statusNote: 'Rider departed kitchen',
    riderName: 'Kamrul Rider',
    riderPhone: '+8801811223344',
    etaMinutes: 14,
    items: [{ name: 'Beef Shatkora', quantity: 2, unitPrice: 360, lineTotal: 720 }],
  });

  assert.equal(payload.subject, 'Foodora BD Invoice INV-FD-2026-9900 (FD-2026-9900) — ON THE WAY');
  assert.equal(payload.trackingUrl, 'https://foodorabd1.vercel.app/?order=99&token=sec_tok_99');
  assert.ok(payload.html.includes('INV-FD-2026-9900'));
  assert.ok(payload.html.includes('Nadia &lt;Rahman&gt;'));
  assert.ok(payload.html.includes('Panshi &amp; Sons'));
  assert.ok(payload.html.includes('Kamrul Rider'));
  assert.ok(payload.html.includes('+8801811223344'));
  assert.ok(payload.html.includes('~14 mins'));
  assert.ok(payload.html.includes('Beef Shatkora'));
  assert.ok(payload.html.includes('@ ৳360'));
  assert.ok(payload.html.includes('Subtotal:'));
  assert.ok(payload.html.includes('FOODORA50'));
  assert.ok(payload.html.includes('VAT / Tax:'));
  assert.ok(payload.html.includes('রাইডার আপনার ঠিকানায় আসছেন'));
  assert.ok(payload.html.includes('https://foodorabd1.vercel.app/?order=99&amp;token=sec_tok_99'));
  assert.ok(payload.text.includes('INV-FD-2026-9900'));
  assert.ok(payload.text.includes('Sylhet (Zindabazar)'));
  assert.ok(payload.text.includes('+8801811223344'));
});

test('mergeCustomSelectOptions deduplicates case-insensitively and appends saved custom options', () => {
  assert.equal(normalizeCustomOptionValue('  Rampura   Dhaka  '), 'Rampura Dhaka');

  const merged = mergeCustomSelectOptions(
    [
      { value: 'Gulshan 2', label: 'Gulshan 2 — Dhaka' },
      { value: 'Banani', label: 'Banani — Dhaka' },
    ],
    ['  gulshan 2 ', 'Banasree Block C', 'Rampura   Dhaka', 'Banasree Block C'],
    'Khilgaon Taltola'
  );

  assert.equal(merged.length, 5);
  assert.equal(merged[0].value, 'Gulshan 2');
  assert.equal(merged[1].value, 'Banani');
  assert.equal(merged[2].value, 'Banasree Block C');
  assert.equal(merged[2].label, 'Banasree Block C (Custom)');
  assert.equal(merged[3].value, 'Rampura Dhaka');
  assert.equal(merged[4].value, 'Khilgaon Taltola');
});

test('pickNearestStandbyRider prefers nearest online approved rider and falls back safely', () => {
  const riders = [
    {
      uid: 'r-far-online',
      fullName: 'Far Rider',
      phone: '01711000001',
      vehicleType: 'Motorbike',
      zone: 'Uttara',
      isAvailable: true,
      lat: 23.8759,
      lng: 90.3795,
      locationUpdatedAt: '2026-11-20T09:00:00Z',
    },
    {
      uid: 'r-near-offline',
      fullName: 'Offline Rider',
      phone: '01711000002',
      vehicleType: 'Bicycle',
      zone: 'Gulshan 2',
      isAvailable: false,
      lat: 23.7950,
      lng: 90.4140,
      locationUpdatedAt: '2026-11-20T09:00:00Z',
    },
    {
      uid: 'r-near-online',
      fullName: 'Banani Rider',
      phone: '01711000003',
      vehicleType: 'Motorbike',
      zone: 'Banani',
      isAvailable: true,
      lat: 23.7937,
      lng: 90.4066,
      locationUpdatedAt: '2026-11-20T09:00:00Z',
    },
  ];

  const picked = pickNearestStandbyRider(riders, 23.7949, 90.4144);
  assert.ok(picked);
  assert.equal(picked?.rider.uid, 'r-near-online');
  assert.ok((picked?.distanceKm ?? 99) < 2);
  assert.equal(pickNearestStandbyRider([], 23.7949, 90.4144), null);
});

test('computeOrderEtaSummary provides phase-aware ETA and distance across order lifecycle', () => {
  const awaiting = computeOrderEtaSummary({
    status: 'confirmed',
    estimatedMinutes: 28,
    restaurantLat: 23.7949,
    restaurantLng: 90.4144,
    deliveryLat: 23.7808,
    deliveryLng: 90.4193,
    standbyRiderLat: 23.7937,
    standbyRiderLng: 90.4066,
  });
  assert.equal(awaiting.phase, 'awaiting_dispatch');
  assert.ok(awaiting.etaMinutes >= 6);
  assert.ok(awaiting.remainingKm > 1);

  const headingToRest = computeOrderEtaSummary({
    status: 'rider_assigned',
    estimatedMinutes: 25,
    restaurantLat: 23.7949,
    restaurantLng: 90.4144,
    deliveryLat: 23.7808,
    deliveryLng: 90.4193,
    riderLat: 23.7937,
    riderLng: 90.4066,
  });
  assert.equal(headingToRest.phase, 'heading_to_restaurant');
  assert.ok(headingToRest.etaMinutes > 5);

  const onTheWay = computeOrderEtaSummary({
    status: 'on_the_way',
    estimatedMinutes: 25,
    restaurantLat: 23.7949,
    restaurantLng: 90.4144,
    deliveryLat: 23.7808,
    deliveryLng: 90.4193,
    riderLat: 23.785,
    riderLng: 90.417,
  });
  assert.equal(onTheWay.phase, 'heading_to_customer');
  assert.ok(onTheWay.etaMinutes >= 2 && onTheWay.etaMinutes < 15);

  const delivered = computeOrderEtaSummary({
    status: 'delivered',
    estimatedMinutes: 25,
    deliveryLat: 23.7808,
    deliveryLng: 90.4193,
  });
  assert.equal(delivered.phase, 'delivered');
  assert.equal(delivered.etaMinutes, 0);
});

test('buildRestaurantUnavailableMessage explains closed vs pending restaurant states in EN and BN', () => {
  const closedEn = buildRestaurantUnavailableMessage("Sultan's Dine", 'approved', false, 'en');
  assert.ok(closedEn.includes("Sultan's Dine"));
  assert.ok(closedEn.includes('closed'));

  const closedBn = buildRestaurantUnavailableMessage("Sultan's Dine", 'approved', false, 'bn');
  assert.ok(closedBn.includes('বন্ধ'));

  const pendingEn = buildRestaurantUnavailableMessage('New Cafe', 'pending', true, 'en');
  assert.ok(pendingEn.includes('pending'));
  assert.ok(pendingEn.includes('Admin approval'));
});

test('buildAiHelpSystemInstruction configures Bangla/English language modes and marketplace context', () => {
  const bnPrompt = buildAiHelpSystemInstruction({
    langPreference: 'bn',
    area: 'Sylhet',
    activeOrderNumber: 'FD-BD-1001',
  });
  assert.ok(bnPrompt.includes('Bengali'));
  assert.ok(bnPrompt.includes('বাংলা'));
  assert.ok(bnPrompt.includes('Sylhet'));
  assert.ok(bnPrompt.includes('FD-BD-1001'));

  const autoBnUiPrompt = buildAiHelpSystemInstruction({
    langPreference: 'auto',
    uiLang: 'bn',
    area: 'Mirpur 10',
  });
  assert.ok(autoBnUiPrompt.includes('Bangla'));
  assert.ok(autoBnUiPrompt.includes('Banglish'));
  assert.ok(autoBnUiPrompt.includes('Mirpur 10'));

  const autoEnUiPrompt = buildAiHelpSystemInstruction({ langPreference: 'auto', uiLang: 'en' });
  assert.ok(autoEnUiPrompt.includes('Bangla'));
  assert.ok(autoEnUiPrompt.includes('English'));
});

test('parseOrderSoundPreference and getOrderAlertChimeNotes validate chime profile defaults and harmonics', () => {
  // Default enabled when unset or truthy
  assert.equal(parseOrderSoundPreference(null), true);
  assert.equal(parseOrderSoundPreference(undefined), true);
  assert.equal(parseOrderSoundPreference('true'), true);
  assert.equal(parseOrderSoundPreference('1'), true);

  // Disabled only when explicitly turned off
  assert.equal(parseOrderSoundPreference('false'), false);
  assert.equal(parseOrderSoundPreference('0'), false);
  assert.equal(parseOrderSoundPreference('off'), false);

  const newOrderNotes = getOrderAlertChimeNotes('new_order');
  assert.equal(newOrderNotes.length, 4);
  assert.ok(newOrderNotes[3].freq > newOrderNotes[0].freq);
  assert.ok((newOrderNotes[0].harmonicRatio ?? 0) >= 2);
  assert.ok(newOrderNotes[3].durationSec > newOrderNotes[0].durationSec);

  const statusNotes = getOrderAlertChimeNotes('status_update');
  assert.equal(statusNotes.length, 2);
  assert.ok(statusNotes[1].freq > statusNotes[0].freq);
});

test('isSandboxAuthToken and shouldPersistAuthToken separate sbx. sandbox tokens from real fbd. email tokens', () => {
  assert.equal(isSandboxAuthToken('sbx.eyJ1aWQiOiJkZW1vIn0.sig'), true);
  assert.equal(shouldPersistAuthToken('sbx.eyJ1aWQiOiJkZW1vIn0.sig'), false);
  assert.equal(shouldPersistAuthToken(''), false);
  assert.equal(shouldPersistAuthToken(null), false);

  assert.equal(isSandboxAuthToken('fbd.eyJ1aWQiOiJ1c2VyXzEifQ.sig'), false);
  assert.equal(shouldPersistAuthToken('fbd.eyJ1aWQiOiJ1c2VyXzEifQ.sig'), true);
  assert.equal(isSandboxAuthToken('eyJhbGciOiJIUzI1NiJ9.realuser.sig'), false);
  assert.equal(shouldPersistAuthToken('eyJhbGciOiJIUzI1NiJ9.realuser.sig'), true);
});

test('shouldRestoreTrackedOrderShortcut ignores stale demo/sandbox records and keeps real orders', () => {
  assert.equal(shouldRestoreTrackedOrderShortcut(null), false);
  assert.equal(shouldRestoreTrackedOrderShortcut({ orderId: 12, isSandbox: true }), false);
  assert.equal(
    shouldRestoreTrackedOrderShortcut({ orderId: 99, orderNumber: 'FD-BD-48374' }),
    false
  );
  assert.equal(
    shouldRestoreTrackedOrderShortcut({ orderId: 101, orderNumber: 'FD-BD-10041' }),
    false
  );
  assert.equal(
    shouldRestoreTrackedOrderShortcut({ orderId: 505, orderNumber: 'FD-BD-99210', isSandbox: false }),
    true
  );
});

test('formatResolvedMapAddress strips Plus Codes and municipal noise while building concise street addresses', () => {
  assert.equal(
    formatResolvedMapAddress({
      displayName: 'Q9W8+X2, Road 71, Gulshan 2, Ward 19, Dhaka North City Corporation, Dhaka Metropolitan, Dhaka Division, 1212, Bangladesh',
      areaName: 'Gulshan 2',
      lat: 23.7949,
      lng: 90.4144,
    }),
    'Road 71, Gulshan 2, Bangladesh'
  );
  assert.equal(
    formatResolvedMapAddress({
      displayName: '',
      areaName: 'Dhanmondi 27',
      lat: 23.7511,
      lng: 90.3765,
    }),
    'Dhanmondi 27, Bangladesh'
  );
  assert.equal(
    formatResolvedMapAddress({
      displayName: '',
      areaName: 'Pinned (23.7800, 90.4100)',
      lat: 23.78,
      lng: 90.41,
    }),
    'Pinned (23.7800, 90.4100), Bangladesh'
  );
});

test('isGooglePlusCodeSegment, extractCleanGoogleGeocodeAddress, and matchCanonicalAreaFromHints resolve exact street and Dhaka zone without Plus Codes', () => {
  assert.equal(isGooglePlusCodeSegment('Q9R7+M24'), true);
  assert.equal(isGooglePlusCodeSegment('Q9W8+XR Dhaka'), true);
  assert.equal(isGooglePlusCodeSegment('Road 11'), false);
  assert.equal(isAdministrativeNoiseSegment('Dhaka North City Corporation'), true);
  assert.equal(isAdministrativeNoiseSegment('Ward 19'), true);
  assert.equal(isAdministrativeNoiseSegment('Unnamed Road'), true);

  assert.deepEqual(
    cleanMapAddressSegments('Q9R7+M24, House 14, Road 11, Banani, Ward 19, Dhaka North City Corporation, Dhaka 1213, Bangladesh'),
    ['House 14', 'Road 11', 'Banani', 'Dhaka']
  );

  const parsed = extractCleanGoogleGeocodeAddress(
    [
      {
        formatted_address: 'QVR4+26 Dhaka, Bangladesh',
        types: ['plus_code'],
      },
      {
        formatted_address: 'Road 11, Banani Model Town, Dhaka 1213, Bangladesh',
        types: ['route'],
        address_components: [
          { long_name: 'Road 11', types: ['route'] },
          { long_name: 'Banani', types: ['sublocality_level_1', 'sublocality'] },
          { long_name: 'Dhaka', types: ['locality'] },
        ],
      },
    ],
    23.7937,
    90.4066,
    BANGLADESH_AREAS
  );

  assert.equal(parsed.areaName, 'Banani');
  assert.equal(parsed.displayName, 'Road 11, Banani Model Town, Dhaka, Bangladesh');
  assert.equal(
    matchCanonicalAreaFromHints(['Bashundhara Residential Area', 'Dhaka'], 23.8191, 90.4526, BANGLADESH_AREAS),
    'Bashundhara R/A'
  );
});

test('Dhaka Zone 01-12 structure, grouped select options, and storefront Active Delivery Bar config work deterministically', () => {
  assert.equal(DHAKA_DELIVERY_ZONES.length, 12);
  assert.equal(DHAKA_DELIVERY_ZONES[0].code, 'ZONE 01');
  assert.equal(DHAKA_DELIVERY_ZONES[11].code, 'ZONE 12');

  const merged = mergeCustomSelectOptions(
    [{ value: 'Niketan', label: 'Niketan', group: 'ZONE 01 — GULSHAN' }],
    ['Baridhara DOHS']
  );
  assert.equal(merged[0].group, 'ZONE 01 — GULSHAN');
  assert.equal(merged[1].group, 'Saved Custom');

  const scDefault = mergeStorefrontConfig(null);
  assert.equal(scDefault.showActiveDeliveryBar, true);
  assert.equal(scDefault.featuredActiveOrderId, '');

  const scHidden = mergeStorefrontConfig({
    showActiveDeliveryBar: false,
    featuredActiveOrderId: '',
  });
  assert.equal(scHidden.showActiveDeliveryBar, false);
  assert.equal(scHidden.featuredActiveOrderId, '');
});

test('shouldPlayDedupedOrderChime suppresses duplicate event keys inside cooldown window', () => {
  const cache = new Map<string, number>();
  assert.equal(shouldPlayDedupedOrderChime('order:10:confirmed', cache, 1000, 4000), true);
  assert.equal(shouldPlayDedupedOrderChime('order:10:confirmed', cache, 2500, 4000), false);
  assert.equal(shouldPlayDedupedOrderChime('order:10:preparing', cache, 2500, 4000), true);
  assert.equal(shouldPlayDedupedOrderChime('order:10:confirmed', cache, 5500, 4000), true);
  assert.equal(shouldPlayDedupedOrderChime('', cache, 5500, 4000), true);
});

test('collectMerchantOrderAlertRecipients deduplicates restaurant, owner, and admin emails while filtering sandbox domains', () => {
  const recipients = collectMerchantOrderAlertRecipients({
    restaurantEmail: 'Vendor@Example.com',
    ownerEmail: 'vendor@example.com',
    adminNotifyEmail: 'rakibraqkib@gmail.com',
    fallbackAdminEmails: ['rakibraqkib@gmail.com', 'vendor@foodora.bd'],
  });
  assert.deepEqual(recipients, ['vendor@example.com', 'rakibraqkib@gmail.com']);
});

test('buildMerchantOrderAlertEmailPayload generates bilingual new order & status update alerts', () => {
  const alert = buildMerchantOrderAlertEmailPayload({
    origin: 'https://foodora.bd',
    orderId: 88,
    orderNumber: 'FD-BD-88120',
    trackingToken: 'tok-88',
    eventKind: 'new_order',
    restaurantName: "Sultan's Dine",
    customerName: 'Nusrat Jahan',
    customerPhone: '01711223344',
    deliveryArea: 'Banani',
    deliveryAddress: 'Road 11, Banani, Dhaka',
    totalAmount: 920,
    paymentMethod: 'bkash',
    paymentStatus: 'paid',
    status: 'confirmed',
    items: [{ name: 'Mutton Kacchi', quantity: 2, lineTotal: 860 }],
  });
  assert.ok(alert.subject.includes('FD-BD-88120'));
  assert.ok(alert.subject.includes('920'));
  assert.ok(alert.html.includes('নতুন অর্ডার এসেছে'));
  assert.ok(alert.html.includes('2x'));
  assert.ok(alert.html.includes('Mutton Kacchi'));
  assert.ok(alert.trackingUrl.includes('order=88'));
});

test('detectOrderBatchChanges identifies newly arrived orders and status/payment updates', () => {
  const initial = detectOrderBatchChanges(null, [
    { id: 1, status: 'confirmed', paymentStatus: 'pending' },
    { id: 2, status: 'preparing', paymentStatus: 'paid' },
  ]);
  assert.equal(initial.newOrders.length, 0);
  assert.equal(initial.updatedOrders.length, 0);

  const next = detectOrderBatchChanges(initial.nextMap, [
    { id: 3, status: 'confirmed', paymentStatus: 'pending' },
    { id: 1, status: 'accepted', paymentStatus: 'pending' },
    { id: 2, status: 'preparing', paymentStatus: 'paid' },
  ]);
  assert.deepEqual(
    next.newOrders.map((o) => o.id),
    [3]
  );
  assert.deepEqual(
    next.updatedOrders.map((o) => o.id),
    [1]
  );
});





