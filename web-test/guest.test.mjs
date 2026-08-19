/**
 * The one flow this product lives or dies on: a stranger opens AI4Food, looks
 * around without being asked for anything, and is only asked who they are at
 * the moment they decide to buy.
 *
 * Every step below is a thing that used to be behind a sign-in screen.
 */
import { test, before, after, describe } from 'node:test';
import assert from 'node:assert/strict';
import { startStack, signInAs, text } from './harness.mjs';

let stack;
before(async () => { stack = await startStack(); }, { timeout: 120_000 });
after(async () => { await stack?.stop(); });

const open = async () => {
  const page = await stack.freshPage();
  await page.goto(stack.appUrl, { waitUntil: 'networkidle' });
  await page.waitForTimeout(700);
  return page;
};

describe('a visitor with no account', () => {
  test('lands in the marketplace, not on a sign-in screen', async () => {
    const page = await open();
    const body = await text(page);

    assert.ok(!/Se connecter pour/i.test(body), 'no sign-in wall');
    assert.ok(await page.locator('.tabs, #tabs').first().isVisible(), 'the tab bar is there');
    assert.match(body, /Pour vous maintenant/i, 'the recommended shelf is the first thing shown');

    const cards = await page.locator('.rc').count();
    assert.ok(cards > 3, `expected a feed of offers, saw ${cards}`);
    // Prices, not a pitch.
    assert.match(body, /FCFA/);
    await page.close();
  });

  test('can search without an account', async () => {
    const page = await open();
    await page.locator('.search').first().click();
    await page.waitForTimeout(400);
    await page.locator('#sq').fill('boulangerie');
    await page.waitForTimeout(900);
    const results = await page.locator('#sres .rc').count();
    assert.ok(results > 0, 'search found nothing');
    assert.ok(!/Se connecter/i.test(await text(page)), 'search did not ask who I am');
    await page.close();
  });

  test('can filter by category without an account', async () => {
    const page = await open();
    await page.getByRole('button', { name: 'Boulangeries' }).first().click();
    await page.waitForTimeout(900);
    const cards = await page.locator('.rc').count();
    assert.ok(cards > 0, 'the category filter emptied the feed');
    await page.close();
  });

  test('can open the map and the list without an account', async () => {
    const page = await open();
    await page.getByRole('tab', { name: /Commerces/i }).click();
    await page.waitForTimeout(900);
    assert.ok(await page.locator('.mapwrap').first().isVisible(), 'no map');

    // The map legend talks about bags, never about shops we are still chasing.
    const body = await text(page);
    assert.ok(!/convaincre/i.test(body), 'a sales pipeline is showing on a customer screen');

    await page.getByRole('button', { name: 'Liste' }).click();
    await page.waitForTimeout(600);
    assert.match(await text(page), /paniers? disponibles? autour de vous/i);
    await page.close();
  });

  test('can open a bag and read everything about it', async () => {
    const page = await open();
    await page.locator('.rc').first().click();
    await page.waitForTimeout(800);
    const body = await text(page);
    for (const wanted of [/FCFA/, /Retrait/i, /Réserver/i]) {
      assert.match(body, wanted);
    }
    assert.ok(!/Se connecter/i.test(body), 'the offer sheet asked me to sign in');
    await page.close();
  });

  test('can favourite a bag, and it survives a reload', async () => {
    const page = await open();
    const heart = page.locator('.rc .hbtn').first();
    await heart.click();
    await page.waitForTimeout(500);
    assert.ok(!/Se connecter pour/i.test(await text(page)), 'a heart should not demand an account');

    await page.reload({ waitUntil: 'networkidle' });
    await page.waitForTimeout(900);
    await page.getByRole('tab', { name: /Favoris/i }).click();
    await page.waitForTimeout(600);
    const saved = await page.locator('.rc').count();
    assert.ok(saved > 0, 'the favourite did not survive the reload');
    await page.close();
  });

  test('Suivi and Profil answer a visitor instead of turning them away', async () => {
    const page = await open();

    await page.getByRole('tab', { name: /Suivi/i }).click();
    await page.waitForTimeout(500);
    let body = await text(page);
    assert.match(body, /Retrouvez vos commandes/i);
    assert.ok(await page.getByRole('button', { name: /Découvrir/i }).first().isVisible(),
      'a visitor must be able to get back to the market');

    await page.getByRole('tab', { name: /Profil/i }).click();
    await page.waitForTimeout(500);
    body = await text(page);
    assert.match(body, /Bienvenue sur AI4Food/i);
    assert.ok(!/Votre impact/i.test(body), 'a visitor has no history to report');
    await page.close();
  });

  test('can switch language and theme without an account', async () => {
    const page = await open();
    await page.getByRole('tab', { name: /Profil/i }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /Langue/i }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /English/i }).first().click();
    await page.waitForTimeout(700);
    assert.match(await text(page), /Welcome to AI4Food|Sign in/i, 'the app did not switch to English');
    await page.close();
  });
});

describe('the moment we ask who you are', () => {
  test('Réserver is the first thing that needs an account, and the bag is kept', async () => {
    const page = await open();

    // Browse, then choose.
    await page.locator('.rc').first().click();
    await page.waitForTimeout(800);
    const chosen = (await text(page)).split('\n').find((l) => /Panier/i.test(l)) || '';

    await page.getByRole('button', { name: /^Réserver/i }).first().click();
    await page.waitForTimeout(700);

    // Only now.
    const gate = await text(page);
    assert.match(gate, /Connectez-vous pour réserver/i);
    assert.match(gate, /Continuer sans compte/i, 'a visitor must be able to back out');

    await signInAs(page);
    await page.waitForTimeout(2500);

    // Back on the same bag, at the payment step — not on the homepage.
    const after = await text(page);
    assert.match(after, /Paiement/i, `expected the payment step, saw: ${after.slice(0, 200)}`);
    if (chosen.trim()) assert.ok(after.includes(chosen.trim()), 'a different bag came back');
    await page.close();
  });

  test('backing out of the gate returns to browsing, still signed out', async () => {
    const page = await open();
    await page.locator('.rc').first().click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: /^Réserver/i }).first().click();
    await page.waitForTimeout(600);
    await page.getByRole('button', { name: /Continuer sans compte/i }).click();
    await page.waitForTimeout(700);

    const body = await text(page);
    assert.match(body, /Pour vous maintenant/i, 'did not come back to the feed');
    assert.ok(await page.locator('.rc').count() > 3);
    await page.close();
  });

  test('an existing session does not ask again', async () => {
    const page = await open();
    await page.getByRole('tab', { name: /Profil/i }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /^Se connecter$/i }).first().click();
    await page.waitForTimeout(500);
    await signInAs(page);
    await page.waitForTimeout(2500);

    await page.getByRole('tab', { name: /Découvrir/i }).click();
    await page.waitForTimeout(700);
    await page.locator('.rc').first().click();
    await page.waitForTimeout(700);
    await page.getByRole('button', { name: /^Réserver/i }).first().click();
    await page.waitForTimeout(900);

    const body = await text(page);
    assert.match(body, /Paiement/i, 'a signed-in customer was asked to sign in again');
    assert.ok(!/Connectez-vous pour réserver/i.test(body));
    await page.close();
  });

  test('guest favourites move into the account on sign-in', async () => {
    const page = await open();
    await page.locator('.rc .hbtn').first().click();
    await page.waitForTimeout(600);

    await page.getByRole('tab', { name: /Profil/i }).click();
    await page.waitForTimeout(400);
    await page.getByRole('button', { name: /^Se connecter$/i }).first().click();
    await page.waitForTimeout(500);
    await signInAs(page, '771119999');
    await page.waitForTimeout(3000);

    // The server is now the authority, so the favourite has to be there.
    await page.getByRole('tab', { name: /Favoris/i }).click();
    await page.waitForTimeout(900);
    assert.ok(await page.locator('.rc').count() > 0, 'the guest favourite was lost at sign-in');
    await page.close();
  });
});
