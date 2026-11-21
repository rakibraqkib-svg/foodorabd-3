import 'dotenv/config';
import express from 'express';
import http from 'node:http';
import path from 'node:path';
import fs from 'node:fs';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';
import JSZip from 'jszip';
import { and, desc, eq, or, sql } from 'drizzle-orm';
import { GoogleGenAI, ThinkingLevel } from '@google/genai';
import { z } from 'zod';
import { db, hasDatabaseConfig } from './src/db/index.ts';
import {
  auditLogs,
  commissionLedger,
  coupons,
  customerAddresses,
  foodItems,
  localCredentials,
  notifications,
  orders,
  orderStatusHistory,
  partnerApiKeys,
  paymentGateways,
  platformSettings,
  restaurantPayouts,
  restaurants,
  reviews,
  riders,
  users,
} from './src/db/schema.ts';
import { ensureSchemaTables } from './src/db/ensure-schema.ts';
import { ensureDatabaseSeeded, IMG_BANGLA } from './src/db/seed.ts';
import {
  ensureDefaultPaymentGateways,
  getActiveCoupons,
  getAdminWorkspace,
  getApprovedRestaurants,
  getCustomerAddresses,
  getCustomerFavorites,
  getCustomerOrders,
  getNotificationsForUser,
  getOrderById,
  getPlatformSettingsRow,
  getRestaurantBySlug,
  getRiderWorkspace,
  getStorefrontProducts,
  getVendorWorkspace,
  toggleCustomerFavorite,
} from './src/db/queries.ts';
import {
  AuthRequest,
  getOrCreateUser,
  optionalAuth,
  requireAuth,
  requireRole,
  signSandboxToken,
  UserRole,
} from './src/middleware/auth.ts';
import { supabaseServer } from './src/lib/supabase-admin.ts';
import {
  ADMIN_PIN_DEFAULT_EMAIL,
  type AiHelpLangPreference,
  buildAiHelpSystemInstruction,
  buildRestaurantUnavailableMessage,
  buildRobotsTxt,
  buildSitemapXml,
  calculateCartItemUnitPrice,
  calculateOrderFinancials,
  canActorModifyUserAccount,
  canTransitionOrderStatus,
  DeliveryMode,
  doesEmailMatchOrder,
  estimateDeliveryFeeAndEta,
  evaluateCoupon,
  isProtectedSuperAdminEmail,
  normalizeGatewayCode,
  normalizePartnerProductInput,
  OrderStatus,
  PaymentMethod,
  toAdminPaymentGatewayView,
  toPublicPaymentGatewayView,
  validateBroadcastNotification,
} from './src/lib/marketplace-logic.ts';
import { getDeliveryProvider } from './src/services/delivery.ts';
import {
  fetchBdtExchangeRates,
  fetchDhakaWeather,
  fetchOsrmRoute,
  reverseOsmGeocode,
  searchMealDbDishes,
  searchOsmPlaces,
} from './src/services/free-apis.ts';
import {
  getEmailTransportStatus,
  sendAndLogOrderTrackingEmail,
} from './src/services/order-email.ts';
import {
  attachSseRealtimeClient,
  broadcastNotificationEvent,
  broadcastOrderEvent,
  initRealtimeWebSocketServer,
} from './src/services/realtime.ts';
import {
  getGatewayAvailability,
  initiatePaymentSession,
  isEnvConfiguredForGateway,
  validatePaymentGatewayConfiguration,
  verifyPaymentServerSide,
} from './src/services/payments.ts';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const PROJECT_ROOT =
  path.basename(__dirname) === 'api' ? path.resolve(__dirname, '..') : __dirname;
const UPLOADS_DIR = process.env.VERCEL
  ? path.join('/tmp', 'foodora-uploads')
  : path.resolve(PROJECT_ROOT, 'public', 'uploads');
try {
  fs.mkdirSync(UPLOADS_DIR, { recursive: true });
} catch {
  // ignore read-only FS in serverless runtimes
}

const app = express();
app.use(express.json({ limit: '8mb' }));
app.use('/uploads', express.static(UPLOADS_DIR));

// Ensure DB is lazily seeded once on first API hit (no eager startup probe at module load)
app.use('/api', async (req, res, next) => {
  if (req.path === '/health' || req.path === '/export/project-zip') {
    return next();
  }
  if (!hasDatabaseConfig()) {
    return res.status(503).json({
      error:
        'Database is not configured. Please add DATABASE_URL in Vercel Environment Variables and redeploy.',
    });
  }
  try {
    await ensureDatabaseSeeded();
  } catch (err) {
    console.error('Lazy database seed check failed:', err);
  }
  next();
});

// Idempotent financial settlement when order is delivered
async function settleOrderCommissionIdempotent(orderId: number) {
  await db.transaction(async (tx) => {
    const existing = await tx
      .select()
      .from(commissionLedger)
      .where(
        and(
          eq(commissionLedger.orderId, orderId),
          eq(commissionLedger.entryType, 'commission_earned')
        )
      )
      .limit(1);

    if (existing.length > 0) {
      return; // Idempotency guard: never double-count
    }

    const orderRows = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
    if (orderRows.length === 0) return;
    const order = orderRows[0];

    await tx.insert(commissionLedger).values({
      orderId: order.id,
      restaurantId: order.restaurantId,
      entryType: 'commission_earned',
      grossAmount: Math.max(0, order.subtotal - order.discountAmount),
      commissionAmount: order.platformCommission,
      netRestaurantAmount: order.restaurantEarnings,
      deliveryFeeAmount: order.deliveryFee,
      note: `Commission (${order.commissionRate}%) settled for ${order.orderNumber}`,
    });
  });
}

function getRequestOrigin(req: express.Request): string {
  const protoHeader = String(req.headers['x-forwarded-proto'] || req.protocol || 'http')
    .split(',')[0]
    .trim();
  const hostHeader = String(req.headers['x-forwarded-host'] || req.get('host') || 'localhost:3000')
    .split(',')[0]
    .trim();
  return `${protoHeader || 'http'}://${hostHeader || 'localhost:3000'}`;
}

app.get('/robots.txt', (req, res) => {
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.setHeader('Cache-Control', 'public, max-age=3600');
  res.send(buildRobotsTxt(getRequestOrigin(req)));
});

app.get('/sitemap.xml', async (req, res) => {
  try {
    if (hasDatabaseConfig()) {
      await ensureDatabaseSeeded();
    }
    const approved = hasDatabaseConfig() ? await getApprovedRestaurants() : [];
    const xml = buildSitemapXml(
      getRequestOrigin(req),
      approved.map((r) => ({ slug: r.slug, updatedAt: r.updatedAt }))
    );
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.setHeader('Cache-Control', 'public, max-age=900');
    res.send(xml);
  } catch {
    res.setHeader('Content-Type', 'application/xml; charset=utf-8');
    res.send(buildSitemapXml(getRequestOrigin(req), []));
  }
});

// ---------- Public & Health Routes ----------

app.get('/api/health', async (_req, res) => {
  res.json({
    ok: true,
    service: 'foodora-bd',
    databaseConfigured: hasDatabaseConfig(),
    timestamp: new Date().toISOString(),
  });
});

app.get('/api/public-config', async (_req, res) => {
  try {
    const [settings, gatewayRows] = await Promise.all([
      getPlatformSettingsRow(),
      ensureDefaultPaymentGateways(),
    ]);
    const paymentGatewaysList = gatewayRows.map((row) =>
      toPublicPaymentGatewayView(row, isEnvConfiguredForGateway(row.code))
    );
    res.json({
      mapsApiKey: process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY || '',
      gateways: getGatewayAvailability(),
      paymentGateways: paymentGatewaysList,
      emailTransport: getEmailTransportStatus(),
      settings,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to load public config' });
  }
});

app.get('/api/realtime/stream', async (req, res) => {
  const qs = new URLSearchParams();
  if (typeof req.query.token === 'string') qs.set('token', req.query.token);
  if (typeof req.query.orderId === 'string') qs.set('orderId', req.query.orderId);
  if (typeof req.query.trackingToken === 'string') qs.set('trackingToken', req.query.trackingToken);
  const cleanup = await attachSseRealtimeClient(res, qs);
  req.on('close', cleanup);
});

// ---------- Auth & Sandbox Personas ----------

app.post('/api/auth/sync', requireAuth, async (req: AuthRequest, res) => {
  res.json({ user: req.user });
});

app.post('/api/auth/sandbox-session', async (req, res) => {
  const requestedRole = typeof req.body?.role === 'string' ? req.body.role : '';
  if (requestedRole === 'super_admin' || requestedRole === 'admin') {
    return res.status(403).json({
      error: 'Admin and Super Admin access is restricted. Please sign in with an authorized Admin account.',
    });
  }
  const schema = z.object({
    role: z.enum(['customer', 'restaurant_owner', 'rider']),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid demo workspace role' });
  }

  const personas: Record<
    'customer' | 'restaurant_owner' | 'rider',
    { uid: string; email: string; fullName: string; role: UserRole }
  > = {
    customer: {
      uid: 'demo-customer-uid',
      email: 'customer@foodora.bd',
      fullName: 'Rahim Uddin',
      role: 'customer',
    },
    restaurant_owner: {
      uid: 'demo-vendor-uid',
      email: 'partner@sultansdine.bd',
      fullName: "Tariqul Islam (Sultan's Dine)",
      role: 'restaurant_owner',
    },
    rider: {
      uid: 'demo-rider-uid',
      email: 'rider@foodora.bd',
      fullName: 'Kamrul Hasan',
      role: 'rider',
    },
  };

  const p = personas[parsed.data.role];
  const token = signSandboxToken(p);
  res.json({ token, user: { ...p, isSandbox: true } });
});

function hashPasswordScrypt(password: string): string {
  const salt = crypto.randomBytes(16).toString('hex');
  const hash = crypto.scryptSync(password, salt, 64).toString('hex');
  return `${salt}:${hash}`;
}

function verifyPasswordScrypt(password: string, stored: string): boolean {
  const [salt, keyHex] = stored.split(':');
  if (!salt || !keyHex) return false;
  const derived = crypto.scryptSync(password, salt, 64);
  const storedBuf = Buffer.from(keyHex, 'hex');
  if (derived.length !== storedBuf.length) return false;
  return crypto.timingSafeEqual(derived, storedBuf);
}

const ADMIN_PIN_VAULT_KEY = '__admin_panel_pin__';
const ADMIN_PIN_VAULT_UID = 'admin-pin-vault';
const ADMIN_PIN_EMAIL_PREFIX = '__admin_pin__:';

function adminPinKeyForEmail(email: string): string {
  return `${ADMIN_PIN_EMAIL_PREFIX}${email.trim().toLowerCase()}`;
}

function getFallbackAdminPin(): string {
  return process.env.ADMIN_ACCESS_PIN || '2026';
}

async function verifyAdminPinValue(pin: string): Promise<boolean> {
  const rows = await db
    .select({ passwordHash: localCredentials.passwordHash })
    .from(localCredentials)
    .where(eq(localCredentials.email, ADMIN_PIN_VAULT_KEY))
    .limit(1);

  if (rows.length > 0) {
    return verifyPasswordScrypt(pin, rows[0].passwordHash);
  }

  const fallback = getFallbackAdminPin();
  const a = Buffer.from(pin, 'utf8');
  const b = Buffer.from(fallback, 'utf8');
  if (a.length !== b.length) return false;
  return crypto.timingSafeEqual(a, b);
}

async function verifyAdminPinForEmail(email: string, pin: string): Promise<boolean> {
  const normalized = email.trim().toLowerCase();
  if (!normalized) return false;

  const specificRows = await db
    .select({ passwordHash: localCredentials.passwordHash })
    .from(localCredentials)
    .where(eq(localCredentials.email, adminPinKeyForEmail(normalized)))
    .limit(1);

  if (specificRows.length > 0) {
    return verifyPasswordScrypt(pin, specificRows[0].passwordHash);
  }

  if (isProtectedSuperAdminEmail(normalized)) {
    return verifyAdminPinValue(pin);
  }

  return false;
}

app.post('/api/auth/admin-pin', async (req, res) => {
  const schema = z.object({
    pin: z.string().trim().min(4).max(16),
    email: z.string().trim().email().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please enter a valid Admin email and 4–16 character PIN.' });
  }

  const targetEmail = (parsed.data.email || ADMIN_PIN_DEFAULT_EMAIL).trim().toLowerCase();

  try {
    const valid = await verifyAdminPinForEmail(targetEmail, parsed.data.pin);
    if (!valid) {
      return res.status(401).json({ error: 'Incorrect Admin email or PIN. Please try again.' });
    }

    const existingRows = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${targetEmail}`)
      .limit(1);

    if (existingRows[0]?.status === 'suspended') {
      return res.status(403).json({ error: 'This Admin account has been suspended.' });
    }

    const assignedRole: UserRole = isProtectedSuperAdminEmail(targetEmail)
      ? 'super_admin'
      : existingRows[0]?.role === 'super_admin'
      ? 'super_admin'
      : 'admin';

    let dbUser = existingRows[0];
    if (dbUser) {
      if (dbUser.role !== assignedRole) {
        const updated = await db
          .update(users)
          .set({ role: assignedRole, updatedAt: new Date() })
          .where(eq(users.id, dbUser.id))
          .returning();
        dbUser = updated[0];
      }
    } else {
      const uid = `adm-${crypto.randomBytes(8).toString('hex')}`;
      const defaultName =
        targetEmail === ADMIN_PIN_DEFAULT_EMAIL ? 'Raqib Rony (Admin)' : targetEmail.split('@')[0];
      dbUser = await getOrCreateUser(uid, targetEmail, defaultName, assignedRole);
    }

    const token = signSandboxToken({
      uid: dbUser.uid,
      email: dbUser.email,
      fullName: dbUser.fullName,
      role: assignedRole,
      isSandbox: false,
    });

    try {
      await db.insert(auditLogs).values({
        actorUid: dbUser.uid,
        action: 'admin_pin_unlock',
        targetType: 'auth',
        targetId: dbUser.email,
        details: `Admin workspace (${assignedRole}) unlocked via Admin PIN for ${dbUser.email}`,
      });
    } catch {
      // non-fatal audit log skip
    }

    return res.json({
      token,
      user: {
        uid: dbUser.uid,
        email: dbUser.email,
        fullName: dbUser.fullName,
        role: assignedRole,
        isSandbox: false,
      },
    });
  } catch (error: any) {
    console.error('Admin PIN unlock failed:', error);
    return res.status(500).json({ error: error.message || 'Failed to verify Admin PIN' });
  }
});

app.post(
  '/api/admin/pin',
  requireAuth,
  requireRole(['super_admin']),
  async (req: AuthRequest, res) => {
    const schema = z.object({
      currentPin: z.string().trim().min(4).max(16),
      newPin: z.string().trim().min(4).max(16),
      adminEmail: z.string().trim().email().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res
        .status(400)
        .json({ error: 'Valid Admin email, current PIN, and new PIN (4–16 chars) are required.' });
    }

    const targetEmail = (parsed.data.adminEmail || ADMIN_PIN_DEFAULT_EMAIL).trim().toLowerCase();

    try {
      const valid =
        (await verifyAdminPinForEmail(req.user!.email, parsed.data.currentPin)) ||
        (await verifyAdminPinForEmail(targetEmail, parsed.data.currentPin)) ||
        (await verifyAdminPinValue(parsed.data.currentPin));
      if (!valid) {
        return res.status(401).json({ error: 'Current Admin PIN is incorrect.' });
      }

      const nextHash = hashPasswordScrypt(parsed.data.newPin);
      const pinKey = adminPinKeyForEmail(targetEmail);
      const pinUid = `admin-pin-${crypto.createHash('sha256').update(targetEmail).digest('hex').slice(0, 16)}`;

      await db
        .insert(localCredentials)
        .values({
          email: pinKey,
          uid: pinUid,
          passwordHash: nextHash,
        })
        .onConflictDoUpdate({
          target: localCredentials.email,
          set: { passwordHash: nextHash },
        });

      const existingTarget = await db
        .select()
        .from(users)
        .where(sql`lower(${users.email}) = ${targetEmail}`)
        .limit(1);

      const targetRole: UserRole = isProtectedSuperAdminEmail(targetEmail)
        ? 'super_admin'
        : existingTarget[0]?.role === 'super_admin'
        ? 'super_admin'
        : 'admin';

      if (existingTarget.length > 0) {
        if (existingTarget[0].role !== targetRole) {
          await db
            .update(users)
            .set({ role: targetRole, updatedAt: new Date() })
            .where(eq(users.id, existingTarget[0].id));
        }
      } else {
        await getOrCreateUser(
          `adm-${crypto.randomBytes(8).toString('hex')}`,
          targetEmail,
          targetEmail === ADMIN_PIN_DEFAULT_EMAIL ? 'Raqib Rony (Admin)' : targetEmail.split('@')[0],
          targetRole
        );
      }

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'admin_pin_updated',
        targetType: 'security',
        targetId: targetEmail,
        details: `Admin Panel PIN created/updated for ${targetEmail} (${targetRole})`,
      });

      return res.json({
        ok: true,
        adminEmail: targetEmail,
        message: `Admin Panel PIN saved for ${targetEmail}.`,
      });
    } catch (error: any) {
      console.error('Admin PIN update failed:', error);
      return res.status(500).json({ error: error.message || 'Failed to update Admin PIN' });
    }
  }
);

function isMissingTableError(err: any): boolean {
  const code = err?.code || err?.cause?.code;
  return code === '42P01';
}

function isUniqueViolationError(err: any): boolean {
  const code = err?.code || err?.cause?.code;
  return code === '23505';
}

app.post('/api/auth/register', async (req, res) => {
  const schema = z.object({
    fullName: z.string().trim().min(2).max(100),
    email: z.string().trim().email(),
    password: z.string().min(6).max(128),
    role: z.enum(['customer', 'restaurant_owner', 'rider']).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please provide a valid name, email, and password (min 6 chars).' });
  }

  const emailLower = parsed.data.email.trim().toLowerCase();
  const fullName = parsed.data.fullName.trim();
  const requestedRole = parsed.data.role || 'customer';

  const attemptRegister = async () => {
    const existingCred = await db
      .select({ uid: localCredentials.uid })
      .from(localCredentials)
      .where(eq(localCredentials.email, emailLower))
      .limit(1);
    if (existingCred.length > 0) {
      return { status: 409 as const, body: { error: 'An account with this email already exists. Please sign in.' } };
    }

    const existingUser = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${emailLower}`)
      .limit(1);
    if (existingUser.length > 0) {
      return {
        status: 409 as const,
        body: {
          error: 'An account with this email already exists. Please sign in with Google or your existing credentials.',
        },
      };
    }

    const uid = `usr-${crypto.randomBytes(8).toString('hex')}`;
    const role: UserRole = isProtectedSuperAdminEmail(emailLower) ? 'super_admin' : requestedRole;
    const passwordHash = hashPasswordScrypt(parsed.data.password);

    await db.transaction(async (tx) => {
      await tx.insert(localCredentials).values({
        email: emailLower,
        uid,
        passwordHash,
      });

      await tx.insert(users).values({
        uid,
        email: emailLower,
        fullName,
        role,
      });

      if (role === 'rider') {
        await tx
          .insert(riders)
          .values({
            uid,
            fullName,
            phone: '+8801700000000',
            email: emailLower,
            vehicleType: 'Motorbike',
            zone: 'Gulshan 2',
            isAvailable: true,
            status: 'approved',
          })
          .onConflictDoNothing();
      }
    });

    const token = signSandboxToken({ uid, email: emailLower, fullName, role, isSandbox: false });
    return {
      status: 201 as const,
      body: {
        token,
        user: { uid, email: emailLower, fullName, role, isSandbox: false },
      },
    };
  };

  try {
    let result;
    try {
      result = await attemptRegister();
    } catch (err: any) {
      if (isMissingTableError(err)) {
        await ensureSchemaTables();
        result = await attemptRegister();
      } else {
        throw err;
      }
    }
    return res.status(result.status).json(result.body);
  } catch (error: any) {
    if (isUniqueViolationError(error)) {
      return res.status(409).json({ error: 'An account with this email already exists. Please sign in.' });
    }
    console.error('Register failed:', error);
    return res.status(500).json({ error: error.message || 'Registration failed' });
  }
});

app.post('/api/auth/login', async (req, res) => {
  const schema = z.object({
    email: z.string().trim().email(),
    password: z.string().min(1),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please enter a valid email and password.' });
  }

  const emailLower = parsed.data.email.trim().toLowerCase();

  const attemptLogin = async () => {
    const credRows = await db
      .select()
      .from(localCredentials)
      .where(eq(localCredentials.email, emailLower))
      .limit(1);

    if (credRows.length === 0) {
      // Fallback: check if user registered via Supabase Email & Password
      try {
        const { data: supaAuth, error: supaErr } = await supabaseServer.auth.signInWithPassword({
          email: emailLower,
          password: parsed.data.password,
        });
        if (!supaErr && supaAuth?.user) {
          const meta = (supaAuth.user.user_metadata || {}) as Record<string, unknown>;
          const metaName =
            (typeof meta.full_name === 'string' && meta.full_name.trim()) ||
            (typeof meta.name === 'string' && meta.name.trim()) ||
            emailLower.split('@')[0];
          const dbUser = await getOrCreateUser(supaAuth.user.id, emailLower, metaName, 'customer');
          if (dbUser.status === 'suspended') {
            return { status: 403 as const, body: { error: 'This account has been suspended by an administrator.' } };
          }
          const role = (dbUser.role as UserRole) || 'customer';
          const token = signSandboxToken({
            uid: dbUser.uid,
            email: dbUser.email,
            fullName: dbUser.fullName,
            role,
            isSandbox: false,
          });
          return {
            status: 200 as const,
            body: {
              token,
              user: { uid: dbUser.uid, email: dbUser.email, fullName: dbUser.fullName, role, isSandbox: false },
            },
          };
        }
      } catch {
        // ignore Supabase fallback network error and return 401
      }
      return {
        status: 401 as const,
        body: { error: 'No password account found for this email. Try Google Sign-In or Create Account.' },
      };
    }

    const { uid, passwordHash: storedHash } = credRows[0];
    if (!verifyPasswordScrypt(parsed.data.password, storedHash)) {
      return { status: 401 as const, body: { error: 'Incorrect password. Please try again.' } };
    }

    const userRows = await db.select().from(users).where(eq(users.uid, uid)).limit(1);
    const dbUser = userRows[0];
    if (dbUser?.status === 'suspended') {
      return { status: 403 as const, body: { error: 'This account has been suspended by an administrator.' } };
    }

    const role: UserRole =
      (dbUser?.role as UserRole) || (isProtectedSuperAdminEmail(emailLower) ? 'super_admin' : 'customer');
    const fullName = dbUser?.fullName || emailLower.split('@')[0];

    const token = signSandboxToken({ uid, email: emailLower, fullName, role, isSandbox: false });
    return {
      status: 200 as const,
      body: {
        token,
        user: { uid, email: emailLower, fullName, role, isSandbox: false },
      },
    };
  };

  try {
    let result;
    try {
      result = await attemptLogin();
    } catch (err: any) {
      if (isMissingTableError(err)) {
        await ensureSchemaTables();
        result = await attemptLogin();
      } else {
        throw err;
      }
    }
    return res.status(result.status).json(result.body);
  } catch (error: any) {
    console.error('Login failed:', error);
    return res.status(500).json({ error: error.message || 'Sign in failed' });
  }
});

const PW_RESET_EMAIL_PREFIX = '__pw_reset__:';
function pwResetKeyForEmail(email: string): string {
  return `${PW_RESET_EMAIL_PREFIX}${email.trim().toLowerCase()}`;
}

app.post('/api/auth/forgot-password', async (req, res) => {
  const schema = z.object({
    email: z.string().trim().email(),
    redirectTo: z.string().url().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  const emailLower = parsed.data.email.trim().toLowerCase();

  try {
    const [existingUsers, existingCreds] = await Promise.all([
      db.select().from(users).where(sql`lower(${users.email}) = ${emailLower}`).limit(1),
      db.select().from(localCredentials).where(eq(localCredentials.email, emailLower)).limit(1),
    ]);

    const userRow = existingUsers[0];
    if (!userRow && existingCreds.length === 0) {
      return res.status(404).json({
        error: 'No account found with this email address. Please create an account first.',
      });
    }

    if (userRow?.status === 'suspended') {
      return res.status(403).json({ error: 'This account has been suspended by an administrator.' });
    }

    const isAdminAccount =
      isProtectedSuperAdminEmail(emailLower) ||
      userRow?.role === 'admin' ||
      userRow?.role === 'super_admin';

    // Best-effort Supabase email recovery trigger (works for Supabase-registered emails)
    try {
      await supabaseServer.auth.resetPasswordForEmail(
        emailLower,
        parsed.data.redirectTo ? { redirectTo: parsed.data.redirectTo } : undefined
      );
    } catch {
      // non-fatal if Supabase email quota or non-Supabase user
    }

    if (isAdminAccount) {
      return res.json({
        ok: true,
        mode: 'admin_pin_or_email',
        isAdminAccount: true,
        message:
          'Admin account verified. Enter your Admin PIN below (or open the password reset link in your email) to set a new password.',
      });
    }

    const otp = String(crypto.randomInt(100000, 1000000));
    const expiresAt = Date.now() + 15 * 60 * 1000;
    const otpHash = hashPasswordScrypt(otp);
    const resetKey = pwResetKeyForEmail(emailLower);
    const resetUid = `pw-reset-${crypto.createHash('sha256').update(emailLower).digest('hex').slice(0, 16)}`;

    await db
      .insert(localCredentials)
      .values({
        email: resetKey,
        uid: resetUid,
        passwordHash: `${expiresAt}|${otpHash}`,
      })
      .onConflictDoUpdate({
        target: localCredentials.email,
        set: { passwordHash: `${expiresAt}|${otpHash}` },
      });

    // If Resend email transport is configured, send real email and do not expose code in JSON
    if (process.env.RESEND_API_KEY) {
      try {
        const mailRes = await fetch('https://api.resend.com/emails', {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            from: process.env.RESEND_FROM_EMAIL || 'Foodora BD <no-reply@foodora.bd>',
            to: [emailLower],
            subject: 'Foodora BD Password Reset Code',
            html: `<p>Your Foodora BD password reset code is <strong>${otp}</strong>. It expires in 15 minutes.</p>`,
          }),
        });
        if (mailRes.ok) {
          return res.json({
            ok: true,
            mode: 'email',
            isAdminAccount: false,
            message: 'A 6-digit password reset code has been sent to your email address.',
          });
        }
      } catch {
        // fallback cleanly to preview verification flow below
      }
    }

    return res.json({
      ok: true,
      mode: 'preview',
      isAdminAccount: false,
      previewCode: otp,
      message:
        'Verification code ready. Enter the 6-digit code and your new password below (valid for 15 minutes).',
    });
  } catch (error: any) {
    console.error('Forgot password error:', error);
    return res.status(500).json({ error: error.message || 'Failed to initiate password reset' });
  }
});

app.post('/api/auth/reset-password', async (req, res) => {
  const schema = z.object({
    email: z.string().trim().email(),
    code: z.string().trim().min(4).max(16),
    newPassword: z.string().min(6).max(128),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({
      error: 'Please enter a valid email, verification code, and new password (min 6 characters).',
    });
  }

  const emailLower = parsed.data.email.trim().toLowerCase();

  try {
    const [existingUsers, existingCreds] = await Promise.all([
      db.select().from(users).where(sql`lower(${users.email}) = ${emailLower}`).limit(1),
      db.select().from(localCredentials).where(eq(localCredentials.email, emailLower)).limit(1),
    ]);

    const userRow = existingUsers[0];
    if (!userRow && existingCreds.length === 0) {
      return res.status(404).json({ error: 'Account not found for this email.' });
    }
    if (userRow?.status === 'suspended') {
      return res.status(403).json({ error: 'This account has been suspended by an administrator.' });
    }

    const isAdminAccount =
      isProtectedSuperAdminEmail(emailLower) ||
      userRow?.role === 'admin' ||
      userRow?.role === 'super_admin';

    if (isAdminAccount) {
      const validAdminPin = await verifyAdminPinForEmail(emailLower, parsed.data.code);
      if (!validAdminPin) {
        return res.status(401).json({
          error: 'Incorrect Admin PIN. Enter your Admin PIN to reset an Admin password.',
        });
      }
    } else {
      const resetKey = pwResetKeyForEmail(emailLower);
      const tokenRows = await db
        .select()
        .from(localCredentials)
        .where(eq(localCredentials.email, resetKey))
        .limit(1);

      if (tokenRows.length === 0) {
        return res.status(401).json({
          error: 'Reset code not found or already used. Please request a new code.',
        });
      }

      const sepIdx = tokenRows[0].passwordHash.indexOf('|');
      const expMs = Number(sepIdx > 0 ? tokenRows[0].passwordHash.slice(0, sepIdx) : '0');
      const storedOtpHash = sepIdx > 0 ? tokenRows[0].passwordHash.slice(sepIdx + 1) : '';
      if (!expMs || expMs < Date.now()) {
        await db.delete(localCredentials).where(eq(localCredentials.email, resetKey));
        return res.status(401).json({ error: 'Reset code has expired. Please request a new one.' });
      }
      if (!verifyPasswordScrypt(parsed.data.code, storedOtpHash)) {
        return res.status(401).json({ error: 'Invalid verification code. Please check and try again.' });
      }
    }

    const uid =
      userRow?.uid || existingCreds[0]?.uid || `usr-${crypto.randomBytes(8).toString('hex')}`;
    const role: UserRole = isProtectedSuperAdminEmail(emailLower)
      ? 'super_admin'
      : ((userRow?.role as UserRole) || 'customer');
    const fullName = userRow?.fullName || emailLower.split('@')[0];
    const nextPasswordHash = hashPasswordScrypt(parsed.data.newPassword);

    await db.transaction(async (tx) => {
      await tx
        .insert(localCredentials)
        .values({
          email: emailLower,
          uid,
          passwordHash: nextPasswordHash,
        })
        .onConflictDoUpdate({
          target: localCredentials.email,
          set: { passwordHash: nextPasswordHash },
        });

      if (!userRow) {
        await tx
          .insert(users)
          .values({
            uid,
            email: emailLower,
            fullName,
            role,
          })
          .onConflictDoNothing();
      }

      await tx.delete(localCredentials).where(eq(localCredentials.email, pwResetKeyForEmail(emailLower)));
    });

    try {
      await db.insert(auditLogs).values({
        actorUid: uid,
        action: 'password_reset',
        targetType: 'auth',
        targetId: emailLower,
        details: `Password updated via recovery flow for ${emailLower}`,
      });
    } catch {
      // non-fatal
    }

    const token = signSandboxToken({ uid, email: emailLower, fullName, role, isSandbox: false });
    return res.json({
      ok: true,
      token,
      user: { uid, email: emailLower, fullName, role, isSandbox: false },
    });
  } catch (error: any) {
    console.error('Reset password error:', error);
    return res.status(500).json({ error: error.message || 'Failed to reset password' });
  }
});

app.post('/api/auth/sync-password', requireAuth, async (req: AuthRequest, res) => {
  const schema = z.object({
    newPassword: z.string().min(6).max(128),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Password must be at least 6 characters.' });
  }

  try {
    const emailLower = req.user!.email.trim().toLowerCase();
    const nextHash = hashPasswordScrypt(parsed.data.newPassword);
    await db
      .insert(localCredentials)
      .values({
        email: emailLower,
        uid: req.user!.uid,
        passwordHash: nextHash,
      })
      .onConflictDoUpdate({
        target: localCredentials.email,
        set: { passwordHash: nextHash },
      });
    return res.json({ ok: true });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to sync password' });
  }
});

// ---------- Storefront & Discovery ----------

app.get('/api/restaurants', async (_req, res) => {
  try {
    const list = await getApprovedRestaurants();
    res.json({ restaurants: list });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch restaurants' });
  }
});

app.get('/api/products', async (_req, res) => {
  try {
    const products = await getStorefrontProducts();
    res.json({ products });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch storefront products' });
  }
});

app.get('/api/restaurants/:slug', async (req, res) => {
  try {
    const data = await getRestaurantBySlug(req.params.slug);
    if (!data) {
      return res.status(404).json({ error: 'Restaurant not found' });
    }
    res.json(data);
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch restaurant' });
  }
});

app.get('/api/coupons', async (_req, res) => {
  try {
    const list = await getActiveCoupons();
    res.json({ coupons: list });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch coupons' });
  }
});

app.post('/api/coupons/validate', async (req, res) => {
  const schema = z.object({
    code: z.string().min(2),
    subtotal: z.number().nonnegative(),
    deliveryFee: z.number().nonnegative(),
    restaurantId: z.number().int().positive(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid coupon request' });
  }

  try {
    const rows = await db
      .select()
      .from(coupons)
      .where(eq(coupons.code, parsed.data.code.trim().toUpperCase()))
      .limit(1);

    if (rows.length === 0) {
      return res.status(404).json({ valid: false, reason: 'Coupon code not found' });
    }

    const c = rows[0];
    const result = evaluateCoupon(
      {
        code: c.code,
        type: c.type as 'percentage' | 'fixed' | 'free_delivery',
        value: c.value,
        minOrder: c.minOrder,
        maxDiscount: c.maxDiscount,
        restaurantId: c.restaurantId,
        isActive: c.isActive,
        usedCount: c.usedCount,
        usageLimit: c.usageLimit,
      },
      parsed.data.subtotal,
      parsed.data.deliveryFee,
      parsed.data.restaurantId
    );
    res.json({ ...result, coupon: c });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Coupon check failed' });
  }
});

app.get('/api/free/weather', async (req, res) => {
  const lat = Number(req.query.lat) || 23.7949;
  const lng = Number(req.query.lng) || 90.4144;
  const weather = await fetchDhakaWeather(lat, lng);
  res.json({ weather });
});

app.get('/api/free/geocode', async (req, res) => {
  const q = String(req.query.q || '').trim();
  if (!q) return res.json({ places: [] });
  const places = await searchOsmPlaces(q);
  res.json({ places });
});

app.get('/api/free/reverse-geocode', async (req, res) => {
  const lat = Number(req.query.lat) || 23.7949;
  const lng = Number(req.query.lng) || 90.4144;
  const lang = req.query.lang === 'bn' ? 'bn' : 'en';
  const result = await reverseOsmGeocode(lat, lng, lang);
  res.json(result);
});

app.get('/api/free/route', async (req, res) => {
  const fromLat = Number(req.query.fromLat);
  const fromLng = Number(req.query.fromLng);
  const toLat = Number(req.query.toLat);
  const toLng = Number(req.query.toLng);
  if (![fromLat, fromLng, toLat, toLng].every(Number.isFinite)) {
    return res.status(400).json({ error: 'Invalid coordinates' });
  }
  const route = await fetchOsrmRoute(fromLat, fromLng, toLat, toLng);
  res.json({ route });
});

app.get('/api/free/rates', async (_req, res) => {
  const rates = await fetchBdtExchangeRates();
  res.json(rates);
});

app.get('/api/free/meals', async (req, res) => {
  const q = String(req.query.q || 'biryani').trim();
  const meals = await searchMealDbDishes(q);
  res.json({ meals });
});

app.post('/api/delivery/quote', async (req, res) => {
  const schema = z.object({
    restaurantId: z.number().int().positive(),
    dropoffLat: z.number(),
    dropoffLng: z.number(),
    deliveryMode: z.enum(['platform', 'restaurant', 'third_party']),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid delivery quote parameters' });
  }

  try {
    const rows = await db
      .select()
      .from(restaurants)
      .where(eq(restaurants.id, parsed.data.restaurantId))
      .limit(1);
    if (rows.length === 0) return res.status(404).json({ error: 'Restaurant not found' });
    const rest = rows[0];
    const provider = getDeliveryProvider(parsed.data.deliveryMode);
    const [baseQuote, osrmRoute, weather] = await Promise.all([
      provider.getQuote({
        orderNumber: 'QUOTE',
        restaurantName: rest.name,
        pickupAddress: rest.address,
        pickupLat: rest.lat,
        pickupLng: rest.lng,
        dropoffAddress: 'Customer Pin',
        dropoffArea: rest.area,
        dropoffLat: parsed.data.dropoffLat,
        dropoffLng: parsed.data.dropoffLng,
        customerName: 'Guest',
        customerPhone: '',
        baseFee: rest.deliveryFee,
        orderValue: 0,
      }),
      fetchOsrmRoute(rest.lat, rest.lng, parsed.data.dropoffLat, parsed.data.dropoffLng),
      fetchDhakaWeather(parsed.data.dropoffLat, parsed.data.dropoffLng),
    ]);

    const baseFeeInput =
      parsed.data.deliveryMode === 'third_party' ? Math.max(55, rest.deliveryFee) : rest.deliveryFee;
    const roadCalc = estimateDeliveryFeeAndEta(
      osrmRoute.distanceKm,
      baseFeeInput,
      parsed.data.deliveryMode
    );

    res.json({
      quote: {
        ...baseQuote,
        distanceKm: osrmRoute.distanceKm,
        fee: roadCalc.fee,
        etaMinutes: Math.max(12, osrmRoute.drivingMinutes + 12 + weather.rainBufferMin),
        routeSource: osrmRoute.source,
        rainBufferMin: weather.rainBufferMin,
        weatherLabel: weather.labelEn,
      },
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to compute delivery quote' });
  }
});

// ---------- Customer Routes ----------

app.get('/api/customer/addresses', requireAuth, async (req: AuthRequest, res) => {
  try {
    const addresses = await getCustomerAddresses(req.user!.uid);
    res.json({ addresses });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/customer/addresses', requireAuth, async (req: AuthRequest, res) => {
  const schema = z.object({
    label: z.string().min(1).max(60),
    area: z.string().min(2).max(60),
    addressLine: z.string().min(4).max(200),
    lat: z.number(),
    lng: z.number(),
    instructions: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please complete all required address fields' });
  }
  try {
    const inserted = await db
      .insert(customerAddresses)
      .values({
        userUid: req.user!.uid,
        label: parsed.data.label,
        area: parsed.data.area,
        addressLine: parsed.data.addressLine,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        instructions: parsed.data.instructions || '',
        isDefault: true,
      })
      .returning();
    res.status(201).json({ address: inserted[0] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/customer/favorites', requireAuth, async (req: AuthRequest, res) => {
  const list = await getCustomerFavorites(req.user!.uid);
  res.json({ favorites: list });
});

app.post('/api/customer/favorites', requireAuth, async (req: AuthRequest, res) => {
  const schema = z.object({ restaurantId: z.number().int().positive() });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid restaurantId' });
  try {
    const result = await toggleCustomerFavorite(req.user!.uid, parsed.data.restaurantId);
    res.json(result);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/customer/orders', requireAuth, async (req: AuthRequest, res) => {
  try {
    const list = await getCustomerOrders(req.user!.uid);
    res.json({ orders: list });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get('/api/orders/track-by-email', async (req, res) => {
  const email = String(req.query.email || '').trim().toLowerCase();
  const orderNumber = String(req.query.orderNumber || '').trim().toUpperCase();
  if (!email || !email.includes('@')) {
    return res.status(400).json({ error: 'Please provide a valid email address.' });
  }

  try {
    let matched: Array<typeof orders.$inferSelect> = [];
    if (orderNumber) {
      matched = await db
        .select()
        .from(orders)
        .where(sql`upper(${orders.orderNumber}) = ${orderNumber}`)
        .limit(1);

      if (matched.length === 0) {
        return res.status(404).json({ error: `Order ${orderNumber} was not found.` });
      }
      const ord = matched[0];
      let matches = doesEmailMatchOrder(ord.customerEmail, email);
      if (!matches && ord.customerUid) {
        const custUsers = await db.select().from(users).where(eq(users.uid, ord.customerUid)).limit(1);
        if (custUsers[0] && doesEmailMatchOrder(custUsers[0].email, email)) {
          matches = true;
        }
      }
      if (!matches) {
        return res.status(403).json({
          error: 'The email address does not match the tracking email on this order.',
        });
      }
    } else {
      matched = await db
        .select()
        .from(orders)
        .where(sql`lower(${orders.customerEmail}) = ${email}`)
        .orderBy(desc(orders.createdAt))
        .limit(1);

      if (matched.length === 0) {
        const custUsers = await db
          .select()
          .from(users)
          .where(sql`lower(${users.email}) = ${email}`)
          .limit(1);
        if (custUsers[0]) {
          matched = await db
            .select()
            .from(orders)
            .where(eq(orders.customerUid, custUsers[0].uid))
            .orderBy(desc(orders.createdAt))
            .limit(1);
        }
      }

      if (matched.length === 0) {
        return res.status(404).json({ error: `No orders found for ${email}.` });
      }
    }

    const detail = await getOrderById(matched[0].id);
    if (!detail) return res.status(404).json({ error: 'Order not found' });
    return res.json(detail);
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to look up order by email' });
  }
});

app.get('/api/orders/:id', optionalAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid order ID' });
  }
  try {
    const detail = await getOrderById(id);
    if (!detail) return res.status(404).json({ error: 'Order not found' });
    const providedToken = String(req.query.token || '').trim();
    const isAdmin = req.user?.role === 'super_admin' || req.user?.role === 'admin';
    const isOwner = Boolean(req.user?.uid && req.user.uid === detail.order.customerUid);
    const hasTokenAccess = Boolean(
      providedToken && detail.order.trackingToken && providedToken === detail.order.trackingToken
    );
    if (!isAdmin && !isOwner && !hasTokenAccess) {
      return res.json({
        ...detail,
        order: {
          ...detail.order,
          trackingToken: '',
        },
        emailLogs: [],
      });
    }
    res.json(detail);
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.post('/api/orders/:id/send-tracking-email', optionalAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) {
    return res.status(400).json({ error: 'Invalid order ID' });
  }
  const schema = z.object({
    email: z.string().trim().email().optional(),
    token: z.string().optional(),
  });
  const parsed = schema.safeParse(req.body || {});
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please enter a valid email address.' });
  }

  try {
    const orderRows = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (orderRows.length === 0) return res.status(404).json({ error: 'Order not found' });
    let order = orderRows[0];

    const isAdmin = req.user?.role === 'super_admin' || req.user?.role === 'admin';
    const isOwner = Boolean(req.user?.uid && req.user.uid === order.customerUid);
    const hasToken = Boolean(
      parsed.data.token && order.trackingToken && parsed.data.token.trim() === order.trackingToken
    );

    if (!isAdmin && !isOwner && !hasToken) {
      return res.status(403).json({ error: 'Sign in or use your order tracking token to email updates.' });
    }

    const targetEmail = (parsed.data.email || order.customerEmail || req.user?.email || '')
      .trim()
      .toLowerCase();
    if (!targetEmail || !targetEmail.includes('@')) {
      return res.status(400).json({ error: 'Please provide an email address for tracking updates.' });
    }

    const nextToken = order.trackingToken || crypto.randomBytes(12).toString('hex');
    if (targetEmail !== order.customerEmail || nextToken !== order.trackingToken) {
      const upd = await db
        .update(orders)
        .set({ customerEmail: targetEmail, trackingToken: nextToken, updatedAt: new Date() })
        .where(eq(orders.id, order.id))
        .returning();
      order = upd[0] || order;
    }

    const [restRows, riderRows] = await Promise.all([
      db.select({ lat: restaurants.lat, lng: restaurants.lng }).from(restaurants).where(eq(restaurants.id, order.restaurantId)).limit(1),
      order.riderUid
        ? db.select({ phone: riders.phone }).from(riders).where(eq(riders.uid, order.riderUid)).limit(1)
        : Promise.resolve([]),
    ]);

    const emailLog = await sendAndLogOrderTrackingEmail({
      origin: getRequestOrigin(req),
      orderId: order.id,
      orderNumber: order.orderNumber,
      trackingToken: nextToken,
      customerName: order.customerName,
      customerEmail: targetEmail,
      restaurantName: order.restaurantName,
      deliveryArea: order.deliveryArea,
      deliveryAddress: order.deliveryAddress,
      totalAmount: order.totalAmount,
      paymentMethod: order.paymentMethod,
      paymentStatus: order.paymentStatus,
      status: order.status,
      statusEvent: order.status,
      statusNote: `Live tracking update requested (${order.status.replace(/_/g, ' ')})`,
      riderName: order.riderName,
      riderPhone: riderRows[0]?.phone || null,
      etaMinutes: order.estimatedMinutes,
      items: order.itemsSnapshotJson,
    });

    return res.json({
      ok: true,
      customerEmail: targetEmail,
      emailLog,
      trackingUrl: emailLog?.trackingUrl || '',
      restaurantLat: restRows[0]?.lat ?? null,
    });
  } catch (error: any) {
    return res.status(500).json({ error: error.message || 'Failed to send tracking email' });
  }
});

// Transactional Checkout & Order Creation
app.post('/api/orders', requireAuth, async (req: AuthRequest, res) => {
  const schema = z.object({
    restaurantId: z.number().int().positive(),
    customerName: z.string().min(2),
    customerPhone: z.string().min(6),
    customerEmail: z.string().trim().email().optional().or(z.literal('')),
    deliveryAddress: z.string().min(5),
    deliveryArea: z.string().min(2),
    deliveryLat: z.number(),
    deliveryLng: z.number(),
    deliveryInstructions: z.string().optional(),
    deliveryMode: z.enum(['platform', 'restaurant', 'third_party']),
    paymentMethod: z.string().min(2).max(32),
    couponCode: z.string().optional(),
    items: z
      .array(
        z.object({
          foodItemId: z.number().int().positive(),
          quantity: z.number().int().min(1).max(50),
          variationName: z.string().optional(),
          addons: z.array(z.string()).default([]),
          specialInstructions: z.string().optional(),
        })
      )
      .min(1),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Invalid order payload', details: parsed.error.flatten() });
  }

  const input = parsed.data;
  const resolvedCustomerEmail = (
    input.customerEmail?.trim() ||
    (req.user!.email && req.user!.email.includes('@') ? req.user!.email : '')
  )
    .trim()
    .toLowerCase();
  const trackingToken = crypto.randomBytes(12).toString('hex');
  const normalizedMethod = normalizeGatewayCode(input.paymentMethod);

  try {
    const gatewayRows = await ensureDefaultPaymentGateways();
    const matchedGateway = gatewayRows.find(
      (g) => normalizeGatewayCode(g.code) === normalizedMethod && g.isActive
    );
    if (!matchedGateway) {
      return res.status(400).json({
        error: `Selected payment method "${input.paymentMethod}" is currently inactive or unsupported.`,
      });
    }

    const created = await db.transaction(async (tx) => {
      // 1. Load authoritative restaurant record
      const restRows = await tx
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, input.restaurantId))
        .limit(1);
      if (restRows.length === 0) throw new Error('Restaurant not found');
      const rest = restRows[0];
      if (rest.status !== 'approved' || !rest.isOpen) {
        throw new Error(
          buildRestaurantUnavailableMessage(rest.name, rest.status, rest.isOpen, 'en')
        );
      }

      // 2. Load authoritative menu items & calculate snapshot totals
      const dbMenu = await tx
        .select()
        .from(foodItems)
        .where(eq(foodItems.restaurantId, rest.id));

      const snapshotItems: Array<{
        foodItemId: number;
        name: string;
        nameBn: string;
        quantity: number;
        unitPrice: number;
        variation?: string;
        addons: Array<{ name: string; price: number }>;
        specialInstructions?: string;
        lineTotal: number;
      }> = [];

      let subtotal = 0;

      for (const reqItem of input.items) {
        const found = dbMenu.find((m) => m.id === reqItem.foodItemId);
        if (!found) {
          throw new Error(`Menu item #${reqItem.foodItemId} does not belong to ${rest.name}`);
        }
        if (!found.inStock || !found.isAvailable) {
          throw new Error(`"${found.name}" is currently out of stock`);
        }

        const matchedVar = (found.variationsJson || []).find(
          (v) => v.name === reqItem.variationName
        );
        const selectedAddons = (found.addonsJson || []).filter((a) =>
          reqItem.addons.includes(a.name)
        );

        const unitPrice = calculateCartItemUnitPrice({
          basePrice: found.price,
          discountPrice: found.discountPrice,
          variationDelta: matchedVar?.priceDelta ?? 0,
          addons: selectedAddons,
        });

        const lineTotal = unitPrice * reqItem.quantity;
        subtotal += lineTotal;

        snapshotItems.push({
          foodItemId: found.id,
          name: found.name,
          nameBn: found.nameBn,
          quantity: reqItem.quantity,
          unitPrice,
          variation: matchedVar?.name,
          addons: selectedAddons,
          specialInstructions: reqItem.specialInstructions,
          lineTotal,
        });
      }

      if (subtotal < rest.minOrder) {
        throw new Error(`Minimum order for ${rest.name} is ৳${rest.minOrder}`);
      }

      // 3. Delivery quote via modular DeliveryProvider
      const provider = getDeliveryProvider(input.deliveryMode as DeliveryMode);
      const quote = await provider.getQuote({
        orderNumber: 'NEW',
        restaurantName: rest.name,
        pickupAddress: rest.address,
        pickupLat: rest.lat,
        pickupLng: rest.lng,
        dropoffAddress: input.deliveryAddress,
        dropoffArea: input.deliveryArea,
        dropoffLat: input.deliveryLat,
        dropoffLng: input.deliveryLng,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        baseFee: rest.deliveryFee,
        orderValue: subtotal,
      });

      // 4. Coupon evaluation
      let discountAmount = 0;
      let deliveryFeeAfterCoupon = quote.fee;
      let appliedCouponCode = '';

      if (input.couponCode && input.couponCode.trim()) {
        const cRows = await tx
          .select()
          .from(coupons)
          .where(eq(coupons.code, input.couponCode.trim().toUpperCase()))
          .limit(1);
        if (cRows.length > 0) {
          const c = cRows[0];
          const evalRes = evaluateCoupon(
            {
              code: c.code,
              type: c.type as 'percentage' | 'fixed' | 'free_delivery',
              value: c.value,
              minOrder: c.minOrder,
              maxDiscount: c.maxDiscount,
              restaurantId: c.restaurantId,
              isActive: c.isActive,
              usedCount: c.usedCount,
              usageLimit: c.usageLimit,
            },
            subtotal,
            quote.fee,
            rest.id
          );
          if (evalRes.valid) {
            discountAmount = evalRes.discountAmount;
            deliveryFeeAfterCoupon = evalRes.deliveryFeeAfterCoupon;
            appliedCouponCode = c.code;
            await tx
              .update(coupons)
              .set({ usedCount: sql`${coupons.usedCount} + 1` })
              .where(eq(coupons.id, c.id));
          }
        }
      }

      const settings = await tx.select().from(platformSettings).limit(1);
      const serviceFee = settings[0]?.serviceFee ?? 10;

      // 5. Financial calculations
      const financials = calculateOrderFinancials({
        subtotal,
        discountAmount,
        deliveryFee: deliveryFeeAfterCoupon,
        serviceFee,
        commissionType: (rest.commissionType as 'percentage' | 'fixed') || 'percentage',
        commissionRate: Number(rest.commissionRate) || 15,
        fixedCommission: rest.fixedCommission || 0,
      });

      const orderNumber = `FD-BD-${Math.floor(10000 + Math.random() * 89999)}`;
      const paymentInit = initiatePaymentSession(
        normalizedMethod as PaymentMethod,
        orderNumber,
        financials.totalPayable,
        matchedGateway
      );
      const deliveryDispatch = await provider.createDelivery({
        orderNumber,
        restaurantName: rest.name,
        pickupAddress: rest.address,
        pickupLat: rest.lat,
        pickupLng: rest.lng,
        dropoffAddress: input.deliveryAddress,
        dropoffArea: input.deliveryArea,
        dropoffLat: input.deliveryLat,
        dropoffLng: input.deliveryLng,
        customerName: input.customerName,
        customerPhone: input.customerPhone,
        baseFee: deliveryFeeAfterCoupon,
        orderValue: financials.totalPayable,
      });

      const insertedOrders = await tx
        .insert(orders)
        .values({
          orderNumber,
          customerUid: req.user!.uid,
          customerName: input.customerName,
          customerPhone: input.customerPhone,
          customerEmail: resolvedCustomerEmail,
          trackingToken,
          restaurantId: rest.id,
          restaurantName: rest.name,
          deliveryAddress: input.deliveryAddress,
          deliveryArea: input.deliveryArea,
          deliveryLat: input.deliveryLat,
          deliveryLng: input.deliveryLng,
          deliveryInstructions: input.deliveryInstructions || '',
          deliveryMode: input.deliveryMode,
          deliveryProvider: deliveryDispatch.provider,
          consignmentId: deliveryDispatch.consignmentId,
          paymentMethod: normalizedMethod,
          paymentStatus: 'pending',
          paymentTxId: paymentInit.transactionId,
          subtotal: financials.subtotal,
          discountAmount: financials.discountAmount,
          couponCode: appliedCouponCode,
          deliveryFee: financials.deliveryFee,
          serviceFee: financials.serviceFee,
          taxAmount: financials.taxAmount,
          totalAmount: financials.totalPayable,
          commissionRate: rest.commissionRate,
          platformCommission: financials.platformCommission,
          restaurantEarnings: financials.restaurantEarnings,
          status: 'confirmed',
          estimatedMinutes: quote.etaMinutes,
          itemsSnapshotJson: snapshotItems,
        })
        .returning();

      const newOrder = insertedOrders[0];

      await tx.insert(orderStatusHistory).values({
        orderId: newOrder.id,
        status: 'confirmed',
        note: `Order placed via ${input.paymentMethod.toUpperCase()} (${deliveryDispatch.provider})`,
        actorUid: req.user!.uid,
      });

      await tx.insert(notifications).values([
        {
          recipientUid: rest.ownerUid,
          roleTarget: 'restaurant_owner',
          title: `New Order ${newOrder.orderNumber}`,
          message: `৳${newOrder.totalAmount} order from ${input.customerName} (${input.deliveryArea})`,
          type: 'order',
          relatedOrderId: newOrder.id,
        },
        {
          recipientUid: req.user!.uid,
          roleTarget: 'customer',
          title: `Order ${newOrder.orderNumber} Confirmed`,
          message: `Your order from ${rest.name} has been received.`,
          type: 'order',
          relatedOrderId: newOrder.id,
        },
      ]);

      return { order: newOrder, paymentSession: paymentInit, deliveryDispatch, restaurantOwnerUid: rest.ownerUid };
    });

    const emailLog = resolvedCustomerEmail
      ? await sendAndLogOrderTrackingEmail({
          origin: getRequestOrigin(req),
          orderId: created.order.id,
          orderNumber: created.order.orderNumber,
          trackingToken: created.order.trackingToken,
          customerName: created.order.customerName,
          customerEmail: resolvedCustomerEmail,
          restaurantName: created.order.restaurantName,
          deliveryArea: created.order.deliveryArea,
          deliveryAddress: created.order.deliveryAddress,
          totalAmount: created.order.totalAmount,
          paymentMethod: created.order.paymentMethod,
          paymentStatus: created.order.paymentStatus,
          status: created.order.status,
          statusEvent: 'confirmed',
          statusNote: `Order placed via ${input.paymentMethod.toUpperCase()}`,
          etaMinutes: created.order.estimatedMinutes,
          items: created.order.itemsSnapshotJson,
        })
      : null;

    broadcastOrderEvent('order:created', {
      orderId: created.order.id,
      orderNumber: created.order.orderNumber,
      restaurantId: created.order.restaurantId,
      restaurantName: created.order.restaurantName,
      restaurantOwnerUid: created.restaurantOwnerUid,
      customerUid: created.order.customerUid,
      customerName: created.order.customerName,
      status: created.order.status,
      deliveryMode: created.order.deliveryMode,
      deliveryArea: created.order.deliveryArea,
      totalAmount: created.order.totalAmount,
    });
    broadcastNotificationEvent({
      recipientUid: created.restaurantOwnerUid,
      roleTarget: 'restaurant_owner',
      title: `New Order ${created.order.orderNumber}`,
      message: `৳${created.order.totalAmount} order from ${created.order.customerName} (${created.order.deliveryArea})`,
      type: 'order',
      relatedOrderId: created.order.id,
    });
    broadcastNotificationEvent({
      recipientUid: created.order.customerUid,
      roleTarget: 'customer',
      title: `Order ${created.order.orderNumber} Confirmed`,
      message: `Your order from ${created.order.restaurantName} has been received.`,
      type: 'order',
      relatedOrderId: created.order.id,
    });

    res.status(201).json({ ...created, emailLog });
  } catch (error: any) {
    console.error('Order creation failed:', error);
    res.status(400).json({ error: error.message || 'Could not place order' });
  }
});

// Server-side Payment Verification (idempotent)
app.post('/api/payments/verify', requireAuth, async (req: AuthRequest, res) => {
  const schema = z.object({
    orderId: z.number().int().positive(),
    transactionId: z.string().min(3),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid verification payload' });

  try {
    const orderRows = await db
      .select()
      .from(orders)
      .where(eq(orders.id, parsed.data.orderId))
      .limit(1);
    if (orderRows.length === 0) return res.status(404).json({ error: 'Order not found' });
    const order = orderRows[0];

    if (order.paymentStatus === 'paid') {
      return res.json({ verified: true, order, message: 'Payment already verified' });
    }

    const gatewayRows = await ensureDefaultPaymentGateways();
    const matchedGateway = gatewayRows.find(
      (g) => normalizeGatewayCode(g.code) === normalizeGatewayCode(order.paymentMethod)
    );
    const verification = verifyPaymentServerSide(
      order.paymentMethod as PaymentMethod,
      parsed.data.transactionId,
      order.totalAmount,
      matchedGateway
    );

    if (!verification.verified) {
      return res.status(400).json({ error: verification.message });
    }

    const updated = await db
      .update(orders)
      .set({
        paymentStatus: 'paid',
        paymentTxId: verification.transactionId,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id))
      .returning();

    await db.insert(orderStatusHistory).values({
      orderId: order.id,
      status: order.status,
      note: verification.message,
      actorUid: req.user!.uid,
    });

    if (updated[0].customerEmail) {
      await sendAndLogOrderTrackingEmail({
        origin: getRequestOrigin(req),
        orderId: updated[0].id,
        orderNumber: updated[0].orderNumber,
        trackingToken: updated[0].trackingToken,
        customerName: updated[0].customerName,
        customerEmail: updated[0].customerEmail,
        restaurantName: updated[0].restaurantName,
        deliveryArea: updated[0].deliveryArea,
        deliveryAddress: updated[0].deliveryAddress,
        totalAmount: updated[0].totalAmount,
        paymentMethod: updated[0].paymentMethod,
        paymentStatus: updated[0].paymentStatus,
        status: updated[0].status,
        statusEvent: 'payment_verified',
        statusNote: verification.message,
        riderName: updated[0].riderName,
        etaMinutes: updated[0].estimatedMinutes,
        items: updated[0].itemsSnapshotJson,
      });
    }

    broadcastOrderEvent('order:updated', {
      orderId: updated[0].id,
      orderNumber: updated[0].orderNumber,
      restaurantId: updated[0].restaurantId,
      restaurantName: updated[0].restaurantName,
      customerUid: updated[0].customerUid,
      riderUid: updated[0].riderUid,
      riderName: updated[0].riderName,
      status: updated[0].status,
      deliveryMode: updated[0].deliveryMode,
      deliveryArea: updated[0].deliveryArea,
      totalAmount: updated[0].totalAmount,
    });

    res.json({ verified: true, order: updated[0], message: verification.message });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Payment verification failed' });
  }
});

// Extensible Payment Gateway Webhook Callback (bKash, Nagad, SSLCommerz, Rocket, Upay, Stripe, Custom)
app.post('/api/payments/webhook/:code', async (req, res) => {
  const code = normalizeGatewayCode(String(req.params.code || ''));
  if (!code) return res.status(400).json({ error: 'Invalid gateway code' });

  try {
    const gwRows = await db
      .select()
      .from(paymentGateways)
      .where(eq(paymentGateways.code, code))
      .limit(1);
    const gateway = gwRows[0];
    if (!gateway) return res.status(404).json({ error: `Payment gateway "${code}" not registered` });

    const expectedSecret = String(gateway.webhookSecret || '').trim();
    if (expectedSecret) {
      const providedSecret = String(
        req.header('x-webhook-secret') || req.body?.webhookSecret || ''
      ).trim();
      if (providedSecret !== expectedSecret) {
        return res.status(401).json({ error: 'Invalid payment webhook secret' });
      }
    }

    const orderNumber = typeof req.body?.orderNumber === 'string' ? req.body.orderNumber.trim() : '';
    const txId = typeof req.body?.transactionId === 'string' ? req.body.transactionId.trim() : '';
    const statusRaw = typeof req.body?.status === 'string' ? req.body.status.trim().toLowerCase() : 'paid';
    const nextPaymentStatus = statusRaw === 'failed' ? 'failed' : 'paid';

    if (!orderNumber && !txId) {
      return res.status(400).json({ error: 'orderNumber or transactionId is required' });
    }

    const matchingOrders = orderNumber
      ? await db.select().from(orders).where(eq(orders.orderNumber, orderNumber)).limit(1)
      : await db.select().from(orders).where(eq(orders.paymentTxId, txId)).limit(1);

    if (matchingOrders.length === 0) {
      return res.status(404).json({ error: 'Matching order not found' });
    }
    const targetOrder = matchingOrders[0];

    const updated = await db
      .update(orders)
      .set({
        paymentStatus: nextPaymentStatus,
        paymentTxId: txId || targetOrder.paymentTxId,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, targetOrder.id))
      .returning();

    await db.insert(orderStatusHistory).values({
      orderId: targetOrder.id,
      status: targetOrder.status,
      note: `Webhook (${gateway.name}) marked payment as ${nextPaymentStatus}`,
      actorUid: `webhook:${code}`,
    });

    res.json({ ok: true, order: updated[0] });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Webhook processing failed' });
  }
});

// Verified Customer Review
app.post('/api/reviews', requireAuth, async (req: AuthRequest, res) => {
  const schema = z.object({
    restaurantId: z.number().int().positive(),
    orderId: z.number().int().positive().optional(),
    rating: z.number().int().min(1).max(5),
    foodRating: z.number().int().min(1).max(5),
    comment: z.string().min(2).max(500),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Please write a short review and rating' });

  try {
    const inserted = await db
      .insert(reviews)
      .values({
        restaurantId: parsed.data.restaurantId,
        orderId: parsed.data.orderId ?? null,
        customerUid: req.user!.uid,
        customerName: req.user!.fullName,
        rating: parsed.data.rating,
        foodRating: parsed.data.foodRating,
        comment: parsed.data.comment,
      })
      .returning();

    const allReviews = await db
      .select()
      .from(reviews)
      .where(eq(reviews.restaurantId, parsed.data.restaurantId));
    const avg =
      allReviews.reduce((s, r) => s + r.rating, 0) / Math.max(1, allReviews.length);

    await db
      .update(restaurants)
      .set({
        rating: avg.toFixed(1),
        reviewCount: sql`${restaurants.reviewCount} + 1`,
      })
      .where(eq(restaurants.id, parsed.data.restaurantId));

    res.status(201).json({ review: inserted[0] });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

// ---------- Multi-Vendor Restaurant Onboarding & Vendor Dashboard ----------

app.post('/api/restaurants/register', requireAuth, async (req: AuthRequest, res) => {
  const schema = z.object({
    ownerName: z.string().min(2),
    name: z.string().min(2),
    nameBn: z.string().min(2),
    cuisine: z.string().min(2),
    area: z.string().min(2),
    address: z.string().min(5),
    lat: z.number(),
    lng: z.number(),
    phone: z.string().min(6),
    email: z.string().email(),
    description: z.string().min(5),
    tradeLicense: z.string().min(3),
    nidNumber: z.string().min(5),
    payoutMethod: z.string().trim().min(2).max(40),
    payoutAccount: z.string().min(5),
    logoUrl: z.string().optional().default(''),
    coverUrl: z.string().optional().default(''),
    deliveryFee: z.number().int().min(0).max(300).default(49),
    minOrder: z.number().int().min(50).max(5000).default(150),
    deliveryMode: z.enum(['platform', 'restaurant', 'third_party']).default('platform'),
  });

  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please complete all restaurant onboarding fields' });
  }

  try {
    const slugBase = parsed.data.name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/(^-|-$)/g, '');
    const slug = `${slugBase}-${Date.now().toString(36).slice(-4)}`;

    const isOwnerAdmin = req.user!.role === 'admin' || req.user!.role === 'super_admin';

    const inserted = await db
      .insert(restaurants)
      .values({
        ownerUid: req.user!.uid,
        name: parsed.data.name,
        nameBn: parsed.data.nameBn,
        slug,
        description: parsed.data.description,
        cuisine: parsed.data.cuisine,
        area: parsed.data.area,
        address: parsed.data.address,
        lat: parsed.data.lat,
        lng: parsed.data.lng,
        phone: parsed.data.phone,
        email: parsed.data.email,
        logoUrl: parsed.data.logoUrl?.trim() || '',
        coverUrl: parsed.data.coverUrl?.trim() || IMG_BANGLA,
        tradeLicense: parsed.data.tradeLicense,
        nidNumber: parsed.data.nidNumber,
        payoutMethod: parsed.data.payoutMethod,
        payoutAccount: parsed.data.payoutAccount,
        deliveryFee: parsed.data.deliveryFee,
        minOrder: parsed.data.minOrder,
        deliveryMode: parsed.data.deliveryMode,
        isNew: true,
        status: isOwnerAdmin ? 'approved' : 'pending',
      })
      .returning();

    if (req.user!.role === 'customer') {
      await db
        .update(users)
        .set({ role: 'restaurant_owner', fullName: parsed.data.ownerName })
        .where(eq(users.uid, req.user!.uid));
    }

    await db.insert(notifications).values({
      recipientUid: 'demo-admin-uid',
      roleTarget: 'super_admin',
      title: isOwnerAdmin ? 'Owner Store Launched' : 'New Restaurant Application',
      message: isOwnerAdmin
        ? `${parsed.data.name} (${parsed.data.area}) launched directly by Platform Owner.`
        : `${parsed.data.name} (${parsed.data.area}) submitted documents for approval.`,
      type: 'approval',
    });

    res.status(201).json({ restaurant: inserted[0] });
  } catch (error: any) {
    console.error('Restaurant registration error:', error);
    res.status(500).json({ error: error.message || 'Failed to register restaurant' });
  }
});

app.get(
  '/api/vendor/workspace',
  requireAuth,
  requireRole(['restaurant_owner', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    try {
      const isSuperAdmin = req.user!.role === 'super_admin' || req.user!.role === 'admin';
      const requestedRaw = Number(req.query.restaurantId);
      const requestedRestaurantId =
        Number.isInteger(requestedRaw) && requestedRaw > 0 ? requestedRaw : null;
      const data = await getVendorWorkspace(req.user!.uid, isSuperAdmin, requestedRestaurantId);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  '/api/vendor/menu',
  requireAuth,
  requireRole(['restaurant_owner', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const schema = z.object({
      restaurantId: z.number().int().positive(),
      category: z.string().min(2),
      name: z.string().min(2),
      nameBn: z.string().min(2),
      description: z.string().default(''),
      imageUrl: z.string().default(IMG_BANGLA),
      price: z.number().int().positive(),
      discountPrice: z.number().int().positive().nullable().optional(),
      isPopular: z.boolean().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid food item details' });

    try {
      const restRows = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, parsed.data.restaurantId))
        .limit(1);
      if (restRows.length === 0) return res.status(404).json({ error: 'Restaurant not found' });
      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'admin';
      if (!isAdmin && restRows[0].ownerUid !== req.user!.uid) {
        return res.status(403).json({ error: 'Forbidden: Not owner of this restaurant' });
      }

      const inserted = await db
        .insert(foodItems)
        .values({
          restaurantId: parsed.data.restaurantId,
          category: parsed.data.category,
          name: parsed.data.name,
          nameBn: parsed.data.nameBn,
          description: parsed.data.description,
          imageUrl: parsed.data.imageUrl || restRows[0].coverUrl,
          price: parsed.data.price,
          discountPrice: parsed.data.discountPrice ?? null,
          variationsJson: [{ name: 'Regular', priceDelta: 0 }],
          addonsJson: [],
          isPopular: parsed.data.isPopular,
        })
        .returning();

      res.status(201).json({ item: inserted[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/vendor/menu/:id',
  requireAuth,
  requireRole(['restaurant_owner', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'Invalid item ID' });

    try {
      const itemRows = await db.select().from(foodItems).where(eq(foodItems.id, itemId)).limit(1);
      if (itemRows.length === 0) return res.status(404).json({ error: 'Food item not found' });

      const restRows = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, itemRows[0].restaurantId))
        .limit(1);
      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'admin';
      if (!isAdmin && restRows[0]?.ownerUid !== req.user!.uid) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const updated = await db
        .update(foodItems)
        .set({
          category:
            typeof req.body.category === 'string' && req.body.category.trim()
              ? req.body.category.trim()
              : itemRows[0].category,
          name:
            typeof req.body.name === 'string' && req.body.name.trim()
              ? req.body.name.trim()
              : itemRows[0].name,
          nameBn:
            typeof req.body.nameBn === 'string' && req.body.nameBn.trim()
              ? req.body.nameBn.trim()
              : itemRows[0].nameBn,
          description:
            typeof req.body.description === 'string'
              ? req.body.description
              : itemRows[0].description,
          imageUrl:
            typeof req.body.imageUrl === 'string' && req.body.imageUrl.trim()
              ? req.body.imageUrl.trim()
              : itemRows[0].imageUrl,
          inStock: req.body.inStock ?? itemRows[0].inStock,
          isAvailable: req.body.isAvailable ?? itemRows[0].isAvailable,
          isPopular: req.body.isPopular ?? itemRows[0].isPopular,
          price: typeof req.body.price === 'number' && req.body.price > 0 ? req.body.price : itemRows[0].price,
          discountPrice:
            req.body.discountPrice === null
              ? null
              : typeof req.body.discountPrice === 'number' && req.body.discountPrice > 0
              ? req.body.discountPrice
              : itemRows[0].discountPrice,
          updatedAt: new Date(),
        })
        .where(eq(foodItems.id, itemId))
        .returning();
      res.json({ item: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.delete(
  '/api/vendor/menu/:id',
  requireAuth,
  requireRole(['restaurant_owner', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const itemId = Number(req.params.id);
    if (!Number.isInteger(itemId)) return res.status(400).json({ error: 'Invalid item ID' });
    try {
      const itemRows = await db.select().from(foodItems).where(eq(foodItems.id, itemId)).limit(1);
      if (itemRows.length === 0) return res.status(404).json({ error: 'Item not found' });
      const restRows = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, itemRows[0].restaurantId))
        .limit(1);
      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'admin';
      if (!isAdmin && restRows[0]?.ownerUid !== req.user!.uid) {
        return res.status(403).json({ error: 'Forbidden' });
      }
      await db.delete(foodItems).where(eq(foodItems.id, itemId));
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

function hashPartnerApiKey(rawKey: string): string {
  return crypto.createHash('sha256').update(rawKey.trim()).digest('hex');
}

function extractPartnerApiKey(req: express.Request): string | null {
  const headerKey = req.header('x-partner-api-key')?.trim();
  if (headerKey) return headerKey;
  const authHeader = req.header('authorization')?.trim();
  if (authHeader && authHeader.toLowerCase().startsWith('bearer fbd_')) {
    return authHeader.slice(7).trim();
  }
  return null;
}

async function resolvePartnerRestaurant(
  req: express.Request
): Promise<
  | { ok: false; error: string; status: 401 | 403 | 404 }
  | {
      ok: true;
      restaurant: typeof restaurants.$inferSelect;
      apiKeyRow: typeof partnerApiKeys.$inferSelect;
    }
> {
  const rawKey = extractPartnerApiKey(req);
  if (!rawKey) return { ok: false, error: 'Missing X-Partner-API-Key header', status: 401 };
  const keyHash = hashPartnerApiKey(rawKey);
  const keyRows = await db
    .select()
    .from(partnerApiKeys)
    .where(eq(partnerApiKeys.keyHash, keyHash))
    .limit(1);
  if (keyRows.length === 0) {
    return { ok: false, error: 'Invalid or revoked Partner API key', status: 401 };
  }
  const restRows = await db
    .select()
    .from(restaurants)
    .where(eq(restaurants.id, keyRows[0].restaurantId))
    .limit(1);
  if (restRows.length === 0) {
    return { ok: false, error: 'Linked restaurant no longer exists', status: 404 };
  }
  if (restRows[0].status === 'suspended' || restRows[0].status === 'rejected') {
    return { ok: false, error: 'Restaurant account is not active for Partner API access', status: 403 };
  }
  await db
    .update(partnerApiKeys)
    .set({ lastUsedAt: new Date() })
    .where(eq(partnerApiKeys.id, keyRows[0].id));
  return { ok: true, restaurant: restRows[0], apiKeyRow: keyRows[0] };
}

app.get(
  '/api/vendor/api-key',
  requireAuth,
  requireRole(['restaurant_owner', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    try {
      const requestedId = Number(req.query.restaurantId);
      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'admin';
      let restRows =
        Number.isInteger(requestedId) && requestedId > 0
          ? await db.select().from(restaurants).where(eq(restaurants.id, requestedId)).limit(1)
          : await db
              .select()
              .from(restaurants)
              .where(eq(restaurants.ownerUid, req.user!.uid))
              .limit(1);

      if (restRows.length === 0 && isAdmin && !(Number.isInteger(requestedId) && requestedId > 0)) {
        restRows = await db.select().from(restaurants).limit(1);
      }

      if (restRows.length === 0) {
        return res.json({ hasKey: false, restaurantId: null, keyPrefix: null, label: null, lastUsedAt: null });
      }
      if (!isAdmin && restRows[0].ownerUid !== req.user!.uid) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const keyRows = await db
        .select()
        .from(partnerApiKeys)
        .where(eq(partnerApiKeys.restaurantId, restRows[0].id))
        .limit(1);

      if (keyRows.length === 0) {
        return res.json({
          hasKey: false,
          restaurantId: restRows[0].id,
          keyPrefix: null,
          label: null,
          lastUsedAt: null,
          updatedAt: null,
        });
      }

      return res.json({
        hasKey: true,
        restaurantId: restRows[0].id,
        keyPrefix: keyRows[0].keyPrefix,
        label: keyRows[0].label,
        lastUsedAt: keyRows[0].lastUsedAt,
        updatedAt: keyRows[0].updatedAt,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  '/api/vendor/api-key/rotate',
  requireAuth,
  requireRole(['restaurant_owner', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const schema = z.object({
      restaurantId: z.number().int().positive(),
      label: z.string().min(2).max(60).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid API key rotation request' });
    }

    try {
      const restRows = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, parsed.data.restaurantId))
        .limit(1);
      if (restRows.length === 0) return res.status(404).json({ error: 'Restaurant not found' });
      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'admin';
      if (!isAdmin && restRows[0].ownerUid !== req.user!.uid) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const rawKey = `fbd_live_${crypto.randomBytes(16).toString('hex')}`;
      const keyHash = hashPartnerApiKey(rawKey);
      const keyPrefix = `${rawKey.slice(0, 14)}...${rawKey.slice(-4)}`;
      const label = parsed.data.label?.trim() || 'Partner Menu API Key';

      const upserted = await db
        .insert(partnerApiKeys)
        .values({
          restaurantId: restRows[0].id,
          keyHash,
          keyPrefix,
          label,
          updatedAt: new Date(),
        })
        .onConflictDoUpdate({
          target: partnerApiKeys.restaurantId,
          set: {
            keyHash,
            keyPrefix,
            label,
            lastUsedAt: null,
            updatedAt: new Date(),
          },
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'partner_api_key_rotated',
        targetType: 'restaurant',
        targetId: String(restRows[0].id),
        details: JSON.stringify({ keyPrefix, label }),
      });

      res.status(201).json({
        apiKey: rawKey,
        restaurantId: restRows[0].id,
        keyPrefix: upserted[0].keyPrefix,
        label: upserted[0].label,
        updatedAt: upserted[0].updatedAt,
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.get('/api/partner/v1/products', async (req, res) => {
  try {
    const auth = await resolvePartnerRestaurant(req);
    if (auth.ok === false) return res.status(auth.status).json({ error: auth.error });

    const products = await db
      .select()
      .from(foodItems)
      .where(eq(foodItems.restaurantId, auth.restaurant.id))
      .orderBy(desc(foodItems.id));

    res.json({
      restaurant: {
        id: auth.restaurant.id,
        name: auth.restaurant.name,
        nameBn: auth.restaurant.nameBn,
        slug: auth.restaurant.slug,
        area: auth.restaurant.area,
        status: auth.restaurant.status,
      },
      count: products.length,
      products,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to fetch partner products' });
  }
});

app.post('/api/partner/v1/products', async (req, res) => {
  try {
    const auth = await resolvePartnerRestaurant(req);
    if (auth.ok === false) return res.status(auth.status).json({ error: auth.error });

    const body = req.body;
    const rawItems = Array.isArray(body?.products)
      ? body.products
      : Array.isArray(body)
      ? body
      : [body];

    if (rawItems.length === 0 || rawItems.length > 50) {
      return res.status(400).json({ error: 'Provide between 1 and 50 products per request.' });
    }

    const normalizedList: Array<ReturnType<typeof normalizePartnerProductInput> & { valid: true }> = [];
    for (let i = 0; i < rawItems.length; i++) {
      const check = normalizePartnerProductInput(
        rawItems[i] && typeof rawItems[i] === 'object' ? rawItems[i] : {},
        auth.restaurant.coverUrl || IMG_BANGLA
      );
      if (!check.valid) {
        return res.status(400).json({ error: check.reason, index: i });
      }
      normalizedList.push(check);
    }

    const inserted = await db
      .insert(foodItems)
      .values(
        normalizedList.map((entry) => ({
          restaurantId: auth.restaurant.id,
          category: entry.product.category,
          name: entry.product.name,
          nameBn: entry.product.nameBn,
          description: entry.product.description,
          imageUrl: entry.product.imageUrl,
          price: entry.product.price,
          discountPrice: entry.product.discountPrice,
          inStock: entry.product.inStock,
          isAvailable: entry.product.isAvailable,
          isVisibleOnStorefront: true,
          isPopular: entry.product.isPopular,
          variationsJson: entry.product.variationsJson,
          addonsJson: entry.product.addonsJson,
        }))
      )
      .returning();

    await db.insert(auditLogs).values({
      actorUid: auth.restaurant.ownerUid,
      action: 'partner_api_product_created',
      targetType: 'food_item',
      targetId: String(inserted[0].id),
      details: JSON.stringify({
        restaurantId: auth.restaurant.id,
        count: inserted.length,
        names: inserted.map((p) => p.name),
      }),
    });

    res.status(201).json({
      count: inserted.length,
      product: inserted.length === 1 ? inserted[0] : undefined,
      products: inserted,
    });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Partner API failed to add product' });
  }
});

app.patch('/api/partner/v1/products/:id', async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  try {
    const auth = await resolvePartnerRestaurant(req);
    if (auth.ok === false) return res.status(auth.status).json({ error: auth.error });

    const existing = await db
      .select()
      .from(foodItems)
      .where(and(eq(foodItems.id, itemId), eq(foodItems.restaurantId, auth.restaurant.id)))
      .limit(1);
    if (existing.length === 0) {
      return res.status(404).json({ error: 'Product not found for this partner restaurant' });
    }
    const cur = existing[0];

    const body = req.body && typeof req.body === 'object' ? req.body : {};
    const merged = normalizePartnerProductInput(
      {
        name: body.name ?? cur.name,
        nameBn: body.nameBn ?? cur.nameBn,
        category: body.category ?? cur.category,
        description: body.description ?? cur.description,
        imageUrl: body.imageUrl ?? cur.imageUrl,
        price: body.price ?? cur.price,
        discountPrice:
          body.discountPrice === undefined ? cur.discountPrice : body.discountPrice,
        inStock: body.inStock ?? cur.inStock,
        isAvailable: body.isAvailable ?? cur.isAvailable,
        isPopular: body.isPopular ?? cur.isPopular,
        variations: body.variations ?? cur.variationsJson,
        addons: body.addons ?? cur.addonsJson,
      },
      cur.imageUrl || auth.restaurant.coverUrl || IMG_BANGLA
    );

    if (!merged.valid) {
      return res.status(400).json({ error: merged.reason });
    }

    const updated = await db
      .update(foodItems)
      .set({
        name: merged.product.name,
        nameBn: merged.product.nameBn,
        category: merged.product.category,
        description: merged.product.description,
        imageUrl: merged.product.imageUrl,
        price: merged.product.price,
        discountPrice: merged.product.discountPrice,
        inStock: merged.product.inStock,
        isAvailable: merged.product.isAvailable,
        isPopular: merged.product.isPopular,
        variationsJson: merged.product.variationsJson,
        addonsJson: merged.product.addonsJson,
        updatedAt: new Date(),
      })
      .where(and(eq(foodItems.id, itemId), eq(foodItems.restaurantId, auth.restaurant.id)))
      .returning();

    res.json({ product: updated[0] });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to update partner product' });
  }
});

app.delete('/api/partner/v1/products/:id', async (req, res) => {
  const itemId = Number(req.params.id);
  if (!Number.isInteger(itemId) || itemId <= 0) {
    return res.status(400).json({ error: 'Invalid product ID' });
  }

  try {
    const auth = await resolvePartnerRestaurant(req);
    if (auth.ok === false) return res.status(auth.status).json({ error: auth.error });

    const deleted = await db
      .delete(foodItems)
      .where(and(eq(foodItems.id, itemId), eq(foodItems.restaurantId, auth.restaurant.id)))
      .returning();

    if (deleted.length === 0) {
      return res.status(404).json({ error: 'Product not found for this partner restaurant' });
    }

    res.json({ deleted: true, id: itemId });
  } catch (error: any) {
    res.status(500).json({ error: error.message || 'Failed to delete partner product' });
  }
});

app.patch(
  '/api/vendor/restaurant',
  requireAuth,
  requireRole(['restaurant_owner', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const schema = z.object({
      restaurantId: z.number().int().positive(),
      isOpen: z.boolean().optional(),
      openingHours: z.string().optional(),
      deliveryFee: z.number().int().min(0).max(500).optional(),
      minOrder: z.number().int().min(0).max(5000).optional(),
      deliveryMode: z.enum(['platform', 'restaurant', 'third_party']).optional(),
      logoUrl: z.string().optional(),
      coverUrl: z.string().optional(),
      description: z.string().optional(),
      area: z.string().min(2).optional(),
      address: z.string().min(3).optional(),
      lat: z.number().optional(),
      lng: z.number().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid restaurant settings' });

    try {
      const rows = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, parsed.data.restaurantId))
        .limit(1);
      if (rows.length === 0) return res.status(404).json({ error: 'Restaurant not found' });
      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'admin';
      if (!isAdmin && rows[0].ownerUid !== req.user!.uid) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const updated = await db
        .update(restaurants)
        .set({
          isOpen: parsed.data.isOpen ?? rows[0].isOpen,
          openingHours: parsed.data.openingHours ?? rows[0].openingHours,
          deliveryFee: parsed.data.deliveryFee ?? rows[0].deliveryFee,
          minOrder: parsed.data.minOrder ?? rows[0].minOrder,
          deliveryMode: parsed.data.deliveryMode ?? rows[0].deliveryMode,
          area: parsed.data.area !== undefined ? parsed.data.area.trim() : rows[0].area,
          address: parsed.data.address !== undefined ? parsed.data.address.trim() : rows[0].address,
          lat: parsed.data.lat !== undefined ? parsed.data.lat : rows[0].lat,
          lng: parsed.data.lng !== undefined ? parsed.data.lng : rows[0].lng,
          logoUrl:
            parsed.data.logoUrl !== undefined ? parsed.data.logoUrl.trim() : rows[0].logoUrl,
          coverUrl:
            parsed.data.coverUrl !== undefined && parsed.data.coverUrl.trim()
              ? parsed.data.coverUrl.trim()
              : rows[0].coverUrl,
          description:
            parsed.data.description !== undefined
              ? parsed.data.description.trim()
              : rows[0].description,
          updatedAt: new Date(),
        })
        .where(eq(restaurants.id, rows[0].id))
        .returning();
      res.json({ restaurant: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/vendor/orders/:id/status',
  requireAuth,
  requireRole(['restaurant_owner', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const orderId = Number(req.params.id);
    const schema = z.object({
      status: z.enum(['accepted', 'preparing', 'ready', 'on_the_way', 'delivered', 'cancelled']),
      note: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!Number.isInteger(orderId) || !parsed.success) {
      return res.status(400).json({ error: 'Invalid status update' });
    }

    try {
      const orderRows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (orderRows.length === 0) return res.status(404).json({ error: 'Order not found' });
      const order = orderRows[0];

      const restRows = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, order.restaurantId))
        .limit(1);
      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'admin';
      if (!isAdmin && restRows[0]?.ownerUid !== req.user!.uid) {
        return res.status(403).json({ error: 'Forbidden: Order belongs to another restaurant' });
      }

      if (!canTransitionOrderStatus(order.status as OrderStatus, parsed.data.status)) {
        return res.status(400).json({
          error: `Cannot transition order from ${order.status} to ${parsed.data.status}`,
        });
      }

      const updated = await db
        .update(orders)
        .set({
          status: parsed.data.status,
          cancelReason:
            parsed.data.status === 'cancelled' ? parsed.data.note || 'Cancelled by restaurant' : order.cancelReason,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id))
        .returning();

      await db.insert(orderStatusHistory).values({
        orderId: order.id,
        status: parsed.data.status,
        note: parsed.data.note || `Updated to ${parsed.data.status}`,
        actorUid: req.user!.uid,
      });

      if (parsed.data.status === 'delivered') {
        await settleOrderCommissionIdempotent(order.id);
      }

      await db.insert(notifications).values({
        recipientUid: order.customerUid,
        roleTarget: 'customer',
        title: `Order ${order.orderNumber}: ${parsed.data.status.replace('_', ' ')}`,
        message: parsed.data.note || `${order.restaurantName} updated your order status.`,
        type: 'order',
        relatedOrderId: order.id,
      });

      if (updated[0].customerEmail) {
        await sendAndLogOrderTrackingEmail({
          origin: getRequestOrigin(req),
          orderId: updated[0].id,
          orderNumber: updated[0].orderNumber,
          trackingToken: updated[0].trackingToken,
          customerName: updated[0].customerName,
          customerEmail: updated[0].customerEmail,
          restaurantName: updated[0].restaurantName,
          deliveryArea: updated[0].deliveryArea,
          deliveryAddress: updated[0].deliveryAddress,
          totalAmount: updated[0].totalAmount,
          paymentMethod: updated[0].paymentMethod,
          paymentStatus: updated[0].paymentStatus,
          status: updated[0].status,
          statusEvent: parsed.data.status,
          statusNote: parsed.data.note || `${order.restaurantName} updated order status`,
          riderName: updated[0].riderName,
          etaMinutes: updated[0].estimatedMinutes,
          items: updated[0].itemsSnapshotJson,
        });
      }

      broadcastOrderEvent('order:updated', {
        orderId: updated[0].id,
        orderNumber: updated[0].orderNumber,
        restaurantId: updated[0].restaurantId,
        restaurantName: updated[0].restaurantName,
        restaurantOwnerUid: restRows[0]?.ownerUid || null,
        customerUid: updated[0].customerUid,
        customerName: updated[0].customerName,
        riderUid: updated[0].riderUid,
        riderName: updated[0].riderName,
        status: updated[0].status,
        deliveryMode: updated[0].deliveryMode,
        deliveryArea: updated[0].deliveryArea,
        totalAmount: updated[0].totalAmount,
      });
      broadcastNotificationEvent({
        recipientUid: order.customerUid,
        roleTarget: 'customer',
        title: `Order ${order.orderNumber}: ${parsed.data.status.replace('_', ' ')}`,
        message: parsed.data.note || `${order.restaurantName} updated your order status.`,
        type: 'order',
        relatedOrderId: order.id,
      });

      res.json({ order: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  '/api/vendor/payouts',
  requireAuth,
  requireRole(['restaurant_owner', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const schema = z.object({
      restaurantId: z.number().int().positive(),
      amount: z.number().int().positive(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid payout request' });

    try {
      const restRows = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, parsed.data.restaurantId))
        .limit(1);
      if (restRows.length === 0) return res.status(404).json({ error: 'Restaurant not found' });
      const rest = restRows[0];
      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'admin';
      if (!isAdmin && rest.ownerUid !== req.user!.uid) {
        return res.status(403).json({ error: 'Forbidden' });
      }

      const inserted = await db
        .insert(restaurantPayouts)
        .values({
          restaurantId: rest.id,
          restaurantName: rest.name,
          amount: parsed.data.amount,
          method: rest.payoutMethod,
          accountNumber: rest.payoutAccount || rest.phone,
          status: 'pending',
        })
        .returning();

      res.status(201).json({ payout: inserted[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// ---------- Delivery Rider Routes ----------

// Open public Rider Job Application & instant activation anywhere in Bangladesh
app.post('/api/riders/apply', async (req, res) => {
  const schema = z.object({
    fullName: z.string().trim().min(2).max(100),
    phone: z.string().trim().min(6).max(30),
    email: z.string().trim().email(),
    password: z.string().min(6).max(128).optional().or(z.literal('')),
    vehicleType: z.string().trim().min(2).max(40).default('Motorbike'),
    zone: z.string().trim().min(2).max(120),
    nidNumber: z.string().trim().min(4).max(50),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: 'Please complete all rider job application fields.' });
  }

  const emailLower = parsed.data.email.trim().toLowerCase();
  if (isProtectedSuperAdminEmail(emailLower)) {
    return res.status(409).json({
      error: 'This email belongs to a Super Admin account. Please use a rider email.',
    });
  }

  try {
    const existingUsers = await db
      .select()
      .from(users)
      .where(sql`lower(${users.email}) = ${emailLower}`)
      .limit(1);

    let uid = existingUsers[0]?.uid || '';
    if (existingUsers[0]) {
      if (existingUsers[0].status === 'suspended') {
        return res.status(403).json({ error: 'This account has been suspended by an administrator.' });
      }
      if (['admin', 'super_admin'].includes(existingUsers[0].role)) {
        return res.status(409).json({
          error: 'This email belongs to an Admin account. Please use a separate rider email.',
        });
      }
      const credRows = await db
        .select()
        .from(localCredentials)
        .where(eq(localCredentials.email, emailLower))
        .limit(1);
      if (credRows.length > 0 && parsed.data.password) {
        if (!verifyPasswordScrypt(parsed.data.password, credRows[0].passwordHash)) {
          return res.status(401).json({
            error: 'An account with this email already exists. Enter your matching password or leave password blank if applying with Google/existing session.',
          });
        }
      }
      await db
        .update(users)
        .set({
          fullName: parsed.data.fullName,
          phone: parsed.data.phone,
          role: existingUsers[0].role === 'restaurant_owner' ? 'rider' : 'rider',
          updatedAt: new Date(),
        })
        .where(eq(users.uid, uid));
    } else {
      uid = `rdr-${crypto.randomBytes(8).toString('hex')}`;
      await db.insert(users).values({
        uid,
        email: emailLower,
        fullName: parsed.data.fullName,
        phone: parsed.data.phone,
        role: 'rider',
      });
      if (parsed.data.password && parsed.data.password.length >= 6) {
        await db
          .insert(localCredentials)
          .values({
            email: emailLower,
            uid,
            passwordHash: hashPasswordScrypt(parsed.data.password),
          })
          .onConflictDoNothing();
      }
    }

    const startLat = Number.isFinite(parsed.data.lat) ? Math.round((parsed.data.lat as number) * 1e6) / 1e6 : 23.7949;
    const startLng = Number.isFinite(parsed.data.lng) ? Math.round((parsed.data.lng as number) * 1e6) / 1e6 : 90.4144;

    const inserted = await db
      .insert(riders)
      .values({
        uid,
        fullName: parsed.data.fullName,
        phone: parsed.data.phone,
        email: emailLower,
        vehicleType: parsed.data.vehicleType,
        zone: parsed.data.zone,
        nidNumber: parsed.data.nidNumber,
        currentLat: startLat,
        currentLng: startLng,
        locationUpdatedAt: new Date(),
        isAvailable: true,
        status: 'approved',
      })
      .onConflictDoUpdate({
        target: riders.uid,
        set: {
          fullName: parsed.data.fullName,
          phone: parsed.data.phone,
          email: emailLower,
          vehicleType: parsed.data.vehicleType,
          zone: parsed.data.zone,
          nidNumber: parsed.data.nidNumber,
          currentLat: startLat,
          currentLng: startLng,
          locationUpdatedAt: new Date(),
          isAvailable: true,
          status: 'approved',
        },
      })
      .returning();

    await db.insert(notifications).values({
      recipientUid: 'demo-admin-uid',
      roleTarget: 'super_admin',
      title: 'New Delivery Rider Joined',
      message: `${parsed.data.fullName} (${parsed.data.vehicleType}) joined for ${parsed.data.zone}, Bangladesh.`,
      type: 'system',
    });

    const userPayload = {
      uid,
      email: emailLower,
      fullName: parsed.data.fullName,
      role: 'rider' as UserRole,
      isSandbox: false,
    };
    const token = signSandboxToken(userPayload);

    return res.status(201).json({
      token,
      user: userPayload,
      rider: inserted[0],
    });
  } catch (error: any) {
    console.error('Rider application failed:', error);
    return res.status(500).json({ error: error.message || 'Could not submit rider application' });
  }
});

app.post('/api/riders/register', requireAuth, async (req: AuthRequest, res) => {
  const schema = z.object({
    fullName: z.string().trim().min(2).max(100),
    phone: z.string().trim().min(6).max(30),
    email: z.string().trim().email(),
    vehicleType: z.string().trim().min(2).max(40),
    zone: z.string().trim().min(2).max(120),
    nidNumber: z.string().trim().min(4).max(50),
    lat: z.number().min(-90).max(90).optional(),
    lng: z.number().min(-180).max(180).optional(),
  });
  const parsed = schema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: 'Invalid rider registration data' });

  try {
    const startLat = Number.isFinite(parsed.data.lat) ? Math.round((parsed.data.lat as number) * 1e6) / 1e6 : 23.7949;
    const startLng = Number.isFinite(parsed.data.lng) ? Math.round((parsed.data.lng as number) * 1e6) / 1e6 : 90.4144;

    const inserted = await db
      .insert(riders)
      .values({
        uid: req.user!.uid,
        fullName: parsed.data.fullName,
        phone: parsed.data.phone,
        email: parsed.data.email.trim().toLowerCase(),
        vehicleType: parsed.data.vehicleType,
        zone: parsed.data.zone,
        nidNumber: parsed.data.nidNumber,
        currentLat: startLat,
        currentLng: startLng,
        locationUpdatedAt: new Date(),
        isAvailable: true,
        status: 'approved',
      })
      .onConflictDoUpdate({
        target: riders.uid,
        set: {
          fullName: parsed.data.fullName,
          phone: parsed.data.phone,
          vehicleType: parsed.data.vehicleType,
          zone: parsed.data.zone,
          nidNumber: parsed.data.nidNumber,
          currentLat: startLat,
          currentLng: startLng,
          locationUpdatedAt: new Date(),
        },
      })
      .returning();

    let nextUser = req.user!;
    if (req.user!.role === 'customer') {
      await db.update(users).set({ role: 'rider', fullName: parsed.data.fullName }).where(eq(users.uid, req.user!.uid));
      nextUser = { ...req.user!, role: 'rider', fullName: parsed.data.fullName };
    }
    const freshToken = signSandboxToken({
      uid: nextUser.uid,
      email: nextUser.email,
      fullName: nextUser.fullName,
      role: nextUser.role,
      isSandbox: nextUser.isSandbox,
    });
    res.status(201).json({ rider: inserted[0], token: freshToken, user: nextUser });
  } catch (error: any) {
    res.status(500).json({ error: error.message });
  }
});

app.get(
  '/api/rider/workspace',
  requireAuth,
  requireRole(['rider', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    try {
      const targetUid =
        req.user!.role === 'super_admin' || req.user!.role === 'admin'
          ? 'demo-rider-uid'
          : req.user!.uid;
      const data = await getRiderWorkspace(targetUid);
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/rider/location',
  requireAuth,
  requireRole(['rider', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const schema = z.object({
      lat: z.number().min(-90).max(90),
      lng: z.number().min(-180).max(180),
      isAvailable: z.boolean().optional(),
      zone: z.string().min(2).max(100).optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Valid GPS latitude and longitude required.' });
    }

    try {
      const riderUid =
        req.user!.role === 'super_admin' || req.user!.role === 'admin'
          ? 'demo-rider-uid'
          : req.user!.uid;
      const existing = await db.select().from(riders).where(eq(riders.uid, riderUid)).limit(1);
      if (existing.length === 0) {
        return res.status(404).json({ error: 'Rider profile not found.' });
      }
      const cur = existing[0];
      const updated = await db
        .update(riders)
        .set({
          currentLat: Math.round(parsed.data.lat * 1e6) / 1e6,
          currentLng: Math.round(parsed.data.lng * 1e6) / 1e6,
          locationUpdatedAt: new Date(),
          isAvailable:
            typeof parsed.data.isAvailable === 'boolean' ? parsed.data.isAvailable : cur.isAvailable,
          zone: parsed.data.zone ? parsed.data.zone.trim() : cur.zone,
        })
        .where(eq(riders.uid, riderUid))
        .returning();

      const activeRiderOrders = await db
        .select({
          id: orders.id,
          orderNumber: orders.orderNumber,
          restaurantId: orders.restaurantId,
          restaurantName: orders.restaurantName,
          customerUid: orders.customerUid,
          status: orders.status,
        })
        .from(orders)
        .where(eq(orders.riderUid, riderUid));

      for (const ord of activeRiderOrders) {
        if (!['delivered', 'cancelled'].includes(ord.status)) {
          broadcastOrderEvent('rider:location', {
            orderId: ord.id,
            orderNumber: ord.orderNumber,
            restaurantId: ord.restaurantId,
            restaurantName: ord.restaurantName,
            customerUid: ord.customerUid,
            riderUid,
            riderName: updated[0].fullName,
            status: ord.status,
            lat: updated[0].currentLat,
            lng: updated[0].currentLng,
          });
        }
      }

      res.json({ rider: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  '/api/rider/orders/:id/accept',
  requireAuth,
  requireRole(['rider', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'Invalid order ID' });

    try {
      const riderUid =
        req.user!.role === 'super_admin' || req.user!.role === 'admin'
          ? 'demo-rider-uid'
          : req.user!.uid;
      const orderRows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (orderRows.length === 0) return res.status(404).json({ error: 'Order not found' });
      const existingOrder = orderRows[0];
      if (['delivered', 'cancelled'].includes(existingOrder.status)) {
        return res.status(409).json({ error: 'Order is already closed and cannot be claimed.' });
      }
      if (existingOrder.riderUid && existingOrder.riderUid !== riderUid) {
        return res.status(409).json({ error: 'Order has already been claimed by another rider.' });
      }

      const riderRows = await db.select().from(riders).where(eq(riders.uid, riderUid)).limit(1);
      const riderName = riderRows[0]?.fullName || req.user!.fullName;

      const updated = await db
        .update(orders)
        .set({
          riderUid,
          riderName,
          status: 'rider_assigned',
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId))
        .returning();

      await db.insert(orderStatusHistory).values({
        orderId,
        status: 'rider_assigned',
        note: `Rider ${riderName} accepted delivery assignment`,
        actorUid: riderUid,
      });

      await db.insert(notifications).values({
        recipientUid: existingOrder.customerUid,
        roleTarget: 'customer',
        title: 'Rider Assigned to Your Order',
        message: `${riderName} is assigned for ${existingOrder.orderNumber}. Track live rider GPS on your map.`,
        type: 'order',
        relatedOrderId: existingOrder.id,
      });

      if (updated[0].customerEmail) {
        await sendAndLogOrderTrackingEmail({
          origin: getRequestOrigin(req),
          orderId: updated[0].id,
          orderNumber: updated[0].orderNumber,
          trackingToken: updated[0].trackingToken,
          customerName: updated[0].customerName,
          customerEmail: updated[0].customerEmail,
          restaurantName: updated[0].restaurantName,
          deliveryArea: updated[0].deliveryArea,
          deliveryAddress: updated[0].deliveryAddress,
          totalAmount: updated[0].totalAmount,
          paymentMethod: updated[0].paymentMethod,
          paymentStatus: updated[0].paymentStatus,
          status: updated[0].status,
          statusEvent: 'rider_assigned',
          statusNote: `Rider ${riderName} accepted delivery assignment`,
          riderName,
          riderPhone: riderRows[0]?.phone || null,
          etaMinutes: updated[0].estimatedMinutes,
          items: updated[0].itemsSnapshotJson,
        });
      }

      broadcastOrderEvent('order:updated', {
        orderId: updated[0].id,
        orderNumber: updated[0].orderNumber,
        restaurantId: updated[0].restaurantId,
        restaurantName: updated[0].restaurantName,
        customerUid: updated[0].customerUid,
        riderUid: updated[0].riderUid,
        riderName: updated[0].riderName,
        status: updated[0].status,
        deliveryMode: updated[0].deliveryMode,
        deliveryArea: updated[0].deliveryArea,
        totalAmount: updated[0].totalAmount,
      });
      broadcastNotificationEvent({
        recipientUid: existingOrder.customerUid,
        roleTarget: 'customer',
        title: 'Rider Assigned to Your Order',
        message: `${riderName} is assigned for ${existingOrder.orderNumber}. Track live rider GPS on your map.`,
        type: 'order',
        relatedOrderId: existingOrder.id,
      });

      res.json({ order: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/rider/orders/:id/status',
  requireAuth,
  requireRole(['rider', 'admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const orderId = Number(req.params.id);
    const schema = z.object({
      status: z.enum(['picked_up', 'on_the_way', 'delivered']),
    });
    const parsed = schema.safeParse(req.body);
    if (!Number.isInteger(orderId) || !parsed.success) {
      return res.status(400).json({ error: 'Invalid rider status update' });
    }

    try {
      const orderRows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (orderRows.length === 0) return res.status(404).json({ error: 'Order not found' });
      const order = orderRows[0];

      const isAdmin = req.user!.role === 'super_admin' || req.user!.role === 'admin';
      if (!isAdmin && order.riderUid !== req.user!.uid) {
        return res.status(403).json({ error: 'Forbidden: Order is assigned to another rider' });
      }
      if (!canTransitionOrderStatus(order.status as OrderStatus, parsed.data.status)) {
        return res
          .status(400)
          .json({ error: `Cannot change order from ${order.status} to ${parsed.data.status}` });
      }

      const updated = await db
        .update(orders)
        .set({
          status: parsed.data.status,
          paymentStatus:
            parsed.data.status === 'delivered' && order.paymentMethod === 'cod'
              ? 'paid'
              : order.paymentStatus,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, order.id))
        .returning();

      await db.insert(orderStatusHistory).values({
        orderId: order.id,
        status: parsed.data.status,
        note: `Rider updated status to ${parsed.data.status.replace(/_/g, ' ')}`,
        actorUid: req.user!.uid,
      });

      const statusLabels: Record<string, string> = {
        picked_up: 'Order Picked Up',
        on_the_way: 'Rider Is On The Way',
        delivered: 'Order Delivered!',
      };
      await db.insert(notifications).values({
        recipientUid: order.customerUid,
        roleTarget: 'customer',
        title: statusLabels[parsed.data.status] || 'Delivery Update',
        message: `${order.orderNumber} (${order.restaurantName}) is now ${parsed.data.status.replace(/_/g, ' ')}.`,
        type: 'order',
        relatedOrderId: order.id,
      });

      if (parsed.data.status === 'delivered') {
        await settleOrderCommissionIdempotent(order.id);
        if (order.riderUid) {
          await db
            .update(riders)
            .set({
              totalDeliveries: sql`${riders.totalDeliveries} + 1`,
              totalEarnings: sql`${riders.totalEarnings} + ${Math.max(40, order.deliveryFee)}`,
            })
            .where(eq(riders.uid, order.riderUid));
        }
      }

      if (updated[0].customerEmail) {
        const assignedRiderRows = updated[0].riderUid
          ? await db
              .select({ phone: riders.phone })
              .from(riders)
              .where(eq(riders.uid, updated[0].riderUid))
              .limit(1)
          : [];
        await sendAndLogOrderTrackingEmail({
          origin: getRequestOrigin(req),
          orderId: updated[0].id,
          orderNumber: updated[0].orderNumber,
          trackingToken: updated[0].trackingToken,
          customerName: updated[0].customerName,
          customerEmail: updated[0].customerEmail,
          restaurantName: updated[0].restaurantName,
          deliveryArea: updated[0].deliveryArea,
          deliveryAddress: updated[0].deliveryAddress,
          totalAmount: updated[0].totalAmount,
          paymentMethod: updated[0].paymentMethod,
          paymentStatus: updated[0].paymentStatus,
          status: updated[0].status,
          statusEvent: parsed.data.status,
          statusNote: statusLabels[parsed.data.status] || 'Delivery Update',
          riderName: updated[0].riderName,
          riderPhone: assignedRiderRows[0]?.phone || null,
          etaMinutes: updated[0].estimatedMinutes,
          items: updated[0].itemsSnapshotJson,
        });
      }

      broadcastOrderEvent('order:updated', {
        orderId: updated[0].id,
        orderNumber: updated[0].orderNumber,
        restaurantId: updated[0].restaurantId,
        restaurantName: updated[0].restaurantName,
        customerUid: updated[0].customerUid,
        riderUid: updated[0].riderUid,
        riderName: updated[0].riderName,
        status: updated[0].status,
        deliveryMode: updated[0].deliveryMode,
        deliveryArea: updated[0].deliveryArea,
        totalAmount: updated[0].totalAmount,
      });
      broadcastNotificationEvent({
        recipientUid: order.customerUid,
        roleTarget: 'customer',
        title: statusLabels[parsed.data.status] || 'Delivery Update',
        message: `${order.orderNumber} (${order.restaurantName}) is now ${parsed.data.status.replace(/_/g, ' ')}.`,
        type: 'order',
        relatedOrderId: order.id,
      });

      res.json({ order: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// ---------- Media Upload Route (Product & Storefront Images) ----------

app.post(
  '/api/upload-image',
  requireAuth,
  async (req: AuthRequest, res) => {
    const schema = z.object({
      dataUrl: z.string().min(20),
      filename: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid image upload payload' });
    }

    const match = /^data:image\/(png|jpeg|jpg|webp|gif);base64,([A-Za-z0-9+/=]+)$/i.exec(
      parsed.data.dataUrl.trim()
    );
    if (!match) {
      return res.status(400).json({ error: 'Only PNG, JPG, WEBP, or GIF images are supported' });
    }

    try {
      const ext = match[1].toLowerCase() === 'jpeg' ? 'jpg' : match[1].toLowerCase();
      const buffer = Buffer.from(match[2], 'base64');
      if (buffer.byteLength > 5 * 1024 * 1024) {
        return res.status(400).json({ error: 'Image must be 5 MB or smaller' });
      }
      const safeStem = (parsed.data.filename || 'food')
        .replace(/\.[^.]+$/, '')
        .toLowerCase()
        .replace(/[^a-z0-9-_]+/g, '-')
        .slice(0, 32) || 'food';
      const outName = `${safeStem}-${Date.now()}-${Math.random().toString(36).slice(2, 6)}.${ext}`;
      if (process.env.VERCEL) {
        return res.status(201).json({ imageUrl: parsed.data.dataUrl.trim() });
      }
      const outPath = path.join(UPLOADS_DIR, outName);
      await fs.promises.writeFile(outPath, buffer);
      res.status(201).json({ imageUrl: `/uploads/${outName}` });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Image upload failed' });
    }
  }
);

// ---------- Super Admin Dashboard Routes ----------

app.get(
  '/api/admin/workspace',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (_req, res) => {
    try {
      const data = await getAdminWorkspace();
      res.json(data);
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  '/api/admin/restaurants',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const schema = z.object({
      name: z.string().min(2),
      nameBn: z.string().min(1),
      cuisine: z.string().min(2),
      area: z.string().min(2),
      address: z.string().min(3),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      phone: z.string().default('+8801710000000'),
      email: z.string().email().default('partner@foodora.bd'),
      description: z.string().default(''),
      logoUrl: z.string().default(''),
      coverUrl: z.string().default(IMG_BANGLA),
      deliveryFee: z.number().int().min(0).max(500).default(49),
      minOrder: z.number().int().min(0).max(10000).default(150),
      discountPct: z.number().int().min(0).max(90).default(0),
      openingHours: z.string().default('10:00 AM - 11:30 PM'),
      deliveryMode: z.enum(['platform', 'restaurant', 'third_party']).default('platform'),
      commissionRate: z.string().default('15.00'),
      subscriptionPlan: z.enum(['free', 'basic', 'premium', 'enterprise']).default('basic'),
      isSponsored: z.boolean().default(false),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid restaurant creation payload' });
    }

    try {
      const slugBase = parsed.data.name
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, '-')
        .replace(/(^-|-$)/g, '');
      const slug = `${slugBase}-${Date.now().toString(36).slice(-4)}`;

      const inserted = await db
        .insert(restaurants)
        .values({
          ownerUid: req.user!.uid,
          name: parsed.data.name,
          nameBn: parsed.data.nameBn,
          slug,
          description: parsed.data.description || `${parsed.data.name} in ${parsed.data.area}, Bangladesh.`,
          cuisine: parsed.data.cuisine,
          area: parsed.data.area,
          address: parsed.data.address,
          lat: Number.isFinite(parsed.data.lat) ? (parsed.data.lat as number) : 23.7937,
          lng: Number.isFinite(parsed.data.lng) ? (parsed.data.lng as number) : 90.4066,
          phone: parsed.data.phone,
          email: parsed.data.email,
          logoUrl: parsed.data.logoUrl?.trim() || '',
          coverUrl: parsed.data.coverUrl || IMG_BANGLA,
          deliveryFee: parsed.data.deliveryFee,
          minOrder: parsed.data.minOrder,
          discountPct: parsed.data.discountPct,
          openingHours: parsed.data.openingHours,
          deliveryMode: parsed.data.deliveryMode,
          commissionRate: parsed.data.commissionRate,
          subscriptionPlan: parsed.data.subscriptionPlan,
          isSponsored: parsed.data.isSponsored,
          isNew: true,
          isOpen: true,
          status: 'approved',
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'restaurant_created',
        targetType: 'restaurant',
        targetId: String(inserted[0].id),
        details: JSON.stringify({ name: inserted[0].name, area: inserted[0].area }),
      });

      res.status(201).json({ restaurant: inserted[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/admin/restaurants/:id',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid restaurant ID' });

    const schema = z.object({
      name: z.string().min(2).optional(),
      nameBn: z.string().min(1).optional(),
      cuisine: z.string().min(2).optional(),
      area: z.string().min(2).optional(),
      address: z.string().min(3).optional(),
      lat: z.number().min(-90).max(90).optional(),
      lng: z.number().min(-180).max(180).optional(),
      description: z.string().optional(),
      logoUrl: z.string().optional(),
      coverUrl: z.string().optional(),
      deliveryFee: z.number().int().min(0).max(500).optional(),
      minOrder: z.number().int().min(0).max(10000).optional(),
      discountPct: z.number().int().min(0).max(90).optional(),
      openingHours: z.string().optional(),
      deliveryMode: z.enum(['platform', 'restaurant', 'third_party']).optional(),
      isOpen: z.boolean().optional(),
      status: z.enum(['pending', 'approved', 'rejected', 'suspended']).optional(),
      commissionRate: z.string().optional(),
      commissionType: z.enum(['percentage', 'fixed']).optional(),
      fixedCommission: z.number().int().min(0).optional(),
      subscriptionPlan: z.enum(['free', 'basic', 'premium', 'enterprise']).optional(),
      isSponsored: z.boolean().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid admin restaurant update' });

    try {
      const rows = await db.select().from(restaurants).where(eq(restaurants.id, id)).limit(1);
      if (rows.length === 0) return res.status(404).json({ error: 'Restaurant not found' });
      const current = rows[0];

      const updated = await db
        .update(restaurants)
        .set({
          name: parsed.data.name ?? current.name,
          nameBn: parsed.data.nameBn ?? current.nameBn,
          cuisine: parsed.data.cuisine ?? current.cuisine,
          area: parsed.data.area ?? current.area,
          address: parsed.data.address ?? current.address,
          lat: parsed.data.lat ?? current.lat,
          lng: parsed.data.lng ?? current.lng,
          description: parsed.data.description ?? current.description,
          logoUrl: parsed.data.logoUrl !== undefined ? parsed.data.logoUrl.trim() : current.logoUrl,
          coverUrl: parsed.data.coverUrl || current.coverUrl,
          deliveryFee: parsed.data.deliveryFee ?? current.deliveryFee,
          minOrder: parsed.data.minOrder ?? current.minOrder,
          discountPct: parsed.data.discountPct ?? current.discountPct,
          openingHours: parsed.data.openingHours ?? current.openingHours,
          deliveryMode: parsed.data.deliveryMode ?? current.deliveryMode,
          isOpen: parsed.data.isOpen ?? current.isOpen,
          status: parsed.data.status ?? current.status,
          commissionRate: parsed.data.commissionRate ?? current.commissionRate,
          commissionType: parsed.data.commissionType ?? current.commissionType,
          fixedCommission: parsed.data.fixedCommission ?? current.fixedCommission,
          subscriptionPlan: parsed.data.subscriptionPlan ?? current.subscriptionPlan,
          isSponsored: parsed.data.isSponsored ?? current.isSponsored,
          updatedAt: new Date(),
        })
        .where(eq(restaurants.id, id))
        .returning();

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: `restaurant_update_${parsed.data.status || 'config'}`,
        targetType: 'restaurant',
        targetId: String(id),
        details: JSON.stringify(parsed.data),
      });

      res.json({ restaurant: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  '/api/admin/products',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const schema = z.object({
      restaurantId: z.number().int().positive(),
      category: z.string().min(2),
      name: z.string().min(2),
      nameBn: z.string().min(1),
      description: z.string().default(''),
      imageUrl: z.string().default(IMG_BANGLA),
      price: z.number().int().positive(),
      discountPrice: z.number().int().positive().nullable().optional(),
      inStock: z.boolean().default(true),
      isAvailable: z.boolean().default(true),
      isVisibleOnStorefront: z.boolean().default(true),
      isPopular: z.boolean().default(false),
      variationsJson: z
        .array(z.object({ name: z.string(), priceDelta: z.number() }))
        .optional(),
      addonsJson: z
        .array(z.object({ name: z.string(), price: z.number() }))
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid product payload' });

    try {
      const restRows = await db
        .select()
        .from(restaurants)
        .where(eq(restaurants.id, parsed.data.restaurantId))
        .limit(1);
      if (restRows.length === 0) return res.status(404).json({ error: 'Restaurant not found' });

      const inserted = await db
        .insert(foodItems)
        .values({
          restaurantId: parsed.data.restaurantId,
          category: parsed.data.category.trim(),
          name: parsed.data.name.trim(),
          nameBn: parsed.data.nameBn.trim(),
          description: parsed.data.description,
          imageUrl: parsed.data.imageUrl.trim() || restRows[0].coverUrl || IMG_BANGLA,
          price: parsed.data.price,
          discountPrice: parsed.data.discountPrice ?? null,
          inStock: parsed.data.inStock,
          isAvailable: parsed.data.isAvailable,
          isVisibleOnStorefront: parsed.data.isVisibleOnStorefront,
          isPopular: parsed.data.isPopular,
          variationsJson:
            parsed.data.variationsJson && parsed.data.variationsJson.length > 0
              ? parsed.data.variationsJson
              : [{ name: 'Regular', priceDelta: 0 }],
          addonsJson: parsed.data.addonsJson ?? [],
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'product_created',
        targetType: 'food_item',
        targetId: String(inserted[0].id),
        details: JSON.stringify({
          name: inserted[0].name,
          restaurantId: inserted[0].restaurantId,
          isVisibleOnStorefront: inserted[0].isVisibleOnStorefront,
        }),
      });

      res.status(201).json({ product: inserted[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/admin/products/:id',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid product ID' });

    const schema = z.object({
      restaurantId: z.number().int().positive().optional(),
      category: z.string().min(2).optional(),
      name: z.string().min(2).optional(),
      nameBn: z.string().min(1).optional(),
      description: z.string().optional(),
      imageUrl: z.string().optional(),
      price: z.number().int().positive().optional(),
      discountPrice: z.number().int().positive().nullable().optional(),
      inStock: z.boolean().optional(),
      isAvailable: z.boolean().optional(),
      isVisibleOnStorefront: z.boolean().optional(),
      isPopular: z.boolean().optional(),
      variationsJson: z
        .array(z.object({ name: z.string(), priceDelta: z.number() }))
        .optional(),
      addonsJson: z
        .array(z.object({ name: z.string(), price: z.number() }))
        .optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid product update payload' });

    try {
      const existing = await db.select().from(foodItems).where(eq(foodItems.id, id)).limit(1);
      if (existing.length === 0) return res.status(404).json({ error: 'Product not found' });
      const cur = existing[0];

      const updated = await db
        .update(foodItems)
        .set({
          restaurantId: parsed.data.restaurantId ?? cur.restaurantId,
          category: parsed.data.category?.trim() || cur.category,
          name: parsed.data.name?.trim() || cur.name,
          nameBn: parsed.data.nameBn?.trim() || cur.nameBn,
          description: parsed.data.description ?? cur.description,
          imageUrl: parsed.data.imageUrl?.trim() || cur.imageUrl,
          price: parsed.data.price ?? cur.price,
          discountPrice:
            parsed.data.discountPrice === undefined ? cur.discountPrice : parsed.data.discountPrice,
          inStock: parsed.data.inStock ?? cur.inStock,
          isAvailable: parsed.data.isAvailable ?? cur.isAvailable,
          isVisibleOnStorefront:
            parsed.data.isVisibleOnStorefront ?? cur.isVisibleOnStorefront,
          isPopular: parsed.data.isPopular ?? cur.isPopular,
          variationsJson: parsed.data.variationsJson ?? cur.variationsJson,
          addonsJson: parsed.data.addonsJson ?? cur.addonsJson,
          updatedAt: new Date(),
        })
        .where(eq(foodItems.id, id))
        .returning();

      const visibilityChanged =
        parsed.data.isVisibleOnStorefront !== undefined &&
        parsed.data.isVisibleOnStorefront !== cur.isVisibleOnStorefront;

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: visibilityChanged ? 'product_visibility_toggled' : 'product_updated',
        targetType: 'food_item',
        targetId: String(id),
        details: JSON.stringify({
          name: updated[0].name,
          price: updated[0].price,
          isVisibleOnStorefront: updated[0].isVisibleOnStorefront,
        }),
      });

      res.json({ product: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.delete(
  '/api/admin/products/:id',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid product ID' });

    try {
      const deleted = await db.delete(foodItems).where(eq(foodItems.id, id)).returning();
      if (deleted.length === 0) return res.status(404).json({ error: 'Product not found' });

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'product_deleted',
        targetType: 'food_item',
        targetId: String(id),
        details: JSON.stringify({ name: deleted[0].name }),
      });

      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/admin/orders/:id/status',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const orderId = Number(req.params.id);
    const schema = z.object({
      status: z.enum([
        'confirmed',
        'accepted',
        'preparing',
        'ready',
        'rider_assigned',
        'picked_up',
        'on_the_way',
        'delivered',
        'cancelled',
      ]),
      riderUid: z.string().nullable().optional(),
      note: z.string().optional(),
    });
    const parsed = schema.safeParse(req.body);
    if (!Number.isInteger(orderId) || !parsed.success) {
      return res.status(400).json({ error: 'Invalid admin order status payload' });
    }

    try {
      const rows = await db.select().from(orders).where(eq(orders.id, orderId)).limit(1);
      if (rows.length === 0) return res.status(404).json({ error: 'Order not found' });
      const order = rows[0];

      let nextRiderUid = order.riderUid;
      let nextRiderName = order.riderName;
      if (parsed.data.riderUid !== undefined) {
        if (parsed.data.riderUid === null || parsed.data.riderUid === '') {
          nextRiderUid = null;
          nextRiderName = null;
        } else {
          const riderRows = await db
            .select()
            .from(riders)
            .where(eq(riders.uid, parsed.data.riderUid))
            .limit(1);
          nextRiderUid = parsed.data.riderUid;
          nextRiderName = riderRows[0]?.fullName || parsed.data.riderUid;
        }
      }

      const updated = await db
        .update(orders)
        .set({
          status: parsed.data.status,
          riderUid: nextRiderUid,
          riderName: nextRiderName,
          paymentStatus:
            parsed.data.status === 'delivered' && order.paymentMethod === 'cod'
              ? 'paid'
              : order.paymentStatus,
          updatedAt: new Date(),
        })
        .where(eq(orders.id, orderId))
        .returning();

      await db.insert(orderStatusHistory).values({
        orderId,
        status: parsed.data.status,
        note: parsed.data.note || `Admin updated status to ${parsed.data.status.replace(/_/g, ' ')}`,
        actorUid: req.user!.uid,
      });

      if (parsed.data.status === 'delivered') {
        await settleOrderCommissionIdempotent(orderId);
      }

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'order_override',
        targetType: 'order',
        targetId: String(orderId),
        details: JSON.stringify(parsed.data),
      });

      if (updated[0].customerEmail) {
        const assignedRiderRows = updated[0].riderUid
          ? await db
              .select({ phone: riders.phone })
              .from(riders)
              .where(eq(riders.uid, updated[0].riderUid))
              .limit(1)
          : [];
        await sendAndLogOrderTrackingEmail({
          origin: getRequestOrigin(req),
          orderId: updated[0].id,
          orderNumber: updated[0].orderNumber,
          trackingToken: updated[0].trackingToken,
          customerName: updated[0].customerName,
          customerEmail: updated[0].customerEmail,
          restaurantName: updated[0].restaurantName,
          deliveryArea: updated[0].deliveryArea,
          deliveryAddress: updated[0].deliveryAddress,
          totalAmount: updated[0].totalAmount,
          paymentMethod: updated[0].paymentMethod,
          paymentStatus: updated[0].paymentStatus,
          status: updated[0].status,
          statusEvent: parsed.data.status,
          statusNote:
            parsed.data.note || `Order update: ${parsed.data.status.replace(/_/g, ' ')}`,
          riderName: updated[0].riderName,
          riderPhone: assignedRiderRows[0]?.phone || null,
          etaMinutes: updated[0].estimatedMinutes,
          items: updated[0].itemsSnapshotJson,
        });
      }

      broadcastOrderEvent('order:updated', {
        orderId: updated[0].id,
        orderNumber: updated[0].orderNumber,
        restaurantId: updated[0].restaurantId,
        restaurantName: updated[0].restaurantName,
        customerUid: updated[0].customerUid,
        riderUid: updated[0].riderUid,
        riderName: updated[0].riderName,
        status: updated[0].status,
        deliveryMode: updated[0].deliveryMode,
        deliveryArea: updated[0].deliveryArea,
        totalAmount: updated[0].totalAmount,
      });

      res.json({ order: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/admin/orders/:id/refund',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const orderId = Number(req.params.id);
    if (!Number.isInteger(orderId)) return res.status(400).json({ error: 'Invalid order ID' });

    try {
      const result = await db.transaction(async (tx) => {
        const rows = await tx.select().from(orders).where(eq(orders.id, orderId)).limit(1);
        if (rows.length === 0) throw new Error('Order not found');
        const order = rows[0];

        const updated = await tx
          .update(orders)
          .set({
            status: 'cancelled',
            paymentStatus: order.paymentStatus === 'paid' ? 'refunded' : 'failed',
            cancelReason: req.body.reason || 'Cancelled & refunded by Super Admin',
            updatedAt: new Date(),
          })
          .where(eq(orders.id, order.id))
          .returning();

        const existingReversal = await tx
          .select()
          .from(commissionLedger)
          .where(
            and(
              eq(commissionLedger.orderId, order.id),
              eq(commissionLedger.entryType, 'commission_reversal')
            )
          )
          .limit(1);

        if (existingReversal.length === 0 && order.platformCommission > 0) {
          await tx.insert(commissionLedger).values({
            orderId: order.id,
            restaurantId: order.restaurantId,
            entryType: 'commission_reversal',
            grossAmount: -Math.max(0, order.subtotal - order.discountAmount),
            commissionAmount: -order.platformCommission,
            netRestaurantAmount: -order.restaurantEarnings,
            deliveryFeeAmount: -order.deliveryFee,
            note: `Refund reversal for ${order.orderNumber}`,
          });
        }

        await tx.insert(orderStatusHistory).values({
          orderId: order.id,
          status: 'cancelled',
          note: 'Order cancelled and commission reversed by Super Admin',
          actorUid: req.user!.uid,
        });

        await tx.insert(auditLogs).values({
          actorUid: req.user!.uid,
          action: 'order_refund',
          targetType: 'order',
          targetId: String(order.id),
          details: JSON.stringify({ orderNumber: order.orderNumber }),
        });

        return updated[0];
      });

      if (result.customerEmail) {
        await sendAndLogOrderTrackingEmail({
          origin: getRequestOrigin(req),
          orderId: result.id,
          orderNumber: result.orderNumber,
          trackingToken: result.trackingToken,
          customerName: result.customerName,
          customerEmail: result.customerEmail,
          restaurantName: result.restaurantName,
          deliveryArea: result.deliveryArea,
          deliveryAddress: result.deliveryAddress,
          totalAmount: result.totalAmount,
          paymentMethod: result.paymentMethod,
          paymentStatus: result.paymentStatus,
          status: result.status,
          statusEvent: 'cancelled',
          statusNote: result.cancelReason || 'Order cancelled & refunded by Admin',
          riderName: result.riderName,
          etaMinutes: result.estimatedMinutes,
          items: result.itemsSnapshotJson,
        });
      }

      broadcastOrderEvent('order:updated', {
        orderId: result.id,
        orderNumber: result.orderNumber,
        restaurantId: result.restaurantId,
        restaurantName: result.restaurantName,
        customerUid: result.customerUid,
        riderUid: result.riderUid,
        riderName: result.riderName,
        status: result.status,
        deliveryMode: result.deliveryMode,
        deliveryArea: result.deliveryArea,
        totalAmount: result.totalAmount,
      });

      res.json({ order: result });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/admin/payouts/:id',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid payout ID' });
    const status = req.body.status === 'rejected' ? 'rejected' : 'paid';

    try {
      const updated = await db
        .update(restaurantPayouts)
        .set({
          status,
          referenceId: status === 'paid' ? `PAY-${Date.now().toString(36).toUpperCase()}` : '',
          processedAt: new Date(),
        })
        .where(eq(restaurantPayouts.id, id))
        .returning();
      if (updated.length === 0) return res.status(404).json({ error: 'Payout not found' });

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: `payout_${status}`,
        targetType: 'payout',
        targetId: String(id),
        details: JSON.stringify({ amount: updated[0].amount }),
      });

      res.json({ payout: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.post(
  '/api/admin/coupons',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const schema = z.object({
      code: z.string().min(3).max(24),
      title: z.string().min(3),
      type: z.enum(['percentage', 'fixed', 'free_delivery']),
      value: z.number().int().min(0),
      minOrder: z.number().int().min(0).default(0),
      maxDiscount: z.number().int().min(0).default(300),
    });
    const parsed = schema.safeParse(req.body);
    if (!parsed.success) return res.status(400).json({ error: 'Invalid coupon data' });

    try {
      const inserted = await db
        .insert(coupons)
        .values({
          code: parsed.data.code.trim().toUpperCase(),
          title: parsed.data.title,
          type: parsed.data.type,
          value: parsed.data.value,
          minOrder: parsed.data.minOrder,
          maxDiscount: parsed.data.maxDiscount,
          isActive: true,
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'coupon_created',
        targetType: 'coupon',
        targetId: String(inserted[0].id),
        details: JSON.stringify({ code: inserted[0].code }),
      });

      res.status(201).json({ coupon: inserted[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/admin/coupons/:id',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid coupon ID' });

    try {
      const rows = await db.select().from(coupons).where(eq(coupons.id, id)).limit(1);
      if (rows.length === 0) return res.status(404).json({ error: 'Coupon not found' });
      const updated = await db
        .update(coupons)
        .set({
          isActive: typeof req.body.isActive === 'boolean' ? req.body.isActive : rows[0].isActive,
        })
        .where(eq(coupons.id, id))
        .returning();
      res.json({ coupon: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.delete(
  '/api/admin/coupons/:id',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid coupon ID' });

    try {
      await db.delete(coupons).where(eq(coupons.id, id));
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/admin/settings',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    try {
      const existing = await db.select().from(platformSettings).limit(1);
      if (existing.length === 0) return res.status(404).json({ error: 'Settings missing' });
      const cur = existing[0];
      const curStorefront =
        cur.storefrontConfig && typeof cur.storefrontConfig === 'object' ? cur.storefrontConfig : {};
      const nextStorefront =
        req.body.storefrontConfig && typeof req.body.storefrontConfig === 'object'
          ? { ...curStorefront, ...req.body.storefrontConfig }
          : curStorefront;

      const updated = await db
        .update(platformSettings)
        .set({
          platformName:
            typeof req.body.platformName === 'string' && req.body.platformName.trim()
              ? req.body.platformName.trim()
              : cur.platformName,
          defaultCommissionPct: req.body.defaultCommissionPct ?? cur.defaultCommissionPct,
          defaultDeliveryFee:
            typeof req.body.defaultDeliveryFee === 'number'
              ? req.body.defaultDeliveryFee
              : cur.defaultDeliveryFee,
          serviceFee:
            typeof req.body.serviceFee === 'number' ? req.body.serviceFee : cur.serviceFee,
          minOrderDefault:
            typeof req.body.minOrderDefault === 'number'
              ? req.body.minOrderDefault
              : cur.minOrderDefault,
          pathaoEnabled: req.body.pathaoEnabled ?? cur.pathaoEnabled,
          pathaoSandbox: req.body.pathaoSandbox ?? cur.pathaoSandbox,
          bkashEnabled: req.body.bkashEnabled ?? cur.bkashEnabled,
          bkashSandbox: req.body.bkashSandbox ?? cur.bkashSandbox,
          sslcommerzEnabled: req.body.sslcommerzEnabled ?? cur.sslcommerzEnabled,
          sslcommerzSandbox: req.body.sslcommerzSandbox ?? cur.sslcommerzSandbox,
          storefrontConfig: nextStorefront,
          updatedAt: new Date(),
        })
        .where(eq(platformSettings.id, cur.id))
        .returning();

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'platform_settings_updated',
        targetType: 'platform_settings',
        targetId: String(cur.id),
        details: JSON.stringify(req.body),
      });

      res.json({ settings: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/admin/users/:id',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid user ID' });

    const allowedRoles = ['customer', 'restaurant_owner', 'rider', 'admin', 'super_admin'];
    try {
      const existing = await db.select().from(users).where(eq(users.id, id)).limit(1);
      if (existing.length === 0) return res.status(404).json({ error: 'User not found' });
      const target = existing[0];
      const nextStatus =
        req.body.status === 'suspended' || req.body.status === 'active'
          ? req.body.status
          : target.status;
      const nextRole =
        typeof req.body.role === 'string' && allowedRoles.includes(req.body.role)
          ? req.body.role
          : target.role;

      const decision = canActorModifyUserAccount({
        actorUid: req.user!.uid,
        actorRole: req.user!.role,
        targetUid: target.uid,
        targetEmail: target.email,
        currentRole: target.role,
        nextRole,
        nextStatus,
      });
      if (!decision.allowed) {
        return res.status(403).json({ error: decision.reason || 'Forbidden: Role change not permitted.' });
      }

      const updated = await db
        .update(users)
        .set({ status: nextStatus, role: nextRole, updatedAt: new Date() })
        .where(eq(users.id, id))
        .returning();

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'user_updated',
        targetType: 'user',
        targetId: String(id),
        details: JSON.stringify({ role: nextRole, status: nextStatus }),
      });

      res.json({ user: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

app.patch(
  '/api/admin/riders/:id',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const id = Number(req.params.id);
    if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid rider ID' });

    const schema = z.object({
      status: z.enum(['pending', 'approved', 'suspended']).optional(),
      isAvailable: z.boolean().optional(),
      zone: z.string().trim().min(2).max(120).optional(),
      vehicleType: z.string().trim().min(2).max(40).optional(),
      currentLat: z.number().min(-90).max(90).optional(),
      currentLng: z.number().min(-180).max(180).optional(),
    });
    const parsed = schema.safeParse(req.body || {});
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid rider update payload' });
    }

    try {
      const existing = await db.select().from(riders).where(eq(riders.id, id)).limit(1);
      if (existing.length === 0) return res.status(404).json({ error: 'Rider not found' });
      const cur = existing[0];

      const hasCoords =
        typeof parsed.data.currentLat === 'number' || typeof parsed.data.currentLng === 'number';

      const updated = await db
        .update(riders)
        .set({
          status: parsed.data.status ?? cur.status,
          isAvailable:
            typeof parsed.data.isAvailable === 'boolean' ? parsed.data.isAvailable : cur.isAvailable,
          zone: parsed.data.zone ? parsed.data.zone : cur.zone,
          vehicleType: parsed.data.vehicleType ? parsed.data.vehicleType : cur.vehicleType,
          currentLat:
            typeof parsed.data.currentLat === 'number'
              ? Math.round(parsed.data.currentLat * 1e6) / 1e6
              : cur.currentLat,
          currentLng:
            typeof parsed.data.currentLng === 'number'
              ? Math.round(parsed.data.currentLng * 1e6) / 1e6
              : cur.currentLng,
          locationUpdatedAt: hasCoords ? new Date() : cur.locationUpdatedAt,
        })
        .where(eq(riders.id, id))
        .returning();

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: hasCoords ? 'rider_gps_override' : 'rider_updated',
        targetType: 'rider',
        targetId: String(id),
        details: JSON.stringify(parsed.data),
      });

      res.json({ rider: updated[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message });
    }
  }
);

// ---------- Super Admin Extensible Payment Gateway Integrations (bKash, Nagad, SSLCommerz & Future Gateways) ----------

app.get(
  '/api/admin/payment-gateways',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    try {
      const origin = getRequestOrigin(req);
      const rows = await ensureDefaultPaymentGateways();
      res.json({
        paymentGateways: rows.map((r) =>
          toAdminPaymentGatewayView(r, origin, isEnvConfiguredForGateway(r.code))
        ),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to load payment gateways' });
    }
  }
);

app.put(
  '/api/admin/payment-gateways',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const schema = z.object({
      code: z.string().min(2).max(32),
      name: z.string().min(2).max(60),
      nameBn: z.string().min(1).max(60).optional(),
      providerType: z.enum(['mfs', 'card', 'wallet', 'cod', 'custom']).default('mfs'),
      mode: z.enum(['sandbox', 'live']).default('sandbox'),
      isActive: z.boolean().default(true),
      apiBaseUrl: z.string().max(240).optional().default(''),
      merchantId: z.string().max(120).optional().default(''),
      apiKey: z.string().max(240).optional(),
      apiSecret: z.string().max(240).optional(),
      webhookSecret: z.string().max(240).optional(),
      instructions: z.string().max(300).optional().default(''),
      sortOrder: z.number().int().min(1).max(100).optional().default(10),
    });

    const parsed = schema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: 'Invalid payment gateway configuration payload' });
    }

    const code = normalizeGatewayCode(parsed.data.code);
    if (code.length < 2) {
      return res.status(400).json({ error: 'Gateway code must contain at least 2 alphanumeric characters' });
    }

    try {
      await ensureDefaultPaymentGateways();
      const existing = await db
        .select()
        .from(paymentGateways)
        .where(eq(paymentGateways.code, code))
        .limit(1);

      const keepOrReplaceSecret = (incoming: string | undefined, prev: string | null | undefined) => {
        if (incoming === undefined) return prev || '';
        const clean = incoming.trim();
        if (!clean || clean.startsWith('••••')) return prev || '';
        return clean;
      };

      const cur = existing[0];
      const nextValues = {
        code,
        name: parsed.data.name.trim(),
        nameBn: parsed.data.nameBn?.trim() || parsed.data.name.trim(),
        providerType: parsed.data.providerType,
        mode: code === 'cod' ? 'live' : parsed.data.mode,
        isActive: parsed.data.isActive,
        apiBaseUrl: parsed.data.apiBaseUrl.trim(),
        merchantId: parsed.data.merchantId.trim(),
        apiKey: keepOrReplaceSecret(parsed.data.apiKey, cur?.apiKey),
        apiSecret: keepOrReplaceSecret(parsed.data.apiSecret, cur?.apiSecret),
        webhookSecret: keepOrReplaceSecret(parsed.data.webhookSecret, cur?.webhookSecret),
        instructions: parsed.data.instructions.trim(),
        sortOrder: parsed.data.sortOrder,
        updatedAt: new Date(),
      };

      const saved = await db
        .insert(paymentGateways)
        .values(nextValues)
        .onConflictDoUpdate({
          target: paymentGateways.code,
          set: nextValues,
        })
        .returning();

      if (code === 'bkash' || code === 'sslcommerz') {
        const settingsRows = await db.select().from(platformSettings).limit(1);
        if (settingsRows.length > 0) {
          await db
            .update(platformSettings)
            .set(
              code === 'bkash'
                ? {
                    bkashEnabled: nextValues.isActive,
                    bkashSandbox: nextValues.mode !== 'live',
                    updatedAt: new Date(),
                  }
                : {
                    sslcommerzEnabled: nextValues.isActive,
                    sslcommerzSandbox: nextValues.mode !== 'live',
                    updatedAt: new Date(),
                  }
            )
            .where(eq(platformSettings.id, settingsRows[0].id));
        }
      }

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: cur ? 'payment_gateway_updated' : 'payment_gateway_created',
        targetType: 'payment_gateway',
        targetId: code,
        details: JSON.stringify({
          name: nextValues.name,
          mode: nextValues.mode,
          isActive: nextValues.isActive,
          providerType: nextValues.providerType,
        }),
      });

      res.json({
        paymentGateway: toAdminPaymentGatewayView(
          saved[0],
          getRequestOrigin(req),
          isEnvConfiguredForGateway(code)
        ),
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to save payment gateway' });
    }
  }
);

app.post(
  '/api/admin/payment-gateways/:code/test',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const code = normalizeGatewayCode(String(req.params.code || ''));
    if (!code) return res.status(400).json({ error: 'Invalid gateway code' });
    try {
      await ensureDefaultPaymentGateways();
      const rows = await db
        .select()
        .from(paymentGateways)
        .where(eq(paymentGateways.code, code))
        .limit(1);
      if (rows.length === 0) return res.status(404).json({ error: 'Gateway not found' });
      const result = validatePaymentGatewayConfiguration(
        rows[0],
        isEnvConfiguredForGateway(code)
      );
      res.json(result);
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Gateway test failed' });
    }
  }
);

app.delete(
  '/api/admin/payment-gateways/:code',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const code = normalizeGatewayCode(String(req.params.code || ''));
    if (!code) return res.status(400).json({ error: 'Invalid gateway code' });
    if (['bkash', 'nagad', 'sslcommerz', 'cod'].includes(code)) {
      return res.status(400).json({
        error: 'Built-in gateways cannot be deleted. Disable them instead.',
      });
    }
    try {
      await db.delete(paymentGateways).where(eq(paymentGateways.code, code));
      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'payment_gateway_deleted',
        targetType: 'payment_gateway',
        targetId: code,
        details: `Removed custom payment gateway ${code}`,
      });
      res.json({ deleted: true });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to delete payment gateway' });
    }
  }
);

// ---------- Super Admin Backend Control (DB Diagnostics, Broadcasts, Maintenance & Backup) ----------

app.get(
  '/api/admin/backend/status',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (_req, res) => {
    const started = Date.now();
    try {
      await db.execute(sql`SELECT 1`);
      const latencyMs = Math.max(1, Date.now() - started);

      const [
        usersCount,
        restaurantsCount,
        foodItemsCount,
        ordersCount,
        ridersCount,
        couponsCount,
        notificationsCount,
        ledgerCount,
        auditCount,
      ] = await Promise.all([
        db.select({ count: sql<number>`count(*)::int` }).from(users),
        db.select({ count: sql<number>`count(*)::int` }).from(restaurants),
        db.select({ count: sql<number>`count(*)::int` }).from(foodItems),
        db.select({ count: sql<number>`count(*)::int` }).from(orders),
        db.select({ count: sql<number>`count(*)::int` }).from(riders),
        db.select({ count: sql<number>`count(*)::int` }).from(coupons),
        db.select({ count: sql<number>`count(*)::int` }).from(notifications),
        db.select({ count: sql<number>`count(*)::int` }).from(commissionLedger),
        db.select({ count: sql<number>`count(*)::int` }).from(auditLogs),
      ]);

      const connStr =
        process.env.DATABASE_URL ||
        process.env.POSTGRES_URL ||
        process.env.SUPABASE_DB_URL ||
        '';
      const databaseProvider = connStr
        ? 'supabase-or-external-url'
        : process.env.SQL_HOST
        ? 'cloudsql-pg'
        : 'local-pg';
      const sslActive =
        Boolean(connStr) && !connStr.includes('localhost') && !connStr.includes('127.0.0.1');

      res.json({
        ok: true,
        checkedAt: new Date().toISOString(),
        latencyMs,
        runtime: process.env.VERCEL ? 'vercel-serverless' : 'node-express',
        databaseProvider,
        sslActive,
        integrations: {
          databaseConfigured: Boolean(connStr || process.env.SQL_HOST),
          supabaseAuthConfigured: Boolean(
            process.env.SUPABASE_URL ||
              process.env.VITE_SUPABASE_URL ||
              'https://uvqptlflvdtxbrqiztzi.supabase.co'
          ),
          googleMapsConfigured: Boolean(
            process.env.VITE_GOOGLE_MAPS_API_KEY || process.env.GOOGLE_MAPS_API_KEY
          ),
          bkashLiveConfigured: Boolean(process.env.BKASH_APP_KEY && process.env.BKASH_APP_SECRET),
          sslcommerzLiveConfigured: Boolean(
            process.env.SSLCOMMERZ_STORE_ID && process.env.SSLCOMMERZ_STORE_PASSWD
          ),
          pathaoLiveConfigured: Boolean(
            process.env.PATHAO_CLIENT_ID && process.env.PATHAO_CLIENT_SECRET
          ),
        },
        tableCounts: {
          users: Number(usersCount[0]?.count ?? 0),
          restaurants: Number(restaurantsCount[0]?.count ?? 0),
          foodItems: Number(foodItemsCount[0]?.count ?? 0),
          orders: Number(ordersCount[0]?.count ?? 0),
          riders: Number(ridersCount[0]?.count ?? 0),
          coupons: Number(couponsCount[0]?.count ?? 0),
          notifications: Number(notificationsCount[0]?.count ?? 0),
          commissionLedger: Number(ledgerCount[0]?.count ?? 0),
          auditLogs: Number(auditCount[0]?.count ?? 0),
        },
      });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Database health check failed' });
    }
  }
);

app.post(
  '/api/admin/notifications/broadcast',
  requireAuth,
  requireRole(['admin', 'super_admin']),
  async (req: AuthRequest, res) => {
    const validated = validateBroadcastNotification({
      targetRole: String(req.body?.targetRole || ''),
      title: String(req.body?.title || ''),
      message: String(req.body?.message || ''),
      type: typeof req.body?.type === 'string' ? req.body.type : 'system',
    });
    if (!validated.valid) {
      return res.status(400).json({ error: validated.reason });
    }

    try {
      const recipientUid =
        validated.targetRole === 'all' ? 'broadcast-all' : `role-${validated.targetRole}`;
      const inserted = await db
        .insert(notifications)
        .values({
          recipientUid,
          roleTarget: validated.targetRole,
          title: validated.title,
          message: validated.message,
          type: validated.type,
        })
        .returning();

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'notification_broadcast',
        targetType: 'notification',
        targetId: String(inserted[0].id),
        details: JSON.stringify({ targetRole: validated.targetRole, title: validated.title }),
      });

      broadcastNotificationEvent({
        recipientUid,
        roleTarget: validated.targetRole,
        title: validated.title,
        message: validated.message,
        type: validated.type,
      });

      res.status(201).json({ notification: inserted[0] });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to send broadcast' });
    }
  }
);

app.post(
  '/api/admin/backend/reseed',
  requireAuth,
  requireRole(['super_admin']),
  async (req: AuthRequest, res) => {
    try {
      await ensureDatabaseSeeded();
      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'backend_reseed_verified',
        targetType: 'database',
        targetId: 'seed',
        details: 'Verified and repaired baseline marketplace seed records without wiping data.',
      });
      res.json({ ok: true, message: 'Database seed integrity verified cleanly.' });
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Database seed verification failed' });
    }
  }
);

app.get(
  '/api/admin/backend/backup',
  requireAuth,
  requireRole(['super_admin']),
  async (req: AuthRequest, res) => {
    try {
      const [
        allUsers,
        allRestaurants,
        allFoodItems,
        allOrders,
        allRiders,
        allCoupons,
        allLedger,
        allPayouts,
        allSettings,
        allNotifications,
      ] = await Promise.all([
        db
          .select({
            id: users.id,
            uid: users.uid,
            email: users.email,
            fullName: users.fullName,
            phone: users.phone,
            role: users.role,
            status: users.status,
            createdAt: users.createdAt,
          })
          .from(users),
        db.select().from(restaurants),
        db.select().from(foodItems),
        db.select().from(orders),
        db.select().from(riders),
        db.select().from(coupons),
        db.select().from(commissionLedger),
        db.select().from(restaurantPayouts),
        db.select().from(platformSettings),
        db.select().from(notifications),
      ]);

      await db.insert(auditLogs).values({
        actorUid: req.user!.uid,
        action: 'backend_backup_exported',
        targetType: 'database',
        targetId: 'json',
        details: JSON.stringify({
          exportedBy: req.user!.email,
          orders: allOrders.length,
          restaurants: allRestaurants.length,
        }),
      });

      const payload = {
        exportedAt: new Date().toISOString(),
        exportedBy: req.user!.email,
        platform: 'Foodora BD',
        tables: {
          users: allUsers,
          restaurants: allRestaurants,
          foodItems: allFoodItems,
          orders: allOrders,
          riders: allRiders,
          coupons: allCoupons,
          commissionLedger: allLedger,
          restaurantPayouts: allPayouts,
          platformSettings: allSettings,
          notifications: allNotifications,
        },
      };

      res.setHeader('Content-Type', 'application/json; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="foodora-bd-db-backup.json"');
      res.send(JSON.stringify(payload, null, 2));
    } catch (error: any) {
      res.status(500).json({ error: error.message || 'Failed to generate database backup' });
    }
  }
);

// ---------- Project Source ZIP Export (Clean, Verified, No Secrets/Temp Bloat) ----------

const EXCLUDED_ZIP_DIRS = new Set([
  'node_modules',
  'dist',
  '.git',
  '.playwright-cli',
  '.aistudio',
  '.cache',
  '.gmp_cache',
  'tmp',
]);

const EXCLUDED_ZIP_FILES = new Set(['.env', '.DS_Store']);

async function addDirectoryToZip(zipFolder: JSZip, fsDir: string, relBase = '') {
  const entries = await fs.promises.readdir(fsDir, { withFileTypes: true });
  for (const entry of entries) {
    const relPath = relBase ? `${relBase}/${entry.name}` : entry.name;
    const fullPath = path.join(fsDir, entry.name);

    if (entry.isDirectory()) {
      if (EXCLUDED_ZIP_DIRS.has(entry.name)) continue;
      // Skip public/assets/aistudio reference screenshot PDF (115MB+)
      if (relPath === 'public/assets/aistudio' || relPath === 'public\\assets\\aistudio') continue;
      await addDirectoryToZip(zipFolder, fullPath, relPath);
    } else if (entry.isFile()) {
      if (EXCLUDED_ZIP_FILES.has(entry.name)) continue;
      if (entry.name.endsWith('.log') || entry.name.endsWith('.zip')) continue;
      const content = await fs.promises.readFile(fullPath);
      zipFolder.file(relPath, content);
    }
  }
}

app.get('/api/export/project-zip', async (_req, res) => {
  try {
    const zip = new JSZip();
    const rootFolder = zip.folder('foodora-bd');
    if (!rootFolder) {
      return res.status(500).json({ error: 'Failed to initialize ZIP archive' });
    }

    await addDirectoryToZip(rootFolder, PROJECT_ROOT);

    const buffer = await zip.generateAsync({
      type: 'nodebuffer',
      compression: 'DEFLATE',
      compressionOptions: { level: 6 },
    });

    res.setHeader('Content-Type', 'application/zip');
    res.setHeader('Content-Disposition', 'attachment; filename="foodora-bd-project.zip"');
    res.setHeader('Content-Length', String(buffer.byteLength));
    res.send(buffer);
  } catch (error: any) {
    console.error('Project ZIP export failed:', error);
    res.status(500).json({ error: error.message || 'Failed to generate ZIP file' });
  }
});

// ---------- Notifications ----------

app.get('/api/notifications', requireAuth, async (req: AuthRequest, res) => {
  const list = await getNotificationsForUser(req.user!.uid, req.user!.role);
  res.json({ notifications: list });
});

app.post('/api/notifications/read-all', requireAuth, async (req: AuthRequest, res) => {
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(
      or(
        eq(notifications.recipientUid, req.user!.uid),
        eq(notifications.roleTarget, req.user!.role),
        eq(notifications.roleTarget, 'all')
      )
    );
  res.json({ ok: true });
});

app.post('/api/notifications/:id/read', requireAuth, async (req: AuthRequest, res) => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id)) return res.status(400).json({ error: 'Invalid notification ID' });
  await db
    .update(notifications)
    .set({ isRead: true })
    .where(
      and(
        eq(notifications.id, id),
        or(
          eq(notifications.recipientUid, req.user!.uid),
          eq(notifications.roleTarget, req.user!.role),
          eq(notifications.roleTarget, 'all')
        )
      )
    );
  res.json({ ok: true });
});

// ---------- Bilingual AI Help Assistant (Bangla & English via Gemini) ----------

function getGeminiHelpClient(): GoogleGenAI | null {
  const apiKey = (process.env.GEMINI_API_KEY || '').trim();
  if (!apiKey) return null;
  return new GoogleGenAI({
    apiKey,
    httpOptions: {
      headers: {
        'User-Agent': 'aistudio-build',
      },
    },
  });
}

const aiHelpRequestSchema = z.object({
  message: z.string().trim().min(1, 'Please enter a question.').max(1500),
  langPreference: z.enum(['auto', 'bn', 'en']).optional().default('auto'),
  uiLang: z.enum(['en', 'bn']).optional().default('en'),
  history: z
    .array(
      z.object({
        role: z.enum(['user', 'model']),
        text: z.string().trim().min(1).max(1500),
      })
    )
    .optional()
    .default([]),
  context: z
    .object({
      area: z.string().trim().max(120).optional(),
      viewType: z.string().trim().max(60).optional(),
      activeOrderNumber: z.string().trim().max(60).optional(),
    })
    .optional(),
});

function extractReadableGeminiError(err: unknown): { status: number; message: string } {
  const rawStatus =
    typeof (err as { status?: unknown })?.status === 'number'
      ? (err as { status: number }).status
      : 502;
  const rawMsg = err instanceof Error ? err.message : 'Failed to generate AI Help response.';

  let parsedMessage = rawMsg;
  let parsedStatus = rawStatus;
  if (rawMsg.trim().startsWith('{')) {
    try {
      const obj = JSON.parse(rawMsg) as {
        error?: { code?: number; message?: string; status?: string };
        message?: string;
      };
      if (obj.error?.message) parsedMessage = obj.error.message;
      else if (obj.message) parsedMessage = obj.message;
      if (typeof obj.error?.code === 'number') parsedStatus = obj.error.code;
    } catch {
      // keep rawMsg
    }
  }

  return {
    status: parsedStatus >= 400 && parsedStatus < 600 ? parsedStatus : 502,
    message: parsedMessage,
  };
}

function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const err = new Error(`${label} timed out after ${Math.round(ms / 1000)}s`);
      (err as Error & { status?: number }).status = 504;
      reject(err);
    }, ms);
    promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        clearTimeout(timer);
        reject(err);
      }
    );
  });
}

app.post('/api/ai/help', optionalAuth, async (req: AuthRequest, res) => {
  try {
    const parsed = aiHelpRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({
        error: parsed.error.issues[0]?.message || 'Invalid AI Help request payload.',
      });
    }

    const ai = getGeminiHelpClient();
    if (!ai) {
      return res.status(503).json({
        error:
          'AI Help is unavailable because GEMINI_API_KEY is not configured in Settings > Secrets.',
      });
    }

    const { message, langPreference, uiLang, history, context } = parsed.data;
    const systemInstruction = buildAiHelpSystemInstruction({
      langPreference: langPreference as AiHelpLangPreference,
      uiLang,
      area: context?.area,
      viewType: context?.viewType,
      activeOrderNumber: context?.activeOrderNumber,
    });

    const contents = [
      ...history.slice(-8).map((item) => ({
        role: item.role,
        parts: [{ text: item.text }],
      })),
      {
        role: 'user' as const,
        parts: [{ text: message }],
      },
    ];

    const attempts: Array<{ model: string; thinkingLevel: ThinkingLevel; timeoutMs: number }> = [
      { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL, timeoutMs: 9000 },
      { model: 'gemini-4-hydrogen', thinkingLevel: ThinkingLevel.LOW, timeoutMs: 9000 },
      { model: 'gemini-3.1-flash-lite', thinkingLevel: ThinkingLevel.MINIMAL, timeoutMs: 10000 },
    ];

    let reply = '';
    let usedModel = attempts[0].model;
    let lastError: unknown = null;

    for (let i = 0; i < attempts.length; i += 1) {
      const attempt = attempts[i];
      try {
        const response = await withTimeout(
          ai.models.generateContent({
            model: attempt.model,
            contents,
            config: {
              systemInstruction,
              thinkingConfig: { thinkingLevel: attempt.thinkingLevel },
            },
          }),
          attempt.timeoutMs,
          attempt.model
        );
        const text = (response.text || '').trim();
        if (!text) {
          const emptyErr = new Error('AI Help returned an empty response.');
          (emptyErr as Error & { status?: number }).status = 502;
          throw emptyErr;
        }
        reply = text;
        usedModel = attempt.model;
        break;
      } catch (err: unknown) {
        lastError = err;
        const { status } = extractReadableGeminiError(err);
        const isTransient = status === 503 || status === 504 || status === 429 || status === 502;
        if (!isTransient || i === attempts.length - 1) {
          throw err;
        }
        await new Promise((r) => setTimeout(r, i === 0 ? 400 : 1000));
      }
    }

    if (!reply && lastError) {
      throw lastError;
    }

    return res.json({
      reply,
      model: usedModel,
    });
  } catch (err: unknown) {
    const { status, message } = extractReadableGeminiError(err);
    console.error('POST /api/ai/help error:', message);
    return res.status(status).json({
      error: message,
    });
  }
});

// ---------- Server Bootstrap (Vite Dev Middleware or Static Production) ----------

async function startServer() {
  const port = Number(process.env.PORT || 3000);

  if (process.env.NODE_ENV !== 'production') {
    const vitePkg = 'vite';
    const { createServer } = await import(/* @vite-ignore */ vitePkg);
    const vite = await createServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(PROJECT_ROOT, 'dist');
    if (fs.existsSync(distPath)) {
      app.use(express.static(distPath));
      app.get('*', (_req, res) => {
        res.sendFile(path.join(distPath, 'index.html'));
      });
    }
  }

  const httpServer = http.createServer(app);
  initRealtimeWebSocketServer(httpServer);

  httpServer.listen(port, '0.0.0.0', () => {
    console.log(`Foodora BD server (HTTP + WS) listening on http://0.0.0.0:${port}`);
  });
}

const isServerless = Boolean(
  process.env.VERCEL ||
    process.env.VERCEL_ENV ||
    process.env.AWS_LAMBDA_FUNCTION_NAME ||
    process.env.NOW_REGION ||
    path.basename(__dirname) === 'api'
);

if (!isServerless) {
  startServer();
}

export { app };
export default app;
