import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

function loadPlaywright() {
  try {
    return createRequire(import.meta.url)('playwright');
  } catch (localError) {
    const moduleRoot = process.env.FDB_NODE_MODULES;
    if (!moduleRoot) {
      throw new Error('Install Playwright locally or set FDB_NODE_MODULES to a node_modules directory.', { cause: localError });
    }
    return createRequire(path.join(moduleRoot, 'package.json'))('playwright');
  }
}

const chromeCandidates = [
  process.env.FDB_CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium'
].filter(Boolean);
const executablePath = chromeCandidates.find((candidate) => fs.existsSync(candidate));
if (!executablePath) throw new Error('Set FDB_CHROME_PATH to an installed Chrome or Edge executable.');

const { chromium } = loadPlaywright();

const browser = await chromium.launch({
  headless: true,
  executablePath
});
const page = await browser.newPage();

try {
  await page.setContent(`<!doctype html>
    <html><body>
      <main><h1>Testovací příspěvek</h1></main>
      <div id="post-dialog" role="dialog" aria-label="Příspěvek" style="width: 900px; min-height: 700px">
        <a href="https://www.facebook.com/page-owner">Autor stránky</a>
        <a href="https://www.facebook.com/wrong-commenter">Komentující mimo reakce</a>
        <div id="reactions-dialog" role="dialog" aria-label="Lidé, kteří zareagovali" style="width: 500px; min-height: 300px">
          <div role="tablist">
            <button role="tab" aria-label="Zobrazit všechny lidi, kteří zareagovali">Vše</button>
            <button role="tab" aria-selected="true" aria-label="Zobrazit 2 lidi, kteří zareagovali pomocí Haha">2</button>
          </div>
          <div class="profile-row" style="display:flex; width:450px; height:52px">
            <a href="https://www.facebook.com/alice"><svg role="img" aria-label="Alice Example" width="40" height="40"></svg></a>
            <img data-reaction src="https://scontent.example.fbcdn.net/reactions/haha.png" alt="" style="width:16px; height:16px">
            <a href="https://www.facebook.com/alice">Alice Example</a>
            <button>Přidat přítele</button>
          </div>
          <div class="profile-row" style="display:flex; width:450px; height:52px">
            <a href="https://www.facebook.com/profile.php?id=12345"><svg role="img" aria-label="Bob Example" width="40" height="40"></svg></a>
            <img data-reaction src="https://scontent.example.fbcdn.net/reactions/haha.png" alt="" style="width:16px; height:16px">
            <a href="https://www.facebook.com/profile.php?id=12345">Bob Example</a>
            <button>Přidat přítele</button>
          </div>
          <a href="https://www.facebook.com/groups/not-a-profile">Skupina</a>
          <a href="https://www.facebook.com/alice/posts/12345">Příspěvek Alice</a>
        </div>
      </div>
    </body></html>`);

  await page.evaluate(() => {
    const values = new Map();
    window.__FDB_TESTING__ = true;
    window.GM_getValue = (key, fallback) => values.has(key) ? values.get(key) : fallback;
    window.GM_setValue = (key, value) => values.set(key, structuredClone(value));
    window.GM_deleteValue = (key) => values.delete(key);
    window.GM_addStyle = (css) => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    };
    window.GM_registerMenuCommand = () => {};
  });

  await page.addScriptTag({ content: fs.readFileSync('facebook-reaction-blocker.user.js', 'utf8') });
  await page.locator('#fdb-panel').waitFor();
  const selectedDialogId = await page.evaluate(() => window.__FDB_INTERNALS__.findReactionDialog()?.id);
  if (selectedDialogId !== 'reactions-dialog') {
    throw new Error(`Expected the nested reaction dialog, got: ${selectedDialogId}`);
  }
  const fixtureUrls = await page.locator('[role="dialog"] a').evaluateAll((anchors) => anchors.map((anchor) => ({
    href: anchor.href,
    cleaned: window.__FDB_INTERNALS__.cleanProfileUrl(anchor.href),
    hostAccepted: /(^|\.)facebook\.com$/i.test(new URL(anchor.href).hostname),
    rect: anchor.getBoundingClientRect().toJSON()
  })));
  if (!fixtureUrls.some((item) => item.hostAccepted)) {
    throw new Error(`Fixture links were not recognized as Facebook URLs: ${JSON.stringify(fixtureUrls)}`);
  }
  await page.locator('#fdb-scan').click();
  await page.waitForFunction(() => {
    const notice = document.querySelector('#fdb-notice');
    return notice && !notice.textContent.includes('Načítám');
  }, { timeout: 10000 });
  const scanNotice = await page.locator('#fdb-notice').innerText();
  if (!scanNotice.includes('Hotovo: 2 profilů včetně ikon reakcí.')) {
    const urlError = await page.evaluate(() => window.__FDB_LAST_URL_ERROR__);
    throw new Error(`Unexpected scan result: ${scanNotice}; urlError=${urlError}; fixture=${JSON.stringify(fixtureUrls)}`);
  }

  const rows = page.locator('#fdb-list .fdb-row');
  if (await rows.count() !== 2) throw new Error(`Expected 2 queued profiles, got ${await rows.count()}`);
  if (!await rows.nth(0).innerText().then((text) => text.includes('Alice Example'))) {
    throw new Error('The text profile name should win over the image alt text.');
  }
  const queuedText = await rows.allTextContents();
  if (queuedText.some((text) => /Autor stránky|Komentující mimo reakce/.test(text))) {
    throw new Error(`Profiles from the parent post dialog leaked into the reaction queue: ${queuedText.join(', ')}`);
  }
  const renderedIcons = page.locator('#fdb-list .fdb-reaction-icon');
  if (await renderedIcons.count() !== 2) {
    throw new Error(`Expected 2 rendered reaction icons, got ${await renderedIcons.count()}`);
  }
  const iconSources = await renderedIcons.evaluateAll((icons) => icons.map((icon) => icon.getAttribute('src')));
  if (iconSources.some((src) => src !== 'https://scontent.example.fbcdn.net/reactions/haha.png')) {
    throw new Error(`Unexpected reaction icon sources: ${JSON.stringify(iconSources)}`);
  }
  const unsafeIconAccepted = await page.evaluate(() =>
    window.__FDB_INTERNALS__.safeReactionIconUrl('https://attacker.example/reaction.png')
  );
  if (unsafeIconAccepted) throw new Error('An untrusted reaction icon host was accepted.');

  await page.locator('#fdb-start').click();
  await page.getByText('Režim nanečisto dokončen.').waitFor();
  const summary = await page.locator('#fdb-summary').innerText();
  if (!summary.includes('hotovo') || !summary.includes('profilů: 2')) {
    throw new Error(`Unexpected dry-run summary: ${summary}`);
  }

  const selectorChecks = await page.evaluate(() => {
    const reactionCounter = document.createElement('button');
    reactionCounter.setAttribute('aria-label', '8 reakcí, podívejte se, kdo zareagoval');
    document.querySelector('main').appendChild(reactionCounter);

    const options = document.createElement('button');
    options.setAttribute('aria-label', 'Zobrazit víc v nastavení profilu');
    document.querySelector('main').appendChild(options);

    const menu = document.createElement('div');
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Nabídka dalších akcí pro profil');
    menu.innerHTML = '<div role="menuitem">Blokovat</div>';
    document.body.appendChild(menu);

    const confirmation = document.createElement('div');
    confirmation.setAttribute('role', 'dialog');
    confirmation.innerHTML = '<p>Opravdu chcete blokovat profil Alice Example?</p><button>Blokovat</button><button>Zrušit</button>';
    document.body.appendChild(confirmation);

    const api = window.__FDB_INTERNALS__;
    const confirmationDialog = api.findConfirmationDialog({ name: 'Alice Example' });
    return {
      options: api.findProfileOptionsButton()?.element === options,
      reactionCounterIgnored: api.findProfileOptionsButton()?.element !== reactionCounter,
      menu: api.findBlockMenuItem()?.innerText === 'Blokovat',
      dialog: confirmationDialog === confirmation,
      confirmation: api.findConfirmButton(confirmationDialog)?.innerText === 'Blokovat'
    };
  });
  if (Object.values(selectorChecks).some((value) => !value)) {
    throw new Error(`Czech selector smoke checks failed: ${JSON.stringify(selectorChecks)}`);
  }

  console.log('Smoke test passed: scan, deduplication, filtering, dry-run UI and Czech action selectors.');
} finally {
  await browser.close();
}
