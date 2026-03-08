class Plugin extends AppPlugin {
  onLoad() {
    // NOTE: Thymer strips top-level code outside the Plugin class.
    this._version = '0.4.14';
    this._pluginName = 'Backreferences';

    this._panelStates = new Map();
    this._eventHandlerIds = [];

    this._storageKeyCollapsed = 'thymer_backreferences_collapsed_v2';
    this._legacyStorageKeyCollapsed = null;
    this._collapsed = this.loadCollapsedSetting();

    this._storageKeyPropGroupCollapsed = 'thymer_backreferences_prop_group_collapsed_v2';
    this._legacyStorageKeyPropGroupCollapsed = null;
    this._propGroupCollapsed = this.loadPropGroupCollapsedSetting();

    this._defaultSortBy = 'page_last_edited';
    this._defaultSortDir = 'desc';
    this._storageKeySortByRecord = 'thymer_backreferences_sort_by_record_v1';
    this._legacyStorageKeySortByRecord = 'thymer_backlinks_sort_by_record_v1';
    this._sortByRecord = this.loadSortByRecordSetting();

    this._defaultFilterPreset = 'all';
    this._recentActivityWindowMs = 7 * 24 * 60 * 60 * 1000;
    this._recordCollectionGuidCache = new Map();
    this._recordCollectionGuidPending = new Map();

    this._defaultMaxResults = 200;
    this._refreshDebounceMs = 350;
    this._queryFilterDebounceMs = 180;
    this._queryFilterChunkSize = 24;
    this._queryFilterMaxResults = 1000;
    this._legacyIgnoreMetaKey = 'plugin.refs.v1.ignore';
    this._storageKeyIgnoreCleanupDone = 'thymer_backreferences_ignore_cleanup_v1';
    this._ignoreCleanupPromise = null;

    this.injectCss();

    this._cmdRefresh = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Refresh (Active Page)',
      icon: 'refresh',
      onSelected: () => {
        const panel = this.ui.getActivePanel();
        if (panel) this.scheduleRefreshForPanel(panel, { force: true, reason: 'cmdpal' });
      }
    });

    this._statusItem = this.ui.addStatusBarItem({
      icon: 'ti-link',
      label: '0',
      tooltip: 'Backreferences',
      onClick: () => {
        const panel = this.ui.getActivePanel();
        if (panel) this.scheduleRefreshForPanel(panel, { force: true, reason: 'status-item' });
      }
    });
    this._statusItem?.hide?.();

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
    setTimeout(() => {
      const p = this.ui.getActivePanel();
      if (p) this.handlePanelChanged(p, 'initial-delayed');
    }, 250);
    setTimeout(() => {
      this.runIgnoreCleanupMigrationIfNeeded().catch(() => {
        // ignore
      });
    }, 900);
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

    this._cmdRefresh?.remove?.();
    this._statusItem?.remove?.();

    for (const panelId of Array.from(this._panelStates?.keys?.() || [])) {
      this.disposePanelState(panelId);
    }
    this._panelStates?.clear?.();
    this._recordCollectionGuidCache?.clear?.();
    this._recordCollectionGuidPending?.clear?.();
  }

  // ---------- Panel lifecycle ----------

  handlePanelChanged(panel, reason) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;

    const panelEl = panel?.getElement?.() || null;
    if (this.shouldSuppressInPanel(panel, panelEl)) {
      this.disposePanelState(panelId);
      this.syncStatusItem();
      return;
    }

    const mountContainer = this.findMountContainer(panelEl);
    if (!mountContainer) {
      this.disposePanelState(panelId);
      this.syncStatusItem();
      return;
    }

    const record = panel?.getActiveRecord?.() || null;
    const recordGuid = record?.guid || null;

    if (!recordGuid) {
      // If the panel no longer shows a record, remove our footer.
      this.disposePanelState(panelId);
      this.syncStatusItem();
      return;
    }

    const state = this.getOrCreatePanelState(panel);
    if (!state.sectionCollapsed || typeof state.sectionCollapsed !== 'object') {
      state.sectionCollapsed = this.createDefaultSectionCollapsedState();
    }
    const recordChanged = state.recordGuid !== recordGuid;
    state.recordGuid = recordGuid;
    state.filterPreset = this.normalizeFilterPreset(state.filterPreset) || this._defaultFilterPreset;

    if (recordChanged || !this.isValidSortBy(state.sortBy) || !this.isValidSortDir(state.sortDir)) {
      state.sectionCollapsed = this.createDefaultSectionCollapsedState();
      state.emptyStateExpanded = false;
      state.linkedContextByLine = new Map();
      state.filterMetaLoading = false;
      state.filterMenuOpen = false;
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
    }

    this.mountFooter(panel, state);

    // Always refresh on navigation; on focus we debounce unless already loaded.
    this.scheduleRefreshForPanel(panel, {
      force: recordChanged,
      reason: reason || (recordChanged ? 'record-changed' : 'record-same')
    });
    this.syncStatusItem();
  }

  shouldSuppressInPanel(panel, panelEl) {
    const nav = panel?.getNavigation?.() || null;
    const navType = nav && typeof nav.type === 'string' ? nav.type.trim() : '';

    // Keep suppression conservative: nav.type labels can vary across builds.
    // We only hard-suppress known custom panel nav types. Other panel kinds are
    // filtered by mount-container detection and active-record checks.
    if (navType === 'custom' || navType === 'custom_panel') return true;

    return false;
  }

  handlePanelClosed(panel) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;
    this.disposePanelState(panelId);
    this.syncStatusItem();
  }

  getOrCreatePanelState(panel) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) {
      return {
        panelId: 'unknown',
        recordGuid: null,
        mountedIn: null,
        rootEl: null,
        bodyEl: null,
        countEl: null,
        filterToggleEl: null,
        filterMenuEl: null,
        sortToggleEl: null,
        sortMenuEl: null,
        searchToggleEl: null,
        searchWrapEl: null,
        searchInputEl: null,
        searchQuery: '',
        searchOpen: false,
        filterPreset: this._defaultFilterPreset,
        filterMenuOpen: false,
        filterMenuDismissHandler: null,
        filterMetaLoading: false,
        sectionCollapsed: this.createDefaultSectionCollapsedState(),
        emptyStateExpanded: false,
        linkedContextByLine: new Map(),
        liveBaselineSnapshot: null,
        liveCurrentSnapshot: null,
        liveNewKeys: new Set(),
        liveRemoteBadgesByKey: new Map(),
        pendingRemoteSync: false,
        pendingRemoteUsers: new Set(),
        sortBy: this._defaultSortBy,
        sortDir: this._defaultSortDir,
        sortMenuOpen: false,
        sortMenuDismissHandler: null,
        queryFilterTimer: null,
        queryFilterSeq: 0,
        queryFilterState: null,
        lastResults: null,
        observer: null,
        refreshTimer: null,
        refreshSeq: 0,
        isLoading: false
      };
    }

    let state = this._panelStates.get(panelId) || null;
    if (state) {
      state.panel = panel;
      return state;
    }

    state = {
      panelId,
      panel,
      recordGuid: null,
      mountedIn: null,
      rootEl: null,
      bodyEl: null,
      countEl: null,
      filterToggleEl: null,
      filterMenuEl: null,
      sortToggleEl: null,
      sortMenuEl: null,
      searchToggleEl: null,
      searchWrapEl: null,
      searchInputEl: null,
      searchQuery: '',
      searchOpen: false,
      filterPreset: this._defaultFilterPreset,
      filterMenuOpen: false,
      filterMenuDismissHandler: null,
      filterMetaLoading: false,
      sectionCollapsed: this.createDefaultSectionCollapsedState(),
      emptyStateExpanded: false,
      linkedContextByLine: new Map(),
      liveBaselineSnapshot: null,
      liveCurrentSnapshot: null,
      liveNewKeys: new Set(),
      liveRemoteBadgesByKey: new Map(),
      pendingRemoteSync: false,
      pendingRemoteUsers: new Set(),
      sortBy: this._defaultSortBy,
      sortDir: this._defaultSortDir,
      sortMenuOpen: false,
      sortMenuDismissHandler: null,
      queryFilterTimer: null,
      queryFilterSeq: 0,
      queryFilterState: null,
      lastResults: null,
      observer: null,
      refreshTimer: null,
      refreshSeq: 0,
      isLoading: false
    };

    this._panelStates.set(panelId, state);
    return state;
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

    try {
      state.observer?.disconnect?.();
    } catch (e) {
      // ignore
    }
    state.observer = null;

    this.setFilterMenuOpen(state, false);
    this.setSortMenuOpen(state, false);

    try {
      state.rootEl?.remove?.();
    } catch (e) {
      // ignore
    }

    this._panelStates.delete(panelId);
  }

  // ---------- Mounting ----------

  mountFooter(panel, state) {
    const panelEl = panel?.getElement?.() || null;
    if (!panelEl) return;

    const container = this.findMountContainer(panelEl);
    if (!container) return;

    // If Thymer re-rendered and dropped our node, rebuild.
    const needsRebuild = !state.rootEl || !state.rootEl.isConnected;
    if (needsRebuild) {
      state.rootEl = this.buildFooterRoot(state);
      state.bodyEl = state.rootEl.querySelector('[data-role="body"]');
      state.countEl = state.rootEl.querySelector('[data-role="count"]');
      this.setSearchOpen(state, state.searchOpen === true);
      this.renderFilterMenu(state);
      this.syncFilterControlState(state);
      this.setFilterMenuOpen(state, state.filterMenuOpen === true);
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

    this.renderFilterMenu(state);
    this.syncFilterControlState(state);
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

    const header = document.createElement('div');
    header.className = 'tlr-header';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'tlr-btn tlr-toggle button-none button-small button-minimal-hover';
    toggleBtn.type = 'button';
    toggleBtn.dataset.action = 'toggle';
    toggleBtn.title = 'Collapse/expand';
    toggleBtn.textContent = this._collapsed ? '+' : '-';

    const title = document.createElement('div');
    title.className = 'tlr-title';
    title.textContent = 'Backreferences';

    const count = document.createElement('div');
    count.className = 'tlr-count text-details';
    count.dataset.role = 'count';
    count.textContent = '';

    const spacer = document.createElement('div');
    spacer.className = 'tlr-spacer';

    const searchWrap = document.createElement('div');
    searchWrap.className = 'tlr-search-wrap query-input';

    const searchIcon = document.createElement('div');
    searchIcon.className = 'tlr-search-icon';
    try {
      searchIcon.appendChild(this.ui.createIcon('ti-search'));
    } catch (e) {
      searchIcon.textContent = 'Search';
    }

    const input = document.createElement('input');
    input.className = 'tlr-search-input query-input--field form-input';
    input.type = 'text';
    input.name = 'backreferences-filter';
    input.placeholder = 'Text or query, e.g. @task AND "meeting"';
    input.title = 'Filter backreferences with plain text or Thymer query syntax';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = state.searchQuery || '';

    const stopKeys = (e) => {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    };

    input.addEventListener('keydown', (e) => {
      stopKeys(e);
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
          e.preventDefault();
          this.scheduleQueryFilterRefresh(state, { immediate: true, reason: 'enter' });
        }
      }
    });

    input.addEventListener('input', () => {
      state.searchQuery = input.value;
      this.handleSearchQueryChanged(state, { immediate: false });
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'tlr-search-clear button-none button-small button-minimal-hover';
    clearBtn.type = 'button';
    clearBtn.dataset.action = 'clear-search';
    clearBtn.title = 'Clear';
    clearBtn.textContent = 'x';

    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(input);
    searchWrap.appendChild(clearBtn);

    const sortWrap = document.createElement('div');
    sortWrap.className = 'tlr-sort-wrap';

    const sortToggle = document.createElement('button');
    sortToggle.className = 'tlr-btn tlr-sort-toggle button-none button-small button-minimal-hover';
    sortToggle.type = 'button';
    sortToggle.dataset.action = 'toggle-sort-menu';
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

    sortWrap.appendChild(sortToggle);
    sortWrap.appendChild(sortMenu);

    header.appendChild(toggleBtn);
    header.appendChild(title);
    header.appendChild(count);
    header.appendChild(spacer);
    header.appendChild(searchWrap);
    header.appendChild(sortWrap);

    const body = document.createElement('div');
    body.className = 'tlr-body';
    body.dataset.role = 'body';

    root.appendChild(header);
    root.appendChild(body);

    root.addEventListener('click', (e) => this.handleFooterClick(e));

    this.applyCollapsedState(root, this._collapsed);
    root.classList.toggle('tlr-sort-open', state.sortMenuOpen === true);

    state.filterToggleEl = null;
    state.filterMenuEl = null;
    state.sortToggleEl = sortToggle;
    state.sortMenuEl = sortMenu;
    state.searchToggleEl = null;
    state.searchWrapEl = searchWrap;
    state.searchInputEl = input;
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
      this._collapsed = !this._collapsed;
      this.saveCollapsedSetting(this._collapsed);
      for (const s of this._panelStates.values()) {
        if (!s?.rootEl) continue;
        this.applyCollapsedState(s.rootEl, this._collapsed);
        const btn = s.rootEl.querySelector?.('[data-action="toggle"]') || null;
        if (btn) btn.textContent = this._collapsed ? '+' : '-';
      }
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
      actionEl.setAttribute?.('aria-expanded', nextCollapsed ? 'false' : 'true');
      return;
    }

    if (action === 'toggle-section') {
      if (!state) return;
      const sectionId = this.normalizeSectionId(actionEl.dataset.sectionId);
      if (!sectionId) return;

      const nextCollapsed = !this.isSectionCollapsed(state, sectionId);
      this.setSectionCollapsed(state, sectionId, nextCollapsed);
      this.renderFromCache(state);

      if (sectionId === 'unlinked' && nextCollapsed !== true) {
        this.ensureDeferredUnlinkedLoaded(state).catch(() => {
          // ignore
        });
      }
      if (sectionId === 'unlinked') {
        this.syncScopedQueryWithCurrentInput(state, { immediate: true, reason: 'toggle-unlinked-section' });
        this.renderFromCache(state);
      }
      return;
    }

    if (action === 'toggle-sort-menu') {
      if (!state) return;
      if (state.sortMenuOpen === true) {
        this.setSortMenuOpen(state, false);
      } else {
        this.setFilterMenuOpen(state, false);
        this.setSortMenuOpen(state, true);
      }
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

    if (action === 'expand-empty') {
      if (!state) return;
      state.emptyStateExpanded = true;
      this.renderFromCache(state);
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

    const panel = state?.panel || null;
    if (!panel) return;

    if (action === 'open-record') {
      const guid = actionEl.dataset.recordGuid || null;
      if (!guid) return;
      this.setFilterMenuOpen(state, false);
      this.setSortMenuOpen(state, false);
      this.openRecord(panel, guid, null, e);
      return;
    }

    if (action === 'open-line') {
      const guid = actionEl.dataset.recordGuid || null;
      const lineGuid = actionEl.dataset.lineGuid || null;
      if (!guid) return;
      this.setFilterMenuOpen(state, false);
      this.setSortMenuOpen(state, false);
      this.openRecord(panel, guid, lineGuid || null, e);
      return;
    }

    if (action === 'open-ref') {
      const guid = actionEl.dataset.refGuid || null;
      if (!guid) return;
      this.setFilterMenuOpen(state, false);
      this.setSortMenuOpen(state, false);
      this.openRecord(panel, guid, null, e);
      return;
    }
  }

  openRecord(panel, recordGuid, subId, e) {
    const workspaceGuid = this.getWorkspaceGuid?.() || null;
    if (!workspaceGuid) return;

    const openInNew = e?.metaKey || e?.ctrlKey;

    if (openInNew) {
      this.ui
        .createPanel({ afterPanel: panel })
        .then((newPanel) => {
          if (!newPanel) return;
          newPanel.navigateTo({
            type: 'edit_panel',
            rootId: recordGuid,
            subId: subId || null,
            workspaceGuid
          });
          this.ui.setActivePanel(newPanel);
        })
        .catch(() => {
          // ignore
        });
      return;
    }

    panel.navigateTo({
      type: 'edit_panel',
      rootId: recordGuid,
      subId: subId || null,
      workspaceGuid
    });
    this.ui.setActivePanel(panel);
  }

  applyCollapsedState(root, collapsed) {
    if (!root) return;
    root.classList.toggle('tlr-collapsed', collapsed === true);
  }

  createDefaultSectionCollapsedState() {
    return {
      property: false,
      linked: false,
      unlinked: true
    };
  }

  normalizeSectionId(sectionId) {
    return sectionId === 'property' || sectionId === 'linked' || sectionId === 'unlinked'
      ? sectionId
      : null;
  }

  getDefaultSectionCollapsed(sectionId) {
    const defaults = this.createDefaultSectionCollapsedState();
    return defaults[sectionId] === true;
  }

  isSectionCollapsed(state, sectionId) {
    const id = this.normalizeSectionId(sectionId);
    if (!id) return false;
    const current = state?.sectionCollapsed?.[id];
    if (typeof current === 'boolean') return current;
    return this.getDefaultSectionCollapsed(id);
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

  getFilterOptions() {
    return [
      { id: 'all', label: 'All References' },
      { id: 'tasks', label: 'Tasks' },
      { id: 'recent', label: 'Recently Active' },
      { id: 'same_collection', label: 'This Collection' },
      { id: 'mentions', label: 'Mentions' },
      { id: 'journal', label: 'Journal Pages' }
    ];
  }

  getFilterLabel(filterPreset) {
    const id = this.normalizeFilterPreset(filterPreset) || this._defaultFilterPreset;
    for (const option of this.getFilterOptions()) {
      if (option.id === id) return option.label;
    }
    return 'All References';
  }

  isValidFilterPreset(filterPreset) {
    if (typeof filterPreset !== 'string') return false;
    return this.getFilterOptions().some((x) => x.id === filterPreset);
  }

  normalizeFilterPreset(filterPreset) {
    return this.isValidFilterPreset(filterPreset) ? filterPreset : null;
  }

  filterPresetNeedsCollectionMeta(filterPreset) {
    return this.normalizeFilterPreset(filterPreset) === 'same_collection';
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
    this.syncScopedQueryWithCurrentInput(state, { immediate: immediate === true, reason: 'input' });
    this.renderFromCache(state);

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
    if (this.getSearchMode(query) !== 'query') {
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

  buildScopedQueryChunks(query, recordGuids) {
    const trimmedQuery = (query || '').trim();
    if (!trimmedQuery) return [];

    const guids = Array.isArray(recordGuids) ? recordGuids.filter(Boolean) : [];
    if (guids.length === 0) return [];

    const chunkSize = Math.max(1, this._queryFilterChunkSize || 40);
    const queries = [];
    for (let i = 0; i < guids.length; i += chunkSize) {
      const chunk = guids.slice(i, i + chunkSize);
      const scope = chunk
        .map((guid) => `(@rguid = "${guid}" OR @guid = "${guid}")`)
        .join(' OR ');
      queries.push(`(${trimmedQuery}) AND (${scope})`);
    }
    return queries;
  }

  mergeScopedQuerySearchResults(resultList) {
    const records = [];
    const lines = [];
    const seenRecordGuids = new Set();
    const seenLineGuids = new Set();

    for (const result of resultList || []) {
      for (const record of result?.records || []) {
        const guid = (record?.guid || '').trim();
        if (!guid || seenRecordGuids.has(guid)) continue;
        seenRecordGuids.add(guid);
        records.push(record);
      }
      for (const line of result?.lines || []) {
        const guid = (line?.guid || '').trim();
        if (!guid || seenLineGuids.has(guid)) continue;
        seenLineGuids.add(guid);
        lines.push(line);
      }
    }

    return { records, lines };
  }

  scheduleQueryFilterRefresh(state, { immediate, reason } = {}) {
    if (!state) return;

    const query = (state.searchQuery || '').trim();
    if (this.getSearchMode(query) !== 'query') {
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

    const results = state.lastResults || null;
    const query = (state.searchQuery || '').trim();
    if (!results || this.getSearchMode(query) !== 'query') {
      this.clearQueryFilterState(state);
      this.renderFromCache(state);
      return;
    }

    const includeUnlinked = this.shouldIncludeUnlinkedInQueryScope(state, results);
    const recordGuids = this.collectQueryScopeRecordGuids(results, { includeUnlinked });
    if (recordGuids.length === 0) {
      if (!this._panelStates.has(panelId) || state.queryFilterSeq !== seq) return;
      state.queryFilterState = this.createQueryFilterState(query, {
        ready: true,
        includesUnlinked: includeUnlinked
      });
      this.renderFromCache(state);
      return;
    }

    const scopedQueries = this.buildScopedQueryChunks(query, recordGuids);
    let merged = { records: [], lines: [] };
    let error = '';
    try {
      const settled = await Promise.all(scopedQueries.map((scopedQuery) => this.data.searchByQuery(scopedQuery, this._queryFilterMaxResults)));
      const firstError = settled.find((result) => typeof result?.error === 'string' && result.error.trim());
      if (firstError?.error) {
        error = firstError.error.trim();
      } else {
        merged = this.mergeScopedQuerySearchResults(settled);
      }
    } catch (e) {
      error = 'Could not apply query filter.';
    }

    if (!this._panelStates.has(panelId)) return;
    if (state.queryFilterSeq !== seq) return;
    if ((state.searchQuery || '').trim() !== query) return;

    const previous = this.getQueryFilterState(state, query);
    if (error) {
      state.queryFilterState = this.createQueryFilterState(query, {
        loading: false,
        ready: previous?.ready === true,
        error,
        includesUnlinked,
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

    for (const record of merged.records || []) {
      const guid = (record?.guid || '').trim();
      if (!guid) continue;
      matchedRecordGuids.add(guid);
      matchedLineRecordGuids.add(guid);
    }

    for (const line of merged.lines || []) {
      const guid = (line?.guid || '').trim();
      if (guid) matchedLineGuids.add(guid);
      const recordGuid = (line?.getRecord?.()?.guid || '').trim();
      if (recordGuid) matchedLineRecordGuids.add(recordGuid);
    }

    state.queryFilterState = this.createQueryFilterState(query, {
      loading: false,
      ready: true,
      includesUnlinked,
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

  setSearchOpen(state, open) {
    if (!state) return;
    state.searchOpen = open === true;
    if (state.searchOpen === true) {
      this.setFilterMenuOpen(state, false);
      this.setSortMenuOpen(state, false);
    }
    if (!state.rootEl) return;

    state.rootEl.classList.toggle('tlr-search-open', state.searchOpen === true);
    state.searchToggleEl?.setAttribute?.('aria-expanded', state.searchOpen === true ? 'true' : 'false');

    if (state.searchInputEl) {
      state.searchInputEl.value = state.searchQuery || '';
      if (state.searchOpen === true) {
        setTimeout(() => {
          try {
            state.searchInputEl?.focus?.();
          } catch (e) {
            // ignore
          }
        }, 0);
      }
    }
  }

  renderFilterMenu(state) {
    const menu = state?.filterMenuEl || null;
    if (!menu) return;

    const filterPreset = this.normalizeFilterPreset(state.filterPreset) || this._defaultFilterPreset;
    state.filterPreset = filterPreset;

    menu.innerHTML = '';

    const title = document.createElement('div');
    title.className = 'tlr-filter-menu-title text-details';
    title.textContent = 'Advanced Filter';
    menu.appendChild(title);

    for (const option of this.getFilterOptions()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tlr-filter-option button-normal button-normal-hover';
      row.dataset.action = 'set-filter-preset';
      row.dataset.filterPreset = option.id;
      if (option.id === filterPreset) row.classList.add('is-active');

      const label = document.createElement('span');
      label.className = 'tlr-filter-option-label';
      label.textContent = option.label;

      row.appendChild(label);
      menu.appendChild(row);
    }
  }

  syncFilterControlState(state) {
    if (!state) return;
    const filterPreset = this.normalizeFilterPreset(state.filterPreset) || this._defaultFilterPreset;
    state.filterPreset = filterPreset;

    if (state.filterToggleEl) {
      state.filterToggleEl.title = `Filter: ${this.getFilterLabel(filterPreset)}`;
      state.filterToggleEl.setAttribute('aria-expanded', state.filterMenuOpen === true ? 'true' : 'false');
      state.filterToggleEl.classList.toggle('is-active', filterPreset !== this._defaultFilterPreset);
      state.filterToggleEl.classList.toggle('is-loading', state.filterMetaLoading === true);
    }

    if (state.rootEl) {
      state.rootEl.classList.toggle('tlr-filter-open', state.filterMenuOpen === true);
    }
  }

  setFilterMenuOpen(state, open) {
    if (!state) return;
    state.filterMenuOpen = open === true;

    if (state.filterMenuDismissHandler) {
      try {
        document.removeEventListener('pointerdown', state.filterMenuDismissHandler, true);
        document.removeEventListener('mousedown', state.filterMenuDismissHandler, true);
      } catch (e) {
        // ignore
      }
      state.filterMenuDismissHandler = null;
    }

    this.syncFilterControlState(state);

    if (state.filterMenuOpen !== true) return;

    const onOutsideMouseDown = (ev) => {
      const menu = state.filterMenuEl || null;
      const toggle = state.filterToggleEl || null;
      if (!menu || !menu.isConnected) {
        this.setFilterMenuOpen(state, false);
        return;
      }

      const target = ev.target;
      if (menu.contains(target)) return;
      if (toggle && toggle.contains(target)) return;
      this.setFilterMenuOpen(state, false);
    };

    state.filterMenuDismissHandler = onOutsideMouseDown;
    try {
      document.addEventListener('pointerdown', onOutsideMouseDown, true);
      document.addEventListener('mousedown', onOutsideMouseDown, true);
    } catch (e) {
      // ignore
    }
  }

  async handleFilterPresetSelected(state, nextPreset) {
    if (!state) return;
    const filterPreset = this.normalizeFilterPreset(nextPreset) || this._defaultFilterPreset;
    state.filterPreset = filterPreset;
    this.setFilterMenuOpen(state, false);

    if (!this.filterPresetNeedsCollectionMeta(filterPreset) || !state.lastResults) {
      state.filterMetaLoading = false;
      this.renderFromCache(state);
      return;
    }

    state.filterMetaLoading = true;
    this.syncFilterControlState(state);
    this.renderFromCache(state);

    try {
      await this.ensureCollectionMetaForResults(state, state.lastResults);
    } finally {
      if ((this._panelStates.get(state.panelId) || null) !== state) return;
      state.filterMetaLoading = false;
      this.syncFilterControlState(state);
      this.renderFromCache(state);
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

    const title = document.createElement('div');
    title.className = 'tlr-sort-menu-title text-details';
    title.textContent = 'Sort By';
    menu.appendChild(title);

    for (const option of this.getSortOptions()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tlr-sort-option button-normal button-normal-hover';
      row.dataset.action = 'set-sort-by';
      row.dataset.sortBy = option.id;
      if (option.id === sortBy) row.classList.add('is-active');

      const label = document.createElement('span');
      label.className = 'tlr-sort-option-label';
      label.textContent = option.label;

      row.appendChild(label);
      menu.appendChild(row);
    }

    const divider = document.createElement('div');
    divider.className = 'tlr-sort-menu-divider';
    menu.appendChild(divider);

    const dirRow = document.createElement('div');
    dirRow.className = 'tlr-sort-dir-row';

    const ascBtn = document.createElement('button');
    ascBtn.type = 'button';
    ascBtn.className = 'tlr-sort-dir-btn button-normal button-normal-hover button-small';
    ascBtn.dataset.action = 'set-sort-dir';
    ascBtn.dataset.sortDir = 'asc';
    ascBtn.textContent = 'Ascending';
    if (sortDir === 'asc') ascBtn.classList.add('is-active');

    const descBtn = document.createElement('button');
    descBtn.type = 'button';
    descBtn.className = 'tlr-sort-dir-btn button-normal button-normal-hover button-small';
    descBtn.dataset.action = 'set-sort-dir';
    descBtn.dataset.sortDir = 'desc';
    descBtn.textContent = 'Descending';
    if (sortDir === 'desc') descBtn.classList.add('is-active');

    dirRow.appendChild(ascBtn);
    dirRow.appendChild(descBtn);
    menu.appendChild(dirRow);
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
      state.sortToggleEl.setAttribute('aria-expanded', state.sortMenuOpen === true ? 'true' : 'false');
    }

    if (state.rootEl) {
      state.rootEl.classList.toggle('tlr-sort-open', state.sortMenuOpen === true);
    }
  }

  setSortMenuOpen(state, open) {
    if (!state) return;
    state.sortMenuOpen = open === true;

    if (state.sortMenuDismissHandler) {
      try {
        document.removeEventListener('pointerdown', state.sortMenuDismissHandler, true);
        document.removeEventListener('mousedown', state.sortMenuDismissHandler, true);
      } catch (e) {
        // ignore
      }
      state.sortMenuDismissHandler = null;
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

    state.sortMenuDismissHandler = onOutsideMouseDown;
    try {
      document.addEventListener('pointerdown', onOutsideMouseDown, true);
      document.addEventListener('mousedown', onOutsideMouseDown, true);
    } catch (e) {
      // ignore
    }
  }

  renderFromCache(state) {
    if (!state) return;
    const cached = state.lastResults || null;
    if (!cached) return;

    const panel = state.panel || null;
    if (panel && (!state.rootEl || !state.rootEl.isConnected)) {
      this.mountFooter(panel, state);
    }

    if (!state.bodyEl || !state.countEl) return;
    this.renderReferences(state, cached);
  }

  loadCollapsedSetting() {
    try {
      const v = localStorage.getItem(this._storageKeyCollapsed);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (e) {
      // ignore
    }

    // Migration: older versions used a back"links" storage key.
    try {
      const legacyKey = this._legacyStorageKeyCollapsed;
      if (legacyKey && legacyKey !== this._storageKeyCollapsed) {
        const v = localStorage.getItem(legacyKey);
        if (v === '1' || v === '0') {
          try {
            localStorage.setItem(this._storageKeyCollapsed, v);
          } catch (e) {
            // ignore
          }
          return v === '1';
        }
      }
    } catch (e) {
      // ignore
    }

    return false;
  }

  saveCollapsedSetting(collapsed) {
    try {
      localStorage.setItem(this._storageKeyCollapsed, collapsed ? '1' : '0');
    } catch (e) {
      // ignore
    }
  }

  loadPropGroupCollapsedSetting() {
    const parse = (v) => {
      if (typeof v !== 'string' || !v.trim()) return null;
      try {
        const parsed = JSON.parse(v);
        if (!Array.isArray(parsed)) return null;

        const out = new Set();
        for (const x of parsed) {
          if (typeof x !== 'string') continue;
          const t = x.trim();
          if (t) out.add(t);
        }
        return out;
      } catch (e) {
        // ignore
      }
      return null;
    };

    try {
      const v = localStorage.getItem(this._storageKeyPropGroupCollapsed);
      const set = parse(v);
      if (set) return set;
    } catch (e) {
      // ignore
    }

    // Migration: older versions used a back"links" storage key.
    try {
      const legacyKey = this._legacyStorageKeyPropGroupCollapsed;
      if (legacyKey && legacyKey !== this._storageKeyPropGroupCollapsed) {
        const v = localStorage.getItem(legacyKey);
        const set = parse(v);
        if (set) {
          try {
            localStorage.setItem(this._storageKeyPropGroupCollapsed, JSON.stringify(Array.from(set)));
          } catch (e) {
            // ignore
          }
          return set;
        }
      }
    } catch (e) {
      // ignore
    }

    return new Set();
  }

  savePropGroupCollapsedSetting() {
    try {
      const arr = Array.from(this._propGroupCollapsed || []);
      localStorage.setItem(this._storageKeyPropGroupCollapsed, JSON.stringify(arr));
    } catch (e) {
      // ignore
    }
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
    if (collapsed === true) this._propGroupCollapsed.add(name);
    else this._propGroupCollapsed.delete(name);
    this.savePropGroupCollapsedSetting();
  }

  loadSortByRecordSetting() {
    const parse = (v) => {
      if (typeof v !== 'string' || !v.trim()) return null;
      try {
        const parsed = JSON.parse(v);
        if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;

        const out = {};
        for (const [recordGuid, pref] of Object.entries(parsed)) {
          const guid = typeof recordGuid === 'string' ? recordGuid.trim() : '';
          if (!guid) continue;
          const sortBy = this.normalizeSortBy(pref?.sortBy);
          const sortDir = this.normalizeSortDir(pref?.sortDir);
          if (!sortBy || !sortDir) continue;
          out[guid] = { sortBy, sortDir };
        }
        return out;
      } catch (e) {
        // ignore
      }
      return null;
    };

    try {
      const v = localStorage.getItem(this._storageKeySortByRecord);
      const map = parse(v);
      if (map) return map;
    } catch (e) {
      // ignore
    }

    // Migration: older versions used a back"links" storage key.
    try {
      const legacyKey = this._legacyStorageKeySortByRecord;
      if (legacyKey && legacyKey !== this._storageKeySortByRecord) {
        const v = localStorage.getItem(legacyKey);
        const map = parse(v);
        if (map) {
          try {
            localStorage.setItem(this._storageKeySortByRecord, JSON.stringify(map));
          } catch (e) {
            // ignore
          }
          return map;
        }
      }
    } catch (e) {
      // ignore
    }

    return {};
  }

  saveSortByRecordSetting() {
    try {
      localStorage.setItem(this._storageKeySortByRecord, JSON.stringify(this._sortByRecord || {}));
    } catch (e) {
      // ignore
    }
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
      this._sortByRecord[guid] = { sortBy: nextSortBy, sortDir: nextSortDir };
    }

    this.saveSortByRecordSetting();
  }

  hasCompletedIgnoreCleanupMigration() {
    try {
      return localStorage.getItem(this._storageKeyIgnoreCleanupDone) === '1';
    } catch (e) {
      // ignore
    }
    return false;
  }

  markIgnoreCleanupMigrationDone() {
    try {
      localStorage.setItem(this._storageKeyIgnoreCleanupDone, '1');
    } catch (e) {
      // ignore
    }
  }

  clearIgnoreCleanupMigrationDone() {
    try {
      localStorage.removeItem(this._storageKeyIgnoreCleanupDone);
    } catch (e) {
      // ignore
    }
  }

  normalizeLegacyIgnoreValue(value) {
    if (value === true || value === 1) return true;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    }
    return false;
  }

  hasLegacyIgnoreMeta(line) {
    const props = line?.props;
    if (!props || typeof props !== 'object') return false;

    const direct = props?.[this._legacyIgnoreMetaKey];
    if (this.normalizeLegacyIgnoreValue(direct)) return true;

    const underscore = props?.plugin_refs_v1_ignore;
    if (this.normalizeLegacyIgnoreValue(underscore)) return true;

    const nested = props?.plugin?.refs?.v1?.ignore;
    if (this.normalizeLegacyIgnoreValue(nested)) return true;

    return false;
  }

  async runIgnoreCleanupMigrationIfNeeded() {
    if (this.hasCompletedIgnoreCleanupMigration()) return;
    if (this._ignoreCleanupPromise) return this._ignoreCleanupPromise;

    this._ignoreCleanupPromise = this.cleanupLegacyIgnoreMetadata()
      .then((result) => {
        if (result.ok === true) this.markIgnoreCleanupMigrationDone();
        return result;
      })
      .finally(() => {
        this._ignoreCleanupPromise = null;
      });

    return this._ignoreCleanupPromise;
  }

  async cleanupLegacyIgnoreMetadata() {
    const allRecords = this.data.getAllRecords?.() || [];
    let removed = 0;
    let failed = 0;
    let scanned = 0;

    for (const record of allRecords || []) {
      if (!record || typeof record.getLineItems !== 'function') continue;

      let items = [];
      try {
        items = (await record.getLineItems(false)) || [];
      } catch (e) {
        continue;
      }

      for (const line of items || []) {
        scanned += 1;
        if (!this.hasLegacyIgnoreMeta(line)) continue;

        let ok = false;
        try {
          ok = (await line.setMetaProperties({
            [this._legacyIgnoreMetaKey]: null,
            plugin_refs_v1_ignore: null
          })) === true;
        } catch (e) {
          ok = false;
        }

        if (ok) removed += 1;
        else failed += 1;
      }
    }

    if (removed > 0) {
      this.refreshAllPanels({ force: true, reason: 'legacy-ignore-cleanup' });
    }

    if (removed > 0 || failed > 0) {
      try {
        this.ui.addToaster({
          title: 'Backreferences',
          message: failed > 0
            ? `Legacy ignore cleanup removed ${removed} line item${removed === 1 ? '' : 's'}; ${failed} could not be updated.`
            : `Legacy ignore cleanup removed ${removed} line item${removed === 1 ? '' : 's'}.`,
          dismissible: true,
          autoDestroyTime: failed > 0 ? 5200 : 3200
        });
      } catch (e) {
        // ignore
      }
    }

    return { ok: failed === 0, removed, failed, scanned };
  }

  invalidateLinkedContextCache(state) {
    const map = state?.linkedContextByLine;
    if (!(map instanceof Map)) return;

    for (const ctx of map.values()) {
      if (!ctx || typeof ctx !== 'object') continue;
      ctx.loaded = false;
      ctx.loading = false;
      ctx.loadPromise = null;
      ctx.error = '';
      ctx.descendants = [];
      ctx.depthByGuid = {};
      ctx.aboveItems = [];
      ctx.belowItems = [];
    }
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

    if (!baseline || !previous) {
      state.liveBaselineSnapshot = currentSnapshot;
      state.liveCurrentSnapshot = currentSnapshot;
      state.liveNewKeys = new Set();
      state.liveRemoteBadgesByKey = new Map();
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

  syncStatusItem() {
    const item = this._statusItem || null;
    if (!item) return;

    const activePanel = this.ui.getActivePanel?.() || null;
    const panelId = activePanel?.getId?.() || null;
    const state = panelId ? (this._panelStates.get(panelId) || null) : null;
    if (!state || !state.liveCurrentSnapshot) {
      item.hide?.();
      return;
    }

    const snapshot = state.liveCurrentSnapshot;
    item.setLabel?.(`${snapshot.totalCount}`);
    item.setTooltip?.(`Backreferences: ${snapshot.totalCount} total (${snapshot.pageCount} pages, ${snapshot.propertyCount} property, ${snapshot.linkedCount} linked)`);
    item.show?.();
  }

  handleWorkspaceInvalidation(ev, reason) {
    this.markAllStatesPendingRemote(ev);
    this.refreshAllPanels({ force: false, reason: reason || 'workspace-invalidated' });
  }

  snapshotIncludesSourceRecord(state, recordGuid) {
    const guid = (recordGuid || '').trim();
    if (!guid) return false;
    return state?.liveCurrentSnapshot?.sourceRecordGuids?.has?.(guid) === true;
  }

  // ---------- Refresh orchestration ----------

  scheduleRefreshForPanel(panel, { force, reason }) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;
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

  async refreshPanel(panelId, { reason }) {
    const state = this._panelStates.get(panelId) || null;
    const panel = state?.panel || null;
    if (!state || !panel) return;

    const record = panel.getActiveRecord?.() || null;
    const recordGuid = record?.guid || null;
    if (!recordGuid) return;

    // Keep state in sync in case of churn.
    state.recordGuid = recordGuid;

    if (!state.rootEl || !state.rootEl.isConnected) {
      this.mountFooter(panel, state);
    }

    if (!state.bodyEl || !state.countEl) return;

    const seq = (state.refreshSeq || 0) + 1;
    state.refreshSeq = seq;

    this.setLoadingState(state, true);

    const cfg = this.getConfiguration?.() || {};
    const maxResults = this.coercePositiveInt(cfg.custom?.maxResults, this._defaultMaxResults);
    const showSelf = cfg.custom?.showSelf === true;

    const recordName = (record?.getName?.() || '').trim();
    const query = `@linkto = "${recordGuid}"`;

    let searchSettled;
    try {
      searchSettled = {
        status: 'fulfilled',
        value: await this.data.searchByQuery(query, maxResults)
      };
    } catch (e) {
      searchSettled = {
        status: 'rejected',
        reason: e
      };
    }

    if (!this._panelStates.has(panelId) || state.refreshSeq !== seq) return;

    let linkedError = '';
    let linkedGroups = [];
    let propertyCandidateRecords = null;
    if (searchSettled.status === 'fulfilled') {
      const result = searchSettled.value;
      if (result?.error) {
        linkedError = result.error;
      } else {
        const lines = Array.isArray(result?.lines) ? result.lines : [];
        propertyCandidateRecords = Array.isArray(result?.records) ? result.records : null;
        linkedGroups = this.groupBacklinkLines(lines, recordGuid, { showSelf });
      }
    } else {
      linkedError = 'Error loading linked references.';
    }

    const shouldLoadUnlinked = Boolean(recordName) && !this.isSectionCollapsed(state, 'unlinked');
    const followupPromises = [
      this.getPropertyBacklinkGroups(record, recordGuid, {
        showSelf,
        candidateRecords: propertyCandidateRecords
      })
    ];
    if (shouldLoadUnlinked) {
      followupPromises.push(this.data.searchByQuery(recordName, maxResults));
    }
    const [propertySettled, unlinkedSettled] = await Promise.allSettled(followupPromises);

    if (!this._panelStates.has(panelId) || state.refreshSeq !== seq) return;

    let propertyError = '';
    let propertyGroups = [];
    if (propertySettled.status === 'fulfilled') {
      propertyGroups = Array.isArray(propertySettled.value) ? propertySettled.value : [];
    } else {
      propertyError = 'Error loading property references.';
    }

    let unlinkedError = '';
    let unlinkedGroups = [];
    const unlinkedDeferred = Boolean(recordName) && !shouldLoadUnlinked;
    if (recordName && shouldLoadUnlinked) {
      if (unlinkedSettled.status === 'fulfilled') {
        const result = unlinkedSettled.value;
        if (result?.error) {
          unlinkedError = result.error;
        } else {
          const lines = Array.isArray(result?.lines) ? result.lines : [];
          unlinkedGroups = this.groupUnlinkedReferenceLines(lines, linkedGroups, recordGuid, recordName, { showSelf });
        }
      } else {
        unlinkedError = 'Error loading unlinked references.';
      }
    }

    if (!this._panelStates.has(panelId) || state.refreshSeq !== seq) return;

    state.filterMetaLoading = false;
    this.syncFilterControlState(state);

    state.lastResults = {
      propertyGroups,
      propertyError,
      linkedGroups,
      linkedError,
      unlinkedGroups,
      unlinkedError,
      unlinkedDeferred,
      unlinkedLoading: false,
      maxResults
    };
    this.syncScopedQueryWithCurrentInput(state, { immediate: true, reason: reason || 'refresh' });
    this.applyLiveSnapshot(state, this.buildResultsSnapshot(propertyGroups, linkedGroups));
    this.invalidateLinkedContextCache(state);
    this.renderFromCache(state);
    if (state.lastResults?.unlinkedDeferred === true && !this.isSectionCollapsed(state, 'unlinked')) {
      this.ensureDeferredUnlinkedLoaded(state).catch(() => {
        // ignore
      });
    }
    this.setLoadingState(state, false);
    this.syncStatusItem();
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

    const cfg = this.getConfiguration?.() || {};
    const maxResults = this.coercePositiveInt(cfg.custom?.maxResults, this._defaultMaxResults);
    const showSelf = cfg.custom?.showSelf === true;

    let nextGroups = [];
    let nextError = '';
    try {
      const result = await this.data.searchByQuery(recordName, maxResults);
      if (result?.error) {
        nextError = result.error;
      } else {
        const lines = Array.isArray(result?.lines) ? result.lines : [];
        nextGroups = this.groupUnlinkedReferenceLines(
          lines,
          Array.isArray(results.linkedGroups) ? results.linkedGroups : [],
          recordGuid,
          recordName,
          { showSelf }
        );
      }
    } catch (e) {
      nextError = 'Error loading unlinked references.';
    }

    if (!this._panelStates.has(state.panelId)) return;
    if (state.lastResults !== results) return;
    if (state.refreshSeq !== seq) return;
    if ((state.recordGuid || '') !== recordGuid) return;

    state.filterMetaLoading = false;
    this.syncFilterControlState(state);

    results.unlinkedGroups = nextGroups;
    results.unlinkedError = nextError;
    results.unlinkedDeferred = false;
    results.unlinkedLoading = false;
    this.syncScopedQueryWithCurrentInput(state, { immediate: true, reason: 'deferred-unlinked-loaded' });
    this.renderFromCache(state);
    this.syncStatusItem();
  }

  setLoadingState(state, isLoading) {
    if (!state?.rootEl) return;
    state.isLoading = isLoading === true;
    state.rootEl.classList.toggle('tlr-loading', isLoading === true);
  }

  // ---------- Event-driven freshness ----------

  handleRecordUpdated(ev) {
    // Property-based references (record-link fields) do not emit lineitem events.
    // Refresh footers when key-value properties change so property backlinks stay fresh.
    if (!ev) return;
    if (!ev.properties) return;
    this.invalidateRecordCollectionGuid(ev.recordGuid || null);
    this.handleWorkspaceInvalidation(ev, 'record.updated');
  }

  handleRecordCreated(ev) {
    this.invalidateRecordCollectionGuid(ev?.recordGuid || null);
    this.handleWorkspaceInvalidation(ev, 'record.created');
  }

  handleRecordMoved(ev) {
    this.invalidateRecordCollectionGuid(ev?.recordGuid || null);
    this.handleWorkspaceInvalidation(ev, 'record.moved');
  }

  handleLineItemUpdated(ev) {
    if (!ev) return;

    const segments = ev?.hasSegments?.() && typeof ev.getSegments === 'function'
      ? (ev.getSegments() || [])
      : [];
    const referenced = this.extractReferencedRecordGuids(segments);

    for (const state of this._panelStates.values()) {
      const panel = state?.panel || null;
      if (!panel) continue;
      if (!state.recordGuid) continue;

      const hitsTargetRecord = referenced.has(state.recordGuid);
      const hitsKnownSource = this.snapshotIncludesSourceRecord(state, ev.recordGuid || null);
      if (!hitsTargetRecord && !hitsKnownSource) continue;

      this.markStatePendingRemote(state, ev);
      this.scheduleRefreshForPanel(panel, { force: false, reason: 'lineitem.updated' });
    }
  }

  handleLineItemCreated(ev) {
    this.handleWorkspaceInvalidation(ev, 'lineitem.created');
  }

  handleLineItemMoved(ev) {
    this.handleWorkspaceInvalidation(ev, 'lineitem.moved');
  }

  handleLineItemUndeleted(ev) {
    this.handleWorkspaceInvalidation(ev, 'lineitem.undeleted');
  }

  handleLineItemDeleted(ev) {
    // We don't know which record(s) were referenced by the deleted item.
    // This is rare, so we just refresh all visible footers (debounced).
    this.handleWorkspaceInvalidation(ev, 'lineitem.deleted');
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

  findLinkedLineByGuid(state, lineGuid) {
    const target = (lineGuid || '').trim();
    if (!target || !state?.lastResults) return null;
    const groups = Array.isArray(state.lastResults?.linkedGroups) ? state.lastResults.linkedGroups : [];

    for (const g of groups) {
      for (const line of g?.lines || []) {
        if ((line?.guid || '') === target) return line;
      }
    }

    return null;
  }

  async collectDescendantContext(line) {
    const descendants = [];
    const depthByGuid = {};
    const seen = new Set();

    const walk = async (items, depth) => {
      for (const item of items || []) {
        const guid = item?.guid || null;
        if (!guid) continue;
        if (seen.has(guid)) continue;
        seen.add(guid);
        descendants.push(item);
        depthByGuid[guid] = depth;
        let children = [];
        try {
          children = (await item.getChildren()) || [];
        } catch (e) {
          children = Array.isArray(item?.children) ? item.children : [];
        }
        await walk(children, depth + 1);
      }
    };

    let rootChildren = [];
    try {
      rootChildren = (await line.getChildren()) || [];
    } catch (e) {
      rootChildren = Array.isArray(line?.children) ? line.children : [];
    }

    await walk(rootChildren, 1);
    return { descendants, depthByGuid };
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

  async ensureLinkedContextLoaded(state, line) {
    const ctx = this.getLinkedContextState(state, line?.guid || null);
    if (!ctx || !line) return null;
    if (ctx.loaded === true) return ctx;
    if (ctx.loading === true && ctx.loadPromise) return ctx.loadPromise;

    ctx.loading = true;
    ctx.error = '';
    this.renderFromCache(state);

    ctx.loadPromise = (async () => {
      await line.getTreeContext();
      const descendantContext = await this.collectDescendantContext(line);

      const record = line.getRecord?.() || null;
      const allItems = record && typeof record.getLineItems === 'function'
        ? ((await record.getLineItems(false)) || [])
        : [];
      const orderedItems = this.buildRecordDocumentOrder(record, allItems);
      const contextItems = orderedItems.length > 0 ? orderedItems : allItems;
      const matchedGuid = line?.guid || '';
      const matchedIndex = contextItems.findIndex((item) => (item?.guid || '') === matchedGuid);
      const aboveItems = [];
      const belowItems = [];

      if (matchedIndex >= 0) {
        let subtreeEndIndex = matchedIndex;
        const descendantGuids = new Set(
          (descendantContext.descendants || [])
            .map((item) => item?.guid || '')
            .filter(Boolean)
        );

        for (let i = matchedIndex + 1; i < contextItems.length; i += 1) {
          const guid = contextItems[i]?.guid || '';
          if (!guid || !descendantGuids.has(guid)) continue;
          subtreeEndIndex = i;
        }

        aboveItems.push(...contextItems.slice(0, matchedIndex));
        belowItems.push(...contextItems.slice(subtreeEndIndex + 1));
      }

      ctx.descendants = descendantContext.descendants;
      ctx.depthByGuid = descendantContext.depthByGuid;
      ctx.aboveItems = aboveItems;
      ctx.belowItems = belowItems;
      ctx.loaded = true;

      const availableAbove = this.getAvailableAboveContextCount(ctx);
      const availableBelow = this.getAvailableBelowContextCount(ctx);
      ctx.siblingAboveCount = Math.max(0, Math.min(ctx.siblingAboveCount || 0, availableAbove || 0));
      ctx.siblingBelowCount = Math.max(0, Math.min(ctx.siblingBelowCount || 0, availableBelow || 0));
      return ctx;
    })()
      .catch(() => {
        ctx.error = 'Could not load line context.';
        ctx.loaded = false;
        return null;
      })
      .finally(() => {
        ctx.loading = false;
        ctx.loadPromise = null;
        this.renderFromCache(state);
      });

    return ctx.loadPromise;
  }

  async handleLinkedContextAction(state, action, lineGuid) {
    const line = this.findLinkedLineByGuid(state, lineGuid);
    if (!line) return;

    const ctx = this.getLinkedContextState(state, lineGuid);
    if (!ctx) return;

    if (action === 'toggle-context-more') {
      if (ctx.showMoreContext === true) {
        this.resetLinkedContextState(ctx);
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

  invalidateRecordCollectionGuid(recordGuid) {
    const guid = (recordGuid || '').trim();
    if (!guid) return;
    this._recordCollectionGuidCache?.delete?.(guid);
    this._recordCollectionGuidPending?.delete?.(guid);
  }

  getActiveCollectionGuid(state) {
    const panel = state?.panel || null;
    const collection = panel?.getActiveCollection?.() || null;
    const guid = typeof collection?.guid === 'string' ? collection.guid.trim() : '';
    return guid || null;
  }

  getKnownRecordCollectionGuid(record) {
    const guid = (record?.guid || '').trim();
    if (!guid) return null;

    if (this._recordCollectionGuidCache?.has?.(guid)) {
      const cached = this._recordCollectionGuidCache.get(guid);
      if (typeof cached === 'string' && cached.trim()) return cached.trim();
      return null;
    }

    const direct = this.readRecordCollectionGuidFast(record);
    if (direct) {
      this._recordCollectionGuidCache?.set?.(guid, direct);
      return direct;
    }

    return null;
  }

  readRecordCollectionGuidFast(record) {
    if (!record) return null;

    const directFields = [
      record?.collectionGuid,
      record?.collection_guid,
      record?.collection?.guid,
      record?.collection?.collectionGuid,
      record?.collection?.collection_guid
    ];

    for (const value of directFields) {
      const guid = typeof value === 'string' ? value.trim() : '';
      if (guid) return guid;
    }

    try {
      const collection = record.getCollection?.() || null;
      const guid = typeof collection?.guid === 'string' ? collection.guid.trim() : '';
      if (guid) return guid;
    } catch (e) {
      // ignore
    }

    return null;
  }

  parseFrontmatterValue(markdown, key) {
    const source = typeof markdown === 'string' ? markdown : '';
    const targetKey = typeof key === 'string' ? key.trim() : '';
    if (!source || !targetKey) return null;

    const match = source.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return null;

    const lines = match[1].split(/\r?\n/);
    for (const line of lines) {
      const m = line.match(/^([^:]+):\s*(.*)$/);
      if (!m) continue;
      if ((m[1] || '').trim() !== targetKey) continue;
      const raw = (m[2] || '').trim();
      return raw.replace(/^"|"$/g, '').trim() || null;
    }

    return null;
  }

  async ensureRecordCollectionGuid(record) {
    const guid = (record?.guid || '').trim();
    if (!guid) return null;

    const known = this.getKnownRecordCollectionGuid(record);
    if (known) return known;

    const pending = this._recordCollectionGuidPending?.get?.(guid) || null;
    if (pending) return pending;

    const loadPromise = (async () => {
      let collectionGuid = null;
      try {
        const markdown = await record.getAsMarkdown?.({ experimental: true });
        collectionGuid = this.parseFrontmatterValue(markdown?.content || '', 'collection_guid');
      } catch (e) {
        collectionGuid = null;
      }

      this._recordCollectionGuidCache?.set?.(guid, collectionGuid || '');
      this._recordCollectionGuidPending?.delete?.(guid);
      return collectionGuid;
    })();

    this._recordCollectionGuidPending?.set?.(guid, loadPromise);
    return loadPromise;
  }

  collectSourceRecordsFromResults(results) {
    const out = [];
    const seen = new Set();

    const add = (record) => {
      const guid = (record?.guid || '').trim();
      if (!guid || seen.has(guid)) return;
      seen.add(guid);
      out.push(record);
    };

    for (const group of results?.propertyGroups || []) {
      for (const record of group?.records || []) add(record);
    }
    for (const group of results?.linkedGroups || []) add(group?.record || null);
    for (const group of results?.unlinkedGroups || []) add(group?.record || null);

    return out;
  }

  async ensureCollectionMetaForResults(state, results) {
    if (!this.filterPresetNeedsCollectionMeta(state?.filterPreset)) return;

    const records = this.collectSourceRecordsFromResults(results);
    if (records.length === 0) return;

    await Promise.all(records.map((record) => this.ensureRecordCollectionGuid(record)));
  }

  // ---------- Grouping + rendering ----------

  async getPropertyBacklinkGroups(targetRecord, targetGuid, { showSelf, candidateRecords }) {
    if (!targetGuid) return [];

    const indexedCandidates = Array.isArray(candidateRecords)
      ? candidateRecords
      : [];
    if (indexedCandidates.length > 0) {
      const groups = this.buildPropertyBacklinkGroupsFromRecords(indexedCandidates, targetGuid, { showSelf });
      if (groups.length > 0) return groups;
    }

    try {
      const backrefRecords = await targetRecord?.getBackReferenceRecords?.();
      if (Array.isArray(backrefRecords) && backrefRecords.length > 0) {
        const groups = this.buildPropertyBacklinkGroupsFromRecords(backrefRecords, targetGuid, { showSelf });
        if (groups.length > 0) return groups;
      }
    } catch (e) {
      // ignore and continue to the full scan fallback
    }

    return this.buildPropertyBacklinkGroupsFromRecords(this.data.getAllRecords?.() || [], targetGuid, { showSelf });
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
    return false;
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

      if ('value' in raw) {
        this.collectPropertyCandidateValues(raw.value, push);
      }

      if (Array.isArray(raw.records)) {
        this.collectPropertyCandidateValues(raw.records, push);
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
      if ((seg?.text?.guid || '') === targetGuid) return true;
    }
    return false;
  }

  lineHasTextMentionOfRecord(line, recordName) {
    const matcher = this.buildPhraseBoundaryMatcher(recordName);
    if (!matcher) return false;
    const text = this.getLineTextMentionSource(line);
    if (!text) return false;
    return matcher.test(text);
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

  buildPhraseBoundaryMatcher(phrase) {
    const trimmed = typeof phrase === 'string' ? phrase.trim() : '';
    if (!trimmed) return null;

    const parts = trimmed.split(/\s+/).filter(Boolean).map((part) => this.escapeRegExp(part));
    if (parts.length === 0) return null;

    return new RegExp(`(^|[^a-z0-9])${parts.join('\\s+')}(?=$|[^a-z0-9])`, 'i');
  }

  escapeRegExp(value) {
    return String(value || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  lineHasMention(line) {
    for (const seg of line?.segments || []) {
      if (seg?.type === 'mention') return true;
    }
    return false;
  }

  isJournalRecord(record) {
    try {
      return Boolean(record?.getJournalDetails?.());
    } catch (e) {
      return false;
    }
  }

  recordIsInActiveCollection(state, record) {
    const activeCollectionGuid = this.getActiveCollectionGuid(state);
    if (!activeCollectionGuid) return false;
    return this.getKnownRecordCollectionGuid(record) === activeCollectionGuid;
  }

  filterPropertyGroups(groups, predicate) {
    const out = [];
    for (const group of groups || []) {
      const propertyName = (group?.propertyName || '').trim();
      if (!propertyName) continue;
      const records = (group?.records || []).filter((record) => predicate(record, group));
      if (records.length === 0) continue;
      out.push({ propertyName, records });
    }
    return out;
  }

  filterLineGroups(groups, predicate) {
    const out = [];
    for (const group of groups || []) {
      const record = group?.record || null;
      if (!record?.guid) continue;
      const lines = (group?.lines || []).filter((line) => predicate(line, record, group));
      if (lines.length === 0) continue;
      out.push({ record, lines });
    }
    return out;
  }

  applyPresetFilter(state, { propertyGroups, linkedGroups, unlinkedGroups }) {
    const filterPreset = this.normalizeFilterPreset(state?.filterPreset) || this._defaultFilterPreset;
    if (filterPreset === this._defaultFilterPreset) {
      return {
        filterPreset,
        propertyGroups: Array.isArray(propertyGroups) ? propertyGroups : [],
        linkedGroups: Array.isArray(linkedGroups) ? linkedGroups : [],
        unlinkedGroups: Array.isArray(unlinkedGroups) ? unlinkedGroups : []
      };
    }

    const propsAll = Array.isArray(propertyGroups) ? propertyGroups : [];
    const linkedAll = Array.isArray(linkedGroups) ? linkedGroups : [];
    const unlinkedAll = Array.isArray(unlinkedGroups) ? unlinkedGroups : [];

    let propertyOut = propsAll;
    let linkedOut = linkedAll;
    let unlinkedOut = unlinkedAll;

    if (filterPreset === 'tasks') {
      propertyOut = [];
      linkedOut = this.filterLineGroups(linkedAll, (line) => line?.type === 'task');
      unlinkedOut = this.filterLineGroups(unlinkedAll, (line) => line?.type === 'task');
    } else if (filterPreset === 'recent') {
      const cutoff = Date.now() - this._recentActivityWindowMs;
      propertyOut = this.filterPropertyGroups(propsAll, (record) => this.getRecordUpdatedTimestamp(record) >= cutoff);
      linkedOut = this.filterLineGroups(linkedAll, (line) => this.getLineActivityTimestamp(line) >= cutoff);
      unlinkedOut = this.filterLineGroups(unlinkedAll, (line) => this.getLineActivityTimestamp(line) >= cutoff);
    } else if (filterPreset === 'same_collection') {
      propertyOut = this.filterPropertyGroups(propsAll, (record) => this.recordIsInActiveCollection(state, record));
      linkedOut = this.filterLineGroups(linkedAll, (_line, record) => this.recordIsInActiveCollection(state, record));
      unlinkedOut = this.filterLineGroups(unlinkedAll, (_line, record) => this.recordIsInActiveCollection(state, record));
    } else if (filterPreset === 'mentions') {
      propertyOut = [];
      linkedOut = this.filterLineGroups(linkedAll, (line) => this.lineHasMention(line));
      unlinkedOut = this.filterLineGroups(unlinkedAll, (line) => this.lineHasMention(line));
    } else if (filterPreset === 'journal') {
      propertyOut = this.filterPropertyGroups(propsAll, (record) => this.isJournalRecord(record));
      linkedOut = this.filterLineGroups(linkedAll, (_line, record) => this.isJournalRecord(record));
      unlinkedOut = this.filterLineGroups(unlinkedAll, (_line, record) => this.isJournalRecord(record));
    }

    return {
      filterPreset,
      propertyGroups: propertyOut,
      linkedGroups: linkedOut,
      unlinkedGroups: unlinkedOut
    };
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

  renderReferences(state, {
    propertyGroups,
    propertyError,
    linkedGroups,
    linkedError,
    unlinkedGroups,
    unlinkedError,
    unlinkedDeferred,
    unlinkedLoading,
    maxResults
  }) {
    if (!state?.bodyEl || !state?.countEl) return;

    const body = state.bodyEl;
    body.innerHTML = '';

    const query = (state.searchQuery || '').trim();
    const searchMode = this.getSearchMode(query);
    const textQueryLower = searchMode === 'text' ? query.toLowerCase() : '';
    const queryFilterState = searchMode === 'query' ? this.getQueryFilterState(state, query) : null;
    const canApplyScopedQuery = searchMode === 'query' && queryFilterState?.ready === true;
    const shouldScopeUnlinked = searchMode === 'query'
      ? this.shouldIncludeUnlinkedInQueryScope(state, state.lastResults || {})
      : true;
    const highlightQuery = searchMode === 'text' ? query : '';

    const propsAll = Array.isArray(propertyGroups) ? propertyGroups : [];
    const linkedAll = Array.isArray(linkedGroups) ? linkedGroups : [];
    const unlinkedAll = Array.isArray(unlinkedGroups) ? unlinkedGroups : [];

    const totalPropRefCount = propsAll.reduce((n, g) => n + (g?.records?.length || 0), 0);
    const totalLinkedRefCount = this.countLinkedReferences(linkedAll);
    const totalUnlinkedRefCount = this.countLinkedReferences(unlinkedAll);
    const hasAnyErrors = Boolean(propertyError || linkedError || unlinkedError);
    const isEmptyWithoutFilter = !hasAnyErrors
      && totalPropRefCount === 0
      && totalLinkedRefCount === 0
      && totalUnlinkedRefCount === 0;
    const useCompactEmpty = isEmptyWithoutFilter
      && searchMode === 'none'
      && state.emptyStateExpanded !== true
      && unlinkedDeferred !== true;

    if (useCompactEmpty) {
      state.rootEl?.classList?.add('tlr-empty-compact');
      this.setFilterMenuOpen(state, false);
      this.setSortMenuOpen(state, false);
      state.countEl.textContent = 'No references yet';
      this.appendCompactEmptyState(body);
      return;
    }

    state.rootEl?.classList?.remove('tlr-empty-compact');

    const totalUniquePages = new Set();
    for (const g of propsAll) {
      for (const r of g?.records || []) {
        const guid = r?.guid || null;
        if (guid) totalUniquePages.add(guid);
      }
    }
    for (const g of linkedAll) {
      const guid = g?.record?.guid || null;
      if (guid) totalUniquePages.add(guid);
    }
    for (const g of unlinkedAll) {
      const guid = g?.record?.guid || null;
      if (guid) totalUniquePages.add(guid);
    }

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
      const nextProps = [];
      for (const g of props) {
        const propertyName = (g?.propertyName || '').trim();
        if (!propertyName) continue;
        const recs = (g?.records || []).filter((r) => {
          const name = (r?.getName?.() || '').toLowerCase();
          return name.includes(textQueryLower);
        });
        if (recs.length > 0) nextProps.push({ propertyName, records: recs });
      }
      props = nextProps;

      const nextLinked = [];
      for (const g of linked) {
        const record = g?.record || null;
        const recordGuid = record?.guid || null;
        if (!recordGuid) continue;
        const lines = (g?.lines || []).filter((line) => {
          const text = this.segmentsToPlainText(line?.segments || []);
          return text.toLowerCase().includes(textQueryLower);
        });
        if (lines.length > 0) nextLinked.push({ record, lines });
      }
      linked = nextLinked;

      const nextUnlinked = [];
      for (const g of unlinked) {
        const record = g?.record || null;
        const recordGuid = record?.guid || null;
        if (!recordGuid) continue;
        const lines = (g?.lines || []).filter((line) => {
          const text = this.segmentsToPlainText(line?.segments || []);
          return text.toLowerCase().includes(textQueryLower);
        });
        if (lines.length > 0) nextUnlinked.push({ record, lines });
      }
      unlinked = nextUnlinked;
    }

    const filteredPropRefCount = props.reduce((n, g) => n + (g?.records?.length || 0), 0);
    const filteredLinkedRefCount = this.countLinkedReferences(linked);
    const filteredUnlinkedRefCount = this.countLinkedReferences(unlinked);
    const hasScopedView = (searchMode === 'text' && Boolean(textQueryLower)) || (searchMode === 'query' && canApplyScopedQuery);
    const showUnlinkedCounts = searchMode !== 'query' || shouldScopeUnlinked;

    const filteredUniquePages = new Set();
    for (const g of props) {
      for (const r of g?.records || []) {
        const guid = r?.guid || null;
        if (guid) filteredUniquePages.add(guid);
      }
    }
    for (const g of linked) {
      const guid = g?.record?.guid || null;
      if (guid) filteredUniquePages.add(guid);
    }
    for (const g of unlinked) {
      const guid = g?.record?.guid || null;
      if (guid) filteredUniquePages.add(guid);
    }

    const sortSpec = {
      sortBy: this.normalizeSortBy(state?.sortBy) || this._defaultSortBy,
      sortDir: this.normalizeSortDir(state?.sortDir) || this._defaultSortDir
    };
    const sortMetrics = this.computeRecordSortMetrics(props, [...linked, ...unlinked]);
    props = this.sortPropertyGroupsForRender(props, sortSpec, sortMetrics);
    linked = this.sortLinkedGroupsForRender(linked, sortSpec, sortMetrics);
    unlinked = this.sortLinkedGroupsForRender(unlinked, sortSpec, sortMetrics);

    const parts = [];
    if (searchMode === 'query') {
      if (query) {
        const shortQuery = query.length > 24 ? `${query.slice(0, 24)}...` : query;
        parts.push(`Query: "${shortQuery}"`);
      }
      if (queryFilterState?.error) {
        parts.push('Invalid query');
      } else if (queryFilterState?.loading === true && canApplyScopedQuery !== true) {
        parts.push('Applying...');
      }

      if (canApplyScopedQuery) {
        if (totalUniquePages.size > 0) parts.push(`${filteredUniquePages.size}/${totalUniquePages.size} pages`);
        if (totalPropRefCount > 0) parts.push(`${filteredPropRefCount}/${totalPropRefCount} prop refs`);
        if (totalLinkedRefCount > 0) parts.push(`${filteredLinkedRefCount}/${totalLinkedRefCount} line refs`);
        if (showUnlinkedCounts && totalUnlinkedRefCount > 0) parts.push(`${filteredUnlinkedRefCount}/${totalUnlinkedRefCount} unlinked refs`);
      } else {
        if (totalUniquePages.size > 0) parts.push(`${totalUniquePages.size} pages`);
        if (totalPropRefCount > 0) parts.push(`${totalPropRefCount} prop refs`);
        if (totalLinkedRefCount > 0) parts.push(`${totalLinkedRefCount} line refs`);
        if (showUnlinkedCounts && totalUnlinkedRefCount > 0) parts.push(`${totalUnlinkedRefCount} unlinked refs`);
      }
    } else if (hasScopedView) {
      if (textQueryLower) {
        const shortQuery = query.length > 24 ? `${query.slice(0, 24)}...` : query;
        parts.push(`Search: "${shortQuery}"`);
      }
      if (totalUniquePages.size > 0) parts.push(`${filteredUniquePages.size}/${totalUniquePages.size} pages`);
      if (totalPropRefCount > 0) parts.push(`${filteredPropRefCount}/${totalPropRefCount} prop refs`);
      if (totalLinkedRefCount > 0) parts.push(`${filteredLinkedRefCount}/${totalLinkedRefCount} line refs`);
      if (totalUnlinkedRefCount > 0) parts.push(`${filteredUnlinkedRefCount}/${totalUnlinkedRefCount} unlinked refs`);
    } else {
      if (totalUniquePages.size > 0) parts.push(`${totalUniquePages.size} page${totalUniquePages.size === 1 ? '' : 's'}`);
      if (totalPropRefCount > 0) parts.push(`${totalPropRefCount} prop ref${totalPropRefCount === 1 ? '' : 's'}`);
      if (totalLinkedRefCount > 0) parts.push(`${totalLinkedRefCount} line ref${totalLinkedRefCount === 1 ? '' : 's'}`);
      if (totalUnlinkedRefCount > 0) parts.push(`${totalUnlinkedRefCount} unlinked ref${totalUnlinkedRefCount === 1 ? '' : 's'}`);
    }
    state.countEl.textContent = parts.join(' | ');

    if (searchMode === 'query' && queryFilterState?.error) {
      this.appendError(body, queryFilterState.error);
    } else if (searchMode === 'query' && queryFilterState?.loading === true) {
      this.appendNote(body, canApplyScopedQuery ? 'Refreshing query results...' : 'Applying query to current backreferences...');
    }

    const propertySection = this.appendCollapsibleSection(body, state, {
      sectionId: 'property',
      title: 'Property References'
    });
    if (propertyError) {
      this.appendError(propertySection.bodyEl, propertyError);
    } else if (props.length === 0) {
      this.appendEmpty(propertySection.bodyEl, hasScopedView ? 'No matching property references.' : 'No property references.');
    } else {
      this.appendPropertyReferenceGroups(propertySection.bodyEl, props, { query: highlightQuery, state });
    }

    const divider = document.createElement('div');
    divider.className = 'tlr-divider';
    body.appendChild(divider);
    const linkedSection = this.appendCollapsibleSection(body, state, {
      sectionId: 'linked',
      title: 'Linked References'
    });

    if (linkedError) {
      this.appendError(linkedSection.bodyEl, linkedError);
    } else {
      this.appendLinkedReferenceGroups(linkedSection.bodyEl, linked, {
        state,
        maxResults,
        query: highlightQuery,
        totalLineCount: totalLinkedRefCount,
        emptyMessage: hasScopedView ? 'No matching linked references.' : 'No linked references.'
      });
    }

    const unlinkedDivider = document.createElement('div');
    unlinkedDivider.className = 'tlr-divider';
    body.appendChild(unlinkedDivider);
    const unlinkedSection = this.appendCollapsibleSection(body, state, {
      sectionId: 'unlinked',
      title: 'Unlinked References'
    });

    if (unlinkedLoading) {
      this.appendNote(unlinkedSection.bodyEl, 'Loading unlinked references...');
      return;
    }

    if (unlinkedError) {
      this.appendError(unlinkedSection.bodyEl, unlinkedError);
      return;
    }

    if (unlinkedDeferred) {
      if (!this.isSectionCollapsed(state, 'unlinked')) {
        this.appendNote(unlinkedSection.bodyEl, 'Loading unlinked references...');
      }
      return;
    }

    this.appendLinkedReferenceGroups(unlinkedSection.bodyEl, unlinked, {
      state,
      maxResults,
      query: highlightQuery,
      totalLineCount: totalUnlinkedRefCount,
      emptyMessage: hasScopedView ? 'No matching unlinked references.' : 'No unlinked references.'
    });
  }

  appendCollapsibleSection(container, state, { sectionId, title }) {
    if (!container) return;

    const id = this.normalizeSectionId(sectionId) || 'property';
    const collapsed = this.isSectionCollapsed(state, id);

    const sectionEl = document.createElement('div');
    sectionEl.className = 'tlr-section';
    if (collapsed) sectionEl.classList.add('tlr-section-collapsed');

    const headerEl = document.createElement('div');
    headerEl.className = 'tlr-section-header';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'tlr-btn tlr-section-toggle button-none button-small button-minimal-hover';
    toggleBtn.dataset.action = 'toggle-section';
    toggleBtn.dataset.sectionId = id;
    toggleBtn.title = 'Collapse/expand';
    toggleBtn.setAttribute('aria-expanded', collapsed ? 'false' : 'true');
    toggleBtn.textContent = collapsed ? '+' : '-';

    const titleEl = document.createElement('div');
    titleEl.className = 'tlr-section-title text-details';
    titleEl.textContent = title || '';

    const bodyEl = document.createElement('div');
    bodyEl.className = 'tlr-section-body';

    headerEl.appendChild(toggleBtn);
    headerEl.appendChild(titleEl);
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

  appendCompactEmptyState(container) {
    if (!container) return;

    const field = document.createElement('div');
    field.className = 'tlr-empty-compact-card form-field';

    const row = document.createElement('div');
    row.className = 'tlr-empty-compact-row form-field-row';

    const summary = document.createElement('div');
    summary.className = 'tlr-empty-compact-copy text-details';
    summary.textContent = 'No references yet.';

    const expandBtn = document.createElement('button');
    expandBtn.type = 'button';
    expandBtn.className = 'tlr-empty-compact-btn button-none button-small button-minimal-hover';
    expandBtn.dataset.action = 'expand-empty';
    expandBtn.textContent = 'Show sections';

    row.appendChild(summary);
    row.appendChild(expandBtn);
    field.appendChild(row);
    container.appendChild(field);
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

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'tlr-prop-header button-normal button-normal-hover';
      header.dataset.action = 'toggle-prop-group';
      header.dataset.propName = propName;
      header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

      const caret = document.createElement('span');
      caret.className = 'tlr-prop-caret';
      caret.setAttribute('aria-hidden', 'true');

      const title = document.createElement('div');
      title.className = 'tlr-prop-title';
      title.textContent = `${propName} in...`;

      const meta = document.createElement('div');
      meta.className = 'tlr-prop-meta text-details';
      meta.textContent = `${g?.records?.length || 0}`;

      header.appendChild(caret);
      header.appendChild(title);
      header.appendChild(meta);

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

      groupEl.appendChild(header);
      groupEl.appendChild(recsEl);
      container.appendChild(groupEl);
    }
  }

  appendLinkedReferenceGroups(container, groups, opts) {
    if (!container) return;

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

      const groupEl = document.createElement('div');
      groupEl.className = 'tlr-group';

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
      meta.textContent = `${(g.lines || []).length}`;

      header.appendChild(title);
      header.appendChild(meta);

      const linesEl = document.createElement('div');
      linesEl.className = 'tlr-lines';

      for (const line of g.lines || []) {
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
          mainRowEl.appendChild(this.buildLinkedContextControls(line.guid, ctx));

          if (ctx.loading === true) {
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

      groupEl.appendChild(header);
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

  buildLinkedContextControls(lineGuid, ctx) {
    const controls = document.createElement('div');
    controls.className = 'tlr-line-actions text-details';

    const group = document.createElement('div');
    group.className = 'tlr-line-actions-group';

    if (ctx?.showMoreContext === true) {
      group.appendChild(this.buildLinkedContextButton('toggle-context-above', lineGuid, {
        icon: 'up',
        label: this.getAboveToggleLabel(ctx),
        disabled: ctx?.loaded === true && this.getAvailableAboveContextCount(ctx) === 0,
        active: (ctx?.siblingAboveCount || 0) > 0
      }));
      group.appendChild(this.buildLinkedContextButton('toggle-context-below', lineGuid, {
        icon: 'down',
        label: this.getBelowToggleLabel(ctx),
        disabled: ctx?.loaded === true && this.getAvailableBelowContextCount(ctx) === 0,
        active: (ctx?.siblingBelowCount || 0) > 0
      }));
    }

    group.appendChild(this.buildLinkedContextButton('toggle-context-more', lineGuid, {
      icon: 'toggle',
      label: ctx?.showMoreContext === true ? 'Hide context' : 'Show more context',
      disabled: ctx?.showMoreContext !== true && ctx?.loaded === true && !this.hasAnyLinkedContext(ctx),
      active: ctx?.showMoreContext === true
    }));

    controls.appendChild(group);
    return controls;
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
    this.appendSegments(content, line?.segments || [], query);
    container.appendChild(content);
  }

  appendLinkedContextRows(container, recordGuid, ctx, query, position) {
    if (!container || !ctx || ctx.loaded !== true) return;

    const items = [];
    if (position === 'top') {
      for (const line of this.getVisibleAboveContextItems(ctx)) {
        items.push({ line, indent: 0 });
      }
    } else {
      if (ctx.showMoreContext === true) {
        for (const line of ctx.descendants || []) {
          items.push({
            line,
            indent: Number(ctx.depthByGuid?.[line?.guid] || 1)
          });
        }
      }

      for (const line of this.getVisibleBelowContextItems(ctx)) {
        items.push({ line, indent: 0 });
      }
    }

    if (items.length === 0) return;

    const list = document.createElement('div');
    list.className = `tlr-context-list tlr-context-list-${position}`;

    for (const item of items) {
      const line = item.line || null;
      const guid = line?.guid || null;
      if (!guid) continue;

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

  segmentsToPlainText(segments) {
    if (!Array.isArray(segments) || segments.length === 0) return '';

    let out = '';
    for (const seg of segments) {
      if (!seg) continue;

      if (seg.type === 'text' || seg.type === 'bold' || seg.type === 'italic' || seg.type === 'code' || seg.type === 'link') {
        if (typeof seg.text === 'string') out += seg.text;
        continue;
      }

      if (seg.type === 'linkobj') {
        const link = seg.text?.link || '';
        const title = seg.text?.title || link;
        out += title;
        continue;
      }

      if (seg.type === 'hashtag') {
        const t = typeof seg.text === 'string' ? seg.text : '';
        if (!t) continue;
        out += t.startsWith('#') ? t : `#${t}`;
        continue;
      }

      if (seg.type === 'datetime') {
        out += this.formatDateTimeSegment(seg.text);
        continue;
      }

      if (seg.type === 'mention') {
        const guid = typeof seg.text === 'string' ? seg.text : '';
        out += this.formatMention(guid);
        continue;
      }

      if (seg.type === 'ref') {
        const guid = seg.text?.guid || null;
        const title = seg.text?.title || (guid ? this.resolveRecordName(guid) : '') || '';
        out += title;
        continue;
      }

      if (typeof seg.text === 'string') {
        out += seg.text;
      }
    }

    return out;
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

      if (seg.type === 'text') {
        this.appendHighlightedText(container, typeof seg.text === 'string' ? seg.text : '', query);
        continue;
      }

      if (seg.type === 'bold' || seg.type === 'italic' || seg.type === 'code') {
        const el = document.createElement('span');
        el.className = seg.type === 'bold' ? 'tlr-seg-bold' : seg.type === 'italic' ? 'tlr-seg-italic' : 'tlr-seg-code';
        el.textContent = '';
        this.appendHighlightedText(el, typeof seg.text === 'string' ? seg.text : '', query);
        container.appendChild(el);
        continue;
      }

      if (seg.type === 'link') {
        const url = typeof seg.text === 'string' ? seg.text : '';
        if (!url) continue;
        const a = document.createElement('a');
        a.href = url;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'tlr-seg-link';
        a.textContent = '';
        this.appendHighlightedText(a, url, query);
        container.appendChild(a);
        continue;
      }

      if (seg.type === 'linkobj') {
        const link = seg.text?.link || '';
        const title = seg.text?.title || link;
        if (!link) continue;
        const a = document.createElement('a');
        a.href = link;
        a.target = '_blank';
        a.rel = 'noopener noreferrer';
        a.className = 'tlr-seg-link';
        a.textContent = '';
        this.appendHighlightedText(a, title, query);
        container.appendChild(a);
        continue;
      }

      if (seg.type === 'hashtag') {
        const t = typeof seg.text === 'string' ? seg.text : '';
        if (!t) continue;
        const el = document.createElement('span');
        el.className = 'tlr-seg-hashtag';
        const tag = t.startsWith('#') ? t : `#${t}`;
        el.textContent = '';
        this.appendHighlightedText(el, tag, query);
        container.appendChild(el);
        continue;
      }

      if (seg.type === 'datetime') {
        const el = document.createElement('span');
        el.className = 'tlr-seg-datetime';
        const text = this.formatDateTimeSegment(seg.text);
        el.textContent = '';
        this.appendHighlightedText(el, text, query);
        container.appendChild(el);
        continue;
      }

      if (seg.type === 'mention') {
        const el = document.createElement('span');
        el.className = 'tlr-seg-mention';
        const guid = typeof seg.text === 'string' ? seg.text : '';
        const text = this.formatMention(guid);
        el.textContent = '';
        this.appendHighlightedText(el, text, query);
        container.appendChild(el);
        continue;
      }

      if (seg.type === 'ref') {
        const guid = seg.text?.guid || null;
        if (!guid) continue;
        const el = document.createElement('span');
        el.className = 'tlr-seg-ref';
        el.dataset.action = 'open-ref';
        el.dataset.refGuid = guid;

        const title = seg.text?.title || this.resolveRecordName(guid) || '[link]';
        el.textContent = '';
        this.appendHighlightedText(el, title, query);
        container.appendChild(el);
        continue;
      }

      // Fallback: render as plain text when possible.
      if (typeof seg.text === 'string' && seg.text) {
        this.appendHighlightedText(container, seg.text, query);
      }
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

  formatDateTimeSegment(v) {
    if (typeof v === 'string') return v;
    const d = v?.d || null;
    if (typeof d !== 'string' || d.length !== 8) return '';
    // d = YYYYMMDD
    return `${d.slice(0, 4)}-${d.slice(4, 6)}-${d.slice(6, 8)}`;
  }

  coercePositiveInt(val, fallback) {
    const n = Number(val);
    if (!Number.isFinite(n)) return fallback;
    const i = Math.floor(n);
    if (i <= 0) return fallback;
    return i;
  }

  // ---------- CSS ----------

  injectCss() {
    this.ui.injectCSS(`
      .tlr-footer {
        margin-top: 16px;
        color: var(--text, inherit);
        font-size: 13px;
      }

      .tlr-header {
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 8px;
        min-height: 30px;
        row-gap: 8px;
        margin-bottom: 10px;
      }

      .tlr-title {
        font-weight: 600;
        white-space: nowrap;
      }

      .tlr-count {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        font-size: 12px;
        white-space: nowrap;
        font-variant-numeric: tabular-nums;
        overflow: hidden;
        text-overflow: ellipsis;
        min-width: 0;
      }

      .tlr-spacer {
        flex: 1 1 auto;
        min-width: 8px;
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
      }

      .tlr-filter-toggle.is-active {
        color: var(--text-default, var(--text, inherit));
        background: var(--bg-selected, var(--bg-hover, rgba(0, 0, 0, 0.06)));
      }

      .tlr-filter-glyph {
        position: relative;
        display: inline-block;
        width: 12px;
        height: 12px;
      }

      .tlr-filter-glyph::before {
        content: '';
        position: absolute;
        top: 1px;
        left: 0;
        width: 0;
        height: 0;
        border-left: 6px solid transparent;
        border-right: 6px solid transparent;
        border-top: 0;
        border-bottom: 6px solid currentColor;
        opacity: 0.95;
      }

      .tlr-filter-glyph::after {
        content: '';
        position: absolute;
        top: 7px;
        left: 5px;
        width: 2px;
        height: 4px;
        border-radius: 999px;
        background: currentColor;
        opacity: 0.95;
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
        padding: 6px;
        border-radius: 5px;
        border: 1px solid var(--cmdpal-border-color, var(--divider-color, var(--border-subtle, rgba(0, 0, 0, 0.12))));
        background: var(--cmdpal-bg-color, var(--panel-bg-color, var(--bg-default, var(--bg-panel, rgba(22, 26, 24, 0.96)))));
        box-shadow: var(--cmdpal-box-shadow, 0 12px 34px rgba(0, 0, 0, 0.18));
        z-index: 120;
      }

      .tlr-filter-menu {
        display: none;
        position: absolute;
        top: calc(100% + 6px);
        right: 0;
        min-width: 220px;
        max-width: min(90vw, 320px);
        padding: 6px;
        border-radius: 5px;
        border: 1px solid var(--cmdpal-border-color, var(--divider-color, var(--border-subtle, rgba(0, 0, 0, 0.12))));
        background: var(--cmdpal-bg-color, var(--panel-bg-color, var(--bg-default, var(--bg-panel, rgba(22, 26, 24, 0.96)))));
        box-shadow: var(--cmdpal-box-shadow, 0 12px 34px rgba(0, 0, 0, 0.18));
        z-index: 120;
      }

      .tlr-filter-open .tlr-filter-menu {
        display: block;
      }

      .tlr-sort-open .tlr-sort-menu {
        display: block;
      }

      .tlr-filter-menu-title {
        margin: 2px 6px 6px;
        font-size: 11px;
      }

      .tlr-filter-option {
        width: 100%;
        display: flex;
        align-items: center;
        line-height: 1.35;
        text-align: left;
      }

      .tlr-filter-option.is-active {
        background: var(--cmdpal-selected-bg-color, var(--bg-hover, rgba(0, 0, 0, 0.04)));
        color: var(--cmdpal-selected-fg-color, var(--text, inherit));
      }

      .tlr-filter-option-label {
        flex: 1 1 auto;
      }

      .tlr-sort-menu-title {
        margin: 2px 6px 6px;
        font-size: 11px;
      }

      .tlr-sort-option {
        width: 100%;
        display: flex;
        align-items: center;
        line-height: 1.35;
        text-align: left;
      }

      .tlr-sort-option.is-active {
        background: var(--cmdpal-selected-bg-color, var(--bg-hover, rgba(0, 0, 0, 0.04)));
        color: var(--cmdpal-selected-fg-color, var(--text, inherit));
      }

      .tlr-sort-option-label {
        flex: 1 1 auto;
      }

      .tlr-sort-menu-divider {
        margin: 10px 0;
        border-top: 1px solid var(--cmdpal-border-color, var(--border-subtle, rgba(0, 0, 0, 0.12)));
      }

      .tlr-sort-dir-row {
        display: flex;
        gap: 8px;
      }

      .tlr-sort-dir-btn {
        flex: 1 1 auto;
        justify-content: center;
      }

      .tlr-sort-dir-btn.is-active {
        background: var(--cmdpal-selected-bg-color, var(--bg-hover, rgba(0, 0, 0, 0.04)));
        color: var(--cmdpal-selected-fg-color, var(--text, inherit));
      }

      .tlr-search-wrap {
        display: flex;
        align-items: center;
        gap: 6px;
        padding: 0 8px;
        height: 30px;
        min-height: 30px;
        flex: 0 1 clamp(240px, 36vw, 440px);
        min-width: min(100%, 240px);
        border: 1px solid var(--input-border-color, var(--divider-color, var(--cmdpal-border-color, var(--border-subtle, rgba(0, 0, 0, 0.12)))));
        border-radius: 999px;
        background: var(--input-bg-color, var(--cmdpal-input-bg-color, var(--bg-panel, transparent)));
        box-sizing: border-box;
      }

      .tlr-empty-compact .tlr-search-toggle,
      .tlr-empty-compact .tlr-search-wrap,
      .tlr-empty-compact .tlr-filter-wrap,
      .tlr-empty-compact .tlr-sort-wrap {
        display: none !important;
      }

      .tlr-empty-compact .tlr-header {
        margin-bottom: 6px;
      }

      .tlr-search-icon {
        display: flex;
        align-items: center;
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
      }

      .tlr-search-input {
        width: 100%;
        max-width: none;
        min-width: 0;
        flex: 1 1 auto;
        height: 20px;
        min-height: 20px;
        border: 0;
        outline: none;
        background: transparent;
        color: var(--input-fg-color, var(--text-default, var(--text, inherit)));
        -webkit-text-fill-color: var(--input-fg-color, var(--text-default, var(--text, inherit)));
        caret-color: var(--input-fg-color, var(--text-default, var(--text, inherit)));
        opacity: 1;
        font-size: 13px;
        line-height: 20px;
        padding: 0;
      }

      .tlr-search-input::placeholder {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
      }

      .tlr-search-clear {
        min-width: 20px;
        padding: 0 4px;
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
      }

      .tlr-toggle {
        width: 26px;
        padding: 4px 0;
        text-align: center;
        font-weight: 700;
      }

      .tlr-body { display: block; }

      .tlr-collapsed .tlr-body { display: none; }

      .tlr-empty,
      .tlr-note,
      .tlr-error {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        padding: 8px 0;
        font-size: 12px;
      }

      .tlr-empty-compact-card {
        padding: 6px 0 2px;
      }

      .tlr-empty-compact-row {
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 12px;
      }

      .tlr-empty-compact-copy {
        min-width: 0;
      }

      .tlr-empty-compact-btn {
        flex: 0 0 auto;
      }

      .tlr-section-header {
        display: flex;
        align-items: center;
        gap: 8px;
        margin-top: 16px;
        margin-bottom: 8px;
      }

      .tlr-section:first-child .tlr-section-header {
        margin-top: 0;
      }

      .tlr-section-toggle {
        width: 20px;
        padding: 0;
        text-align: center;
        font-weight: 700;
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
      }

      .tlr-section-title {
        font-size: 12px;
        font-weight: 650;
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        text-transform: none;
        letter-spacing: 0;
      }

      .tlr-section-collapsed .tlr-section-body {
        display: none;
      }

      .tlr-divider {
        margin: 14px 0 10px;
        border-top: 1px solid var(--divider-color, var(--border-subtle, rgba(0, 0, 0, 0.12)));
      }

      .tlr-prop-group { margin: 12px 0 16px; }

      .tlr-prop-header {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 10px;
        width: 100%;
        padding: 8px 10px;
        text-align: left;
      }

      .tlr-prop-caret {
        width: 0;
        height: 0;
        border-top: 5px solid transparent;
        border-bottom: 5px solid transparent;
        border-left: 6px solid var(--text-muted, rgba(0, 0, 0, 0.6));
        opacity: 0.85;
        transform: rotate(90deg);
        transition: transform 140ms ease;
        flex: 0 0 auto;
      }

      .tlr-prop-collapsed .tlr-prop-caret {
        transform: rotate(0deg);
      }

      .tlr-prop-collapsed .tlr-prop-records {
        display: none;
      }

      .tlr-prop-title {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: normal;
        overflow-wrap: anywhere;
        flex: 1 1 auto;
        min-width: 0;
      }

      .tlr-prop-meta {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        font-size: 12px;
        margin-left: auto;
        flex: 0 0 auto;
      }

      .tlr-prop-records { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }

      .tlr-prop-record {
        display: block;
        width: 100%;
        padding: 8px 10px;
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

      .tlr-group { margin: 12px 0 16px; }

      .tlr-group-header {
        width: 100%;
        display: flex;
        align-items: center;
        justify-content: space-between;
        gap: 10px;
        padding: 8px 10px;
        text-align: left;
      }

      .tlr-group-title {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: normal;
        overflow-wrap: anywhere;
        line-height: 1.35;
      }

      .tlr-group-meta {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        font-size: 12px;
        flex: 0 0 auto;
      }

      .tlr-lines { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }

      .tlr-line-entry {
        display: flex;
        flex-direction: column;
        gap: 4px;
      }

      .tlr-line-main {
        display: flex;
        align-items: flex-start;
        gap: 4px;
      }

      .tlr-line {
        display: block;
        flex: 1 1 auto;
        min-width: 0;
        padding: 8px 10px;
        text-align: left;
        color: var(--text, inherit);
        line-height: 1.35;
      }

      .tlr-prefix {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
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
        flex: 0 0 auto;
        padding: 8px 10px 0 0;
      }

      .tlr-line-actions-group {
        display: flex;
        align-items: center;
        gap: 4px;
        margin-left: auto;
        flex: 0 0 auto;
      }

      .tlr-context-btn {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 24px;
        height: 24px;
        padding: 0;
        border-radius: 6px;
        color: var(--text-muted, rgba(0, 0, 0, 0.72));
      }

      .tlr-context-btn:hover:not(:disabled),
      .tlr-context-btn.is-active {
        color: var(--text-default, var(--text, inherit));
        background: var(--bg-selected, var(--bg-hover, rgba(0, 0, 0, 0.06)));
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
        gap: 2px;
      }

      .tlr-context-line {
        display: block;
        width: 100%;
        padding: 6px 10px 6px calc(10px + var(--tlr-context-indent, 0px));
        text-align: left;
        color: var(--text, inherit);
        line-height: 1.35;
        border-left: 1px solid var(--divider-color, var(--border-subtle, rgba(0, 0, 0, 0.12)));
      }

      .tlr-context-note {
        padding: 0 10px 2px;
      }

      .tlr-live-badge {
        display: inline-flex;
        align-items: center;
        padding: 1px 6px;
        border-radius: 999px;
        border: 1px solid var(--divider-color, var(--border-subtle, rgba(0, 0, 0, 0.12)));
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
        color: var(--text-muted, rgba(0, 0, 0, 0.68));
        font-size: 11px;
        vertical-align: middle;
      }

      .tlr-live-badge.is-new {
        color: var(--text-default, var(--text, inherit));
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
        .tlr-spacer {
          display: none;
        }

        .tlr-search-wrap {
          order: 10;
          flex: 1 1 100%;
          min-width: 0;
        }

        .tlr-sort-menu {
          right: auto;
          left: 0;
          min-width: 240px;
          max-width: min(92vw, 320px);
        }

        .tlr-filter-menu {
          right: auto;
          left: 0;
          min-width: 220px;
          max-width: min(92vw, 300px);
        }

        .tlr-search-input { max-width: none; }
      }
    `);
  }
}
