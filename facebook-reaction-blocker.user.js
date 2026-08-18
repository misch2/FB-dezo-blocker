// ==UserScript==
// @name         Facebook Reaction Blocker (safe prototype)
// @namespace    https://github.com/michal/facebook-dezo-blocker
// @version      0.1.4
// @description  Collect profiles from an opened Facebook reaction dialog and block them one by one.
// @author       FacebookDezoBlocker contributors
// @match        https://www.facebook.com/*
// @match        https://facebook.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_deleteValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  const STORAGE_KEY = 'fdb-job-v3';
  const PANEL_ID = 'fdb-panel';
  const MAX_SCAN_ROUNDS = 80;
  const NO_GROWTH_LIMIT = 5;
  const RESERVED_PATHS = new Set([
    '', 'about', 'ads', 'bookmarks', 'business', 'events', 'friends', 'gaming',
    'groups', 'help', 'home.php', 'login', 'marketplace', 'me', 'messages',
    'notifications', 'pages', 'photo', 'photos', 'privacy', 'reel', 'reels',
    'search', 'settings', 'share', 'sharer', 'stories', 'story.php', 'watch'
  ]);
  const LABELS = {
    options: [
      /\b(see |show |view )?(more )?options\b/i,
      /\b(profile )?actions\b/i,
      /(zobrazit |ukázat )?(další )?možnosti/i,
      /zobrazit víc v nastavení profilu/i,
      /see more (?:in|about) (?:the )?profile/i,
      /(?:^|\s)(?:další )?(?:akce|nabídka akcí)(?:\s|$)/i,
      /^more$/i,
      /^další$/i,
      /^…$/
    ],
    block: [
      /\bblock(?: profile)?\b/i,
      /zablokovat(?: profil)?/i,
      /(?:^|\s)blokovat(?: profil)?(?:\s|$)/i
    ],
    forbiddenBlock: [
      /message/i, /messages/i, /zpráv/i, /messenger/i
    ],
    confirm: [
      /^confirm$/i,
      /^potvrdit$/i
    ],
    more: [
      /^(see|show|view|load) more$/i,
      /^(zobrazit|ukázat|načíst) (další|více)$/i
    ]
  };

  let ui = null;
  let busy = false;

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const randomBetween = (min, max) => Math.round(min + Math.random() * (max - min));
  const visible = (element) => {
    if (!(element instanceof Element)) return false;
    const rect = element.getBoundingClientRect();
    const style = getComputedStyle(element);
    return rect.width > 1 && rect.height > 1 && style.visibility !== 'hidden' && style.display !== 'none';
  };
  const compact = (value) => String(value || '').replace(/\s+/g, ' ').trim();
  const matchesAny = (value, patterns) => patterns.some((pattern) => pattern.test(compact(value)));
  const nowText = () => new Date().toLocaleTimeString('cs-CZ', { hour: '2-digit', minute: '2-digit', second: '2-digit' });

  function defaultState() {
    return {
      version: 3,
      sourceUrl: '',
      queue: [],
      currentIndex: 0,
      jobStatus: 'idle',
      mode: 'dry',
      timings: {
        clickMin: 1500,
        clickMax: 2800,
        profileMin: 5000,
        profileMax: 8000
      },
      maxProfiles: 25,
      reactionLabel: '',
      log: [],
      createdAt: new Date().toISOString()
    };
  }

  function getState() {
    const state = GM_getValue(STORAGE_KEY, null);
    return state && state.version === 3 ? { ...defaultState(), ...state } : defaultState();
  }

  function setState(state) {
    GM_setValue(STORAGE_KEY, state);
    render(state);
  }

  function addLog(state, message) {
    state.log = [...(state.log || []), `${nowText()} ${message}`].slice(-100);
  }

  function currentTarget(state) {
    return state.queue[state.currentIndex] || null;
  }

  function cleanProfileUrl(rawUrl) {
    try {
      const baseUrl = /^https?:/i.test(location.origin) ? location.origin : 'https://www.facebook.com/';
      const url = new URL(rawUrl, baseUrl);
      if (!/(^|\.)facebook\.com$/i.test(url.hostname)) return null;

      url.protocol = 'https:';
      url.hostname = 'www.facebook.com';
      url.hash = '';
      const pathParts = url.pathname.split('/').filter(Boolean);
      const firstPathPart = pathParts[0] || '';
      if (RESERVED_PATHS.has(firstPathPart.toLowerCase())) return null;

      if (firstPathPart.toLowerCase() === 'profile.php') {
        const id = url.searchParams.get('id');
        if (!id || !/^\d+$/.test(id)) return null;
        url.search = `?id=${id}`;
      } else {
        const isUsernameProfile = pathParts.length === 1;
        const isPeopleProfile = firstPathPart.toLowerCase() === 'people'
          && pathParts.length === 3
          && /^\d+$/.test(pathParts[2]);
        if (!isUsernameProfile && !isPeopleProfile) return null;
        url.search = '';
        url.pathname = url.pathname.replace(/\/$/, '');
      }
      return url.toString();
    } catch (error) {
      if (window.__FDB_TESTING__ === true) window.__FDB_LAST_URL_ERROR__ = String(error?.stack || error);
      return null;
    }
  }

  function sameProfile(left, right) {
    return cleanProfileUrl(left) === cleanProfileUrl(right);
  }

  function reactionDialogScore(dialog) {
    const tabs = [...dialog.querySelectorAll('[role="tab"]')];
    const selectedTab = tabs.find((tab) => tab.getAttribute('aria-selected') === 'true');
    const tabLabels = tabs.map(labelOf).join(' ');
    const selectedLabel = selectedTab ? labelOf(selectedTab) : '';
    const profileUrls = new Set(
      [...dialog.querySelectorAll('a[href]')]
        .map((anchor) => cleanProfileUrl(anchor.href))
        .filter(Boolean)
    );
    const hasReactionWording = /zareag|reagoval|reacted|reactions?|to se mi líbí|haha|super|péče|štve|love|care|angry/i.test(tabLabels);
    const selectedHasReactionWording = /zareag|reagoval|reacted|reactions?|to se mi líbí|haha|super|péče|štve|love|care|angry/i.test(selectedLabel);
    const hasFriendControls = [...dialog.querySelectorAll('button, [role="button"]')]
      .some((element) => /přidat přítele|add friend/i.test(labelOf(element)));

    let score = 0;
    if (tabs.length >= 2 && hasReactionWording) score += 150;
    if (selectedTab && selectedHasReactionWording) score += 150;
    if (profileUrls.size >= 1) score += Math.min(50, profileUrls.size * 5);
    if (hasFriendControls) score += 30;
    if (dialog.parentElement?.closest('[role="dialog"]')) score += 20;
    return score;
  }

  function findReactionDialog() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    const candidates = dialogs
      .map((dialog) => ({ dialog, score: reactionDialogScore(dialog) }))
      .filter((candidate) => candidate.score >= 300);
    if (!candidates.length) return null;
    const deepestCandidates = candidates.filter((candidate) =>
      !candidates.some((other) => other !== candidate && candidate.dialog.contains(other.dialog))
    );
    return deepestCandidates.sort((a, b) => {
      if (b.score !== a.score) return b.score - a.score;
      const ar = a.dialog.getBoundingClientRect();
      const br = b.dialog.getBoundingClientRect();
      return (ar.width * ar.height) - (br.width * br.height);
    })[0].dialog;
  }

  function selectedReactionLabel(dialog) {
    const selectedTab = dialog.querySelector('[role="tab"][aria-selected="true"]');
    return selectedTab ? labelOf(selectedTab) : '';
  }

  function profileIdentityFromAnchor(anchor) {
    const innerText = compact(anchor.innerText);
    if (innerText) return { name: innerText, quality: 3 };
    const ariaLabel = compact(anchor.getAttribute('aria-label'));
    if (ariaLabel) return { name: ariaLabel, quality: 2 };
    const imageAlt = compact(anchor.querySelector('img')?.getAttribute('alt'));
    if (imageAlt) return { name: imageAlt, quality: 1 };
    return { name: 'Neznámý profil', quality: 0 };
  }

  function safeReactionIconUrl(rawUrl) {
    try {
      const baseUrl = /^https?:/i.test(location.origin) ? location.origin : 'https://www.facebook.com/';
      const url = new URL(rawUrl, baseUrl);
      const trustedHost = url.hostname === 'facebook.com'
        || url.hostname.endsWith('.facebook.com')
        || url.hostname === 'fbcdn.net'
        || url.hostname.endsWith('.fbcdn.net');
      return url.protocol === 'https:' && trustedHost ? url.toString() : '';
    } catch (_error) {
      return '';
    }
  }

  function reactionIconUrlFromAnchor(anchor, dialog) {
    let candidateRow = anchor;
    for (let level = 0; candidateRow && candidateRow !== dialog && level < 12; level += 1) {
      const rowRect = candidateRow.getBoundingClientRect();
      if (rowRect.width >= 200 && rowRect.height >= 36 && rowRect.height <= 96) {
        const icon = [...candidateRow.querySelectorAll('img[src]')].find((image) => {
          if (!visible(image)) return false;
          const rect = image.getBoundingClientRect();
          return rect.width >= 10 && rect.width <= 26
            && rect.height >= 10 && rect.height <= 26
            && Boolean(safeReactionIconUrl(image.src));
        });
        if (icon) return safeReactionIconUrl(icon.src);
      }
      candidateRow = candidateRow.parentElement;
    }
    return '';
  }

  function collectProfiles(dialog, profiles) {
    for (const anchor of dialog.querySelectorAll('a[href]')) {
      const url = cleanProfileUrl(anchor.href);
      if (!url) continue;
      const identity = profileIdentityFromAnchor(anchor);
      const existing = profiles.get(url);
      const reactionIconUrl = reactionIconUrlFromAnchor(anchor, dialog);
      if (!existing) {
        profiles.set(url, {
          name: identity.name,
          nameQuality: identity.quality,
          reactionIconUrl,
          url,
          status: 'pending',
          note: ''
        });
      } else {
        if (identity.quality > existing.nameQuality) {
          existing.name = identity.name;
          existing.nameQuality = identity.quality;
        }
        if (!existing.reactionIconUrl && reactionIconUrl) existing.reactionIconUrl = reactionIconUrl;
      }
    }
  }

  function findScrollable(dialog) {
    return [dialog, ...dialog.querySelectorAll('div')]
      .filter((element) => visible(element) && element.scrollHeight > element.clientHeight + 30)
      .sort((a, b) => b.scrollHeight - a.scrollHeight)[0] || null;
  }

  async function scanReactionDialog() {
    if (busy) return;
    const dialog = findReactionDialog();
    if (!dialog) {
      setNotice('Nenalezen bezpečně rozpoznatelný dialog reakcí. Otevři seznam reakcí a zvol konkrétní reakci.', 'error');
      return;
    }

    busy = true;
    setNotice('Načítám profily z otevřeného dialogu…', 'working');
    const profiles = new Map();
    const scrollable = findScrollable(dialog);
    let unchanged = 0;
    let previousSize = 0;

    try {
      for (let round = 0; round < MAX_SCAN_ROUNDS && unchanged < NO_GROWTH_LIMIT; round += 1) {
        collectProfiles(dialog, profiles);
        setNotice(`Načítám profily… nalezeno ${profiles.size}.`, 'working');

        if (profiles.size === previousSize) unchanged += 1;
        else unchanged = 0;
        previousSize = profiles.size;

        const moreButton = [...dialog.querySelectorAll('[role="button"], button')]
          .find((element) => visible(element) && matchesAny(element.innerText || element.getAttribute('aria-label'), LABELS.more));
        if (moreButton) moreButton.click();

        if (scrollable) {
          scrollable.scrollTop = Math.min(
            scrollable.scrollHeight,
            scrollable.scrollTop + Math.max(300, Math.round(scrollable.clientHeight * 0.8))
          );
        }
        await sleep(randomBetween(650, 950));
      }

      collectProfiles(dialog, profiles);
      const state = getState();
      const limit = readNumber('fdb-max', state.maxProfiles, 1, 200);
      const queue = [...profiles.values()].slice(0, limit);
      const missingIcons = queue.filter((target) => !target.reactionIconUrl).length;
      state.sourceUrl = location.href;
      state.queue = queue;
      state.reactionLabel = selectedReactionLabel(dialog);
      state.currentIndex = 0;
      state.jobStatus = 'idle';
      state.maxProfiles = limit;
      state.log = [];
      addLog(state, `Načteno ${queue.length} profilů z dialogu reakcí${state.reactionLabel ? ` (${state.reactionLabel})` : ''}.`);
      setState(state);
      setNotice(
        queue.length
          ? missingIcons
            ? `Načteno ${queue.length} profilů, ale u ${missingIcons} chybí ikonka reakce. Ostrý režim je zablokovaný.`
            : `Hotovo: ${queue.length} profilů včetně ikon reakcí. Zkontroluj náhled před spuštěním.`
          : 'V dialogu jsem nenašel profilové odkazy. Zkontroluj, že je otevřený seznam reakcí.',
        queue.length && !missingIcons ? 'ok' : 'error'
      );
    } finally {
      busy = false;
    }
  }

  function labelOf(element) {
    return compact([
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.innerText
    ].filter(Boolean).join(' '));
  }

  function findProfileOptionsButton() {
    const root = document.querySelector('[role="main"]') || document.querySelector('main') || document.body;
    const candidates = [...root.querySelectorAll('button, [role="button"]')]
      .filter(visible)
      .map((element) => {
        const label = labelOf(element);
        const rect = element.getBoundingClientRect();
        let score = 0;
        if (matchesAny(label, LABELS.options)) score += 100;
        if (/\b(?:option|action)s?\b|možnost|(?:^|\s)akce(?:\s|$)/i.test(label)) score += 35;
        if (/^\s*(…|\.\.\.)\s*$/.test(compact(element.innerText))) score += 30;
        if (rect.top >= 0 && rect.top < 850) score += 10;
        if (/notification|messenger|account|oznámen|účet/i.test(label)) score -= 100;
        if (/\bpost\b|příspěv/i.test(label)) score -= 100;
        return { element, label, score };
      })
      .filter((candidate) => candidate.score >= 80)
      .sort((a, b) => b.score - a.score);
    return candidates[0] || null;
  }

  async function waitFor(getter, timeoutMs, intervalMs = 200) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      const value = getter();
      if (value) return value;
      await sleep(intervalMs);
    }
    return null;
  }

  async function clickWithPacing(element, state) {
    await sleep(randomBetween(state.timings.clickMin, state.timings.clickMax));
    if (getState().jobStatus !== 'running') throw new Error('Úloha byla během čekání pozastavena.');
    element.scrollIntoView({ block: 'center', inline: 'center' });
    element.click();
  }

  function findBlockMenuItem() {
    const roots = [...document.querySelectorAll('[role="menu"], [role="dialog"]')].filter(visible);
    const candidates = roots.flatMap((root) => [...root.querySelectorAll('[role="menuitem"], button, [role="button"]')]);
    return candidates.find((element) => {
      if (!visible(element)) return false;
      const label = labelOf(element);
      return matchesAny(label, LABELS.block) && !matchesAny(label, LABELS.forbiddenBlock);
    }) || null;
  }

  function blockConfirmationTitle(dialog, target) {
    if (!(dialog instanceof Element)) return '';
    const titles = [...dialog.querySelectorAll('h1, h2, h3, h4, h5, h6, [role="heading"]')]
      .filter(visible)
      .map((element) => compact(element.innerText || element.getAttribute('aria-label')))
      .filter(Boolean);
    const title = titles.find((value) =>
      /^(?:block|zablokovat|blokovat)(?:\s+(?:profile|profil|uživatele))?\s+.+\?$/i.test(value)
    );
    if (!title) return '';

    const targetName = compact(target?.name);
    if (!targetName || targetName === 'Neznámý') return title;
    const firstName = targetName.split(' ')[0].toLocaleLowerCase();
    return title.toLocaleLowerCase().includes(firstName) ? title : '';
  }

  function findConfirmationDialog(target) {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].filter(visible);
    return dialogs.find((dialog) => blockConfirmationTitle(dialog, target)) || null;
  }

  function findConfirmButton(dialog, target) {
    if (!blockConfirmationTitle(dialog, target)) return null;
    return [...dialog.querySelectorAll('button, [role="button"]')].find((element) => {
      if (!visible(element)) return false;
      const label = labelOf(element);
      const isExplicitBlock = matchesAny(label, LABELS.block) && !matchesAny(label, LABELS.forbiddenBlock);
      return isExplicitBlock || matchesAny(label, LABELS.confirm);
    }) || null;
  }

  async function automateBlock(target, state) {
    setNotice(`Hledám nabídku profilu ${target.name}…`, 'working');
    const optionCandidate = await waitFor(findProfileOptionsButton, 12000);
    if (!optionCandidate) throw new Error('Nenalezena nabídka „Další možnosti“ v záhlaví profilu.');
    await clickWithPacing(optionCandidate.element, state);

    setNotice('Hledám položku „Blokovat“…', 'working');
    const blockItem = await waitFor(findBlockMenuItem, 8000);
    if (!blockItem) throw new Error('V otevřené nabídce nebyla nalezena položka „Blokovat“ ani „Zablokovat“.');
    await clickWithPacing(blockItem, state);

    const confirmation = await waitFor(() => findConfirmationDialog(target), 8000);
    if (!confirmation) throw new Error('Facebook nezobrazil rozpoznatelný potvrzovací dialog blokování.');
    const confirmButton = findConfirmButton(confirmation, target);
    if (!confirmButton) throw new Error('V potvrzovacím dialogu blokování nebylo nalezeno tlačítko „Potvrdit“, „Blokovat“ ani „Zablokovat“.');

    if (state.mode === 'guided') {
      const approved = window.confirm(`Opravdu na Facebooku zablokovat profil „${target.name}“?`);
      if (!approved) return 'skipped';
    }

    setNotice(`Potvrzuji blokování profilu ${target.name}…`, 'working');
    await clickWithPacing(confirmButton, state);
    await sleep(2500);
    return 'blocked';
  }

  function readSettings(state) {
    const modeElement = document.querySelector('#fdb-mode');
    const mode = modeElement ? modeElement.value : state.mode;
    const clickMin = readNumber('fdb-click-min', state.timings.clickMin, 1000, 60000);
    const clickMax = readNumber('fdb-click-max', state.timings.clickMax, clickMin, 60000);
    const profileMin = readNumber('fdb-profile-min', state.timings.profileMin, 1000, 300000);
    const profileMax = readNumber('fdb-profile-max', state.timings.profileMax, profileMin, 300000);
    const maxProfiles = readNumber('fdb-max', state.maxProfiles, 1, 200);
    return { mode, timings: { clickMin, clickMax, profileMin, profileMax }, maxProfiles };
  }

  function readNumber(id, fallback, min, max) {
    const value = Number(document.getElementById(id)?.value);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, Math.round(value))) : fallback;
  }

  async function startJob() {
    if (busy) return;
    const state = getState();
    if (!state.queue.length) {
      setNotice('Fronta je prázdná. Nejdřív načti profily z dialogu reakcí.', 'error');
      return;
    }

    const settings = readSettings(state);
    state.mode = settings.mode;
    state.timings = settings.timings;
    state.maxProfiles = settings.maxProfiles;
    state.queue = state.queue.slice(0, settings.maxProfiles);

    if (state.mode === 'dry') {
      state.queue = state.queue.map((target) => ({ ...target, status: 'preview', note: 'Bez zásahu' }));
      state.currentIndex = state.queue.length;
      state.jobStatus = 'complete';
      addLog(state, `Režim nanečisto dokončen pro ${state.queue.length} profilů; nic nebylo změněno.`);
      setState(state);
      setNotice('Režim nanečisto dokončen. Nebyl zablokován žádný profil.', 'ok');
      return;
    }

    const missingIcons = state.queue.filter((target) => !target.reactionIconUrl).length;
    if (missingIcons) {
      setNotice(`Ostrý režim nelze spustit: u ${missingIcons} profilů chybí načtená ikonka reakce. Načti seznam reakcí znovu.`, 'error');
      return;
    }

    const warning = state.mode === 'automatic'
      ? `Automatický režim skutečně zablokuje až ${state.queue.length} profilů bez dalšího potvrzení. Pokračovat?`
      : `Asistovaný režim otevře až ${state.queue.length} profilů a před každým blokováním se zeptá. Pokračovat?`;
    if (!window.confirm(warning)) return;

    const restartFromPreview = state.currentIndex >= state.queue.length || state.queue.some((target) => target.status === 'preview');
    state.queue = state.queue.map((target) => target.status === 'preview'
      ? { ...target, status: 'pending', note: '' }
      : target);
    state.currentIndex = restartFromPreview ? 0 : Math.min(state.currentIndex, state.queue.length - 1);
    if (!currentTarget(state) || !['pending', 'error'].includes(currentTarget(state).status)) {
      const firstPending = state.queue.findIndex((target) => ['pending', 'error'].includes(target.status));
      state.currentIndex = firstPending >= 0 ? firstPending : 0;
    }
    state.jobStatus = 'running';
    addLog(state, `Spuštěn ${state.mode === 'guided' ? 'asistovaný' : 'automatický'} režim.`);
    setState(state);
    await resumeJob();
  }

  async function resumeJob() {
    if (busy) return;
    let state = getState();
    if (state.jobStatus !== 'running') return;
    const target = currentTarget(state);
    if (!target) {
      state.jobStatus = 'complete';
      addLog(state, 'Fronta dokončena.');
      setState(state);
      setNotice('Fronta je dokončena.', 'ok');
      return;
    }

    if (!sameProfile(location.href, target.url)) {
      setNotice(`Přecházím na profil ${target.name}…`, 'working');
      location.assign(target.url);
      return;
    }

    busy = true;
    target.status = 'working';
    setState(state);
    try {
      const result = await automateBlock(target, state);
      state = getState();
      const freshTarget = currentTarget(state);
      freshTarget.status = result;
      freshTarget.note = result === 'blocked' ? 'Zablokováno' : 'Přeskočeno uživatelem';
      addLog(state, `${freshTarget.name}: ${freshTarget.note}.`);
      state.currentIndex += 1;

      if (state.currentIndex >= state.queue.length) {
        state.jobStatus = 'complete';
        setState(state);
        setNotice('Hotovo. Fronta byla zpracována.', 'ok');
        return;
      }

      setState(state);
      const delay = randomBetween(state.timings.profileMin, state.timings.profileMax);
      setNotice(`Další profil za ${(delay / 1000).toFixed(1)} s…`, 'working');
      await sleep(delay);
      state = getState();
      if (state.jobStatus === 'running') location.assign(currentTarget(state).url);
    } catch (error) {
      state = getState();
      const failedTarget = currentTarget(state);
      if (failedTarget) {
        failedTarget.status = 'error';
        failedTarget.note = error.message;
      }
      state.jobStatus = 'paused';
      addLog(state, `Pozastaveno: ${error.message}`);
      setState(state);
      setNotice(`${error.message} Úloha byla pozastavena.`, 'error');
    } finally {
      busy = false;
    }
  }

  function pauseJob() {
    const state = getState();
    state.jobStatus = 'paused';
    addLog(state, 'Úloha pozastavena uživatelem.');
    setState(state);
    setNotice('Pozastaveno. Probíhající kliknutí již nelze vrátit.', 'ok');
  }

  async function continueJob() {
    const state = getState();
    if (!state.queue.length || state.currentIndex >= state.queue.length) return;
    if (currentTarget(state)?.status === 'working') currentTarget(state).status = 'pending';
    state.jobStatus = 'running';
    addLog(state, 'Úloha znovu spuštěna.');
    setState(state);
    await resumeJob();
  }

  async function skipCurrent() {
    const state = getState();
    const target = currentTarget(state);
    if (!target) return;
    target.status = 'skipped';
    target.note = 'Ručně přeskočeno';
    addLog(state, `${target.name}: ručně přeskočeno.`);
    state.currentIndex += 1;
    state.jobStatus = state.currentIndex < state.queue.length ? 'running' : 'complete';
    setState(state);
    if (state.jobStatus === 'running') await resumeJob();
  }

  function stopJob() {
    if (!window.confirm('Ukončit úlohu? Dosud provedená blokování nelze vrátit tímto skriptem.')) return;
    const state = getState();
    state.jobStatus = 'stopped';
    addLog(state, 'Úloha ukončena uživatelem.');
    setState(state);
    setNotice('Úloha byla ukončena.', 'ok');
  }

  function clearJob() {
    if (!window.confirm('Vymazat načtenou frontu a místní protokol?')) return;
    GM_deleteValue(STORAGE_KEY);
    render(defaultState());
    setNotice('Fronta byla vymazána.', 'ok');
  }

  function returnToSource() {
    const sourceUrl = getState().sourceUrl;
    if (sourceUrl) location.assign(sourceUrl);
  }

  function statusText(status) {
    return ({
      idle: 'připraveno', running: 'běží', paused: 'pozastaveno',
      complete: 'hotovo', stopped: 'ukončeno'
    })[status] || status;
  }

  function targetStatusIcon(status) {
    return ({ pending: '○', working: '◌', blocked: '✓', skipped: '↷', error: '!', preview: '·' })[status] || '○';
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  function panelMarkup() {
    return `
      <header>
        <strong>Reaction Blocker</strong>
        <button id="fdb-collapse" class="fdb-icon" title="Sbalit">−</button>
      </header>
      <div id="fdb-body">
        <p class="fdb-help">1. Otevři reakce příspěvku a vyber reakci.<br>2. Načti profily a zkontroluj náhled.</p>
        <button id="fdb-scan" class="fdb-primary">Načíst otevřenou reakci</button>
        <label>Režim
          <select id="fdb-mode">
            <option value="dry">Nanečisto (bez blokování)</option>
            <option value="guided">Asistovaný (potvrdit každý)</option>
            <option value="automatic">Automatický (bez potvrzení)</option>
          </select>
        </label>
        <div class="fdb-grid">
          <label>Prodleva kliků od (ms)<input id="fdb-click-min" type="number" min="1000" step="100"></label>
          <label>do (ms)<input id="fdb-click-max" type="number" min="1000" step="100"></label>
          <label>Mezi profily od (ms)<input id="fdb-profile-min" type="number" min="1000" step="500"></label>
          <label>do (ms)<input id="fdb-profile-max" type="number" min="1000" step="500"></label>
        </div>
        <label>Maximum profilů v jednom běhu<input id="fdb-max" type="number" min="1" max="200"></label>
        <div id="fdb-summary"></div>
        <div id="fdb-list"></div>
        <div id="fdb-notice" aria-live="polite"></div>
        <div class="fdb-actions">
          <button id="fdb-start" class="fdb-danger">Spustit</button>
          <button id="fdb-pause">Pauza</button>
          <button id="fdb-continue">Pokračovat</button>
          <button id="fdb-skip">Přeskočit</button>
          <button id="fdb-stop">Stop</button>
          <button id="fdb-source">Zpět na příspěvek</button>
          <button id="fdb-clear">Vymazat frontu</button>
        </div>
        <details><summary>Protokol</summary><pre id="fdb-log"></pre></details>
        <p class="fdb-warning">Facebook může rozhraní kdykoli změnit. Před ostrým během ověř režim nanečisto.</p>
      </div>`;
  }

  function installUi() {
    if (document.getElementById(PANEL_ID)) return;
    GM_addStyle(`
      #${PANEL_ID} { position: fixed; z-index: 2147483647; right: 18px; bottom: 18px; width: 340px;
        max-height: calc(100vh - 36px); overflow: auto; color: #1c1e21; background: #fff; border: 1px solid #ccd0d5;
        border-radius: 10px; box-shadow: 0 8px 28px rgba(0,0,0,.28); font: 13px/1.35 Arial,sans-serif; }
      #${PANEL_ID} * { box-sizing: border-box; }
      #${PANEL_ID} header { position: sticky; top: 0; z-index: 1; display: flex; justify-content: space-between;
        align-items: center; padding: 10px 12px; color: white; background: #1877f2; border-radius: 9px 9px 0 0; }
      #${PANEL_ID} header strong { font-size: 15px; }
      #${PANEL_ID} button, #${PANEL_ID} select, #${PANEL_ID} input { font: inherit; }
      #${PANEL_ID} button { padding: 7px 9px; border: 1px solid #ccd0d5; border-radius: 6px; background: #f5f6f7; cursor: pointer; }
      #${PANEL_ID} button:hover { filter: brightness(.96); }
      #${PANEL_ID} .fdb-icon { padding: 0 6px; color: white; background: transparent; border: 0; font-size: 20px; }
      #${PANEL_ID} #fdb-body { padding: 11px; }
      #${PANEL_ID}.collapsed #fdb-body { display: none; }
      #${PANEL_ID} label { display: block; margin-top: 8px; font-size: 12px; color: #4b4f56; }
      #${PANEL_ID} label input, #${PANEL_ID} label select { width: 100%; margin-top: 3px; padding: 6px; border: 1px solid #ccd0d5; border-radius: 5px; background: white; }
      #${PANEL_ID} .fdb-grid { display: grid; grid-template-columns: 1fr 1fr; gap: 0 8px; }
      #${PANEL_ID} .fdb-primary { width: 100%; color: white; background: #1877f2; border-color: #1877f2; }
      #${PANEL_ID} .fdb-danger { color: white; background: #c62828; border-color: #c62828; }
      #${PANEL_ID} .fdb-actions { display: flex; flex-wrap: wrap; gap: 6px; margin-top: 10px; }
      #${PANEL_ID} #fdb-summary { margin-top: 10px; padding: 7px; border-radius: 5px; background: #f0f2f5; }
      #${PANEL_ID} #fdb-list { max-height: 125px; overflow: auto; margin-top: 6px; border: 1px solid #e4e6eb; border-radius: 5px; }
      #${PANEL_ID} .fdb-row { display: flex; gap: 6px; padding: 4px 6px; border-bottom: 1px solid #eee; }
      #${PANEL_ID} .fdb-row:last-child { border-bottom: 0; }
      #${PANEL_ID} .fdb-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
      #${PANEL_ID} .fdb-reaction-icon { flex: 0 0 auto; width: 18px; height: 18px; object-fit: contain; }
      #${PANEL_ID} .fdb-reaction-missing { flex: 0 0 auto; width: 18px; color: #b3261e; text-align: center; font-weight: bold; }
      #${PANEL_ID} .fdb-target-status { flex: 0 0 auto; margin-left: auto; color: #606770; }
      #${PANEL_ID} #fdb-notice { display: none; margin-top: 8px; padding: 7px; border-radius: 5px; }
      #${PANEL_ID} #fdb-notice.ok { display: block; background: #e7f5e9; color: #176b2c; }
      #${PANEL_ID} #fdb-notice.error { display: block; background: #fde8e8; color: #9b1c1c; }
      #${PANEL_ID} #fdb-notice.working { display: block; background: #e7f0fd; color: #174ea6; }
      #${PANEL_ID} details { margin-top: 8px; }
      #${PANEL_ID} pre { max-height: 100px; overflow: auto; white-space: pre-wrap; font-size: 11px; }
      #${PANEL_ID} .fdb-help, #${PANEL_ID} .fdb-warning { margin: 0 0 9px; color: #606770; }
      #${PANEL_ID} .fdb-warning { margin: 10px 0 0; font-size: 11px; }
    `);

    ui = document.createElement('section');
    ui.id = PANEL_ID;
    ui.innerHTML = panelMarkup();
    document.body.appendChild(ui);

    ui.addEventListener('click', (event) => event.stopPropagation());
    ui.querySelector('#fdb-collapse').addEventListener('click', () => {
      ui.classList.toggle('collapsed');
      ui.querySelector('#fdb-collapse').textContent = ui.classList.contains('collapsed') ? '+' : '−';
    });
    ui.querySelector('#fdb-scan').addEventListener('click', scanReactionDialog);
    ui.querySelector('#fdb-start').addEventListener('click', startJob);
    ui.querySelector('#fdb-pause').addEventListener('click', pauseJob);
    ui.querySelector('#fdb-continue').addEventListener('click', continueJob);
    ui.querySelector('#fdb-skip').addEventListener('click', skipCurrent);
    ui.querySelector('#fdb-stop').addEventListener('click', stopJob);
    ui.querySelector('#fdb-source').addEventListener('click', returnToSource);
    ui.querySelector('#fdb-clear').addEventListener('click', clearJob);
    render(getState());
  }

  function render(state) {
    if (!ui) return;
    const counts = state.queue.reduce((result, target) => {
      result[target.status] = (result[target.status] || 0) + 1;
      return result;
    }, {});
    ui.querySelector('#fdb-summary').textContent =
      `Stav: ${statusText(state.jobStatus)} · profilů: ${state.queue.length}` +
      (state.reactionLabel ? ` · vybraná reakce: ${state.reactionLabel}` : '') +
      (counts.blocked ? ` · blokováno: ${counts.blocked}` : '') +
      (counts.error ? ` · chyb: ${counts.error}` : '');
    ui.querySelector('#fdb-mode').value = state.mode;
    ui.querySelector('#fdb-click-min').value = state.timings.clickMin;
    ui.querySelector('#fdb-click-max').value = state.timings.clickMax;
    ui.querySelector('#fdb-profile-min').value = state.timings.profileMin;
    ui.querySelector('#fdb-profile-max').value = state.timings.profileMax;
    ui.querySelector('#fdb-max').value = state.maxProfiles;

    const start = Math.max(0, Math.min(state.currentIndex - 2, state.queue.length - 8));
    const shown = state.queue.slice(start, start + 8);
    ui.querySelector('#fdb-list').innerHTML = shown.length
      ? shown.map((target, index) => `
          <div class="fdb-row" title="${escapeHtml(target.note || target.url)}">
            ${target.reactionIconUrl
              ? `<img class="fdb-reaction-icon" src="${escapeHtml(target.reactionIconUrl)}" alt="Načtená reakce">`
              : '<span class="fdb-reaction-missing" title="Ikonka reakce nebyla načtena">!</span>'}
            <span class="fdb-name">${escapeHtml(`${start + index + 1}. ${target.name}`)}</span>
            <span class="fdb-target-status" title="Stav zpracování">${targetStatusIcon(target.status)}</span>
          </div>`).join('')
      : '<div class="fdb-row"><span>Fronta je prázdná.</span></div>';
    ui.querySelector('#fdb-log').textContent = (state.log || []).join('\n');
    ui.querySelector('#fdb-pause').disabled = state.jobStatus !== 'running';
    ui.querySelector('#fdb-continue').disabled = !['paused', 'stopped'].includes(state.jobStatus);
    ui.querySelector('#fdb-skip').disabled = !currentTarget(state);
    ui.querySelector('#fdb-source').disabled = !state.sourceUrl;
  }

  function setNotice(message, type) {
    if (!ui) return;
    const notice = ui.querySelector('#fdb-notice');
    notice.textContent = message;
    notice.className = type || '';
  }

  function init() {
    installUi();
    GM_registerMenuCommand('Zobrazit/sbalit Reaction Blocker', () => {
      ui.classList.toggle('collapsed');
    });
    window.setTimeout(resumeJob, 1800);
  }

  if (window.__FDB_TESTING__ === true) {
    window.__FDB_INTERNALS__ = {
      cleanProfileUrl,
      findReactionDialog,
      reactionDialogScore,
      reactionIconUrlFromAnchor,
      safeReactionIconUrl,
      findProfileOptionsButton,
      findBlockMenuItem,
      findConfirmationDialog,
      findConfirmButton
    };
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init, { once: true });
  } else {
    init();
  }
})();
