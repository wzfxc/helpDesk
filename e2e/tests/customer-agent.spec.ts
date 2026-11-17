import {
  AGENT,
  CUSTOMER,
  Session,
  createTicketViaApi,
  expect,
  PNG_BYTES,
  postMessageViaApi,
  test,
  uniqueToken,
  uploadViaApi,
} from './fixtures';

test('acceptance #3: customer creates a ticket with an attachment, agent replies, customer sees it live', async ({
  browser,
}) => {
  const token = uniqueToken();
  const subject = `Printer ${token} is broken`;
  const reply = `We are on it ${token}`;

  const customer = await Session.open(browser, CUSTOMER(1));
  await customer.page.goto('/tickets/new');
  await customer.page.getByLabel('Subject').fill(subject);
  await customer.page.getByLabel('Category').selectOption('billing');
  await customer.page.getByLabel('Priority').selectOption('high');
  await customer.page.getByLabel('Description').fill('The printer prints blank pages');
  await customer.page
    .getByTestId('file-input')
    .setInputFiles({ name: 'photo.png', mimeType: 'image/png', buffer: PNG_BYTES });
  await expect(customer.page.getByText('photo.png')).toBeVisible();
  // wait for the upload to finish (progress disappears, submit enabled)
  const submit = customer.page.getByRole('button', { name: 'Create ticket' });
  await expect(submit).toBeEnabled();
  await submit.click();
  await expect(customer.page).toHaveURL(/\/tickets\/[0-9a-f-]{36}$/);
  const ticketUrl = customer.page.url();
  await expect(customer.page.getByRole('heading', { level: 1 })).toContainText(subject);
  await expect(customer.page.getByRole('link', { name: /photo\.png/ })).toBeVisible();
  await expect(
    customer.page.locator('main header').getByText('New', { exact: true }),
  ).toBeVisible();

  // the agent finds the ticket via search and replies in the UI
  const agent = await Session.open(browser, AGENT(1));
  await agent.page.goto(`/queue?q=${token}`);
  await agent.page.getByRole('link', { name: subject }).click();
  await expect(agent.page.getByRole('heading', { level: 1 })).toContainText(subject);
  await agent.page.locator('#composer-body').fill(reply);
  await agent.page.getByRole('button', { name: 'Send to customer' }).click();
  await expect(agent.page.getByText(reply)).toBeVisible();

  // the customer sees it without reloading, and the status changed new -> open
  await expect(customer.page.getByText(reply)).toBeVisible();
  await expect(
    customer.page.locator('main header').getByText('Open', { exact: true }),
  ).toBeVisible();
  expect(customer.page.url()).toBe(ticketUrl);
});

test('acceptance #4: internal notes and their attachments are invisible to the customer', async ({
  browser,
}) => {
  const token = uniqueToken();
  // one word that appears only in the notes (not in the subject), so a search hit would leak it
  const secret = `NOTEONLY${token}`;
  const customer = await Session.open(browser, CUSTOMER(2));
  const agent = await Session.open(browser, AGENT(1));
  const ticket = await createTicketViaApi(customer.api, { subject: `Note test ${token}` });

  await customer.page.goto(`/tickets/${ticket.id}`);
  await expect(customer.page.getByRole('heading', { level: 1 })).toContainText(token);

  // agent adds an internal note with an attachment (through the UI composer for the note)
  const upload = await uploadViaApi(agent.api, {
    name: 'internal.png',
    mimeType: 'image/png',
    buffer: PNG_BYTES,
  });
  expect(upload.status).toBe(201);
  await agent.page.goto(`/tickets/${ticket.id}`);
  await agent.page.getByRole('button', { name: 'Internal note' }).click();
  await expect(
    agent.page.getByText('Internal note — the customer will not see this'),
  ).toBeVisible();
  await agent.page.locator('#composer-body').fill(secret);
  await agent.page.getByRole('button', { name: 'Add note' }).click();
  await expect(agent.page.getByTestId('message-note').filter({ hasText: secret })).toBeVisible();
  await postMessageViaApi(agent.api, ticket.id, {
    body: `with file ${secret}`,
    internal: true,
    attachmentIds: [upload.id],
  });

  // not in the customer's open page (live) nor after reload
  await customer.page.waitForTimeout(1000);
  await expect(customer.page.getByText(secret)).toHaveCount(0);
  await customer.page.reload();
  await expect(customer.page.getByRole('heading', { level: 1 })).toContainText(token);
  await expect(customer.page.getByText(secret)).toHaveCount(0);

  // not through the API (detail, list, search) ...
  const detail = await customer.api.get(`/api/tickets/${ticket.id}`);
  expect(detail.status()).toBe(200);
  expect(await detail.text()).not.toContain(secret);
  const search = await customer.api.get(
    `/api/tickets?q=${encodeURIComponent(secret.split('-')[2] ?? '')}`,
  );
  expect(JSON.stringify(await search.json())).not.toContain(ticket.id);
  // ... nor through the note's attachment
  expect((await customer.api.get(`/api/attachments/${upload.id}`)).status()).toBe(404);
  expect((await agent.api.get(`/api/attachments/${upload.id}`)).status()).toBe(200);
});

test('acceptance #5: foreign tickets and their attachments are denied', async ({ browser }) => {
  const token = uniqueToken();
  const owner = await Session.open(browser, CUSTOMER(3));
  const other = await Session.open(browser, CUSTOMER(4));
  const wrongAgent = await Session.open(browser, AGENT(3)); // delivery + other, not billing
  const upload = await uploadViaApi(owner.api, {
    name: 'p.png',
    mimeType: 'image/png',
    buffer: PNG_BYTES,
  });
  const ticket = await createTicketViaApi(owner.api, {
    subject: `Private ${token}`,
    category: 'billing',
    attachmentIds: [upload.id],
  });

  for (const who of [other, wrongAgent]) {
    expect((await who.api.get(`/api/tickets/${ticket.id}`)).status()).toBe(404);
    expect((await who.api.get(`/api/attachments/${upload.id}`)).status()).toBe(404);
    await who.page.goto(`/tickets/${ticket.id}`);
    await expect(who.page.getByText('Ticket not found')).toBeVisible();
  }
  expect((await owner.api.get(`/api/attachments/${upload.id}`)).status()).toBe(200);
});

test('acceptance #14: disguised executables and oversized files are rejected', async ({
  browser,
}) => {
  const customer = await Session.open(browser, CUSTOMER(1));
  const exe = await uploadViaApi(customer.api, {
    name: 'cat.png',
    mimeType: 'image/png',
    buffer: Buffer.concat([Buffer.from('MZ\x90\x00', 'binary'), Buffer.alloc(300)]),
  });
  expect(exe.status).toBe(415);
  const big = await uploadViaApi(customer.api, {
    name: 'big.txt',
    mimeType: 'text/plain',
    buffer: Buffer.alloc(11 * 1024 * 1024, 0x61),
  });
  expect(big.status).toBe(413);
});
