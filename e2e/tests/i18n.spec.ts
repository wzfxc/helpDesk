import {
  AGENT,
  CUSTOMER,
  Session,
  createTicketViaApi,
  expect,
  test,
  uniqueToken,
} from './fixtures';

test('i18n: uk/en locale switching, pluralization, relative time and composer focus', async ({
  browser,
}) => {
  const token = uniqueToken();
  const customer = await Session.open(browser, CUSTOMER(1));
  const t1 = await createTicketViaApi(customer.api, { subject: `I18n ${token} 1` });
  await createTicketViaApi(customer.api, { subject: `I18n ${token} 2` });

  const agent = await Session.open(browser, AGENT(1));
  await agent.page.goto(`/queue?q=${token}`);
  await expect(agent.page.getByRole('heading', { level: 1 })).toHaveText('Ticket queue');
  await expect(agent.page.locator('html')).toHaveAttribute('lang', 'en');

  // Switch to Ukrainian and verify persistence across reload
  await agent.page.locator('#lang-select').selectOption('uk');
  await expect(agent.page.locator('html')).toHaveAttribute('lang', 'uk');
  await expect(agent.page.getByRole('heading', { level: 1 })).toHaveText('Черга заявок');
  await agent.page.reload();
  await expect(agent.page.locator('html')).toHaveAttribute('lang', 'uk');
  await expect(agent.page.getByRole('heading', { level: 1 })).toHaveText('Черга заявок');

  // Relative time uses localized Ukrainian strings
  const rowTimes = agent.page.getByTestId('queue-row').first().locator('time');
  await expect(rowTimes.first()).toContainText(/тому|зараз|хв|год|с/);

  // Ukrainian plural forms: 1 -> заявку, 2 -> заявки
  const rows = agent.page.getByTestId('queue-row');
  await expect(rows).toHaveCount(2);
  await rows.first().getByRole('checkbox').check();
  await expect(agent.page.getByTestId('selected-count')).toContainText('Обрано 1 заявку');
  await agent.page.getByLabel('Обрати всі завантажені заявки').check();
  await expect(agent.page.getByTestId('selected-count')).toContainText('Обрано 2 заявки');

  // Open ticket in uk locale, send via button click and confirm focus returns to composer
  await agent.page.goto(`/tickets/${t1.id}`);
  await expect(agent.page.getByRole('button', { name: 'Надіслати клієнту' })).toBeVisible();
  const composer = agent.page.locator('#composer-body');
  await composer.fill(`Ukrainian reply ${token}`);
  await agent.page.getByRole('button', { name: 'Надіслати клієнту' }).click();
  await expect(agent.page.getByText(`Ukrainian reply ${token}`)).toBeVisible();
  await expect(composer).toBeFocused();

  // Switch back to English
  await agent.page.locator('#lang-select').selectOption('en');
  await expect(agent.page.locator('html')).toHaveAttribute('lang', 'en');
  await expect(agent.page.getByRole('button', { name: 'Send to customer' })).toBeVisible();
});

