import { Router } from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import { supabase } from '../services/supabase.js';
import { inferBotPersona } from '../services/openai.js';
import { evaluateAnomalies } from '../services/anomalyFilter.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const router = Router();

// Servir la interfaz HTML
router.get('/portal/:businessId', (req, res) => {
  res.sendFile(join(__dirname, '..', '..', 'public', 'portal.html'));
});

// GET /api/portal/:businessId — Datos completos del negocio
router.get('/api/portal/:businessId', async (req, res) => {
  try {
    const { businessId } = req.params;

    const { data: business, error: bizErr } = await supabase
      .from('businesses')
      .select('*')
      .eq('id', businessId)
      .single();

    if (bizErr || !business) {
      return res.status(404).json({ error: 'Negocio no encontrado' });
    }

    const persona = inferBotPersona(business.niche, business.bot_name, business.bot_gender, business.notes);
    const finalGender = business.bot_gender || persona.gender;
    const avatar = finalGender === 'female' ? '👩' : (finalGender === 'male' ? '👨' : '🤖');

    const { data: appts } = await supabase
      .from('appointments')
      .select('*, contacts(id, full_name, phone)')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    const { data: knowledge } = await supabase
      .from('knowledge_base')
      .select('*')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    const allAppts = appts || [];
    const confirmedCount = allAppts.filter(a => a.status === 'confirmed').length;
    const completedCount = allAppts.filter(a => a.status === 'completed').length;
    const cancelledCount = allAppts.filter(a => a.status === 'cancelled').length;

    let estimatedRevenue = 0;
    allAppts.forEach(a => {
      const priceMatch = (a.notes || a.service_name || '').match(/\$\s*(\d+)/);
      if (priceMatch) estimatedRevenue += parseInt(priceMatch[1]);
    });

    const pendingAnomalies = (knowledge || []).filter(k => k.content_type === 'anomaly_review');

    res.json({
      business: {
        ...business,
        bot_name: business.bot_name || persona.name,
        bot_gender: finalGender,
        bot_avatar: avatar,
      },
      appointments: allAppts,
      knowledge: knowledge || [],
      metrics: {
        total_appointments: allAppts.length,
        confirmed_appointments: confirmedCount,
        completed_appointments: completedCount,
        cancelled_appointments: cancelledCount,
        estimated_revenue_usd: estimatedRevenue,
        pending_anomalies: pendingAnomalies.length,
      }
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/portal/:businessId/export — Descargar reporte CSV de citas
router.get('/api/portal/:businessId/export', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { data: biz } = await supabase.from('businesses').select('name').eq('id', businessId).single();
    const { data: appts, error } = await supabase
      .from('appointments')
      .select('*, contacts(full_name, phone)')
      .eq('business_id', businessId)
      .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });

    const safeBizName = (biz?.name || 'citas').replace(/[^a-zA-Z0-9_-]/g, '_');
    let csv = '\uFEFFTicket,Cliente,Teléfono,Servicio,Estado,Detalle / Horario,Fecha Creación\r\n';
    (appts || []).forEach(a => {
      const ticket = `"${(a.idempotency_key || a.id || '').replace(/"/g, '""')}"`;
      const clientName = `"${(a.contacts?.full_name || a.notes?.match(/Cliente:\s*([^|]+)/i)?.[1]?.trim() || 'Cliente').replace(/"/g, '""')}"`;
      const clientPhone = `"+${(a.contacts?.phone || '').replace(/\D/g, '')}"`;
      const service = `"${(a.service_name || 'General').replace(/"/g, '""')}"`;
      const status = `"${(a.status || 'confirmed').replace(/"/g, '""')}"`;
      const notes = `"${(a.notes || '').replace(/"/g, '""')}"`;
      const date = a.created_at ? new Date(a.created_at).toLocaleString('es-ES') : '-';
      csv += `${ticket},${clientName},${clientPhone},${service},${status},${notes},${date}\r\n`;
    });

    res.setHeader('Content-Type', 'text/csv; charset=utf-8');
    res.setHeader('Content-Disposition', `attachment; filename="reporte_citas_${safeBizName}.csv"`);
    res.send(csv);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// PATCH /api/portal/:businessId/appointments/:id
router.patch('/api/portal/:businessId/appointments/:id', async (req, res) => {
  try {
    const { businessId, id } = req.params;
    const { status } = req.body;

    const { data, error } = await supabase
      .from('appointments')
      .update({ status })
      .eq('id', id)
      .eq('business_id', businessId)
      .select()
      .single();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/portal/:businessId/stock/toggle
router.post('/api/portal/:businessId/stock/toggle', async (req, res) => {
  try {
    const { businessId } = req.params;
    const { item_name, is_currently_out } = req.body;

    if (is_currently_out) {
      const { data: matches } = await supabase
        .from('knowledge_base')
        .select('id')
        .eq('business_id', businessId)
        .ilike('title', '%AGOTADO%')
        .ilike('title', `%${item_name}%`);

      if (matches && matches.length > 0) {
        await supabase.from('knowledge_base').delete().in('id', matches.map(m => m.id));
      }
      return res.json({ ok: true, status: 'available' });
    } else {
      const title = `⚠️ AGOTADO: ${item_name}`;
      const content = `El producto o servicio "${item_name}" se encuentra temporalmente AGOTADO o NO DISPONIBLE. Detalle: Marcado desde el Portal Web. REGLA OBLIGATORIA: No ofrecerlo ni reservarlo; explicar con amabilidad que no hay stock y sugerir alternativas.`;

      const { data, error } = await supabase.from('knowledge_base').insert({
        business_id: businessId,
        title,
        content,
        content_type: 'custom',
        is_active: true
      }).select().single();

      if (error) return res.status(500).json({ error: error.message });
      return res.json({ ok: true, status: 'out_of_stock', data });
    }
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/portal/:businessId/profile
router.post('/api/portal/:businessId/profile', async (req, res) => {
  try {
    const { businessId } = req.params;
    const {
      name, address, business_hours, bot_name, bot_gender,
      services_text, policies, owner_phone
    } = req.body;

    const { data: currentBiz } = await supabase
      .from('businesses')
      .select('*, knowledge_base(content)')
      .eq('id', businessId)
      .single();

    if (!currentBiz) return res.status(404).json({ error: 'Negocio no encontrado' });

    const totalKnowledgeLen = (currentBiz.knowledge_base || []).map(k => k.content).join('').length;

    const evaluation = evaluateAnomalies(
      { name, address, business_hours, bot_name, bot_gender, services_text, policies, owner_phone },
      { ...currentBiz, knowledge_base_length: totalKnowledgeLen }
    );

    if (evaluation.isAnomaly) {
      console.warn(`🚨 [ANOMALIA DETECTADA] en negocio ${currentBiz.name}:`, evaluation.reasons);

      const anomalyPayload = {
        updates: { name, address, business_hours, bot_name, bot_gender, services_text, policies, owner_phone },
        reasons: evaluation.reasons,
        flags: evaluation.flags,
        business_name: currentBiz.name,
        submitted_at: new Date().toISOString()
      };

      await supabase.from('knowledge_base').insert({
        business_id: businessId,
        title: `🚨 Revisión requerida: Cambios inusuales detectados`,
        content: JSON.stringify(anomalyPayload),
        content_type: 'custom',
        is_active: false
      });

      return res.json({
        ok: true,
        anomaly: true,
        reasons: evaluation.reasons,
        message: 'Detectamos detalles inusuales en la información enviada. Por seguridad, tus cambios fueron enviados a validación por el administrador y se aplicarán en breve.'
      });
    }

    const updates = {};
    if (name) updates.name = name;
    if (address !== undefined) updates.address = address;
    if (business_hours) updates.business_hours = business_hours;
    if (bot_name) updates.bot_name = bot_name;
    if (bot_gender) updates.bot_gender = bot_gender;
    if (policies !== undefined) updates.policies = policies;
    if (owner_phone) updates.owner_phone = owner_phone;

    let { error: updateErr } = await supabase
      .from('businesses')
      .update(updates)
      .eq('id', businessId);

    if (updateErr && updateErr.message.includes('bot_')) {
      delete updates.bot_name;
      delete updates.bot_gender;
      await supabase.from('businesses').update(updates).eq('id', businessId);
    }

    if (services_text && services_text.trim()) {
      const { data: existingKb } = await supabase
        .from('knowledge_base')
        .select('id')
        .eq('business_id', businessId)
        .in('content_type', ['services', 'prices'])
        .limit(1);

      if (existingKb && existingKb.length > 0) {
        await supabase
          .from('knowledge_base')
          .update({
            title: 'Menú de Servicios y Precios Actualizado',
            content: services_text.trim(),
            updated_at: new Date().toISOString()
          })
          .eq('id', existingKb[0].id);
      } else {
        await supabase
          .from('knowledge_base')
          .insert({
            business_id: businessId,
            title: 'Menú de Servicios y Precios Actualizado',
            content: services_text.trim(),
            content_type: 'services',
            is_active: true
          });
      }
    }

    res.json({
      ok: true,
      anomaly: false,
      message: '¡Excelente! Los datos de tu negocio y la memoria de tu bot fueron actualizados con éxito en tiempo real. 🎉'
    });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
