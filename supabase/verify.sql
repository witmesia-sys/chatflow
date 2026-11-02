-- ================================================================
-- VERIFICACION: Confirmar que el schema quedó correcto
-- Ejecutar en Supabase SQL Editor
-- ================================================================

-- 1. Tablas creadas con RLS activo
SELECT
  tablename,
  rowsecurity AS rls_enabled
FROM pg_tables
WHERE schemaname = 'public'
  AND tablename IN (
    'businesses','business_members','business_api_keys',
    'knowledge_base','contacts','conversations',
    'messages','appointments','usage_logs'
  )
ORDER BY tablename;

-- 2. Funciones creadas
SELECT routine_name, routine_type
FROM information_schema.routines
WHERE routine_schema = 'public'
  AND routine_name IN (
    'my_business_id','custom_access_token_hook',
    'save_business_api_key','get_secret_value',
    'search_knowledge','create_appointment',
    'create_business','update_updated_at_column'
  )
ORDER BY routine_name;

-- 3. Constraint anti-doble-reserva
SELECT conname, contype
FROM pg_constraint
WHERE conname = 'no_double_booking';

-- 4. Indices creados
SELECT indexname
FROM pg_indexes
WHERE schemaname = 'public'
ORDER BY indexname;
