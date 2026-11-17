'use client';

import { useQuery } from '@tanstack/react-query';
import type {
  CannedResponse,
  Me,
  NotificationList,
  SavedView,
  StaffMember,
} from '@helpdesk/shared';
import { api, ApiRequestError } from './api';

export const meQuery = {
  queryKey: ['me'] as const,
  queryFn: () => api<Me>('/me'),
  retry: false,
  staleTime: 5 * 60_000,
};

/** The current user; `isError` with status 401 means "not signed in". */
export function useMe() {
  return useQuery(meQuery);
}

export const isUnauthorized = (err: unknown): boolean =>
  err instanceof ApiRequestError && err.status === 401;

export function useStaff(enabled: boolean) {
  return useQuery({
    queryKey: ['staff'],
    queryFn: () => api<StaffMember[]>('/users/staff'),
    enabled,
    staleTime: 5 * 60_000,
  });
}

export function useCanned(enabled: boolean) {
  return useQuery({
    queryKey: ['canned'],
    queryFn: () => api<CannedResponse[]>('/canned-responses'),
    enabled,
  });
}

export function useViews(enabled: boolean) {
  return useQuery({
    queryKey: ['views'],
    queryFn: () => api<SavedView[]>('/views'),
    enabled,
  });
}

export function useNotifications(enabled: boolean) {
  return useQuery({
    queryKey: ['notifications'],
    queryFn: () => api<NotificationList>('/notifications'),
    enabled,
  });
}
