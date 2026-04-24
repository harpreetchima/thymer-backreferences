class Plugin extends AppPlugin {
  onLoad() {
    // NOTE: Thymer strips top-level code outside the Plugin class.
    this._panelStates = new Map();
    this._eventHandlerIds = [];
    this._maxStoredPageViewRecords = 400;
    this._maxStoredSortByRecords = 400;
    this._maxStoredPropGroupStates = 160;
    this._maxStoredRecordGroupStates = 600;

    this._storageKeyVisibility = 'thymer_backreferences_visibility_v1';
    this._visibilityConfig = this.loadVisibilityConfig();

    this._storageKeyPageViewByRecord = 'thymer_backreferences_page_view_by_record_v1';
    this._pageViewByRecord = this.loadPageViewByRecordSetting();

    this._storageKeyPropGroupCollapsed = 'thymer_backreferences_prop_group_collapsed_v2';
    this._legacyStorageKeyPropGroupCollapsed = null;
    this._propGroupCollapsed = this.loadPropGroupCollapsedSetting();

    this._storageKeyRecordGroupCollapsed = 'thymer_backreferences_record_group_collapsed_v1';
    this._legacyStorageKeyRecordGroupCollapsed = null;
    this._recordGroupCollapsed = this.loadRecordGroupCollapsedSetting();

    this._defaultSortBy = 'page_last_edited';
    this._defaultSortDir = 'desc';
    this._storageKeySortByRecord = 'thymer_backreferences_sort_by_record_v1';
    this._legacyStorageKeySortByRecord = 'thymer_backlinks_sort_by_record_v1';
    this._sortByRecord = this.loadSortByRecordSetting();

    this._defaultMaxResults = 200;
    this._refreshDebounceMs = 350;
    this._queryFilterDebounceMs = 180;
    this._defaultQueryFilterMaxResults = 1000;
    this._propertyIndexStatus = 'idle';
    this._propertyIndexByTargetGuid = new Map();
    this._propertyIndexSourceEntriesByRecordGuid = new Map();
    this._propertyIndexStats = this.createEmptyPropertyIndexStats();
    this._propertyIndexError = '';
    this._propertyIndexPromise = null;
    this._propertyIndexBuildSeq = 0;
    this._propertyIndexRebuildTimer = null;
    this._propertyIndexNeedsRebuild = false;
    this._queryAutocompleteCatalog = null;
    this._queryAutocompleteCatalogPromise = null;
    this._queryStandaloneFilters = [
      'task', 'todo', 'done', 'due', 'overdue', 'assigned', 'unassigned', 'scheduled',
      'inprogress', 'wip', 'waiting', 'billing', 'important', 'discuss', 'alert', 'starred',
      'document', 'page', 'record', 'heading', 'text', 'quote', 'list', 'image', 'file',
      'me', 'mention', 'today', 'tomorrow', 'yesterday', 'thisweek', 'nextweek', 'lastweek',
      'thismonth', 'thisyear'
    ];
    this._queryBuiltInKeys = [
      'created_at', 'modified_at', 'created_by', 'modified_by', 'text', 'type', 'date',
      'due', 'time', 'mention', 'scheduled', 'hashtag', 'link', 'collection', 'guid',
      'pguid', 'rguid', 'backref', 'linkto'
    ];

    this.injectCss();

    this._cmdRebuildIndex = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Rebuild Graph Index',
      icon: 'refresh',
      onSelected: () => {
        this.rebuildPropertyIndex({ reason: 'cmdpal-rebuild-index' }).catch(() => {
          // The error state is rendered in the footer.
        });
      }
    });
    this._cmdToggleDefaultVisibility = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Toggle Globally',
      icon: 'eye',
      onSelected: () => this.toggleDefaultVisibility()
    });
    this._cmdToggleCollectionVisibility = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Toggle in Current Collection',
      icon: 'eye',
      onSelected: () => this.toggleVisibilityForActiveCollection()
    });

    this._eventHandlerIds.push(
      this.events.on('panel.navigated', (ev) => this.handlePanelChanged(ev.panel, 'panel.navigated'))
    );
    this._eventHandlerIds.push(
      this.events.on('panel.focused', (ev) => this.handlePanelChanged(ev.panel, 'panel.focused'))
    );
    this._eventHandlerIds.push(
      this.events.on('panel.closed', (ev) => this.handlePanelClosed(ev.panel))
    );
    this._eventHandlerIds.push(
      this.events.on('reload', () => this.refreshAllPanels({ force: true, reason: 'reload' }))
    );

    // Keep backreferences reasonably fresh when references are created/edited elsewhere.
    this._eventHandlerIds.push(this.events.on('lineitem.created', (ev) => this.handleLineItemCreated(ev)));
    this._eventHandlerIds.push(this.events.on('lineitem.updated', (ev) => this.handleLineItemUpdated(ev)));
    this._eventHandlerIds.push(this.events.on('lineitem.moved', (ev) => this.handleLineItemMoved(ev)));
    this._eventHandlerIds.push(this.events.on('lineitem.undeleted', (ev) => this.handleLineItemUndeleted(ev)));
    this._eventHandlerIds.push(this.events.on('lineitem.deleted', (ev) => this.handleLineItemDeleted(ev)));
    this._eventHandlerIds.push(this.events.on('record.created', (ev) => this.handleRecordCreated(ev)));
    this._eventHandlerIds.push(this.events.on('record.updated', (ev) => this.handleRecordUpdated(ev)));
    this._eventHandlerIds.push(this.events.on('record.moved', (ev) => this.handleRecordMoved(ev)));

    const panel = this.ui.getActivePanel();
    if (panel) this.handlePanelChanged(panel, 'initial');
    this.rebuildPropertyIndex({ reason: 'initial' }).catch(() => {
      // The error state is rendered in the footer.
    });
    setTimeout(() => {
      const p = this.ui.getActivePanel();
      if (p) this.handlePanelChanged(p, 'initial-delayed');
    }, 250);
  }

  onUnload() {
    for (const id of this._eventHandlerIds || []) {
      try {
        this.events.off(id);
      } catch (e) {
        // ignore
      }
    }
    this._eventHandlerIds = [];

    this._cmdRebuildIndex?.remove?.();
    this._cmdToggleDefaultVisibility?.remove?.();
    this._cmdToggleCollectionVisibility?.remove?.();

    if (this._propertyIndexRebuildTimer) {
      clearTimeout(this._propertyIndexRebuildTimer);
      this._propertyIndexRebuildTimer = null;
    }

    for (const panelId of Array.from(this._panelStates?.keys?.() || [])) {
      this.disposePanelState(panelId);
    }
    this._panelStates?.clear?.();
  }

  // ---------- Panel lifecycle ----------

  handlePanelChanged(panel, reason) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;

    const panelEl = panel?.getElement?.() || null;
    if (this.shouldSuppressInPanel(panel, panelEl)) {
      this.disposePanelState(panelId);
      return;
    }

    const mountContainer = this.findMountContainer(panelEl);
    if (!mountContainer) {
      this.disposePanelState(panelId);
      return;
    }

    const record = panel?.getActiveRecord?.() || null;
    const recordGuid = record?.guid || null;

    if (!recordGuid) {
      // If the panel no longer shows a record, remove our footer.
      this.disposePanelState(panelId);
      return;
    }

    const state = this.getOrCreatePanelState(panel);
    if (!state.sectionCollapsed || typeof state.sectionCollapsed !== 'object') {
      state.sectionCollapsed = this.createDefaultSectionCollapsedState();
    }
    if (state.footerCollapsed !== true && state.footerCollapsed !== false) {
      state.footerCollapsed = null;
    }
    const recordChanged = state.recordGuid !== recordGuid;
    state.recordGuid = recordGuid;
    if (recordChanged) {
      const viewPrefs = this.getPageViewPreference(recordGuid);
      state.footerCollapsed = viewPrefs.footerCollapsed;
      state.sectionCollapsed = this.cloneSectionCollapsedState(viewPrefs.sections);
    }

    if (recordChanged || !this.isValidSortBy(state.sortBy) || !this.isValidSortDir(state.sortDir)) {
      state.linkedContextByLine = new Map();
      state.searchAutocompleteItems = [];
      state.searchAutocompleteSelectedIndex = 0;
      state.searchAutocompleteOpen = false;
      state.liveBaselineSnapshot = null;
      state.liveCurrentSnapshot = null;
      state.liveNewKeys = new Set();
      state.liveRemoteBadgesByKey = new Map();
      state.pendingRemoteSync = false;
      state.pendingRemoteUsers = new Set();
      if (state.queryFilterTimer) {
        clearTimeout(state.queryFilterTimer);
        state.queryFilterTimer = null;
      }
      state.queryFilterState = null;
      const pref = this.getSortPreferenceForRecord(recordGuid);
      state.sortBy = pref.sortBy;
      state.sortDir = pref.sortDir;
      state.sortMenuOpen = false;
      state.searchOpen = Boolean((state.searchQuery || '').trim());
    }

    if (this.isPanelVisible(panel)) {
      this.mountFooter(panel, state);
    } else {
      this.unmountFooterForHiddenPanel(state);
      return;
    }

    // Always refresh on navigation; on focus we debounce unless already loaded.
    this.scheduleRefreshForPanel(panel, {
      force: recordChanged,
      reason: reason || (recordChanged ? 'record-changed' : 'record-same')
    });
  }

  shouldSuppressInPanel(panel, panelEl) {
    const panelType = typeof panel?.getType === 'function' ? (panel.getType() || '').trim() : '';
    const nav = panel?.getNavigation?.() || null;
    const navType = nav && typeof nav.type === 'string' ? nav.type.trim() : '';

    if (panelType && panelType !== 'edit_panel') return true;

    // Keep suppression conservative: nav.type labels can vary across builds.
    // We hard-suppress known custom panel nav types and any Search surface,
    // which can share editor-panel containers but should never host footer UI.
    if (navType === 'custom' || navType === 'custom_panel') return true;
    if (panelEl?.matches?.('.search-panel') || panelEl?.closest?.('.search-panel')) return true;

    return false;
  }

  getVisibilityInstallDefault() {
    const cfg = this.getConfiguration?.() || {};
    if (typeof cfg?.custom?.defaultVisible === 'boolean') {
      return cfg.custom.defaultVisible;
    }
    return true;
  }

  normalizeVisibilityConfig(value, fallbackDefaultVisible) {
    const fallback = fallbackDefaultVisible === false ? false : true;
    const source = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const defaultVisible = typeof source.defaultVisible === 'boolean'
      ? source.defaultVisible
      : fallback;
    const collections = {};
    const rawCollections = source.collections && typeof source.collections === 'object' && !Array.isArray(source.collections)
      ? source.collections
      : {};

    for (const [guid, visible] of Object.entries(rawCollections)) {
      const key = typeof guid === 'string' ? guid.trim() : '';
      if (!key || typeof visible !== 'boolean') continue;
      if (visible === defaultVisible) continue;
      collections[key] = visible;
    }

    const updatedAt = Number.isFinite(Number(source.updatedAt)) && Number(source.updatedAt) > 0
      ? Math.floor(Number(source.updatedAt))
      : 0;

    return {
      version: 1,
      defaultVisible,
      collections,
      updatedAt
    };
  }

  loadVisibilityConfig() {
    const fallback = this.getVisibilityInstallDefault();
    return this.normalizeVisibilityConfig(this.readJsonStorage(this._storageKeyVisibility), fallback);
  }

  saveVisibilityConfig(config) {
    const next = this.normalizeVisibilityConfig(config, this.getVisibilityInstallDefault());
    next.updatedAt = Date.now();
    this._visibilityConfig = next;
    this.writeJsonStorage(this._storageKeyVisibility, next);
    return next;
  }

  getPanelCollection(panel) {
    try {
      return panel?.getActiveCollection?.() || null;
    } catch (e) {
      return null;
    }
  }

  getCollectionGuid(collection) {
    const guid = typeof collection?.getGuid === 'function'
      ? collection.getGuid()
      : (collection?.guid || collection?.id || '');
    return typeof guid === 'string' ? guid.trim() : '';
  }

  getCollectionName(collection) {
    const name = typeof collection?.getName === 'function'
      ? collection.getName()
      : (collection?.name || '');
    return (typeof name === 'string' && name.trim()) ? name.trim() : 'current collection';
  }

  isCollectionVisible(collection) {
    const cfg = this._visibilityConfig || this.loadVisibilityConfig();
    const guid = this.getCollectionGuid(collection);
    if (guid && Object.prototype.hasOwnProperty.call(cfg.collections || {}, guid)) {
      return cfg.collections[guid] !== false;
    }
    return cfg.defaultVisible !== false;
  }

  isPanelVisible(panel) {
    return this.isCollectionVisible(this.getPanelCollection(panel));
  }

  showToast(title) {
    const text = typeof title === 'string' ? title.trim() : '';
    if (!text) return;
    try {
      this.ui?.addToaster?.({
        title: text,
        dismissible: true,
        autoDestroyTime: 1800
      });
    } catch (e) {
      // ignore
    }
  }

  toggleDefaultVisibility() {
    const current = this._visibilityConfig || this.loadVisibilityConfig();
    const nextVisible = current.defaultVisible === false;
    this.saveVisibilityConfig({
      version: 1,
      defaultVisible: nextVisible,
      collections: {},
      updatedAt: Date.now()
    });
    this.showToast(`Backreferences ${nextVisible ? 'shown' : 'hidden'} globally`);
    this.reconcileAllPanelsVisibility({ refreshVisible: nextVisible, reason: 'toggle-global-visibility' });
  }

  toggleVisibilityForActiveCollection() {
    const panel = this.ui?.getActivePanel?.() || null;
    const collection = this.getPanelCollection(panel);
    const guid = this.getCollectionGuid(collection);
    if (!guid) {
      this.showToast('No active collection for Backreferences');
      return;
    }

    const current = this._visibilityConfig || this.loadVisibilityConfig();
    const currentVisible = this.isCollectionVisible(collection);
    const nextVisible = !currentVisible;
    const collections = { ...(current.collections || {}) };
    if (nextVisible === current.defaultVisible) {
      delete collections[guid];
    } else {
      collections[guid] = nextVisible;
    }

    this.saveVisibilityConfig({
      ...current,
      collections,
      updatedAt: Date.now()
    });

    const name = this.getCollectionName(collection);
    this.showToast(`Backreferences ${nextVisible ? 'shown' : 'hidden'} for ${name}`);
    this.reconcileAllPanelsVisibility({
      refreshVisible: nextVisible,
      reason: 'toggle-collection-visibility',
      collectionGuid: guid
    });
  }

  getKnownPanels() {
    const panels = [];
    const seen = new Set();
    const addPanel = (panel) => {
      const id = panel?.getId?.() || null;
      if (!id || seen.has(id)) return;
      seen.add(id);
      panels.push(panel);
    };

    try {
      const openPanels = this.ui?.getPanels?.() || [];
      for (const panel of openPanels) addPanel(panel);
    } catch (e) {
      // ignore
    }

    for (const state of this._panelStates?.values?.() || []) {
      addPanel(state?.panel || null);
    }

    return panels;
  }

  reconcileAllPanelsVisibility({ refreshVisible, reason, collectionGuid } = {}) {
    for (const panel of this.getKnownPanels()) {
      if (collectionGuid) {
        const guid = this.getCollectionGuid(this.getPanelCollection(panel));
        if (guid !== collectionGuid) continue;
      }
      this.handlePanelChanged(panel, reason || 'visibility-changed');
    }
  }

  handlePanelClosed(panel) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;
    this.disposePanelState(panelId);
  }

  getOrCreatePanelState(panel) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) {
      return this.createPanelState('unknown', null);
    }

    let state = this._panelStates.get(panelId) || null;
    if (state) {
      state.panel = panel;
      return state;
    }

    state = this.createPanelState(panelId, panel);

    this._panelStates.set(panelId, state);
    return state;
  }

  createPanelState(panelId, panel) {
    return {
      panelId: panelId || 'unknown',
      panel: panel || null,
      recordGuid: null,
      mountedIn: null,
      rootEl: null,
      bodyEl: null,
      statusSlotEl: null,
      propertySlotEl: null,
      linkedSlotEl: null,
      unlinkedSlotEl: null,
      countEl: null,
      footerToggleEl: null,
      sortToggleEl: null,
      sortMenuEl: null,
      searchToggleEl: null,
      searchRowEl: null,
      searchWrapEl: null,
      searchInputEl: null,
      searchHighlightTextEl: null,
      searchClearEl: null,
      searchRefreshEl: null,
      searchAutocompleteEl: null,
      searchAutocompleteItems: [],
      searchAutocompleteSelectedIndex: 0,
      searchAutocompleteOpen: false,
      searchAutocompleteDismissHandler: null,
      searchAutocompleteRequestSeq: 0,
      searchQuery: '',
      searchOpen: false,
      footerCollapsed: null,
      sectionCollapsed: this.createDefaultSectionCollapsedState(),
      linkedContextByLine: new Map(),
      liveBaselineSnapshot: null,
      liveCurrentSnapshot: null,
      liveNewKeys: new Set(),
      liveRemoteBadgesByKey: new Map(),
      liveRenderVersion: 0,
      pendingRemoteSync: false,
      pendingRemoteUsers: new Set(),
      linkedContextRenderVersion: 0,
      renderSectionKeys: null,
      sortBy: this._defaultSortBy,
      sortDir: this._defaultSortDir,
      sortMenuOpen: false,
      sortMenuDismissHandler: null,
      sortMenuKeyHandler: null,
      queryFilterTimer: null,
      queryFilterSeq: 0,
      queryFilterState: null,
      contextPreloadTimer: null,
      contextPreloadSeq: 0,
      lastResults: null,
      observer: null,
      refreshTimer: null,
      refreshSeq: 0,
      isLoading: false
    };
  }

  disposePanelState(panelId) {
    const state = this._panelStates.get(panelId) || null;
    if (!state) return;

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }

    if (state.queryFilterTimer) {
      clearTimeout(state.queryFilterTimer);
      state.queryFilterTimer = null;
    }

    if (state.contextPreloadTimer) {
      clearTimeout(state.contextPreloadTimer);
      state.contextPreloadTimer = null;
    }
    state.contextPreloadSeq = (state.contextPreloadSeq || 0) + 1;

    try {
      state.observer?.disconnect?.();
    } catch (e) {
      // ignore
    }
    state.observer = null;

    this.setSortMenuOpen(state, false);
    this.setSearchAutocompleteOpen(state, false);

    try {
      state.rootEl?.remove?.();
    } catch (e) {
      // ignore
    }

    this._panelStates.delete(panelId);
  }

  unmountFooterForHiddenPanel(state) {
    if (!state) return;

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }

    if (state.queryFilterTimer) {
      clearTimeout(state.queryFilterTimer);
      state.queryFilterTimer = null;
    }

    if (state.contextPreloadTimer) {
      clearTimeout(state.contextPreloadTimer);
      state.contextPreloadTimer = null;
    }
    state.contextPreloadSeq = (state.contextPreloadSeq || 0) + 1;

    try {
      state.observer?.disconnect?.();
    } catch (e) {
      // ignore
    }
    state.observer = null;

    this.setSortMenuOpen(state, false);
    this.setSearchAutocompleteOpen(state, false);

    try {
      state.rootEl?.remove?.();
    } catch (e) {
      // ignore
    }

    state.mountedIn = null;
    state.rootEl = null;
    state.bodyEl = null;
    state.statusSlotEl = null;
    state.propertySlotEl = null;
    state.linkedSlotEl = null;
    state.unlinkedSlotEl = null;
    state.countEl = null;
    state.footerToggleEl = null;
    state.sortToggleEl = null;
    state.sortMenuEl = null;
    state.searchToggleEl = null;
    state.searchRowEl = null;
    state.searchWrapEl = null;
    state.searchInputEl = null;
    state.searchHighlightTextEl = null;
    state.searchClearEl = null;
    state.searchRefreshEl = null;
    state.searchAutocompleteEl = null;
    state.renderSectionKeys = null;
  }

  // ---------- Mounting ----------

  mountFooter(panel, state) {
    if (!this.isPanelVisible(panel)) {
      this.unmountFooterForHiddenPanel(state);
      return;
    }

    const panelEl = panel?.getElement?.() || null;
    if (!panelEl) return;

    const container = this.findMountContainer(panelEl);
    if (!container) return;

    // If Thymer re-rendered and dropped our node, rebuild.
    const needsRebuild = !state.rootEl || !state.rootEl.isConnected;
    if (needsRebuild) {
      state.rootEl = this.buildFooterRoot(state);
      state.bodyEl = state.rootEl.querySelector('[data-role="body"]');
      state.statusSlotEl = state.rootEl.querySelector('[data-role="status-slot"]');
      state.propertySlotEl = state.rootEl.querySelector('[data-role="property-slot"]');
      state.linkedSlotEl = state.rootEl.querySelector('[data-role="linked-slot"]');
      state.unlinkedSlotEl = state.rootEl.querySelector('[data-role="unlinked-slot"]');
      state.countEl = state.rootEl.querySelector('[data-role="count"]');
      state.renderSectionKeys = null;
      this.setSearchOpen(state, state.searchOpen === true || Boolean((state.searchQuery || '').trim()));
      this.syncSearchAutocompleteControlState(state);
      this.renderSearchAutocomplete(state);
      this.setSearchAutocompleteOpen(state, state.searchOpen === true && state.searchAutocompleteOpen === true);
      this.renderSortMenu(state);
      this.syncSortControlState(state);
      this.setSortMenuOpen(state, state.sortMenuOpen === true);
      if (state.lastResults) {
        this.renderReferences(state, state.lastResults);
      }
    }

    // Ensure it is mounted in the right container.
    if (state.rootEl && state.rootEl.parentElement !== container) {
      container.appendChild(state.rootEl);
      state.mountedIn = container;
    }

    this.renderSortMenu(state);
    this.syncSortControlState(state);

    // If the container/panel DOM churns, remount when our root disappears.
    if (!state.observer) {
      state.observer = new MutationObserver(() => {
        if (state.rootEl && !state.rootEl.isConnected) {
          // Remount on next tick so we don't fight Thymer's own DOM updates.
          setTimeout(() => this.mountFooter(panel, state), 0);
        }
      });
      state.observer.observe(panelEl, { childList: true, subtree: true });
    }
  }

  findMountContainer(panelEl) {
    return this.findMountContainerDetails(panelEl).element || null;
  }

  findMountContainerDetails(panelEl) {
    if (!panelEl) return { element: null, selector: null };

    const checks = ['.page-content', '.editor-wrapper', '.editor-panel', '#editor'];
    for (const selector of checks) {
      if (panelEl?.matches?.(selector)) return { element: panelEl, selector };
      const child = panelEl.querySelector?.(selector) || null;
      if (child) return { element: child, selector };
    }

    return { element: null, selector: null };
  }

  buildFooterRoot(state) {
    const root = document.createElement('div');
    root.className = 'tlr-footer form-field-group';
    root.dataset.panelId = state.panelId;

    const headerField = document.createElement('div');
    headerField.className = 'tlr-header-field form-field';

    const header = document.createElement('div');
    header.className = 'tlr-header form-field-row';

    const headerMain = document.createElement('div');
    headerMain.className = 'tlr-header-main';

    const headerControls = document.createElement('div');
    headerControls.className = 'tlr-header-controls';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'tlr-btn tlr-toggle tlr-section-toggle button-none button-small button-minimal-hover';
    toggleBtn.type = 'button';
    toggleBtn.dataset.action = 'toggle';
    toggleBtn.title = 'Collapse/expand';
    toggleBtn.setAttribute('aria-label', 'Collapse');
    toggleBtn.setAttribute('aria-expanded', 'true');
    toggleBtn.appendChild(this.buildChevronIcon(false, 'tlr-toggle-caret'));

    const title = document.createElement('div');
    title.className = 'tlr-title tlr-section-title text-details';
    title.textContent = 'Backreferences';

    const count = document.createElement('div');
    count.className = 'tlr-count text-details';
    count.dataset.role = 'count';
    count.textContent = '';

    const filterWrap = document.createElement('div');
    filterWrap.className = 'tlr-filter-wrap';

    const filterToggle = document.createElement('button');
    filterToggle.className = 'tlr-btn tlr-filter-toggle tlr-search-toggle button-none button-small button-minimal-hover tooltip id--filter-button';
    filterToggle.type = 'button';
    filterToggle.dataset.action = 'toggle-search';
    filterToggle.setAttribute('aria-expanded', state.searchOpen === true ? 'true' : 'false');
    filterToggle.setAttribute('aria-label', 'Filter');
    filterToggle.setAttribute('data-tooltip', 'Filter');
    filterToggle.setAttribute('data-tooltip-dir', 'top');
    try {
      const filterIcon = this.ui.createIcon('ti-filter');
      filterIcon.classList.add('id--filter-icon');
      filterToggle.appendChild(filterIcon);
    } catch (e) {
      filterToggle.textContent = 'Filter';
    }
    filterWrap.appendChild(filterToggle);

    const searchRow = document.createElement('div');
    searchRow.className = 'tlr-search-row form-field';

    const searchRowInner = document.createElement('div');
    searchRowInner.className = 'tlr-search-row-inner form-field-row';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'tlr-search-wrap tlr-query-input query-input';

    const queryWrap = document.createElement('div');
    queryWrap.className = 'query-input--wrapper';

    const highlight = document.createElement('div');
    highlight.className = 'query-input--highlight';

    const highlightText = document.createElement('span');
    highlight.appendChild(highlightText);

    const input = document.createElement('input');
    input.className = 'tlr-search-input query-input--field w-full form-input is-collection-filter';
    input.type = 'text';
    input.name = 'backreferences-filter';
    input.placeholder = 'Search text, or use @Collection.property = "value"';
    input.title = 'Search current backreferences with plain text, or use Thymer query syntax like @Collection.property = "value" and AND/OR/NOT';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = state.searchQuery || '';

    const stopKeys = (e) => {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    };

    input.addEventListener('keydown', (e) => {
      stopKeys(e);
      if (state.searchAutocompleteOpen === true) {
        if (e.key === 'ArrowDown') {
          e.preventDefault();
          this.moveSearchAutocompleteSelection(state, 1);
          return;
        }
        if (e.key === 'ArrowUp') {
          e.preventDefault();
          this.moveSearchAutocompleteSelection(state, -1);
          return;
        }
        if (e.key === 'Tab') {
          e.preventDefault();
          this.applySelectedSearchAutocompleteItem(state);
          return;
        }
        if (e.key === 'Enter') {
          e.preventDefault();
          this.applySelectedSearchAutocompleteItem(state);
          return;
        }
        if (e.key === 'Escape') {
          e.preventDefault();
          this.setSearchAutocompleteOpen(state, false);
          return;
        }
      }

      if (e.key === 'Escape') {
        e.preventDefault();
        const q = (state.searchQuery || '').trim();
        if (q) {
          state.searchQuery = '';
          input.value = '';
          this.handleSearchQueryChanged(state, { immediate: true });
        } else {
          input.blur();
        }
        return;
      }

      if (e.key === 'Enter') {
        const mode = this.getSearchMode(state.searchQuery || '');
        if (mode === 'query') {
          if (this.isIncompleteQueryDraft(state.searchQuery || '')) return;
          e.preventDefault();
          this.scheduleQueryFilterRefresh(state, { immediate: true, reason: 'enter' });
        }
      }
    });

    input.addEventListener('focus', () => {
      this.updateSearchFieldState(state);
      this.updateSearchAutocomplete(state);
    });

    input.addEventListener('click', () => {
      this.updateSearchFieldState(state);
      this.updateSearchAutocomplete(state);
    });

    input.addEventListener('blur', () => {
      this.updateSearchFieldState(state);
    });

    input.addEventListener('keyup', (e) => {
      if (e.key === 'ArrowDown' || e.key === 'ArrowUp' || e.key === 'Enter' || e.key === 'Tab' || e.key === 'Escape') {
        return;
      }
      this.updateSearchFieldState(state);
      this.updateSearchAutocomplete(state);
    });

    input.addEventListener('input', () => {
      state.searchQuery = input.value;
      this.updateSearchFieldState(state);
      this.handleSearchQueryChanged(state, { immediate: false });
      this.updateSearchAutocomplete(state);
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'tlr-search-clear query-input--clear-btn button-none button-small button-minimal-hover tooltip';
    clearBtn.type = 'button';
    clearBtn.dataset.action = 'clear-search';
    clearBtn.setAttribute('aria-label', 'Clear search');
    clearBtn.setAttribute('data-tooltip', 'Clear search');
    clearBtn.setAttribute('data-tooltip-dir', 'top');
    try {
      clearBtn.appendChild(this.ui.createIcon('ti-x'));
    } catch (e) {
      clearBtn.textContent = 'x';
    }

    const refreshBtn = document.createElement('button');
    refreshBtn.className = 'tlr-search-refresh query-input--refresh-btn button-none button-small button-minimal-hover tooltip';
    refreshBtn.type = 'button';
    refreshBtn.dataset.action = 'refresh-search';
    refreshBtn.setAttribute('aria-label', 'Refresh now');
    refreshBtn.setAttribute('data-tooltip', 'Refresh now');
    refreshBtn.setAttribute('data-tooltip-dir', 'top');
    try {
      refreshBtn.appendChild(this.ui.createIcon('ti-refresh'));
    } catch (e) {
      refreshBtn.textContent = 'Refresh';
    }

    const autocomplete = document.createElement('div');
    autocomplete.className = 'tlr-search-autocomplete cmdpal--inline dropdown active focused-component';
    autocomplete.setAttribute('role', 'listbox');

    queryWrap.appendChild(highlight);
    queryWrap.appendChild(input);
    queryWrap.appendChild(clearBtn);
    queryWrap.appendChild(refreshBtn);
    searchWrap.appendChild(queryWrap);
    searchWrap.appendChild(autocomplete);

    const sortWrap = document.createElement('div');
    sortWrap.className = 'tlr-sort-wrap';

    const sortToggle = document.createElement('button');
    sortToggle.className = 'tlr-btn tlr-sort-toggle button-none button-small button-minimal-hover';
    sortToggle.type = 'button';
    sortToggle.dataset.action = 'toggle-sort-menu';
    sortToggle.setAttribute('aria-label', 'Sort options');
    sortToggle.setAttribute('aria-haspopup', 'menu');
    sortToggle.setAttribute('aria-expanded', state.sortMenuOpen === true ? 'true' : 'false');
    sortToggle.title = 'Sort options';
    const sortGlyph = document.createElement('span');
    sortGlyph.className = 'tlr-sort-glyph';
    sortGlyph.setAttribute('aria-hidden', 'true');
    const sortBars = document.createElement('span');
    sortBars.className = 'tlr-sort-glyph-bars';
    const sortArrows = document.createElement('span');
    sortArrows.className = 'tlr-sort-glyph-arrows';
    sortGlyph.appendChild(sortBars);
    sortGlyph.appendChild(sortArrows);
    sortToggle.appendChild(sortGlyph);

    const sortMenu = document.createElement('div');
    sortMenu.className = 'tlr-sort-menu cmdpal--inline dropdown active focused-component';
    sortMenu.setAttribute('role', 'menu');
    sortMenu.setAttribute('aria-label', 'Backreferences sort options');

    sortWrap.appendChild(sortToggle);
    sortWrap.appendChild(sortMenu);

    headerMain.appendChild(toggleBtn);
    headerMain.appendChild(title);
    headerMain.appendChild(count);

    headerControls.appendChild(filterWrap);
    headerControls.appendChild(sortWrap);

    header.appendChild(headerMain);
    header.appendChild(headerControls);
    headerField.appendChild(header);

    const body = document.createElement('div');
    body.className = 'tlr-body';
    body.dataset.role = 'body';

    const statusSlot = document.createElement('div');
    statusSlot.className = 'tlr-status-slot';
    statusSlot.dataset.role = 'status-slot';

    const propertySlot = document.createElement('div');
    propertySlot.className = 'tlr-section-slot tlr-section-slot-property';
    propertySlot.dataset.role = 'property-slot';

    const linkedSlot = document.createElement('div');
    linkedSlot.className = 'tlr-section-slot tlr-section-slot-linked';
    linkedSlot.dataset.role = 'linked-slot';

    const unlinkedSlot = document.createElement('div');
    unlinkedSlot.className = 'tlr-section-slot tlr-section-slot-unlinked';
    unlinkedSlot.dataset.role = 'unlinked-slot';

    searchRowInner.appendChild(searchWrap);
    searchRow.appendChild(searchRowInner);
    root.appendChild(headerField);
    root.appendChild(searchRow);
    body.appendChild(statusSlot);
    body.appendChild(propertySlot);
    this.appendReferenceDivider(body);
    body.appendChild(linkedSlot);
    this.appendReferenceDivider(body);
    body.appendChild(unlinkedSlot);
    root.appendChild(body);

    root.addEventListener('click', (e) => this.handleFooterClick(e));

    state.rootEl = root;
    state.footerToggleEl = toggleBtn;
    this.syncFooterCollapsedState(state, this.isFooterCollapsed(state, this.getCollapseMetrics(state.lastResults)));
    root.classList.toggle('tlr-sort-open', state.sortMenuOpen === true);

    state.sortToggleEl = sortToggle;
    state.sortMenuEl = sortMenu;
    state.searchToggleEl = filterToggle;
    state.searchRowEl = searchRow;
    state.searchWrapEl = searchWrap;
    state.searchInputEl = input;
    state.searchHighlightTextEl = highlightText;
    state.searchClearEl = clearBtn;
    state.searchRefreshEl = refreshBtn;
    state.searchAutocompleteEl = autocomplete;
    state.statusSlotEl = statusSlot;
    state.propertySlotEl = propertySlot;
    state.linkedSlotEl = linkedSlot;
    state.unlinkedSlotEl = unlinkedSlot;
    state.renderSectionKeys = null;
    return root;
  }

  // ---------- Click handling ----------

  handleFooterClick(e) {
    const root = e.currentTarget;
    if (!root) return;

    const actionEl = e.target?.closest?.('[data-action]') || null;
    if (!actionEl) return;

    const action = actionEl.dataset.action || '';
    const panelId = root.dataset.panelId || null;
    if (!panelId) return;

    const state = this._panelStates.get(panelId) || null;

    if (action === 'toggle') {
      if (!state) return;
      const nextCollapsed = !this.isFooterCollapsed(state, this.getCollapseMetrics(state.lastResults));
      this.applyFooterCollapsedPreferenceForRecord(state.recordGuid, nextCollapsed);
      return;
    }

    if (action === 'toggle-prop-group') {
      const propName = (actionEl.dataset.propName || '').trim();
      if (!propName) return;

      const groupEl = actionEl.closest?.('.tlr-prop-group') || null;
      const isCollapsed = groupEl ? groupEl.classList.contains('tlr-prop-collapsed') : this.isPropGroupCollapsed(propName);
      const nextCollapsed = !isCollapsed;

      this.setPropGroupCollapsed(propName, nextCollapsed);
      if (groupEl) groupEl.classList.toggle('tlr-prop-collapsed', nextCollapsed);
      const propControls = groupEl?.querySelectorAll?.('[data-action="toggle-prop-group"]') || [];
      propControls.forEach((el) => {
        el.setAttribute?.('aria-expanded', nextCollapsed ? 'false' : 'true');
        if (el.classList?.contains?.('tlr-prop-toggle')) {
          el.title = nextCollapsed ? 'Expand' : 'Collapse';
          el.setAttribute?.('aria-label', nextCollapsed ? 'Expand' : 'Collapse');
        }
      });
      this.syncChevronIcon(groupEl?.querySelector?.('.tlr-prop-caret') || null, nextCollapsed);
      return;
    }

    if (action === 'toggle-record-group') {
      const sectionId = this.normalizeRecordGroupSectionId(actionEl.dataset.groupSectionId);
      const recordGuid = (actionEl.dataset.recordGuid || '').trim();
      const targetRecordGuid = (actionEl.dataset.targetRecordGuid || state?.recordGuid || '').trim();
      if (!sectionId || !recordGuid || !targetRecordGuid) return;

      const groupEl = actionEl.closest?.('.tlr-group') || null;
      const isCollapsed = groupEl ? groupEl.classList.contains('tlr-group-collapsed') : this.isRecordGroupCollapsed(sectionId, targetRecordGuid, recordGuid);
      const nextCollapsed = !isCollapsed;

      this.setRecordGroupCollapsed(sectionId, targetRecordGuid, recordGuid, nextCollapsed);
      if (groupEl) groupEl.classList.toggle('tlr-group-collapsed', nextCollapsed);
      actionEl.setAttribute?.('aria-expanded', nextCollapsed ? 'false' : 'true');
      actionEl.title = nextCollapsed ? 'Expand' : 'Collapse';
      actionEl.setAttribute?.('aria-label', nextCollapsed ? 'Expand' : 'Collapse');
      this.syncChevronIcon(actionEl.querySelector?.('.tlr-group-caret') || null, nextCollapsed);
      return;
    }

    if (action === 'toggle-section') {
      if (!state) return;
      const sectionId = this.normalizeSectionId(actionEl.dataset.sectionId);
      if (!sectionId) return;

      const nextCollapsed = !this.isSectionCollapsed(state, sectionId, this.getCollapseMetrics(state.lastResults));
      this.applySectionCollapsedPreferenceForRecord(state.recordGuid, sectionId, nextCollapsed);
      return;
    }

    if (action === 'toggle-search') {
      if (!state) return;
      this.setSearchOpen(state, state.searchOpen !== true);
      return;
    }

    if (action === 'toggle-sort-menu') {
      if (!state) return;
      if (state.sortMenuOpen === true) {
        this.setSortMenuOpen(state, false);
      } else {
        this.setSortMenuOpen(state, true);
      }
      return;
    }

    if (action === 'refresh-search') {
      if (!state) return;
      this.scheduleRefreshForPanel(state.panel, { force: true, reason: 'search-refresh' });
      return;
    }

    if (action === 'rebuild-property-index') {
      this.rebuildPropertyIndex({ reason: 'footer-rebuild-index' }).catch(() => {
        // The error state is rendered in the footer.
      });
      return;
    }

    if (action === 'set-sort-by') {
      if (!state) return;
      const nextSortBy = this.normalizeSortBy(actionEl.dataset.sortBy);
      if (!nextSortBy) return;
      this.applySortPreferenceForRecord(state.recordGuid, nextSortBy, state.sortDir);
      this.setSortMenuOpen(state, true);
      return;
    }

    if (action === 'set-sort-dir') {
      if (!state) return;
      const nextSortDir = this.normalizeSortDir(actionEl.dataset.sortDir);
      if (!nextSortDir) return;
      this.applySortPreferenceForRecord(state.recordGuid, state.sortBy, nextSortDir);
      this.setSortMenuOpen(state, true);
      return;
    }

    if (action === 'clear-search') {
      if (!state) return;
      const q = (state.searchQuery || '').trim();
      if (q) {
        state.searchQuery = '';
        if (state.searchInputEl) state.searchInputEl.value = '';
        this.handleSearchQueryChanged(state, { immediate: true, keepFocus: true });
      } else {
        state.searchInputEl?.blur?.();
      }
      return;
    }

    if (
      action === 'toggle-context-more' ||
      action === 'toggle-context-above' ||
      action === 'toggle-context-below'
    ) {
      if (!state) return;
      this.handleLinkedContextAction(
        state,
        action,
        actionEl.dataset.lineGuid || null
      ).catch(() => {
        // ignore
      });
      return;
    }

    if (action === 'link-unlinked') {
      if (!state) return;
      const lineGuid = actionEl.dataset.lineGuid || null;
      if (!lineGuid) return;
      this.setSortMenuOpen(state, false);
      this.linkUnlinkedReference(state, lineGuid).catch(() => {
        // ignore
      });
      return;
    }

    const panel = state?.panel || null;
    if (!panel) return;

    if (action === 'open-record') {
      const guid = actionEl.dataset.recordGuid || null;
      if (!guid) return;
      this.setSortMenuOpen(state, false);
      this.openRecord(panel, guid, null, e);
      return;
    }

    if (action === 'open-line') {
      const guid = actionEl.dataset.recordGuid || null;
      const lineGuid = actionEl.dataset.lineGuid || null;
      if (!guid) return;
      this.setSortMenuOpen(state, false);
      this.openRecord(panel, guid, lineGuid || null, e);
      return;
    }

    if (action === 'open-ref') {
      const guid = actionEl.dataset.refGuid || null;
      if (!guid) return;
      this.setSortMenuOpen(state, false);
      this.openRecord(panel, guid, null, e);
      return;
    }
  }

  navigatePanelToRecord(panel, recordGuid, lineGuid, workspaceGuid) {
    if (!lineGuid) {
      panel.navigateTo({
        type: 'edit_panel',
        rootId: recordGuid,
        subId: null,
        workspaceGuid
      });
      return Promise.resolve(true);
    }

    try {
      const result = panel.navigateTo({
        itemGuid: lineGuid,
        highlight: true
      });

      if (result && typeof result.then === 'function') {
        return result.then((found) => found !== false);
      }

      return Promise.resolve(result !== false);
    } catch (_err) {
      return Promise.resolve(false);
    }
  }

  waitForPanelNavigationFrame() {
    return new Promise((resolve) => {
      if (typeof requestAnimationFrame === 'function') {
        requestAnimationFrame(() => resolve());
        return;
      }
      setTimeout(resolve, 0);
    });
  }

  waitForPanelRecord(panel, recordGuid, timeoutMs = 1800) {
    return new Promise((resolve) => {
      const startedAt = Date.now();

      const check = () => {
        const activeRecordGuid = panel?.getActiveRecord?.()?.guid || null;
        if (activeRecordGuid && (!recordGuid || activeRecordGuid === recordGuid)) {
          resolve(true);
          return;
        }

        if ((Date.now() - startedAt) >= timeoutMs) {
          resolve(false);
          return;
        }

        if (typeof requestAnimationFrame === 'function') {
          requestAnimationFrame(check);
          return;
        }

        setTimeout(check, 16);
      };

      check();
    });
  }

  async openRecord(panel, recordGuid, lineGuid, e) {
    const workspaceGuid = this.getWorkspaceGuid?.() || null;
    if (!workspaceGuid) return;

    const openInNew = e?.metaKey || e?.ctrlKey;

    if (openInNew) {
      try {
        const newPanel = await this.ui.createPanel({ afterPanel: panel });
        if (!newPanel) return;
        this.ui.setActivePanel(newPanel);
        await this.waitForPanelNavigationFrame();
        await this.navigatePanelToRecord(newPanel, recordGuid, null, workspaceGuid);
        await this.waitForPanelRecord(newPanel, recordGuid);

        if (lineGuid) {
          await this.navigatePanelToRecord(newPanel, recordGuid, lineGuid, workspaceGuid);
          await this.waitForPanelNavigationFrame();
          await this.waitForPanelNavigationFrame();
        }
      } catch (_err) {
        // ignore
      }
      return;
    }

    this.navigatePanelToRecord(panel, recordGuid, lineGuid || null, workspaceGuid);
    this.ui.setActivePanel(panel);
  }

  applyCollapsedState(root, collapsed) {
    if (!root) return;
    root.classList.toggle('tlr-collapsed', collapsed === true);
  }

  createDefaultSectionCollapsedState() {
    return {};
  }

  cloneSectionCollapsedState(sectionCollapsed) {
    const out = {};
    for (const id of ['property', 'linked', 'unlinked']) {
      if (typeof sectionCollapsed?.[id] === 'boolean') out[id] = sectionCollapsed[id];
    }
    return out;
  }

  getCollapseMetrics(results) {
    if (!results || typeof results !== 'object') {
      return {
        ready: false,
        propertyCount: 0,
        linkedCount: 0,
        unlinkedCount: 0,
        propertyError: false,
        linkedError: false,
        unlinkedError: false,
        propertyIndexPending: false,
        propertyIndexError: false,
        unlinkedDeferred: false
      };
    }

    const propertyGroups = Array.isArray(results.propertyGroups) ? results.propertyGroups : [];
    const linkedGroups = Array.isArray(results.linkedGroups) ? results.linkedGroups : [];
    const unlinkedGroups = Array.isArray(results.unlinkedGroups) ? results.unlinkedGroups : [];

    return {
      ready: true,
      propertyCount: propertyGroups.reduce((n, group) => n + (group?.records?.length || 0), 0),
      linkedCount: this.countLinkedReferences(linkedGroups),
      unlinkedCount: this.countLinkedReferences(unlinkedGroups),
      propertyError: Boolean(results.propertyError),
      linkedError: Boolean(results.linkedError),
      unlinkedError: Boolean(results.unlinkedError),
      propertyIndexPending: results.propertyIndexStatus === 'idle' || results.propertyIndexStatus === 'indexing',
      propertyIndexError: results.propertyIndexStatus === 'error',
      unlinkedDeferred: results.unlinkedDeferred === true
    };
  }

  getDefaultFooterCollapsed(metrics) {
    if (!metrics?.ready) return false;
    if (metrics.propertyError || metrics.linkedError || metrics.propertyIndexPending || metrics.propertyIndexError) return false;
    return (metrics.propertyCount + metrics.linkedCount) === 0;
  }

  isFooterCollapsed(state, metrics) {
    if (state?.footerCollapsed === true || state?.footerCollapsed === false) {
      return state.footerCollapsed;
    }
    return this.getDefaultFooterCollapsed(metrics);
  }

  syncFooterCollapsedState(state, collapsed) {
    if (!state?.rootEl) return;
    const nextCollapsed = collapsed === true;
    this.applyCollapsedState(state.rootEl, nextCollapsed);
    if (state.searchRowEl) {
      state.searchRowEl.style.display = state.searchOpen === true && nextCollapsed !== true ? 'block' : 'none';
    }

    const btn = state.footerToggleEl || state.rootEl.querySelector?.('[data-action="toggle"]') || null;
    if (!btn) return;
    btn.title = nextCollapsed ? 'Expand' : 'Collapse';
    btn.setAttribute('aria-label', nextCollapsed ? 'Expand' : 'Collapse');
    btn.setAttribute('aria-expanded', nextCollapsed ? 'false' : 'true');
    this.syncChevronIcon(btn.querySelector?.('.tlr-toggle-caret') || null, nextCollapsed);
  }

  normalizeSectionId(sectionId) {
    return sectionId === 'property' || sectionId === 'linked' || sectionId === 'unlinked'
      ? sectionId
      : null;
  }

  getDefaultSectionCollapsed(sectionId, metrics) {
    const id = this.normalizeSectionId(sectionId);
    if (!id) return false;
    if (!metrics?.ready) return false;
    const isTrulyEmpty = !metrics.propertyError
      && !metrics.linkedError
      && !metrics.unlinkedError
      && !metrics.propertyIndexPending
      && !metrics.propertyIndexError
      && metrics.propertyCount === 0
      && metrics.linkedCount === 0
      && metrics.unlinkedCount === 0;
    if (isTrulyEmpty) {
      if (id === 'unlinked') return metrics.unlinkedDeferred === true;
      return false;
    }
    if (id === 'unlinked') return true;
    if (id === 'property') return (metrics.propertyError || metrics.propertyIndexPending || metrics.propertyIndexError)
      ? false
      : metrics.propertyCount === 0;
    if (id === 'linked') return metrics.linkedError ? false : metrics.linkedCount === 0;
    return false;
  }

  isSectionCollapsed(state, sectionId, metrics) {
    const id = this.normalizeSectionId(sectionId);
    if (!id) return false;
    const current = state?.sectionCollapsed?.[id];
    if (typeof current === 'boolean') return current;
    return this.getDefaultSectionCollapsed(id, metrics);
  }

  setSectionCollapsed(state, sectionId, collapsed) {
    if (!state) return;
    const id = this.normalizeSectionId(sectionId);
    if (!id) return;
    if (!state.sectionCollapsed || typeof state.sectionCollapsed !== 'object') {
      state.sectionCollapsed = this.createDefaultSectionCollapsedState();
    }
    state.sectionCollapsed[id] = collapsed === true;
  }

  getSearchMode(rawQuery) {
    const query = (rawQuery || '').trim();
    if (!query) return 'none';
    if (query.includes('@') || query.includes('#') || query.includes('"')) return 'query';
    if (query.includes('(') || query.includes(')')) return 'query';
    if (query.includes('&&') || query.includes('||')) return 'query';
    if (/\b(?:AND|OR|NOT)\b/.test(query)) return 'query';
    return 'text';
  }

  getQueryAutocompleteCatalogSync() {
    return this._queryAutocompleteCatalog || {
      collections: [],
      users: []
    };
  }

  async ensureQueryAutocompleteCatalog() {
    if (this._queryAutocompleteCatalog) return this._queryAutocompleteCatalog;
    if (this._queryAutocompleteCatalogPromise) return this._queryAutocompleteCatalogPromise;

    this._queryAutocompleteCatalogPromise = (async () => {
      let collections = [];
      try {
        collections = await this.data.getAllCollections();
      } catch (e) {
        collections = [];
      }

      const catalogCollections = [];
      for (const collection of collections || []) {
        const name = (collection?.getName?.() || '').trim();
        const guid = (collection?.getGuid?.() || '').trim();
        if (!name || !guid) continue;

        const config = collection?.getConfiguration?.() || null;
        const fields = [];
        for (const field of config?.fields || []) {
          const label = (field?.label || '').trim();
          if (!label || field?.active === false) continue;
          fields.push({
            id: (field?.id || '').trim(),
            label,
            type: (field?.type || '').trim()
          });
        }

        fields.sort((a, b) => a.label.localeCompare(b.label));
        catalogCollections.push({ name, guid, fields });
      }

      catalogCollections.sort((a, b) => a.name.localeCompare(b.name));

      const catalogUsers = [];
      for (const user of this.data.getActiveUsers?.() || []) {
        const name = (user?.getDisplayName?.() || '').trim();
        const guid = (user?.guid || '').trim();
        if (!name || !guid) continue;
        catalogUsers.push({ name, guid });
      }

      catalogUsers.sort((a, b) => a.name.localeCompare(b.name));

      this._queryAutocompleteCatalog = {
        collections: catalogCollections,
        users: catalogUsers
      };
      this._queryAutocompleteCatalogPromise = null;
      return this._queryAutocompleteCatalog;
    })();

    return this._queryAutocompleteCatalogPromise;
  }

  quoteQueryIdentifier(name) {
    const value = String(name || '');
    return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  formatQueryIdentifier(name) {
    const value = String(name || '').trim();
    if (!value) return '';
    return /^[A-Za-z0-9_]+$/.test(value) ? value : this.quoteQueryIdentifier(value);
  }

  getBuiltInQueryKeys() {
    return Array.from(this._queryBuiltInKeys || []);
  }

  getStandaloneQueryFilters() {
    return Array.from(this._queryStandaloneFilters || []);
  }

  isBuiltInQueryKey(name) {
    const value = String(name || '').trim().toLowerCase();
    return value ? this._queryBuiltInKeys.includes(value) : false;
  }

  isQueryOperatorToken(token) {
    return token === '=' || token === '!=' || token === '<' || token === '<=' || token === '>' || token === '>=';
  }

  buildSearchAutocompleteItem({ label, icon, detail, insertText, replaceStart, replaceEnd } = {}) {
    return {
      label: String(label || ''),
      icon: icon || null,
      detail: String(detail || ''),
      insertText: String(insertText || ''),
      replaceStart: Number.isFinite(replaceStart) ? replaceStart : 0,
      replaceEnd: Number.isFinite(replaceEnd) ? replaceEnd : 0
    };
  }

  dedupeSearchAutocompleteItems(items) {
    const out = [];
    const seen = new Set();
    for (const item of items || []) {
      const key = `${item?.label || ''}\n${item?.detail || ''}\n${item?.insertText || ''}\n${item?.replaceStart || 0}\n${item?.replaceEnd || 0}`;
      if (!item?.label || seen.has(key)) continue;
      seen.add(key);
      out.push(item);
    }
    return out;
  }

  parseQueryFieldContext(query, caret) {
    const before = String(query || '').slice(0, caret);
    const match = before.match(/(?:^|[\s(])@(?:("(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+))\.((?:"(?:[^"\\]|\\.)*")|[A-Za-z0-9_]*)$/);
    if (!match) return null;
    const collectionToken = match[1] || '';
    const fieldToken = match[2] || '';
    const replaceEnd = caret;
    const replaceStart = replaceEnd - fieldToken.length;
    const rawCollection = collectionToken.startsWith('"') && collectionToken.endsWith('"')
      ? collectionToken.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : collectionToken;
    const normalizedCollection = rawCollection.trim().toLowerCase();
    return {
      collectionToken,
      collectionName: rawCollection,
      normalizedCollection,
      fieldToken,
      fieldPrefix: fieldToken.startsWith('"') ? fieldToken.slice(1).toLowerCase() : fieldToken.toLowerCase(),
      replaceStart,
      replaceEnd
    };
  }

  parseQueryOperatorContext(query, caret) {
    const before = String(query || '').slice(0, caret);
    const match = before.match(/(?:^|[\s(])@(?:("(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)(?:\.((?:"(?:[^"\\]|\\.)*")|[A-Za-z0-9_]+))?)\s*$/);
    if (!match) return null;

    const keyToken = match[1] || '';
    const fieldToken = match[2] || '';
    const rawKey = keyToken.startsWith('"') && keyToken.endsWith('"')
      ? keyToken.slice(1, -1).replace(/\\"/g, '"').replace(/\\\\/g, '\\')
      : keyToken;
    if (!fieldToken && !this.isBuiltInQueryKey(rawKey)) return null;

    return {
      replaceStart: caret,
      replaceEnd: caret
    };
  }

  parseQueryTokenContext(query, caret) {
    const before = String(query || '').slice(0, caret);
    const match = before.match(/(?:^|[\s(])@((?:"(?:[^"\\]|\\.)*")|[^\s()]*)$/);
    if (!match) return null;
    const token = match[1] || '';
    if (token.includes('.')) return null;
    const replaceEnd = caret;
    const replaceStart = replaceEnd - token.length;
    const unquoted = token.startsWith('"') ? token.slice(1) : token;
    return {
      token,
      prefix: unquoted.toLowerCase(),
      replaceStart,
      replaceEnd,
      quoted: token.startsWith('"')
    };
  }

  getSearchAutocompleteItems(query, caret, catalog) {
    const items = [];
    const fieldContext = this.parseQueryFieldContext(query, caret);
    if (fieldContext) {
      const collection = (catalog?.collections || []).find((entry) => entry.name.trim().toLowerCase() === fieldContext.normalizedCollection) || null;
      const exactFieldMatch = (collection?.fields || []).some((field) => field.label.trim().toLowerCase() === fieldContext.fieldPrefix.trim().toLowerCase());
      const isOpenQuotedField = fieldContext.fieldToken.startsWith('"') && !fieldContext.fieldToken.endsWith('"');
      if (fieldContext.fieldToken && exactFieldMatch && !isOpenQuotedField) {
        const operatorItems = [];
        for (const operator of ['=', '!=', '<=', '>=', '<', '>']) {
          operatorItems.push(this.buildSearchAutocompleteItem({
            label: operator,
            icon: 'ti-math-symbols',
            detail: 'Operator',
            insertText: ` ${operator} `,
            replaceStart: caret,
            replaceEnd: caret
          }));
        }
        return operatorItems;
      }
      for (const field of collection?.fields || []) {
        if (fieldContext.fieldPrefix && !field.label.toLowerCase().includes(fieldContext.fieldPrefix)) continue;
        items.push(this.buildSearchAutocompleteItem({
          label: field.label,
          icon: 'ti-columns-2',
          detail: field.type || 'Field',
          insertText: this.formatQueryIdentifier(field.label),
          replaceStart: fieldContext.replaceStart,
          replaceEnd: fieldContext.replaceEnd
        }));
      }
      return this.dedupeSearchAutocompleteItems(items);
    }

    const operatorContext = this.parseQueryOperatorContext(query, caret);
    if (operatorContext) {
      for (const operator of ['=', '!=', '<=', '>=', '<', '>']) {
        items.push(this.buildSearchAutocompleteItem({
          label: operator,
          icon: 'ti-math-symbols',
          detail: 'Operator',
          insertText: ` ${operator} `,
          replaceStart: operatorContext.replaceStart,
          replaceEnd: operatorContext.replaceEnd
        }));
      }
      return items;
    }

    const tokenContext = this.parseQueryTokenContext(query, caret);
    if (!tokenContext) return [];

    for (const keyword of this.getStandaloneQueryFilters()) {
      if (tokenContext.prefix && !keyword.toLowerCase().includes(tokenContext.prefix)) continue;
      items.push(this.buildSearchAutocompleteItem({
        label: `@${keyword}`,
        icon: 'ti-at',
        detail: 'Filter',
        insertText: keyword,
        replaceStart: tokenContext.replaceStart,
        replaceEnd: tokenContext.replaceEnd
      }));
    }

    for (const key of this.getBuiltInQueryKeys()) {
      if (tokenContext.prefix && !key.toLowerCase().includes(tokenContext.prefix)) continue;
      items.push(this.buildSearchAutocompleteItem({
        label: `@${key}`,
        icon: 'ti-key',
        detail: 'Built-in key',
        insertText: key,
        replaceStart: tokenContext.replaceStart,
        replaceEnd: tokenContext.replaceEnd
      }));
    }

    for (const user of catalog?.users || []) {
      if (tokenContext.prefix && !user.name.toLowerCase().includes(tokenContext.prefix)) continue;
      items.push(this.buildSearchAutocompleteItem({
        label: `@${user.name}`,
        icon: 'ti-user',
        detail: 'User',
        insertText: this.formatQueryIdentifier(user.name),
        replaceStart: tokenContext.replaceStart,
        replaceEnd: tokenContext.replaceEnd
      }));
    }

    for (const collection of catalog?.collections || []) {
      if (tokenContext.prefix && !collection.name.toLowerCase().includes(tokenContext.prefix)) continue;
      items.push(this.buildSearchAutocompleteItem({
        label: `@${collection.name}`,
        icon: 'ti-database',
        detail: 'Collection',
        insertText: this.formatQueryIdentifier(collection.name),
        replaceStart: tokenContext.replaceStart,
        replaceEnd: tokenContext.replaceEnd
      }));
    }

    return this.dedupeSearchAutocompleteItems(items).slice(0, 12);
  }

  renderSearchAutocomplete(state) {
    const menu = state?.searchAutocompleteEl || null;
    if (!menu) return;

    menu.innerHTML = '';
    const items = Array.isArray(state.searchAutocompleteItems) ? state.searchAutocompleteItems : [];
    if (state.searchAutocompleteOpen !== true || items.length === 0) return;

    const list = document.createElement('div');
    list.className = 'autocomplete clickable';
    const scroll = document.createElement('div');
    scroll.className = 'vscroll-node';
    const content = document.createElement('div');
    content.className = 'vcontent';
    const scrollbar = document.createElement('div');
    scrollbar.className = 'vscrollbar scrollbar';
    const thumb = document.createElement('div');
    thumb.className = 'vscrollbar-thumb scrollbar-thumb clickable';
    thumb.innerHTML = '&nbsp;';

    items.forEach((item, index) => {
      const row = document.createElement('div');
      row.className = 'autocomplete--option';
      row.dataset.index = String(index);
      row.setAttribute('role', 'option');
      if (index === state.searchAutocompleteSelectedIndex) {
        row.classList.add('autocomplete--option-selected');
      }

      const iconWrap = document.createElement('span');
      iconWrap.className = 'autocomplete--option-icon';
      if (item.icon) {
        try {
          iconWrap.appendChild(this.ui.createIcon(item.icon));
        } catch (e) {
          iconWrap.textContent = '@';
        }
      }

      const label = document.createElement('span');
      label.className = 'autocomplete--option-label';
      label.textContent = item.label;

      const right = document.createElement('span');
      right.className = 'autocomplete--option-right';
      right.textContent = item.detail || '';

      row.appendChild(iconWrap);
      row.appendChild(label);
      row.appendChild(right);

      row.addEventListener('mouseenter', () => {
        if (state.searchAutocompleteSelectedIndex === index) return;
        state.searchAutocompleteSelectedIndex = index;
        this.syncRenderedSearchAutocompleteSelection(state);
      });
      row.addEventListener('mousedown', (e) => {
        e.preventDefault();
      });
      row.addEventListener('click', (e) => {
        e.preventDefault();
        state.searchAutocompleteSelectedIndex = index;
        this.applySelectedSearchAutocompleteItem(state);
      });

      content.appendChild(row);
    });

    scroll.appendChild(content);
    scroll.addEventListener('scroll', () => {
      this.syncSearchAutocompleteScrollbar(state);
    });

    thumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startY = e.clientY;
      const startScrollTop = scroll.scrollTop;
      const onMouseMove = (moveEvent) => {
        const trackHeight = scrollbar.clientHeight || scroll.clientHeight || 0;
        const thumbHeight = thumb.clientHeight || 0;
        const maxThumbTop = Math.max(1, trackHeight - thumbHeight);
        const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        if (maxScrollTop <= 0) return;
        const deltaRatio = (moveEvent.clientY - startY) / maxThumbTop;
        scroll.scrollTop = Math.max(0, Math.min(maxScrollTop, startScrollTop + (deltaRatio * maxScrollTop)));
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseup', onMouseUp, true);
      };

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
    });

    list.appendChild(scroll);
    scrollbar.appendChild(thumb);
    list.appendChild(scrollbar);
    menu.appendChild(list);

    const sync = () => {
      this.scrollSelectedSearchAutocompleteItemIntoView(state);
      this.syncSearchAutocompleteScrollbar(state);
    };
    sync();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(sync);
    } else {
      setTimeout(sync, 0);
    }
  }

  scrollSelectedSearchAutocompleteItemIntoView(state) {
    const menu = state?.searchAutocompleteEl || null;
    const scroll = menu?.querySelector?.('.vscroll-node') || null;
    const selected = menu?.querySelector?.(`.autocomplete--option[data-index="${state?.searchAutocompleteSelectedIndex || 0}"]`) || null;
    if (!scroll || !selected) return;

    const rowTop = selected.offsetTop;
    const rowBottom = rowTop + selected.offsetHeight;
    const viewportTop = scroll.scrollTop;
    const viewportBottom = viewportTop + scroll.clientHeight;
    if (rowTop < viewportTop) {
      scroll.scrollTop = rowTop;
    } else if (rowBottom > viewportBottom) {
      scroll.scrollTop = rowBottom - scroll.clientHeight;
    }
  }

  syncRenderedSearchAutocompleteSelection(state) {
    const menu = state?.searchAutocompleteEl || null;
    if (!menu) return;
    const selectedIndex = state?.searchAutocompleteSelectedIndex || 0;
    const rows = menu.querySelectorAll?.('.autocomplete--option[data-index]') || [];
    rows.forEach((row) => {
      const rowIndex = Number(row.dataset.index);
      row.classList.toggle('autocomplete--option-selected', rowIndex === selectedIndex);
    });
  }

  syncSearchAutocompleteScrollbar(state) {
    const menu = state?.searchAutocompleteEl || null;
    const scroll = menu?.querySelector?.('.vscroll-node') || null;
    const scrollbar = menu?.querySelector?.('.vscrollbar') || null;
    const thumb = menu?.querySelector?.('.vscrollbar-thumb') || null;
    if (!scroll || !scrollbar || !thumb) return;

    const viewportHeight = scroll.clientHeight || 0;
    const scrollHeight = scroll.scrollHeight || 0;
    const trackHeight = scrollbar.clientHeight || viewportHeight;
    if (!viewportHeight || !scrollHeight || !trackHeight || scrollHeight <= viewportHeight + 1) {
      scrollbar.classList.remove('has-thumb');
      thumb.style.height = '0px';
      thumb.style.transform = 'translateY(0px)';
      return;
    }

    const thumbHeight = Math.max(16, Math.round((viewportHeight / scrollHeight) * trackHeight));
    const maxScrollTop = Math.max(1, scrollHeight - viewportHeight);
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxThumbTop * (scroll.scrollTop / maxScrollTop);

    scrollbar.classList.add('has-thumb');
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }

  syncSearchAutocompleteControlState(state) {
    if (!state?.rootEl) return;
    state.rootEl.classList.toggle('tlr-search-autocomplete-open', state.searchAutocompleteOpen === true);
  }

  clearPointerDismissHandler(state, handlerKey) {
    const key = typeof handlerKey === 'string' ? handlerKey.trim() : '';
    if (!state || !key || !state[key]) return;
    try {
      document.removeEventListener('pointerdown', state[key], true);
      document.removeEventListener('mousedown', state[key], true);
    } catch (e) {
      // ignore
    }
    state[key] = null;
  }

  setPointerDismissHandler(state, handlerKey, handler) {
    const key = typeof handlerKey === 'string' ? handlerKey.trim() : '';
    if (!state || !key || typeof handler !== 'function') return;
    this.clearPointerDismissHandler(state, key);
    state[key] = handler;
    try {
      document.addEventListener('pointerdown', handler, true);
      document.addEventListener('mousedown', handler, true);
    } catch (e) {
      // ignore
    }
  }

  setSearchAutocompleteOpen(state, open) {
    if (!state) return;
    state.searchAutocompleteOpen = open === true && (state.searchAutocompleteItems?.length || 0) > 0;

    this.clearPointerDismissHandler(state, 'searchAutocompleteDismissHandler');

    this.syncSearchAutocompleteControlState(state);
    this.renderSearchAutocomplete(state);

    if (state.searchAutocompleteOpen !== true) return;

    const onOutsideMouseDown = (ev) => {
      const menu = state.searchAutocompleteEl || null;
      const input = state.searchInputEl || null;
      const target = ev.target;
      if (!menu || !menu.isConnected || !input || !input.isConnected) {
        this.setSearchAutocompleteOpen(state, false);
        return;
      }
      if (menu.contains(target)) return;
      if (input.contains?.(target)) return;
      this.setSearchAutocompleteOpen(state, false);
    };

    this.setPointerDismissHandler(state, 'searchAutocompleteDismissHandler', onOutsideMouseDown);
  }

  moveSearchAutocompleteSelection(state, delta) {
    const items = state?.searchAutocompleteItems || [];
    if (!state || state.searchAutocompleteOpen !== true || items.length === 0) return;
    const lastIndex = items.length - 1;
    const next = Math.max(0, Math.min(lastIndex, (state.searchAutocompleteSelectedIndex || 0) + delta));
    if (next === state.searchAutocompleteSelectedIndex) return;
    state.searchAutocompleteSelectedIndex = next;
    this.renderSearchAutocomplete(state);
  }

  applySelectedSearchAutocompleteItem(state) {
    const items = state?.searchAutocompleteItems || [];
    const item = items[state?.searchAutocompleteSelectedIndex || 0] || null;
    const input = state?.searchInputEl || null;
    if (!state || !item || !input) return;

    const value = state.searchQuery || '';
    const start = Math.max(0, Math.min(value.length, item.replaceStart || 0));
    const end = Math.max(start, Math.min(value.length, item.replaceEnd || 0));
    const nextValue = `${value.slice(0, start)}${item.insertText}${value.slice(end)}`;
    const caret = start + item.insertText.length;

    state.searchQuery = nextValue;
    input.value = nextValue;
    this.setSearchAutocompleteOpen(state, false);
    this.handleSearchQueryChanged(state, { immediate: false, keepFocus: true });

    setTimeout(() => {
      try {
        input.focus();
        input.setSelectionRange(caret, caret);
      } catch (e) {
        // ignore
      }
      this.updateSearchAutocomplete(state);
    }, 0);
  }

  updateSearchAutocomplete(state) {
    if (!state?.searchInputEl) return;

    const input = state.searchInputEl;
    const query = state.searchQuery || '';
    const caret = Number.isFinite(input.selectionStart) ? input.selectionStart : query.length;
    if (document.activeElement !== input || caret !== query.length) {
      state.searchAutocompleteItems = [];
      state.searchAutocompleteSelectedIndex = 0;
      this.setSearchAutocompleteOpen(state, false);
      return;
    }

    const catalog = this.getQueryAutocompleteCatalogSync();
    const items = this.getSearchAutocompleteItems(query, caret, catalog);
    state.searchAutocompleteItems = items;
    state.searchAutocompleteSelectedIndex = Math.max(0, Math.min(items.length - 1, state.searchAutocompleteSelectedIndex || 0));
    this.setSearchAutocompleteOpen(state, items.length > 0);

    const requestSeq = (state.searchAutocompleteRequestSeq || 0) + 1;
    state.searchAutocompleteRequestSeq = requestSeq;
    this.ensureQueryAutocompleteCatalog()
      .then(() => {
        const liveState = this._panelStates.get(state.panelId) || null;
        if (!liveState || liveState.searchAutocompleteRequestSeq !== requestSeq) return;
        if (document.activeElement !== liveState.searchInputEl) return;
        const liveQuery = liveState.searchQuery || '';
        const liveCaret = Number.isFinite(liveState.searchInputEl?.selectionStart)
          ? liveState.searchInputEl.selectionStart
          : liveQuery.length;
        const liveItems = this.getSearchAutocompleteItems(liveQuery, liveCaret, this.getQueryAutocompleteCatalogSync());
        liveState.searchAutocompleteItems = liveItems;
        liveState.searchAutocompleteSelectedIndex = Math.max(0, Math.min(liveItems.length - 1, liveState.searchAutocompleteSelectedIndex || 0));
        this.setSearchAutocompleteOpen(liveState, liveItems.length > 0);
      })
      .catch(() => {
        // ignore
      });
  }

  isIncompleteQueryDraft(rawQuery) {
    const query = (rawQuery || '').trim();
    if (this.getSearchMode(query) !== 'query') return false;
    if (/(?:^|[\s(])@$/.test(query)) return true;
    if (/(?:^|[\s(])@"(?:[^"\\]|\\.)*$/.test(query)) return true;
    if (/(?:^|[\s(])@(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)\.$/.test(query)) return true;
    if (/(?:^|[\s(])@(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)\.(?:"(?:[^"\\]|\\.)*|[A-Za-z0-9_]*)$/.test(query)) return true;
    if (/(?:^|[\s(])@(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)\.(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)\s*$/.test(query)) return true;
    if (/(?:^|[\s(])@(?:created_at|modified_at|created_by|modified_by|text|type|date|due|time|mention|scheduled|hashtag|link|collection|guid|pguid|rguid|backref|linkto)\s*$/i.test(query)) {
      return true;
    }
    if (/(?:^|[\s(])@(?:(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+)(?:\.(?:"(?:[^"\\]|\\.)*"|[A-Za-z0-9_]+))?)\s*(?:=|!=|<=|>=|<|>)\s*$/i.test(query)) {
      return true;
    }
    return false;
  }

  createQueryFilterState(query, { loading, ready, error, includesUnlinked, matchedRecordGuids, matchedLineGuids, matchedLineRecordGuids } = {}) {
    return {
      query: (query || '').trim(),
      loading: loading === true,
      ready: ready === true,
      error: typeof error === 'string' ? error : '',
      includesUnlinked: includesUnlinked === true,
      matchedRecordGuids: matchedRecordGuids instanceof Set ? matchedRecordGuids : new Set(),
      matchedLineGuids: matchedLineGuids instanceof Set ? matchedLineGuids : new Set(),
      matchedLineRecordGuids: matchedLineRecordGuids instanceof Set ? matchedLineRecordGuids : new Set()
    };
  }

  getQueryFilterState(state, query) {
    const current = state?.queryFilterState || null;
    const normalizedQuery = (query || '').trim();
    if (!current) return null;
    if ((current.query || '') !== normalizedQuery) return null;
    return current;
  }

  clearQueryFilterState(state) {
    if (!state) return;
    if (state.queryFilterTimer) {
      clearTimeout(state.queryFilterTimer);
      state.queryFilterTimer = null;
    }
    state.queryFilterState = null;
  }

  handleSearchQueryChanged(state, { immediate, keepFocus } = {}) {
    if (!state) return;
    this.syncSearchControlState(state);
    this.syncScopedQueryWithCurrentInput(state, { immediate: immediate === true, reason: 'input' });
    this.renderFromCache(state);
    this.updateSearchAutocomplete(state);

    if (keepFocus === true && state.searchInputEl) {
      setTimeout(() => {
        try {
          state.searchInputEl?.focus?.();
        } catch (e) {
          // ignore
        }
      }, 0);
    }
  }

  syncScopedQueryWithCurrentInput(state, { immediate, reason } = {}) {
    if (!state) return;
    const query = (state.searchQuery || '').trim();
    if (this.getSearchMode(query) !== 'query' || this.isIncompleteQueryDraft(query)) {
      this.clearQueryFilterState(state);
      return;
    }
    this.scheduleQueryFilterRefresh(state, { immediate: immediate === true, reason: reason || 'sync' });
  }

  shouldIncludeUnlinkedInQueryScope(state, results) {
    if (!state || !results) return false;
    if (this.isSectionCollapsed(state, 'unlinked')) return false;
    if (results.unlinkedDeferred === true) return false;
    if (results.unlinkedLoading === true) return false;
    return true;
  }

  collectQueryScopeRecordGuids(results, { includeUnlinked } = {}) {
    const out = [];
    const seen = new Set();

    const add = (record) => {
      const guid = (record?.guid || '').trim();
      if (!guid || seen.has(guid)) return;
      seen.add(guid);
      out.push(guid);
    };

    for (const group of results?.propertyGroups || []) {
      for (const record of group?.records || []) add(record);
    }
    for (const group of results?.linkedGroups || []) add(group?.record || null);
    if (includeUnlinked === true) {
      for (const group of results?.unlinkedGroups || []) add(group?.record || null);
    }

    return out;
  }

  filterPropertyGroups(groups, predicate) {
    const match = typeof predicate === 'function' ? predicate : null;
    if (!match) return [];

    const out = [];
    for (const group of groups || []) {
      const propertyName = (group?.propertyName || '').trim();
      if (!propertyName) continue;
      const records = (group?.records || []).filter((record) => match(record, group));
      if (records.length === 0) continue;
      out.push({ propertyName, records });
    }
    return out;
  }

  filterLineGroups(groups, predicate) {
    const match = typeof predicate === 'function' ? predicate : null;
    if (!match) return [];

    const out = [];
    for (const group of groups || []) {
      const record = group?.record || null;
      if (!record?.guid) continue;
      const lines = (group?.lines || []).filter((line) => match(line, record, group));
      if (lines.length === 0) continue;
      out.push({ record, lines });
    }
    return out;
  }

  scheduleQueryFilterRefresh(state, { immediate, reason } = {}) {
    if (!state) return;

    const query = (state.searchQuery || '').trim();
    if (this.getSearchMode(query) !== 'query' || this.isIncompleteQueryDraft(query)) {
      this.clearQueryFilterState(state);
      return;
    }

    const previous = this.getQueryFilterState(state, query);
    state.queryFilterState = previous
      ? this.createQueryFilterState(query, {
          loading: true,
          ready: previous.ready === true,
          error: '',
          includesUnlinked: previous.includesUnlinked === true,
          matchedRecordGuids: previous.matchedRecordGuids,
          matchedLineGuids: previous.matchedLineGuids,
          matchedLineRecordGuids: previous.matchedLineRecordGuids
        })
      : this.createQueryFilterState(query, { loading: true });

    if (state.queryFilterTimer) {
      clearTimeout(state.queryFilterTimer);
      state.queryFilterTimer = null;
    }

    const seq = (state.queryFilterSeq || 0) + 1;
    state.queryFilterSeq = seq;
    const delay = immediate === true ? 0 : this._queryFilterDebounceMs;
    state.queryFilterTimer = setTimeout(() => {
      state.queryFilterTimer = null;
      this.refreshScopedQueryFilter(state.panelId, seq, { reason: reason || 'scheduled-query-filter' }).catch(() => {
        // ignore
      });
    }, delay);
  }

  async refreshScopedQueryFilter(panelId, seq, { reason } = {}) {
    const state = this._panelStates.get(panelId) || null;
    if (!state) return;
    if (state.queryFilterSeq !== seq) return;

    const results = state.lastResults || null;
    const query = (state.searchQuery || '').trim();
    if (!results || this.getSearchMode(query) !== 'query' || this.isIncompleteQueryDraft(query)) {
      this.clearQueryFilterState(state);
      this.renderFromCache(state);
      return;
    }

    const includeUnlinked = this.shouldIncludeUnlinkedInQueryScope(state, results);
    const recordGuids = this.collectQueryScopeRecordGuids(results, { includeUnlinked });
    if (recordGuids.length === 0) {
      if (!this._panelStates.has(panelId)) return;
      state.queryFilterState = this.createQueryFilterState(query, {
        loading: false,
        ready: true,
        includesUnlinked: includeUnlinked
      });
      this.renderFromCache(state);
      return;
    }

    let result = null;
    let error = '';
    try {
      const { queryFilterMaxResults } = this.getRefreshConfig();
      result = await this.data.searchByQuery(query, queryFilterMaxResults);
      if (typeof result?.error === 'string' && result.error.trim()) error = result.error.trim();
    } catch (e) {
      error = 'Could not apply query filter.';
    }

    if (!this._panelStates.has(panelId)) return;
    if (state.queryFilterSeq !== seq) return;
    if ((state.searchQuery || '').trim() !== query) return;

    const latestResults = state.lastResults || results;
    const latestIncludesUnlinked = this.shouldIncludeUnlinkedInQueryScope(state, latestResults);
    const latestScopedRecordGuids = new Set(
      this.collectQueryScopeRecordGuids(latestResults, { includeUnlinked: latestIncludesUnlinked })
    );

    if (latestScopedRecordGuids.size === 0) {
      state.queryFilterState = this.createQueryFilterState(query, {
        loading: false,
        ready: true,
        includesUnlinked: latestIncludesUnlinked
      });
      this.renderFromCache(state);
      return;
    }

    const previous = this.getQueryFilterState(state, query);
    if (error) {
      state.queryFilterState = this.createQueryFilterState(query, {
        loading: false,
        ready: previous?.ready === true,
        error,
        includesUnlinked: latestIncludesUnlinked,
        matchedRecordGuids: previous?.matchedRecordGuids,
        matchedLineGuids: previous?.matchedLineGuids,
        matchedLineRecordGuids: previous?.matchedLineRecordGuids
      });
      this.renderFromCache(state);
      return;
    }

    const matchedRecordGuids = new Set();
    const matchedLineGuids = new Set();
    const matchedLineRecordGuids = new Set();

    for (const record of result?.records || []) {
      const guid = (record?.guid || '').trim();
      if (!guid || !latestScopedRecordGuids.has(guid)) continue;
      matchedRecordGuids.add(guid);
      matchedLineRecordGuids.add(guid);
    }

    for (const line of result?.lines || []) {
      const recordGuid = (line?.getRecord?.()?.guid || '').trim();
      if (!recordGuid || !latestScopedRecordGuids.has(recordGuid)) continue;
      const guid = (line?.guid || '').trim();
      if (guid) matchedLineGuids.add(guid);
      matchedLineRecordGuids.add(recordGuid);
    }

    state.queryFilterState = this.createQueryFilterState(query, {
      loading: false,
      ready: true,
      includesUnlinked: latestIncludesUnlinked,
      matchedRecordGuids,
      matchedLineGuids,
      matchedLineRecordGuids
    });
    this.renderFromCache(state);
  }

  filterPropertyGroupsByScopedQuery(groups, queryFilterState) {
    const matchedRecordGuids = queryFilterState?.matchedRecordGuids || new Set();
    const matchedLineRecordGuids = queryFilterState?.matchedLineRecordGuids || new Set();
    return this.filterPropertyGroups(groups, (record) => {
      const guid = (record?.guid || '').trim();
      if (!guid) return false;
      return matchedRecordGuids.has(guid) || matchedLineRecordGuids.has(guid);
    });
  }

  filterLineGroupsByScopedQuery(groups, queryFilterState) {
    const matchedRecordGuids = queryFilterState?.matchedRecordGuids || new Set();
    const matchedLineGuids = queryFilterState?.matchedLineGuids || new Set();
    const out = [];

    for (const group of groups || []) {
      const record = group?.record || null;
      const recordGuid = (record?.guid || '').trim();
      if (!recordGuid) continue;

      if (matchedRecordGuids.has(recordGuid)) {
        out.push({
          record,
          lines: Array.isArray(group?.lines) ? Array.from(group.lines) : []
        });
        continue;
      }

      const lines = (group?.lines || []).filter((line) => matchedLineGuids.has((line?.guid || '').trim()));
      if (lines.length === 0) continue;
      out.push({ record, lines });
    }

    return out;
  }

  hasSearchQuery(state) {
    return Boolean((state?.searchQuery || '').trim());
  }

  updateSearchFieldState(state) {
    if (!state) return;
    const query = state.searchQuery || '';
    const hasValue = query.length > 0;

    if (state.searchInputEl && state.searchInputEl.value !== query) {
      state.searchInputEl.value = query;
    }
    if (state.searchHighlightTextEl) {
      state.searchHighlightTextEl.textContent = query;
    }
    if (state.searchClearEl) {
      state.searchClearEl.style.display = hasValue ? 'flex' : 'none';
    }
    if (state.searchRefreshEl) {
      state.searchRefreshEl.style.display = hasValue ? 'none' : 'flex';
    }
  }

  syncSearchControlState(state) {
    if (!state) return;
    const open = state.searchOpen === true;
    const active = open || this.hasSearchQuery(state);
    const hasQuery = this.hasSearchQuery(state);
    const footerCollapsed = state.rootEl?.classList?.contains?.('tlr-collapsed') === true;

    if (state.rootEl) {
      state.rootEl.classList.toggle('tlr-search-open', open);
      state.rootEl.classList.toggle('tlr-search-active', active);
    }
    if (state.searchRowEl) {
      state.searchRowEl.style.display = open && footerCollapsed !== true ? 'block' : 'none';
    }
    if (state.searchToggleEl) {
      state.searchToggleEl.setAttribute('aria-expanded', open ? 'true' : 'false');
      state.searchToggleEl.classList.toggle('is-active', active);
      const tooltip = open ? 'Hide filter bar' : hasQuery ? 'Filter (active)' : 'Filter';
      state.searchToggleEl.setAttribute('aria-label', tooltip);
      state.searchToggleEl.setAttribute('data-tooltip', tooltip);
      state.searchToggleEl.title = tooltip;
      const icon = state.searchToggleEl.querySelector?.('.id--filter-icon') || null;
      icon?.classList?.toggle?.('text-primary-icon', active);
      icon?.classList?.toggle?.('bold', active);
    }

    this.updateSearchFieldState(state);
  }

  setSearchOpen(state, open) {
    if (!state) return;
    state.searchOpen = open === true;
    if (state.searchOpen === true) {
      this.setSortMenuOpen(state, false);
    } else {
      this.setSearchAutocompleteOpen(state, false);
      try {
        state.searchInputEl?.blur?.();
      } catch (e) {
        // ignore
      }
    }

    this.syncSearchControlState(state);

    if (state.searchOpen === true && state.searchInputEl) {
      setTimeout(() => {
        try {
          state.searchInputEl?.focus?.();
        } catch (e) {
          // ignore
        }
      }, 0);
    }
  }

  getSortOptions() {
    return [
      { id: 'page_last_edited', label: 'Page Last Edited' },
      { id: 'reference_activity', label: 'Reference Activity' },
      { id: 'reference_count', label: 'Reference Count' },
      { id: 'page_title', label: 'Page Title' },
      { id: 'page_created_date', label: 'Page Created Date' }
    ];
  }

  getSortLabel(sortBy) {
    const id = this.normalizeSortBy(sortBy) || this._defaultSortBy;
    for (const option of this.getSortOptions()) {
      if (option.id === id) return option.label;
    }
    return 'Page Last Edited';
  }

  isValidSortBy(sortBy) {
    if (typeof sortBy !== 'string') return false;
    return this.getSortOptions().some((x) => x.id === sortBy);
  }

  isValidSortDir(sortDir) {
    return sortDir === 'asc' || sortDir === 'desc';
  }

  normalizeSortBy(sortBy) {
    return this.isValidSortBy(sortBy) ? sortBy : null;
  }

  normalizeSortDir(sortDir) {
    return this.isValidSortDir(sortDir) ? sortDir : null;
  }

  getSortPreferenceForRecord(recordGuid) {
    const guid = (recordGuid || '').trim();
    const fallback = { sortBy: this._defaultSortBy, sortDir: this._defaultSortDir };
    if (!guid) return fallback;

    const raw = this._sortByRecord?.[guid] || null;
    if (!raw || typeof raw !== 'object') return fallback;

    return {
      sortBy: this.normalizeSortBy(raw.sortBy) || fallback.sortBy,
      sortDir: this.normalizeSortDir(raw.sortDir) || fallback.sortDir
    };
  }

  applySortPreferenceForRecord(recordGuid, sortBy, sortDir) {
    const guid = (recordGuid || '').trim();
    if (!guid) return;

    const nextSortBy = this.normalizeSortBy(sortBy) || this._defaultSortBy;
    const nextSortDir = this.normalizeSortDir(sortDir) || this._defaultSortDir;

    this.setSortPreferenceForRecord(guid, nextSortBy, nextSortDir);

    for (const s of this._panelStates.values()) {
      if (!s || s.recordGuid !== guid) continue;
      s.sortBy = nextSortBy;
      s.sortDir = nextSortDir;
      this.renderSortMenu(s);
      this.syncSortControlState(s);
      this.renderFromCache(s);
    }
  }

  renderSortMenu(state) {
    const menu = state?.sortMenuEl || null;
    if (!menu) return;

    const sortBy = this.normalizeSortBy(state.sortBy) || this._defaultSortBy;
    const sortDir = this.normalizeSortDir(state.sortDir) || this._defaultSortDir;
    state.sortBy = sortBy;
    state.sortDir = sortDir;

    menu.innerHTML = '';

    const list = document.createElement('div');
    list.className = 'autocomplete clickable';

    const scroll = document.createElement('div');
    scroll.className = 'vscroll-node';

    const content = document.createElement('div');
    content.className = 'vcontent';

    const scrollbar = document.createElement('div');
    scrollbar.className = 'vscrollbar scrollbar';

    const thumb = document.createElement('div');
    thumb.className = 'vscrollbar-thumb scrollbar-thumb clickable';
    thumb.innerHTML = '&nbsp;';

    const title = document.createElement('div');
    title.className = 'tlr-sort-menu-title text-details';
    title.textContent = 'Sort by';
    content.appendChild(title);

    for (const option of this.getSortOptions()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tlr-sort-option autocomplete--option button-none';
      row.dataset.action = 'set-sort-by';
      row.dataset.sortBy = option.id;
      row.setAttribute('role', 'menuitemradio');
      row.setAttribute('aria-checked', option.id === sortBy ? 'true' : 'false');
      if (option.id === sortBy) row.classList.add('autocomplete--option-selected');

      const label = document.createElement('span');
      label.className = 'tlr-sort-option-label autocomplete--option-label';
      label.textContent = option.label;

      row.appendChild(label);
      content.appendChild(row);
    }

    const divider = document.createElement('div');
    divider.className = 'tlr-sort-menu-divider';
    content.appendChild(divider);

    const directionTitle = document.createElement('div');
    directionTitle.className = 'tlr-sort-menu-title text-details';
    directionTitle.textContent = 'Direction';
    content.appendChild(directionTitle);

    const ascBtn = document.createElement('button');
    ascBtn.type = 'button';
    ascBtn.className = 'tlr-sort-option autocomplete--option button-none';
    ascBtn.dataset.action = 'set-sort-dir';
    ascBtn.dataset.sortDir = 'asc';
    ascBtn.setAttribute('role', 'menuitemradio');
    ascBtn.setAttribute('aria-checked', sortDir === 'asc' ? 'true' : 'false');
    ascBtn.textContent = 'Ascending';
    if (sortDir === 'asc') ascBtn.classList.add('autocomplete--option-selected');

    const descBtn = document.createElement('button');
    descBtn.type = 'button';
    descBtn.className = 'tlr-sort-option autocomplete--option button-none';
    descBtn.dataset.action = 'set-sort-dir';
    descBtn.dataset.sortDir = 'desc';
    descBtn.setAttribute('role', 'menuitemradio');
    descBtn.setAttribute('aria-checked', sortDir === 'desc' ? 'true' : 'false');
    descBtn.textContent = 'Descending';
    if (sortDir === 'desc') descBtn.classList.add('autocomplete--option-selected');

    content.appendChild(ascBtn);
    content.appendChild(descBtn);

    scroll.appendChild(content);
    scroll.addEventListener('scroll', () => {
      this.syncSortMenuScrollbar(state);
    });

    thumb.addEventListener('mousedown', (e) => {
      e.preventDefault();
      e.stopPropagation();

      const startY = e.clientY;
      const startScrollTop = scroll.scrollTop;
      const onMouseMove = (moveEvent) => {
        const trackHeight = scrollbar.clientHeight || scroll.clientHeight || 0;
        const thumbHeight = thumb.clientHeight || 0;
        const maxThumbTop = Math.max(1, trackHeight - thumbHeight);
        const maxScrollTop = Math.max(0, scroll.scrollHeight - scroll.clientHeight);
        if (maxScrollTop <= 0) return;
        const deltaRatio = (moveEvent.clientY - startY) / maxThumbTop;
        scroll.scrollTop = Math.max(0, Math.min(maxScrollTop, startScrollTop + (deltaRatio * maxScrollTop)));
      };

      const onMouseUp = () => {
        document.removeEventListener('mousemove', onMouseMove, true);
        document.removeEventListener('mouseup', onMouseUp, true);
      };

      document.addEventListener('mousemove', onMouseMove, true);
      document.addEventListener('mouseup', onMouseUp, true);
    });

    list.appendChild(scroll);
    scrollbar.appendChild(thumb);
    list.appendChild(scrollbar);
    menu.appendChild(list);

    const sync = () => {
      this.syncSortMenuScrollbar(state);
    };
    sync();
    if (typeof requestAnimationFrame === 'function') {
      requestAnimationFrame(sync);
    } else {
      setTimeout(sync, 0);
    }
  }

  syncSortControlState(state) {
    if (!state) return;
    const sortBy = this.normalizeSortBy(state.sortBy) || this._defaultSortBy;
    const sortDir = this.normalizeSortDir(state.sortDir) || this._defaultSortDir;
    state.sortBy = sortBy;
    state.sortDir = sortDir;

    const sortLabel = this.getSortLabel(sortBy);
    const dirLabel = sortDir === 'asc' ? 'Ascending' : 'Descending';

    if (state.sortToggleEl) {
      state.sortToggleEl.title = `Sort: ${sortLabel} (${dirLabel})`;
      state.sortToggleEl.setAttribute('aria-label', `Sort options: ${sortLabel}, ${dirLabel}`);
      state.sortToggleEl.setAttribute('aria-expanded', state.sortMenuOpen === true ? 'true' : 'false');
    }

    if (state.rootEl) {
      state.rootEl.classList.toggle('tlr-sort-open', state.sortMenuOpen === true);
    }
  }

  setSortMenuOpen(state, open) {
    if (!state) return;
    state.sortMenuOpen = open === true;

    this.clearPointerDismissHandler(state, 'sortMenuDismissHandler');
    if (state.sortMenuKeyHandler) {
      try {
        document.removeEventListener('keydown', state.sortMenuKeyHandler, true);
      } catch (e) {
        // ignore
      }
      state.sortMenuKeyHandler = null;
    }

    this.syncSortControlState(state);

    if (state.sortMenuOpen !== true) return;

    const onOutsideMouseDown = (ev) => {
      const menu = state.sortMenuEl || null;
      const toggle = state.sortToggleEl || null;
      if (!menu || !menu.isConnected) {
        this.setSortMenuOpen(state, false);
        return;
      }

      const target = ev.target;
      if (menu.contains(target)) return;
      if (toggle && toggle.contains(target)) return;
      this.setSortMenuOpen(state, false);
    };

    this.setPointerDismissHandler(state, 'sortMenuDismissHandler', onOutsideMouseDown);

    const onMenuKeyDown = (ev) => {
      if (ev.key !== 'Escape') return;
      ev.preventDefault();
      this.setSortMenuOpen(state, false);
      try {
        state.sortToggleEl?.focus?.();
      } catch (e) {
        // ignore
      }
    };

    state.sortMenuKeyHandler = onMenuKeyDown;
    try {
      document.addEventListener('keydown', onMenuKeyDown, true);
    } catch (e) {
      // ignore
    }
  }

  syncSortMenuScrollbar(state) {
    const menu = state?.sortMenuEl || null;
    const scroll = menu?.querySelector?.('.vscroll-node') || null;
    const scrollbar = menu?.querySelector?.('.vscrollbar') || null;
    const thumb = menu?.querySelector?.('.vscrollbar-thumb') || null;
    if (!scroll || !scrollbar || !thumb) return;

    const viewportHeight = scroll.clientHeight || 0;
    const scrollHeight = scroll.scrollHeight || 0;
    const trackHeight = scrollbar.clientHeight || viewportHeight;
    if (!viewportHeight || !scrollHeight || !trackHeight || scrollHeight <= viewportHeight + 1) {
      scrollbar.classList.remove('has-thumb');
      thumb.style.height = '0px';
      thumb.style.transform = 'translateY(0px)';
      return;
    }

    const thumbHeight = Math.max(16, Math.round((viewportHeight / scrollHeight) * trackHeight));
    const maxScrollTop = Math.max(1, scrollHeight - viewportHeight);
    const maxThumbTop = Math.max(0, trackHeight - thumbHeight);
    const thumbTop = maxThumbTop * (scroll.scrollTop / maxScrollTop);

    scrollbar.classList.add('has-thumb');
    thumb.style.height = `${thumbHeight}px`;
    thumb.style.transform = `translateY(${thumbTop}px)`;
  }

  renderFromCache(state) {
    if (!state) return;
    const cached = state.lastResults || null;
    if (!cached) return;
    this.syncPropertyIndexResultForState(state);

    const panel = state.panel || null;
    if (panel && !this.isPanelVisible(panel)) {
      this.unmountFooterForHiddenPanel(state);
      return;
    }

    if (panel && (!state.rootEl || !state.rootEl.isConnected)) {
      this.mountFooter(panel, state);
    }

    if (!state.bodyEl || !state.countEl) return;
    this.renderReferences(state, cached);
  }

  readJsonStorage(key) {
    const storageKey = typeof key === 'string' ? key.trim() : '';
    if (!storageKey) return null;
    try {
      const raw = localStorage.getItem(storageKey);
      if (typeof raw !== 'string' || !raw.trim()) return null;
      return JSON.parse(raw);
    } catch (e) {
      // ignore
    }
    return null;
  }

  writeJsonStorage(key, value) {
    const storageKey = typeof key === 'string' ? key.trim() : '';
    if (!storageKey) return;
    try {
      localStorage.setItem(storageKey, JSON.stringify(value));
    } catch (e) {
      // ignore
    }
  }

  normalizeTouchedAt(value) {
    const n = Number(value);
    if (!Number.isFinite(n) || n <= 0) return 0;
    return Math.floor(n);
  }

  pruneTouchedRecordMap(value, maxEntries) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};

    const entries = Object.entries(value);
    if (!Number.isFinite(maxEntries) || maxEntries < 1 || entries.length <= maxEntries) {
      return value;
    }

    const kept = entries
      .map(([guid, entry], index) => ({
        guid,
        entry,
        index,
        touchedAt: this.normalizeTouchedAt(entry?.touchedAt)
      }))
      .sort((a, b) => (b.touchedAt - a.touchedAt) || (b.index - a.index))
      .slice(0, maxEntries)
      .sort((a, b) => (a.touchedAt - b.touchedAt) || (a.index - b.index));

    const out = {};
    for (const item of kept) {
      out[item.guid] = item.entry;
    }
    return out;
  }

  parseStoredStringSet(value) {
    if (!Array.isArray(value)) return null;
    const out = new Set();
    for (const item of value) {
      if (typeof item !== 'string') continue;
      const text = item.trim();
      if (text) out.add(text);
    }
    return out;
  }

  pruneStoredSet(set, maxEntries) {
    if (!(set instanceof Set)) return new Set();
    if (!Number.isFinite(maxEntries) || maxEntries < 1 || set.size <= maxEntries) {
      return new Set(set);
    }

    const values = Array.from(set);
    return new Set(values.slice(values.length - maxEntries));
  }

  touchStoredSetEntry(set, value, maxEntries) {
    const text = typeof value === 'string' ? value.trim() : '';
    const out = set instanceof Set ? new Set(set) : new Set();
    if (text) {
      out.delete(text);
      out.add(text);
    }
    return this.pruneStoredSet(out, maxEntries);
  }

  parseStoredRecordMap(value, normalizeEntry) {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const normalize = typeof normalizeEntry === 'function' ? normalizeEntry : null;
    const out = {};
    for (const [recordGuid, entry] of Object.entries(value)) {
      const guid = typeof recordGuid === 'string' ? recordGuid.trim() : '';
      if (!guid) continue;
      const normalized = normalize ? normalize(entry) : entry;
      if (normalized == null) continue;
      out[guid] = normalized;
    }
    return out;
  }

  normalizePageViewPreference(pref) {
    const sections = this.cloneSectionCollapsedState(pref?.sections);
    const footerCollapsed = typeof pref?.footerCollapsed === 'boolean' ? pref.footerCollapsed : null;
    const touchedAt = this.normalizeTouchedAt(pref?.touchedAt);
    return { footerCollapsed, sections, touchedAt };
  }

  loadPageViewByRecordSetting() {
    const current = this.parseStoredRecordMap(
      this.readJsonStorage(this._storageKeyPageViewByRecord),
      (pref) => this.normalizePageViewPreference(pref)
    ) || {};
    const pruned = this.pruneTouchedRecordMap(current, this._maxStoredPageViewRecords);
    if (Object.keys(pruned).length !== Object.keys(current).length) {
      this.writeJsonStorage(this._storageKeyPageViewByRecord, pruned);
    }
    return pruned;
  }

  savePageViewByRecordSetting() {
    this._pageViewByRecord = this.pruneTouchedRecordMap(
      this._pageViewByRecord || {},
      this._maxStoredPageViewRecords
    );
    this.writeJsonStorage(this._storageKeyPageViewByRecord, this._pageViewByRecord || {});
  }

  getPageViewPreference(recordGuid) {
    const guid = (recordGuid || '').trim();
    if (!guid) return this.normalizePageViewPreference(null);
    return this.normalizePageViewPreference(this._pageViewByRecord?.[guid] || null);
  }

  ensurePageViewPreference(recordGuid) {
    const guid = (recordGuid || '').trim();
    if (!guid) return null;
    if (!this._pageViewByRecord || typeof this._pageViewByRecord !== 'object') {
      this._pageViewByRecord = {};
    }
    const nextPref = this.normalizePageViewPreference(this._pageViewByRecord[guid] || null);
    this._pageViewByRecord[guid] = nextPref;
    return nextPref;
  }

  setFooterCollapsedPreferenceForRecord(recordGuid, collapsed) {
    const pref = this.ensurePageViewPreference(recordGuid);
    if (!pref) return;
    pref.footerCollapsed = collapsed === true;
    pref.touchedAt = Date.now();
    this.savePageViewByRecordSetting();
  }

  setSectionCollapsedPreferenceForRecord(recordGuid, sectionId, collapsed) {
    const id = this.normalizeSectionId(sectionId);
    if (!id) return;
    const pref = this.ensurePageViewPreference(recordGuid);
    if (!pref) return;
    pref.sections = this.cloneSectionCollapsedState(pref.sections);
    pref.sections[id] = collapsed === true;
    pref.touchedAt = Date.now();
    this.savePageViewByRecordSetting();
  }

  applyFooterCollapsedPreferenceForRecord(recordGuid, collapsed) {
    const guid = (recordGuid || '').trim();
    if (!guid) return;
    this.setFooterCollapsedPreferenceForRecord(guid, collapsed);

    for (const state of this._panelStates.values()) {
      if (!state || state.recordGuid !== guid) continue;
      state.footerCollapsed = collapsed === true;
      this.syncFooterCollapsedState(state, this.isFooterCollapsed(state, this.getCollapseMetrics(state.lastResults)));
    }
  }

  applySectionCollapsedPreferenceForRecord(recordGuid, sectionId, collapsed) {
    const guid = (recordGuid || '').trim();
    const id = this.normalizeSectionId(sectionId);
    if (!guid || !id) return;
    this.setSectionCollapsedPreferenceForRecord(guid, id, collapsed);

    for (const state of this._panelStates.values()) {
      if (!state || state.recordGuid !== guid) continue;
      state.sectionCollapsed = this.cloneSectionCollapsedState(state.sectionCollapsed);
      state.sectionCollapsed[id] = collapsed === true;
      this.syncScopedQueryWithCurrentInput(state, { immediate: true, reason: 'section-preference-changed' });
      this.renderFromCache(state);
      if (id === 'unlinked' && collapsed !== true && state.lastResults?.unlinkedDeferred === true) {
        this.ensureDeferredUnlinkedLoaded(state).catch(() => {
          // ignore
        });
      }
    }
  }

  loadPropGroupCollapsedSetting() {
    const current = this.parseStoredStringSet(this.readJsonStorage(this._storageKeyPropGroupCollapsed));
    if (current) {
      const pruned = this.pruneStoredSet(current, this._maxStoredPropGroupStates);
      if (pruned.size !== current.size) {
        this.writeJsonStorage(this._storageKeyPropGroupCollapsed, Array.from(pruned));
      }
      return pruned;
    }

    // Migration: older versions used a back"links" storage key.
    try {
      const legacyKey = this._legacyStorageKeyPropGroupCollapsed;
      if (legacyKey && legacyKey !== this._storageKeyPropGroupCollapsed) {
        const set = this.parseStoredStringSet(this.readJsonStorage(legacyKey));
        if (set) {
          const pruned = this.pruneStoredSet(set, this._maxStoredPropGroupStates);
          this.writeJsonStorage(this._storageKeyPropGroupCollapsed, Array.from(pruned));
          return pruned;
        }
      }
    } catch (e) {
      // ignore
    }

    return new Set();
  }

  loadRecordGroupCollapsedSetting() {
    const current = this.parseStoredStringSet(this.readJsonStorage(this._storageKeyRecordGroupCollapsed));
    if (current) {
      const pruned = this.pruneStoredSet(current, this._maxStoredRecordGroupStates);
      if (pruned.size !== current.size) {
        this.writeJsonStorage(this._storageKeyRecordGroupCollapsed, Array.from(pruned));
      }
      return pruned;
    }

    try {
      const legacyKey = this._legacyStorageKeyRecordGroupCollapsed;
      if (legacyKey && legacyKey !== this._storageKeyRecordGroupCollapsed) {
        const set = this.parseStoredStringSet(this.readJsonStorage(legacyKey));
        if (set) {
          const pruned = this.pruneStoredSet(set, this._maxStoredRecordGroupStates);
          this.writeJsonStorage(this._storageKeyRecordGroupCollapsed, Array.from(pruned));
          return pruned;
        }
      }
    } catch (e) {
      // ignore
    }

    return new Set();
  }

  savePropGroupCollapsedSetting() {
    this._propGroupCollapsed = this.pruneStoredSet(
      this._propGroupCollapsed,
      this._maxStoredPropGroupStates
    );
    this.writeJsonStorage(this._storageKeyPropGroupCollapsed, Array.from(this._propGroupCollapsed || []));
  }

  saveRecordGroupCollapsedSetting() {
    this._recordGroupCollapsed = this.pruneStoredSet(
      this._recordGroupCollapsed,
      this._maxStoredRecordGroupStates
    );
    this.writeJsonStorage(this._storageKeyRecordGroupCollapsed, Array.from(this._recordGroupCollapsed || []));
  }

  isPropGroupCollapsed(propName) {
    const name = (propName || '').trim();
    if (!name) return false;
    return this._propGroupCollapsed?.has?.(name) === true;
  }

  setPropGroupCollapsed(propName, collapsed) {
    const name = (propName || '').trim();
    if (!name) return;
    if (!this._propGroupCollapsed) this._propGroupCollapsed = new Set();
    if (collapsed === true) {
      this._propGroupCollapsed = this.touchStoredSetEntry(
        this._propGroupCollapsed,
        name,
        this._maxStoredPropGroupStates
      );
    } else {
      this._propGroupCollapsed.delete(name);
    }
    this.savePropGroupCollapsedSetting();
  }

  normalizeRecordGroupSectionId(sectionId) {
    return sectionId === 'linked' || sectionId === 'unlinked' ? sectionId : null;
  }

  getRecordGroupCollapsedKey(sectionId, targetRecordGuid, recordGuid) {
    const normalizedSectionId = this.normalizeRecordGroupSectionId(sectionId);
    const targetGuid = typeof targetRecordGuid === 'string' ? targetRecordGuid.trim() : '';
    const guid = typeof recordGuid === 'string' ? recordGuid.trim() : '';
    if (!normalizedSectionId || !targetGuid || !guid) return '';
    return `${normalizedSectionId}:${targetGuid}:${guid}`;
  }

  isRecordGroupCollapsed(sectionId, targetRecordGuid, recordGuid) {
    const key = this.getRecordGroupCollapsedKey(sectionId, targetRecordGuid, recordGuid);
    if (!key) return false;
    return this._recordGroupCollapsed?.has?.(key) === true;
  }

  setRecordGroupCollapsed(sectionId, targetRecordGuid, recordGuid, collapsed) {
    const key = this.getRecordGroupCollapsedKey(sectionId, targetRecordGuid, recordGuid);
    if (!key) return;
    if (!this._recordGroupCollapsed) this._recordGroupCollapsed = new Set();
    if (collapsed === true) {
      this._recordGroupCollapsed = this.touchStoredSetEntry(
        this._recordGroupCollapsed,
        key,
        this._maxStoredRecordGroupStates
      );
    } else {
      this._recordGroupCollapsed.delete(key);
    }
    this.saveRecordGroupCollapsedSetting();
  }

  loadSortByRecordSetting() {
    const normalizeSortPref = (pref) => {
      const sortBy = this.normalizeSortBy(pref?.sortBy);
      const sortDir = this.normalizeSortDir(pref?.sortDir);
      if (!sortBy || !sortDir) return null;
      return {
        sortBy,
        sortDir,
        touchedAt: this.normalizeTouchedAt(pref?.touchedAt)
      };
    };

    const current = this.parseStoredRecordMap(
      this.readJsonStorage(this._storageKeySortByRecord),
      normalizeSortPref
    );
    if (current) {
      const pruned = this.pruneTouchedRecordMap(current, this._maxStoredSortByRecords);
      if (Object.keys(pruned).length !== Object.keys(current).length) {
        this.writeJsonStorage(this._storageKeySortByRecord, pruned);
      }
      return pruned;
    }

    // Migration: older versions used a back"links" storage key.
    try {
      const legacyKey = this._legacyStorageKeySortByRecord;
      if (legacyKey && legacyKey !== this._storageKeySortByRecord) {
        const map = this.parseStoredRecordMap(this.readJsonStorage(legacyKey), normalizeSortPref);
        if (map) {
          const pruned = this.pruneTouchedRecordMap(map, this._maxStoredSortByRecords);
          this.writeJsonStorage(this._storageKeySortByRecord, pruned);
          return pruned;
        }
      }
    } catch (e) {
      // ignore
    }

    return {};
  }

  saveSortByRecordSetting() {
    this._sortByRecord = this.pruneTouchedRecordMap(
      this._sortByRecord || {},
      this._maxStoredSortByRecords
    );
    this.writeJsonStorage(this._storageKeySortByRecord, this._sortByRecord || {});
  }

  setSortPreferenceForRecord(recordGuid, sortBy, sortDir) {
    const guid = (recordGuid || '').trim();
    if (!guid) return;

    const nextSortBy = this.normalizeSortBy(sortBy) || this._defaultSortBy;
    const nextSortDir = this.normalizeSortDir(sortDir) || this._defaultSortDir;

    if (!this._sortByRecord || typeof this._sortByRecord !== 'object') {
      this._sortByRecord = {};
    }

    if (nextSortBy === this._defaultSortBy && nextSortDir === this._defaultSortDir) {
      delete this._sortByRecord[guid];
    } else {
      this._sortByRecord[guid] = {
        sortBy: nextSortBy,
        sortDir: nextSortDir,
        touchedAt: Date.now()
      };
    }

    this.saveSortByRecordSetting();
  }

  bumpLinkedContextRenderVersion(state) {
    if (!state) return;
    state.linkedContextRenderVersion = (state.linkedContextRenderVersion || 0) + 1;
  }

  invalidateLinkedContextCache(state) {
    const map = state?.linkedContextByLine;
    if (!(map instanceof Map)) return;
    let changed = false;

    for (const ctx of map.values()) {
      if (!ctx || typeof ctx !== 'object') continue;
      if (
        ctx.loaded === true
        || ctx.loading === true
        || (ctx.descendants || []).length > 0
        || (ctx.aboveItems || []).length > 0
        || (ctx.belowItems || []).length > 0
        || ctx.showMoreContext === true
        || (ctx.siblingAboveCount || 0) > 0
        || (ctx.siblingBelowCount || 0) > 0
        || ctx.error
      ) {
        changed = true;
      }
      ctx.loaded = false;
      ctx.loading = false;
      ctx.loadPromise = null;
      ctx.error = '';
      ctx.descendants = [];
      ctx.depthByGuid = {};
      ctx.relativeDepthByGuid = {};
      ctx.aboveItems = [];
      ctx.belowItems = [];
    }
    if (changed) this.bumpLinkedContextRenderVersion(state);
  }

  getPropertySnapshotKey(propertyName, recordGuid) {
    return `prop:${(propertyName || '').trim()}::${(recordGuid || '').trim()}`;
  }

  getLinkedSnapshotKey(lineGuid) {
    return `line:${(lineGuid || '').trim()}`;
  }

  buildResultsSnapshot(propertyGroups, linkedGroups) {
    const itemsByKey = new Map();
    const sourceRecordGuids = new Set();
    let propertyCount = 0;
    let linkedCount = 0;

    for (const g of propertyGroups || []) {
      const propertyName = (g?.propertyName || '').trim();
      if (!propertyName) continue;
      for (const record of g?.records || []) {
        const recordGuid = record?.guid || null;
        if (!recordGuid) continue;
        const key = this.getPropertySnapshotKey(propertyName, recordGuid);
        itemsByKey.set(key, {
          kind: 'property',
          key,
          signature: key,
          recordGuid,
          propertyName
        });
        sourceRecordGuids.add(recordGuid);
        propertyCount += 1;
      }
    }

    for (const g of linkedGroups || []) {
      const recordGuid = g?.record?.guid || null;
      if (!recordGuid) continue;
      sourceRecordGuids.add(recordGuid);
      for (const line of g?.lines || []) {
        const lineGuid = line?.guid || null;
        if (!lineGuid) continue;
        const key = this.getLinkedSnapshotKey(lineGuid);
        itemsByKey.set(key, {
          kind: 'line',
          key,
          signature: `${recordGuid}|${lineGuid}|${this.segmentsToPlainText(line?.segments || [])}|${this.getLineActivityTimestamp(line)}`,
          recordGuid,
          lineGuid
        });
        linkedCount += 1;
      }
    }

    return {
      itemsByKey,
      sourceRecordGuids,
      propertyCount,
      linkedCount,
      totalCount: propertyCount + linkedCount,
      pageCount: sourceRecordGuids.size
    };
  }

  diffCurrentSnapshotKeys(prevSnapshot, nextSnapshot) {
    const changed = new Set();
    const prevItems = prevSnapshot?.itemsByKey instanceof Map ? prevSnapshot.itemsByKey : new Map();
    const nextItems = nextSnapshot?.itemsByKey instanceof Map ? nextSnapshot.itemsByKey : new Map();

    for (const [key, nextItem] of nextItems.entries()) {
      const prevItem = prevItems.get(key) || null;
      if (!prevItem || prevItem.signature !== nextItem.signature) changed.add(key);
    }

    return changed;
  }

  sameStringSet(a, b) {
    const left = a instanceof Set ? a : new Set();
    const right = b instanceof Set ? b : new Set();
    if (left.size !== right.size) return false;
    for (const value of left) {
      if (!right.has(value)) return false;
    }
    return true;
  }

  sameStringMap(a, b) {
    const left = a instanceof Map ? a : new Map();
    const right = b instanceof Map ? b : new Map();
    if (left.size !== right.size) return false;
    for (const [key, value] of left.entries()) {
      if (!right.has(key)) return false;
      if (right.get(key) !== value) return false;
    }
    return true;
  }

  markStatePendingRemote(state, ev) {
    if (!state || ev?.source?.isLocal !== false) return;
    state.pendingRemoteSync = true;
    if (!(state.pendingRemoteUsers instanceof Set)) state.pendingRemoteUsers = new Set();

    const user = typeof ev.getSourceUser === 'function' ? ev.getSourceUser() : null;
    const name = (user?.getDisplayName?.() || '').trim();
    if (name) state.pendingRemoteUsers.add(name);
  }

  markAllStatesPendingRemote(ev) {
    for (const state of this._panelStates.values()) {
      this.markStatePendingRemote(state, ev);
    }
  }

  getRemoteBadgeTooltip(userNames) {
    const names = Array.from(userNames || []).filter(Boolean);
    if (names.length === 1) return `Changed remotely by ${names[0]}`;
    if (names.length > 1) return `Changed remotely by ${names.join(', ')}`;
    return 'Changed remotely';
  }

  applyLiveSnapshot(state, snapshot) {
    if (!state) return;

    const currentSnapshot = snapshot || this.buildResultsSnapshot([], []);
    const baseline = state.liveBaselineSnapshot;
    const previous = state.liveCurrentSnapshot;
    const prevNewKeys = state.liveNewKeys instanceof Set ? new Set(state.liveNewKeys) : new Set();
    const prevRemoteBadges = state.liveRemoteBadgesByKey instanceof Map
      ? new Map(state.liveRemoteBadgesByKey)
      : new Map();

    if (!baseline || !previous) {
      state.liveBaselineSnapshot = currentSnapshot;
      state.liveCurrentSnapshot = currentSnapshot;
      state.liveNewKeys = new Set();
      state.liveRemoteBadgesByKey = new Map();
      state.liveRenderVersion = (state.liveRenderVersion || 0) + 1;
      state.pendingRemoteSync = false;
      state.pendingRemoteUsers = new Set();
      return;
    }

    const nextNewKeys = new Set();
    for (const key of currentSnapshot.itemsByKey.keys()) {
      if (!baseline.itemsByKey.has(key)) nextNewKeys.add(key);
    }

    const nextRemoteBadges = state.liveRemoteBadgesByKey instanceof Map
      ? new Map(state.liveRemoteBadgesByKey)
      : new Map();

    for (const key of Array.from(nextRemoteBadges.keys())) {
      if (!currentSnapshot.itemsByKey.has(key)) nextRemoteBadges.delete(key);
    }

    if (state.pendingRemoteSync === true) {
      const tooltip = this.getRemoteBadgeTooltip(state.pendingRemoteUsers);
      for (const key of this.diffCurrentSnapshotKeys(previous, currentSnapshot)) {
        if (!currentSnapshot.itemsByKey.has(key)) continue;
        nextRemoteBadges.set(key, tooltip);
      }
    }

    state.liveCurrentSnapshot = currentSnapshot;
    state.liveNewKeys = nextNewKeys;
    state.liveRemoteBadgesByKey = nextRemoteBadges;
    if (!this.sameStringSet(prevNewKeys, nextNewKeys) || !this.sameStringMap(prevRemoteBadges, nextRemoteBadges)) {
      state.liveRenderVersion = (state.liveRenderVersion || 0) + 1;
    }
    state.pendingRemoteSync = false;
    state.pendingRemoteUsers = new Set();
  }

  getLiveBadgesForKey(state, itemKey) {
    const badges = [];
    if (!state || !itemKey) return badges;

    if (state.liveNewKeys instanceof Set && state.liveNewKeys.has(itemKey)) {
      badges.push({ label: 'New', className: 'is-new', tooltip: 'Added since this page was opened' });
    }

    if (state.liveRemoteBadgesByKey instanceof Map && state.liveRemoteBadgesByKey.has(itemKey)) {
      badges.push({ label: 'Changed', className: 'is-remote', tooltip: state.liveRemoteBadgesByKey.get(itemKey) || 'Changed remotely' });
    }

    return badges;
  }

  appendLiveBadges(container, state, itemKey) {
    if (!container) return;

    for (const badge of this.getLiveBadgesForKey(state, itemKey)) {
      container.appendChild(document.createTextNode(' '));
      const el = document.createElement('span');
      el.className = `tlr-live-badge text-details ${badge.className || ''}`.trim();
      el.textContent = badge.label;
      if (badge.tooltip) el.title = badge.tooltip;
      container.appendChild(el);
    }
  }

  handleWorkspaceInvalidation(ev, reason) {
    this.markAllStatesPendingRemote(ev);
    this.refreshAllPanels({ force: false, reason: reason || 'workspace-invalidated' });
  }

  createEmptyPropertyIndexStats() {
    return {
      scannedRecords: 0,
      indexedReferences: 0,
      indexedTargets: 0,
      startedAt: null,
      finishedAt: null
    };
  }

  getPropertyIndexSnapshot() {
    return {
      status: this._propertyIndexStatus || 'idle',
      stats: { ...(this._propertyIndexStats || this.createEmptyPropertyIndexStats()) },
      error: this._propertyIndexError || ''
    };
  }

  getPropertyIndexDisplayMessage(snapshot) {
    const state = snapshot || this.getPropertyIndexSnapshot();
    const scanned = this.coerceNonNegativeInt(state?.stats?.scannedRecords, 0);
    if (state.status === 'indexing') {
      return `Indexing backreferences... ${scanned.toLocaleString()} records scanned`;
    }
    if (state.status === 'idle') {
      return 'Property reference index has not been built yet.';
    }
    if (state.status === 'error') {
      return state.error || 'Error indexing property references.';
    }
    return '';
  }

  notifyPropertyIndexChanged(reason) {
    for (const state of this._panelStates?.values?.() || []) {
      if (!state?.lastResults) continue;
      this.syncPropertyIndexResultForState(state);
      this.renderFromCache(state);
    }
  }

  syncPropertyIndexResultForState(state) {
    const results = state?.lastResults || null;
    if (!state || !results) return false;
    const { showSelf } = this.getRefreshConfig();
    const next = this.getPropertyBacklinkResult(state.recordGuid, { showSelf });
    results.propertyGroups = next.propertyGroups;
    results.propertyError = next.propertyError;
    results.propertyIndexStatus = next.propertyIndexStatus;
    results.propertyIndexStats = next.propertyIndexStats;
    results.propertyIndexError = next.propertyIndexError;
    this.applyLiveSnapshot(state, this.buildResultsSnapshot(results.propertyGroups, results.linkedGroups));
    return true;
  }

  async rebuildPropertyIndex({ reason } = {}) {
    if (this._propertyIndexStatus === 'indexing' && this._propertyIndexPromise) {
      this._propertyIndexNeedsRebuild = true;
      return this._propertyIndexPromise;
    }

    const seq = (this._propertyIndexBuildSeq || 0) + 1;
    this._propertyIndexBuildSeq = seq;
    this._propertyIndexStatus = 'indexing';
    this._propertyIndexError = '';
    this._propertyIndexStats = {
      ...this.createEmptyPropertyIndexStats(),
      startedAt: new Date()
    };
    this.notifyPropertyIndexChanged(reason || 'property-index-started');

    const promise = this.buildPropertyIndex(seq, reason)
      .finally(() => {
        if (this._propertyIndexPromise === promise) {
          this._propertyIndexPromise = null;
        }
      });
    this._propertyIndexPromise = promise;
    return promise;
  }

  async buildPropertyIndex(seq, reason) {
    const byTargetGuid = new Map();
    const sourceEntriesByRecordGuid = new Map();

    try {
      if (typeof this.data?.getAllCollections !== 'function') {
        throw new Error('Thymer graph collections are unavailable.');
      }

      const collections = await this.data.getAllCollections();
      if (!Array.isArray(collections)) {
        throw new Error('Thymer graph collections could not be read.');
      }

      let lastNotifyAt = Date.now();
      for (const collection of collections) {
        if (!collection || typeof collection.getAllRecords !== 'function') continue;
        let records = [];
        try {
          records = await collection.getAllRecords();
        } catch (e) {
          continue;
        }
        if (!Array.isArray(records)) continue;

        for (const record of records) {
          if (this._propertyIndexBuildSeq !== seq) return;
          this.indexSourceRecordPropertyRefs(record, byTargetGuid, sourceEntriesByRecordGuid);
          this._propertyIndexStats.scannedRecords += 1;

          const now = Date.now();
          if (
            this._propertyIndexStats.scannedRecords % 250 === 0 ||
            now - lastNotifyAt > 300
          ) {
            lastNotifyAt = now;
            this.notifyPropertyIndexChanged(reason || 'property-index-progress');
            await this.waitForIndexYield();
          }
        }
      }

      if (this._propertyIndexBuildSeq !== seq) return;

      this._propertyIndexByTargetGuid = byTargetGuid;
      this._propertyIndexSourceEntriesByRecordGuid = sourceEntriesByRecordGuid;
      this._propertyIndexStats = {
        ...this._propertyIndexStats,
        indexedReferences: this.countPropertyIndexReferences(byTargetGuid),
        indexedTargets: byTargetGuid.size,
        finishedAt: new Date()
      };
      this._propertyIndexStatus = 'ready';
      this._propertyIndexError = '';
      this.notifyPropertyIndexChanged(reason || 'property-index-ready');
    } catch (e) {
      if (this._propertyIndexBuildSeq !== seq) return;
      this._propertyIndexStatus = 'error';
      this._propertyIndexError = e?.message || 'Error indexing property references.';
      this._propertyIndexStats = {
        ...this._propertyIndexStats,
        finishedAt: new Date()
      };
      this.notifyPropertyIndexChanged(reason || 'property-index-error');
    } finally {
      if (this._propertyIndexBuildSeq === seq && this._propertyIndexNeedsRebuild) {
        this._propertyIndexNeedsRebuild = false;
        this.schedulePropertyIndexRebuild('queued-property-index-rebuild', 0);
      }
    }
  }

  waitForIndexYield() {
    return new Promise((resolve) => setTimeout(resolve, 0));
  }

  schedulePropertyIndexRebuild(reason, delayMs = 600) {
    if (this._propertyIndexStatus === 'indexing') {
      this._propertyIndexNeedsRebuild = true;
      return;
    }
    if (this._propertyIndexRebuildTimer) {
      clearTimeout(this._propertyIndexRebuildTimer);
      this._propertyIndexRebuildTimer = null;
    }
    this._propertyIndexRebuildTimer = setTimeout(() => {
      this._propertyIndexRebuildTimer = null;
      this.rebuildPropertyIndex({ reason: reason || 'scheduled-property-index-rebuild' }).catch(() => {
        // The error state is rendered in the footer.
      });
    }, Math.max(0, Number(delayMs) || 0));
  }

  countPropertyIndexReferences(byTargetGuid = this._propertyIndexByTargetGuid) {
    let total = 0;
    for (const byProp of byTargetGuid?.values?.() || []) {
      for (const records of byProp?.values?.() || []) {
        total += records?.size || 0;
      }
    }
    return total;
  }

  getPropertyReferenceGuids(prop) {
    const out = new Set();
    const linkedRecordGuids = this.getPropertyLinkedRecordGuids(prop);
    for (const guid of linkedRecordGuids || []) {
      const t = (guid || '').trim();
      if (t) out.add(t);
    }
    for (const value of this.getPropertyCandidateValues(prop)) {
      const t = (value || '').trim();
      if (t) out.add(t);
    }
    return out;
  }

  indexSourceRecordPropertyRefs(record, byTargetGuid, sourceEntriesByRecordGuid) {
    const sourceGuid = (record?.guid || '').trim();
    if (!sourceGuid) return 0;
    this.removeSourceRecordFromPropertyIndexMaps(sourceGuid, byTargetGuid, sourceEntriesByRecordGuid);

    let props = [];
    try {
      props = record.getAllProperties?.() || [];
    } catch (e) {
      props = [];
    }
    if (!Array.isArray(props)) props = [];

    const entries = [];
    const seenEntries = new Set();
    for (const prop of props) {
      const propertyName = (prop?.name || '').trim();
      if (!propertyName) continue;

      for (const targetGuid of this.getPropertyReferenceGuids(prop)) {
        const guid = (targetGuid || '').trim();
        if (!guid) continue;
        const entryKey = `${guid}\u0000${propertyName}`;
        if (seenEntries.has(entryKey)) continue;
        seenEntries.add(entryKey);

        let byProp = byTargetGuid.get(guid) || null;
        if (!byProp) {
          byProp = new Map();
          byTargetGuid.set(guid, byProp);
        }
        let bySource = byProp.get(propertyName) || null;
        if (!bySource) {
          bySource = new Map();
          byProp.set(propertyName, bySource);
        }
        bySource.set(sourceGuid, record);
        entries.push({ targetGuid: guid, propertyName });
      }
    }

    if (entries.length > 0) {
      sourceEntriesByRecordGuid.set(sourceGuid, entries);
    } else {
      sourceEntriesByRecordGuid.delete(sourceGuid);
    }

    return entries.length;
  }

  removeSourceRecordFromPropertyIndexMaps(sourceRecordGuid, byTargetGuid, sourceEntriesByRecordGuid) {
    const sourceGuid = (sourceRecordGuid || '').trim();
    if (!sourceGuid) return false;
    const entries = sourceEntriesByRecordGuid?.get?.(sourceGuid) || [];
    for (const entry of entries) {
      const byProp = byTargetGuid?.get?.(entry.targetGuid);
      if (!byProp) continue;
      const bySource = byProp.get(entry.propertyName);
      if (!bySource) continue;
      bySource.delete(sourceGuid);
      if (bySource.size === 0) byProp.delete(entry.propertyName);
      if (byProp.size === 0) byTargetGuid.delete(entry.targetGuid);
    }
    sourceEntriesByRecordGuid?.delete?.(sourceGuid);
    return entries.length > 0;
  }

  removeSourceRecordFromPropertyIndex(sourceRecordGuid) {
    return this.removeSourceRecordFromPropertyIndexMaps(
      sourceRecordGuid,
      this._propertyIndexByTargetGuid,
      this._propertyIndexSourceEntriesByRecordGuid
    );
  }

  updatePropertyIndexForRecord(sourceRecordGuid, sourceRecord) {
    const sourceGuid = ((sourceRecordGuid || sourceRecord?.guid || '') + '').trim();
    if (!sourceGuid) return false;
    if (this._propertyIndexStatus !== 'ready') {
      this.schedulePropertyIndexRebuild('record-updated-during-index-build');
      return false;
    }

    const record = sourceRecord || this.data.getRecord?.(sourceGuid) || null;
    if (!record) {
      this.schedulePropertyIndexRebuild('record-updated-without-record');
      return false;
    }

    this.removeSourceRecordFromPropertyIndex(sourceGuid);
    this.indexSourceRecordPropertyRefs(
      record,
      this._propertyIndexByTargetGuid,
      this._propertyIndexSourceEntriesByRecordGuid
    );
    this._propertyIndexStats = {
      ...(this._propertyIndexStats || this.createEmptyPropertyIndexStats()),
      indexedReferences: this.countPropertyIndexReferences(),
      indexedTargets: this._propertyIndexByTargetGuid.size
    };
    this.notifyPropertyIndexChanged('record-property-index-updated');
    return true;
  }

  getPropertyBacklinkGroupsFromIndex(targetGuid, { showSelf } = {}) {
    const guid = (targetGuid || '').trim();
    if (!guid || this._propertyIndexStatus !== 'ready') return [];

    const byProp = this._propertyIndexByTargetGuid?.get?.(guid) || null;
    if (!byProp) return [];

    const groups = Array.from(byProp.entries()).map(([propertyName, recordMap]) => {
      const records = [];
      const seen = new Set();
      for (const record of recordMap?.values?.() || []) {
        const sourceGuid = (record?.guid || '').trim();
        if (!sourceGuid || seen.has(sourceGuid)) continue;
        if (!showSelf && sourceGuid === guid) continue;
        seen.add(sourceGuid);
        records.push(record);
      }
      return { propertyName, records };
    }).filter((group) => group.records.length > 0);

    groups.sort((a, b) => {
      const an = (a.propertyName || '').toLowerCase();
      const bn = (b.propertyName || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    for (const g of groups) {
      g.records.sort((a, b) => {
        const ad = a?.getUpdatedAt?.() || null;
        const bd = b?.getUpdatedAt?.() || null;
        const at = ad ? ad.getTime() : 0;
        const bt = bd ? bd.getTime() : 0;
        if (bt !== at) return bt - at;
        const an = (a?.getName?.() || '').toLowerCase();
        const bn = (b?.getName?.() || '').toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
    }

    return groups;
  }

  getPropertyBacklinkResult(targetGuid, { showSelf } = {}) {
    const snapshot = this.getPropertyIndexSnapshot();
    return {
      propertyGroups: snapshot.status === 'ready'
        ? this.getPropertyBacklinkGroupsFromIndex(targetGuid, { showSelf })
        : [],
      propertyError: '',
      propertyIndexStatus: snapshot.status,
      propertyIndexStats: snapshot.stats,
      propertyIndexError: snapshot.status === 'error'
        ? (snapshot.error || 'Error indexing property references.')
        : ''
    };
  }

  snapshotIncludesSourceRecord(state, recordGuid) {
    const guid = (recordGuid || '').trim();
    if (!guid) return false;
    return state?.liveCurrentSnapshot?.sourceRecordGuids?.has?.(guid) === true;
  }

  // ---------- Refresh orchestration ----------

  scheduleRefreshForPanel(panel, { force, reason } = {}) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;
    if (!this.isPanelVisible(panel)) {
      const hiddenState = this._panelStates.get(panelId) || null;
      if (hiddenState) this.unmountFooterForHiddenPanel(hiddenState);
      return;
    }
    let state = this._panelStates.get(panelId) || null;
    if (!state) state = this.getOrCreatePanelState(panel);
    if (!state) return;

    if (state.refreshTimer) {
      clearTimeout(state.refreshTimer);
      state.refreshTimer = null;
    }

    const delay = force ? 0 : this._refreshDebounceMs;
    state.refreshTimer = setTimeout(() => {
      state.refreshTimer = null;
      this.refreshPanel(panelId, { reason: reason || 'scheduled' }).catch(() => {
        // ignore
      });
    }, delay);
  }

  refreshAllPanels({ force, reason }) {
    for (const state of this._panelStates.values()) {
      const panel = state?.panel || null;
      if (!panel) continue;
      this.scheduleRefreshForPanel(panel, { force: force === true, reason: reason || 'all' });
    }
  }

  getRefreshConfig() {
    const cfg = this.getConfiguration?.() || {};
    const maxResults = this.coercePositiveInt(cfg.custom?.maxResults, this._defaultMaxResults);
    return {
      maxResults,
      queryFilterMaxResults: this.coercePositiveInt(
        cfg.custom?.queryFilterMaxResults,
        Math.max(this._defaultQueryFilterMaxResults, maxResults)
      ),
      showSelf: cfg.custom?.showSelf === true
    };
  }

  isRefreshStateCurrent(panelId, state, seq) {
    if (!panelId || !state) return false;
    if (!this._panelStates.has(panelId)) return false;
    return state.refreshSeq === seq;
  }

  normalizeDateToIso(value) {
    if (!value) return '';

    if (value instanceof Date && Number.isFinite(value.getTime())) {
      return [
        this.padDateTimeNumber(value.getFullYear(), 4),
        this.padDateTimeNumber(value.getMonth() + 1, 2),
        this.padDateTimeNumber(value.getDate(), 2)
      ].join('-');
    }

    if (typeof value === 'string') {
      const compact = value.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
      if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
      const dashed = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})/);
      if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
      return '';
    }

    if (value && typeof value === 'object') {
      const source = value.value && typeof value.value === 'object'
        ? value.value
        : value;
      return this.formatDateTimeDate(
        typeof source.d === 'string' ? source.d
          : typeof source.date === 'string' ? source.date
            : source
      );
    }

    return '';
  }

  parseDateIsoFromRecordTitle(recordName) {
    const title = typeof recordName === 'string'
      ? recordName.trim().replace(/\b(\d{1,2})(st|nd|rd|th)\b/gi, '$1')
      : '';
    if (!title) return '';

    const direct = this.normalizeDateToIso(title);
    if (direct) return direct;

    const months = {
      jan: 1, january: 1,
      feb: 2, february: 2,
      mar: 3, march: 3,
      apr: 4, april: 4,
      may: 5,
      jun: 6, june: 6,
      jul: 7, july: 7,
      aug: 8, august: 8,
      sep: 9, sept: 9, september: 9,
      oct: 10, october: 10,
      nov: 11, november: 11,
      dec: 12, december: 12
    };
    const monthFirst = title.match(/^(?:[A-Za-z]{3,9}\s+)?([A-Za-z]{3,9})\s+(\d{1,2}),?\s+(\d{4})$/);
    const dayFirst = title.match(/^(\d{1,2})\s+([A-Za-z]{3,9}),?\s+(\d{4})$/);
    const match = monthFirst || dayFirst;
    if (!match) return '';

    const monthName = (monthFirst ? match[1] : match[2]).toLowerCase();
    const month = months[monthName] || 0;
    const day = Number(monthFirst ? match[2] : match[1]);
    const year = Number(match[3]);
    if (!Number.isFinite(year) || !Number.isFinite(day) || month <= 0 || day <= 0 || day > 31) return '';
    const parsed = new Date(year, month - 1, day);
    if (parsed.getFullYear() !== year || parsed.getMonth() !== month - 1 || parsed.getDate() !== day) return '';
    return `${this.padDateTimeNumber(year, 4)}-${this.padDateTimeNumber(month, 2)}-${this.padDateTimeNumber(day, 2)}`;
  }

  getRecordDateReferenceIso(record) {
    if (!record) return '';

    try {
      const details = typeof record.getJournalDetails === 'function' ? record.getJournalDetails() : null;
      const journalDate = this.normalizeDateToIso(details?.date || null);
      if (journalDate) return journalDate;
    } catch (e) {
      // Fall back to parsing date-like page titles below.
    }

    return this.parseDateIsoFromRecordTitle(record.getName?.() || '');
  }

  getLinkedReferenceSearchSpecs(recordGuid, targetRecord) {
    const guid = (recordGuid || '').trim();
    if (!guid) return [];

    const specs = [{ kind: 'linkto', query: `@linkto = "${guid}"` }];
    const dateIso = this.getRecordDateReferenceIso(targetRecord);
    if (dateIso) {
      specs.push({ kind: 'datetime', query: `@date = "${dateIso}"`, dateIso });
    }
    return specs;
  }

  async runLinkedReferenceSearch(recordGuid, maxResults, { targetRecord } = {}) {
    const specs = this.getLinkedReferenceSearchSpecs(recordGuid, targetRecord);
    const searches = await Promise.all(specs.map(async (spec) => {
      try {
        return {
          ...spec,
          status: 'fulfilled',
          value: await this.data.searchByQuery(spec.query, maxResults)
        };
      } catch (e) {
        return {
          ...spec,
          status: 'rejected',
          reason: e
        };
      }
    }));

    return {
      status: 'fulfilled',
      value: { searches }
    };
  }

  mergeLinkedReferenceSearchLines(searches) {
    const lines = [];
    const seenLineGuids = new Set();

    for (const search of searches || []) {
      if (search?.status !== 'fulfilled' || search?.value?.error) continue;
      for (const line of search.value?.lines || []) {
        const guid = line?.guid || '';
        if (guid && seenLineGuids.has(guid)) continue;
        if (guid) seenLineGuids.add(guid);
        lines.push(line);
      }
    }

    return lines;
  }

  resolveLinkedReferenceSearch(searchSettled, recordGuid, { showSelf }) {
    let linkedError = '';
    let linkedGroups = [];

    if (searchSettled?.status === 'fulfilled') {
      const searches = Array.isArray(searchSettled.value?.searches)
        ? searchSettled.value.searches
        : [{ kind: 'linkto', status: 'fulfilled', value: searchSettled.value }];
      const primarySearch = searches.find((search) => search?.kind === 'linkto') || searches[0] || null;
      const primaryResult = primarySearch?.value || null;
      if (primarySearch?.status === 'rejected') {
        linkedError = 'Error loading linked references.';
      } else if (primaryResult?.error) {
        linkedError = primaryResult.error;
      } else {
        const lines = this.mergeLinkedReferenceSearchLines(searches);
        linkedGroups = this.groupBacklinkLines(lines, recordGuid, { showSelf });
      }
    } else {
      linkedError = 'Error loading linked references.';
    }

    return { linkedError, linkedGroups };
  }

  buildLiteralPhraseSearchQuery(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return '';
    const escaped = text
      .replace(/\\/g, '\\\\')
      .replace(/"/g, '\\"')
      .replace(/\s+/g, ' ');
    return `"${escaped}"`;
  }

  shouldIncludeMentionAlias(value) {
    const text = typeof value === 'string' ? value.trim() : '';
    if (!text) return false;
    const words = text.split(/\s+/).filter(Boolean);
    if (words.length >= 2) return true;
    if (/^[A-Z0-9]{2,8}$/.test(text)) return true;
    return text.length >= 8;
  }

  getRecordMentionPhrases(recordName) {
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
      const baseTitle = parentheticalMatch[1].trim();
      const alias = parentheticalMatch[2].trim();
      add(baseTitle);
      if (this.shouldIncludeMentionAlias(alias)) add(alias);
    }

    for (const separator of [' / ', ' | ']) {
      if (!title.includes(separator)) continue;
      const parts = title.split(separator).map((part) => part.trim()).filter(Boolean);
      for (const part of parts) {
        if (this.shouldIncludeMentionAlias(part)) add(part);
      }
    }

    return out;
  }

  getUnlinkedSearchPhrases(recordName) {
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

    for (const phrase of this.getRecordMentionPhrases(recordName)) {
      add(phrase);

      if (/[\/|:_\-\u2010-\u2015]/.test(phrase)) {
        const normalized = this.getPhraseBoundaryTokens(phrase).join(' ');
        if (normalized && normalized.toLowerCase() !== phrase.toLowerCase()) add(normalized);
      }
    }

    return out.slice(0, 6);
  }

  buildUnlinkedSearchQuery(recordName) {
    const phrases = this.getUnlinkedSearchPhrases(recordName)
      .map((phrase) => this.buildLiteralPhraseSearchQuery(phrase))
      .filter(Boolean);
    if (phrases.length === 0) return '';
    if (phrases.length === 1) return phrases[0];
    return phrases.join(' OR ');
  }

  async loadUnlinkedReferenceGroups(recordName, maxResults, { recordGuid, linkedGroups, showSelf }) {
    try {
      const query = this.buildUnlinkedSearchQuery(recordName) || this.buildLiteralPhraseSearchQuery(recordName) || recordName;
      const result = await this.data.searchByQuery(query, maxResults);
      if (result?.error) {
        return { unlinkedError: result.error, unlinkedGroups: [] };
      }

      const lines = Array.isArray(result?.lines) ? result.lines : [];
      return {
        unlinkedError: '',
        unlinkedGroups: this.groupUnlinkedReferenceLines(lines, linkedGroups, recordGuid, recordName, { showSelf })
      };
    } catch (e) {
      return {
        unlinkedError: 'Error loading unlinked references.',
        unlinkedGroups: []
      };
    }
  }

  async loadFollowupReferenceResults(state, record, {
    recordGuid,
    recordName,
    maxResults,
    showSelf,
    linkedGroups
  }) {
    const shouldLoadUnlinked = Boolean(recordName) && !this.isSectionCollapsed(state, 'unlinked');
    const propertyResult = this.getPropertyBacklinkResult(recordGuid, { showSelf });
    const followupPromises = [
      Promise.resolve(propertyResult)
    ];

    if (shouldLoadUnlinked) {
      followupPromises.push(
        this.loadUnlinkedReferenceGroups(recordName, maxResults, {
          recordGuid,
          linkedGroups,
          showSelf
        })
      );
    }

    const [propertySettled, unlinkedSettled] = await Promise.allSettled(followupPromises);

    let propertyError = '';
    let propertyGroups = [];
    if (propertySettled.status === 'fulfilled') {
      propertyError = propertySettled.value?.propertyError || '';
      propertyGroups = Array.isArray(propertySettled.value?.propertyGroups)
        ? propertySettled.value.propertyGroups
        : [];
    } else {
      propertyError = 'Error loading property references.';
    }

    const unlinkedDeferred = Boolean(recordName) && !shouldLoadUnlinked;
    let unlinkedError = '';
    let unlinkedGroups = [];
    if (recordName && shouldLoadUnlinked) {
      if (unlinkedSettled.status === 'fulfilled') {
        unlinkedError = unlinkedSettled.value?.unlinkedError || '';
        unlinkedGroups = Array.isArray(unlinkedSettled.value?.unlinkedGroups)
          ? unlinkedSettled.value.unlinkedGroups
          : [];
      } else {
        unlinkedError = 'Error loading unlinked references.';
      }
    }

    return {
      propertyError,
      propertyGroups,
      propertyIndexStatus: propertySettled.status === 'fulfilled'
        ? propertySettled.value?.propertyIndexStatus || 'idle'
        : 'error',
      propertyIndexStats: propertySettled.status === 'fulfilled'
        ? propertySettled.value?.propertyIndexStats || this.createEmptyPropertyIndexStats()
        : this.createEmptyPropertyIndexStats(),
      propertyIndexError: propertySettled.status === 'fulfilled'
        ? propertySettled.value?.propertyIndexError || ''
        : 'Error loading property references.',
      unlinkedError,
      unlinkedGroups,
      unlinkedDeferred,
      unlinkedLoading: false,
      maxResults
    };
  }

  applyRefreshedResults(state, results, { reason } = {}) {
    state.lastResults = results;
    if (!this.isPanelVisible(state?.panel || null)) {
      this.unmountFooterForHiddenPanel(state);
      return;
    }
    this.syncScopedQueryWithCurrentInput(state, { immediate: true, reason: reason || 'refresh' });
    this.applyLiveSnapshot(state, this.buildResultsSnapshot(results.propertyGroups, results.linkedGroups));
    this.invalidateLinkedContextCache(state);
    this.renderFromCache(state);
    this.scheduleContextAvailabilityPreload(state, results, { reason: reason || 'refresh' });
    if (state.lastResults?.unlinkedDeferred === true && !this.isSectionCollapsed(state, 'unlinked')) {
      this.ensureDeferredUnlinkedLoaded(state).catch(() => {
        // ignore
      });
    }
  }

  scheduleContextAvailabilityPreload(state, results, { reason } = {}) {
    if (!state || !results) return;
    if (!this.isPanelVisible(state.panel || null)) return;
    if (state.contextPreloadTimer) {
      clearTimeout(state.contextPreloadTimer);
      state.contextPreloadTimer = null;
    }

    const seq = (state.contextPreloadSeq || 0) + 1;
    state.contextPreloadSeq = seq;
    state.contextPreloadTimer = setTimeout(() => {
      state.contextPreloadTimer = null;
      this.preloadContextAvailability(state.panelId, seq, results, { reason }).catch(() => {
        // Context availability is opportunistic; failed preloads should not disrupt the panel.
      });
    }, 0);
  }

  collectContextPreloadLines(results) {
    const out = [];
    const seen = new Set();
    const appendGroups = (groups) => {
      for (const group of groups || []) {
        for (const line of group?.lines || []) {
          const guid = line?.guid || '';
          if (!guid || seen.has(guid)) continue;
          if (typeof line?.getTreeContext !== 'function') continue;
          seen.add(guid);
          out.push(line);
        }
      }
    };

    appendGroups(results?.linkedGroups || []);
    if (results?.unlinkedDeferred !== true && results?.unlinkedLoading !== true) {
      appendGroups(results?.unlinkedGroups || []);
    }
    return out;
  }

  async preloadContextAvailability(panelId, seq, results) {
    const state = this._panelStates.get(panelId) || null;
    if (!state || state.contextPreloadSeq !== seq || state.lastResults !== results) return;

    for (const line of this.collectContextPreloadLines(results)) {
      if (!this._panelStates.has(panelId)) return;
      if (state.contextPreloadSeq !== seq || state.lastResults !== results) return;
      const ctx = this.getLinkedContextState(state, line?.guid || null);
      if (!ctx || ctx.loaded === true || ctx.loading === true) continue;
      await this.ensureLinkedContextLoaded(state, line, { background: true });
    }
  }

  async refreshPanel(panelId, { reason } = {}) {
    const state = this._panelStates.get(panelId) || null;
    const panel = state?.panel || null;
    if (!state || !panel) return;

    const record = panel.getActiveRecord?.() || null;
    const recordGuid = record?.guid || null;
    if (!recordGuid) return;

    // Keep state in sync in case of churn.
    state.recordGuid = recordGuid;

    if (!this.isPanelVisible(panel)) {
      this.unmountFooterForHiddenPanel(state);
      return;
    }

    if (!state.rootEl || !state.rootEl.isConnected) {
      this.mountFooter(panel, state);
    }

    if (!state.bodyEl || !state.countEl) return;

    const seq = (state.refreshSeq || 0) + 1;
    state.refreshSeq = seq;

    this.setLoadingState(state, true);

    try {
      const { maxResults, showSelf } = this.getRefreshConfig();

      const recordName = (record?.getName?.() || '').trim();
      const searchSettled = await this.runLinkedReferenceSearch(recordGuid, maxResults, { targetRecord: record });

      if (!this.isRefreshStateCurrent(panelId, state, seq)) return;

      const { linkedError, linkedGroups } = this.resolveLinkedReferenceSearch(
        searchSettled,
        recordGuid,
        { showSelf }
      );

      const followupResults = await this.loadFollowupReferenceResults(state, record, {
        recordGuid,
        recordName,
        maxResults,
        showSelf,
        linkedGroups
      });

      if (!this.isRefreshStateCurrent(panelId, state, seq)) return;

      this.applyRefreshedResults(state, {
        ...followupResults,
        linkedGroups,
        linkedError
      }, { reason: reason || 'refresh' });
    } finally {
      if (this.isRefreshStateCurrent(panelId, state, seq)) {
        this.setLoadingState(state, false);
      }
    }
  }

  async ensureDeferredUnlinkedLoaded(state) {
    const results = state?.lastResults || null;
    if (!state || !results) return;
    if (results.unlinkedDeferred !== true) return;
    if (results.unlinkedLoading === true) return;

    const panel = state.panel || null;
    const record = panel?.getActiveRecord?.() || null;
    const recordGuid = record?.guid || state.recordGuid || null;
    const recordName = (record?.getName?.() || '').trim();
    if (!recordGuid || !recordName) return;

    const seq = state.refreshSeq || 0;
    results.unlinkedLoading = true;
    results.unlinkedError = '';
    this.renderFromCache(state);

    const { maxResults, showSelf } = this.getRefreshConfig();
    const { unlinkedGroups: nextGroups, unlinkedError: nextError } = await this.loadUnlinkedReferenceGroups(
      recordName,
      maxResults,
      {
        recordGuid,
        linkedGroups: Array.isArray(results.linkedGroups) ? results.linkedGroups : [],
        showSelf
      }
    );

    if (!this._panelStates.has(state.panelId)) return;
    if (state.lastResults !== results) return;
    if (state.refreshSeq !== seq) return;
    if ((state.recordGuid || '') !== recordGuid) return;

    results.unlinkedGroups = nextGroups;
    results.unlinkedError = nextError;
    results.unlinkedDeferred = false;
    results.unlinkedLoading = false;
    this.syncScopedQueryWithCurrentInput(state, { immediate: true, reason: 'deferred-unlinked-loaded' });
    this.renderFromCache(state);
    this.scheduleContextAvailabilityPreload(state, results, { reason: 'deferred-unlinked-loaded' });
  }

  setLoadingState(state, isLoading) {
    if (!state?.rootEl) return;
    state.isLoading = isLoading === true;
    state.rootEl.classList.toggle('tlr-loading', isLoading === true);
  }

  // ---------- Event-driven freshness ----------

  getEventRecordGuid(ev) {
    const guid = typeof ev?.recordGuid === 'string'
      ? ev.recordGuid
      : (typeof ev?.guid === 'string' ? ev.guid : '');
    return guid.trim();
  }

  getEventLineSegments(ev) {
    if (!ev) return [];
    if (ev?.hasSegments?.() && typeof ev.getSegments === 'function') {
      return ev.getSegments() || [];
    }
    if (Array.isArray(ev?.segments)) return ev.segments;
    if (Array.isArray(ev?.rawSegments)) return ev.rawSegments;
    return [];
  }

  getStateRecordName(state) {
    return (state?.panel?.getActiveRecord?.()?.getName?.() || '').trim();
  }

  getStateRecordDateReferenceIso(state) {
    const record = state?.panel?.getActiveRecord?.()
      || this.data.getRecord?.(state?.recordGuid || '')
      || null;
    return this.getRecordDateReferenceIso(record);
  }

  recordReferencesGuid(record, targetGuid) {
    const guid = (targetGuid || '').trim();
    if (!guid || !record || typeof record.getAllProperties !== 'function') return false;
    const props = record.getAllProperties() || [];
    for (const prop of props) {
      if (this.propertyReferencesGuid(prop, guid)) return true;
    }
    return false;
  }

  refreshMatchingStates(ev, reason, matcher) {
    const match = typeof matcher === 'function' ? matcher : null;
    let refreshed = 0;

    for (const state of this._panelStates.values()) {
      const panel = state?.panel || null;
      if (!panel || !state?.recordGuid) continue;
      if (match && match(state) !== true) continue;

      this.markStatePendingRemote(state, ev);
      this.scheduleRefreshForPanel(panel, { force: false, reason: reason || 'workspace-invalidated' });
      refreshed += 1;
    }

    return refreshed;
  }

  recordEventAffectsState(state, sourceRecordGuid, sourceRecord) {
    const targetGuid = (state?.recordGuid || '').trim();
    if (!targetGuid) return false;
    if (sourceRecordGuid && sourceRecordGuid === targetGuid) return true;
    if (sourceRecordGuid && this.snapshotIncludesSourceRecord(state, sourceRecordGuid)) return true;
    if (sourceRecord && this.recordReferencesGuid(sourceRecord, targetGuid)) return true;
    return false;
  }

  lineEventAffectsState(state, { sourceRecordGuid, segments, referencedGuids } = {}) {
    const targetGuid = (state?.recordGuid || '').trim();
    if (!targetGuid) return false;
    if (sourceRecordGuid && sourceRecordGuid === targetGuid) return true;
    if (sourceRecordGuid && this.snapshotIncludesSourceRecord(state, sourceRecordGuid)) return true;
    if (referencedGuids instanceof Set && referencedGuids.has(targetGuid)) return true;

    const targetDateIso = this.getStateRecordDateReferenceIso(state);
    if (targetDateIso && Array.isArray(segments) && segments.length > 0) {
      if (this.lineHasDateTimeForDate({ segments }, targetDateIso)) return true;
    }

    const targetName = this.getStateRecordName(state);
    if (targetName && Array.isArray(segments) && segments.length > 0) {
      return this.lineHasTextMentionOfRecord({ segments }, targetName);
    }

    return false;
  }

  handleRecordUpdated(ev) {
    // Property-based references (record-link fields) do not emit lineitem events.
    if (!ev) return;
    if (!ev.properties) return;

    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const sourceRecord = sourceRecordGuid ? (this.data.getRecord?.(sourceRecordGuid) || null) : null;
    if (!this.updatePropertyIndexForRecord(sourceRecordGuid, sourceRecord)) {
      this.schedulePropertyIndexRebuild('record.updated-property-index-rebuild');
    }
  }

  handleRecordCreated(ev) {
    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const sourceRecord = sourceRecordGuid ? (this.data.getRecord?.(sourceRecordGuid) || null) : null;
    if (sourceRecordGuid && sourceRecord) {
      this.updatePropertyIndexForRecord(sourceRecordGuid, sourceRecord);
    } else {
      this.schedulePropertyIndexRebuild('record.created-property-index-rebuild');
    }
    const refreshed = this.refreshMatchingStates(ev, 'record.created', (state) =>
      this.recordEventAffectsState(state, sourceRecordGuid, sourceRecord)
    );
    if (refreshed === 0 && !sourceRecordGuid) {
      this.handleWorkspaceInvalidation(ev, 'record.created');
    }
  }

  handleRecordMoved(ev) {
    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const sourceRecord = sourceRecordGuid ? (this.data.getRecord?.(sourceRecordGuid) || null) : null;
    const refreshed = this.refreshMatchingStates(ev, 'record.moved', (state) =>
      this.recordEventAffectsState(state, sourceRecordGuid, sourceRecord)
    );
    if (refreshed === 0 && !sourceRecordGuid) {
      this.handleWorkspaceInvalidation(ev, 'record.moved');
    }
  }

  handleLineItemUpdated(ev) {
    if (!ev) return;

    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const segments = this.getEventLineSegments(ev);
    const referencedGuids = this.extractReferencedRecordGuids(segments);
    const refreshed = this.refreshMatchingStates(ev, 'lineitem.updated', (state) =>
      this.lineEventAffectsState(state, { sourceRecordGuid, segments, referencedGuids })
    );
    if (refreshed === 0 && !sourceRecordGuid && segments.length === 0) {
      this.handleWorkspaceInvalidation(ev, 'lineitem.updated');
    }
  }

  handleLineItemCreated(ev) {
    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const segments = this.getEventLineSegments(ev);
    const referencedGuids = this.extractReferencedRecordGuids(segments);
    const refreshed = this.refreshMatchingStates(ev, 'lineitem.created', (state) =>
      this.lineEventAffectsState(state, { sourceRecordGuid, segments, referencedGuids })
    );
    if (refreshed === 0 && !sourceRecordGuid && segments.length === 0) {
      this.handleWorkspaceInvalidation(ev, 'lineitem.created');
    }
  }

  handleLineItemMoved(ev) {
    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const segments = this.getEventLineSegments(ev);
    const referencedGuids = this.extractReferencedRecordGuids(segments);
    const refreshed = this.refreshMatchingStates(ev, 'lineitem.moved', (state) =>
      this.lineEventAffectsState(state, { sourceRecordGuid, segments, referencedGuids })
    );
    if (refreshed === 0 && !sourceRecordGuid && segments.length === 0) {
      this.handleWorkspaceInvalidation(ev, 'lineitem.moved');
    }
  }

  handleLineItemUndeleted(ev) {
    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const segments = this.getEventLineSegments(ev);
    const referencedGuids = this.extractReferencedRecordGuids(segments);
    const refreshed = this.refreshMatchingStates(ev, 'lineitem.undeleted', (state) =>
      this.lineEventAffectsState(state, { sourceRecordGuid, segments, referencedGuids })
    );
    if (refreshed === 0 && !sourceRecordGuid && segments.length === 0) {
      this.handleWorkspaceInvalidation(ev, 'lineitem.undeleted');
    }
  }

  handleLineItemDeleted(ev) {
    const sourceRecordGuid = this.getEventRecordGuid(ev);
    const segments = this.getEventLineSegments(ev);
    const referencedGuids = this.extractReferencedRecordGuids(segments);
    const refreshed = this.refreshMatchingStates(ev, 'lineitem.deleted', (state) =>
      this.lineEventAffectsState(state, { sourceRecordGuid, segments, referencedGuids })
    );
    if (refreshed === 0 && !sourceRecordGuid && segments.length === 0) {
      this.handleWorkspaceInvalidation(ev, 'lineitem.deleted');
    }
  }

  countLinkedReferences(groups) {
    let total = 0;
    for (const g of groups || []) {
      for (const line of g?.lines || []) {
        total += 1;
      }
    }
    return total;
  }

  getLinkedContextState(state, lineGuid) {
    if (!state) return null;
    if (!(state.linkedContextByLine instanceof Map)) state.linkedContextByLine = new Map();

    const guid = (lineGuid || '').trim();
    if (!guid) return null;

    let ctx = state.linkedContextByLine.get(guid) || null;
    if (ctx) return ctx;

    ctx = {
      lineGuid: guid,
      showMoreContext: false,
      siblingAboveCount: 0,
      siblingBelowCount: 0,
      loaded: false,
      loading: false,
      loadPromise: null,
      error: '',
      descendants: [],
      depthByGuid: {},
      relativeDepthByGuid: {},
      aboveItems: [],
      belowItems: []
    };
    state.linkedContextByLine.set(guid, ctx);
    return ctx;
  }

  hasRequestedLinkedContext(ctx) {
    return Boolean(
      ctx && (ctx.showMoreContext === true || (ctx.siblingAboveCount || 0) > 0 || (ctx.siblingBelowCount || 0) > 0)
    );
  }

  getAvailableAboveContextCount(ctx) {
    if (!ctx || ctx.loaded !== true) return null;
    return Array.isArray(ctx.aboveItems) ? ctx.aboveItems.length : 0;
  }

  getAvailableBelowContextCount(ctx) {
    if (!ctx || ctx.loaded !== true) return null;
    return Array.isArray(ctx.belowItems) ? ctx.belowItems.length : 0;
  }

  getVisibleAboveContextItems(ctx) {
    if (!ctx || ctx.loaded !== true || !Array.isArray(ctx.aboveItems)) return [];
    const available = this.getAvailableAboveContextCount(ctx) || 0;
    const count = Math.max(0, Math.min(ctx.siblingAboveCount || 0, available));
    if (count === 0) return [];
    const start = Math.max(0, ctx.aboveItems.length - count);
    return ctx.aboveItems.slice(start);
  }

  getVisibleBelowContextItems(ctx) {
    if (!ctx || ctx.loaded !== true || !Array.isArray(ctx.belowItems)) return [];
    const available = this.getAvailableBelowContextCount(ctx) || 0;
    const count = Math.max(0, Math.min(ctx.siblingBelowCount || 0, available));
    if (count === 0) return [];
    return ctx.belowItems.slice(0, count);
  }

  hasAnyLinkedContext(ctx) {
    if (!ctx || ctx.loaded !== true) return false;
    return Boolean(
      (ctx.descendants || []).length > 0 ||
      this.getAvailableAboveContextCount(ctx) > 0 ||
      this.getAvailableBelowContextCount(ctx) > 0
    );
  }

  getAboveToggleLabel(ctx) {
    const shown = ctx?.siblingAboveCount || 0;
    const available = this.getAvailableAboveContextCount(ctx);
    if (shown <= 0) return 'Show above';
    if (available === null || shown < available) return 'More above';
    return 'Hide above';
  }

  getBelowToggleLabel(ctx) {
    const shown = ctx?.siblingBelowCount || 0;
    const available = this.getAvailableBelowContextCount(ctx);
    if (shown <= 0) return 'Show below';
    if (available === null || shown < available) return 'More below';
    return 'Hide below';
  }

  adjustContextWindowCount(current, available) {
    const now = Math.max(0, current || 0);
    if (available !== null && available <= 0) return 0;
    if (now <= 0) return 1;
    if (available === null) return now + 1;
    if (now < available) return now + 1;
    return 0;
  }

  resetLinkedContextState(ctx) {
    if (!ctx) return;
    ctx.showMoreContext = false;
    ctx.siblingAboveCount = 0;
    ctx.siblingBelowCount = 0;
    ctx.error = '';
  }

  findContextLineByGuid(state, lineGuid) {
    const target = (lineGuid || '').trim();
    if (!target || !state?.lastResults) return null;
    const groups = [
      ...(Array.isArray(state.lastResults?.linkedGroups) ? state.lastResults.linkedGroups : []),
      ...(Array.isArray(state.lastResults?.unlinkedGroups) ? state.lastResults.unlinkedGroups : [])
    ];

    for (const g of groups) {
      for (const line of g?.lines || []) {
        if ((line?.guid || '') === target) return line;
      }
    }

    return null;
  }

  async collectDescendantContext(line, treeContext = null) {
    const rootGuid = line?.guid || null;
    const tree = treeContext || (typeof line?.getTreeContext === 'function'
      ? await line.getTreeContext().catch(() => null)
      : null);
    const descendants = Array.isArray(tree?.descendants) ? tree.descendants.filter(Boolean) : [];
    const depthByGuid = {};

    if (!rootGuid || descendants.length === 0) {
      return { descendants, depthByGuid };
    }

    const parentByGuid = this.buildParentGuidMap(null, descendants);
    const scopedDescendants = [];

    for (const item of descendants) {
      const guid = item?.guid || null;
      if (!guid) continue;
      const depth = this.getLineDepthFromAncestor(guid, rootGuid, parentByGuid);
      if (depth === null) continue;
      depthByGuid[guid] = depth;
      scopedDescendants.push(item);
    }

    return { descendants: scopedDescendants, depthByGuid };
  }

  async collectBaselineContextItems(line, treeContext = null) {
    if (!line) return { baselineRootGuid: null, items: [] };

    const tree = treeContext || (typeof line?.getTreeContext === 'function'
      ? await line.getTreeContext().catch(() => null)
      : null);
    const ancestors = Array.isArray(tree?.ancestors) ? tree.ancestors.filter(Boolean) : [];
    const baselineRoot = ancestors.length > 0
      ? ancestors[ancestors.length - 1]
      : line;
    const baselineRootGuid = baselineRoot?.guid || line?.guid || null;

    const baselineTree = baselineRootGuid === (line?.guid || null)
      ? tree
      : (typeof baselineRoot?.getTreeContext === 'function'
        ? await baselineRoot.getTreeContext().catch(() => null)
        : null);
    const descendants = Array.isArray(baselineTree?.descendants)
      ? baselineTree.descendants.filter(Boolean)
      : [];
    const items = [];

    if (baselineRoot?.guid) items.push(baselineRoot);
    for (const item of descendants) {
      const guid = item?.guid || null;
      if (!guid || guid === baselineRootGuid) continue;
      items.push(item);
    }

    return { baselineRootGuid, items };
  }

  buildRecordDocumentOrder(record, items) {
    const recordGuid = record?.guid || null;
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    if (!recordGuid || list.length === 0) return list;

    const childrenByParent = new Map();
    const visited = new Set();
    const ordered = [];

    for (const item of list) {
      const guid = item?.guid || null;
      if (!guid) continue;

      const parentGuid = typeof item?.parent_guid === 'string' && item.parent_guid
        ? item.parent_guid
        : recordGuid;
      const key = parentGuid === recordGuid ? recordGuid : parentGuid;

      if (!childrenByParent.has(key)) childrenByParent.set(key, []);
      childrenByParent.get(key).push(item);
    }

    const walk = (parentGuid) => {
      const children = childrenByParent.get(parentGuid) || [];
      for (const item of children) {
        const guid = item?.guid || null;
        if (!guid || visited.has(guid)) continue;
        visited.add(guid);
        ordered.push(item);
        walk(guid);
      }
    };

    walk(recordGuid);

    for (const item of list) {
      const guid = item?.guid || null;
      if (!guid || visited.has(guid)) continue;
      visited.add(guid);
      ordered.push(item);
    }

    return ordered;
  }

  buildParentGuidMap(record, items) {
    const recordGuid = record?.guid || null;
    const map = new Map();

    for (const item of Array.isArray(items) ? items : []) {
      const guid = item?.guid || null;
      if (!guid) continue;
      const parentGuid = typeof item?.parent_guid === 'string' && item.parent_guid
        ? item.parent_guid
        : recordGuid;
      map.set(guid, parentGuid || null);
    }

    return map;
  }

  getLineDepthFromAncestor(lineGuid, ancestorGuid, parentByGuid) {
    const guid = lineGuid || null;
    const ancestor = ancestorGuid || null;
    if (!guid || !ancestor || !(parentByGuid instanceof Map) || guid === ancestor) return null;

    let depth = 0;
    let currentGuid = guid;
    const seen = new Set();

    while (currentGuid && !seen.has(currentGuid)) {
      seen.add(currentGuid);
      const parentGuid = parentByGuid.get(currentGuid) || null;
      if (!parentGuid) return null;
      depth += 1;
      if (parentGuid === ancestor) return depth;
      currentGuid = parentGuid;
    }

    return null;
  }

  isLineWithinSubtree(lineGuid, subtreeRootGuid, parentByGuid) {
    if (!lineGuid || !subtreeRootGuid) return false;
    if (lineGuid === subtreeRootGuid) return true;
    return this.getLineDepthFromAncestor(lineGuid, subtreeRootGuid, parentByGuid) !== null;
  }

  findBaselineContextRootGuid(record, matchedGuid, parentByGuid) {
    const recordGuid = record?.guid || null;
    let currentGuid = matchedGuid || null;
    if (!recordGuid || !currentGuid || !(parentByGuid instanceof Map)) return currentGuid;

    const seen = new Set();
    while (currentGuid && !seen.has(currentGuid)) {
      seen.add(currentGuid);
      const parentGuid = parentByGuid.get(currentGuid) || null;
      if (!parentGuid || parentGuid === recordGuid) return currentGuid;
      currentGuid = parentGuid;
    }

    return matchedGuid || null;
  }

  scopeContextItemsToBaseline(record, items, matchedGuid) {
    const list = Array.isArray(items) ? items.filter(Boolean) : [];
    const parentByGuid = this.buildParentGuidMap(record, list);
    const baselineRootGuid = this.findBaselineContextRootGuid(record, matchedGuid, parentByGuid);
    const scopedItems = baselineRootGuid
      ? list.filter((item) => this.isLineWithinSubtree(item?.guid || null, baselineRootGuid, parentByGuid))
      : list;

    return {
      baselineRootGuid,
      items: scopedItems,
      parentByGuid
    };
  }

  async ensureLinkedContextLoaded(state, line, { background } = {}) {
    const ctx = this.getLinkedContextState(state, line?.guid || null);
    if (!ctx || !line) return null;
    if (ctx.loaded === true) return ctx;
    if (ctx.loading === true && ctx.loadPromise) return ctx.loadPromise;

    ctx.loading = true;
    ctx.backgroundLoading = background === true;
    ctx.error = '';
    if (background !== true) {
      this.renderFromCache(state);
    }

    ctx.loadPromise = (async () => {
      const treeContext = await line.getTreeContext();
      const descendantContext = await this.collectDescendantContext(line, treeContext);
      const matchedGuid = line?.guid || '';
      const record = typeof line?.getRecord === 'function' ? line.getRecord() : (line?.record || null);
      const baselineContext = await this.collectBaselineContextItems(line, treeContext);
      const baselineItems = baselineContext.items.length > 0
        ? baselineContext.items
        : [
          line,
          ...(Array.isArray(descendantContext.descendants) ? descendantContext.descendants : [])
        ];
      const scopedBaseline = this.scopeContextItemsToBaseline(record, baselineItems, matchedGuid);
      const scopedItems = this.buildRecordDocumentOrder(
        record,
        Array.isArray(scopedBaseline?.items) && scopedBaseline.items.length > 0
          ? scopedBaseline.items
          : baselineItems.filter(Boolean)
      );
      const baselineParentByGuid = scopedBaseline?.parentByGuid instanceof Map
        ? scopedBaseline.parentByGuid
        : this.buildParentGuidMap(record, scopedItems);
      const descendants = [];
      const depthByGuid = {};
      const relativeDepthByGuid = {};
      const baselineRootGuid = scopedBaseline?.baselineRootGuid || baselineContext?.baselineRootGuid || null;
      const matchedRootDepth = baselineRootGuid && matchedGuid && baselineRootGuid !== matchedGuid
        ? this.getLineDepthFromAncestor(matchedGuid, baselineRootGuid, baselineParentByGuid)
        : 0;
      const matchedAbsoluteDepth = Number.isFinite(matchedRootDepth) ? matchedRootDepth : 0;

      for (const item of scopedItems) {
        const guid = item?.guid || '';
        if (!guid) continue;
        const absoluteDepth = !baselineRootGuid || guid === baselineRootGuid
          ? 0
          : this.getLineDepthFromAncestor(guid, baselineRootGuid, baselineParentByGuid);
        if (absoluteDepth === null) continue;
        relativeDepthByGuid[guid] = Math.max(0, absoluteDepth - matchedAbsoluteDepth);
      }

      for (const item of scopedItems) {
        const guid = item?.guid || '';
        if (!guid || guid === matchedGuid) continue;
        const depth = this.getLineDepthFromAncestor(guid, matchedGuid, baselineParentByGuid);
        if (depth === null) continue;
        descendants.push(item);
        depthByGuid[guid] = depth;
      }

      if (descendants.length === 0) {
        for (const item of descendantContext.descendants || []) {
          const guid = item?.guid || '';
          if (!guid || guid === matchedGuid || depthByGuid[guid] != null) continue;
          descendants.push(item);
          depthByGuid[guid] = Number(descendantContext.depthByGuid?.[guid] || 1);
          if (relativeDepthByGuid[guid] == null) {
            relativeDepthByGuid[guid] = Number(descendantContext.depthByGuid?.[guid] || 1);
          }
        }
      }

      const matchedIndex = scopedItems.findIndex((item) => (item?.guid || '') === matchedGuid);
      const aboveItems = [];
      const belowItems = [];

      if (matchedIndex >= 0) {
        let subtreeEndIndex = matchedIndex;
        const descendantGuids = new Set(
          descendants
            .map((item) => item?.guid || '')
            .filter(Boolean)
        );

        for (let i = matchedIndex + 1; i < scopedItems.length; i += 1) {
          const guid = scopedItems[i]?.guid || '';
          if (!guid || !descendantGuids.has(guid)) continue;
          subtreeEndIndex = i;
        }

        aboveItems.push(...scopedItems.slice(0, matchedIndex));
        belowItems.push(...scopedItems.slice(subtreeEndIndex + 1));
      }

      ctx.descendants = descendants;
      ctx.depthByGuid = depthByGuid;
      ctx.relativeDepthByGuid = relativeDepthByGuid;
      ctx.aboveItems = aboveItems;
      ctx.belowItems = belowItems;
      ctx.loaded = true;

      const availableAbove = this.getAvailableAboveContextCount(ctx);
      const availableBelow = this.getAvailableBelowContextCount(ctx);
      ctx.siblingAboveCount = Math.max(0, Math.min(ctx.siblingAboveCount || 0, availableAbove || 0));
      ctx.siblingBelowCount = Math.max(0, Math.min(ctx.siblingBelowCount || 0, availableBelow || 0));
      if (!this.hasAnyLinkedContext(ctx)) {
        ctx.showMoreContext = false;
        ctx.siblingAboveCount = 0;
        ctx.siblingBelowCount = 0;
      }
      return ctx;
    })()
      .catch(() => {
        ctx.error = background === true ? '' : 'Could not load line context.';
        ctx.loaded = false;
        return null;
      })
      .finally(() => {
        ctx.loading = false;
        ctx.backgroundLoading = false;
        ctx.loadPromise = null;
        if (this._panelStates.get(state?.panelId) === state) {
          this.bumpLinkedContextRenderVersion(state);
          this.renderFromCache(state);
        }
      });

    return ctx.loadPromise;
  }

  async handleLinkedContextAction(state, action, lineGuid) {
    const line = this.findContextLineByGuid(state, lineGuid);
    if (!line) return;

    const ctx = this.getLinkedContextState(state, lineGuid);
    if (!ctx) return;

    if (action === 'toggle-context-more') {
      if (ctx.showMoreContext === true) {
        this.resetLinkedContextState(ctx);
        this.bumpLinkedContextRenderVersion(state);
        this.renderFromCache(state);
        return;
      }
      ctx.showMoreContext = true;
    } else if (action === 'toggle-context-above') {
      ctx.siblingAboveCount = this.adjustContextWindowCount(ctx.siblingAboveCount, this.getAvailableAboveContextCount(ctx));
    } else if (action === 'toggle-context-below') {
      ctx.siblingBelowCount = this.adjustContextWindowCount(ctx.siblingBelowCount, this.getAvailableBelowContextCount(ctx));
    } else {
      return;
    }

    this.bumpLinkedContextRenderVersion(state);
    this.renderFromCache(state);
    if (!this.hasRequestedLinkedContext(ctx)) return;
    await this.ensureLinkedContextLoaded(state, line);
  }

  extractReferencedRecordGuids(segments) {
    const out = new Set();
    for (const seg of segments || []) {
      if (seg?.type !== 'ref') continue;
      const guid = seg?.text?.guid || null;
      if (!guid) continue;
      const rec = this.data.getRecord?.(guid) || null;
      if (rec) out.add(guid);
    }
    return out;
  }

  // ---------- Grouping + rendering ----------

  async getPropertyBacklinkGroups(targetRecord, targetGuid, { showSelf } = {}) {
    return this.getPropertyBacklinkGroupsFromIndex(targetGuid, { showSelf });
  }

  buildPropertyBacklinkGroupsFromRecords(sourceRecords, targetGuid, { showSelf }) {
    const byProp = new Map();
    const seenSourceGuids = new Set();

    for (const src of sourceRecords || []) {
      const srcGuid = src?.guid || null;
      if (!srcGuid) continue;
      if (seenSourceGuids.has(srcGuid)) continue;
      seenSourceGuids.add(srcGuid);
      if (!showSelf && srcGuid === targetGuid) continue;

      const props = src.getAllProperties?.() || [];
      for (const p of props || []) {
        const propName = (p?.name || '').trim();
        if (!propName) continue;
        if (!this.propertyReferencesGuid(p, targetGuid)) continue;

        let group = byProp.get(propName) || null;
        if (!group) {
          group = new Map();
          byProp.set(propName, group);
        }
        group.set(srcGuid, src);
      }
    }

    const groups = Array.from(byProp.entries()).map(([propertyName, recordMap]) => ({
      propertyName,
      records: Array.from(recordMap.values())
    }));

    groups.sort((a, b) => {
      const an = (a.propertyName || '').toLowerCase();
      const bn = (b.propertyName || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    for (const g of groups) {
      g.records.sort((a, b) => {
        const ad = a?.getUpdatedAt?.() || null;
        const bd = b?.getUpdatedAt?.() || null;
        const at = ad ? ad.getTime() : 0;
        const bt = bd ? bd.getTime() : 0;
        if (bt !== at) return bt - at;
        const an = (a?.getName?.() || '').toLowerCase();
        const bn = (b?.getName?.() || '').toLowerCase();
        return an < bn ? -1 : an > bn ? 1 : 0;
      });
    }

    return groups;
  }

  propertyReferencesGuid(prop, targetGuid) {
    if (!prop || !targetGuid) return false;

    const values = this.getPropertyCandidateValues(prop);
    for (const v of values) {
      if (v === targetGuid) return true;
    }

    const linkedRecordGuids = this.getPropertyLinkedRecordGuids(prop);
    return linkedRecordGuids?.has?.(targetGuid) === true;
  }

  getPropertyLinkedRecordGuids(prop) {
    if (!prop || typeof prop.linkedRecords !== 'function') return null;

    const out = new Set();
    try {
      const records = prop.linkedRecords() || [];
      for (const record of records) {
        const guid = typeof record?.guid === 'string' ? record.guid.trim() : '';
        if (guid) out.add(guid);
      }
    } catch (e) {
      return null;
    }

    return out;
  }

  getPropertyCandidateValues(prop) {
    const out = [];
    const seen = new Set();

    const push = (v) => {
      if (typeof v !== 'string') return;
      const t = v.trim();
      if (!t) return;
      if (seen.has(t)) return;
      seen.add(t);
      out.push(t);
    };

    let raw = [];
    try {
      if (prop && 'value' in prop) {
        raw.push(prop.value);
      }
    } catch (e) {
      // ignore
    }
    try {
      raw.push(prop.text?.());
    } catch (e) {
      // ignore
    }
    try {
      raw.push(prop.choice?.());
    } catch (e) {
      // ignore
    }
    try {
      const values = prop.values?.();
      if (Array.isArray(values)) raw.push(values);
    } catch (e) {
      // ignore
    }

    for (const r of raw) {
      this.collectPropertyCandidateValues(r, push);
    }

    return out;
  }

  collectPropertyCandidateValues(raw, push) {
    if (raw == null) return;

    if (typeof raw === 'string') {
      for (const v of this.expandPossibleListString(raw)) {
        push(v);
      }
      return;
    }

    if (Array.isArray(raw)) {
      const kind = typeof raw[0] === 'string' ? raw[0].trim().toLowerCase() : '';
      if (raw.length === 2 && kind) {
        if (kind === 'record' || kind === 'records') {
          this.collectPropertyCandidateValues(raw[1], push);
          return;
        }
        if (kind === 'text' || kind === 'url' || kind === 'hashtag' || kind === 'choice'
          || kind === 'datetime' || kind === 'number' || kind === 'banner' || kind === 'file'
          || kind === 'image') {
          this.collectPropertyCandidateValues(raw[1], push);
          return;
        }
      }

      for (const item of raw) {
        this.collectPropertyCandidateValues(item, push);
      }
      return;
    }

    if (typeof raw === 'object') {
      const guidKeys = ['guid', 'recordGuid', 'record_guid', 'targetGuid', 'target_guid'];
      for (const key of guidKeys) {
        const value = raw?.[key];
        if (typeof value === 'string') push(value);
      }

      for (const key of ['value', 'record', 'records', 'linkedRecord', 'linkedRecords', 'target', 'targets', 'item', 'items', 'node', 'nodes', 'ref', 'refs']) {
        if (key in raw) this.collectPropertyCandidateValues(raw[key], push);
      }
    }
  }

  expandPossibleListString(v) {
    if (typeof v !== 'string') return [];
    const t = v.trim();
    if (!t) return [];

    // Some properties may serialize multi-values as JSON.
    if (t.startsWith('[') && t.endsWith(']')) {
      try {
        const parsed = JSON.parse(t);
        if (Array.isArray(parsed)) {
          return parsed
            .filter((x) => typeof x === 'string')
            .map((x) => x.trim())
            .filter(Boolean);
        }
      } catch (e) {
        // fall through
      }
    }

    // Or as a comma-separated list.
    if (t.includes(',')) {
      return t
        .split(',')
        .map((x) => x.trim())
        .filter(Boolean);
    }

    // Or as multi-line text.
    if (t.includes('\n')) {
      return t
        .split(/\r?\n/)
        .map((x) => x.trim())
        .filter(Boolean);
    }

    return [t];
  }

  groupBacklinkLines(lines, targetGuid, { showSelf }) {
    const byRecord = new Map();
    const seenLineGuids = new Set();

    for (const line of lines || []) {
      if (!line || !line.guid || seenLineGuids.has(line.guid)) continue;
      seenLineGuids.add(line.guid);

      const srcRecord = line.record || null;
      const srcGuid = srcRecord?.guid || null;
      if (!srcGuid) continue;
      if (!showSelf && srcGuid === targetGuid) continue;

      const prev = byRecord.get(srcGuid) || { record: srcRecord, lines: [] };
      prev.record = prev.record || srcRecord;
      prev.lines.push(line);
      byRecord.set(srcGuid, prev);
    }

    const groups = Array.from(byRecord.values());
    groups.sort((a, b) => {
      const ad = a.record?.getUpdatedAt?.() || null;
      const bd = b.record?.getUpdatedAt?.() || null;
      const at = ad ? ad.getTime() : 0;
      const bt = bd ? bd.getTime() : 0;
      if (bt !== at) return bt - at;
      const an = (a.record?.getName?.() || '').toLowerCase();
      const bn = (b.record?.getName?.() || '').toLowerCase();
      return an < bn ? -1 : an > bn ? 1 : 0;
    });

    for (const g of groups) {
      g.lines.sort((x, y) => {
        const xd = x?.getCreatedAt?.() || null;
        const yd = y?.getCreatedAt?.() || null;
        const xt = xd ? xd.getTime() : 0;
        const yt = yd ? yd.getTime() : 0;
        return xt - yt;
      });
    }

    return groups;
  }

  groupUnlinkedReferenceLines(lines, linkedGroups, targetGuid, targetName, { showSelf }) {
    const linkedLineGuids = new Set();
    for (const group of linkedGroups || []) {
      for (const line of group?.lines || []) {
        const guid = line?.guid || null;
        if (guid) linkedLineGuids.add(guid);
      }
    }

    const candidates = [];
    for (const line of lines || []) {
      const guid = line?.guid || null;
      if (!guid || linkedLineGuids.has(guid)) continue;

      const srcGuid = line?.record?.guid || null;
      if (!showSelf && srcGuid === targetGuid) continue;
      if (this.lineHasRefToRecord(line, targetGuid)) continue;
      if (!this.lineHasTextMentionOfRecord(line, targetName)) continue;
      candidates.push(line);
    }

    return this.groupBacklinkLines(candidates, targetGuid, { showSelf });
  }

  lineHasRefToRecord(line, recordGuid) {
    const targetGuid = (recordGuid || '').trim();
    if (!targetGuid) return false;

    for (const seg of line?.segments || []) {
      if (seg?.type !== 'ref') continue;
      const textObj = typeof seg?.text === 'string' ? { guid: seg.text } : (seg?.text || {});
      if ((textObj.guid || '') === targetGuid) return true;
    }
    return false;
  }

  dateTimeValueMatchesIso(value, targetIso) {
    const iso = this.normalizeDateToIso(targetIso);
    if (!iso) return false;

    if (typeof value === 'string') {
      return this.normalizeDateToIso(value) === iso;
    }
    if (!value || typeof value !== 'object') return false;

    const startSource = value.start && typeof value.start === 'object'
      ? value.start
      : value.from && typeof value.from === 'object'
        ? value.from
        : value;
    const endSource = value.end && typeof value.end === 'object'
      ? value.end
      : value.to && typeof value.to === 'object'
        ? value.to
        : (value.ed || value.et || value.endDate || value.endTime)
          ? {
              d: value.ed || value.endDate || null,
              t: value.et || value.endTime || null
            }
          : null;

    const startIso = this.normalizeDateToIso(startSource);
    const endIso = this.normalizeDateToIso(endSource);
    if (startIso === iso || endIso === iso) return true;
    if (startIso && endIso) return startIso <= iso && iso <= endIso;
    return false;
  }

  lineHasDateTimeForDate(line, targetIso) {
    const iso = this.normalizeDateToIso(targetIso);
    if (!iso) return false;

    for (const seg of line?.segments || []) {
      if (seg?.type !== 'datetime') continue;
      if (this.dateTimeValueMatchesIso(seg.text, iso)) return true;
    }
    return false;
  }

  lineHasTextMentionOfRecord(line, recordName) {
    const matchers = this.buildRecordMentionMatchers(recordName);
    if (matchers.length === 0) return false;
    const text = this.getLineTextMentionSource(line);
    if (!text) return false;
    return matchers.some((matcher) => matcher.test(text));
  }

  getLineTextMentionSource(line) {
    let out = '';

    for (const seg of line?.segments || []) {
      if (!seg) continue;
      if (seg.type === 'text' || seg.type === 'bold' || seg.type === 'italic' || seg.type === 'code') {
        if (typeof seg.text === 'string') out += seg.text;
      }
    }

    return out;
  }

  getPhraseBoundaryTokens(phrase) {
    const trimmed = typeof phrase === 'string' ? phrase.trim() : '';
    if (!trimmed) return [];
    return trimmed
      .replace(/['’]/g, '')
      .match(/[a-z0-9]+/gi) || [];
  }

  buildPhraseBoundaryPattern(phrase) {
    const tokens = this.getPhraseBoundaryTokens(phrase).map((part) => this.escapeRegExp(part));
    if (tokens.length === 0) return null;

    const separator = `[\\s\\-\\u2010-\\u2015_./,:;!?()[\\]{}"'“”‘’]+`;
    return `(^|[^a-z0-9])(${tokens.join(separator)})(?=$|[^a-z0-9])`;
  }

  buildPhraseBoundaryMatcher(phrase) {
    const pattern = this.buildPhraseBoundaryPattern(phrase);
    if (!pattern) return null;
    return new RegExp(pattern, 'i');
  }

  buildPhraseBoundaryGlobalMatcher(phrase) {
    const pattern = this.buildPhraseBoundaryPattern(phrase);
    if (!pattern) return null;
    return new RegExp(pattern, 'ig');
  }

  buildRecordMentionMatchers(recordName) {
    return this.getRecordMentionPhrases(recordName)
      .map((phrase) => this.buildPhraseBoundaryMatcher(phrase))
      .filter(Boolean);
  }

  buildRecordMentionGlobalMatchers(recordName) {
    return this.getRecordMentionPhrases(recordName)
      .sort((a, b) => b.length - a.length)
      .map((phrase) => this.buildPhraseBoundaryGlobalMatcher(phrase))
      .filter(Boolean);
  }

  findUnlinkedLineByGuid(state, lineGuid) {
    const target = (lineGuid || '').trim();
    if (!target || !state?.lastResults) return null;

    for (const group of state.lastResults?.unlinkedGroups || []) {
      for (const line of group?.lines || []) {
        if ((line?.guid || '') === target) return line;
      }
    }

    return null;
  }

  buildReplacedSegments(segments, recordName, recordGuid) {
    if (!Array.isArray(segments) || !recordGuid) return segments;

    const matchers = this.buildRecordMentionGlobalMatchers(recordName);
    if (matchers.length === 0) return segments;

    const result = [];
    let changed = false;

    for (const seg of segments) {
      if (!seg || !['text', 'bold', 'italic', 'code'].includes(seg.type) || typeof seg.text !== 'string') {
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

      if (matches.length === 0) {
        result.push(seg);
        continue;
      }

      matches.sort((a, b) => (a.start - b.start) || (b.end - a.end));

      let lastIndex = 0;
      let matched = false;

      for (const match of matches) {
        if (match.start < lastIndex) continue;
        matched = true;
        changed = true;

        if (match.start > lastIndex) {
          result.push({ type: seg.type, text: text.slice(lastIndex, match.start) });
        }

        result.push({ type: 'ref', text: { guid: recordGuid, title: match.matchedText } });
        lastIndex = match.end;
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

  async linkUnlinkedReference(state, lineGuid) {
    const panel = state?.panel || null;
    const record = panel?.getActiveRecord?.() || null;
    const recordGuid = (record?.guid || '').trim();
    const recordName = (record?.getName?.() || '').trim();
    if (!recordGuid || !recordName) return;

    const line = this.findUnlinkedLineByGuid(state, lineGuid);
    if (!line || typeof line.setSegments !== 'function') return;
    if (this.lineHasRefToRecord(line, recordGuid)) return;

    const nextSegments = this.buildReplacedSegments(line.segments || [], recordName, recordGuid);
    if (nextSegments === line.segments) return;

    await line.setSegments(nextSegments);
    this.refreshAllPanels({ force: true, reason: 'link-unlinked' });
  }

  escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  sortPropertyGroupsForRender(groups, sortSpec, sortMetrics) {
    return (groups || []).map((g) => {
      const records = Array.isArray(g?.records) ? Array.from(g.records) : [];
      records.sort((a, b) => this.compareRecordsForSort(a, b, sortSpec, sortMetrics));
      return {
        propertyName: g?.propertyName || '',
        records
      };
    });
  }

  sortLinkedGroupsForRender(groups, sortSpec, sortMetrics) {
    const out = (groups || []).map((g) => ({
      record: g?.record || null,
      lines: Array.isArray(g?.lines) ? Array.from(g.lines) : []
    }));

    out.sort((a, b) => this.compareRecordsForSort(a?.record || null, b?.record || null, sortSpec, sortMetrics));
    return out;
  }

  computeRecordSortMetrics(propertyGroups, linkedGroups) {
    const referenceCountByGuid = new Map();
    const referenceActivityByGuid = new Map();

    const addReferenceCount = (recordGuid, delta) => {
      const guid = (recordGuid || '').trim();
      if (!guid) return;
      const n = Number(delta);
      if (!Number.isFinite(n) || n === 0) return;
      const prev = referenceCountByGuid.get(guid) || 0;
      referenceCountByGuid.set(guid, prev + n);
    };

    const setReferenceActivity = (recordGuid, timestamp) => {
      const guid = (recordGuid || '').trim();
      if (!guid) return;
      const ts = Number(timestamp);
      if (!Number.isFinite(ts) || ts <= 0) return;
      const prev = referenceActivityByGuid.get(guid) || 0;
      if (ts > prev) referenceActivityByGuid.set(guid, ts);
    };

    for (const g of propertyGroups || []) {
      for (const record of g?.records || []) {
        const guid = record?.guid || null;
        if (!guid) continue;
        addReferenceCount(guid, 1);
        setReferenceActivity(guid, this.getRecordUpdatedTimestamp(record));
      }
    }

    for (const g of linkedGroups || []) {
      const record = g?.record || null;
      const guid = record?.guid || null;
      if (!guid) continue;

      const lines = Array.isArray(g?.lines) ? g.lines : [];
      if (lines.length === 0) continue;
      addReferenceCount(guid, lines.length);

      let newestLineActivity = 0;
      for (const line of lines) {
        const ts = this.getLineActivityTimestamp(line);
        if (ts > newestLineActivity) newestLineActivity = ts;
      }

      if (newestLineActivity <= 0) {
        newestLineActivity = this.getRecordUpdatedTimestamp(record);
      }
      setReferenceActivity(guid, newestLineActivity);
    }

    return { referenceCountByGuid, referenceActivityByGuid };
  }

  compareRecordsForSort(a, b, sortSpec, sortMetrics) {
    const sortBy = this.normalizeSortBy(sortSpec?.sortBy) || this._defaultSortBy;
    const sortDir = this.normalizeSortDir(sortSpec?.sortDir) || this._defaultSortDir;

    const aGuid = a?.guid || '';
    const bGuid = b?.guid || '';

    let primary = 0;

    if (sortBy === 'page_title') {
      primary = this.compareText(this.getRecordNameForSort(a), this.getRecordNameForSort(b));
    } else if (sortBy === 'page_created_date') {
      primary = this.compareNumbers(this.getRecordCreatedTimestamp(a), this.getRecordCreatedTimestamp(b));
    } else if (sortBy === 'reference_count') {
      const ac = sortMetrics?.referenceCountByGuid?.get?.(aGuid) || 0;
      const bc = sortMetrics?.referenceCountByGuid?.get?.(bGuid) || 0;
      primary = this.compareNumbers(ac, bc);
    } else if (sortBy === 'reference_activity') {
      const at = this.getReferenceActivityTimestamp(a, sortMetrics);
      const bt = this.getReferenceActivityTimestamp(b, sortMetrics);
      primary = this.compareNumbers(at, bt);
    } else {
      primary = this.compareNumbers(this.getRecordUpdatedTimestamp(a), this.getRecordUpdatedTimestamp(b));
    }

    if (sortDir === 'desc') primary *= -1;
    if (primary !== 0) return primary;

    const nameTieBreak = this.compareText(this.getRecordNameForSort(a), this.getRecordNameForSort(b));
    if (nameTieBreak !== 0) return nameTieBreak;

    return this.compareText(aGuid, bGuid);
  }

  getRecordNameForSort(record) {
    return (record?.getName?.() || '').trim().toLowerCase();
  }

  getRecordUpdatedTimestamp(record) {
    const d = record?.getUpdatedAt?.() || null;
    return d instanceof Date ? d.getTime() : 0;
  }

  getRecordCreatedTimestamp(record) {
    const d = record?.getCreatedAt?.() || null;
    return d instanceof Date ? d.getTime() : 0;
  }

  getLineActivityTimestamp(line) {
    const updatedAt = line?.getUpdatedAt?.() || null;
    if (updatedAt instanceof Date) return updatedAt.getTime();
    const createdAt = line?.getCreatedAt?.() || null;
    return createdAt instanceof Date ? createdAt.getTime() : 0;
  }

  getReferenceActivityTimestamp(record, sortMetrics) {
    const guid = record?.guid || '';
    if (!guid) return 0;
    const fromLinked = sortMetrics?.referenceActivityByGuid?.get?.(guid) || 0;
    if (fromLinked > 0) return fromLinked;
    return this.getRecordUpdatedTimestamp(record);
  }

  compareNumbers(a, b) {
    const av = Number(a) || 0;
    const bv = Number(b) || 0;
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  }

  compareText(a, b) {
    const av = typeof a === 'string' ? a : '';
    const bv = typeof b === 'string' ? b : '';
    if (av < bv) return -1;
    if (av > bv) return 1;
    return 0;
  }

  renderError(state, message) {
    if (!state?.bodyEl || !state?.countEl) return;
    state.countEl.textContent = '';
    state.bodyEl.innerHTML = '';

    const el = document.createElement('div');
    el.className = 'tlr-error';
    el.textContent = message || 'Error loading references.';
    state.bodyEl.appendChild(el);
  }

  formatCountLabel(count, noun, opts) {
    const totalCount = typeof opts?.totalCount === 'number' ? opts.totalCount : null;
    const useRatio = opts?.scoped === true && totalCount !== null && totalCount !== count;
    const includeZero = opts?.includeZero === true;
    const unit = totalCount !== null ? totalCount : count;

    if (!includeZero && Number(unit) <= 0 && (!useRatio || Number(count) <= 0)) return '';

    if (useRatio) {
      return `${count}/${totalCount} ${noun}${totalCount === 1 ? '' : 's'}`;
    }

    return `${unit} ${noun}${unit === 1 ? '' : 's'}`;
  }

  collectUniquePageGuids(propertyGroups, linkedGroups, unlinkedGroups) {
    const guids = new Set();

    for (const group of propertyGroups || []) {
      for (const record of group?.records || []) {
        const guid = record?.guid || null;
        if (guid) guids.add(guid);
      }
    }

    for (const group of linkedGroups || []) {
      const guid = group?.record?.guid || null;
      if (guid) guids.add(guid);
    }

    for (const group of unlinkedGroups || []) {
      const guid = group?.record?.guid || null;
      if (guid) guids.add(guid);
    }

    return guids;
  }

  filterPropertyGroupsByText(groups, textQueryLower) {
    const nextGroups = [];
    for (const group of groups || []) {
      const propertyName = (group?.propertyName || '').trim();
      if (!propertyName) continue;
      const records = (group?.records || []).filter((record) => {
        const name = (record?.getName?.() || '').toLowerCase();
        return name.includes(textQueryLower);
      });
      if (records.length > 0) nextGroups.push({ propertyName, records });
    }
    return nextGroups;
  }

  filterLineGroupsByText(groups, textQueryLower) {
    const nextGroups = [];
    for (const group of groups || []) {
      const record = group?.record || null;
      const recordGuid = record?.guid || null;
      if (!recordGuid) continue;
      const lines = (group?.lines || []).filter((line) => {
        const text = this.segmentsToPlainText(line?.segments || []);
        return text.toLowerCase().includes(textQueryLower);
      });
      if (lines.length > 0) nextGroups.push({ record, lines });
    }
    return nextGroups;
  }

  filterReferenceGroupsForRender({
    propsAll,
    linkedAll,
    unlinkedAll,
    searchMode,
    textQueryLower,
    queryFilterState,
    canApplyScopedQuery,
    shouldScopeUnlinked
  }) {
    let props = propsAll;
    let linked = linkedAll;
    let unlinked = shouldScopeUnlinked ? unlinkedAll : [];

    if (searchMode === 'query') {
      if (canApplyScopedQuery) {
        props = this.filterPropertyGroupsByScopedQuery(propsAll, queryFilterState);
        linked = this.filterLineGroupsByScopedQuery(linkedAll, queryFilterState);
        unlinked = shouldScopeUnlinked
          ? this.filterLineGroupsByScopedQuery(unlinkedAll, queryFilterState)
          : [];
      }
    } else if (textQueryLower) {
      props = this.filterPropertyGroupsByText(props, textQueryLower);
      linked = this.filterLineGroupsByText(linked, textQueryLower);
      unlinked = this.filterLineGroupsByText(unlinked, textQueryLower);
    }

    return { props, linked, unlinked };
  }

  buildReferenceSummaryParts({
    searchMode,
    incompleteQueryDraft,
    queryFilterState,
    canApplyScopedQuery,
    hasScopedView,
    filteredUniquePagesSize,
    totalUniquePagesSize,
    filteredVisibleRefCount,
    totalVisibleRefCount
  }) {
    const parts = [];

    if (searchMode === 'query') {
      if (incompleteQueryDraft) {
        parts.push('Continue typing...');
      } else if (queryFilterState?.error) {
        parts.push('Invalid query');
      } else if (queryFilterState?.loading === true && canApplyScopedQuery !== true) {
        parts.push('Applying...');
      }

      if (canApplyScopedQuery) {
        const pageLabel = this.formatCountLabel(filteredUniquePagesSize, 'page', {
          totalCount: totalUniquePagesSize,
          scoped: true
        });
        const refLabel = this.formatCountLabel(filteredVisibleRefCount, 'ref', {
          totalCount: totalVisibleRefCount,
          scoped: true
        });
        if (pageLabel) parts.push(pageLabel);
        if (refLabel) parts.push(refLabel);
      } else {
        const pageLabel = this.formatCountLabel(totalUniquePagesSize, 'page');
        const refLabel = this.formatCountLabel(totalVisibleRefCount, 'ref');
        if (pageLabel) parts.push(pageLabel);
        if (refLabel) parts.push(refLabel);
      }
      return parts;
    }

    if (hasScopedView) {
      const pageLabel = this.formatCountLabel(filteredUniquePagesSize, 'page', {
        totalCount: totalUniquePagesSize,
        scoped: true
      });
      const refLabel = this.formatCountLabel(filteredVisibleRefCount, 'ref', {
        totalCount: totalVisibleRefCount,
        scoped: true
      });
      if (pageLabel) parts.push(pageLabel);
      if (refLabel) parts.push(refLabel);
      return parts;
    }

    const pageLabel = this.formatCountLabel(totalUniquePagesSize, 'page');
    const refLabel = this.formatCountLabel(totalVisibleRefCount, 'ref');
    if (pageLabel) parts.push(pageLabel);
    if (refLabel) parts.push(refLabel);
    return parts;
  }

  buildReferenceSectionMeta(visibleCount, totalCount, showScopedCounts) {
    if (showScopedCounts !== true && Number(visibleCount) === 0) return '';
    return this.formatCountLabel(visibleCount, 'ref', {
      totalCount: showScopedCounts ? totalCount : null,
      scoped: showScopedCounts,
      includeZero: true
    });
  }

  buildUnknownReferenceSectionMeta() {
    return '- refs';
  }

  buildReferenceViewState(state, {
    propertyGroups,
    propertyError,
    propertyIndexStatus,
    propertyIndexStats,
    propertyIndexError,
    linkedGroups,
    linkedError,
    unlinkedGroups,
    unlinkedError,
    unlinkedDeferred,
    unlinkedLoading,
    maxResults
  }) {
    const query = (state.searchQuery || '').trim();
    const searchMode = this.getSearchMode(query);
    const incompleteQueryDraft = searchMode === 'query' && this.isIncompleteQueryDraft(query);
    const textQueryLower = searchMode === 'text' ? query.toLowerCase() : '';
    const queryFilterState = searchMode === 'query' ? this.getQueryFilterState(state, query) : null;
    const canApplyScopedQuery = searchMode === 'query' && incompleteQueryDraft !== true && queryFilterState?.ready === true;
    const shouldScopeUnlinked = searchMode === 'query'
      ? this.shouldIncludeUnlinkedInQueryScope(state, state.lastResults || {})
      : true;
    const highlightQuery = searchMode === 'text' ? query : '';
    const normalizedPropertyIndexStatus = propertyIndexStatus || 'ready';
    const normalizedPropertyIndexStats = propertyIndexStats || this.createEmptyPropertyIndexStats();
    const normalizedPropertyIndexError = propertyIndexError || '';

    const propsAll = Array.isArray(propertyGroups) ? propertyGroups : [];
    const linkedAll = Array.isArray(linkedGroups) ? linkedGroups : [];
    const unlinkedAll = Array.isArray(unlinkedGroups) ? unlinkedGroups : [];

    const totalPropRefCount = propsAll.reduce((total, group) => total + (group?.records?.length || 0), 0);
    const totalLinkedRefCount = this.countLinkedReferences(linkedAll);
    const totalUnlinkedRefCount = this.countLinkedReferences(unlinkedAll);
    const collapseMetrics = {
      ready: true,
      propertyCount: totalPropRefCount,
      linkedCount: totalLinkedRefCount,
      unlinkedCount: totalUnlinkedRefCount,
      propertyError: Boolean(propertyError),
      linkedError: Boolean(linkedError),
      unlinkedError: Boolean(unlinkedError),
      propertyIndexPending: normalizedPropertyIndexStatus === 'idle' || normalizedPropertyIndexStatus === 'indexing',
      propertyIndexError: normalizedPropertyIndexStatus === 'error',
      unlinkedDeferred: unlinkedDeferred === true
    };
    const totalUniquePages = this.collectUniquePageGuids(propsAll, linkedAll, []);
    const filteredGroups = this.filterReferenceGroupsForRender({
      propsAll,
      linkedAll,
      unlinkedAll,
      searchMode,
      textQueryLower,
      queryFilterState,
      canApplyScopedQuery,
      shouldScopeUnlinked
    });

    let { props, linked, unlinked } = filteredGroups;
    const filteredPropRefCount = props.reduce((total, group) => total + (group?.records?.length || 0), 0);
    const filteredLinkedRefCount = this.countLinkedReferences(linked);
    const filteredUnlinkedRefCount = this.countLinkedReferences(unlinked);
    const hasScopedView = (searchMode === 'text' && Boolean(textQueryLower)) || (searchMode === 'query' && canApplyScopedQuery);
    const showUnlinkedCounts = searchMode !== 'query' || shouldScopeUnlinked;
    const showScopedCounts = hasScopedView || (searchMode === 'query' && canApplyScopedQuery);
    const totalVisibleRefCount = totalPropRefCount + totalLinkedRefCount;
    const filteredVisibleRefCount = filteredPropRefCount + filteredLinkedRefCount;
    const filteredUniquePages = this.collectUniquePageGuids(props, linked, []);

    const sortSpec = {
      sortBy: this.normalizeSortBy(state?.sortBy) || this._defaultSortBy,
      sortDir: this.normalizeSortDir(state?.sortDir) || this._defaultSortDir
    };
    const sortMetrics = this.computeRecordSortMetrics(props, [...linked, ...unlinked]);
    props = this.sortPropertyGroupsForRender(props, sortSpec, sortMetrics);
    linked = this.sortLinkedGroupsForRender(linked, sortSpec, sortMetrics);
    unlinked = this.sortLinkedGroupsForRender(unlinked, sortSpec, sortMetrics);

    return {
      searchMode,
      incompleteQueryDraft,
      queryFilterState,
      canApplyScopedQuery,
      shouldScopeUnlinked,
      highlightQuery,
      props,
      linked,
      unlinked,
      propertyError,
      propertyIndexStatus: normalizedPropertyIndexStatus,
      propertyIndexStats: normalizedPropertyIndexStats,
      propertyIndexError: normalizedPropertyIndexError,
      propertyIndexMessage: this.getPropertyIndexDisplayMessage({
        status: normalizedPropertyIndexStatus,
        stats: normalizedPropertyIndexStats,
        error: normalizedPropertyIndexError
      }),
      linkedError,
      unlinkedError,
      unlinkedDeferred,
      unlinkedLoading,
      maxResults,
      totalPropRefCount,
      totalLinkedRefCount,
      totalUnlinkedRefCount,
      filteredPropRefCount,
      filteredLinkedRefCount,
      filteredUnlinkedRefCount,
      totalVisibleRefCount,
      filteredVisibleRefCount,
      totalUniquePagesSize: totalUniquePages.size,
      filteredUniquePagesSize: filteredUniquePages.size,
      collapseMetrics,
      hasScopedView,
      showUnlinkedCounts,
      showScopedCounts,
      propertySectionCollapsed: this.isSectionCollapsed(state, 'property', collapseMetrics),
      linkedSectionCollapsed: this.isSectionCollapsed(state, 'linked', collapseMetrics),
      unlinkedSectionCollapsed: this.isSectionCollapsed(state, 'unlinked', collapseMetrics),
      summaryText: this.buildReferenceSummaryParts({
        searchMode,
        incompleteQueryDraft,
        queryFilterState,
        canApplyScopedQuery,
        hasScopedView,
        filteredUniquePagesSize: filteredUniquePages.size,
        totalUniquePagesSize: totalUniquePages.size,
        filteredVisibleRefCount,
        totalVisibleRefCount
      }).join(' | ')
    };
  }

  buildPropertyGroupsSignature(groups) {
    return (groups || []).map((group) => {
      const propertyName = (group?.propertyName || '').trim();
      const records = (group?.records || []).map((record) => {
        const guid = (record?.guid || '').trim();
        return `${guid}@${this.getRecordUpdatedTimestamp(record)}:${record?.getName?.() || ''}`;
      }).join(',');
      return `${propertyName}[${records}]`;
    }).join('||');
  }

  buildLineGroupsSignature(groups) {
    return (groups || []).map((group) => {
      const record = group?.record || null;
      const recordGuid = (record?.guid || '').trim();
      const recordName = record?.getName?.() || '';
      const lines = (group?.lines || []).map((line) => {
        const guid = (line?.guid || '').trim();
        return `${guid}@${this.getLineActivityTimestamp(line)}:${this.getLineContentText(line)}`;
      }).join(',');
      return `${recordGuid}:${recordName}[${lines}]`;
    }).join('||');
  }

  buildReferenceStatusRenderKey(viewState) {
    return [
      viewState.searchMode,
      viewState.incompleteQueryDraft === true ? 'draft' : 'ready',
      viewState.queryFilterState?.error || '',
      viewState.queryFilterState?.loading === true ? 'loading' : 'idle',
      viewState.canApplyScopedQuery === true ? 'scoped' : 'unscoped',
      viewState.propertyIndexStatus || 'idle',
      viewState.propertyIndexStats?.scannedRecords || 0,
      viewState.propertyIndexError || ''
    ].join('|');
  }

  buildPropertySectionRenderKey(state, viewState) {
    return [
      viewState.propertySectionCollapsed === true ? 'collapsed' : 'open',
      viewState.propertyError || '',
      viewState.propertyIndexStatus || 'idle',
      viewState.propertyIndexStats?.scannedRecords || 0,
      viewState.propertyIndexError || '',
      viewState.showScopedCounts === true ? 'scoped' : 'plain',
      viewState.hasScopedView === true ? 'filtered' : 'all',
      viewState.highlightQuery || '',
      viewState.filteredPropRefCount,
      viewState.totalPropRefCount,
      this.buildPropertyGroupsSignature(viewState.props),
      state?.liveRenderVersion || 0
    ].join('|');
  }

  buildLinkedSectionRenderKey(state, viewState) {
    return [
      viewState.linkedSectionCollapsed === true ? 'collapsed' : 'open',
      viewState.linkedError || '',
      viewState.showScopedCounts === true ? 'scoped' : 'plain',
      viewState.hasScopedView === true ? 'filtered' : 'all',
      viewState.highlightQuery || '',
      viewState.filteredLinkedRefCount,
      viewState.totalLinkedRefCount,
      viewState.maxResults || 0,
      this.buildLineGroupsSignature(viewState.linked),
      state?.liveRenderVersion || 0,
      state?.linkedContextRenderVersion || 0
    ].join('|');
  }

  buildUnlinkedSectionRenderKey(state, viewState) {
    return [
      viewState.unlinkedSectionCollapsed === true ? 'collapsed' : 'open',
      viewState.unlinkedError || '',
      viewState.unlinkedDeferred === true ? 'deferred' : 'ready',
      viewState.unlinkedLoading === true ? 'loading' : 'idle',
      viewState.showScopedCounts === true ? 'scoped' : 'plain',
      viewState.showUnlinkedCounts === true ? 'show' : 'hide',
      viewState.hasScopedView === true ? 'filtered' : 'all',
      viewState.highlightQuery || '',
      viewState.filteredUnlinkedRefCount,
      viewState.totalUnlinkedRefCount,
      viewState.maxResults || 0,
      this.buildLineGroupsSignature(viewState.unlinked),
      state?.liveRenderVersion || 0,
      state?.linkedContextRenderVersion || 0
    ].join('|');
  }

  buildReferenceRenderPlan(state, viewState) {
    const currentKeys = state?.renderSectionKeys || {};
    const nextKeys = {
      status: this.buildReferenceStatusRenderKey(viewState),
      property: this.buildPropertySectionRenderKey(state, viewState),
      linked: this.buildLinkedSectionRenderKey(state, viewState),
      unlinked: this.buildUnlinkedSectionRenderKey(state, viewState)
    };
    return {
      nextKeys,
      statusChanged: currentKeys.status !== nextKeys.status,
      propertyChanged: currentKeys.property !== nextKeys.property,
      linkedChanged: currentKeys.linked !== nextKeys.linked,
      unlinkedChanged: currentKeys.unlinked !== nextKeys.unlinked
    };
  }

  appendReferenceStatus(body, viewState) {
    if (viewState.searchMode === 'query' && viewState.incompleteQueryDraft) {
      this.appendNote(body, 'Finish the query to filter the current backreferences.');
    } else if (viewState.searchMode === 'query' && viewState.queryFilterState?.error) {
      this.appendError(body, viewState.queryFilterState.error);
    } else if (viewState.searchMode === 'query' && viewState.queryFilterState?.loading === true) {
      this.appendNote(
        body,
        viewState.canApplyScopedQuery
          ? 'Refreshing query results...'
          : 'Applying query to current backreferences...'
      );
    } else if (viewState.propertyIndexStatus === 'indexing') {
      this.appendNote(body, viewState.propertyIndexMessage);
    } else if (viewState.propertyIndexStatus === 'idle') {
      this.appendNote(body, viewState.propertyIndexMessage);
    }
  }

  renderPropertyReferenceSection(body, state, viewState) {
    const section = this.appendCollapsibleSection(body, state, {
      sectionId: 'property',
      title: 'Property References',
      collapsed: viewState.propertySectionCollapsed,
      meta: viewState.propertyIndexStatus !== 'ready'
        ? this.buildUnknownReferenceSectionMeta()
        : this.buildReferenceSectionMeta(
            viewState.showScopedCounts ? viewState.filteredPropRefCount : viewState.totalPropRefCount,
            viewState.totalPropRefCount,
            viewState.showScopedCounts
          )
    });

    if (viewState.propertyError) {
      this.appendError(section.bodyEl, viewState.propertyError);
    } else if (viewState.propertyIndexStatus === 'indexing' || viewState.propertyIndexStatus === 'idle') {
      this.appendNote(section.bodyEl, viewState.propertyIndexMessage);
    } else if (viewState.propertyIndexStatus === 'error') {
      this.appendPropertyIndexError(section.bodyEl, viewState.propertyIndexError);
    } else if (viewState.props.length === 0) {
      this.appendEmpty(
        section.bodyEl,
        viewState.hasScopedView ? 'No matching property references.' : 'No property references.'
      );
    } else {
      this.appendPropertyReferenceGroups(section.bodyEl, viewState.props, {
        query: viewState.highlightQuery,
        state
      });
    }
  }

  renderLinkedReferenceSection(body, state, viewState) {
    const section = this.appendCollapsibleSection(body, state, {
      sectionId: 'linked',
      title: 'Linked References',
      collapsed: viewState.linkedSectionCollapsed,
      meta: this.buildReferenceSectionMeta(
        viewState.showScopedCounts ? viewState.filteredLinkedRefCount : viewState.totalLinkedRefCount,
        viewState.totalLinkedRefCount,
        viewState.showScopedCounts
      )
    });

    if (viewState.linkedError) {
      this.appendError(section.bodyEl, viewState.linkedError);
    } else {
      this.appendLinkedReferenceGroups(section.bodyEl, viewState.linked, {
        groupSectionId: 'linked',
        state,
        maxResults: viewState.maxResults,
        query: viewState.highlightQuery,
        totalLineCount: viewState.totalLinkedRefCount,
        emptyMessage: viewState.hasScopedView ? 'No matching linked references.' : 'No linked references.'
      });
    }
  }

  renderUnlinkedReferenceSection(body, state, viewState) {
    const section = this.appendCollapsibleSection(body, state, {
      sectionId: 'unlinked',
      title: 'Unlinked References',
      collapsed: viewState.unlinkedSectionCollapsed,
      meta: (viewState.unlinkedDeferred === true || viewState.unlinkedLoading === true)
        ? this.buildUnknownReferenceSectionMeta()
        : this.buildReferenceSectionMeta(
          viewState.showScopedCounts && viewState.showUnlinkedCounts
            ? viewState.filteredUnlinkedRefCount
            : viewState.totalUnlinkedRefCount,
          viewState.totalUnlinkedRefCount,
          viewState.showScopedCounts && viewState.showUnlinkedCounts
        )
    });

    if (viewState.unlinkedLoading) {
      this.appendNote(section.bodyEl, 'Loading unlinked references...');
      return;
    }

    if (viewState.unlinkedError) {
      this.appendError(section.bodyEl, viewState.unlinkedError);
      return;
    }

    if (viewState.unlinkedDeferred) {
      if (!viewState.unlinkedSectionCollapsed) {
        this.appendNote(section.bodyEl, 'Loading unlinked references...');
      }
      return;
    }

    this.appendLinkedReferenceGroups(section.bodyEl, viewState.unlinked, {
      groupSectionId: 'unlinked',
      state,
      maxResults: viewState.maxResults,
      query: viewState.highlightQuery,
      totalLineCount: viewState.totalUnlinkedRefCount,
      emptyMessage: viewState.hasScopedView ? 'No matching unlinked references.' : 'No unlinked references.'
    });
  }

  appendReferenceDivider(container) {
    const divider = document.createElement('div');
    divider.className = 'tlr-divider';
    container.appendChild(divider);
  }

  renderReferences(state, {
    propertyGroups,
    propertyError,
    propertyIndexStatus,
    propertyIndexStats,
    propertyIndexError,
    linkedGroups,
    linkedError,
    unlinkedGroups,
    unlinkedError,
    unlinkedDeferred,
    unlinkedLoading,
    maxResults
  }) {
    if (!state?.bodyEl || !state?.countEl) return;
    if (!state?.statusSlotEl || !state?.propertySlotEl || !state?.linkedSlotEl || !state?.unlinkedSlotEl) return;

    const viewState = this.buildReferenceViewState(state, {
      propertyGroups,
      propertyError,
      propertyIndexStatus,
      propertyIndexStats,
      propertyIndexError,
      linkedGroups,
      linkedError,
      unlinkedGroups,
      unlinkedError,
      unlinkedDeferred,
      unlinkedLoading,
      maxResults
    });

    this.syncFooterCollapsedState(state, this.isFooterCollapsed(state, viewState.collapseMetrics));

    state.countEl.textContent = viewState.summaryText;
    const plan = this.buildReferenceRenderPlan(state, viewState);

    if (plan.statusChanged) {
      state.statusSlotEl.innerHTML = '';
      this.appendReferenceStatus(state.statusSlotEl, viewState);
    }
    if (plan.propertyChanged) {
      state.propertySlotEl.innerHTML = '';
      this.renderPropertyReferenceSection(state.propertySlotEl, state, viewState);
    }
    if (plan.linkedChanged) {
      state.linkedSlotEl.innerHTML = '';
      this.renderLinkedReferenceSection(state.linkedSlotEl, state, viewState);
    }
    if (plan.unlinkedChanged) {
      state.unlinkedSlotEl.innerHTML = '';
      this.renderUnlinkedReferenceSection(state.unlinkedSlotEl, state, viewState);
    }

    state.renderSectionKeys = plan.nextKeys;
  }

  buildChevronIcon(collapsed, extraClass) {
    const iconEl = document.createElement('span');
    iconEl.classList.add('ti', 'tlr-fold-icon');
    if (extraClass) iconEl.classList.add(extraClass);
    this.syncChevronIcon(iconEl, collapsed === true);
    iconEl.setAttribute('aria-hidden', 'true');
    return iconEl;
  }

  syncChevronIcon(iconEl, collapsed) {
    if (!iconEl?.classList) return;
    iconEl.classList.remove('ti-chevron-down', 'ti-chevron-right');
    iconEl.classList.add(collapsed === true ? 'ti-chevron-right' : 'ti-chevron-down');
  }

  appendCollapsibleSection(container, state, { sectionId, title, meta, collapsed }) {
    if (!container) return;

    const id = this.normalizeSectionId(sectionId) || 'property';
    const sectionCollapsed = collapsed === true;

    const sectionEl = document.createElement('div');
    sectionEl.className = 'tlr-section form-field';
    if (sectionCollapsed) sectionEl.classList.add('tlr-section-collapsed');

    const headerEl = document.createElement('div');
    headerEl.className = 'tlr-section-header form-field-row';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'tlr-btn tlr-section-toggle button-none button-small button-minimal-hover';
    toggleBtn.dataset.action = 'toggle-section';
    toggleBtn.dataset.sectionId = id;
    toggleBtn.title = 'Collapse/expand';
    toggleBtn.setAttribute('aria-label', sectionCollapsed ? 'Expand section' : 'Collapse section');
    toggleBtn.setAttribute('aria-expanded', sectionCollapsed ? 'false' : 'true');
    toggleBtn.appendChild(this.buildChevronIcon(sectionCollapsed, 'tlr-section-caret'));

    const titleEl = document.createElement('div');
    titleEl.className = 'tlr-section-title text-details';
    titleEl.textContent = title || '';

    const metaEl = document.createElement('div');
    metaEl.className = 'tlr-section-meta text-details';
    metaEl.textContent = meta || '';

    const bodyEl = document.createElement('div');
    bodyEl.className = 'tlr-section-body';

    headerEl.appendChild(toggleBtn);
    headerEl.appendChild(titleEl);
    headerEl.appendChild(metaEl);
    sectionEl.appendChild(headerEl);
    sectionEl.appendChild(bodyEl);
    container.appendChild(sectionEl);

    return { sectionEl, bodyEl };
  }

  appendError(container, message) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'tlr-error';
    el.textContent = message || 'Error loading references.';
    container.appendChild(el);
  }

  appendPropertyIndexError(container, message) {
    if (!container) return;
    this.appendError(container, message || 'Error indexing property references.');

    const action = document.createElement('button');
    action.className = 'tlr-btn button-none button-small button-minimal-hover';
    action.type = 'button';
    action.dataset.action = 'rebuild-property-index';
    action.textContent = 'Rebuild graph index';
    container.appendChild(action);
  }

  appendEmpty(container, message) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'tlr-empty';
    el.textContent = message || '';
    container.appendChild(el);
  }

  appendNote(container, message) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'tlr-note';
    el.textContent = message || '';
    container.appendChild(el);
  }

  appendPropertyReferenceGroups(container, groups, opts) {
    if (!container) return;

    const query = (opts?.query || '').trim();
    const state = opts?.state || null;

    for (const g of groups || []) {
      const propName = (g?.propertyName || '').trim();
      if (!propName) continue;

      const isCollapsed = this.isPropGroupCollapsed(propName);

      const groupEl = document.createElement('div');
      groupEl.className = 'tlr-prop-group';

      if (isCollapsed) groupEl.classList.add('tlr-prop-collapsed');

      const rowEl = document.createElement('div');
      rowEl.className = 'tlr-prop-row';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'tlr-btn tlr-prop-toggle button-none button-small button-minimal-hover';
      toggleBtn.dataset.action = 'toggle-prop-group';
      toggleBtn.dataset.propName = propName;
      toggleBtn.title = isCollapsed ? 'Expand' : 'Collapse';
      toggleBtn.setAttribute('aria-label', isCollapsed ? 'Expand' : 'Collapse');
      toggleBtn.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');
      toggleBtn.appendChild(this.buildChevronIcon(isCollapsed, 'tlr-prop-caret'));

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'tlr-prop-header button-normal button-normal-hover';
      header.dataset.action = 'toggle-prop-group';
      header.dataset.propName = propName;
      header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

      const title = document.createElement('div');
      title.className = 'tlr-prop-title';
      title.textContent = `${propName} in...`;

      const meta = document.createElement('div');
      meta.className = 'tlr-prop-meta text-details';
      meta.textContent = `${g?.records?.length || 0}`;

      header.appendChild(title);
      header.appendChild(meta);

      rowEl.appendChild(toggleBtn);
      rowEl.appendChild(header);

      const recsEl = document.createElement('div');
      recsEl.className = 'tlr-prop-records';

      for (const r of g?.records || []) {
        const guid = r?.guid || null;
        if (!guid) continue;

        const btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'tlr-prop-record button-none button-minimal-hover';
        btn.dataset.action = 'open-record';
        btn.dataset.recordGuid = guid;
        const name = r.getName?.() || 'Untitled';
        btn.textContent = '';
        this.appendHighlightedText(btn, name, query);
        this.appendLiveBadges(btn, state, this.getPropertySnapshotKey(propName, guid));
        recsEl.appendChild(btn);
      }

      groupEl.appendChild(rowEl);
      groupEl.appendChild(recsEl);
      container.appendChild(groupEl);
    }
  }

  appendLinkedReferenceGroups(container, groups, opts) {
    if (!container) return;

    const groupSectionId = this.normalizeRecordGroupSectionId(opts?.groupSectionId) || 'linked';
    const state = opts?.state || null;
    const maxResults = opts?.maxResults || 0;
    const query = (opts?.query || '').trim();
    const totalLineCount = typeof opts?.totalLineCount === 'number' ? opts.totalLineCount : null;
    const emptyMessage = (opts?.emptyMessage || '').trim() || 'No linked references.';

    const pageCount = groups.length;
    const refCount = groups.reduce((n, g) => n + (g?.lines?.length || 0), 0);

    if (pageCount === 0) {
      const empty = document.createElement('div');
      empty.className = 'tlr-empty';
      empty.textContent = emptyMessage;
      container.appendChild(empty);
      return;
    }

    for (const g of groups) {
      const record = g.record || null;
      const recordGuid = record?.guid || null;
      if (!recordGuid) continue;
      const lines = Array.isArray(g.lines) ? g.lines : [];
      const singleRefGroup = lines.length === 1;
      const targetRecordGuid = state?.recordGuid || '';
      const groupCollapsed = this.isRecordGroupCollapsed(groupSectionId, targetRecordGuid, recordGuid);

      const groupEl = document.createElement('div');
      groupEl.className = 'tlr-group';
      groupEl.classList.add(`tlr-group-${groupSectionId}`);
      if (singleRefGroup) groupEl.classList.add('tlr-group-single');
      if (groupCollapsed) groupEl.classList.add('tlr-group-collapsed');

      const rowEl = document.createElement('div');
      rowEl.className = 'tlr-group-row';

      const toggleBtn = document.createElement('button');
      toggleBtn.type = 'button';
      toggleBtn.className = 'tlr-btn tlr-group-toggle button-none button-small button-minimal-hover';
      toggleBtn.dataset.action = 'toggle-record-group';
      toggleBtn.dataset.groupSectionId = groupSectionId;
      toggleBtn.dataset.targetRecordGuid = targetRecordGuid;
      toggleBtn.dataset.recordGuid = recordGuid;
      toggleBtn.title = groupCollapsed ? 'Expand' : 'Collapse';
      toggleBtn.setAttribute('aria-label', groupCollapsed ? 'Expand' : 'Collapse');
      toggleBtn.setAttribute('aria-expanded', groupCollapsed ? 'false' : 'true');
      toggleBtn.appendChild(this.buildChevronIcon(groupCollapsed, 'tlr-group-caret'));

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'tlr-group-header button-normal button-normal-hover';
      header.dataset.action = 'open-record';
      header.dataset.recordGuid = recordGuid;

      const title = document.createElement('div');
      title.className = 'tlr-group-title';
      title.textContent = record.getName?.() || 'Untitled';

      const meta = document.createElement('div');
      meta.className = 'tlr-group-meta text-details';
      meta.textContent = `${lines.length}`;

      header.appendChild(title);
      header.appendChild(meta);

      rowEl.appendChild(toggleBtn);
      rowEl.appendChild(header);

      const linesEl = document.createElement('div');
      linesEl.className = 'tlr-lines';

      for (const line of lines) {
        const entryEl = document.createElement('div');
        entryEl.className = 'tlr-line-entry';

        const ctx = state ? this.getLinkedContextState(state, line.guid) : null;
        if (state && ctx && this.hasRequestedLinkedContext(ctx) && ctx.loaded !== true && ctx.loading !== true) {
          this.ensureLinkedContextLoaded(state, line).catch(() => {
            // ignore
          });
        }

        this.appendLinkedContextRows(entryEl, recordGuid, ctx, query, 'top');

        const lineEl = document.createElement('button');
        lineEl.type = 'button';
        lineEl.className = 'tlr-line button-none button-minimal-hover';
        lineEl.dataset.action = 'open-line';
        lineEl.dataset.recordGuid = recordGuid;
        lineEl.dataset.lineGuid = line.guid;
        this.appendLineText(lineEl, line, query);
        this.appendLiveBadges(lineEl, state, this.getLinkedSnapshotKey(line.guid));
        const mainRowEl = document.createElement('div');
        mainRowEl.className = 'tlr-line-main';
        mainRowEl.appendChild(lineEl);
        entryEl.appendChild(mainRowEl);

        if (state && ctx) {
          if (ctx.showMoreContext === true) mainRowEl.classList.add('is-context-open');
          const controlsEl = this.buildLinkedContextControls(line.guid, ctx, {
            showLinkAction: groupSectionId === 'unlinked'
          });
          if (controlsEl) mainRowEl.appendChild(controlsEl);

          if (ctx.loading === true && ctx.backgroundLoading !== true) {
            const loadingEl = document.createElement('div');
            loadingEl.className = 'tlr-note tlr-context-note';
            loadingEl.textContent = 'Loading context...';
            entryEl.appendChild(loadingEl);
          } else if (ctx.error) {
            const errorEl = document.createElement('div');
            errorEl.className = 'tlr-error tlr-context-note';
            errorEl.textContent = ctx.error;
            entryEl.appendChild(errorEl);
          }
        }

        this.appendLinkedContextRows(entryEl, recordGuid, ctx, query, 'bottom');
        linesEl.appendChild(entryEl);
      }

      groupEl.appendChild(rowEl);
      groupEl.appendChild(linesEl);
      container.appendChild(groupEl);
    }

    if (maxResults > 0 && (totalLineCount ?? refCount) >= maxResults) {
      const note = document.createElement('div');
      note.className = 'tlr-note';
      note.textContent = `Showing first ${maxResults} matches.`;
      container.appendChild(note);
    }
  }

  buildLinkedContextControls(lineGuid, ctx, opts = {}) {
    const controls = document.createElement('div');
    controls.className = 'tlr-line-actions text-details';

    const group = document.createElement('div');
    group.className = 'tlr-line-actions-group';

    if (opts.showLinkAction === true) {
      group.appendChild(this.buildUnlinkedLinkButton(lineGuid));
    }

    if (ctx?.showMoreContext === true) {
      const availableAbove = this.getAvailableAboveContextCount(ctx);
      const availableBelow = this.getAvailableBelowContextCount(ctx);
      const showingAbove = (ctx?.siblingAboveCount || 0) > 0;
      const showingBelow = (ctx?.siblingBelowCount || 0) > 0;

      if (showingAbove || availableAbove > 0) {
        group.appendChild(this.buildLinkedContextButton('toggle-context-above', lineGuid, {
          icon: 'up',
          label: this.getAboveToggleLabel(ctx),
          disabled: ctx?.loaded === true && availableAbove === 0,
          active: showingAbove
        }));
      }
      if (showingBelow || availableBelow > 0) {
        group.appendChild(this.buildLinkedContextButton('toggle-context-below', lineGuid, {
          icon: 'down',
          label: this.getBelowToggleLabel(ctx),
          disabled: ctx?.loaded === true && availableBelow === 0,
          active: showingBelow
        }));
      }
    }

    const shouldShowContextToggle = ctx?.showMoreContext === true
      || this.hasAnyLinkedContext(ctx);
    if (shouldShowContextToggle) {
      group.appendChild(this.buildLinkedContextButton('toggle-context-more', lineGuid, {
        icon: 'toggle',
        label: ctx?.showMoreContext === true ? 'Hide context' : 'Show more context',
        disabled: ctx?.showMoreContext !== true && ctx?.loaded === true && !this.hasAnyLinkedContext(ctx),
        active: ctx?.showMoreContext === true
      }));
    }

    if (group.children.length === 0) controls.classList.add('is-empty');
    controls.appendChild(group);
    return controls;
  }

  buildUnlinkedLinkButton(lineGuid) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tlr-unlinked-link-btn button-none button-small button-minimal-hover tooltip';
    btn.dataset.action = 'link-unlinked';
    btn.dataset.lineGuid = lineGuid || '';
    btn.title = 'Link mention';
    btn.setAttribute('aria-label', 'Link mention');
    btn.setAttribute('data-tooltip', 'Link mention');
    btn.setAttribute('data-tooltip-dir', 'top');

    let iconEl = null;
    try {
      iconEl = this.ui.createIcon('ti-link');
    } catch (e) {
      iconEl = null;
    }

    if (iconEl) {
      iconEl.classList.add('tlr-unlinked-link-icon');
      btn.appendChild(iconEl);
    } else {
      btn.textContent = 'Link';
      btn.classList.add('tlr-unlinked-link-btn-fallback');
    }

    return btn;
  }

  buildLinkedContextButton(action, lineGuid, opts) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tlr-context-btn button-none button-small button-minimal-hover';
    btn.dataset.action = action;
    btn.dataset.lineGuid = lineGuid || '';
    btn.title = opts?.label || '';
    btn.setAttribute('aria-label', opts?.label || '');
    btn.classList.add(`tlr-context-btn-${opts?.icon || 'more'}`);
    if (opts?.active === true) btn.classList.add('is-active');
    if (opts?.disabled === true) btn.disabled = true;

    btn.appendChild(this.buildLinkedContextGlyph(opts?.icon || 'toggle'));
    return btn;
  }

  buildLinkedContextGlyph(icon) {
    const glyph = document.createElement('span');
    glyph.className = `tlr-context-glyph tlr-context-glyph-${icon}`;
    glyph.setAttribute('aria-hidden', 'true');

    const addChevron = (dir) => {
      let iconEl = null;
      try {
        iconEl = this.ui.createIcon(`ti-chevron-${dir}`);
      } catch (e) {
        iconEl = null;
      }

      if (!iconEl) {
        iconEl = document.createElement('span');
        iconEl.className = `ti ti-chevron-${dir}`;
      }

      glyph.appendChild(iconEl);
    };

    if (icon === 'toggle') {
      addChevron('up');
      addChevron('down');
      return glyph;
    }

    if (icon === 'up' || icon === 'down') {
      addChevron(icon);
      return glyph;
    }

    return glyph;
  }

  appendLineText(container, line, query) {
    if (!container) return;

    const prefix = this.getLinePrefix(line);
    if (prefix) {
      const p = document.createElement('span');
      p.className = 'tlr-prefix';
      p.textContent = prefix;
      container.appendChild(p);
    }

    const content = document.createElement('span');
    content.className = 'tlr-line-content';
    const segments = Array.isArray(line?.segments) ? line.segments : [];
    if (segments.length > 0) {
      this.appendSegments(content, segments, query);
    } else {
      this.appendHighlightedText(content, this.getLineContentText(line), query);
    }
    container.appendChild(content);
  }

  appendLinkedContextRows(container, recordGuid, ctx, query, position) {
    if (!container || !ctx || ctx.loaded !== true) return;

    const items = [];
    if (position === 'top') {
      for (const line of this.getVisibleAboveContextItems(ctx)) {
        items.push({
          line,
          indent: Number(ctx.relativeDepthByGuid?.[line?.guid] || 0)
        });
      }
    } else {
      if (ctx.showMoreContext === true) {
        for (const line of ctx.descendants || []) {
          items.push({
            line,
            indent: Number(ctx.relativeDepthByGuid?.[line?.guid] || ctx.depthByGuid?.[line?.guid] || 1)
          });
        }
      }

      for (const line of this.getVisibleBelowContextItems(ctx)) {
        items.push({
          line,
          indent: Number(ctx.relativeDepthByGuid?.[line?.guid] || 0)
        });
      }
    }

    if (items.length === 0) return;

    const list = document.createElement('div');
    list.className = `tlr-context-list tlr-context-list-${position}`;

    for (const item of items) {
      const line = item.line || null;
      const guid = line?.guid || null;
      if (!guid) continue;
      if (!this.hasRenderableLineContent(line)) continue;

      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tlr-context-line button-none button-minimal-hover';
      row.dataset.action = 'open-line';
      row.dataset.recordGuid = recordGuid || '';
      row.dataset.lineGuid = guid;
      row.style.setProperty('--tlr-context-indent', `${Math.max(0, item.indent || 0) * 12}px`);

      this.appendLineText(row, line, query);
      list.appendChild(row);
    }

    if (list.childElementCount > 0) container.appendChild(list);
  }

  getLinePrefix(line) {
    const t = line?.type || '';
    if (t === 'task') {
      const done = line.isTaskCompleted?.();
      if (done === true) return '[x] ';
      if (done === false) return '[ ] ';
      return '- ';
    }
    if (t === 'ulist') return '- ';
    if (t === 'olist') return '1. ';
    if (t === 'heading') return '# ';
    if (t === 'quote') return '> ';
    return '';
  }

  getSegmentDisplayText(seg) {
    if (!seg) return '';

    if (seg.type === 'text' || seg.type === 'bold' || seg.type === 'italic' || seg.type === 'code' || seg.type === 'link') {
      return typeof seg.text === 'string' ? seg.text : '';
    }

    if (seg.type === 'linkobj') {
      const link = seg.text?.link || '';
      return seg.text?.title || link || '';
    }

    if (seg.type === 'hashtag') {
      const text = typeof seg.text === 'string' ? seg.text : '';
      if (!text) return '';
      return text.startsWith('#') ? text : `#${text}`;
    }

    if (seg.type === 'datetime') {
      return this.formatDateTimeSegment(seg.text);
    }

    if (seg.type === 'mention') {
      return this.formatMention(typeof seg.text === 'string' ? seg.text : '');
    }

    if (seg.type === 'ref') {
      const textObj = typeof seg.text === 'string' ? { guid: seg.text } : (seg.text || {});
      const guid = textObj.guid || null;
      return textObj.title || (guid ? this.resolveRecordName(guid) : '') || '';
    }

    return typeof seg.text === 'string' ? seg.text : '';
  }

  getSegmentHref(seg) {
    if (!seg) return '';
    if (seg.type === 'link') return typeof seg.text === 'string' ? seg.text : '';
    if (seg.type === 'linkobj') return seg.text?.link || '';
    return '';
  }

  appendSegmentTextElement(container, className, text, query) {
    if (!container) return;
    const el = document.createElement('span');
    el.className = className || '';
    el.textContent = '';
    this.appendHighlightedText(el, text, query);
    container.appendChild(el);
  }

  segmentsToPlainText(segments) {
    if (!Array.isArray(segments) || segments.length === 0) return '';

    let out = '';
    for (const seg of segments) {
      out += this.getSegmentDisplayText(seg);
    }

    return out;
  }

  getLineContentText(line) {
    const segmentText = this.segmentsToPlainText(line?.segments || []);
    if (segmentText) return segmentText;
    return typeof line?.text === 'string' ? line.text : '';
  }

  hasRenderableLineContent(line) {
    return this.getLineContentText(line).trim().length > 0;
  }

  appendHighlightedText(container, text, query) {
    if (!container) return;
    const s = typeof text === 'string' ? text : '';
    if (!s) return;

    const q = typeof query === 'string' ? query.trim() : '';
    if (!q) {
      container.appendChild(document.createTextNode(s));
      return;
    }

    const hayLower = s.toLowerCase();
    const needleLower = q.toLowerCase();
    if (!needleLower) {
      container.appendChild(document.createTextNode(s));
      return;
    }

    let idx = 0;
    while (idx < s.length) {
      const next = hayLower.indexOf(needleLower, idx);
      if (next === -1) break;

      if (next > idx) {
        container.appendChild(document.createTextNode(s.slice(idx, next)));
      }

      const mark = document.createElement('mark');
      mark.className = 'tlr-search-mark';
      mark.textContent = s.slice(next, next + needleLower.length);
      container.appendChild(mark);

      idx = next + needleLower.length;
    }

    if (idx < s.length) {
      container.appendChild(document.createTextNode(s.slice(idx)));
    }
  }

  appendSegments(container, segments, query) {
    if (!container) return;
    if (!Array.isArray(segments) || segments.length === 0) {
      container.textContent = '';
      return;
    }

    for (const seg of segments) {
      if (!seg) continue;
      const text = this.getSegmentDisplayText(seg);

      if (seg.type === 'text') {
        this.appendHighlightedText(container, text, query);
        continue;
      }

      if (seg.type === 'bold' || seg.type === 'italic' || seg.type === 'code') {
        this.appendSegmentTextElement(
          container,
          seg.type === 'bold' ? 'tlr-seg-bold' : seg.type === 'italic' ? 'tlr-seg-italic' : 'tlr-seg-code',
          text,
          query
        );
        continue;
      }

      if (seg.type === 'link') {
        const url = this.getSegmentHref(seg);
        if (!url) continue;
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'tlr-seg-link';
        a.textContent = '';
        this.appendHighlightedText(a, text, query);
        container.appendChild(a);
        continue;
      }

      if (seg.type === 'linkobj') {
        const link = this.getSegmentHref(seg);
        if (!link) continue;
        const a = document.createElement('a');
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'tlr-seg-link';
        a.textContent = '';
        this.appendHighlightedText(a, text, query);
        container.appendChild(a);
        continue;
      }

      if (seg.type === 'hashtag') {
        this.appendSegmentTextElement(container, 'tlr-seg-hashtag', text, query);
        continue;
      }

      if (seg.type === 'datetime') {
        this.appendSegmentTextElement(container, 'tlr-seg-datetime', text, query);
        continue;
      }

      if (seg.type === 'mention') {
        this.appendSegmentTextElement(container, 'tlr-seg-mention', text, query);
        continue;
      }

      if (seg.type === 'ref') {
        const textObj = typeof seg.text === 'string' ? { guid: seg.text } : (seg.text || {});
        const guid = textObj.guid || null;
        if (!guid) continue;
        const el = document.createElement('span');
        el.className = 'tlr-seg-ref';
        el.dataset.action = 'open-ref';
        el.dataset.refGuid = guid;
        el.textContent = '';
        this.appendHighlightedText(el, text || '[link]', query);
        container.appendChild(el);
        continue;
      }

      if (text) this.appendHighlightedText(container, text, query);
    }
  }

  resolveRecordName(guid) {
    const rec = this.data.getRecord?.(guid) || null;
    return rec?.getName?.() || null;
  }

  formatMention(userGuid) {
    if (!userGuid) return '@user';
    const users = this.data.getActiveUsers?.() || [];
    const u = users.find((x) => x?.guid === userGuid) || null;
    const name = (u?.getDisplayName?.() || '').trim();
    return name ? `@${name}` : '@user';
  }

  padDateTimeNumber(value, width = 2) {
    const n = Number(value);
    if (!Number.isFinite(n)) return '';
    return String(Math.trunc(n)).padStart(width, '0');
  }

  formatDateTimeDate(value) {
    if (typeof value === 'string') {
      const compact = value.trim().match(/^(\d{4})(\d{2})(\d{2})$/);
      if (compact) return `${compact[1]}-${compact[2]}-${compact[3]}`;
      const dashed = value.trim().match(/^(\d{4})-(\d{2})-(\d{2})$/);
      if (dashed) return `${dashed[1]}-${dashed[2]}-${dashed[3]}`;
      return '';
    }

    if (value && typeof value === 'object') {
      const year = Number(value.year);
      const month = Number(value.month);
      const day = Number(value.day);
      if (Number.isFinite(year) && Number.isFinite(month) && Number.isFinite(day)) {
        const normalizedMonth = month >= 1 ? month : (month + 1);
        return `${this.padDateTimeNumber(year, 4)}-${this.padDateTimeNumber(normalizedMonth, 2)}-${this.padDateTimeNumber(day, 2)}`;
      }
    }

    return '';
  }

  formatDateTimeTime(value, fallbackParts = null) {
    if (typeof value === 'number' && Number.isFinite(value)) {
      return `${this.padDateTimeNumber(value, 2)}:00`;
    }

    if (value && typeof value === 'object') {
      const nested = value.value && typeof value.value === 'object'
        ? value.value
        : value.t && typeof value.t === 'string'
          ? value.t
          : value.time && (typeof value.time === 'string' || typeof value.time === 'number' || typeof value.time === 'object')
            ? value.time
            : null;
      if (nested && nested !== value) {
        const nestedText = this.formatDateTimeTime(nested, value);
        if (nestedText) return nestedText;
      }
    }

    if (typeof value === 'string') {
      const raw = value.trim();
      if (!raw) return '';

      const colon = raw.match(/^(\d{1,2}):(\d{2})(?::(\d{2}))?$/);
      if (colon) {
        const hours = this.padDateTimeNumber(colon[1], 2);
        const minutes = this.padDateTimeNumber(colon[2], 2);
        const seconds = colon[3] ? this.padDateTimeNumber(colon[3], 2) : '';
        return seconds ? `${hours}:${minutes}:${seconds}` : `${hours}:${minutes}`;
      }

      const digits = raw.replace(/\D+/g, '');
      if (digits.length === 1 || digits.length === 2) {
        return `${digits.padStart(2, '0')}:00`;
      }
      if (digits.length === 3) {
        return `${digits.slice(0, 1).padStart(2, '0')}:${digits.slice(1, 3)}`;
      }
      if (digits.length === 4) {
        return `${digits.slice(0, 2)}:${digits.slice(2, 4)}`;
      }
      if (digits.length === 6) {
        return `${digits.slice(0, 2)}:${digits.slice(2, 4)}:${digits.slice(4, 6)}`;
      }
    }

    if (fallbackParts && typeof fallbackParts === 'object') {
      const hours = Number(fallbackParts.hours ?? fallbackParts.hour ?? fallbackParts.h);
      const minutes = Number(fallbackParts.minutes ?? fallbackParts.minute ?? fallbackParts.m ?? 0);
      const seconds = Number(fallbackParts.seconds ?? fallbackParts.second ?? fallbackParts.s ?? 0);
      if (Number.isFinite(hours)) {
        const hh = this.padDateTimeNumber(hours, 2);
        const mm = this.padDateTimeNumber(minutes, 2);
        const ss = Number.isFinite(seconds) && seconds > 0
          ? this.padDateTimeNumber(seconds, 2)
          : '';
        return ss ? `${hh}:${mm}:${ss}` : `${hh}:${mm}`;
      }
    }

    return '';
  }

  extractDateTimeDisplayParts(value) {
    if (!value || typeof value !== 'object') return null;

    const source = value.value && typeof value.value === 'object'
      ? value.value
      : value;

    const date = this.formatDateTimeDate(
      typeof source.d === 'string' ? source.d
        : typeof source.date === 'string' ? source.date
          : source
    );
    const time = this.formatDateTimeTime(
      source.t != null ? source.t
        : source.time != null ? source.time
          : null,
      source
    );

    if (!date && !time) return null;
    return { date, time };
  }

  formatDateTimeDisplayParts(parts) {
    if (!parts) return '';
    const date = typeof parts.date === 'string' ? parts.date : '';
    const time = typeof parts.time === 'string' ? parts.time : '';
    if (date && time) return `${date} ${time}`;
    return date || time || '';
  }

  formatDateTimeSegment(v) {
    if (typeof v === 'string') return v;
    if (!v || typeof v !== 'object') return '';

    const raw = typeof v.raw === 'string' ? v.raw.trim() : '';
    if (raw) return raw;

    const startSource = v.start && typeof v.start === 'object'
      ? v.start
      : v.from && typeof v.from === 'object'
        ? v.from
        : v;
    const endSource = v.end && typeof v.end === 'object'
      ? v.end
      : v.to && typeof v.to === 'object'
        ? v.to
        : (v.ed || v.et || v.endDate || v.endTime)
          ? {
              d: v.ed || v.endDate || null,
              t: v.et || v.endTime || null
            }
          : null;

    const start = this.extractDateTimeDisplayParts(startSource);
    const end = this.extractDateTimeDisplayParts(endSource);

    const startText = this.formatDateTimeDisplayParts(start);
    let endText = this.formatDateTimeDisplayParts(end);
    if (start?.date && !end?.date && end?.time) {
      endText = end.time;
    }

    if (startText && endText) return `${startText} to ${endText}`;
    return startText || endText || '';
  }

  coercePositiveInt(val, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    if (i <= 0) return fallback;
    return i;
  }

  coerceNonNegativeInt(val, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    if (i < 0) return fallback;
    return i;
  }

  // ---------- CSS ----------

  injectCss() {
    this.ui.injectCSS(`
      .tlr-footer {
        --tlr-child-indent: 26px;
        --tlr-context-rail-gap: 8px;
        --tlr-text-default: var(--text-default, var(--text, inherit));
        --tlr-text-muted: var(--text-muted, var(--text-secondary, var(--tlr-text-default)));
        --tlr-label-color: var(--tlr-text-default);
        --tlr-label-font-size: 14px;
        --tlr-label-font-weight: 700;
        --tlr-border-color: var(--divider-color, var(--cmdpal-border-color, var(--border-subtle, transparent)));
        --tlr-hover-bg: var(--button-normal-hover-color, var(--bg-hover, transparent));
        --tlr-selected-bg: var(--bg-selected, var(--tlr-hover-bg));
        margin-top: 14px;
        color: var(--tlr-text-default);
        font-size: 13px;
      }

      .tlr-header {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 20px;
        margin-bottom: 0;
      }

      .tlr-header-field {
        padding-bottom: 0;
      }

      .tlr-header-main {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .tlr-header-controls {
        flex: 0 0 auto;
        display: inline-flex;
        align-items: center;
        gap: 4px;
      }

      .tlr-title {
        flex: 0 0 auto;
        min-width: 0;
        white-space: nowrap;
      }

      .tlr-count {
        flex: 1 1 auto;
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        line-height: normal;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }

      .tlr-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        line-height: 1;
        box-sizing: border-box;
      }

      .tlr-search-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
      }

      .tlr-filter-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
      }

      .tlr-filter-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
        min-height: 24px;
        border: 1px solid transparent;
        border-radius: var(--button-radius, 5px);
        transition: background-color 0.15s, border-color 0.15s, color 0.15s;
      }

      .tlr-filter-toggle.is-active {
        background: var(--button-minimal-bg-active-color, var(--tlr-selected-bg));
        border-color: var(--button-minimal-hover-color, var(--button-minimal-border-color, transparent));
        color: var(--button-minimal-fg-color, var(--tlr-text-default));
      }

      .tlr-filter-toggle.is-active .id--filter-icon {
        color: var(--button-primary-icon-color, currentColor);
        font-weight: 700;
      }

      .tlr-sort-wrap {
        position: relative;
        display: inline-flex;
        align-items: center;
      }

      .tlr-sort-toggle {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        min-width: 30px;
      }

      .tlr-sort-glyph {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        width: 14px;
        height: 12px;
      }

      .tlr-sort-glyph-bars {
        position: relative;
        width: 8px;
        height: 10px;
      }

      .tlr-sort-glyph-bars::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        width: 8px;
        height: 2px;
        background: currentColor;
        box-shadow: 0 4px 0 currentColor, 0 8px 0 currentColor;
        opacity: 0.9;
      }

      .tlr-sort-glyph-arrows {
        position: relative;
        width: 4px;
        height: 10px;
      }

      .tlr-sort-glyph-arrows::before {
        content: '';
        position: absolute;
        top: 0;
        left: 0;
        border-left: 2px solid transparent;
        border-right: 2px solid transparent;
        border-bottom: 3px solid currentColor;
        opacity: 0.95;
      }

      .tlr-sort-glyph-arrows::after {
        content: '';
        position: absolute;
        bottom: 0;
        left: 0;
        border-left: 2px solid transparent;
        border-right: 2px solid transparent;
        border-top: 3px solid currentColor;
        opacity: 0.95;
      }

      .tlr-sort-menu {
        display: none;
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 260px;
        max-width: min(90vw, 340px);
        z-index: 140;
      }

      .tlr-sort-menu,
      .tlr-search-autocomplete {
        padding: 6px;
        border-radius: var(--radius-normal, 8px);
        border: 1px solid var(--cmdpal-border-color, var(--tlr-border-color));
        background: var(--cmdpal-bg-color, var(--panel-bg-color, var(--bg-default, var(--bg-panel, transparent))));
        box-shadow: var(--cmdpal-box-shadow, 0 12px 34px rgba(0, 0, 0, 0.18));
      }

      .tlr-search-autocomplete {
        display: none;
        position: absolute;
        top: calc(100% + 6px);
        left: 0;
        width: min(420px, max(260px, 100%));
        max-width: min(90vw, 420px);
        z-index: 140;
      }

      .tlr-search-autocomplete .autocomplete,
      .tlr-sort-menu .autocomplete {
        position: relative;
        overflow: hidden;
        max-height: 300px;
      }

      .tlr-sort-menu .autocomplete {
        max-height: min(80vh, 460px);
      }

      .tlr-search-autocomplete .vscroll-node,
      .tlr-sort-menu .vscroll-node {
        max-height: 300px;
        overflow-y: auto;
        scrollbar-width: none;
        -ms-overflow-style: none;
        touch-action: pan-y;
      }

      .tlr-sort-menu .vscroll-node {
        max-height: min(80vh, 460px);
        overflow-y: visible;
      }

      .tlr-search-autocomplete .vscroll-node::-webkit-scrollbar,
      .tlr-sort-menu .vscroll-node::-webkit-scrollbar {
        width: 0;
        height: 0;
      }

      .tlr-search-autocomplete .vcontent,
      .tlr-sort-menu .vcontent {
        position: relative;
      }

      .tlr-search-autocomplete .vscrollbar,
      .tlr-sort-menu .vscrollbar {
        position: absolute;
        right: 0;
        top: 0;
        bottom: 0;
        width: 15px;
        user-select: none;
        display: none;
      }

      .tlr-search-autocomplete .vscrollbar.has-thumb,
      .tlr-sort-menu .vscrollbar.has-thumb {
        display: block;
      }

      .tlr-search-autocomplete .vscrollbar-thumb,
      .tlr-sort-menu .vscrollbar-thumb {
        min-height: 16px;
      }

      .tlr-search-autocomplete .autocomplete--option,
      .tlr-sort-menu .autocomplete--option {
        border-radius: 6px;
      }

      .tlr-search-autocomplete .autocomplete--option-right,
      .tlr-sort-menu .autocomplete--option-right {
        color: var(--tlr-text-muted);
        font-size: 11px;
      }

      .tlr-sort-open .tlr-sort-menu {
        display: block;
      }

      .tlr-sort-menu-title {
        margin: 0;
        padding: 8px 10px 4px;
        font-size: 11px;
      }

      .tlr-sort-option {
        width: 100%;
        display: flex;
        align-items: center;
        min-height: 30px;
        padding: 6px 10px;
        line-height: 1.4;
        text-align: left;
        color: var(--tlr-text-default);
        border-radius: 6px;
        box-sizing: border-box;
      }

      .tlr-sort-option-label {
        flex: 1 1 auto;
      }

      .tlr-sort-menu .tlr-sort-option.autocomplete--option-selected,
      .tlr-sort-menu .tlr-sort-option[aria-checked="true"] {
        background: var(--button-primary-bg-color, var(--accent-bg-color, var(--tlr-selected-bg)));
        color: var(--button-primary-fg-color, var(--text-on-accent, var(--tlr-text-default)));
      }

      .tlr-sort-menu .tlr-sort-option:hover,
      .tlr-sort-menu .tlr-sort-option:focus-visible {
        background: var(--button-normal-hover-color, var(--tlr-hover-bg));
      }

      .tlr-sort-menu .tlr-sort-option.autocomplete--option-selected:hover,
      .tlr-sort-menu .tlr-sort-option.autocomplete--option-selected:focus-visible,
      .tlr-sort-menu .tlr-sort-option[aria-checked="true"]:hover,
      .tlr-sort-menu .tlr-sort-option[aria-checked="true"]:focus-visible {
        background: var(--button-primary-bg-color, var(--accent-bg-color, var(--tlr-selected-bg)));
        color: var(--button-primary-fg-color, var(--text-on-accent, var(--tlr-text-default)));
      }

      .tlr-sort-menu-divider {
        margin: 8px 0;
        border-top: 1px solid var(--cmdpal-border-color, var(--tlr-border-color));
      }

      .tlr-search-row {
        display: none;
        width: 100%;
        padding-top: 0;
      }

      .tlr-search-row-inner {
        width: 100%;
      }

      .tlr-search-open .tlr-search-row {
        display: block;
      }

      .tlr-search-wrap {
        position: relative;
        width: 100%;
      }

      .tlr-query-input {
        position: relative;
        width: 100%;
      }

      .tlr-query-input .query-input--wrapper {
        position: relative;
        display: block;
      }

      .tlr-query-input .query-input--highlight {
        display: none;
      }

      .tlr-search-input {
        width: 100%;
        max-width: none;
        min-width: 0;
        position: relative;
        min-height: 34px;
        border: 1px solid var(--input-border-color, var(--tlr-border-color)) !important;
        outline: none !important;
        background: var(--input-bg-color, var(--cmdpal-input-bg-color, var(--bg-panel, transparent))) !important;
        color: var(--input-fg-color, var(--tlr-text-default)) !important;
        -webkit-text-fill-color: var(--input-fg-color, var(--tlr-text-default)) !important;
        caret-color: var(--input-fg-color, var(--tlr-text-default));
        opacity: 1;
        font-size: 13px;
        line-height: 22px;
        font-family: var(--ed-variable-width-font, inherit);
        font-weight: 400;
        padding: 5px 54px 5px 12px;
        border-radius: var(--radius-normal, 8px);
        box-shadow: none !important;
        transition: border-color 0.15s, box-shadow 0.15s, outline-color 0.15s;
      }

      .tlr-search-input::placeholder {
        color: var(--text-xmuted, var(--tlr-text-muted));
      }

      .tlr-search-input:focus {
        border: var(--input-border-focus, 1px solid var(--input-border-color, var(--tlr-border-color))) !important;
        outline: var(--input-border-focus, 1px solid var(--input-border-color, var(--tlr-border-color))) !important;
        box-shadow: var(--input-border-shadow, none) !important;
      }

      .tlr-search-autocomplete-open .tlr-search-autocomplete {
        display: block;
      }

      .tlr-search-clear,
      .tlr-search-refresh {
        display: none;
        position: absolute;
        right: 6px;
        top: 50%;
        transform: translateY(-50%);
        width: 18px;
        height: 18px;
        padding: 0;
        border: none;
        background: transparent;
        border-radius: 50%;
        cursor: pointer;
        z-index: 2;
        font-size: 12px;
        line-height: 1;
        color: var(--tlr-text-muted);
        opacity: 0.7;
        transition: opacity 0.15s, background 0.15s, color 0.15s;
        align-items: center;
        justify-content: center;
      }

      .tlr-search-clear:hover,
      .tlr-search-refresh:hover {
        opacity: 1;
        background: var(--tlr-hover-bg);
      }

      .tlr-toggle {
        flex: 0 0 auto;
        width: 20px;
        height: 20px;
        padding: 0;
        color: var(--tlr-text-muted);
      }

      .tlr-body {
        display: block;
      }

      .tlr-collapsed .tlr-body,
      .tlr-collapsed .tlr-search-row {
        display: none;
      }

      .tlr-empty,
      .tlr-note,
      .tlr-error {
        color: var(--tlr-text-muted);
        padding: 6px 0;
        font-size: 12px;
      }

      .tlr-section-body > .tlr-empty,
      .tlr-section-body > .tlr-note,
      .tlr-section-body > .tlr-error {
        margin-left: 28px;
      }

      .tlr-section-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin: 0;
      }

      .tlr-section-body {
        padding-top: 8px;
      }

      .tlr-section-toggle {
        width: 20px;
        height: 20px;
        padding: 0;
        color: var(--tlr-text-muted);
        flex: 0 0 auto;
      }

      .tlr-section-title {
        flex: 1 1 auto;
        min-width: 0;
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        color: var(--tlr-label-color);
        text-transform: none;
        letter-spacing: 0;
      }

      .tlr-section-meta {
        flex: 0 0 auto;
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        font-variant-numeric: tabular-nums;
        white-space: nowrap;
      }

      .tlr-section-collapsed .tlr-section-body {
        display: none;
      }

      .tlr-divider {
        margin: 12px 0 8px;
        border-top: 1px solid var(--tlr-border-color);
      }

      .tlr-prop-group { margin: 10px 0 12px; }

      .tlr-prop-row {
        display: flex;
        align-items: center;
        gap: 6px;
      }

      .tlr-prop-toggle {
        width: 20px;
        height: 20px;
        padding: 0;
        text-align: center;
        font-weight: 700;
        color: var(--tlr-text-muted);
        flex: 0 0 auto;
      }

      .tlr-prop-header {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        width: 100%;
        flex: 1 1 auto;
        padding: 2px 0 0;
        min-height: 0;
        border: 0;
        background: transparent !important;
        box-shadow: none;
        text-align: left;
        color: var(--tlr-label-color);
      }

      .tlr-fold-icon {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        flex: 0 0 auto;
        color: var(--tlr-text-muted);
        opacity: 0.9;
        font-size: 14px;
        line-height: 1;
        transition: transform 140ms ease, color 140ms ease, opacity 140ms ease;
      }

      .tlr-prop-collapsed .tlr-prop-records {
        display: none;
      }

      .tlr-prop-title {
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: normal;
        overflow-wrap: anywhere;
        flex: 1 1 auto;
        min-width: 0;
      }

      .tlr-prop-meta {
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        margin-left: auto;
        flex: 0 0 auto;
      }

      .tlr-prop-records {
        margin-top: 10px;
        margin-left: var(--tlr-child-indent);
        padding-left: 10px;
        border-left: 1px solid var(--tlr-border-color);
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .tlr-prop-record {
        display: block;
        width: 100%;
        padding: 7px 10px;
        text-align: left;
        color: var(--ed-link-color, var(--link-color, var(--accent, inherit)));
        line-height: 1.4;
        white-space: normal;
        word-break: break-word;
        overflow-wrap: anywhere;
      }

      .tlr-prop-record:hover {
        color: var(--ed-link-hover-color, var(--link-hover-color, var(--ed-link-color, var(--link-color, var(--accent, inherit)))));
        text-decoration: underline;
      }

      .tlr-group { margin: 6px 0 10px; }

      .tlr-group-row {
        display: flex;
        align-items: flex-start;
        gap: 6px;
      }

      .tlr-group-toggle {
        width: 20px;
        height: 20px;
        padding: 0;
        text-align: center;
        font-weight: 700;
        color: var(--tlr-text-muted);
        flex: 0 0 auto;
        margin-top: 1px;
      }

      .tlr-group-header {
        width: 100%;
        flex: 1 1 auto;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 2px 0 0;
        min-height: 0;
        border: 0;
        background: transparent !important;
        box-shadow: none;
        text-align: left;
        color: var(--tlr-label-color);
      }

      .tlr-group-collapsed .tlr-lines {
        display: none;
      }

      .tlr-group-title {
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        overflow: visible;
        text-overflow: clip;
        white-space: normal;
        overflow-wrap: anywhere;
        line-height: 1.35;
      }

      .tlr-group-meta {
        color: var(--tlr-label-color);
        font-size: var(--tlr-label-font-size);
        font-weight: var(--tlr-label-font-weight);
        flex: 0 0 auto;
      }

      .tlr-group-single .tlr-group-meta {
        display: none;
      }

      .tlr-lines {
        margin-top: 10px;
        margin-left: var(--tlr-child-indent);
        padding-left: 10px;
        border-left: 1px solid var(--tlr-border-color);
        display: flex;
        flex-direction: column;
        gap: 8px;
      }

      .tlr-group .tlr-lines {
        margin-top: 2px;
        gap: 6px;
      }

      .tlr-line-entry {
        display: flex;
        flex-direction: column;
        gap: 6px;
      }

      .tlr-line-main {
        display: flex;
        align-items: flex-start;
        gap: 4px;
        border-radius: var(--radius-normal, 8px);
        border: 1px solid transparent;
        background: transparent;
        transition: background-color 0.15s, border-color 0.15s;
      }

      .tlr-group .tlr-line-main {
        border: 0;
        background: transparent;
      }

      .tlr-line-main:hover,
      .tlr-line-main:focus-within {
        background: var(--tlr-hover-bg);
        border-color: var(--tlr-border-color);
      }

      .tlr-line-main.is-context-open {
        background: var(--tlr-selected-bg);
        border-color: var(--tlr-border-color);
      }

      .tlr-line {
        display: block;
        flex: 1 1 auto;
        min-width: 0;
        padding: 8px 10px 8px 12px;
        text-align: left;
        color: var(--tlr-text-default);
        line-height: 1.35;
        border-radius: inherit;
      }

      .tlr-group .tlr-line {
        padding: 4px 6px 7px 10px;
      }

      .tlr-prefix {
        color: var(--tlr-text-muted);
      }

      .tlr-line-content {
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.45;
      }

      .tlr-line-actions {
        display: flex;
        align-items: center;
        gap: 8px;
        flex: 0 0 82px;
        width: 82px;
        padding: 2px 8px 6px 0;
        min-height: 100%;
        justify-content: flex-end;
      }

      .tlr-group-unlinked .tlr-line-actions {
        flex-basis: 110px;
        width: 110px;
      }

      .tlr-line-actions {
        opacity: 0;
        transition: opacity 120ms ease;
      }

      .tlr-line-main:hover .tlr-line-actions,
      .tlr-line-main:focus-within .tlr-line-actions {
        opacity: 1;
      }

      .tlr-line-actions-group {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-left: auto;
        flex: 0 0 auto;
      }

      .tlr-unlinked-link-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border-radius: 6px;
        color: var(--tlr-text-muted);
        line-height: 1;
      }

      .tlr-unlinked-link-btn:hover {
        color: var(--tlr-text-default);
        background: var(--tlr-selected-bg);
      }

      .tlr-unlinked-link-icon {
        width: 14px;
        height: 14px;
      }

      .tlr-unlinked-link-btn-fallback {
        width: auto;
        min-width: 40px;
        padding: 0 8px;
        font-size: 12px;
      }

      .tlr-context-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border-radius: 6px;
        color: var(--tlr-text-muted);
      }

      .tlr-context-btn:hover:not(:disabled),
      .tlr-context-btn.is-active {
        color: var(--tlr-text-default);
        background: var(--tlr-selected-bg);
      }

      .tlr-context-btn:disabled {
        opacity: 0.4;
        cursor: default;
      }

      .tlr-context-glyph {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
      }

      .tlr-context-glyph > * {
        width: 14px;
        height: 14px;
        flex: 0 0 auto;
      }

      .tlr-context-glyph .ti {
        font-size: 14px;
        line-height: 1;
      }

      .tlr-context-glyph-toggle {
        flex-direction: column;
        gap: 0;
      }

      .tlr-context-glyph-toggle .ti {
        font-size: 12px;
        margin: -3px 0;
      }

      .tlr-context-glyph-toggle > * {
        width: 12px;
        height: 12px;
      }

      .tlr-context-btn-toggle {
        width: 26px;
      }

      .tlr-context-list {
        display: flex;
        flex-direction: column;
        gap: 3px;
        margin-left: 0;
        padding-left: 0;
      }

      .tlr-context-line {
        display: block;
        box-sizing: border-box;
        width: calc(100% - var(--tlr-context-indent, 0px));
        margin-left: var(--tlr-context-indent, 0px);
        padding: 5px 10px 5px 12px;
        text-align: left;
        color: var(--tlr-text-default);
        line-height: 1.35;
        border-left: 1px solid var(--tlr-border-color);
        border-radius: 6px;
        transition: background-color 0.15s, border-color 0.15s;
      }

      .tlr-context-line:hover,
      .tlr-context-line:focus-visible {
        background: var(--tlr-hover-bg);
      }

      .tlr-context-note {
        padding: 0 10px 2px;
      }

      .tlr-live-badge {
        display: inline-flex;
        align-items: center;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid var(--tlr-border-color);
        background: var(--tlr-hover-bg);
        color: var(--tlr-text-muted);
        font-size: 11px;
        vertical-align: middle;
      }

      .tlr-live-badge.is-new {
        color: var(--tlr-text-default);
      }

      .tlr-live-badge.is-remote {
        border-style: dashed;
      }

      .tlr-seg-bold { font-weight: 600; }
      .tlr-seg-italic { font-style: italic; }
      .tlr-seg-code {
        font-family: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace;
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
        padding: 1px 4px;
        border-radius: 6px;
      }
      .tlr-seg-link { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); text-decoration: underline; }
      .tlr-seg-link:visited { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); }
      .tlr-seg-link:hover { color: var(--ed-link-hover-color, var(--link-hover-color, var(--ed-link-color, var(--link-color, var(--accent, inherit))))); }
      .tlr-seg-hashtag { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); }
      .tlr-seg-datetime { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); }
      .tlr-seg-mention { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); }
      .tlr-seg-ref { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); cursor: pointer; text-decoration: underline; }
      .tlr-seg-ref:hover { color: var(--ed-link-hover-color, var(--link-hover-color, var(--ed-link-color, var(--link-color, var(--accent, inherit))))); }

      .tlr-search-mark {
        background: var(--ed-selection-self-bg, var(--selection-bg, rgba(255, 217, 61, 0.35)));
        color: inherit;
        padding: 0 1px;
        border-radius: 4px;
        display: inline;
        line-height: inherit;
      }

      .tlr-loading .tlr-search-wrap { opacity: 0.78; }
      .tlr-loading .tlr-sort-toggle { opacity: 0.6; cursor: default; }

      @media (max-width: 760px) {
        .tlr-footer {
          --tlr-child-indent: 22px;
          --tlr-context-rail-gap: 6px;
        }

        .tlr-header {
          gap: 8px;
          align-items: flex-start;
        }

        .tlr-header-main {
          min-width: 0;
        }

        .tlr-count {
          min-width: 0;
        }

        .tlr-sort-menu {
          right: 0;
          left: auto;
          min-width: 240px;
          max-width: min(92vw, 320px);
        }
        .tlr-search-input { max-width: none; }
      }
    `);
  }
}
