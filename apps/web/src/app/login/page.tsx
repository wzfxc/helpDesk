'use client';

import { useRouter } from 'next/navigation';
import { useTranslations } from 'next-intl';
import { useForm } from 'react-hook-form';
import { zodResolver } from '@hookform/resolvers/zod';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { LoginRequestSchema, type LoginRequest, type Me } from '@helpdesk/shared';
import { api, ApiRequestError } from '@/lib/api';
import { Button, Field, fieldErrorMessage, inputClass } from '@/components/ui';

export default function LoginPage() {
  const t = useTranslations();
  const router = useRouter();
  const qc = useQueryClient();
  const {
    register,
    handleSubmit,
    formState: { errors },
  } = useForm<LoginRequest>({ resolver: zodResolver(LoginRequestSchema), mode: 'onSubmit' });

  const login = useMutation({
    mutationFn: (body: LoginRequest) => api<Me>('/auth/login', { method: 'POST', json: body }),
    onSuccess: (me) => {
      qc.setQueryData(['me'], me);
      router.replace('/');
    },
  });

  const serverError =
    login.error instanceof ApiRequestError
      ? login.error.status === 429
        ? t('auth.rateLimited', { seconds: login.error.retryAfter ?? 60 })
        : t('auth.invalidCredentials')
      : login.error
        ? t('common.genericError')
        : undefined;

  return (
    <main className="mx-auto mt-20 max-w-sm rounded-lg border border-slate-300 bg-white p-6 dark:border-slate-700 dark:bg-slate-900">
      <h1 className="mb-4 text-xl font-semibold">{t('auth.title')}</h1>
      <form
        noValidate
        className="space-y-4"
        onSubmit={(e) => {
          void handleSubmit((v) => {
            login.mutate(v);
          })(e);
        }}
      >
        <Field id="email" label={t('auth.email')} error={fieldErrorMessage(t, errors.email)}>
          {(p) => (
            <input
              {...p}
              type="email"
              autoComplete="username"
              className={inputClass}
              {...register('email')}
            />
          )}
        </Field>
        <Field
          id="password"
          label={t('auth.password')}
          error={fieldErrorMessage(t, errors.password)}
        >
          {(p) => (
            <input
              {...p}
              type="password"
              autoComplete="current-password"
              className={inputClass}
              {...register('password')}
            />
          )}
        </Field>
        {serverError ? (
          <p role="alert" className="text-sm text-red-700 dark:text-red-400">
            {serverError}
          </p>
        ) : null}
        <Button type="submit" variant="primary" disabled={login.isPending} className="w-full">
          {t('auth.submit')}
        </Button>
      </form>
    </main>
  );
}
