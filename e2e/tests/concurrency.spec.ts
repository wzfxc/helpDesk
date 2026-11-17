import { randomUUID } from 'node:crypto';
import {
  AGENT,
  CUSTOMER,
  Session,
  createTicketViaApi,
  expect,
  test,
  uniqueToken,
} from './fixtures';

test('acceptance #6: six simultaneous "take next" calls get six different tickets', async ({
  browser,
}) => {
  const agents = await Promise.all([1, 2, 3, 4, 5, 6].map((n) => Session.open(browser, AGENT(n))));
  const responses = await Promise.all(agents.map((a) => a.api.post('/api/tickets/take-next')));
  expect(responses.map((r) => r.status())).toEqual([200, 200, 200, 200, 200, 200]);
  const bodies = (await Promise.all(responses.map((r) => r.json()))) as {
    id: string;
    assignee: { id: string };
  }[];
  expect(new Set(bodies.map((b) => b.id)).size).toBe(6);
  expect(new Set(bodies.map((b) => b.assignee.id)).size).toBe(6);
});

test('take next from the queue UI opens the assigned ticket', async ({ browser }) => {
  const agent = await Session.open(browser, AGENT(2));
  await agent.page.goto('/queue');
  await agent.page.getByRole('button', { name: 'Take next' }).click();
  await expect(agent.page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/);
  await expect(agent.page.locator('#sp-assignee')).toContainText('Олена Коваль');
});

test('acceptance #7: second agent editing a stale ticket gets a conflict and nothing is overwritten', async ({
  browser,
}) => {
  const token = uniqueToken();
  const customer = await Session.open(browser, CUSTOMER(1));
  const ticket = await createTicketViaApi(customer.api, {
    subject: `Conflict ${token}`,
    category: 'billing',
  });

  const a = await Session.open(browser, AGENT(1));
  const b = await Session.open(browser, AGENT(2));
  // B never receives live updates, so its copy of the ticket stays at the old version
  await b.page.route('**/api/events', (route) => route.abort());
  await a.page.goto(`/tickets/${ticket.id}`);
  await b.page.goto(`/tickets/${ticket.id}`);
  await expect(b.page.locator('#sp-priority')).toHaveValue('normal');

  const saved = a.page.waitForResponse(
    (r) => r.url().includes(`/api/tickets/${ticket.id}`) && r.request().method() === 'PATCH',
  );
  await a.page.locator('#sp-priority').selectOption('high');
  expect((await saved).status()).toBe(200);

  // B types a reply first: it must survive the conflict
  await b.page.locator('#composer-body').fill('draft text that must not be lost');
  await b.page.locator('#sp-priority').selectOption('urgent');
  const banner = b.page.getByTestId('conflict-banner');
  await expect(banner).toBeVisible();
  await expect(banner).toContainText('changed by someone else');
  await expect(b.page.locator('#sp-priority')).toHaveValue('high');
  await expect(b.page.locator('#composer-body')).toHaveValue('draft text that must not be lost');

  const current = await (await customer.api.get(`/api/tickets/${ticket.id}`)).json();
  expect(current.ticket.priority).toBe('high');
});

test('acceptance #8: double click and a dropped request still produce a single message', async ({
  browser,
}) => {
  const token = uniqueToken();
  const text = `Only once ${token}`;
  const customer = await Session.open(browser, CUSTOMER(1));
  const ticket = await createTicketViaApi(customer.api, { subject: `Once ${token}` });
  await customer.page.goto(`/tickets/${ticket.id}`);

  let aborted = 0;
  await customer.page.route('**/api/tickets/*/messages', async (route) => {
    if (aborted === 0) {
      aborted += 1;
      await route.abort('connectionreset');
      return;
    }
    await route.continue();
  });
  await customer.page.locator('#composer-body').fill(text);
  await customer.page.getByRole('button', { name: 'Send to customer' }).dblclick();
  await expect(customer.page.getByTestId('message').filter({ hasText: text })).toHaveCount(1);
  expect(aborted).toBe(1);

  const detail = await (await customer.api.get(`/api/tickets/${ticket.id}`)).json();
  const copies = (detail.messages as { body: string }[]).filter((m) => m.body === text);
  expect(copies).toHaveLength(1);

  // and at the API level: the same clientMessageId posted many times in parallel
  const clientMessageId = randomUUID();
  const rs = await Promise.all(
    Array.from({ length: 5 }, () =>
      customer.api.post(`/api/tickets/${ticket.id}/messages`, {
        data: { clientMessageId, body: `dup ${token}` },
      }),
    ),
  );
  expect(rs.map((r) => r.status())).toEqual([201, 201, 201, 201, 201]);
  const after = await (await customer.api.get(`/api/tickets/${ticket.id}`)).json();
  expect(
    (after.messages as { body: string }[]).filter((m) => m.body === `dup ${token}`),
  ).toHaveLength(1);
});

test('acceptance #9: 50 concurrent ticket creations get unique consecutive numbers', async ({
  browser,
}) => {
  const customers = await Promise.all(
    [5, 6, 7, 8, 9].map((n) => Session.open(browser, CUSTOMER(n))),
  );
  const token = uniqueToken();
  const results = await Promise.all(
    Array.from({ length: 50 }, (_, i) =>
      createTicketViaApi(customers[i % customers.length]!.api, {
        subject: `Parallel ${token} ${i.toString()}`,
        category: 'other',
      }),
    ),
  );
  const numbers = results.map((r) => r.number).sort((x, y) => x - y);
  expect(new Set(numbers).size).toBe(50);
  // consecutive: allocated inside the insert transaction, other tests may interleave only before/after
  expect(numbers[49]! - numbers[0]!).toBe(49);
});
