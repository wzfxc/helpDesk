import { describe, expect, it, vi } from 'vitest';
import { QueryClient } from '@tanstack/react-query';
import type { Message, Ticket, TicketDetail } from '@helpdesk/shared';
import en from '../messages/en.json';
import uk from '../messages/uk.json';
import { clearDraft, draftKey, loadDraft, saveDraft } from '@/lib/drafts';
import { hotkeyAction, isTypingTarget } from '@/lib/hotkeys';
import {
  appendMessage,
  flattenTickets,
  mergeTicketIntoPages,
  replaceTicket,
  type TicketPages,
} from '@/lib/ticket-cache';
import { applyServerEvent, type TypingInfo } from '@/lib/use-event-stream';

function makeTicket(overrides: Partial<Ticket> = {}): Ticket {
  return {
    id: '11111111-1111-4111-8111-111111111111',
    number: 1001,
    subject: 'Test subject',
    category: 'billing',
    priority: 'normal',
    status: 'new',
    tags: [],
    version: 1,
    customer: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Customer',
      email: 'c@example.com',
    },
    assignee: null,
    parentTicketId: null,
    parentTicketNumber: null,
    firstResponseDueAt: '2026-01-01T12:00:00.000Z',
    resolutionDueAt: '2026-01-02T12:00:00.000Z',
    firstRespondedAt: null,
    resolvedAt: null,
    closedAt: null,
    nextDueAt: '2026-01-01T12:00:00.000Z',
    slaPaused: false,
    slaBreachedFirst: false,
    slaBreachedResolution: false,
    lastMessageAt: '2026-01-01T10:00:00.000Z',
    unread: false,
    rating: null,
    createdAt: '2026-01-01T10:00:00.000Z',
    updatedAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

function makeMessage(overrides: Partial<Message> = {}): Message {
  return {
    id: '33333333-3333-4333-8333-333333333333',
    ticketId: '11111111-1111-4111-8111-111111111111',
    author: {
      id: '22222222-2222-4222-8222-222222222222',
      name: 'Customer',
      role: 'customer',
    },
    body: 'Hello',
    internal: false,
    clientMessageId: null,
    attachments: [],
    createdAt: '2026-01-01T10:00:00.000Z',
    ...overrides,
  };
}

function collectKeys(obj: Record<string, unknown>, prefix = ''): string[] {
  return Object.entries(obj).flatMap(([k, v]) => {
    const next = prefix ? `${prefix}.${k}` : k;
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      return collectKeys(v as Record<string, unknown>, next);
    }
    return [next];
  });
}

describe('i18n message parity', () => {
  it('en.json and uk.json define the exact same keys', () => {
    expect(collectKeys(en).sort()).toEqual(collectKeys(uk).sort());
  });
});

describe('drafts', () => {
  const isTextDraft = (v: unknown): v is { body: string } =>
    typeof v === 'object' && v !== null && typeof (v as { body?: unknown }).body === 'string';

  it('saves, loads and clears drafts', () => {
    const key = draftKey('u1', 't1');
    expect(key).toBe('draft:u1:t1');
    saveDraft(key, { body: 'hello' });
    expect(loadDraft(key, isTextDraft)).toEqual({ body: 'hello' });
    clearDraft(key);
    expect(loadDraft(key, isTextDraft)).toBeNull();
  });

  it('ignores malformed or unexpected JSON shapes', () => {
    const key = draftKey('u1', 'bad');
    localStorage.setItem(key, '{not json');
    expect(loadDraft(key, isTextDraft)).toBeNull();
    localStorage.setItem(key, JSON.stringify({ wrong: 123 }));
    expect(loadDraft(key, isTextDraft)).toBeNull();
  });
});

describe('hotkeys', () => {
  it('maps navigation keys when target is not an input', () => {
    const div = document.createElement('div');
    const base = { ctrlKey: false, metaKey: false, altKey: false, target: div };
    expect(hotkeyAction({ ...base, key: 'j' })).toBe('next');
    expect(hotkeyAction({ ...base, key: 'k' })).toBe('prev');
    expect(hotkeyAction({ ...base, key: 'Enter' })).toBe('open');
    expect(hotkeyAction({ ...base, key: '/' })).toBe('search');
    expect(hotkeyAction({ ...base, key: '?' })).toBe('help');
    expect(hotkeyAction({ ...base, key: 'x' })).toBeNull();
  });

  it('ignores shortcuts with modifiers or inside form inputs', () => {
    const div = document.createElement('div');
    expect(
      hotkeyAction({ key: 'j', ctrlKey: true, metaKey: false, altKey: false, target: div }),
    ).toBeNull();
    for (const tag of ['input', 'textarea', 'select']) {
      const el = document.createElement(tag);
      expect(isTypingTarget(el)).toBe(true);
      expect(
        hotkeyAction({ key: 'j', ctrlKey: false, metaKey: false, altKey: false, target: el }),
      ).toBeNull();
    }
    const textbox = document.createElement('div');
    textbox.setAttribute('role', 'textbox');
    expect(isTypingTarget(textbox)).toBe(true);
  });
});

describe('ticket-cache & SSE applyServerEvent', () => {
  it('merges updated tickets in place without overwriting newer versions', () => {
    const t1 = makeTicket({ id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', version: 2 });
    const t2 = makeTicket({ id: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', version: 1 });
    const pages: TicketPages = {
      pages: [{ items: [t1, t2], nextCursor: null }],
      pageParams: [null],
    };

    const updatedT2 = makeTicket({ id: t2.id, version: 2, status: 'open' });
    const res = mergeTicketIntoPages(pages, updatedT2);
    expect(res.found).toBe(true);
    expect(flattenTickets(res.data).map((t) => t.status)).toEqual(['new', 'open']);

    // Stale event for t1 (version 1 < 2) must be ignored
    const staleT1 = makeTicket({ id: t1.id, version: 1, status: 'closed' });
    const staleRes = mergeTicketIntoPages(res.data, staleT1);
    expect(staleRes.found).toBe(true);
    expect(flattenTickets(staleRes.data)[0]?.status).toBe('new');
  });

  it('appends messages without duplicating and replaces ticket details respecting version', () => {
    const t = makeTicket({ version: 2 });
    const m1 = makeMessage();
    let detail: TicketDetail | undefined = { ticket: t, messages: [m1], events: [] };
    detail = appendMessage(detail, m1);
    expect(detail?.messages).toHaveLength(1);
    const m2 = makeMessage({ id: '44444444-4444-4444-8444-444444444444', body: 'World' });
    detail = appendMessage(detail, m2);
    expect(detail?.messages).toHaveLength(2);
    expect(replaceTicket(detail, makeTicket({ version: 1, status: 'closed' }))?.ticket.status).toBe(
      'new',
    );
    expect(replaceTicket(detail, makeTicket({ version: 3, status: 'open' }))?.ticket.status).toBe(
      'open',
    );
  });

  it('applyServerEvent updates ticket detail, invalidates missing lists and records typing', () => {
    const qc = new QueryClient();
    const invalidateSpy = vi.spyOn(qc, 'invalidateQueries');
    const ticket = makeTicket({ version: 2, status: 'open' });
    qc.setQueryData<TicketDetail>(['ticket', ticket.id], {
      ticket: makeTicket({ version: 1 }),
      messages: [],
      events: [],
    });
    qc.setQueryData<TicketPages>(['tickets', 'queue'], {
      pages: [{ items: [], nextCursor: null }],
      pageParams: [null],
    });

    applyServerEvent(qc, { type: 'ticket.updated', ticket });
    expect(qc.getQueryData<TicketDetail>(['ticket', ticket.id])?.ticket.status).toBe('open');
    expect(invalidateSpy).toHaveBeenCalledWith({ queryKey: ['tickets'], refetchType: 'active' });

    const msg = makeMessage();
    applyServerEvent(qc, { type: 'message.created', ticketId: ticket.id, message: msg });
    expect(qc.getQueryData<TicketDetail>(['ticket', ticket.id])?.messages).toHaveLength(1);

    applyServerEvent(qc, {
      type: 'typing',
      ticketId: ticket.id,
      user: { id: '55555555-5555-4555-8555-555555555555', name: 'Іван' },
    });
    expect(qc.getQueryData<TypingInfo>(['typing', ticket.id])?.name).toBe('Іван');
  });
});
