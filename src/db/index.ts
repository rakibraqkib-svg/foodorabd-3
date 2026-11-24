import { drizzle } from 'drizzle-orm/node-postgres';
import { Pool } from 'pg';
import * as schema from './schema.ts';

declare global {
  var _postgresPool: Pool | undefined;
}

export function hasDatabaseConfig(): boolean {
  return Boolean(
    process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.SUPABASE_DB_URL ||
      process.env.SQL_HOST
  );
}

export const createPool = () => {
  if (!global._postgresPool) {
    const connectionString =
      process.env.DATABASE_URL ||
      process.env.POSTGRES_URL ||
      process.env.SUPABASE_DB_URL;
    const isVercel = Boolean(
      process.env.VERCEL ||
        process.env.VERCEL_ENV ||
        process.env.AWS_LAMBDA_FUNCTION_NAME ||
        process.env.NOW_REGION
    );
    if (connectionString) {
      global._postgresPool = new Pool({
        connectionString,
        ssl:
          connectionString.includes('localhost') || connectionString.includes('127.0.0.1')
            ? undefined
            : { rejectUnauthorized: false },
        max: isVercel ? 5 : 10,
        idleTimeoutMillis: isVercel ? 15000 : 30000,
        connectionTimeoutMillis: 15000,
      });
    } else if (process.env.SQL_HOST) {
      global._postgresPool = new Pool({
        host: process.env.SQL_HOST,
        user: process.env.SQL_USER,
        password: process.env.SQL_PASSWORD,
        database: process.env.SQL_DB_NAME,
        max: 10,
        connectionTimeoutMillis: 15000,
      });
    } else {
      global._postgresPool = new Pool({
        host: 'missing-database-url.invalid',
        connectionTimeoutMillis: 1500,
        max: 1,
      });
    }

    global._postgresPool.on('error', (err) => {
      // Suppress transient idle client connection terminations (e.g. Supabase pooler / NAT timeout drops)
      if (err.message && (err.message.includes('Connection terminated unexpectedly') || err.message.includes('terminating connection'))) {
        return;
      }
      console.error('Unexpected error on idle SQL pool client:', err);
    });
  }
  return global._postgresPool;
};

const pool = createPool();

export const db = drizzle(pool, { schema });

export function isTransientDbError(err: unknown): boolean {
  const collectMsg = (val: unknown, depth = 0): string => {
    if (!val || depth > 3) return '';
    if (typeof val === 'string') return val;
    if (val instanceof Error) {
      const code = (val as Error & { code?: string }).code || '';
      return `${val.message} ${code} ${collectMsg((val as Error & { cause?: unknown }).cause, depth + 1)}`;
    }
    if (typeof val === 'object') {
      const obj = val as Record<string, unknown>;
      return `${String(obj.message || '')} ${String(obj.code || '')} ${collectMsg(obj.cause, depth + 1)}`;
    }
    return String(val);
  };
  const msg = collectMsg(err).toUpperCase();
  return (
    msg.includes('ENOENT') ||
    msg.includes('ECONNREFUSED') ||
    msg.includes('ECONNRESET') ||
    msg.includes('ETIMEDOUT') ||
    msg.includes('EPIPE') ||
    msg.includes('57P01') ||
    msg.includes('CONNECTION TERMINATED UNEXPECTEDLY') ||
    msg.includes('THE DATABASE SYSTEM IS STARTING UP')
  );
}

export async function withDbRetry<T>(fn: () => Promise<T>, maxAttempts = 4): Promise<T> {
  let lastErr: unknown;
  for (let attempt = 1; attempt <= maxAttempts; attempt++) {
    try {
      return await fn();
    } catch (err) {
      lastErr = err;
      if (!isTransientDbError(err) || attempt >= maxAttempts) {
        throw err;
      }
      const delayMs = attempt * 350;
      await new Promise((resolve) => setTimeout(resolve, delayMs));
    }
  }
  throw lastErr;
}
