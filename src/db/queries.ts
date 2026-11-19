import { and, asc, desc, eq, like, or } from 'drizzle-orm';
import { db } from './index.ts';
import {
  auditLogs,
  commissionLedger,
  coupons,
  customerAddresses,
  favorites,
  foodItems,
  localCredentials,
  notifications,
  orders,
  orderStatusHistory,
  paymentGateways,
  platformSettings,
  restaurantPayouts,
  restaurants,
  reviews,
  riders,
  users,
} from './schema.ts';
import {
  DEFAULT_PAYMENT_GATEWAYS,
  partitionOwnedVsPartnerRestaurants,
  PROTECTED_SUPER_ADMIN_EMAILS,
} from '../lib/marketplace-logic.ts';

export async function getApprovedRestaurants() {
  try {
    return await db
      .select()
      .from(restaurants)
      .where(eq(restaurants.status, 'approved'))
      .orderBy(desc(restaurants.isSponsored), desc(restaurants.rating));
  } catch (error) {
    console.error('Failed to load approved restaurants:', error);
    throw new Error('Failed to load restaurants', { cause: error });
  }
}

export async function getAllRestaurantsAdmin() {
  try {
    return await db.select().from(restaurants).orderBy(desc(restaurants.createdAt));
  } catch (error) {
    console.error('Failed to load all restaurants:', error);
    throw new Error('Failed to load restaurants', { cause: error });
  }
}

export async function getStorefrontProducts() {
  try {
    const rows = await db
      .select({
        id: foodItems.id,
        restaurantId: foodItems.restaurantId,
        category: foodItems.category,
        name: foodItems.name,
        nameBn: foodItems.nameBn,
        description: foodItems.description,
        imageUrl: foodItems.imageUrl,
        price: foodItems.price,
        discountPrice: foodItems.discountPrice,
        variationsJson: foodItems.variationsJson,
        addonsJson: foodItems.addonsJson,
        inStock: foodItems.inStock,
        isAvailable: foodItems.isAvailable,
        isPopular: foodItems.isPopular,
        isVisibleOnStorefront: foodItems.isVisibleOnStorefront,
        restaurantName: restaurants.name,
        restaurantNameBn: restaurants.nameBn,
        restaurantSlug: restaurants.slug,
        restaurantLogoUrl: restaurants.logoUrl,
        restaurantCoverUrl: restaurants.coverUrl,
        restaurantArea: restaurants.area,
        restaurantCuisine: restaurants.cuisine,
        deliveryTimeMin: restaurants.deliveryTimeMin,
        deliveryFee: restaurants.deliveryFee,
        deliveryMode: restaurants.deliveryMode,
        minOrder: restaurants.minOrder,
        rating: restaurants.rating,
        isOpen: restaurants.isOpen,
      })
      .from(foodItems)
      .innerJoin(restaurants, eq(foodItems.restaurantId, restaurants.id))
      .where(
        and(
          eq(restaurants.status, 'approved'),
          eq(foodItems.isVisibleOnStorefront, true),
          eq(foodItems.isAvailable, true)
        )
      )
      .orderBy(desc(foodItems.isPopular), desc(foodItems.inStock), desc(foodItems.id));
    return rows;
  } catch (error) {
    console.error('Failed to load storefront products:', error);
    throw new Error('Failed to load storefront products', { cause: error });
  }
}

export async function getRestaurantBySlug(slug: string) {
  try {
    const rows = await db.select().from(restaurants).where(eq(restaurants.slug, slug)).limit(1);
    if (rows.length === 0) return null;
    const restaurant = rows[0];
    const items = await db
      .select()
      .from(foodItems)
      .where(
        and(
          eq(foodItems.restaurantId, restaurant.id),
          eq(foodItems.isVisibleOnStorefront, true)
        )
      );
    const restaurantReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.restaurantId, restaurant.id))
      .orderBy(desc(reviews.createdAt));
    return { restaurant, items, reviews: restaurantReviews };
  } catch (error) {
    console.error('Failed to load restaurant detail:', error);
    throw new Error('Failed to load restaurant details', { cause: error });
  }
}

export async function getActiveCoupons() {
  try {
    return await db.select().from(coupons).where(eq(coupons.isActive, true));
  } catch (error) {
    console.error('Failed to load coupons:', error);
    throw new Error('Failed to load coupons', { cause: error });
  }
}

export async function getCustomerAddresses(userUid: string) {
  try {
    return await db
      .select()
      .from(customerAddresses)
      .where(eq(customerAddresses.userUid, userUid))
      .orderBy(desc(customerAddresses.isDefault));
  } catch (error) {
    console.error('Failed to load addresses:', error);
    throw new Error('Failed to load saved addresses', { cause: error });
  }
}

export async function getCustomerOrders(customerUid: string) {
  try {
    return await db
      .select()
      .from(orders)
      .where(eq(orders.customerUid, customerUid))
      .orderBy(desc(orders.createdAt));
  } catch (error) {
    console.error('Failed to load customer orders:', error);
    throw new Error('Failed to load customer orders', { cause: error });
  }
}

export async function getOrderById(orderId: number) {
  try {
    const rows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (rows.length === 0) return null;
    const order = rows[0];
    const history = await db
      .select()
      .from(orderStatusHistory)
      .where(eq(orderStatusHistory.orderId, orderId))
      .orderBy(orderStatusHistory.createdAt);
    const restRows = await db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, order.restaurantId))
      .limit(1);

    let riderLocation: {
      uid: string;
      fullName: string;
      phone: string;
      vehicleType: string;
      zone: string;
      isAvailable: boolean;
      lat: number;
      lng: number;
      locationUpdatedAt: Date;
    } | null = null;

    if (order.riderUid) {
      const riderRows = await db
        .select()
        .from(riders)
        .where(eq(riders.uid, order.riderUid))
        .limit(1);
      if (riderRows.length > 0) {
        const r = riderRows[0];
        riderLocation = {
          uid: r.uid,
          fullName: r.fullName,
          phone: r.phone,
          vehicleType: r.vehicleType,
          zone: r.zone,
          isAvailable: r.isAvailable,
          lat: r.currentLat,
          lng: r.currentLng,
          locationUpdatedAt: r.locationUpdatedAt,
        };
      }
    }

    return {
      order,
      history,
      restaurant: restRows[0] ?? null,
      riderLocation,
    };
  } catch (error) {
    console.error('Failed to fetch order detail:', error);
    throw new Error('Failed to fetch order details', { cause: error });
  }
}

export async function getPlatformSettingsRow() {
  try {
    const rows = await db.select().from(platformSettings).limit(1);
    return rows[0] ?? null;
  } catch (error) {
    console.error('Failed to fetch platform settings:', error);
    throw new Error('Failed to load platform settings', { cause: error });
  }
}

export async function ensureDefaultPaymentGateways() {
  try {
    const existing = await db
      .select()
      .from(paymentGateways)
      .orderBy(asc(paymentGateways.sortOrder), asc(paymentGateways.id));

    if (existing.length === 0) {
      const settings = await getPlatformSettingsRow();
      const seedRows = DEFAULT_PAYMENT_GATEWAYS.map((gw) => {
        if (gw.code === 'bkash' && settings) {
          return {
            ...gw,
            isActive: settings.bkashEnabled,
            mode: settings.bkashSandbox ? 'sandbox' : 'live',
          };
        }
        if (gw.code === 'sslcommerz' && settings) {
          return {
            ...gw,
            isActive: settings.sslcommerzEnabled,
            mode: settings.sslcommerzSandbox ? 'sandbox' : 'live',
          };
        }
        return gw;
      });
      await db.insert(paymentGateways).values(seedRows).onConflictDoNothing();
      return await db
        .select()
        .from(paymentGateways)
        .orderBy(asc(paymentGateways.sortOrder), asc(paymentGateways.id));
    }
    return existing;
  } catch (error) {
    console.error('Failed to load payment gateways:', error);
    return DEFAULT_PAYMENT_GATEWAYS.map((gw, idx) => ({
      id: idx + 1,
      ...gw,
      merchantId: '',
      apiKey: '',
      apiSecret: '',
      webhookSecret: '',
      createdAt: new Date(),
      updatedAt: new Date(),
    }));
  }
}

export async function getVendorWorkspace(
  ownerUid: string,
  isSuperAdmin: boolean,
  requestedRestaurantId?: number | null
) {
  try {
    const rawList = isSuperAdmin
      ? await db.select().from(restaurants).orderBy(restaurants.id)
      : await db.select().from(restaurants).where(eq(restaurants.ownerUid, ownerUid)).orderBy(restaurants.id);

    const partitioned = partitionOwnedVsPartnerRestaurants(rawList, ownerUid);
    const owned = partitioned.ordered;

    const requestedMatch =
      requestedRestaurantId && Number.isInteger(requestedRestaurantId)
        ? owned.find((r) => r.id === requestedRestaurantId) ?? null
        : null;
    const target = requestedMatch ?? owned[0] ?? null;

    if (!target) {
      return {
        restaurant: null,
        restaurants: [],
        ownRestaurantIds: [] as number[],
        menuItems: [],
        orders: [],
        ledger: [],
        payouts: [],
      };
    }

    const menuItems = await db
      .select()
      .from(foodItems)
      .where(eq(foodItems.restaurantId, target.id))
      .orderBy(desc(foodItems.id));
    const restOrders = await db
      .select()
      .from(orders)
      .where(eq(orders.restaurantId, target.id))
      .orderBy(desc(orders.createdAt));
    const ledger = await db
      .select()
      .from(commissionLedger)
      .where(eq(commissionLedger.restaurantId, target.id))
      .orderBy(desc(commissionLedger.createdAt));
    const payouts = await db
      .select()
      .from(restaurantPayouts)
      .where(eq(restaurantPayouts.restaurantId, target.id))
      .orderBy(desc(restaurantPayouts.requestedAt));

    return {
      restaurant: target,
      restaurants: owned,
      ownRestaurantIds: partitioned.own.map((r) => r.id),
      menuItems,
      orders: restOrders,
      ledger,
      payouts,
    };
  } catch (error) {
    console.error('Failed to fetch vendor workspace:', error);
    throw new Error('Failed to load restaurant dashboard', { cause: error });
  }
}

export async function getRiderWorkspace(riderUid: string) {
  try {
    const [riderRows, allOrders, allRestaurants] = await Promise.all([
      db.select().from(riders).where(eq(riders.uid, riderUid)).limit(1),
      db.select().from(orders).orderBy(desc(orders.createdAt)),
      db.select({ id: restaurants.id, lat: restaurants.lat, lng: restaurants.lng }).from(restaurants),
    ]);
    const restCoordMap = new Map(allRestaurants.map((r) => [r.id, { lat: r.lat, lng: r.lng }]));
    const withRestCoords = allOrders.map((o) => {
      const coords = restCoordMap.get(o.restaurantId);
      return {
        ...o,
        restaurantLat: coords?.lat,
        restaurantLng: coords?.lng,
      };
    });
    const availableOrders = withRestCoords.filter(
      (o) =>
        o.deliveryMode === 'platform' &&
        !o.riderUid &&
        ['accepted', 'preparing', 'ready'].includes(o.status)
    );
    const assignedOrders = withRestCoords.filter((o) => o.riderUid === riderUid);
    return {
      rider: riderRows[0] ?? null,
      availableOrders,
      assignedOrders,
    };
  } catch (error) {
    console.error('Failed to load rider workspace:', error);
    throw new Error('Failed to load rider dashboard', { cause: error });
  }
}

export async function getAdminWorkspace() {
  try {
    const [
      allRestaurants,
      allProducts,
      allOrders,
      allUsers,
      allLedger,
      allPayouts,
      allCoupons,
      allRiders,
      recentAuditLogs,
      settings,
      adminPinCreds,
    ] = await Promise.all([
      db.select().from(restaurants).orderBy(desc(restaurants.createdAt)),
      db.select().from(foodItems).orderBy(desc(foodItems.id)),
      db.select().from(orders).orderBy(desc(orders.createdAt)),
      db.select().from(users).orderBy(desc(users.createdAt)),
      db.select().from(commissionLedger).orderBy(desc(commissionLedger.createdAt)),
      db.select().from(restaurantPayouts).orderBy(desc(restaurantPayouts.requestedAt)),
      db.select().from(coupons).orderBy(desc(coupons.createdAt)),
      db.select().from(riders).orderBy(desc(riders.createdAt)),
      db.select().from(auditLogs).orderBy(desc(auditLogs.createdAt)).limit(60),
      getPlatformSettingsRow(),
      db
        .select({ email: localCredentials.email })
        .from(localCredentials)
        .where(like(localCredentials.email, '__admin_pin__:%')),
    ]);

    const adminPinEmailSet = new Set<string>(PROTECTED_SUPER_ADMIN_EMAILS);
    for (const row of adminPinCreds) {
      const stripped = row.email.replace(/^__admin_pin__:/, '').trim().toLowerCase();
      if (stripped) adminPinEmailSet.add(stripped);
    }

    return {
      restaurants: allRestaurants,
      products: allProducts,
      orders: allOrders,
      users: allUsers,
      ledger: allLedger,
      payouts: allPayouts,
      coupons: allCoupons,
      riders: allRiders,
      auditLogs: recentAuditLogs,
      settings,
      adminPinEmails: Array.from(adminPinEmailSet),
    };
  } catch (error) {
    console.error('Failed to load admin workspace:', error);
    throw new Error('Failed to load admin dashboard', { cause: error });
  }
}

export async function getNotificationsForUser(uid: string, role: string) {
  try {
    return await db
      .select()
      .from(notifications)
      .where(
        or(
          eq(notifications.recipientUid, uid),
          eq(notifications.roleTarget, role),
          eq(notifications.roleTarget, 'all')
        )
      )
      .orderBy(desc(notifications.createdAt))
      .limit(25);
  } catch (error) {
    console.error('Failed to fetch notifications:', error);
    return [];
  }
}

export async function getCustomerFavorites(customerUid: string) {
  try {
    return await db
      .select()
      .from(favorites)
      .where(eq(favorites.customerUid, customerUid));
  } catch (error) {
    console.error('Failed to fetch favorites:', error);
    return [];
  }
}

export async function toggleCustomerFavorite(customerUid: string, restaurantId: number) {
  try {
    const existing = await db
      .select()
      .from(favorites)
      .where(and(eq(favorites.customerUid, customerUid), eq(favorites.restaurantId, restaurantId)));
    if (existing.length > 0) {
      await db
        .delete(favorites)
        .where(and(eq(favorites.customerUid, customerUid), eq(favorites.restaurantId, restaurantId)));
      return { favorited: false };
    }
    await db.insert(favorites).values({ customerUid, restaurantId });
    return { favorited: true };
  } catch (error) {
    console.error('Failed to toggle favorite:', error);
    throw new Error('Failed to update favorite', { cause: error });
  }
}
