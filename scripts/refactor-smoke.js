#!/usr/bin/env node

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

function loadPluginClass() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
  const factory = new Function('AppPlugin', `${source}; return Plugin;`);
  return factory(class AppPlugin {});
}

function makeDate(value) {
  return value ? new Date(value) : null;
}

function makeProperty(name, value) {
  return {
    name,
    value,
    text() {
      return typeof value === 'string' ? value : '';
    },
    choice() {
      return null;
    }
  };
}

function makeRecord({ guid, name, updatedAt, createdAt, properties = [], journal = false, journalDate = null }) {
  return {
    guid,
    getName() {
      return name;
    },
    getUpdatedAt() {
      return updatedAt || null;
    },
    getCreatedAt() {
      return createdAt || null;
    },
    getAllProperties() {
      return properties;
    },
    getJournalDetails() {
      return journal ? { date: journalDate || new Date(2026, 2, 11) } : null;
    }
  };
}

function makeCollection({ guid, name }) {
  return {
    getGuid() {
      return guid;
    },
    getName() {
      return name;
    }
  };
}

function makeLine({ guid, record, segments = [], type = 'text', createdAt, updatedAt, parentGuid = null }) {
  return {
    guid,
    record,
    segments,
    type,
    parent_guid: parentGuid,
    getRecord() {
      return record || null;
    },
    getCreatedAt() {
      return createdAt || null;
    },
    getUpdatedAt() {
      return updatedAt || null;
    }
  };
}

function makeJournalBacklinkFixture({ journalName = 'April 23rd 2026', sourceName = 'Source Note' } = {}) {
  const journal = makeRecord({
    guid: 'journal-guid',
    name: journalName,
    journal: true,
    journalDate: new Date(2026, 3, 23)
  });
  const source = makeRecord({
    guid: 'source-guid',
    name: sourceName,
    updatedAt: makeDate('2026-04-23T09:00:00Z')
  });
  const linkedLine = makeLine({
    guid: 'linked-line',
    record: source,
    segments: [{ type: 'ref', text: { guid: journal.guid, title: journal.getName() } }]
  });
  const dateLine = makeLine({
    guid: 'date-line',
    record: source,
    segments: [{ type: 'datetime', text: { d: '20260423' } }]
  });
  return { journal, source, linkedLine, dateLine };
}

function makePanel({ id, record, collection = null, element = null, type = 'edit_panel', navType = 'edit_panel' }) {
  let activeRecord = record || null;
  let activeCollection = collection || null;
  const navigateCalls = [];

  const panel = {
    getId() {
      return id;
    },
    getElement() {
      return element || {};
    },
    getType() {
      return type;
    },
    getNavigation() {
      return { type: navType };
    },
    getActiveRecord() {
      return activeRecord;
    },
    getActiveCollection() {
      return activeCollection;
    },
    setActiveRecord(nextRecord) {
      activeRecord = nextRecord;
    },
    setActiveCollection(nextCollection) {
      activeCollection = nextCollection;
    },
    navigateTo(payload) {
      navigateCalls.push(payload);
      if (payload?.rootId) {
        activeRecord = makeRecord({
          guid: payload.rootId,
          name: `Record ${payload.rootId}`
        });
      }
      return true;
    }
  };

  return {
    panel,
    navigateCalls,
    getActiveRecord() {
      return activeRecord;
    }
  };
}

function makePanelElement() {
  return {
    matches(selector) {
      return selector === '.page-content';
    },
    closest() {
      return null;
    },
    querySelector() {
      return null;
    }
  };
}

function installLocalStorage(initial = {}) {
  const store = new Map(Object.entries(initial).map(([key, value]) => [key, String(value)]));
  global.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, String(value));
    },
    removeItem(key) {
      store.delete(key);
    },
    clear() {
      store.clear();
    }
  };
  return store;
}

function datasetKeyFromAttribute(name) {
  return String(name || '').replace(/-([a-z])/g, (_match, letter) => letter.toUpperCase());
}

function getDomClassSet(el) {
  return new Set((el?.className || '').split(/\s+/).filter(Boolean));
}

function domElementMatches(el, selector) {
  const text = String(selector || '').trim();
  if (!el || !text) return false;

  const classDataMatch = text.match(/^\.([A-Za-z0-9_-]+)(?:\[data-([A-Za-z0-9_-]+)(?:="([^"]*)")?\])?$/);
  if (classDataMatch) {
    if (!getDomClassSet(el).has(classDataMatch[1])) return false;
    if (!classDataMatch[2]) return true;
    const key = datasetKeyFromAttribute(classDataMatch[2]);
    if (!(key in (el.dataset || {}))) return false;
    return classDataMatch[3] === undefined || String(el.dataset[key]) === classDataMatch[3];
  }

  const dataMatch = text.match(/^\[data-([A-Za-z0-9_-]+)(?:="([^"]*)")?\]$/);
  if (dataMatch) {
    const key = datasetKeyFromAttribute(dataMatch[1]);
    if (!(key in (el.dataset || {}))) return false;
    return dataMatch[2] === undefined || String(el.dataset[key]) === dataMatch[2];
  }

  return false;
}

function queryDomElements(root, selector, firstOnly = false, out = []) {
  for (const child of root?.children || []) {
    if (domElementMatches(child, selector)) {
      out.push(child);
      if (firstOnly) return out;
    }
    queryDomElements(child, selector, firstOnly, out);
    if (firstOnly && out.length > 0) return out;
  }
  return out;
}

function makeDomElement(tagName) {
  const listeners = {};
  const el = {
    tagName,
    children: [],
    dataset: {},
    attributes: {},
    className: '',
    textContent: '',
    disabled: false,
    parentNode: null,
    eventListeners: listeners,
    style: {
      setProperty(name, value) {
        this[name] = String(value);
      }
    },
    appendChild(child) {
      if (child && typeof child === 'object') child.parentNode = this;
      this.children.push(child);
      return child;
    },
    addEventListener(type, handler) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      listeners[type] = (listeners[type] || []).filter((fn) => fn !== handler);
    },
    contains(target) {
      if (target === this) return true;
      return this.children.some((child) => child?.contains?.(target));
    },
    querySelector(selector) {
      return queryDomElements(this, selector, true)[0] || null;
    },
    querySelectorAll(selector) {
      return queryDomElements(this, selector);
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    classList: {
      contains(name) {
        return getDomClassSet(el).has(name);
      },
      add(...names) {
        const existing = new Set((el.className || '').split(/\s+/).filter(Boolean));
        for (const name of names) existing.add(name);
        el.className = Array.from(existing).join(' ');
      },
      remove(...names) {
        const removeSet = new Set(names);
        const existing = (el.className || '').split(/\s+/).filter(Boolean)
          .filter((name) => !removeSet.has(name));
        el.className = existing.join(' ');
      },
      toggle(name, force) {
        const existing = new Set((el.className || '').split(/\s+/).filter(Boolean));
        const shouldAdd = force === undefined ? !existing.has(name) : force === true;
        if (shouldAdd) existing.add(name);
        else existing.delete(name);
        el.className = Array.from(existing).join(' ');
        return shouldAdd;
      }
    }
  };
  Object.defineProperty(el, 'innerHTML', {
    get() {
      return '';
    },
    set(value) {
      if (String(value || '') === '') {
        for (const child of this.children) {
          if (child && typeof child === 'object') child.parentNode = null;
        }
        this.children = [];
      }
    }
  });
  return el;
}

function getDomText(el) {
  if (!el || typeof el !== 'object') return '';
  let text = typeof el.textContent === 'string' ? el.textContent : '';
  for (const child of el.children || []) {
    text += getDomText(child);
  }
  return text;
}

function attachRefreshPanelState(plugin, panel, recordGuid, { collapseUnlinked = false } = {}) {
  const panelId = panel.getId();
  const state = plugin.createPanelState(panelId, panel);
  state.recordGuid = recordGuid;
  state.sectionCollapsed.unlinked = collapseUnlinked === true;
  state.rootEl = makeDomElement('div');
  state.rootEl.isConnected = true;
  state.bodyEl = makeDomElement('div');
  state.countEl = makeDomElement('span');
  plugin._panelStates.set(panelId, state);
  return state;
}

function attachRenderSlots(state) {
  state.bodyEl = makeDomElement('div');
  state.countEl = makeDomElement('span');
  state.statusSlotEl = makeDomElement('div');
  state.propertySlotEl = makeDomElement('div');
  state.linkedSlotEl = makeDomElement('div');
  state.unlinkedSlotEl = makeDomElement('div');
  return state;
}

function makePlugin() {
  const Plugin = loadPluginClass();
  const plugin = new Plugin();
  plugin.getWorkspaceGuid = () => 'test-workspace-guid';

  plugin._panelStates = new Map();
  plugin._eventHandlerIds = [];
  plugin._lineContentTextCache = new WeakMap();
  plugin._perfStorageKey = 'thymer_backreferences_perf_v1';
  plugin._perfMaxSamples = 120;
  plugin._perfSamples = [];
  plugin._perfSeq = 0;
  plugin._perfSessionStartedAt = new Date('2026-05-07T00:00:00Z');
  plugin._defaultSortBy = 'page_last_edited';
  plugin._defaultSortDir = 'desc';
  plugin._defaultFilterPreset = 'all';
  plugin._recentActivityWindowMs = 7 * 24 * 60 * 60 * 1000;
  plugin._defaultContextPreloadMaxLines = 30;
  plugin._linkedDateSearchDelayMs = 1200;
  plugin._defaultQueryFilterMaxResults = 1000;
  plugin._maxStoredPageViewRecords = 400;
  plugin._maxStoredSortByRecords = 400;
  plugin._maxStoredPropGroupStates = 160;
  plugin._maxStoredRecordGroupStates = 600;
  plugin._storageKeyVisibility = 'thymer_backreferences_visibility_v1';
  plugin._visibilityConfig = plugin.normalizeVisibilityConfig(null, true);
  plugin._queryBuiltInKeys = [
    'created_at', 'modified_at', 'created_by', 'modified_by', 'text', 'type', 'date',
    'due', 'time', 'mention', 'scheduled', 'hashtag', 'link', 'collection', 'guid',
    'pguid', 'rguid', 'backref', 'linkto'
  ];

  const recordsByGuid = new Map();
  const users = [
    {
      guid: 'user-1',
      getDisplayName() {
        return 'Harpreet';
      }
    }
  ];

  plugin.data = {
    getRecord(guid) {
      return recordsByGuid.get(guid) || null;
    },
    getActiveUsers() {
      return users;
    },
    getPluginByGuid() {
      throw new Error('visibility tests must not save plugin configuration');
    }
  };

  const toasters = [];
  let activePanel = null;
  let panels = [];
  plugin.ui = {
    createIcon() {
      return { classList: { add() {} } };
    },
    addToaster(options) {
      toasters.push(options);
      return { remove() {} };
    },
    getActivePanel() {
      return activePanel;
    },
    getPanels() {
      return panels;
    }
  };

  plugin.__recordsByGuid = recordsByGuid;
  plugin.__toasters = toasters;
  plugin.__setActivePanel = (panel) => {
    activePanel = panel;
  };
  plugin.__setPanels = (nextPanels) => {
    panels = Array.isArray(nextPanels) ? nextPanels : [];
  };
  return plugin;
}

function makeLoadedFocusedPanelFixture({ pendingRemoteSync = false } = {}) {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note' });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = 'target-guid';
  state.lastResults = { propertyGroups: [], linkedGroups: [], unlinkedGroups: [] };
  state.pendingRemoteSync = pendingRemoteSync;
  plugin._panelStates.set('panel-1', state);
  plugin.findMountContainer = () => ({});
  plugin.mountFooter = () => {};

  return { plugin, panel, state };
}

function attachTwoPanelStates(plugin, {
  targetAName = 'Target A',
  targetBName = 'Target B'
} = {}) {
  const targetA = makeRecord({ guid: 'target-a', name: targetAName });
  const targetB = makeRecord({ guid: 'target-b', name: targetBName });
  const panelA = makePanel({ id: 'panel-a', record: targetA });
  const panelB = makePanel({ id: 'panel-b', record: targetB });
  const stateA = plugin.createPanelState('panel-a', panelA.panel);
  const stateB = plugin.createPanelState('panel-b', panelB.panel);
  stateA.recordGuid = targetA.guid;
  stateB.recordGuid = targetB.guid;
  plugin._panelStates.set('panel-a', stateA);
  plugin._panelStates.set('panel-b', stateB);

  const refreshes = [];
  plugin.scheduleRefreshForPanel = (panel, args) => {
    refreshes.push({ id: panel.getId(), reason: args.reason });
  };

  return { targetA, targetB, stateA, stateB, refreshes };
}

function makeFooterActionEl(action, dataset = {}, extras = {}) {
  return {
    dataset: { action, ...dataset },
    ...extras
  };
}

function clickFooterAction(plugin, panelId, actionEl, event = {}) {
  const openLineEl = actionEl?.dataset?.action === 'open-line' ? actionEl : null;
  const target = event.target || {
    closest(selector) {
      if (selector === '[data-action="open-line"]') return openLineEl;
      if (selector === '[data-action]') return actionEl;
      return null;
    }
  };

  plugin.handleFooterClick({
    currentTarget: { dataset: { panelId } },
    target,
    ...event
  });
}

function installDomDocument() {
  const listeners = {};
  return {
    eventListeners: listeners,
    createElement: makeDomElement,
    createTextNode(text) {
      return { tagName: '#text', textContent: String(text || ''), children: [] };
    },
    addEventListener(type, handler) {
      if (!listeners[type]) listeners[type] = [];
      listeners[type].push(handler);
    },
    removeEventListener(type, handler) {
      listeners[type] = (listeners[type] || []).filter((fn) => fn !== handler);
    }
  };
}

function withDomDocument(fn) {
  const previousDocument = global.document;
  const previousRequestAnimationFrame = global.requestAnimationFrame;
  const doc = installDomDocument();
  global.document = doc;
  global.requestAnimationFrame = (handler) => {
    handler();
    return 1;
  };

  try {
    return fn(doc);
  } finally {
    global.document = previousDocument;
    global.requestAnimationFrame = previousRequestAnimationFrame;
  }
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

test('visibility config normalizes local values and falls back visible', () => {
  const plugin = makePlugin();
  installLocalStorage();

  assert.deepEqual(plugin.normalizeVisibilityConfig(null, true), {
    version: 1,
    defaultVisible: true,
    collections: {},
    updatedAt: 0
  });

  const normalized = plugin.normalizeVisibilityConfig({
    version: 9,
    defaultVisible: false,
    collections: {
      'collection-a': true,
      'collection-b': false,
      '': true,
      'collection-c': 'yes'
    },
    updatedAt: 42.9
  }, true);

  assert.equal(normalized.version, 1);
  assert.equal(normalized.defaultVisible, false);
  assert.deepEqual(normalized.collections, { 'collection-a': true });
  assert.equal(normalized.updatedAt, 42);
});

test('global visibility toggle flips default, clears collection overrides, and stays local', () => {
  const plugin = makePlugin();
  const store = installLocalStorage();
  plugin._visibilityConfig = plugin.normalizeVisibilityConfig({
    defaultVisible: true,
    collections: { 'collection-a': false }
  }, true);
  plugin.reconcileAllPanelsVisibility = (args) => {
    plugin.__reconciled = args;
  };

  plugin.toggleDefaultVisibility();

  assert.equal(plugin._visibilityConfig.defaultVisible, false);
  assert.deepEqual(plugin._visibilityConfig.collections, {});
  assert.equal(plugin.__reconciled.refreshVisible, false);
  assert.equal(plugin.__reconciled.reason, 'toggle-global-visibility');
  assert.match(plugin.__toasters.at(-1).title, /hidden globally/);
  assert.equal(JSON.parse(store.get(plugin._storageKeyVisibility)).defaultVisible, false);
});

test('collection visibility toggle flips active collection and prunes default-equal overrides', () => {
  const plugin = makePlugin();
  installLocalStorage();
  const collection = makeCollection({ guid: 'collection-a', name: 'Journal' });
  const record = makeRecord({ guid: 'record-a', name: 'Today' });
  const { panel } = makePanel({ id: 'panel-a', record, collection });
  plugin.__setActivePanel(panel);
  plugin.reconcileAllPanelsVisibility = (args) => {
    plugin.__reconciled = args;
  };

  plugin._visibilityConfig = plugin.normalizeVisibilityConfig({
    defaultVisible: true,
    collections: {}
  }, true);
  plugin.toggleVisibilityForActiveCollection();

  assert.deepEqual(plugin._visibilityConfig.collections, { 'collection-a': false });
  assert.equal(plugin.__reconciled.collectionGuid, 'collection-a');
  assert.equal(plugin.__reconciled.refreshVisible, false);
  assert.match(plugin.__toasters.at(-1).title, /hidden for Journal/);

  plugin.toggleVisibilityForActiveCollection();

  assert.deepEqual(plugin._visibilityConfig.collections, {});
  assert.equal(plugin.__reconciled.refreshVisible, true);
  assert.match(plugin.__toasters.at(-1).title, /shown for Journal/);
});

test('collection visibility toggle without active collection toasts and does not save', () => {
  const plugin = makePlugin();
  const store = installLocalStorage();
  plugin.__setActivePanel(null);

  plugin.toggleVisibilityForActiveCollection();

  assert.equal(store.has(plugin._storageKeyVisibility), false);
  assert.match(plugin.__toasters.at(-1).title, /No active collection/);
});

test('performance diagnostics are opt-in and omit raw query text', async () => {
  const plugin = makePlugin();
  const previousWindow = global.window;
  const previousConsole = global.console;
  const store = installLocalStorage();
  global.window = {};
  global.console = {
    info() {},
    groupCollapsed() {},
    log() {},
    table() {},
    groupEnd() {}
  };
  plugin.data.searchByQuery = async () => ({
    lines: [makeLine({ guid: 'line-1', record: makeRecord({ guid: 'record-1', name: 'Record 1' }) })],
    records: []
  });

  try {
    plugin.installPerfConsoleHelper();
    assert.equal(global.window.BackreferencesPerf.status(), 'disabled');
    assert.equal(plugin.perfEnabled(), false);

    const disabledPerf = plugin.perfCreate('refresh', { reason: 'background' });
    plugin.perfLog(disabledPerf);
    assert.equal(plugin.getPerfSnapshot().sampleCount, 1);
    assert.equal(JSON.parse(global.window.BackreferencesPerf.report()).length, 0);

    global.window.BackreferencesPerf.enable();
    assert.equal(store.get(plugin._perfStorageKey), '1');
    const perf = plugin.perfCreate('refresh', { reason: 'test' });
    await plugin.timedSearchByQuery('"Sensitive Note Title"', 25, perf, 'unlinked');
    plugin.perfLog(perf);

    const report = JSON.parse(global.window.BackreferencesPerf.report());
    assert.equal(report.length, 1);
    assert.equal(report[0].steps[0].step, 'search: unlinked');
    assert.equal(JSON.stringify(report).includes('Sensitive Note Title'), false);

    const snapshot = plugin.getPerfSnapshot();
    assert.equal(snapshot.plugin, 'Backreferences');
    assert.equal(snapshot.sampleCount, 2);
    assert.equal(snapshot.samples.at(-1).steps[0].step, 'search: unlinked');
    assert.equal(JSON.stringify(snapshot).includes('Sensitive Note Title'), false);

    global.window.BackreferencesPerf.disable();
    assert.equal(store.has(plugin._perfStorageKey), false);
  } finally {
    global.window = previousWindow;
    global.console = previousConsole;
  }
});

test('navigation diagnostic helper reports live line visibility evidence', async () => {
  const plugin = makePlugin();
  const previousWindow = global.window;
  const previousDocument = global.document;
  const previousConsole = global.console;
  const rows = [];
  const targetEl = {
    tagName: 'DIV',
    className: 'line-item is-highlighted',
    innerText: 'On Hillary Lane in conversation with Tony Chamas',
    closest() {
      return null;
    },
    getBoundingClientRect() {
      return { x: 10, y: 120, width: 600, height: 24, top: 120, bottom: 144, left: 10, right: 610 };
    }
  };

  global.window = { innerWidth: 1000, innerHeight: 800 };
  global.document = {
    title: 'Thymer :: chima :: Benjamin Studebaker',
    querySelectorAll(selector) {
      if (selector === '[data-action="open-line"]') return rows;
      if (selector === 'body *') return [targetEl];
      return [];
    }
  };
  global.console = {
    info() {},
    warn() {},
    log() {},
    table() {}
  };

  try {
    plugin.installNavigationTestConsoleHelper();
    assert.equal(typeof global.window.BackreferencesNavTest.run, 'function');
    assert.match(global.window.BackreferencesNavTest.help(), /BackreferencesNavTest\.run/);

    const missing = await global.window.BackreferencesNavTest.run({ text: 'Missing', waitMs: 0 });
    assert.equal(missing.ok, false);
    assert.match(missing.reason, /No matching/);

    const root = { dataset: { panelId: 'panel-1' } };
    const row = {
      dataset: {
        action: 'open-line',
        recordGuid: 'record-guid',
        lineGuid: 'line-guid'
      },
      innerText: 'On Hillary Lane in conversation with Tony Chamas',
      closest(selector) {
        return selector === '.tlr-footer' ? root : null;
      }
    };
    const calls = [];
    rows.push(row);
    plugin._panelStates.set('panel-1', { panel: { getId: () => 'panel-1' } });
    plugin.openRecord = async (_panel, recordGuid, lineGuid, event) => {
      calls.push({ recordGuid, lineGuid, ctrlKey: event.ctrlKey === true });
    };

    const found = global.window.BackreferencesNavTest.find({ text: 'Hillary Lane' });
    assert.equal(found.found, true);
    assert.equal(found.lineGuid, 'line-guid');

    const result = await global.window.BackreferencesNavTest.run({ text: 'Hillary Lane', mode: 'new', waitMs: 0 });
    assert.equal(result.ok, true);
    assert.equal(result.visibleMatchCount, 1);
    assert.equal(result.highlightedVisible, true);
    assert.deepEqual(calls, [{ recordGuid: 'record-guid', lineGuid: 'line-guid', ctrlKey: true }]);
  } finally {
    global.window = previousWindow;
    global.document = previousDocument;
    global.console = previousConsole;
  }
});

test('performance ring buffer keeps bounded structured samples', () => {
  const plugin = makePlugin();
  plugin._perfMaxSamples = 3;

  for (let i = 0; i < 5; i += 1) {
    plugin.recordPerfSample({
      label: 'sample',
      totalMs: i + 0.04,
      meta: { reason: `reason-${i}` },
      counts: { scannedRecords: i },
      steps: [{ step: 'work', ms: i + 0.05 }]
    });
  }

  const snapshot = plugin.getPerfSnapshot();
  assert.equal(snapshot.maxSamples, 3);
  assert.equal(snapshot.sampleCount, 3);
  assert.deepEqual(snapshot.samples.map((sample) => sample.seq), [3, 4, 5]);
  assert.deepEqual(snapshot.samples.map((sample) => sample.meta.reason), ['reason-2', 'reason-3', 'reason-4']);
  assert.equal(snapshot.samples[0].counts.scannedRecords, 2);
  assert.equal(snapshot.samples[0].steps[0].ms, 2.1);
});

test('copy perf snapshot command writes snapshot JSON to clipboard', async () => {
  const plugin = makePlugin();
  const previousNavigatorDescriptor = Object.getOwnPropertyDescriptor(global, 'navigator');
  let clipboardText = '';
  Object.defineProperty(global, 'navigator', {
    configurable: true,
    value: {
      clipboard: {
        async writeText(text) {
          clipboardText = text;
        }
      }
    }
  });

  plugin.recordPerfSample({
    label: 'property-index',
    totalMs: 12.34,
    meta: { reason: 'test-copy' },
    counts: { scannedRecords: 42 },
    steps: [{ step: 'scan', ms: 12.34 }]
  });

  try {
    const result = await plugin.copyPerfSnapshotToClipboard();
    const parsed = JSON.parse(clipboardText);

    assert.equal(result.copied, true);
    assert.equal(parsed.plugin, 'Backreferences');
    assert.equal(parsed.sampleCount, 1);
    assert.equal(parsed.samples[0].label, 'property-index');
    assert.equal(parsed.samples[0].counts.scannedRecords, 42);
    assert.match(plugin.__toasters.at(-1).title, /copied/);
  } finally {
    if (previousNavigatorDescriptor) {
      Object.defineProperty(global, 'navigator', previousNavigatorDescriptor);
    } else {
      delete global.navigator;
    }
  }
});

test('onLoad skips graph-wide property indexing startup work', async () => {
  const plugin = makePlugin();
  const oldIndexCacheKey = 'thymer_backreferences_property_index_cache_v1';
  const store = installLocalStorage({
    [oldIndexCacheKey]: JSON.stringify({ version: 1, records: { stale: true } })
  });
  const previousSetTimeout = global.setTimeout;
  const previousClearTimeout = global.clearTimeout;
  const scheduled = [];

  global.setTimeout = (fn, delay) => {
    scheduled.push({ fn, delay });
    return scheduled.length;
  };
  global.clearTimeout = () => {};

  plugin.injectCss = () => {};
  plugin.installPerfConsoleHelper = () => {};
  plugin.handlePanelChanged = () => {};
  const commandLabels = [];
  plugin.ui = {
    addCommandPaletteCommand(command) {
      commandLabels.push(command.label);
      return { remove() {} };
    },
    getActivePanel() {
      return null;
    }
  };
  plugin.events = {
    on(eventName, callback) {
      return `${eventName}:${typeof callback}`;
    },
    off() {}
  };

  try {
    plugin.onLoad();
    assert.equal(commandLabels.includes('Backreferences: Copy Perf Snapshot'), true);
    assert.equal(commandLabels.includes('Backreferences: Rebuild Graph Index'), false);
    assert.deepEqual(scheduled.map((timer) => timer.delay), [250]);
    assert.equal(store.has(oldIndexCacheKey), false);
    await Promise.resolve();
  } finally {
    global.setTimeout = previousSetTimeout;
    global.clearTimeout = previousClearTimeout;
  }
});

test('reload refreshes panels without scheduling a property index rebuild', () => {
  const plugin = makePlugin();
  const scheduled = [];
  const refreshes = [];
  plugin.schedulePropertyIndexRebuild = (reason, delayMs) => {
    scheduled.push({ reason, delayMs });
  };
  plugin.refreshAllPanels = (args) => {
    refreshes.push(args);
  };

  plugin.handlePluginReload();

  assert.deepEqual(scheduled, []);
  assert.deepEqual(refreshes, [{ force: true, reason: 'reload' }]);
});

test('hidden visible-eligible panel keeps state warm and skips mounting and refresh scheduling', () => {
  const plugin = makePlugin();
  installLocalStorage();
  const collection = makeCollection({ guid: 'collection-a', name: 'Hidden' });
  const record = makeRecord({ guid: 'record-a', name: 'Hidden Page' });
  const { panel } = makePanel({
    id: 'panel-a',
    record,
    collection,
    element: makePanelElement()
  });
  plugin._visibilityConfig = plugin.normalizeVisibilityConfig({
    defaultVisible: true,
    collections: { 'collection-a': false }
  }, true);

  let mounted = false;
  let refreshed = false;
  plugin.mountFooter = () => {
    mounted = true;
  };
  plugin.scheduleRefreshForPanel = () => {
    refreshed = true;
  };

  plugin.handlePanelChanged(panel, 'test-hidden');

  assert.equal(plugin._panelStates.has('panel-a'), true);
  assert.equal(plugin._panelStates.get('panel-a').recordGuid, 'record-a');
  assert.equal(mounted, false);
  assert.equal(refreshed, false);
});

test('hidden panels cancel pending footer timers without deleting state', () => {
  const plugin = makePlugin();
  const state = plugin.createPanelState('panel-a', null);
  plugin._panelStates.set('panel-a', state);
  state.refreshTimer = setTimeout(() => {}, 1000);
  state.queryFilterTimer = setTimeout(() => {}, 1000);
  state.contextPreloadTimer = setTimeout(() => {}, 1000);

  plugin.unmountFooterForHiddenPanel(state);

  assert.equal(plugin._panelStates.has('panel-a'), true);
  assert.equal(state.refreshTimer, null);
  assert.equal(state.queryFilterTimer, null);
  assert.equal(state.contextPreloadTimer, null);
  assert.equal(state.contextPreloadSeq, 1);
});

test('showing a hidden collection remounts from existing state and schedules refresh', () => {
  const plugin = makePlugin();
  installLocalStorage();
  const collection = makeCollection({ guid: 'collection-a', name: 'Shown' });
  const record = makeRecord({ guid: 'record-a', name: 'Shown Page' });
  const { panel } = makePanel({
    id: 'panel-a',
    record,
    collection,
    element: makePanelElement()
  });
  const state = plugin.createPanelState('panel-a', panel);
  state.recordGuid = 'record-a';
  state.lastResults = { propertyGroups: [], linkedGroups: [], unlinkedGroups: [] };
  plugin._panelStates.set('panel-a', state);
  plugin.__setPanels([panel]);
  plugin._visibilityConfig = plugin.normalizeVisibilityConfig({
    defaultVisible: true,
    collections: { 'collection-a': false }
  }, true);

  const mounts = [];
  const refreshes = [];
  plugin.mountFooter = (nextPanel, nextState) => {
    mounts.push({ panelId: nextPanel.getId(), sameState: nextState === state });
  };
  plugin.scheduleRefreshForPanel = (nextPanel, args) => {
    refreshes.push({ panelId: nextPanel.getId(), force: args.force, reason: args.reason });
  };

  plugin._visibilityConfig = plugin.normalizeVisibilityConfig({
    defaultVisible: true,
    collections: {}
  }, true);
  plugin.reconcileAllPanelsVisibility({ refreshVisible: true, reason: 'toggle-collection-visibility', collectionGuid: 'collection-a' });

  assert.deepEqual(mounts, [{ panelId: 'panel-a', sameState: true }]);
  assert.deepEqual(refreshes, [
    { panelId: 'panel-a', force: false, reason: 'toggle-collection-visibility' }
  ]);
});

test('search and custom panels remain suppressed and dispose state', () => {
  const plugin = makePlugin();
  const record = makeRecord({ guid: 'record-a', name: 'Search Page' });
  const { panel } = makePanel({
    id: 'panel-a',
    record,
    collection: makeCollection({ guid: 'collection-a', name: 'Search' }),
    navType: 'custom'
  });
  plugin._panelStates.set('panel-a', plugin.createPanelState('panel-a', panel));

  plugin.handlePanelChanged(panel, 'custom-panel');

  assert.equal(plugin._panelStates.has('panel-a'), false);
});

test('property candidate parsing supports record tuples and nested objects', () => {
  const plugin = makePlugin();
  const prop = makeProperty('Entity', [
    ['record', 'target-guid'],
    { value: ['records', [{ guid: 'other-guid' }, { targetGuid: 'nested-guid' }]] },
    '{"ignored":true}'
  ]);

  const values = plugin.getPropertyCandidateValues(prop);
  assert.equal(values.includes('target-guid'), true);
  assert.equal(values.includes('other-guid'), true);
  assert.equal(values.includes('nested-guid'), true);
  assert.equal(plugin.propertyReferencesGuid(prop, 'target-guid'), true);
  assert.equal(plugin.propertyReferencesGuid(prop, 'missing-guid'), false);
});

test('property references accept raw GUID values and SDK linked records', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target' });
  const other = makeRecord({ guid: 'other-guid', name: 'Other' });
  const prop = {
    name: 'Entity',
    value: 'target-guid',
    linkedRecords() {
      return [other];
    },
    text() {
      return 'target-guid';
    },
    choice() {
      return 'target-guid';
    }
  };

  assert.equal(plugin.propertyReferencesGuid(prop, target.guid), true);
  assert.equal(plugin.propertyReferencesGuid(prop, other.guid), true);
});

test('property references use SDK linked records when raw values are absent', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target' });
  const prop = {
    name: 'Entity',
    linkedRecords() {
      return [target];
    }
  };

  assert.equal(plugin.propertyReferencesGuid(prop, target.guid), true);
});

test('property references use SDK linked records when raw values are display text', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target' });
  const prop = {
    name: 'Entity',
    value: 'Target',
    linkedRecords() {
      return [target];
    },
    text() {
      return 'Target';
    }
  };

  assert.equal(plugin.propertyReferencesGuid(prop, target.guid), true);
});

test('property references fall back to raw values when SDK linked records are empty', () => {
  const plugin = makePlugin();
  const prop = {
    name: 'Entity',
    value: ['record', 'target-guid'],
    linkedRecords() {
      return [];
    },
    text() {
      return '';
    },
    choice() {
      return null;
    }
  };

  assert.equal(plugin.propertyReferencesGuid(prop, 'target-guid'), true);
});

test('property references read raw SDK values arrays', () => {
  const plugin = makePlugin();
  const prop = {
    name: 'Entity',
    linkedRecords() {
      return [];
    },
    values() {
      return [['record', 'target-guid']];
    }
  };

  assert.equal(plugin.propertyReferencesGuid(prop, 'target-guid'), true);
});

test('property references recurse through nested raw SDK value objects', () => {
  const plugin = makePlugin();
  const prop = {
    name: 'Entity',
    values() {
      return [{ record: { guid: 'target-guid' } }];
    }
  };

  assert.equal(plugin.propertyReferencesGuid(prop, 'target-guid'), true);
});

test('property backlink grouping dedupes records and sorts groups by property and record recency', () => {
  const plugin = makePlugin();
  const targetGuid = 'target-guid';
  const alpha = makeRecord({
    guid: 'record-alpha',
    name: 'Alpha',
    updatedAt: makeDate('2026-03-11T14:00:00Z'),
    properties: [
      makeProperty('Project', ['record', targetGuid]),
      makeProperty('Entity', ['record', targetGuid])
    ]
  });
  const beta = makeRecord({
    guid: 'record-beta',
    name: 'Beta',
    updatedAt: makeDate('2026-03-11T16:00:00Z'),
    properties: [makeProperty('Project', ['record', targetGuid])]
  });
  const gamma = makeRecord({
    guid: 'record-gamma',
    name: 'Gamma',
    updatedAt: makeDate('2026-03-11T14:00:00Z'),
    properties: [makeProperty('Project', ['record', targetGuid])]
  });

  const groups = plugin.buildPropertyBacklinkGroupsFromRecords([alpha, beta, gamma, beta], targetGuid, { showSelf: false });
  assert.deepEqual(groups.map((group) => group.propertyName), ['Entity', 'Project']);
  assert.deepEqual(groups[1].records.map((record) => record.guid), ['record-beta', 'record-alpha', 'record-gamma']);
});

test('SDK backreference candidates serve property target pages without graph scanning', async () => {
  const plugin = makePlugin();
  const henrik = makeRecord({ guid: 'henrik-guid', name: 'Henrik Karlsson' });
  const flatland = makeRecord({ guid: 'flatland-guid', name: 'Escaping Flatland' });
  const datePage = makeRecord({ guid: 'date-guid', name: 'April 24, 2026' });
  const lineOnlySource = makeRecord({ guid: 'line-source', name: 'Line Source' });
  const note = makeRecord({
    guid: 'note-source',
    name: 'Note Source',
    updatedAt: makeDate('2026-03-11T14:00:00Z'),
    properties: [
      makeProperty('Entity', ['record', henrik.guid]),
      makeProperty('Date', ['record', datePage.guid])
    ]
  });
  const publication = makeRecord({
    guid: 'publication-source',
    name: 'Publication Source',
    updatedAt: makeDate('2026-03-11T16:00:00Z'),
    properties: [makeProperty('Publication', ['record', flatland.guid])]
  });

  henrik.getBackReferenceRecords = async () => [lineOnlySource, note];
  flatland.getBackReferenceRecords = async () => [publication];
  datePage.getBackReferenceRecords = async () => [note];
  plugin.data.getAllCollections = async () => {
    throw new Error('property references should not scan graph collections');
  };

  const henrikGroups = await plugin.getPropertyBacklinkGroups(henrik, henrik.guid, { showSelf: false });
  const flatlandGroups = await plugin.getPropertyBacklinkGroups(flatland, flatland.guid, { showSelf: false });
  const dateGroups = await plugin.getPropertyBacklinkGroups(datePage, datePage.guid, { showSelf: false });

  assert.deepEqual(henrikGroups.map((group) => group.propertyName), ['Entity']);
  assert.deepEqual(henrikGroups[0].records.map((record) => record.guid), ['note-source']);
  assert.deepEqual(flatlandGroups.map((group) => group.propertyName), ['Publication']);
  assert.deepEqual(flatlandGroups[0].records.map((record) => record.guid), ['publication-source']);
  assert.deepEqual(dateGroups.map((group) => group.propertyName), ['Date']);
});

test('property source records returned by getBackReferenceRecords are inspected with linkedRecords', async () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target' });
  const source = makeRecord({
    guid: 'source-guid',
    name: 'Source',
    updatedAt: makeDate('2026-03-11T14:00:00Z'),
    properties: [{
      name: 'Entity',
      value: 'Target display name',
      linkedRecords() {
        return [target];
      },
      text() {
        return 'Target display name';
      }
    }]
  });
  target.getBackReferenceRecords = async () => [source];

  const groups = await plugin.getPropertyBacklinkGroups(target, target.guid, { showSelf: false });
  assert.deepEqual(groups.map((group) => group.propertyName), ['Entity']);
  assert.deepEqual(groups[0].records.map((record) => record.guid), ['source-guid']);
});

test('property backlink result records candidate stats and SDK failure state', async () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target' });
  const source = makeRecord({
    guid: 'source-guid',
    name: 'Source',
    properties: [makeProperty('Entity', ['record', target.guid])]
  });
  target.getBackReferenceRecords = async () => [source];

  const ok = await plugin.getPropertyBacklinkResult(target, target.guid, { showSelf: false });
  assert.equal(ok.propertyIndexStatus, 'ready');
  assert.equal(ok.propertyIndexStats.reason, 'sdk-backreferences');
  assert.equal(ok.propertyIndexStats.scannedRecords, 1);
  assert.equal(ok.propertyIndexStats.scannedProperties, 1);
  assert.equal(ok.propertyIndexStats.indexedReferences, 1);
  assert.deepEqual(ok.propertyGroups[0].records.map((record) => record.guid), [source.guid]);

  const unavailable = await plugin.getPropertyBacklinkResult(
    makeRecord({ guid: 'missing-sdk', name: 'Missing SDK' }),
    'missing-sdk',
    { showSelf: false }
  );
  assert.equal(unavailable.propertyIndexStatus, 'error');
  assert.equal(
    unavailable.propertyIndexError,
    'Property References require a newer Thymer version. Update Thymer, then refresh references.'
  );

  target.getBackReferenceRecords = async () => {
    throw new Error('SDK exploded');
  };
  const failed = await plugin.getPropertyBacklinkResult(target, target.guid, { showSelf: false });
  assert.equal(failed.propertyIndexStatus, 'error');
  assert.equal(
    failed.propertyIndexError,
    'Property References could not be loaded. Refresh references to try again.'
  );
});

test('record property updates refresh affected panels without graph index maintenance', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target' });
  const source = makeRecord({
    guid: 'source-guid',
    name: 'Source',
    properties: [makeProperty('Entity', ['record', target.guid])]
  });
  plugin.__recordsByGuid.set(source.guid, source);
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = target.guid;
  plugin._panelStates.set('panel-1', state);

  const refreshes = [];
  plugin.scheduleRefreshForPanel = (nextPanel, opts) => {
    refreshes.push({ panelId: nextPanel.getId(), opts });
  };

  plugin.handleRecordUpdated({
    recordGuid: source.guid,
    properties: true,
    source: { isLocal: false }
  });

  assert.deepEqual(refreshes, [{
    panelId: 'panel-1',
    opts: { force: false, reason: 'record.updated' }
  }]);
  const eventSamples = plugin.getPerfSnapshot().samples.filter((sample) => sample.label === 'event-handler');
  assert.equal(eventSamples[0].counts.refreshed, 1);
});

test('linked and unlinked grouping preserves source grouping rules', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note', updatedAt: makeDate('2026-03-10T09:00:00Z') });
  const source = makeRecord({ guid: 'source-guid', name: 'Source Note', updatedAt: makeDate('2026-03-11T09:00:00Z') });

  const linkedOlder = makeLine({
    guid: 'line-1',
    record: source,
    createdAt: makeDate('2026-03-10T08:00:00Z'),
    segments: [{ type: 'ref', text: { guid: target.guid, title: target.getName() } }]
  });
  const linkedNewer = makeLine({
    guid: 'line-2',
    record: source,
    createdAt: makeDate('2026-03-10T09:00:00Z'),
    segments: [{ type: 'ref', text: { guid: target.guid, title: target.getName() } }]
  });
  const mentionOnly = makeLine({
    guid: 'line-3',
    record: source,
    createdAt: makeDate('2026-03-10T10:00:00Z'),
    segments: [{ type: 'text', text: 'Target Note shows up here without a record link.' }]
  });
  const mentionAndLink = makeLine({
    guid: 'line-4',
    record: source,
    createdAt: makeDate('2026-03-10T11:00:00Z'),
    segments: [
      { type: 'text', text: 'Target Note also appears with a real link ' },
      { type: 'ref', text: { guid: target.guid, title: target.getName() } }
    ]
  });

  const linkedGroups = plugin.groupBacklinkLines([linkedNewer, linkedOlder], target.guid, { showSelf: false });
  assert.deepEqual(linkedGroups[0].lines.map((line) => line.guid), ['line-1', 'line-2']);

  const unlinkedGroups = plugin.groupUnlinkedReferenceLines(
    [linkedOlder, mentionOnly, mentionAndLink],
    linkedGroups,
    target.guid,
    target.getName(),
    { showSelf: false }
  );
  assert.deepEqual(unlinkedGroups[0].lines.map((line) => line.guid), ['line-3']);
});

test('linked reference search includes datetime tags for journal pages', async () => {
  const plugin = makePlugin();
  const { journal, source, linkedLine, dateLine } = makeJournalBacklinkFixture();
  const queries = [];

  plugin.data.searchByQuery = async (query) => {
    queries.push(query);
    if (query === '@linkto = "journal-guid"') return { error: '', records: [source], lines: [linkedLine] };
    if (query === '@date = "2026-04-23"') return { error: '', records: [source], lines: [linkedLine, dateLine] };
    return { error: '', records: [], lines: [] };
  };

  const settled = await plugin.runLinkedReferenceSearch(journal.guid, 200, { targetRecord: journal });
  const { linkedError, linkedGroups } = plugin.resolveLinkedReferenceSearch(
    settled,
    journal.guid,
    { showSelf: false }
  );

  assert.equal(linkedError, '');
  assert.deepEqual(queries, ['@linkto = "journal-guid"', '@date = "2026-04-23"']);
  assert.deepEqual(linkedGroups.map((group) => group.record.guid), ['source-guid']);
  assert.deepEqual(linkedGroups[0].lines.map((line) => line.guid), ['linked-line', 'date-line']);
});

test('refresh defers journal datetime search until after first render', async () => {
  const plugin = makePlugin();
  const { journal, source, linkedLine, dateLine } = makeJournalBacklinkFixture({
    journalName: 'Thu Apr 23',
    sourceName: 'Source'
  });
  const { panel } = makePanel({ id: 'panel-1', record: journal });
  const state = attachRefreshPanelState(plugin, panel, journal.guid, { collapseUnlinked: true });

  let resolveDateSearch;
  const dateSearch = new Promise((resolve) => {
    resolveDateSearch = resolve;
  });
  const queries = [];
  const renderSnapshots = [];
  plugin._linkedDateSearchDelayMs = 0;
  plugin.getRefreshConfig = () => ({ maxResults: 200, showSelf: false });
  plugin.data.searchByQuery = async (query) => {
    queries.push(query);
    if (query === '@linkto = "journal-guid"') return { error: '', records: [source], lines: [linkedLine] };
    if (query === '@date = "2026-04-23"') return dateSearch;
    return { error: '', records: [], lines: [] };
  };
  plugin.loadUnlinkedReferenceGroups = async () => ({ unlinkedError: '', unlinkedGroups: [] });
  plugin.renderFromCache = (nextState) => {
    renderSnapshots.push({
      linkedDateDeferred: nextState.lastResults?.linkedDateDeferred === true,
      linkedLineGuids: nextState.lastResults?.linkedGroups?.flatMap((group) => group.lines.map((line) => line.guid)) || []
    });
  };
  plugin.scheduleContextAvailabilityPreload = () => {};

  await plugin.refreshPanel('panel-1', { reason: 'journal-open' });

  assert.deepEqual(queries, ['@linkto = "journal-guid"']);
  assert.deepEqual(renderSnapshots[0], {
    linkedDateDeferred: true,
    linkedLineGuids: ['linked-line']
  });
  const refreshSample = plugin.getPerfSnapshot().samples.find((sample) => sample.label === 'refresh');
  assert.equal(refreshSample.steps.some((step) => step.step === 'search: datetime'), false);

  await new Promise((resolve) => setTimeout(resolve, 0));
  assert.deepEqual(queries, ['@linkto = "journal-guid"', '@date = "2026-04-23"']);

  resolveDateSearch({ error: '', records: [source], lines: [linkedLine, dateLine] });
  await new Promise((resolve) => setTimeout(resolve, 0));

  assert.equal(state.lastResults.linkedDateDeferred, false);
  assert.deepEqual(
    state.lastResults.linkedGroups[0].lines.map((line) => line.guid),
    ['linked-line', 'date-line']
  );
});

test('first refresh defers unlinked search until the section is expanded', async () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note' });
  const source = makeRecord({ guid: 'source-guid', name: 'Source' });
  const linkedLine = makeLine({
    guid: 'linked-line',
    record: source,
    segments: [{ type: 'ref', text: { guid: target.guid, title: target.getName() } }]
  });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = target.guid;
  state.rootEl = makeDomElement('div');
  state.rootEl.isConnected = true;
  state.bodyEl = makeDomElement('div');
  state.countEl = makeDomElement('span');
  plugin._panelStates.set('panel-1', state);

  const queries = [];
  plugin.getRefreshConfig = () => ({ maxResults: 200, showSelf: false });
  plugin.data.searchByQuery = async (query) => {
    queries.push(query);
    if (query === '@linkto = "target-guid"') return { error: '', records: [source], lines: [linkedLine] };
    if (query === '"Target Note"') return { error: '', records: [source], lines: [] };
    return { error: '', records: [], lines: [] };
  };
  plugin.renderFromCache = () => {};
  plugin.scheduleContextAvailabilityPreload = () => {};

  await plugin.refreshPanel('panel-1', { reason: 'initial' });

  assert.deepEqual(queries, ['@linkto = "target-guid"']);
  assert.equal(state.lastResults.unlinkedDeferred, true);
  assert.equal(state.lastResults.linkedGroups.length, 1);
  assert.equal(plugin.isSectionCollapsed(state, 'unlinked', plugin.getCollapseMetrics(state.lastResults)), true);
});

test('refresh overlaps linked and unlinked searches but groups after linked results', async () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note' });
  const source = makeRecord({ guid: 'source-guid', name: 'Source' });
  const linkedLine = makeLine({
    guid: 'linked-line',
    record: source,
    segments: [{ type: 'ref', text: { guid: target.guid, title: target.getName() } }]
  });
  const mentionLine = makeLine({
    guid: 'mention-line',
    record: source,
    segments: [{ type: 'text', text: 'Target Note is mentioned without a link.' }]
  });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = attachRefreshPanelState(plugin, panel, target.guid);

  let resolveLinkedSearch;
  let resolveUnlinkedSearch;
  const linkedSearch = new Promise((resolve) => {
    resolveLinkedSearch = resolve;
  });
  const unlinkedSearch = new Promise((resolve) => {
    resolveUnlinkedSearch = resolve;
  });
  const queries = [];
  plugin.getRefreshConfig = () => ({ maxResults: 200, showSelf: false });
  plugin.data.searchByQuery = async (query) => {
    queries.push(query);
    if (query === '@linkto = "target-guid"') return linkedSearch;
    if (query === '"Target Note"') return unlinkedSearch;
    return { error: '', records: [], lines: [] };
  };
  plugin.renderFromCache = () => {};
  plugin.scheduleContextAvailabilityPreload = () => {};

  const refresh = plugin.refreshPanel('panel-1', { reason: 'open-target' });
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(queries, ['@linkto = "target-guid"', '"Target Note"']);

  resolveUnlinkedSearch({ error: '', records: [source], lines: [linkedLine, mentionLine] });
  await Promise.resolve();
  assert.equal(state.lastResults, null);

  resolveLinkedSearch({ error: '', records: [source], lines: [linkedLine] });
  await refresh;

  assert.deepEqual(state.lastResults.linkedGroups[0].lines.map((line) => line.guid), ['linked-line']);
  assert.deepEqual(state.lastResults.unlinkedGroups[0].lines.map((line) => line.guid), ['mention-line']);
});

test('stale refresh sequence does not apply older panel results', async () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note' });
  const source = makeRecord({ guid: 'source-guid', name: 'Source' });
  const linkedLine = makeLine({
    guid: 'linked-line',
    record: source,
    segments: [{ type: 'ref', text: { guid: target.guid, title: target.getName() } }]
  });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = attachRefreshPanelState(plugin, panel, target.guid, { collapseUnlinked: true });

  let resolveLinkedSearch;
  const linkedSearch = new Promise((resolve) => {
    resolveLinkedSearch = resolve;
  });
  let applied = 0;
  plugin.getRefreshConfig = () => ({ maxResults: 200, showSelf: false });
  plugin.data.searchByQuery = async () => linkedSearch;
  plugin.applyRefreshedResults = () => {
    applied += 1;
  };

  const refresh = plugin.refreshPanel('panel-1', { reason: 'stale-test' });
  await Promise.resolve();
  state.refreshSeq += 1;
  resolveLinkedSearch({ error: '', records: [source], lines: [linkedLine] });
  await refresh;

  assert.equal(applied, 0);
  assert.equal(state.lastResults, null);
});

test('line event matching catches datetime references to journal pages', () => {
  const plugin = makePlugin();
  const journal = makeRecord({
    guid: 'journal-guid',
    name: 'April 23rd 2026',
    journal: true,
    journalDate: new Date(2026, 3, 23)
  });
  const { panel } = makePanel({ id: 'panel-1', record: journal });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = journal.guid;

  assert.equal(plugin.lineEventAffectsState(state, {
    sourceRecordGuid: 'source-guid',
    segments: [{ type: 'datetime', text: { d: '20260423' } }],
    referencedGuids: new Set()
  }), true);
  assert.equal(plugin.lineEventAffectsState(state, {
    sourceRecordGuid: 'source-guid',
    segments: [{ type: 'datetime', text: { d: '20260424' } }],
    referencedGuids: new Set()
  }), false);
});

test('same-record local line edits do not refresh unless self references are visible and matched', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note' });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = target.guid;
  plugin.updatePanelStateRecordCache(state, target);

  plugin.getConfiguration = () => ({ custom: { showSelf: false } });
  assert.equal(plugin.lineEventAffectsState(state, {
    sourceRecordGuid: target.guid,
    segments: [],
    referencedGuids: new Set()
  }), false);
  assert.equal(plugin.lineEventAffectsState(state, {
    sourceRecordGuid: target.guid,
    segments: [{ type: 'text', text: 'Just typing in the current page.' }],
    referencedGuids: new Set()
  }), false);
  assert.equal(plugin.lineEventAffectsState(state, {
    sourceRecordGuid: target.guid,
    segments: [{ type: 'ref', text: { guid: target.guid, title: target.getName() } }],
    referencedGuids: new Set([target.guid])
  }), false);

  plugin.getConfiguration = () => ({ custom: { showSelf: true } });
  assert.equal(plugin.lineEventAffectsState(state, {
    sourceRecordGuid: target.guid,
    segments: [{ type: 'text', text: 'Just typing in the current page.' }],
    referencedGuids: new Set()
  }), false);
  assert.equal(plugin.lineEventAffectsState(state, {
    sourceRecordGuid: target.guid,
    segments: [{ type: 'ref', text: { guid: target.guid, title: target.getName() } }],
    referencedGuids: new Set([target.guid])
  }), true);
  assert.equal(plugin.lineEventAffectsState(state, {
    sourceRecordGuid: target.guid,
    segments: [{ type: 'text', text: 'Target Note appears as self text.' }],
    referencedGuids: new Set()
  }), true);
});

test('current target line edits do not schedule refresh or replace cached results', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note' });
  const source = makeRecord({ guid: 'source-guid', name: 'Source Note' });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  const cachedResults = {
    propertyGroups: [],
    linkedGroups: [{ record: source, lines: [makeLine({ guid: 'line-1', record: source })] }],
    unlinkedGroups: [],
    unlinkedDeferred: true,
    unlinkedLoading: false
  };
  state.recordGuid = target.guid;
  state.lastResults = cachedResults;
  plugin._panelStates.set('panel-1', state);

  const refreshes = [];
  plugin.scheduleRefreshForPanel = (nextPanel, opts) => {
    refreshes.push({ panelId: nextPanel.getId(), opts });
  };

  plugin.handleLineItemCreated({
    recordGuid: target.guid,
    segments: [],
    source: { isLocal: true }
  });
  plugin.handleLineItemUpdated({
    recordGuid: target.guid,
    segments: [{ type: 'text', text: 'irrelevant new text' }],
    source: { isLocal: true }
  });

  assert.deepEqual(refreshes, []);
  assert.equal(state.lastResults, cachedResults);
});

test('external line edits that reference the target still refresh affected panels', () => {
  const plugin = makePlugin();
  const { targetA, refreshes } = attachTwoPanelStates(plugin);

  plugin.handleLineItemUpdated({
    recordGuid: 'source-guid',
    segments: [{ type: 'ref', text: { guid: targetA.guid, title: targetA.getName() } }],
    source: { isLocal: false }
  });

  assert.deepEqual(refreshes, [
    { id: 'panel-a', reason: 'lineitem.updated' }
  ]);
});

test('date normalization handles compact dashed nested and invalid shapes', () => {
  const plugin = makePlugin();

  assert.equal(plugin.normalizeDateToIso('20260423'), '2026-04-23');
  assert.equal(plugin.normalizeDateToIso('2026-04-23T09:30:00Z'), '2026-04-23');
  assert.equal(plugin.normalizeDateToIso({ value: { d: '20260423' } }), '2026-04-23');
  assert.equal(plugin.normalizeDateToIso({ date: '2026-04-23' }), '2026-04-23');
  assert.equal(plugin.normalizeDateToIso({ year: 2026, month: 0, day: 23 }), '2026-01-23');
  assert.equal(plugin.normalizeDateToIso('2026-13-40'), '');
  assert.equal(plugin.normalizeDateToIso({ value: { nope: true } }), '');

  assert.equal(plugin.dateTimeValueMatchesIso({ value: { d: '20260423' } }, '2026-04-23'), true);
  assert.equal(plugin.dateTimeValueMatchesIso({
    start: { d: '20260422' },
    end: { d: '20260424' }
  }, '2026-04-23'), true);
  assert.equal(plugin.dateTimeValueMatchesIso({ d: '20260425' }, '2026-04-23'), false);
});

test('record date references use journal dates and date-like titles', () => {
  const plugin = makePlugin();
  const journal = makeRecord({
    guid: 'journal-guid',
    name: 'Fallback Title',
    journal: true,
    journalDate: { value: { date: '2026-04-23' } }
  });
  const titled = makeRecord({ guid: 'title-guid', name: 'April 23rd 2026' });
  const dashed = makeRecord({ guid: 'dash-guid', name: '2026-04-23' });
  const invalid = makeRecord({ guid: 'bad-guid', name: 'April 40 2026' });

  assert.equal(plugin.getRecordDateReferenceIso(journal), '2026-04-23');
  assert.equal(plugin.getRecordDateReferenceIso(titled), '2026-04-23');
  assert.equal(plugin.getRecordDateReferenceIso(dashed), '2026-04-23');
  assert.equal(plugin.getRecordDateReferenceIso(invalid), '');
});

test('line event matching reuses cached target matchers', () => {
  const plugin = makePlugin();
  let getNameCalls = 0;
  const target = {
    guid: 'target-guid',
    getName() {
      getNameCalls += 1;
      return 'Target Note';
    },
    getJournalDetails() {
      return null;
    }
  };
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = target.guid;
  plugin.updatePanelStateRecordCache(state, target);

  assert.equal(getNameCalls, 1);
  assert.equal(plugin.lineEventAffectsState(state, {
    sourceRecordGuid: 'source-guid',
    segments: [{ type: 'text', text: 'Target Note appears here.' }],
    referencedGuids: new Set()
  }), true);
  assert.equal(plugin.lineEventAffectsState(state, {
    sourceRecordGuid: 'source-guid',
    segments: [{ type: 'text', text: 'Target Note appears again.' }],
    referencedGuids: new Set()
  }), true);
  assert.equal(getNameCalls, 1);
});

test('line event ref extraction does not fetch records per segment', () => {
  const plugin = makePlugin();
  let getRecordCalls = 0;
  plugin.data.getRecord = () => {
    getRecordCalls += 1;
    return null;
  };

  const refs = plugin.extractReferencedRecordGuids([
    { type: 'ref', text: { guid: 'record-a' } },
    { type: 'ref', text: 'record-b' },
    { type: 'text', text: 'plain' }
  ]);

  assert.deepEqual(Array.from(refs).sort(), ['record-a', 'record-b']);
  assert.equal(getRecordCalls, 0);
});

test('sort metrics support reference-count and reference-activity ordering', () => {
  const plugin = makePlugin();
  const alpha = makeRecord({
    guid: 'record-alpha',
    name: 'Alpha',
    updatedAt: makeDate('2026-03-09T09:00:00Z'),
    createdAt: makeDate('2026-03-01T09:00:00Z')
  });
  const beta = makeRecord({
    guid: 'record-beta',
    name: 'Beta',
    updatedAt: makeDate('2026-03-08T09:00:00Z'),
    createdAt: makeDate('2026-03-02T09:00:00Z')
  });

  const propertyGroups = [
    { propertyName: 'Entity', records: [alpha] }
  ];
  const linkedGroups = [
    {
      record: beta,
      lines: [
        makeLine({ guid: 'line-a', record: beta, updatedAt: makeDate('2026-03-11T10:00:00Z') }),
        makeLine({ guid: 'line-b', record: beta, updatedAt: makeDate('2026-03-11T12:00:00Z') })
      ]
    }
  ];

  const sortMetrics = plugin.computeRecordSortMetrics(propertyGroups, linkedGroups);
  assert.equal(sortMetrics.referenceCountByGuid.get(beta.guid), 2);
  assert.equal(sortMetrics.referenceActivityByGuid.get(beta.guid), makeDate('2026-03-11T12:00:00Z').getTime());

  const byCount = plugin.compareRecordsForSort(alpha, beta, { sortBy: 'reference_count', sortDir: 'desc' }, sortMetrics);
  const byActivity = plugin.compareRecordsForSort(alpha, beta, { sortBy: 'reference_activity', sortDir: 'desc' }, sortMetrics);
  assert.equal(byCount > 0, true);
  assert.equal(byActivity > 0, true);
});

test('document-order builder keeps children directly after their parent', () => {
  const plugin = makePlugin();
  const record = makeRecord({ guid: 'record-guid', name: 'Ordered Note' });
  const items = [
    { guid: 'child-b', parent_guid: 'parent-b' },
    { guid: 'parent-a', parent_guid: record.guid },
    { guid: 'child-a', parent_guid: 'parent-a' },
    { guid: 'parent-b', parent_guid: record.guid }
  ];

  const ordered = plugin.buildRecordDocumentOrder(record, items);
  assert.deepEqual(ordered.map((item) => item.guid), ['parent-a', 'child-a', 'parent-b', 'child-b']);
});

test('segment helpers keep plain text, mentions, refs, and datetimes readable', () => {
  const plugin = makePlugin();
  const linkedRecord = makeRecord({ guid: 'linked-guid', name: 'Linked Record' });
  plugin.__recordsByGuid.set(linkedRecord.guid, linkedRecord);

  const text = plugin.segmentsToPlainText([
    { type: 'text', text: 'Hello ' },
    { type: 'mention', text: 'user-1' },
    { type: 'text', text: ' meet ' },
    { type: 'ref', text: { guid: linkedRecord.guid } },
    { type: 'text', text: ' on ' },
    { type: 'datetime', text: { d: '20260311' } }
  ]);

  assert.equal(text, 'Hello @Harpreet meet Linked Record on 2026-03-11');
});

test('line content text cache reuses segment formatting until a line changes', () => {
  const plugin = makePlugin();
  let calls = 0;
  let updatedAt = makeDate('2026-03-09T09:00:00Z');
  const line = {
    guid: 'line-1',
    segments: [{ type: 'text', text: 'Alpha' }],
    getUpdatedAt() {
      return updatedAt;
    },
    getCreatedAt() {
      return null;
    }
  };

  const original = plugin.segmentsToPlainText.bind(plugin);
  plugin.segmentsToPlainText = (segments) => {
    calls += 1;
    return original(segments);
  };

  assert.equal(plugin.getLineContentText(line), 'Alpha');
  assert.equal(plugin.getLineContentText(line), 'Alpha');
  assert.equal(calls, 1);

  updatedAt = makeDate('2026-03-09T10:00:00Z');
  line.segments = [{ type: 'text', text: 'Beta' }];

  assert.equal(plugin.getLineContentText(line), 'Beta');
  assert.equal(calls, 2);
});

test('datetime formatter preserves time-only and date-time values', () => {
  const plugin = makePlugin();

  assert.equal(plugin.formatDateTimeSegment({ t: '0930' }), '09:30');
  assert.equal(plugin.formatDateTimeSegment({ d: '', t: { t: '1700', tz: 4 } }), '17:00');
  assert.equal(plugin.formatDateTimeSegment({ d: '2026-03-11', hours: 17, minutes: 5 }), '2026-03-11 17:05');
  assert.equal(plugin.formatDateTimeSegment({ d: '20260311', t: '0930' }), '2026-03-11 09:30');
  assert.equal(
    plugin.formatDateTimeSegment({
      start: { d: '20260311', t: '0930' },
      end: { t: '1130' }
    }),
    '2026-03-11 09:30 to 11:30'
  );
});

test('descendant context depth follows parent_guid from tree context', async () => {
  const plugin = makePlugin();
  const record = makeRecord({ guid: 'record-guid', name: 'Suffering' });
  const root = makeLine({ guid: 'root-line', record });
  const easy = makeLine({ guid: 'easy-line', record, parentGuid: root.guid });
  const shame = makeLine({ guid: 'shame-line', record, parentGuid: easy.guid });
  const hard = makeLine({ guid: 'hard-line', record, parentGuid: root.guid });
  const compassion = makeLine({ guid: 'compassion-line', record, parentGuid: hard.guid });

  root.getTreeContext = async () => ({
    descendants: [easy, shame, hard, compassion]
  });

  // Deliberately misleading child arrays: if collectDescendantContext walked getChildren()
  // recursively, "hard-line" would end up nested too deeply.
  easy.getChildren = async () => [shame, hard];
  hard.getChildren = async () => [compassion];

  const ctx = await plugin.collectDescendantContext(root);
  assert.deepEqual(ctx.descendants.map((item) => item.guid), ['easy-line', 'shame-line', 'hard-line', 'compassion-line']);
  assert.equal(ctx.depthByGuid['easy-line'], 1);
  assert.equal(ctx.depthByGuid['shame-line'], 2);
  assert.equal(ctx.depthByGuid['hard-line'], 1);
  assert.equal(ctx.depthByGuid['compassion-line'], 2);
});

test('descendant context filters out lines from parallel branches', async () => {
  const plugin = makePlugin();
  const record = makeRecord({ guid: 'record-guid', name: 'Scoped Note' });
  const matched = makeLine({ guid: 'matched-line', record });
  const child = makeLine({ guid: 'child-line', record, parentGuid: matched.guid });
  const parallel = makeLine({ guid: 'parallel-line', record, parentGuid: 'other-root' });
  const parallelChild = makeLine({ guid: 'parallel-child', record, parentGuid: parallel.guid });

  matched.getTreeContext = async () => ({
    descendants: [child, parallel, parallelChild]
  });

  const ctx = await plugin.collectDescendantContext(matched);
  assert.deepEqual(ctx.descendants.map((item) => item.guid), ['child-line']);
  assert.deepEqual(ctx.depthByGuid, { 'child-line': 1 });
});

test('baseline scoping excludes parallel top-level branches from linked context', async () => {
  const plugin = makePlugin();
  plugin.renderFromCache = () => {};
  plugin.bumpLinkedContextRenderVersion = () => {};

  const record = makeRecord({ guid: 'record-guid', name: 'Backref Scope' });
  const branchA = makeLine({ guid: 'branch-a', record, parentGuid: record.guid });
  const matched = makeLine({ guid: 'matched-line', record, parentGuid: branchA.guid });
  const matchedChild = makeLine({ guid: 'matched-child', record, parentGuid: matched.guid });
  const branchSibling = makeLine({ guid: 'branch-sibling', record, parentGuid: branchA.guid });
  const branchB = makeLine({ guid: 'branch-b', record, parentGuid: record.guid });
  const branchBChild = makeLine({ guid: 'branch-b-child', record, parentGuid: branchB.guid });
  matched.getTreeContext = async () => ({
    ancestors: [branchA],
    descendants: [matchedChild]
  });
  branchA.getTreeContext = async () => ({
    ancestors: [],
    descendants: [matched, matchedChild, branchSibling]
  });
  branchB.getTreeContext = async () => ({
    ancestors: [],
    descendants: [branchBChild]
  });

  const state = { linkedContextByLine: new Map() };
  const ctx = await plugin.ensureLinkedContextLoaded(state, matched);

  assert.deepEqual(ctx.aboveItems.map((item) => item.guid), ['branch-a']);
  assert.deepEqual(ctx.descendants.map((item) => item.guid), ['matched-child']);
  assert.deepEqual(ctx.belowItems.map((item) => item.guid), ['branch-sibling']);
});

test('baseline tree fills in deeper descendants missing from matched tree context', async () => {
  const plugin = makePlugin();
  plugin.renderFromCache = () => {};
  plugin.bumpLinkedContextRenderVersion = () => {};

  const record = makeRecord({ guid: 'record-guid', name: 'Depth Note' });
  const branchRoot = makeLine({ guid: 'branch-root', record, parentGuid: record.guid });
  const matched = makeLine({ guid: 'matched-line', record, parentGuid: branchRoot.guid });
  const feeling = makeLine({ guid: 'feeling-line', record, parentGuid: matched.guid });
  const behaviour = makeLine({ guid: 'behaviour-line', record, parentGuid: feeling.guid });
  const pros = makeLine({ guid: 'pros-line', record, parentGuid: matched.guid });
  const cons = makeLine({ guid: 'cons-line', record, parentGuid: matched.guid });
  const letsGoBackIn = makeLine({ guid: 'lets-go-back-in', record, parentGuid: cons.guid });
  const furtherIn = makeLine({ guid: 'further-in', record, parentGuid: letsGoBackIn.guid });

  matched.getTreeContext = async () => ({
    ancestors: [branchRoot],
    descendants: [feeling, behaviour, pros, cons]
  });
  branchRoot.getTreeContext = async () => ({
    ancestors: [],
    descendants: [matched, feeling, behaviour, pros, cons, letsGoBackIn, furtherIn]
  });

  const state = { linkedContextByLine: new Map() };
  const ctx = await plugin.ensureLinkedContextLoaded(state, matched);

  assert.deepEqual(ctx.descendants.map((item) => item.guid), [
    'feeling-line',
    'behaviour-line',
    'pros-line',
    'cons-line',
    'lets-go-back-in',
    'further-in'
  ]);
  assert.equal(ctx.depthByGuid['cons-line'], 1);
  assert.equal(ctx.depthByGuid['lets-go-back-in'], 2);
  assert.equal(ctx.depthByGuid['further-in'], 3);
  assert.deepEqual(ctx.belowItems.map((item) => item.guid), []);
});

test('below context preserves nested depth for sibling branches', async () => {
  const plugin = makePlugin();
  plugin.renderFromCache = () => {};
  plugin.bumpLinkedContextRenderVersion = () => {};

  const record = makeRecord({ guid: 'record-guid', name: 'Sibling Depth Note' });
  const branchRoot = makeLine({ guid: 'branch-root', record, parentGuid: record.guid });
  const matched = makeLine({ guid: 'matched-line', record, parentGuid: branchRoot.guid });
  const feeling = makeLine({ guid: 'feeling-line', record, parentGuid: matched.guid });
  const cons = makeLine({ guid: 'cons-line', record, parentGuid: branchRoot.guid });
  const letsGoBackIn = makeLine({ guid: 'lets-go-back-in', record, parentGuid: cons.guid });
  const furtherIn = makeLine({ guid: 'further-in', record, parentGuid: letsGoBackIn.guid });

  matched.getTreeContext = async () => ({
    ancestors: [branchRoot],
    descendants: [feeling]
  });
  branchRoot.getTreeContext = async () => ({
    ancestors: [],
    descendants: [matched, feeling, cons, letsGoBackIn, furtherIn]
  });

  const state = { linkedContextByLine: new Map() };
  const ctx = await plugin.ensureLinkedContextLoaded(state, matched);

  assert.deepEqual(ctx.descendants.map((item) => item.guid), ['feeling-line']);
  assert.deepEqual(ctx.belowItems.map((item) => item.guid), ['cons-line', 'lets-go-back-in', 'further-in']);
  assert.equal(ctx.relativeDepthByGuid['cons-line'], 0);
  assert.equal(ctx.relativeDepthByGuid['lets-go-back-in'], 1);
  assert.equal(ctx.relativeDepthByGuid['further-in'], 2);
});

test('segment helpers handle ref segments with string seg.text (plain guid format from API)', () => {
  const plugin = makePlugin();
  const linkedRecord = makeRecord({ guid: 'linked-guid', name: '@John Doe' });
  plugin.__recordsByGuid.set(linkedRecord.guid, linkedRecord);

  // seg.text as plain guid string — the format the Thymer API can return
  const text = plugin.segmentsToPlainText([
    { type: 'text', text: 'attendees:: ' },
    { type: 'ref', text: linkedRecord.guid },
  ]);

  assert.equal(text, 'attendees:: @John Doe');

  // Also verify lineHasRefToRecord is consistent
  const line = {
    guid: 'line-1',
    record: { guid: 'source-guid' },
    segments: [{ type: 'ref', text: linkedRecord.guid }]
  };
  assert.equal(plugin.lineHasRefToRecord(line, linkedRecord.guid), true);
});

test('buildReplacedSegments uses phrase boundaries and replaces all matching mentions', () => {
  const plugin = makePlugin();
  const segments = [
    { type: 'text', text: 'Acme replacement some-acme Acme' }
  ];

  const next = plugin.buildReplacedSegments(segments, 'Acme', 'target-guid');

  assert.notEqual(next, segments);
  assert.equal(next.filter((seg) => seg.type === 'ref').length, 3);
  assert.equal(plugin.segmentsToPlainText(next), 'Acme replacement some-acme Acme');
  assert.equal(next.some((seg) => seg.type === 'text' && seg.text.includes('replacement')), true);
});

test('linkUnlinkedReference updates one unlinked line and refreshes panels', async () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Acme' });
  const source = makeRecord({ guid: 'source-guid', name: 'Source Note' });
  const line = makeLine({
    guid: 'line-unlinked',
    record: source,
    segments: [{ type: 'text', text: 'Acme replacement some-acme' }]
  });

  let savedSegments = null;
  let refreshArgs = null;
  line.setSegments = async (nextSegments) => {
    savedSegments = nextSegments;
    line.segments = nextSegments;
  };
  plugin.refreshAllPanels = (args) => {
    refreshArgs = args;
  };

  const state = {
    panel: {
      getActiveRecord() {
        return target;
      }
    },
    lastResults: {
      unlinkedGroups: [{ record: source, lines: [line] }]
    }
  };

  await plugin.linkUnlinkedReference(state, 'line-unlinked');

  assert.ok(Array.isArray(savedSegments));
  assert.equal(savedSegments.filter((seg) => seg.type === 'ref').length, 2);
  assert.equal(plugin.segmentsToPlainText(savedSegments), 'Acme replacement some-acme');
  assert.deepEqual(refreshArgs, { force: true, reason: 'link-unlinked' });
});

test('unlinked searches quote record titles as literal phrases', async () => {
  const plugin = makePlugin();
  let seenQuery = null;
  plugin.data.searchByQuery = async (query) => {
    seenQuery = query;
    return { lines: [] };
  };

  await plugin.loadUnlinkedReferenceGroups('@task "Acme"', 25, {
    recordGuid: 'target-guid',
    linkedGroups: [],
    showSelf: false
  });

  assert.equal(seenQuery, '"@task \\"Acme\\""');
});

test('mention matching handles punctuation normalization and conservative aliases', () => {
  const plugin = makePlugin();
  const title = 'Thymer / Backreferences (TBR)';

  assert.equal(
    plugin.lineHasTextMentionOfRecord(
      { segments: [{ type: 'text', text: 'Thymer-Backreferences is live.' }] },
      title
    ),
    true
  );

  assert.equal(
    plugin.lineHasTextMentionOfRecord(
      { segments: [{ type: 'text', text: 'TBR is live.' }] },
      title
    ),
    true
  );

  const replaced = plugin.buildReplacedSegments(
    [{ type: 'text', text: 'TBR is live.' }],
    title,
    'target-guid'
  );

  assert.equal(replaced.filter((seg) => seg.type === 'ref').length, 1);
  assert.equal(plugin.segmentsToPlainText(replaced), 'TBR is live.');
});

test('query-mode helpers distinguish plain text from Thymer query drafts', () => {
  const plugin = makePlugin();
  assert.equal(plugin.getSearchMode('plain text'), 'text');
  assert.equal(plugin.getSearchMode('@task'), 'query');
  assert.equal(plugin.isIncompleteQueryDraft('@Sources.'), true);
  assert.equal(plugin.isIncompleteQueryDraft('@modified_at > "2026-03-01"'), false);
});

test('scoped query draft input clears pending filter state', () => {
  const plugin = makePlugin();
  const state = plugin.createPanelState('panel-1', null);
  state.searchQuery = '@Sources.';
  state.queryFilterState = plugin.createQueryFilterState('@Sources.Status = "Active"', { ready: true });
  state.queryFilterTimer = setTimeout(() => {}, 1000);

  plugin.syncScopedQueryWithCurrentInput(state, { immediate: true });

  assert.equal(plugin.getRunnableScopedQuery(state), '');
  assert.equal(state.queryFilterState, null);
  assert.equal(state.queryFilterTimer, null);

  state.searchQuery = '@modified_at > "2026-03-01"';
  assert.equal(plugin.getRunnableScopedQuery(state), '@modified_at > "2026-03-01"');
});

test('scoped query helpers preserve matching property and line groups', () => {
  const plugin = makePlugin();
  const alpha = makeRecord({ guid: 'record-alpha', name: 'Alpha' });
  const beta = makeRecord({ guid: 'record-beta', name: 'Beta' });
  const propertyGroups = [{ propertyName: 'Journey', records: [alpha, beta] }];
  const linkedGroups = [{
    record: beta,
    lines: [
      makeLine({ guid: 'line-1', record: beta, segments: [{ type: 'text', text: 'one' }] }),
      makeLine({ guid: 'line-2', record: beta, segments: [{ type: 'text', text: 'two' }] })
    ]
  }];

  const propertyState = plugin.createQueryFilterState('@Journey.Status = "Active"', {
    ready: true,
    matchedLineRecordGuids: new Set([beta.guid])
  });
  const lineState = plugin.createQueryFilterState('@Journey.Status = "Active"', {
    ready: true,
    matchedLineGuids: new Set(['line-2'])
  });

  const filteredBySet = plugin.filterPropertyGroupsByRecordSet(propertyGroups, new Set([alpha.guid]));
  const filteredProps = plugin.filterPropertyGroupsByScopedQuery(propertyGroups, propertyState);
  const filteredLines = plugin.filterLineGroupsByScopedQuery(linkedGroups, lineState);

  assert.deepEqual(filteredBySet[0].records.map((record) => record.guid), ['record-alpha']);
  assert.deepEqual(filteredProps[0].records.map((record) => record.guid), ['record-beta']);
  assert.deepEqual(filteredLines[0].lines.map((line) => line.guid), ['line-2']);
});

test('refresh config supports a separate scoped query result cap', () => {
  const plugin = makePlugin();
  plugin.getConfiguration = () => ({
    custom: {
      maxResults: 25,
      queryFilterMaxResults: 1500,
      contextPreloadMaxLines: 12,
      showSelf: true
    }
  });

  assert.deepEqual(plugin.getRefreshConfig(), {
    maxResults: 25,
    queryFilterMaxResults: 1500,
    contextPreloadMaxLines: 12,
    showSelf: true
  });
});

test('context availability preload is capped and skips collapsed groups', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note' });
  const sourceA = makeRecord({ guid: 'source-a', name: 'Source A' });
  const sourceB = makeRecord({ guid: 'source-b', name: 'Source B' });
  const sourceC = makeRecord({ guid: 'source-c', name: 'Source C' });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = target.guid;
  plugin._recordGroupCollapsed = new Set(['linked:target-guid:source-a']);

  const makeContextLine = (guid, record) => ({
    ...makeLine({ guid, record, segments: [{ type: 'text', text: guid }] }),
    getTreeContext: async () => ({ descendants: [] })
  });

  const results = {
    linkedGroups: [
      { record: sourceA, lines: [makeContextLine('line-a', sourceA)] },
      { record: sourceB, lines: [makeContextLine('line-b1', sourceB), makeContextLine('line-b2', sourceB)] }
    ],
    unlinkedGroups: [
      { record: sourceC, lines: [makeContextLine('line-c', sourceC)] }
    ],
    unlinkedDeferred: false,
    unlinkedLoading: false
  };

  assert.deepEqual(
    plugin.collectContextPreloadLines(results, { state, limit: 2 }).map((line) => line.guid),
    ['line-b1', 'line-b2']
  );
  assert.deepEqual(
    plugin.collectContextPreloadLines(results, { state, limit: 10, includeUnlinked: false }).map((line) => line.guid),
    ['line-b1', 'line-b2']
  );
  assert.deepEqual(
    plugin.collectContextPreloadLines(results, { state, limit: 0 }).map((line) => line.guid),
    []
  );
});

test('stale scoped query refreshes cannot overwrite newer filter state', async () => {
  const plugin = makePlugin();
  const record = makeRecord({ guid: 'record-alpha', name: 'Alpha' });
  const { panel } = makePanel({ id: 'panel-1', record });
  const state = plugin.createPanelState('panel-1', panel);
  state.searchQuery = '@task';
  state.queryFilterSeq = 1;
  state.lastResults = {
    propertyGroups: [],
    linkedGroups: [{
      record,
      lines: [makeLine({ guid: 'line-1', record, segments: [{ type: 'text', text: 'task' }] })]
    }],
    unlinkedGroups: [],
    unlinkedDeferred: true,
    unlinkedLoading: false
  };
  state.queryFilterState = plugin.createQueryFilterState('@task', { loading: true });
  plugin._panelStates.set('panel-1', state);

  let searchedWithMaxResults = null;
  let renderCount = 0;
  plugin.getConfiguration = () => ({ custom: { queryFilterMaxResults: 1500 } });
  plugin.data.searchByQuery = async (_query, maxResults) => {
    searchedWithMaxResults = maxResults;
    state.queryFilterSeq = 2;
    return { error: '', records: [record], lines: [] };
  };
  plugin.renderFromCache = () => {
    renderCount += 1;
  };

  await plugin.refreshScopedQueryFilter('panel-1', 1);

  assert.equal(searchedWithMaxResults, 1500);
  assert.equal(state.queryFilterState.loading, true);
  assert.equal(renderCount, 0);
});

test('context controls omit unavailable directional buttons', () => {
  const plugin = makePlugin();
  const previousDocument = global.document;
  global.document = {
    createElement: makeDomElement
  };

  try {
    const noContext = plugin.buildLinkedContextControls('line-1', {
      showMoreContext: false,
      loaded: true,
      aboveItems: [],
      belowItems: [],
      siblingAboveCount: 0,
      siblingBelowCount: 0,
      descendants: []
    });
    const unlinkedNoContext = plugin.buildLinkedContextControls('line-1', {
      showMoreContext: false,
      loaded: true,
      aboveItems: [],
      belowItems: [],
      siblingAboveCount: 0,
      siblingBelowCount: 0,
      descendants: []
    }, { showLinkAction: true });
    const unknownContext = plugin.buildLinkedContextControls('line-1', {
      showMoreContext: false,
      loaded: false,
      loading: false,
      aboveItems: [],
      belowItems: [],
      siblingAboveCount: 0,
      siblingBelowCount: 0,
      descendants: []
    });
    const descendantsOnly = plugin.buildLinkedContextControls('line-1', {
      showMoreContext: true,
      loaded: true,
      aboveItems: [],
      belowItems: [],
      siblingAboveCount: 0,
      siblingBelowCount: 0,
      descendants: [makeLine({ guid: 'child-line' })]
    });
    const noContextActions = noContext.children[0].children.map((child) => child.dataset.action);
    const unlinkedNoContextActions = unlinkedNoContext.children[0].children.map((child) => child.dataset.action);
    const unknownContextActions = unknownContext.children[0].children.map((child) => child.dataset.action);
    const descendantsOnlyActions = descendantsOnly.children[0].children.map((child) => child.dataset.action);

    const withBelow = plugin.buildLinkedContextControls('line-1', {
      showMoreContext: true,
      loaded: true,
      aboveItems: [],
      belowItems: [makeLine({ guid: 'below-line' })],
      siblingAboveCount: 0,
      siblingBelowCount: 0,
      descendants: []
    });
    const belowActions = withBelow.children[0].children.map((child) => child.dataset.action);

    assert.deepEqual(noContextActions, []);
    assert.deepEqual(unlinkedNoContextActions, ['link-unlinked']);
    assert.deepEqual(unknownContextActions, []);
    assert.deepEqual(descendantsOnlyActions, ['toggle-context-more']);
    assert.deepEqual(belowActions, ['toggle-context-below', 'toggle-context-more']);
  } finally {
    global.document = previousDocument;
  }
});

test('summary counts ignore unlinked refs and footer defaults ignore unlinked-only matches', () => {
  const plugin = makePlugin();
  const linkedRecord = makeRecord({ guid: 'linked-record', name: 'Linked Record' });
  const unlinkedRecord = makeRecord({ guid: 'unlinked-record', name: 'Unlinked Record' });
  const linkedGroups = [{
    record: linkedRecord,
    lines: [makeLine({ guid: 'linked-line', record: linkedRecord, segments: [{ type: 'text', text: 'linked' }] })]
  }];
  const unlinkedGroups = [{
    record: unlinkedRecord,
    lines: [
      makeLine({ guid: 'unlinked-line-1', record: unlinkedRecord, segments: [{ type: 'text', text: 'one' }] }),
      makeLine({ guid: 'unlinked-line-2', record: unlinkedRecord, segments: [{ type: 'text', text: 'two' }] })
    ]
  }];
  const state = {
    searchQuery: '',
    emptyStateExpanded: false,
    sortBy: 'page_last_edited',
    sortDir: 'desc',
    sectionCollapsed: {},
    lastResults: null
  };

  const primaryView = plugin.buildReferenceViewState(state, {
    propertyGroups: [],
    propertyError: '',
    linkedGroups,
    linkedError: '',
    unlinkedGroups,
    unlinkedError: '',
    unlinkedDeferred: false,
    unlinkedLoading: false,
    maxResults: 200
  });
  const unlinkedOnlyView = plugin.buildReferenceViewState(state, {
    propertyGroups: [],
    propertyError: '',
    linkedGroups: [],
    linkedError: '',
    unlinkedGroups,
    unlinkedError: '',
    unlinkedDeferred: false,
    unlinkedLoading: false,
    maxResults: 200
  });

  assert.equal(primaryView.totalVisibleRefCount, 1);
  assert.equal(primaryView.summaryText.includes('1 ref'), true);
  assert.equal(primaryView.summaryText.includes('3 ref'), false);
  assert.equal(unlinkedOnlyView.totalVisibleRefCount, 0);
  assert.equal(plugin.getDefaultFooterCollapsed(unlinkedOnlyView.collapseMetrics), true);
  assert.equal(plugin.buildUnknownReferenceSectionMeta(), '- refs');
});

test('fully empty pages open direct empty states for loaded sections', () => {
  const plugin = makePlugin();
  const deferredEmpty = {
    ready: true,
    propertyCount: 0,
    linkedCount: 0,
    unlinkedCount: 0,
    propertyError: false,
    linkedError: false,
    unlinkedError: false,
    unlinkedDeferred: true
  };
  const loadedEmpty = {
    ...deferredEmpty,
    unlinkedDeferred: false
  };

  assert.equal(plugin.getDefaultSectionCollapsed('property', deferredEmpty), false);
  assert.equal(plugin.getDefaultSectionCollapsed('linked', deferredEmpty), false);
  assert.equal(plugin.getDefaultSectionCollapsed('unlinked', deferredEmpty), true);
  assert.equal(plugin.getDefaultSectionCollapsed('unlinked', loadedEmpty), false);
  assert.equal(plugin.getDefaultSectionCollapsed('unlinked', null), true);
  assert.equal(plugin.getDefaultSectionCollapsed('linked', null), false);
});

test('property reference loading and error states keep the footer recoverable', () => {
  const plugin = makePlugin();
  const state = {
    searchQuery: '',
    sortBy: 'page_last_edited',
    sortDir: 'desc',
    sectionCollapsed: {},
    lastResults: null
  };
  const indexingStats = {
    ...plugin.createEmptyPropertyIndexStats(),
    scannedRecords: 1240
  };

  const indexingView = plugin.buildReferenceViewState(state, {
    propertyGroups: [],
    propertyError: '',
    propertyIndexStatus: 'indexing',
    propertyIndexStats: indexingStats,
    propertyIndexError: '',
    linkedGroups: [],
    linkedError: '',
    unlinkedGroups: [],
    unlinkedError: '',
    unlinkedDeferred: true,
    unlinkedLoading: false,
    maxResults: 200
  });
  const errorView = plugin.buildReferenceViewState(state, {
    propertyGroups: [],
    propertyError: '',
    propertyIndexStatus: 'error',
    propertyIndexStats: plugin.createEmptyPropertyIndexStats(),
    propertyIndexError: 'Lookup failed',
    linkedGroups: [],
    linkedError: '',
    unlinkedGroups: [],
    unlinkedError: '',
    unlinkedDeferred: true,
    unlinkedLoading: false,
    maxResults: 200
  });

  assert.equal(indexingView.propertyIndexMessage, 'Loading property references...');
  assert.equal(plugin.getDefaultFooterCollapsed(indexingView.collapseMetrics), false);
  assert.equal(indexingView.propertySectionCollapsed, false);
  assert.equal(errorView.propertyIndexError, 'Lookup failed');
  assert.equal(plugin.getDefaultFooterCollapsed(errorView.collapseMetrics), false);
  assert.equal(errorView.propertySectionCollapsed, false);

  const previousDocument = global.document;
  global.document = {
    createElement: makeDomElement
  };

  try {
    const container = makeDomElement('div');
    plugin.appendPropertyIndexError(container, 'Lookup failed');
    assert.equal(container.children[0].textContent, 'Lookup failed');
    assert.equal(container.children[1].dataset.action, 'refresh-search');
    assert.equal(container.children[1].textContent, 'Refresh references');
  } finally {
    global.document = previousDocument;
  }
});

test('deferred unlinked section shows idle copy until loading starts', () => {
  const plugin = makePlugin();
  assert.deepEqual(plugin.getUnlinkedReferenceSectionOutcome({
    unlinkedLoading: false,
    unlinkedError: '',
    unlinkedSectionCollapsed: false,
    unlinkedDeferred: true
  }), { type: 'note', message: 'Expand to load unlinked references.' });
  assert.deepEqual(plugin.getUnlinkedReferenceSectionOutcome({
    unlinkedLoading: true,
    unlinkedError: '',
    unlinkedSectionCollapsed: false,
    unlinkedDeferred: true
  }), { type: 'note', message: 'Loading unlinked references...' });
});

test('reference sections render property linked and unlinked rows with highlights', () => withDomDocument(() => {
  const plugin = makePlugin();
  const state = plugin.createPanelState('panel-1', null);
  const propertyRecord = makeRecord({ guid: 'property-record', name: 'Alpha Property' });
  const linkedRecord = makeRecord({ guid: 'linked-record', name: 'Linked Source' });
  const unlinkedRecord = makeRecord({ guid: 'unlinked-record', name: 'Unlinked Source' });

  state.recordGuid = 'target-record';
  state.searchQuery = 'Alpha';
  state.sectionCollapsed.unlinked = false;
  attachRenderSlots(state);
  state.lastResults = {};

  plugin.renderReferences(state, {
    propertyGroups: [{ propertyName: 'Owner', records: [propertyRecord] }],
    propertyError: '',
    propertyIndexStatus: 'ready',
    propertyIndexStats: plugin.createEmptyPropertyIndexStats(),
    propertyIndexError: '',
    linkedGroups: [{
      record: linkedRecord,
      lines: [makeLine({
        guid: 'linked-line',
        record: linkedRecord,
        segments: [{ type: 'text', text: 'Alpha linked text' }]
      })]
    }],
    linkedError: '',
    unlinkedGroups: [{
      record: unlinkedRecord,
      lines: [makeLine({
        guid: 'unlinked-line',
        record: unlinkedRecord,
        segments: [{ type: 'text', text: 'Alpha loose text' }]
      })]
    }],
    unlinkedError: '',
    unlinkedDeferred: false,
    unlinkedLoading: false,
    maxResults: 200
  });

  const propertyRows = state.propertySlotEl.querySelectorAll('.tlr-prop-record');
  const linkedGroups = state.linkedSlotEl.querySelectorAll('.tlr-group-linked');
  const unlinkedGroups = state.unlinkedSlotEl.querySelectorAll('.tlr-group-unlinked');
  const linkedLines = state.linkedSlotEl.querySelectorAll('.tlr-line');
  const unlinkedLines = state.unlinkedSlotEl.querySelectorAll('.tlr-line');

  assert.equal(getDomText(state.countEl), '2 pages | 2 refs');
  assert.equal(propertyRows.length, 1);
  assert.equal(propertyRows[0].dataset.recordGuid, 'property-record');
  assert.equal(propertyRows[0].querySelectorAll('.tlr-search-mark').length, 1);
  assert.equal(linkedGroups.length, 1);
  assert.equal(unlinkedGroups.length, 1);
  assert.equal(linkedLines[0].dataset.lineGuid, 'linked-line');
  assert.equal(unlinkedLines[0].dataset.lineGuid, 'unlinked-line');
  assert.equal(linkedLines[0].querySelectorAll('.tlr-search-mark').length, 1);
  assert.equal(unlinkedLines[0].querySelectorAll('.tlr-search-mark').length, 1);
}));

test('segment rendering covers links hashtags refs and query highlighting', () => withDomDocument(() => {
  const plugin = makePlugin();
  plugin.data.getRecord = (guid) => makeRecord({ guid, name: 'Alpha Resolved' });

  const container = makeDomElement('span');
  const segments = [
    { type: 'link', text: 'https://example.com/alpha' },
    { type: 'text', text: ' ' },
    { type: 'linkobj', text: { link: 'https://docs.example/alpha', title: 'Alpha Docs' } },
    { type: 'text', text: ' ' },
    { type: 'hashtag', text: 'alpha' },
    { type: 'text', text: ' ' },
    { type: 'ref', text: { guid: 'target-guid' } }
  ];

  assert.equal(
    plugin.segmentsToPlainText(segments),
    'https://example.com/alpha Alpha Docs #alpha Alpha Resolved'
  );

  plugin.appendSegments(container, segments, 'Alpha');

  const links = container.querySelectorAll('.tlr-seg-link');
  const hashtags = container.querySelectorAll('.tlr-seg-hashtag');
  const refs = container.querySelectorAll('.tlr-seg-ref');
  const marks = container.querySelectorAll('.tlr-search-mark');

  assert.equal(links.length, 2);
  assert.equal(links[0].href, 'https://example.com/alpha');
  assert.equal(links[1].href, 'https://docs.example/alpha');
  assert.equal(hashtags.length, 1);
  assert.equal(getDomText(hashtags[0]), '#alpha');
  assert.equal(refs.length, 1);
  assert.equal(refs[0].dataset.action, 'open-ref');
  assert.equal(refs[0].dataset.refGuid, 'target-guid');
  assert.equal(marks.length, 4);
}));

test('page view preferences round-trip footer and section state through storage helpers', () => {
  const plugin = makePlugin();
  const previousLocalStorage = global.localStorage;
  const store = new Map();
  global.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, value);
    }
  };

  try {
    plugin._storageKeyPageViewByRecord = 'test-page-view';
    plugin._pageViewByRecord = {};
    plugin.setFooterCollapsedPreferenceForRecord('record-1', true);
    plugin.setSectionCollapsedPreferenceForRecord('record-1', 'linked', true);
    plugin._pageViewByRecord = plugin.loadPageViewByRecordSetting();

    const pref = plugin.getPageViewPreference('record-1');
    assert.equal(pref.footerCollapsed, true);
    assert.equal(pref.sections.linked, true);
  } finally {
    global.localStorage = previousLocalStorage;
  }
});

test('source group collapse state is scoped to the current target page', () => {
  const plugin = makePlugin();
  plugin._recordGroupCollapsed = new Set();

  plugin.setRecordGroupCollapsed('linked', 'target-a', 'source-page', true);

  assert.equal(plugin.isRecordGroupCollapsed('linked', 'target-a', 'source-page'), true);
  assert.equal(plugin.isRecordGroupCollapsed('linked', 'target-b', 'source-page'), false);
  assert.equal(plugin.isRecordGroupCollapsed('unlinked', 'target-a', 'source-page'), false);

  plugin.setRecordGroupCollapsed('linked', 'target-a', 'source-page', false);
  assert.equal(plugin.isRecordGroupCollapsed('linked', 'target-a', 'source-page'), false);
});

test('stored preferences prune oldest entries by recency', () => {
  const plugin = makePlugin();
  const previousLocalStorage = global.localStorage;
  const store = new Map();
  global.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, value);
    }
  };

  try {
    plugin._storageKeyPageViewByRecord = 'test-page-view-prune';
    plugin._storageKeySortByRecord = 'test-sort-prune';
    plugin._storageKeyRecordGroupCollapsed = 'test-record-groups-prune';
    plugin._maxStoredPageViewRecords = 2;
    plugin._maxStoredSortByRecords = 2;
    plugin._maxStoredRecordGroupStates = 2;

    plugin._pageViewByRecord = {
      alpha: { footerCollapsed: true, sections: plugin.createDefaultSectionCollapsedState(), touchedAt: 1 },
      beta: { footerCollapsed: false, sections: plugin.createDefaultSectionCollapsedState(), touchedAt: 2 },
      gamma: { footerCollapsed: true, sections: plugin.createDefaultSectionCollapsedState(), touchedAt: 3 }
    };
    plugin.savePageViewByRecordSetting();

    plugin._sortByRecord = {
      alpha: { sortBy: 'page_title', sortDir: 'asc', touchedAt: 1 },
      beta: { sortBy: 'reference_count', sortDir: 'desc', touchedAt: 2 },
      gamma: { sortBy: 'reference_activity', sortDir: 'desc', touchedAt: 3 }
    };
    plugin.saveSortByRecordSetting();

    plugin._recordGroupCollapsed = new Set(['linked:target:alpha', 'linked:target:beta', 'linked:target:gamma']);
    plugin.saveRecordGroupCollapsedSetting();

    const pagePrefs = JSON.parse(store.get('test-page-view-prune'));
    const sortPrefs = JSON.parse(store.get('test-sort-prune'));
    const recordGroups = JSON.parse(store.get('test-record-groups-prune'));

    assert.deepEqual(Object.keys(pagePrefs).sort(), ['beta', 'gamma']);
    assert.deepEqual(Object.keys(sortPrefs).sort(), ['beta', 'gamma']);
    assert.deepEqual(recordGroups, ['linked:target:beta', 'linked:target:gamma']);
  } finally {
    global.localStorage = previousLocalStorage;
  }
});

test('sort preferences normalize invalid values and persist only overrides', () => {
  const plugin = makePlugin();
  const previousLocalStorage = global.localStorage;
  const store = new Map();
  global.localStorage = {
    getItem(key) {
      return store.has(key) ? store.get(key) : null;
    },
    setItem(key, value) {
      store.set(key, value);
    }
  };

  try {
    plugin._storageKeySortByRecord = 'test-sort-prefs';
    plugin._sortByRecord = {};

    plugin.setSortPreferenceForRecord('record-1', 'reference_count', 'asc');
    assert.deepEqual(plugin.getSortPreferenceForRecord('record-1'), {
      sortBy: 'reference_count',
      sortDir: 'asc'
    });

    let saved = JSON.parse(store.get('test-sort-prefs'));
    assert.equal(saved['record-1'].sortBy, 'reference_count');
    assert.equal(saved['record-1'].sortDir, 'asc');
    assert.equal(typeof saved['record-1'].touchedAt, 'number');

    plugin.setSortPreferenceForRecord('record-1', 'not-a-sort', 'sideways');
    saved = JSON.parse(store.get('test-sort-prefs'));
    assert.equal(Object.prototype.hasOwnProperty.call(saved, 'record-1'), false);
    assert.deepEqual(plugin.getSortPreferenceForRecord('record-1'), {
      sortBy: 'page_last_edited',
      sortDir: 'desc'
    });
  } finally {
    global.localStorage = previousLocalStorage;
  }
});

test('panel lifecycle reuses state and only forces refresh on record changes', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note' });
  const { panel } = makePanel({ id: 'panel-1', record: target });

  const mounted = [];
  const refreshes = [];
  plugin.findMountContainer = () => ({});
  plugin.mountFooter = (_panel, state) => {
    mounted.push(state.panelId);
  };
  plugin.scheduleRefreshForPanel = (_panel, args) => {
    refreshes.push(args);
  };
  plugin.getPageViewPreference = () => ({
    footerCollapsed: false,
    sections: plugin.createDefaultSectionCollapsedState(),
    touchedAt: 0
  });

  plugin.handlePanelChanged(panel, 'panel.navigated');
  plugin.handlePanelChanged(panel, 'panel.focused');

  assert.deepEqual(mounted, ['panel-1', 'panel-1']);
  assert.equal(refreshes[0].force, true);
  assert.equal(refreshes[1].force, false);
});

test('panel focus with loaded same-record results renders from cache without refresh', () => {
  const { plugin, panel, state } = makeLoadedFocusedPanelFixture();
  let refreshCount = 0;
  let cacheRenderCount = 0;
  plugin.scheduleRefreshForPanel = () => {
    refreshCount += 1;
  };
  plugin.renderFromCache = (nextState) => {
    assert.equal(nextState, state);
    cacheRenderCount += 1;
  };

  plugin.handlePanelChanged(panel, 'panel.focused');

  assert.equal(refreshCount, 0);
  assert.equal(cacheRenderCount, 1);
});

test('panel focus refreshes loaded same-record results when remote sync is pending', () => {
  const { plugin, panel } = makeLoadedFocusedPanelFixture({ pendingRemoteSync: true });
  const refreshes = [];
  plugin.scheduleRefreshForPanel = (_panel, args) => {
    refreshes.push(args);
  };
  plugin.renderFromCache = () => {
    throw new Error('pending remote sync should schedule a refresh');
  };

  plugin.handlePanelChanged(panel, 'panel.focused');

  assert.equal(refreshes.length, 1);
  assert.equal(refreshes[0].force, false);
  assert.equal(refreshes[0].reason, 'panel.focused');
});

test('ctrl-click line navigation opens a new panel then highlights the line', async () => {
  const plugin = makePlugin();
  const current = makePanel({
    id: 'panel-current',
    record: makeRecord({ guid: 'source-guid', name: 'Source' })
  });
  const created = makePanel({
    id: 'panel-created',
    record: makeRecord({ guid: 'target-guid', name: 'Target' })
  });
  const focusedPanels = [];

  plugin.getWorkspaceGuid = () => 'workspace-guid';
  plugin.ui = {
    createPanel: async ({ afterPanel }) => {
      assert.equal(afterPanel, current.panel);
      return created.panel;
    },
    setActivePanel(panel) {
      focusedPanels.push(panel.getId());
    }
  };
  plugin.waitForPanelNavigationFrame = async () => {};

  await plugin.openRecord(current.panel, 'target-guid', 'line-guid', { metaKey: true });

  assert.deepEqual(focusedPanels, ['panel-created']);
  assert.deepEqual(created.navigateCalls, [
    {
      itemGuid: 'line-guid',
      highlight: true
    }
  ]);
  assert.equal(current.navigateCalls.length, 0);
});

test('plain-click line navigation reuses current panel and highlights the line', async () => {
  const plugin = makePlugin();
  const current = makePanel({
    id: 'panel-current',
    record: makeRecord({ guid: 'source-guid', name: 'Source' })
  });
  const events = [];
  let resolveNavigation;

  plugin.getWorkspaceGuid = () => 'workspace-guid';
  plugin.ui.setActivePanel = (panel) => {
    events.push(`focus:${panel.getId()}`);
  };
  current.panel.navigateTo = (payload) => {
    current.navigateCalls.push(payload);
    events.push('navigate:start');
    return new Promise((resolve) => {
      resolveNavigation = () => {
        events.push('navigate:resolve');
        resolve(true);
      };
    });
  };
  plugin.waitForPanelNavigationFrame = async () => {
    events.push('frame');
  };

  const opened = plugin.openRecord(current.panel, 'target-guid', 'line-guid', {});
  await Promise.resolve();
  await Promise.resolve();

  assert.deepEqual(events, ['focus:panel-current', 'frame', 'navigate:start']);
  resolveNavigation();
  await opened;

  assert.deepEqual(events, ['focus:panel-current', 'frame', 'navigate:start', 'navigate:resolve', 'frame']);
  assert.deepEqual(current.navigateCalls, [
    {
      itemGuid: 'line-guid',
      highlight: true
    }
  ]);
});

test('line navigation verifies the highlighted line remains visible after layout settles', async () => {
  const plugin = makePlugin();
  const current = makePanel({
    id: 'panel-current',
    record: makeRecord({ guid: 'source-guid', name: 'Source' })
  });
  const calls = [];

  plugin.ensureLineVisibleAfterNavigation = async (panel, lineGuid) => {
    calls.push({ panelId: panel.getId(), lineGuid });
    return { supported: true, found: true, visible: true, scrolled: false };
  };

  await plugin.navigatePanelToRecord(current.panel, 'target-guid', 'line-guid', 'workspace-guid');

  assert.deepEqual(current.navigateCalls, [
    {
      itemGuid: 'line-guid',
      highlight: true
    }
  ]);
  assert.deepEqual(calls, [{ panelId: 'panel-current', lineGuid: 'line-guid' }]);
});

test('line visibility guard scrolls the exact rendered line back into view', async () => {
  const plugin = makePlugin();
  let lineTop = 1500;
  let scrollOptions = null;
  const scroller = {
    scrollTop: 78,
    scrollHeight: 8500,
    clientHeight: 900,
    getBoundingClientRect() {
      return { top: 0, bottom: 900, left: 0, right: 700, width: 700, height: 900 };
    }
  };
  const lineEl = {
    scrollIntoView(options) {
      scrollOptions = options;
      scroller.scrollTop = 1100;
      lineTop = 420;
    },
    closest(selector) {
      return selector === '.panel-scroller-y' ? scroller : null;
    },
    getBoundingClientRect() {
      return {
        top: lineTop,
        bottom: lineTop + 48,
        left: 10,
        right: 610,
        width: 600,
        height: 48
      };
    }
  };
  const panelEl = {
    matches() {
      return false;
    },
    querySelector(selector) {
      if (selector.includes('[data-guid="line-guid"]')) return lineEl;
      if (selector === '.panel-scroller-y') return scroller;
      return null;
    },
    getBoundingClientRect() {
      return { top: 0, bottom: 900, left: 0, right: 700, width: 700, height: 900 };
    }
  };
  const { panel } = makePanel({
    id: 'panel-current',
    record: makeRecord({ guid: 'target-guid', name: 'Target' }),
    element: panelEl
  });

  plugin._lineNavigationSettleMinMs = 0;
  plugin._lineNavigationSettleStableMs = 0;
  plugin._lineNavigationSettleMaxMs = 1;
  plugin.waitForPanelNavigationFrame = async () => {};
  plugin.waitForPanelNavigationDelay = async () => {};

  const result = await plugin.ensureLineVisibleAfterNavigation(panel, 'line-guid');

  assert.equal(result.supported, true);
  assert.equal(result.found, true);
  assert.equal(result.scrolled, true);
  assert.equal(result.visible, true);
  assert.deepEqual(scrollOptions, { block: 'center', inline: 'nearest' });
  assert.equal(scroller.scrollTop, 1100);
});

test('nested record refs inside a backreference row still open the source line', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target' });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = target.guid;
  plugin._panelStates.set('panel-1', state);

  const calls = [];
  const root = { dataset: { panelId: 'panel-1' } };
  const lineAction = {
    dataset: {
      action: 'open-line',
      recordGuid: 'source-guid',
      lineGuid: 'line-guid'
    }
  };
  const nestedRefAction = {
    dataset: {
      action: 'open-ref',
      refGuid: 'nested-ref-guid'
    }
  };
  const targetEl = {
    closest(selector) {
      if (selector === '[data-action="open-line"]') return lineAction;
      if (selector === '[data-action]') return nestedRefAction;
      return null;
    }
  };

  plugin.openRecord = (nextPanel, recordGuid, lineGuid, event) => {
    calls.push({ panelId: nextPanel.getId(), recordGuid, lineGuid, ctrlKey: event.ctrlKey === true });
  };

  plugin.handleFooterClick({
    currentTarget: root,
    target: targetEl,
    ctrlKey: true,
    preventDefault() {
      calls.push({ prevented: true });
    },
    stopPropagation() {
      calls.push({ stopped: true });
    }
  });

  assert.deepEqual(calls, [
    { prevented: true },
    { stopped: true },
    { panelId: 'panel-1', recordGuid: 'source-guid', lineGuid: 'line-guid', ctrlKey: true }
  ]);
});

test('footer click dispatches collapse and search controls', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target' });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = target.guid;
  state.footerCollapsed = false;
  state.sectionCollapsed.linked = false;
  state.searchOpen = false;
  state.searchQuery = 'needle';
  state.searchInputEl = { value: 'needle' };
  plugin._panelStates.set('panel-1', state);

  const calls = [];
  plugin.applyFooterCollapsedPreferenceForRecord = (recordGuid, collapsed) => {
    calls.push({ type: 'footer', recordGuid, collapsed });
  };
  plugin.applySectionCollapsedPreferenceForRecord = (recordGuid, sectionId, collapsed) => {
    calls.push({ type: 'section', recordGuid, sectionId, collapsed });
  };
  plugin.setSearchOpen = (nextState, open) => {
    calls.push({ type: 'search-open', panelId: nextState.panelId, open });
  };
  plugin.scheduleRefreshForPanel = (nextPanel, opts) => {
    calls.push({ type: 'refresh', panelId: nextPanel.getId(), opts });
  };
  plugin.handleSearchQueryChanged = (nextState, opts) => {
    calls.push({ type: 'clear-search', panelId: nextState.panelId, opts });
  };

  clickFooterAction(plugin, 'panel-1', makeFooterActionEl('toggle'));
  clickFooterAction(plugin, 'panel-1', makeFooterActionEl('toggle-section', { sectionId: 'linked' }));
  clickFooterAction(plugin, 'panel-1', makeFooterActionEl('toggle-search'));
  clickFooterAction(plugin, 'panel-1', makeFooterActionEl('refresh-search'));
  clickFooterAction(plugin, 'panel-1', makeFooterActionEl('clear-search'));

  assert.deepEqual(calls, [
    { type: 'footer', recordGuid: 'target-guid', collapsed: true },
    { type: 'section', recordGuid: 'target-guid', sectionId: 'linked', collapsed: true },
    { type: 'search-open', panelId: 'panel-1', open: true },
    { type: 'refresh', panelId: 'panel-1', opts: { force: true, reason: 'search-refresh' } },
    { type: 'clear-search', panelId: 'panel-1', opts: { immediate: true, keepFocus: true } }
  ]);
  assert.equal(state.searchQuery, '');
  assert.equal(state.searchInputEl.value, '');
});

test('footer click dispatches sort and context controls', () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target' });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = target.guid;
  state.sortBy = 'page_last_edited';
  state.sortDir = 'desc';
  state.sortMenuOpen = false;
  plugin._panelStates.set('panel-1', state);

  const calls = [];
  plugin.setSortMenuOpen = (nextState, open) => {
    nextState.sortMenuOpen = open === true;
    calls.push({ type: 'sort-menu', panelId: nextState.panelId, open: open === true });
  };
  plugin.applySortPreferenceForRecord = (recordGuid, sortBy, sortDir) => {
    state.sortBy = sortBy;
    state.sortDir = sortDir;
    calls.push({ type: 'sort', recordGuid, sortBy, sortDir });
  };
  plugin.handleLinkedContextAction = (_nextState, action, lineGuid) => {
    calls.push({ type: 'context', action, lineGuid });
    return Promise.resolve();
  };
  plugin.linkUnlinkedReference = (_nextState, lineGuid) => {
    calls.push({ type: 'link-unlinked', lineGuid });
    return Promise.resolve();
  };

  clickFooterAction(plugin, 'panel-1', makeFooterActionEl('toggle-sort-menu'));
  clickFooterAction(plugin, 'panel-1', makeFooterActionEl('set-sort-by', { sortBy: 'reference_count' }));
  clickFooterAction(plugin, 'panel-1', makeFooterActionEl('set-sort-dir', { sortDir: 'asc' }));
  clickFooterAction(plugin, 'panel-1', makeFooterActionEl('toggle-context-more', { lineGuid: 'line-guid' }));
  clickFooterAction(plugin, 'panel-1', makeFooterActionEl('link-unlinked', { lineGuid: 'line-guid' }));

  assert.deepEqual(calls, [
    { type: 'sort-menu', panelId: 'panel-1', open: true },
    { type: 'sort', recordGuid: 'target-guid', sortBy: 'reference_count', sortDir: 'desc' },
    { type: 'sort-menu', panelId: 'panel-1', open: true },
    { type: 'sort', recordGuid: 'target-guid', sortBy: 'reference_count', sortDir: 'asc' },
    { type: 'sort-menu', panelId: 'panel-1', open: true },
    { type: 'context', action: 'toggle-context-more', lineGuid: 'line-guid' },
    { type: 'sort-menu', panelId: 'panel-1', open: false },
    { type: 'link-unlinked', lineGuid: 'line-guid' }
  ]);
});

test('autocomplete and sort menus share a virtual scrollbar shell', () => withDomDocument(() => {
  const plugin = makePlugin();
  const state = plugin.createPanelState('panel-1', null);
  state.searchAutocompleteEl = makeDomElement('div');
  state.searchAutocompleteOpen = true;
  state.searchAutocompleteSelectedIndex = 1;
  state.searchAutocompleteItems = [
    plugin.buildSearchAutocompleteItem({
      label: '@created_at',
      icon: 'ti-at',
      detail: 'Built-in key',
      insertText: 'created_at',
      replaceStart: 0,
      replaceEnd: 0
    }),
    plugin.buildSearchAutocompleteItem({
      label: '@modified_at',
      icon: 'ti-at',
      detail: 'Built-in key',
      insertText: 'modified_at',
      replaceStart: 0,
      replaceEnd: 0
    })
  ];

  plugin.renderSearchAutocomplete(state);

  const autocompleteScroll = state.searchAutocompleteEl.querySelector('.vscroll-node');
  const autocompleteScrollbar = state.searchAutocompleteEl.querySelector('.vscrollbar');
  const autocompleteThumb = state.searchAutocompleteEl.querySelector('.vscrollbar-thumb');
  assert.equal(state.searchAutocompleteEl.querySelectorAll('.autocomplete--option[data-index]').length, 2);
  assert.ok(autocompleteScroll);
  assert.ok(autocompleteScrollbar);
  assert.ok(autocompleteThumb);
  assert.equal((autocompleteScroll.eventListeners.scroll || []).length, 1);
  assert.equal((autocompleteThumb.eventListeners.mousedown || []).length, 1);

  autocompleteScroll.clientHeight = 50;
  autocompleteScroll.scrollHeight = 200;
  autocompleteScroll.scrollTop = 50;
  autocompleteScrollbar.clientHeight = 100;
  autocompleteThumb.clientHeight = 25;
  plugin.syncSearchAutocompleteScrollbar(state);
  assert.equal(autocompleteScrollbar.classList.contains('has-thumb'), true);
  assert.equal(autocompleteThumb.style.height, '25px');
  assert.equal(autocompleteThumb.style.transform, 'translateY(25px)');

  state.sortMenuEl = makeDomElement('div');
  state.sortBy = 'reference_count';
  state.sortDir = 'asc';

  plugin.renderSortMenu(state);

  const sortScroll = state.sortMenuEl.querySelector('.vscroll-node');
  const sortScrollbar = state.sortMenuEl.querySelector('.vscrollbar');
  const sortThumb = state.sortMenuEl.querySelector('.vscrollbar-thumb');
  assert.equal(state.sortMenuEl.querySelectorAll('.tlr-sort-option').length, plugin.getSortOptions().length + 2);
  assert.ok(sortScroll);
  assert.ok(sortScrollbar);
  assert.ok(sortThumb);
  assert.equal((sortScroll.eventListeners.scroll || []).length, 1);
  assert.equal((sortThumb.eventListeners.mousedown || []).length, 1);

  sortScroll.clientHeight = 80;
  sortScroll.scrollHeight = 240;
  sortScroll.scrollTop = 80;
  sortScrollbar.clientHeight = 120;
  sortThumb.clientHeight = 40;
  plugin.syncSortMenuScrollbar(state);
  assert.equal(sortScrollbar.classList.contains('has-thumb'), true);
  assert.equal(sortThumb.style.height, '40px');
  assert.equal(sortThumb.style.transform, 'translateY(40px)');
}));

test('autocomplete and sort menu dismiss handlers still close on outside input', () => withDomDocument((doc) => {
  const plugin = makePlugin();
  const state = plugin.createPanelState('panel-1', null);
  state.rootEl = makeDomElement('div');
  state.searchAutocompleteEl = makeDomElement('div');
  state.searchAutocompleteEl.isConnected = true;
  state.searchInputEl = makeDomElement('input');
  state.searchInputEl.isConnected = true;
  state.searchAutocompleteItems = [
    plugin.buildSearchAutocompleteItem({
      label: '@created_at',
      icon: 'ti-at',
      detail: 'Built-in key',
      insertText: 'created_at',
      replaceStart: 0,
      replaceEnd: 0
    })
  ];

  plugin.setSearchAutocompleteOpen(state, true);
  assert.equal(state.searchAutocompleteOpen, true);
  assert.equal(typeof state.searchAutocompleteDismissHandler, 'function');
  assert.equal((doc.eventListeners.pointerdown || []).length, 1);

  state.searchAutocompleteDismissHandler({ target: makeDomElement('span') });
  assert.equal(state.searchAutocompleteOpen, false);
  assert.equal(state.searchAutocompleteDismissHandler, null);

  state.sortMenuEl = makeDomElement('div');
  state.sortMenuEl.isConnected = true;
  state.sortToggleEl = makeDomElement('button');
  let focused = false;
  state.sortToggleEl.focus = () => {
    focused = true;
  };

  plugin.setSortMenuOpen(state, true);
  assert.equal(state.sortMenuOpen, true);
  assert.equal(typeof state.sortMenuDismissHandler, 'function');
  assert.equal(typeof state.sortMenuKeyHandler, 'function');

  let prevented = false;
  state.sortMenuKeyHandler({
    key: 'Escape',
    preventDefault() {
      prevented = true;
    }
  });

  assert.equal(prevented, true);
  assert.equal(focused, true);
  assert.equal(state.sortMenuOpen, false);
  assert.equal(state.sortMenuDismissHandler, null);
  assert.equal(state.sortMenuKeyHandler, null);
}));

test('deferred unlinked loading hydrates cached state for the current panel only', async () => {
  const plugin = makePlugin();
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note' });
  const source = makeRecord({ guid: 'source-guid', name: 'Source Note' });
  const line = makeLine({
    guid: 'line-unlinked',
    record: source,
    segments: [{ type: 'text', text: 'Target Note appears here.' }]
  });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = target.guid;
  state.refreshSeq = 1;
  state.lastResults = {
    linkedGroups: [],
    unlinkedDeferred: true,
    unlinkedLoading: false,
    unlinkedError: '',
    unlinkedGroups: []
  };
  plugin._panelStates.set('panel-1', state);

  let renderCount = 0;
  let scopedSync = null;
  plugin.getRefreshConfig = () => ({ maxResults: 200, showSelf: false });
  plugin.renderFromCache = () => {
    renderCount += 1;
  };
  plugin.syncScopedQueryWithCurrentInput = (_state, args) => {
    scopedSync = args;
  };
  plugin.loadUnlinkedReferenceGroups = async () => ({
    unlinkedGroups: [{ record: source, lines: [line] }],
    unlinkedError: ''
  });

  await plugin.ensureDeferredUnlinkedLoaded(state);

  assert.equal(state.lastResults.unlinkedDeferred, false);
  assert.equal(state.lastResults.unlinkedLoading, false);
  assert.equal(state.lastResults.unlinkedGroups.length, 1);
  assert.equal(renderCount, 2);
  assert.deepEqual(scopedSync, { immediate: true, reason: 'deferred-unlinked-loaded' });
});

test('expanding deferred unlinked section starts loading and hydrates cached results', async () => {
  const plugin = makePlugin();
  installLocalStorage();
  plugin._storageKeyPageViewByRecord = 'thymer_backreferences_page_view_by_record_v1';
  const target = makeRecord({ guid: 'target-guid', name: 'Target Note' });
  const source = makeRecord({ guid: 'source-guid', name: 'Source Note' });
  const line = makeLine({
    guid: 'line-unlinked',
    record: source,
    segments: [{ type: 'text', text: 'Target Note appears here.' }]
  });
  const { panel } = makePanel({ id: 'panel-1', record: target });
  const state = plugin.createPanelState('panel-1', panel);
  state.recordGuid = target.guid;
  state.refreshSeq = 1;
  state.lastResults = {
    linkedGroups: [],
    unlinkedDeferred: true,
    unlinkedLoading: false,
    unlinkedError: '',
    unlinkedGroups: []
  };
  plugin._panelStates.set('panel-1', state);

  let loadCalls = 0;
  plugin.getRefreshConfig = () => ({ maxResults: 200, showSelf: false });
  plugin.renderFromCache = () => {};
  plugin.syncScopedQueryWithCurrentInput = () => {};
  plugin.scheduleContextAvailabilityPreload = () => {};
  plugin.loadUnlinkedReferenceGroups = async () => {
    loadCalls += 1;
    return {
      unlinkedGroups: [{ record: source, lines: [line] }],
      unlinkedError: ''
    };
  };

  plugin.applySectionCollapsedPreferenceForRecord(target.guid, 'unlinked', false);
  await Promise.resolve();
  await Promise.resolve();

  assert.equal(loadCalls, 1);
  assert.equal(state.sectionCollapsed.unlinked, false);
  assert.equal(state.lastResults.unlinkedDeferred, false);
  assert.equal(state.lastResults.unlinkedLoading, false);
  assert.equal(state.lastResults.unlinkedGroups[0].lines[0].guid, 'line-unlinked');
});

test('property invalidation refreshes affected panels while line events stay targeted', () => {
  const plugin = makePlugin();
  const { targetA, targetB, stateA, stateB, refreshes } = attachTwoPanelStates(plugin, {
    targetAName: 'Thymer / Backreferences (TBR)',
    targetBName: 'Something Else'
  });
  const sourceProperties = [makeProperty('Entity', ['record', targetA.guid])];
  const source = makeRecord({
    guid: 'source-guid',
    name: 'Source',
    properties: sourceProperties
  });
  plugin.__recordsByGuid.set(source.guid, source);
  stateA.liveCurrentSnapshot = { sourceRecordGuids: new Set([source.guid]) };

  sourceProperties.splice(0, sourceProperties.length, makeProperty('Entity', ['record', targetB.guid]));
  plugin.handleRecordUpdated({
    recordGuid: source.guid,
    properties: true,
    source: { isLocal: false },
    getSourceUser() {
      return {
        getDisplayName() {
          return 'Remote User';
        }
      };
    }
  });

  plugin.handleLineItemCreated({
    recordGuid: 'line-source-guid',
    segments: [{ type: 'text', text: 'TBR just shipped.' }],
    source: { isLocal: false },
    getSourceUser() {
      return {
        getDisplayName() {
          return 'Remote User';
        }
      };
    }
  });

  assert.deepEqual(refreshes, [
    { id: 'panel-a', reason: 'record.updated' },
    { id: 'panel-b', reason: 'record.updated' },
    { id: 'panel-a', reason: 'lineitem.created' }
  ]);
  assert.equal(stateA.pendingRemoteSync, true);
  assert.equal(stateB.pendingRemoteSync, true);

  const eventSamples = plugin.getPerfSnapshot().samples.filter((sample) => sample.label === 'event-handler');
  assert.deepEqual(eventSamples.map((sample) => sample.meta.eventName), ['record.updated', 'lineitem.created']);
  assert.equal(eventSamples[0].counts.refreshed, 2);
  assert.equal(eventSamples[1].counts.refreshed, 1);
  assert.equal(eventSamples[1].counts.segmentCount, 1);
});

test('segmentless moved line events invalidate visible panels', () => {
  const plugin = makePlugin();
  const { stateA, stateB, refreshes } = attachTwoPanelStates(plugin);

  plugin.handleLineItemMoved({
    recordGuid: 'destination-record',
    source: { isLocal: false }
  });

  assert.deepEqual(refreshes, [
    { id: 'panel-a', reason: 'lineitem.moved' },
    { id: 'panel-b', reason: 'lineitem.moved' }
  ]);
  assert.equal(stateA.pendingRemoteSync, true);
  assert.equal(stateB.pendingRemoteSync, true);

  const eventSamples = plugin.getPerfSnapshot().samples.filter((sample) => sample.label === 'event-handler');
  assert.equal(eventSamples[0].counts.workspaceInvalidated, true);
  assert.equal(eventSamples[0].counts.segmentCount, 0);
});

test('render instrumentation records cache and reference render samples', () => withDomDocument(() => {
  const plugin = makePlugin();
  const state = attachRenderSlots(plugin.createPanelState('panel-1', null));
  state.recordGuid = 'target-guid';
  state.lastResults = {
    propertyGroups: [],
    propertyError: '',
    propertyIndexStatus: 'ready',
    propertyIndexStats: plugin.createEmptyPropertyIndexStats(),
    propertyIndexError: '',
    linkedGroups: [],
    linkedError: '',
    unlinkedGroups: [],
    unlinkedError: '',
    unlinkedDeferred: false,
    unlinkedLoading: false,
    maxResults: 200
  };

  plugin.renderFromCache(state);

  const labels = plugin.getPerfSnapshot().samples.map((sample) => sample.label);
  assert.equal(labels.includes('renderReferences'), true);
  assert.equal(labels.includes('renderFromCache'), true);
}));

test('reference render plan skips unchanged sections and isolates linked-context rerenders', () => {
  const plugin = makePlugin();
  const state = plugin.createPanelState('panel-1', null);
  const linkedRecord = makeRecord({ guid: 'linked-record', name: 'Linked Record' });
  const linkedGroups = [{
    record: linkedRecord,
    lines: [makeLine({ guid: 'line-1', record: linkedRecord, segments: [{ type: 'text', text: 'linked' }] })]
  }];

  const viewState = plugin.buildReferenceViewState(state, {
    propertyGroups: [],
    propertyError: '',
    linkedGroups,
    linkedError: '',
    unlinkedGroups: [],
    unlinkedError: '',
    unlinkedDeferred: false,
    unlinkedLoading: false,
    maxResults: 200
  });

  const firstPlan = plugin.buildReferenceRenderPlan(state, viewState);
  assert.equal(firstPlan.propertyChanged, true);
  assert.equal(firstPlan.linkedChanged, true);
  assert.equal(firstPlan.unlinkedChanged, true);

  state.renderSectionKeys = firstPlan.nextKeys;
  const secondPlan = plugin.buildReferenceRenderPlan(state, viewState);
  assert.equal(secondPlan.propertyChanged, false);
  assert.equal(secondPlan.linkedChanged, false);
  assert.equal(secondPlan.unlinkedChanged, false);

  state.linkedContextRenderVersion = 1;
  const thirdPlan = plugin.buildReferenceRenderPlan(state, viewState);
  assert.equal(thirdPlan.propertyChanged, false);
  assert.equal(thirdPlan.linkedChanged, true);
  assert.equal(thirdPlan.unlinkedChanged, false);
});

test('collapsed section render keys avoid expensive content signatures', () => {
  const plugin = makePlugin();
  const state = plugin.createPanelState('panel-1', null);
  const linkedRecord = makeRecord({ guid: 'linked-record', name: 'Linked Record' });
  const linkedGroups = [{
    record: linkedRecord,
    lines: [makeLine({ guid: 'line-1', record: linkedRecord, segments: [{ type: 'text', text: 'linked' }] })]
  }];

  state.recordGuid = 'target-record';
  state.sectionCollapsed = {
    ...plugin.createDefaultSectionCollapsedState(),
    linked: true,
    unlinked: true
  };

  let lineSignatureCalls = 0;
  plugin.buildLineGroupsSignature = (groups) => {
    lineSignatureCalls += 1;
    return `lines:${groups.length}`;
  };

  const collapsedView = plugin.buildReferenceViewState(state, {
    propertyGroups: [],
    propertyError: '',
    linkedGroups,
    linkedError: '',
    unlinkedGroups: linkedGroups,
    unlinkedError: '',
    unlinkedDeferred: false,
    unlinkedLoading: false,
    maxResults: 200
  });

  plugin.buildReferenceRenderPlan(state, collapsedView);
  assert.equal(lineSignatureCalls, 0);

  state.sectionCollapsed.linked = false;
  const openView = plugin.buildReferenceViewState(state, {
    propertyGroups: [],
    propertyError: '',
    linkedGroups,
    linkedError: '',
    unlinkedGroups: linkedGroups,
    unlinkedError: '',
    unlinkedDeferred: false,
    unlinkedLoading: false,
    maxResults: 200
  });

  plugin.buildReferenceRenderPlan(state, openView);
  assert.equal(lineSignatureCalls, 1);
});

test('collapsed sections skip render-time sorting', () => {
  const plugin = makePlugin();
  const state = plugin.createPanelState('panel-1', null);
  const linkedRecord = makeRecord({ guid: 'linked-record', name: 'Linked Record' });
  const linkedGroups = [{
    record: linkedRecord,
    lines: [makeLine({ guid: 'line-1', record: linkedRecord, segments: [{ type: 'text', text: 'linked' }] })]
  }];

  state.recordGuid = 'target-record';
  state.sectionCollapsed = {
    property: true,
    linked: true,
    unlinked: true
  };

  let sortCalls = 0;
  plugin.computeRecordSortMetrics = () => {
    sortCalls += 1;
    return { referenceCountByGuid: new Map(), referenceActivityByGuid: new Map() };
  };
  plugin.sortPropertyGroupsForRender = (groups) => {
    sortCalls += 1;
    return groups;
  };
  plugin.sortLinkedGroupsForRender = (groups) => {
    sortCalls += 1;
    return groups;
  };

  plugin.buildReferenceViewState(state, {
    propertyGroups: [{ propertyName: 'Entity', records: [linkedRecord] }],
    propertyError: '',
    linkedGroups,
    linkedError: '',
    unlinkedGroups: linkedGroups,
    unlinkedError: '',
    unlinkedDeferred: false,
    unlinkedLoading: false,
    maxResults: 200
  });
  assert.equal(sortCalls, 0);

  state.sectionCollapsed.linked = false;
  plugin.buildReferenceViewState(state, {
    propertyGroups: [{ propertyName: 'Entity', records: [linkedRecord] }],
    propertyError: '',
    linkedGroups,
    linkedError: '',
    unlinkedGroups: linkedGroups,
    unlinkedError: '',
    unlinkedDeferred: false,
    unlinkedLoading: false,
    maxResults: 200
  });
  assert.equal(sortCalls, 2);
});

(async () => {
  let passed = 0;
  for (const { name, fn } of tests) {
    await fn();
    passed += 1;
    console.log(`ok - ${name}`);
  }

  console.log(`\nrefactor smoke passed (${passed} checks)`);
})().catch((err) => {
  console.error(err);
  process.exit(1);
});
