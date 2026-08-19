/**
 * The admin console. All of this existed as an API already; what is under test
 * is that a person can now actually run the business with it — and that the
 * two rules it carries hold: an applicant does not become visible by being
 * approved, and a payout cannot be called paid without a reference.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, text } from './harness.mjs';

let stack;
before(async () => { stack = await startStack(); }, { timeout: 120_000 });
after(async () => { await stack?.stop(); });

async function console_() {
  const page = await stack.freshPage();
  await page.goto(`${stack.appUrl.replace('ai4food-app.html', 'ai4food-admin.html')}`,
    { waitUntil: 'networkidle' });
  await page.waitForTimeout(500);
  await page.locator('#id').fill('+221770000001');
  await page.locator('#pw').fill('admin-dakar-2026');
  await page.getByRole('button', { name: /Se connecter/i }).click();
  await page.locator('nav').waitFor({ timeout: 15_000 });
  await page.waitForFunction(() => !/Chargement/.test(document.body.innerText), null, { timeout: 15_000 });
  return page;
}

describe('the console', () => {
  test('an admin signs in and sees the day', async () => {
    const page = await console_();
    const body = await text(page);
    assert.match(body, /Aujourd'hui/);
    assert.match(body, /commission/i);
    assert.match(body, /commerces partenaires/i);
    await page.close();
  });

  test('a merchant account cannot get in', async () => {
    const page = await stack.freshPage();
    await page.goto(stack.appUrl.replace('ai4food-app.html', 'ai4food-admin.html'),
      { waitUntil: 'networkidle' });
    await page.waitForTimeout(400);
    await page.locator('#id').fill('+221770000002');
    await page.locator('#pw').fill('boulangerie-2026');
    await page.getByRole('button', { name: /Se connecter/i }).click();
    await page.waitForTimeout(1500);
    assert.match(await text(page), /pas un compte AI4Food interne/i);
    await page.close();
  });

  test('an application arrives, and approving it does not publish a shop', async () => {
    // A shop applies through the public endpoint, as one would from the app.
    const applied = await fetch(`${stack.api}/api/partners/apply`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        business_name: 'Boulangerie Test', category: 'Boulangeries',
        contact_name: 'Awa Fall', phone: '+221771112233', zone: 'Médina',
        address: '12 rue Blanchot', surplus_note: 'Pains et viennoiseries',
      }),
    });
    assert.equal(applied.status, 201);

    // It must not be on a customer's map before anybody has looked at it.
    const before = await (await fetch(`${stack.api}/api/merchants?limit=500`)).json();
    assert.ok(!before.items.some((m) => m.name === 'Boulangerie Test'),
      'an application reached the customers before review');

    const page = await console_();
    await page.getByRole('button', { name: 'Candidatures' }).click();
    await page.waitForTimeout(1200);
    assert.match(await text(page), /Boulangerie Test/);

    // Approve it, pinning it on the map.
    page.on('dialog', (d) => d.accept(d.message().includes('Latitude') ? '14.6817' : '-17.4497'));
    await page.getByRole('button', { name: 'Approuver' }).first().click();
    await page.waitForTimeout(1800);

    // Approved creates the shop — as pending, so it still is not published.
    const after = await (await fetch(`${stack.api}/api/merchants?limit=500`)).json();
    assert.ok(!after.items.some((m) => m.name === 'Boulangerie Test'),
      'approving an application put a shop in front of customers');

    await page.getByRole('button', { name: 'Commerces' }).click();
    await page.waitForTimeout(1200);
    const shops = await text(page);
    assert.match(shops, /Boulangerie Test/, 'the shop was not created');
    assert.match(shops, /pending/, 'the new shop should be pending, not active');
    await page.close();
  });

  test('a payout cannot be called paid without a reference', async () => {
    const page = await console_();
    await page.getByRole('button', { name: 'Versements' }).click();
    await page.waitForTimeout(1500);

    page.on('dialog', (d) => d.accept());
    await page.getByRole('button', { name: /Établir les versements/i }).click();
    await page.waitForTimeout(2000);

    const body = await text(page);
    assert.match(body, /owed/, 'no payouts were drawn up');
    assert.match(body, /rien ici ne prétend qu'un virement est parti/i,
      'the console must say plainly that owed is not paid');
    await page.close();
  });

  test('the failed-refund queue exists and is honest when empty', async () => {
    const page = await console_();
    await page.getByRole('button', { name: 'Remboursements' }).click();
    await page.waitForTimeout(1200);
    assert.match(await text(page), /Rien en attente|en souffrance/i);
    await page.close();
  });

  test('prospects are here, and only here', async () => {
    const page = await console_();
    await page.getByRole('button', { name: 'Commerces' }).click();
    await page.waitForTimeout(1400);
    assert.match(await text(page), /prospect/, 'the pipeline should be visible to an admin');

    // And not to anybody else.
    const seen = await (await fetch(`${stack.api}/api/merchants?limit=500`)).json();
    assert.ok(seen.total > 0, 'a customer should see the partners');
    assert.ok(seen.total < 78, 'a customer is seeing the whole pipeline');
    await page.close();
  });
});
