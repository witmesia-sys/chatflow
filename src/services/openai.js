/**
 * Servicio de IA usando Google Gemini API (SDK oficial).
 * Gemini 1.5 Flash: 1 millón de tokens gratis por día, sin restricciones geo.
 * El servidor corre en EEUU (Render), así que no hay bloqueo desde Venezuela.
 */
import { GoogleGenerativeAI } from '@google/generative-ai';
import { getKnowledgeBase, getUpcomingAppointments, saveMessage, logUsage, supabase } from './supabase.js';
import { sendWhatsAppMessage, sendWhatsAppImage } from './whatsapp.js';
import { checkCalendarAvailability, createCalendarEvent } from './calendar.js';
import { logger } from '../utils/logger.js';

const genAI  = new GoogleGenerativeAI(process.env.GEMINI_API_KEY ?? '');

// gemini-3.5-flash-lite responde en ~600ms (sub-segundo).
// Ignoramos modelos pesados o experimentales como 3.8 que causan latencias de 3 minutos.
const envModel = process.env.AI_MODEL || '';
const PRIMARY_MODEL = (envModel.includes('3.8') || envModel.includes('exp') || !envModel)
  ? 'gemini-3.5-flash-lite'
  : envModel;
const FALLBACK_MODEL = 'gemini-3.5-flash';

// Timeout de seguridad de 15 segundos para garantizar respuestas completas sin cortes prematuros
function sendMessageWithTimeout(target, message, timeoutMs = 15000, isGenerateContent = false) {
  const timeout = new Promise((_, reject) =>
    setTimeout(() => reject(new Error('TIMEOUT_EXCEEDED')), timeoutMs)
  );
  const action = isGenerateContent ? target.generateContent(message) : target.sendMessage(message);
  return Promise.race([action, timeout]);
}

function isErrorOrFallbackMessage(content = '') {
  const c = (content || '').toLowerCase();
  return c.includes('inconveniente técnico') ||
         c.includes('retraso en mi señal') ||
         c.includes('breve retraso') ||
         c.includes('señal de red') ||
         c.includes('disculpa la demora');
}

/**
 * Sanitiza el historial para cumplir las reglas estrictas de Gemini API:
 * 1. Debe alternar estrictamente user -> model -> user -> model.
 * 2. Si hay mensajes consecutivos del mismo rol, los concatena.
 * 3. El primer mensaje debe ser 'user'.
 * 4. El último mensaje debe ser 'model' (antes de enviar el nuevo userText).
 * 5. Ignora respuestas de error o fallbacks anteriores para no contaminar el contexto.
 */
function sanitizeGeminiHistory(rawHistory) {
  const clean = [];
  let lastRole = null;
  for (const m of (rawHistory || [])) {
    if (!m.content || isErrorOrFallbackMessage(m.content)) continue;
    const role = m.role === 'assistant' ? 'model' : 'user';
    if (role === lastRole && clean.length > 0) {
      // Concatenar mensajes consecutivos del mismo rol
      clean[clean.length - 1].parts[0].text += '\n' + m.content;
      continue;
    }
    clean.push({ role, parts: [{ text: m.content }] });
    lastRole = role;
  }
  while (clean.length > 0 && clean[0].role !== 'user') clean.shift();
  while (clean.length > 0 && clean[clean.length - 1].role === 'user') clean.pop();
  return clean;
}

// Herramientas nativas de agendamiento, confirmación de pagos y catálogo visual
const BOOKING_TOOL = [{
  functionDeclarations: [
    {
      name: 'register_and_confirm_booking',
      description: 'Genera el comprobante/ticket oficial de la reserva y notifica al dueño del negocio cuando el cliente ya ha confirmado el servicio, su nombre y la hora acordada.',
      parameters: {
        type: 'OBJECT',
        properties: {
          client_name:   { type: 'STRING', description: 'Nombre completo o nombre del cliente' },
          service_name:  { type: 'STRING', description: 'Nombre del servicio solicitado (ej. Corte clásico, Degradado, etc.)' },
          price:         { type: 'STRING', description: 'Precio del servicio si se conoce (ej. $10)' },
          datetime_text: { type: 'STRING', description: 'Fecha y hora pactada (ej. Mañana a las 10:00 AM)' }
        },
        required: ['client_name', 'service_name', 'datetime_text']
      }
    },
    {
      name: 'notify_payment_transfer',
      description: 'Notifica al dueño del negocio y genera acuse de recibo cuando el cliente indica haber realizado el pago (Pago Móvil, Zelle, Transferencia, Binance) o envía el número de referencia bancaria para su validación.',
      parameters: {
        type: 'OBJECT',
        properties: {
          client_name:      { type: 'STRING', description: 'Nombre del cliente' },
          payment_method:   { type: 'STRING', description: 'Método utilizado (ej. Pago Móvil, Zelle, Transferencia, Binance, Efectivo)' },
          reference_number: { type: 'STRING', description: 'Número de referencia bancaria o datos del pago reportado' },
          amount_paid:      { type: 'STRING', description: 'Monto pagado si el cliente lo indicó (ej. $15 o Bs 750)' },
          product_name:     { type: 'STRING', description: 'Nombre del producto o servicio comprado' }
        },
        required: ['client_name', 'reference_number']
      }
    },
    {
      name: 'send_catalog_photo',
      description: 'Envía una foto de un producto, muestra, catálogo o trabajo previo al WhatsApp del cliente cuando este solicita ver fotos, modelos o el producto.',
      parameters: {
        type: 'OBJECT',
        properties: {
          product_name: { type: 'STRING', description: 'Nombre del producto, servicio o corte solicitado' },
          photo_url:    { type: 'STRING', description: 'URL de la foto encontrada en la base de conocimiento' },
          caption:      { type: 'STRING', description: 'Mensaje descriptivo que acompañará la foto' }
        },
        required: ['product_name']
      }
    }
  ]
}];

// Herramientas de Google Calendar (opcionales si GCal está configurado)
const TOOLS = [{
  functionDeclarations: [
    {
      name: 'check_availability',
      description: 'Consulta los próximos slots disponibles en Google Calendar del negocio',
      parameters: {
        type: 'OBJECT',
        properties: {
          service:        { type: 'STRING', description: 'Nombre del servicio solicitado' },
          preferred_date: { type: 'STRING', description: 'Fecha preferida ISO 8601 (opcional)' },
        },
        required: ['service'],
      },
    },
    {
      name: 'create_appointment',
      description: 'Crea una cita en Google Calendar y la registra en la base de datos',
      parameters: {
        type: 'OBJECT',
        properties: {
          contact_name:  { type: 'STRING', description: 'Nombre completo del cliente' },
          contact_phone: { type: 'STRING', description: 'Teléfono del cliente' },
          service:       { type: 'STRING', description: 'Nombre del servicio' },
          datetime_iso:  { type: 'STRING', description: 'Fecha y hora exacta en ISO 8601' },
        },
        required: ['contact_name', 'service', 'datetime_iso'],
      },
    },
  ],
}];

/**
 * Motor de Inferencia de Identidad y Personalidad:
 * Si el usuario configuró nombre/género, se respeta al 100%.
 * Si lo dejó vacío o en 'auto', se autogenera la mejor personalidad según el nicho.
 */
export function inferBotPersona(niche = '', customName = '', customGender = '', notes = '') {
  const n = (niche || '').toLowerCase();
  let cName = (customName || '').trim();
  let cGender = (customGender || '').trim().toLowerCase();

  // Si no se proporcionó nombre/género directo, intentar extraerlo del tag [bot:Nombre|genero] en notes
  if (!cName && notes) {
    const match = notes.match(/\[bot:([^|\]]+)(?:\|([^\]]+))?\]/i);
    if (match) {
      cName = match[1]?.trim() || '';
      if (!cGender || cGender === 'auto') {
        cGender = (match[2]?.trim() || 'neutral').toLowerCase();
      }
    }
  }

  // Caso 1: Nombre y género especificados por el dueño
  if (cName && cGender && cGender !== 'auto') {
    return {
      name: cName,
      gender: cGender,
      personality: cGender === 'female'
        ? 'Cálida, atenta, empática, profesional y muy detallista.'
        : 'Dinámico, atento, profesional, cercano y con excelente vibra.'
    };
  }

  // Caso 2: Solo dio nombre
  if (cName && (!cGender || cGender === 'auto')) {
    return {
      name: cName,
      gender: 'neutral',
      personality: 'Atento, profesional, dinámico y muy servicial.'
    };
  }

  // Caso 3: Autogeneración inteligente según el nicho del negocio
  if (n.includes('barber') || n.includes('afeit') || n.includes('corte hombre')) {
    return {
      name: 'Mateo',
      gender: (cGender && cGender !== 'auto') ? cGender : 'male',
      personality: 'Cercano, dinámico, con estilo urbano, buena vibra y energía fresca de barbería moderna 💈.'
    };
  }

  if (n.includes('spa') || n.includes('estetic') || n.includes('uña') || n.includes('ceja') || n.includes('pestaña') || n.includes('skincare')) {
    return {
      name: 'Camila',
      gender: (cGender && cGender !== 'auto') ? cGender : 'female',
      personality: 'Cálida, dulce, relajante y detallista con el bienestar y el cuidado personal 🌸.'
    };
  }

  if (n.includes('peluquer') || n.includes('salon') || n.includes('belleza') || n.includes('estilism')) {
    return {
      name: 'Sofía',
      gender: (cGender && cGender !== 'auto') ? cGender : 'female',
      personality: 'Amable, profesional, creativa y apasionada por el estilo, la moda y la imagen 💇‍♀️.'
    };
  }

  if (n.includes('dent') || n.includes('clinic') || n.includes('medic') || n.includes('salud') || n.includes('odontolog')) {
    return {
      name: 'Valeria',
      gender: (cGender && cGender !== 'auto') ? cGender : 'female',
      personality: 'Profesional, empática, tranquilizadora y muy formal con los pacientes 🩺.'
    };
  }

  if (n.includes('restaurant') || n.includes('cafe') || n.includes('comida') || n.includes('burger') || n.includes('pizza')) {
    return {
      name: 'Lucas',
      gender: (cGender && cGender !== 'auto') ? cGender : 'male',
      personality: 'Servicial, alegre, antojador y ágil para tomar reservas y recomendaciones 🍔.'
    };
  }

  if (n.includes('taller') || n.includes('mecanic') || n.includes('auto') || n.includes('carro') || n.includes('lavado')) {
    return {
      name: 'Carlos',
      gender: (cGender && cGender !== 'auto') ? cGender : 'male',
      personality: 'Directo, práctico, confiable y enfocado en soluciones rápidas y eficientes 🔧.'
    };
  }

  // Nicho genérico por defecto
  return {
    name: 'Alex',
    gender: (cGender && cGender !== 'auto') ? cGender : 'neutral',
    personality: 'Atento, eficiente, servicial, cálido y educado ✨.'
  };
}

function buildSystemPrompt(business, knowledgeChunks, upcomingAppointments = []) {
  const toneMap = {
    professional: 'Sé profesional, formal y preciso.',
    friendly:     'Sé amigable, cálido y usa emojis con moderación 😊.',
    sales:        'Sé persuasivo y orientado a la acción. Siempre invita a reservar.',
    formal:       'Sé formal, respetuoso y usa lenguaje de negocios.',
  };
  const tone      = toneMap[business.ai_tone] ?? toneMap.friendly;
  const knowledge = knowledgeChunks.length > 0
    ? knowledgeChunks.map(k => `[${k.content_type}] ${k.title ?? ''}: ${k.content}`).join('\n')
    : 'No hay información cargada aún. Pide al usuario que contacte directamente al negocio para más detalles.';

  const persona = inferBotPersona(business.niche, business.bot_name, business.bot_gender, business.notes);
  const genderTitle = persona.gender === 'female' ? 'la asistente virtual femenina oficial'
                    : persona.gender === 'male'   ? 'el asistente virtual masculino oficial'
                    : 'el asistente virtual oficial';

  const grammarGuide = persona.gender === 'female'
    ? 'Habla con concordancia femenina cuando te refieras a ti misma (ej. "estoy lista para ayudarte", "encantada de atenderte").'
    : persona.gender === 'male'
    ? 'Habla con concordancia masculina cuando te refieras a ti mismo (ej. "estoy listo para ayudarte", "encantado de atenderte").'
    : 'Habla en tono neutral y cordial.';

  const bookedSlotsSummary = (upcomingAppointments && upcomingAppointments.length > 0)
    ? upcomingAppointments.map(a => {
        const client = a.contacts?.full_name || 'Cliente';
        const notes = a.notes || '';
        return `• ${a.service_name} (${notes || 'Horario reservado'})`;
      }).join('\n')
    : 'No hay citas registradas recientemente en la agenda.';

  const n = (business.niche || '').toLowerCase();
  const notes = (business.notes || '').toLowerCase();
  const isSales = n.includes('venta') || n.includes('curso') || n.includes('tienda') || n.includes('infoproducto') || n.includes('ecommerce') || n.includes('comercio') || n.includes('ropa') || n.includes('zapato') || notes.includes('[mode:sales]');
  const isSupport = n.includes('soporte') || n.includes('atencion') || notes.includes('[mode:support]');

  let businessMission = '';
  let specificProtocol = '';

  if (isSales) {
    businessMission = 'Tu ÚNICO objetivo es ASESORAR, REBATIR OBJECIONES, REALIZAR LA DEMO EN VIVO Y CERRAR VENTAS del sistema BarberPro AI / ChatFlow (Recepcionista 24/7 + Contador de Bolsillo 100% WhatsApp Nativo por $29/mes). Nos apalancamos en barberías, pero el sistema sirve para CUALQUIER negocio (estéticas, spas, clínicas dentales, restaurantes, tiendas, talleres). Si escribe alguien de otro rubro, adáptate de inmediato y vende con ejemplos de su propio negocio. Sé persuasivo, empático y orientado a la conversión.';
    specificProtocol = `7. PROTOCOLO DE VENTAS, DEMO EN VIVO, OBJECIONES Y PAGO MÓVIL:
   - ENFOQUE DEL PRODUCTO (RECEPCIONISTA 24/7 + CONTADOR DE BOLSILLO EN WHATSAPP):
     • Explica que es 100% WhatsApp Nativo: tus clientes no abren páginas web lentas ni formularios; chatean y se agendan en 10 segundos.
     • Para el dueño es su Contador Personal en el bolsillo: le lleva el corte de caja del día y las cuentas de ingresos sin libretas de papel (con comando #caja).
   - REGLA DE ORO DEL PRECIO ($29/MES Y MOMENTO DE REVELACIÓN):
     • EL PRECIO REAL ES: Plan Fundador a solo $29 USD / mes (o su equivalente en Bs por Pago Móvil según tasa oficial). PROHIBIDO cobrar $49.99/mes. Si mencionas $49, solo puede ser como valor regular de mercado para anclar el descuento ("su valor regular es de $49/mes, pero hoy solo pagas $29/mes").
     • MOMENTO OBLIGATORIO DE DAR EL PRECIO:
       * NUNCA des el precio en el primer mensaje de bienvenida o cuando el prospecto solo pide información general (ej: "Buenas", "Me da información", "¿De qué trata?", "Hola"). Si das el precio de entrada, el cliente lo juzga como un gasto antes de ver el valor y se pone a la defensiva diciendo que "está caro".
       * En el primer mensaje, enfócate 100% en el dolor y la solución: atiende clientes en WhatsApp 24/7 sin que pierda ventas mientras corta o descansa, y le lleva su contador de caja (#caja). Invítalo de inmediato a ver la demo en vivo.
       * EL PRECIO SE ENTREGA ÚNICAMENTE EN DOS CASOS:
         1. Si el cliente PREGUNTA EXPLÍCITAMENTE por el precio (ej: "¿Cuánto cuesta?", "¿Qué precio tiene?", "¿Cuánto sale?"): Respóndele de inmediato con la oferta de $29/mes.
         2. AL FINALIZAR LA PRESENTACIÓN O TRAS LA DEMO EN VIVO: Cuando el cliente ya vio el valor y se emitió el ticket formal, ahí revelas la oferta ganadora del Plan Fundador a solo $29 USD / mes con el Libro Maestro de regalo.
   - VENTA ADAPTATIVA MULTI-NICHO (CUALQUIER NEGOCIO):
     • Si el prospecto menciona que tiene otro negocio (ej. salón de belleza, estética, uñas, spa, clínica dental, consultorio médico, restaurante, delivery, taller mecánico, autolavado, tienda de ropa, gimnasio) o pregunta "¿sirve para mi negocio?":
       * NUNCA digas que es solo para barberías ni limites la venta.
       * Responde con simpatía y total seguridad: "¡Totalmente, crack! Aunque nos ves en redes con barberías, nuestro sistema está optimizado para CUALQUIER negocio que reciba citas, pedidos o consultas de clientes por WhatsApp (estéticas, dentistas, restaurantes, tiendas y talleres)."
       * Explícale el beneficio exacto para su nicho:
         - Estéticas / Spas / Uñas: "Tus clientas agendan sus turnos de uñas, cejas o masajes 24/7 con la especialista que elijan, y el bot te hace el corte de caja diario por servicio."
         - Clínicas Dentales / Médicos / Salud: "Tus pacientes confirman o agendan su turno médico sin que tengas que pausar tu consulta para atender el teléfono, reduciendo ausencias a cero."
         - Restaurantes / Comida / Delivery: "Tus clientes ven el menú en el chat, seleccionan platos, el bot suma la cuenta y toma los datos de entrega sin páginas web complicadas."
         - Tiendas / Ropa / Comercios: "Muestra fotos, precios, tallas disponibles y toma pedidos directos en WhatsApp."
         - Talleres / Autolavados: "Agenda turnos de mantenimiento, cambios de aceite y revisiones con fecha y hora exacta."
       * Invítalo a hacer la demo con su rubro y ofrécele el mismo Plan Fundador a solo $29 USD/mes con entrega 100% configurado en 24 horas.
   - TÉCNICA DE CONTROL DE TERRENO Y DEMO EN VIVO (EL PUENTE DE OPINIÓN):
     • Sea cual sea el negocio que mencione el cliente (panaderías, talleres, tiendas, fábricas, o cualquier negocio diferente, poco común o cuando pida "hazme un ejemplo con mi negocio"):
       * NUNCA te compliques intentando inventar catálogos complejos, recetas o listas de precios de productos desconocidos.
       * Valida su negocio con entusiasmo y carisma, y guíalo de inmediato a NUESTRO TERRENO usando la técnica del Puente de Opinión:
         "¡Oye, qué negocio tan interesante! De hecho, nuestro sistema se entrega 100% configurado y personalizado para tus propios productos o servicios en menos de 24 horas. Pero para que pongas a prueba mi velocidad real y se lo puedas mostrar a tus amigos o socios para que te den una opinión y puntuación sobre mí, hagamos la prueba en vivo con un ejemplo claro que todos conocen: una reserva de turno express.
         Escríbeme tú mismo aquí como si fueras un cliente: 'Quiero un turno para mañana a las 4pm' y mira cómo te respondo al segundo y te emito tu comprobante 😉"
     • Cuando el cliente escriba cualquier mensaje simulando pedir turno o cita:
       * Atiéndelo como el recepcionista estrella de su local, responde sus dudas y EN EL INSTANTE en que tengas fecha y hora, DEBES EJECUTAR INMEDIATAMENTE la herramienta "register_and_confirm_booking" para emitir el ticket formal de demostración.
       * Al emitir el ticket de la demo, concluye con el puente de venta:
         "¿Viste qué rápido y limpio? 🔥 En 10 segundos tu cliente quedó agendado con su ticket. Y esa cita ya se sumó a tu corte de caja para que sepas al centavo cuánto facturaste sin tocar una libreta. Esto mismo hace con los clientes de tu negocio. Su valor regular es de $49/mes, pero hoy para los primeros 50 negocios tenemos el Plan Fundador a solo $29 USD / mes con el Libro Maestro de regalo de bienvenida y entrega listo en 24h. ¿Te gustaría activarlo hoy mismo?"
   - MANEJO DE OBJECIONES:
     • Si el cliente insiste en ver el ejemplo exactamente con su propio negocio: Explica con profesionalismo y autoridad: "¡Totalmente comprensible, hermano! Mira cómo funciona la Inteligencia Artificial: para que tu bot atienda a tus clientes reales con precisión exacta (sin inventar precios falsos ni cometer errores), nosotros le cargamos a tu asistente la información detallada que tú mismo nos entregas (tus productos, precios, horarios, cuentas de pago y reglas del local). Por eso, al activar tu Plan Fundador ($29/mes), te pedimos esos datos y en menos de 24 horas tu bot queda 100% calibrado para tu propio negocio. Para que compruebes cómo responde con datos reales y exactos ya cargados, haz la prueba aquí mismo: pregúntame '¿Qué precios tienes?' o simula pedir un turno escribiendo 'Quiero agendar para mañana' y mira la exactitud 😉"
     • Si dice que "está caro ($29)": Explica la matemática simple de su negocio: con solo 2 o 3 clientes o servicios que el bot rescate al mes de gente que escribe de noche o mientras estás ocupado, el sistema y el contador se pagan totalmente solos. Todo lo demás es ganancia neta y descanso para ti.
     • Si dice "no sé de tecnología / no tengo PC": "Cero computadoras, hermano. Todo funciona 100% en la nube y lo manejas desde tu mismo teléfono celular. Además nosotros te lo entregamos 100% listo y configurado en 24 horas."
     • Si dice "lo voy a pensar" o "te aviso luego": Pregunta amablemente: "¿Hay alguna duda puntual sobre la configuración o la entrega que te gustaría aclarar antes? Recuerda que el cupo del Plan Fundador a $29/mes con los bonos de bienvenida está reservado para los primeros 50 negocios."
     • Si pide el libro gratis antes de pagar: Explica con simpatía que el Libro Maestro es el bono de bienvenida exclusivo que se desbloquea de inmediato en cuanto active su suscripción.
   - PAGO MÓVIL Y DATOS BANCARIOS:
     • Cuando el cliente decida comprar o pida los datos, entrégale los datos de pago (Pago Móvil / Zelle / Binance) claros y ordenados de la base de conocimiento.
     • Pide SIEMPRE: "Una vez realizado el pago, por favor envíame por aquí la captura de pantalla o el número de referencia bancaria para validar tu acreditación, enviarte de inmediato tu bono de regalo de 67 páginas y poner en marcha la configuración de tu bot y contador de caja."
     • En cuanto el cliente escriba el número de referencia o confirme la transferencia, DEBES EJECUTAR INMEDIATAMENTE la herramienta "notify_payment_transfer" con los datos de la venta.`;
  } else if (isSupport) {
    businessMission = 'Tu misión primordial es escuchar con empatía, responder dudas con precisión, calificar necesidades y orientar al cliente hacia la mejor solución.';
    specificProtocol = `7. PROTOCOLO DE ATENCIÓN Y CALIFICACIÓN:
   - Escucha activamente la situación del cliente. Haz preguntas clave para entender su requerimiento.
   - Si requiere atención personalizada especializada, sugiérele contactar a un asesor escribiendo "humano".`;
  } else {
    businessMission = 'Tu misión primordial es guiar al cliente a resolver dudas y AGENDAR SU CITA o turno en los horarios disponibles.';
    specificProtocol = `7. PROTOCOLO DE AGENDAMIENTO Y EMISIÓN DE TICKET:
   - Cuando el cliente indique que quiere reservar o mencione un día u hora (ej. "mañana a las 10am"), valida que no choque con las citas ocupadas y pregúntale su nombre si aún no lo sabes.
   - En el instante en que tengas: 1) El servicio elegido, 2) La fecha y hora pactada, y 3) El nombre del cliente, DEBES EJECUTAR INMEDIATAMENTE la herramienta "register_and_confirm_booking" con esos datos para emitir el ticket formal y alertar al dueño.`;
  }

  return `Eres ${persona.name}, ${genderTitle} de "${business.name}".
PERSONALIDAD: ${persona.personality}
${grammarGuide}
IDENTIDAD: Si el cliente te pregunta tu nombre o quién eres, preséntate con simpatía y orgullo: "¡Hola! Soy ${persona.name}, asistente de ${business.name} 😊".

Tu misión: responder de forma CONCISA, natural y humana (máximo 2 a 3 frases, estilo WhatsApp).
${businessMission}

TONO: ${tone}

BASE DE CONOCIMIENTO (SERVICIOS, PRECIOS, STOCK, CUENTAS DE PAGO Y NOVEDADES):
${knowledge}

CITAS Y TURNOS YA RESERVADOS EN LA AGENDA (HORARIOS OCUPADOS):
${bookedSlotsSummary}

HORARIO DE ATENCIÓN: ${JSON.stringify(business.business_hours ?? 'Lunes a Sábado de 9:00 am a 8:00 pm')}
ZONA HORARIA: ${business.timezone}

REGLAS ESTRICTAS DE CONVERSACIÓN:
1. NO REPETIR SALUDOS: Si la conversación ya empezó o el cliente ya saludó antes, NUNCA vuelvas a decir "¡Hola!", "Buen día" ni "Buenas noches". Ve directo a responder lo que pide.
2. DISPONIBILIDAD DE HORARIOS: Si el cliente pide un día u hora que coincide con los turnos reservados arriba, indícale amablemente: "Ese turno específico ya se encuentra reservado, pero con gusto te puedo agendar a las [proponer horas disponibles]" dentro del horario de atención.
3. PRODUCTOS Y SERVICIOS AGOTADOS: Si en la base de conocimiento algún servicio o producto aparece listado como AGOTADO o NO DISPONIBLE, NO permitas reservarlo ni comprarlo; explica amablemente que está agotado por el momento y sugiere la mejor opción alterna.
4. CERO INVENTOS DE PRECIOS O DATOS BANCARIOS: Si preguntan por un precio o cuenta no registrada en la base de conocimiento, responde: "Prefiero comunicarte con un asesor para darte esa cotización exacta." No inventes precios ni números de cuenta.
5. DOMAIN LOCK: Si preguntan por temas ajenos al negocio, responde con ingenio breve y regresa al objetivo.
6. BREVEDAD: Máximo 2 o 3 frases por mensaje. Estilo WhatsApp ágil.
${specificProtocol}
8. REGLA SUPREMA DE REENCAMINAMIENTO CONVERSACIONAL (BRIDGE BACK):
   - PROHIBIDO TERMINANTEMENTE DECIR "estoy en mantenimiento", "inconveniente técnico", "no puedo ayudarte con eso" o sonar como un robot descompuesto.
   - Si el cliente hace preguntas fuera del tema, comentarios cotidianos, preguntas curiosas o se sale del carril: responde con amabilidad, ingenio y una pizca de carisma o sentido común breve (1 frase), y DE INMEDIATO TIENDE UN PUENTE CONVERSACIONAL para volver a la conversación de valor/venta/cita.
     • Ejemplo: "¡Jaja totalmente de acuerdo! 😄 Y hablando de avanzar, ¿te gustaría que te pase los datos para aprovechar la promo de hoy?"
     • Ejemplo: "¡Qué buen punto! Por cierto, ¿qué horario te vendría mejor para agendarte esta semana?"
9. FOTOS Y MUESTRAS DEL CATÁLOGO:
   - Si el cliente pide fotos, muestras o ver el producto ("tienes fotos?", "cómo es el modelo?", "puedo ver muestras?"):
   - Si en la base de conocimiento hay referencias de fotos (ej. [📸 FOTO_PRODUCTO: ...]), ejecuta la herramienta "send_catalog_photo" para enviarle la foto directamente a su WhatsApp o compártele el enlace con entusiasmo.`;
}

export async function handleIncomingMessage({ business, contact, conversation, userText, waMessageId }) {
  const n = (business.niche || '').toLowerCase();
  const notes = (business.notes || '').toLowerCase();
  const isSales = n.includes('venta') || n.includes('curso') || n.includes('tienda') || n.includes('infoproducto') || n.includes('ecommerce') || n.includes('comercio') || n.includes('ropa') || n.includes('zapato') || notes.includes('[mode:sales]');

  await saveMessage({
    conversationId: conversation.id,
    businessId:     business.id,
    role:           'user',
    content:        userText,
    waMessageId,
  });

  const [knowledgeChunks, upcomingAppointments] = await Promise.all([
    getKnowledgeBase(business.id),
    getUpcomingAppointments(business.id)
  ]);
  const systemPrompt    = buildSystemPrompt(business, knowledgeChunks, upcomingAppointments);
  const geminiHistory   = sanitizeGeminiHistory((conversation.context_window ?? []).slice(-10));

  let response    = null;
  let totalTokens = 0;

  const isGCalActive = process.env.GOOGLE_CLIENT_ID && process.env.GOOGLE_CLIENT_ID !== 'PENDIENTE';
  const activeTools  = isGCalActive ? [...TOOLS, ...BOOKING_TOOL] : BOOKING_TOOL;

  try {
    let modelInstance = genAI.getGenerativeModel({
      model:             PRIMARY_MODEL,
      systemInstruction: systemPrompt,
      tools:             activeTools,
    });

    let chat = modelInstance.startChat({ history: geminiHistory });
    let result;
    try {
      result = await sendMessageWithTimeout(chat, userText, 14000);
    } catch (modelErr) {
      logger.warn(`Llamada en chat demoró o falló (${modelErr.message}). Reintentando con llamada directa y fallback...`);
      const directModel = genAI.getGenerativeModel({
        model:             PRIMARY_MODEL,
        systemInstruction: systemPrompt,
      });
      const fallbackPrompt = geminiHistory.length > 0
        ? `Historial reciente:\n${geminiHistory.map(h => `${h.role}: ${h.parts[0]?.text || ''}`).join('\n')}\n\nCliente: ${userText}`
        : userText;
      result = await sendMessageWithTimeout(directModel, fallbackPrompt, 15000, true);
    }
    const resp = result.response;

    totalTokens = resp.usageMetadata?.totalTokenCount ?? 0;

    // Verificar si hay function calls
    const fnCall = resp.functionCalls()?.[0];

    if (fnCall) {
      logger.info(`Tool call: ${fnCall.name}`, fnCall.args);
      let toolResult = {};

      if (fnCall.name === 'register_and_confirm_booking') {
        const { client_name, service_name, price, datetime_text } = fnCall.args;
        const ticketCode = 'CF-' + Math.floor(1000 + Math.random() * 9000);
        const persona = inferBotPersona(business.niche, business.bot_name, business.bot_gender, business.notes);

        // 1. Comprobante digital para el cliente
        const customerTicket = `🎟️ *COMPROBANTE DE RESERVA #${ticketCode}*
━━━━━━━━━━━━━━━━━━━━━
💈 *Negocio:* ${business.name}
🤖 *Atendido por:* ${persona.name}
✂️ *Servicio:* ${service_name} ${price ? `(${price})` : ''}
📅 *Fecha/Hora:* ${datetime_text}
👤 *Cliente:* ${client_name}
📍 *Lugar:* ${business.address ?? 'C.C. Las Estrellas, Local 4'}
━━━━━━━━━━━━━━━━━━━━━
⚠️ _Tolerancia de 15 minutos. Si necesitas cancelar o reprogramar, avísanos por este chat._`;

        // 2. Alerta inmediata al WhatsApp del dueño
        const ownerAlert = `🔔 *¡NUEVA CITA REGISTRADA POR ${persona.name.toUpperCase()}!*
━━━━━━━━━━━━━━━━━━━━━
💈 *Negocio:* ${business.name}
👤 *Cliente:* ${client_name}
📱 *WhatsApp Cliente:* +${contact.phone}
✂️ *Servicio:* ${service_name} ${price ? `(${price})` : ''}
⏰ *Fecha y Hora:* ${datetime_text}
🎟️ *Ticket:* #${ticketCode}
━━━━━━━━━━━━━━━━━━━━━
_Notificación enviada automáticamente a tu WhatsApp_`;

        if (business.owner_phone) {
          const cleanOwner = String(business.owner_phone).replace(/\D/g, '');
          try {
            await sendWhatsAppMessage(business, cleanOwner, ownerAlert);
            logger.info(`Alerta enviada al dueño: ${cleanOwner}`);
          } catch (e) {
            logger.warn(`No se pudo enviar alerta al dueño: ${e.message}`);
          }
        }

        // 3. Registrar en Supabase
        try {
          const appointmentNotes = `Cliente: ${client_name} | Horario: ${datetime_text} | Precio: ${price || 'N/A'}`;
          await supabase.rpc('create_appointment', {
            p_business_id:     business.id,
            p_contact_id:      contact.id,
            p_service_name:    service_name,
            p_start_time:      new Date().toISOString(),
            p_end_time:        new Date(Date.now() + 3600000).toISOString(),
            p_gcal_event_id:   null,
            p_idempotency_key: `booking-${ticketCode}-${Date.now()}`,
            p_notes:           appointmentNotes,
          });
          if (client_name) {
            await supabase.from('contacts').update({ full_name: client_name }).eq('id', contact.id);
          }
        } catch (e) {
          logger.warn(`Error registrando cita en DB: ${e.message}`);
        }

        // 4. Respuesta directa al cliente con el ticket oficial (sin latencia de segundo llamado a Gemini)
        response = `¡Listo, ${client_name}! ${persona.name} ha confirmado tu cita con éxito. 🎉\n\n${customerTicket}`;
      } else if (fnCall.name === 'notify_payment_transfer') {
        const { client_name, payment_method, reference_number, amount_paid, product_name } = fnCall.args;

        // 1. Alerta inmediata al WhatsApp del dueño
        const ownerPaymentAlert = `💰 *¡NUEVO PAGO REPORTADO POR CLIENTE!*
━━━━━━━━━━━━━━━━━━━━━
🏪 *Negocio:* ${business.name}
👤 *Cliente:* ${client_name || contact.full_name || 'Cliente'}
📱 *WhatsApp Cliente:* +${contact.phone}
💳 *Método:* ${payment_method || 'Pago Móvil / Transferencia'}
🔢 *Referencia:* ${reference_number}
💵 *Monto:* ${amount_paid || 'Monto acordado'}
📦 *Producto/Servicio:* ${product_name || 'Venta'}
━━━━━━━━━━━━━━━━━━━━━
_Verifica en tu cuenta bancaria y envía el producto o acceso al cliente._`;

        if (business.owner_phone) {
          const cleanOwner = String(business.owner_phone).replace(/\D/g, '');
          try {
            await sendWhatsAppMessage(business, cleanOwner, ownerPaymentAlert);
            logger.info(`Alerta de pago enviada al dueño: ${cleanOwner}`);
          } catch (e) {
            logger.warn(`No se pudo enviar alerta de pago al dueño: ${e.message}`);
          }
        }

        // 2. Respuesta directa al cliente
        response = `¡Excelente, ${client_name || 'amigo(a)'}! 🎉 He registrado tu referencia de pago *#${reference_number}*.\n\nNuestro equipo está verificando la acreditación en el banco en este momento. En breve te confirmamos la entrega o acceso formal. ¡Muchas gracias por tu compra! 🙌`;
      } else if (fnCall.name === 'send_catalog_photo') {
        const { product_name, photo_url, caption } = fnCall.args;
        if (photo_url) {
          try {
            await sendWhatsAppImage(business, contact.phone, photo_url, caption || `Aquí tienes la foto de: ${product_name} 📸`);
            response = caption || `¡Con gusto! Acabo de enviarte la foto de *${product_name}* 📸. ¿Qué te parece?`;
          } catch (imgErr) {
            response = `Aquí tienes la imagen de *${product_name}*: ${photo_url} 📸. ¿Te gustaría apartar el tuyo?`;
          }
        } else {
          response = `Con gusto te muestro más detalles sobre *${product_name}*. ¿Hay algún modelo o característica específica que desees ver? 😊`;
        }
      } else if (fnCall.name === 'check_availability') {
        toolResult = await checkCalendarAvailability(business, fnCall.args.service, fnCall.args.preferred_date);
        const followUp = await chat.sendMessage([{
          functionResponse: { name: fnCall.name, response: { name: fnCall.name, content: toolResult } },
        }]);
        response     = followUp.response.text();
        totalTokens += followUp.response.usageMetadata?.totalTokenCount ?? 0;
      } else if (fnCall.name === 'create_appointment') {
        toolResult = await createCalendarEvent(business, contact, fnCall.args);
        const followUp = await chat.sendMessage([{
          functionResponse: { name: fnCall.name, response: { name: fnCall.name, content: toolResult } },
        }]);
        response     = followUp.response.text();
        totalTokens += followUp.response.usageMetadata?.totalTokenCount ?? 0;
      }
    } else {
      response = resp.text();
    }
  } catch (err) {
    logger.error('Error en Gemini AI:', err.message);
    if (isSales) {
      response = '¡Hola! Disculpa la demora, estaba atendiendo otra consulta. Con respecto a lo que me comentas, ¿te gustaría que te pase los detalles de la promo o cómo lo adaptamos a tu negocio directamente? 😊';
    } else {
      response = '¡Hola! Disculpa, hubo un breve retraso en la conexión. ¿Me comentas en qué te puedo colaborar o qué horario te gustaría consultar? 😊';
    }
  }

  await saveMessage({
    conversationId: conversation.id,
    businessId:     business.id,
    role:           'assistant',
    content:        response,
  });

  await logUsage(business.id, 'ai_call', totalTokens);
  return response;
}
