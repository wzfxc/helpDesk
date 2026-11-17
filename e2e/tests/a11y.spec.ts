import AxeBuilder from '@axe-core/playwright';
import type { Page } from '@playwright/test';
import {
  AGENT,
  BASE_URL,
  CUSTOMER,
  LEAD,
  Session,
  createTicketViaApi,
  expect,
  test,
  uniqueToken,
} from './fixtures';

async function expectNoAxeViolations(page: Page, contextLabel: string): Promise<void> {
  const results = await new AxeBuilder({ page })
    .withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa'])
    .analyze();
  expect(results.violations, `axe violations on ${contextLabel}`).toEqual([]);
}

for (const colorScheme of ['light', 'dark'] as const) {
  test(`axe accessibility check (${colorScheme}): login & customer pages`, async ({ browser }) => {
    const anonCtx = await browser.newContext({
      baseURL: BASE_URL,
      colorScheme,
    });
    await anonCtx.addCookies([{ name: 'locale', value: 'en', url: BASE_URL }]);
    try {
      const loginPage = await anonCtx.newPage();
      await loginPage.goto('/login');
      await expect(loginPage.getByRole('heading', { level: 1, name: 'Sign in' })).toBeVisible();
      await expectNoAxeViolations(loginPage, `/login (${colorScheme})`);
    } finally {
      await anonCtx.close();
    }

    const customer = await Session.open(browser, CUSTOMER(1), { colorScheme });
    const ticket = await createTicketViaApi(customer.api, {
      subject: `Axe customer ${uniqueToken()}`,
    });

    await customer.page.goto('/tickets');
    await expect(
      customer.page.getByRole('heading', { level: 1, name: 'My tickets' }),
    ).toBeVisible();
    await expectNoAxeViolations(customer.page, `/tickets (${colorScheme})`);

    await customer.page.goto('/tickets/new');
    await expect(
      customer.page.getByRole('heading', { level: 1, name: 'New ticket' }),
    ).toBeVisible();
    await expectNoAxeViolations(customer.page, `/tickets/new (${colorScheme})`);

    await customer.page.goto(`/tickets/${ticket.id}`);
    await expect(customer.page.getByRole('heading', { level: 1 })).toContainText(
      `HD-${ticket.number}`,
    );
    await expect(customer.page.locator('#composer-body')).toBeVisible();
    await expectNoAxeViolations(customer.page, `/tickets/[id] customer (${colorScheme})`);
  });

  test(`axe accessibility check (${colorScheme}): agent & lead pages`, async ({ browser }) => {
    const customer = await Session.open(browser, CUSTOMER(2), { colorScheme });
    const ticket = await createTicketViaApi(customer.api, {
      subject: `Axe agent ${uniqueToken()}`,
      category: 'billing',
    });

    const agent = await Session.open(browser, AGENT(1), { colorScheme });
    await agent.page.goto('/queue');
    await expect(agent.page.getByTestId('queue-row').first()).toBeVisible();
    await expectNoAxeViolations(agent.page, `/queue (${colorScheme})`);

    await agent.page.goto(`/tickets/${ticket.id}`);
    await expect(agent.page.locator('#composer-body')).toBeVisible();
    await expectNoAxeViolations(agent.page, `/tickets/[id] agent (${colorScheme})`);

    const lead = await Session.open(browser, LEAD, { colorScheme });
    await lead.page.goto('/lead');
    await expect(lead.page.getByTestId('stat-created')).toBeVisible();
    await expectNoAxeViolations(lead.page, `/lead (${colorScheme})`);

    await lead.page.goto('/lead/settings');
    await expect(lead.page.locator('#sla-first-low')).toBeVisible();
    await expectNoAxeViolations(lead.page, `/lead/settings (${colorScheme})`);
  });
}
