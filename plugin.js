class Plugin extends AppPlugin {
  onLoad() {
    // NOTE: Thymer strips top-level code outside the Plugin class.
    this._version = '0.4.7';
    this._pluginName = 'Backreferences';

    this._panelStates = new Map();
    this._eventHandlerIds = [];

    this._storageKeyCollapsed = 'thymer_backreferences_collapsed_v2';
    this._legacyStorageKeyCollapsed = null;
    this._collapsed = this.loadCollapsedSetting();

    this._storageKeyPropGroupCollapsed = 'thymer_backreferences_prop_group_collapsed_v2';
    this._legacyStorageKeyPropGroupCollapsed = null;
    this._propGroupCollapsed = this.loadPropGroupCollapsedSetting();

    this._storageKeyRecordGroupCollapsed = 'thymer_backreferences_record_group_collapsed_v1';
    this._recordGroupCollapsed = this.loadRecordGroupCollapsedSetting();

    this._storageKeyPropertyRefsCollapsed = 'thymer_backreferences_property_refs_collapsed_v1';
    this._propertyRefsCollapsed = this.loadBoolSetting(this._storageKeyPropertyRefsCollapsed, false);

    this._storageKeyLinkedRefsCollapsed = 'thymer_backreferences_linked_refs_collapsed_v1';
    this._linkedRefsCollapsed = this.loadBoolSetting(this._storageKeyLinkedRefsCollapsed, false);

    this._storageKeyUnlinkedCollapsed = 'thymer_backreferences_unlinked_collapsed_v1';
    this._unlinkedCollapsed = this.loadUnlinkedCollapsedSetting();

    this._defaultSortBy = 'page_last_edited';
    this._defaultSortDir = 'desc';
    this._storageKeySortByRecord = 'thymer_backreferences_sort_by_record_v1';
    this._legacyStorageKeySortByRecord = 'thymer_backlinks_sort_by_record_v1';
    this._sortByRecord = this.loadSortByRecordSetting();

    this._defaultMaxResults = 200;
    this._refreshDebounceMs = 350;
    this._sharedIgnoreMetaKey = 'plugin.refs.v1.ignore';
    this._collectionRecordNameCache = new Map();

    this.injectCss();

    this._cmdRefresh = this.ui.addCommandPaletteCommand({
      label: 'Backreferences: Refresh (Active Page)',
      icon: 'refresh',
      onSelected: () => {
        const panel = this.ui.getActivePanel();
        if (panel) this.scheduleRefreshForPanel(panel, { force: true, reason: 'cmdpal' });
      }
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
    this._eventHandlerIds.push(this.events.on('lineitem.updated', (ev) => this.handleLineItemUpdated(ev)));
    this._eventHandlerIds.push(this.events.on('lineitem.deleted', () => this.handleLineItemDeleted()));
    this._eventHandlerIds.push(this.events.on('record.updated', (ev) => this.handleRecordUpdated(ev)));

    const panel = this.ui.getActivePanel();
    if (panel) this.handlePanelChanged(panel, 'initial');
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

    this._cmdRefresh?.remove?.();

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
    const recordChanged = state.recordGuid !== recordGuid;
    state.recordGuid = recordGuid;

    if (recordChanged || !this.isValidSortBy(state.sortBy) || !this.isValidSortDir(state.sortDir)) {
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
        sortToggleEl: null,
        sortMenuEl: null,
        searchToggleEl: null,
        searchWrapEl: null,
        searchInputEl: null,
        chipsRowEl: null,
        searchPhrases: [],
        searchTyped: '',
        searchOpen: false,
        sortBy: this._defaultSortBy,
        sortDir: this._defaultSortDir,
        sortMenuOpen: false,
        sortMenuDismissHandler: null,
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
      sortToggleEl: null,
      sortMenuEl: null,
      searchToggleEl: null,
      searchWrapEl: null,
      searchInputEl: null,
      chipsRowEl: null,
      searchPhrases: [],
      searchTyped: '',
      searchOpen: false,
      sortBy: this._defaultSortBy,
      sortDir: this._defaultSortDir,
      sortMenuOpen: false,
      sortMenuDismissHandler: null,
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

    try {
      state.observer?.disconnect?.();
    } catch (e) {
      // ignore
    }
    state.observer = null;

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

    const searchToggle = document.createElement('button');
    searchToggle.className = 'tlr-btn tlr-search-toggle button-none button-small button-minimal-hover';
    searchToggle.type = 'button';
    searchToggle.dataset.action = 'toggle-search';
    searchToggle.title = 'Filter references';
    searchToggle.setAttribute('aria-expanded', state.searchOpen === true ? 'true' : 'false');
    try {
      searchToggle.appendChild(this.ui.createIcon('ti-search'));
    } catch (e) {
      searchToggle.textContent = 'Search';
    }

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
    input.placeholder = 'Filter... (Enter to pin)';
    input.autocomplete = 'off';
    input.spellcheck = false;
    input.value = state.searchTyped || '';

    const chipsRow = document.createElement('div');
    chipsRow.className = 'tlr-chips-row';
    chipsRow.dataset.role = 'chips';

    const rebuildChips = () => {
      chipsRow.innerHTML = '';
      const phrases = state.searchPhrases || [];
      for (let i = 0; i < phrases.length; i++) {
        const chip = document.createElement('span');
        chip.className = 'tlr-chip';
        const label = document.createElement('span');
        label.className = 'tlr-chip-label';
        label.textContent = phrases[i];
        const remove = document.createElement('button');
        remove.type = 'button';
        remove.className = 'tlr-chip-remove button-none';
        remove.dataset.action = 'remove-chip';
        remove.dataset.chipIndex = i;
        remove.title = `Remove "${phrases[i]}"`;
        remove.textContent = '×';
        chip.appendChild(label);
        chip.appendChild(remove);
        chipsRow.appendChild(chip);
      }
      chipsRow.style.display = phrases.length > 0 ? 'flex' : 'none';
    };

    const commitChip = () => {
      const val = input.value.trim();
      if (!val) return;
      if (!Array.isArray(state.searchPhrases)) state.searchPhrases = [];
      if (!state.searchPhrases.includes(val)) {
        state.searchPhrases = [...state.searchPhrases, val];
        rebuildChips();
      }
      input.value = '';
      state.searchTyped = '';
      this.renderFromCache(state);
    };

    const stopKeys = (e) => {
      e.stopPropagation();
      if (typeof e.stopImmediatePropagation === 'function') e.stopImmediatePropagation();
    };

    input.addEventListener('keydown', (e) => {
      stopKeys(e);
      if (e.key === 'Enter') {
        e.preventDefault();
        commitChip();
      } else if (e.key === 'Escape') {
        e.preventDefault();
        if (input.value.trim()) {
          input.value = '';
          state.searchTyped = '';
          this.renderFromCache(state);
        } else if ((state.searchPhrases || []).length > 0) {
          state.searchPhrases = [];
          state.searchTyped = '';
          rebuildChips();
          this.renderFromCache(state);
        } else {
          this.setSearchOpen(state, false);
        }
      }
    });

    input.addEventListener('keypress', stopKeys);
    input.addEventListener('keyup', stopKeys);

    input.addEventListener('input', () => {
      state.searchTyped = input.value;
      this.renderFromCache(state);
    });

    rebuildChips();

    const clearBtn = document.createElement('button');
    clearBtn.className = 'tlr-search-clear button-none button-small button-minimal-hover';
    clearBtn.type = 'button';
    clearBtn.dataset.action = 'clear-search';
    clearBtn.title = 'Clear all filters';
    clearBtn.textContent = '×';

    searchWrap.appendChild(searchIcon);
    searchWrap.appendChild(input);
    searchWrap.appendChild(clearBtn);

    state._rebuildChips = rebuildChips;

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
    header.appendChild(searchToggle);
    header.appendChild(searchWrap);
    header.appendChild(sortWrap);

    const body = document.createElement('div');
    body.className = 'tlr-body';
    body.dataset.role = 'body';

    root.appendChild(header);
    root.appendChild(chipsRow);
    root.appendChild(body);

    root.addEventListener('click', (e) => this.handleFooterClick(e));

    this.applyCollapsedState(root, this._collapsed);
    root.classList.toggle('tlr-search-open', state.searchOpen === true);
    root.classList.toggle('tlr-sort-open', state.sortMenuOpen === true);

    state.sortToggleEl = sortToggle;
    state.sortMenuEl = sortMenu;
    state.searchToggleEl = searchToggle;
    state.searchWrapEl = searchWrap;
    state.searchInputEl = input;
    state.chipsRowEl = chipsRow;
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

    if (action === 'toggle-record-group') {
      const guid = actionEl.dataset.recordGuid || null;
      if (!guid) return;

      const nextCollapsed = !this.isRecordGroupCollapsed(guid);
      if (!this._recordGroupCollapsed) this._recordGroupCollapsed = new Set();

      if (nextCollapsed) {
        this._recordGroupCollapsed.add(guid);
      } else {
        this._recordGroupCollapsed.delete(guid);
      }
      this.saveRecordGroupCollapsedSetting();

      for (const s of this._panelStates.values()) {
        if (!s?.rootEl) continue;
        // Group toggle carets
        const btnEls = Array.from(s.rootEl.querySelectorAll?.(`.tlr-group-header-pill[data-record-guid="${guid}"]`) || []);
        for (const btn of btnEls) {
          btn.setAttribute?.('aria-expanded', nextCollapsed ? 'false' : 'true');
        }
        // Group containers
        const groupEls = Array.from(s.rootEl.querySelectorAll?.(`.tlr-group[data-record-guid="${guid}"]`) || []);
        for (const groupEl of groupEls) {
          groupEl.classList.toggle('tlr-group-collapsed', nextCollapsed);
        }
      }
      return;
    }

    if (action === 'toggle-search') {
      if (!state) return;
      this.setSearchOpen(state, !(state.searchOpen === true));
      return;
    }

    if (action === 'toggle-sort-menu') {
      if (!state) return;
      this.setSortMenuOpen(state, !(state.sortMenuOpen === true));
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

    if (action === 'remove-chip') {
      if (!state) return;
      const idx = parseInt(actionEl.dataset.chipIndex, 10);
      if (!isNaN(idx) && Array.isArray(state.searchPhrases)) {
        state.searchPhrases = state.searchPhrases.filter((_, i) => i !== idx);
        if (typeof state._rebuildChips === 'function') state._rebuildChips();
        this.renderFromCache(state);
      }
      return;
    }

    if (action === 'clear-search') {
      if (!state) return;
      const hasFilter = (state.searchPhrases || []).length > 0 || (state.searchTyped || '').trim();
      if (hasFilter) {
        state.searchPhrases = [];
        state.searchTyped = '';
        if (state.searchInputEl) state.searchInputEl.value = '';
        if (typeof state._rebuildChips === 'function') state._rebuildChips();
        this.renderFromCache(state);
        this.setSearchOpen(state, true);
      } else {
        this.setSearchOpen(state, false);
      }
      return;
    }

    if (action === 'toggle-property-refs') {
      this._propertyRefsCollapsed = !this._propertyRefsCollapsed;
      this.saveBoolSetting(this._storageKeyPropertyRefsCollapsed, this._propertyRefsCollapsed);
      for (const s of this._panelStates.values()) {
        if (!s?.rootEl) continue;
        const el = s.rootEl.querySelector?.('.tlr-section-block[data-section="property"]') || null;
        if (el) el.classList.toggle('tlr-section-collapsed', this._propertyRefsCollapsed);
      }
      return;
    }

    if (action === 'toggle-linked-refs') {
      this._linkedRefsCollapsed = !this._linkedRefsCollapsed;
      this.saveBoolSetting(this._storageKeyLinkedRefsCollapsed, this._linkedRefsCollapsed);
      for (const s of this._panelStates.values()) {
        if (!s?.rootEl) continue;
        const el = s.rootEl.querySelector?.('.tlr-section-block[data-section="linked"]') || null;
        if (el) el.classList.toggle('tlr-section-collapsed', this._linkedRefsCollapsed);
      }
      return;
    }

    if (action === 'toggle-unlinked') {
      this._unlinkedCollapsed = !this._unlinkedCollapsed;
      this.saveUnlinkedCollapsedSetting(this._unlinkedCollapsed);
      for (const s of this._panelStates.values()) {
        if (!s?.rootEl) continue;
        const el = s.rootEl.querySelector?.('.tlr-section-block[data-section="unlinked"]') || null;
        if (el) el.classList.toggle('tlr-section-collapsed', this._unlinkedCollapsed);
      }
      return;
    }

    if (action === 'link-unlinked') {
      if (!state) return;
      const lineGuid = actionEl.dataset.lineGuid || null;
      if (!lineGuid) return;
      this.linkUnlinkedReference(state, lineGuid).catch(() => {});
      return;
    }

    if (action === 'link-all-unlinked') {
      if (!state) return;
      this.linkAllUnlinkedReferences(state).catch(() => {});
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
      if (e?.altKey === true) {
        this.setSortMenuOpen(state, false);
        this.toggleSharedIgnoreForLine(state, lineGuid).catch(() => {
          // ignore
        });
        return;
      }
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

  setSearchOpen(state, open) {
    if (!state) return;
    state.searchOpen = open === true;
    if (state.searchOpen === true) this.setSortMenuOpen(state, false);
    if (!state.rootEl) return;

    state.rootEl.classList.toggle('tlr-search-open', state.searchOpen === true);
    state.searchToggleEl?.setAttribute?.('aria-expanded', state.searchOpen === true ? 'true' : 'false');

    if (state.searchInputEl) {
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

  loadBoolSetting(key, defaultValue) {
    try {
      const v = localStorage.getItem(key);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (e) {
      // ignore
    }
    return defaultValue === true;
  }

  saveBoolSetting(key, value) {
    try {
      localStorage.setItem(key, value ? '1' : '0');
    } catch (e) {
      // ignore
    }
  }

  loadUnlinkedCollapsedSetting() {
    try {
      const v = localStorage.getItem(this._storageKeyUnlinkedCollapsed);
      if (v === '1') return true;
      if (v === '0') return false;
    } catch (e) {
      // ignore
    }
    return true;
  }

  saveUnlinkedCollapsedSetting(collapsed) {
    try {
      localStorage.setItem(this._storageKeyUnlinkedCollapsed, collapsed ? '1' : '0');
    } catch (e) {
      // ignore
    }
  }

  loadRecordGroupCollapsedSetting() {
    try {
      const stored = localStorage.getItem(this._storageKeyRecordGroupCollapsed);
      if (stored) {
        const arr = JSON.parse(stored);
        if (Array.isArray(arr)) return new Set(arr);
      }
    } catch (e) {
      // ignore
    }
    return new Set();
  }

  saveRecordGroupCollapsedSetting() {
    try {
      const arr = Array.from(this._recordGroupCollapsed || []);
      localStorage.setItem(this._storageKeyRecordGroupCollapsed, JSON.stringify(arr));
    } catch (e) {
      // ignore
    }
  }

  isRecordGroupCollapsed(guid) {
    if (!this._recordGroupCollapsed) return false;
    return this._recordGroupCollapsed.has(guid);
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

    // Rebuild collection record name cache so we can resolve refs to collection entries.
    await this.rebuildCollectionRecordNameCache();

    const query = `@linkto = "${recordGuid}"`;
    const [searchSettled, propSettled] = await Promise.allSettled([
      this.data.searchByQuery(query, maxResults),
      this.getPropertyBacklinkGroups(record, recordGuid, { showSelf })
    ]);

    // Ignore stale refreshes.
    if (!this._panelStates.has(panelId) || state.refreshSeq !== seq) return;

    let linkedError = '';
    let linkedGroups = [];
    const treeContextMap = new Map();

    if (searchSettled.status === 'fulfilled') {
      const result = searchSettled.value;
      if (result?.error) {
        linkedError = result.error;
      } else {
        const lines = Array.isArray(result?.lines) ? result.lines : [];
        
        await Promise.all(lines.map(async (line) => {
          if (typeof line.getTreeContext === 'function') {
            try {
              const ctx = await line.getTreeContext();
              treeContextMap.set(line.guid, ctx);
            } catch (e) {}
          }
        }));

        linkedGroups = this.groupBacklinkLines(lines, recordGuid, { showSelf });
      }
    } else {
      linkedError = 'Error loading linked references.';
    }

    let propertyError = '';
    let propertyGroups = [];
    if (propSettled.status === 'fulfilled') {
      propertyGroups = Array.isArray(propSettled.value) ? propSettled.value : [];
    } else {
      propertyError = 'Error loading property references.';
    }

    // --- Unlinked references ---
    let unlinkedError = '';
    let unlinkedGroups = [];
    const unlinkedTreeContextMap = new Map();

    try {
      const recordName = (record?.getName?.() || '').trim();
      if (recordName) {
        // Collect all line guids that already link to this record (to exclude them).
        const alreadyLinkedLineGuids = new Set();
        for (const g of linkedGroups) {
          for (const line of g?.lines || []) {
            if (line?.guid) alreadyLinkedLineGuids.add(line.guid);
          }
        }

        const unlinkedSearchResult = await this.data.searchByQuery(recordName, maxResults);
        if (unlinkedSearchResult?.error) {
          unlinkedError = unlinkedSearchResult.error;
        } else {
          const allLines = Array.isArray(unlinkedSearchResult?.lines) ? unlinkedSearchResult.lines : [];

          // Filter: keep only lines that mention the record name in plain text
          // but do NOT already have a ref segment pointing to this record.
          const candidateLines = [];
          for (const line of allLines) {
            if (!line || !line.guid) continue;
            // Skip lines already in linked references.
            if (alreadyLinkedLineGuids.has(line.guid)) continue;
            // Skip lines belonging to the target record itself.
            const srcGuid = line.record?.guid || null;
            if (!showSelf && srcGuid === recordGuid) continue;
            // Check that the line has a text segment containing the name (case-insensitive)
            // and does NOT have a ref segment pointing to this record.
            if (this.lineHasRefToRecord(line, recordGuid)) continue;
            if (!this.lineHasTextMentionOf(line, recordName)) continue;
            candidateLines.push(line);
          }

          await Promise.all(candidateLines.map(async (line) => {
            if (typeof line.getTreeContext === 'function') {
              try {
                const ctx = await line.getTreeContext();
                unlinkedTreeContextMap.set(line.guid, ctx);
              } catch (e) {}
            }
          }));

          unlinkedGroups = this.groupBacklinkLines(candidateLines, recordGuid, { showSelf });
        }
      }
    } catch (e) {
      unlinkedError = 'Error loading unlinked references.';
    }

    // Ignore stale refreshes (re-check after async unlinked work).
    if (!this._panelStates.has(panelId) || state.refreshSeq !== seq) return;

    state.lastResults = {
      propertyGroups,
      propertyError,
      linkedGroups,
      linkedError,
      unlinkedGroups,
      unlinkedError,
      unlinkedTreeContextMap,
      maxResults,
      treeContextMap
    };
    this.renderFromCache(state);
    this.setLoadingState(state, false);
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
    this.refreshAllPanels({ force: false, reason: 'record.updated' });
  }

  handleLineItemUpdated(ev) {
    if (this.didSharedIgnoreChange(ev)) {
      this.refreshAllPanels({ force: false, reason: 'lineitem.ignore-change' });
      return;
    }

    if (!ev?.hasSegments?.() || typeof ev.getSegments !== 'function') return;

    const segments = ev.getSegments() || [];
    const referenced = this.extractReferencedRecordGuids(segments);

    // For linked references: only refresh panels whose record is referenced.
    // For unlinked references: any text edit could add/remove a name mention,
    // so we always do a debounced refresh of all panels.
    if (referenced.size > 0) {
      for (const state of this._panelStates.values()) {
        const panel = state?.panel || null;
        if (!panel) continue;
        if (!state.recordGuid) continue;
        if (!referenced.has(state.recordGuid)) continue;
        this.scheduleRefreshForPanel(panel, { force: false, reason: 'lineitem.updated' });
      }
    }

    // Debounced refresh for unlinked references on any segment change.
    this.refreshAllPanels({ force: false, reason: 'lineitem.updated.unlinked' });
  }

  handleLineItemDeleted() {
    // We don't know which record(s) were referenced by the deleted item.
    // This is rare, so we just refresh all visible footers (debounced).
    this.refreshAllPanels({ force: false, reason: 'lineitem.deleted' });
  }

  didSharedIgnoreChange(ev) {
    const mp = ev?.metaProperties;
    if (!mp || typeof mp !== 'object') return false;

    if (Object.prototype.hasOwnProperty.call(mp, this._sharedIgnoreMetaKey)) return true;

    const nested = mp?.plugin?.refs?.v1;
    if (nested && Object.prototype.hasOwnProperty.call(nested, 'ignore')) return true;

    return false;
  }

  normalizeSharedIgnoreValue(value) {
    if (value === true || value === 1) return true;
    if (typeof value === 'string') {
      const v = value.trim().toLowerCase();
      if (v === '1' || v === 'true' || v === 'yes' || v === 'on') return true;
    }
    return false;
  }

  readSharedIgnoreFromProps(props) {
    if (!props || typeof props !== 'object') return false;

    const direct = props?.[this._sharedIgnoreMetaKey];
    if (this.normalizeSharedIgnoreValue(direct)) return true;

    const underscore = props?.plugin_refs_v1_ignore;
    if (this.normalizeSharedIgnoreValue(underscore)) return true;

    const nested = props?.plugin?.refs?.v1?.ignore;
    if (this.normalizeSharedIgnoreValue(nested)) return true;

    return false;
  }

  isLineSharedIgnored(line) {
    if (!line) return false;
    return this.readSharedIgnoreFromProps(line?.props || null);
  }

  countActiveLinkedReferences(groups) {
    let total = 0;
    for (const g of groups || []) {
      for (const line of g?.lines || []) {
        if (this.isLineSharedIgnored(line)) continue;
        total += 1;
      }
    }
    return total;
  }

  countIgnoredLinkedReferences(groups) {
    let total = 0;
    for (const g of groups || []) {
      for (const line of g?.lines || []) {
        if (!this.isLineSharedIgnored(line)) continue;
        total += 1;
      }
    }
    return total;
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

  async toggleSharedIgnoreForLine(state, lineGuid) {
    const line = this.findLinkedLineByGuid(state, lineGuid);
    if (!line || typeof line.setMetaProperty !== 'function') return;

    const currentlyIgnored = this.isLineSharedIgnored(line);
    const nextValue = currentlyIgnored ? null : 1;

    let ok = false;
    try {
      ok = (await line.setMetaProperty(this._sharedIgnoreMetaKey, nextValue)) === true;
    } catch (e) {
      ok = false;
    }
    if (!ok) return;

    try {
      this.ui.addToaster({
        title: 'Backreferences',
        message: currentlyIgnored
          ? 'Reference restored to shared counts.'
          : 'Reference ignored in shared counts.',
        dismissible: true,
        autoDestroyTime: 1800
      });
    } catch (e) {
      // ignore
    }

    this.refreshAllPanels({ force: true, reason: 'line.ignore-toggled' });
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

  // ---------- Unlinked reference helpers ----------

  lineHasRefToRecord(line, recordGuid) {
    if (!line || !recordGuid) return false;
    const segments = line.segments || [];
    for (const seg of segments) {
      if (seg?.type !== 'ref') continue;
      const textObj = typeof seg.text === 'string' ? { guid: seg.text } : (seg.text || {});
      if (textObj.guid === recordGuid) return true;
    }
    return false;
  }

  lineHasTextMentionOf(line, name) {
    if (!line || !name) return false;
    const nameLower = name.toLowerCase();
    const segments = line.segments || [];
    for (const seg of segments) {
      if (seg?.type === 'ref') continue;
      const text = typeof seg.text === 'string' ? seg.text : '';
      if (text.toLowerCase().includes(nameLower)) return true;
    }
    return false;
  }

  buildReplacedSegments(segments, name, recordGuid) {
    if (!Array.isArray(segments) || !name || !recordGuid) return segments;
    const nameLower = name.toLowerCase();
    const newSegments = [];

    for (const seg of segments) {
      // Only replace in text-like segments, skip refs and other structured types.
      if (seg?.type !== 'text' && seg?.type !== 'bold' && seg?.type !== 'italic') {
        newSegments.push(seg);
        continue;
      }

      const text = typeof seg.text === 'string' ? seg.text : '';
      if (!text || !text.toLowerCase().includes(nameLower)) {
        newSegments.push(seg);
        continue;
      }

      // Split the text around the first occurrence of the name (case-insensitive).
      const idx = text.toLowerCase().indexOf(nameLower);
      if (idx === -1) {
        newSegments.push(seg);
        continue;
      }

      const before = text.slice(0, idx);
      const match = text.slice(idx, idx + name.length);
      const after = text.slice(idx + name.length);

      if (before) newSegments.push({ type: seg.type, text: before });
      newSegments.push({ type: 'ref', text: { guid: recordGuid, title: match } });
      if (after) newSegments.push({ type: seg.type, text: after });

      // Only replace first occurrence per segment.
      continue;
    }

    return newSegments;
  }

  buildReplacedSegmentsAll(segments, name, recordGuid) {
    if (!Array.isArray(segments) || !name || !recordGuid) return segments;
    const nameLower = name.toLowerCase();
    const newSegments = [];

    for (const seg of segments) {
      if (seg?.type !== 'text' && seg?.type !== 'bold' && seg?.type !== 'italic') {
        newSegments.push(seg);
        continue;
      }

      const text = typeof seg.text === 'string' ? seg.text : '';
      if (!text || !text.toLowerCase().includes(nameLower)) {
        newSegments.push(seg);
        continue;
      }

      // Replace ALL occurrences of the name in this text segment.
      let remaining = text;
      while (remaining.length > 0) {
        const idx = remaining.toLowerCase().indexOf(nameLower);
        if (idx === -1) {
          newSegments.push({ type: seg.type, text: remaining });
          break;
        }

        const before = remaining.slice(0, idx);
        const match = remaining.slice(idx, idx + name.length);
        remaining = remaining.slice(idx + name.length);

        if (before) newSegments.push({ type: seg.type, text: before });
        newSegments.push({ type: 'ref', text: { guid: recordGuid, title: match } });
      }

      continue;
    }

    return newSegments;
  }

  async linkUnlinkedReference(state, lineGuid) {
    const panel = state?.panel || null;
    const record = panel?.getActiveRecord?.() || null;
    const recordGuid = record?.guid || null;
    const recordName = (record?.getName?.() || '').trim();
    if (!recordGuid || !recordName || !lineGuid) return;

    const line = this.findUnlinkedLineByGuid(state, lineGuid);
    if (!line || typeof line.setSegments !== 'function') return;

    const newSegments = this.buildReplacedSegments(line.segments || [], recordName, recordGuid);
    try {
      await line.setSegments(newSegments);
    } catch (e) {
      // ignore
    }

    this.refreshAllPanels({ force: true, reason: 'unlinked.linked' });
  }

  async linkAllUnlinkedReferences(state) {
    const panel = state?.panel || null;
    const record = panel?.getActiveRecord?.() || null;
    const recordGuid = record?.guid || null;
    const recordName = (record?.getName?.() || '').trim();
    if (!recordGuid || !recordName) return;

    const groups = state?.lastResults?.unlinkedGroups || [];
    let count = 0;

    for (const g of groups) {
      for (const line of g?.lines || []) {
        if (!line || typeof line.setSegments !== 'function') continue;
        if (this.lineHasRefToRecord(line, recordGuid)) continue;
        if (!this.lineHasTextMentionOf(line, recordName)) continue;
        const newSegments = this.buildReplacedSegmentsAll(line.segments || [], recordName, recordGuid);
        try {
          await line.setSegments(newSegments);
          count++;
        } catch (e) {
          // ignore
        }
      }
    }

    if (count > 0) {
      try {
        this.ui.addToaster({
          title: 'Backreferences',
          message: `Linked ${count} unlinked reference${count === 1 ? '' : 's'}.`,
          dismissible: true,
          autoDestroyTime: 2500
        });
      } catch (e) {
        // ignore
      }
    }

    this.refreshAllPanels({ force: true, reason: 'unlinked.linked-all' });
  }

  findUnlinkedLineByGuid(state, lineGuid) {
    const target = (lineGuid || '').trim();
    if (!target || !state?.lastResults) return null;
    const groups = Array.isArray(state.lastResults?.unlinkedGroups) ? state.lastResults.unlinkedGroups : [];

    for (const g of groups) {
      for (const line of g?.lines || []) {
        if ((line?.guid || '') === target) return line;
      }
    }

    return null;
  }

  // ---------- Grouping + rendering ----------

  async getPropertyBacklinkGroups(_targetRecord, targetGuid, { showSelf }) {
    if (!targetGuid) return [];

    // NOTE: Thymer's built-in backlinks/backrefs do not include record-link properties,
    // so we scan all records' properties to find record-link fields pointing at targetGuid.
    const allRecords = this.data.getAllRecords?.() || [];
    const byProp = new Map();

    for (const src of allRecords || []) {
      const srcGuid = src?.guid || null;
      if (!srcGuid) continue;
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

    // Most record-link properties currently expose their referenced record GUID via .text().
    // We also look at .choice() as a fallback for older/quirky configs.
    let raw = [];
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
      for (const v of this.expandPossibleListString(r)) {
        push(v);
      }
    }

    return out;
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
      const activeLines = lines.filter((line) => !this.isLineSharedIgnored(line));
      if (activeLines.length === 0) continue;
      addReferenceCount(guid, activeLines.length);

      let newestLineActivity = 0;
      for (const line of activeLines) {
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

  renderReferences(state, { propertyGroups, propertyError, linkedGroups, linkedError, unlinkedGroups, unlinkedError, unlinkedTreeContextMap, maxResults, treeContextMap }) {
    if (!state?.bodyEl || !state?.countEl) return;

    const body = state.bodyEl;
    body.innerHTML = '';

    const pinnedPhrases = (state.searchPhrases || []).map(p => p.toLowerCase()).filter(Boolean);
    const typedPhrase = (state.searchTyped || '').trim().toLowerCase();
    const phrases = typedPhrase ? [...pinnedPhrases, typedPhrase] : pinnedPhrases;
    const query = phrases.join(' ');

    const propsAll = Array.isArray(propertyGroups) ? propertyGroups : [];
    const linkedAll = Array.isArray(linkedGroups) ? linkedGroups : [];
    const unlinkedAll = Array.isArray(unlinkedGroups) ? unlinkedGroups : [];

    const totalPropRefCount = propsAll.reduce((n, g) => n + (g?.records?.length || 0), 0);
    const totalLinkedRefCount = this.countActiveLinkedReferences(linkedAll);
    const totalIgnoredLinkedRefCount = this.countIgnoredLinkedReferences(linkedAll);
    const totalUnlinkedRefCount = this.countActiveLinkedReferences(unlinkedAll);

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
    let unlinked = unlinkedAll;

    if (phrases.length > 0) {
      const allMatch = (text) => phrases.every(p => text.includes(p));

      const nextProps = [];
      for (const g of propsAll) {
        const propertyName = (g?.propertyName || '').trim();
        if (!propertyName) continue;
        const recs = (g?.records || []).filter((r) => {
          const name = (r?.getName?.() || '').toLowerCase();
          return allMatch(name);
        });
        if (recs.length > 0) nextProps.push({ propertyName, records: recs });
      }
      props = nextProps;

      const nextLinked = [];
      for (const g of linkedAll) {
        const record = g?.record || null;
        const recordGuid = record?.guid || null;
        if (!recordGuid) continue;
        const lines = (g?.lines || []).filter((line) => {
          const text = this.segmentsToPlainText(line?.segments || []).toLowerCase();
          return allMatch(text);
        });
        if (lines.length > 0) nextLinked.push({ record, lines });
      }
      linked = nextLinked;

      const nextUnlinked = [];
      for (const g of unlinkedAll) {
        const record = g?.record || null;
        const recordGuid = record?.guid || null;
        if (!recordGuid) continue;
        const lines = (g?.lines || []).filter((line) => {
          const text = this.segmentsToPlainText(line?.segments || []).toLowerCase();
          return allMatch(text);
        });
        if (lines.length > 0) nextUnlinked.push({ record, lines });
      }
      unlinked = nextUnlinked;
    }

    const filteredPropRefCount = props.reduce((n, g) => n + (g?.records?.length || 0), 0);
    const filteredLinkedRefCount = this.countActiveLinkedReferences(linked);
    const filteredIgnoredLinkedRefCount = this.countIgnoredLinkedReferences(linked);
    const filteredUnlinkedRefCount = this.countActiveLinkedReferences(unlinked);

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
    const sortMetrics = this.computeRecordSortMetrics(props, linked);
    props = this.sortPropertyGroupsForRender(props, sortSpec, sortMetrics);
    linked = this.sortLinkedGroupsForRender(linked, sortSpec, sortMetrics);
    unlinked = this.sortLinkedGroupsForRender(unlinked, sortSpec, sortMetrics);

    const parts = [];
    if (phrases.length > 0) {
      const shortQuery = query.length > 24 ? `${query.slice(0, 24)}...` : query;
      parts.push(`Filter: "${shortQuery}"`);
      if (totalUniquePages.size > 0) parts.push(`${filteredUniquePages.size}/${totalUniquePages.size} pages`);
      if (totalPropRefCount > 0) parts.push(`${filteredPropRefCount}/${totalPropRefCount} prop refs`);
      if (totalLinkedRefCount > 0) parts.push(`${filteredLinkedRefCount}/${totalLinkedRefCount} linked`);
      if (totalIgnoredLinkedRefCount > 0) parts.push(`${filteredIgnoredLinkedRefCount}/${totalIgnoredLinkedRefCount} ignored`);
      if (totalUnlinkedRefCount > 0) parts.push(`${filteredUnlinkedRefCount}/${totalUnlinkedRefCount} unlinked`);
    } else {
      if (totalUniquePages.size > 0) parts.push(`${totalUniquePages.size} page${totalUniquePages.size === 1 ? '' : 's'}`);
      if (totalPropRefCount > 0) parts.push(`${totalPropRefCount} prop ref${totalPropRefCount === 1 ? '' : 's'}`);
      if (totalLinkedRefCount > 0) parts.push(`${totalLinkedRefCount} linked`);
      if (totalIgnoredLinkedRefCount > 0) parts.push(`${totalIgnoredLinkedRefCount} ignored`);
      if (totalUnlinkedRefCount > 0) parts.push(`${totalUnlinkedRefCount} unlinked`);
    }
    state.countEl.textContent = parts.join(' | ');

    // --- Property References Section ---
    const propBlock = this.buildSectionBlock({
      sectionKey: 'property',
      title: 'Property References',
      count: filteredPropRefCount,
      collapsed: this._propertyRefsCollapsed,
      toggleAction: 'toggle-property-refs'
    });
    body.appendChild(propBlock);
    const propBody = propBlock.querySelector('.tlr-section-body');
    if (propertyError) {
      this.appendError(propBody, propertyError);
    } else if (props.length === 0) {
      this.appendEmpty(propBody, phrases.length > 0 ? 'No matching property references.' : 'No property references.');
    } else {
      this.appendPropertyReferenceGroups(propBody, props, { query });
    }

    // --- Linked References Section ---
    const linkedBlock = this.buildSectionBlock({
      sectionKey: 'linked',
      title: 'Linked References',
      count: filteredLinkedRefCount,
      collapsed: this._linkedRefsCollapsed,
      toggleAction: 'toggle-linked-refs'
    });
    body.appendChild(linkedBlock);
    const linkedBody = linkedBlock.querySelector('.tlr-section-body');
    if (linkedError) {
      this.appendError(linkedBody, linkedError);
    } else {
      this.appendLinkedReferenceGroups(linkedBody, linked, {
        maxResults,
        query,
        totalLineCount: totalLinkedRefCount,
        emptyMessage: phrases.length > 0 ? 'No matching linked references.' : 'No linked references.',
        treeContextMap: treeContextMap || new Map()
      });
    }

    // --- Unlinked References Section ---
    const unlinkedBlock = this.buildSectionBlock({
      sectionKey: 'unlinked',
      title: 'Unlinked References',
      count: filteredUnlinkedRefCount,
      collapsed: this._unlinkedCollapsed,
      toggleAction: 'toggle-unlinked',
      extraHeaderContent: (filteredUnlinkedRefCount > 1) ? this.buildLinkAllButton() : null
    });
    body.appendChild(unlinkedBlock);
    const unlinkedBody = unlinkedBlock.querySelector('.tlr-section-body');
    if (unlinkedError) {
      this.appendError(unlinkedBody, unlinkedError);
    } else if (unlinked.length === 0) {
      this.appendEmpty(unlinkedBody, phrases.length > 0 ? 'No matching unlinked references.' : 'No unlinked references.');
    } else {
      this.appendUnlinkedReferenceGroups(unlinkedBody, unlinked, {
        query,
        treeContextMap: unlinkedTreeContextMap || new Map()
      });
    }
  }

  buildSectionBlock({ sectionKey, title, count, collapsed, toggleAction, extraHeaderContent }) {
    const block = document.createElement('div');
    block.className = 'tlr-section-block';
    block.dataset.section = sectionKey || '';
    if (collapsed) block.classList.add('tlr-section-collapsed');

    const header = document.createElement('div');
    header.className = 'tlr-section-header';

    const toggleBtn = document.createElement('button');
    toggleBtn.type = 'button';
    toggleBtn.className = 'tlr-section-toggle button-none button-small button-minimal-hover';
    toggleBtn.dataset.action = toggleAction || '';
    toggleBtn.title = `Collapse/expand ${(title || '').toLowerCase()}`;

    const caret = document.createElement('span');
    caret.className = 'tlr-section-caret';
    caret.setAttribute('aria-hidden', 'true');
    toggleBtn.appendChild(caret);

    const titleEl = document.createElement('span');
    titleEl.className = 'tlr-section-label';
    titleEl.textContent = title || '';
    toggleBtn.appendChild(titleEl);

    const countEl = document.createElement('span');
    countEl.className = 'tlr-section-count text-details';
    countEl.textContent = (typeof count === 'number' && count > 0) ? `${count}` : '0';

    header.appendChild(toggleBtn);
    header.appendChild(countEl);

    if (extraHeaderContent instanceof HTMLElement) {
      header.appendChild(extraHeaderContent);
    }

    block.appendChild(header);

    const bodyEl = document.createElement('div');
    bodyEl.className = 'tlr-section-body';
    block.appendChild(bodyEl);

    return block;
  }

  buildLinkAllButton() {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'tlr-link-all-btn button-none button-small button-minimal-hover';
    btn.dataset.action = 'link-all-unlinked';
    btn.title = 'Convert all unlinked mentions to linked references';
    btn.textContent = 'Link All';
    return btn;
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

  appendPropertyReferenceGroups(container, groups, opts) {
    if (!container) return;

    const query = (opts?.query || '').trim();

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
        recsEl.appendChild(btn);
      }

      groupEl.appendChild(header);
      groupEl.appendChild(recsEl);
      container.appendChild(groupEl);
    }
  }

  appendLinkedReferenceGroups(container, groups, opts) {
    if (!container) return;

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

      const isCollapsed = this.isRecordGroupCollapsed(recordGuid);

      const groupEl = document.createElement('div');
      groupEl.className = 'tlr-group';
      groupEl.dataset.recordGuid = recordGuid;
      if (isCollapsed) groupEl.classList.add('tlr-group-collapsed');

      const header = document.createElement('div');
      header.className = 'tlr-group-header-pill button-normal button-normal-hover';
      header.dataset.action = 'toggle-record-group';
      header.dataset.recordGuid = recordGuid;
      header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

      const caret = document.createElement('span');
      caret.className = 'tlr-group-caret';
      caret.setAttribute('aria-hidden', 'true');

      const titleBtn = document.createElement('span');
      titleBtn.className = 'tlr-group-title-btn';
      titleBtn.dataset.action = 'open-record';
      titleBtn.dataset.recordGuid = recordGuid;

      const groupTitle = document.createElement('div');
      groupTitle.className = 'tlr-group-title';
      groupTitle.textContent = record.getName?.() || 'Untitled';
      titleBtn.appendChild(groupTitle);

      const groupMeta = document.createElement('div');
      groupMeta.className = 'tlr-group-meta text-details';
      groupMeta.textContent = `${g.lines?.length || 0}`;

      header.appendChild(caret);
      header.appendChild(titleBtn);
      header.appendChild(groupMeta);

      const linesEl = document.createElement('div');
      linesEl.className = 'tlr-lines';

      for (const line of g.lines || []) {
        const ctx = opts?.treeContextMap?.get?.(line.guid) || null;
        const ancestors = ctx?.ancestors || [];
        const descendants = ctx?.descendants || [];

        const blockEl = document.createElement('div');
        blockEl.className = 'tlr-line-block';

        if (ancestors.length > 0) {
          const breadcrumbsEl = document.createElement('div');
          breadcrumbsEl.className = 'tlr-breadcrumbs text-details';
          
          for (let i = ancestors.length - 1; i >= 0; i--) {
            const anc = ancestors[i];
            const ancEl = document.createElement('span');
            ancEl.className = 'tlr-breadcrumb-item';
            this.appendSegments(ancEl, anc.segments || [], query);
            breadcrumbsEl.appendChild(ancEl);
            if (i > 0) {
              const sep = document.createElement('span');
              sep.className = 'tlr-breadcrumb-sep';
              sep.textContent = ' > ';
              breadcrumbsEl.appendChild(sep);
            }
          }
          blockEl.appendChild(breadcrumbsEl);
        }

        const lineEl = document.createElement('button');
        lineEl.type = 'button';
        lineEl.className = 'tlr-line button-none button-minimal-hover';
        lineEl.dataset.action = 'open-line';
        lineEl.dataset.recordGuid = recordGuid;
        lineEl.dataset.lineGuid = line.guid;

        const ignored = this.isLineSharedIgnored(line);
        if (ignored) lineEl.classList.add('tlr-line-ignored');
        lineEl.title = ignored
          ? 'Alt+Click to include this reference again'
          : 'Alt+Click to ignore this reference in shared counts';

        const prefix = this.getLinePrefix(line);
        if (prefix) {
          const p = document.createElement('span');
          p.className = 'tlr-prefix';
          p.textContent = prefix;
          lineEl.appendChild(p);
        }

        const content = document.createElement('span');
        content.className = 'tlr-line-content';
        this.appendSegments(content, line.segments || [], query);
        lineEl.appendChild(content);

        if (ignored) {
          lineEl.appendChild(document.createTextNode(' '));
          const ignoredFlag = document.createElement('span');
          ignoredFlag.className = 'tlr-line-ignored-flag text-details';
          ignoredFlag.textContent = 'Ignored';
          lineEl.appendChild(ignoredFlag);
        }

        blockEl.appendChild(lineEl);

        if (descendants.length > 0) {
          const descEl = document.createElement('div');
          descEl.className = 'tlr-descendants';
          
          // We need to calculate relative depth
          // Since descendants are in pre-order traversal and have parent_guid, we can compute depths.
          const depthMap = new Map();
          depthMap.set(line.guid, 0);

          for (const desc of descendants) {
            const parentGuid = desc.parent_guid || line.guid;
            const parentDepth = depthMap.get(parentGuid) ?? 0;
            const depth = parentDepth + 1;
            depthMap.set(desc.guid, depth);

            const dEl = document.createElement('div');
            dEl.className = 'tlr-descendant-line text-details';
            dEl.style.paddingLeft = `${depth * 16}px`;

            const dPrefix = this.getLinePrefix(desc);
            if (dPrefix) {
              const dp = document.createElement('span');
              dp.className = 'tlr-prefix';
              dp.textContent = dPrefix;
              dEl.appendChild(dp);
            }

            const dContent = document.createElement('span');
            dContent.className = 'tlr-line-content';
            this.appendSegments(dContent, desc.segments || [], query);
            dEl.appendChild(dContent);

            descEl.appendChild(dEl);
          }
          blockEl.appendChild(descEl);
        }

        linesEl.appendChild(blockEl);
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

  appendUnlinkedReferenceGroups(container, groups, opts) {
    if (!container) return;

    const query = (opts?.query || '').trim();

    for (const g of groups) {
      const record = g.record || null;
      const recordGuid = record?.guid || null;
      if (!recordGuid) continue;

      const isCollapsed = this.isRecordGroupCollapsed(recordGuid);

      const groupEl = document.createElement('div');
      groupEl.className = 'tlr-group';
      groupEl.dataset.recordGuid = recordGuid;
      if (isCollapsed) groupEl.classList.add('tlr-group-collapsed');

      const header = document.createElement('div');
      header.className = 'tlr-group-header-pill button-normal button-normal-hover';
      header.dataset.action = 'toggle-record-group';
      header.dataset.recordGuid = recordGuid;
      header.setAttribute('aria-expanded', isCollapsed ? 'false' : 'true');

      const caret = document.createElement('span');
      caret.className = 'tlr-group-caret';
      caret.setAttribute('aria-hidden', 'true');

      const titleBtn = document.createElement('span');
      titleBtn.className = 'tlr-group-title-btn';
      titleBtn.dataset.action = 'open-record';
      titleBtn.dataset.recordGuid = recordGuid;

      const groupTitle = document.createElement('div');
      groupTitle.className = 'tlr-group-title';
      groupTitle.textContent = record.getName?.() || 'Untitled';
      titleBtn.appendChild(groupTitle);

      const groupMeta = document.createElement('div');
      groupMeta.className = 'tlr-group-meta text-details';
      groupMeta.textContent = `${g.lines?.length || 0}`;

      header.appendChild(caret);
      header.appendChild(titleBtn);
      header.appendChild(groupMeta);

      const linesEl = document.createElement('div');
      linesEl.className = 'tlr-lines';

      for (const line of g.lines || []) {
        const ctx = opts?.treeContextMap?.get?.(line.guid) || null;
        const ancestors = ctx?.ancestors || [];

        const blockEl = document.createElement('div');
        blockEl.className = 'tlr-line-block';

        if (ancestors.length > 0) {
          const breadcrumbsEl = document.createElement('div');
          breadcrumbsEl.className = 'tlr-breadcrumbs text-details';
          for (let i = ancestors.length - 1; i >= 0; i--) {
            const anc = ancestors[i];
            const ancEl = document.createElement('span');
            ancEl.className = 'tlr-breadcrumb-item';
            this.appendSegments(ancEl, anc.segments || [], query);
            breadcrumbsEl.appendChild(ancEl);
            if (i > 0) {
              const sep = document.createElement('span');
              sep.className = 'tlr-breadcrumb-sep';
              sep.textContent = ' > ';
              breadcrumbsEl.appendChild(sep);
            }
          }
          blockEl.appendChild(breadcrumbsEl);
        }

        const lineRow = document.createElement('div');
        lineRow.className = 'tlr-unlinked-line-row';

        const lineEl = document.createElement('button');
        lineEl.type = 'button';
        lineEl.className = 'tlr-line button-none button-minimal-hover';
        lineEl.dataset.action = 'open-line';
        lineEl.dataset.recordGuid = recordGuid;
        lineEl.dataset.lineGuid = line.guid;

        const prefix = this.getLinePrefix(line);
        if (prefix) {
          const p = document.createElement('span');
          p.className = 'tlr-prefix';
          p.textContent = prefix;
          lineEl.appendChild(p);
        }

        const content = document.createElement('span');
        content.className = 'tlr-line-content';
        this.appendSegments(content, line.segments || [], query);
        lineEl.appendChild(content);

        const linkBtn = document.createElement('button');
        linkBtn.type = 'button';
        linkBtn.className = 'tlr-link-btn button-none button-small button-minimal-hover';
        linkBtn.dataset.action = 'link-unlinked';
        linkBtn.dataset.lineGuid = line.guid;
        linkBtn.title = 'Convert this mention to a linked reference';
        linkBtn.textContent = 'Link';

        lineRow.appendChild(lineEl);
        lineRow.appendChild(linkBtn);
        blockEl.appendChild(lineRow);
        linesEl.appendChild(blockEl);
      }

      groupEl.appendChild(header);
      groupEl.appendChild(linesEl);
      container.appendChild(groupEl);
    }
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
        const textObj = typeof seg.text === 'string' ? { guid: seg.text } : (seg.text || {});
        const guid = textObj.guid || null;
        const title = textObj.title || (guid ? this.resolveRecordName(guid) : '') || '[link]';
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

    const phrases = (typeof query === 'string' ? query.trim() : '')
      .split(/\s+/).filter(Boolean).map(p => p.toLowerCase());

    if (phrases.length === 0) {
      container.appendChild(document.createTextNode(s));
      return;
    }

    const hayLower = s.toLowerCase();

    // Build a sorted list of [start, end] match ranges for all phrases
    const ranges = [];
    for (const needle of phrases) {
      let idx = 0;
      while (idx < s.length) {
        const next = hayLower.indexOf(needle, idx);
        if (next === -1) break;
        ranges.push([next, next + needle.length]);
        idx = next + needle.length;
      }
    }
    if (ranges.length === 0) {
      container.appendChild(document.createTextNode(s));
      return;
    }

    // Sort and merge overlapping ranges
    ranges.sort((a, b) => a[0] - b[0]);
    const merged = [ranges[0]];
    for (let i = 1; i < ranges.length; i++) {
      const last = merged[merged.length - 1];
      if (ranges[i][0] <= last[1]) {
        last[1] = Math.max(last[1], ranges[i][1]);
      } else {
        merged.push(ranges[i]);
      }
    }

    let pos = 0;
    for (const [start, end] of merged) {
      if (start > pos) container.appendChild(document.createTextNode(s.slice(pos, start)));
      const mark = document.createElement('mark');
      mark.className = 'tlr-search-mark';
      mark.textContent = s.slice(start, end);
      container.appendChild(mark);
      pos = end;
    }
    if (pos < s.length) container.appendChild(document.createTextNode(s.slice(pos)));
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
        const textObj = typeof seg.text === 'string' ? { guid: seg.text } : (seg.text || {});
        const guid = textObj.guid || null;
        if (!guid) continue;
        const el = document.createElement('span');
        el.className = 'tlr-seg-ref';
        el.dataset.action = 'open-ref';
        el.dataset.refGuid = guid;

        const title = textObj.title || this.resolveRecordName(guid) || '[link]';
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
    const name = rec?.getName?.() || null;
    if (name) return name;
    const fromCache = this._collectionRecordNameCache?.get?.(guid) || null;
    if (fromCache) return fromCache;
    return `[Unknown: ${guid}]`;
  }

  async rebuildCollectionRecordNameCache() {
    const cache = new Map();
    try {
      const collections = await this.data.getAllCollections?.() || [];
      for (const col of collections) {
        try {
          const records = await col.getAllRecords?.() || [];
          for (const r of records) {
            const g = r?.guid || null;
            if (!g) continue;
            const n = r?.getName?.() || null;
            if (n) cache.set(g, n);
          }
        } catch (e) {
          // ignore individual collection errors
        }
      }
    } catch (e) {
      // ignore
    }
    this._collectionRecordNameCache = cache;
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
        gap: 8px;
        min-height: 30px;
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

      .tlr-sort-open .tlr-sort-menu {
        display: block;
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
        display: none;
        align-items: center;
        gap: 6px;
        padding: 0 8px;
        height: 30px;
        min-height: 30px;
        border: 1px solid var(--input-border-color, var(--divider-color, var(--cmdpal-border-color, var(--border-subtle, rgba(0, 0, 0, 0.12)))));
        border-radius: 3px;
        background: var(--input-bg-color, var(--cmdpal-input-bg-color, var(--bg-panel, transparent)));
        box-sizing: border-box;
      }

      .tlr-search-open .tlr-search-wrap { display: flex; }
      .tlr-search-open .tlr-search-toggle { display: none; }

      .tlr-search-icon {
        display: flex;
        align-items: center;
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
      }

      .tlr-search-input {
        width: clamp(150px, 22vw, 260px);
        max-width: none;
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

      .tlr-chips-row {
        display: none;
        flex-wrap: wrap;
        align-items: center;
        gap: 4px;
        padding: 4px 10px;
        border-bottom: 1px solid var(--divider-color, var(--border-subtle, rgba(0,0,0,0.08)));
        background: var(--bg-panel, transparent);
      }

      .tlr-chip {
        display: inline-flex;
        align-items: center;
        gap: 2px;
        padding: 2px 4px 2px 8px;
        border-radius: 10px;
        background: var(--accent, var(--link-color, #4a90d9));
        color: #fff;
        font-size: 11px;
        line-height: 16px;
        white-space: nowrap;
      }

      .tlr-chip-label {
        max-width: 120px;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tlr-chip-remove {
        display: inline-flex;
        align-items: center;
        justify-content: center;
        width: 14px;
        height: 14px;
        border-radius: 50%;
        font-size: 13px;
        line-height: 1;
        color: rgba(255,255,255,0.8);
        cursor: pointer;
        padding: 0;
      }

      .tlr-chip-remove:hover {
        color: #fff;
        background: rgba(0,0,0,0.2);
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

      .tlr-section-block {
        margin-top: 6px;
      }

      .tlr-section-block + .tlr-section-block {
        margin-top: 2px;
        padding-top: 6px;
        border-top: 1px solid var(--divider-color, var(--border-subtle, rgba(0, 0, 0, 0.12)));
      }

      .tlr-section-header {
        display: flex;
        align-items: center;
        gap: 6px;
        min-height: 30px;
      }

      .tlr-section-toggle {
        display: inline-flex;
        align-items: center;
        gap: 6px;
        padding: 3px 6px;
      }

      .tlr-section-caret {
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

      .tlr-section-collapsed .tlr-section-caret {
        transform: rotate(0deg);
      }

      .tlr-section-label {
        font-size: 12px;
        font-weight: 650;
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        text-transform: uppercase;
        letter-spacing: 0.04em;
        white-space: nowrap;
      }

      .tlr-section-count {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        font-size: 11px;
        font-variant-numeric: tabular-nums;
        opacity: 0.8;
      }

      .tlr-section-body {
        display: block;
      }

      .tlr-section-collapsed .tlr-section-body {
        display: none;
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

      .tlr-group-header-pill {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 10px;
        width: 100%;
        padding: 8px 10px;
        text-align: left;
        cursor: pointer;
      }

      .tlr-group-caret {
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

      .tlr-group-collapsed .tlr-group-caret {
        transform: rotate(0deg);
      }

      .tlr-group-collapsed .tlr-lines {
        display: none;
      }

      .tlr-group-title-btn {
        flex: 1 1 auto;
        min-width: 0;
        display: flex;
        align-items: center;
        padding: 0;
        margin: 0;
        cursor: pointer;
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
        margin-left: auto;
      }

      .tlr-lines { margin-top: 8px; display: flex; flex-direction: column; gap: 12px; }

      .tlr-line-block {
        display: flex;
        flex-direction: column;
        gap: 4px;
        width: 100%;
      }

      .tlr-breadcrumbs {
        font-size: 12px;
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        opacity: 0.8;
        padding: 0 10px;
        display: flex;
        align-items: center;
        flex-wrap: wrap;
        gap: 2px;
      }

      .tlr-breadcrumb-item {
        white-space: nowrap;
        overflow: hidden;
        text-overflow: ellipsis;
        max-width: 200px;
      }

      .tlr-breadcrumb-sep {
        opacity: 0.5;
        margin: 0 2px;
      }

      .tlr-descendants {
        display: flex;
        flex-direction: column;
        gap: 2px;
        padding-top: 2px;
      }

      .tlr-descendant-line {
        padding: 2px 10px;
        font-size: 12px;
        opacity: 0.8;
        display: flex;
        align-items: flex-start;
      }

      .tlr-line {
        display: block;
        width: 100%;
        padding: 4px 10px;
        text-align: left;
        color: var(--text, inherit);
        line-height: 1.35;
      }

      .tlr-line.tlr-line-ignored {
        opacity: 0.62;
      }

      .tlr-prefix {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
      }

      .tlr-line-content {
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.45;
      }

      .tlr-line-ignored-flag {
        margin-left: 6px;
        font-size: 11px;
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

      .tlr-unlinked-line-row {
        display: flex;
        align-items: flex-start;
        gap: 4px;
      }

      .tlr-unlinked-line-row > .tlr-line {
        flex: 1 1 auto;
        min-width: 0;
      }

      .tlr-link-btn {
        flex: 0 0 auto;
        color: var(--ed-link-color, var(--link-color, var(--accent, inherit)));
        font-size: 12px;
        padding: 4px 8px;
        white-space: nowrap;
        opacity: 0.7;
        transition: opacity 120ms ease;
      }

      .tlr-link-btn:hover {
        opacity: 1;
        text-decoration: underline;
      }

      .tlr-link-all-btn {
        margin-left: auto;
        color: var(--ed-link-color, var(--link-color, var(--accent, inherit)));
        font-size: 12px;
        padding: 2px 8px;
        white-space: nowrap;
        opacity: 0.7;
        transition: opacity 120ms ease;
      }

      .tlr-link-all-btn:hover {
        opacity: 1;
        text-decoration: underline;
      }

      .tlr-loading .tlr-search-toggle { opacity: 0.6; cursor: default; }
      .tlr-loading .tlr-sort-toggle { opacity: 0.6; cursor: default; }

      @media (max-width: 760px) {
        .tlr-header {
          flex-wrap: wrap;
          row-gap: 8px;
        }

        .tlr-sort-menu {
          right: auto;
          left: 0;
          min-width: 240px;
          max-width: min(92vw, 320px);
        }

        .tlr-search-input {
          width: min(58vw, 220px);
          max-width: none;
        }
      }
    `);
  }
}
