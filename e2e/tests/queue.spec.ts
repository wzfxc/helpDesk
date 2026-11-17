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

test('acceptance #12: bulk action applies to the rest and reports skipped tickets with reasons', async ({
  browser,
}) => {
  const token = uniqueToken();
  const customer = await Session.open(browser, CUSTOMER(1));
  const a = await createTicketViaApi(customer.api, { subject: `Bulk ${token} A` });
  const b = await createTicketViaApi(customer.api, { subject: `Bulk ${token} B` });
  const c = await createTicketViaApi(customer.api, { subject: `Bulk ${token} C` });
  // C is resolved: resolved -> pending is not an allowed transition
  expect((await customer.api.post(`/api/tickets/${c.id}/resolve`)).status()).toBe(200);

  const agent = await Session.open(browser, AGENT(1));
  await agent.page.goto(`/queue?q=${token}`);
  await expect(agent.page.getByTestId('queue-row')).toHaveCount(3);
  await agent.page.getByLabel('Select all loaded tickets').check();
  await expect(agent.page.getByTestId('selected-count')).toContainText('3 tickets selected');
  await agent.page.locator('#bulk-select').selectOption('status:pending');
  await agent.page.getByRole('button', { name: 'Apply' }).click();

  const report = agent.page.getByTestId('bulk-report');
  await expect(report).toBeVisible();
  await expect(report.getByTestId('bulk-summary')).toContainText('2 tickets updated');
  const skipped = report.getByTestId('bulk-skipped');
  await expect(skipped).toHaveCount(1);
  await expect(skipped).toContainText(`HD-${c.number}`);
  await expect(skipped).toContainText('transition not allowed');

  for (const t of [a, b]) {
    const d = await (await agent.api.get(`/api/tickets/${t.id}`)).json();
    expect(d.ticket.status).toBe('pending');
  }
  const dc = await (await agent.api.get(`/api/tickets/${c.id}`)).json();
  expect(dc.ticket.status).toBe('resolved');
});

test('bulk action on 200 tickets with inaccessible ones reports every reason (API)', async ({
  browser,
}) => {
  const token = uniqueToken();
  const customer = await Session.open(browser, CUSTOMER(2));
  const mine: string[] = [];
  const foreign: string[] = [];
  for (let i = 0; i < 6; i++) {
    mine.push(
      (
        await createTicketViaApi(customer.api, {
          subject: `Mine ${token} ${i.toString()}`,
          category: 'billing',
        })
      ).id,
    );
    foreign.push(
      (
        await createTicketViaApi(customer.api, {
          subject: `Foreign ${token} ${i.toString()}`,
          category: 'technical',
        })
      ).id,
    );
  }
  const agent = await Session.open(browser, AGENT(1)); // billing + account only
  const missing = Array.from({ length: 5 }, () => randomUUID());
  const res = await agent.api.post('/api/tickets/bulk', {
    data: {
      ids: [...mine, ...foreign, ...missing],
      action: { type: 'priority', priority: 'high' },
    },
  });
  expect(res.status()).toBe(200);
  const body = (await res.json()) as {
    succeeded: number;
    skipped: number;
    results: { ok: boolean; reason?: string }[];
  };
  expect(body.succeeded).toBe(6);
  expect(body.results.filter((r) => r.reason === 'forbidden')).toHaveLength(6);
  expect(body.results.filter((r) => r.reason === 'not_found')).toHaveLength(5);
});

test('acceptance #13: filters live in the URL, survive reload and the Back button', async ({
  browser,
}) => {
  const agent = await Session.open(browser, AGENT(1));
  await agent.page.goto('/queue');
  await expect(agent.page.getByTestId('queue-row').first()).toBeVisible();

  await agent.page.locator('#f-status').selectOption('open');
  await expect(agent.page).toHaveURL(/status=open/);
  await agent.page.locator('#f-priority').selectOption('high');
  await expect(agent.page).toHaveURL(/priority=high/);
  await expect(agent.page).toHaveURL(/status=open/);

  await agent.page.reload();
  await expect(agent.page.locator('#f-status')).toHaveValue('open');
  await expect(agent.page.locator('#f-priority')).toHaveValue('high');
  await expect(agent.page.getByTestId('queue-row').first()).toBeVisible();

  await agent.page.goBack();
  await expect(agent.page).toHaveURL(/status=open/);
  await expect(agent.page).not.toHaveURL(/priority=high/);
  await expect(agent.page.locator('#f-priority')).toHaveValue('');
  await expect(agent.page.locator('#f-status')).toHaveValue('open');

  // search is part of the URL too
  const token = uniqueToken();
  const customer = await Session.open(browser, CUSTOMER(1));
  const ticket = await createTicketViaApi(customer.api, { subject: `Findable ${token}` });
  await agent.page.goto('/queue');
  await agent.page.getByRole('searchbox').fill(token);
  await expect(agent.page).toHaveURL(new RegExp(`q=${token}`));
  await expect(agent.page.getByTestId('queue-row')).toHaveCount(1);
  expect(ticket.number).toBeGreaterThan(1000);
});

for (const sort of ['sla', '-created'] as const) {
  test(`Enter opens the focused ticket even if a new ticket arrives (sort=${sort})`, async ({
    browser,
  }) => {
    const agent = await Session.open(browser, AGENT(1));
    await agent.page.goto(`/queue?sort=${sort}`);
    const rows = agent.page.getByTestId('queue-row');
    await expect(rows.first()).toBeVisible();
    for (let i = 0; i < 3; i++) await agent.page.keyboard.press('j');
    const focused = rows.nth(2);
    await expect(focused).toHaveAttribute('data-active', 'true');
    const id = await focused.getAttribute('data-row-id');
    const before = await rows.count();

    const customer = await Session.open(browser, CUSTOMER(1));
    const fresh = await createTicketViaApi(customer.api, {
      subject: `Arrives live ${uniqueToken()}`,
      category: 'billing',
      priority: 'urgent',
    });
    await expect(agent.page.locator(`[data-row-id="${fresh.id}"]`)).toBeVisible();
    expect(await rows.count()).toBeGreaterThan(before - 1);

    await expect(agent.page.locator(`[data-row-id="${id}"]`)).toHaveAttribute(
      'data-active',
      'true',
    );
    await agent.page.keyboard.press('Enter');
    await expect(agent.page).toHaveURL(new RegExp(`/tickets/${id}$`));
  });
}

test('keyboard shortcuts: j/k move, Enter opens, / focuses search, ? shows help', async ({
  browser,
}) => {
  const agent = await Session.open(browser, AGENT(1));
  await agent.page.goto('/queue');
  await expect(agent.page.getByTestId('queue-row').first()).toBeVisible();
  await agent.page.keyboard.press('j');
  await expect(agent.page.getByTestId('queue-row').first()).toHaveAttribute('data-active', 'true');
  await agent.page.keyboard.press('j');
  await expect(agent.page.getByTestId('queue-row').nth(1)).toHaveAttribute('data-active', 'true');
  await agent.page.keyboard.press('k');
  await expect(agent.page.getByTestId('queue-row').first()).toHaveAttribute('data-active', 'true');
  await agent.page.keyboard.press('?');
  await expect(agent.page.getByRole('dialog', { name: 'Keyboard shortcuts' })).toBeVisible();
  await agent.page.keyboard.press('Escape');
  await agent.page.keyboard.press('/');
  await expect(agent.page.getByRole('searchbox')).toBeFocused();
  // typing into the field must not trigger shortcuts
  await agent.page.keyboard.type('jk?');
  await expect(agent.page.getByRole('dialog')).toHaveCount(0);
  await agent.page.getByRole('searchbox').fill('');
  await agent.page.getByRole('searchbox').blur();
  await agent.page.keyboard.press('Enter');
  await expect(agent.page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/);
});
