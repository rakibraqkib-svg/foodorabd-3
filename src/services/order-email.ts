import { db } from '../db/index.ts';
import { orderEmailLogs } from '../db/schema.ts';
import { buildOrderTrackingEmailPayload } from '../lib/marketplace-logic.ts';

export async function sendAndLogOrderTrackingEmail(params: {
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
  statusEvent?: string;
  statusNote?: string;
  riderName?: string | null;
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
    totalAmount: params.totalAmount,
    paymentMethod: params.paymentMethod,
    status: params.status,
    statusNote: params.statusNote,
    riderName: params.riderName,
  });

  let deliveryProvider = 'in_app_email_log';
  let providerStatus = 'recorded';

  const resendKey = (
    process.env.RESEND_API_KEY ||
    process.env.EMAIL_PROVIDER_API_KEY ||
    ''
  ).trim();

  if (resendKey) {
    try {
      const mailRes = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${resendKey}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify({
          from: process.env.RESEND_FROM_EMAIL || 'Foodora BD <orders@foodora.bd>',
          to: [emailLower],
          subject: payload.subject,
          html: payload.html,
          text: payload.text,
        }),
        signal: AbortSignal.timeout(4000),
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
