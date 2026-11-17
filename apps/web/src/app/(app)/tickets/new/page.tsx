'use client';

import { useEffect, useRef } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import {
  CATEGORIES,
  CUSTOMER_PRIORITIES,
  CreateTicketSchema,
  LIMITS,
  type Ticket,
} from '@helpdesk/shared';
import { type z } from 'zod';
import { AttachmentUploader, useUploads } from '@/components/attachments';
import { Button, Field, fieldErrorMessage, inputClass } from '@/components/ui';
import { api } from '@/lib/api';
import { clearDraft, draftKey, loadDraft, saveDraft } from '@/lib/drafts';
import { useMe } from '@/lib/queries';

const FormSchema = CreateTicketSchema.omit({ attachmentIds: true });
type FormValues = z.input<typeof FormSchema>;

const isFormValues = (v: unknown): v is FormValues => typeof v === 'object' && v !== null;

const EMPTY: FormValues = { subject: '', category: 'other', priority: 'normal', body: '' };

export default function NewTicketPage() {
  const t = useTranslations();
  const router = useRouter();
  const qc = useQueryClient();
  const { data: me } = useMe();
  const uploads = useUploads();
  const {
    register,
    handleSubmit,
    reset,
    watch,
    formState: { errors },
  } = useForm<FormValues>({ resolver: zodResolver(FormSchema), defaultValues: EMPTY });

  // Restore the draft once per user, then autosave (debounced) on every change.
  const key = me ? draftKey(me.id, 'new') : null;
  const restored = useRef(false);
  useEffect(() => {
    if (!key || restored.current) return;
    restored.current = true;
    const draft = loadDraft(key, isFormValues);
    if (draft) reset({ ...EMPTY, ...draft });
  }, [key, reset]);

  useEffect(() => {
    if (!key) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const sub = watch((values) => {
      clearTimeout(timer);
      timer = setTimeout(() => {
        saveDraft(key, values);
      }, 300);
    });
    return () => {
      clearTimeout(timer);
      sub.unsubscribe();
    };
  }, [key, watch]);

  const create = useMutation({
    mutationFn: (values: FormValues) =>
      api<Ticket>('/tickets', { method: 'POST', json: { ...values, attachmentIds: uploads.ids } }),
    onSuccess: (ticket) => {
      if (key) clearDraft(key);
      void qc.invalidateQueries({ queryKey: ['tickets'] });
      router.push(`/tickets/${ticket.id}`);
    },
  });

  return (
    <div className="max-w-2xl">
      <h1 className="mb-4 text-2xl font-semibold">{t('newTicket.title')}</h1>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          void handleSubmit((v) => {
            create.mutate(v);
          })(e);
        }}
      >
        <Field
          id="subject"
          label={t('newTicket.subject')}
          error={fieldErrorMessage(t, errors.subject, LIMITS.subjectMax)}
        >
          {(p) => (
            <input
              {...p}
              className={inputClass}
              maxLength={LIMITS.subjectMax + 50}
              {...register('subject')}
            />
          )}
        </Field>
        <div className="grid gap-4 sm:grid-cols-2">
          <Field
            id="category"
            label={t('newTicket.category')}
            error={fieldErrorMessage(t, errors.category)}
          >
            {(p) => (
              <select {...p} className={inputClass} {...register('category')}>
                {CATEGORIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`category.${c}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
          <Field
            id="priority"
            label={t('newTicket.priority')}
            error={fieldErrorMessage(t, errors.priority)}
          >
            {(p) => (
              <select {...p} className={inputClass} {...register('priority')}>
                {CUSTOMER_PRIORITIES.map((c) => (
                  <option key={c} value={c}>
                    {t(`priority.${c}`)}
                  </option>
                ))}
              </select>
            )}
          </Field>
        </div>
        <Field
          id="body"
          label={t('newTicket.body')}
          error={fieldErrorMessage(t, errors.body, LIMITS.messageBodyMax)}
        >
          {(p) => <textarea {...p} rows={6} className={inputClass} {...register('body')} />}
        </Field>
        <AttachmentUploader uploads={uploads} label={t('newTicket.attachments')} />
        {create.isError ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {t('common.genericError')}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={create.isPending || uploads.busy}>
          {t('newTicket.submit')}
        </Button>
      </form>
    </div>
  );
}
