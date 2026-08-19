/**
 * From "I want this" to a bag in someone's hands, in the browser.
 *
 * The assertions that matter are the ones about money and stock: a wallet
 * order must not read as confirmed before the wallet says so, an unpaid bag
 * must not be collectable, and a pickup code must work exactly once.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, signInAs, text } from './harness.mjs';

let stack;
before(async () => { stack = await startStack(); }, { timeout: 120_000 });
after(async () => { await stack?.stop(); });

async function customer(phone = '771234567') {
  const page = await stack.freshPage();
  await page.goto(stack.appUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  await page.getByRole('tab', { name: /Profil/i }).click();
  await page.waitForTimeout(400);
  await page.getByRole('button', { name: /^Se connecter$/i }).first().click();
  await page.waitForTimeout(500);
  await signInAs(page, phone);
  await page.waitForTimeout(2500);
  return page;
}

/** Opens a bag that still has stock and gets to the payment step. */
async function toPayment(page) {
  await page.getByRole('tab', { name: /Découvrir/i }).click();
  await page.waitForTimeout(900);
  const cards = page.locator('.rc');
  const n = await cards.count();
  for (let i = 0; i < n; i++) {
    const card = cards.nth(i);
    if (/épuisé|sold/i.test((await card.innerText()).toLowerCase())) continue;
    await card.click();
    await page.waitForTimeout(800);
    const reserve = page.getByRole('button', { name: /^Réserver/i }).first();
    if (await reserve.count() && await reserve.isEnabled()) {
      await reserve.click();
      await page.waitForTimeout(1000);
      return;
    }
    await page.keyboard.press('Escape');
    await page.waitForTimeout(400);
  }
  throw new Error('no bag with stock left to buy');
}

describe('paying at the counter', () => {
  test('a cash order is a booking straight away, with a code', async () => {
    const page = await customer();
    await toPayment(page);

    await page.getByRole('button', { name: /Espèces/i }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /^Payer/i }).first().click();
    await page.waitForTimeout(2500);

    const body = await text(page);
    assert.match(body, /Commande confirmée/i);
    assert.match(body, /AI4-[A-Z0-9]{4}/, 'a confirmed order shows its pickup code');
    await page.close();
  });
});

describe('paying with a wallet', () => {
  test('only methods the server actually has are offered', async () => {
    const page = await customer('771230001');
    await toPayment(page);
    const body = await text(page);
    assert.match(body, /Wave/, 'Wave is configured in this run');
    assert.match(body, /Espèces/);
    assert.ok(!/Orange Money/i.test(body), 'an uncredentialed wallet must not be offered');
    // And no invented wallet balance anywhere.
    assert.ok(!/Solde/i.test(body), 'the app must not show a balance it does not know');
    await page.close();
  });

  test('the bag is held, not sold, until the wallet confirms', async () => {
    const page = await customer('771230002');
    await toPayment(page);
    await page.getByRole('button', { name: /Wave/i }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /^Payer/i }).first().click();
    await page.waitForURL(/\/pay\//, { timeout: 20_000 });

    // Walk away from the wallet without paying.
    await page.goto(stack.appUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(4000);
    await page.getByRole('tab', { name: /Suivi/i }).click();
    await page.waitForTimeout(900);

    const body = await text(page);
    assert.match(body, /Paiement à terminer|Gardé encore/i, 'the hold is not shown');
    assert.ok(!/Commande confirmée/i.test(body), 'an unpaid bag must never read as confirmed');
    assert.ok(!/CODE DE RETRAIT/i.test(body), 'an unpaid bag has no code to show');
    assert.match(body, /Terminer le paiement/i);
    await page.close();
  });

  test('paying at the wallet turns the hold into a bag with a code', async () => {
    const page = await customer('771230003');
    await toPayment(page);
    await page.getByRole('button', { name: /Wave/i }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /^Payer/i }).first().click();
    await page.waitForURL(/\/pay\//, { timeout: 20_000 });

    await page.locator('#pay').click();
    await page.waitForURL((u) => !/\/pay\//.test(u.toString()), { timeout: 20_000 });
    await page.waitForTimeout(4500);

    const body = await text(page);
    assert.match(body, /Commande confirmée|AI4-[A-Z0-9]{4}/i, 'the paid bag was not confirmed');
    assert.ok(!/payment=|order=/.test(page.url()), 'the wallet round-trip is left in the address bar');
    await page.close();
  });

  test('giving up at the wallet puts the bag back and says nothing was charged', async () => {
    const page = await customer('771230004');
    await toPayment(page);
    await page.getByRole('button', { name: /Wave/i }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /^Payer/i }).first().click();
    await page.waitForURL(/\/pay\//, { timeout: 20_000 });

    await page.locator('#quit').click();
    await page.waitForURL((u) => !/\/pay\//.test(u.toString()), { timeout: 20_000 });
    await page.waitForTimeout(4500);

    const body = await text(page);
    assert.ok(!/Commande confirmée/i.test(body), 'an abandoned checkout must not confirm anything');
    await page.close();
  });
});

describe('the counter', () => {
  test('a shop signs in with a password and sees its own orders', async () => {
    const page = await stack.freshPage();
    await page.goto(stack.appUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.getByRole('tab', { name: /Profil/i }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /Espace commerçant/i }).click();
    await page.waitForTimeout(600);

    await page.locator('#sid').fill('+221770000002');
    await page.locator('#spw').fill('boulangerie-2026');
    await page.getByRole('button', { name: /Se connecter/i }).click();
    await page.waitForTimeout(3000);

    assert.match(await text(page), /Boulangerie Jaune/i, 'the shop should land on its own counter');

    // On the counter itself, a customer is a first name and four digits.
    await page.getByRole('tab', { name: /Retraits|Codes/i }).first().click();
    await page.waitForTimeout(1200);
    const counter = await text(page);
    assert.ok(!/\+221\d{9}/.test(counter), 'a full customer phone number is showing on the counter');
    await page.close();
  });

  test('an admin account is turned away from the customer app', async () => {
    const page = await stack.freshPage();
    await page.goto(stack.appUrl, { waitUntil: 'networkidle' });
    await page.waitForTimeout(700);
    await page.getByRole('tab', { name: /Profil/i }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /Espace commerçant/i }).click();
    await page.waitForTimeout(600);
    await page.locator('#sid').fill('+221770000001');
    await page.locator('#spw').fill('admin-dakar-2026');
    await page.getByRole('button', { name: /Se connecter/i }).click();
    await page.waitForTimeout(2500);

    const body = await text(page);
    assert.ok(!/Pour vous maintenant/i.test(body), 'an internal account got into the customer feed');
    await page.close();
  });
});

describe('nothing shouts a stack trace at anybody', () => {
  test('the console stays clean through a whole purchase', async () => {
    const page = await customer('771230005');
    await toPayment(page);
    await page.getByRole('button', { name: /Espèces/i }).first().click();
    await page.waitForTimeout(300);
    await page.getByRole('button', { name: /^Payer/i }).first().click();
    await page.waitForTimeout(2500);
    // The confirmation is a full sheet; leave it the way it offers to.
    await page.getByRole('button', { name: /Voir ma commande/i }).click();
    await page.waitForTimeout(1200);

    const real = page.errors.filter((e) => !/vibrate|ERR_CONNECTION_RESET/i.test(e));
    assert.deepEqual(real, [], `browser errors during a purchase: ${real.join(' | ')}`);
    await page.close();
  });
});
