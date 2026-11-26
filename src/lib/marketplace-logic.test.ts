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
  findLocalAddressSuggestions,
  filterAndRankRemoteSuggestions,
  mergeAddressSuggestions,
  normalizeFuzzyAddressText,
  resolveMapPinAppearance,
  ORDER_EMAIL_TEMPLATE_PRESETS,
  getOrderEmailTemplatePreview,
  expandAddressSearchQueries,
  resolveOrderEmailImageUrl,
  DEFAULT_ORDER_EMAIL_IMAGE_PATH,
  classifyEmailImageSrcForCid,
  extractEmailInlineCidPlan,
  filterOrdersByRestaurantOwnership,
  isValidExternalAiBaseUrl,
  toPublicAiProviderView,
  toAdminAiProviderView,
  validateRiderJobPayload,
  normalizeVariationsList,
  normalizeAddonsList,
  validateVendorAddRiderPayload,
  DEFAULT_AI_PROVIDERS,
  buildOpenRouterChatPayload,
  generateFoodoraOwnAiReply,
  formatRiderShortOrderCode,
  calculateRiderLegEtaMin,
  resolveRiderCashCollectAmount,
  parseUploadedImageDataUrl,
  AI_PROVIDER_PRESETS,
  buildMessengerUrl,
  buildWhatsAppSupportUrl,
} from './marketplace-logic';
import { DEFAULT_STOREFRONT_CONFIG, mergeStorefrontConfig } from './storefront-config';
import { BANGLADESH_AREAS, BANGLADESH_SEARCH_PLACES, DHAKA_DELIVERY_ZONES } from './i18n';

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
  assert.equal(canAddToSingleRestaurantCart([{ restaurantId: '5' as any }], 5), true);
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

  assert.equal(payload.subject, 'Foodora BD · Rider Is On The Way (FD-2026-9900 / INV-FD-2026-9900)');
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

test('findLocalAddressSuggestions and mergeAddressSuggestions rank prefix matches, support Bangla/zone tokens, and deduplicate coordinates', () => {
  const banMatches = findLocalAddressSuggestions('ban', BANGLADESH_AREAS, 5);
  assert.ok(banMatches.length >= 2);
  // Exact prefix match ("Banani" / "Banani DOHS" / "Banasree") ranks first
  assert.ok(banMatches[0].shortName.toLowerCase().startsWith('ban'));

  // Multi-token & Bangla query matching
  const bnMatches = findLocalAddressSuggestions('বনানী', BANGLADESH_AREAS, 4);
  assert.ok(bnMatches.some((m) => m.shortName === 'Banani'));

  const zoneMatches = findLocalAddressSuggestions('ZONE 01', BANGLADESH_AREAS, 5);
  assert.ok(zoneMatches.length >= 1);
  assert.ok(zoneMatches.every((m) => (m.subtitle || '').includes('ZONE 01')));

  const merged = mergeAddressSuggestions(
    [
      {
        shortName: 'Banani',
        displayName: 'Banani, Dhaka, Bangladesh',
        lat: 23.7937,
        lng: 90.4066,
        source: 'area',
      },
    ],
    [
      {
        shortName: 'Banani',
        displayName: 'Banani, Dhaka North, Bangladesh',
        lat: 23.79371,
        lng: 90.40662,
        source: 'map',
      },
      {
        shortName: 'Road 11, Banani',
        displayName: 'Road 11, Banani, Dhaka, Bangladesh',
        lat: 23.7944,
        lng: 90.4048,
        source: 'map',
      },
    ],
    5
  );

  assert.equal(merged.length, 2);
  assert.equal(merged[0].source, 'area');
  assert.equal(merged[1].shortName, 'Road 11, Banani');
});

test('fuzzy address normalization and BANGLADESH_SEARCH_PLACES find misspelled landmarks like sad musa citycenter', () => {
  assert.equal(normalizeFuzzyAddressText('Sad Musa CityCenter'), 'sad musa city center');
  const expanded = expandAddressSearchQueries('sad musa citycenter');
  assert.ok(expanded.includes('sad musa city center'));
  assert.ok(expanded.includes('saad musa city center'));
  assert.ok(expanded.includes('saad musa'));

  const sadMusaHits = findLocalAddressSuggestions('sad musa citycenter', BANGLADESH_SEARCH_PLACES, 8);
  assert.ok(sadMusaHits.length >= 3);
  assert.equal(sadMusaHits[0].shortName, 'Saad Musa City Center');
  assert.ok(sadMusaHits[0].displayName.includes('Pragati Sarani'));
  assert.ok(sadMusaHits.every((h) => !h.shortName.includes('Barishal')));

  // Partial query "sad musa" should surface multiple Bangladesh options (Dhaka + Chattogram)
  const partialHits = findLocalAddressSuggestions('sad musa', BANGLADESH_SEARCH_PLACES, 8);
  assert.ok(partialHits.length >= 3);

  // Remote ranking filters out unrelated loose trigram hits like "Achairja Mura"
  const filteredRemote = filterAndRankRemoteSuggestions(
    'saad musa city center',
    [
      {
        shortName: 'Achairja Mura',
        displayName: 'Achairja Mura, Cumilla, Bangladesh',
        lat: 23.3845,
        lng: 91.2749,
        source: 'map',
      },
      {
        shortName: 'Saad Musa Fabrics LTD',
        displayName: 'Saad Musa Fabrics LTD, Chittagong, Bangladesh',
        lat: 22.4057,
        lng: 91.8256,
        source: 'map',
      },
      {
        shortName: 'Musa Pharmcy',
        displayName: 'Musa Pharmcy, Faridpur, Bangladesh',
        lat: 23.6045,
        lng: 89.8363,
        source: 'map',
      },
    ],
    10
  );
  assert.equal(filteredRemote.length, 2);
  assert.equal(filteredRemote[0].shortName, 'Saad Musa Fabrics LTD');
});

test('resolveMapPinAppearance renders red user pin with You/userName and black vendor pin with restaurantName', () => {
  const defaultUser = resolveMapPinAppearance({});
  assert.equal(defaultUser.primaryRole, 'user');
  assert.equal(defaultUser.primaryPinColor, '#DC2626');
  assert.equal(defaultUser.primaryBorderColor, '#991B1B');
  assert.equal(defaultUser.primaryLabel, 'You');

  const namedUser = resolveMapPinAppearance({
    pinType: 'user',
    userName: 'Tanjim Rahman',
    markerLabel: 'Banani',
    secondaryLabel: "Sultan's Dine",
  });
  assert.equal(namedUser.primaryLabel, 'Tanjim Rahman');
  assert.equal(namedUser.primaryPinColor, '#DC2626');
  assert.equal(namedUser.secondaryLabel, "Sultan's Dine");
  assert.equal(namedUser.secondaryPinColor, '#111827');

  const areaUser = resolveMapPinAppearance({
    pinType: 'user',
    markerLabel: 'Gulshan 2',
  });
  assert.equal(areaUser.primaryLabel, 'You · Gulshan 2');

  const vendorPin = resolveMapPinAppearance({
    pinType: 'vendor',
    restaurantName: 'Kacchi Bhai',
    markerLabel: 'Banani',
  });
  assert.equal(vendorPin.primaryRole, 'vendor');
  assert.equal(vendorPin.primaryLabel, 'Kacchi Bhai');
  assert.equal(vendorPin.primaryPinColor, '#111827');
  assert.equal(vendorPin.primaryBorderColor, '#000000');
});

test('ORDER_EMAIL_TEMPLATE_PRESETS and getOrderEmailTemplatePreview generate bilingual templates for all stages', () => {
  assert.equal(ORDER_EMAIL_TEMPLATE_PRESETS.length, 6);
  for (const preset of ORDER_EMAIL_TEMPLATE_PRESETS) {
    const preview = getOrderEmailTemplatePreview(preset.status, 'https://foodora.bd', 'buyer@gmail.com');
    assert.ok(preview.subject.includes('FD-BD-84210'));
    assert.ok(preview.html.includes('INV-FD-BD-84210'));
    assert.ok(preview.html.includes(preset.badgeColor));
    assert.ok(preview.trackingUrl.includes('order=99999'));
    assert.ok(preview.text.includes('Foodora BD'));
  }

  const paidEmail = buildOrderTrackingEmailPayload({
    origin: 'https://foodora.bd',
    orderId: 501,
    orderNumber: 'FD-BD-501',
    trackingToken: 'tok-501',
    customerName: 'Nusrat',
    customerEmail: 'nusrat@gmail.com',
    restaurantName: 'Chillox',
    deliveryArea: 'Dhanmondi',
    totalAmount: 450,
    paymentMethod: 'bkash',
    paymentStatus: 'paid',
    status: 'payment_verified',
  });
  assert.ok(paidEmail.subject.includes('Payment Confirmed'));
  assert.ok(paidEmail.html.includes('পেমেন্ট সম্পন্ন'));
});

test('resolveOrderEmailImageUrl and invoice email HTML include ordered product thumbnail images', () => {
  assert.equal(
    resolveOrderEmailImageUrl('/src/assets/images/kacchi.jpg', 'https://foodora.bd/'),
    'https://foodora.bd/src/assets/images/kacchi.jpg'
  );
  assert.equal(
    resolveOrderEmailImageUrl('https://cdn.example.com/burger.png', 'https://foodora.bd'),
    'https://cdn.example.com/burger.png'
  );
  assert.equal(resolveOrderEmailImageUrl('', 'https://foodora.bd'), '');

  const preview = getOrderEmailTemplatePreview(
    'confirmed',
    'https://ais-pre-example.run.app',
    'raqkibrony@gmail.com'
  );
  assert.ok(
    preview.html.includes(
      'https://ais-pre-example.run.app/src/assets/images/food_kacchi_biriyani_1794831373742.jpg'
    )
  );
  assert.ok(
    preview.html.includes(
      'https://ais-pre-example.run.app/src/assets/images/food_tandoori_kabab_1794831377175.jpg'
    )
  );
  assert.ok(preview.html.includes('<img src='));
});

test('extractEmailInlineCidPlan converts local/preview image URLs and data URIs into deduplicated cid attachments while preserving external CDNs', () => {
  const sampleHtml = `
    <div>
      <img src="http://ais-dev-demo.run.app/src/assets/images/food_kacchi_biriyani_1794831373742.jpg" />
      <img src="https://ais-pre-demo.run.app/src/assets/images/food_kacchi_biriyani_1794831373742.jpg" />
      <img src="/uploads/dish-special.png" />
      <img src="https://cdn.example.com/public-burger.jpg" />
      <img src="data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" />
    </div>
  `;
  const plan = extractEmailInlineCidPlan(sampleHtml);
  assert.equal(plan.images.length, 3);
  assert.equal(plan.images[0].cid, 'foodora-img-1');
  assert.equal(plan.images[0].localPath, '/src/assets/images/food_kacchi_biriyani_1794831373742.jpg');
  assert.equal(plan.images[1].cid, 'foodora-img-2');
  assert.equal(plan.images[1].localPath, '/uploads/dish-special.png');
  assert.equal(plan.images[2].cid, 'foodora-img-3');
  assert.equal(plan.images[2].kind, 'data');

  // Same local file via two origins shares cid foodora-img-1
  assert.equal((plan.html.match(/src="cid:foodora-img-1"/g) || []).length, 2);
  assert.ok(plan.html.includes('src="cid:foodora-img-2"'));
  assert.ok(plan.html.includes('src="cid:foodora-img-3"'));
  // External CDN URL stays untouched
  assert.ok(plan.html.includes('src="https://cdn.example.com/public-burger.jpg"'));

  // Merchant alert email now embeds product thumbnails too
  const merchantAlert = buildMerchantOrderAlertEmailPayload({
    origin: 'https://ais-pre-demo.run.app',
    orderId: 91,
    orderNumber: 'FD-BD-9911',
    eventKind: 'new_order',
    restaurantName: "Sultan's Dine",
    customerName: 'Rakib',
    deliveryArea: 'Banani',
    totalAmount: 450,
    paymentMethod: 'cod',
    status: 'confirmed',
    items: [{ name: 'Zdf', quantity: 1, lineTotal: 350 }],
  });
  assert.ok(merchantAlert.html.includes(DEFAULT_ORDER_EMAIL_IMAGE_PATH));
  assert.ok(merchantAlert.html.includes('<img src='));

  const alertCidPlan = extractEmailInlineCidPlan(merchantAlert.html);
  assert.equal(alertCidPlan.images.length, 1);
  assert.ok(alertCidPlan.html.includes('src="cid:foodora-img-1"'));
  assert.equal(classifyEmailImageSrcForCid('https://cdn.example.com/photo.jpg'), null);
});

test('filterOrdersByRestaurantOwnership strictly isolates restaurant owners while allowing admins', () => {
  const sampleOrders = [
    { id: 1, restaurantId: 10 },
    { id: 2, restaurantId: 12 },
    { id: 3, restaurantId: 15 },
    { id: 4, restaurantId: 10 },
  ];

  const ownerFiltered = filterOrdersByRestaurantOwnership(sampleOrders, [10], false);
  assert.deepEqual(
    ownerFiltered.map((o) => o.id),
    [1, 4]
  );

  const multiStoreOwner = filterOrdersByRestaurantOwnership(sampleOrders, [10, 15], false);
  assert.deepEqual(
    multiStoreOwner.map((o) => o.id),
    [1, 3, 4]
  );

  const adminView = filterOrdersByRestaurantOwnership(sampleOrders, [10], true);
  assert.equal(adminView.length, 4);
});

test('AI provider views mask secrets and SSRF validator blocks unsafe external AI base URLs', () => {
  assert.equal(isValidExternalAiBaseUrl('https://api.openai.com/v1'), true);
  assert.equal(isValidExternalAiBaseUrl('https://api.groq.com/openai/v1'), true);
  assert.equal(isValidExternalAiBaseUrl('http://api.openai.com/v1'), false);
  assert.equal(isValidExternalAiBaseUrl('https://localhost:8080/v1'), false);
  assert.equal(isValidExternalAiBaseUrl('https://127.0.0.1/v1'), false);
  assert.equal(isValidExternalAiBaseUrl('https://192.168.1.10/v1'), false);
  assert.equal(isValidExternalAiBaseUrl('https://10.0.0.5/v1'), false);
  assert.equal(isValidExternalAiBaseUrl('https://169.254.169.254/latest'), false);

  const openaiRow = {
    code: 'ChatGPT',
    name: 'ChatGPT (OpenAI)',
    providerType: 'openai',
    model: 'gpt-4o-mini',
    apiBaseUrl: 'https://api.openai.com/v1',
    apiKey: 'sk-proj-supersecret-9876',
    isActive: true,
    isDefault: false,
    sortOrder: 2,
  };

  const pubView = toPublicAiProviderView(openaiRow, true);
  assert.equal(pubView.code, 'chatgpt');
  assert.equal(pubView.isConfigured, true);
  assert.equal('apiKey' in pubView, false);

  const adminView = toAdminAiProviderView(openaiRow, true);
  assert.equal(adminView.hasApiKey, true);
  assert.equal(adminView.apiKeyPreview, '••••9876');
  assert.equal('apiKey' in adminView, false);

  const geminiRow = {
    code: 'gemini',
    name: 'Google Gemini',
    providerType: 'gemini',
    model: 'gemini-4-hydrogen',
    apiBaseUrl: '',
    apiKey: '',
    isActive: true,
    isDefault: true,
    sortOrder: 1,
  };
  const geminiAdmin = toAdminAiProviderView(geminiRow, true);
  assert.equal(geminiAdmin.isConfigured, true);
  assert.equal(geminiAdmin.hasApiKey, true);
  assert.equal(geminiAdmin.apiKeyPreview, 'Server Env Configured');
});

test('validateRiderJobPayload validates restaurant job inputs and supports rider_assigned transitions', () => {
  const badRest = validateRiderJobPayload({ restaurantId: 0, title: 'Rider', zone: 'Banani' });
  assert.equal(badRest.valid, false);

  const shortTitle = validateRiderJobPayload({ restaurantId: 5, title: 'Hi', zone: 'Banani' });
  assert.equal(shortTitle.valid, false);

  const valid = validateRiderJobPayload({
    restaurantId: 5,
    title: '  Evening Delivery Rider  ',
    zone: 'Gulshan 2',
    vacancies: 3,
  });
  assert.equal(valid.valid, true);
  if (valid.valid) {
    assert.equal(valid.data.restaurantId, 5);
    assert.equal(valid.data.title, 'Evening Delivery Rider');
    assert.equal(valid.data.titleBn, 'Evening Delivery Rider');
    assert.equal(valid.data.vacancies, 3);
  }

  assert.equal(canTransitionOrderStatus('confirmed', 'rider_assigned'), true);
  assert.equal(canTransitionOrderStatus('preparing', 'rider_assigned'), true);
  assert.equal(canTransitionOrderStatus('rider_assigned', 'delivered'), true);
});

test('normalizeVariationsList & normalizeAddonsList clean duplicates, prices, and defaults', () => {
  assert.deepEqual(normalizeVariationsList([]), [{ name: 'Regular', priceDelta: 0 }]);
  assert.deepEqual(normalizeVariationsList([], false), []);

  const vars = normalizeVariationsList([
    { name: '  Half ', priceDelta: -80.4 },
    { name: 'half', priceDelta: 10 },
    { name: 'Full Platter', priceDelta: 180 },
    { name: '', priceDelta: 50 },
  ]);
  assert.deepEqual(vars, [
    { name: 'Half', priceDelta: -80 },
    { name: 'Full Platter', priceDelta: 180 },
  ]);

  const addons = normalizeAddonsList([
    { name: ' Extra Cheese ', price: 65 },
    { name: 'extra cheese', price: 99 },
    { name: 'Free Sauce', price: -20 },
  ]);
  assert.deepEqual(addons, [
    { name: 'Extra Cheese', price: 65 },
    { name: 'Free Sauce', price: 0 },
  ]);
});

test('validateVendorAddRiderPayload validates phone, email, optional password, and store ownership input', () => {
  const badStore = validateVendorAddRiderPayload({
    restaurantId: 0,
    fullName: 'Arif',
    phone: '01712345678',
    email: 'arif@bd.com',
  });
  assert.equal(badStore.valid, false);

  const badPhone = validateVendorAddRiderPayload({
    restaurantId: 1,
    fullName: 'Arif Hasan',
    phone: '12345',
    email: 'arif@bd.com',
  });
  assert.equal(badPhone.valid, false);

  const shortPass = validateVendorAddRiderPayload({
    restaurantId: 1,
    fullName: 'Arif Hasan',
    phone: '01712345678',
    email: 'arif@bd.com',
    password: '123',
  });
  assert.equal(shortPass.valid, false);

  const ok = validateVendorAddRiderPayload({
    restaurantId: 2,
    fullName: '  Arif Hasan ',
    phone: '01712345678',
    email: 'ARIF@restaurant.bd',
    password: 'secret123',
    vehicleType: 'Motorbike',
    zone: 'Banani',
  });
  assert.equal(ok.valid, true);
  if (ok.valid) {
    assert.equal(ok.data.restaurantId, 2);
    assert.equal(ok.data.fullName, 'Arif Hasan');
    assert.equal(ok.data.email, 'arif@restaurant.bd');
    assert.equal(ok.data.phone, '+8801712345678');
    assert.equal(ok.data.password, 'secret123');
  }
});

test('DEFAULT_AI_PROVIDERS, Foodora Own AI, and OpenRouter views preserve built-in and env-backed config safely', () => {
  assert.equal(DEFAULT_AI_PROVIDERS[0].code, 'foodora');
  assert.equal(DEFAULT_AI_PROVIDERS[0].isDefault, true);
  assert.equal(DEFAULT_AI_PROVIDERS[1].code, 'openrouter');
  assert.equal(DEFAULT_AI_PROVIDERS[1].model, 'google/gemma-4-31b-it:free');

  const foodoraRow = {
    ...DEFAULT_AI_PROVIDERS[0],
    apiKey: '',
  };
  const foodoraPub = toPublicAiProviderView(foodoraRow, { hasGeminiKey: false, hasOpenRouterKey: false });
  assert.equal(foodoraPub.isConfigured, true);
  const foodoraAdmin = toAdminAiProviderView(foodoraRow, { hasGeminiKey: true });
  assert.equal(foodoraAdmin.hasApiKey, true);
  assert.equal(foodoraAdmin.apiKeyPreview, 'Foodora Own AI + Gemini');

  const openRouterEnvRow = {
    ...DEFAULT_AI_PROVIDERS[1],
    apiKey: '',
  };
  const orPubEnv = toPublicAiProviderView(openRouterEnvRow, { hasOpenRouterKey: true });
  assert.equal(orPubEnv.isConfigured, true);
  const orAdminEnv = toAdminAiProviderView(openRouterEnvRow, { hasOpenRouterKey: true });
  assert.equal(orAdminEnv.hasApiKey, true);
  assert.equal(orAdminEnv.apiKeyPreview, 'Server Env Configured');

  const orDbKeyAdmin = toAdminAiProviderView(
    { ...openRouterEnvRow, apiKey: 'sk-or-v1-secret-1234' },
    { hasOpenRouterKey: false }
  );
  assert.equal(orDbKeyAdmin.hasApiKey, true);
  assert.equal(orDbKeyAdmin.apiKeyPreview, '••••1234');
  assert.equal('apiKey' in orDbKeyAdmin, false);
});

test('buildOpenRouterChatPayload configures Gemma 4 reasoning, google-ai-studio provider lock, and preserves reasoning_details', () => {
  const reasoningToken = [{ type: 'reasoning.text', text: 'Count r letters carefully: 3.' }];
  const payload = buildOpenRouterChatPayload({
    model: 'google/gemma-4-31b-it:free',
    systemInstruction: 'You are Foodora BD AI Help.',
    history: [
      { role: 'user', text: "How many r's are in strawberry?" },
      { role: 'model', text: 'There are 3 r letters.', reasoning_details: reasoningToken },
    ],
    message: 'Are you sure? Think carefully.',
  });

  assert.equal(payload.model, 'google/gemma-4-31b-it:free');
  assert.deepEqual(payload.reasoning, { enabled: true });
  assert.deepEqual(payload.provider, {
    only: ['google-ai-studio'],
    allow_fallbacks: false,
  });

  const msgs = payload.messages as Array<{ role: string; content: string; reasoning_details?: unknown }>;
  assert.equal(msgs.length, 4);
  assert.equal(msgs[0].role, 'system');
  assert.equal(msgs[1].role, 'user');
  assert.equal(msgs[2].role, 'assistant');
  assert.deepEqual(msgs[2].reasoning_details, reasoningToken);
  assert.equal(msgs[3].role, 'user');
  assert.equal(msgs[3].content, 'Are you sure? Think carefully.');
});

test('generateFoodoraOwnAiReply answers English, Bangla, and Banglish Foodora queries with live restaurant context', () => {
  const enTrack = generateFoodoraOwnAiReply({
    message: 'How can I track my rider ETA?',
    langPreference: 'auto',
    uiLang: 'en',
    activeOrderNumber: 'FD-BD-5541',
  });
  assert.ok(enTrack.includes('Track Rider'));
  assert.ok(enTrack.includes('FD-BD-5541'));

  const bnPay = generateFoodoraOwnAiReply({
    message: 'বিকাশ বা ক্যাশ অন ডেলিভারি পেমেন্ট করা যাবে?',
    langPreference: 'auto',
    uiLang: 'en',
  });
  assert.ok(bnPay.includes('bKash'));
  assert.ok(bnPay.includes('FOODORA50'));

  const banglishMenu = generateFoodoraOwnAiReply({
    message: 'Amar khuub khabar khawar ichha, kacchi kothay pabo?',
    langPreference: 'auto',
    uiLang: 'en',
    area: 'Gulshan 2',
    openRestaurants: [{ name: "Sultan's Dine", area: 'Gulshan 2', cuisine: 'Biriyani' }],
  });
  assert.ok(banglishMenu.includes('Gulshan 2'));
  assert.ok(banglishMenu.includes("Sultan's Dine"));
});

test('Rider sheet helpers format short order codes, leg ETAs, and COD vs Paid online cash collection', () => {
  assert.equal(formatRiderShortOrderCode('aa98-2442-1639', 12), '1639');
  assert.equal(formatRiderShortOrderCode('FD-BD-8251', 7), '8251');
  assert.equal(formatRiderShortOrderCode('ORD', 42), '0042');

  const legEta = calculateRiderLegEtaMin(23.7949, 90.4144, 23.7808, 90.4193, 2);
  assert.ok(legEta >= 2 && legEta <= 45);
  assert.equal(calculateRiderLegEtaMin(Number.NaN, 90.4, 23.78, 90.41, 4), 4);

  const onlinePay = resolveRiderCashCollectAmount('bkash', 800);
  assert.equal(onlinePay.isCod, false);
  assert.equal(onlinePay.amountToCollect, 0);
  assert.equal(onlinePay.statusLabelEn, 'Paid online');

  const codDefault = resolveRiderCashCollectAmount('cod', 280.95);
  assert.equal(codDefault.isCod, true);
  assert.equal(codDefault.amountToCollect, 280.95);
  assert.equal(codDefault.statusLabelEn, 'Collect cash');

  const codEdited = resolveRiderCashCollectAmount('cod', 280.95, 250);
  assert.equal(codEdited.isCod, true);
  assert.equal(codEdited.amountToCollect, 250);
});

test('parseUploadedImageDataUrl handles image/jpeg, image/jpg, image/pjpeg, whitespace, and octet-stream JPEG magic bytes', () => {
  // Valid minimal JPEG header bytes (FF D8 FF E0)
  const jpegBase64 = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10]).toString('base64');

  const stdJpeg = parseUploadedImageDataUrl(`data:image/jpeg;base64,${jpegBase64}`);
  assert.equal(stdJpeg.valid, true);
  if (stdJpeg.valid) {
    assert.equal(stdJpeg.ext, 'jpg');
    assert.equal(stdJpeg.mimeType, 'image/jpeg');
  }

  const pjpeg = parseUploadedImageDataUrl(`data:image/pjpeg;charset=utf-8;base64, ${jpegBase64.slice(0, 4)}\n${jpegBase64.slice(4)}`);
  assert.equal(pjpeg.valid, true);
  if (pjpeg.valid) {
    assert.equal(pjpeg.ext, 'jpg');
    assert.equal(pjpeg.base64Data, jpegBase64);
  }

  const octetJpg = parseUploadedImageDataUrl(`data:application/octet-stream;base64,${jpegBase64}`, 'photo.JPG');
  assert.equal(octetJpg.valid, true);
  if (octetJpg.valid) {
    assert.equal(octetJpg.ext, 'jpg');
  }

  const bad = parseUploadedImageDataUrl('data:application/pdf;base64,JVBERi0xLjQ=');
  assert.equal(bad.valid, false);
});

test('sanitizeRiderProfileUpdate and calculateRiderProfileStats validate edits and compute completion metrics', async () => {
  const logic = await import('./marketplace-logic');
  const ok = logic.sanitizeRiderProfileUpdate({
    fullName: '  Kamrul Hasan  ',
    phone: ' +880 1711-009988 ',
    vehicleType: 'Motorbike',
    zone: 'Banani',
    nidNumber: '1995269123456',
    isAvailable: false,
    avatarUrl: '/uploads/rider-12.jpg',
  });
  assert.equal(ok.valid, true);
  if (ok.valid) {
    assert.equal(ok.data.fullName, 'Kamrul Hasan');
    assert.equal(ok.data.phone, '+880 1711-009988');
    assert.equal(ok.data.isAvailable, false);
    assert.equal(ok.data.avatarUrl, '/uploads/rider-12.jpg');
  }

  const badPhone = logic.sanitizeRiderProfileUpdate({
    fullName: 'Kamrul',
    phone: '123',
    vehicleType: 'Bicycle',
    zone: 'Mirpur 10',
  });
  assert.equal(badPhone.valid, false);

  const badAvatar = logic.sanitizeRiderProfileUpdate({
    fullName: 'Kamrul',
    phone: '01711223344',
    vehicleType: 'Bicycle',
    zone: 'Mirpur 10',
    avatarUrl: 'javascript:alert(1)',
  });
  assert.equal(badAvatar.valid, false);

  const stats = logic.calculateRiderProfileStats(
    { totalDeliveries: 9, totalEarnings: 720 },
    [
      { status: 'delivered', deliveryFee: 80 },
      { status: 'cancelled', deliveryFee: 60 },
      { status: 'picked_up', deliveryFee: 70 },
    ]
  );
  assert.equal(stats.deliveredCount, 9);
  assert.equal(stats.cancelledCount, 1);
  assert.equal(stats.activeCount, 1);
  assert.equal(stats.completionRatePct, 90);
  assert.equal(stats.avgEarningPerOrder, 80);
});

test('isBicycleVehicleType, canOwnerOpenNewRestaurant, and buildBranchRestaurantNames enforce bicycle license exemption and 1-restaurant + multi-branch rules', async () => {
  const logic = await import('./marketplace-logic');
  assert.equal(logic.isBicycleVehicleType('Bicycle'), true);
  assert.equal(logic.isBicycleVehicleType('bycikel'), true);
  assert.equal(logic.isBicycleVehicleType('সাইকেল'), true);
  assert.equal(logic.isBicycleVehicleType('Motorbike'), false);
  assert.equal(logic.isBicycleVehicleType('Scooter'), false);

  assert.equal(logic.canOwnerOpenNewRestaurant(0, 'customer').allowed, true);
  assert.equal(logic.canOwnerOpenNewRestaurant(0, 'restaurant_owner').allowed, true);
  const blocked = logic.canOwnerOpenNewRestaurant(1, 'restaurant_owner');
  assert.equal(blocked.allowed, false);
  assert.ok(blocked.error?.includes('1 restaurant'));
  assert.equal(logic.canOwnerOpenNewRestaurant(5, 'super_admin').allowed, true);

  const branchNames = logic.buildBranchRestaurantNames(
    "Sultan's Dine — Gulshan",
    'সুলতানস ডাইন — গুলশান',
    'Banani Branch',
    'বনানী শাখা'
  );
  assert.equal(branchNames.name, "Sultan's Dine — Banani Branch");
  assert.equal(branchNames.nameBn, 'সুলতানস ডাইন — বনানী শাখা');
});

test('Expanded AI providers include Pollinations keyless AI, OpenRouter retry payload, and multi-provider env detection', () => {
  assert.ok(DEFAULT_AI_PROVIDERS.length >= 16);
  assert.ok(AI_PROVIDER_PRESETS.length >= 12);

  const pollinationsRow = DEFAULT_AI_PROVIDERS.find((p) => p.code === 'pollinations');
  assert.ok(pollinationsRow);
  const pollPub = toPublicAiProviderView({ ...pollinationsRow!, apiKey: '' }, {});
  assert.equal(pollPub.isConfigured, true);

  const mistralRow = DEFAULT_AI_PROVIDERS.find((p) => p.code === 'mistral');
  assert.ok(mistralRow);
  assert.equal(
    toPublicAiProviderView({ ...mistralRow!, apiKey: '' }, { hasMistralKey: true }).isConfigured,
    true
  );
  assert.equal(
    toPublicAiProviderView({ ...mistralRow!, apiKey: '' }, { hasMistralKey: false }).isConfigured,
    false
  );

  const fallbackPayload = buildOpenRouterChatPayload({
    model: 'google/gemma-4-31b-it:free',
    systemInstruction: 'Be helpful.',
    history: [{ role: 'model', text: 'Hi', reasoning_details: { secret: 1 } }],
    message: 'Test',
    strictProvider: false,
    enableReasoning: false,
  });
  assert.equal('provider' in fallbackPayload, false);
  assert.equal('reasoning' in fallbackPayload, false);
});

test('buildMessengerUrl, buildWhatsAppSupportUrl, and StorefrontConfig defaults support Messenger & WhatsApp contact channels', () => {
  assert.equal(
    buildMessengerUrl(DEFAULT_STOREFRONT_CONFIG.messengerUrl),
    'https://www.facebook.com/messages/t/mdrakib.roni.1'
  );
  assert.equal(
    buildMessengerUrl(''),
    'https://www.facebook.com/messages/t/mdrakib.roni.1'
  );
  assert.equal(
    buildMessengerUrl('mdrakib.roni.1'),
    'https://www.facebook.com/messages/t/mdrakib.roni.1'
  );

  assert.equal(
    buildWhatsAppSupportUrl('01712345678'),
    'https://wa.me/8801712345678'
  );
  assert.equal(
    buildWhatsAppSupportUrl('+880 1712-345678', 'Hello Foodora'),
    'https://wa.me/8801712345678?text=Hello%20Foodora'
  );

  const supportReply = generateFoodoraOwnAiReply({
    message: 'WhatsApp or Messenger support link kothay?',
    langPreference: 'bn',
  });
  assert.ok(supportReply.includes('Messenger'));
  assert.ok(supportReply.includes('WhatsApp'));
});
