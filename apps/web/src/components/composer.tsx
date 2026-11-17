'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  LIMITS,
  TYPING_THROTTLE_MS,
  TYPING_TTL_MS,
  renderCannedResponse,
  type CreateMessageResponse,
  type Me,
  type Ticket,
  type TicketDetail,
} from '@helpdesk/shared';
import { api, isNetworkError } from '@/lib/api';
import { clearDraft, draftKey, loadDraft, saveDraft } from '@/lib/drafts';
import { useCanned } from '@/lib/queries';
import { appendMessage, replaceTicket } from '@/lib/ticket-cache';
import type { TypingInfo } from '@/lib/use-event-stream';
import { AttachmentUploader, useUploads } from './attachments';
import { Button, inputClass } from './ui';

export type ComposerMode = 'reply' | 'note';

interface Draft {
  body: string;
  mode: ComposerMode;
  /** Generated once per draft and reused by every retry: the server de-duplicates on it. */
  clientMessageId: string;
}

const isDraft = (v: unknown): v is Draft =>
  typeof v === 'object' &&
  v !== null &&
  typeof (v as Draft).body === 'string' &&
  ((v as Draft).mode === 'reply' || (v as Draft).mode === 'note') &&
  typeof (v as Draft).clientMessageId === 'string';

const freshDraft = (mode: ComposerMode = 'reply'): Draft => ({
  body: '',
  mode,
  clientMessageId: crypto.randomUUID(),
});

interface SendVars {
  clientMessageId: string;
  body: string;
  internal: boolean;
  attachmentIds: string[];
  followUp?: 'pending' | 'resolved';
}

function TypingIndicator({ ticketId }: { ticketId: string }) {
  const t = useTranslations('composer');
  const { data } = useQuery<TypingInfo | null>({
    queryKey: ['typing', ticketId],
    queryFn: () => Promise.resolve(null),
    staleTime: Infinity,
  });
  const [, tick] = useState(0);
  useEffect(() => {
    const id = setInterval(() => {
      tick((n) => n + 1);
    }, 1000);
    return () => {
      clearInterval(id);
    };
  }, []);
  if (!data || Date.now() - data.at > TYPING_TTL_MS) return null;
  return (
    <p
      data-testid="typing-indicator"
      className="text-sm italic text-slate-700 dark:text-slate-300"
      aria-live="polite"
    >
      {t('someoneTyping', { name: data.name })}
    </p>
  );
}

export function Composer({ ticket, me }: { ticket: Ticket; me: Me }) {
  const t = useTranslations('composer');
  const router = useRouter();
  const qc = useQueryClient();
  const staff = me.role !== 'customer';
  const key = draftKey(me.id, ticket.id);
  const uploads = useUploads();
  const [draft, setDraft] = useState<Draft | null>(null);
  const loadedFor = useRef<string | null>(null);
  const bodyRef = useRef<HTMLTextAreaElement>(null);
  const lastTyping = useRef(0);
  const { data: canned } = useCanned(staff);

  // Load the saved draft for this ticket (also after a page reload).
  useEffect(() => {
    if (loadedFor.current === key) return;
    loadedFor.current = key;
    setDraft(loadDraft(key, isDraft) ?? freshDraft());
  }, [key]);

  // Debounced autosave; an empty draft is removed.
  useEffect(() => {
    if (!draft) return;
    const timer = setTimeout(() => {
      if (draft.body.trim() === '') clearDraft(key);
      else saveDraft(key, draft);
    }, 300);
    return () => {
      clearTimeout(timer);
    };
  }, [draft, key]);

  const send = useMutation({
    mutationFn: (vars: SendVars) =>
      api<CreateMessageResponse>(`/tickets/${ticket.id}/messages`, { method: 'POST', json: vars }),
    // Only failures that never reached the server are retried, with the same clientMessageId.
    retry: (count, err) => isNetworkError(err) && count < 3,
    retryDelay: 400,
    onSuccess: (resp) => {
      clearDraft(key);
      setDraft((d) => freshDraft(d?.mode ?? 'reply'));
      uploads.reset();
      if (resp.newTicketId) {
        void qc.invalidateQueries({ queryKey: ['tickets'] });
        router.push(`/tickets/${resp.newTicketId}`);
        return;
      }
      qc.setQueryData<TicketDetail>(['ticket', ticket.id], (d) =>
        replaceTicket(appendMessage(d, resp.message), resp.ticket),
      );
      void qc.invalidateQueries({ queryKey: ['tickets'], refetchType: 'none' });
      requestAnimationFrame(() => {
        bodyRef.current?.focus();
      });
    },
  });

  if (!draft) return null;
  const closed = ticket.status === 'closed';
  if (closed && staff) {
    return <p className="text-sm text-slate-700 dark:text-slate-300">{ticket.status}</p>;
  }
  const note = staff && draft.mode === 'note';
  const canSend = draft.body.trim() !== '' && !send.isPending && !uploads.busy;

  const submit = (followUp?: 'pending' | 'resolved') => {
    if (!canSend) return;
    send.mutate({
      clientMessageId: draft.clientMessageId,
      body: draft.body,
      internal: note,
      attachmentIds: uploads.ids,
      ...(followUp && !note ? { followUp } : {}),
    });
  };

  const onType = (body: string) => {
    setDraft({ ...draft, body });
    if (staff && Date.now() - lastTyping.current > TYPING_THROTTLE_MS) {
      lastTyping.current = Date.now();
      void api(`/tickets/${ticket.id}/typing`, { method: 'POST' }).catch(() => undefined);
    }
  };

  return (
    <form
      aria-label={t('label')}
      data-mode={draft.mode}
      onSubmit={(e) => {
        e.preventDefault();
        submit();
      }}
      className={`space-y-3 rounded-md border-2 p-3 ${
        note
          ? 'border-amber-600 bg-amber-50 dark:border-amber-500 dark:bg-amber-950'
          : 'border-blue-600 bg-white dark:border-blue-500 dark:bg-slate-900'
      }`}
    >
      {staff ? <TypingIndicator ticketId={ticket.id} /> : null}
      {staff ? (
        <div role="group" aria-label={t('modeGroup')} className="flex gap-2">
          {(['reply', 'note'] as const).map((m) => (
            <Button
              key={m}
              variant={draft.mode === m ? 'primary' : 'secondary'}
              aria-pressed={draft.mode === m}
              onClick={() => {
                setDraft({ ...draft, mode: m });
              }}
            >
              {m === 'reply' ? t('modeReply') : t('modeNote')}
            </Button>
          ))}
          {canned && canned.length > 0 ? (
            <>
              <label htmlFor="canned-select" className="sr-only">
                {t('canned')}
              </label>
              <select
                id="canned-select"
                className={`${inputClass} !w-auto`}
                value=""
                onChange={(e) => {
                  const c = canned.find((x) => x.id === e.target.value);
                  if (!c) return;
                  const text = renderCannedResponse(c.body, {
                    customerName: ticket.customer.name,
                    ticketNumber: `HD-${ticket.number}`,
                    agentName: me.name,
                  });
                  setDraft({ ...draft, body: draft.body ? `${draft.body}\n${text}` : text });
                }}
              >
                <option value="">{t('cannedNone')}</option>
                {canned.map((c) => (
                  <option key={c.id} value={c.id}>
                    {c.title}
                  </option>
                ))}
              </select>
            </>
          ) : null}
        </div>
      ) : null}
      {staff ? (
        <p
          className={`text-sm font-medium ${note ? 'text-amber-900 dark:text-amber-200' : 'text-blue-900 dark:text-blue-200'}`}
        >
          {note ? t('warningNote') : t('warningReply')}
        </p>
      ) : null}
      <div>
        <label htmlFor="composer-body" className="sr-only">
          {t('label')}
        </label>
        <textarea
          ref={bodyRef}
          id="composer-body"
          rows={5}
          className={inputClass}
          maxLength={LIMITS.messageBodyMax}
          placeholder={note ? t('placeholderNote') : t('placeholderReply')}
          value={draft.body}
          onChange={(e) => {
            onType(e.target.value);
          }}
          onKeyDown={(e) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 'Enter') {
              e.preventDefault();
              submit();
            }
          }}
        />
        <p className="text-xs text-slate-600 dark:text-slate-400">{t('shortcutHint')}</p>
      </div>
      <AttachmentUploader uploads={uploads} label={t('label')} />
      {send.isError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {t('sendFailed')}
        </p>
      ) : null}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" variant={note ? 'secondary' : 'primary'} disabled={!canSend}>
          {send.isPending
            ? t('sending')
            : note
              ? t('addNote')
              : staff
                ? t('sendReply')
                : t('sendReply')}
        </Button>
        {staff && !note ? (
          <>
            <Button
              disabled={!canSend}
              onClick={() => {
                submit('pending');
              }}
            >
              {t('sendWait')}
            </Button>
            <Button
              disabled={!canSend}
              onClick={() => {
                submit('resolved');
              }}
            >
              {t('sendResolve')}
            </Button>
          </>
        ) : null}
      </div>
    </form>
  );
}
