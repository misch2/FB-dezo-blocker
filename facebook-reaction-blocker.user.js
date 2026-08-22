// ==UserScript==
// @name         Facebook Reaction Blocker
// @namespace    https://github.com/misch2/FB-dezo-blocker
// @version      0.1.10
// @description  Collect profiles from an opened Facebook reaction dialog and block them one by one.
// @author       Michal Schwarz
// @homepageURL  https://github.com/misch2/FB-dezo-blocker
// @updateURL    https://raw.githubusercontent.com/misch2/FB-dezo-blocker/main/facebook-reaction-blocker.user.js
// @downloadURL  https://raw.githubusercontent.com/misch2/FB-dezo-blocker/main/facebook-reaction-blocker.user.js
// @match        https://www.facebook.com/*
// @match        https://facebook.com/*
// @run-at       document-idle
// @grant        GM_addStyle
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @grant        GM_setValue
// ==/UserScript==

(function () {
  'use strict';

  // A job must follow a single browsing context through profile navigations,
  // not leak into every Facebook tab that Tampermonkey runs the script in.
  const STORAGE_KEY = 'fdb-job-v4';
  const SETTINGS_KEY = 'fdb-settings-v1';
  const JOB_STATE_VERSION = 5;
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

  function defaultSettings() {
    return {
      mode: 'dry',
      timings: {
        clickMin: 1500,
        clickMax: 2800,
        profileMin: 5000,
        profileMax: 8000
      },
      maxProfiles: 25
    };
  }

  function defaultJobState() {
    return {
      version: JOB_STATE_VERSION,
      sourceUrl: '',
      queue: [],
      currentIndex: 0,
      jobStatus: 'idle',
      reactionLabel: '',
      completionAlertShown: false,
      runBlockedCount: 0,
      log: [],
      createdAt: new Date().toISOString()
    };
  }

  function defaultState() {
    return { ...defaultJobState(), ...getSettings() };
  }

  function normalizeSettings(candidate, fallback = defaultSettings()) {
    const source = candidate && typeof candidate === 'object' ? candidate : {};
    const sourceTimings = source.timings && typeof source.timings === 'object' ? source.timings : {};
    const baseTimings = fallback.timings || defaultSettings().timings;
    const clickMin = normalizeNumber(sourceTimings.clickMin, baseTimings.clickMin, 1000, 60000);
    const clickMax = normalizeNumber(sourceTimings.clickMax, baseTimings.clickMax, clickMin, 60000);
    const profileMin = normalizeNumber(sourceTimings.profileMin, baseTimings.profileMin, 1000, 300000);
    const profileMax = normalizeNumber(sourceTimings.profileMax, baseTimings.profileMax, profileMin, 300000);
    return {
      mode: ['dry', 'guided', 'automatic'].includes(source.mode) ? source.mode : fallback.mode,
      timings: { clickMin, clickMax, profileMin, profileMax },
      maxProfiles: normalizeNumber(source.maxProfiles, fallback.maxProfiles, 1)
    };
  }

  function normalizeNumber(value, fallback, min, max) {
    const number = Number(value);
    if (!Number.isFinite(number)) return fallback;
    const rounded = Math.round(number);
    if (!Number.isFinite(rounded)) return fallback;
    const atLeastMinimum = Math.max(min, rounded);
    return max === undefined ? atLeastMinimum : Math.min(max, atLeastMinimum);
  }

  function readTampermonkeyValue(key, fallback) {
    try {
      return typeof GM_getValue === 'function' ? GM_getValue(key, fallback) : fallback;
    } catch (_error) {
      return fallback;
    }
  }

  function writeTampermonkeyValue(key, value) {
    try {
      if (typeof GM_setValue === 'function') GM_setValue(key, value);
      return true;
    } catch (error) {
      setNotice(`Nastavení nelze uložit: ${error.message}`, 'error');
      return false;
    }
  }

  function getSettings(legacySettings = null) {
    const storedSettings = readTampermonkeyValue(SETTINGS_KEY, null);
    if (storedSettings !== null && storedSettings !== undefined) {
      return normalizeSettings(storedSettings);
    }

    const settings = normalizeSettings(legacySettings || defaultSettings());
    if (legacySettings) writeTampermonkeyValue(SETTINGS_KEY, settings);
    return settings;
  }

  function setSettings(settings) {
    const normalized = normalizeSettings(settings, getSettings());
    return writeTampermonkeyValue(SETTINGS_KEY, normalized);
  }

  function persistSettingsFromUi() {
    setSettings(readSettings());
  }

  function jobStateForStorage(state) {
    return {
      version: JOB_STATE_VERSION,
      sourceUrl: state.sourceUrl,
      queue: state.queue,
      currentIndex: state.currentIndex,
      jobStatus: state.jobStatus,
      reactionLabel: state.reactionLabel,
      completionAlertShown: Boolean(state.completionAlertShown),
      runBlockedCount: Number.isFinite(Number(state.runBlockedCount)) ? Number(state.runBlockedCount) : 0,
      log: state.log,
      createdAt: state.createdAt
    };
  }

  function getState() {
    try {
      const serializedState = window.sessionStorage.getItem(STORAGE_KEY);
      const state = serializedState ? JSON.parse(serializedState) : null;
      const isSupportedVersion = state && [4, JOB_STATE_VERSION].includes(state.version);
      const legacySettings = isSupportedVersion && state.version === 4 ? state : null;
      return isSupportedVersion
        ? { ...defaultJobState(), ...state, ...getSettings(legacySettings) }
        : defaultState();
    } catch (_error) {
      return defaultState();
    }
  }

  function setState(state) {
    try {
      window.sessionStorage.setItem(STORAGE_KEY, JSON.stringify(jobStateForStorage(state)));
    } catch (error) {
      setNotice(`Úlohu nelze uložit pouze pro toto okno: ${error.message}`, 'error');
      return false;
    }
    render(state);
    return true;
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
    const scanSettings = readSettings();
    setSettings(scanSettings);
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
      const settings = readSettings();
      setSettings(settings);
      const limit = settings.maxProfiles;
      const queue = [...profiles.values()].slice(0, limit);
      const missingIcons = queue.filter((target) => !target.reactionIconUrl).length;
      state.sourceUrl = location.href;
      state.queue = queue;
      state.reactionLabel = selectedReactionLabel(dialog);
      state.currentIndex = 0;
      state.jobStatus = 'idle';
      state.mode = settings.mode;
      state.timings = settings.timings;
      state.maxProfiles = limit;
      state.completionAlertShown = false;
      state.runBlockedCount = 0;
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
      render(getState());
    }
  }

  function labelOf(element) {
    return compact([
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.innerText
    ].filter(Boolean).join(' '));
  }

  function labelPartsOf(element) {
    return [
      element.getAttribute('aria-label'),
      element.getAttribute('title'),
      element.innerText
    ].map(compact).filter(Boolean);
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
      const isConfirmation = labelPartsOf(element).some((part) => matchesAny(part, LABELS.confirm));
      return isExplicitBlock || isConfirmation;
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

  function readSettings(fallback = getSettings()) {
    const modeElement = document.querySelector('#fdb-mode');
    const mode = modeElement ? modeElement.value : fallback.mode;
    const clickMin = readNumber('fdb-click-min', fallback.timings.clickMin, 1000, 60000);
    const clickMax = readNumber('fdb-click-max', fallback.timings.clickMax, clickMin, 60000);
    const profileMin = readNumber('fdb-profile-min', fallback.timings.profileMin, 1000, 300000);
    const profileMax = readNumber('fdb-profile-max', fallback.timings.profileMax, profileMin, 300000);
    const maxProfiles = readNumber('fdb-max', fallback.maxProfiles, 1);
    return normalizeSettings({ mode, timings: { clickMin, clickMax, profileMin, profileMax }, maxProfiles }, fallback);
  }

  function readNumber(id, fallback, min, max) {
    const value = Number(document.getElementById(id)?.value);
    return Number.isFinite(value)
      ? (max === undefined ? Math.max(min, Math.round(value)) : Math.min(max, Math.max(min, Math.round(value))))
      : fallback;
  }

  const RETRYABLE_STATUSES = new Set(['pending', 'error', 'skipped', 'preview', 'working']);
  const PROCESSABLE_STATUSES = new Set(['pending', 'error']);

  function firstProcessableIndex(state) {
    return state.queue.findIndex((target) => PROCESSABLE_STATUSES.has(target.status));
  }

  function prepareRetry(state) {
    state.queue = state.queue.map((target) => {
      if (!RETRYABLE_STATUSES.has(target.status) || target.status === 'pending') return target;
      return { ...target, status: 'pending', note: '' };
    });
    const firstPending = firstProcessableIndex(state);
    if (firstPending < 0) return false;
    state.currentIndex = firstPending;
    state.completionAlertShown = false;
    state.runBlockedCount = 0;
    return true;
  }

  function completeJob(state, message = 'Hotovo. Fronta byla zpracována.', allowAlert = true) {
    const wasComplete = state.jobStatus === 'complete';
    state.currentIndex = state.queue.length;
    state.jobStatus = 'complete';
    if (!wasComplete) addLog(state, 'Fronta dokončena.');

    const counts = state.queue.reduce((result, target) => {
      result[target.status] = (result[target.status] || 0) + 1;
      return result;
    }, {});
    const shouldAlert = allowAlert
      && state.mode !== 'dry'
      && counts.blocked > 0
      && state.runBlockedCount > 0
      && !counts.error
      && !state.completionAlertShown;
    if (shouldAlert) state.completionAlertShown = true;
    setState(state);
    setNotice(message, 'ok');
    if (shouldAlert) window.alert('Blokování doběhlo úspěšně do konce.');
  }

  async function startJob() {
    if (busy) return;
    const settings = readSettings();
    setSettings(settings);
    const state = getState();
    if (!state.queue.length) {
      setNotice('Fronta je prázdná. Nejdřív načti profily z dialogu reakcí.', 'error');
      return;
    }

    state.mode = settings.mode;
    state.timings = settings.timings;
    state.maxProfiles = settings.maxProfiles;
    state.queue = state.queue.slice(0, settings.maxProfiles);

    if (state.jobStatus === 'complete' && !prepareRetry(state)) {
      setNotice('Ve frontě není žádný profil, který by bylo možné znovu zpracovat.', 'ok');
      return;
    }

    if (state.mode === 'dry') {
      state.queue = state.queue.map((target) => target.status === 'blocked'
        ? target
        : { ...target, status: 'preview', note: 'Bez zásahu' });
      state.currentIndex = state.queue.length;
      state.completionAlertShown = false;
      state.runBlockedCount = 0;
      addLog(state, `Režim nanečisto dokončen pro ${state.queue.length} profilů; nic nebylo změněno.`);
      completeJob(state, 'Režim nanečisto dokončen. Nebyl zablokován žádný profil.');
      return;
    }

    const processableQueue = state.queue.filter((target) => PROCESSABLE_STATUSES.has(target.status));
    const missingIcons = processableQueue.filter((target) => !target.reactionIconUrl).length;
    if (missingIcons) {
      setNotice(`Ostrý režim nelze spustit: u ${missingIcons} profilů chybí načtená ikonka reakce. Načti seznam reakcí znovu.`, 'error');
      return;
    }

    const remaining = processableQueue.length;
    if (!remaining) {
      completeJob(state, 'Ve frontě není žádný profil, který by bylo možné zpracovat.', false);
      return;
    }
    const warning = state.mode === 'automatic'
      ? `Automatický režim skutečně zablokuje až ${remaining} profilů bez dalšího potvrzení. Pokračovat?`
      : `Asistovaný režim otevře až ${remaining} profilů a před každým blokováním se zeptá. Pokračovat?`;
    if (!window.confirm(warning)) return;

    const firstPending = firstProcessableIndex(state);
    if (firstPending < 0) {
      completeJob(state, undefined, false);
      return;
    }
    state.currentIndex = firstPending;
    state.jobStatus = 'running';
    state.completionAlertShown = false;
    state.runBlockedCount = 0;
    addLog(state, `Spuštěn ${state.mode === 'guided' ? 'asistovaný' : 'automatický'} režim.`);
    setState(state);
    await resumeJob();
  }

  async function resumeJob() {
    if (busy) return;
    let state = getState();
    if (state.jobStatus !== 'running') return;
    let target = currentTarget(state);
    if (!target || !PROCESSABLE_STATUSES.has(target.status)) {
      const firstPending = firstProcessableIndex(state);
      if (firstPending < 0) {
        completeJob(state);
        return;
      }
      state.currentIndex = firstPending;
      target = currentTarget(state);
      setState(state);
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
      if (state.jobStatus !== 'running') {
        const interruptedTarget = currentTarget(state);
        if (interruptedTarget?.status === 'working') {
          interruptedTarget.status = result;
          interruptedTarget.note = result === 'blocked' ? 'Zablokováno' : 'Přeskočeno uživatelem';
          if (result === 'blocked') state.runBlockedCount = (state.runBlockedCount || 0) + 1;
          addLog(state, `${interruptedTarget.name}: ${interruptedTarget.note}.`);
          state.currentIndex += 1;
        }
        setState(state);
        return;
      }
      const freshTarget = currentTarget(state);
      if (!freshTarget) {
        completeJob(state);
        return;
      }
      freshTarget.status = result;
      freshTarget.note = result === 'blocked' ? 'Zablokováno' : 'Přeskočeno uživatelem';
      if (result === 'blocked') state.runBlockedCount = (state.runBlockedCount || 0) + 1;
      addLog(state, `${freshTarget.name}: ${freshTarget.note}.`);
      state.currentIndex += 1;
      const nextPending = firstProcessableIndex(state);
      if (nextPending < 0) {
        completeJob(state);
        return;
      }
      state.currentIndex = nextPending;

      setState(state);
      const delay = randomBetween(state.timings.profileMin, state.timings.profileMax);
      setNotice(`Další profil za ${(delay / 1000).toFixed(1)} s…`, 'working');
      await sleep(delay);
      state = getState();
      if (state.jobStatus === 'running') location.assign(currentTarget(state).url);
    } catch (error) {
      state = getState();
      if (state.jobStatus === 'stopped') {
        const interruptedTarget = currentTarget(state);
        if (interruptedTarget?.status === 'working') {
          interruptedTarget.status = 'pending';
          interruptedTarget.note = 'Zastaveno před dokončením';
        }
        setState(state);
        return;
      }
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
      render(getState());
    }
  }

  function pauseJob() {
    const state = getState();
    if (state.jobStatus !== 'running') return;
    state.jobStatus = 'paused';
    addLog(state, 'Úloha pozastavena uživatelem.');
    setState(state);
    setNotice('Pozastaveno. Probíhající kliknutí již nelze vrátit.', 'ok');
  }

  async function continueJob() {
    if (busy) return;
    const state = getState();
    if (!state.queue.length || !['paused', 'stopped'].includes(state.jobStatus)) return;
    if (currentTarget(state)?.status === 'working') {
      currentTarget(state).status = 'pending';
      currentTarget(state).note = '';
    }
    const firstPending = firstProcessableIndex(state);
    if (firstPending < 0) {
      setNotice('Ve frontě není žádný profil, který by bylo možné pokračovat.', 'ok');
      return;
    }
    state.currentIndex = firstPending;
    state.jobStatus = 'running';
    addLog(state, 'Úloha znovu spuštěna.');
    setState(state);
    await resumeJob();
  }

  async function skipCurrent() {
    if (busy) return;
    const state = getState();
    const target = currentTarget(state);
    if (!target || target.status === 'blocked' || state.jobStatus === 'complete') return;
    const wasRunning = state.jobStatus === 'running';
    target.status = 'skipped';
    target.note = 'Ručně přeskočeno';
    addLog(state, `${target.name}: ručně přeskočeno.`);
    state.currentIndex += 1;
    const nextPending = firstProcessableIndex(state);
    if (nextPending < 0) {
      completeJob(state);
      return;
    }
    state.currentIndex = nextPending;
    if (wasRunning) state.jobStatus = 'running';
    setState(state);
    if (wasRunning) await resumeJob();
  }

  function stopJob() {
    const currentState = getState();
    if (!['running', 'paused'].includes(currentState.jobStatus)) return;
    if (!window.confirm('Ukončit úlohu? Dosud provedená blokování nelze vrátit tímto skriptem.')) return;
    const state = getState();
    if (!['running', 'paused'].includes(state.jobStatus)) return;
    state.jobStatus = 'stopped';
    addLog(state, 'Úloha ukončena uživatelem.');
    setState(state);
    setNotice('Úloha byla ukončena.', 'ok');
  }

  function clearJob() {
    const state = getState();
    if (busy || ['running', 'paused'].includes(state.jobStatus)) {
      setNotice('Frontu nelze vymazat během běhu. Nejdřív použij Stop.', 'error');
      return;
    }
    if (!window.confirm('Vymazat načtenou frontu a místní protokol?')) return;
    try {
      window.sessionStorage.removeItem(STORAGE_KEY);
    } catch (error) {
      setNotice(`Frontu nelze vymazat: ${error.message}`, 'error');
      return;
    }
    render(defaultState());
    setNotice('Fronta byla vymazána.', 'ok');
  }

  async function handleRunAction() {
    const state = getState();
    if (state.jobStatus === 'running') {
      pauseJob();
    } else if (busy) {
      return;
    } else if (['paused', 'stopped'].includes(state.jobStatus)) {
      await continueJob();
    } else {
      await startJob();
    }
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

  function targetStatusLabel(status) {
    return ({
      pending: 'čeká', working: 'zpracovává se', blocked: 'zablokováno',
      skipped: 'přeskočeno', error: 'chyba', preview: 'náhled'
    })[status] || 'čeká';
  }

  function runButtonState(status) {
    return ({
      idle: { icon: '▶', label: 'Spustit', title: 'Spustit zpracování fronty' },
      running: { icon: '⏸', label: 'Pauza', title: 'Pozastavit zpracování fronty' },
      paused: { icon: '▶', label: 'Pokračovat', title: 'Pokračovat ve zpracování fronty' },
      stopped: { icon: '▶', label: 'Pokračovat', title: 'Pokračovat ve zpracování fronty' },
      complete: { icon: '↻', label: 'Spustit znovu', title: 'Znovu zpracovat přeskočené a chybové profily' }
    })[status] || { icon: '▶', label: 'Spustit', title: 'Spustit zpracování fronty' };
  }

  function escapeHtml(value) {
    return String(value).replace(/[&<>'"]/g, (character) => ({
      '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;'
    })[character]);
  }

  function panelMarkup() {
    return `
      <header>
        <strong>Reaction Blocker 0.1.10</strong>
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
        <label>Maximum profilů v jednom běhu<input id="fdb-max" type="number" min="1"></label>
        <div id="fdb-summary">
          <div class="fdb-queue-heading">
            <strong id="fdb-list-heading">Fronta (0)</strong>
            <button id="fdb-source" title="Vrátit se k původnímu příspěvku"><span aria-hidden="true">↩</span> Zpět na příspěvek</button>
          </div>
          <span id="fdb-compat-summary" class="fdb-visually-hidden"></span>
        </div>
        <div id="fdb-list" role="list" aria-labelledby="fdb-list-heading"></div>
        <div class="fdb-actions">
          <button id="fdb-run" data-role="run" class="fdb-danger"><span class="fdb-button-icon" aria-hidden="true">▶</span> <span class="fdb-button-label">Spustit</span></button>
          <button id="fdb-skip"><span class="fdb-button-icon" aria-hidden="true">⏭</span> Přeskočit</button>
          <button id="fdb-stop"><span class="fdb-button-icon" aria-hidden="true">■</span> Stop</button>
        </div>
        <div id="fdb-notice" aria-live="polite"></div>
        <div id="fdb-metrics" aria-live="polite"></div>
        <details><summary>Protokol</summary><pre id="fdb-log"></pre></details>
        <div class="fdb-maintenance"><button id="fdb-clear"><span class="fdb-button-icon" aria-hidden="true">⌫</span> Vymazat frontu</button></div>
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
      #${PANEL_ID} #fdb-summary { margin-top: 10px; }
      #${PANEL_ID} .fdb-queue-heading { display: flex; align-items: center; justify-content: space-between; gap: 6px; }
      #${PANEL_ID} .fdb-queue-heading strong { font-size: 14px; }
      #${PANEL_ID} .fdb-queue-heading button { padding: 4px 6px; font-size: 11px; }
      #${PANEL_ID} #fdb-list { max-height: 250px; overflow: auto; margin-top: 6px; border: 1px solid #e4e6eb; border-radius: 5px; }
      #${PANEL_ID} .fdb-row { display: flex; gap: 6px; align-items: center; padding: 4px 6px; border-bottom: 1px solid #eee; }
      #${PANEL_ID} .fdb-row:last-child { border-bottom: 0; }
      #${PANEL_ID} .fdb-row.fdb-current { background: #e7f0fd; outline: 1px solid #1877f2; outline-offset: -1px; }
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
      #${PANEL_ID} #fdb-metrics { margin-top: 7px; color: #4b4f56; font-size: 12px; }
      #${PANEL_ID} .fdb-maintenance { display: flex; justify-content: flex-end; margin-top: 7px; }
      #${PANEL_ID} .fdb-button-icon { display: inline-block; min-width: 1em; text-align: center; }
      #${PANEL_ID} .fdb-visually-hidden { position: absolute; width: 1px; height: 1px; padding: 0; margin: -1px; overflow: hidden; clip: rect(0, 0, 0, 0); white-space: nowrap; border: 0; }
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
    ui.querySelector('#fdb-run').addEventListener('click', handleRunAction);
    ui.querySelector('#fdb-skip').addEventListener('click', skipCurrent);
    ui.querySelector('#fdb-stop').addEventListener('click', stopJob);
    ui.querySelector('#fdb-source').addEventListener('click', returnToSource);
    ui.querySelector('#fdb-clear').addEventListener('click', clearJob);
    ['#fdb-mode', '#fdb-click-min', '#fdb-click-max', '#fdb-profile-min', '#fdb-profile-max', '#fdb-max']
      .forEach((selector) => {
        const control = ui.querySelector(selector);
        control.addEventListener('input', persistSettingsFromUi);
        control.addEventListener('change', persistSettingsFromUi);
      });
    render(getState());
  }

  function render(state) {
    if (!ui) return;
    const counts = state.queue.reduce((result, target) => {
      result[target.status] = (result[target.status] || 0) + 1;
      return result;
    }, {});
    ui.querySelector('#fdb-list-heading').textContent = `Fronta (${state.queue.length})`;
    ui.querySelector('#fdb-compat-summary').textContent = `Stav: ${statusText(state.jobStatus)} · profilů: ${state.queue.length}`;
    const settings = getSettings();
    ui.querySelector('#fdb-mode').value = settings.mode;
    ui.querySelector('#fdb-click-min').value = settings.timings.clickMin;
    ui.querySelector('#fdb-click-max').value = settings.timings.clickMax;
    ui.querySelector('#fdb-profile-min').value = settings.timings.profileMin;
    ui.querySelector('#fdb-profile-max').value = settings.timings.profileMax;
    ui.querySelector('#fdb-max').value = settings.maxProfiles;

    const focusIndex = state.currentIndex < state.queue.length ? state.currentIndex : state.queue.length - 1;
    ui.querySelector('#fdb-list').innerHTML = state.queue.length
      ? state.queue.map((target, index) => `
          <div class="fdb-row${index === focusIndex && ['running', 'paused', 'stopped'].includes(state.jobStatus) ? ' fdb-current' : ''}" data-index="${index}" role="listitem" aria-posinset="${index + 1}" aria-setsize="${state.queue.length}"${index === focusIndex && ['running', 'paused', 'stopped'].includes(state.jobStatus) ? ' aria-current="true"' : ''} title="${escapeHtml(target.note || target.url)}" aria-label="${escapeHtml(`${index + 1}. ${target.name}, ${targetStatusLabel(target.status)}`)}">
            ${target.reactionIconUrl
              ? `<img class="fdb-reaction-icon" src="${escapeHtml(target.reactionIconUrl)}" alt="Načtená reakce" loading="lazy">`
              : '<span class="fdb-reaction-missing" title="Ikonka reakce nebyla načtena">!</span>'}
            <span class="fdb-name">${escapeHtml(`${index + 1}. ${target.name}`)}</span>
            <span class="fdb-target-status" title="${escapeHtml(`Stav: ${targetStatusLabel(target.status)}`)}" aria-label="${escapeHtml(targetStatusLabel(target.status))}">${targetStatusIcon(target.status)}</span>
          </div>`).join('')
      : '<div class="fdb-row"><span>Fronta je prázdná.</span></div>';
    ui.querySelector('#fdb-metrics').textContent =
      `Blokováno: ${counts.blocked || 0}  Přeskočeno: ${counts.skipped || 0}  Chyby: ${counts.error || 0}`;
    ui.querySelector('#fdb-log').textContent = (state.log || []).join('\n');
    const runButton = ui.querySelector('#fdb-run');
    const runState = runButtonState(state.jobStatus);
    runButton.querySelector('.fdb-button-icon').textContent = runState.icon;
    runButton.querySelector('.fdb-button-label').textContent = runState.label;
    runButton.title = runState.title;
    runButton.setAttribute('aria-label', `${runState.label}. ${runState.title}`);
    runButton.disabled = busy && state.jobStatus !== 'running';
    const target = currentTarget(state);
    ui.querySelector('#fdb-scan').disabled = busy || ['running', 'paused'].includes(state.jobStatus);
    ui.querySelector('#fdb-skip').disabled = busy || !target || target.status === 'blocked' || state.jobStatus === 'complete';
    ui.querySelector('#fdb-stop').disabled = !['running', 'paused'].includes(state.jobStatus);
    ui.querySelector('#fdb-source').disabled = busy || !state.sourceUrl || ['running', 'paused'].includes(state.jobStatus);
    ui.querySelector('#fdb-clear').disabled = busy || ['running', 'paused'].includes(state.jobStatus);
    if (['running', 'paused', 'stopped'].includes(state.jobStatus)) {
      const currentRow = ui.querySelector(`#fdb-list [data-index="${focusIndex}"]`);
      if (currentRow && typeof currentRow.scrollIntoView === 'function') currentRow.scrollIntoView({ block: 'nearest' });
    }
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
