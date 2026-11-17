import type { ReactNode } from 'react';
import { describe, expect, it } from 'vitest';
import { render, screen, waitFor } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { NextIntlClientProvider } from 'next-intl';
import { http, HttpResponse } from 'msw';
import type { CannedResponse, Me, Ticket, TicketDetail } from '@helpdesk/shared';
import en from '../messages/en.json';
import LoginPage from '@/app/login/page';
import { Composer } from '@/components/composer';
import { SidePanel } from '@/components/side-panel';
import { server } from './setup';

function renderWithProviders(ui: ReactNode, qc = new QueryClient()) {
  qc.setDefaultOptions({ queries: { retry: false }, mutations: { retry: false } });
  return {
    qc,
    ...render(
      <NextIntlClientProvider locale="en" messages={en} timeZone="Europe/Kyiv">
        <QueryClientProvider client={qc}>{ui}</QueryClientProvider>
      </NextIntlClientProvider>,
    ),
  };
}

const AGENT: Me = {
  id: '11111111-1111-4111-8111-111111111111',
  email: 'agent1@helpdesk.local',
  name: 'Іван Петренко',
  role: 'agent',
  categories: ['billing'],
};

const TICKET: Ticket = {
  id: '22222222-2222-4222-8222-222222222222',
  number: 1042,
  subject: 'Cannot pay invoice',
  category: 'billing',
  priority: 'normal',
  status: 'open',
  tags: ['vip'],
  version: 2,
  customer: {
    id: '33333333-3333-4333-8333-333333333333',
    name: 'Олена',
    email: 'customer1@example.com',
  },
  assignee: { id: AGENT.id, name: AGENT.name },
  parentTicketId: null,
  parentTicketNumber: null,
  firstResponseDueAt: '2026-01-02T12:00:00.000Z',
  resolutionDueAt: '2026-01-05T12:00:00.000Z',
  firstRespondedAt: '2026-01-01T10:05:00.000Z',
  resolvedAt: null,
  closedAt: null,
  nextDueAt: '2026-01-05T12:00:00.000Z',
  slaPaused: false,
  slaBreachedFirst: false,
  slaBreachedResolution: false,
  lastMessageAt: '2026-01-01T10:05:00.000Z',
  unread: false,
  rating: null,
  createdAt: '2026-01-01T10:00:00.000Z',
  updatedAt: '2026-01-01T10:05:00.000Z',
};

describe('LoginPage', () => {
  it('shows accessible field validation errors when submitted empty', async () => {
    const user = userEvent.setup();
    renderWithProviders(<LoginPage />);

    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    const email = screen.getByLabelText('Email');
    const password = screen.getByLabelText('Password');
    await waitFor(() => {
      expect(email).toHaveAttribute('aria-invalid', 'true');
      expect(password).toHaveAttribute('aria-invalid', 'true');
    });
    expect(screen.getAllByRole('alert')).toHaveLength(2);
  });

  it('displays invalid credentials and rate-limit errors from API', async () => {
    const user = userEvent.setup();
    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json(
          { error: { code: 'invalid_credentials', message: 'Invalid email or password' } },
          { status: 401 },
        ),
      ),
    );
    renderWithProviders(<LoginPage />);

    await user.type(screen.getByLabelText('Email'), 'agent1@helpdesk.local');
    await user.type(screen.getByLabelText('Password'), 'wrongpass');
    await user.click(screen.getByRole('button', { name: 'Sign in' }));

    expect(await screen.findByRole('alert')).toHaveTextContent('Invalid email or password');

    server.use(
      http.post('/api/auth/login', () =>
        HttpResponse.json(
          { error: { code: 'rate_limited', message: 'Too many attempts' } },
          { status: 429, headers: { 'Retry-After': '45' } },
        ),
      ),
    );
    await user.click(screen.getByRole('button', { name: 'Sign in' }));
    expect(await screen.findByRole('alert')).toHaveTextContent('45 seconds');
  });
});

describe('Composer', () => {
  it('switches reply/note modes, inserts canned template and sends message via MSW', async () => {
    const user = userEvent.setup();
    const canned: CannedResponse[] = [
      {
        id: '44444444-4444-4444-8444-444444444444',
        title: 'Greeting',
        body: 'Hi {{customerName}} on {{ticketNumber}} from {{agentName}}',
        category: null,
        createdAt: '2026-01-01T00:00:00.000Z',
        updatedAt: '2026-01-01T00:00:00.000Z',
      },
    ];
    let sentPayload: { body: string; internal: boolean; clientMessageId: string } | null = null;
    server.use(
      http.get('/api/canned-responses', () => HttpResponse.json(canned)),
      http.post('/api/tickets/:id/typing', () => new HttpResponse(null, { status: 204 })),
      http.post('/api/tickets/:id/messages', async ({ request }) => {
        sentPayload = (await request.json()) as typeof sentPayload;
        return HttpResponse.json(
          {
            message: {
              id: '55555555-5555-4555-8555-555555555555',
              ticketId: TICKET.id,
              author: { id: AGENT.id, name: AGENT.name, role: 'agent' },
              body: sentPayload?.body ?? '',
              internal: sentPayload?.internal ?? false,
              clientMessageId: sentPayload?.clientMessageId ?? null,
              attachments: [],
              createdAt: '2026-01-01T10:10:00.000Z',
            },
            ticket: { ...TICKET, version: 3 },
            newTicketId: null,
          },
          { status: 201 },
        );
      }),
    );

    const savedId = '66666666-6666-4666-8666-666666666666';
    localStorage.setItem(
      `draft:${AGENT.id}:${TICKET.id}`,
      JSON.stringify({ body: 'Saved draft', mode: 'reply', clientMessageId: savedId }),
    );

    renderWithProviders(<Composer ticket={TICKET} me={AGENT} />);
    const textarea = screen.getByPlaceholderText('Write a reply…');
    expect(textarea).toHaveValue('Saved draft');

    // Switch to Internal note
    await user.click(screen.getByRole('button', { name: 'Internal note' }));
    expect(screen.getByRole('button', { name: 'Internal note' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(screen.getByText('Internal note — the customer will not see this')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Add note' })).toBeInTheDocument();

    // Insert canned template with placeholder substitution
    const select = await screen.findByLabelText('Insert template');
    await user.selectOptions(select, '44444444-4444-4444-8444-444444444444');
    expect(textarea).toHaveValue('Saved draft\nHi Олена on HD-1042 from Іван Петренко');

    // Ctrl+Enter submits using preserved clientMessageId
    await user.type(textarea, '{Control>}{Enter}{/Control}');
    await waitFor(() => {
      expect(sentPayload).toEqual({
        body: 'Saved draft\nHi Олена on HD-1042 from Іван Петренко',
        internal: true,
        clientMessageId: savedId,
        attachmentIds: [],
      });
    });
    expect(textarea).toHaveValue('');
    await waitFor(() => {
      expect(textarea).toHaveFocus();
    });
  });
});

describe('SidePanel', () => {
  it('handles 409 version_conflict by updating state and showing conflict banner', async () => {
    const user = userEvent.setup();
    const fresh: Ticket = { ...TICKET, version: 3, priority: 'high' };
    const qc = new QueryClient();
    qc.setQueryData<TicketDetail>(['ticket', TICKET.id], {
      ticket: TICKET,
      messages: [],
      events: [],
    });

    server.use(
      http.patch(`/api/tickets/${TICKET.id}`, () =>
        HttpResponse.json(
          {
            error: { code: 'version_conflict', message: 'The ticket was changed by someone else' },
            current: fresh,
          },
          { status: 409 },
        ),
      ),
    );

    renderWithProviders(<SidePanel ticket={TICKET} me={AGENT} />, qc);
    await user.selectOptions(screen.getByLabelText('Priority'), 'urgent');

    expect(await screen.findByTestId('conflict-banner')).toBeInTheDocument();
    expect(qc.getQueryData<TicketDetail>(['ticket', TICKET.id])?.ticket.version).toBe(3);
  });
});

describe('closed ticket (staff)', () => {
  const CLOSED: Ticket = { ...TICKET, status: 'closed', closedAt: '2026-01-04T10:00:00.000Z' };

  it('composer shows a translated explanation, not the raw status', async () => {
    renderWithProviders(<Composer ticket={CLOSED} me={AGENT} />);
    const notice = await screen.findByTestId('closed-staff-notice');
    expect(notice).toHaveTextContent('This ticket is closed: replies are disabled');
    expect(notice).not.toHaveTextContent(/^closed$/);
    expect(screen.queryByRole('textbox')).not.toBeInTheDocument();
  });

  it('side panel makes every field read-only and explains why', () => {
    renderWithProviders(<SidePanel ticket={CLOSED} me={AGENT} />);
    for (const label of ['Status', 'Priority', 'Category', 'Tags']) {
      expect(screen.getByLabelText(label)).toBeDisabled();
    }
    const note = screen.getByText(/Closed tickets are read-only/);
    expect(screen.getByLabelText('Status')).toHaveAttribute('aria-describedby', note.id);
  });

  it('side panel stays editable for an open ticket', () => {
    renderWithProviders(<SidePanel ticket={TICKET} me={AGENT} />);
    expect(screen.getByLabelText('Status')).toBeEnabled();
    expect(screen.queryByText(/Closed tickets are read-only/)).not.toBeInTheDocument();
  });
});
