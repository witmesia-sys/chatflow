import 'dotenv/config';
import express from 'express';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';
import webhookRouter from './routes/webhook.js';
import portalRouter from './routes/portal.js';
import { logger } from './utils/logger.js';

const __dirname = dirname(fileURLToPath(import.meta.url));
const app  = express();
const PORT = process.env.PORT || 3000;

// Servir archivos estáticos (incluye carpeta public/uploads para imágenes de catálogo)
app.use(express.static(join(__dirname, '..', 'public')));

// Raw body para validación HMAC de Meta (debe ir ANTES del json middleware)
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json({ limit: '25mb' }));

app.use('/webhook', webhookRouter);
app.use('/', portalRouter);

app.get('/health', (_, res) => res.json({
  status: 'ok',
  ts: new Date().toISOString(),
  env: {
    supabase:  !!process.env.SUPABASE_URL,
    openai:    !!process.env.OPENAI_API_KEY,
    whatsapp:  !!process.env.WHATSAPP_ACCESS_TOKEN,
  }
}));

app.listen(PORT, () => {
  logger.info(`ChatFlow AI Webhook corriendo en http://localhost:${PORT}`);
  logger.info(`Health check: http://localhost:${PORT}/health`);
});
