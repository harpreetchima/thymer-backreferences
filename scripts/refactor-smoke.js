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

function makePanel({ id, record }) {
  let activeRecord = record || null;
  const navigateCalls = [];

  const panel = {
    getId() {
      return id;
    },
    getElement() {
      return {};
    },
    getType() {
      return 'edit_panel';
    },
    getNavigation() {
      return { type: 'edit_panel' };
    },
    getActiveRecord() {
      return activeRecord;
    },
    setActiveRecord(nextRecord) {
      activeRecord = nextRecord;
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

function makeDomElement(tagName) {
  const el = {
    tagName,
    children: [],
    dataset: {},
    attributes: {},
    className: '',
    textContent: '',
    disabled: false,
    appendChild(child) {
      this.children.push(child);
      return child;
    },
    setAttribute(name, value) {
      this.attributes[name] = String(value);
    },
    classList: {
      add(...names) {
        const existing = new Set((el.className || '').split(/\s+/).filter(Boolean));
        for (const name of names) existing.add(name);
        el.className = Array.from(existing).join(' ');
      }
    }
  };
  return el;
}

function makePlugin() {
  const Plugin = loadPluginClass();
  const plugin = new Plugin();

  plugin._panelStates = new Map();
  plugin._eventHandlerIds = [];
  plugin._defaultSortBy = 'page_last_edited';
  plugin._defaultSortDir = 'desc';
  plugin._defaultFilterPreset = 'all';
  plugin._recentActivityWindowMs = 7 * 24 * 60 * 60 * 1000;
  plugin._defaultQueryFilterMaxResults = 1000;
  plugin._maxStoredPageViewRecords = 400;
  plugin._maxStoredSortByRecords = 400;
  plugin._maxStoredPropGroupStates = 160;
  plugin._maxStoredRecordGroupStates = 600;
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
    }
  };

  plugin.ui = {
    createIcon() {
      return { classList: { add() {} } };
    }
  };

  plugin.__recordsByGuid = recordsByGuid;
  return plugin;
}

const tests = [];

function test(name, fn) {
  tests.push({ name, fn });
}

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

test('property references prefer SDK linked records over raw text-like values', () => {
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

  assert.equal(plugin.propertyReferencesGuid(prop, target.guid), false);
  assert.equal(plugin.propertyReferencesGuid(prop, other.guid), true);
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

test('property backlink grouping dedupes records and sorts groups by property name', () => {
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

  const groups = plugin.buildPropertyBacklinkGroupsFromRecords([alpha, beta, beta], targetGuid, { showSelf: false });
  assert.deepEqual(groups.map((group) => group.propertyName), ['Entity', 'Project']);
  assert.deepEqual(groups[1].records.map((record) => record.guid), ['record-beta', 'record-alpha']);
});

test('property backlink loading unions indexed candidates and SDK backreference records', async () => {
  const plugin = makePlugin();
  const targetGuid = 'target-guid';
  const indexed = makeRecord({
    guid: 'indexed-source',
    name: 'Indexed Source',
    updatedAt: makeDate('2026-03-11T14:00:00Z'),
    properties: [makeProperty('Project', ['record', targetGuid])]
  });
  const sdk = makeRecord({
    guid: 'sdk-source',
    name: 'SDK Source',
    updatedAt: makeDate('2026-03-11T16:00:00Z'),
    properties: [makeProperty('Project', ['record', targetGuid])]
  });
  const target = makeRecord({ guid: targetGuid, name: 'Target' });
  target.getBackReferenceRecords = async () => [sdk, indexed];

  const groups = await plugin.getPropertyBacklinkGroups(target, targetGuid, {
    showSelf: false,
    candidateRecords: [indexed]
  });

  assert.deepEqual(groups.map((group) => group.propertyName), ['Project']);
  assert.deepEqual(groups[0].records.map((record) => record.guid), ['sdk-source', 'indexed-source']);
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
  const journal = makeRecord({
    guid: 'journal-guid',
    name: 'April 23rd 2026',
    journal: true,
    journalDate: new Date(2026, 3, 23)
  });
  const source = makeRecord({ guid: 'source-guid', name: 'Source Note', updatedAt: makeDate('2026-04-23T09:00:00Z') });
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
  const queries = [];

  plugin.data.searchByQuery = async (query) => {
    queries.push(query);
    if (query === '@linkto = "journal-guid"') return { error: '', records: [source], lines: [linkedLine] };
    if (query === '@date = "2026-04-23"') return { error: '', records: [source], lines: [linkedLine, dateLine] };
    return { error: '', records: [], lines: [] };
  };

  const settled = await plugin.runLinkedReferenceSearch(journal.guid, 200, { targetRecord: journal });
  const { linkedError, linkedGroups, propertyCandidateRecords } = plugin.resolveLinkedReferenceSearch(
    settled,
    journal.guid,
    { showSelf: false }
  );

  assert.equal(linkedError, '');
  assert.deepEqual(queries, ['@linkto = "journal-guid"', '@date = "2026-04-23"']);
  assert.deepEqual(propertyCandidateRecords.map((record) => record.guid), ['source-guid']);
  assert.deepEqual(linkedGroups.map((group) => group.record.guid), ['source-guid']);
  assert.deepEqual(linkedGroups[0].lines.map((line) => line.guid), ['linked-line', 'date-line']);
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

test('datetime formatter preserves time-only and date-time values', () => {
  const plugin = makePlugin();

  assert.equal(plugin.formatDateTimeSegment({ t: '0930' }), '09:30');
  assert.equal(plugin.formatDateTimeSegment({ d: '', t: { t: '1700', tz: 4 } }), '17:00');
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
    matchedRecordGuids: new Set([beta.guid])
  });
  const lineState = plugin.createQueryFilterState('@Journey.Status = "Active"', {
    ready: true,
    matchedLineGuids: new Set(['line-2'])
  });

  const filteredProps = plugin.filterPropertyGroupsByScopedQuery(propertyGroups, propertyState);
  const filteredLines = plugin.filterLineGroupsByScopedQuery(linkedGroups, lineState);

  assert.deepEqual(filteredProps[0].records.map((record) => record.guid), ['record-beta']);
  assert.deepEqual(filteredLines[0].lines.map((line) => line.guid), ['line-2']);
});

test('refresh config supports a separate scoped query result cap', () => {
  const plugin = makePlugin();
  plugin.getConfiguration = () => ({
    custom: {
      maxResults: 25,
      queryFilterMaxResults: 1500,
      showSelf: true
    }
  });

  assert.deepEqual(plugin.getRefreshConfig(), {
    maxResults: 25,
    queryFilterMaxResults: 1500,
    showSelf: true
  });
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
});

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
  plugin.waitForPanelRecord = async () => true;

  await plugin.openRecord(current.panel, 'target-guid', 'line-guid', { metaKey: true });

  assert.deepEqual(focusedPanels, ['panel-created']);
  assert.deepEqual(created.navigateCalls, [
    {
      type: 'edit_panel',
      rootId: 'target-guid',
      subId: null,
      workspaceGuid: 'workspace-guid'
    },
    {
      itemGuid: 'line-guid',
      highlight: true
    }
  ]);
  assert.equal(current.navigateCalls.length, 0);
});

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

test('targeted invalidation refreshes only panels affected by record and line events', () => {
  const plugin = makePlugin();
  const targetA = makeRecord({ guid: 'target-a', name: 'Thymer / Backreferences (TBR)' });
  const targetB = makeRecord({ guid: 'target-b', name: 'Something Else' });
  const source = makeRecord({
    guid: 'source-guid',
    name: 'Source',
    properties: [makeProperty('Entity', ['record', targetA.guid])]
  });
  plugin.__recordsByGuid.set(source.guid, source);

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
    { id: 'panel-a', reason: 'lineitem.created' }
  ]);
  assert.equal(stateA.pendingRemoteSync, true);
  assert.equal(stateB.pendingRemoteSync, false);
});

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
  assert.equal(thirdPlan.unlinkedChanged, true);
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
