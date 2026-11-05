/**
 * Migración directa via conexión PostgreSQL directa a Supabase
 * Ejecutar: node scripts/pg-migrate.mjs
 */
import 'dotenv/config';
import pg from 'pg';

const { Client } = pg;

// URL de conexión directa de Supabase (puerto 5432 - transacción pooler)
// Formato: postgresql://postgres.[ref]:[password]@aws-0-us-east-1.pooler.supabase.com:5432/postgres
// Necesitamos la DB password del proyecto
const DB_URL = process.env.SUPABASE_DB_URL;

if (!DB_URL) {
  console.error('❌ Falta SUPABASE_DB_URL en .env');
  console.log('Obtén la URL de: Supabase Dashboard → Settings → Database → Connection string (URI)');
  process.exit(1);
}

const SQL = `
ALTER TABLE businesses
  ADD COLUMN IF NOT EXISTS subscription_status TEXT NOT NULL DEFAULT 'active'
    CHECK (subscription_status IN ('active','overdue','suspended')),
  ADD COLUMN IF NOT EXISTS pricing_model TEXT NOT NULL DEFAULT 'monthly'
    CHECK (pricing_model IN ('monthly','one_time')),
  ADD COLUMN IF NOT EXISTS monthly_price NUMERIC(10,2) NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS next_billing_date TIMESTAMPTZ,
  ADD COLUMN IF NOT EXISTS messages_limit INTEGER NOT NULL DEFAULT 1000,
  ADD COLUMN IF NOT EXISTS owner_phone TEXT,
  ADD COLUMN IF NOT EXISTS notes TEXT;
`;

const client = new Client({ connectionString: DB_URL, ssl: { rejectUnauthorized: false } });
await client.connect();
await client.query(SQL);
console.log('✅ Columnas añadidas');
await client.end();
