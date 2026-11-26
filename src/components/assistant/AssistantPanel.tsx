import React, { useEffect, useRef, useState } from 'react';
import { Button, Drawer, Textarea } from '../ui';
import { useI18n } from '../../intl/index';
import { usePermissions } from '../../lib/usePermissions';

interface Message { role: 'user' | 'assistant'; content: string; tool_calls?: unknown[] }
export function AssistantPanel() {
  const { t, lang, dir } = useI18n();
  const { can, ready, user } = usePermissions();
  const [open, setOpen] = useState(false);
  const [question, setQuestion] = useState('');
  const [messages, setMessages] = useState<Message[]>([]);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const generation = useRef(0);
  const allowed = ready && can('assistant.use');
  useEffect(() => {
    generation.current++;
    setOpen(false);
    setMessages([]);
    setQuestion('');
    setError('');
    setBusy(false);
  }, [user?.id, allowed]);
  if (!allowed) return null;
  async function ask(event: React.FormEvent) {
    event.preventDefault();
    if (!question.trim() || busy) return;
    if (!navigator.onLine) { setError('assistant_needs_internet'); return; }
    const content = question.trim();
    const requestGeneration = generation.current;
    setBusy(true);
    setError('');
    try {
      const response = await fetch('/api/assistant/ask', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ question: content, language: lang, history: messages.slice(-20).map(({ role, content }) => ({ role, content })) }),
      });
      const data = await response.json();
      if (requestGeneration !== generation.current) return;
      if (!response.ok) throw new Error(data.code || 'assistant_failed');
      setMessages(previous => [...previous, { role: 'user', content }, { role: 'assistant', content: data.answer, tool_calls: data.tool_calls }]);
      setQuestion('');
    } catch (e) {
      if (requestGeneration !== generation.current) return;
      const code = e instanceof Error ? e.message : '';
      setError(['assistant_no_key', 'assistant_needs_internet', 'assistant_key_rejected', 'assistant_provider_error', 'assistant_loop_limit', 'assistant_invalid_question'].includes(code) ? code : 'assistant_failed');
    } finally { if (requestGeneration === generation.current) setBusy(false); }
  }
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => setOpen(true)}
      >
        {t('assistant_title')}
      </Button>
      <Drawer
        open={open}
        onClose={() => setOpen(false)}
        title={t('assistant_title')}
      >
        <div dir={dir} className="flex h-full flex-col gap-4">
          <p className="text-sm text-text-3">{t('assistant_intro')}</p>
          <div className="flex-1 space-y-4 overflow-auto" aria-live="polite">
            {messages.map((message, index) => (
              <div
                key={index}
                className={`rounded-xl p-3 text-sm ${message.role === 'user' ? 'ms-8 bg-primary/10' : 'me-8 bg-surface-2'}`}
              >
                <p className="whitespace-pre-wrap" dir="auto">{message.content}</p>
                {!!message.tool_calls?.length && (
                  <details className="mt-3">
                    <summary className="cursor-pointer">{t('assistant_numbers')}</summary>
                    <pre dir="ltr" className="mt-2 overflow-auto whitespace-pre-wrap text-xs">{JSON.stringify(message.tool_calls, null, 2)}</pre>
                  </details>
                )}
              </div>
            ))}
          </div>
          {error && <p role="alert" className="text-sm text-danger">{t(error)}</p>}
          <form onSubmit={ask} className="space-y-3">
            <Textarea
              value={question}
              onChange={event => setQuestion(event.target.value)}
              maxLength={4000}
              aria-label={t('assistant_question')}
              placeholder={t('assistant_question')}
              disabled={busy}
            />
            <Button
              type="submit"
              disabled={busy || !question.trim()}
            >
              {t(busy ? 'assistant_thinking' : 'assistant_send')}
            </Button>
          </form>
        </div>
      </Drawer>
    </>
  );
}
