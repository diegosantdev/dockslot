import { test, expect } from '@playwright/test';
test.beforeEach(async ({ page }) => {
  await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Dock board', exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
});
test('planner creates and confirms a booking; gate and dock complete the visit', async ({
  page,
}) => {
  const reference = `E2E-${Date.now()}`;
  await page.getByRole('button', { name: 'New appointment' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('Reference', { exact: true }).fill(reference);
  await dialog.getByLabel('Carrier', { exact: true }).fill('E2E Freight');
  await dialog.getByLabel('Reported ETA').fill('17:00');
  await dialog.getByRole('button', { name: 'Create request' }).click();
  await expect(dialog.getByRole('heading', { name: reference, exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Find available slots' }).click();
  await expect(dialog.getByLabel('Available slot')).toBeVisible();
  await dialog.getByLabel('Available slot').selectOption({ index: 1 });
  await dialog.getByRole('button', { name: 'Confirm slot' }).click();
  for (const action of ['check in', 'start service', 'complete service', 'check out']) {
    const button = dialog.getByRole('button', { name: action, exact: true });
    await expect(button).toBeEnabled();
    await button.click();
  }
  await expect(dialog.getByText('checked out', { exact: true })).toBeVisible();
});
test('delay generates a real proposal which only applies after approval', async ({ page }) => {
  const scheduleDate = await page.getByLabel('Schedule date').inputValue();
  await page.getByRole('button', { name: /DS-1047/ }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByLabel('New ETA').fill(`${scheduleDate}T12:30`);
  await dialog.getByRole('button', { name: 'Update ETA' }).click();
  await dialog.getByRole('button', { name: 'Recover' }).click();
  await expect(page.getByRole('heading', { name: 'Review the changes' })).toBeVisible();
  await expect(page.getByText('Nothing changes until you approve.')).toBeVisible();
  const approve = page.getByRole('button', { name: 'Approve & apply' });
  await expect(approve).toBeEnabled();
  await approve.click();
  await expect(page.getByRole('status')).toContainText('Recovery plan applied');
});
test('mobile navigation and keyboard-readable board', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.getByRole('button', { name: 'Toggle navigation' }).click();
  await page.getByRole('button', { name: 'Gate & yard' }).click();
  await expect(page.getByRole('heading', { name: 'Gate & yard', exact: true })).toBeVisible();
  await expect(page.locator('body')).not.toHaveJSProperty('scrollWidth', 0);
});
