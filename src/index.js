import 'dotenv/config';
import express from 'express';
import webhookRouter from './routes/webhook.js';
import portalRouter from './routes/portal.js';
import { logger } from './utils/logger.js';

const app  = express();
const PORT = process.env.PORT || 3000;

// Raw body para validación HMAC de Meta (debe ir ANTES del json middleware)
app.use('/webhook', express.raw({ type: 'application/json' }));
app.use(express.json());

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
