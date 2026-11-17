import {
  AGENT,
  CUSTOMER,
  Session,
  createTicketViaApi,
  expect,
  test,
  uniqueToken,
} from './fixtures';

test('acceptance #11: resolved ticket auto-closes after 3 days and customer reply creates a linked child ticket', async ({
  browser,
}) => {
  const token = uniqueToken();
  const subject = `Lifecycle ${token}`;
  const customer = await Session.open(browser, CUSTOMER(1));
  const agent = await Session.open(browser, AGENT(1));

  const ticket = await createTicketViaApi(customer.api, { subject, category: 'billing' });
  await customer.page.goto(`/tickets/${ticket.id}`);
  await expect(customer.page.getByRole('heading', { level: 1 })).toContainText(subject);

  // Agent sends reply and marks the ticket resolved.
  await agent.page.goto(`/tickets/${ticket.id}`);
  await expect(agent.page.getByRole('heading', { level: 1 })).toContainText(subject);
  await agent.page.locator('#composer-body').fill(`Resolved reply ${token}`);
  await agent.page.getByRole('button', { name: 'Send & resolve' }).click();
  await expect(
    agent.page.locator('main header').getByText('Resolved', { exact: true }),
  ).toBeVisible();

  // Advance API clock by 4 days and trigger auto-close job via test hooks.
  try {
    const clockRes = await agent.api.post('/api/__test/clock', { data: { advanceDays: 4 } });
    expect(clockRes.status()).toBe(200);
    const jobRes = await agent.api.post('/api/__test/auto-close');
    expect(jobRes.status()).toBe(200);
    const jobBody = (await jobRes.json()) as { closed: number };
    expect(jobBody.closed).toBeGreaterThanOrEqual(1);
  } finally {
    await agent.api.post('/api/__test/clock', { data: { reset: true } });
  }

  // Closed state is reflected for the customer and edits are rejected with 422.
  await customer.page.reload();
  await expect(
    customer.page.locator('main header').getByText('Closed', { exact: true }),
  ).toBeVisible();
  await expect(
    customer.page.getByText(
      'This ticket is closed. A reply will create a new ticket linked to it.',
    ),
  ).toBeVisible();

  const detailRes = await agent.api.get(`/api/tickets/${ticket.id}`);
  expect(detailRes.status()).toBe(200);
  const detail = (await detailRes.json()) as { ticket: { status: string; version: number } };
  expect(detail.ticket.status).toBe('closed');

  const closedPatch = await agent.api.patch(`/api/tickets/${ticket.id}`, {
    data: { priority: 'urgent', version: detail.ticket.version },
  });
  expect(closedPatch.status()).toBe(422);
  const closedPatchBody = (await closedPatch.json()) as { error: { code: string } };
  expect(closedPatchBody.error.code).toBe('ticket_closed');

  // Customer sends a follow-up reply -> navigates to a linked child ticket.
  const followUpText = `Still seeing the same issue ${token}`;
  await customer.page.locator('#composer-body').fill(followUpText);
  await customer.page.getByRole('button', { name: 'Send to customer' }).click();

  await expect(customer.page).toHaveURL(new RegExp(`/tickets/(?!${ticket.id})[0-9a-f-]{36}$`));
  await expect(
    customer.page.locator('main header').getByText('New', { exact: true }),
  ).toBeVisible();
  await expect(
    customer.page.getByRole('link', { name: `Follow-up of HD-${ticket.number}` }),
  ).toBeVisible();
  await expect(customer.page.getByText(followUpText)).toBeVisible();

  const childId = customer.page.url().split('/').pop();
  expect(childId).toBeTruthy();
  const childRes = await customer.api.get(`/api/tickets/${childId}`);
  expect(childRes.status()).toBe(200);
  const childDetail = (await childRes.json()) as {
    ticket: { parentTicketId: string | null; parentTicketNumber: number | null; status: string };
  };
  expect(childDetail.ticket.status).toBe('new');
  expect(childDetail.ticket.parentTicketId).toBe(ticket.id);
  expect(childDetail.ticket.parentTicketNumber).toBe(ticket.number);
});
