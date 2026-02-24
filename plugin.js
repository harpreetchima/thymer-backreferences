class Plugin extends AppPlugin {
  onLoad() {
    // NOTE: Thymer strips top-level code outside the Plugin class.
    this._version = '0.3.3';
    this._pluginName = 'Backreferences';

    this._panelStates = new Map();
    this._eventHandlerIds = [];

    this._storageKeyCollapsed = 'thymer_backreferences_collapsed_v1';
    this._legacyStorageKeyCollapsed = 'thymer_backlinks_collapsed_v1';
    this._collapsed = this.loadCollapsedSetting();

    this._storageKeyPropGroupCollapsed = 'thymer_backreferences_prop_group_collapsed_v1';
    this._legacyStorageKeyPropGroupCollapsed = 'thymer_backlinks_prop_group_collapsed_v1';
    this._propGroupCollapsed = this.loadPropGroupCollapsedSetting();

    this._defaultSortBy = 'page_last_edited';
    this._defaultSortDir = 'desc';
    this._storageKeySortByRecord = 'thymer_backreferences_sort_by_record_v1';
    this._legacyStorageKeySortByRecord = 'thymer_backlinks_sort_by_record_v1';
    this._sortByRecord = this.loadSortByRecordSetting();

    this._defaultMaxResults = 200;
    this._refreshDebounceMs = 350;

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
        searchQuery: '',
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
      searchQuery: '',
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
    return (
      panelEl.querySelector?.('.page-content') ||
      panelEl.querySelector?.('.editor-wrapper') ||
      panelEl.querySelector?.('#editor') ||
      panelEl
    );
  }

  buildFooterRoot(state) {
    const root = document.createElement('div');
    root.className = 'tlr-footer';
    root.dataset.panelId = state.panelId;

    const header = document.createElement('div');
    header.className = 'tlr-header';

    const toggleBtn = document.createElement('button');
    toggleBtn.className = 'tlr-btn tlr-toggle';
    toggleBtn.type = 'button';
    toggleBtn.dataset.action = 'toggle';
    toggleBtn.title = 'Collapse/expand';
    toggleBtn.textContent = this._collapsed ? '+' : '-';

    const title = document.createElement('div');
    title.className = 'tlr-title';
    title.textContent = 'Backreferences';

    const count = document.createElement('div');
    count.className = 'tlr-count';
    count.dataset.role = 'count';
    count.textContent = '';

    const spacer = document.createElement('div');
    spacer.className = 'tlr-spacer';

    const searchToggle = document.createElement('button');
    searchToggle.className = 'tlr-btn tlr-search-toggle';
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
    searchWrap.className = 'tlr-search-wrap';

    const searchIcon = document.createElement('div');
    searchIcon.className = 'tlr-search-icon';
    try {
      searchIcon.appendChild(this.ui.createIcon('ti-search'));
    } catch (e) {
      searchIcon.textContent = 'Search';
    }

    const input = document.createElement('input');
    input.className = 'tlr-search-input';
    input.type = 'text';
    input.placeholder = 'Filter references...';
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
          this.renderFromCache(state);
        } else {
          this.setSearchOpen(state, false);
        }
      }
    });

    input.addEventListener('input', () => {
      state.searchQuery = input.value;
      this.renderFromCache(state);
    });

    const clearBtn = document.createElement('button');
    clearBtn.className = 'tlr-search-clear';
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
    sortToggle.className = 'tlr-btn tlr-sort-toggle';
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
    sortMenu.className = 'tlr-sort-menu';
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

    if (action === 'clear-search') {
      if (!state) return;
      const q = (state.searchQuery || '').trim();
      if (q) {
        state.searchQuery = '';
        if (state.searchInputEl) state.searchInputEl.value = '';
        this.renderFromCache(state);
        // Keep the input open for continued searching.
        this.setSearchOpen(state, true);
      } else {
        this.setSearchOpen(state, false);
      }
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
    title.className = 'tlr-sort-menu-title';
    title.textContent = 'Sort By';
    menu.appendChild(title);

    for (const option of this.getSortOptions()) {
      const row = document.createElement('button');
      row.type = 'button';
      row.className = 'tlr-sort-option';
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
    ascBtn.className = 'tlr-sort-dir-btn';
    ascBtn.dataset.action = 'set-sort-dir';
    ascBtn.dataset.sortDir = 'asc';
    ascBtn.textContent = 'Ascending';
    if (sortDir === 'asc') ascBtn.classList.add('is-active');

    const descBtn = document.createElement('button');
    descBtn.type = 'button';
    descBtn.className = 'tlr-sort-dir-btn';
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
        document.removeEventListener('mousedown', state.sortMenuDismissHandler, true);
      } catch (e) {
        // ignore
      }
      state.sortMenuDismissHandler = null;
    }

    this.syncSortControlState(state);

    if (state.sortMenuOpen !== true) return;

    const onOutsideMouseDown = (ev) => {
      const root = state.rootEl || null;
      if (!root || !root.isConnected) {
        this.setSortMenuOpen(state, false);
        return;
      }

      if (root.contains(ev.target)) return;
      this.setSortMenuOpen(state, false);
    };

    state.sortMenuDismissHandler = onOutsideMouseDown;
    try {
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

    const cfg = this.getConfiguration?.() || {};
    return cfg.custom?.collapsedByDefault === true;
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

  // ---------- Refresh orchestration ----------

  scheduleRefreshForPanel(panel, { force, reason }) {
    const panelId = panel?.getId?.() || null;
    if (!panelId) return;
    const state = this._panelStates.get(panelId) || null;
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

    const query = `@linkto = "${recordGuid}"`;
    const [searchSettled, propSettled] = await Promise.allSettled([
      this.data.searchByQuery(query, maxResults),
      this.getPropertyBacklinkGroups(record, recordGuid, { showSelf })
    ]);

    // Ignore stale refreshes.
    if (!this._panelStates.has(panelId) || state.refreshSeq !== seq) return;

    let linkedError = '';
    let linkedGroups = [];
    if (searchSettled.status === 'fulfilled') {
      const result = searchSettled.value;
      if (result?.error) {
        linkedError = result.error;
      } else {
        const lines = Array.isArray(result?.lines) ? result.lines : [];
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

    state.lastResults = {
      propertyGroups,
      propertyError,
      linkedGroups,
      linkedError,
      maxResults
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
    if (!ev?.hasSegments?.() || typeof ev.getSegments !== 'function') return;

    const segments = ev.getSegments() || [];
    const referenced = this.extractReferencedRecordGuids(segments);
    if (referenced.size === 0) return;

    for (const state of this._panelStates.values()) {
      const panel = state?.panel || null;
      if (!panel) continue;
      if (!state.recordGuid) continue;
      if (!referenced.has(state.recordGuid)) continue;
      this.scheduleRefreshForPanel(panel, { force: false, reason: 'lineitem.updated' });
    }
  }

  handleLineItemDeleted() {
    // We don't know which record(s) were referenced by the deleted item.
    // This is rare, so we just refresh all visible footers (debounced).
    this.refreshAllPanels({ force: false, reason: 'lineitem.deleted' });
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

  renderReferences(state, { propertyGroups, propertyError, linkedGroups, linkedError, maxResults }) {
    if (!state?.bodyEl || !state?.countEl) return;

    const body = state.bodyEl;
    body.innerHTML = '';

    const query = (state.searchQuery || '').trim();
    const queryLower = query.toLowerCase();

    const propsAll = Array.isArray(propertyGroups) ? propertyGroups : [];
    const linkedAll = Array.isArray(linkedGroups) ? linkedGroups : [];

    const totalPropRefCount = propsAll.reduce((n, g) => n + (g?.records?.length || 0), 0);
    const totalLinkedRefCount = linkedAll.reduce((n, g) => n + (g?.lines?.length || 0), 0);

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

    let props = propsAll;
    let linked = linkedAll;

    if (queryLower) {
      const nextProps = [];
      for (const g of propsAll) {
        const propertyName = (g?.propertyName || '').trim();
        if (!propertyName) continue;
        const recs = (g?.records || []).filter((r) => {
          const name = (r?.getName?.() || '').toLowerCase();
          return name.includes(queryLower);
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
          const text = this.segmentsToPlainText(line?.segments || []);
          return text.toLowerCase().includes(queryLower);
        });
        if (lines.length > 0) nextLinked.push({ record, lines });
      }
      linked = nextLinked;
    }

    const filteredPropRefCount = props.reduce((n, g) => n + (g?.records?.length || 0), 0);
    const filteredLinkedRefCount = linked.reduce((n, g) => n + (g?.lines?.length || 0), 0);

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

    const sortSpec = {
      sortBy: this.normalizeSortBy(state?.sortBy) || this._defaultSortBy,
      sortDir: this.normalizeSortDir(state?.sortDir) || this._defaultSortDir
    };
    const sortMetrics = this.computeRecordSortMetrics(props, linked);
    props = this.sortPropertyGroupsForRender(props, sortSpec, sortMetrics);
    linked = this.sortLinkedGroupsForRender(linked, sortSpec, sortMetrics);

    const parts = [];
    if (queryLower) {
      const shortQuery = query.length > 24 ? `${query.slice(0, 24)}...` : query;
      parts.push(`Filter: "${shortQuery}"`);
      if (totalUniquePages.size > 0) parts.push(`${filteredUniquePages.size}/${totalUniquePages.size} pages`);
      if (totalPropRefCount > 0) parts.push(`${filteredPropRefCount}/${totalPropRefCount} prop refs`);
      if (totalLinkedRefCount > 0) parts.push(`${filteredLinkedRefCount}/${totalLinkedRefCount} line refs`);
    } else {
      if (totalUniquePages.size > 0) parts.push(`${totalUniquePages.size} page${totalUniquePages.size === 1 ? '' : 's'}`);
      if (totalPropRefCount > 0) parts.push(`${totalPropRefCount} prop ref${totalPropRefCount === 1 ? '' : 's'}`);
      if (totalLinkedRefCount > 0) parts.push(`${totalLinkedRefCount} line ref${totalLinkedRefCount === 1 ? '' : 's'}`);
    }
    state.countEl.textContent = parts.join(' | ');

    this.appendSectionTitle(body, 'Property References');
    if (propertyError) {
      this.appendError(body, propertyError);
    } else if (props.length === 0) {
      this.appendEmpty(body, queryLower ? 'No matching property references.' : 'No property references.');
    } else {
      this.appendPropertyReferenceGroups(body, props, { query });
    }

    const divider = document.createElement('div');
    divider.className = 'tlr-divider';
    body.appendChild(divider);
    this.appendSectionTitle(body, 'Linked References');

    if (linkedError) {
      this.appendError(body, linkedError);
      return;
    }

    this.appendLinkedReferenceGroups(body, linked, {
      maxResults,
      query,
      totalLineCount: totalLinkedRefCount,
      emptyMessage: queryLower ? 'No matching linked references.' : 'No linked references.'
    });
  }

  appendSectionTitle(container, text) {
    if (!container) return;
    const el = document.createElement('div');
    el.className = 'tlr-section-title';
    el.textContent = text || '';
    container.appendChild(el);
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
      header.className = 'tlr-prop-header';
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
      meta.className = 'tlr-prop-meta';
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
        btn.className = 'tlr-prop-record';
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

      const groupEl = document.createElement('div');
      groupEl.className = 'tlr-group';

      const header = document.createElement('button');
      header.type = 'button';
      header.className = 'tlr-group-header';
      header.dataset.action = 'open-record';
      header.dataset.recordGuid = recordGuid;

      const title = document.createElement('div');
      title.className = 'tlr-group-title';
      title.textContent = record.getName?.() || 'Untitled';

      const meta = document.createElement('div');
      meta.className = 'tlr-group-meta';
      meta.textContent = `${g.lines.length}`;

      header.appendChild(title);
      header.appendChild(meta);

      const linesEl = document.createElement('div');
      linesEl.className = 'tlr-lines';

      for (const line of g.lines || []) {
        const lineEl = document.createElement('button');
        lineEl.type = 'button';
        lineEl.className = 'tlr-line';
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

        linesEl.appendChild(lineEl);
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
        margin-top: 24px;
        padding-top: 16px;
        border-top: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.12));
        color: var(--text, inherit);
        font-size: 13px;
      }

      .tlr-header {
        display: flex;
        align-items: center;
        gap: 8px;
        min-height: 30px;
        margin-bottom: 12px;
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
        border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.12));
        background: var(--bg-panel, transparent);
        color: var(--text, inherit);
        padding: 4px 8px;
        border-radius: 8px;
        cursor: pointer;
        font-size: 12px;
        line-height: 1;
        min-height: 30px;
        box-sizing: border-box;
      }

      .tlr-btn:hover {
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
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
        padding: 8px;
        border-radius: 12px;
        border: 1px solid var(--cmdpal-border-color, var(--border-subtle, rgba(0, 0, 0, 0.12)));
        background: var(--cmdpal-bg-color, var(--bg-panel, rgba(22, 26, 24, 0.96)));
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.18);
        z-index: 20;
      }

      .tlr-sort-open .tlr-sort-menu {
        display: block;
      }

      .tlr-sort-menu-title {
        font-size: 11px;
        font-weight: 700;
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        text-transform: uppercase;
        letter-spacing: 0.04em;
        margin: 2px 4px 6px;
      }

      .tlr-sort-option {
        width: 100%;
        border: 1px solid transparent;
        border-radius: 9px;
        background: transparent;
        color: var(--text, inherit);
        padding: 8px 12px;
        display: flex;
        align-items: center;
        line-height: 1.35;
        text-align: left;
        cursor: pointer;
      }

      .tlr-sort-option:hover {
        background: var(--cmdpal-hover-bg-color, var(--bg-hover, rgba(0, 0, 0, 0.04)));
      }

      .tlr-sort-option.is-active {
        border-color: var(--cmdpal-selected-bg-color, var(--cmdpal-border-color, var(--border-subtle, rgba(0, 0, 0, 0.12))));
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
        gap: 10px;
      }

      .tlr-sort-dir-btn {
        flex: 1 1 auto;
        border: 1px solid var(--cmdpal-border-color, var(--border-subtle, rgba(0, 0, 0, 0.12)));
        border-radius: 8px;
        background: transparent;
        color: var(--text, inherit);
        padding: 7px 10px;
        cursor: pointer;
        text-align: center;
        min-height: 30px;
      }

      .tlr-sort-dir-btn:hover {
        background: var(--cmdpal-hover-bg-color, var(--bg-hover, rgba(0, 0, 0, 0.04)));
      }

      .tlr-sort-dir-btn.is-active {
        background: var(--cmdpal-selected-bg-color, var(--bg-hover, rgba(0, 0, 0, 0.04)));
        color: var(--cmdpal-selected-fg-color, var(--text, inherit));
        border-color: var(--cmdpal-selected-bg-color, var(--cmdpal-border-color, var(--border-subtle, rgba(0, 0, 0, 0.12))));
      }

      .tlr-search-wrap {
        display: none;
        align-items: center;
        gap: 8px;
        padding: 0 10px;
        height: 30px;
        min-height: 30px;
        border: 1px solid var(--cmdpal-border-color, var(--border-subtle, rgba(0, 0, 0, 0.12)));
        border-radius: 10px;
        background: var(--cmdpal-bg-color, var(--bg-panel, transparent));
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
        color: var(--text, inherit);
        font-size: 12px;
        line-height: 20px;
      }

      .tlr-search-input::placeholder {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
      }

      .tlr-search-clear {
        border: 0;
        outline: none;
        background: transparent;
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        cursor: pointer;
        padding: 2px 8px;
        border-radius: 8px;
      }

      .tlr-search-clear:hover {
        background: var(--cmdpal-hover-bg-color, var(--bg-hover, rgba(0, 0, 0, 0.04)));
        color: var(--text, inherit);
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
      }

      .tlr-section-title {
        margin-top: 16px;
        margin-bottom: 8px;
        font-size: 11px;
        font-weight: 700;
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        text-transform: uppercase;
        letter-spacing: 0.04em;
      }

      .tlr-divider {
        margin: 14px 0 10px;
        border-top: 2px solid var(--border-subtle, rgba(0, 0, 0, 0.12));
      }

      .tlr-prop-group { margin: 12px 0 16px; }

      .tlr-prop-header {
        display: flex;
        align-items: center;
        justify-content: flex-start;
        gap: 10px;
        width: 100%;
        padding: 8px 10px;
        border-radius: 10px;
        border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.12));
        background: var(--bg-panel, transparent);
        cursor: pointer;
        text-align: left;
      }

      .tlr-prop-header:hover {
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
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
        white-space: nowrap;
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
        width: 100%;
        border: 1px solid transparent;
        background: transparent;
        padding: 8px 10px;
        border-radius: 10px;
        cursor: pointer;
        text-align: left;
        color: var(--ed-link-color, var(--link-color, var(--accent, inherit)));
        line-height: 1.4;
      }

      .tlr-prop-record:hover {
        border-color: var(--border-subtle, rgba(0, 0, 0, 0.12));
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
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
        border-radius: 10px;
        border: 1px solid var(--border-subtle, rgba(0, 0, 0, 0.12));
        background: var(--bg-panel, transparent);
        cursor: pointer;
        text-align: left;
      }

      .tlr-group-header:hover {
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
      }

      .tlr-group-title {
        font-weight: 600;
        overflow: hidden;
        text-overflow: ellipsis;
        white-space: nowrap;
      }

      .tlr-group-meta {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
        font-size: 12px;
        flex: 0 0 auto;
      }

      .tlr-lines { margin-top: 8px; display: flex; flex-direction: column; gap: 6px; }

      .tlr-line {
        width: 100%;
        border: 1px solid transparent;
        background: transparent;
        padding: 8px 10px;
        border-radius: 10px;
        cursor: pointer;
        text-align: left;
        color: var(--text, inherit);
        line-height: 1.35;
      }

      .tlr-line:hover {
        border-color: var(--border-subtle, rgba(0, 0, 0, 0.12));
        background: var(--bg-hover, rgba(0, 0, 0, 0.04));
      }

      .tlr-prefix {
        color: var(--text-muted, rgba(0, 0, 0, 0.6));
      }

      .tlr-line-content {
        white-space: pre-wrap;
        word-break: break-word;
        line-height: 1.45;
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
      .tlr-seg-hashtag { color: var(--accent, #2b6cb0); }
      .tlr-seg-datetime { color: var(--accent, #2b6cb0); }
      .tlr-seg-mention { color: var(--accent, #2b6cb0); }
      .tlr-seg-ref { color: var(--ed-link-color, var(--link-color, var(--accent, inherit))); cursor: pointer; text-decoration: underline; }
      .tlr-seg-ref:hover { color: var(--ed-link-hover-color, var(--link-hover-color, var(--ed-link-color, var(--link-color, var(--accent, inherit))))); }

      .tlr-search-mark {
        background: var(--ed-selection-self-bg, var(--selection-bg, rgba(255, 217, 61, 0.35)));
        color: inherit;
        padding: 0 1px;
        border-radius: 4px;
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
