import { supabase } from './supabase.js';
import { logger } from '../utils/logger.js';

/**
 * Procesa comandos directos enviados por el dueño del negocio desde su WhatsApp personal
 * Comandos soportados: #citas, #agotar, #disponible, #bloquear, #ayuda
 */
export async function handleOwnerCommand(business, rawText) {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  // 1. #citas — Consultar próximas reservas
  if (lower === '#citas' || lower === '!citas') {
    const { data: appts, error } = await supabase
      .from('appointments')
      .select('id, service_name, notes, status, idempotency_key, created_at, contacts(full_name, phone)')
      .eq('business_id', business.id)
      .eq('status', 'confirmed')
      .order('created_at', { ascending: false })
      .limit(6);

    if (error || !appts || appts.length === 0) {
      return `📅 *AGENDA DE CITAS — ${business.name}*\n\nActualmente no tienes citas pendientes registradas en la agenda.`;
    }

    const lines = appts.map((a, i) => {
      const ticket = a.idempotency_key?.match(/CF-\d+/)?.[0] || 'S/N';
      const client = a.contacts?.full_name || 'Cliente';
      const phone = a.contacts?.phone ? `(+${a.contacts.phone})` : '';
      const notes = a.notes ? `\n   📝 ${a.notes}` : '';
      return `${i + 1}. *${client}* ${phone}\n   ✂️ ${a.service_name} | 🎟️ #${ticket}${notes}`;
    }).join('\n\n');

    return `📅 *AGENDA DE CITAS — ${business.name}*\n━━━━━━━━━━━━━━━━━━━━━\n${lines}\n━━━━━━━━━━━━━━━━━━━━━\n_Tienes ${appts.length} cita(s) confirmada(s)._`;
  }

  // 2. #agotar <producto o servicio>
  if (lower.startsWith('#agotar') || lower.startsWith('!agotar')) {
    const item = text.replace(/^[#!]agotar\s*/i, '').trim();
    if (!item) {
      return '⚠️ Por favor indica qué producto o servicio deseas marcar como agotado.\nEjemplo: *#agotar pomada mate* o *#agotar afeitado con navaja*';
    }

    const title = `⚠️ AGOTADO: ${item}`;
    const content = `El producto o servicio "${item}" se encuentra temporalmente AGOTADO o NO DISPONIBLE. Detalle: Reportado por el dueño. REGLA OBLIGATORIA: No ofrecerlo ni reservarlo; si el cliente lo solicita, infórmale con amabilidad que no hay disponibilidad y sugiérele alternativas.`;

    await supabase.from('knowledge_base').insert({
      business_id: business.id,
      title,
      content,
      content_type: 'out_of_stock',
      is_active: true,
    });

    return `📦 *¡Anotado!* He marcado "*${item}*" como *AGOTADO*.\n\nA partir de este momento, el asistente virtual no lo ofrecerá ni permitirá reservarlo a los clientes hasta que lo reactives con *#disponible ${item}*.`;
  }

  // 3. #disponible <producto o servicio>
  if (lower.startsWith('#disponible') || lower.startsWith('!disponible')) {
    const item = text.replace(/^[#!]disponible\s*/i, '').trim();
    if (!item) {
      return '⚠️ Por favor indica qué producto o servicio vuelve a estar disponible.\nEjemplo: *#disponible pomada mate*';
    }

    // Desactivar entradas de out_of_stock coincidentes
    const { data: matches } = await supabase
      .from('knowledge_base')
      .select('id, title')
      .eq('business_id', business.id)
      .eq('content_type', 'out_of_stock')
      .ilike('title', `%${item}%`);

    if (matches && matches.length > 0) {
      const ids = matches.map(m => m.id);
      await supabase.from('knowledge_base').update({ is_active: false }).in('id', ids);
    }

    return `✅ *¡Listo!* "*${item}*" vuelve a estar marcado como *DISPONIBLE*.\n\nEl asistente virtual ya puede recomendarlo y agendarlo normalmente para tus clientes.`;
  }

  // 4. #bloquear <horario>
  if (lower.startsWith('#bloquear') || lower.startsWith('!bloquear')) {
    const schedule = text.replace(/^[#!]bloquear\s*/i, '').trim();
    if (!schedule) {
      return '⚠️ Por favor indica qué horario o día deseas bloquear.\nEjemplo: *#bloquear viernes de 2pm a 5pm* o *#bloquear mañana todo el día*';
    }

    await supabase.from('knowledge_base').insert({
      business_id: business.id,
      title: `🔒 BLOQUEO DE AGENDA: ${schedule}`,
      content: `HORARIO BLOQUEADO: "${schedule}". El negocio NO ATENDERÁ ni recibirá citas en esa franja de tiempo por motivos de descanso o mantenimiento. Si un cliente solicita turno en ese horario, indícale amablemente que está ocupado y ofrece alternativas.`,
      content_type: 'inventory_notice',
      is_active: true,
    });

    return `🔒 *Horario bloqueado con éxito:*\n"${schedule}" quedó registrado.\n\nEl bot no otorgará citas en ese rango y ofrecerá otras horas disponibles.`;
  }

  // 5. #ayuda — Menú de comandos
  if (lower === '#ayuda' || lower === '!ayuda' || lower === '#menu' || lower === '!menu') {
    return `📱 *MENÚ DE CONTROL DIRECTO — DUEÑO*\n━━━━━━━━━━━━━━━━━━━━━\nPuedes controlar a tu bot desde tu propio WhatsApp con estos comandos:\n\n• *#citas* ➔ Ver la lista de citas agendadas\n• *#agotar <producto>* ➔ Marcar algo sin stock\n• *#disponible <producto>* ➔ Reactivar disponibilidad\n• *#bloquear <horario>* ➔ Bloquear horas de la agenda\n• *#ayuda* ➔ Ver este menú\n━━━━━━━━━━━━━━━━━━━━━\n_Solo tú (desde tu número de dueño) puedes ejecutar estos comandos._`;
  }

  return null;
}
