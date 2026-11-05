/**
 * Migración directa de Supabase via Management API
 * Ejecutar: node scripts/run-migration.mjs
 */
import 'dotenv/config';

const PROJECT_REF = 'flbccyhbhufkjgjzsrbz';
const SERVICE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

// SQL completo de migración
const SQL = `
-- ============================================================
-- ChatFlow AI SaaS: Columnas de billing y kill switch
-- ============================================================

-- 1. Extender tabla businesses
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

-- 2. Vista admin_dashboard
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
    SELECT COUNT(*) FROM conversations c
    WHERE c.business_id = b.id AND c.status = 'active'
  ), 0) AS active_conversations,
  COALESCE((
    SELECT SUM(cost_usd) FROM usage_logs ul
    WHERE ul.business_id = b.id
      AND ul.created_at >= date_trunc('month', NOW())
  ), 0) AS ai_cost_this_month
FROM businesses b;

-- 3. Kill switch: suspender negocio
CREATE OR REPLACE FUNCTION suspend_business(p_business_id UUID, p_reason TEXT DEFAULT 'payment_overdue')
RETURNS VOID AS $$
BEGIN
  UPDATE businesses SET
    subscription_status = 'suspended',
    is_active           = false,
    notes = COALESCE(notes,'') || E'\\n[' || NOW()::TEXT || '] Suspendido: ' || p_reason
  WHERE id = p_business_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 4. Reactivar negocio
CREATE OR REPLACE FUNCTION reactivate_business(p_business_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE businesses SET
    subscription_status = 'active',
    is_active           = true,
    next_billing_date   = NOW() + INTERVAL '1 month',
    notes = COALESCE(notes,'') || E'\\n[' || NOW()::TEXT || '] Reactivado'
  WHERE id = p_business_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 5. Marcar pago pendiente
CREATE OR REPLACE FUNCTION mark_overdue(p_business_id UUID)
RETURNS VOID AS $$
BEGIN
  UPDATE businesses SET
    subscription_status = 'overdue',
    notes = COALESCE(notes,'') || E'\\n[' || NOW()::TEXT || '] Pago pendiente'
  WHERE id = p_business_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 6. Actualizar plan de negocio
CREATE OR REPLACE FUNCTION update_business_plan(
  p_business_id UUID,
  p_monthly_price NUMERIC,
  p_messages_limit INTEGER,
  p_pricing_model TEXT DEFAULT 'monthly'
)
RETURNS VOID AS $$
BEGIN
  UPDATE businesses SET
    monthly_price  = p_monthly_price,
    messages_limit = p_messages_limit,
    pricing_model  = p_pricing_model
  WHERE id = p_business_id;
END;
$$ LANGUAGE plpgsql SECURITY DEFINER;

-- 7. Seed demo business con billing
UPDATE businesses SET
  subscription_status = 'active',
  monthly_price       = 49.99,
  messages_limit      = 2000,
  next_billing_date   = NOW() + INTERVAL '30 days',
  pricing_model       = 'monthly',
  owner_phone         = '584142558415'
WHERE id = '783e2ef2-5f4e-46b6-8d2b-e8604b1fbefe';
`;

async function runMigration() {
  console.log('🚀 Ejecutando migración en Supabase...\n');

  const res = await fetch(
    `https://api.supabase.com/v1/projects/${PROJECT_REF}/database/query`,
    {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${SERVICE_KEY}`,
      },
      body: JSON.stringify({ query: SQL }),
    }
  );

  const text = await res.text();
  console.log(`Status: ${res.status}`);
  console.log(text.substring(0, 500));

  if (res.ok) {
    console.log('\n✅ Migración aplicada con éxito');
  } else {
    console.log('\n⚠️  Respuesta inesperada - puede que necesites aplicar el SQL manualmente');
  }
}

runMigration().catch(console.error);
