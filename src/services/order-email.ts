import crypto from 'node:crypto';
import nodemailer from 'nodemailer';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { localCredentials, orderEmailLogs } from '../db/schema.ts';
import {
  buildMerchantOrderAlertEmailPayload,
  buildOrderTrackingEmailPayload,
  collectMerchantOrderAlertRecipients,
  PRIMARY_SUPER_ADMIN_EMAIL,
} from '../lib/marketplace-logic.ts';

const EMAIL_CONFIG_KEY = '__email_transport_config__';
const EMAIL_CONFIG_UID = 'sys-email-transport-config';

export interface EmailTransportStatus {
  configured: boolean;
  provider: 'smtp' | 'resend' | 'in_app_email_log';
  fromAddress: string;
  source?: 'database' | 'env' | 'none';
}

export interface AdminEmailSettingsView {
  provider: 'gmail' | 'smtp' | 'resend';
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  fromAddress: string;
  notifyEmail?: string;
  hasSmtpPass: boolean;
  smtpPassPreview: string;
  hasResendKey: boolean;
  resendKeyPreview: string;
  configured: boolean;
  activeProvider: 'smtp' | 'resend' | 'in_app_email_log';
  source: 'database' | 'env' | 'none';
}

interface StoredEmailConfig {
  provider: 'gmail' | 'smtp' | 'resend';
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPassEnc?: string;
  fromAddress: string;
  notifyEmail?: string;
  resendApiKeyEnc?: string;
  updatedAt?: string;
}

interface ResolvedEmailConfig {
  providerMode: 'gmail' | 'smtp' | 'resend';
  smtpHost: string;
  smtpPort: number;
  smtpSecure: boolean;
  smtpUser: string;
  smtpPass: string;
  fromAddress: string;
  resendKey: string;
  source: 'database' | 'env' | 'none';
}

function deriveEncryptionKey(): Buffer {
  const secret =
    process.env.FOODORA_SESSION_SECRET ||
    process.env.SUPABASE_SERVICE_ROLE_KEY ||
    process.env.DATABASE_URL ||
    'foodora-bd-email-config-key-v1';
  return crypto.createHash('sha256').update(secret).digest();
}

function encryptSecret(plain: string): string {
  const clean = plain.trim();
  if (!clean) return '';
  const iv = crypto.randomBytes(12);
  const cipher = crypto.createCipheriv('aes-256-gcm', deriveEncryptionKey(), iv);
  const encrypted = Buffer.concat([cipher.update(clean, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return `v1:${iv.toString('hex')}:${tag.toString('hex')}:${encrypted.toString('hex')}`;
}

function decryptSecret(encoded?: string): string {
  if (!encoded || !encoded.startsWith('v1:')) return '';
  try {
    const [, ivHex, tagHex, dataHex] = encoded.split(':');
    if (!ivHex || !tagHex || !dataHex) return '';
    const decipher = crypto.createDecipheriv(
      'aes-256-gcm',
      deriveEncryptionKey(),
      Buffer.from(ivHex, 'hex')
    );
    decipher.setAuthTag(Buffer.from(tagHex, 'hex'));
    const plain = Buffer.concat([
      decipher.update(Buffer.from(dataHex, 'hex')),
      decipher.final(),
    ]);
    return plain.toString('utf8');
  } catch {
    return '';
  }
}

function maskSecret(val: string): string {
  const clean = val.trim();
  if (!clean) return '';
  if (clean.length <= 4) return '••••';
  return `${clean.slice(0, 2)}••••••${clean.slice(-2)}`;
}

async function readStoredConfig(): Promise<StoredEmailConfig | null> {
  try {
    const rows = await db
      .select({ passwordHash: localCredentials.passwordHash })
      .from(localCredentials)
      .where(eq(localCredentials.email, EMAIL_CONFIG_KEY))
      .limit(1);
    if (!rows[0]?.passwordHash) return null;
    const parsed = JSON.parse(rows[0].passwordHash) as StoredEmailConfig;
    return parsed && typeof parsed === 'object' ? parsed : null;
  } catch {
    return null;
  }
}

async function resolveEffectiveConfig(): Promise<ResolvedEmailConfig> {
  const stored = await readStoredConfig();
  if (stored) {
    const smtpPass = decryptSecret(stored.smtpPassEnc);
    const resendKey = decryptSecret(stored.resendApiKeyEnc);
    const smtpHost =
      stored.provider === 'gmail'
        ? 'smtp.gmail.com'
        : (stored.smtpHost || '').trim();
    const smtpPort = Number(stored.smtpPort) || (stored.provider === 'gmail' ? 465 : 587);
    const smtpSecure =
      stored.provider === 'gmail' ? smtpPort === 465 : Boolean(stored.smtpSecure ?? smtpPort === 465);
    const smtpUser = (stored.smtpUser || '').trim();
    const defaultFrom =
      stored.provider === 'resend'
        ? 'Foodora BD <onboarding@resend.dev>'
        : smtpUser
        ? `Foodora BD <${smtpUser}>`
        : 'Foodora BD <orders@foodora.bd>';
    const fromAddress = (stored.fromAddress || defaultFrom).trim();

    if (
      (stored.provider === 'resend' && resendKey) ||
      ((stored.provider === 'gmail' || stored.provider === 'smtp') && smtpHost && smtpUser && smtpPass)
    ) {
      return {
        providerMode: stored.provider,
        smtpHost,
        smtpPort,
        smtpSecure,
        smtpUser,
        smtpPass,
        fromAddress,
        resendKey,
        source: 'database',
      };
    }
  }

  const envSmtpHost = (process.env.SMTP_HOST || '').trim();
  const envSmtpUser = (process.env.SMTP_USER || '').trim();
  const envSmtpPass = (process.env.SMTP_PASS || '').trim();
  const envSmtpPort = Number(process.env.SMTP_PORT || 587);
  const envSmtpSecure =
    process.env.SMTP_SECURE === 'true' || (!process.env.SMTP_SECURE && envSmtpPort === 465);
  const envResendKey = (
    process.env.RESEND_API_KEY ||
    process.env.EMAIL_PROVIDER_API_KEY ||
    ''
  ).trim();

  if (envSmtpHost && envSmtpUser && envSmtpPass) {
    return {
      providerMode: envSmtpHost.includes('gmail') ? 'gmail' : 'smtp',
      smtpHost: envSmtpHost,
      smtpPort: Number.isFinite(envSmtpPort) ? envSmtpPort : 587,
      smtpSecure: envSmtpSecure,
      smtpUser: envSmtpUser,
      smtpPass: envSmtpPass,
      fromAddress: (process.env.SMTP_FROM || `Foodora BD <${envSmtpUser}>`).trim(),
      resendKey: envResendKey,
      source: 'env',
    };
  }

  if (envResendKey) {
    return {
      providerMode: 'resend',
      smtpHost: '',
      smtpPort: 587,
      smtpSecure: false,
      smtpUser: '',
      smtpPass: '',
      fromAddress: (process.env.RESEND_FROM_EMAIL || 'Foodora BD <onboarding@resend.dev>').trim(),
      resendKey: envResendKey,
      source: 'env',
    };
  }

  return {
    providerMode: stored?.provider || 'gmail',
    smtpHost: stored?.smtpHost || 'smtp.gmail.com',
    smtpPort: stored?.smtpPort || 465,
    smtpSecure: stored?.smtpSecure ?? true,
    smtpUser: stored?.smtpUser || '',
    smtpPass: '',
    fromAddress: stored?.fromAddress || 'Foodora BD <orders@foodora.bd>',
    resendKey: '',
    source: 'none',
  };
}

export async function getEmailTransportStatus(): Promise<EmailTransportStatus> {
  const cfg = await resolveEffectiveConfig();
  if (cfg.source !== 'none') {
    if (cfg.providerMode === 'resend' && cfg.resendKey) {
      return {
        configured: true,
        provider: 'resend',
        fromAddress: cfg.fromAddress,
        source: cfg.source,
      };
    }
    if (cfg.smtpHost && cfg.smtpUser && cfg.smtpPass) {
      return {
        configured: true,
        provider: 'smtp',
        fromAddress: cfg.fromAddress,
        source: cfg.source,
      };
    }
  }
  return {
    configured: false,
    provider: 'in_app_email_log',
    fromAddress: 'Foodora BD <orders@foodora.bd>',
    source: 'none',
  };
}

export async function getAdminEmailSettingsView(): Promise<AdminEmailSettingsView> {
  const [stored, effective, status] = await Promise.all([
    readStoredConfig(),
    resolveEffectiveConfig(),
    getEmailTransportStatus(),
  ]);
  const storedPass = decryptSecret(stored?.smtpPassEnc);
  const storedResend = decryptSecret(stored?.resendApiKeyEnc);
  const effectivePass = storedPass || effective.smtpPass;
  const effectiveResend = storedResend || effective.resendKey;

  return {
    provider: stored?.provider || effective.providerMode || 'gmail',
    smtpHost: stored?.smtpHost || effective.smtpHost || 'smtp.gmail.com',
    smtpPort: stored?.smtpPort || effective.smtpPort || 465,
    smtpSecure: stored ? Boolean(stored.smtpSecure) : Boolean(effective.smtpSecure),
    smtpUser: stored?.smtpUser || effective.smtpUser || '',
    fromAddress: stored?.fromAddress || effective.fromAddress || 'Foodora BD <orders@foodora.bd>',
    notifyEmail:
      stored?.notifyEmail ||
      (process.env.ORDER_ALERT_NOTIFY_EMAIL || '').trim() ||
      PRIMARY_SUPER_ADMIN_EMAIL,
    hasSmtpPass: Boolean(effectivePass),
    smtpPassPreview: maskSecret(effectivePass),
    hasResendKey: Boolean(effectiveResend),
    resendKeyPreview: maskSecret(effectiveResend),
    configured: status.configured,
    activeProvider: status.provider,
    source: effective.source,
  };
}

export async function saveAdminEmailSettings(input: {
  provider: 'gmail' | 'smtp' | 'resend';
  smtpHost?: string;
  smtpPort?: number;
  smtpSecure?: boolean;
  smtpUser?: string;
  smtpPass?: string;
  fromAddress?: string;
  notifyEmail?: string;
  resendApiKey?: string;
}): Promise<AdminEmailSettingsView> {
  const prev = await readStoredConfig();
  const provider = input.provider || 'gmail';
  const smtpHost =
    provider === 'gmail'
      ? 'smtp.gmail.com'
      : (input.smtpHost ?? prev?.smtpHost ?? '').trim();
  const smtpPort = Number(
    input.smtpPort ?? prev?.smtpPort ?? (provider === 'gmail' ? 465 : 587)
  );
  const smtpSecure =
    typeof input.smtpSecure === 'boolean'
      ? input.smtpSecure
      : provider === 'gmail'
      ? smtpPort === 465
      : smtpPort === 465;
  const smtpUser = (input.smtpUser ?? prev?.smtpUser ?? '').trim();
  const fromAddress = (
    input.fromAddress ??
    prev?.fromAddress ??
    (provider === 'resend'
      ? 'Foodora BD <onboarding@resend.dev>'
      : smtpUser
      ? `Foodora BD <${smtpUser}>`
      : 'Foodora BD <orders@foodora.bd>')
  ).trim();
  const notifyEmail = (
    input.notifyEmail !== undefined
      ? input.notifyEmail
      : prev?.notifyEmail ?? PRIMARY_SUPER_ADMIN_EMAIL
  )
    .trim()
    .toLowerCase();

  const nextSmtpPassEnc =
    input.smtpPass !== undefined && input.smtpPass.trim() !== ''
      ? encryptSecret(input.smtpPass.trim())
      : prev?.smtpPassEnc || '';
  const nextResendKeyEnc =
    input.resendApiKey !== undefined && input.resendApiKey.trim() !== ''
      ? encryptSecret(input.resendApiKey.trim())
      : prev?.resendApiKeyEnc || '';

  const payload: StoredEmailConfig = {
    provider,
    smtpHost,
    smtpPort: Number.isFinite(smtpPort) ? smtpPort : 465,
    smtpSecure,
    smtpUser,
    smtpPassEnc: nextSmtpPassEnc,
    fromAddress,
    notifyEmail,
    resendApiKeyEnc: nextResendKeyEnc,
    updatedAt: new Date().toISOString(),
  };

  await db
    .insert(localCredentials)
    .values({
      email: EMAIL_CONFIG_KEY,
      uid: EMAIL_CONFIG_UID,
      passwordHash: JSON.stringify(payload),
    })
    .onConflictDoUpdate({
      target: localCredentials.email,
      set: { passwordHash: JSON.stringify(payload) },
    });

  return getAdminEmailSettingsView();
}

export async function sendTransactionalEmail(params: {
  to: string;
  subject: string;
  html: string;
  text: string;
}): Promise<{
  ok: boolean;
  provider: 'smtp' | 'resend' | 'in_app_email_log';
  status: string;
  error?: string;
}> {
  const emailLower = String(params.to || '').trim().toLowerCase();
  if (!emailLower || !emailLower.includes('@')) {
    return {
      ok: false,
      provider: 'in_app_email_log',
      status: 'invalid_recipient',
      error: 'Invalid recipient email address.',
    };
  }

  const cfg = await resolveEffectiveConfig();

  if (
    (cfg.providerMode === 'gmail' || cfg.providerMode === 'smtp') &&
    cfg.smtpHost &&
    cfg.smtpUser &&
    cfg.smtpPass
  ) {
    try {
      const transporter = nodemailer.createTransport({
        host: cfg.smtpHost,
        port: Number.isFinite(cfg.smtpPort) ? cfg.smtpPort : 465,
        secure: cfg.smtpSecure,
        auth: {
          user: cfg.smtpUser,
          pass: cfg.smtpPass,
        },
        connectionTimeout: 8000,
        greetingTimeout: 8000,
        socketTimeout: 10000,
      });
      await transporter.sendMail({
        from: cfg.fromAddress || `Foodora BD <${cfg.smtpUser}>`,
        to: emailLower,
        subject: params.subject,
        text: params.text,
        html: params.html,
      });
      return { ok: true, provider: 'smtp', status: 'sent' };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err || 'SMTP send failed');
      console.warn('SMTP email dispatch failed:', message);
      return {
        ok: false,
        provider: 'smtp',
        status: `smtp_error: ${message.slice(0, 120)}`,
        error: message,
      };
    }
  }

  if (cfg.resendKey) {
    try {
      const mailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${cfg.resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: cfg.fromAddress || 'Foodora BD <onboarding@resend.dev>',
          to: [emailLower],
          subject: params.subject,
          html: params.html,
          text: params.text,
        }),
        signal: AbortSignal.timeout(7000),
      });
      if (mailRes.ok) {
        return { ok: true, provider: 'resend', status: 'sent' };
      }
      const errText = await mailRes.text().catch(() => '');
      return {
        ok: false,
        provider: 'resend',
        status: `resend_error_http_${mailRes.status}`,
        error: errText || `Resend returned HTTP ${mailRes.status}`,
      };
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Resend request timed out';
      return {
        ok: false,
        provider: 'resend',
        status: `resend_error: ${message.slice(0, 120)}`,
        error: message,
      };
    }
  }

  return {
    ok: false,
    provider: 'in_app_email_log',
    status: 'not_configured',
    error: 'Gmail SMTP or Resend API Key is not configured yet in Admin -> Backend Control.',
  };
}

export async function sendTestEmail(toEmail: string) {
  const cleanEmail = String(toEmail || '').trim().toLowerCase();
  const payload = buildOrderTrackingEmailPayload({
    origin: process.env.PUBLIC_APP_URL || 'https://foodora.bd',
    orderId: 99999,
    orderNumber: 'FD-BD-TEST1',
    trackingToken: 'test-token',
    customerName: 'Foodora Admin Test',
    customerEmail: cleanEmail,
    restaurantName: "Sultan's Dine — Gulshan",
    deliveryArea: 'Gulshan 2, Dhaka',
    deliveryAddress: 'Road 71, House 12, Gulshan 2, Dhaka, Bangladesh',
    subtotal: 650,
    discountAmount: 50,
    couponCode: 'FOODORA50',
    deliveryFee: 45,
    serviceFee: 10,
    taxAmount: 0,
    totalAmount: 655,
    paymentMethod: 'bkash',
    paymentStatus: 'paid',
    status: 'confirmed',
    statusNote: 'SMTP / Gmail Invoice Delivery Test Successful',
    etaMinutes: 25,
    items: [
      { name: 'Kacchi Biryani (Mutton)', quantity: 1, unitPrice: 650, lineTotal: 650 },
    ],
  });

  return sendTransactionalEmail({
    to: cleanEmail,
    subject: `[TEST] ${payload.subject}`,
    html: payload.html,
    text: payload.text,
  });
}

export async function sendAndLogOrderTrackingEmail(params: {
  origin: string;
  orderId: number;
  orderNumber: string;
  trackingToken?: string | null;
  customerName: string;
  customerEmail: string;
  restaurantName: string;
  deliveryArea: string;
  deliveryAddress?: string | null;
  subtotal?: number | null;
  discountAmount?: number | null;
  couponCode?: string | null;
  deliveryFee?: number | null;
  serviceFee?: number | null;
  taxAmount?: number | null;
  totalAmount: number;
  paymentMethod: string;
  paymentStatus?: string | null;
  status: string;
  statusEvent?: string;
  statusNote?: string;
  riderName?: string | null;
  riderPhone?: string | null;
  etaMinutes?: number | null;
  createdAt?: string | Date | null;
  items?: Array<{
    name: string;
    nameBn?: string;
    quantity: number;
    unitPrice?: number;
    variation?: string;
    addons?: Array<{ name: string; price: number }>;
    lineTotal: number;
  }>;
}) {
  const emailLower = String(params.customerEmail || '').trim().toLowerCase();
  if (!emailLower || !emailLower.includes('@')) {
    return null;
  }

  const payload = buildOrderTrackingEmailPayload({
    origin: params.origin,
    orderId: params.orderId,
    orderNumber: params.orderNumber,
    trackingToken: params.trackingToken,
    customerName: params.customerName,
    customerEmail: emailLower,
    restaurantName: params.restaurantName,
    deliveryArea: params.deliveryArea,
    deliveryAddress: params.deliveryAddress,
    subtotal: params.subtotal,
    discountAmount: params.discountAmount,
    couponCode: params.couponCode,
    deliveryFee: params.deliveryFee,
    serviceFee: params.serviceFee,
    taxAmount: params.taxAmount,
    totalAmount: params.totalAmount,
    paymentMethod: params.paymentMethod,
    paymentStatus: params.paymentStatus,
    status: params.status,
    statusNote: params.statusNote,
    riderName: params.riderName,
    riderPhone: params.riderPhone,
    etaMinutes: params.etaMinutes,
    createdAt: params.createdAt,
    items: params.items,
  });

  const dispatchResult = await sendTransactionalEmail({
    to: emailLower,
    subject: payload.subject,
    html: payload.html,
    text: payload.text,
  });

  try {
    const inserted = await db
      .insert(orderEmailLogs)
      .values({
        orderId: params.orderId,
        orderNumber: params.orderNumber,
        recipientEmail: emailLower,
        subject: payload.subject,
        trackingUrl: payload.trackingUrl,
        statusEvent: params.statusEvent || params.status,
        deliveryProvider: dispatchResult.provider,
        providerStatus: dispatchResult.status,
        htmlPreview: payload.html,
      })
      .returning();
    return inserted[0] ?? null;
  } catch (err) {
    console.warn('Order email log insert skipped:', err);
    return null;
  }
}

export async function sendMerchantOrderAlertEmail(params: {
  origin: string;
  orderId: number;
  orderNumber: string;
  trackingToken?: string | null;
  eventKind: 'new_order' | 'status_update';
  restaurantName: string;
  restaurantEmail?: string | null;
  ownerEmail?: string | null;
  customerName: string;
  customerPhone?: string | null;
  deliveryArea: string;
  deliveryAddress?: string | null;
  totalAmount: number;
  paymentMethod: string;
  paymentStatus?: string | null;
  status: string;
  statusNote?: string;
  riderName?: string | null;
  items?: Array<{
    name: string;
    quantity: number;
    variation?: string;
    lineTotal: number;
  }>;
}) {
  const status = await getEmailTransportStatus();
  if (!status.configured) return [];

  const stored = await readStoredConfig();
  const configuredNotify =
    stored?.notifyEmail ||
    (process.env.ORDER_ALERT_NOTIFY_EMAIL || '').trim() ||
    PRIMARY_SUPER_ADMIN_EMAIL;

  const recipients = collectMerchantOrderAlertRecipients({
    restaurantEmail: params.restaurantEmail,
    ownerEmail: params.ownerEmail,
    adminNotifyEmail: configuredNotify,
    fallbackAdminEmails: [PRIMARY_SUPER_ADMIN_EMAIL],
  });
  if (recipients.length === 0) return [];

  const payload = buildMerchantOrderAlertEmailPayload({
    origin: params.origin,
    orderId: params.orderId,
    orderNumber: params.orderNumber,
    trackingToken: params.trackingToken,
    eventKind: params.eventKind,
    restaurantName: params.restaurantName,
    customerName: params.customerName,
    customerPhone: params.customerPhone,
    deliveryArea: params.deliveryArea,
    deliveryAddress: params.deliveryAddress,
    totalAmount: params.totalAmount,
    paymentMethod: params.paymentMethod,
    paymentStatus: params.paymentStatus,
    status: params.status,
    statusNote: params.statusNote,
    riderName: params.riderName,
    items: params.items,
  });

  return Promise.allSettled(
    recipients.map((to) =>
      sendTransactionalEmail({
        to,
        subject: payload.subject,
        html: payload.html,
        text: payload.text,
      })
    )
  );
}
