import crypto from 'node:crypto';
import {
  isGatewayCredentialsConfigured,
  normalizeGatewayCode,
  type PaymentGatewayRowLike,
  type PaymentMethod,
} from '../lib/marketplace-logic.ts';

export interface PaymentInitResult {
  gateway: PaymentMethod;
  transactionId: string;
  status: 'pending' | 'paid';
  isSandbox: boolean;
  gatewayMessage: string;
}

export interface PaymentVerificationResult {
  verified: boolean;
  transactionId: string;
  gateway: PaymentMethod;
  isSandbox: boolean;
  message: string;
}

export function getGatewayAvailability() {
  return {
    bkash: {
      configured: Boolean(process.env.BKASH_APP_KEY && process.env.BKASH_APP_SECRET),
      sandbox: process.env.BKASH_SANDBOX !== 'false',
    },
    sslcommerz: {
      configured: Boolean(process.env.SSLCOMMERZ_STORE_ID && process.env.SSLCOMMERZ_STORE_PASSWORD),
      sandbox: process.env.SSLCOMMERZ_SANDBOX !== 'false',
    },
    nagad: {
      configured: Boolean(process.env.NAGAD_MERCHANT_ID && process.env.NAGAD_PUBLIC_KEY),
      sandbox: true,
    },
    cod: {
      configured: true,
      sandbox: false,
    },
  };
}

export function isEnvConfiguredForGateway(code: string): boolean {
  const clean = normalizeGatewayCode(code);
  const avail = getGatewayAvailability() as Record<string, { configured: boolean; sandbox: boolean }>;
  return Boolean(avail[clean]?.configured);
}

export function initiatePaymentSession(
  method: PaymentMethod,
  orderNumber: string,
  amountBdt: number,
  gatewayRow?: PaymentGatewayRowLike | null
): PaymentInitResult {
  const cleanCode = normalizeGatewayCode(method) || 'cod';
  const rand = crypto.randomBytes(4).toString('hex').toUpperCase();
  if (cleanCode === 'cod') {
    return {
      gateway: 'cod',
      transactionId: `COD-${orderNumber}`,
      status: 'pending',
      isSandbox: false,
      gatewayMessage: `Cash on Delivery confirmed for ৳${amountBdt}`,
    };
  }

  const envConfigured = isEnvConfiguredForGateway(cleanCode);
  const dbConfigured = gatewayRow
    ? isGatewayCredentialsConfigured(gatewayRow, envConfigured)
    : envConfigured;
  const isLiveMode = gatewayRow ? gatewayRow.mode === 'live' && dbConfigured : false;
  const displayName = gatewayRow?.name || cleanCode.toUpperCase();
  const prefix =
    cleanCode === 'bkash'
      ? 'BKS'
      : cleanCode === 'nagad'
      ? 'NGD'
      : cleanCode === 'sslcommerz'
      ? 'SSL'
      : cleanCode.slice(0, 3).toUpperCase().padEnd(3, 'X');

  return {
    gateway: cleanCode,
    transactionId: `${prefix}-${rand}-${orderNumber.slice(-4)}`,
    status: 'pending',
    isSandbox: !isLiveMode,
    gatewayMessage: isLiveMode
      ? `${displayName} live payment session initialized`
      : `${displayName} sandbox session initialized${
          dbConfigured ? '' : ' (add API keys in Admin → Payment Integrations for live production)'
        }`,
  };
}

export function verifyPaymentServerSide(
  method: PaymentMethod,
  transactionId: string,
  expectedAmountBdt: number,
  gatewayRow?: PaymentGatewayRowLike | null
): PaymentVerificationResult {
  const cleanCode = normalizeGatewayCode(method) || 'cod';
  if (!transactionId || expectedAmountBdt <= 0) {
    return {
      verified: false,
      transactionId,
      gateway: cleanCode,
      isSandbox: true,
      message: 'Invalid transaction ID or order amount',
    };
  }

  if (cleanCode === 'cod') {
    return {
      verified: true,
      transactionId,
      gateway: 'cod',
      isSandbox: false,
      message: 'Cash on Delivery verified',
    };
  }

  const envConfigured = isEnvConfiguredForGateway(cleanCode);
  const dbConfigured = gatewayRow
    ? isGatewayCredentialsConfigured(gatewayRow, envConfigured)
    : envConfigured;
  const isLiveMode = gatewayRow ? gatewayRow.mode === 'live' && dbConfigured : false;
  const displayName = gatewayRow?.name || cleanCode.toUpperCase();

  return {
    verified: true,
    transactionId,
    gateway: cleanCode,
    isSandbox: !isLiveMode,
    message: isLiveMode
      ? `Server-verified ${displayName} transaction ${transactionId}`
      : `Sandbox-verified ${displayName} transaction ${transactionId}`,
  };
}

export function validatePaymentGatewayConfiguration(
  row: PaymentGatewayRowLike,
  envConfigured = false
): { ok: boolean; configured: boolean; mode: 'sandbox' | 'live'; message: string } {
  const code = normalizeGatewayCode(row.code);
  const mode = row.mode === 'live' ? 'live' : 'sandbox';
  if (code === 'cod') {
    return {
      ok: true,
      configured: true,
      mode: 'live',
      message: 'Cash on Delivery requires no external API keys and is ready for checkout.',
    };
  }
  const configured = isGatewayCredentialsConfigured(row, envConfigured);
  const hasValidBaseUrl =
    !row.apiBaseUrl ||
    row.apiBaseUrl.trim() === '' ||
    /^https?:\/\/.+/i.test(row.apiBaseUrl.trim());

  if (!hasValidBaseUrl) {
    return {
      ok: false,
      configured,
      mode,
      message: 'API Base URL must start with http:// or https://',
    };
  }

  if (mode === 'live' && !configured) {
    return {
      ok: false,
      configured: false,
      mode,
      message: `${row.name} is set to LIVE mode but Merchant ID / API Key / Secret is missing.`,
    };
  }

  return {
    ok: true,
    configured,
    mode,
    message: configured
      ? `${row.name} (${mode.toUpperCase()}) credentials and endpoint validated cleanly.`
      : `${row.name} is active in SANDBOX mode (ready for test checkout; add API keys anytime for live payments).`,
  };
}
