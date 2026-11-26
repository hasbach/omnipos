import { db } from '../db.js';
import { sessionHasPermission } from '../permissions.js';
import { askAssistant } from './claude.js';
import { AssistantError } from './tools.js';

export function setupAssistantRoutes(app: any, authenticate: any) {
  app.post('/api/assistant/ask', authenticate, async (req: any, res: any) => {
    if (!sessionHasPermission(req, 'assistant.use')) return res.status(403).json({ error: 'PERMISSION_DENIED' });
    try {
      const tenant = req.session.tenantId;
      const key = db.prepare("SELECT value FROM local_tenant_settings WHERE tenant_id = ? AND key = 'anthropic_api_key'").get(tenant) as any;
      const setting = db.prepare("SELECT value FROM settings WHERE tenant_id = ? AND key = 'language'").get(tenant) as any;
      const language = ['en', 'ar', 'fr'].includes(req.body?.language) ? req.body.language : setting?.value || 'en';
      res.json(await askAssistant(tenant, key?.value || '', req.body?.question, req.body?.history, language));
    } catch (e) {
      const error = e instanceof AssistantError ? e : new AssistantError('assistant_failed', 500);
      res.status(error.status).json({ error: error.code, code: error.code });
    }
  });
}
