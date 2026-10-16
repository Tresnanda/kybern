export const screens = {
  'dock7b-explorer': async page => {
    await page.getByText('Dock7 claude-code', { exact: true }).first().click()
    if (!await page.getByRole('button', { name: 'Add panel', exact: true }).count()) await page.keyboard.press('Meta+j')
    await page.getByRole('button', { name: 'Add panel', exact: true }).click()
    await page.getByRole('menuitem', { name: /^Explorer/ }).click()
    for (const name of ['src', 'components', 'kit']) await page.getByRole('treeitem', { name, exact: true }).click()
    await page.getByRole('treeitem', { name: 'theme.ts', exact: true }).click()
    await page.locator('pre').filter({ hasText: 'export const example' }).first().waitFor()
  },
}
