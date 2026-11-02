-- ================================================================
-- ChatFlow AI - Schema Multi-Tenant
-- Ejecutar BLOQUE POR BLOQUE en Supabase SQL Editor
-- Cada bloque termina con un comentario "-- FIN BLOQUE N"
-- ================================================================


-- ================================================================
-- BLOQUE 1: EXTENSIONES
-- ================================================================
CREATE EXTENSION IF NOT EXISTS "uuid-ossp";
CREATE EXTENSION IF NOT EXISTS "pgcrypto";
CREATE EXTENSION IF NOT EXISTS "btree_gist";
CREATE EXTENSION IF NOT EXISTS "vector";
-- FIN BLOQUE 1


-- ================================================================
-- BLOQUE 2: TABLA businesses
-- ================================================================
CREATE TABLE public.businesses (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  owner_user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  name              TEXT        NOT NULL,
  niche             TEXT,
  phone_number      TEXT,
  whatsapp_phone_id TEXT,
  owner_phone       TEXT,
  address           TEXT,
  timezone          TEXT        NOT NULL DEFAULT 'America/Bogota',
  business_hours    JSONB,
  policies          TEXT,
  ai_tone           TEXT        NOT NULL DEFAULT 'friendly',
  ai_goal           TEXT        NOT NULL DEFAULT 'book_appointment',
  is_active         BOOLEAN     NOT NULL DEFAULT true,
  subscription_tier TEXT        NOT NULL DEFAULT 'basic',
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_ai_tone CHECK (ai_tone IN ('professional','friendly','sales','formal')),
  CONSTRAINT chk_ai_goal CHECK (ai_goal IN ('book_appointment','qualify_lead','answer_faq')),
  CONSTRAINT chk_tier    CHECK (subscription_tier IN ('basic','pro','enterprise'))
);

CREATE INDEX idx_businesses_phone    ON public.businesses(phone_number);
CREATE INDEX idx_businesses_owner    ON public.businesses(owner_user_id);
CREATE INDEX idx_businesses_wa_phone ON public.businesses(whatsapp_phone_id);

ALTER TABLE public.businesses ENABLE ROW LEVEL SECURITY;

CREATE POLICY "businesses_select" ON public.businesses
  FOR SELECT TO authenticated
  USING (owner_user_id = auth.uid());

CREATE POLICY "businesses_insert" ON public.businesses
  FOR INSERT TO authenticated
  WITH CHECK (owner_user_id = auth.uid());

CREATE POLICY "businesses_update" ON public.businesses
  FOR UPDATE TO authenticated
  USING (owner_user_id = auth.uid());
-- FIN BLOQUE 2


-- ================================================================
-- BLOQUE 3: TABLA business_members
-- ================================================================
CREATE TABLE public.business_members (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  user_id     UUID        NOT NULL REFERENCES auth.users(id) ON DELETE CASCADE,
  role        TEXT        NOT NULL DEFAULT 'owner',
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_role CHECK (role IN ('owner','agent','viewer')),
  UNIQUE (business_id, user_id)
);

CREATE INDEX idx_members_user     ON public.business_members(user_id);
CREATE INDEX idx_members_business ON public.business_members(business_id);

ALTER TABLE public.business_members ENABLE ROW LEVEL SECURITY;

CREATE POLICY "members_self" ON public.business_members
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (user_id = auth.uid());
-- FIN BLOQUE 3


-- ================================================================
-- BLOQUE 4: FUNCION RLS + CUSTOM ACCESS TOKEN HOOK
-- ================================================================
-- Nota: NO se puede crear en schema "auth" desde SQL Editor.
-- Se crea en public y se referencia igual desde las policies.
CREATE OR REPLACE FUNCTION public.my_business_id()
RETURNS UUID LANGUAGE sql STABLE SECURITY DEFINER AS $$
  SELECT (auth.jwt() -> 'app_metadata' ->> 'business_id')::uuid;
$$;

GRANT EXECUTE ON FUNCTION public.my_business_id() TO authenticated;

CREATE OR REPLACE FUNCTION public.custom_access_token_hook(event jsonb)
RETURNS jsonb LANGUAGE plpgsql SECURITY DEFINER SET search_path = '' AS $$
DECLARE
  claims jsonb;
  v_business_id uuid;
BEGIN
  SELECT business_id INTO v_business_id
  FROM public.business_members
  WHERE user_id = (event->>'user_id')::uuid
  ORDER BY created_at ASC LIMIT 1;

  claims := event->'claims';
  IF jsonb_typeof(claims->'app_metadata') IS NULL THEN
    claims := jsonb_set(claims, '{app_metadata}', '{}');
  END IF;
  claims := jsonb_set(claims, '{app_metadata,business_id}', to_jsonb(v_business_id));
  RETURN jsonb_set(event, '{claims}', claims);
END;
$$;

GRANT EXECUTE ON FUNCTION public.custom_access_token_hook TO supabase_auth_admin;
REVOKE EXECUTE ON FUNCTION public.custom_access_token_hook FROM authenticated, anon, public;
-- FIN BLOQUE 4
-- ACCION: Auth > Hooks > Custom Access Token > seleccionar public.custom_access_token_hook


-- ================================================================
-- BLOQUE 5: TABLA business_api_keys (Supabase Vault)
-- ================================================================
CREATE TABLE public.business_api_keys (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  service_name    TEXT        NOT NULL,
  vault_secret_id UUID        NOT NULL,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, service_name)
);

CREATE INDEX idx_api_keys_business ON public.business_api_keys(business_id);

ALTER TABLE public.business_api_keys ENABLE ROW LEVEL SECURITY;

CREATE POLICY "api_keys_tenant" ON public.business_api_keys
  AS RESTRICTIVE FOR ALL TO authenticated
  USING  (business_id = public.my_business_id())
  WITH CHECK (business_id = public.my_business_id());

CREATE OR REPLACE FUNCTION public.save_business_api_key(
  p_business_id  UUID,
  p_service_name TEXT,
  p_api_key      TEXT
)
RETURNS void LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_secret_id UUID;
BEGIN
  IF p_business_id != public.my_business_id() THEN
    RAISE EXCEPTION 'Unauthorized: business_id mismatch';
  END IF;
  v_secret_id := vault.create_secret(
    p_api_key,
    p_service_name,
    'ChatFlow AI key for business ' || p_business_id::text
  );
  INSERT INTO public.business_api_keys (business_id, service_name, vault_secret_id)
  VALUES (p_business_id, p_service_name, v_secret_id)
  ON CONFLICT (business_id, service_name)
  DO UPDATE SET vault_secret_id = EXCLUDED.vault_secret_id, created_at = NOW();
END;
$$;

CREATE OR REPLACE FUNCTION public.get_secret_value(p_secret_id UUID)
RETURNS TEXT LANGUAGE sql SECURITY DEFINER AS $$
  SELECT secret FROM vault.decrypted_secrets WHERE id = p_secret_id;
$$;

REVOKE ALL ON FUNCTION public.get_secret_value FROM anon, authenticated;
GRANT  EXECUTE ON FUNCTION public.get_secret_value TO service_role;
-- FIN BLOQUE 5


-- ================================================================
-- BLOQUE 6: TABLA knowledge_base (RAG con pgvector)
-- ================================================================
CREATE TABLE public.knowledge_base (
  id           UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id  UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  content_type TEXT        NOT NULL DEFAULT 'faq',
  title        TEXT,
  content      TEXT        NOT NULL,
  embedding    VECTOR(1536),
  is_active    BOOLEAN     NOT NULL DEFAULT true,
  created_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_content_type CHECK (content_type IN ('faq','services','prices','pdf','manual','custom'))
);

CREATE INDEX idx_kb_business  ON public.knowledge_base(business_id);
CREATE INDEX idx_kb_embedding ON public.knowledge_base
  USING ivfflat (embedding vector_cosine_ops) WITH (lists = 100);

ALTER TABLE public.knowledge_base ENABLE ROW LEVEL SECURITY;

CREATE POLICY "kb_tenant" ON public.knowledge_base
  AS RESTRICTIVE FOR ALL TO authenticated
  USING  (business_id = public.my_business_id())
  WITH CHECK (business_id = public.my_business_id());

CREATE OR REPLACE FUNCTION public.search_knowledge(
  p_business_id UUID,
  p_embedding   VECTOR(1536),
  p_limit       INT DEFAULT 5
)
RETURNS TABLE (id UUID, title TEXT, content TEXT, similarity FLOAT)
LANGUAGE sql STABLE AS $$
  SELECT id, title, content,
         1 - (embedding <=> p_embedding) AS similarity
  FROM public.knowledge_base
  WHERE business_id = p_business_id
    AND is_active = true
    AND embedding IS NOT NULL
  ORDER BY embedding <=> p_embedding
  LIMIT p_limit;
$$;
-- FIN BLOQUE 6


-- ================================================================
-- BLOQUE 7: TABLA contacts
-- ================================================================
CREATE TABLE public.contacts (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  phone       TEXT        NOT NULL,
  full_name   TEXT,
  email       TEXT,
  tags        TEXT[],
  notes       TEXT,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  UNIQUE(business_id, phone)
);

CREATE INDEX idx_contacts_business ON public.contacts(business_id);
CREATE INDEX idx_contacts_phone    ON public.contacts(phone);

ALTER TABLE public.contacts ENABLE ROW LEVEL SECURITY;

CREATE POLICY "contacts_tenant" ON public.contacts
  AS RESTRICTIVE FOR ALL TO authenticated
  USING  (business_id = public.my_business_id())
  WITH CHECK (business_id = public.my_business_id());
-- FIN BLOQUE 7


-- ================================================================
-- BLOQUE 8: TABLA conversations
-- ================================================================
CREATE TABLE public.conversations (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id     UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contact_id      UUID        NOT NULL REFERENCES public.contacts(id) ON DELETE CASCADE,
  status          TEXT        NOT NULL DEFAULT 'bot_active',
  alert_level     TEXT,
  handoff_reason  TEXT,
  context_window  JSONB       NOT NULL DEFAULT '[]'::jsonb,
  created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_status      CHECK (status IN ('bot_active','paused','human_takeover','closed')),
  CONSTRAINT chk_alert_level CHECK (alert_level IN ('red') OR alert_level IS NULL)
);

CREATE INDEX idx_conv_business ON public.conversations(business_id);
CREATE INDEX idx_conv_contact  ON public.conversations(contact_id);
CREATE INDEX idx_conv_status   ON public.conversations(business_id, status);

ALTER TABLE public.conversations ENABLE ROW LEVEL SECURITY;

CREATE POLICY "conv_tenant" ON public.conversations
  AS RESTRICTIVE FOR ALL TO authenticated
  USING  (business_id = public.my_business_id())
  WITH CHECK (business_id = public.my_business_id());
-- FIN BLOQUE 8


-- ================================================================
-- BLOQUE 9: TABLA messages
-- ================================================================
CREATE TABLE public.messages (
  id              UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  conversation_id UUID        NOT NULL REFERENCES public.conversations(id) ON DELETE CASCADE,
  business_id     UUID        NOT NULL REFERENCES public.businesses(id),
  role            TEXT        NOT NULL,
  content         TEXT        NOT NULL,
  wa_message_id   TEXT        UNIQUE,
  sent_at         TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_role CHECK (role IN ('user','assistant','system','tool'))
);

CREATE INDEX idx_msg_business     ON public.messages(business_id);
CREATE INDEX idx_msg_conversation ON public.messages(conversation_id, sent_at DESC);

ALTER TABLE public.messages ENABLE ROW LEVEL SECURITY;

CREATE POLICY "msg_tenant" ON public.messages
  AS RESTRICTIVE FOR ALL TO authenticated
  USING  (business_id = public.my_business_id())
  WITH CHECK (business_id = public.my_business_id());
-- FIN BLOQUE 9


-- ================================================================
-- BLOQUE 10: TABLA appointments (TSTZRANGE + EXCLUDE GIST)
-- ================================================================
CREATE TABLE public.appointments (
  id                UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id       UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  contact_id        UUID        NOT NULL REFERENCES public.contacts(id),
  conversation_id   UUID        REFERENCES public.conversations(id),
  service_name      TEXT        NOT NULL,
  slot              TSTZRANGE   NOT NULL,
  status            TEXT        NOT NULL DEFAULT 'confirmed',
  gcal_event_id     TEXT,
  idempotency_key   TEXT        NOT NULL UNIQUE,
  notes             TEXT,
  created_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  updated_at        TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_appt_status CHECK (status IN ('pending','confirmed','cancelled','completed','no_show'))
);

ALTER TABLE public.appointments
ADD CONSTRAINT no_double_booking
EXCLUDE USING gist (
  business_id WITH =,
  slot WITH &&
) WHERE (status != 'cancelled');

CREATE INDEX idx_appt_business_slot ON public.appointments(business_id, slot);

ALTER TABLE public.appointments ENABLE ROW LEVEL SECURITY;

CREATE POLICY "appt_tenant" ON public.appointments
  AS RESTRICTIVE FOR ALL TO authenticated
  USING  (business_id = public.my_business_id())
  WITH CHECK (business_id = public.my_business_id());

CREATE OR REPLACE FUNCTION public.create_appointment(
  p_business_id     UUID,
  p_contact_id      UUID,
  p_service_name    TEXT,
  p_start_time      TIMESTAMPTZ,
  p_end_time        TIMESTAMPTZ,
  p_idempotency_key TEXT,
  p_gcal_event_id   TEXT DEFAULT NULL,
  p_notes           TEXT DEFAULT NULL
)
RETURNS JSON LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_existing appointments%rowtype;
  v_new      appointments%rowtype;
BEGIN
  SELECT * INTO v_existing FROM appointments WHERE idempotency_key = p_idempotency_key;
  IF FOUND THEN
    RETURN json_build_object('success', true, 'idempotent', true, 'data', row_to_json(v_existing));
  END IF;

  BEGIN
    INSERT INTO appointments (
      business_id, contact_id, service_name, slot, status,
      idempotency_key, gcal_event_id, notes
    ) VALUES (
      p_business_id, p_contact_id, p_service_name,
      tstzrange(p_start_time, p_end_time, '[)'),
      'confirmed', p_idempotency_key, p_gcal_event_id, p_notes
    ) RETURNING * INTO v_new;
    RETURN json_build_object('success', true, 'data', row_to_json(v_new));

  EXCEPTION
    WHEN exclusion_violation THEN
      RETURN json_build_object(
        'success', false, 'error_code', 'SLOT_TAKEN',
        'message', 'Este horario ya fue reservado. Por favor elige otro.'
      );
    WHEN unique_violation THEN
      SELECT * INTO v_existing FROM appointments WHERE idempotency_key = p_idempotency_key;
      RETURN json_build_object('success', true, 'idempotent', true, 'data', row_to_json(v_existing));
  END;
END;
$$;
-- FIN BLOQUE 10


-- ================================================================
-- BLOQUE 11: TABLA usage_logs
-- ================================================================
CREATE TABLE public.usage_logs (
  id          UUID        PRIMARY KEY DEFAULT gen_random_uuid(),
  business_id UUID        NOT NULL REFERENCES public.businesses(id) ON DELETE CASCADE,
  event_type  TEXT        NOT NULL,
  tokens_used INTEGER,
  cost_usd    NUMERIC(10,6),
  metadata    JSONB,
  created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
  CONSTRAINT chk_event_type CHECK (event_type IN ('ai_call','appointment_booked','handoff','wa_message'))
);

CREATE INDEX idx_usage_business ON public.usage_logs(business_id, created_at DESC);

ALTER TABLE public.usage_logs ENABLE ROW LEVEL SECURITY;

CREATE POLICY "usage_tenant" ON public.usage_logs
  AS RESTRICTIVE FOR ALL TO authenticated
  USING (business_id = public.my_business_id());
-- FIN BLOQUE 11


-- ================================================================
-- BLOQUE 12: TRIGGERS updated_at + FUNCION create_business
-- ================================================================
CREATE OR REPLACE FUNCTION update_updated_at_column()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = NOW();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_businesses_updated_at
  BEFORE UPDATE ON public.businesses
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_contacts_updated_at
  BEFORE UPDATE ON public.contacts
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_conversations_updated_at
  BEFORE UPDATE ON public.conversations
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE TRIGGER trg_appointments_updated_at
  BEFORE UPDATE ON public.appointments
  FOR EACH ROW EXECUTE FUNCTION update_updated_at_column();

CREATE OR REPLACE FUNCTION public.create_business(
  p_name     TEXT,
  p_niche    TEXT DEFAULT NULL,
  p_timezone TEXT DEFAULT 'America/Bogota'
)
RETURNS UUID LANGUAGE plpgsql SECURITY DEFINER AS $$
DECLARE
  v_business_id UUID;
BEGIN
  INSERT INTO public.businesses (owner_user_id, name, niche, timezone)
  VALUES (auth.uid(), p_name, p_niche, p_timezone)
  RETURNING id INTO v_business_id;

  INSERT INTO public.business_members (business_id, user_id, role)
  VALUES (v_business_id, auth.uid(), 'owner');

  RETURN v_business_id;
END;
$$;
-- FIN BLOQUE 12
-- Schema ChatFlow AI completado.
