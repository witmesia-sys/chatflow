-- ================================================================
-- ChatFlow AI — Registro de Negocio y Permisos
-- Ejecutar en: Supabase Dashboard -> SQL Editor -> New query
-- ================================================================

-- 1. Otorgar permisos al service_role sobre las tablas
GRANT USAGE ON SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL TABLES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL ROUTINES IN SCHEMA public TO postgres, anon, authenticated, service_role;
GRANT ALL ON ALL SEQUENCES IN SCHEMA public TO postgres, anon, authenticated, service_role;

ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON TABLES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON ROUTINES TO postgres, anon, authenticated, service_role;
ALTER DEFAULT PRIVILEGES IN SCHEMA public GRANT ALL ON SEQUENCES TO postgres, anon, authenticated, service_role;

-- 2. Función para mantener ventana de contexto de chat
CREATE OR REPLACE FUNCTION public.append_context_window(
  p_conversation_id UUID,
  p_role TEXT,
  p_content TEXT
)
RETURNS VOID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_item JSONB;
BEGIN
  v_item := jsonb_build_object('role', p_role, 'content', p_content);
  UPDATE public.conversations
  SET context_window = CASE 
    WHEN jsonb_array_length(COALESCE(context_window, '[]'::jsonb)) >= 10 
    THEN (context_window - 0) || jsonb_build_array(v_item)
    ELSE COALESCE(context_window, '[]'::jsonb) || jsonb_build_array(v_item)
  END
  WHERE id = p_conversation_id;
END;
$$;

-- 3. Crear usuario, negocio BarberPro y su base de conocimiento
DO $$
DECLARE
  v_user_id UUID;
  v_business_id UUID;
BEGIN
  -- Usuario admin
  SELECT id INTO v_user_id FROM auth.users WHERE email = 'admin@chatflowai.com';

  IF v_user_id IS NULL THEN
    v_user_id := gen_random_uuid();
    INSERT INTO auth.users (
      id, instance_id, email, encrypted_password, email_confirmed_at,
      created_at, updated_at, raw_app_meta_data, raw_user_meta_data,
      is_super_admin, role, aud
    ) VALUES (
      v_user_id, '00000000-0000-0000-0000-000000000000',
      'admin@chatflowai.com', crypt('ChatFlow2024!', gen_salt('bf')), NOW(),
      NOW(), NOW(), '{"provider":"email","providers":["email"]}',
      '{"name":"Admin BarberPro"}', false, 'authenticated', 'authenticated'
    );
  END IF;

  -- Negocio
  SELECT id INTO v_business_id FROM public.businesses WHERE phone_number = '15551338065';

  IF v_business_id IS NULL THEN
    INSERT INTO public.businesses (
      owner_user_id, name, niche, phone_number, whatsapp_phone_id, owner_phone,
      timezone, business_hours, policies, ai_tone, ai_goal, is_active, subscription_tier
    ) VALUES (
      v_user_id, 'BarberPro 5 Estrellas', 'barbería', '15551338065',
      '1420759887787569', '584142558415', 'America/Caracas',
      '{"mon":["09:00","19:00"],"tue":["09:00","19:00"],"wed":["09:00","19:00"],"thu":["09:00","19:00"],"fri":["09:00","20:00"],"sat":["09:00","20:00"]}'::jsonb,
      'Tolerancia de 15 minutos para citas.', 'friendly', 'book_appointment', true, 'pro'
    ) RETURNING id INTO v_business_id;

    INSERT INTO public.business_members (business_id, user_id, role)
    VALUES (v_business_id, v_user_id, 'owner')
    ON CONFLICT (business_id, user_id) DO NOTHING;
  END IF;

  -- Base de conocimiento para que la IA responda
  DELETE FROM public.knowledge_base WHERE business_id = v_business_id;

  INSERT INTO public.knowledge_base (business_id, content_type, title, content)
  VALUES 
    (v_business_id, 'services', 'Servicios y Precios', 'Corte clasico: $10. Corte degradado / fade: $12. Perfilado de barba y toalla caliente: $8. Combo Corte + Barba: $18. Tratamiento capilar: $15.'),
    (v_business_id, 'faq', 'Ubicacion y Horario', 'Estamos ubicados en Av. Principal, C.C. Las Estrellas, Local 4. Atendemos de Lunes a Jueves 9:00 AM a 7:00 PM, y Viernes a Sabado 9:00 AM a 8:00 PM.'),
    (v_business_id, 'faq', 'Metodos de Pago', 'Aceptamos Pago Movil, Efectivo ($ y Bs), Zelle y Binance Pay.');

END $$;
