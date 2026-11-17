import { describe, expect, it } from 'vitest';
import { STATUSES, type Status } from './enums';
import { canTransition, manualTargets, statusAfterMessage, TRANSITIONS } from './transitions';

describe('transition matrix', () => {
  it('has no duplicate rules', () => {
    const keys = TRANSITIONS.map((r) => `${r.from}>${r.to}:${r.trigger}`);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it('never leaves closed and never returns to new', () => {
    for (const r of TRANSITIONS) {
      expect(r.from).not.toBe('closed');
      expect(r.to).not.toBe('new');
      expect(r.from).not.toBe(r.to);
    }
  });

  it('manual staff transitions', () => {
    const expected: Record<Status, Status[]> = {
      new: ['open', 'pending', 'resolved'],
      open: ['pending', 'resolved'],
      pending: ['open', 'resolved'],
      resolved: ['open', 'closed'],
      closed: [],
    };
    for (const s of STATUSES) expect(manualTargets(s).sort()).toEqual(expected[s].sort());
  });

  it('customers cannot use staff triggers', () => {
    expect(canTransition('new', 'open', 'staff_manual', 'customer')).toBe(false);
    expect(canTransition('resolved', 'closed', 'auto_close', 'lead')).toBe(false);
    expect(canTransition('resolved', 'closed', 'auto_close', 'system')).toBe(true);
  });
});

describe('statusAfterMessage', () => {
  const staff = (current: Status, followUp?: 'pending' | 'resolved') =>
    statusAfterMessage({ current, role: 'agent', internal: false, followUp });
  const customer = (current: Status) =>
    statusAfterMessage({ current, role: 'customer', internal: false });

  it('staff public reply on new/pending opens the ticket', () => {
    expect(staff('new')).toEqual({ kind: 'set', to: 'open', trigger: 'staff_public_reply' });
    expect(staff('pending')).toEqual({ kind: 'set', to: 'open', trigger: 'staff_public_reply' });
    expect(staff('open')).toEqual({ kind: 'keep' });
    expect(staff('resolved')).toEqual({ kind: 'keep' });
  });

  it('staff cannot write to closed tickets', () => {
    expect(staff('closed')).toEqual({ kind: 'reject', reason: 'ticket_closed' });
    expect(statusAfterMessage({ current: 'closed', role: 'lead', internal: true })).toEqual({
      kind: 'reject',
      reason: 'ticket_closed',
    });
  });

  it('send and wait / send and resolve', () => {
    expect(staff('open', 'pending')).toMatchObject({ kind: 'set', to: 'pending' });
    expect(staff('pending', 'pending')).toEqual({ kind: 'keep' });
    expect(staff('resolved', 'pending')).toMatchObject({ kind: 'set', to: 'pending' });
    expect(staff('new', 'resolved')).toMatchObject({ kind: 'set', to: 'resolved' });
    expect(staff('resolved', 'resolved')).toEqual({ kind: 'keep' });
  });

  it('internal notes never change status', () => {
    for (const s of ['new', 'open', 'pending', 'resolved'] as const) {
      expect(statusAfterMessage({ current: s, role: 'agent', internal: true })).toEqual({
        kind: 'keep',
      });
    }
    expect(
      statusAfterMessage({ current: 'open', role: 'agent', internal: true, followUp: 'pending' }),
    ).toEqual({ kind: 'reject', reason: 'forbidden' });
  });

  it('customer reply reopens pending/resolved and spawns from closed', () => {
    expect(customer('pending')).toEqual({ kind: 'set', to: 'open', trigger: 'customer_reply' });
    expect(customer('resolved')).toEqual({ kind: 'set', to: 'open', trigger: 'customer_reply' });
    expect(customer('new')).toEqual({ kind: 'keep' });
    expect(customer('open')).toEqual({ kind: 'keep' });
    expect(customer('closed')).toEqual({ kind: 'spawn' });
  });

  it('customers cannot post notes or choose follow-up', () => {
    expect(statusAfterMessage({ current: 'open', role: 'customer', internal: true })).toEqual({
      kind: 'reject',
      reason: 'forbidden',
    });
    expect(
      statusAfterMessage({
        current: 'open',
        role: 'customer',
        internal: false,
        followUp: 'resolved',
      }),
    ).toEqual({ kind: 'reject', reason: 'forbidden' });
  });
});
