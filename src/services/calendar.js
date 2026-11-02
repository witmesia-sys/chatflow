/**
 * calendar.js — Google Calendar Integration
 * ChatFlow AI / AutoCitas AI
 *
 * Responsabilidades:
 *  - checkCalendarAvailability(): devuelve 2 slots libres próximos
 *  - createCalendarEvent():       crea el evento y llama a create_appointment() en Supabase
 *
 * Autenticación: OAuth2 con refresh_token almacenado en Supabase Vault por negocio.
 * Scope requerido: https://www.googleapis.com/auth/calendar
 */

import { google } from 'googleapis';
import { createClient } from '@supabase/supabase-js';
import { randomUUID } from 'crypto';
import { logger } from '../utils/logger.js';

// Cliente Supabase con service_role para acceder a vault y funciones atómicas
const supabaseAdmin = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

// ─────────────────────────────────────────────
// HELPERS: Autenticación OAuth2 por negocio
// ─────────────────────────────────────────────

/**
 * Construye un cliente OAuth2 autenticado para el negocio dado.
 * Desencripta el refresh_token desde Supabase Vault (solo accesible con service_role).
 */
async function getAuthClientForBusiness(businessId) {
  // 1. Obtener vault_secret_id para el gcal_refresh_token del negocio
  const { data, error } = await supabaseAdmin
    .from('business_api_keys')
    .select('vault_secret_id')
    .eq('business_id', businessId)
    .eq('service_name', 'gcal_refresh_token')
    .single();

  if (error || !data) {
    throw new Error(`Google Calendar no conectado para negocio ${businessId}`);
  }

  // 2. Desencriptar el token desde vault.decrypted_secrets
  const { data: secretRow, error: vaultError } = await supabaseAdmin
    .rpc('get_secret_value', { p_secret_id: data.vault_secret_id });

  if (vaultError || !secretRow) {
    throw new Error('Error desencriptando token de Google Calendar');
  }

  // 3. Construir cliente OAuth2
  const oauth2Client = new google.auth.OAuth2(
    process.env.GOOGLE_CLIENT_ID,
    process.env.GOOGLE_CLIENT_SECRET,
    process.env.GOOGLE_REDIRECT_URI
  );

  oauth2Client.setCredentials({ refresh_token: secretRow });

  // Auto-guardar el nuevo access_token cuando se refresque
  oauth2Client.on('tokens', async (tokens) => {
    if (tokens.refresh_token) {
      // Actualizar refresh_token en vault si Google lo rota
      await supabaseAdmin.rpc('save_business_api_key', {
        p_business_id:  businessId,
        p_service_name: 'gcal_refresh_token',
        p_api_key:      tokens.refresh_token,
      });
      logger.info(`Refresh token rotado para negocio ${businessId}`);
    }
  });

  return oauth2Client;
}

// ─────────────────────────────────────────────
// FUNCIÓN 1: Consultar disponibilidad
// ─────────────────────────────────────────────

/**
 * Retorna exactamente 2 slots disponibles próximos para el servicio solicitado.
 * Estrategia: busca en los próximos 7 días, devuelve los primeros 2 huecos libres
 * respetando el horario de atención del negocio.
 *
 * @param {Object} business         - Registro del negocio (incluye business_hours, timezone)
 * @param {string} service          - Nombre del servicio solicitado
 * @param {string} [preferredDate]  - ISO 8601 de fecha preferida (opcional)
 * @returns {Object}                - { slots: [{start, end, label}], service }
 */
export async function checkCalendarAvailability(business, service, preferredDate) {
  try {
    const auth     = await getAuthClientForBusiness(business.id);
    const calendar = google.calendar({ version: 'v3', auth });

    // Ventana de búsqueda: desde ahora (o fecha preferida) hasta 7 días después
    const now       = preferredDate ? new Date(preferredDate) : new Date();
    const timeMin   = now.toISOString();
    const timeMax   = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000).toISOString();

    // Consultar eventos ya agendados en el calendario del negocio
    const { data: freeBusy } = await calendar.freebusy.query({
      requestBody: {
        timeMin,
        timeMax,
        timeZone: business.timezone,
        items: [{ id: 'primary' }],
      },
    });

    const busySlots = freeBusy.calendars?.primary?.busy ?? [];

    // Generar candidatos de slots respetando horario de atención
    const candidates = generateCandidateSlots(business, now, timeMax, service);

    // Filtrar candidatos que no solapan con slots ocupados
    const availableSlots = candidates.filter(candidate =>
      !busySlots.some(busy =>
        new Date(busy.start) < new Date(candidate.end) &&
        new Date(busy.end) > new Date(candidate.start)
      )
    );

    // Tomar solo los primeros 2 disponibles
    const topTwo = availableSlots.slice(0, 2);

    if (topTwo.length === 0) {
      return {
        available: false,
        message: 'No hay disponibilidad en los próximos 7 días. ¿Puedo buscarte en una fecha específica?',
        slots: [],
      };
    }

    return {
      available: true,
      service,
      slots: topTwo.map(slot => ({
        start: slot.start,
        end:   slot.end,
        label: formatSlotLabel(slot.start, business.timezone),
      })),
    };

  } catch (err) {
    logger.error('Error consultando disponibilidad:', err.message);
    return {
      available: false,
      message: 'No pude consultar la agenda en este momento. Te transfiero con un asesor.',
      slots: [],
      error: true,
    };
  }
}

// ─────────────────────────────────────────────
// FUNCIÓN 2: Crear evento y registrar cita
// ─────────────────────────────────────────────

/**
 * Crea el evento en Google Calendar y registra la cita en Supabase de forma atómica.
 * Usa la función create_appointment() de Supabase para garantizar idempotencia + EXCLUDE.
 *
 * @param {Object} business  - Registro del negocio
 * @param {Object} contact   - Contacto del cliente { id, full_name, phone }
 * @param {Object} args      - { contact_name, contact_phone, service, datetime_iso }
 * @returns {Object}         - { success, appointment?, error? }
 */
export async function createCalendarEvent(business, contact, args) {
  const { service, datetime_iso, contact_name } = args;

  try {
    const auth     = await getAuthClientForBusiness(business.id);
    const calendar = google.calendar({ version: 'v3', auth });

    // Duración por defecto: 60 minutos (configurable por servicio en el futuro)
    const startTime = new Date(datetime_iso);
    const endTime   = new Date(startTime.getTime() + 60 * 60 * 1000);

    // Idempotency key: UUID único generado aquí, reutilizable en retries
    const idempotencyKey = randomUUID();

    // ── Paso 1: Intentar reservar en Supabase PRIMERO (constraint atómica)
    const { data: result, error: dbError } = await supabaseAdmin.rpc('create_appointment', {
      p_business_id:     business.id,
      p_contact_id:      contact.id,
      p_service_name:    service,
      p_start_time:      startTime.toISOString(),
      p_end_time:        endTime.toISOString(),
      p_idempotency_key: idempotencyKey,
    });

    if (dbError) throw dbError;

    // Si el slot ya fue tomado por race condition
    if (!result.success) {
      return {
        success: false,
        error_code: result.error_code,
        message: result.message,
      };
    }

    const appointmentId = result.data.id;

    // ── Paso 2: Crear evento en Google Calendar
    const { data: gcalEvent } = await calendar.events.insert({
      calendarId: 'primary',
      requestBody: {
        summary:     `${service} — ${contact_name ?? contact.full_name ?? contact.phone}`,
        description: `Cita agendada automáticamente por ChatFlow AI\nServicio: ${service}\nCliente: ${contact.phone}`,
        start: { dateTime: startTime.toISOString(), timeZone: business.timezone },
        end:   { dateTime: endTime.toISOString(),   timeZone: business.timezone },
        attendees: contact.email ? [{ email: contact.email }] : [],
        reminders: {
          useDefault: false,
          overrides:  [
            { method: 'popup', minutes: 60 },
            { method: 'popup', minutes: 10 },
          ],
        },
      },
    });

    // ── Paso 3: Actualizar la cita en Supabase con el gcal_event_id
    await supabaseAdmin
      .from('appointments')
      .update({ gcal_event_id: gcalEvent.id, status: 'confirmed' })
      .eq('id', appointmentId);

    logger.info(`Cita creada: ${appointmentId} | GCal: ${gcalEvent.id}`);

    return {
      success:     true,
      idempotent:  result.idempotent ?? false,
      appointment: {
        id:           appointmentId,
        service,
        start:        startTime.toISOString(),
        end:          endTime.toISOString(),
        label:        formatSlotLabel(startTime.toISOString(), business.timezone),
        gcal_event_id: gcalEvent.id,
      },
    };

  } catch (err) {
    logger.error('Error creando cita en Google Calendar:', err.message);
    return {
      success:    false,
      error_code: 'GCAL_ERROR',
      message:    'Hubo un error al confirmar tu cita. Un asesor te contactará para confirmar manualmente.',
    };
  }
}

// ─────────────────────────────────────────────
// HELPERS INTERNOS
// ─────────────────────────────────────────────

/**
 * Genera candidatos de slots en el horario de atención del negocio.
 * Por defecto: slots de 60 min, de lunes a sábado, en horario definido en business_hours.
 */
function generateCandidateSlots(business, fromDate, toDateIso, service) {
  const slots        = [];
  const toDate       = new Date(toDateIso);
  const current      = new Date(fromDate);
  const businessHours = business.business_hours ?? {};

  // Redondear al próximo slot de hora completa o media hora
  current.setMinutes(current.getMinutes() < 30 ? 30 : 60, 0, 0);

  const DAY_KEYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

  while (current < toDate && slots.length < 20) {
    const dayKey = DAY_KEYS[current.getDay()];
    const hours  = businessHours[dayKey];

    if (hours && Array.isArray(hours) && hours.length === 2) {
      const [openHour, openMin]  = hours[0].split(':').map(Number);
      const [closeHour, closeMin] = hours[1].split(':').map(Number);

      const openTime  = new Date(current);
      openTime.setHours(openHour, openMin, 0, 0);
      const closeTime = new Date(current);
      closeTime.setHours(closeHour, closeMin, 0, 0);

      // El slot debe comenzar después de la hora actual y antes de cierre - 60min
      if (current >= openTime && current.getTime() + 60 * 60 * 1000 <= closeTime.getTime()) {
        const slotEnd = new Date(current.getTime() + 60 * 60 * 1000);
        slots.push({
          start: current.toISOString(),
          end:   slotEnd.toISOString(),
        });
      }
    }

    // Avanzar 30 minutos para el siguiente candidato
    current.setMinutes(current.getMinutes() + 30);

    // Si ya pasamos el horario de hoy, saltar al inicio del próximo día
    if (businessHours[dayKey]) {
      const [closeHour, closeMin] = (businessHours[dayKey][1] ?? '18:00').split(':').map(Number);
      const closeToday = new Date(current);
      closeToday.setHours(closeHour, closeMin, 0, 0);
      if (current > closeToday) {
        current.setDate(current.getDate() + 1);
        current.setHours(0, 0, 0, 0);
      }
    }
  }

  return slots;
}

/**
 * Formatea un ISO datetime en etiqueta legible para WhatsApp.
 * Ej: "martes 4 de noviembre a las 3:00 PM"
 */
function formatSlotLabel(isoString, timezone) {
  const date = new Date(isoString);
  return date.toLocaleString('es-CO', {
    timeZone:  timezone,
    weekday:   'long',
    day:       'numeric',
    month:     'long',
    hour:      '2-digit',
    minute:    '2-digit',
    hour12:    true,
  });
}
