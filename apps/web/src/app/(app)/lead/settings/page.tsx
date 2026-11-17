'use client';

import { useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  CATEGORIES,
  LIMITS,
  PRIORITY_RANK,
  UpdateSlaPoliciesSchema,
  UpsertCannedResponseSchema,
  type CannedResponse,
  type Category,
  type Priority,
  type SlaPolicy,
} from '@helpdesk/shared';
import type { z } from 'zod';
import { Button, Field, fieldErrorMessage, inputClass } from '@/components/ui';
import { api, ApiRequestError } from '@/lib/api';
import { useCanned, useMe } from '@/lib/queries';

type CannedFormValues = z.input<typeof UpsertCannedResponseSchema>;

function sortPolicies(list: readonly SlaPolicy[]): SlaPolicy[] {
  return [...list].sort((a, b) => PRIORITY_RANK[b.priority] - PRIORITY_RANK[a.priority]);
}

function SlaPoliciesSection({ enabled }: { enabled: boolean }) {
  const t = useTranslations();
  const qc = useQueryClient();
  const [draft, setDraft] = useState<SlaPolicy[]>([]);
  const [validationErr, setValidationErr] = useState<string | null>(null);
  const [savedNotice, setSavedNotice] = useState(false);

  const policiesQuery = useQuery({
    queryKey: ['sla-policies'],
    queryFn: () => api<SlaPolicy[]>('/sla-policies'),
    enabled,
  });

  useEffect(() => {
    if (policiesQuery.data) {
      setDraft(sortPolicies(policiesQuery.data));
    }
  }, [policiesQuery.data]);

  const save = useMutation({
    mutationFn: (policies: SlaPolicy[]) =>
      api<SlaPolicy[]>('/sla-policies', { method: 'PUT', json: { policies } }),
    onSuccess: (updated) => {
      qc.setQueryData(['sla-policies'], updated);
      setDraft(sortPolicies(updated));
      setValidationErr(null);
      setSavedNotice(true);
    },
  });

  const updateField = (
    priority: Priority,
    field: 'firstResponseMinutes' | 'resolutionMinutes',
    raw: string,
  ) => {
    const n = Number(raw);
    setSavedNotice(false);
    setValidationErr(null);
    setDraft((prev) =>
      prev.map((p) =>
        p.priority === priority ? { ...p, [field]: Number.isFinite(n) ? n : 0 } : p,
      ),
    );
  };

  const handleSubmit = (e: React.SyntheticEvent) => {
    e.preventDefault();
    setSavedNotice(false);
    const parsed = UpdateSlaPoliciesSchema.safeParse({ policies: draft });
    if (!parsed.success) {
      const hasOrderProblem = draft.some((p) => p.resolutionMinutes < p.firstResponseMinutes);
      setValidationErr(hasOrderProblem ? t('lead.slaInvalidOrder') : t('errors.invalid'));
      return;
    }
    setValidationErr(null);
    save.mutate(parsed.data.policies);
  };

  return (
    <section
      aria-labelledby="sla-policies-heading"
      className="space-y-4 rounded-md border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <div>
        <h2 id="sla-policies-heading" className="text-lg font-semibold">
          {t('lead.slaPolicies')}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t('lead.slaHint')}</p>
      </div>

      {policiesQuery.isPending ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">{t('common.loading')}</p>
      ) : (
        <form noValidate onSubmit={handleSubmit} className="space-y-4">
          <div className="overflow-x-auto">
            <table className="w-full border-collapse text-left text-sm">
              <thead>
                <tr className="border-b border-slate-300 dark:border-slate-700">
                  <th scope="col" className="py-2 pr-4 font-semibold">
                    {t('ticket.priority')}
                  </th>
                  <th scope="col" className="px-4 py-2 font-semibold">
                    {t('lead.firstResponseMinutes')}
                  </th>
                  <th scope="col" className="pl-4 py-2 font-semibold">
                    {t('lead.resolutionMinutes')}
                  </th>
                </tr>
              </thead>
              <tbody>
                {draft.map((policy) => {
                  const pLabel = t(`priority.${policy.priority}`);
                  return (
                    <tr
                      key={policy.priority}
                      data-testid={`sla-row-${policy.priority}`}
                      className="border-b border-slate-200 last:border-b-0 dark:border-slate-800"
                    >
                      <td className="py-2 pr-4 font-medium">{pLabel}</td>
                      <td className="px-4 py-2">
                        <label htmlFor={`sla-first-${policy.priority}`} className="sr-only">
                          {pLabel} — {t('lead.firstResponseMinutes')}
                        </label>
                        <input
                          id={`sla-first-${policy.priority}`}
                          type="number"
                          min={1}
                          max={60 * 24 * 30}
                          className={`${inputClass} !w-32`}
                          value={policy.firstResponseMinutes}
                          onChange={(e) => {
                            updateField(policy.priority, 'firstResponseMinutes', e.target.value);
                          }}
                        />
                      </td>
                      <td className="py-2 pl-4">
                        <label htmlFor={`sla-res-${policy.priority}`} className="sr-only">
                          {pLabel} — {t('lead.resolutionMinutes')}
                        </label>
                        <input
                          id={`sla-res-${policy.priority}`}
                          type="number"
                          min={1}
                          max={60 * 24 * 90}
                          className={`${inputClass} !w-32`}
                          value={policy.resolutionMinutes}
                          onChange={(e) => {
                            updateField(policy.priority, 'resolutionMinutes', e.target.value);
                          }}
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>

          {validationErr ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {validationErr}
            </p>
          ) : null}

          {save.isError ? (
            <p role="alert" className="text-sm text-red-700 dark:text-red-400">
              {save.error instanceof ApiRequestError
                ? save.error.message
                : t('common.genericError')}
            </p>
          ) : null}

          <div className="flex items-center gap-3">
            <Button type="submit" variant="primary" disabled={save.isPending || draft.length === 0}>
              {t('common.save')}
            </Button>
            {savedNotice ? (
              <span role="status" className="text-sm text-emerald-700 dark:text-emerald-400">
                {t('lead.saved')}
              </span>
            ) : null}
          </div>
        </form>
      )}
    </section>
  );
}

function CannedResponsesSection({ enabled }: { enabled: boolean }) {
  const t = useTranslations();
  const qc = useQueryClient();
  const cannedQuery = useCanned(enabled);
  const [editingId, setEditingId] = useState<string | null>(null);
  const titleRef = useRef<HTMLInputElement | null>(null);

  const {
    register,
    handleSubmit,
    reset,
    formState: { errors },
  } = useForm<CannedFormValues>({
    resolver: zodResolver(UpsertCannedResponseSchema),
    defaultValues: { title: '', body: '', category: null },
  });

  const { ref: titleRegisterRef, ...titleRegisterRest } = register('title');

  const upsert = useMutation({
    mutationFn: (values: CannedFormValues) => {
      const payload = {
        title: values.title,
        body: values.body,
        category: values.category || null,
      };
      if (editingId) {
        return api<CannedResponse>(`/canned-responses/${editingId}`, {
          method: 'PUT',
          json: payload,
        });
      }
      return api<CannedResponse>('/canned-responses', { method: 'POST', json: payload });
    },
    onSuccess: () => {
      void qc.invalidateQueries({ queryKey: ['canned'] });
      setEditingId(null);
      reset({ title: '', body: '', category: null });
    },
  });

  const remove = useMutation({
    mutationFn: (id: string) => api(`/canned-responses/${id}`, { method: 'DELETE' }),
    onSuccess: (_data, id) => {
      void qc.invalidateQueries({ queryKey: ['canned'] });
      if (editingId === id) {
        setEditingId(null);
        reset({ title: '', body: '', category: null });
      }
    },
  });

  const startEdit = (item: CannedResponse) => {
    setEditingId(item.id);
    reset({ title: item.title, body: item.body, category: item.category });
    titleRef.current?.focus();
  };

  const cancelEdit = () => {
    setEditingId(null);
    reset({ title: '', body: '', category: null });
  };

  const items = cannedQuery.data ?? [];

  return (
    <section
      aria-labelledby="canned-heading"
      className="space-y-4 rounded-md border border-slate-300 bg-white p-4 dark:border-slate-700 dark:bg-slate-900"
    >
      <div>
        <h2 id="canned-heading" className="text-lg font-semibold">
          {t('lead.canned')}
        </h2>
        <p className="mt-1 text-sm text-slate-600 dark:text-slate-400">{t('lead.cannedHint')}</p>
      </div>

      <form
        noValidate
        className="space-y-3 rounded-md border border-slate-200 p-3 dark:border-slate-800"
        onSubmit={(e) => {
          void handleSubmit((values) => {
            upsert.mutate(values);
          })(e);
        }}
      >
        <div className="grid gap-3 sm:grid-cols-2">
          <Field
            id="canned-title"
            label={t('lead.cannedTitle')}
            error={fieldErrorMessage(t, errors.title, LIMITS.cannedTitleMax)}
          >
            {(props) => (
              <input
                {...props}
                {...titleRegisterRest}
                ref={(el) => {
                  titleRegisterRef(el);
                  titleRef.current = el;
                }}
                maxLength={LIMITS.cannedTitleMax}
                className={inputClass}
              />
            )}
          </Field>

          <Field id="canned-category" label={t('lead.cannedCategory')}>
            {(props) => {
              const reg = register('category', {
                setValueAs: (v: string): Category | null => (v ? (v as Category) : null),
              });
              return (
                <select {...props} {...reg} className={inputClass}>
                  <option value="">{t('queue.allCategories')}</option>
                  {CATEGORIES.map((c) => (
                    <option key={c} value={c}>
                      {t(`category.${c}`)}
                    </option>
                  ))}
                </select>
              );
            }}
          </Field>
        </div>

        <Field
          id="canned-body"
          label={t('lead.cannedBody')}
          error={fieldErrorMessage(t, errors.body, LIMITS.cannedBodyMax)}
        >
          {(props) => (
            <textarea
              {...props}
              rows={3}
              maxLength={LIMITS.cannedBodyMax}
              className={inputClass}
              {...register('body')}
            />
          )}
        </Field>

        {upsert.isError ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {upsert.error instanceof ApiRequestError
              ? upsert.error.message
              : t('common.genericError')}
          </p>
        ) : null}

        <div className="flex gap-2">
          <Button type="submit" variant="primary" disabled={upsert.isPending}>
            {editingId ? t('common.save') : t('lead.add')}
          </Button>
          {editingId ? <Button onClick={cancelEdit}>{t('common.cancel')}</Button> : null}
        </div>
      </form>

      {remove.isError ? (
        <p role="alert" className="text-sm text-red-700 dark:text-red-400">
          {remove.error instanceof ApiRequestError
            ? remove.error.message
            : t('common.genericError')}
        </p>
      ) : null}

      {cannedQuery.isPending ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">{t('common.loading')}</p>
      ) : items.length === 0 ? (
        <p className="text-sm text-slate-600 dark:text-slate-400">{t('lead.cannedEmpty')}</p>
      ) : (
        <ul className="space-y-2">
          {items.map((item) => (
            <li
              key={item.id}
              data-testid="canned-item"
              className="flex flex-wrap items-start justify-between gap-3 rounded-md border border-slate-200 p-3 dark:border-slate-800"
            >
              <div className="min-w-0 flex-1 space-y-1">
                <div className="flex flex-wrap items-center gap-2">
                  <span className="font-medium">{item.title}</span>
                  <span className="rounded bg-slate-200 px-2 py-0.5 text-xs text-slate-800 dark:bg-slate-700 dark:text-slate-100">
                    {item.category ? t(`category.${item.category}`) : t('queue.allCategories')}
                  </span>
                </div>
                <p className="whitespace-pre-wrap text-sm text-slate-700 dark:text-slate-300">
                  {item.body}
                </p>
              </div>
              <div className="flex gap-2">
                <Button
                  onClick={() => {
                    startEdit(item);
                  }}
                >
                  {t('lead.cannedEdit')}
                </Button>
                <Button
                  variant="danger"
                  disabled={remove.isPending}
                  onClick={() => {
                    remove.mutate(item.id);
                  }}
                >
                  {t('common.delete')}
                </Button>
              </div>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

export default function LeadSettingsPage() {
  const t = useTranslations('lead');
  const router = useRouter();
  const { data: me } = useMe();

  useEffect(() => {
    if (me && me.role !== 'lead') {
      router.replace(me.role === 'customer' ? '/tickets' : '/queue');
    }
  }, [me, router]);

  const isLead = me?.role === 'lead';
  if (me && !isLead) return null;

  return (
    <div className="space-y-6">
      <h1 className="text-2xl font-semibold">{t('settings')}</h1>
      <SlaPoliciesSection enabled={isLead} />
      <CannedResponsesSection enabled={isLead} />
    </div>
  );
}
