import { buildLorebookIndex, filterLorebookRecords } from './modules/LorebookIndex.js?v=0.1.0';

const EXTENSION_FOLDER = 'third-party/SillyTavern-CharacterLorebooks';
const SETTINGS_KEY = 'srlCharacterLorebooks';
const ROOT_ID = 'srl-character-lorebooks';
const DEFAULT_SETTINGS = Object.freeze({ scope: 'current', query: '' });

let eventBindings = [];

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
    const worldInfo = context.powerUserSettings?.world_info ?? {};
    return buildLorebookIndex({
        worldNames: context.getWorldInfoNames?.() ?? [],
        characters: context.characters ?? [],
        charLore: worldInfo.charLore ?? [],
        activeGlobalNames: worldInfo.globalSelect ?? [],
        chatLoreName: context.chatMetadata?.world_info ?? '',
        personaLoreName: context.powerUserSettings?.persona_description_lorebook ?? '',
        currentCharacterId: context.characterId,
    });
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

function render({ focusQuery = false } = {}) {
    const context = getContext();
    const root = document.getElementById(ROOT_ID);
    if (!context || !root) return;
    const settings = getSettings(context);
    const index = getIndex(context);
    const records = filterLorebookRecords(index, settings.scope, settings.query);
    const currentLabel = index.currentCharacter?.name ?? '群聊或未选择角色';
    const unavailableHint = settings.scope === 'current' && !index.currentCharacter
        ? '<p class="srl-character-lorebooks__empty">当前不是单角色聊天。请切到“全部”，或在群聊中使用酒馆原生世界书管理。</p>'
        : records.length
            ? `<ul class="srl-character-lorebooks__list">${records.map(renderRecord).join('')}</ul>`
            : '<p class="srl-character-lorebooks__empty">这个范围没有世界书。</p>';
    const missing = index.missingBindings.length
        ? `<div class="srl-character-lorebooks__warning"><i class="fa-solid fa-triangle-exclamation"></i><span>发现 ${index.missingBindings.length} 个失效绑定：${index.missingBindings.map(item => escapeHtml(item.name)).join('、')}。插件没有修改它们。</span></div>`
        : '';

    root.innerHTML = `<div class="inline-drawer srl-character-lorebooks__drawer">
        <div class="inline-drawer-toggle inline-drawer-header">
            <b><i class="fa-solid fa-book-atlas"></i> 角色世界书</b>
            <div class="inline-drawer-icon fa-solid fa-circle-chevron-down down"></div>
        </div>
        <div class="inline-drawer-content">
            <p class="srl-character-lorebooks__intro">只整理酒馆现有绑定，不移动文件、不改全局启用状态，也不改变提示词装配。</p>
            <div class="srl-character-lorebooks__summary">
                <span>当前：<b>${escapeHtml(currentLabel)}</b></span>
                <span>角色归属 ${index.ownedCount}</span><span>公共 ${index.publicCount}</span><span>共享 ${index.sharedCount}</span>
            </div>
            <div class="srl-character-lorebooks__controls">
                <label>显示
                    <select data-field="scope" class="text_pole">
                        <option value="current"${settings.scope === 'current' ? ' selected' : ''}>当前角色</option>
                        <option value="public"${settings.scope === 'public' ? ' selected' : ''}>公共世界书</option>
                        <option value="all"${settings.scope === 'all' ? ' selected' : ''}>全部世界书</option>
                    </select>
                </label>
                <label class="srl-character-lorebooks__search"><span class="fa-solid fa-magnifying-glass"></span><input data-field="query" class="text_pole" type="search" value="${escapeHtml(settings.query)}" placeholder="搜索世界书或角色"></label>
                <button type="button" class="menu_button" data-action="refresh"><i class="fa-solid fa-rotate"></i> 刷新</button>
                <button type="button" class="menu_button" data-action="open-all"><i class="fa-solid fa-arrow-up-right-from-square"></i> 原生世界书</button>
            </div>
            ${missing}
            ${unavailableHint}
        </div>
    </div>`;
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
        render();
    });
    root.addEventListener('input', event => {
        const field = event.target?.dataset?.field;
        if (field !== 'query') return;
        const context = getContext();
        if (!context) return;
        const settings = getSettings(context);
        settings.query = event.target.value;
        saveSettings(context, settings);
        render({ focusQuery: true });
    });
    root.addEventListener('click', event => {
        const target = event.target.closest?.('[data-action]');
        if (!target) return;
        if (target.dataset.action === 'refresh') render();
        if (target.dataset.action === 'open-all') openNativeWorldPanel();
        if (target.dataset.action === 'open-native') openNativeWorld(target.dataset.worldName);
    });
}

function bindRuntimeEvents(context) {
    const source = context.eventSource;
    const types = context.eventTypes;
    if (!source?.on || !types) return;
    const refresh = () => render();
    for (const type of [
        types.CHAT_CHANGED,
        types.CHARACTER_EDITED,
        types.CHARACTER_DELETED,
        types.CHARACTER_RENAMED,
        types.GROUP_UPDATED,
        types.WORLDINFO_UPDATED,
        types.WORLDINFO_SETTINGS_UPDATED,
    ]) {
        if (!type) continue;
        source.on(type, refresh);
        eventBindings.push({ source, type, refresh });
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
}

export function disable() {
    unbindRuntimeEvents();
    document.getElementById(ROOT_ID)?.remove();
}
