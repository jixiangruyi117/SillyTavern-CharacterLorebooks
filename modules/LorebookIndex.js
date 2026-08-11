export function normalizeAvatarKey(value) {
    return String(value ?? '').replace(/\.[^/.]+$/u, '');
}

function normalizeNames(values) {
    return Array.isArray(values)
        ? values.map(value => String(value ?? '').trim()).filter(Boolean)
        : [];
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

/**
 * Builds a view-only index from SillyTavern's existing character lore bindings.
 * It intentionally never mutates character data, world-info settings, or world files.
 */
export function buildLorebookIndex({
    worldNames = [],
    characters = [],
    charLore = [],
    activeGlobalNames = [],
    chatLoreName = '',
    personaLoreName = '',
    currentCharacterId = null,
} = {}) {
    const names = [...new Set(normalizeNames(worldNames))];
    const knownNames = new Set(names);
    const byName = new Map(names.map(name => [name, {
        name,
        owners: [],
        globalActive: normalizeNames(activeGlobalNames).includes(name),
        chatActive: String(chatLoreName ?? '') === name,
        personaActive: String(personaLoreName ?? '') === name,
    }]));
    const missingBindings = [];
    const characterList = Array.isArray(characters) ? characters : [];
    const charLoreList = Array.isArray(charLore) ? charLore : [];

    const addBinding = (name, character, type) => {
        const bookName = String(name ?? '').trim();
        if (!bookName) return;
        const owner = makeOwner(character, type);
        const record = byName.get(bookName);
        if (!record) {
            missingBindings.push({ name: bookName, owner, type });
            return;
        }
        if (!record.owners.some(item => item.key === owner.key && item.type === owner.type)) {
            record.owners.push(owner);
        }
    };

    for (const character of characterList) {
        const primary = character?.data?.extensions?.world;
        addBinding(primary, character, 'primary');
        const avatarKey = normalizeAvatarKey(character?.avatar);
        const additional = charLoreList.find(item => String(item?.name ?? '') === avatarKey)?.extraBooks;
        for (const bookName of normalizeNames(additional)) addBinding(bookName, character, 'additional');
    }

    const currentCharacterIndex = normalizeCharacterIndex(currentCharacterId);
    const currentCharacter = currentCharacterIndex !== null && currentCharacterIndex >= 0
        ? characterList[currentCharacterIndex] ?? null
        : null;
    const currentKey = normalizeAvatarKey(currentCharacter?.avatar);
    const records = [...byName.values()]
        .map(record => ({
            ...record,
            owners: [...record.owners].sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN')),
            current: Boolean(currentKey && record.owners.some(owner => owner.key === currentKey)),
        }))
        .sort((a, b) => a.name.localeCompare(b.name, 'zh-Hans-CN'));

    return {
        records,
        missingBindings,
        currentCharacter: currentCharacter ? makeOwner(currentCharacter, 'current') : null,
        ownedCount: records.filter(record => record.owners.length > 0).length,
        publicCount: records.filter(record => record.owners.length === 0).length,
        sharedCount: records.filter(record => new Set(record.owners.map(owner => owner.key)).size > 1).length,
        knownNames,
    };
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
