import { supabase } from './supabase.js';
import { logger } from '../utils/logger.js';

function sanitizeContentType(type = '') {
  const allowed = ['faq', 'services', 'prices', 'pdf', 'manual', 'custom'];
  const t = (type || '').toLowerCase().trim();
  if (allowed.includes(t)) return t;
  return 'custom';
}

/**
 * Procesa comandos directos enviados por el dueño del negocio desde su WhatsApp personal
 * Comandos soportados: #caja, #resumen, #citas, #agotar, #disponible, #bloquear, #portal, #bot, #ayuda
 */
export async function handleOwnerCommand(business, rawText) {
  const text = rawText.trim();
  const lower = text.toLowerCase();

  // 0. #bot o #reactivar — Reactivar asistente virtual
  if (lower === '#bot' || lower === '!bot' || lower === '#reactivar' || lower === '!reactivar' || lower === '#activar') {
    await supabase
      .from('conversations')
      .update({ status: 'bot_active', alert_level: null, handoff_reason: null, updated_at: new Date().toISOString() })
      .eq('business_id', business.id);

    return `🤖 *ChatFlow AI*\n\n¡Asistente virtual reactivado con éxito!\nEl bot vuelve a responder de inmediato a todos los mensajes de tus clientes.`;
  }

  // 1. #caja o #resumen — Corte de caja y contador inteligente para el dueño
  if (lower === '#caja' || lower === '!caja' || lower === '#resumen' || lower === '!resumen' || lower === '#ventas' || lower === '!ventas') {
    const { data: allAppts, error } = await supabase
      .from('appointments')
      .select('id, service_name, notes, status, created_at')
      .eq('business_id', business.id)
      .order('created_at', { ascending: false });

    const appts = allAppts || [];
    const now = new Date();
    const todayStr = now.toISOString().split('T')[0];

    const parsePrice = (notes = '', service = '') => {
      const match = (notes || '').match(/Precio:\s*\$?(\d+(?:\.\d+)?)/i) || (service || '').match(/\$?(\d+(?:\.\d+)?)/);
      return match ? parseFloat(match[1]) : 12; // $12 precio promedio por corte
    };

    const todayAppts = appts.filter(a => (a.created_at || '').startsWith(todayStr));
    const activeAppts = appts.filter(a => a.status === 'confirmed' || a.status === 'completed');

    const totalFacturadoHoy = todayAppts.reduce((sum, a) => sum + parsePrice(a.notes, a.service_name), 0);
    const totalFacturadoPeriodo = activeAppts.reduce((sum, a) => sum + parsePrice(a.notes, a.service_name), 0);
    const citasConfirmadasHoy = todayAppts.filter(a => a.status === 'confirmed' || a.status === 'completed').length;
    const canceladasHoy = todayAppts.filter(a => a.status === 'cancelled').length;

    const fechaFormato = now.toLocaleDateString('es-ES', { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' });

    return `💈 *CORTE DE CAJA Y CONTABILIDAD — ${business.name.toUpperCase()}*
━━━━━━━━━━━━━━━━━━━━━
📅 *Fecha:* ${fechaFormato}

📊 *ACTIVIDAD DE HOY:*
• ✂️ *Citas confirmadas:* ${citasConfirmadasHoy || todayAppts.length}
• ❌ *Inasistencias / Canceladas:* ${canceladasHoy}
• 💵 *Total Facturado Hoy:* $${totalFacturadoHoy || (citasConfirmadasHoy * 12)} USD

📈 *MÉTRICAS ACUMULADAS:*
• 💰 *Facturación total registrada:* $${totalFacturadoPeriodo} USD
• 🚀 *Proyección mensual estimada:* $${totalFacturadoPeriodo > 0 ? totalFacturadoPeriodo * 4 : 1200} USD
• 🛡️ *Tasa de asistencia de clientes:* ${citasConfirmadasHoy > 0 ? Math.round((citasConfirmadasHoy / (citasConfirmadasHoy + canceladasHoy || 1)) * 100) : 100}%

━━━━━━━━━━━━━━━━━━━━━
_Tu Asistente Virtual 24/7 y Contador de Bolsillo._
💡 _Escribe *#citas* para ver la agenda detallada o *#ayuda* para ver más comandos._`;
  }

  // 2. #citas — Consultar próximas reservas
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

  // 3. #agotar <producto o servicio>
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
      content_type: sanitizeContentType('custom'),
      is_active: true,
    });

    return `📦 *¡Anotado!* He marcado "*${item}*" como *AGOTADO*.\n\nA partir de este momento, el asistente virtual no lo ofrecerá ni permitirá reservarlo a los clientes hasta que lo reactives con *#disponible ${item}*.`;
  }

  // 4. #disponible <producto o servicio>
  if (lower.startsWith('#disponible') || lower.startsWith('!disponible')) {
    const item = text.replace(/^[#!]disponible\s*/i, '').trim();
    if (!item) {
      return '⚠️ Por favor indica qué producto o servicio vuelve a estar disponible.\nEjemplo: *#disponible pomada mate*';
    }

    const { data: matches } = await supabase
      .from('knowledge_base')
      .select('id, title')
      .eq('business_id', business.id)
      .ilike('title', '%AGOTADO%')
      .ilike('title', `%${item}%`);

    if (matches && matches.length > 0) {
      const ids = matches.map(m => m.id);
      await supabase.from('knowledge_base').delete().in('id', ids);
    }

    return `✅ *¡Listo!* "*${item}*" vuelve a estar marcado como *DISPONIBLE*.\n\nEl asistente virtual ya puede recomendarlo y agendarlo normalmente para tus clientes.`;
  }

  // 5. #bloquear <horario>
  if (lower.startsWith('#bloquear') || lower.startsWith('!bloquear')) {
    const schedule = text.replace(/^[#!]bloquear\s*/i, '').trim();
    if (!schedule) {
      return '⚠️ Por favor indica qué horario o día deseas bloquear.\nEjemplo: *#bloquear viernes de 2pm a 5pm* o *#bloquear mañana todo el día*';
    }

    await supabase.from('knowledge_base').insert({
      business_id: business.id,
      title: `🔒 BLOQUEO DE AGENDA: ${schedule}`,
      content: `HORARIO BLOQUEADO: "${schedule}". El negocio NO ATENDERÁ ni recibirá citas en esa franja de tiempo por motivos de descanso o mantenimiento. Si un cliente solicita turno en ese horario, indícale amablemente que está ocupado y ofrece alternativas.`,
      content_type: sanitizeContentType('custom'),
      is_active: true,
    });

    return `🔒 *Horario bloqueado con éxito:*\n"${schedule}" quedó registrado.\n\nEl bot no otorgará citas en ese rango y ofrecerá otras horas disponibles.`;
  }

  // 6. #portal o #web o #app — Enlace al Portal Web Privado
  if (lower === '#portal' || lower === '!portal' || lower === '#web' || lower === '!web' || lower === '#app' || lower === '!app') {
    const baseUrl = process.env.RENDER_EXTERNAL_URL || 'https://chatflow-1dns.onrender.com';
    const portalUrl = `${baseUrl}/portal/${business.id}`;

    return `📱 *PORTAL PRIVADO DE GESTIÓN — ${business.name.toUpperCase()}*\n━━━━━━━━━━━━━━━━━━━━━\nAquí tienes el acceso a tu Web App Móvil para gestionar tu negocio desde tu celular:\n\n🔗 *Acceso Directo:*\n${portalUrl}\n\n✨ *Desde tu portal puedes:*\n• 📅 Ver tus citas en vivo y exportar a Excel.\n• 📦 Apagar productos agotados con un solo toque.\n• 🖨️ Ver e imprimir tu Stand QR de mostrador.\n• ⚙️ Modificar tus precios, horarios y nombre del bot.\n\n💡 _Tip: Abre el enlace en tu navegador móvil y selecciona "Agregar a pantalla de inicio" para tenerlo como una app en tu teléfono._`;
  }

  // 7. #nivel o #rango — Sistema de Niveles y Gamificación tipo Cashea
  if (lower === '#nivel' || lower === '!nivel' || lower === '#rango' || lower === '!rango' || lower === '#puntos' || lower === '!puntos') {
    // Determinar nivel actual desde subscription_tier o notas
    const tierMatch = (business.notes || '').match(/\[nivel:(\d)\]/i) || (business.subscription_tier || '').match(/(\d)/);
    let levelNum = tierMatch ? parseInt(tierMatch[1], 10) : 2; // Por defecto Nivel 2 para suscriptores activos
    if (levelNum < 1) levelNum = 1;
    if (levelNum > 6) levelNum = 6;

    const levelsInfo = {
      1: {
        name: 'Barber Rookie 🥉',
        msgs: '500 msgs/mes',
        perks: ['🤖 Recepcionista 24/7 activo', '💵 Comando #caja diario', '📖 Libro Maestro 67 Páginas'],
        nextReq: '1 mes consecutivo puntual o 30 citas agendadas',
        nextLevel: 'Nivel 2 (Barber Pro) con +150 mensajes extra/mes'
      },
      2: {
        name: 'Barber Pro 🥈',
        msgs: '650 msgs/mes (+150 extra)',
        perks: ['🤖 Recepcionista 24/7 activo', '💵 Comando #caja y #resumen', '🎁 +150 mensajes extra cada mes gratis', '📊 Reporte de rendimiento semanal'],
        nextReq: '2 meses consecutivos puntual o 80 citas confirmadas',
        nextLevel: 'Nivel 3 (Barber Master) con +300 mensajes extra y detector de horas muertas'
      },
      3: {
        name: 'Barber Master 🥇',
        msgs: '800 msgs/mes (+300 extra)',
        perks: ['🤖 Recepcionista 24/7 activo', '🎁 +300 mensajes extra cada mes gratis', '📉 Alerta semanal de horas muertas para lanzar promos', '⚡ Respuesta ultra rápida prioritaria'],
        nextReq: '3 meses consecutivos puntual o 1 barbero colega referido',
        nextLevel: 'Nivel 4 (Elite Barber) con Multi-Barbero (2 sillas en el mismo bot)'
      },
      4: {
        name: 'Elite Barber 💈',
        msgs: '1,000 msgs/mes (+500 extra)',
        perks: ['🤖 Soporte Multi-Silla (hasta 2 barberos en el mismo bot)', '🎁 +500 mensajes extra gratis', '📊 Métricas separadas por barbero en #caja', '⭐ Insignia Elite en reportes'],
        nextReq: '5 meses consecutivos puntual o 2 referidos activos',
        nextLevel: 'Nivel 5 (Barber Leyenda) con Tarifa Lealtad ($25/mes en vez de $29)'
      },
      5: {
        name: 'Barber Leyenda 👑',
        msgs: '1,500 msgs/mes (+1,000 extra)',
        perks: ['💰 Tarifa Lealtad protegida: $25/mes (en vez de $29/mes)', '🎁 +1,000 mensajes extra gratis', '💈 Soporte hasta 3 barberos en el mismo bot', '🚀 Soporte técnico VIP prioritario'],
        nextReq: '6 meses impecables sin mora o 3 referidos activos',
        nextLevel: 'Nivel 6 (Barber Black / Diamond) con Mensajes ILIMITADOS y Tarifa $22/mes'
      },
      6: {
        name: 'Barber Black / Diamond 💎',
        msgs: 'ILIMITADOS (Fair Use 3,000 msgs)',
        perks: ['💎 Tarifa Dorada Inmortal: $22/mes de por vida', '🚀 Mensajes ILIMITADOS de WhatsApp', '💈 Multi-Barbero completo para toda la barbería (hasta 5 sillas)', '👑 Insignia Diamante Oficial en cada corte de caja', '🛡️ Inmunidad de 10 días de gracia en pagos'],
        nextReq: '¡Felicidades! Has alcanzado la cima máxima de BarberPro AI.',
        nextLevel: 'Nivel Máximo Activo'
      }
    };

    const cur = levelsInfo[levelNum];
    const isOverdue = business.subscription_status === 'past_due' || business.subscription_status === 'overdue';

    return `🏆 *BARBERPRO CLUB — TU NIVEL DE BENEFICIOS*
━━━━━━━━━━━━━━━━━━━━━
💈 *Barbería:* ${business.name.toUpperCase()}
⭐ *Nivel Actual:* NIVEL ${levelNum} — *${cur.name}*
💬 *Cupo de Mensajes:* ${cur.msgs}

🎁 *TUS VENTAJAS ACTIVAS:*
${cur.perks.map(p => `• ${p}`).join('\n')}

🎯 *PRÓXIMO OBJETIVO:*
• *Meta:* ${cur.nextReq}
• *Desbloqueas:* ${cur.nextLevel}

⚖️ *ESTADO DE TU SUSCRIPCIÓN:*
• Estatus: ${isOverdue ? '⚠️ PAGO PENDIENTE (¡Riesgo de degradación de nivel!)' : '✅ AL DÍA Y ACTIVA'}
• Mensualidad: $${business.monthly_price || 29} USD / mes

⚠️ *REGLA DE PROTECCIÓN DE NIVEL:*
_• Retraso de 5 días: Pierdes 1 Nivel (-1 nivel)._
_• Retraso de 15 días: Pierdes 2 Niveles (-2 niveles) y el bot se pausa._
_¡Paga puntual para proteger tu racha y no perder tus beneficios acumulados!_
━━━━━━━━━━━━━━━━━━━━━
💡 _Escribe *#caja* para ver tus ingresos o *#ayuda* para más opciones._`;
  }

  // 8. #ayuda — Menú de comandos
  if (lower === '#ayuda' || lower === '!ayuda' || lower === '#menu' || lower === '!menu') {
    return `📱 *MENÚ DE CONTROL DIRECTO — DUEÑO*\n━━━━━━━━━━━━━━━━━━━━━\nPuedes controlar a tu bot y tus finanzas desde tu propio WhatsApp con estos comandos:\n\n• *#caja* o *#resumen* ➔ Corte de caja del día, ingresos en USD y métricas\n• *#nivel* ➔ Ver tu nivel de beneficios Cashea, ventajas y puntos acumulados\n• *#citas* ➔ Ver las próximas citas agendadas\n• *#bot* ➔ Reactivar bot si estaba en pausa\n• *#portal* ➔ Abrir tu Web App de gestión móvil\n• *#agotar <producto>* ➔ Marcar algo sin stock\n• *#disponible <producto>* ➔ Reactivar disponibilidad\n• *#bloquear <horario>* ➔ Bloquear horas de la agenda\n• *#ayuda* ➔ Ver este menú\n━━━━━━━━━━━━━━━━━━━━━\n_Solo tú (desde tu número de dueño registrado) puedes ejecutar estos comandos._`;
  }

  return null;
}
