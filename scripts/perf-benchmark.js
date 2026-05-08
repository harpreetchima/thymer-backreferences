#!/usr/bin/env node

const fs = require('node:fs');
const path = require('node:path');
const { performance } = require('node:perf_hooks');

function installNoopLocalStorage() {
  Object.defineProperty(globalThis, 'localStorage', {
    configurable: true,
    value: {
      getItem() {
        return null;
      },
      setItem() {},
      removeItem() {}
    }
  });
}

function loadPluginClass() {
  const source = fs.readFileSync(path.join(__dirname, '..', 'plugin.js'), 'utf8');
  const factory = new Function('AppPlugin', `${source}; return Plugin;`);
  return factory(class AppPlugin {});
}

function parsePositiveInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}

function parseNonNegativeInt(value, fallback) {
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return fallback;
  return Math.floor(n);
}

function parseArgs(argv) {
  const defaults = {
    collections: 4,
    recordsPerCollection: 250,
    propertiesPerRecord: 6,
    targets: 80,
    linksPerProperty: 2,
    lineGroups: 120,
    linesPerGroup: 4,
    contextLimit: 50,
    iterations: 3,
    json: false
  };
  const config = { ...defaults };
  const args = Array.from(argv);

  for (let i = 0; i < args.length; i += 1) {
    const arg = args[i];
    const readValue = () => {
      const inline = arg.includes('=') ? arg.split('=').slice(1).join('=') : null;
      if (inline !== null) return inline;
      i += 1;
      return args[i];
    };

    if (arg === '--json') {
      config.json = true;
    } else if (arg.startsWith('--collections')) {
      config.collections = parsePositiveInt(readValue(), defaults.collections);
    } else if (arg.startsWith('--records')) {
      config.recordsPerCollection = parsePositiveInt(readValue(), defaults.recordsPerCollection);
    } else if (arg.startsWith('--properties')) {
      config.propertiesPerRecord = parsePositiveInt(readValue(), defaults.propertiesPerRecord);
    } else if (arg.startsWith('--targets')) {
      config.targets = parsePositiveInt(readValue(), defaults.targets);
    } else if (arg.startsWith('--links')) {
      config.linksPerProperty = parsePositiveInt(readValue(), defaults.linksPerProperty);
    } else if (arg.startsWith('--line-groups')) {
      config.lineGroups = parseNonNegativeInt(readValue(), defaults.lineGroups);
    } else if (arg.startsWith('--lines-per-group')) {
      config.linesPerGroup = parsePositiveInt(readValue(), defaults.linesPerGroup);
    } else if (arg.startsWith('--context-limit')) {
      config.contextLimit = parseNonNegativeInt(readValue(), defaults.contextLimit);
    } else if (arg.startsWith('--iterations')) {
      config.iterations = parsePositiveInt(readValue(), defaults.iterations);
    } else {
      throw new Error(`Unknown argument: ${arg}`);
    }
  }

  return config;
}

function makeDate(seed, offsetMs = 0) {
  return new Date(Date.UTC(2026, 0, 1, 12, 0, 0) + seed * 60000 + offsetMs);
}

function makeProperty(name, targetRecords) {
  const values = targetRecords.map((record) => ['record', record.guid]);
  return {
    name,
    value: values,
    linkedRecords() {
      return targetRecords;
    },
    text() {
      return '';
    },
    choice() {
      return null;
    },
    values() {
      return values;
    }
  };
}

function makeRecord({ guid, name, properties = [], seed = 0 }) {
  return {
    guid,
    getName() {
      return name;
    },
    getUpdatedAt() {
      return makeDate(seed, 30000);
    },
    getCreatedAt() {
      return makeDate(seed);
    },
    getAllProperties() {
      return properties;
    },
    getJournalDetails() {
      return null;
    }
  };
}

function makeLine({ guid, record, index, target }) {
  return {
    guid,
    record,
    type: 'text',
    segments: [
      { type: 'text', text: `Benchmark reference ${index} to ${target.getName()} ` },
      { type: 'ref', text: { guid: target.guid, title: target.getName() } }
    ],
    getRecord() {
      return record;
    },
    getCreatedAt() {
      return makeDate(index);
    },
    getUpdatedAt() {
      return makeDate(index, 45000);
    },
    async getTreeContext() {
      return { ancestors: [], descendants: [] };
    }
  };
}

function makeCollection({ guid, name, records }) {
  return {
    getGuid() {
      return guid;
    },
    getName() {
      return name;
    },
    async getAllRecords() {
      return records;
    }
  };
}

function makePlugin() {
  const Plugin = loadPluginClass();
  const plugin = new Plugin();
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
  plugin._defaultMaxResults = 200;
  plugin._defaultContextPreloadMaxLines = 30;
  plugin._defaultQueryFilterMaxResults = 1000;
  plugin._recordGroupCollapsed = new Set();
  plugin._queryBuiltInKeys = [
    'created_at', 'modified_at', 'created_by', 'modified_by', 'text', 'type', 'date',
    'due', 'time', 'mention', 'scheduled', 'hashtag', 'link', 'collection', 'guid',
    'pguid', 'rguid', 'backref', 'linkto'
  ];
  plugin.getConfiguration = () => ({
    custom: {
      maxResults: 200,
      queryFilterMaxResults: 1000,
      contextPreloadMaxLines: 50,
      showSelf: true
    }
  });
  plugin.ui = {
    addToaster() {
      return { remove() {} };
    }
  };
  return plugin;
}

function createFixture(config) {
  const targetRecords = Array.from({ length: config.targets }, (_, i) => makeRecord({
    guid: `target-${i}`,
    name: `Target ${i}`,
    seed: i
  }));
  const sourceRecords = [];
  const collections = [];
  const recordsByGuid = new Map(targetRecords.map((record) => [record.guid, record]));
  const candidatesByTargetGuid = new Map();
  let propertyCount = 0;

  const addCandidate = (targetGuid, record) => {
    const guid = (targetGuid || '').trim();
    const sourceGuid = (record?.guid || '').trim();
    if (!guid || !sourceGuid) return;
    let bySource = candidatesByTargetGuid.get(guid) || null;
    if (!bySource) {
      bySource = new Map();
      candidatesByTargetGuid.set(guid, bySource);
    }
    bySource.set(sourceGuid, record);
  };

  for (let c = 0; c < config.collections; c += 1) {
    const records = [];
    for (let r = 0; r < config.recordsPerCollection; r += 1) {
      const globalIndex = c * config.recordsPerCollection + r;
      const properties = [];
      for (let p = 0; p < config.propertiesPerRecord; p += 1) {
        const targets = [];
        for (let link = 0; link < config.linksPerProperty; link += 1) {
          const targetIndex = (globalIndex * 17 + p * 7 + link * 13) % targetRecords.length;
          targets.push(targetRecords[targetIndex]);
        }
        properties.push(makeProperty(`Prop ${p}`, targets));
      }
      propertyCount += properties.length;
      const record = makeRecord({
        guid: `source-${globalIndex}`,
        name: `Source ${globalIndex}`,
        properties,
        seed: globalIndex + targetRecords.length
      });
      sourceRecords.push(record);
      records.push(record);
      recordsByGuid.set(record.guid, record);
      for (const prop of properties) {
        for (const linked of prop.linkedRecords()) {
          addCandidate(linked.guid, record);
        }
      }
    }
    collections.push(makeCollection({
      guid: `collection-${c}`,
      name: `Collection ${c}`,
      records
    }));
  }

  collections.unshift(makeCollection({
    guid: 'targets',
    name: 'Targets',
    records: targetRecords
  }));

  const linkedGroups = [];
  const unlinkedGroups = [];
  let lineCount = 0;
  for (let g = 0; g < config.lineGroups; g += 1) {
    const record = sourceRecords[g % sourceRecords.length] || targetRecords[g % targetRecords.length];
    const target = targetRecords[g % targetRecords.length];
    const linkedLines = [];
    const unlinkedLines = [];
    for (let l = 0; l < config.linesPerGroup; l += 1) {
      const index = g * config.linesPerGroup + l;
      linkedLines.push(makeLine({ guid: `linked-line-${index}`, record, index, target }));
      unlinkedLines.push(makeLine({ guid: `unlinked-line-${index}`, record, index: index + 100000, target }));
      lineCount += 2;
    }
    addCandidate(target.guid, record);
    linkedGroups.push({ record, lines: linkedLines });
    unlinkedGroups.push({ record, lines: unlinkedLines });
  }

  for (const target of targetRecords) {
    target.getBackReferenceRecords = async () => Array.from(candidatesByTargetGuid.get(target.guid)?.values?.() || []);
  }

  return {
    collections,
    targetRecords,
    sourceRecords,
    recordsByGuid,
    linkedGroups,
    unlinkedGroups,
    stats: {
      collectionCount: collections.length,
      targetRecordCount: targetRecords.length,
      sourceRecordCount: sourceRecords.length,
      totalRecordCount: targetRecords.length + sourceRecords.length,
      propertyCount,
      lineGroupCount: linkedGroups.length + unlinkedGroups.length,
      lineCount
    }
  };
}

function installFixture(plugin, fixture) {
  plugin.data = {
    async getAllCollections() {
      throw new Error('property benchmark should not scan all graph collections');
    },
    getRecord(guid) {
      return fixture.recordsByGuid.get(guid) || null;
    },
    async searchByQuery(query, maxResults) {
      const text = String(query || '').toLowerCase();
      const records = [];
      const lines = [];
      const limit = Number(maxResults) > 0 ? Number(maxResults) : 1000;
      for (const record of fixture.sourceRecords) {
        if (records.length >= limit) break;
        if (record.getName().toLowerCase().includes(text) || record.guid.endsWith('0')) records.push(record);
      }
      for (const group of fixture.linkedGroups) {
        for (const line of group.lines) {
          if (lines.length >= limit) break;
          if (line.guid.endsWith('0') || line.guid.endsWith('5')) lines.push(line);
        }
        if (lines.length >= limit) break;
      }
      return { records, lines };
    }
  };
}

function countPropertyGroups(groups) {
  return (groups || []).reduce((total, group) => total + (group?.records?.length || 0), 0);
}

function countLineGroups(groups) {
  return (groups || []).reduce((total, group) => total + (group?.lines?.length || 0), 0);
}

function makeReferenceState(plugin, targetGuid, searchQuery = '') {
  return {
    panelId: 'bench-panel',
    recordGuid: targetGuid,
    searchQuery,
    sortBy: 'page_last_edited',
    sortDir: 'desc',
    sectionCollapsed: { property: false, linked: false, unlinked: false },
    footerCollapsed: false,
    linkedContextByLine: new Map(),
    renderSectionKeys: null,
    lastResults: null
  };
}

async function makeResults(plugin, fixture) {
  const target = fixture.targetRecords[0];
  const propertyResult = await plugin.getPropertyBacklinkResult(target, target.guid, { showSelf: true });
  return {
    target,
    propertyGroups: propertyResult.propertyGroups,
    linkedGroups: fixture.linkedGroups,
    unlinkedGroups: fixture.unlinkedGroups,
    propertyError: '',
    propertyIndexStatus: propertyResult.propertyIndexStatus,
    propertyIndexStats: propertyResult.propertyIndexStats,
    propertyIndexError: propertyResult.propertyIndexError,
    linkedError: '',
    unlinkedError: '',
    unlinkedDeferred: false,
    unlinkedLoading: false,
    maxResults: 200
  };
}

function makeQueryFilterState(fixture) {
  const matchedRecordGuids = new Set();
  const matchedLineGuids = new Set();
  const matchedLineRecordGuids = new Set();

  for (let i = 0; i < fixture.sourceRecords.length; i += 4) {
    const guid = fixture.sourceRecords[i].guid;
    matchedRecordGuids.add(guid);
    matchedLineRecordGuids.add(guid);
  }
  for (const group of fixture.linkedGroups) {
    for (let i = 0; i < group.lines.length; i += 2) {
      matchedLineGuids.add(group.lines[i].guid);
      matchedLineRecordGuids.add(group.record.guid);
    }
  }

  return {
    query: '@bench',
    loading: false,
    ready: true,
    includesUnlinked: true,
    error: '',
    matchedRecordGuids,
    matchedLineGuids,
    matchedLineRecordGuids
  };
}

async function measure(name, iterations, fn) {
  const samples = [];
  let last = null;
  for (let i = 0; i < iterations; i += 1) {
    const startedAt = performance.now();
    last = await fn(i);
    samples.push(performance.now() - startedAt);
  }
  const totalMs = samples.reduce((total, sample) => total + sample, 0);
  const minMs = Math.min(...samples);
  const maxMs = Math.max(...samples);
  return {
    name,
    iterations,
    totalMs: Number(totalMs.toFixed(3)),
    meanMs: Number((totalMs / iterations).toFixed(3)),
    minMs: Number(minMs.toFixed(3)),
    maxMs: Number(maxMs.toFixed(3)),
    last
  };
}

async function runBenchmark(config) {
  const plugin = makePlugin();
  const fixture = createFixture(config);
  installFixture(plugin, fixture);
  const results = [];

  results.push(await measure('propertyBackrefs.singleTargetSdkCandidates', config.iterations, async () => {
    const target = fixture.targetRecords[0];
    const result = await plugin.getPropertyBacklinkResult(target, target.guid, { showSelf: true });
    return {
      status: result.propertyIndexStatus,
      candidateRecords: result.propertyIndexStats.scannedRecords,
      scannedProperties: result.propertyIndexStats.scannedProperties,
      propertyGroups: result.propertyGroups.length,
      references: countPropertyGroups(result.propertyGroups)
    };
  }));

  results.push(await measure('propertyBackrefs.allTargetSdkCandidates', config.iterations, async () => {
    let groups = 0;
    let references = 0;
    let candidateRecords = 0;
    let scannedProperties = 0;
    for (const target of fixture.targetRecords) {
      const result = await plugin.getPropertyBacklinkResult(target, target.guid, { showSelf: true });
      candidateRecords += result.propertyIndexStats.scannedRecords;
      scannedProperties += result.propertyIndexStats.scannedProperties;
      groups += result.propertyGroups.length;
      references += countPropertyGroups(result.propertyGroups);
    }
    return { targets: fixture.targetRecords.length, candidateRecords, scannedProperties, groups, references };
  }));

  const referenceResults = await makeResults(plugin, fixture);
  const queryFilterState = makeQueryFilterState(fixture);
  results.push(await measure('references.scopedQueryFiltering', config.iterations, async () => {
    const propertyGroups = plugin.filterPropertyGroupsByScopedQuery(referenceResults.propertyGroups, queryFilterState);
    const linkedGroups = plugin.filterLineGroupsByScopedQuery(referenceResults.linkedGroups, queryFilterState);
    const unlinkedGroups = plugin.filterLineGroupsByScopedQuery(referenceResults.unlinkedGroups, queryFilterState);
    return {
      propertyReferences: countPropertyGroups(propertyGroups),
      linkedLines: countLineGroups(linkedGroups),
      unlinkedLines: countLineGroups(unlinkedGroups)
    };
  }));

  results.push(await measure('references.renderPlanning', config.iterations, async () => {
    const state = makeReferenceState(plugin, referenceResults.target.guid);
    state.lastResults = referenceResults;
    const viewState = plugin.buildReferenceViewState(state, referenceResults);
    const plan = plugin.buildReferenceRenderPlan(state, viewState);
    return {
      propertyReferences: viewState.totalPropRefCount,
      linkedReferences: viewState.totalLinkedRefCount,
      unlinkedReferences: viewState.totalUnlinkedRefCount,
      changedSections: ['status', 'property', 'linked', 'unlinked']
        .filter((section) => plan[`${section}Changed`] === true).length
    };
  }));

  results.push(await measure('references.contextPreloadPlanning', config.iterations, async () => {
    const state = makeReferenceState(plugin, referenceResults.target.guid);
    const lines = plugin.collectContextPreloadLines(referenceResults, {
      state,
      limit: config.contextLimit,
      includeLinked: true,
      includeUnlinked: true
    });
    return {
      collectedLines: lines.length,
      limit: config.contextLimit
    };
  }));

  const searchPerf = plugin.perfCreate('bench-search', { reason: 'synthetic-benchmark' });
  results.push(await measure('data.searchByQuery.fake', config.iterations, async () => {
    const result = await plugin.timedSearchByQuery('source', 200, searchPerf, 'bench');
    return {
      records: Array.isArray(result.records) ? result.records.length : 0,
      lines: Array.isArray(result.lines) ? result.lines.length : 0
    };
  }));
  plugin.perfLog(searchPerf);

  return {
    version: 1,
    generatedAt: new Date().toISOString(),
    config: {
      collections: config.collections,
      recordsPerCollection: config.recordsPerCollection,
      propertiesPerRecord: config.propertiesPerRecord,
      targets: config.targets,
      linksPerProperty: config.linksPerProperty,
      lineGroups: config.lineGroups,
      linesPerGroup: config.linesPerGroup,
      contextLimit: config.contextLimit,
      iterations: config.iterations
    },
    fixture: fixture.stats,
    benchmarks: results,
    propertyReferences: {
      status: referenceResults.propertyIndexStatus,
      stats: referenceResults.propertyIndexStats,
      groups: referenceResults.propertyGroups.length,
      references: countPropertyGroups(referenceResults.propertyGroups)
    },
    perfSamples: plugin.getPerfSnapshot().samples.map((sample) => ({
      label: sample.label,
      totalMs: sample.totalMs,
      counts: sample.counts,
      steps: sample.steps.map((step) => ({
        step: step.step,
        ms: step.ms
      }))
    }))
  };
}

function formatMs(value) {
  return `${Number(value).toFixed(3)}ms`;
}

function printHumanSummary(result) {
  const fixture = result.fixture;
  console.log('Backreferences synthetic benchmark');
  console.log(`Graph: ${fixture.collectionCount} collections, ${fixture.totalRecordCount} records, ${fixture.propertyCount} properties, ${fixture.lineCount} lines`);
  console.log(`Iterations: ${result.config.iterations}`);
  for (const bench of result.benchmarks) {
    console.log(`- ${bench.name}: mean ${formatMs(bench.meanMs)} (min ${formatMs(bench.minMs)}, max ${formatMs(bench.maxMs)})`);
  }
  const refs = result.propertyReferences;
  console.log(`Property references: ${refs.status}, ${refs.stats.scannedRecords} candidate records, ${refs.references} references`);
}

async function main() {
  try {
    installNoopLocalStorage();
    const config = parseArgs(process.argv.slice(2));
    const result = await runBenchmark(config);
    if (config.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printHumanSummary(result);
      console.log('');
      console.log('Run with --json for machine-readable output.');
    }
  } catch (e) {
    console.error(e?.stack || e?.message || e);
    process.exitCode = 1;
  }
}

main();
