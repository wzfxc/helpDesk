import { describe, expect, it } from 'vitest';
import { DEFAULT_SLA_POLICIES, type Priority } from '@helpdesk/shared';
import { addBusinessMinutes, businessMinutesBetween } from './business-time.js';
import { computeDeadlines, nextDueAt } from './deadlines.js';

const d = (iso: string) => new Date(iso);
const policy = (p: Priority) => {
  const found = DEFAULT_SLA_POLICIES.find((x) => x.priority === p);
  if (!found) throw new Error(p);
  return found;
};

describe('addBusinessMinutes (Europe/Kyiv, Mon–Fri 09–18)', () => {
  it('stays within the same day', () => {
    // Tue 2025-01-07 10:00 Kyiv (UTC+2)
    expect(addBusinessMinutes(d('2025-01-07T08:00:00Z'), 60)).toEqual(d('2025-01-07T09:00:00Z'));
  });

  it('starts at 09:00 when created before working hours', () => {
    // Mon 07:00 Kyiv -> 10:00 Kyiv
    expect(addBusinessMinutes(d('2025-01-06T05:00:00Z'), 60)).toEqual(d('2025-01-06T08:00:00Z'));
  });

  it('skips the weekend when created on Saturday', () => {
    // Sat 2025-01-11 12:00 Kyiv -> Mon 10:00 Kyiv
    expect(addBusinessMinutes(d('2025-01-11T10:00:00Z'), 60)).toEqual(d('2025-01-13T08:00:00Z'));
  });

  it('ends exactly at 18:00 when the budget fits the day', () => {
    // Fri 17:00 Kyiv + 60 = Fri 18:00 Kyiv
    expect(addBusinessMinutes(d('2025-01-10T15:00:00Z'), 60)).toEqual(d('2025-01-10T16:00:00Z'));
  });

  it('handles the spring DST switch (UTC+2 -> UTC+3)', () => {
    // Fri 2025-03-28 17:00 Kyiv (+2) + 4h -> Mon 2025-03-31 12:00 Kyiv (+3) = 09:00Z
    expect(addBusinessMinutes(d('2025-03-28T15:00:00Z'), 240)).toEqual(d('2025-03-31T09:00:00Z'));
  });

  it('handles the autumn DST switch (UTC+3 -> UTC+2)', () => {
    // Fri 2025-10-24 17:00 Kyiv (+3) + 4h -> Mon 2025-10-27 12:00 Kyiv (+2) = 10:00Z
    expect(addBusinessMinutes(d('2025-10-24T14:00:00Z'), 240)).toEqual(d('2025-10-27T10:00:00Z'));
  });

  it('spans multiple business days', () => {
    // Mon 09:00 Kyiv + 3 business days (1620 min) = Wed 18:00 Kyiv
    expect(addBusinessMinutes(d('2025-01-06T07:00:00Z'), 1620)).toEqual(d('2025-01-08T16:00:00Z'));
  });

  it('shifts by the business part of a pause', () => {
    // Tue 10:00 + 60 with a pause 10:30-11:15 -> 11:45
    const pauses = [{ start: d('2025-01-07T08:30:00Z'), end: d('2025-01-07T09:15:00Z') }];
    expect(addBusinessMinutes(d('2025-01-07T08:00:00Z'), 60, pauses)).toEqual(
      d('2025-01-07T09:45:00Z'),
    );
  });

  it('ignores the non-business part of a pause', () => {
    // pause Fri 17:30 Kyiv -> Mon 09:30 Kyiv only removes 30 + 30 business minutes
    const pauses = [{ start: d('2025-01-10T15:30:00Z'), end: d('2025-01-13T07:30:00Z') }];
    // Fri 17:00 + 240: 30 (Fri) + 210 (Mon from 09:30) -> Mon 13:00 Kyiv = 11:00Z
    expect(addBusinessMinutes(d('2025-01-10T15:00:00Z'), 240, pauses)).toEqual(
      d('2025-01-13T11:00:00Z'),
    );
  });

  it('returns null while an open pause blocks the deadline', () => {
    const pauses = [{ start: d('2025-01-07T08:30:00Z'), end: null }];
    expect(addBusinessMinutes(d('2025-01-07T08:00:00Z'), 60, pauses)).toBeNull();
    // ...but a deadline reached before the open pause is known
    expect(addBusinessMinutes(d('2025-01-07T08:00:00Z'), 15, pauses)).toEqual(
      d('2025-01-07T08:15:00Z'),
    );
  });

  it('merges overlapping pauses', () => {
    const pauses = [
      { start: d('2025-01-07T08:10:00Z'), end: d('2025-01-07T08:40:00Z') },
      { start: d('2025-01-07T08:30:00Z'), end: d('2025-01-07T08:50:00Z') },
    ];
    // 40 minutes paused
    expect(addBusinessMinutes(d('2025-01-07T08:00:00Z'), 60, pauses)).toEqual(
      d('2025-01-07T09:40:00Z'),
    );
  });
});

describe('businessMinutesBetween', () => {
  it('counts only working time', () => {
    // Fri 17:00 Kyiv -> Mon 12:00 Kyiv = 60 + 180
    expect(businessMinutesBetween(d('2025-01-10T15:00:00Z'), d('2025-01-13T10:00:00Z'))).toBe(240);
  });

  it('is zero over a weekend and for reversed ranges', () => {
    expect(businessMinutesBetween(d('2025-01-11T10:00:00Z'), d('2025-01-12T10:00:00Z'))).toBe(0);
    expect(businessMinutesBetween(d('2025-01-13T10:00:00Z'), d('2025-01-10T10:00:00Z'))).toBe(0);
  });

  it('is the inverse of addBusinessMinutes across DST', () => {
    const start = d('2025-03-27T12:34:00Z');
    for (const m of [1, 59, 240, 540, 1620, 2700]) {
      const end = addBusinessMinutes(start, m);
      expect(end).not.toBeNull();
      if (end) expect(businessMinutesBetween(start, end)).toBe(m);
    }
  });

  it('excludes pauses including open ones', () => {
    const pauses = [{ start: d('2025-01-07T09:00:00Z'), end: null }];
    // Tue 10:00 -> 13:00 Kyiv, paused from 11:00
    expect(
      businessMinutesBetween(d('2025-01-07T08:00:00Z'), d('2025-01-07T11:00:00Z'), pauses),
    ).toBe(60);
  });
});

describe('computeDeadlines', () => {
  // Acceptance #10: high priority created on Friday 17:00 Kyiv.
  const fri17 = d('2025-01-10T15:00:00Z');

  it('high on Friday 17:00 -> first response Mon 12:00, resolution Mon 17:00', () => {
    const r = computeDeadlines(fri17, policy('high'), []);
    expect(r.firstResponseDueAt).toEqual(d('2025-01-13T10:00:00Z'));
    expect(r.resolutionDueAt).toEqual(d('2025-01-13T15:00:00Z'));
  });

  it('pending pause shifts both deadlines by exactly the paused business time', () => {
    // pending Mon 09:00 -> 10:30 Kyiv = 90 business minutes
    const pauses = [{ start: d('2025-01-13T07:00:00Z'), end: d('2025-01-13T08:30:00Z') }];
    const r = computeDeadlines(fri17, policy('high'), pauses);
    expect(r.firstResponseDueAt).toEqual(d('2025-01-13T11:30:00Z')); // Mon 13:30
    // 60 (Fri) + 450 (Mon 10:30–18:00) = 510, remaining 30 -> Tue 09:30 Kyiv
    expect(r.resolutionDueAt).toEqual(d('2025-01-14T07:30:00Z'));
  });

  it('priority change recomputes from creation time', () => {
    const asNormal = computeDeadlines(fri17, policy('normal'), []);
    const asUrgent = computeDeadlines(fri17, policy('urgent'), []);
    expect(asNormal.firstResponseDueAt).toEqual(d('2025-01-13T15:00:00Z')); // Mon 17:00
    expect(asUrgent.firstResponseDueAt).toEqual(d('2025-01-10T16:00:00Z')); // Fri 18:00
    expect(asUrgent.resolutionDueAt).toEqual(d('2025-01-13T10:00:00Z')); // Mon 12:00
  });
});

describe('nextDueAt', () => {
  const base = {
    firstResponseDueAt: d('2025-01-13T10:00:00Z'),
    resolutionDueAt: d('2025-01-13T15:00:00Z'),
  };
  it('uses first-response deadline until answered, then resolution', () => {
    expect(nextDueAt({ ...base, status: 'new', firstRespondedAt: null })).toEqual(
      base.firstResponseDueAt,
    );
    expect(
      nextDueAt({ ...base, status: 'open', firstRespondedAt: d('2025-01-13T08:00:00Z') }),
    ).toEqual(base.resolutionDueAt);
  });
  it('is null while paused or finished', () => {
    for (const status of ['pending', 'resolved', 'closed'] as const) {
      expect(nextDueAt({ ...base, status, firstRespondedAt: null })).toBeNull();
    }
  });
});
