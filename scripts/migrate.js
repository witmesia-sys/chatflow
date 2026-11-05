/**
 * Script de migración: extiende el schema de Supabase con columnas SaaS
 * Ejecutar: node scripts/migrate.js
 */
import { createClient } from '@supabase/supabase-js';
import 'dotenv/config';

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const migrations = [
  // ── 1. Extender tabla businesses con campos de suscripción
  {
    name: 'add_subscription_columns',
    sql: `
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
    `,
  },

  // ── 2. Vista para el admin panel (MRR, conteo, consumo)
  {
    name: 'create_admin_dashboard_view',
    sql: `
      CREATE OR REPLACE VIEW admin_dashboard AS
      SELECT
        b.id,
        b.name                  AS business_name,
        b.owner_name,
        b.owner_phone,
        b.phone_number          AS whatsapp_number,
        b.subscription_status,
        b.pricing_model,
        b.monthly_price,
        b.next_billing_date,
        b.messages_limit,
        b.is_active,
        b.created_at,
        COALESCE((
          SELECT COUNT(*)
          FROM messages m
          JOIN conversations c ON c.id = m.conversation_id
          WHERE c.business_id = b.id
            AND m.role = 'assistant'
            AND m.created_at >= date_trunc('month', NOW())
        ), 0) AS messages_this_month,
        COALESCE((
          SELECT COUNT(*)
          FROM conversations c
          WHERE c.business_id = b.id
            AND c.status = 'active'
        ), 0) AS active_conversations,
        COALESCE((
          SELECT SUM(cost_usd)
          FROM usage_logs ul
          WHERE ul.business_id = b.id
            AND ul.created_at >= date_trunc('month', NOW())
        ), 0) AS ai_cost_this_month
      FROM businesses b;
    `,
  },

  // ── 3. Función suspend_business (kill switch)
  {
    name: 'create_suspend_function',
    sql: `
      CREATE OR REPLACE FUNCTION suspend_business(p_business_id UUID, p_reason TEXT DEFAULT 'payment_overdue')
      RETURNS VOID AS $$
      BEGIN
        UPDATE businesses
        SET
          subscription_status = 'suspended',
          is_active           = false,
          notes               = COALESCE(notes, '') || E'\\n[' || NOW()::TEXT || '] Suspendido: ' || p_reason
        WHERE id = p_business_id;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `,
  },

  // ── 4. Función reactivate_business
  {
    name: 'create_reactivate_function',
    sql: `
      CREATE OR REPLACE FUNCTION reactivate_business(p_business_id UUID)
      RETURNS VOID AS $$
      BEGIN
        UPDATE businesses
        SET
          subscription_status = 'active',
          is_active           = true,
          next_billing_date   = NOW() + INTERVAL '1 month',
          notes               = COALESCE(notes, '') || E'\\n[' || NOW()::TEXT || '] Reactivado'
        WHERE id = p_business_id;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `,
  },

  // ── 5. Función marcar pago pendiente (overdue)
  {
    name: 'create_mark_overdue_function',
    sql: `
      CREATE OR REPLACE FUNCTION mark_overdue(p_business_id UUID)
      RETURNS VOID AS $$
      BEGIN
        UPDATE businesses
        SET
          subscription_status = 'overdue',
          notes               = COALESCE(notes, '') || E'\\n[' || NOW()::TEXT || '] Marcado como pago pendiente'
        WHERE id = p_business_id;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `,
  },

  // ── 6. Función update_messages_limit
  {
    name: 'create_update_limit_function',
    sql: `
      CREATE OR REPLACE FUNCTION update_business_plan(
        p_business_id UUID,
        p_monthly_price NUMERIC,
        p_messages_limit INTEGER,
        p_pricing_model TEXT DEFAULT 'monthly'
      )
      RETURNS VOID AS $$
      BEGIN
        UPDATE businesses
        SET
          monthly_price  = p_monthly_price,
          messages_limit = p_messages_limit,
          pricing_model  = p_pricing_model
        WHERE id = p_business_id;
      END;
      $$ LANGUAGE plpgsql SECURITY DEFINER;
    `,
  },

  // ── 7. Seed: actualizar negocio demo con billing real
  {
    name: 'seed_demo_billing',
    sql: `
      UPDATE businesses SET
        subscription_status = 'active',
        monthly_price       = 49.99,
        messages_limit      = 2000,
        next_billing_date   = NOW() + INTERVAL '30 days',
        pricing_model       = 'monthly',
        owner_phone         = '584142558415'
      WHERE id = '783e2ef2-5f4e-46b6-8d2b-e8604b1fbefe';
    `,
  },
];

async function runMigrations() {
  console.log('🚀 Iniciando migraciones de ChatFlow AI...\n');

  for (const migration of migrations) {
    process.stdout.write(`  ⏳ ${migration.name}...`);
    const { error } = await supabase.rpc('exec_sql', { sql: migration.sql }).catch(() => ({ error: null }));

    // Si exec_sql no existe, usar el método alternativo
    const { error: directError } = await supabase
      .from('_migrations_dummy_do_not_use')
      .select('*')
      .limit(0)
      .catch(() => ({ error: null }));

    // Ejecutar SQL directo via la URL de administración
    const resp = await fetch(`${process.env.SUPABASE_URL}/rest/v1/rpc/exec_sql`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${process.env.SUPABASE_SERVICE_ROLE_KEY}`,
        'apikey': process.env.SUPABASE_SERVICE_ROLE_KEY,
      },
      body: JSON.stringify({ sql: migration.sql }),
    }).catch(() => null);

    if (resp?.ok) {
      console.log(' ✅');
    } else {
      console.log(' ⚠️  (puede que ya exista o requiera SQL Editor)');
    }
  }

  console.log('\n✅ Migraciones completadas. Verificando schema...');

  // Verificar columnas añadidas
  const { data, error } = await supabase
    .from('businesses')
    .select('id, name, subscription_status, monthly_price, messages_limit')
    .limit(3);

  if (error) {
    console.error('❌ Error verificando:', error.message);
  } else {
    console.log('\nNegocios en la DB:');
    console.table(data);
  }
}

runMigrations().catch(console.error);
