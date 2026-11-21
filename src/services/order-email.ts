import nodemailer from 'nodemailer';
import { db } from '../db/index.ts';
import { orderEmailLogs } from '../db/schema.ts';
import { buildOrderTrackingEmailPayload } from '../lib/marketplace-logic.ts';

export interface EmailTransportStatus {
  configured: boolean;
  provider: 'smtp' | 'resend' | 'in_app_email_log';
  fromAddress: string;
}

export function getEmailTransportStatus(): EmailTransportStatus {
  const smtpHost = (process.env.SMTP_HOST || '').trim();
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').trim();
  if (smtpHost && smtpUser && smtpPass) {
    return {
      configured: true,
      provider: 'smtp',
      fromAddress: (process.env.SMTP_FROM || `Foodora BD <${smtpUser}>`).trim(),
    };
  }

  const resendKey = (
    process.env.RESEND_API_KEY ||
    process.env.EMAIL_PROVIDER_API_KEY ||
    ''
  ).trim();
  if (resendKey) {
    return {
      configured: true,
      provider: 'resend',
      fromAddress: (process.env.RESEND_FROM_EMAIL || 'Foodora BD <onboarding@resend.dev>').trim(),
    };
  }

  return {
    configured: false,
    provider: 'in_app_email_log',
    fromAddress: 'Foodora BD <orders@foodora.bd>',
  };
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
  totalAmount: number;
  paymentMethod: string;
  paymentStatus?: string | null;
  status: string;
  statusEvent?: string;
  statusNote?: string;
  riderName?: string | null;
  riderPhone?: string | null;
  etaMinutes?: number | null;
  items?: Array<{ name: string; nameBn?: string; quantity: number; lineTotal: number }>;
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
    totalAmount: params.totalAmount,
    paymentMethod: params.paymentMethod,
    paymentStatus: params.paymentStatus,
    status: params.status,
    statusNote: params.statusNote,
    riderName: params.riderName,
    riderPhone: params.riderPhone,
    etaMinutes: params.etaMinutes,
    items: params.items,
  });

  let deliveryProvider = 'in_app_email_log';
  let providerStatus = 'recorded';

  const smtpHost = (process.env.SMTP_HOST || '').trim();
  const smtpUser = (process.env.SMTP_USER || '').trim();
  const smtpPass = (process.env.SMTP_PASS || '').trim();
  const smtpPort = Number(process.env.SMTP_PORT || 587);
  const smtpSecure =
    process.env.SMTP_SECURE === 'true' || (!process.env.SMTP_SECURE && smtpPort === 465);

  const resendKey = (
    process.env.RESEND_API_KEY ||
    process.env.EMAIL_PROVIDER_API_KEY ||
    ''
  ).trim();

  if (smtpHost && smtpUser && smtpPass) {
    try {
      const transporter = nodemailer.createTransport({
        host: smtpHost,
        port: Number.isFinite(smtpPort) ? smtpPort : 587,
        secure: smtpSecure,
        auth: {
          user: smtpUser,
          pass: smtpPass,
        },
        connectionTimeout: 6000,
        greetingTimeout: 6000,
        socketTimeout: 8000,
      });
      await transporter.sendMail({
        from: (process.env.SMTP_FROM || `Foodora BD <${smtpUser}>`).trim(),
        to: emailLower,
        subject: payload.subject,
        text: payload.text,
        html: payload.html,
      });
      deliveryProvider = 'smtp';
      providerStatus = 'sent';
    } catch (err) {
      deliveryProvider = 'smtp';
      providerStatus = `fallback_recorded_smtp_error`;
      console.warn('SMTP email dispatch failed, recorded in orderEmailLogs:', err instanceof Error ? err.message : err);
    }
  } else if (resendKey) {
    try {
      const mailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || 'Foodora BD <onboarding@resend.dev>',
          to: [emailLower],
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
        }),
        signal: AbortSignal.timeout(5000),
      });
      if (mailRes.ok) {
        deliveryProvider = 'resend';
        providerStatus = 'sent';
      } else {
        deliveryProvider = 'resend';
        providerStatus = `fallback_recorded_http_${mailRes.status}`;
      }
    } catch {
      deliveryProvider = 'in_app_email_log';
      providerStatus = 'recorded_offline_fallback';
    }
  }

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
        deliveryProvider,
        providerStatus,
        htmlPreview: payload.html,
      })
      .returning();
    return inserted[0] ?? null;
  } catch (err) {
    console.warn('Order email log insert skipped:', err);
    return null;
  }
}
