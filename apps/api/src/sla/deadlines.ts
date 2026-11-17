import type { Status } from '@helpdesk/shared';
import {
  addBusinessMinutes,
  KYIV_CALENDAR,
  type BusinessCalendar,
  type Pause,
} from './business-time.js';

export interface SlaMinutes {
  firstResponseMinutes: number;
  resolutionMinutes: number;
}

export interface Deadlines {
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
}

/**
 * Deadlines are always computed from the ticket creation time plus every pause so far,
 * which makes a priority change a simple recomputation.
 * A deadline is null only while an open pause started before it would be reached.
 */
export function computeDeadlines(
  createdAt: Date,
  policy: SlaMinutes,
  pauses: readonly Pause[],
  cal: BusinessCalendar = KYIV_CALENDAR,
): Deadlines {
  return {
    firstResponseDueAt: addBusinessMinutes(createdAt, policy.firstResponseMinutes, pauses, cal),
    resolutionDueAt: addBusinessMinutes(createdAt, policy.resolutionMinutes, pauses, cal),
  };
}

/** Statuses during which SLA timers are stopped. */
export const PAUSED_STATUSES: readonly Status[] = ['pending', 'resolved', 'closed'];
export const isPausedStatus = (s: Status): boolean => PAUSED_STATUSES.includes(s);

/** Nearest running deadline (what queues sort by), or null when no timer runs. */
export function nextDueAt(t: {
  status: Status;
  firstRespondedAt: Date | null;
  firstResponseDueAt: Date | null;
  resolutionDueAt: Date | null;
}): Date | null {
  if (isPausedStatus(t.status)) return null;
  if (!t.firstRespondedAt && t.firstResponseDueAt) {
    if (t.resolutionDueAt && t.resolutionDueAt < t.firstResponseDueAt) return t.resolutionDueAt;
    return t.firstResponseDueAt;
  }
  return t.resolutionDueAt;
}
