import { createClient } from '@supabase/supabase-js';
import { logger } from '../utils/logger.js';

// service_role para operaciones del webhook (bypasea RLS — solo en backend seguro)
export const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─────────────────────────────────────────────
// BUSINESSES
// ─────────────────────────────────────────────

/**
 * Busca el negocio por su número de WhatsApp (display_phone_number del webhook de Meta).
 * Pre-carga y desencripta el whatsapp_token para adjuntarlo en memoria (nunca se persiste).
 */
export async function getBusinessByPhone(phoneNumber) {
  if (!phoneNumber) return null;
  const cleanPhone = String(phoneNumber).replace(/\D/g, '');

  const { data, error } = await supabase
    .from('businesses')
    .select('*')
    .or(`phone_number.eq.${phoneNumber},phone_number.eq.${cleanPhone},phone_number.eq.+${cleanPhone}`)
    .eq('is_active', true)
    .limit(1)
    .maybeSingle();

  if (error) {
    logger.error('Error en getBusinessByPhone:', error);
    return null;
  }
  if (!data) return null;

  // Cargar el token de WhatsApp desencriptado desde Vault si existe
  try {
    const { data: keyRow } = await supabase
      .from('business_api_keys')
      .select('vault_secret_id')
      .eq('business_id', data.id)
      .eq('service_name', 'whatsapp_token')
      .maybeSingle();

    if (keyRow) {
      const { data: secret } = await supabase
        .rpc('get_secret_value', { p_secret_id: keyRow.vault_secret_id });
      data._wa_token = secret;  // propiedad efímera, solo en memoria
    }
  } catch (e) {
    logger.warn(`No se pudo cargar WA token para negocio ${data.id}:`, e.message);
  }

  return data;
}

// ─────────────────────────────────────────────
// CONTACTS
// ─────────────────────────────────────────────

export async function upsertContact(businessId, phone) {
  const { data, error } = await supabase
    .from('contacts')
    .upsert(
      { business_id: businessId, phone },
      { onConflict: 'business_id,phone', ignoreDuplicates: false }
    )
    .select()
    .single();

  if (error) throw new Error(`upsertContact: ${error.message}`);
  return data;
}

// ─────────────────────────────────────────────
// CONVERSATIONS
// ─────────────────────────────────────────────

export async function getOrCreateConversation(businessId, contactId, waMessageId) {
  // Buscar conversación activa existente (no cerrada)
  const { data: existing } = await supabase
    .from('conversations')
    .select('*')
    .eq('business_id', businessId)
    .eq('contact_id', contactId)
    .neq('status', 'closed')
    .order('created_at', { ascending: false })
    .limit(1)
    .maybeSingle();

  if (existing) return existing;

  // Crear nueva conversación
  const { data: created, error } = await supabase
    .from('conversations')
    .insert({ business_id: businessId, contact_id: contactId })
    .select()
    .single();

  if (error) throw new Error(`getOrCreateConversation: ${error.message}`);
  return created;
}

// ─────────────────────────────────────────────
// KNOWLEDGE BASE
// ─────────────────────────────────────────────

export async function getKnowledgeBase(businessId) {
  const { data } = await supabase
    .from('knowledge_base')
    .select('title, content, content_type')
    .eq('business_id', businessId)
    .eq('is_active', true)
    .limit(20);

  return data ?? [];
}

// ─────────────────────────────────────────────
// APPOINTMENTS (AGENDA DE CITAS)
// ─────────────────────────────────────────────

export async function getUpcomingAppointments(businessId) {
  try {
    const { data } = await supabase
      .from('appointments')
      .select('id, service_name, slot, notes, status, contacts(full_name, phone)')
      .eq('business_id', businessId)
      .eq('status', 'confirmed')
      .order('created_at', { ascending: false })
      .limit(10);

    return data ?? [];
  } catch (err) {
    logger.warn(`getUpcomingAppointments: ${err.message}`);
    return [];
  }
}

// ─────────────────────────────────────────────
// MESSAGES
// ─────────────────────────────────────────────

export async function saveMessage({ conversationId, businessId, role, content, waMessageId }) {
  const payload = { conversation_id: conversationId, business_id: businessId, role, content };
  if (waMessageId) payload.wa_message_id = waMessageId;

  const { error } = await supabase.from('messages').insert(payload);

  // Ignorar error de duplicate wa_message_id (mensaje ya procesado)
  if (error && error.code !== '23505') {
    logger.warn(`saveMessage error: ${error.message}`);
  }

  // Actualizar context_window en la conversación (últimos 10 mensajes)
  try {
    await supabase.rpc('append_context_window', {
      p_conversation_id: conversationId,
      p_role: role,
      p_content: content,
    });
  } catch (err) {
    logger.warn('append_context_window aviso:', err.message);
  }
}

// ─────────────────────────────────────────────
// USAGE LOGS
// ─────────────────────────────────────────────

export async function logUsage(businessId, eventType, tokensUsed = 0) {
  // Costo aproximado GPT-4o-mini: $0.150 / 1M input tokens + $0.600 / 1M output tokens
  // Usamos promedio $0.375 / 1M tokens como estimación conservadora
  const costUsd = (tokensUsed / 1_000_000) * 0.375;

  try {
    await supabase.from('usage_logs').insert({
      business_id: businessId,
      event_type:  eventType,
      tokens_used: tokensUsed,
      cost_usd:    costUsd,
    });
  } catch (e) {
    logger.warn(`logUsage: ${e.message}`);
  }
}
