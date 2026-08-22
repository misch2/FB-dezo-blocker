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
const context = await browser.newContext();
await context.route('https://www.facebook.com/**', (route) => route.fulfill({
  status: 200,
  contentType: 'text/html',
  body: '<!doctype html><html><body></body></html>'
}));
const page = await context.newPage();
const userscriptSource = fs.readFileSync('facebook-reaction-blocker.user.js', 'utf8');

async function installUserscriptEnvironment(targetPage) {
  await targetPage.evaluate(() => {
    const sessionValues = new Map();
    Object.defineProperty(window, 'sessionStorage', {
      configurable: true,
      value: {
        getItem: (key) => sessionValues.has(String(key)) ? sessionValues.get(String(key)) : null,
        setItem: (key, value) => sessionValues.set(String(key), String(value)),
        removeItem: (key) => sessionValues.delete(String(key))
      }
    });

    // Tampermonkey values are shared between Facebook tabs, unlike the job
    // queue above. localStorage is only the synchronous backing store for
    // this test double; the userscript still has to use the GM_* API.
    const gmPrefix = '__fdb-test-gm:';
    window.GM_getValue = (key, fallback) => {
      const serialized = window.localStorage.getItem(`${gmPrefix}${String(key)}`);
      if (serialized === null) return fallback;
      try {
        return JSON.parse(serialized);
      } catch (_error) {
        return serialized;
      }
    };
    window.GM_setValue = (key, value) => {
      window.localStorage.setItem(`${gmPrefix}${String(key)}`, JSON.stringify(value));
    };

    window.__FDB_TESTING__ = true;
    window.GM_addStyle = (css) => {
      const style = document.createElement('style');
      style.textContent = css;
      document.head.appendChild(style);
    };
    window.GM_registerMenuCommand = () => {};
  });
}

try {
  await page.goto('https://www.facebook.com/test-page', { waitUntil: 'commit' });
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

  await installUserscriptEnvironment(page);

  await page.addScriptTag({ content: userscriptSource });
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

  await page.evaluate(() => {
    const state = JSON.parse(window.sessionStorage.getItem('fdb-job-v4'));
    state.jobStatus = 'running';
    window.sessionStorage.setItem('fdb-job-v4', JSON.stringify(state));
  });
  const secondPage = await context.newPage();
  try {
    await secondPage.goto('https://www.facebook.com/second-tab', { waitUntil: 'commit' });
    await secondPage.setContent('<!doctype html><html><body><main><h1>Druhé facebookové okno</h1></main></body></html>');
    await installUserscriptEnvironment(secondPage);
    await secondPage.addScriptTag({ content: userscriptSource });
    await secondPage.locator('#fdb-panel').waitFor();
    await secondPage.waitForTimeout(2000);
    const secondSummary = await secondPage.locator('#fdb-summary').innerText();
    if (!/profilů:\s*0|fronta\s*\(0\)/i.test(secondSummary)) {
      throw new Error(`A separate Facebook tab inherited the running queue: ${secondSummary}`);
    }
  } finally {
    await secondPage.close();
  }

  await page.evaluate(() => {
    const state = JSON.parse(window.sessionStorage.getItem('fdb-job-v4'));
    state.jobStatus = 'idle';
    window.sessionStorage.setItem('fdb-job-v4', JSON.stringify(state));
  });

  const unsafeIconAccepted = await page.evaluate(() =>
    window.__FDB_INTERNALS__.safeReactionIconUrl('https://attacker.example/reaction.png')
  );
  if (unsafeIconAccepted) throw new Error('An untrusted reaction icon host was accepted.');

  const dryRunDialogs = [];
  const captureDryRunDialog = async (dialog) => {
    dryRunDialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  };
  page.on('dialog', captureDryRunDialog);
  await page.locator('#fdb-run').click();
  await page.getByText('Režim nanečisto dokončen.').waitFor();
  page.off('dialog', captureDryRunDialog);
  if (dryRunDialogs.some((dialog) => dialog.type === 'alert')) {
    throw new Error(`Dry-run completion unexpectedly displayed a browser alert: ${JSON.stringify(dryRunDialogs)}`);
  }
  const dryRunState = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem('fdb-job-v4')));
  if (dryRunState.jobStatus !== 'complete' || dryRunState.currentIndex !== dryRunState.queue.length
    || dryRunState.queue.some((target) => target.status !== 'preview')) {
    throw new Error(`Unexpected dry-run state: ${JSON.stringify(dryRunState)}`);
  }

  const selectorChecks = await page.evaluate(() => {
    const reactionCounter = document.createElement('button');
    reactionCounter.id = 'fdb-selector-reaction-counter';
    reactionCounter.setAttribute('aria-label', '8 reakcí, podívejte se, kdo zareagoval');
    document.querySelector('main').appendChild(reactionCounter);

    const options = document.createElement('button');
    options.id = 'fdb-selector-options';
    options.setAttribute('aria-label', 'Zobrazit víc v nastavení profilu');
    document.querySelector('main').appendChild(options);

    const menu = document.createElement('div');
    menu.id = 'fdb-selector-menu';
    menu.setAttribute('role', 'menu');
    menu.setAttribute('aria-label', 'Nabídka dalších akcí pro profil');
    menu.innerHTML = '<div role="menuitem">Blokovat</div>';
    document.body.appendChild(menu);

    const confirmation = document.createElement('div');
    confirmation.id = 'fdb-selector-confirmation';
    confirmation.setAttribute('role', 'dialog');
    confirmation.innerHTML = '<h2>Zablokovat Alice Example?</h2><p>Alice už nebude moct zobrazit váš profil.</p><button>Zrušit</button><div role="button" tabindex="0" aria-label="Potvrdit">Potvrdit</div>';
    document.body.appendChild(confirmation);

    const unrelatedConfirmation = document.createElement('div');
    unrelatedConfirmation.id = 'fdb-selector-unrelated-confirmation';
    unrelatedConfirmation.setAttribute('role', 'dialog');
    unrelatedConfirmation.innerHTML = '<h2>Smazat komentář?</h2><button>Zrušit</button><button>Potvrdit</button>';
    document.body.appendChild(unrelatedConfirmation);

    const api = window.__FDB_INTERNALS__;
    const confirmationDialog = api.findConfirmationDialog({ name: 'Alice Example' });
    return {
      options: api.findProfileOptionsButton()?.element === options,
      reactionCounterIgnored: api.findProfileOptionsButton()?.element !== reactionCounter,
      menu: api.findBlockMenuItem()?.innerText === 'Blokovat',
      dialog: confirmationDialog === confirmation,
      wrongTargetRejected: api.findConfirmationDialog({ name: 'Bob Example' }) !== confirmation,
      confirmation: api.findConfirmButton(confirmationDialog, { name: 'Alice Example' })?.innerText === 'Potvrdit',
      unrelatedConfirmationRejected: api.findConfirmButton(unrelatedConfirmation, { name: 'Alice Example' }) === null
    };
  });
  if (Object.values(selectorChecks).some((value) => !value)) {
    throw new Error(`Czech selector smoke checks failed: ${JSON.stringify(selectorChecks)}`);
  }
  await page.evaluate(() => {
    [
      '#fdb-selector-reaction-counter', '#fdb-selector-options', '#fdb-selector-menu',
      '#fdb-selector-confirmation', '#fdb-selector-unrelated-confirmation'
    ].forEach((selector) => document.querySelector(selector)?.remove());
  });

  // Regression fixture: a reaction list larger than the former hard cap of
  // 200 profiles. Keep the first two rows because the earlier assertions
  // cover deduplication and profile-name selection.
  await page.evaluate(() => {
    const dialog = document.querySelector('#reactions-dialog');
    for (let index = 3; index <= 250; index += 1) {
      const row = document.createElement('div');
      row.className = 'profile-row';
      row.style.cssText = 'display:flex; width:450px; height:52px';
      row.innerHTML = `
        <a href="https://www.facebook.com/fixture-profile-${index}"><svg role="img" aria-label="Fixture Profile ${index}" width="40" height="40"></svg></a>
        <img data-reaction src="https://scontent.example.fbcdn.net/reactions/haha.png" alt="" style="width:16px; height:16px">
        <a href="https://www.facebook.com/fixture-profile-${index}">Fixture Profile ${index}</a>
        <button>Přidat přítele</button>`;
      dialog.appendChild(row);
    }
  });

  await page.locator('#fdb-max').fill('1000');
  await page.locator('#fdb-mode').selectOption('automatic');
  const selectedSettingsBeforeScan = await page.locator('#fdb-mode').inputValue();
  const maxBeforeScan = await page.locator('#fdb-max').inputValue();
  if (selectedSettingsBeforeScan !== 'automatic' || maxBeforeScan !== '1000') {
    throw new Error(`Could not set regression settings before scan: mode=${selectedSettingsBeforeScan}, max=${maxBeforeScan}`);
  }

  // The production scanner intentionally waits between rounds. Make only
  // this scan's waits immediate so the 250-profile fixture stays a smoke test.
  await page.evaluate(() => {
    window.__FDB_REAL_SET_TIMEOUT__ = window.setTimeout;
    window.setTimeout = (callback) => {
      callback();
      return 0;
    };
  });
  try {
    await page.locator('#fdb-scan').click();
    await page.waitForFunction(() => {
      const notice = document.querySelector('#fdb-notice');
      return notice && !notice.textContent.includes('Načítám');
    }, { timeout: 10000 });
  } finally {
    await page.evaluate(() => {
      window.setTimeout = window.__FDB_REAL_SET_TIMEOUT__;
      delete window.__FDB_REAL_SET_TIMEOUT__;
    });
  }

  const largeScanNotice = await page.locator('#fdb-notice').innerText();
  if (!largeScanNotice.includes('Hotovo: 250 profilů včetně ikon reakcí.')) {
    throw new Error(`The scan did not retain all profiles above 200: ${largeScanNotice}`);
  }
  const largeQueueSize = await page.evaluate(() => {
    const state = JSON.parse(window.sessionStorage.getItem('fdb-job-v4'));
    return state?.queue?.length;
  });
  if (largeQueueSize !== 250) {
    throw new Error(`Expected 250 queued profiles, got ${largeQueueSize}`);
  }
  const renderedLargeQueue = page.locator('#fdb-list .fdb-row');
  if (await renderedLargeQueue.count() !== 250) {
    throw new Error(`Expected the complete 250-profile queue in the DOM, got ${await renderedLargeQueue.count()} rows`);
  }
  const renderedLargeQueueText = await renderedLargeQueue.allTextContents();
  if (!renderedLargeQueueText[0]?.includes('Alice Example') || !renderedLargeQueueText[249]?.includes('Fixture Profile 250')) {
    throw new Error(`The complete queue did not retain its first and last rows: first=${renderedLargeQueueText[0]}, last=${renderedLargeQueueText[249]}`);
  }
  const renderedLargeQueueAccessibility = await renderedLargeQueue.evaluateAll((rows) => rows.map((row) => ({
    label: row.getAttribute('aria-label'),
    position: row.getAttribute('aria-posinset'),
    size: row.getAttribute('aria-setsize')
  })));
  if (renderedLargeQueueAccessibility.some((row, index) => !row.label?.trim()
    || row.position !== String(index + 1) || row.size !== '250')) {
    throw new Error(`Queue rows should expose their accessible name and full-queue position: ${JSON.stringify(renderedLargeQueueAccessibility.slice(0, 3))}`);
  }
  const runButton = page.locator('#fdb-run');
  if (await runButton.count() !== 1 || !/Spustit/.test(await runButton.innerText()) || /znovu/i.test(await runButton.innerText())) {
    throw new Error(`An idle queue should expose the initial context action, got: ${await runButton.innerText()}`);
  }
  if (!await page.locator('#fdb-stop').isDisabled()) {
    throw new Error('Stop should be disabled before a queue run starts.');
  }

  // Re-inject the userscript with a persisted status to exercise the
  // context-sensitive run control without navigating to a real profile or
  // starting any Facebook action. The real resume timer is disabled only
  // while this deterministic render assertion is made.
  async function renderPersistedJobStatus(jobStatus, queue = null, extraState = {}) {
    await page.evaluate(({ jobStatus: nextStatus, queue: nextQueue, extra }) => {
      const state = JSON.parse(window.sessionStorage.getItem('fdb-job-v4')) || {};
      if (nextQueue) state.queue = nextQueue;
      state.jobStatus = nextStatus;
      Object.assign(state, extra);
      window.sessionStorage.setItem('fdb-job-v4', JSON.stringify(state));
      document.querySelector('#fdb-panel')?.remove();
      window.__FDB_REAL_SET_TIMEOUT__ = window.setTimeout;
      window.setTimeout = () => 0;
    }, { jobStatus, queue, extra: extraState });
    await page.addScriptTag({ content: userscriptSource });
    await page.locator('#fdb-panel').waitFor();
    await page.evaluate(() => {
      window.setTimeout = window.__FDB_REAL_SET_TIMEOUT__;
      delete window.__FDB_REAL_SET_TIMEOUT__;
    });
  }

  await renderPersistedJobStatus('running');
  if (!/Pauza/i.test(await page.locator('#fdb-run').innerText())) {
    throw new Error(`A running queue should expose Pauza, got: ${await page.locator('#fdb-run').innerText()}`);
  }
  await renderPersistedJobStatus('paused');
  if (!/Pokračovat/i.test(await page.locator('#fdb-run').innerText())) {
    throw new Error(`A paused queue should expose Pokračovat, got: ${await page.locator('#fdb-run').innerText()}`);
  }
  await renderPersistedJobStatus('stopped');
  if (!/Pokračovat/i.test(await page.locator('#fdb-run').innerText())) {
    throw new Error(`A stopped queue should expose Pokračovat, got: ${await page.locator('#fdb-run').innerText()}`);
  }
  await renderPersistedJobStatus('complete');
  if (!/Spustit znovu/i.test(await page.locator('#fdb-run').innerText())) {
    throw new Error(`A completed queue should expose Spustit znovu, got: ${await page.locator('#fdb-run').innerText()}`);
  }
  if (!await page.locator('#fdb-stop').isDisabled()) {
    throw new Error('Stop should remain disabled after completion.');
  }

  const skipQueue = [
    {
      url: 'https://www.facebook.com/fixture-already-blocked',
      name: 'Already Blocked',
      reactionIconUrl: 'https://scontent.example.fbcdn.net/reactions/haha.png',
      status: 'blocked',
      note: 'Zablokováno'
    },
    {
      url: 'https://www.facebook.com/fixture-last-skip',
      name: 'Last Skip',
      reactionIconUrl: 'https://scontent.example.fbcdn.net/reactions/haha.png',
      status: 'pending',
      note: ''
    },
    {
      url: 'https://www.facebook.com/fixture-terminal-tail',
      name: 'Terminal Tail',
      reactionIconUrl: 'https://scontent.example.fbcdn.net/reactions/haha.png',
      status: 'blocked',
      note: 'Zablokováno'
    }
  ];
  await renderPersistedJobStatus('paused', skipQueue, {
    currentIndex: 1,
    mode: 'automatic',
    completionAlertShown: false
  });
  if (await page.locator('#fdb-skip').isDisabled()) {
    throw new Error('Skip should be available for the current paused profile.');
  }
  const skipDialogs = [];
  const captureSkipDialog = async (dialog) => {
    skipDialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  };
  page.on('dialog', captureSkipDialog);
  await page.locator('#fdb-skip').click();
  await page.waitForFunction(() => JSON.parse(window.sessionStorage.getItem('fdb-job-v4'))?.jobStatus === 'complete');
  page.off('dialog', captureSkipDialog);
  const skippedCompletion = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem('fdb-job-v4')));
  if (skippedCompletion.currentIndex !== skippedCompletion.queue.length
    || skippedCompletion.queue[1]?.status !== 'skipped') {
    throw new Error(`Completing with the last Skip did not finish the queue: ${JSON.stringify(skippedCompletion)}`);
  }
  if (skipDialogs.some((dialog) => dialog.type === 'alert')) {
    throw new Error(`Skipping the final profile unexpectedly displayed a success alert: ${JSON.stringify(skipDialogs)}`);
  }

  // Synthetic profile controls for one automatic completion. They deliberately
  // stay inside the test page and only exercise the conservative selector path;
  // no Facebook request or real profile is ever touched.
  await page.evaluate(() => {
    const main = document.querySelector('main');
    main.innerHTML = '';
    window.__FDB_TEST_OPTIONS_CLICKS__ = 0;

    const options = document.createElement('button');
    options.id = 'fdb-test-profile-options';
    options.setAttribute('role', 'button');
    options.setAttribute('aria-label', 'Další možnosti');
    options.textContent = '…';
    main.appendChild(options);

    const menu = document.createElement('div');
    menu.id = 'fdb-test-block-menu';
    menu.setAttribute('role', 'menu');
    menu.style.cssText = 'display:none; width:240px; height:80px';
    const block = document.createElement('div');
    block.setAttribute('role', 'menuitem');
    block.textContent = 'Blokovat';
    menu.appendChild(block);
    document.body.appendChild(menu);

    const confirmation = document.createElement('div');
    confirmation.id = 'fdb-test-block-confirmation';
    confirmation.setAttribute('role', 'dialog');
    confirmation.style.cssText = 'display:none; width:320px; height:180px';
    confirmation.innerHTML = '<h2>Zablokovat Fixture Target?</h2><button id="fdb-test-confirm">Potvrdit</button>';
    document.body.appendChild(confirmation);

    const result = document.createElement('div');
    result.id = 'fdb-test-result-dialog';
    result.setAttribute('role', 'dialog');
    result.style.cssText = 'display:none; width:320px; height:180px';
    result.innerHTML = '<h2>Zablokovala jste Fixture Target</h2><button>Zavřít</button>';
    document.body.appendChild(result);

    options.addEventListener('click', () => {
      window.__FDB_TEST_OPTIONS_CLICKS__ += 1;
      menu.style.display = 'block';
    });
    block.addEventListener('click', () => { confirmation.style.display = 'block'; });
    confirmation.querySelector('#fdb-test-confirm').addEventListener('click', () => {
      confirmation.style.display = 'none';
      result.style.display = 'block';
    });
  });

  const realCompletionTarget = {
    url: 'https://www.facebook.com/test-page',
    name: 'Fixture Target',
    reactionIconUrl: 'https://scontent.example.fbcdn.net/reactions/haha.png',
    status: 'pending',
    note: ''
  };
  await renderPersistedJobStatus('idle', [realCompletionTarget], {
    currentIndex: 0,
    mode: 'automatic',
    completionAlertShown: false,
    timings: { clickMin: 1000, clickMax: 1000, profileMin: 1000, profileMax: 1000 }
  });
  const completionDialogs = [];
  const captureCompletionDialog = async (dialog) => {
    completionDialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  };
  page.on('dialog', captureCompletionDialog);
  await page.evaluate(() => {
    window.__FDB_REAL_SET_TIMEOUT__ = window.setTimeout;
    window.setTimeout = (callback) => {
      callback();
      return 0;
    };
  });
  await page.locator('#fdb-run').click();
  try {
    await page.waitForFunction(() => JSON.parse(window.sessionStorage.getItem('fdb-job-v4'))?.jobStatus === 'complete');
  } catch (error) {
    const completionDebug = await page.evaluate(() => ({
      state: JSON.parse(window.sessionStorage.getItem('fdb-job-v4')),
      notice: document.querySelector('#fdb-notice')?.textContent,
      menuVisible: Boolean(document.querySelector('#fdb-test-block-menu')?.offsetParent),
      confirmationVisible: Boolean(document.querySelector('#fdb-test-block-confirmation')?.offsetParent),
      resultVisible: Boolean(document.querySelector('#fdb-test-result-dialog')?.offsetParent),
      optionsClicks: window.__FDB_TEST_OPTIONS_CLICKS__
    }));
    throw new Error(`Synthetic automatic completion timed out: ${JSON.stringify({ completionDebug, completionDialogs })}`, { cause: error });
  }
  await page.evaluate(() => {
    window.setTimeout = window.__FDB_REAL_SET_TIMEOUT__;
    delete window.__FDB_REAL_SET_TIMEOUT__;
  });
  page.off('dialog', captureCompletionDialog);
  const completionAlerts = completionDialogs.filter((dialog) => dialog.type === 'alert');
  if (completionAlerts.length !== 1 || !/doběhlo úspěšně|úspěšně.*konce/i.test(completionAlerts[0]?.message || '')) {
    throw new Error(`Expected exactly one native success alert, got: ${JSON.stringify(completionDialogs)}`);
  }
  if (!await page.locator('#fdb-test-result-dialog').isVisible()) {
    throw new Error('The Facebook result dialog should remain visible after the success alert.');
  }
  const completedRealJob = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem('fdb-job-v4')));
  if (!completedRealJob.completionAlertShown || completedRealJob.queue[0]?.status !== 'blocked') {
    throw new Error(`Successful completion did not persist its terminal state and alert flag: ${JSON.stringify(completedRealJob)}`);
  }

  const reloadDialogs = [];
  const captureReloadDialog = async (dialog) => {
    reloadDialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  };
  page.on('dialog', captureReloadDialog);
  await renderPersistedJobStatus('complete');
  await page.waitForTimeout(100);
  page.off('dialog', captureReloadDialog);
  if (reloadDialogs.some((dialog) => dialog.type === 'alert')) {
    throw new Error(`Reloading a completed job repeated the success alert: ${JSON.stringify(reloadDialogs)}`);
  }

  const optionsClicksBeforeRestart = await page.evaluate(() => window.__FDB_TEST_OPTIONS_CLICKS__);
  const restartDialogs = [];
  const captureRestartDialog = async (dialog) => {
    restartDialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  };
  page.on('dialog', captureRestartDialog);
  await page.locator('#fdb-run').click();
  await page.waitForTimeout(100);
  page.off('dialog', captureRestartDialog);
  const safeRestartState = await page.evaluate(() => ({
    state: JSON.parse(window.sessionStorage.getItem('fdb-job-v4')),
    optionsClicks: window.__FDB_TEST_OPTIONS_CLICKS__
  }));
  if (safeRestartState.optionsClicks !== optionsClicksBeforeRestart
    || safeRestartState.state.queue[0]?.status !== 'blocked') {
    throw new Error(`Spustit znovu attempted to reprocess a blocked target: ${JSON.stringify({ safeRestartState, restartDialogs })}`);
  }

  await page.evaluate(() => {
    document.querySelector('#fdb-test-block-menu').style.display = 'none';
    document.querySelector('#fdb-test-block-confirmation').style.display = 'none';
    document.querySelector('#fdb-test-result-dialog').style.display = 'none';
  });
  await renderPersistedJobStatus('idle', [{ ...realCompletionTarget }], {
    currentIndex: 0,
    mode: 'automatic',
    completionAlertShown: false,
    runBlockedCount: 0,
    timings: { clickMin: 1000, clickMax: 1000, profileMin: 1000, profileMax: 1000 }
  });
  const stoppedCompletionDialogs = [];
  const captureStoppedCompletionDialog = async (dialog) => {
    stoppedCompletionDialogs.push({ type: dialog.type(), message: dialog.message() });
    await dialog.accept();
  };
  page.on('dialog', captureStoppedCompletionDialog);
  await page.evaluate(() => {
    window.__FDB_REAL_SET_TIMEOUT__ = window.setTimeout;
    window.__FDB_HELD_FINAL_SLEEP__ = null;
    window.setTimeout = (callback, delay) => {
      if (delay === 2500) {
        window.__FDB_HELD_FINAL_SLEEP__ = callback;
        return 1;
      }
      callback();
      return 0;
    };
  });
  await page.locator('#fdb-run').click();
  await page.waitForFunction(() => document.querySelector('#fdb-test-result-dialog')?.offsetParent
    && typeof window.__FDB_HELD_FINAL_SLEEP__ === 'function');
  await page.locator('#fdb-stop').click();
  await page.evaluate(() => {
    const finishSleep = window.__FDB_HELD_FINAL_SLEEP__;
    window.setTimeout = window.__FDB_REAL_SET_TIMEOUT__;
    delete window.__FDB_REAL_SET_TIMEOUT__;
    delete window.__FDB_HELD_FINAL_SLEEP__;
    finishSleep();
  });
  await page.waitForFunction(() => {
    const state = JSON.parse(window.sessionStorage.getItem('fdb-job-v4'));
    return state?.jobStatus === 'stopped' && state.queue?.[0]?.status === 'blocked';
  });
  page.off('dialog', captureStoppedCompletionDialog);
  const stoppedCompletionState = await page.evaluate(() => JSON.parse(window.sessionStorage.getItem('fdb-job-v4')));
  if (stoppedCompletionState.currentIndex !== 1 || stoppedCompletionState.runBlockedCount !== 1
    || stoppedCompletionDialogs.some((dialog) => dialog.type === 'alert')) {
    throw new Error(`Stopping during the final confirmation lost or repeated the completed block: ${JSON.stringify({ stoppedCompletionState, stoppedCompletionDialogs })}`);
  }

  const selectedSettingsAfterScan = await page.locator('#fdb-mode').inputValue();
  const maxAfterScan = await page.locator('#fdb-max').inputValue();
  if (selectedSettingsAfterScan !== 'automatic' || maxAfterScan !== '1000') {
    throw new Error(`Scan reset user settings: mode=${selectedSettingsAfterScan}, max=${maxAfterScan}`);
  }

  const settingsPage = await context.newPage();
  try {
    await settingsPage.goto('https://www.facebook.com/settings-tab', { waitUntil: 'commit' });
    await settingsPage.setContent('<!doctype html><html><body><main><h1>Jiná facebooková stránka</h1></main></body></html>');
    await installUserscriptEnvironment(settingsPage);
    await settingsPage.addScriptTag({ content: userscriptSource });
    await settingsPage.locator('#fdb-panel').waitFor();
    const sharedSettings = await settingsPage.evaluate(() => ({
      mode: document.querySelector('#fdb-mode').value,
      maxProfiles: document.querySelector('#fdb-max').value,
      summary: document.querySelector('#fdb-summary').textContent
    }));
    if (sharedSettings.mode !== 'automatic' || sharedSettings.maxProfiles !== '1000') {
      throw new Error(`Settings did not persist to a separate Facebook tab: ${JSON.stringify(sharedSettings)}`);
    }
    if (!/profilů:\s*0|fronta\s*\(0\)/i.test(sharedSettings.summary)) {
      throw new Error(`The separate Facebook tab inherited the job queue: ${sharedSettings.summary}`);
    }
  } finally {
    await settingsPage.close();
  }

  page.once('dialog', (dialog) => dialog.accept());
  await page.locator('#fdb-clear').click();
  await page.waitForFunction(() => /profilů:\s*0|fronta\s*\(0\)/i.test(document.querySelector('#fdb-summary')?.textContent || ''));
  const settingsAfterClear = await page.evaluate(() => ({
    mode: document.querySelector('#fdb-mode').value,
    maxProfiles: document.querySelector('#fdb-max').value,
    queueStorage: window.sessionStorage.getItem('fdb-job-v4')
  }));
  if (settingsAfterClear.mode !== 'automatic' || settingsAfterClear.maxProfiles !== '1000') {
    throw new Error(`Clearing the queue reset saved settings: ${JSON.stringify(settingsAfterClear)}`);
  }
  if (settingsAfterClear.queueStorage !== null) {
    throw new Error('Clearing the queue left job state in sessionStorage.');
  }

  console.log('Smoke test passed: full queue UI, contextual controls, safe completion alerts, stop/retry isolation, settings persistence and Czech selectors.');
} finally {
  await browser.close();
}
