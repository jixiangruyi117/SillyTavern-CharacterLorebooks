import {
    buildLorebookIndexAsync,
    createLorebookOwnershipFingerprint,
    createCharacterScopedGlobalSelectionPlan,
    filterLorebookRecords,
    projectLorebookIndex,
} from './modules/LorebookIndex.js?v=0.2.4';
import { world_info } from '../../../world-info.js';

const EXTENSION_FOLDER = 'third-party/SillyTavern-CharacterLorebooks';
const SETTINGS_KEY = 'srlCharacterLorebooks';
const ROOT_ID = 'srl-character-lorebooks';
const DEFAULT_SETTINGS = Object.freeze({ scope: 'current', query: '' });
const SEARCH_DELAY_MS = 150;
const INDEX_REBUILD_DELAY_MS = 160;
const INDEX_CHUNK_SIZE = 250;
const PAGE_SIZE = 40;

let eventBindings = [];
let cleanupConfirmation = null;
let catalog = null;
let catalogRebuilding = false;
let rebuildTimer = 0;
let rebuildVersion = 0;
let searchTimer = 0;
let listPage = 1;

function escapeHtml(value) {
    return String(value ?? '').replace(/[&<>'"]/gu, character => ({
        '&': '&amp;', '<': '&lt;', '>': '&gt;', "'": '&#39;', '"': '&quot;',
    })[character]);
}

function getContext() {
    return globalThis.SillyTavern?.getContext?.() ?? null;
}

function getSettings(context) {
    const source = context.extensionSettings?.[SETTINGS_KEY] ?? {};
    const settings = {
        scope: ['current', 'public', 'all'].includes(source.scope) ? source.scope : DEFAULT_SETTINGS.scope,
        query: String(source.query ?? ''),
    };
    context.extensionSettings[SETTINGS_KEY] = settings;
    return settings;
}

function saveSettings(context, settings) {
    context.extensionSettings[SETTINGS_KEY] = settings;
    context.saveSettingsDebounced?.();
}

function getIndex(context) {
    return catalog ? projectLorebookIndex(catalog, context.characterId) : null;
}

function getCatalogBuildOptions(context, settings = getSettings(context)) {
    return {
        worldNames: context.getWorldInfoNames?.() ?? [],
        characters: context.characters ?? [],
        charLore: world_info?.charLore ?? [],
        activeGlobalNames: world_info?.globalSelect ?? [],
        chatLoreName: context.chatMetadata?.world_info ?? '',
        personaLoreName: context.powerUserSettings?.persona_description_lorebook ?? '',
        currentCharacterId: null,
    };
}

function yieldToBrowser() {
    return new Promise(resolve => {
        if (typeof globalThis.requestIdleCallback === 'function') {
            globalThis.requestIdleCallback(() => resolve(), { timeout: 120 });
            return;
        }
        setTimeout(resolve, 0);
    });
}

function scheduleCatalogRebuild({ immediate = false } = {}) {
    clearTimeout(rebuildTimer);
    const version = ++rebuildVersion;
    catalogRebuilding = true;
    if (document.getElementById(ROOT_ID)) render();
    rebuildTimer = setTimeout(async () => {
        try {
            const context = getContext();
            if (!context?.getWorldInfoNames) {
                if (version === rebuildVersion) catalogRebuilding = false;
                return;
            }
            const nextCatalog = await buildLorebookIndexAsync(getCatalogBuildOptions(context), { chunkSize: INDEX_CHUNK_SIZE, yieldToMain: yieldToBrowser });
            if (version !== rebuildVersion) return;
            catalog = nextCatalog;
            catalogRebuilding = false;
            listPage = 1;
            render();
        } catch (error) {
            if (version !== rebuildVersion) return;
            catalogRebuilding = false;
            globalThis.toastr?.error?.('世界书目录建立失败；酒馆原有设置没有被修改。', '角色世界书');
            console.error('[角色世界书] 目录建立失败', error);
            render();
        }
    }, immediate ? 0 : INDEX_REBUILD_DELAY_MS);
}

function getCurrentCharacterLabel(context, index) {
    if (index.currentCharacter) return index.currentCharacter.name;
    if (context.groupId) return '群聊（没有单一当前角色）';
    return '尚未选择角色';
}

function getRecordTags(record) {
    const tags = [];
    if (record.current) tags.push('<span class="srl-character-lorebooks__tag srl-character-lorebooks__tag--current">当前角色</span>');
    if (record.owners.length === 0) tags.push('<span class="srl-character-lorebooks__tag">公共</span>');
    if (new Set(record.owners.map(owner => owner.key)).size > 1) tags.push('<span class="srl-character-lorebooks__tag srl-character-lorebooks__tag--shared">共享</span>');
    if (record.globalActive) tags.push('<span class="srl-character-lorebooks__tag srl-character-lorebooks__tag--active">全局已启用</span>');
    if (record.chatActive) tags.push('<span class="srl-character-lorebooks__tag">聊天</span>');
    if (record.personaActive) tags.push('<span class="srl-character-lorebooks__tag">人设</span>');
    return tags.join('');
}

function renderRecord(record) {
    const ownerText = record.owners.length
        ? record.owners.map(owner => `${escapeHtml(owner.name)}${owner.type === 'additional' ? '（附加）' : ''}`).join('、')
        : '未绑定角色';
    return `<li class="srl-character-lorebooks__item">
        <div class="srl-character-lorebooks__item-main">
            <strong>${escapeHtml(record.name)}</strong>
            <span class="srl-character-lorebooks__tags">${getRecordTags(record)}</span>
            <small>${ownerText}</small>
        </div>
        <button class="menu_button srl-character-lorebooks__open" type="button" data-action="open-native" data-world-name="${escapeHtml(record.name)}" title="用酒馆原生编辑器打开" aria-label="编辑 ${escapeHtml(record.name)}">
            <i class="fa-solid fa-pen-to-square"></i>
        </button>
    </li>`;
}

function renderRecords(index, settings) {
    if (!index) {
        return '<div class="srl-character-lorebooks__records" data-role="records"><p class="srl-character-lorebooks__index-status"><i class="fa-solid fa-spinner fa-spin"></i> 正在分批整理世界书目录…</p></div>';
    }
    const records = filterLorebookRecords(index, settings.scope, settings.query);
    const unavailableHint = settings.scope === 'current' && !index.currentCharacter
        ? '<p class="srl-character-lorebooks__empty">当前没有可识别的单角色绑定。群聊请切到“全部”查看所有归属世界书。</p>'
        : records.length ? renderPagedRecords(records) : '<p class="srl-character-lorebooks__empty">这个范围没有世界书。</p>';
    const rebuildingHint = catalogRebuilding
        ? '<p class="srl-character-lorebooks__index-status"><i class="fa-solid fa-arrows-rotate fa-spin"></i> 正在后台更新目录，暂时显示上一次结果。</p>'
        : '';
    return `<div class="srl-character-lorebooks__records" data-role="records">${rebuildingHint}${unavailableHint}</div>`;
}

function renderPagedRecords(records) {
    const totalPages = Math.max(1, Math.ceil(records.length / PAGE_SIZE));
    listPage = Math.min(Math.max(listPage, 1), totalPages);
    const start = (listPage - 1) * PAGE_SIZE;
    const pageRecords = records.slice(start, start + PAGE_SIZE);
    const pager = totalPages > 1
        ? `<nav class="srl-character-lorebooks__pager" aria-label="世界书分页">
            <button type="button" class="menu_button" data-action="page-prev"${listPage === 1 ? ' disabled' : ''}><i class="fa-solid fa-chevron-left"></i> 上一页</button>
            <span>${listPage} / ${totalPages}</span>
            <button type="button" class="menu_button" data-action="page-next"${listPage === totalPages ? ' disabled' : ''}>下一页 <i class="fa-solid fa-chevron-right"></i></button>
        </nav>`
        : '';
    return `<p class="srl-character-lorebooks__list-meta">显示 ${start + 1}–${start + pageRecords.length} / ${records.length}</p>
        <ul class="srl-character-lorebooks__list">${pageRecords.map(renderRecord).join('')}</ul>${pager}`;
}

function isDrawerOpen(root) {
    const content = root.querySelector(':scope > .srl-character-lorebooks__drawer > .inline-drawer-content');
    return content instanceof HTMLElement ? getComputedStyle(content).display !== 'none' : null;
}

function restoreDrawerState(root, wasOpen) {
    if (wasOpen === null) return;
    const content = root.querySelector(':scope > .srl-character-lorebooks__drawer > .inline-drawer-content');
    const icon = root.querySelector(':scope > .srl-character-lorebooks__drawer > .inline-drawer-header .inline-drawer-icon');
    if (!(content instanceof HTMLElement) || !(icon instanceof HTMLElement)) return;
    content.style.display = wasOpen ? 'block' : 'none';
    icon.classList.toggle('up', wasOpen);
    icon.classList.toggle('down', !wasOpen);
    icon.classList.toggle('fa-circle-chevron-up', wasOpen);
    icon.classList.toggle('fa-circle-chevron-down', !wasOpen);
}

function refreshRecords() {
    const context = getContext();
    const root = document.getElementById(ROOT_ID);
    const target = root?.querySelector('[data-role="records"]');
    if (!context || !(target instanceof HTMLElement)) return;
    target.outerHTML = renderRecords(getIndex(context), getSettings(context));
}

function renderCleanupConfirmation() {
    if (!cleanupConfirmation) return '';
    const names = cleanupConfirmation.deactivate.map(escapeHtml).join('、');
    return `<div class="srl-character-lorebooks__cleanup-confirmation">
        <i class="fa-solid fa-circle-info"></i>
        <span>将关闭其他角色的全局启用：${names}。当前角色书仍由酒馆原生自动启用，公共书保持不变。</span>
        <div class="srl-character-lorebooks__confirmation-actions">
            <button type="button" class="menu_button" data-action="cancel-cleanup">取消</button>
            <button type="button" class="menu_button redWarningBG" data-action="confirm-cleanup">确认关闭 ${cleanupConfirmation.deactivate.length} 本</button>
        </div>
    </div>`;
}

function requestCharacterScopedCleanup() {
    const context = getContext();
    if (!context) return;
    const index = getIndex(context);
    if (!index) {
        globalThis.toastr?.info?.('世界书目录仍在整理，请稍后再试。', '角色世界书');
        return;
    }
    if (!index.currentCharacter) {
        globalThis.toastr?.warning?.('请先打开单角色聊天；群聊没有唯一的当前角色。', '角色世界书');
        return;
    }
    const plan = createCharacterScopedGlobalSelectionPlan(index);
    if (!plan.deactivate.length) {
        globalThis.toastr?.info?.('没有其他角色的世界书处于全局启用状态。', '角色世界书');
        return;
    }
    cleanupConfirmation = plan;
    render();
}

function getWorldNameForOption(option, names) {
    const index = Number(option.value);
    return Number.isInteger(index) && names[index] ? names[index] : option.textContent?.trim() ?? '';
}

function confirmCharacterScopedCleanup() {
    const context = getContext();
    const select = document.getElementById('world_info');
    if (!context || !(select instanceof HTMLSelectElement)) {
        globalThis.toastr?.warning?.('未识别到酒馆原生全局世界书选择器，未修改任何设置。', '角色世界书');
        return;
    }
    const index = getIndex(context);
    if (!index) {
        globalThis.toastr?.info?.('世界书目录仍在整理，请稍后再试。', '角色世界书');
        return;
    }
    const plan = createCharacterScopedGlobalSelectionPlan(index);
    if (!plan.deactivate.length) {
        cleanupConfirmation = null;
        globalThis.toastr?.info?.('全局启用列表已经没有其他角色世界书。', '角色世界书');
        render();
        return;
    }
    const keep = new Set(plan.keep);
    for (const option of select.options) option.selected = keep.has(getWorldNameForOption(option, context.getWorldInfoNames?.() ?? []));
    select.dispatchEvent(new Event('change', { bubbles: true }));
    cleanupConfirmation = null;
    globalThis.toastr?.success?.(`已关闭 ${plan.deactivate.length} 本其他角色世界书的全局启用。`, '角色世界书');
    setTimeout(render, 0);
}

function render({ focusQuery = false } = {}) {
    const context = getContext();
    const root = document.getElementById(ROOT_ID);
    if (!context || !root) return;
    const wasOpen = isDrawerOpen(root);
    const settings = getSettings(context);
    const index = getIndex(context);
    const displayIndex = index ?? {
        records: [],
        missingBindings: [],
        ownedCount: 0,
        publicCount: 0,
        sharedCount: 0,
        currentCharacter: null,
        diagnostics: { characterCount: 0, primaryBindingCount: 0, additionalBindingCount: 0, unownedCount: 0 },
    };
    const currentLabel = getCurrentCharacterLabel(context, displayIndex);
    const missing = displayIndex.missingBindings.length
        ? `<div class="srl-character-lorebooks__warning"><i class="fa-solid fa-circle-info"></i><span>发现 ${displayIndex.missingBindings.length} 个尚未存在的角色世界书：${displayIndex.missingBindings.map(item => escapeHtml(item.name)).join('、')}。若角色卡内嵌该世界书，进入聊天后按酒馆提示确认导入；若没有内嵌书，则这是原绑定已失效。插件不会自动创建或覆盖世界书。</span></div>`
        : '';

    root.innerHTML = `<div class="inline-drawer srl-character-lorebooks__drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-book-atlas"></i> 角色世界书 <span class="srl-character-lorebooks__count">${displayIndex.records.length}</span></b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <section class="srl-character-lorebooks__overview">
                <div><small>当前角色</small><strong>${escapeHtml(currentLabel)}</strong></div>
                <p>只整理酒馆已有绑定，不移动文件、不改全局启用状态，也不改变提示词装配。</p>
                <small>目录诊断：读取 ${displayIndex.diagnostics.characterCount} 个角色摘要，主绑定 ${displayIndex.diagnostics.primaryBindingCount}，附加 ${displayIndex.diagnostics.additionalBindingCount}，未归属 ${displayIndex.diagnostics.unownedCount}</small>
            </section>
            <div class="srl-character-lorebooks__summary" aria-label="世界书统计">
                <span><b>${displayIndex.ownedCount}</b> 角色归属</span><span><b>${displayIndex.publicCount}</b> 公共</span><span><b>${displayIndex.sharedCount}</b> 共享</span>
            </div>
            <div class="srl-character-lorebooks__controls">
                <label class="srl-character-lorebooks__scope">显示
                    <select data-field="scope" class="text_pole">
                        <option value="current"${settings.scope === 'current' ? ' selected' : ''}>当前角色</option>
                        <option value="public"${settings.scope === 'public' ? ' selected' : ''}>公共世界书</option>
                        <option value="all"${settings.scope === 'all' ? ' selected' : ''}>全部世界书</option>
                    </select>
                </label>
                <label class="srl-character-lorebooks__search"><span class="fa-solid fa-magnifying-glass"></span><input data-field="query" class="text_pole" type="search" value="${escapeHtml(settings.query)}" placeholder="搜索世界书或角色" aria-label="搜索世界书或角色"></label>
                <button type="button" class="menu_button" data-action="refresh"><i class="fa-solid fa-rotate"></i> 刷新</button>
                <button type="button" class="menu_button" data-action="open-all"><i class="fa-solid fa-arrow-up-right-from-square"></i> 原生世界书</button>
                <button type="button" class="menu_button srl-character-lorebooks__cleanup" data-action="request-cleanup"><i class="fa-solid fa-filter-circle-xmark"></i> 关闭其他角色书</button>
            </div>
            ${missing}
            ${renderCleanupConfirmation()}
            ${renderRecords(index, settings)}
        </div>
    </div>`;
    restoreDrawerState(root, wasOpen);
    if (focusQuery) {
        const input = root.querySelector('[data-field="query"]');
        input?.focus();
        input?.setSelectionRange?.(input.value.length, input.value.length);
    }
}

function ensureNativeWorldPanelOpen() {
    const panel = document.getElementById('WorldInfo');
    if (panel && getComputedStyle(panel).display !== 'none') return;
    document.getElementById('WIDrawerIcon')?.click();
}

function openNativeWorld(worldName) {
    const context = getContext();
    const names = context?.getWorldInfoNames?.() ?? [];
    const index = names.indexOf(worldName);
    if (index < 0) {
        globalThis.toastr?.warning?.('该世界书已不存在，未执行任何修改。', '角色世界书');
        return;
    }
    ensureNativeWorldPanelOpen();
    const select = document.getElementById('world_editor_select');
    if (!(select instanceof HTMLSelectElement)) {
        globalThis.toastr?.warning?.('未找到酒馆原生世界书编辑器。', '角色世界书');
        return;
    }
    select.value = String(index);
    select.dispatchEvent(new Event('change', { bubbles: true }));
}

function openNativeWorldPanel() {
    ensureNativeWorldPanelOpen();
}

function bindDomEvents() {
    const root = document.getElementById(ROOT_ID);
    if (!root || root.dataset.eventsBound === 'true') return;
    root.dataset.eventsBound = 'true';
    root.addEventListener('change', event => {
        const field = event.target?.dataset?.field;
        if (field !== 'scope') return;
        const context = getContext();
        if (!context) return;
        const settings = getSettings(context);
        settings.scope = event.target.value;
        saveSettings(context, settings);
        listPage = 1;
        refreshRecords();
    });
    root.addEventListener('input', event => {
        const field = event.target?.dataset?.field;
        if (field !== 'query') return;
        const context = getContext();
        if (!context) return;
        const settings = getSettings(context);
        settings.query = event.target.value;
        saveSettings(context, settings);
        listPage = 1;
        clearTimeout(searchTimer);
        searchTimer = setTimeout(refreshRecords, SEARCH_DELAY_MS);
    });
    root.addEventListener('click', event => {
        const target = event.target.closest?.('[data-action]');
        if (!target) return;
        if (target.dataset.action === 'refresh') scheduleCatalogRebuild({ immediate: true });
        if (target.dataset.action === 'open-all') openNativeWorldPanel();
        if (target.dataset.action === 'open-native') openNativeWorld(target.dataset.worldName);
        if (target.dataset.action === 'page-prev') { listPage -= 1; refreshRecords(); }
        if (target.dataset.action === 'page-next') { listPage += 1; refreshRecords(); }
        if (target.dataset.action === 'request-cleanup') requestCharacterScopedCleanup();
        if (target.dataset.action === 'cancel-cleanup') { cleanupConfirmation = null; render(); }
        if (target.dataset.action === 'confirm-cleanup') confirmCharacterScopedCleanup();
    });
}

function bindRuntimeEvents(context) {
    const source = context.eventSource;
    const types = context.eventTypes;
    if (!source?.on || !types) return;
    const renderSelection = () => {
        cleanupConfirmation = null;
        listPage = 1;
        render();
    };
    const rebuildCatalog = () => {
        cleanupConfirmation = null;
        scheduleCatalogRebuild();
    };
    const rebuildAfterCharacterListLoaded = () => {
        const latestContext = getContext();
        if (!latestContext) return;
        const fingerprint = createLorebookOwnershipFingerprint(getCatalogBuildOptions(latestContext));
        if (!catalog || catalog.sourceFingerprint !== fingerprint) rebuildCatalog();
    };
    for (const type of [
        types.CHARACTER_EDITED,
        types.CHARACTER_DELETED,
        types.CHARACTER_RENAMED,
        types.WORLDINFO_UPDATED,
        types.WORLDINFO_SETTINGS_UPDATED,
    ]) {
        if (!type) continue;
        source.on(type, rebuildCatalog);
        eventBindings.push({ source, type, refresh: rebuildCatalog });
    }
    if (types.CHARACTER_PAGE_LOADED) {
        source.on(types.CHARACTER_PAGE_LOADED, rebuildAfterCharacterListLoaded);
        eventBindings.push({ source, type: types.CHARACTER_PAGE_LOADED, refresh: rebuildAfterCharacterListLoaded });
    }
    for (const type of [types.CHAT_CHANGED, types.GROUP_UPDATED]) {
        if (!type) continue;
        source.on(type, renderSelection);
        eventBindings.push({ source, type, refresh: renderSelection });
    }
}

function unbindRuntimeEvents() {
    for (const { source, type, refresh } of eventBindings) source.removeListener?.(type, refresh);
    eventBindings = [];
}

export async function activate() {
    const context = getContext();
    if (!context?.extensionSettings || !context?.getWorldInfoNames) {
        globalThis.toastr?.error?.('未识别到酒馆世界书接口，插件没有接管任何数据。', '角色世界书');
        return;
    }
    const container = document.getElementById('extensions_settings2');
    if (!container || document.getElementById(ROOT_ID)) return;
    const html = await context.renderExtensionTemplateAsync?.(EXTENSION_FOLDER, 'settings', {}) ?? '<div id="srl-character-lorebooks"></div>';
    container.insertAdjacentHTML('beforeend', html);
    getSettings(context);
    bindRuntimeEvents(context);
    render();
    bindDomEvents();
    scheduleCatalogRebuild({ immediate: true });
}

export function disable() {
    unbindRuntimeEvents();
    cleanupConfirmation = null;
    catalog = null;
    catalogRebuilding = false;
    rebuildVersion += 1;
    clearTimeout(rebuildTimer);
    clearTimeout(searchTimer);
    document.getElementById(ROOT_ID)?.remove();
}
