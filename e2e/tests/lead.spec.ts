import { AGENT, LEAD, Session, expect, test, uniqueToken } from './fixtures';

test('lead dashboard displays stats for period and agent workload', async ({ browser }) => {
  const lead = await Session.open(browser, LEAD);
  await lead.page.goto('/lead');
  await expect(lead.page.getByRole('heading', { level: 1, name: 'Dashboard' })).toBeVisible();
  await expect(lead.page.getByTestId('stat-created')).not.toBeEmpty();
  await expect(lead.page.getByTestId('stat-resolved')).not.toBeEmpty();
  await expect(lead.page.getByTestId('agent-workload-row').first()).toBeVisible();

  const statsRes = lead.page.waitForResponse(
    (r) => r.url().includes('/api/stats?') && r.status() === 200,
  );
  await lead.page.getByRole('button', { name: '7 days' }).click();
  expect((await statsRes).status()).toBe(200);
});

test('lead settings updates SLA policies and manages canned responses CRUD', async ({
  browser,
}) => {
  const token = uniqueToken();
  const lead = await Session.open(browser, LEAD);
  await lead.page.goto('/lead/settings');
  await expect(lead.page.getByRole('heading', { level: 1, name: 'Settings' })).toBeVisible();

  // SLA policy update and restore
  const lowFirst = lead.page.locator('#sla-first-low');
  await expect(lowFirst).toHaveValue('1080');
  await lowFirst.fill('1000');
  await lead.page
    .locator('section', { hasText: 'SLA policies' })
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(lead.page.getByText('Saved')).toBeVisible();
  await lead.page.reload();
  await expect(lead.page.locator('#sla-first-low')).toHaveValue('1000');
  await lead.page.locator('#sla-first-low').fill('1080');
  await lead.page
    .locator('section', { hasText: 'SLA policies' })
    .getByRole('button', { name: 'Save' })
    .click();
  await expect(lead.page.getByText('Saved')).toBeVisible();

  // Canned response create, edit, delete
  const title = `Template ${token}`;
  const updatedTitle = `Updated ${token}`;
  await lead.page.locator('#canned-title').fill(title);
  await lead.page.locator('#canned-category').selectOption('billing');
  await lead.page.locator('#canned-body').fill(`Hello {{customerName}} (${token})`);
  await lead.page.getByRole('button', { name: 'Add template' }).click();

  const item = lead.page.getByTestId('canned-item').filter({ hasText: title });
  await expect(item).toBeVisible();
  await item.getByRole('button', { name: 'Edit' }).click();
  await lead.page.locator('#canned-title').fill(updatedTitle);
  await lead.page
    .locator('section', { hasText: 'Canned responses' })
    .getByRole('button', { name: 'Save' })
    .click();

  const updatedItem = lead.page.getByTestId('canned-item').filter({ hasText: updatedTitle });
  await expect(updatedItem).toBeVisible();
  await updatedItem.getByRole('button', { name: 'Delete' }).click();
  await expect(updatedItem).toHaveCount(0);
});

test('non-lead user is redirected away from /lead', async ({ browser }) => {
  const agent = await Session.open(browser, AGENT(1));
  await agent.page.goto('/lead');
  await expect(agent.page).toHaveURL(/\/queue$/);
});
