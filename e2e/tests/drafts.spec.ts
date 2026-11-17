import { CUSTOMER, Session, createTicketViaApi, expect, test, uniqueToken } from './fixtures';

test('acceptance #15: new ticket draft survives a reload', async ({ browser }) => {
  const customer = await Session.open(browser, CUSTOMER(1));
  await customer.page.goto('/tickets/new');
  await customer.page.getByLabel('Subject').fill('Half written subject');
  await customer.page.getByLabel('Description').fill('Half written description');
  await customer.page.getByLabel('Category').selectOption('delivery');
  await customer.page.waitForTimeout(700); // debounce
  await customer.page.reload();
  await expect(customer.page.getByLabel('Subject')).toHaveValue('Half written subject');
  await expect(customer.page.getByLabel('Description')).toHaveValue('Half written description');
  await expect(customer.page.getByLabel('Category')).toHaveValue('delivery');
});

test('acceptance #15: unsent reply draft survives a reload and is cleared after sending', async ({
  browser,
}) => {
  const token = uniqueToken();
  const customer = await Session.open(browser, CUSTOMER(1));
  const ticket = await createTicketViaApi(customer.api, { subject: `Draft ${token}` });
  await customer.page.goto(`/tickets/${ticket.id}`);
  await customer.page.locator('#composer-body').fill(`unfinished reply ${token}`);
  await customer.page.waitForTimeout(700);
  await customer.page.reload();
  await expect(customer.page.locator('#composer-body')).toHaveValue(`unfinished reply ${token}`);

  await customer.page.getByRole('button', { name: 'Send to customer' }).click();
  await expect(
    customer.page.getByTestId('message').filter({ hasText: `unfinished reply ${token}` }),
  ).toHaveCount(1);
  await expect(customer.page.locator('#composer-body')).toHaveValue('');
  await customer.page.reload();
  await expect(customer.page.locator('#composer-body')).toHaveValue('');
});

test('acceptance #8 (UI): the reply editor keeps one clientMessageId for a draft', async ({
  browser,
}) => {
  const token = uniqueToken();
  const customer = await Session.open(browser, CUSTOMER(1));
  const ticket = await createTicketViaApi(customer.api, { subject: `Draft id ${token}` });
  await customer.page.goto(`/tickets/${ticket.id}`);
  await customer.page.locator('#composer-body').fill(`x ${token}`);
  await customer.page.waitForTimeout(700);
  const ids = await customer.page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([k]) => k.startsWith('draft:'))
      .map(([, v]) => (JSON.parse(v) as { clientMessageId: string }).clientMessageId),
  );
  expect(ids).toHaveLength(1);
  expect(ids[0]).toMatch(/^[0-9a-f-]{36}$/);
  await customer.page.reload();
  const again = await customer.page.evaluate(() =>
    Object.entries(localStorage)
      .filter(([k]) => k.startsWith('draft:'))
      .map(([, v]) => (JSON.parse(v) as { clientMessageId: string }).clientMessageId),
  );
  expect(again).toEqual(ids);
});
