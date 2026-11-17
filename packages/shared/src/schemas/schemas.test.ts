import { describe, expect, it } from 'vitest';
import { renderCannedResponse, CreateSavedViewSchema, UpdateSlaPoliciesSchema } from './misc';
import {
  BulkRequestSchema,
  CreateMessageSchema,
  CreateTicketSchema,
  TicketListQuerySchema,
  UpdateTicketSchema,
} from './tickets';
import { LoginRequestSchema } from './auth';

const uuid = '3f1c2b7e-8a4d-4c1e-9b2f-1a2b3c4d5e6f';

describe('CreateTicketSchema', () => {
  const valid = { subject: 'Hi', category: 'billing', priority: 'high', body: 'text' };

  it('accepts a valid ticket and trims the subject', () => {
    const r = CreateTicketSchema.parse({ ...valid, subject: '  Hi  ' });
    expect(r.subject).toBe('Hi');
    expect(r.attachmentIds).toEqual([]);
  });

  it('rejects urgent priority for customers', () => {
    expect(CreateTicketSchema.safeParse({ ...valid, priority: 'urgent' }).success).toBe(false);
  });

  it('enforces subject length 1..200', () => {
    expect(CreateTicketSchema.safeParse({ ...valid, subject: '   ' }).success).toBe(false);
    expect(CreateTicketSchema.safeParse({ ...valid, subject: 'x'.repeat(201) }).success).toBe(
      false,
    );
    expect(CreateTicketSchema.safeParse({ ...valid, subject: 'x'.repeat(200) }).success).toBe(true);
  });

  it('allows at most 5 attachments', () => {
    const ids = Array.from(
      { length: 6 },
      (_, i) => `3f1c2b7e-8a4d-4c1e-9b2f-1a2b3c4d5e6${i.toString()}`,
    );
    expect(CreateTicketSchema.safeParse({ ...valid, attachmentIds: ids }).success).toBe(false);
  });
});

describe('UpdateTicketSchema', () => {
  it('requires version and at least one field', () => {
    expect(UpdateTicketSchema.safeParse({ version: 1 }).success).toBe(false);
    expect(UpdateTicketSchema.safeParse({ status: 'open' }).success).toBe(false);
    expect(UpdateTicketSchema.safeParse({ version: 1, status: 'open' }).success).toBe(true);
  });

  it('rejects unknown fields', () => {
    expect(UpdateTicketSchema.safeParse({ version: 1, number: 5 }).success).toBe(false);
  });

  it('normalizes tags', () => {
    const r = UpdateTicketSchema.parse({ version: 0, tags: ['VIP', 'vip', ' refund '] });
    expect(r.tags).toEqual(['vip', 'refund']);
  });
});

describe('CreateMessageSchema', () => {
  it('requires a uuid clientMessageId', () => {
    expect(CreateMessageSchema.safeParse({ clientMessageId: 'x', body: 'a' }).success).toBe(false);
    expect(CreateMessageSchema.parse({ clientMessageId: uuid, body: 'a' }).internal).toBe(false);
  });
});

describe('TicketListQuerySchema', () => {
  it('parses comma lists and booleans from query strings', () => {
    const r = TicketListQuerySchema.parse({
      status: 'new,open',
      priority: ['high', 'urgent'],
      slaBreached: 'true',
      limit: '20',
    });
    expect(r.status).toEqual(['new', 'open']);
    expect(r.priority).toEqual(['high', 'urgent']);
    expect(r.slaBreached).toBe(true);
    expect(r.limit).toBe(20);
  });

  it('rejects bad values', () => {
    expect(TicketListQuerySchema.safeParse({ status: 'nope' }).success).toBe(false);
    expect(TicketListQuerySchema.safeParse({ limit: '1000' }).success).toBe(false);
    expect(TicketListQuerySchema.safeParse({ assignee: 'someone' }).success).toBe(false);
    expect(TicketListQuerySchema.safeParse({ createdFrom: 'yesterday' }).success).toBe(false);
  });
});

describe('BulkRequestSchema', () => {
  it('caps the number of ids at 200', () => {
    const ids = Array.from({ length: 201 }, () => crypto.randomUUID());
    expect(
      BulkRequestSchema.safeParse({ ids, action: { type: 'priority', priority: 'low' } }).success,
    ).toBe(false);
    expect(
      BulkRequestSchema.safeParse({
        ids: ids.slice(0, 200),
        action: { type: 'priority', priority: 'low' },
      }).success,
    ).toBe(true);
  });
});

describe('misc schemas', () => {
  it('normalizes login email', () => {
    expect(LoginRequestSchema.parse({ email: ' A@B.io ', password: 'x' }).email).toBe('a@b.io');
  });

  it('renders canned placeholders and leaves unknown ones', () => {
    expect(
      renderCannedResponse('Hi {{customerName}}, re {{ ticketNumber }} {{x}}', {
        customerName: 'Olena',
        ticketNumber: 'HD-7',
      }),
    ).toBe('Hi Olena, re HD-7 {{x}}');
  });

  it('validates saved view query strings', () => {
    expect(CreateSavedViewSchema.safeParse({ name: 'a', query: 'status=open' }).success).toBe(true);
    expect(CreateSavedViewSchema.safeParse({ name: 'a', query: 'status=bogus' }).success).toBe(
      false,
    );
  });

  it('validates SLA policies', () => {
    expect(
      UpdateSlaPoliciesSchema.safeParse({
        policies: [{ priority: 'low', firstResponseMinutes: 100, resolutionMinutes: 50 }],
      }).success,
    ).toBe(false);
  });
});
