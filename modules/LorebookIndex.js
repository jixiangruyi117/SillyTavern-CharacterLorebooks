export function normalizeAvatarKey(value) {
    return String(value ?? '').replace(/\.[^/.]+$/u, '');
}

function normalizeNames(values) {
    return Array.isArray(values)
        ? values.map(value => String(value ?? '').trim()).filter(Boolean)
        : [];
}

/**
 * Copies only ownership fields before the asynchronous index yields. SillyTavern
 * refreshes its live character array in place, so retaining that array would
 * otherwise let one catalog mix characters from two refreshes.
 */
export function snapshotLorebookOwnershipSources(characters) {
    return (Array.isArray(characters) ? characters : []).map(character => ({
        avatar: String(character?.avatar ?? ''),
        name: String(character?.name ?? '未命名角色'),
        shallow: character?.shallow === true,
        data: {
            extensions: { world: String(character?.data?.extensions?.world ?? '') },
        },
    }));
}

export function createLorebookOwnershipFingerprint({ worldNames = [], characters = [], charLore = [], legacyOwners = [] } = {}) {
    return JSON.stringify({
        worldNames: [...normalizeNames(worldNames)].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN')),
        characters: snapshotLorebookOwnershipSources(characters)
            .map(character => [character.avatar, character.shallow, character.data.extensions.world])
            .sort((a, b) => a[0].localeCompare(b[0], 'en')),
        legacyOwners: (Array.isArray(legacyOwners) ? legacyOwners : [])
            .map(item => [String(item?.avatar ?? ''), String(item?.worldName ?? '')])
            .filter(([avatar, worldName]) => avatar && worldName)
            .sort((a, b) => a[0].localeCompare(b[0], 'en')),
        charLore: (Array.isArray(charLore) ? charLore : [])
            .map(item => [String(item?.name ?? ''), [...normalizeNames(item?.extraBooks)].sort((a, b) => a.localeCompare(b, 'zh-Hans-CN'))])
            .filter(([name]) => name)
            .sort((a, b) => a[0].localeCompare(b[0], 'en')),
    });
}

function makeOwner(character, type) {
    return {
        avatar: String(character.avatar ?? ''),
        key: normalizeAvatarKey(character.avatar),
        name: String(character.name ?? '未命名角色'),
        type,
    };
}

function normalizeCharacterIndex(value) {
    if (typeof value === 'number' && Number.isInteger(value)) return value;
    if (typeof value !== 'string' || !/^\d+$/u.test(value.trim())) return null;
    const index = Number(value);
    return Number.isSafeInteger(index) ? index : null;
}

function createAdditionalBooksByCharacter(charLore) {
    const result = new Map();
    for (const item of Array.isArray(charLore) ? charLore : []) {
        const key = String(item?.name ?? '').trim();
        if (!key) continue;
        const books = normalizeNames(item?.extraBooks);
        if (!books.length) continue;
        result.set(key, [...(result.get(key) ?? []), ...books]);
    }
    return result;
}

function createLegacyBooksByCharacter(legacyOwners) {
    const result = new Map();
    for (const item of Array.isArray(legacyOwners) ? legacyOwners : []) {
        const key = normalizeAvatarKey(item?.avatar);
        const bookName = String(item?.worldName ?? '').trim();
        if (!key || !bookName) continue;
        result.set(key, [...(result.get(key) ?? []), bookName]);
    }
    return result;
}

function createBuildState({
    worldNames = [],
    characters = [],
    charLore = [],
    legacyOwners = [],
    activeGlobalNames = [],
    chatLoreName = '',
    personaLoreName = '',
} = {}) {
    const names = [...new Set(normalizeNames(worldNames))];
    const activeGlobalNameSet = new Set(normalizeNames(activeGlobalNames));
    return {
        byName: new Map(names.map(name => [name, {
            name,
            owners: [],
            globalActive: activeGlobalNameSet.has(name),
            chatActive: String(chatLoreName ?? '') === name,
            personaActive: String(personaLoreName ?? '') === name,
        }])),
        characters: snapshotLorebookOwnershipSources(characters),
        extraBooksByCharacter: createAdditionalBooksByCharacter(charLore),
        legacyBooksByCharacter: createLegacyBooksByCharacter(legacyOwners),
        missingBindings: [],
        knownNames: new Set(names),
        sourceFingerprint: createLorebookOwnershipFingerprint({ worldNames, characters, charLore, legacyOwners }),
    };
}

function addBinding(state, name, character, type) {
    const bookName = String(name ?? '').trim();
    if (!bookName) return;
    const owner = makeOwner(character, type);
    const record = state.byName.get(bookName);
    if (!record) {
        state.missingBindings.push({ name: bookName, owner, type });
        return;
    }
    const existing = record.owners.find(item => item.key === owner.key);
    if (!existing) {
        record.owners.push(owner);
    }
}

function addCharacterBindings(state, character) {
    addBinding(state, character?.data?.extensions?.world, character, 'primary');
    const avatarKey = normalizeAvatarKey(character?.avatar);
    for (const bookName of state.extraBooksByCharacter.get(avatarKey) ?? []) {
        addBinding(state, bookName, character, 'additional');
    }
    if (!character?.data?.extensions?.world) {
        for (const bookName of state.legacyBooksByCharacter.get(avatarKey) ?? []) {
            addBinding(state, bookName, character, 'legacy');
        }
    }
}

function finalizeBuild(state) {
    const records = [...state.byName.values()]
        .map(record => ({
            ...record,
            owners: [...record.owners].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
            current: false,
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));
    return {
        records,
        missingBindings: state.missingBindings,
        characters: state.characters,
        ownedCount: records.filter(record => record.owners.length > 0).length,
        publicCount: records.filter(record => record.owners.length === 0).length,
        sharedCount: records.filter(record => new Set(record.owners.map(owner => owner.key)).size > 1).length,
        knownNames: state.knownNames,
        sourceFingerprint: state.sourceFingerprint,
        diagnostics: {
            characterCount: state.characters.length,
            primaryBindingCount: records.filter(record => record.owners.some(owner => owner.type === 'primary')).length,
            additionalBindingCount: records.filter(record => record.owners.some(owner => owner.type === 'additional')).length,
            legacyBindingCount: records.filter(record => record.owners.some(owner => owner.type === 'legacy')).length,
            unownedCount: records.filter(record => record.owners.length === 0).length,
        },
    };
}

/**
 * Projects an immutable cached catalog onto the currently selected character.
 * This never rescans the character list or the extra-book configuration.
 */
export function projectLorebookIndex(baseIndex, currentCharacterId = null) {
    if (!baseIndex) return null;
    const currentCharacterIndex = normalizeCharacterIndex(currentCharacterId);
    const currentCharacter = currentCharacterIndex !== null && currentCharacterIndex >= 0
        ? baseIndex.characters?.[currentCharacterIndex] ?? null
        : null;
    const currentKey = normalizeAvatarKey(currentCharacter?.avatar);
    return {
        ...baseIndex,
        records: baseIndex.records.map(record => ({
            ...record,
            current: Boolean(currentKey && record.owners.some(owner => owner.key === currentKey)),
        })),
        currentCharacter: currentCharacter ? makeOwner(currentCharacter, 'current') : null,
    };
}

/**
 * Synchronously builds a view-only index from SillyTavern's existing bindings.
 */
export function buildLorebookIndex(options = {}) {
    const state = createBuildState(options);
    for (const character of state.characters) addCharacterBindings(state, character);
    return projectLorebookIndex(finalizeBuild(state), options.currentCharacterId);
}

/**
 * Builds the same index in small batches so a large import does not monopolize the UI thread.
 */
export async function buildLorebookIndexAsync(options = {}, { chunkSize = 250, yieldToMain = () => new Promise(resolve => setTimeout(resolve, 0)) } = {}) {
    const state = createBuildState(options);
    const size = Math.max(1, Number(chunkSize) || 250);
    for (let start = 0; start < state.characters.length; start += size) {
        for (const character of state.characters.slice(start, start + size)) addCharacterBindings(state, character);
        if (start + size < state.characters.length) await yieldToMain();
    }
    return projectLorebookIndex(finalizeBuild(state), options.currentCharacterId);
}

export function filterLorebookRecords(index, scope = 'current', query = '') {
    const normalizedQuery = String(query ?? '').trim().toLocaleLowerCase('zh-Hans-CN');
    return (index?.records ?? []).filter(record => {
        const inScope = scope === 'all'
            || scope === 'public' && record.owners.length === 0
            || scope === 'current' && record.current;
        if (!inScope) return false;
        if (!normalizedQuery) return true;
        return [record.name, ...record.owners.map(owner => owner.name)]
            .some(value => value.toLocaleLowerCase('zh-Hans-CN').includes(normalizedQuery));
    });
}

/**
 * Keeps active public lorebooks and the current character's active books,
 * while identifying globally active books owned only by other characters.
 */
export function createCharacterScopedGlobalSelectionPlan(index) {
    const records = index?.records ?? [];
    const active = records.filter(record => record.globalActive);
    const deactivate = active
        .filter(record => record.owners.length > 0 && !record.current)
        .map(record => record.name);
    const deactivateSet = new Set(deactivate);
    return {
        deactivate,
        keep: active.filter(record => !deactivateSet.has(record.name)).map(record => record.name),
    };
}
