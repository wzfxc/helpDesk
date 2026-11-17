'use client';

import { useCallback, useRef, useState, type DragEvent } from 'react';
import { useTranslations } from 'next-intl';
import { LIMITS, type Attachment } from '@helpdesk/shared';
import { ApiRequestError, uploadAttachment } from '@/lib/api';
import { Button } from './ui';

export interface UploadItem {
  localId: string;
  name: string;
  progress: number;
  status: 'uploading' | 'done' | 'error';
  attachment?: Attachment;
  error?: string;
  abort?: () => void;
}

/** Upload state for the composer / new ticket form: progress, cancel, remove. */
export function useUploads() {
  const [items, setItems] = useState<UploadItem[]>([]);
  const counter = useRef(0);

  const patch = useCallback((localId: string, change: Partial<UploadItem>) => {
    setItems((prev) => prev.map((i) => (i.localId === localId ? { ...i, ...change } : i)));
  }, []);

  const add = useCallback(
    (files: File[]) => {
      for (const file of files) {
        counter.current += 1;
        const localId = `u${counter.current.toString()}`;
        const handle = uploadAttachment(file, (progress) => {
          patch(localId, { progress });
        });
        setItems((prev) => [
          ...prev,
          { localId, name: file.name, progress: 0, status: 'uploading', abort: handle.abort },
        ]);
        handle.promise
          .then((attachment) => {
            patch(localId, { status: 'done', progress: 100, attachment });
          })
          .catch((err: unknown) => {
            if (err instanceof DOMException && err.name === 'AbortError') {
              setItems((prev) => prev.filter((i) => i.localId !== localId));
              return;
            }
            patch(localId, {
              status: 'error',
              error: err instanceof ApiRequestError ? err.message : 'network error',
            });
          });
      }
    },
    [patch],
  );

  const remove = useCallback((localId: string) => {
    setItems((prev) => {
      prev.find((i) => i.localId === localId)?.abort?.();
      return prev.filter((i) => i.localId !== localId);
    });
  }, []);

  const reset = useCallback(() => {
    setItems([]);
  }, []);

  return {
    items,
    add,
    remove,
    reset,
    ids: items.flatMap((i) => (i.attachment ? [i.attachment.id] : [])),
    busy: items.some((i) => i.status === 'uploading'),
    count: items.filter((i) => i.status !== 'error').length,
  };
}

export function AttachmentUploader({
  uploads,
  label,
}: {
  uploads: ReturnType<typeof useUploads>;
  label: string;
}) {
  const t = useTranslations('composer');
  const inputRef = useRef<HTMLInputElement>(null);
  const [dragging, setDragging] = useState(false);
  const inputId = `file-${label.replace(/\W/g, '')}`;

  const take = (list: FileList | null) => {
    if (!list) return;
    const room = LIMITS.attachmentsPerMessage - uploads.count;
    uploads.add(Array.from(list).slice(0, Math.max(0, room)));
  };

  return (
    <div className="space-y-2">
      {/* eslint-disable-next-line jsx-a11y/no-static-element-interactions -- drag & drop is an enhancement; the keyboard path is the labelled file input inside */}
      <div
        onDragOver={(e: DragEvent) => {
          e.preventDefault();
          setDragging(true);
        }}
        onDragLeave={() => {
          setDragging(false);
        }}
        onDrop={(e: DragEvent) => {
          e.preventDefault();
          setDragging(false);
          take(e.dataTransfer.files);
        }}
        className={`rounded-md border-2 border-dashed p-3 text-sm ${
          dragging
            ? 'border-blue-600 bg-blue-50 dark:bg-blue-950'
            : 'border-slate-400 dark:border-slate-600'
        }`}
      >
        <span>{t('dropHere')} </span>
        <label
          htmlFor={inputId}
          className="cursor-pointer font-medium text-blue-800 underline dark:text-blue-300"
        >
          {t('chooseFiles')}
        </label>
        <input
          id={inputId}
          ref={inputRef}
          type="file"
          multiple
          className="sr-only"
          data-testid="file-input"
          onChange={(e) => {
            take(e.target.files);
            e.target.value = '';
          }}
        />
        <p className="mt-1 text-xs text-slate-600 dark:text-slate-400">
          {t('attachmentsLimit', { max: LIMITS.attachmentsPerMessage })}
        </p>
      </div>
      {uploads.items.length > 0 ? (
        <ul className="space-y-1" aria-label={label}>
          {uploads.items.map((i) => (
            <li key={i.localId} className="flex items-center gap-2 text-sm">
              <span className="truncate">{i.name}</span>
              {i.status === 'uploading' ? (
                <>
                  <progress
                    value={i.progress}
                    max={100}
                    aria-label={t('uploading', { name: i.name, percent: i.progress })}
                    className="h-2 w-24"
                  />
                  <span aria-hidden="true">{i.progress}%</span>
                </>
              ) : null}
              {i.status === 'error' ? (
                <span role="alert" className="text-red-700 dark:text-red-400">
                  {t('uploadFailed', { name: i.name, reason: i.error ?? '' })}
                </span>
              ) : null}
              <Button
                variant="ghost"
                aria-label={
                  i.status === 'uploading'
                    ? t('cancelUpload', { name: i.name })
                    : t('removeAttachment', { name: i.name })
                }
                onClick={() => {
                  uploads.remove(i.localId);
                }}
              >
                ✕
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
