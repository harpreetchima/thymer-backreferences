// ==Plugin==
// @id: dawn-backlinks
// @name: Backlinks
// @description: Backlinks+ lab footer — SDK refs on expand, cache paint on nav, Boot Kernel
// @icon: ti-arrow-back-up
// ==/Plugin==

/**
 * Dawn Backlinks (parity deepen toward Backlinks+)
 *
 * CONTRACT:
 * - Collapsed cold (.tlr-footer chrome). Expand/collapse is per collection
 *   (journals share `__journal__`); persisted in LS `collapsedByScope`.
 * - Group-by mode (collection / time / property) is also per collection scope
 *   (`groupByByScope`) — same keys as collapse — so journal ≠ Cs.
 * - Time group headings: Today / Yesterday / Last week / Last month, then calendar
 *   months (`Jul 2026`, `May 2025`, …). No rolling “Last year” catch-all (that was
 *   dumping Jun–Jul 2026 under Last year in Sep 2026 — user 2026-09-02).
 * - Linked (and unlinked) lists page at 40 rows with a Show more control — applies to
 *   date sort and time/collection/property grouping (user 2026-09-02; MS Cs cutoff).
 * - Footer on every record (prod Backlinks+). Time Machine remains journal-day only.
 * - panel.navigated: mount + paint FROM CACHE for this record only — never fetch.
 * - Expand: BootKernel onDemand → record.getBackReferences() / getBackReferenceRecords().
 * - Idle: do not catalog References with getAllRecords (darienx vault is huge).
 *   Linked refs load onDemand via getBackReferences when expanded.
 * - Search: text substring + cache-only @query subset (@collection/@text, AND/OR/NOT).
 * - Time Machine: last in the footer body (after unlinked), matching prod slot order.
 *   Year → collection (or chrono); time-ascending inside a year. onDemand `@date`
 *   seed + client filter rules (incl. text ops) — never getAllRecords / never on panel.navigated.
 * - Unlinked mentions: onDemand phrase `searchByQuery` on section expand only — never on panel.navigated.
 * - Property `@date` fold-in: onDemand with linked load (journal When-style hits) — never on panel.navigated.
 * - Prefs/cache: localStorage paint-first; sync *intent* is always on (no local-vs-synced chooser).
 *   Prefs flush via pathb-host scheduleFlush (onDemand) — never on panel.navigated.
 *   No getAllCollections on nav / idle. Excluded-collections dialog loads names via
 *   BootKernel.getAllCollections onDemand only.
 * Darienx References: `1YHFKPE56RZ2Q578VEFK54S4PA`. Old Backlinks+ stays Off.
 */

const BL_LS_CFG = 'dawn_backlinks_cfg_v3';
const BL_LS_CACHE = 'dawn_backlinks_cache_v4';
const BL_LS_CATALOG = 'dawn_backlinks_catalog_v2';
const BL_LS_TM = 'thymer_backreferences_timemachine_v1';
const BL_LS_TM_DAWN = 'dawn_backlinks_timemachine_v1';
const BL_LS_EXCL_PROD = 'thymer_backreferences_excluded_sources_v1';
const TM_QUERY_LIMIT = 200;
const REFS_LAB = { name: 'Lab References', guid: '10CJHAHSNXQK64BFMXAHCAHQ5N' };
const REFS = { name: 'References', guid: '1600JMC7RP54WSXBV79N3VYX2C' };
const REFS_PROD = { name: 'References', guid: '1YHFKPE56RZ2Q578VEFK54S4PA' };
const CATALOG_TTL_MS = 15 * 60 * 1000;
const CACHE_TTL_MS = 30 * 60 * 1000;
/** Initial linked/unlinked page rows; "Show more" adds another page (all sorts/group-bys). */
const BL_PAGE_SIZE = 40;

class Plugin extends AppPlugin {
  onLoad() {
    this._unreg = null;
    this._navIds = [];
    this._panelStates = new Map();
    this._navGen = 0;
    this._navTimer = null;
    this._buildingCatalog = false;
    this._cssInjected = false;
    this._defaultCollapsed = true;
    /** @type {Record<string, boolean>} `__journal__` | `c:guid` | `n:name` | `r:guid` */
    this._collapsedByScope = Object.create(null);
    this._groupByByScope = Object.create(null);
    this._searchOpen = false;
    this._searchQuery = '';
    this._sortBy = 'journal_page';
    this._sortDir = 'desc';
    this._groupBy = 'none';
    this._sortMenuOpen = false;
    /** @type {string[]} collection names (case-insensitive match) */
    this._excludedCollections = [];
    this._hideBuiltInBacklinks = true;
    /** @type {Record<string, { refs: any[], builtAt: number, ms: number, error?: string }>} */
    this._cache = Object.create(null);
    this._catalog = { count: 0, builtAt: 0, ms: 0 };
    this._loadingGuids = new Set();
    /** @type {Map<string, { expanded: boolean, lines?: string[], loading?: boolean, error?: string }>} */
    this._expanded = new Map();
    this._loadTimer = null;
    this._searchMode = 'none';
    this._queryStatus = '';
    this._acOpen = false;
    this._acItems = [];
    this._acIndex = -1;
    this._inputDebounce = null;
    this._timeMachineSettings = this._defaultTimeMachineSettings();
    this._tmCache = Object.create(null); // journalKey -> { items, builtAt, query }
    /** @type {Record<string, { collapsed: boolean, loading?: boolean, error?: string, groups?: any[], loaded?: boolean }>} */
    this._unlinkedByGuid = Object.create(null);
    /** Always sync-intent; LS remains paint-first. Path B flush via pathb-host later. */
    this._storageMode = 'synced';

    try {
      this._timeMachineSettings = this._loadTimeMachineSettings();
    } catch (_) {}

    try {
      this._reloadPrefsFromLocal();
    } catch (_) {}
    // First paint may still lack PathB hydrate; prod LS covered inside reload.
    this._loadCache();
    this._loadCatalogMeta();
    this._injectCss();
    this._applyNativeBacklinksVisibility();
    this._initPathBPrefs();

    this._waitForBoot((boot) => {
      this._unreg = boot.register({
        id: 'dawn-backlinks',
        tier: 'shell',
        mountShell: ({ isMobile }) => this._mountShell(isMobile),
        runIdle: () => {},
        idleDelayMs: () => 0,
      });
    });

    try {
      this._cmdToggle = this.ui.addCommandPaletteCommand({
        label: 'Backlinks: Toggle collapsed',
        icon: 'ti-arrow-back-up',
        onSelected: () => {
          const st = this._activeState();
          this._setCollapsed(!this._footerCollapsed(st), st);
        },
      });
    } catch (_) {}
    try {
      this._cmdRebuild = this.ui.addCommandPaletteCommand({
        label: 'Backlinks: Refresh active page',
        icon: 'ti-refresh',
        onSelected: () => {
          const panel = this.ui.getActivePanel?.();
          const rec = panel?.getActiveRecord?.();
          const guid = rec?.guid || rec?.getGuid?.();
          if (guid) delete this._cache[guid];
          const st =
            (panel?.getId?.() && this._panelStates.get(panel.getId())) || {
              record: rec,
              panel,
            };
          this._setCollapsed(false, st);
          if (panel) this._handlePanel(panel, { forceLoad: true });
        },
      });
    } catch (_) {}

    const schedule = (panel) => {
      clearTimeout(this._navTimer);
      const gen = ++this._navGen;
      this._navTimer = setTimeout(() => {
        if (gen !== this._navGen) return;
        this._handlePanel(panel);
      }, 200);
    };
    try {
      this._navIds.push(this.events.on('panel.navigated', (ev) => schedule(ev.panel)));
      this._navIds.push(this.events.on('panel.focused', (ev) => schedule(ev.panel)));
    } catch (_) {}
    try {
      const active = this.ui.getActivePanel?.();
      if (active) schedule(active);
    } catch (_) {}
  }

  _workspaceGuid() {
    try {
      if (typeof this.getWorkspaceGuid === 'function') return this.getWorkspaceGuid();
    } catch (_) {}
    try {
      return this.workspace?.guid || this.workspace?.getGuid?.() || null;
    } catch (_) {}
    return null;
  }

  _panelNavSvg(kind) {
    const n = 14;
    if (kind === 'side') {
      return (
        '<svg xmlns="http://www.w3.org/2000/svg" width="' +
        n +
        '" height="' +
        n +
        '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="5" width="18" height="14" rx="1.5" opacity="0.35"/><path d="M14 5v14"/><path d="M7 12h4"/><path d="m9 10 2 2-2 2"/></svg>'
      );
    }
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      n +
      '" height="' +
      n +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M7 17 17 7"/><path d="M7 7h10v10"/></svg>'
    );
  }

  _buildPanelNavActions(recordGuid, lineGuid, panel) {
    const wrap = document.createElement('div');
    wrap.className = 'dawn-tlr-panel-nav-actions tlr-panel-nav-actions';
    const mk = (action, label, kind) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'dawn-tlr-panel-nav-btn tlr-panel-nav-btn button-none button-small button-minimal-hover';
      btn.title = label;
      btn.setAttribute('aria-label', label);
      const icon = document.createElement('span');
      icon.className = 'dawn-tlr-panel-nav-icon tlr-panel-nav-icon';
      icon.innerHTML = this._panelNavSvg(kind);
      btn.appendChild(icon);
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this._openRecord(recordGuid, lineGuid || null, panel, {
          newPanel: action === 'open-side',
        });
      });
      return btn;
    };
    wrap.appendChild(mk('open-here', 'Open in this panel', 'here'));
    wrap.appendChild(mk('open-side', 'Open in side panel', 'side'));
    return wrap;
  }

  /** Open a record in this panel or a side panel (prod openRecord). */
  async _openRecord(guid, lineGuid, panel, { newPanel } = {}) {
    if (!guid) return;
    const target = panel || this.ui.getActivePanel?.();
    const ws = this._workspaceGuid();
    const nav = (p) => {
      if (!p?.navigateTo) return false;
      p.navigateTo({
        type: 'edit_panel',
        rootId: guid,
        subId: lineGuid || guid,
        workspaceGuid: ws,
      });
      return true;
    };
    if (newPanel) {
      try {
        if (typeof target?.openRecordInNewPanel === 'function') {
          target.openRecordInNewPanel(guid);
          return;
        }
      } catch (_) {}
      try {
        const created = await this.ui.createPanel?.({ afterPanel: target });
        if (created) {
          this.ui.setActivePanel?.(created);
          if (nav(created)) return;
        }
      } catch (_) {}
    }
    try {
      if (nav(target)) {
        this.ui.setActivePanel?.(target);
        return;
      }
    } catch (_) {}
    try {
      if (typeof target?.openRecordInThisPanel === 'function') {
        target.openRecordInThisPanel(guid);
        return;
      }
    } catch (_) {}
    try {
      void this.data.getRecord?.(guid).then((rec) => {
        if (rec) (panel || this.ui.getActivePanel?.())?.navigateToRecord?.(rec);
      });
    } catch (_) {}
  }

  onUnload() {
    clearTimeout(this._navTimer);
    clearTimeout(this._loadTimer);
    try {
      this._unreg?.();
    } catch (_) {}
    for (const id of this._navIds || []) {
      try {
        this.events.off(id);
      } catch (_) {}
    }
    this._navIds = [];
    try {
      for (const id of [...(this._panelStates?.keys?.() || [])]) this._dispose(id);
    } catch (_) {}
    try {
      this._cmdToggle?.remove?.();
    } catch (_) {}
    try {
      this._cmdRebuild?.remove?.();
    } catch (_) {}
    try {
      this._chip?.remove?.();
    } catch (_) {}
    try {
      this._styleEl?.remove?.();
    } catch (_) {}
  }

  _waitForBoot(cb) {
    let n = 0;
    const tick = () => {
      const boot = globalThis.BootKernel || globalThis.__dawnBoot;
      if (boot?.register) {
        cb(boot);
        return;
      }
      if (++n > 240) return;
      setTimeout(tick, 40);
    };
    tick();
  }

  _mountShell() {}

  _prefsMirrorKeys() {
    return [BL_LS_CFG, BL_LS_EXCL_PROD, BL_LS_TM_DAWN, BL_LS_TM];
  }

  _initPathBPrefs() {
    let n = 0;
    const tick = () => {
      const api = globalThis.ThymerPluginSettings;
      if (api?.init && (api.__dawnPathBHost || !api.__pathBStub)) {
        try {
          const opts = {
            plugin: this,
            pluginId: 'dawn-backlinks',
            label: 'Backlinks',
            data: this.data,
            mirrorKeys: () => this._prefsMirrorKeys(),
            onHydrated: () => {
              try {
                this._reloadPrefsFromLocal();
                this._refreshAll?.({});
              } catch (_) {}
            },
          };
          api.init(opts);
          // Mobile often hydrates late (Plugin Backend list cold). Re-pull a few times.
          const delays = [1200, 4000, 10000];
          for (const ms of delays) {
            setTimeout(() => {
              try {
                if (!api?.init || !api.__dawnPathBHost) {
                  this._reloadPrefsFromLocal();
                  this._refreshAll?.({});
                  return;
                }
                const before = (this._excludedCollections || []).join('\0');
                Promise.resolve(api.init({ ...opts, awaitHydrate: true }))
                  .catch(() => {})
                  .finally(() => {
                    try {
                      this._reloadPrefsFromLocal();
                      const after = (this._excludedCollections || []).join('\0');
                      if (after !== before) this._refreshAll?.({});
                    } catch (_) {}
                  });
              } catch (_) {}
            }, ms);
          }
        } catch (e) {
          console.warn('[Dawn/Backlinks] PathB init', e);
        }
        return;
      }
      n += 1;
      if (n > 240) return;
      setTimeout(tick, 40);
    };
    tick();
  }

  _unionExcluded(lists) {
    const out = [];
    const seen = new Set();
    for (const list of lists || []) {
      if (!Array.isArray(list)) continue;
      for (const raw of list) {
        const n = String(raw || '').trim();
        if (!n) continue;
        const key = n.toLowerCase();
        if (seen.has(key)) continue;
        seen.add(key);
        out.push(n);
      }
    }
    return out.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  _excludedFromDawnCfg(p) {
    if (!p || !Array.isArray(p.excludedCollections)) return [];
    return p.excludedCollections.map((x) => String(x || '').trim()).filter(Boolean);
  }

  _excludedFromProdLs() {
    try {
      const prodEx = JSON.parse(localStorage.getItem(BL_LS_EXCL_PROD) || 'null');
      const list = prodEx?.collections || prodEx?.excludedCollections;
      if (!Array.isArray(list)) return [];
      return list.map((n) => String(n || '').trim()).filter(Boolean);
    } catch (_) {
      return [];
    }
  }

  _reloadPrefsFromLocal() {
    try {
      const raw =
        localStorage.getItem(BL_LS_CFG) || localStorage.getItem('dawn_backlinks_cfg_v2');
      let dawnEx = [];
      let dawnSetHide = false;
      if (raw) {
        const p = JSON.parse(raw);
        this._applyCollapsedCfg(p);
        this._searchOpen = p.searchOpen === true;
        this._searchQuery = typeof p.searchQuery === 'string' ? p.searchQuery : '';
        if (
          p.sortBy === 'page_title' ||
          p.sortBy === 'reference_count' ||
          p.sortBy === 'journal_page' ||
          p.sortBy === 'page_last_edited'
        ) {
          this._sortBy = p.sortBy;
        }
        if (p.sortDir === 'asc' || p.sortDir === 'desc') this._sortDir = p.sortDir;
        if (
          p.groupBy === 'none' ||
          p.groupBy === 'collection' ||
          p.groupBy === 'time' ||
          p.groupBy === 'property'
        ) {
          this._groupBy = p.groupBy;
        }
        this._applyGroupByCfg(p);
        dawnEx = this._excludedFromDawnCfg(p);
        if (typeof p.hideBuiltInBacklinks === 'boolean') {
          this._hideBuiltInBacklinks = p.hideBuiltInBacklinks;
          dawnSetHide = true;
        }
      }
      this._excludedCollections = this._unionExcluded([dawnEx, this._excludedFromProdLs()]);
      if (!dawnSetHide) {
        try {
          const prodEx = JSON.parse(localStorage.getItem(BL_LS_EXCL_PROD) || 'null');
          if (prodEx && typeof prodEx.hideBuiltInBacklinks === 'boolean') {
            this._hideBuiltInBacklinks = prodEx.hideBuiltInBacklinks !== false;
          }
        } catch (_) {}
      }
    } catch (_) {}
    try {
      this._timeMachineSettings = this._loadTimeMachineSettings();
    } catch (_) {}
    this._applyNativeBacklinksVisibility();
  }

  _schedulePrefsFlush() {
    try {
      const api = globalThis.ThymerPluginSettings;
      if (!api?.scheduleFlush) return;
      if (!this._pluginSettingsPluginId) {
        this._pluginSettingsPluginId = 'dawn-backlinks';
        this._pluginSettingsSyncMode = 'synced';
      }
      api.scheduleFlush(this, () => this._prefsMirrorKeys());
    } catch (_) {}
  }

  _saveCfg() {
    try {
      localStorage.setItem(
        BL_LS_CFG,
        JSON.stringify({
          collapsed: this._defaultCollapsed !== false,
          collapsedByScope: this._collapsedByScope || {},
          groupByByScope: this._groupByByScope || {},
          searchOpen: this._searchOpen,
          searchQuery: this._searchQuery,
          sortBy: this._sortBy,
          sortDir: this._sortDir,
          groupBy: this._groupBy,
          excludedCollections: this._excludedCollections,
          hideBuiltInBacklinks: this._hideBuiltInBacklinks !== false,
        })
      );
    } catch (_) {}
    this._persistProdExcludedSources();
    this._schedulePrefsFlush();
  }

  _persistProdExcludedSources() {
    try {
      const prev = JSON.parse(localStorage.getItem(BL_LS_EXCL_PROD) || 'null') || {};
      const next = {
        ...prev,
        version: prev.version || 1,
        collections: Array.isArray(this._excludedCollections)
          ? [...this._excludedCollections]
          : prev.collections || [],
        hideBuiltInBacklinks: this._hideBuiltInBacklinks !== false,
        updatedAt: Date.now(),
      };
      localStorage.setItem(BL_LS_EXCL_PROD, JSON.stringify(next));
    } catch (_) {}
  }

  _applyNativeBacklinksVisibility() {
    try {
      document.documentElement.classList.toggle(
        'tlr-hide-native-backrefs',
        this._hideBuiltInBacklinks !== false
      );
    } catch (_) {}
  }

  _applyCollapsedCfg(p) {
    if (!p || typeof p !== 'object') return;
    this._defaultCollapsed = p.collapsed !== false;
    const next = Object.create(null);
    const map = p.collapsedByScope;
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [k, v] of Object.entries(map)) {
        if (!k) continue;
        next[k] = v === true;
      }
    }
    this._collapsedByScope = next;
  }

  _normalizeGroupBy(v) {
    return v === 'none' || v === 'collection' || v === 'time' || v === 'property' ? v : null;
  }

  _applyGroupByCfg(p) {
    if (!p || typeof p !== 'object') return;
    const next = Object.create(null);
    const map = p.groupByByScope;
    if (map && typeof map === 'object' && !Array.isArray(map)) {
      for (const [k, v] of Object.entries(map)) {
        if (!k) continue;
        const g = this._normalizeGroupBy(typeof v === 'string' ? v : v?.groupBy);
        if (g) next[k] = g;
      }
    }
    this._groupByByScope = next;
    // One-time: seed journal scope from legacy global groupBy if scopes empty.
    if (
      !Object.keys(next).length &&
      this._normalizeGroupBy(p.groupBy) &&
      p.groupBy !== 'none'
    ) {
      this._groupByByScope['__journal__'] = p.groupBy;
    }
  }

  _groupByForState(state) {
    const scope =
      state?.collapseScope || this._collapseScopeKey(state?.record, state?.panel);
    if (scope && Object.prototype.hasOwnProperty.call(this._groupByByScope || {}, scope)) {
      return this._normalizeGroupBy(this._groupByByScope[scope]) || 'none';
    }
    return this._normalizeGroupBy(this._groupBy) || 'none';
  }

  _setGroupBy(modeId, state) {
    const st = state || this._activeState();
    let scope =
      st?.collapseScope || this._collapseScopeKey(st?.record, st?.panel);
    if (!scope) {
      try {
        const panel = this.ui.getActivePanel?.();
        scope = this._collapseScopeKey(panel?.getActiveRecord?.(), panel);
      } catch (_) {}
    }
    const current = this._groupByForState(st || { collapseScope: scope });
    const want = this._normalizeGroupBy(modeId) || 'none';
    const next = current === want ? 'none' : want;
    if (scope) this._groupByByScope[scope] = next;
    else this._groupBy = next;
    this._saveCfg();
    if (scope) {
      for (const s of this._panelStates.values()) {
        const key = s.collapseScope || this._collapseScopeKey(s.record, s.panel);
        if (key === scope) this._paint(s);
      }
    } else {
      this._refreshAll();
    }
  }

  _panelCollection(panel) {
    try {
      return panel?.getActiveCollection?.() || null;
    } catch (_) {
      return null;
    }
  }

  _collectionGuid(collection) {
    try {
      const guid =
        (typeof collection?.getGuid === 'function' ? collection.getGuid() : null) ||
        (typeof collection?.getGUID === 'function' ? collection.getGUID() : null) ||
        collection?.guid ||
        collection?.id ||
        '';
      return typeof guid === 'string' ? guid.trim() : '';
    } catch (_) {
      return '';
    }
  }

  _collapseScopeKey(record, panel) {
    if (this._isJournal(record)) return '__journal__';
    const fromPanel = this._collectionGuid(this._panelCollection(panel));
    if (fromPanel) return 'c:' + fromPanel;
    try {
      const fromRec = this._collectionGuid(record?.getCollection?.());
      if (fromRec) return 'c:' + fromRec;
    } catch (_) {}
    const label = this._recordCollectionLabel(record);
    if (label) return 'n:' + label.toLowerCase();
    const guid = this._recordGuid(record);
    return guid ? 'r:' + guid : '';
  }

  _footerCollapsed(state) {
    const scope =
      state?.collapseScope || this._collapseScopeKey(state?.record, state?.panel);
    if (scope && Object.prototype.hasOwnProperty.call(this._collapsedByScope || {}, scope)) {
      return this._collapsedByScope[scope] === true;
    }
    return this._defaultCollapsed !== false;
  }

  _activeState() {
    try {
      const panel = this.ui.getActivePanel?.();
      const id = panel?.getId?.();
      if (id && this._panelStates.has(id)) return this._panelStates.get(id);
      if (panel) {
        for (const s of this._panelStates.values()) {
          if (s.panel === panel) return s;
        }
      }
    } catch (_) {}
    return null;
  }

  _setCollapsed(collapsed, state) {
    const st = state || this._activeState();
    let scope =
      st?.collapseScope || this._collapseScopeKey(st?.record, st?.panel);
    if (!scope) {
      try {
        const panel = this.ui.getActivePanel?.();
        scope = this._collapseScopeKey(panel?.getActiveRecord?.(), panel);
      } catch (_) {}
    }
    const next = !!collapsed;
    const was = this._footerCollapsed(st || { collapseScope: scope });
    if (scope) this._collapsedByScope[scope] = next;
    else this._defaultCollapsed = next;
    this._saveCfg();
    const forceLoad = was && !next;
    if (scope) {
      for (const s of this._panelStates.values()) {
        const key = s.collapseScope || this._collapseScopeKey(s.record, s.panel);
        if (key === scope && s.panel) this._handlePanel(s.panel, { forceLoad });
      }
    } else {
      this._refreshAll({ forceLoad });
    }
  }

  _loadCache() {
    try {
      const raw = localStorage.getItem(BL_LS_CACHE);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p && typeof p === 'object') this._cache = p;
    } catch (_) {}
  }

  _saveCache() {
    try {
      // Keep cache bounded.
      const keys = Object.keys(this._cache);
      if (keys.length > 80) {
        keys
          .sort((a, b) => (this._cache[a]?.builtAt || 0) - (this._cache[b]?.builtAt || 0))
          .slice(0, keys.length - 60)
          .forEach((k) => delete this._cache[k]);
      }
      localStorage.setItem(BL_LS_CACHE, JSON.stringify(this._cache));
    } catch (_) {}
  }

  _loadCatalogMeta() {
    try {
      const raw = localStorage.getItem(BL_LS_CATALOG);
      if (!raw) return;
      const p = JSON.parse(raw);
      if (p) this._catalog = { count: p.count || 0, builtAt: p.builtAt || 0, ms: p.ms || 0 };
    } catch (_) {}
  }

  _saveCatalogMeta() {
    try {
      localStorage.setItem(BL_LS_CATALOG, JSON.stringify(this._catalog));
    } catch (_) {}
  }

  async _runIdle() {}

  /** Catalog skipped — darienx References is a full-library scan we never run on idle. */
  async _buildCatalog() {}

  /** Prod Backlinks+ affiliate glyph (Tabler outline; font often blank in footers). */
  _affiliateSvg(sizePx) {
    const n = sizePx || 15;
    return (
      '<svg xmlns="http://www.w3.org/2000/svg" width="' +
      n +
      '" height="' +
      n +
      '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.75"' +
      ' stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' +
      '<path d="M5.931 6.936l1.275 4.249m5.607 5.609l4.251 1.275"/>' +
      '<path d="M11.683 12.317l5.759 -5.759"/>' +
      '<path d="M4 5.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0"/>' +
      '<path d="M17 5.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0"/>' +
      '<path d="M17 18.5a1.5 1.5 0 1 0 3 0a1.5 1.5 0 1 0 -3 0"/>' +
      '<path d="M4 15.5a4.5 4.5 0 1 0 9 0a4.5 4.5 0 1 0 -9 0"/>' +
      '</svg>'
    );
  }

  _syncPillCaret(caretEl, collapsed) {
    if (!caretEl?.classList) return;
    caretEl.classList.remove('ti-chevron-down', 'ti-chevron-right');
    caretEl.classList.add(collapsed ? 'ti-chevron-right' : 'ti-chevron-down');
  }

  _buildPillHeader() {
    const header = document.createElement('div');
    header.className = 'dawn-tlr-header tlr-header';

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className =
      'dawn-tlr-pill tlr-summary-pill button-none button-small button-minimal-hover';
    pill.title = 'Collapse/expand';
    pill.setAttribute('aria-label', 'Expand');
    pill.setAttribute('aria-expanded', 'false');

    const icon = document.createElement('span');
    icon.className = 'dawn-tlr-title-icon tlr-title-icon';
    icon.setAttribute('aria-hidden', 'true');
    icon.innerHTML = this._affiliateSvg(15);

    const label = document.createElement('span');
    label.className = 'dawn-tlr-pill-label tlr-pill-label';
    label.textContent = 'backlinks';

    const count = document.createElement('span');
    count.className = 'dawn-tlr-count tlr-count';
    count.dataset.role = 'count';

    const caret = document.createElement('span');
    caret.className = 'ti dawn-tlr-toggle-caret tlr-toggle-caret';
    caret.setAttribute('aria-hidden', 'true');
    this._syncPillCaret(caret, true);

    pill.appendChild(icon);
    pill.appendChild(label);
    pill.appendChild(count);
    pill.appendChild(caret);
    pill.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const st = this._stateForEl(pill);
      this._setCollapsed(!this._footerCollapsed(st), st);
    });

    const controls = document.createElement('div');
    controls.className = 'dawn-tlr-header-controls tlr-header-controls';

    // Prod order: settings → groupModes → TM → filter → sort
    const settingsBtn = document.createElement('button');
    settingsBtn.type = 'button';
    settingsBtn.className =
      'dawn-tlr-hover-action dawn-tlr-settings-cog button-none button-small button-minimal-hover';
    settingsBtn.title = 'Backreferences settings';
    settingsBtn.setAttribute('aria-label', 'Backreferences settings');
    settingsBtn.setAttribute('data-tooltip', 'Settings');
    const settingsIcon = document.createElement('span');
    settingsIcon.className = 'ti ti-settings';
    settingsIcon.setAttribute('aria-hidden', 'true');
    settingsBtn.appendChild(settingsIcon);
    settingsBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._openSettingsMenu(settingsBtn);
    });
    controls.appendChild(settingsBtn);

    const groupModes = document.createElement('div');
    groupModes.className = 'dawn-tlr-group-modes tlr-group-modes';
    for (const mode of [
      { id: 'collection', icon: 'ti-folder', label: 'Group by collection' },
      { id: 'time', icon: 'ti-clock', label: 'Group by time' },
      { id: 'property', icon: 'ti-id', label: 'Group by property' },
    ]) {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'dawn-tlr-group-mode tlr-group-mode button-none button-small button-minimal-hover';
      btn.dataset.groupBy = mode.id;
      btn.title = mode.label;
      btn.setAttribute('aria-label', mode.label);
      btn.setAttribute('aria-pressed', 'false');
      btn.classList.toggle('is-active', false);
      const gi = document.createElement('span');
      gi.className = 'ti ' + mode.icon;
      gi.setAttribute('aria-hidden', 'true');
      btn.appendChild(gi);
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        const st = this._stateForEl(btn) || this._activeState();
        this._setGroupBy(mode.id, st);
      });
      groupModes.appendChild(btn);
    }
    controls.appendChild(groupModes);

    const tmBtn = document.createElement('button');
    tmBtn.type = 'button';
    tmBtn.className =
      'dawn-tlr-tm-toggle tlr-tm-toggle button-none button-small button-minimal-hover is-disabled';
    tmBtn.title = 'Time Machine';
    tmBtn.setAttribute('aria-label', 'Time Machine');
    tmBtn.setAttribute('aria-pressed', 'false');
    tmBtn.dataset.action = 'toggle-time-machine';
    const tmIcon = document.createElement('span');
    tmIcon.className = 'ti ti-hourglass';
    tmIcon.setAttribute('aria-hidden', 'true');
    tmBtn.appendChild(tmIcon);
    tmBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      const st = this._stateForEl(tmBtn);
      if (st) void this._toggleTimeMachine(st);
    });
    controls.appendChild(tmBtn);

    const filterBtn = document.createElement('button');
    filterBtn.type = 'button';
    filterBtn.className =
      'dawn-tlr-filter-toggle tlr-filter-toggle button-none button-small button-minimal-hover';
    filterBtn.title = this._searchOpen ? 'Hide filter bar' : 'Filter';
    filterBtn.setAttribute('aria-label', filterBtn.title);
    filterBtn.setAttribute('aria-expanded', this._searchOpen ? 'true' : 'false');
    filterBtn.classList.toggle('is-active', !!this._searchOpen || !!(this._searchQuery || '').trim());
    const filterIcon = document.createElement('span');
    filterIcon.className = 'ti ti-filter id--filter-icon';
    filterIcon.setAttribute('aria-hidden', 'true');
    filterBtn.appendChild(filterIcon);
    filterBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._setSearchOpen(!this._searchOpen, this._stateForEl(filterBtn));
    });
    controls.appendChild(filterBtn);

    const sortWrap = document.createElement('div');
    sortWrap.className = 'dawn-tlr-sort-wrap tlr-sort-wrap';
    const sortBtn = document.createElement('button');
    sortBtn.type = 'button';
    sortBtn.className =
      'dawn-tlr-sort-toggle tlr-sort-toggle button-none button-small button-minimal-hover';
    sortBtn.title = 'Sort options';
    sortBtn.setAttribute('aria-label', 'Sort options');
    sortBtn.setAttribute('aria-haspopup', 'menu');
    const glyph = document.createElement('span');
    glyph.className = 'dawn-tlr-sort-glyph tlr-sort-glyph';
    glyph.setAttribute('aria-hidden', 'true');
    const bars = document.createElement('span');
    bars.className = 'dawn-tlr-sort-glyph-bars tlr-sort-glyph-bars';
    const arrows = document.createElement('span');
    arrows.className = 'dawn-tlr-sort-glyph-arrows tlr-sort-glyph-arrows';
    glyph.appendChild(bars);
    glyph.appendChild(arrows);
    sortBtn.appendChild(glyph);
    sortBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._setSortMenuOpen(!this._sortMenuOpen);
    });
    const sortMenu = document.createElement('div');
    sortMenu.className = 'dawn-tlr-sort-menu tlr-sort-menu';
    sortMenu.setAttribute('role', 'menu');
    sortMenu.setAttribute('aria-label', 'Backreferences sort options');
    sortWrap.appendChild(sortBtn);
    sortWrap.appendChild(sortMenu);
    controls.appendChild(sortWrap);

    header.appendChild(pill);
    header.appendChild(controls);
    return {
      header,
      pill,
      count,
      caret,
      filterBtn,
      settingsBtn,
      groupModes,
      tmBtn,
      sortBtn,
      sortMenu,
      sortWrap,
    };
  }

  _excludedSet() {
    return new Set(
      (this._excludedCollections || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean)
    );
  }

  _isExcludedCollection(name) {
    const n = String(name || '').trim().toLowerCase();
    if (!n) return false;
    return this._excludedSet().has(n);
  }

  _recordCollectionLabel(record) {
    if (!record) return '';
    try {
      if (typeof record.prop === 'function') {
        const prop = record.prop('Collection') || record.prop('collection');
        if (prop) {
          if (typeof prop.choiceLabel === 'function') {
            const label = String(prop.choiceLabel() || '').trim();
            if (label) return label;
          }
          if (typeof prop.text === 'function') {
            const text = String(prop.text() || '').trim();
            if (text) return text;
          }
        }
      }
    } catch (_) {}
    try {
      const coll = record.getCollection?.();
      const name = coll?.getName?.() || coll?.name || '';
      if (name) return String(name).trim();
    } catch (_) {}
    try {
      const n = record.collectionName || record.collection || '';
      if (n && typeof n === 'string') return n.trim();
    } catch (_) {}
    return '';
  }

  _filterExcludedGroups(groups) {
    const excl = this._excludedSet();
    if (!excl.size) return groups;
    return (groups || []).filter((g) => !excl.has(String(g.collection || '').trim().toLowerCase()));
  }

  _collectionsFromCache() {
    const names = new Set();
    for (const entry of Object.values(this._cache || {})) {
      for (const ref of entry?.refs || []) {
        const c = String(ref.collection || '').trim();
        if (c) names.add(c);
      }
    }
    for (const n of this._excludedCollections || []) {
      if (n) names.add(n);
    }
    return [...names].sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
  }

  async _collectionNamesOnDemand() {
    const boot = globalThis.BootKernel || globalThis.__dawnBoot;
    let all = [];
    try {
      all = boot?.getAllCollections
        ? await boot.getAllCollections(this.data)
        : await this.data.getAllCollections?.();
    } catch (_) {
      all = [];
    }
    const names = [];
    const seen = new Set();
    const push = (raw) => {
      const name = String(raw || '').trim();
      if (!name) return;
      const key = name.toLowerCase();
      if (seen.has(key)) return;
      if (key === 'journal' || key === 'journals') return;
      seen.add(key);
      names.push(name);
    };
    for (const coll of all || []) {
      push(coll?.name || (typeof coll?.getName === 'function' ? coll.getName() : ''));
    }
    for (const n of this._collectionsFromCache()) push(n);
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    return names;
  }

  _openSettingsMenu(anchorEl) {
    const existing = document.getElementById('dawn-tlr-settings-menu');
    if (existing) {
      existing.remove();
      return;
    }
    const menu = document.createElement('div');
    menu.id = 'dawn-tlr-settings-menu';
    menu.className = 'dawn-tlr-popup-menu';
    const close = () => {
      try { menu.remove(); } catch (_) {}
      document.removeEventListener('mousedown', onDocDown, true);
      document.removeEventListener('keydown', onKey, true);
    };
    const onDocDown = (e) => {
      if (menu.contains(e.target)) return;
      if (anchorEl?.contains?.(e.target)) return;
      close();
    };
    const onKey = (e) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        close();
      }
    };
    const addItem = (label, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dawn-tlr-popup-menu-item button-none';
      btn.textContent = label;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        close();
        onClick();
      });
      menu.appendChild(btn);
    };
    const n = (this._excludedCollections || []).length;
    addItem('Excluded collections…' + (n ? ' (' + n + ')' : ''), () => this._openExcludedDialog());
    addItem(
      (this._hideBuiltInBacklinks !== false ? '✓ ' : '') + 'Hide built-in Backlinks',
      () => {
        this._hideBuiltInBacklinks = this._hideBuiltInBacklinks === false;
        this._saveCfg();
        this._applyNativeBacklinksVisibility();
      }
    );
    addItem('Time Machine settings…', () => this._openTimeMachineSettings());
    document.documentElement.appendChild(menu);
    try {
      const r = anchorEl.getBoundingClientRect();
      const w = Math.max(200, menu.offsetWidth || 220);
      menu.style.width = w + 'px';
      menu.style.left =
        Math.max(8, Math.min(window.innerWidth - w - 8, Math.round(r.right - w))) + 'px';
      menu.style.top = Math.round(r.bottom + 6) + 'px';
    } catch (_) {}
    document.addEventListener('mousedown', onDocDown, true);
    document.addEventListener('keydown', onKey, true);
  }

  async _openExcludedDialog() {
    try { document.querySelector('.dawn-tlr-excl-overlay')?.remove?.(); } catch (_) {}
    const excludedStart = new Set(
      (this._excludedCollections || []).map((n) => String(n).trim().toLowerCase()).filter(Boolean)
    );
    const included = new Set();
    const nameByLower = new Map();
    const names = [];

    const overlay = document.createElement('div');
    overlay.className = 'dawn-tlr-excl-overlay';
    const panel = document.createElement('div');
    panel.className = 'dawn-tlr-excl-panel';
    const h = document.createElement('h3');
    h.textContent = 'Collections in Backlinks';
    panel.appendChild(h);
    const help = document.createElement('p');
    help.className = 'dawn-tlr-excl-help';
    help.textContent =
      'Checked collections appear. Uncheck any collection you want hidden from Backlinks and Time Machine.';
    panel.appendChild(help);

    let hideDraft = this._hideBuiltInBacklinks !== false;
    const hideRow = document.createElement('label');
    hideRow.className = 'dawn-tlr-excl-row dawn-tlr-excl-hide-native tlr-tm-settings-row';
    const hideCb = document.createElement('input');
    hideCb.type = 'checkbox';
    hideCb.checked = hideDraft;
    hideCb.addEventListener('change', () => {
      hideDraft = !!hideCb.checked;
    });
    hideRow.append(hideCb, document.createTextNode(' Hide built-in Backlinks chip'));
    panel.appendChild(hideRow);

    const filterRow = document.createElement('div');
    filterRow.className = 'dawn-tlr-excl-filter-row';
    const filter = document.createElement('input');
    filter.type = 'search';
    filter.className = 'dawn-tlr-tm-settings-input dawn-tlr-excl-filter';
    filter.placeholder = 'Filter collections…';
    filter.disabled = true;
    const bulk = document.createElement('div');
    bulk.className = 'dawn-tlr-excl-bulk';
    const mkBulk = (label, apply) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dawn-tlr-excl-bulk-btn button-none';
      btn.textContent = label;
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        apply();
      });
      return btn;
    };
    const visibleKeys = () => {
      const q = filter.value.trim().toLowerCase();
      return names.map((n) => n.toLowerCase()).filter((k) => !q || k.includes(q));
    };
    bulk.appendChild(mkBulk('All', () => {
      for (const k of visibleKeys()) included.add(k);
      renderItems();
    }));
    bulk.appendChild(mkBulk('None', () => {
      for (const k of visibleKeys()) included.delete(k);
      renderItems();
    }));
    filterRow.append(filter, bulk);
    panel.appendChild(filterRow);

    const listWrap = document.createElement('div');
    listWrap.className = 'dawn-tlr-excl-list tlr-excl-list';
    const loading = document.createElement('p');
    loading.className = 'dawn-tlr-excl-help';
    loading.textContent = 'Loading collections…';
    listWrap.appendChild(loading);
    panel.appendChild(listWrap);

    const actions = document.createElement('div');
    actions.className = 'dawn-tlr-excl-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => overlay.remove());
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'primary';
    save.textContent = 'Save';
    save.disabled = true;
    save.addEventListener('click', () => {
      this._excludedCollections = names
        .filter((n) => !included.has(n.toLowerCase()))
        .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
      this._hideBuiltInBacklinks = hideDraft !== false;
      this._saveCfg();
      this._applyNativeBacklinksVisibility();
      overlay.remove();
      this._refreshAll();
    });
    actions.append(cancel, save);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    overlay.addEventListener('mousedown', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.documentElement.appendChild(overlay);

    const itemsHost = document.createElement('div');
    itemsHost.className = 'dawn-tlr-excl-items tlr-excl-items';
    const renderItems = () => {
      const q = filter.value.trim().toLowerCase();
      itemsHost.replaceChildren();
      let shown = 0;
      for (const name of names) {
        const key = name.toLowerCase();
        if (q && !key.includes(q)) continue;
        shown += 1;
        const row = document.createElement('label');
        row.className = 'dawn-tlr-excl-row tlr-excl-item tlr-tm-settings-row';
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = included.has(key);
        cb.addEventListener('change', () => {
          if (cb.checked) included.add(key);
          else included.delete(key);
        });
        row.append(cb, document.createTextNode(' ' + name));
        itemsHost.appendChild(row);
      }
      if (!shown) {
        const empty = document.createElement('p');
        empty.className = 'dawn-tlr-excl-help';
        empty.textContent = names.length ? 'No matches.' : 'No collections found.';
        itemsHost.appendChild(empty);
      }
    };

    let loaded = [];
    try {
      loaded = await this._collectionNamesOnDemand();
    } catch (_) {
      loaded = this._collectionsFromCache();
    }
    if (!overlay.isConnected) return;
    names.length = 0;
    for (const n of loaded) {
      const key = n.toLowerCase();
      if (!nameByLower.has(key)) {
        nameByLower.set(key, n);
        names.push(n);
      }
    }
    for (const kept of this._excludedCollections || []) {
      const key = String(kept || '').trim().toLowerCase();
      if (key && !nameByLower.has(key)) {
        nameByLower.set(key, kept);
        names.push(kept);
      }
    }
    names.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: 'base' }));
    included.clear();
    for (const n of names) {
      const key = n.toLowerCase();
      if (!excludedStart.has(key)) included.add(key);
    }

    listWrap.replaceChildren(itemsHost);
    filter.disabled = false;
    save.disabled = false;
    filter.addEventListener('input', renderItems);
    filter.addEventListener('keydown', (e) => e.stopPropagation());
    renderItems();
    queueMicrotask(() => {
      try { filter.focus(); } catch (_) {}
    });
  }

  _setSortMenuOpen(open) {
    this._sortMenuOpen = !!open;
    this._refreshAll();
    if (this._sortMenuOpen) {
      queueMicrotask(() => {
        const onDoc = (e) => {
          for (const st of this._panelStates.values()) {
            if (st.sortWrapEl?.contains?.(e.target)) return;
          }
          document.removeEventListener('mousedown', onDoc, true);
          this._setSortMenuOpen(false);
        };
        document.addEventListener('mousedown', onDoc, true);
      });
    }
  }

  _sortSummary(state) {
    const by = this._sortBy;
    const dir = this._sortDir;
    const groupBy = this._groupByForState(state || this._activeState());
    const grouped = groupBy && groupBy !== 'none';
    const labels = {
      journal_page: 'Journal Page / When',
      page_last_edited: 'Page Last Edited',
      page_title: 'Page Title',
      reference_count: 'Reference Count',
    };
    const dateDir = dir === 'asc' ? 'oldest first' : 'newest first';
    const dirLabel = grouped
      ? dateDir + ' in group'
      : by === 'page_title'
        ? dir === 'asc'
          ? 'A→Z'
          : 'Z→A'
        : by === 'reference_count'
          ? dir === 'asc'
            ? 'fewest first'
            : 'most first'
          : dateDir;
    const parts = [labels[by] || by, dirLabel];
    if (grouped) {
      const noun = groupBy === 'time' ? 'time' : groupBy;
      parts.push('grouped by ' + noun);
    }
    return parts.join(' · ');
  }

  _paintSortMenu(menuEl, state) {
    if (!menuEl) return;
    menuEl.innerHTML = '';
    const stateLine = document.createElement('div');
    stateLine.className = 'dawn-tlr-sort-menu-state';
    stateLine.textContent = this._sortSummary(state);
    menuEl.appendChild(stateLine);
    const addLabel = (t) => {
      const el = document.createElement('div');
      el.className = 'dawn-tlr-sort-menu-label';
      el.textContent = t;
      menuEl.appendChild(el);
    };
    const addItem = (label, active, onClick) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className = 'dawn-tlr-sort-menu-item button-none' + (active ? ' is-active' : '');
      const mark = document.createElement('span');
      mark.className = 'dawn-tlr-sort-menu-check';
      mark.textContent = active ? '✓' : '';
      const txt = document.createElement('span');
      txt.textContent = label;
      btn.appendChild(mark);
      btn.appendChild(txt);
      btn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        onClick();
        this._setSortMenuOpen(false);
      });
      menuEl.appendChild(btn);
    };
    const sep = () => {
      const el = document.createElement('div');
      el.className = 'dawn-tlr-sort-menu-sep';
      menuEl.appendChild(el);
    };

    addLabel('Sort by');
    for (const opt of [
      { id: 'journal_page', label: 'Journal Page / When' },
      { id: 'page_last_edited', label: 'Page Last Edited' },
      { id: 'page_title', label: 'Page Title' },
      { id: 'reference_count', label: 'Reference Count' },
    ]) {
      addItem(opt.label, this._sortBy === opt.id, () => {
        this._sortBy = opt.id;
        this._saveCfg();
        this._refreshAll();
      });
    }
    sep();
    addLabel('Direction');
    addItem('Ascending', this._sortDir === 'asc', () => {
      this._sortDir = 'asc';
      this._saveCfg();
      this._refreshAll();
    });
    addItem('Descending', this._sortDir === 'desc', () => {
      this._sortDir = 'desc';
      this._saveCfg();
      this._refreshAll();
    });
  }

  /** Journal page / When, else last edited. Last-edited sort prefers editedMs. */
  _dateKey(g) {
    const useEdited = this._sortBy === 'page_last_edited';
    return Number((useEdited ? g.editedMs || g.whenMs : g.whenMs || g.editedMs) || 0);
  }

  _compareTitle(a, b) {
    return String(a.title || '').localeCompare(String(b.title || ''), undefined, {
      sensitivity: 'base',
    });
  }

  _compareGuid(a, b) {
    return String(a.fromGuid || '').localeCompare(String(b.fromGuid || ''));
  }

  /**
   * Newest-first by default (`sortDir` desc). Undated records sort last when desc,
   * first when asc — they should not interleave dated rows.
   */
  _sortByDateThenTitle(groups) {
    const dir = this._sortDir === 'desc' ? -1 : 1;
    const arr = (groups || []).slice();
    arr.sort((a, b) => {
      const da = this._dateKey(a);
      const db = this._dateKey(b);
      if (da !== db) return (da - db) * dir;
      const t = this._compareTitle(a, b);
      if (t) return t;
      return this._compareGuid(a, b);
    });
    return arr;
  }

  _sortGroups(groups) {
    const dir = this._sortDir === 'desc' ? -1 : 1;
    const by = this._sortBy;
    const arr = groups.slice();
    arr.sort((a, b) => {
      let cmp = 0;
      if (by === 'reference_count') {
        cmp = (a.lines?.length || 0) - (b.lines?.length || 0);
      } else if (by === 'page_title') {
        cmp = this._compareTitle(a, b);
      } else {
        cmp = this._dateKey(a) - this._dateKey(b);
      }
      if (cmp) return cmp * dir;
      const dateCmp = this._dateKey(a) - this._dateKey(b);
      if (dateCmp) return dateCmp * dir;
      const titleCmp = this._compareTitle(a, b);
      if (titleCmp) return titleCmp;
      return this._compareGuid(a, b);
    });
    return arr;
  }

  _bucketGroups(groups, groupByIn) {
    const groupBy = this._normalizeGroupBy(groupByIn) || 'none';
    if (!groupBy || groupBy === 'none') {
      return [{ label: '', groups }];
    }
    const map = new Map();
    const orderBy = Object.create(null);
    for (const g of groups) {
      let key = 'Other';
      let order = 5000;
      if (groupBy === 'property') {
        key = (g.propertyName || 'References').trim() || 'References';
      } else if (groupBy === 'collection') {
        key = (g.collection || 'No collection').trim() || 'No collection';
      } else if (groupBy === 'time') {
        const ms = this._dateKey(g);
        const bucket = this._timeBucket(ms);
        key = bucket.key;
        order = bucket.order;
      }
      if (!map.has(key)) map.set(key, []);
      map.get(key).push(g);
      if (orderBy[key] == null || order < orderBy[key]) orderBy[key] = order;
    }
    const keys = [...map.keys()].sort((a, b) => {
      if (groupBy === 'time') {
        const da = orderBy[a] ?? 5000;
        const db = orderBy[b] ?? 5000;
        if (da !== db) return da - db;
      }
      if (a === 'Other' || a === 'No collection' || a === 'No date') return 1;
      if (b === 'Other' || b === 'No collection' || b === 'No date') return -1;
      return a.localeCompare(b, undefined, { sensitivity: 'base' });
    });
    // Group headings are collection / time / property; records inside a heading
    // are always date-ordered (same direction as Sort). Title/count sort still
    // applies to the ungrouped list.
    return keys.map((k) => ({ label: k, groups: this._sortByDateThenTitle(map.get(k)) }));
  }

  _buildSearchRow() {
    const row = document.createElement('div');
    row.className = 'dawn-tlr-search-row';
    const wrap = document.createElement('div');
    wrap.className = 'dawn-tlr-search-wrap';
    const input = document.createElement('input');
    input.type = 'text';
    input.className = 'dawn-tlr-search-input';
    input.placeholder = 'Search text, or use @Collection.property = "value"';
    input.title =
      'Search text, or use @Collection.property = "value". Dawn applies a cache-safe subset.';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = this._searchQuery || '';
    input.addEventListener('keydown', (e) => {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
      if (this._acOpen && this._acItems.length) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this._acIndex = Math.min(
            this._acItems.length - 1,
            this._acIndex < 0 ? 0 : this._acIndex + 1
          );
          this._paintAutocompleteOnly();
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this._acIndex = Math.max(0, this._acIndex - 1);
          this._paintAutocompleteOnly();
          return;
        }
        if ((e.key === 'Enter' || e.key === 'Tab') && this._acIndex >= 0) {
          e.preventDefault();
          this._applyAutocomplete(this._acItems[this._acIndex], input);
          return;
        }
      }
      if (e.key === 'Escape') {
        e.preventDefault();
        if (this._acOpen) {
          this._acOpen = false;
          this._acItems = [];
          this._acIndex = -1;
          this._paintAutocompleteOnly();
          return;
        }
        if ((this._searchQuery || '').trim()) {
          this._searchQuery = '';
          input.value = '';
          this._saveCfg();
          this._onSearchChanged({ immediate: true });
        } else {
          this._setSearchOpen(false);
        }
      }
    });
    input.addEventListener('input', () => {
      this._searchQuery = input.value;
      this._saveCfg();
      this._updateAutocomplete(input);
      this._onSearchChanged({ immediate: false });
    });
    input.addEventListener('focus', () => this._updateAutocomplete(input));
    const clearBtn = document.createElement('button');
    clearBtn.type = 'button';
    clearBtn.className =
      'dawn-tlr-search-clear button-none button-small button-minimal-hover';
    clearBtn.title = 'Clear search';
    clearBtn.setAttribute('aria-label', 'Clear search');
    const x = document.createElement('span');
    x.className = 'ti ti-x';
    x.setAttribute('aria-hidden', 'true');
    clearBtn.appendChild(x);
    clearBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._searchQuery = '';
      input.value = '';
      this._acOpen = false;
      this._acItems = [];
      this._saveCfg();
      this._onSearchChanged({ immediate: true });
      try {
        input.focus();
      } catch (_) {}
    });
    const refreshBtn = document.createElement('button');
    refreshBtn.type = 'button';
    refreshBtn.className =
      'dawn-tlr-search-refresh button-none button-small button-minimal-hover';
    refreshBtn.title = 'Refresh backlinks for this page';
    refreshBtn.setAttribute('aria-label', 'Refresh');
    const refreshIcon = document.createElement('span');
    refreshIcon.className = 'ti ti-refresh';
    refreshIcon.setAttribute('aria-hidden', 'true');
    refreshBtn.appendChild(refreshIcon);
    refreshBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      this._refreshAll({ forceLoad: true });
    });
    const ac = document.createElement('div');
    ac.className = 'dawn-tlr-search-ac';
    ac.setAttribute('role', 'listbox');
    wrap.appendChild(input);
    wrap.appendChild(clearBtn);
    wrap.appendChild(refreshBtn);
    wrap.appendChild(ac);
    row.appendChild(wrap);
    return { row, input, clearBtn, refreshBtn, ac };
  }

  _onSearchChanged({ immediate } = {}) {
    clearTimeout(this._inputDebounce);
    const run = () => {
      this._inputDebounce = null;
      this._refreshAll();
    };
    const mode = this._getSearchMode(this._searchQuery);
    if (immediate || mode !== 'query') run();
    else this._inputDebounce = setTimeout(run, 160);
  }

  _setSearchOpen(open, state) {
    this._searchOpen = !!open;
    const st = state || this._activeState();
    if (!this._searchOpen) {
      this._acOpen = false;
      this._acItems = [];
      this._acIndex = -1;
    }
    if (this._searchOpen && this._footerCollapsed(st)) {
      this._setCollapsed(false, st);
    } else {
      this._saveCfg();
      this._refreshAll({ forceLoad: this._searchOpen && !this._footerCollapsed(st) });
    }
    if (this._searchOpen) {
      queueMicrotask(() => {
        try {
          (st?.searchInputEl || this._activeState()?.searchInputEl)?.focus?.();
        } catch (_) {}
      });
    }
  }

  _getSearchMode(rawQuery) {
    const query = (rawQuery || '').trim();
    if (!query) return 'none';
    if (query.includes('@') || query.includes('#') || query.includes('"')) return 'query';
    if (query.includes('(') || query.includes(')')) return 'query';
    if (query.includes('&&') || query.includes('||')) return 'query';
    if (/\b(?:AND|OR|NOT)\b/.test(query)) return 'query';
    return 'text';
  }

  _isIncompleteQueryDraft(rawQuery) {
    const query = (rawQuery || '').trim();
    if (this._getSearchMode(query) !== 'query') return false;
    if (/(?:^|[\s(])@$/.test(query)) return true;
    if (/(?:^|[\s(])@"(?:[^"\\]|\\.)*$/.test(query)) return true;
    if (/(?:^|[\s(])@(?:collection|text)\s*$/i.test(query)) return true;
    if (/(?:^|[\s(])@(?:collection|text)\s*(?:=|!=)\s*$/i.test(query)) return true;
    if (/(?:^|[\s(])@(?:collection|text)\s*(?:=|!=)\s*"$/.test(query)) return true;
    if (/(?:^|[\s(])@(?:collection|text)\s*(?:=|!=)\s*"(?:[^"\\]|\\.)*$/.test(query)) {
      return true;
    }
    return false;
  }

  _unquote(tok) {
    const s = String(tok || '').trim();
    if (s.length >= 2 && s.startsWith('"') && s.endsWith('"')) {
      return s.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\');
    }
    return s;
  }

  _tokenizeQuery(query) {
    const s = String(query || '');
    const tokens = [];
    let i = 0;
    while (i < s.length) {
      if (/\s/.test(s[i])) {
        i += 1;
        continue;
      }
      if (s[i] === '(' || s[i] === ')') {
        tokens.push({ type: s[i] });
        i += 1;
        continue;
      }
      if (s[i] === '"') {
        let j = i + 1;
        let out = '';
        while (j < s.length) {
          if (s[j] === '\\' && j + 1 < s.length) {
            out += s[j + 1];
            j += 2;
            continue;
          }
          if (s[j] === '"') break;
          out += s[j];
          j += 1;
        }
        tokens.push({ type: 'string', value: out });
        i = j < s.length ? j + 1 : j;
        continue;
      }
      if (s.startsWith('!=', i)) {
        tokens.push({ type: 'op', value: '!=' });
        i += 2;
        continue;
      }
      if (s[i] === '=') {
        tokens.push({ type: 'op', value: '=' });
        i += 1;
        continue;
      }
      if (s[i] === '#') {
        let j = i + 1;
        while (j < s.length && !/[\s()]/.test(s[j])) j += 1;
        tokens.push({ type: 'hashtag', value: s.slice(i, j) });
        i = j;
        continue;
      }
      if (s[i] === '@') {
        let j = i + 1;
        if (s[j] === '"') {
          j += 1;
          while (j < s.length) {
            if (s[j] === '\\' && j + 1 < s.length) {
              j += 2;
              continue;
            }
            if (s[j] === '"') {
              j += 1;
              break;
            }
            j += 1;
          }
        } else {
          while (j < s.length && /[A-Za-z0-9_]/.test(s[j])) j += 1;
        }
        tokens.push({ type: 'at', value: s.slice(i, j) });
        i = j;
        continue;
      }
      let j = i;
      while (
        j < s.length &&
        !/[\s()=!]/.test(s[j]) &&
        s[j] !== '"' &&
        s[j] !== '@' &&
        s[j] !== '#'
      ) {
        j += 1;
      }
      const word = s.slice(i, j);
      const up = word.toUpperCase();
      if (up === 'AND' || up === 'OR' || up === 'NOT') tokens.push({ type: up });
      else if (word === '&&') tokens.push({ type: 'AND' });
      else if (word === '||') tokens.push({ type: 'OR' });
      else tokens.push({ type: 'word', value: word });
      i = j;
    }
    return tokens;
  }

  _parseQuery(query) {
    const tokens = this._tokenizeQuery(query);
    let i = 0;
    const peek = () => tokens[i] || null;
    const take = () => tokens[i++] || null;
    const unsupported = (msg) => ({ type: 'unsupported', message: msg || 'Unsupported query' });

    const parsePrimary = () => {
      const t = peek();
      if (!t) return unsupported('Empty query');
      if (t.type === '(') {
        take();
        const inner = parseOr();
        if (peek()?.type !== ')') return unsupported('Missing )');
        take();
        return inner;
      }
      if (t.type === 'NOT') {
        take();
        return { type: 'not', child: parsePrimary() };
      }
      if (t.type === 'hashtag') {
        take();
        return { type: 'text', op: '=', value: t.value };
      }
      if (t.type === 'string') {
        take();
        return { type: 'text', op: '=', value: t.value };
      }
      if (t.type === 'at') {
        take();
        const keyRaw = t.value.slice(1);
        const key = this._unquote(keyRaw.startsWith('"') ? keyRaw : keyRaw).toLowerCase();
        if (key.includes('.')) {
          return unsupported('Field queries (@Collection.Field) not in cache subset');
        }
        if (key !== 'collection' && key !== 'text') {
          return unsupported('Only @collection and @text supported (cache subset)');
        }
        const opTok = peek();
        if (!opTok || opTok.type !== 'op') return unsupported('Expected = or !=');
        take();
        const valTok = peek();
        if (!valTok || (valTok.type !== 'string' && valTok.type !== 'word' && valTok.type !== 'at')) {
          return unsupported('Expected value');
        }
        take();
        let value = '';
        if (valTok.type === 'string') value = valTok.value;
        else if (valTok.type === 'at') value = this._unquote(valTok.value.slice(1));
        else value = valTok.value;
        return { type: key, op: opTok.value, value };
      }
      if (t.type === 'word') {
        take();
        return { type: 'text', op: '=', value: t.value };
      }
      return unsupported('Unexpected token');
    };

    const parseAnd = () => {
      let left = parsePrimary();
      while (peek()?.type === 'AND') {
        take();
        left = { type: 'and', left, right: parsePrimary() };
      }
      return left;
    };
    const parseOr = () => {
      let left = parseAnd();
      while (peek()?.type === 'OR') {
        take();
        left = { type: 'or', left, right: parseAnd() };
      }
      return left;
    };

    if (!tokens.length) return { type: 'empty' };
    const ast = parseOr();
    if (i < tokens.length) return unsupported('Trailing tokens');
    return ast;
  }

  _evalAst(ast, g) {
    if (!ast) return false;
    if (ast.type === 'unsupported' || ast.type === 'empty') return false;
    if (ast.type === 'and') return this._evalAst(ast.left, g) && this._evalAst(ast.right, g);
    if (ast.type === 'or') return this._evalAst(ast.left, g) || this._evalAst(ast.right, g);
    if (ast.type === 'not') return !this._evalAst(ast.child, g);
    const hayTitle = String(g.title || '').toLowerCase();
    const hayColl = String(g.collection || '').toLowerCase();
    const hayLines = (g.lines || []).map((l) => String(l.text || '').toLowerCase());
    const val = String(ast.value || '').toLowerCase();
    if (ast.type === 'collection') {
      const match = !!val && (hayColl === val || hayColl.includes(val));
      return ast.op === '!=' ? !match : match;
    }
    if (ast.type === 'text') {
      const match =
        !!val &&
        (hayTitle.includes(val) || hayColl.includes(val) || hayLines.some((t) => t.includes(val)));
      return ast.op === '!=' ? !match : match;
    }
    return false;
  }

  _trimLinesForText(g, qLower) {
    const titleHit = String(g.title || '')
      .toLowerCase()
      .includes(qLower);
    const collHit = String(g.collection || '')
      .toLowerCase()
      .includes(qLower);
    const lines = (g.lines || []).filter((l) =>
      String(l.text || '')
        .toLowerCase()
        .includes(qLower)
    );
    if (!titleHit && !collHit && !lines.length) return null;
    if (titleHit || collHit) {
      return { ...g, lines: g.lines ? g.lines.slice() : [] };
    }
    return { ...g, lines };
  }

  _filterGroups(groups) {
    const raw = String(this._searchQuery || '').trim();
    this._searchMode = this._getSearchMode(raw);
    this._queryStatus = '';
    if (!raw || this._searchMode === 'none') return groups;

    if (this._searchMode === 'text') {
      const q = raw.toLowerCase();
      const out = [];
      for (const g of groups || []) {
        const next = this._trimLinesForText(g, q);
        if (next) out.push(next);
      }
      return out;
    }

    if (this._isIncompleteQueryDraft(raw)) {
      this._queryStatus = 'incomplete';
      return groups;
    }
    const ast = this._parseQuery(raw);
    if (ast?.type === 'unsupported') {
      this._queryStatus = 'unsupported';
      return [];
    }
    if (ast?.type === 'empty') return groups;

    const out = [];
    for (const g of groups || []) {
      if (!this._evalAst(ast, g)) continue;
      if (ast.type === 'text' && ast.op === '=') {
        const q = String(ast.value || '').toLowerCase();
        const next = this._trimLinesForText(g, q);
        if (next) out.push(next);
      } else {
        out.push(g);
      }
    }
    return out;
  }

  _updateAutocomplete(inputEl) {
    const query = inputEl?.value ?? this._searchQuery ?? '';
    const caret = typeof inputEl?.selectionStart === 'number' ? inputEl.selectionStart : query.length;
    const before = query.slice(0, caret);
    const m = before.match(/(?:^|[\s(])@((?:"[^"]*)?|[A-Za-z0-9_]*)$/);
    if (!m) {
      this._acOpen = false;
      this._acItems = [];
      this._acIndex = -1;
      this._paintAutocompleteOnly();
      return;
    }
    const prefix = (m[1] || '').replace(/^"/, '').toLowerCase();
    const replaceEnd = caret;
    const replaceStart = caret - (m[1] || '').length;
    const items = [];
    for (const key of ['collection', 'text']) {
      if (prefix && !key.startsWith(prefix) && !key.includes(prefix)) continue;
      items.push({
        label: '@' + key,
        detail: key === 'collection' ? 'Filter by collection' : 'Filter by text',
        insertText: key + ' = ',
        replaceStart,
        replaceEnd,
      });
    }
    for (const name of this._collectionsFromCache().slice(0, 12)) {
      if (prefix && !name.toLowerCase().includes(prefix) && !('collection'.startsWith(prefix))) {
        continue;
      }
      const needsQ = !/^[A-Za-z0-9_]+$/.test(name);
      const id = needsQ ? '"' + name.replace(/"/g, '\\"') + '"' : name;
      items.push({
        label: '@collection = ' + name,
        detail: 'Collection',
        insertText: 'collection = ' + id + ' ',
        replaceStart,
        replaceEnd,
      });
    }
    this._acItems = items.slice(0, 14);
    this._acOpen = this._acItems.length > 0;
    this._acIndex = this._acOpen ? 0 : -1;
    this._paintAutocompleteOnly();
  }

  _applyAutocomplete(item, inputEl) {
    if (!item || !inputEl) return;
    const value = inputEl.value || '';
    const start = item.replaceStart ?? 0;
    const end = item.replaceEnd ?? start;
    const next = value.slice(0, start) + item.insertText + value.slice(end);
    inputEl.value = next;
    this._searchQuery = next;
    this._saveCfg();
    const caret = start + item.insertText.length;
    try {
      inputEl.setSelectionRange(caret, caret);
      inputEl.focus();
    } catch (_) {}
    this._acOpen = false;
    this._acItems = [];
    this._acIndex = -1;
    this._onSearchChanged({ immediate: true });
    this._updateAutocomplete(inputEl);
  }

  _paintAutocompleteOnly() {
    for (const st of this._panelStates.values()) {
      this._paintAutocomplete(st);
    }
  }

  _paintAutocomplete(state) {
    const ac = state?.acEl;
    if (!ac) return;
    ac.innerHTML = '';
    if (!this._acOpen || !this._acItems.length || this._footerCollapsed(state) || !this._searchOpen) {
      ac.classList.remove('is-open');
      return;
    }
    ac.classList.add('is-open');
    this._acItems.forEach((item, idx) => {
      const btn = document.createElement('button');
      btn.type = 'button';
      btn.className =
        'dawn-tlr-search-ac-item button-none' + (idx === this._acIndex ? ' is-active' : '');
      btn.setAttribute('role', 'option');
      const lab = document.createElement('span');
      lab.className = 'dawn-tlr-search-ac-label';
      lab.textContent = item.label;
      const det = document.createElement('span');
      det.className = 'dawn-tlr-search-ac-detail';
      det.textContent = item.detail || '';
      btn.appendChild(lab);
      btn.appendChild(det);
      btn.addEventListener('mousedown', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        this._applyAutocomplete(item, state.searchInputEl);
      });
      ac.appendChild(btn);
    });
  }

  _injectCss() {
    if (this._cssInjected) return;
    try {
      document.querySelectorAll('style[data-dawn-backlinks]').forEach((n) => n.remove());
    } catch (_) {}
    const el = document.createElement('style');
    el.setAttribute('data-dawn-backlinks', '1');
    // Look-only: production Backreferences-style native footer (pill + left rule).
    el.textContent = `
      html.tlr-hide-native-backrefs .backrefs-footer {
        display: none !important;
      }
      /* Beat Theme Architect / host .tlr-footer glass if any leftover rules fire. */
      html .dawn-tlr-footer.tlr-footer,
      .dawn-tlr-footer {
        --dawn-tlr-text-default: var(--text-default, var(--text, inherit));
        --dawn-tlr-text-muted: var(--text-muted, var(--text-secondary, var(--dawn-tlr-text-default)));
        --dawn-tlr-border-color: var(--divider-color, var(--cmdpal-border-color, var(--border-subtle, rgba(255,255,255,0.12))));
        --dawn-tlr-hover-bg: var(--button-normal-hover-color, var(--bg-hover, rgba(255,255,255,0.05)));
        --dawn-tlr-selected-bg: var(--bg-selected, var(--dawn-tlr-hover-bg));
        --dawn-tlr-editor-font: var(--editor-font-family, var(--font-family, inherit));
        --dawn-tlr-editor-size: var(--editor-font-size, 15px);
        margin: 14px 0 10px;
        padding: 0 !important;
        font: 13px/1.35 ui-sans-serif, system-ui, sans-serif;
        color: inherit;
        background: transparent !important;
        border: none !important;
        border-radius: 0 !important;
        box-shadow: none !important;
        overflow: visible;
      }
      .dawn-tlr-header {
        display: flex; align-items: center; gap: 6px;
        min-height: 28px; padding: 0; margin: 0 0 2px;
        user-select: none;
      }
      .dawn-tlr-header-controls {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 4px;
        margin-left: 2px;
      }
      .dawn-tlr-group-modes {
        display: inline-flex;
        align-items: center;
        gap: 1px;
      }
      .dawn-tlr-group-mode,
      .dawn-tlr-tm-toggle,
      .dawn-tlr-filter-toggle {
        appearance: none;
        border: 1px solid transparent;
        background: transparent;
        color: var(--text-muted, rgba(200,190,170,0.75));
        cursor: pointer;
        width: 28px;
        height: 24px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        opacity: 0;
        transition: opacity 0.12s, color 0.12s, background 0.12s, border-color 0.12s;
      }
      .dawn-tlr-header:hover .dawn-tlr-group-mode,
      .dawn-tlr-header:focus-within .dawn-tlr-group-mode,
      .dawn-tlr-group-mode:focus-visible,
      .dawn-tlr-group-mode.is-active,
      .dawn-tlr-header:hover .dawn-tlr-tm-toggle,
      .dawn-tlr-header:focus-within .dawn-tlr-tm-toggle,
      .dawn-tlr-tm-toggle:focus-visible,
      .dawn-tlr-header:hover .dawn-tlr-filter-toggle,
      .dawn-tlr-header:focus-within .dawn-tlr-filter-toggle,
      .dawn-tlr-filter-toggle:focus-visible,
      .dawn-tlr-filter-toggle.is-active {
        opacity: 1;
      }
      @media (hover: none), (pointer: coarse) {
        .dawn-tlr-group-mode,
        .dawn-tlr-tm-toggle,
        .dawn-tlr-filter-toggle { opacity: 0.6; }
      }
      .dawn-tlr-group-mode:hover,
      .dawn-tlr-tm-toggle:hover,
      .dawn-tlr-filter-toggle:hover {
        color: inherit;
        background: rgba(255,255,255,0.06);
      }
      .dawn-tlr-group-mode.is-active,
      .dawn-tlr-filter-toggle.is-active {
        background: var(--button-minimal-bg-active-color, rgba(255,255,255,0.1));
        border-color: var(--divider-color, rgba(255,255,255,0.12));
        color: inherit;
      }
      .dawn-tlr-tm-toggle.is-disabled,
      .dawn-tlr-tm-toggle[hidden] {
        display: none !important;
      }
      .dawn-tlr-tm-toggle.is-active {
        opacity: 1;
        background: var(--button-minimal-bg-active-color, rgba(255,255,255,0.1));
        border-color: var(--divider-color, rgba(255,255,255,0.12));
        color: inherit;
      }
      .dawn-tlr-tm-slot { display: block; }
      .dawn-tlr-tm-slot[hidden],
      .dawn-tlr-footer.is-collapsed .dawn-tlr-tm-slot { display: none !important; }
      .dawn-tlr-tm-section {
        margin: 10px 0 4px;
        padding-top: 10px;
        border-top: 1px solid var(--divider-color, rgba(255,255,255,0.08));
      }
      .dawn-tlr-tm-head {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-bottom: 8px;
        color: var(--text-muted, #8a7e6a);
      }
      .dawn-tlr-tm-icon { display: inline-flex; width: 16px; height: 16px; opacity: 0.85; }
      .dawn-tlr-tm-icon .ti { font-size: 15px; }
      .dawn-tlr-tm-title {
        flex: 1;
        font-size: 12px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
      }
      .dawn-tlr-tm-year-head {
        margin: 12px 0 6px;
        padding-bottom: 4px;
        border-bottom: 1px solid var(--divider-color, rgba(255,255,255,0.08));
        font-size: 11px;
        font-weight: 700;
        letter-spacing: 0.08em;
        text-transform: uppercase;
        opacity: 0.85;
      }
      .dawn-tlr-tm-year-head:first-child { margin-top: 0; }
      .dawn-tlr-tm-subcoll {
        margin: 8px 0 4px;
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: var(--text-muted, #8a7e6a);
      }
      .dawn-tlr-tm-settings-overlay {
        position: fixed;
        inset: 0;
        z-index: 99999;
        display: flex;
        align-items: center;
        justify-content: center;
        background: rgba(0, 0, 0, 0.45);
      }
      .dawn-tlr-tm-settings-panel {
        width: min(560px, 92vw);
        max-height: min(80vh, 720px);
        overflow: auto;
        padding: 18px 18px 14px;
        border-radius: 12px;
        background: var(--cmdpal-bg-color, var(--panel-bg-color, #1d1915));
        color: inherit;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.12));
        box-shadow: 0 16px 40px rgba(0, 0, 0, 0.35);
        display: flex;
        flex-direction: column;
        gap: 10px;
      }
      .dawn-tlr-tm-settings-panel h3 { margin: 0; font-size: 16px; }
      .dawn-tlr-tm-settings-help {
        margin: 0;
        font-size: 12px;
        color: var(--text-muted, #8a7e6a);
        line-height: 1.4;
      }
      .dawn-tlr-tm-settings-row {
        display: flex;
        align-items: center;
        gap: 8px;
        font-size: 13px;
        cursor: pointer;
      }
      .dawn-tlr-tm-settings-input,
      .dawn-tlr-tm-filter-row input,
      .dawn-tlr-tm-filter-row select {
        width: 100%;
        padding: 7px 10px;
        border-radius: 6px;
        font-size: 12px;
        background: transparent;
        color: inherit;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.14));
      }
      .dawn-tlr-tm-filters { display: flex; flex-direction: column; gap: 8px; }
      .dawn-tlr-tm-filter-row {
        display: flex;
        flex-wrap: wrap;
        gap: 8px;
        align-items: center;
      }
      .dawn-tlr-tm-filter-row input,
      .dawn-tlr-tm-filter-row select { width: auto; flex: 1; min-width: 90px; }
      .dawn-tlr-tm-settings-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
        margin-top: 8px;
      }
      .dawn-tlr-tm-settings-actions button,
      .dawn-tlr-tm-settings-secondary {
        padding: 8px 12px;
        border-radius: 8px;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.14));
        background: transparent;
        color: inherit;
        cursor: pointer;
        font-size: 13px;
      }
      .dawn-tlr-tm-settings-primary {
        background: var(--ed-link-color, var(--link-color, #6aa7ff)) !important;
        border-color: transparent !important;
        color: #fff !important;
        font-weight: 700;
      }
      .dawn-tlr-group-mode .ti,
      .dawn-tlr-tm-toggle .ti,
      .dawn-tlr-filter-toggle .ti { font-size: 15px; line-height: 1; }
      .dawn-tlr-sort-menu-state {
        font-size: 11px;
        color: #8a7e6a;
        padding: 4px 8px 6px;
        line-height: 1.35;
      }
      .dawn-tlr-popup-menu-sep {
        height: 1px;
        margin: 4px 6px;
        background: rgba(255,255,255,0.08);
      }
      .dawn-tlr-unlinked-pill {
        appearance: none;
        display: inline-flex;
        align-items: center;
        gap: 8px;
        margin: 14px 0 2px 2px;
        padding: 4px 10px;
        min-height: 28px;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
        border-radius: 999px;
        background: rgba(255,255,255,0.04);
        color: var(--text-muted, #8a7e6a);
        font: inherit;
        font-size: 12px;
        font-weight: 600;
        cursor: pointer;
      }
      .dawn-tlr-unlinked-pill:hover {
        color: inherit;
        background: rgba(255,255,255,0.07);
      }
      .dawn-tlr-unlinked-pill[aria-expanded="true"] {
        color: inherit;
      }
      .dawn-tlr-unlinked-pill-caret { font-size: 12px; opacity: 0.8; }
      .dawn-tlr-unlinked-results { margin-top: 10px; }
      .dawn-tlr-line-row {
        display: flex;
        align-items: flex-start;
        gap: 4px;
      }
      .dawn-tlr-line-row .dawn-tlr-line { flex: 1 1 auto; min-width: 0; text-align: left; }
      .dawn-tlr-unlinked-link-btn {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-muted, #8a7e6a);
        cursor: pointer;
        width: 26px;
        height: 24px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        opacity: 0.55;
        flex: 0 0 auto;
      }
      .dawn-tlr-unlinked-link-btn:hover {
        opacity: 1;
        color: inherit;
        background: rgba(255,255,255,0.06);
      }
      .dawn-tlr-unlinked-link-btn .ti { font-size: 14px; line-height: 1; }
      .dawn-tlr-unlinked-link-btn.is-busy { opacity: 0.4; pointer-events: none; }
      .dawn-tlr-hover-action {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-muted, rgba(200,190,170,0.75));
        cursor: pointer;
        width: 26px;
        height: 24px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.12s, color 0.12s, background 0.12s;
        border-radius: 6px;
        border: 1px solid transparent;
        line-height: 0;
      }
      .dawn-tlr-hover-action .ti { font-size: 15px; line-height: 1; }
      .dawn-tlr-header:hover .dawn-tlr-hover-action,
      .dawn-tlr-header:focus-within .dawn-tlr-hover-action,
      .dawn-tlr-hover-action:focus-visible,
      .dawn-tlr-hover-action.is-active { opacity: 1; }
      .dawn-tlr-hover-action:hover { color: inherit; background: rgba(255,255,255,0.06); }
      .dawn-tlr-hover-action.is-active {
        background: var(--button-minimal-bg-active-color, rgba(255,255,255,0.1));
        border-color: var(--divider-color, rgba(255,255,255,0.12));
        color: inherit;
      }
      @media (hover: none), (pointer: coarse) {
        .dawn-tlr-hover-action { opacity: 0.6; }
      }
      .dawn-tlr-sort-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
      }
      .dawn-tlr-sort-toggle {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-muted, rgba(200,190,170,0.75));
        cursor: pointer;
        width: 26px;
        height: 24px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        opacity: 0;
        transition: opacity 0.12s, color 0.12s, background 0.12s;
        border-radius: 6px;
        line-height: 0;
      }
      .dawn-tlr-header:hover .dawn-tlr-sort-toggle,
      .dawn-tlr-header:focus-within .dawn-tlr-sort-toggle,
      .dawn-tlr-sort-toggle:focus-visible,
      .dawn-tlr-footer.is-sort-open .dawn-tlr-sort-toggle,
      .dawn-tlr-sort-toggle.is-active { opacity: 1; }
      .dawn-tlr-sort-toggle:hover { color: inherit; background: rgba(255,255,255,0.06); }
      @media (hover: none), (pointer: coarse) {
        .dawn-tlr-sort-toggle { opacity: 0.6; }
      }
      .dawn-tlr-sort-glyph {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        width: 14px;
        height: 12px;
        color: inherit;
      }
      .dawn-tlr-sort-glyph-bars {
        position: relative;
        width: 8px;
        height: 10px;
      }
      .dawn-tlr-sort-glyph-bars::before {
        content: '';
        position: absolute;
        top: 0; left: 0;
        width: 8px; height: 2px;
        background: currentColor;
        box-shadow: 0 4px 0 currentColor, 0 8px 0 currentColor;
        opacity: 0.9;
      }
      .dawn-tlr-sort-glyph-arrows {
        position: relative;
        width: 4px;
        height: 10px;
      }
      .dawn-tlr-sort-glyph-arrows::before {
        content: '';
        position: absolute;
        top: 0; left: 0;
        border-left: 2px solid transparent;
        border-right: 2px solid transparent;
        border-bottom: 3px solid currentColor;
        opacity: 0.95;
      }
      .dawn-tlr-sort-glyph-arrows::after {
        content: '';
        position: absolute;
        bottom: 0; left: 0;
        border-left: 2px solid transparent;
        border-right: 2px solid transparent;
        border-top: 3px solid currentColor;
        opacity: 0.95;
      }
      .dawn-tlr-sort-menu {
        display: none;
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        left: auto;
        width: max-content;
        min-width: 240px;
        max-width: min(90vw, 340px);
        z-index: 140;
        padding: 6px;
        border-radius: 10px;
        background: var(--cmdpal-bg-color, var(--panel-bg-color, #1d1915));
        border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
        box-shadow: 0 8px 32px rgba(0,0,0,0.45);
        flex-direction: column;
        gap: 2px;
      }
      .dawn-tlr-footer.is-sort-open .dawn-tlr-sort-menu { display: flex; }
      .dawn-tlr-popup-menu {
        position: fixed;
        left: 0;
        top: 0;
        right: auto;
        width: max-content;
        min-width: 200px;
        max-width: min(90vw, 320px);
        z-index: 100060;
        padding: 5px;
        border-radius: 10px;
        background: var(--cmdpal-bg-color, var(--panel-bg-color, #1d1915));
        border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
        box-shadow: 0 8px 32px rgba(0,0,0,0.45);
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .dawn-tlr-popup-menu-item {
        appearance: none;
        display: block;
        width: 100%;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 13px;
        padding: 7px 10px;
        border-radius: 7px;
        cursor: pointer;
        text-align: left;
      }
      .dawn-tlr-popup-menu-item:hover { background: rgba(255,255,255,0.06); }
      .dawn-tlr-sort-menu-label {
        font-size: 10px;
        font-weight: 700;
        letter-spacing: 0.06em;
        text-transform: uppercase;
        color: #8a7e6a;
        padding: 4px 8px 2px;
      }
      .dawn-tlr-sort-menu-item {
        appearance: none;
        display: flex;
        align-items: center;
        gap: 8px;
        width: 100%;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 13px;
        padding: 7px 8px;
        border-radius: 7px;
        cursor: pointer;
        text-align: left;
      }
      .dawn-tlr-sort-menu-item:hover { background: rgba(255,255,255,0.06); }
      .dawn-tlr-sort-menu-item.is-active { background: rgba(255,255,255,0.08); }
      .dawn-tlr-sort-menu-check {
        width: 14px;
        text-align: center;
        opacity: 0.85;
        font-size: 12px;
      }
      .dawn-tlr-sort-menu-sep {
        height: 1px;
        margin: 4px 6px;
        background: rgba(255,255,255,0.08);
      }
      .dawn-tlr-bucket-label {
        font-size: 11.5px;
        font-weight: 700;
        letter-spacing: 0.04em;
        text-transform: uppercase;
        color: #8a7e6a;
        margin: 12px 0 4px 2px;
      }
      .dawn-tlr-bucket-label:first-child { margin-top: 2px; }
      /* Same pill chrome as Find unlinked mentions */
      .dawn-tlr-show-more.dawn-tlr-unlinked-pill {
        width: auto;
        max-width: 100%;
        margin: 12px 0 2px 2px;
        justify-content: flex-start;
      }
      .dawn-tlr-show-more:focus-visible {
        outline: 2px solid rgba(120,160,255,0.55);
        outline-offset: 1px;
      }
      .dawn-tlr-settings-cog.is-active {
        opacity: 1;
        background: rgba(255,255,255,0.1);
      }
      .dawn-tlr-excl-overlay {
        position: fixed;
        inset: 0;
        z-index: 100050;
        background: rgba(0,0,0,0.45);
        display: flex;
        align-items: center;
        justify-content: center;
        padding: 16px;
      }
      .dawn-tlr-excl-panel {
        display: flex;
        flex-direction: column;
        width: min(420px, 94vw);
        max-height: min(80vh, 640px);
        overflow: hidden;
        border-radius: 12px;
        padding: 16px 16px 12px;
        background: var(--cmdpal-bg-color, var(--panel-bg-color, #1d1915));
        border: 1px solid var(--divider-color, rgba(255,255,255,0.12));
        box-shadow: 0 12px 40px rgba(0,0,0,0.5);
        color: inherit;
        font: 13px/1.4 ui-sans-serif, system-ui, sans-serif;
      }
      .dawn-tlr-excl-panel h3 {
        margin: 0 0 6px;
        font-size: 15px;
        font-weight: 650;
      }
      .dawn-tlr-excl-help {
        margin: 0 0 10px;
        font-size: 12px;
        color: #8a7e6a;
        flex: 0 0 auto;
      }
      .dawn-tlr-excl-hide-native {
        margin: 0 0 10px;
        flex: 0 0 auto;
        padding: 2px 0;
      }
      .dawn-tlr-excl-filter-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0 0 8px;
        flex: 0 0 auto;
      }
      .dawn-tlr-excl-filter {
        flex: 1;
        min-width: 0;
      }
      .dawn-tlr-excl-bulk {
        display: flex;
        gap: 4px;
        flex: 0 0 auto;
      }
      .dawn-tlr-excl-bulk-btn {
        appearance: none;
        border: 0;
        background: transparent;
        color: var(--text-muted, #8a7e6a);
        font: 12px/1.2 ui-sans-serif, system-ui, sans-serif;
        padding: 4px 6px;
        cursor: pointer;
        border-radius: 4px;
      }
      .dawn-tlr-excl-bulk-btn:hover {
        background: rgba(255,255,255,0.08);
        color: inherit;
      }
      .dawn-tlr-excl-list {
        flex: 1 1 auto;
        min-height: 120px;
        max-height: min(52vh, 380px);
        overflow-y: auto;
        overflow-x: hidden;
        margin: 0 0 10px;
        padding: 2px 2px 4px 0;
      }
      .dawn-tlr-excl-items {
        display: flex;
        flex-direction: column;
        gap: 1px;
      }
      .dawn-tlr-excl-row {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
        padding: 3px 6px;
        border-radius: 4px;
        cursor: pointer;
        font-size: 12.5px;
        line-height: 1.25;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dawn-tlr-excl-row:hover {
        background: var(--button-normal-hover-color, var(--bg-hover, rgba(255,255,255,0.06)));
      }
      .dawn-tlr-excl-actions {
        display: flex;
        justify-content: flex-end;
        gap: 8px;
      }
      .dawn-tlr-excl-actions button {
        appearance: none;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.14));
        background: rgba(255,255,255,0.06);
        color: inherit;
        border-radius: 8px;
        padding: 6px 12px;
        font: inherit;
        cursor: pointer;
      }
      .dawn-tlr-excl-actions button:disabled {
        opacity: 0.45;
        cursor: default;
      }
      .dawn-tlr-excl-actions button.primary {
        background: rgba(232,224,208,0.14);
      }
      .dawn-tlr-search-row {
        display: none;
        margin: 2px 0 6px 10px;
        padding: 0 0 0 4px;
      }
      .dawn-tlr-footer.is-search-open .dawn-tlr-search-row { display: block; }
      .dawn-tlr-footer.is-collapsed .dawn-tlr-search-row { display: none; }
      .dawn-tlr-search-wrap {
        position: relative;
        display: flex;
        align-items: center;
        gap: 4px;
        max-width: 100%;
      }
      .dawn-tlr-search-ac {
        display: none;
        position: absolute;
        top: calc(100% + 4px);
        left: 0;
        right: 28px;
        z-index: 150;
        max-height: 220px;
        overflow: auto;
        padding: 4px;
        border-radius: 10px;
        background: var(--cmdpal-bg-color, var(--panel-bg-color, #1d1915));
        border: 1px solid var(--divider-color, rgba(255,255,255,0.1));
        box-shadow: 0 8px 28px rgba(0,0,0,0.45);
        flex-direction: column;
        gap: 1px;
      }
      .dawn-tlr-search-ac.is-open { display: flex; }
      .dawn-tlr-search-ac-item {
        appearance: none;
        display: flex;
        align-items: baseline;
        justify-content: space-between;
        gap: 10px;
        width: 100%;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        font-size: 12.5px;
        padding: 6px 8px;
        border-radius: 7px;
        cursor: pointer;
        text-align: left;
      }
      .dawn-tlr-search-ac-item:hover,
      .dawn-tlr-search-ac-item.is-active { background: rgba(255,255,255,0.08); }
      .dawn-tlr-search-ac-label { font-weight: 550; }
      .dawn-tlr-search-ac-detail {
        font-size: 11px;
        color: #8a7e6a;
        white-space: nowrap;
      }
      .dawn-tlr-query-status {
        font-size: 11px;
        color: #8a7e6a;
        padding: 0 0 6px 2px;
      }
      .dawn-tlr-search-mark {
        background: rgba(232, 200, 120, 0.28);
        color: inherit;
        border-radius: 2px;
        padding: 0 1px;
      }
      .dawn-tlr-search-input {
        flex: 1 1 auto;
        min-width: 0;
        appearance: none;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.12));
        background: var(--bg-secondary, rgba(127,127,127,0.1));
        color: inherit;
        font: inherit;
        font-size: 13px;
        border-radius: 8px;
        padding: 6px 10px;
        outline: none;
      }
      .dawn-tlr-search-input:focus {
        border-color: rgba(255,255,255,0.22);
      }
      .dawn-tlr-search-clear {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-muted, rgba(200,190,170,0.75));
        cursor: pointer;
        width: 24px;
        height: 24px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        flex: 0 0 auto;
      }
      .dawn-tlr-search-clear:hover { color: inherit; background: rgba(255,255,255,0.06); }
      .dawn-tlr-search-clear .ti { font-size: 14px; }
      .dawn-tlr-search-refresh {
        appearance: none;
        border: none;
        background: transparent;
        color: var(--text-muted, rgba(200,190,170,0.75));
        cursor: pointer;
        width: 24px;
        height: 24px;
        padding: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        border-radius: 6px;
        flex: 0 0 auto;
      }
      .dawn-tlr-search-refresh:hover { color: inherit; background: rgba(255,255,255,0.06); }
      .dawn-tlr-search-refresh .ti { font-size: 14px; }
      .dawn-tlr-pill {
        appearance: none;
        display: inline-flex !important;
        align-items: center;
        gap: 8px;
        max-width: 100%;
        padding: 4px 12px 4px 8px !important;
        min-height: 28px;
        border-radius: 999px !important;
        background: var(--button-minimal-bg-color, var(--bg-secondary, rgba(127,127,127,0.14))) !important;
        border: 1px solid var(--divider-color, rgba(255,255,255,0.08)) !important;
        color: inherit;
        cursor: pointer;
        font: inherit;
      }
      .dawn-tlr-title-icon {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        opacity: 0.9;
        color: var(--text-muted, rgba(200,190,170,0.85));
        line-height: 0;
      }
      .dawn-tlr-title-icon svg { display: block; }
      .dawn-tlr-pill-label {
        flex: 0 1 auto;
        font-size: 13px;
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dawn-tlr-footer.is-collapsed .dawn-tlr-pill-label,
      .dawn-tlr-footer.is-collapsed .dawn-tlr-toggle-caret {
        display: none;
      }
      .dawn-tlr-footer.is-collapsed .dawn-tlr-header-controls {
        display: none;
      }
      .dawn-tlr-footer.is-collapsed .dawn-tlr-pill {
        padding: 4px 8px !important;
        gap: 6px;
      }
      .dawn-tlr-count {
        flex: 0 0 auto;
        font-size: 12px;
        font-weight: 500;
        color: var(--text-muted, rgba(200,190,170,0.72));
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }
      .dawn-tlr-count:empty { display: none; }
      .dawn-tlr-toggle-caret {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        opacity: 0.85;
        color: var(--text-muted, rgba(200,190,170,0.75));
        font-size: 14px;
        line-height: 1;
      }
      .dawn-tlr-body {
        border-left: 1px solid rgba(255,255,255,0.08);
        margin: 4px 0 4px 10px;
        padding: 6px 0 4px 14px;
      }
      .dawn-tlr-footer.is-collapsed .dawn-tlr-body { display: none; }
      .dawn-tlr-group { margin: 0; }
      .dawn-tlr-group-row {
        display: flex;
        align-items: center;
        gap: 2px;
        padding: 5px 8px 5px 0;
        border-radius: 8px;
      }
      .dawn-tlr-group-row:hover {
        background: rgba(255,255,255,0.05);
      }
      .dawn-tlr-panel-nav-actions {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        flex: 0 0 auto;
        opacity: 0;
        transition: opacity 120ms ease;
      }
      .dawn-tlr-group-row:hover .dawn-tlr-panel-nav-actions,
      .dawn-tlr-group-row:focus-within .dawn-tlr-panel-nav-actions,
      .dawn-tlr-line-row:hover .dawn-tlr-panel-nav-actions,
      .dawn-tlr-line-row:focus-within .dawn-tlr-panel-nav-actions {
        opacity: 1;
      }
      @media (hover: none), (pointer: coarse) {
        .dawn-tlr-panel-nav-actions { opacity: 0.75; }
      }
      .dawn-tlr-panel-nav-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 22px;
        height: 22px;
        padding: 0;
        border-radius: 5px;
        color: var(--text-muted, rgba(200,190,170,0.75));
        line-height: 1;
      }
      .dawn-tlr-panel-nav-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
      }
      .dawn-tlr-panel-nav-icon svg {
        display: block;
        width: 14px;
        height: 14px;
      }
      .dawn-tlr-panel-nav-btn:hover {
        color: inherit;
        background: rgba(255,255,255,0.08);
      }
      .dawn-tlr-expand-btn {
        appearance: none;
        flex: 0 0 auto;
        width: 16px;
        height: 16px;
        padding: 0;
        border: none;
        background: transparent;
        color: var(--text-muted, rgba(200,190,170,0.75));
        cursor: pointer;
        opacity: 0;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        transition: opacity 0.12s;
      }
      .dawn-tlr-expand-btn .ti { font-size: 12px; line-height: 1; }
      .dawn-tlr-group-row:hover .dawn-tlr-expand-btn,
      .dawn-tlr-expand-btn:focus-visible,
      .dawn-tlr-expand-btn.is-expanded { opacity: 1; }
      @media (hover: none), (pointer: coarse) {
        .dawn-tlr-expand-btn { opacity: 0.65; }
      }
      .dawn-tlr-group-header {
        appearance: none;
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        justify-content: space-between;
        align-items: baseline;
        gap: 14px;
        padding: 0;
        border: none;
        background: transparent;
        color: inherit;
        font: inherit;
        cursor: pointer;
        text-align: left;
      }
      .dawn-tlr-group-title {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: baseline;
        gap: 0;
        white-space: nowrap;
        overflow: hidden;
        font-size: 15px;
        font-weight: 600;
        line-height: 1.7;
      }
      .dawn-tlr-icon-slot {
        flex: 0 0 auto;
        width: 20px;
        display: inline-flex;
        justify-content: flex-start;
        align-items: center;
        opacity: 0.7;
      }
      .dawn-tlr-icon-slot .ti { font-size: 14px; }
      .dawn-tlr-group-title-text {
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }
      .dawn-tlr-row-meta {
        flex: 0 1 auto;
        min-width: 0;
        font-size: 12.5px;
        font-weight: 400;
        color: var(--text-muted, rgba(200,190,170,0.72));
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
      }
      .dawn-tlr-lines {
        margin-top: 0;
        margin-left: 22px;
        padding-left: 8px;
        display: flex;
        flex-direction: column;
        gap: 2px;
      }
      .dawn-tlr-line {
        appearance: none;
        display: block;
        width: 100%;
        text-align: left;
        border: none;
        background: transparent;
        color: var(--text-muted, rgba(200,190,170,0.78));
        font-size: 13.5px;
        line-height: 1.5;
        padding: 2px 0;
        cursor: pointer;
        border-radius: 4px;
      }
      .dawn-tlr-line:hover {
        color: inherit;
        background: rgba(255,255,255,0.04);
      }
      .dawn-tlr-record-preview {
        display: none;
        flex-direction: column;
        margin: 2px 0 10px 22px;
        padding: 2px 0 2px 2px;
        gap: 0;
        font-family: var(--dawn-tlr-editor-font);
        font-size: var(--dawn-tlr-editor-size);
        line-height: 1.6;
        color: var(--dawn-tlr-text-default);
      }
      .dawn-tlr-group.is-expanded .dawn-tlr-record-preview { display: flex; }
      .dawn-tlr-preview-node { display: flex; flex-direction: column; }
      .dawn-tlr-preview-row {
        display: flex;
        align-items: flex-start;
        gap: 1px;
      }
      .dawn-tlr-preview-toggle {
        width: 14px; min-width: 14px;
        height: calc(var(--dawn-tlr-editor-size) * 1.6);
        display: flex; align-items: center; justify-content: center;
        flex-shrink: 0; padding: 0; border: none; background: transparent;
        color: var(--dawn-tlr-text-muted);
        opacity: 0; cursor: pointer;
        transition: opacity 0.12s ease;
      }
      .dawn-tlr-preview-node:hover > .dawn-tlr-preview-row > .dawn-tlr-preview-toggle,
      .dawn-tlr-preview-toggle.is-open,
      .dawn-tlr-preview-row:hover > .dawn-tlr-preview-toggle,
      .dawn-tlr-preview-toggle:has(.dawn-tlr-preview-arrow.is-collapsed) { opacity: 0.75; }
      .dawn-tlr-preview-arrow {
        display: block; width: 0; height: 0;
        border-left: 4px solid transparent; border-right: 4px solid transparent;
        border-top: 5px solid currentColor;
        transition: transform 0.12s ease;
      }
      .dawn-tlr-preview-arrow.is-collapsed { transform: rotate(-90deg); opacity: 1; }
      .dawn-tlr-preview-marker {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 14px;
        height: calc(var(--dawn-tlr-editor-size) * 1.6);
        color: var(--dawn-tlr-text-muted);
        font-size: 1.08em;
        line-height: 1;
        user-select: none;
      }
      .dawn-tlr-preview-marker-ordinal {
        justify-content: flex-end;
        padding-right: 2px;
        font-variant-numeric: tabular-nums;
      }
      .dawn-tlr-preview-marker-ulist { font-size: 1.3em; }
      .dawn-tlr-preview-marker-checkbox {
        width: 13px; min-width: 13px; height: 13px;
        margin-top: calc((var(--dawn-tlr-editor-size) * 1.6 - 13px) / 2);
        border: 1px solid var(--dawn-tlr-border-color); border-radius: 3px;
        font-size: 10px; line-height: 1;
      }
      .dawn-tlr-preview-marker-checkbox.is-done {
        color: var(--ed-link-color, var(--link-color, var(--accent, inherit)));
        border-color: currentColor;
      }
      .dawn-tlr-preview-row-task .dawn-tlr-expand-line,
      .dawn-tlr-preview-row-ulist .dawn-tlr-expand-line,
      .dawn-tlr-preview-row-olist .dawn-tlr-expand-line {
        padding-left: 4px;
      }
      .dawn-tlr-preview-row-heading .dawn-tlr-expand-line {
        font-weight: 600;
        font-size: calc(var(--dawn-tlr-editor-size) * 1.12);
        padding-top: 4px;
      }
      .dawn-tlr-preview-row-quote .dawn-tlr-expand-line {
        border-left: 2px solid var(--dawn-tlr-border-color);
        padding-left: 8px;
        font-style: italic;
        color: var(--dawn-tlr-text-muted);
      }
      .dawn-tlr-preview-row-ref > .dawn-tlr-expand-line,
      .dawn-tlr-preview-row-transclusion > .dawn-tlr-expand-line {
        color: var(--ed-link-color, var(--link-color, var(--accent, var(--dawn-tlr-text-default))));
        font-weight: 500;
      }
      .dawn-tlr-expand-line {
        appearance: none; flex: 1 1 auto; min-width: 0;
        display: block; width: 100%; text-align: left;
        border: none; background: transparent;
        color: var(--dawn-tlr-text-default);
        font-family: var(--dawn-tlr-editor-font);
        font-size: var(--dawn-tlr-editor-size);
        line-height: 1.6;
        padding: 1px 6px 1px 2px; border-radius: 4px; cursor: pointer;
        white-space: pre-wrap; word-break: break-word;
        transition: background 0.1s, color 0.1s;
      }
      .dawn-tlr-expand-line:hover { background: var(--dawn-tlr-hover-bg); }
      .dawn-tlr-preview-link-pill {
        display: inline-flex !important;
        width: auto !important;
        max-width: 100%;
        align-items: center;
        gap: 4px;
        margin: 1px 0;
        padding: 3px 10px 3px 8px !important;
        border-radius: 8px;
        background: color-mix(in srgb, var(--dawn-tlr-selected-bg) 70%, var(--dawn-tlr-text-default) 14%);
        border: 1px solid color-mix(in srgb, var(--dawn-tlr-border-color) 70%, transparent);
      }
      .dawn-tlr-preview-transclusion-title { font-weight: 600; }
      .dawn-tlr-preview-reference-glyph {
        display: inline-block;
        margin-left: 5px;
        color: currentColor;
        font-size: 0.82em;
        opacity: 0.72;
        transform: translateY(-0.08em);
      }
      .dawn-tlr-preview-embed-note {
        color: var(--dawn-tlr-text-muted);
        font-style: italic;
      }
      .dawn-tlr-preview-children-holder { display: flex; flex-direction: column; }
      .dawn-tlr-preview-children-holder.is-hidden { display: none; }
      .dawn-tlr-preview-children {
        display: flex; flex-direction: column;
        margin-left: 7px;
        padding-left: 14px;
        border-left: 1px solid var(--dawn-tlr-border-color);
      }
      /* Note blocks render as a soft container in the editor; approximate it here. */
      .dawn-tlr-preview-node[data-line-type="block"] > .dawn-tlr-preview-children-holder > .dawn-tlr-preview-children {
        margin: 2px 0 4px 7px;
        padding: 4px 10px;
        border: 1px solid var(--dawn-tlr-border-color);
        border-radius: 8px;
        background: color-mix(in srgb, var(--dawn-tlr-selected-bg) 70%, #000 18%);
      }
      .dawn-tlr-preview-transcluded {
        margin-top: 1px;
        margin-bottom: 3px;
        padding-top: 4px;
        padding-bottom: 4px;
        border-left: 1px solid var(--dawn-tlr-border-color) !important;
        border-radius: 0 8px 8px 0;
        background: color-mix(in srgb, var(--dawn-tlr-selected-bg) 65%, #000 22%);
      }
      .dawn-tlr-empty {
        opacity: .65;
        padding: 4px 0;
        font-size: 12px;
        font-style: italic;
        color: var(--text-muted, inherit);
      }
    `;
    document.documentElement.appendChild(el);
    this._styleEl = el;
    this._cssInjected = true;
  }

  _findContainer(panelEl) {
    if (!panelEl) return null;
    let last = null;
    for (const sel of ['.page-content', '.editor-wrapper', '.editor-panel', '#editor']) {
      const nodes = panelEl.querySelectorAll?.(sel);
      if (nodes?.length) last = nodes[nodes.length - 1];
    }
    return last || panelEl;
  }

  _mountFooterInContainer(container, root) {
    if (!container || !root) return;
    const hi =
      container.querySelector('[data-dawn-readwise="highlights"]') ||
      container.querySelector('.dawn-th-footer--highlights');
    if (hi) {
      if (root.nextElementSibling !== hi) container.insertBefore(root, hi);
      return;
    }
    if (root.parentElement !== container) container.appendChild(root);
  }

  _isJournal(record) {
    try {
      if (record?.getJournalDetails?.()?.date) return true;
    } catch (_) {}
    try {
      const g = String(record?.guid || '');
      return /(?:^|[-_:])\d{8}$/.test(g);
    } catch (_) {}
    return false;
  }

  _dayKey(record) {
    try {
      const d = record?.getJournalDetails?.()?.date;
      if (d instanceof Date && !isNaN(d.getTime())) {
        return (
          d.getFullYear() +
          '-' +
          String(d.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(d.getDate()).padStart(2, '0')
        );
      }
      if (typeof d === 'string') {
        const m = d.match(/(\d{4}-\d{2}-\d{2})/);
        if (m) return m[1];
      }
    } catch (_) {}
    try {
      const m = String(record?.guid || '').match(/(\d{8})$/);
      if (m) {
        const s = m[1];
        return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
      }
    } catch (_) {}
    return null;
  }

  _recordGuid(record) {
    try {
      return record?.guid || record?.getGuid?.() || null;
    } catch (_) {
      return null;
    }
  }

  _cacheFresh(entry) {
    if (!entry) return false;
    return Date.now() - (entry.builtAt || 0) < CACHE_TTL_MS;
  }

  _handlePanel(panel, opts) {
    const forceLoad = !!(opts && opts.forceLoad);
    const panelId = panel?.getId?.();
    if (!panelId) return;
    const record = panel?.getActiveRecord?.();
    const recordGuid = this._recordGuid(record);
    // Prod Backlinks+ mounts on every record. Journal-only was a Dawn gate
    // that hid the footer on notes. Time Machine still needs a day key.
    if (!record || !recordGuid) {
      this._dispose(panelId);
      return;
    }
    const dayKey = this._dayKey(record) || '';
    let state = this._panelStates.get(panelId);
    if (!state) {
      state = { panelId };
      this._panelStates.set(panelId, state);
    }
    const recordChanged = state.recordGuid && state.recordGuid !== recordGuid;
    const dayChanged = state.dayKey && state.dayKey !== dayKey;
    state.panel = panel;
    state.record = record;
    state.dayKey = dayKey;
    state.recordGuid = recordGuid;
    state.collapseScope = this._collapseScopeKey(record, panel);
    if (recordChanged || state.linkedShowLimit == null) {
      this._resetShowLimits(state);
    }
    if (dayChanged || recordChanged) {
      this._resetTimeMachineState(state);
      // Keep collapsed default per collection; drop in-flight results for old day.
      if (state.recordGuid && this._unlinkedByGuid[state.recordGuid]?.loading) {
        /* leave loading flag; gen will discard */
      }
    }

    const container = this._findContainer(panel?.getElement?.());
    if (!container) return;

    // Do NOT call __dawnJhsShell.sync here — JHS has its own nav listener.
    // Double-sync on every flip was thrashing mobile DOM.

    if (!state.root || !state.root.isConnected || !state.countEl) {
      try {
        state.root?.remove?.();
      } catch (_) {}
      const root = document.createElement('div');
      root.className = 'dawn-tlr-footer tlr-footer tlr-footer--native';
      root.setAttribute('data-dawn-backlinks', '1');
      const built = this._buildPillHeader();
      const search = this._buildSearchRow();
      const body = document.createElement('div');
      body.className = 'dawn-tlr-body';
      const tmSlot = document.createElement('div');
      tmSlot.className = 'dawn-tlr-tm-slot tlr-tm-slot';
      tmSlot.setAttribute('data-role', 'time-machine-slot');
      tmSlot.hidden = true;
      root.appendChild(built.header);
      root.appendChild(search.row);
      root.appendChild(body);
      body.appendChild(tmSlot);
      this._mountFooterInContainer(container, root);
      state.root = root;
      state.pillEl = built.pill;
      state.countEl = built.count;
      state.caretEl = built.caret;
      state.filterBtn = built.filterBtn;
      state.settingsBtn = built.settingsBtn;
      state.groupModesEl = built.groupModes;
      state.tmBtn = built.tmBtn;
      state.sortBtn = built.sortBtn;
      state.sortMenuEl = built.sortMenu;
      state.sortWrapEl = built.sortWrap;
      state.searchRowEl = search.row;
      state.searchInputEl = search.input;
      state.acEl = search.ac;
      state.tmSlotEl = tmSlot;
      state.bodyEl = body;
      if (state.timeMachineCollapsed == null) state.timeMachineCollapsed = true;
    } else {
      this._mountFooterInContainer(container, state.root);
    }
    this._ensureTimeMachineSlot(state);

    this._paint(state);

    // Load only when expanded (production gate) — never on collapsed day-flip.
    const collapsed = this._footerCollapsed(state);
    if (!collapsed && (forceLoad || recordChanged || !this._cacheFresh(this._cache[recordGuid]))) {
      this._scheduleLoad(state);
    }
  }

  _scheduleLoad(state) {
    const guid = state.recordGuid;
    if (!guid || this._loadingGuids.has(guid)) return;
    // Debounce + cancel on rapid day-flips (mobile meltdown when footer left open).
    clearTimeout(this._loadTimer);
    const gen = this._navGen;
    this._loadTimer = setTimeout(() => {
      if (gen !== this._navGen) return;
      const boot = globalThis.BootKernel || globalThis.__dawnBoot;
      const run = () => {
        if (gen !== this._navGen) return;
        this._loadRefsForState(state);
      };
      if (boot?.enqueue) {
        boot.enqueue(run, { id: 'dawn-bl:load-' + guid.slice(-12), tier: 'onDemand' });
      } else {
        void run();
      }
    }, 450);
  }

  async _loadRefsForState(state) {
    const guid = state.recordGuid;
    const record = state.record || state.panel?.getActiveRecord?.();
    if (!guid || !record) return;
    if (this._recordGuid(record) !== guid) return;
    if (this._loadingGuids.has(guid)) return;
    this._loadingGuids.add(guid);
    this._paint(state);
    const t0 = performance.now();
    try {
      const refs = await this._fetchBackReferences(record);
      if (this._recordGuid(state.panel?.getActiveRecord?.()) !== guid) return;
      let dateRefs = [];
      try {
        dateRefs = await this._fetchDatePropertyRefs(record, guid);
      } catch (e) {
        console.warn('[Dawn/Backlinks] @date fold-in', e);
      }
      if (this._recordGuid(state.panel?.getActiveRecord?.()) !== guid) return;
      const merged = this._mergeDatePropertyRefs(refs, dateRefs);
      this._cache[guid] = {
        refs: merged,
        builtAt: Date.now(),
        ms: Math.round(performance.now() - t0),
        dateRefs: dateRefs.length,
      };
      this._saveCache();
      console.info(
        '[Dawn/Backlinks] loaded',
        merged.length,
        '(date',
        dateRefs.length + ')',
        'for',
        guid.slice(-12),
        'in',
        this._cache[guid].ms,
        'ms'
      );
    } catch (e) {
      console.warn('[Dawn/Backlinks] load fail', e);
      this._cache[guid] = {
        refs: [],
        builtAt: Date.now(),
        ms: Math.round(performance.now() - t0),
        error: String(e?.message || e),
      };
      this._saveCache();
    } finally {
      this._loadingGuids.delete(guid);
      this._paint(state);
    }
  }

  async _fetchBackReferences(record) {
    const out = [];
    const seenLine = new Set();
    const seenRecord = new Set();

    // Prefer detailed SDK API — keep multiple lines per source record.
    try {
      if (typeof record.getBackReferences === 'function') {
        const detailed = (await record.getBackReferences()) || [];
        for (const ref of detailed) {
          const normalized = this._normalizeRef(ref);
          if (!normalized) continue;
          const lineKey =
            normalized.fromGuid +
            '::' +
            (normalized.lineGuid || normalized.snippet || normalized.kind);
          if (seenLine.has(lineKey)) continue;
          seenLine.add(lineKey);
          seenRecord.add(normalized.fromGuid);
          out.push(normalized);
        }
        if (out.length) return out;
      }
    } catch (e) {
      console.warn('[Dawn/Backlinks] getBackReferences', e);
    }

    try {
      if (typeof record.getBackReferenceRecords === 'function') {
        const records = (await record.getBackReferenceRecords()) || [];
        for (const r of records) {
          let fromGuid = '';
          let title = '';
          let collection = '';
          try {
            fromGuid = r.guid || r.getGuid?.() || '';
            title = r.getName?.() || r.name || fromGuid;
            collection = this._recordCollectionLabel(r);
          } catch (_) {}
          if (!fromGuid || seenRecord.has(fromGuid)) continue;
          seenRecord.add(fromGuid);
          out.push({
            fromGuid,
            title,
            kind: 'record',
            snippet: '',
            lineGuid: '',
            collection,
            whenMs: this._recordWhenMs(r, title, fromGuid),
            editedMs: this._recordEditedMs(r),
          });
        }
      }
    } catch (e) {
      console.warn('[Dawn/Backlinks] getBackReferenceRecords', e);
    }

    return out;
  }

  _normalizeRef(ref) {
    if (!ref) return null;
    try {
      const fromRec = ref.record || ref.sourceRecord || ref.fromRecord || ref.from_document;
      let fromGuid =
        ref.fromGuid ||
        ref.sourceGuid ||
        ref.recordGuid ||
        (typeof fromRec === 'string' ? fromRec : null) ||
        fromRec?.guid ||
        fromRec?.getGuid?.() ||
        ref.from_document?.guid ||
        '';
      let title =
        ref.title ||
        ref.name ||
        fromRec?.getName?.() ||
        fromRec?.name ||
        ref.from_document?.name ||
        '';
      const kind = ref.kind || ref.type || (ref.propertyId ? 'property' : 'line');
      const snippet =
        ref.snippet ||
        ref.text ||
        ref.lineText ||
        this._segmentsToPlainText(ref.from_item?.segments) ||
        (ref.from_item ? this._getLineTextMentionSource(ref.from_item) : '') ||
        ref.sourceLine?.getPlainText?.() ||
        this._getLineTextMentionSource(ref.sourceLine) ||
        '';
      const lineGuid =
        ref.lineGuid ||
        ref.itemGuid ||
        ref.from_item?.guid ||
        ref.sourceLine?.guid ||
        '';
      let collection = '';
      try {
        collection =
          this._recordCollectionLabel(fromRec) ||
          fromRec?.collectionName ||
          ref.collectionName ||
          ref.collection ||
          '';
      } catch (_) {}
      if (!fromGuid) return null;
      if (!title) title = fromGuid.slice(0, 12) + '…';
      const rec = this._asRecord(fromRec && typeof fromRec === 'object' ? fromRec : fromGuid);
      const whenMs = this._recordWhenMs(rec, title, fromGuid);
      const editedMs = this._recordEditedMs(rec);
      return {
        fromGuid,
        title: String(title).slice(0, 160),
        kind: String(kind || 'line'),
        snippet: String(snippet || '').slice(0, 220),
        lineGuid: String(lineGuid || ''),
        collection: String(collection || ''),
        whenMs,
        editedMs,
      };
    } catch (_) {
      return null;
    }
  }

  _groupRefs(refs) {
    const map = new Map();
    for (const h of refs || []) {
      if (!h?.fromGuid) continue;
      let g = map.get(h.fromGuid);
      if (!g) {
        g = {
          fromGuid: h.fromGuid,
          title: h.title || h.fromGuid,
          collection: h.collection || '',
          propertyName: h.propertyName || '',
          whenMs: h.whenMs || 0,
          editedMs: h.editedMs || 0,
          lines: [],
        };
        map.set(h.fromGuid, g);
      }
      if (h.title && (!g.title || g.title === h.fromGuid)) g.title = h.title;
      if (h.collection && !g.collection) g.collection = h.collection;
      if (h.propertyName && !g.propertyName) g.propertyName = h.propertyName;
      if (h.whenMs && (!g.whenMs || h.whenMs > g.whenMs)) g.whenMs = h.whenMs;
      if (h.editedMs && (!g.editedMs || h.editedMs > g.editedMs)) g.editedMs = h.editedMs;
      if (!g.whenMs) {
        try {
          const rec = this._asRecord(h.fromGuid);
          g.whenMs = this._recordWhenMs(rec, g.title, h.fromGuid);
          if (!g.editedMs) g.editedMs = this._recordEditedMs(rec);
        } catch (_) {}
      }
      if (h.snippet && String(h.kind || '') !== 'property') {
        g.lines.push({ text: h.snippet, lineGuid: h.lineGuid || '', kind: h.kind || 'line' });
      }
    }
    return [...map.values()];
  }

  _normalizeDateToIso(value) {
    if (!value) return '';
    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return (
        value.getFullYear() +
        '-' +
        String(value.getMonth() + 1).padStart(2, '0') +
        '-' +
        String(value.getDate()).padStart(2, '0')
      );
    }
    if (typeof value === 'string') {
      const compact = value.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
      if (compact) return compact[1] + '-' + compact[2] + '-' + compact[3];
      const dashed = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (dashed) return dashed[1] + '-' + dashed[2] + '-' + dashed[3];
      return '';
    }
    if (value && typeof value === 'object') {
      const d = value.d || value.date || (value.value && (value.value.d || value.value.date));
      if (typeof d === 'string') return this._normalizeDateToIso(d);
    }
    return '';
  }

  _msFromIso(iso, time) {
    const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(iso || '').trim());
    if (!m) return 0;
    const tm = /^(\d{1,2}):(\d{2})(?::(\d{2}))?/.exec(String(time || '').trim());
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(tm?.[1] || 0),
      Number(tm?.[2] || 0),
      Number(tm?.[3] || 0)
    );
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }

  _timestampFromValue(value) {
    if (!value && value !== 0) return 0;
    if (value instanceof Date) return Number.isFinite(value.getTime()) ? value.getTime() : 0;
    if (typeof value === 'number' && Number.isFinite(value)) {
      if (value > 1e11) return value;
      if (value > 1e9) return value * 1000;
      return 0;
    }
    if (typeof value === 'string') {
      const iso = this._normalizeDateToIso(value);
      if (iso) return this._msFromIso(iso);
      const t = Date.parse(value);
      return Number.isFinite(t) ? t : 0;
    }
    if (Array.isArray(value)) {
      for (const item of value) {
        const ts = this._timestampFromValue(item);
        if (ts) return ts;
      }
      return 0;
    }
    if (typeof value === 'object') {
      const iso = this._normalizeDateToIso(value);
      if (iso) {
        const time = value.t || value.time || value.value?.t || '';
        return this._msFromIso(iso, time);
      }
    }
    return 0;
  }

  _leadingTitleMs(title) {
    const m = /^\s*(\d{4})[.\-/](\d{1,2})[.\-/](\d{1,2})(?:\.?\s+(\d{1,2}):(\d{2}))?/.exec(
      String(title || '')
    );
    if (!m) return 0;
    const d = new Date(
      Number(m[1]),
      Number(m[2]) - 1,
      Number(m[3]),
      Number(m[4] || 0),
      Number(m[5] || 0)
    );
    const ms = d.getTime();
    return Number.isFinite(ms) ? ms : 0;
  }

  _guidDateMs(guid) {
    const m = String(guid || '').match(/(?:^|[-_:])(\d{8})$/);
    if (!m) return 0;
    const s = m[1];
    return this._msFromIso(s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8));
  }

  _asRecord(recOrGuid) {
    if (recOrGuid && typeof recOrGuid === 'object') {
      if (
        typeof recOrGuid.getJournalDetails === 'function' ||
        typeof recOrGuid.prop === 'function' ||
        typeof recOrGuid.getName === 'function'
      ) {
        return recOrGuid;
      }
    }
    const guid =
      typeof recOrGuid === 'string'
        ? recOrGuid
        : recOrGuid?.guid || recOrGuid?.getGuid?.() || '';
    if (!guid) return null;
    try {
      return this.data.getRecord?.(guid) || null;
    } catch (_) {
      return null;
    }
  }

  _recordWhenMs(record, title, guid) {
    if (record) {
      try {
        const ts = this._timestampFromValue(record.getJournalDetails?.()?.date);
        if (ts) return ts;
      } catch (_) {}
      try {
        for (const name of ['When', 'when', 'Date', 'date']) {
          const prop = record.prop?.(name);
          if (!prop) continue;
          const raws = [];
          try {
            if (typeof prop.date === 'function') raws.push(prop.date());
          } catch (_) {}
          try {
            if (typeof prop.get === 'function') raws.push(prop.get());
          } catch (_) {}
          try {
            if (typeof prop.text === 'function') raws.push(prop.text());
          } catch (_) {}
          for (const raw of raws) {
            const ts = this._timestampFromValue(raw);
            if (ts) return ts;
          }
        }
      } catch (_) {}
    }
    const fromTitle = this._leadingTitleMs(title || record?.getName?.() || '');
    if (fromTitle) return fromTitle;
    return this._guidDateMs(guid || record?.guid || record?.getGuid?.());
  }

  _recordEditedMs(record) {
    try {
      return (
        this._timestampFromValue(record?.getUpdatedAt?.()) ||
        this._timestampFromValue(record?.getModifiedDate?.()) ||
        this._timestampFromValue(record?.modified) ||
        0
      );
    } catch (_) {
      return 0;
    }
  }

  _timeBucket(ms) {
    const t = Number(ms) || 0;
    if (!t) return { key: 'No date', order: 9000 };
    const d = new Date(t);
    if (isNaN(d.getTime())) return { key: 'No date', order: 9000 };
    const start = (x) => new Date(x.getFullYear(), x.getMonth(), x.getDate()).getTime();
    const day = start(d);
    const today = start(new Date());
    const dayMs = 86400000;
    if (day > today) return { key: 'Upcoming', order: -1 };
    if (day === today) return { key: 'Today', order: 0 };
    if (day === today - dayMs) return { key: 'Yesterday', order: 1 };
    if (day > today - 7 * dayMs) return { key: 'Last week', order: 2 };
    if (day > today - 31 * dayMs) return { key: 'Last month', order: 3 };
    // Older than ~31d: calendar month headings (not a rolling "Last year" bucket —
    // that labeled most of the current year as "Last year").
    let key = '';
    try {
      key = d.toLocaleDateString(undefined, { month: 'short', year: 'numeric' });
    } catch (_) {
      key = String(d.getMonth() + 1) + '/' + d.getFullYear();
    }
    const now = new Date();
    const monthsAgo =
      now.getFullYear() * 12 + now.getMonth() - (d.getFullYear() * 12 + d.getMonth());
    return { key, order: 100 + Math.max(0, monthsAgo) };
  }

  _matchingDatePropertyNames(record, dateIso) {
    const iso = this._normalizeDateToIso(dateIso);
    if (!record || !iso) return [];
    const preferred = [];
    const other = [];
    let props = [];
    try {
      props = record.getAllProperties?.() || [];
    } catch (_) {
      props = [];
    }
    for (const prop of props) {
      const name = String(prop?.name || '').trim();
      if (!name) continue;
      let dateVal = null;
      try {
        if (typeof prop.date === 'function') dateVal = prop.date();
      } catch (_) {
        dateVal = null;
      }
      if (!(dateVal instanceof Date) || Number.isNaN(dateVal.getTime())) continue;
      if (this._normalizeDateToIso(dateVal) !== iso) continue;
      if (/^(when|date)$/i.test(name)) preferred.push(name);
      else other.push(name);
    }
    return preferred.length ? preferred : other;
  }

  async _fetchDatePropertyRefs(targetRecord, targetGuid) {
    const dateIso = this._dayKey(targetRecord) || this._normalizeDateToIso(
      targetRecord?.getJournalDetails?.()?.date
    );
    if (!dateIso || typeof this.data.searchByQuery !== 'function') return [];
    let result = null;
    try {
      result = await this.data.searchByQuery('@date = "' + dateIso + '"', 200);
    } catch (_) {
      return [];
    }
    if (result?.error) return [];
    const records = Array.isArray(result?.records) ? result.records : [];
    if (!records.length) return [];
    const excl = this._excludedSet();
    const out = [];
    const seen = new Set();
    for (const src of records) {
      const srcGuid = src?.guid || '';
      if (!srcGuid || srcGuid === targetGuid) continue;
      if (this._isJournal(src)) continue;
      if (seen.has(srcGuid)) continue;
      let collection = '';
      let title = '';
      try {
        title = src.getName?.() || src.name || 'Untitled';
        collection = this._recordCollectionLabel(src);
      } catch (_) {}
      const collL = String(collection || '').trim().toLowerCase();
      if (excl.has(collL) || collL === 'journal' || collL === 'journals') continue;
      const propNames = this._matchingDatePropertyNames(src, dateIso);
      const names = propNames.length ? propNames : ['When'];
      seen.add(srcGuid);
      for (const propName of names) {
        out.push({
          fromGuid: srcGuid,
          title: String(title).slice(0, 160),
          kind: 'property',
          snippet: '',
          lineGuid: '',
          collection: String(collection || ''),
          propertyName: propName,
          whenMs: this._recordWhenMs(src, title, srcGuid),
          editedMs: this._recordEditedMs(src),
        });
      }
    }
    return out;
  }

  _mergeDatePropertyRefs(linkRefs, dateRefs) {
    const out = Array.isArray(linkRefs) ? linkRefs.slice() : [];
    const seenLine = new Set(
      out.map((r) => r.fromGuid + '::' + (r.lineGuid || r.snippet || r.kind || ''))
    );
    for (const r of dateRefs || []) {
      const key = r.fromGuid + '::prop:' + (r.propertyName || r.snippet || 'When');
      if (seenLine.has(key)) continue;
      seenLine.add(key);
      out.push(r);
    }
    return out;
  }

  _makeTimeMachineSlot() {
    const tmSlot = document.createElement('div');
    tmSlot.className = 'dawn-tlr-tm-slot tlr-tm-slot';
    tmSlot.setAttribute('data-role', 'time-machine-slot');
    tmSlot.hidden = true;
    return tmSlot;
  }

  _ensureTimeMachineSlot(state) {
    if (!state) return null;
    if (!state.tmSlotEl || state.tmSlotEl.nodeType !== 1) {
      state.tmSlotEl = this._makeTimeMachineSlot();
    }
    return state.tmSlotEl;
  }

  _detachTimeMachineSlot(state) {
    const slot = state?.tmSlotEl;
    if (!slot) return;
    try {
      slot.remove();
    } catch (_) {}
  }

  _placeTimeMachineSlot(state) {
    const slot = this._ensureTimeMachineSlot(state);
    const body = state?.bodyEl;
    if (!slot || !body) return;
    if (slot.parentElement !== body) body.appendChild(slot);
    this._renderTimeMachineSection(state);
  }

  _paint(state) {
    if (!state.root) return;
    const collapsed = this._footerCollapsed(state);
    state.root.classList.toggle('is-collapsed', !!collapsed);
    state.root.classList.toggle('is-search-open', !!this._searchOpen && !collapsed);
    const guid = state.recordGuid;
    const entry = guid ? this._cache[guid] : null;
    const loading = guid && this._loadingGuids.has(guid);
    const refs = entry?.refs || [];

    if (state.pillEl) {
      state.pillEl.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
      state.pillEl.setAttribute('aria-label', collapsed ? 'Expand' : 'Collapse');
    }
    this._syncPillCaret(state.caretEl, collapsed);

    state.root.classList.toggle('is-sort-open', !!this._sortMenuOpen);
    const groupBy = this._groupByForState(state);
    if (state.groupModesEl) {
      for (const mode of ['collection', 'time', 'property']) {
        const btn = state.groupModesEl.querySelector(`[data-group-by="${mode}"]`);
        if (!btn) continue;
        const active = groupBy === mode;
        btn.classList.toggle('is-active', active);
        btn.setAttribute('aria-pressed', active ? 'true' : 'false');
        const base =
          mode === 'collection'
            ? 'Group by collection'
            : mode === 'time'
              ? 'Group by time'
              : 'Group by property';
        btn.title = active ? base + ' (click to ungroup)' : base;
        btn.setAttribute('aria-label', btn.title);
      }
    }
    if (state.filterBtn) {
      const open = !!this._searchOpen;
      const active = open || !!(this._searchQuery || '').trim();
      state.filterBtn.classList.toggle('is-active', active);
      state.filterBtn.setAttribute('aria-expanded', open ? 'true' : 'false');
      state.filterBtn.title = open ? 'Hide filter bar' : active ? 'Filter (active)' : 'Filter';
      state.filterBtn.setAttribute('aria-label', state.filterBtn.title);
    }
    if (state.sortBtn) {
      state.sortBtn.classList.toggle('is-active', !!this._sortMenuOpen);
      state.sortBtn.setAttribute('aria-expanded', this._sortMenuOpen ? 'true' : 'false');
      state.sortBtn.title = 'Sort options · ' + this._sortSummary(state);
    }
    if (this._sortMenuOpen) this._paintSortMenu(state.sortMenuEl, state);
    if (state.searchInputEl && state.searchInputEl.value !== (this._searchQuery || '')) {
      state.searchInputEl.value = this._searchQuery || '';
    }
    this._paintAutocomplete(state);
    this._syncTimeMachineControl(state);

    const allGroups = this._filterExcludedGroups(this._groupRefs(refs));
    const groups = this._sortGroups(this._filterGroups(allGroups));
    const filtering = !!(this._searchQuery || '').trim();
    const queryStatus = this._queryStatus;

    if (state.countEl) {
      if (entry) {
        const pageN = groups.length;
        const refN = filtering
          ? groups.reduce((n, g) => n + Math.max(1, g.lines?.length || 0), 0)
          : refs.length;
        state.countEl.textContent = String(refN);
        state.countEl.title =
          refN +
          ' backlink' +
          (refN === 1 ? '' : 's') +
          ' in ' +
          pageN +
          ' page' +
          (pageN === 1 ? '' : 's') +
          (filtering ? ' (filtered)' : '') +
          (entry.ms != null ? ' · ' + entry.ms + 'ms' : '');
      } else if (loading) {
        state.countEl.textContent = '…';
        state.countEl.title = 'Loading…';
      } else {
        state.countEl.textContent = '0';
        state.countEl.title = '0 backlinks';
      }
    }

    if (collapsed || !state.bodyEl) {
      this._renderTimeMachineSection(state);
      return;
    }
    this._detachTimeMachineSlot(state);
    state.bodyEl.innerHTML = '';

    if (loading && !entry) {
      state.bodyEl.innerHTML = '<div class="dawn-tlr-empty">Loading…</div>';
      this._placeTimeMachineSlot(state);
      return;
    }
    if (entry?.error && !refs.length) {
      state.bodyEl.innerHTML =
        '<div class="dawn-tlr-empty">Error loading references. ' + entry.error + '</div>';
      this._placeTimeMachineSlot(state);
      return;
    }
    if (!entry) {
      state.bodyEl.innerHTML =
        '<div class="dawn-tlr-empty">Expand to load backlinks.</div>';
      this._placeTimeMachineSlot(state);
      return;
    }
    if (!allGroups.length) {
      state.bodyEl.innerHTML = '<div class="dawn-tlr-empty">No backlinks.</div>';
      this._appendUnlinkedSection(state.bodyEl, state);
      this._placeTimeMachineSlot(state);
      return;
    }
    if (queryStatus === 'incomplete') {
      const st = document.createElement('div');
      st.className = 'dawn-tlr-query-status';
      st.textContent = 'Continue typing…';
      state.bodyEl.appendChild(st);
    } else if (queryStatus === 'unsupported') {
      state.bodyEl.innerHTML =
        '<div class="dawn-tlr-empty">Cache @query supports @collection / @text with = !=, AND OR NOT. Vault-wide fields deferred.</div>';
      this._placeTimeMachineSlot(state);
      return;
    }

    if (!groups.length) {
      state.bodyEl.innerHTML = '<div class="dawn-tlr-empty">No matching backlinks.</div>';
      this._appendUnlinkedSection(state.bodyEl, state);
      this._placeTimeMachineSlot(state);
      return;
    }

    if (this._searchMode === 'query' && filtering && queryStatus !== 'incomplete') {
      const st = document.createElement('div');
      st.className = 'dawn-tlr-query-status';
      st.textContent = 'Cache query · ' + groups.length + ' match' + (groups.length === 1 ? '' : 'es');
      state.bodyEl.appendChild(st);
    }

    let shown = 0;
    const limit = Math.max(BL_PAGE_SIZE, Number(state.linkedShowLimit) || BL_PAGE_SIZE);
    state.linkedShowLimit = limit;
    for (const bucket of this._bucketGroups(groups, groupBy)) {
      const slice = [];
      for (const g of bucket.groups) {
        if (shown >= limit) break;
        slice.push(g);
        shown += 1;
      }
      if (!slice.length) continue;
      if (bucket.label) {
        const lab = document.createElement('div');
        lab.className = 'dawn-tlr-bucket-label';
        lab.textContent = bucket.label;
        state.bodyEl.appendChild(lab);
      }
      for (const g of slice) {
        state.bodyEl.appendChild(this._buildGroup(g, state));
      }
      if (shown >= limit) break;
    }
    if (shown < groups.length) {
      state.bodyEl.appendChild(
        this._buildShowMoreButton({
          remaining: groups.length - shown,
          onClick: () => {
            state.linkedShowLimit = limit + BL_PAGE_SIZE;
            this._paint(state);
          },
        })
      );
    }
    this._appendUnlinkedSection(state.bodyEl, state);
    this._placeTimeMachineSlot(state);
  }

  _buildShowMoreButton({ remaining, onClick }) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className =
      'dawn-tlr-show-more dawn-tlr-unlinked-pill button-none button-minimal-hover';
    const n = Math.max(0, Number(remaining) || 0);
    const caret = document.createElement('span');
    caret.className = 'ti ti-chevron-down dawn-tlr-unlinked-pill-caret';
    caret.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'dawn-tlr-unlinked-pill-label';
    label.textContent = n > 0 ? 'Show more · ' + n + ' remaining' : 'Show more';
    btn.appendChild(caret);
    btn.appendChild(label);
    btn.title = 'Show the next ' + BL_PAGE_SIZE + ' backlinks';
    btn.addEventListener('click', (e) => {
      e.preventDefault();
      e.stopPropagation();
      try {
        onClick?.();
      } catch (_) {}
    });
    return btn;
  }

  _escapeRegExp(s) {
    return String(s || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  _buildLiteralPhraseSearchQuery(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\s+/g, ' ');
    return '"' + escaped + '"';
  }

  _shouldIncludeMentionAlias(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return true;
    if (/^[A-Z0-9]{2,8}$/.test(text)) return true;
    return text.length >= 8;
  }

  _getRecordMentionPhrases(recordName) {
    const out = [];
    const seen = new Set();
    const add = (value) => {
      const text = typeof value === 'string' ? value.trim() : '';
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    };
    const title = typeof recordName === 'string' ? recordName.trim() : '';
    if (!title) return out;
    add(title);
    const parentheticalMatch = title.match(/^(.*?)\s*\(([^)]+)\)\s*$/);
    if (parentheticalMatch) {
      add(parentheticalMatch[1].trim());
      const alias = parentheticalMatch[2].trim();
      if (this._shouldIncludeMentionAlias(alias)) add(alias);
    }
    for (const separator of [' / ', ' | ']) {
      if (!title.includes(separator)) continue;
      for (const part of title.split(separator).map((x) => x.trim()).filter(Boolean)) {
        if (this._shouldIncludeMentionAlias(part)) add(part);
      }
    }
    return out;
  }

  _getPhraseBoundaryTokens(phrase) {
    const trimmed = typeof phrase === 'string' ? phrase.trim() : '';
    if (!trimmed) return [];
    return trimmed.replace(/['’]/g, '').match(/[a-z0-9]+/gi) || [];
  }

  _getUnlinkedSearchPhrases(recordName) {
    const out = [];
    const seen = new Set();
    const add = (value) => {
      const text = typeof value === 'string' ? value.trim().replace(/\s+/g, ' ') : '';
      if (!text) return;
      const key = text.toLowerCase();
      if (seen.has(key)) return;
      seen.add(key);
      out.push(text);
    };
    for (const phrase of this._getRecordMentionPhrases(recordName)) {
      add(phrase);
      if (/[\/|:_\-‐-―]/.test(phrase)) {
        const normalized = this._getPhraseBoundaryTokens(phrase).join(' ');
        if (normalized && normalized.toLowerCase() !== phrase.toLowerCase()) add(normalized);
      }
    }
    return out.slice(0, 6);
  }

  _buildUnlinkedSearchQuery(recordName) {
    const phrases = this._getUnlinkedSearchPhrases(recordName)
      .map((phrase) => this._buildLiteralPhraseSearchQuery(phrase))
      .filter(Boolean);
    if (!phrases.length) return '';
    if (phrases.length === 1) return phrases[0];
    return phrases.join(' OR ');
  }

  _buildPhraseBoundaryPattern(phrase) {
    const tokens = this._getPhraseBoundaryTokens(phrase).map((part) => this._escapeRegExp(part));
    if (!tokens.length) return null;
    const separator = '[\\s\\-\\u2010-\\u2015_./,:;!?()[\\]{}"\'“”‘’]+';
    return '(^|[^a-z0-9])(' + tokens.join(separator) + ')(?=$|[^a-z0-9])';
  }

  _buildPhraseBoundaryMatcher(phrase) {
    const pattern = this._buildPhraseBoundaryPattern(phrase);
    if (!pattern) return null;
    try {
      return new RegExp(pattern, 'i');
    } catch (_) {
      return null;
    }
  }

  _buildPhraseBoundaryGlobalMatcher(phrase) {
    const pattern = this._buildPhraseBoundaryPattern(phrase);
    if (!pattern) return null;
    try {
      return new RegExp(pattern, 'ig');
    } catch (_) {
      return null;
    }
  }

  _buildRecordMentionMatchers(recordName) {
    return this._getRecordMentionPhrases(recordName)
      .map((phrase) => this._buildPhraseBoundaryMatcher(phrase))
      .filter(Boolean);
  }

  _buildRecordMentionGlobalMatchers(recordName) {
    return this._getRecordMentionPhrases(recordName)
      .sort((a, b) => b.length - a.length)
      .map((phrase) => this._buildPhraseBoundaryGlobalMatcher(phrase))
      .filter(Boolean);
  }

  _resolveRecordName(guid) {
    const id = String(guid || '').trim();
    if (!id) return '';
    try {
      const rec = this.data.getRecord?.(id);
      if (rec && typeof rec.then === 'function') return '';
      return rec?.getName?.() || rec?.name || '';
    } catch (_) {
      return '';
    }
  }

  /** Plain-text label for a line segment (prod Backlinks+ getSegmentDisplayText). */
  _segmentDisplayText(seg) {
    if (!seg) return '';
    const type = seg.type || '';
    if (type === 'ref') {
      const textObj = typeof seg.text === 'string' ? { guid: seg.text } : seg.text || {};
      const guid = textObj.guid || '';
      return String(textObj.title || this._resolveRecordName(guid) || '').trim();
    }
    if (type === 'linkobj') {
      const t = seg.text || {};
      return String(t.title || t.link || '').trim();
    }
    if (type === 'link') {
      return typeof seg.text === 'string' ? seg.text : '';
    }
    if (type === 'hashtag') {
      const text = typeof seg.text === 'string' ? seg.text : '';
      if (!text) return '';
      return text.startsWith('#') ? text : '#' + text;
    }
    if (type === 'mention') {
      const raw = typeof seg.text === 'string' ? seg.text : '';
      return raw ? (raw.startsWith('@') ? raw : '@' + raw) : '';
    }
    if (type === 'text' || type === 'bold' || type === 'italic' || type === 'code') {
      return typeof seg.text === 'string' ? seg.text : '';
    }
    return typeof seg.text === 'string' ? seg.text : '';
  }

  _segmentsToPlainText(segments) {
    if (!Array.isArray(segments) || !segments.length) return '';
    return segments.map((s) => this._segmentDisplayText(s)).join('');
  }

  _getLineTextMentionSource(line) {
    const fromSegs = this._segmentsToPlainText(line?.segments || []);
    if (fromSegs) return fromSegs;
    try {
      if (typeof line?.getPlainText === 'function') return String(line.getPlainText() || '');
    } catch (_) {}
    try {
      if (typeof line?.text === 'string') return line.text;
    } catch (_) {}
    return '';
  }

  _lineHasRefToRecord(line, recordGuid) {
    const targetGuid = String(recordGuid || '').trim();
    if (!targetGuid) return false;
    for (const seg of line?.segments || []) {
      if (seg?.type !== 'ref') continue;
      const textObj = typeof seg?.text === 'string' ? { guid: seg.text } : seg?.text || {};
      if (String(textObj.guid || '') === targetGuid) return true;
    }
    return false;
  }

  _lineHasTextMentionOfRecord(line, recordName) {
    const matchers = this._buildRecordMentionMatchers(recordName);
    if (!matchers.length) return false;
    const text = this._getLineTextMentionSource(line);
    if (!text) return false;
    return matchers.some((m) => m.test(text));
  }

  _groupUnlinkedLines(lines, linkedGroups, targetGuid, targetName) {
    const linkedLineGuids = new Set();
    for (const group of linkedGroups || []) {
      for (const line of group?.lines || []) {
        const guid = line?.lineGuid || line?.guid || null;
        if (guid) linkedLineGuids.add(guid);
      }
    }
    const map = new Map();
    for (const line of lines || []) {
      const lineGuid = line?.guid || '';
      if (!lineGuid || linkedLineGuids.has(lineGuid)) continue;
      const src = line?.record || null;
      const srcGuid = src?.guid || line?.recordGuid || '';
      if (!srcGuid || srcGuid === targetGuid) continue;
      if (this._lineHasRefToRecord(line, targetGuid)) continue;
      if (!this._lineHasTextMentionOfRecord(line, targetName)) continue;
      let title = '';
      let collection = '';
      try {
        title = src?.getName?.() || src?.name || 'Untitled';
      } catch (_) {
        title = 'Untitled';
      }
      try {
        collection = this._recordCollectionLabel(src);
      } catch (_) {}
      const snippet = this._getLineTextMentionSource(line).slice(0, 220);
      if (!map.has(srcGuid)) {
        map.set(srcGuid, {
          fromGuid: srcGuid,
          title: String(title).slice(0, 160),
          collection: String(collection || ''),
          lines: [],
          whenMs: 0,
          editedMs: 0,
        });
      }
      map.get(srcGuid).lines.push({
        text: snippet || '(mention)',
        lineGuid,
        kind: 'unlinked',
        line,
      });
    }
    return [...map.values()];
  }

  _unlinkedEntry(guid) {
    if (!guid) return null;
    if (!this._unlinkedByGuid[guid]) {
      this._unlinkedByGuid[guid] = {
        collapsed: true,
        loading: false,
        error: '',
        groups: null,
        loaded: false,
        lineByGuid: Object.create(null),
      };
    }
    if (!this._unlinkedByGuid[guid].lineByGuid) {
      this._unlinkedByGuid[guid].lineByGuid = Object.create(null);
    }
    return this._unlinkedByGuid[guid];
  }

  async _loadUnlinkedForState(state) {
    const guid = state?.recordGuid;
    if (!guid) return;
    const entry = this._unlinkedEntry(guid);
    if (entry.loading) return;
    entry.loading = true;
    entry.error = '';
    this._paint(state);
    const record = state.record || state.panel?.getActiveRecord?.();
    let recordName = '';
    try {
      recordName = record?.getName?.() || record?.name || '';
    } catch (_) {}
    const linkedGroups = this._groupRefs((this._cache[guid]?.refs) || []);
    const boot = globalThis.BootKernel || globalThis.__dawnBoot;
    const run = async () => {
      if (state.recordGuid !== guid) return;
      try {
        if (typeof this.data.searchByQuery !== 'function') {
          entry.error = 'searchByQuery unavailable.';
          entry.groups = [];
          entry.loaded = true;
          return;
        }
        const query =
          this._buildUnlinkedSearchQuery(recordName) ||
          this._buildLiteralPhraseSearchQuery(recordName) ||
          recordName;
        if (!query) {
          entry.groups = [];
          entry.loaded = true;
          return;
        }
        const result = await this.data.searchByQuery(query, 200);
        if (state.recordGuid !== guid) return;
        if (result?.error) {
          entry.error = String(result.error);
          entry.groups = [];
        } else {
          const lines = Array.isArray(result?.lines) ? result.lines : [];
          entry.groups = this._groupUnlinkedLines(lines, linkedGroups, guid, recordName);
          entry.lineByGuid = Object.create(null);
          for (const g of entry.groups || []) {
            for (const ln of g.lines || []) {
              if (ln.lineGuid && ln.line) entry.lineByGuid[ln.lineGuid] = ln.line;
            }
          }
          entry.error = '';
        }
        entry.loaded = true;
      } catch (e) {
        entry.error = 'Error loading unlinked references.';
        entry.groups = [];
        entry.loaded = true;
        console.warn('[Dawn/Backlinks] unlinked', e);
      } finally {
        entry.loading = false;
        if (state.recordGuid === guid) this._paint(state);
      }
    };
    if (boot?.enqueue) {
      boot.enqueue(() => run(), {
        id: 'dawn-bl:unlinked-' + guid.slice(-12),
        tier: 'onDemand',
      });
    } else {
      await run();
    }
  }

  _appendUnlinkedSection(parent, state) {
    if (!parent || !state) return;
    const guid = state.recordGuid;
    const entry = this._unlinkedEntry(guid);
    const collapsed = entry.collapsed !== false;

    const pill = document.createElement('button');
    pill.type = 'button';
    pill.className = 'dawn-tlr-unlinked-pill button-none button-minimal-hover';
    pill.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    pill.title = 'Unlinked mentions';

    const caret = document.createElement('span');
    caret.className =
      'ti ' + (collapsed ? 'ti-chevron-right' : 'ti-chevron-down') + ' dawn-tlr-unlinked-pill-caret';
    caret.setAttribute('aria-hidden', 'true');
    const label = document.createElement('span');
    label.className = 'dawn-tlr-unlinked-pill-label';
    if (entry.loading && !collapsed) {
      label.textContent = 'Loading unlinked mentions…';
    } else if (collapsed) {
      label.textContent = 'Find unlinked mentions';
    } else {
      const n = (entry.groups || []).reduce((a, g) => a + Math.max(1, g.lines?.length || 0), 0);
      label.textContent = n > 0 ? 'Unlinked mentions · ' + n : 'Unlinked mentions';
    }
    pill.appendChild(caret);
    pill.appendChild(label);
    pill.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      entry.collapsed = !collapsed;
      if (!entry.collapsed && !entry.loaded && !entry.loading) {
        void this._loadUnlinkedForState(state);
      } else {
        this._paint(state);
      }
    });
    parent.appendChild(pill);

    if (collapsed) return;

    const results = document.createElement('div');
    results.className = 'dawn-tlr-unlinked-results';
    if (entry.loading) {
      const note = document.createElement('div');
      note.className = 'dawn-tlr-empty';
      note.textContent = 'Loading unlinked references...';
      results.appendChild(note);
      parent.appendChild(results);
      return;
    }
    if (entry.error) {
      const err = document.createElement('div');
      err.className = 'dawn-tlr-empty';
      err.textContent = entry.error;
      results.appendChild(err);
      parent.appendChild(results);
      return;
    }
    const groups = entry.groups || [];
    if (!groups.length) {
      const empty = document.createElement('div');
      empty.className = 'dawn-tlr-empty';
      empty.textContent = 'No unlinked mentions.';
      results.appendChild(empty);
      parent.appendChild(results);
      return;
    }
    let shown = 0;
    const limit = Math.max(BL_PAGE_SIZE, Number(state.unlinkedShowLimit) || BL_PAGE_SIZE);
    state.unlinkedShowLimit = limit;
    for (const g of groups) {
      if (shown >= limit) break;
      results.appendChild(this._buildGroup(g, state, { showLinkAction: true }));
      shown += 1;
    }
    if (shown < groups.length) {
      results.appendChild(
        this._buildShowMoreButton({
          remaining: groups.length - shown,
          onClick: () => {
            state.unlinkedShowLimit = limit + BL_PAGE_SIZE;
            this._paint(state);
          },
        })
      );
    }
    parent.appendChild(results);
  }

  _buildReplacedSegments(segments, recordName, recordGuid) {
    if (!Array.isArray(segments) || !recordGuid) return segments;
    const matchers = this._buildRecordMentionGlobalMatchers(recordName);
    if (!matchers.length) return segments;
    const result = [];
    let changed = false;
    for (const seg of segments) {
      if (
        !seg ||
        !['text', 'bold', 'italic', 'code'].includes(seg.type) ||
        typeof seg.text !== 'string'
      ) {
        result.push(seg);
        continue;
      }
      const text = seg.text;
      const matches = [];
      for (const matcher of matchers) {
        matcher.lastIndex = 0;
        let match = null;
        while ((match = matcher.exec(text)) !== null) {
          const prefix = match[1] || '';
          const matchedText = match[2] || '';
          const start = match.index + prefix.length;
          const end = start + matchedText.length;
          matches.push({ start, end, matchedText });
          matcher.lastIndex = end;
        }
      }
      if (!matches.length) {
        result.push(seg);
        continue;
      }
      matches.sort((a, b) => a.start - b.start || b.end - a.end);
      let lastIndex = 0;
      let matched = false;
      for (const m of matches) {
        if (m.start < lastIndex) continue;
        matched = true;
        changed = true;
        if (m.start > lastIndex) {
          result.push({ type: seg.type, text: text.slice(lastIndex, m.start) });
        }
        result.push({ type: 'ref', text: { guid: recordGuid, title: m.matchedText } });
        lastIndex = m.end;
      }
      if (!matched) {
        result.push(seg);
        continue;
      }
      if (lastIndex < text.length) {
        result.push({ type: seg.type, text: text.slice(lastIndex) });
      }
    }
    return changed ? result : segments;
  }

  async _linkUnlinkedReference(state, lineGuid, btnEl) {
    const record = state?.record || state?.panel?.getActiveRecord?.();
    const recordGuid = String(record?.guid || state?.recordGuid || '').trim();
    let recordName = '';
    try {
      recordName = String(record?.getName?.() || record?.name || '').trim();
    } catch (_) {}
    if (!recordGuid || !recordName || !lineGuid) return;
    const entry = this._unlinkedEntry(recordGuid);
    const line = entry?.lineByGuid?.[lineGuid] || null;
    if (!line || typeof line.setSegments !== 'function') {
      try {
        this.ui.showMessage?.('Could not link mention (line API unavailable).');
      } catch (_) {}
      return;
    }
    if (this._lineHasRefToRecord(line, recordGuid)) return;
    const next = this._buildReplacedSegments(line.segments || [], recordName, recordGuid);
    if (next === line.segments) {
      try {
        this.ui.showMessage?.('No plain-text mention found to link.');
      } catch (_) {}
      return;
    }
    if (btnEl) btnEl.classList.add('is-busy');
    try {
      await line.setSegments(next);
      // Invalidate linked + unlinked caches for this journal page.
      try {
        delete this._cache[recordGuid];
      } catch (_) {}
      entry.loaded = false;
      entry.groups = null;
      entry.lineByGuid = Object.create(null);
      entry.collapsed = false;
      this._scheduleLoad(state);
      void this._loadUnlinkedForState(state);
    } catch (e) {
      console.warn('[Dawn/Backlinks] link-unlinked', e);
      try {
        this.ui.showMessage?.('Link failed: ' + String(e?.message || e));
      } catch (_) {}
    } finally {
      if (btnEl) btnEl.classList.remove('is-busy');
    }
  }

  _buildGroup(g, state, opts) {
    const showLinkAction = !!(opts && opts.showLinkAction);
    const expanded = !!this._expanded.get(g.fromGuid)?.expanded;
    const groupEl = document.createElement('div');
    groupEl.className = 'dawn-tlr-group' + (expanded ? ' is-expanded' : '');
    groupEl.dataset.recordGuid = g.fromGuid;

    const rowEl = document.createElement('div');
    rowEl.className = 'dawn-tlr-group-row';

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className =
      'dawn-tlr-expand-btn button-none button-small button-minimal-hover' +
      (expanded ? ' is-expanded' : '');
    expandBtn.title = expanded ? 'Hide record preview' : 'Preview record content inline';
    expandBtn.setAttribute('aria-label', expandBtn.title);
    const caret = document.createElement('span');
    caret.className = 'ti ' + (expanded ? 'ti-chevron-down' : 'ti-chevron-right');
    caret.setAttribute('aria-hidden', 'true');
    expandBtn.appendChild(caret);
    expandBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this._toggleExpand(g.fromGuid, groupEl, state);
    });

    const titleBtn = document.createElement('button');
    titleBtn.type = 'button';
    titleBtn.className = 'dawn-tlr-group-header button-none button-minimal-hover';
    titleBtn.title = 'Open record';

    const titleInner = document.createElement('div');
    titleInner.className = 'dawn-tlr-group-title';
    const iconSlot = document.createElement('span');
    iconSlot.className = 'dawn-tlr-icon-slot';
    iconSlot.innerHTML = '<i class="ti ti-file-text" aria-hidden="true"></i>';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'dawn-tlr-group-title-text';
    nameSpan.textContent = g.title || 'Untitled';
    titleInner.appendChild(iconSlot);
    titleInner.appendChild(nameSpan);
    titleBtn.appendChild(titleInner);

    const metaBits = [];
    const groupBy = this._groupByForState(state);
    if (groupBy !== 'property' && g.propertyName) metaBits.push(g.propertyName);
    if (groupBy !== 'collection' && groupBy !== 'property' && g.collection) {
      metaBits.push(g.collection);
    }
    if (metaBits.length) {
      const meta = document.createElement('div');
      meta.className = 'dawn-tlr-row-meta';
      meta.textContent = '· ' + metaBits.join(' · ');
      titleBtn.appendChild(meta);
    }

    titleBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this._openRecord(g.fromGuid, null, state.panel, {
        newPanel: !!(ev.metaKey || ev.ctrlKey),
      });
    });

    rowEl.appendChild(expandBtn);
    rowEl.appendChild(titleBtn);
    rowEl.appendChild(this._buildPanelNavActions(g.fromGuid, null, state.panel));
    groupEl.appendChild(rowEl);

    const previewEl = document.createElement('div');
    previewEl.className = 'dawn-tlr-record-preview';
    const cached = this._expanded.get(g.fromGuid);
    if (expanded && cached?.allItems) {
      this._renderRecordPreview(
        previewEl,
        cached.allItems,
        g.fromGuid,
        cached.collapsedNodes || new Set(),
        state
      );
    } else if (expanded && cached?.loading) {
      previewEl.innerHTML = '<div class="dawn-tlr-empty">Loading…</div>';
    } else if (expanded && cached?.error) {
      previewEl.innerHTML =
        '<div class="dawn-tlr-empty">' + cached.error + '</div>';
    }
    groupEl.appendChild(previewEl);

    if (g.lines && g.lines.length) {
      const linesEl = document.createElement('div');
      linesEl.className = 'dawn-tlr-lines';
      const hl =
        this._searchMode === 'text' ? String(this._searchQuery || '').trim() : '';
      for (const line of g.lines.slice(0, 8)) {
        const row = document.createElement('div');
        row.className = 'dawn-tlr-line-row';
        const lineBtn = document.createElement('button');
        lineBtn.type = 'button';
        lineBtn.className = 'dawn-tlr-line button-none button-minimal-hover';
        this._setHighlightedText(lineBtn, line.text || '', hl);
        lineBtn.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          void this._openRecord(g.fromGuid, line.lineGuid || null, state.panel, {
            newPanel: !!(ev.metaKey || ev.ctrlKey),
          });
        });
        row.appendChild(lineBtn);
        row.appendChild(
          this._buildPanelNavActions(g.fromGuid, line.lineGuid || null, state.panel)
        );
        if (showLinkAction && line.kind === 'unlinked' && line.lineGuid) {
          const linkBtn = document.createElement('button');
          linkBtn.type = 'button';
          linkBtn.className =
            'dawn-tlr-unlinked-link-btn tlr-unlinked-link-btn button-none button-small button-minimal-hover';
          linkBtn.title = 'Link mention';
          linkBtn.setAttribute('aria-label', 'Link mention');
          linkBtn.innerHTML = '<i class="ti ti-link" aria-hidden="true"></i>';
          linkBtn.addEventListener('click', (ev) => {
            ev.preventDefault();
            ev.stopPropagation();
            void this._linkUnlinkedReference(state, line.lineGuid, linkBtn);
          });
          row.appendChild(linkBtn);
        }
        linesEl.appendChild(row);
      }
      groupEl.appendChild(linesEl);
    }

    return groupEl;
  }

  _setHighlightedText(el, text, query) {
    const raw = String(text || '');
    const q = String(query || '').trim();
    el.textContent = '';
    if (!q || q.length < 2) {
      el.textContent = raw;
      return;
    }
    const lower = raw.toLowerCase();
    const needle = q.toLowerCase();
    let i = 0;
    let guard = 0;
    while (i < raw.length && guard < 40) {
      guard += 1;
      const at = lower.indexOf(needle, i);
      if (at < 0) {
        el.appendChild(document.createTextNode(raw.slice(i)));
        break;
      }
      if (at > i) el.appendChild(document.createTextNode(raw.slice(i, at)));
      const mark = document.createElement('mark');
      mark.className = 'dawn-tlr-search-mark';
      mark.textContent = raw.slice(at, at + needle.length);
      el.appendChild(mark);
      i = at + needle.length;
    }
  }

  _previewLineText(item) {
    if (!item) return '';
    try {
      if (typeof item.getPlainText === 'function') {
        const t = item.getPlainText();
        if (t) return String(t);
      }
    } catch (_) {}
    try {
      const segs = item.segments;
      if (Array.isArray(segs) && segs.length) return this._segmentsToPlainText(segs);
    } catch (_) {}
    try {
      if (typeof item.text === 'string') return item.text;
      if (typeof item.getText === 'function') return String(item.getText() || '');
    } catch (_) {}
    return '';
  }

  _resolveTransclusionTargetGuid(item, byGuid, childrenOf) {
    const candidates = [];
    const pushGuidish = (value) => {
      const text = typeof value === 'string' ? value.trim() : '';
      if (text.length >= 10 && /^[0-9A-Z][0-9A-Z_-]{9,}$/i.test(text)) candidates.push(text);
    };
    const scan = (value, depth = 0) => {
      if (depth > 3 || value == null) return;
      if (typeof value === 'string') return pushGuidish(value);
      if (Array.isArray(value)) {
        for (const entry of value) scan(entry, depth + 1);
        return;
      }
      if (typeof value === 'object') {
        for (const entry of Object.values(value)) scan(entry, depth + 1);
      }
    };
    scan(item?.props);
    for (const seg of item?.segments || []) scan(seg);
    for (const guid of candidates) {
      if (guid === item?.guid) continue;
      if (byGuid.has(guid) || childrenOf.has(guid)) return guid;
    }
    return '';
  }

  _buildPreviewMarker(item, ordinal) {
    const type = item?.type || '';
    const marker = document.createElement('span');
    marker.className = 'dawn-tlr-preview-marker dawn-tlr-preview-marker-' + (type || 'text');
    if (type === 'task') {
      let done = null;
      try {
        done = item.isTaskCompleted?.();
      } catch (_) {
        done = null;
      }
      marker.classList.add('dawn-tlr-preview-marker-checkbox');
      if (done === true) {
        marker.classList.add('is-done');
        marker.textContent = '✓';
      }
      return marker;
    }
    if (type === 'ulist') {
      marker.textContent = '•';
      return marker;
    }
    if (type === 'olist') {
      marker.textContent = ordinal + '.';
      marker.classList.add('dawn-tlr-preview-marker-ordinal');
      return marker;
    }
    return null;
  }

  _renderRecordPreview(previewEl, allItems, recordGuid, collapsedNodes, state) {
    if (!previewEl) return;
    previewEl.innerHTML = '';
    if (!allItems || !allItems.length) {
      previewEl.innerHTML = '<div class="dawn-tlr-empty">(empty)</div>';
      return;
    }
    const childrenOf = new Map();
    const byGuid = new Map();
    for (const item of allItems) {
      const guid = item?.guid || '';
      if (guid) byGuid.set(guid, item);
      const p = item.parent_guid || recordGuid;
      if (!childrenOf.has(p)) childrenOf.set(p, []);
      const siblings = childrenOf.get(p);
      if (guid && siblings.some((s) => s?.guid === guid)) continue;
      siblings.push(item);
    }

    const renderChildren = (parentGuid, visiting) => {
      const children = childrenOf.get(parentGuid) || [];
      if (!children.length) return null;
      const wrap = document.createElement('div');
      wrap.className = 'dawn-tlr-preview-children';
      let ordinal = 0;
      for (const child of children) {
        ordinal = child?.type === 'olist' ? ordinal + 1 : 0;
        wrap.appendChild(renderNode(child, ordinal, visiting));
      }
      return wrap;
    };

    const renderNode = (item, ordinal, visiting) => {
      const guid = item.guid || '';
      const type = item?.type || 'text';
      const isCollapsed = collapsedNodes.has(guid);
      const isLinkRef = type === 'ref';
      const isTransclusion = type === 'transclusion';
      const nodeEl = document.createElement('div');
      nodeEl.className = 'dawn-tlr-preview-node';
      if (guid) nodeEl.dataset.nodeGuid = guid;
      if (type) nodeEl.dataset.lineType = type;
      const rowEl = document.createElement('div');
      rowEl.className = 'dawn-tlr-preview-row dawn-tlr-preview-row-' + type;

      let targetGuid = '';
      if ((isTransclusion || isLinkRef) && !visiting.has(guid)) {
        targetGuid = this._resolveTransclusionTargetGuid(item, byGuid, childrenOf);
      }
      const ownChildren = isLinkRef ? [] : childrenOf.get(guid) || [];
      const targetChildren =
        !isLinkRef && targetGuid ? childrenOf.get(targetGuid) || [] : [];
      const embeddedParentGuid = targetChildren.length
        ? targetGuid
        : ownChildren.length
          ? guid
          : '';
      const hasChildren = !!embeddedParentGuid;

      const toggleEl = document.createElement('button');
      toggleEl.type = 'button';
      toggleEl.className = 'dawn-tlr-preview-toggle button-none';
      if (hasChildren) {
        toggleEl.setAttribute('aria-label', isCollapsed ? 'Expand' : 'Collapse');
        const arrow = document.createElement('span');
        arrow.className =
          'dawn-tlr-preview-arrow' + (isCollapsed ? ' is-collapsed' : '');
        toggleEl.appendChild(arrow);
        toggleEl.addEventListener('click', (ev) => {
          ev.preventDefault();
          ev.stopPropagation();
          if (collapsedNodes.has(guid)) collapsedNodes.delete(guid);
          else collapsedNodes.add(guid);
          const cached = this._expanded.get(recordGuid) || {};
          this._expanded.set(recordGuid, {
            ...cached,
            expanded: true,
            allItems,
            collapsedNodes,
          });
          this._renderRecordPreview(previewEl, allItems, recordGuid, collapsedNodes, state);
        });
      }
      rowEl.appendChild(toggleEl);

      if (!isLinkRef) {
        const marker = this._buildPreviewMarker(item, ordinal);
        if (marker) rowEl.appendChild(marker);
      }

      const lineBtn = document.createElement('button');
      lineBtn.type = 'button';
      lineBtn.className =
        'dawn-tlr-expand-line button-none' +
        (isLinkRef ? ' dawn-tlr-preview-link-pill' : '') +
        (isTransclusion ? ' dawn-tlr-preview-transclusion-title' : '');
      let text = this._previewLineText(item).trim();
      if (!text && targetGuid) {
        const targetItem = byGuid.get(targetGuid);
        text = this._previewLineText(targetItem).trim();
        if (!text) {
          const placeholder = document.createElement('span');
          placeholder.className = 'dawn-tlr-preview-embed-note';
          placeholder.textContent = isLinkRef ? 'Linked note' : 'Embedded content';
          lineBtn.appendChild(placeholder);
        }
      }
      if (text) lineBtn.appendChild(document.createTextNode(text));
      else if (!lineBtn.childNodes.length) lineBtn.textContent = '\u00a0';
      if (isTransclusion || isLinkRef) {
        const glyph = document.createElement('span');
        glyph.className = 'dawn-tlr-preview-reference-glyph';
        glyph.textContent = '↗';
        glyph.setAttribute('aria-hidden', 'true');
        lineBtn.appendChild(glyph);
      }
      lineBtn.addEventListener('click', (ev) => {
        ev.preventDefault();
        ev.stopPropagation();
        void this._openRecord(recordGuid, guid || null, state?.panel, {
          newPanel: !!(ev.metaKey || ev.ctrlKey),
        });
      });
      rowEl.appendChild(lineBtn);
      nodeEl.appendChild(rowEl);

      if (hasChildren && embeddedParentGuid && !visiting.has(embeddedParentGuid)) {
        const nextVisiting = new Set(visiting);
        nextVisiting.add(guid);
        if (targetGuid) nextVisiting.add(targetGuid);
        const childrenEl = renderChildren(embeddedParentGuid, nextVisiting);
        const holder = document.createElement('div');
        holder.className =
          'dawn-tlr-preview-children-holder' + (isCollapsed ? ' is-hidden' : '');
        if (childrenEl) {
          if (isTransclusion) childrenEl.classList.add('dawn-tlr-preview-transcluded');
          holder.appendChild(childrenEl);
        }
        nodeEl.appendChild(holder);
      }
      return nodeEl;
    };

    const roots = childrenOf.get(recordGuid) || [];
    let ordinal = 0;
    for (const root of roots) {
      ordinal = root?.type === 'olist' ? ordinal + 1 : 0;
      previewEl.appendChild(renderNode(root, ordinal, new Set()));
    }
  }

  async _toggleExpand(fromGuid, groupEl, state) {
    if (!fromGuid || !groupEl) return;
    const expandBtn = groupEl.querySelector('.dawn-tlr-expand-btn');
    const caret = expandBtn?.querySelector?.('.ti');
    const previewEl = groupEl.querySelector('.dawn-tlr-record-preview');
    const cached = this._expanded.get(fromGuid);

    if (cached?.expanded) {
      this._expanded.set(fromGuid, {
        expanded: false,
        allItems: cached.allItems || null,
        collapsedNodes: cached.collapsedNodes || new Set(),
      });
      groupEl.classList.remove('is-expanded');
      if (expandBtn) {
        expandBtn.classList.remove('is-expanded');
        expandBtn.title = 'Preview record content inline';
        expandBtn.setAttribute('aria-label', expandBtn.title);
      }
      if (caret) {
        caret.classList.remove('ti-chevron-down');
        caret.classList.add('ti-chevron-right');
      }
      if (previewEl) previewEl.innerHTML = '';
      return;
    }

    // Re-open from cache without re-fetch when possible.
    if (cached?.allItems) {
      this._expanded.set(fromGuid, {
        expanded: true,
        allItems: cached.allItems,
        collapsedNodes: cached.collapsedNodes || new Set(),
      });
      groupEl.classList.add('is-expanded');
      if (expandBtn) {
        expandBtn.classList.add('is-expanded');
        expandBtn.title = 'Hide record preview';
        expandBtn.setAttribute('aria-label', expandBtn.title);
      }
      if (caret) {
        caret.classList.remove('ti-chevron-right');
        caret.classList.add('ti-chevron-down');
      }
      if (previewEl) {
        this._renderRecordPreview(
          previewEl,
          cached.allItems,
          fromGuid,
          cached.collapsedNodes || new Set(),
          state
        );
      }
      return;
    }

    this._expanded.set(fromGuid, {
      expanded: true,
      loading: true,
      allItems: null,
      collapsedNodes: new Set(),
    });
    groupEl.classList.add('is-expanded');
    if (expandBtn) {
      expandBtn.classList.add('is-expanded');
      expandBtn.title = 'Hide record preview';
      expandBtn.setAttribute('aria-label', expandBtn.title);
    }
    if (caret) {
      caret.classList.remove('ti-chevron-right');
      caret.classList.add('ti-chevron-down');
    }
    if (previewEl) {
      previewEl.innerHTML = '<div class="dawn-tlr-empty">Loading…</div>';
    }

    const run = async () => {
      try {
        const rec = await this.data.getRecord?.(fromGuid);
        if (!rec) throw new Error('Record not found');
        const items =
          typeof rec.getLineItems === 'function' ? (await rec.getLineItems()) || [] : [];
        const collapsedNodes = new Set();
        this._expanded.set(fromGuid, {
          expanded: true,
          allItems: items,
          collapsedNodes,
        });
        if (previewEl && groupEl.isConnected) {
          this._renderRecordPreview(previewEl, items, fromGuid, collapsedNodes, state);
        }
      } catch (e) {
        const msg = String(e?.message || e);
        this._expanded.set(fromGuid, {
          expanded: true,
          error: msg,
          allItems: [],
          collapsedNodes: new Set(),
        });
        if (previewEl && groupEl.isConnected) {
          previewEl.innerHTML =
            '<div class="dawn-tlr-empty">Could not load record content.</div>';
        }
      }
    };

    const boot = globalThis.BootKernel || globalThis.__dawnBoot;
    if (boot?.enqueue) {
      boot.enqueue(run, {
        id: 'dawn-bl:preview-' + fromGuid.slice(-12),
        tier: 'onDemand',
      });
    } else {
      void run();
    }
  }


  _stateForEl(el) {
    if (!el) return null;
    for (const st of this._panelStates.values()) {
      if (st?.root?.contains?.(el) || st?.tmBtn === el) return st;
    }
    return null;
  }

  _defaultTimeMachineSettings() {
    return {
      enabled: true,
      filters: [{ id: 'tm_default', field: 'When', op: 'same_day_last_year', value: '' }],
      excludeJournalYearForMonthDay: true,
      groupWithinYear: 'collection',
      excludedCollections: [],
    };
  }

  _normalizeTimeMachineSettings(raw) {
    const base = this._defaultTimeMachineSettings();
    if (!raw || typeof raw !== 'object') return base;
    const enabled = raw.enabled !== false;
    const filters =
      Array.isArray(raw.filters) && raw.filters.length
        ? raw.filters.map((f, i) => ({
            id: String(f?.id || 'tm_' + i),
            field: String(f?.field || 'When').trim(),
            op: String(f?.op || 'same_day_last_year').trim(),
            value: f?.value != null ? String(f.value) : '',
          }))
        : base.filters;
    const excludeJournalYearForMonthDay = raw.excludeJournalYearForMonthDay !== false;
    const g = String(raw.groupWithinYear || '').trim().toLowerCase();
    const groupWithinYear = g === 'chrono' ? 'chrono' : 'collection';
    const excludedCollections = Array.isArray(raw.excludedCollections)
      ? raw.excludedCollections.map((n) => String(n || '').trim()).filter(Boolean)
      : base.excludedCollections;
    return { enabled, filters, excludeJournalYearForMonthDay, groupWithinYear, excludedCollections };
  }

  _loadTimeMachineSettings() {
    try {
      const raw =
        localStorage.getItem(BL_LS_TM_DAWN) || localStorage.getItem(BL_LS_TM);
      if (raw) return this._normalizeTimeMachineSettings(JSON.parse(raw));
    } catch (_) {}
    try {
      const tn = JSON.parse(localStorage.getItem('tn_settings_v1') || 'null');
      if (tn && typeof tn === 'object') {
        const migrated = this._normalizeTimeMachineSettings({
          ...(tn.timeMachine || {}),
          excludedCollections: tn.excludedCollections || [],
        });
        this._saveTimeMachineSettings(migrated);
        return migrated;
      }
    } catch (_) {}
    return this._defaultTimeMachineSettings();
  }

  _saveTimeMachineSettings(settings) {
    const normalized = this._normalizeTimeMachineSettings(settings);
    this._timeMachineSettings = normalized;
    try {
      localStorage.setItem(BL_LS_TM_DAWN, JSON.stringify(normalized));
      localStorage.setItem(BL_LS_TM, JSON.stringify(normalized));
    } catch (_) {}
    this._schedulePrefsFlush();
    return normalized;
  }

  _timeMachineEnabled() {
    const tm = this._normalizeTimeMachineSettings(this._timeMachineSettings);
    return !!tm.enabled && Array.isArray(tm.filters) && tm.filters.length > 0;
  }

  _tmOpChoices() {
    // Prod full list minus vault-scan-only primary paths (not_on_journal_day as sole seed).
    return [
      ['same_day_last_year', 'Same calendar day, last year'],
      ['on_journal_day', 'On journal day'],
      ['same_month_day_as_journal', 'Same month/day as journal (any year)'],
      ['not_on_journal_day', 'Not on journal day'],
      ['eq', 'Text equals'],
      ['neq', 'Text not equals'],
      ['contains', 'Text contains'],
      ['not_contains', 'Text does not contain'],
      ['starts_with', 'Text starts with'],
      ['ends_with', 'Text ends with'],
      ['is_empty', 'Field empty'],
      ['is_not_empty', 'Field not empty'],
    ];
  }

  _tmIsDateOp(op) {
    return (
      op === 'same_day_last_year' ||
      op === 'on_journal_day' ||
      op === 'same_month_day_as_journal' ||
      op === 'not_on_journal_day'
    );
  }

  _tmIsTextOp(op) {
    return (
      op === 'eq' ||
      op === 'neq' ||
      op === 'contains' ||
      op === 'not_contains' ||
      op === 'starts_with' ||
      op === 'ends_with' ||
      op === 'is_empty' ||
      op === 'is_not_empty'
    );
  }

  _tmFilterFingerprint(tm) {
    const filters = (tm?.filters || [])
      .map((f) => [f.field || '', f.op || '', f.value || ''].join('\0'))
      .join('|');
    return (
      (tm?.enabled ? '1' : '0') +
      '::' +
      filters +
      '::' +
      (tm?.excludeJournalYearForMonthDay !== false ? '1' : '0')
    );
  }

  _tmPrimaryDateSeedOp(filters) {
    for (const f of filters || []) {
      const op = String(f?.op || '');
      if (op === 'same_day_last_year' || op === 'on_journal_day' || op === 'same_month_day_as_journal') {
        return op;
      }
    }
    return null;
  }

  _coerceDateForTm(raw) {
    if (!raw) return null;
    if (raw instanceof Date && !Number.isNaN(raw.getTime())) return raw;
    if (typeof raw?.toDate === 'function') {
      const d = raw.toDate();
      if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
    }
    if (typeof raw?.value === 'function') {
      const d = new Date(raw.value());
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof raw === 'number') {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    if (typeof raw === 'string' && raw.length >= 8) {
      const d = new Date(raw);
      if (!Number.isNaN(d.getTime())) return d;
    }
    return null;
  }

  _readTmDateField(record, fieldName) {
    const key = String(fieldName || '').trim();
    if (!key || !record) return null;
    try {
      const prop = record.prop?.(key);
      if (!prop) return null;
      if (typeof prop.date === 'function') {
        const d = prop.date();
        if (d instanceof Date && !Number.isNaN(d.getTime())) return d;
      }
      return this._coerceDateForTm(prop.get?.());
    } catch (_) {
      return null;
    }
  }

  _readTmFieldValue(record, fieldName) {
    const key = String(fieldName || '').trim();
    if (!key || !record) return '';
    try {
      if (key.toLowerCase() === 'name' || key.toLowerCase() === 'title') {
        return String(record.getName?.() || record.name || '');
      }
      const prop = record.prop?.(key);
      if (!prop) return '';
      const raw = prop.get?.();
      if (raw == null) return '';
      if (typeof raw === 'string') return raw;
      if (typeof raw === 'number' || typeof raw === 'boolean') return String(raw);
      if (raw instanceof Date) {
        return (
          raw.getFullYear() +
          '-' +
          String(raw.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(raw.getDate()).padStart(2, '0')
        );
      }
      if (typeof raw?.label === 'string') return raw.label;
      if (typeof raw?.name === 'string') return raw.name;
      return String(raw);
    } catch (_) {
      return '';
    }
  }

  _journalPartsFromKey(dayKey) {
    const iso = String(dayKey || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    return {
      year: Number(iso.slice(0, 4)),
      month: Number(iso.slice(5, 7)),
      day: Number(iso.slice(8, 10)),
      iso,
    };
  }

  _evaluateTmFilterRule(record, rule, journalParts, tm) {
    const field = String(rule?.field || '').trim();
    const op = String(rule?.op || '').trim();
    const cmpRaw = String(rule?.value || '');
    if (!field) return true;
    const isDateOp = this._tmIsDateOp(op);
    const raw = isDateOp
      ? this._readTmDateField(record, field)
      : this._readTmFieldValue(record, field);
    const asLower = (v) => {
      if (v == null) return '';
      if (v instanceof Date) {
        return (
          v.getFullYear() +
          '-' +
          String(v.getMonth() + 1).padStart(2, '0') +
          '-' +
          String(v.getDate()).padStart(2, '0')
        );
      }
      return String(v).toLowerCase();
    };
    const cmp = String(cmpRaw || '').toLowerCase();

    if (op === 'is_empty') {
      if (isDateOp) return !this._coerceDateForTm(raw);
      return !String(this._readTmFieldValue(record, field) || '').trim();
    }
    if (op === 'is_not_empty') {
      if (isDateOp) return !!this._coerceDateForTm(raw);
      return !!String(this._readTmFieldValue(record, field) || '').trim();
    }
    if (op === 'same_month_day_as_journal') {
      const d = this._coerceDateForTm(raw);
      if (!d || !journalParts) return false;
      if (d.getMonth() + 1 !== journalParts.month || d.getDate() !== journalParts.day) {
        return false;
      }
      if (tm?.excludeJournalYearForMonthDay !== false && d.getFullYear() === journalParts.year) {
        return false;
      }
      return true;
    }
    if (op === 'on_journal_day') {
      const d = this._coerceDateForTm(raw);
      if (!d || !journalParts) return false;
      return (
        d.getFullYear() === journalParts.year &&
        d.getMonth() + 1 === journalParts.month &&
        d.getDate() === journalParts.day
      );
    }
    if (op === 'not_on_journal_day') {
      const d = this._coerceDateForTm(raw);
      if (!d || !journalParts) return true;
      return !(
        d.getFullYear() === journalParts.year &&
        d.getMonth() + 1 === journalParts.month &&
        d.getDate() === journalParts.day
      );
    }
    if (op === 'same_day_last_year') {
      const d = this._coerceDateForTm(raw);
      if (!d || !journalParts) return false;
      return (
        d.getFullYear() === journalParts.year - 1 &&
        d.getMonth() + 1 === journalParts.month &&
        d.getDate() === journalParts.day
      );
    }

    const v = asLower(raw);
    if (op === 'eq') return v === cmp;
    if (op === 'neq') return v !== cmp;
    if (op === 'contains') return v.includes(cmp);
    if (op === 'not_contains') return !v.includes(cmp);
    if (op === 'starts_with') return v.startsWith(cmp);
    if (op === 'ends_with') return v.endsWith(cmp);
    return true;
  }

  _recordPassesTmFilters(record, dayKey, tm) {
    const journalParts = this._journalPartsFromKey(dayKey);
    for (const rule of tm?.filters || []) {
      if (!this._evaluateTmFilterRule(record, rule, journalParts, tm)) return false;
    }
    return true;
  }

  _resetTimeMachineState(state) {
    if (!state) return;
    state.timeMachineCollapsed = true;
    state.timeMachineLoading = false;
    state.timeMachineResults = null;
    state.timeMachineJournalKey = '';
    state.timeMachineNote = '';
  }

  _syncTimeMachineControl(state) {
    const btn = state?.tmBtn;
    if (!btn) return;
    const journalKey = state?.dayKey || '';
    const enabled = this._timeMachineEnabled() && !!journalKey;
    const open = enabled && state.timeMachineCollapsed !== true;
    btn.classList.toggle('is-active', open);
    btn.classList.toggle('is-disabled', !enabled);
    btn.hidden = !enabled;
    btn.setAttribute('aria-hidden', enabled ? 'false' : 'true');
    btn.setAttribute('aria-pressed', open ? 'true' : 'false');
    btn.disabled = !enabled;
    btn.title = !this._timeMachineEnabled()
      ? 'Time Machine (disabled in settings)'
      : !journalKey
        ? 'Time Machine (journal pages only)'
        : open
          ? 'Hide Time Machine'
          : 'Show Time Machine';
    btn.setAttribute('aria-label', btn.title);
  }

  async _toggleTimeMachine(state) {
    if (!state || !this._timeMachineEnabled()) return;
    if (!state.dayKey) return;
    const nextCollapsed = state.timeMachineCollapsed !== true;
    state.timeMachineCollapsed = nextCollapsed;
    // Opening TM should reveal the footer body (prod section lives under the pill).
    if (!nextCollapsed && this._footerCollapsed(state)) {
      this._setCollapsed(false, state);
    }
    this._paint(state);
    if (!nextCollapsed) {
      await this._runTimeMachineGenerate(state);
    }
  }

  _tmTargetIso(dayKey, op) {
    const iso = String(dayKey || '');
    if (!/^\d{4}-\d{2}-\d{2}$/.test(iso)) return null;
    if (op === 'on_journal_day') return iso;
    if (op === 'same_day_last_year') {
      const y = Number(iso.slice(0, 4)) - 1;
      return y + iso.slice(4);
    }
    return null; // month_day handled separately
  }

  async _queryTimeMachineViaDateSearch(dayKey) {
    const tm = this._normalizeTimeMachineSettings(this._timeMachineSettings);
    let seedOp = this._tmPrimaryDateSeedOp(tm.filters);
    const excl = new Set([
      ...this._excludedSet(),
      ...(tm.excludedCollections || []).map((n) => String(n).trim().toLowerCase()),
    ]);
    const journalNames = new Set(['journal', 'journals']);
    const fp = this._tmFilterFingerprint(tm);

    // Cache hit (fingerprint includes text filter values)
    const cacheKey = dayKey + '::' + fp + '::org2';
    const cached = this._tmCache[cacheKey];
    if (cached && Date.now() - (cached.builtAt || 0) < CACHE_TTL_MS) {
      return { items: cached.items, note: cached.note || '' };
    }

    let autoNotOnSeed = false;
    if (!seedOp) {
      const hasNotOn = (tm.filters || []).some((f) => f.op === 'not_on_journal_day');
      if (hasNotOn) {
        // BK-safe substitute for vault-wide sole-not_on: seed same month/day (recent years), post-filter not_on.
        seedOp = 'same_month_day_as_journal';
        autoNotOnSeed = true;
      } else {
        return {
          items: [],
          note:
            'Add a date seed rule (same day last year / on journal day / same month-day). Text rules post-filter that set (no vault scan).',
        };
      }
    }

    if (typeof this.data.searchByQuery !== 'function') {
      return {
        items: [],
        note: 'searchByQuery unavailable — Time Machine needs host date index.',
      };
    }

    const candidates = []; // {rec, dateIso, year}
    let note = '';

    if (seedOp === 'same_month_day_as_journal') {
      // Safe approximation: query last ~8 years of same month/day (not vault getAllRecords).
      const md = dayKey.slice(5);
      const y0 = Number(dayKey.slice(0, 4));
      const years = [];
      for (let y = y0; y >= y0 - 8; y -= 1) {
        if (tm.excludeJournalYearForMonthDay && y === y0) continue;
        years.push(y);
      }
      const seen = new Set();
      for (const y of years) {
        const iso = y + '-' + md;
        let result = null;
        try {
          result = await this.data.searchByQuery('@date = "' + iso + '"', TM_QUERY_LIMIT);
        } catch (_) {
          continue;
        }
        if (result?.error) continue;
        for (const rec of result?.records || []) {
          const guid = rec?.guid || '';
          if (!guid || seen.has(guid)) continue;
          seen.add(guid);
          candidates.push({ rec, dateIso: iso, year: y });
        }
      }
      note = autoNotOnSeed
        ? 'Auto-seed same month/day (recent years) for “not on journal day”, then post-filter (no vault scan).'
        : '@date seed (recent years) + client filter rules.';
    } else {
      const iso = this._tmTargetIso(dayKey, seedOp);
      if (!iso) {
        return { items: [], note: 'Could not resolve date seed for Time Machine.' };
      }
      let result = null;
      try {
        result = await this.data.searchByQuery('@date = "' + iso + '"', TM_QUERY_LIMIT);
      } catch (e) {
        return { items: [], note: 'Time Machine search failed: ' + String(e?.message || e) };
      }
      if (result?.error) {
        return { items: [], note: String(result.error) };
      }
      for (const rec of result?.records || []) {
        candidates.push({ rec, dateIso: iso, year: Number(iso.slice(0, 4)) });
      }
      const hasText = (tm.filters || []).some((f) => this._tmIsTextOp(f.op));
      note = hasText
        ? '@date seed + text post-filters (no vault scan).'
        : '';
    }

    const items = [];
    const seenOut = new Set();
    for (const { rec, dateIso, year } of candidates) {
      const guid = rec?.guid || '';
      if (!guid || seenOut.has(guid)) continue;
      if (this._isJournal(rec)) continue;
      let coll = '';
      try {
        coll = this._recordCollectionLabel(rec);
      } catch (_) {}
      const collL = String(coll).trim().toLowerCase();
      if (journalNames.has(collL) || excl.has(collL)) continue;
      if (!this._recordPassesTmFilters(rec, dayKey, tm)) continue;
      seenOut.add(guid);
      let title = '';
      try {
        title = rec.getName?.() || rec.name || 'Untitled';
      } catch (_) {
        title = 'Untitled';
      }
      const dateVal = this._tmDateValForRecord(rec, tm, dateIso);
      const itemYear =
        dateVal && !Number.isNaN(dateVal.getTime()) ? dateVal.getFullYear() : year;
      items.push({
        guid,
        title,
        collectionName: coll || 'Other',
        dateIso,
        dateVal,
        year: itemYear,
      });
    }

    items.sort((a, b) => {
      const c = String(a.collectionName).localeCompare(String(b.collectionName));
      if (c) return c;
      const ta =
        a.dateVal instanceof Date && !Number.isNaN(a.dateVal.getTime())
          ? a.dateVal.getTime()
          : 0;
      const tb =
        b.dateVal instanceof Date && !Number.isNaN(b.dateVal.getTime())
          ? b.dateVal.getTime()
          : 0;
      if (ta !== tb) return ta - tb;
      return String(a.title).localeCompare(String(b.title));
    });
    this._tmCache[cacheKey] = { items, builtAt: Date.now(), note };
    return { items, note };
  }

  async _runTimeMachineGenerate(state) {
    if (!state || !this._timeMachineEnabled()) return;
    const journalKey = state.dayKey;
    if (!journalKey) {
      state.timeMachineResults = [];
      this._renderTimeMachineSection(state);
      return;
    }
    if (state.timeMachineLoading) return;
    if (state.timeMachineResults != null && state.timeMachineJournalKey === journalKey) {
      this._renderTimeMachineSection(state);
      this._syncTimeMachineControl(state);
      return;
    }
    state.timeMachineLoading = true;
    state.timeMachineJournalKey = journalKey;
    state.timeMachineNote = '';
    this._renderTimeMachineSection(state);
    this._syncTimeMachineControl(state);

    const boot = globalThis.BootKernel || globalThis.__dawnBoot;
    const run = async () => {
      if (state.dayKey !== journalKey) return;
      try {
        const { items, note } = await this._queryTimeMachineViaDateSearch(journalKey);
        if (state.dayKey !== journalKey) return;
        state.timeMachineResults = items;
        state.timeMachineNote = note || '';
      } catch (e) {
        console.warn('[Dawn/Backlinks] TM', e);
        state.timeMachineResults = [];
        state.timeMachineNote = String(e?.message || e);
      }
      state.timeMachineLoading = false;
      this._renderTimeMachineSection(state);
      this._syncTimeMachineControl(state);
    };
    if (boot?.enqueue) {
      boot.enqueue(() => run(), {
        id: 'dawn-bl:tm-' + journalKey,
        tier: 'onDemand',
      });
    } else {
      await run();
    }
  }

  _dateFromTmIso(iso) {
    const m = String(iso || '').match(/^(\d{4})-(\d{2})-(\d{2})/);
    if (!m) return null;
    const d = new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3]));
    return Number.isNaN(d.getTime()) ? null : d;
  }

  _tmDateValForRecord(record, tm, dateIso) {
    const tryField = (name) => this._readTmDateField(record, name);
    let dateVal = null;
    for (const rule of tm?.filters || []) {
      if (!this._tmIsDateOp(rule?.op)) continue;
      dateVal = tryField(rule.field);
      if (dateVal) break;
    }
    if (!dateVal) dateVal = tryField('When') || tryField('Date');
    if (!dateVal) dateVal = this._dateFromTmIso(dateIso);
    return dateVal;
  }

  _tmItemYear(item) {
    const d =
      item?.dateVal instanceof Date && !Number.isNaN(item.dateVal.getTime())
        ? item.dateVal
        : this._coerceDateForTm(item?.dateVal);
    if (d && !Number.isNaN(d.getTime())) return d.getFullYear();
    const y = Number(item?.year);
    if (Number.isFinite(y)) return y;
    const iso = String(item?.dateIso || '');
    if (/^\d{4}-/.test(iso)) return Number(iso.slice(0, 4));
    return null;
  }

  _groupTmByYear(items) {
    const yearMap = new Map();
    const unknown = [];
    for (const it of items || []) {
      const y = this._tmItemYear(it);
      if (y == null || Number.isNaN(y)) {
        unknown.push(it);
        continue;
      }
      if (!yearMap.has(y)) yearMap.set(y, []);
      yearMap.get(y).push(it);
    }
    const years = Array.from(yearMap.keys()).sort((a, b) => b - a);
    return { yearMap, years, unknown };
  }

  _sortTmItemsByTimeAscending(items) {
    return [...(items || [])].sort((a, b) => {
      const ta =
        a?.dateVal instanceof Date && !Number.isNaN(a.dateVal.getTime())
          ? a.dateVal.getTime()
          : 0;
      const tb =
        b?.dateVal instanceof Date && !Number.isNaN(b.dateVal.getTime())
          ? b.dateVal.getTime()
          : 0;
      if (ta !== tb) return ta - tb;
      return String(a?.title || '').localeCompare(String(b?.title || ''));
    });
  }

  _groupTmResultsByCollection(items) {
    const byColl = new Map();
    for (const item of items || []) {
      const name = item?.collectionName || 'Other';
      if (!byColl.has(name)) byColl.set(name, []);
      byColl.get(name).push(item);
    }
    return byColl;
  }

  _buildTimeMachineRow(item, state) {
    const guid = item?.guid || '';
    const groupEl = document.createElement('div');
    groupEl.className = 'dawn-tlr-group dawn-tlr-group-tm';
    const rowEl = document.createElement('div');
    rowEl.className = 'dawn-tlr-group-row';
    const titleBtn = document.createElement('button');
    titleBtn.type = 'button';
    titleBtn.className = 'dawn-tlr-group-header button-none button-minimal-hover';
    titleBtn.title = 'Open record';
    const titleInner = document.createElement('div');
    titleInner.className = 'dawn-tlr-group-title';
    const iconSlot = document.createElement('span');
    iconSlot.className = 'dawn-tlr-icon-slot';
    iconSlot.innerHTML = '<i class="ti ti-file-text" aria-hidden="true"></i>';
    const nameSpan = document.createElement('span');
    nameSpan.className = 'dawn-tlr-group-title-text';
    nameSpan.textContent = item?.title || 'Untitled';
    titleInner.appendChild(iconSlot);
    titleInner.appendChild(nameSpan);
    titleBtn.appendChild(titleInner);
    if (item?.collectionName) {
      const meta = document.createElement('div');
      meta.className = 'dawn-tlr-row-meta';
      meta.textContent = '· ' + item.collectionName;
      titleBtn.appendChild(meta);
    }
    titleBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this._openRecord(guid, null, state.panel, {
        newPanel: !!(ev.metaKey || ev.ctrlKey),
      });
    });
    rowEl.appendChild(titleBtn);
    if (guid) rowEl.appendChild(this._buildPanelNavActions(guid, null, state.panel));
    groupEl.appendChild(rowEl);
    return groupEl;
  }

  _renderTimeMachineSection(state) {
    const slot = state?.tmSlotEl;
    if (!slot) return;
    slot.innerHTML = '';
    const journalKey = state?.dayKey || '';
    if (!this._timeMachineEnabled() || !journalKey || state.timeMachineCollapsed === true) {
      slot.hidden = true;
      return;
    }
    // Only show TM chrome when footer expanded (matches “section in body” feel).
    if (this._footerCollapsed(state)) {
      slot.hidden = true;
      return;
    }
    slot.hidden = false;

    const wrap = document.createElement('div');
    wrap.className = 'dawn-tlr-tm-section tlr-tm-section';
    const head = document.createElement('div');
    head.className = 'dawn-tlr-tm-head tlr-tm-head';
    const iconWrap = document.createElement('span');
    iconWrap.className = 'dawn-tlr-tm-icon tlr-tm-icon';
    iconWrap.innerHTML = '<i class="ti ti-hourglass" aria-hidden="true"></i>';
    const title = document.createElement('div');
    title.className = 'dawn-tlr-tm-title tlr-tm-title';
    title.textContent = 'Time Machine';
    const collapseBtn = document.createElement('button');
    collapseBtn.type = 'button';
    collapseBtn.className =
      'dawn-tlr-tm-collapse button-none button-small button-minimal-hover';
    collapseBtn.title = 'Collapse Time Machine';
    collapseBtn.setAttribute('aria-label', 'Collapse Time Machine');
    collapseBtn.innerHTML = '<i class="ti ti-chevron-up" aria-hidden="true"></i>';
    collapseBtn.addEventListener('click', (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      void this._toggleTimeMachine(state);
    });
    head.append(iconWrap, title, collapseBtn);
    wrap.appendChild(head);

    const body = document.createElement('div');
    body.className = 'dawn-tlr-tm-body tlr-tm-body';
    wrap.appendChild(body);

    if (state.timeMachineLoading) {
      const loading = document.createElement('div');
      loading.className = 'dawn-tlr-empty';
      loading.textContent = 'Loading Time Machine…';
      body.appendChild(loading);
      slot.appendChild(wrap);
      return;
    }
    if (state.timeMachineResults == null) {
      slot.appendChild(wrap);
      return;
    }
    if (!state.timeMachineResults.length) {
      const empty = document.createElement('div');
      empty.className = 'dawn-tlr-empty';
      empty.textContent = 'No records matched your Time Machine filters.';
      body.appendChild(empty);
      if (state.timeMachineNote) {
        const note = document.createElement('div');
        note.className = 'dawn-tlr-query-status';
        note.textContent = state.timeMachineNote;
        body.appendChild(note);
      }
      slot.appendChild(wrap);
      return;
    }

    const tmCfg = this._normalizeTimeMachineSettings(this._timeMachineSettings);
    const { yearMap, years, unknown } = this._groupTmByYear(state.timeMachineResults);
    const renderYear = (label, list) => {
      const yh = document.createElement('div');
      yh.className = 'dawn-tlr-tm-year-head tlr-tm-year-head';
      yh.textContent = label;
      body.appendChild(yh);
      if (tmCfg.groupWithinYear === 'chrono') {
        for (const item of this._sortTmItemsByTimeAscending(list)) {
          body.appendChild(this._buildTimeMachineRow(item, state));
        }
        return;
      }
      const byColl = this._groupTmResultsByCollection(list);
      const names = Array.from(byColl.keys()).sort((a, b) => String(a).localeCompare(String(b)));
      for (const n of names) {
        const sub = document.createElement('div');
        sub.className = 'dawn-tlr-tm-subcoll tlr-tm-subcoll';
        sub.textContent = n;
        body.appendChild(sub);
        for (const item of this._sortTmItemsByTimeAscending(byColl.get(n) || [])) {
          body.appendChild(this._buildTimeMachineRow(item, state));
        }
      }
    };
    for (const y of years) renderYear(String(y), yearMap.get(y) || []);
    if (unknown.length) renderYear('Other', unknown);
    if (state.timeMachineNote) {
      const note = document.createElement('div');
      note.className = 'dawn-tlr-query-status';
      note.textContent = state.timeMachineNote;
      body.appendChild(note);
    }
    slot.appendChild(wrap);
  }

  _openTimeMachineSettings() {
    try {
      document.querySelector('.dawn-tlr-tm-settings-overlay')?.remove?.();
    } catch (_) {}
    const draft = this._normalizeTimeMachineSettings(this._timeMachineSettings);
    const overlay = document.createElement('div');
    overlay.className = 'dawn-tlr-tm-settings-overlay tlr-tm-settings-overlay';
    const panel = document.createElement('div');
    panel.className = 'dawn-tlr-tm-settings-panel tlr-tm-settings-panel';

    const h = document.createElement('h3');
    h.textContent = 'Time Machine';
    panel.appendChild(h);
    const help = document.createElement('p');
    help.className = 'dawn-tlr-tm-settings-help tlr-tm-settings-help';
    help.textContent =
      'Journal-page section. Dawn seeds via on-demand @date (not a vault scan), then applies all filter rules client-side — including text ops. “Not on journal day” alone is deferred (needs vault scan); combine with a date seed.';
    panel.appendChild(help);

    const en = document.createElement('label');
    en.className = 'dawn-tlr-tm-settings-row tlr-tm-settings-row';
    const cb = document.createElement('input');
    cb.type = 'checkbox';
    cb.checked = draft.enabled !== false;
    cb.addEventListener('change', () => {
      draft.enabled = cb.checked;
    });
    en.append(cb, document.createTextNode(' Show Time Machine'));
    panel.appendChild(en);

    const exclBtn = document.createElement('button');
    exclBtn.type = 'button';
    exclBtn.className = 'dawn-tlr-tm-settings-secondary tlr-tm-settings-secondary';
    exclBtn.textContent = 'Excluded collections…';
    exclBtn.addEventListener('click', () => {
      overlay.remove();
      this._openExcludedDialog();
    });
    panel.appendChild(exclBtn);

    const filtersWrap = document.createElement('div');
    filtersWrap.className = 'dawn-tlr-tm-filters tlr-tm-filters';
    const opChoices = this._tmOpChoices();
    const renderFilters = () => {
      filtersWrap.innerHTML = '';
      draft.filters.forEach((rule, ridx) => {
        const row = document.createElement('div');
        row.className = 'dawn-tlr-tm-filter-row tlr-tm-filter-row';
        const fin = document.createElement('input');
        fin.type = 'text';
        fin.placeholder = 'Field (e.g. When)';
        fin.value = rule.field || '';
        fin.addEventListener('input', () => {
          draft.filters[ridx].field = fin.value.trim();
        });
        const opSel = document.createElement('select');
        for (const [val, lab] of opChoices) {
          const o = document.createElement('option');
          o.value = val;
          o.textContent = lab;
          opSel.appendChild(o);
        }
        opSel.value = opChoices.some(([v]) => v === rule.op) ? rule.op : 'same_day_last_year';
        opSel.addEventListener('change', () => {
          draft.filters[ridx].op = opSel.value;
          renderFilters();
        });
        const vin = document.createElement('input');
        vin.type = 'text';
        vin.placeholder = 'Compare value';
        vin.value = rule.value || '';
        vin.disabled = !this._tmIsTextOp(opSel.value) || opSel.value === 'is_empty' || opSel.value === 'is_not_empty';
        vin.addEventListener('input', () => {
          draft.filters[ridx].value = vin.value;
        });
        const rm = document.createElement('button');
        rm.type = 'button';
        rm.textContent = '✕';
        rm.addEventListener('click', () => {
          draft.filters.splice(ridx, 1);
          if (!draft.filters.length) {
            draft.filters.push({
              id: 'tm_' + Date.now(),
              field: 'When',
              op: 'same_day_last_year',
              value: '',
            });
          }
          renderFilters();
        });
        row.append(fin, opSel, vin, rm);
        filtersWrap.appendChild(row);
      });
    };
    renderFilters();
    panel.appendChild(filtersWrap);

    const addBtn = document.createElement('button');
    addBtn.type = 'button';
    addBtn.className = 'dawn-tlr-tm-settings-secondary tlr-tm-settings-secondary';
    addBtn.textContent = '+ Add filter rule';
    addBtn.addEventListener('click', () => {
      draft.filters.push({
        id: 'tm_' + Date.now(),
        field: 'When',
        op: 'same_day_last_year',
        value: '',
      });
      renderFilters();
    });
    panel.appendChild(addBtn);

    const exclLb = document.createElement('label');
    exclLb.className = 'dawn-tlr-tm-settings-row tlr-tm-settings-row';
    const exclCb = document.createElement('input');
    exclCb.type = 'checkbox';
    exclCb.checked = draft.excludeJournalYearForMonthDay !== false;
    exclCb.addEventListener('change', () => {
      draft.excludeJournalYearForMonthDay = exclCb.checked;
    });
    exclLb.append(
      exclCb,
      document.createTextNode(' Exclude journal year from “same month/day” results')
    );
    panel.appendChild(exclLb);

    const groupSel = document.createElement('select');
    groupSel.className = 'dawn-tlr-tm-settings-input tlr-tm-settings-input';
    for (const [val, lab] of [
      ['collection', 'Group within year by collection'],
      ['chrono', 'Group within year by time'],
    ]) {
      const o = document.createElement('option');
      o.value = val;
      o.textContent = lab;
      groupSel.appendChild(o);
    }
    groupSel.value = draft.groupWithinYear === 'chrono' ? 'chrono' : 'collection';
    groupSel.addEventListener('change', () => {
      draft.groupWithinYear = groupSel.value === 'chrono' ? 'chrono' : 'collection';
    });
    panel.appendChild(groupSel);

    const actions = document.createElement('div');
    actions.className = 'dawn-tlr-tm-settings-actions tlr-tm-settings-actions';
    const cancel = document.createElement('button');
    cancel.type = 'button';
    cancel.textContent = 'Cancel';
    cancel.addEventListener('click', () => overlay.remove());
    const save = document.createElement('button');
    save.type = 'button';
    save.className = 'dawn-tlr-tm-settings-primary tlr-tm-settings-primary';
    save.textContent = 'Save';
    save.addEventListener('click', () => {
      this._saveTimeMachineSettings(draft);
      this._tmCache = Object.create(null);
      for (const st of this._panelStates.values()) {
        this._resetTimeMachineState(st);
        this._syncTimeMachineControl(st);
        this._renderTimeMachineSection(st);
      }
      overlay.remove();
    });
    actions.append(cancel, save);
    panel.appendChild(actions);
    overlay.appendChild(panel);
    overlay.addEventListener('click', (e) => {
      if (e.target === overlay) overlay.remove();
    });
    document.body.appendChild(overlay);
  }

  _dispose(panelId) {
    const state = this._panelStates.get(panelId);
    if (!state) return;
    try {
      state.root?.remove?.();
    } catch (_) {}
    this._panelStates.delete(panelId);
  }

  _resetShowLimits(state) {
    if (!state) return;
    state.linkedShowLimit = BL_PAGE_SIZE;
    state.unlinkedShowLimit = BL_PAGE_SIZE;
  }

  _refreshAll(opts) {
    const keepShowLimit = !!(opts && opts.keepShowLimit);
    for (const s of this._panelStates.values()) {
      if (!keepShowLimit) this._resetShowLimits(s);
      if (s.panel) this._handlePanel(s.panel, opts);
    }
  }
}
