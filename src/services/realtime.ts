import type { Server as HttpServer } from 'node:http';
import type { Response as ExpressResponse } from 'express';
import { WebSocketServer, WebSocket } from 'ws';
import { eq } from 'drizzle-orm';
import { db } from '../db/index.ts';
import { orders, restaurants } from '../db/schema.ts';
import { resolveUserFromToken, UserRole } from '../middleware/auth.ts';

export type RealtimeEventType =
  | 'connected'
  | 'order:created'
  | 'order:updated'
  | 'rider:location'
  | 'notification:created';

export interface RealtimeOrderEventPayload {
  orderId: number;
  orderNumber: string;
  restaurantId: number;
  restaurantName: string;
  restaurantOwnerUid?: string | null;
  customerUid: string;
  customerName?: string;
  riderUid?: string | null;
  riderName?: string | null;
  status: string;
  deliveryMode?: string;
  deliveryArea?: string;
  totalAmount?: number;
  lat?: number;
  lng?: number;
  updatedAt?: string;
}

export interface RealtimeNotificationPayload {
  recipientUid?: string;
  roleTarget?: string;
  title: string;
  message: string;
  type?: string;
  relatedOrderId?: number | null;
}

interface RealtimeClientMeta {
  id: string;
  uid: string | null;
  role: UserRole | null;
  restaurantIds: Set<number>;
  watchOrderId: number | null;
  send: (jsonText: string) => void;
  close: () => void;
}

const clients = new Map<string, RealtimeClientMeta>();
let wss: WebSocketServer | null = null;
let heartbeatTimer: ReturnType<typeof setInterval> | null = null;

async function resolveClientMetaFromQuery(params: URLSearchParams): Promise<{
  uid: string | null;
  role: UserRole | null;
  restaurantIds: Set<number>;
  watchOrderId: number | null;
}> {
  const token = params.get('token');
  const orderIdRaw = Number(params.get('orderId'));
  const trackingToken = (params.get('trackingToken') || '').trim();

  let uid: string | null = null;
  let role: UserRole | null = null;
  const restaurantIds = new Set<number>();
  let watchOrderId: number | null = null;

  if (token) {
    try {
      const user = await resolveUserFromToken(token);
      if (user) {
        uid = user.uid;
        role = user.role;
        if (user.role === 'restaurant_owner') {
          const owned = await db
            .select({ id: restaurants.id })
            .from(restaurants)
            .where(eq(restaurants.ownerUid, user.uid));
          for (const r of owned) restaurantIds.add(r.id);
        }
      }
    } catch {
      // ignore invalid WS auth token cleanly
    }
  }

  if (Number.isInteger(orderIdRaw) && orderIdRaw > 0) {
    try {
      const rows = await db
        .select({
          id: orders.id,
          customerUid: orders.customerUid,
          riderUid: orders.riderUid,
          trackingToken: orders.trackingToken,
        })
        .from(orders)
        .where(eq(orders.id, orderIdRaw))
        .limit(1);
      const ord = rows[0];
      if (ord) {
        const isAdmin = role === 'admin' || role === 'super_admin';
        const isParticipant = Boolean(uid && (ord.customerUid === uid || ord.riderUid === uid));
        const hasValidTrackingToken = Boolean(
          trackingToken && ord.trackingToken && trackingToken === ord.trackingToken
        );
        if (isAdmin || isParticipant || hasValidTrackingToken) {
          watchOrderId = ord.id;
        }
      }
    } catch {
      // ignore invalid order watch
    }
  }

  return { uid, role, restaurantIds, watchOrderId };
}

export function initRealtimeWebSocketServer(httpServer: HttpServer) {
  if (wss) return wss;

  wss = new WebSocketServer({ server: httpServer, path: '/ws' });

  wss.on('connection', async (socket: WebSocket, req) => {
    const clientId = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
    const url = new URL(req.url || '/ws', 'http://localhost');
    const auth = await resolveClientMetaFromQuery(url.searchParams);

    const meta: RealtimeClientMeta = {
      id: clientId,
      uid: auth.uid,
      role: auth.role,
      restaurantIds: auth.restaurantIds,
      watchOrderId: auth.watchOrderId,
      send: (jsonText: string) => {
        if (socket.readyState === WebSocket.OPEN) {
          socket.send(jsonText);
        }
      },
      close: () => {
        try {
          socket.close();
        } catch {
          // ignore
        }
      },
    };

    clients.set(clientId, meta);
    meta.send(
      JSON.stringify({
        type: 'connected',
        payload: { role: auth.role, watchOrderId: auth.watchOrderId },
        ts: Date.now(),
      })
    );

    socket.on('close', () => {
      clients.delete(clientId);
    });
    socket.on('error', () => {
      clients.delete(clientId);
    });
  });

  if (!heartbeatTimer) {
    heartbeatTimer = setInterval(() => {
      if (!wss) return;
      for (const client of wss.clients) {
        if (client.readyState === WebSocket.OPEN) {
          try {
            client.ping();
          } catch {
            // ignore
          }
        }
      }
    }, 25000);
  }

  return wss;
}

export async function attachSseRealtimeClient(
  res: ExpressResponse,
  params: URLSearchParams
): Promise<() => void> {
  const clientId = `sse-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
  const auth = await resolveClientMetaFromQuery(params);

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache, no-transform');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no');
  res.flushHeaders?.();
  res.write('retry: 2000\n: stream-ready\n\n');

  const meta: RealtimeClientMeta = {
    id: clientId,
    uid: auth.uid,
    role: auth.role,
    restaurantIds: auth.restaurantIds,
    watchOrderId: auth.watchOrderId,
    send: (jsonText: string) => {
      res.write(`data: ${jsonText}\n\n`);
    },
    close: () => {
      try {
        res.end();
      } catch {
        // ignore
      }
    },
  };

  clients.set(clientId, meta);
  meta.send(
    JSON.stringify({
      type: 'connected',
      payload: { role: auth.role, watchOrderId: auth.watchOrderId },
      ts: Date.now(),
    })
  );

  const keepAlive = setInterval(() => {
    try {
      res.write(': ping\n\n');
    } catch {
      clearInterval(keepAlive);
      clients.delete(clientId);
    }
  }, 20000);

  return () => {
    clearInterval(keepAlive);
    clients.delete(clientId);
  };
}

function shouldReceiveOrderEvent(
  client: RealtimeClientMeta,
  payload: RealtimeOrderEventPayload
): boolean {
  if (client.role === 'admin' || client.role === 'super_admin') return true;
  if (client.watchOrderId && client.watchOrderId === payload.orderId) return true;
  if (client.uid && client.uid === payload.customerUid) return true;
  if (client.uid && payload.restaurantOwnerUid && client.uid === payload.restaurantOwnerUid) return true;
  if (client.restaurantIds.has(payload.restaurantId)) return true;
  if (client.uid && payload.riderUid && client.uid === payload.riderUid) return true;
  // Platform riders should immediately see unassigned confirmed/ready orders
  if (
    client.role === 'rider' &&
    !payload.riderUid &&
    payload.deliveryMode !== 'restaurant' &&
    ['confirmed', 'accepted', 'preparing', 'ready'].includes(payload.status)
  ) {
    return true;
  }
  return false;
}

export function broadcastOrderEvent(
  type: 'order:created' | 'order:updated' | 'rider:location',
  payload: RealtimeOrderEventPayload
) {
  if (clients.size === 0) return;
  const serialized = JSON.stringify({
    type,
    payload: { ...payload, updatedAt: payload.updatedAt || new Date().toISOString() },
    ts: Date.now(),
  });
  for (const client of clients.values()) {
    if (shouldReceiveOrderEvent(client, payload)) {
      try {
        client.send(serialized);
      } catch {
        clients.delete(client.id);
      }
    }
  }
}

export function broadcastNotificationEvent(payload: RealtimeNotificationPayload) {
  if (clients.size === 0) return;
  const serialized = JSON.stringify({
    type: 'notification:created',
    payload,
    ts: Date.now(),
  });
  const recipient = String(payload.recipientUid || '').trim();
  const isGlobalBroadcast = recipient === 'broadcast-all' || (!recipient && payload.roleTarget === 'all');
  const isExplicitRoleBroadcast =
    Boolean(payload.roleTarget) &&
    (!recipient || recipient.startsWith('role-') || recipient === 'demo-admin-uid');

  for (const client of clients.values()) {
    const matchesUid = Boolean(recipient && client.uid && client.uid === recipient);
    const matchesRoleBroadcast = Boolean(
      isExplicitRoleBroadcast &&
        payload.roleTarget &&
        client.role &&
        (client.role === payload.roleTarget ||
          ((client.role === 'admin' || client.role === 'super_admin') &&
            (payload.roleTarget === 'admin' || payload.roleTarget === 'super_admin')))
    );
    if (matchesUid || isGlobalBroadcast || matchesRoleBroadcast) {
      try {
        client.send(serialized);
      } catch {
        clients.delete(client.id);
      }
    }
  }
}
