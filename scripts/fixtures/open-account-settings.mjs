/** Follow the real account menu, rather than assuming Settings is a sidebar button. */
export async function openAccountSettings(page, { legacy = false } = {}) {
  if (legacy) {
    await page.getByRole('button', { name: 'Settings', exact: true }).click()
    return
  }
  await page.getByRole('button', { name: 'Account & settings', exact: true }).click()
  await page.getByRole('menuitem', { name: 'Settings', exact: true }).click()
}
