import test from 'node:test';
import assert from 'node:assert/strict';
import {
    buildLorebookIndex,
    buildLorebookIndexAsync,
    createLorebookCatalogFingerprint,
    createCharacterScopedGlobalSelectionPlan,
    filterLorebookRecords,
    normalizeAvatarKey,
    projectLorebookIndex,
} from '../modules/LorebookIndex.js';

test('uses SillyTavern avatar stem for additional lorebook ownership', () => {
    assert.equal(normalizeAvatarKey('Alice.png'), 'Alice');
    const index = buildLorebookIndex({
        worldNames: ['Alice Book', 'Shared Book', 'Public Book'],
        characters: [
            { name: 'Alice', avatar: 'Alice.png', data: { extensions: { world: 'Alice Book' } } },
            { name: 'Bob', avatar: 'Bob.webp', data: { extensions: { world: 'Shared Book' } } },
        ],
        charLore: [{ name: 'Alice', extraBooks: ['Shared Book'] }],
        currentCharacterId: 0,
    });

    assert.deepEqual(index.records.find(record => record.name === 'Alice Book').owners.map(owner => owner.type), ['primary']);
    assert.deepEqual(index.records.find(record => record.name === 'Shared Book').owners.map(owner => owner.name), ['Alice', 'Bob']);
    assert.deepEqual(filterLorebookRecords(index, 'current').map(record => record.name), ['Alice Book', 'Shared Book']);
    assert.deepEqual(filterLorebookRecords(index, 'public').map(record => record.name), ['Public Book']);
});

test('reports broken bindings without inventing a worldbook', () => {
    const index = buildLorebookIndex({
        worldNames: ['Existing'],
        characters: [{ name: 'Alice', avatar: 'Alice.png', data: { extensions: { world: 'Missing' } } }],
        charLore: [{ name: 'Alice', extraBooks: ['Also Missing'] }],
        currentCharacterId: 0,
    });

    assert.equal(index.records.length, 1);
    assert.deepEqual(index.missingBindings.map(item => item.name), ['Missing', 'Also Missing']);
    assert.deepEqual(filterLorebookRecords(index, 'current'), []);
});

test('tracks active global, chat, and persona labels without changing their state', () => {
    const index = buildLorebookIndex({
        worldNames: ['Global', 'Chat', 'Persona'],
        activeGlobalNames: ['Global'],
        chatLoreName: 'Chat',
        personaLoreName: 'Persona',
    });

    assert.equal(index.records.find(record => record.name === 'Global').globalActive, true);
    assert.equal(index.records.find(record => record.name === 'Chat').chatActive, true);
    assert.equal(index.records.find(record => record.name === 'Persona').personaActive, true);
});

test('accepts SillyTavern character IDs supplied as numeric strings', () => {
    const index = buildLorebookIndex({
        worldNames: ['Alice Book'],
        characters: [{ name: 'Alice', avatar: 'Alice.png', data: { extensions: { world: 'Alice Book' } } }],
        currentCharacterId: '0',
    });

    assert.equal(index.currentCharacter?.name, 'Alice');
    assert.equal(filterLorebookRecords(index, 'current')[0]?.name, 'Alice Book');
});

test('only deactivates globally selected lorebooks owned by other characters', () => {
    const index = buildLorebookIndex({
        worldNames: ['Alice Book', 'Bob Book', 'Public Book'],
        characters: [
            { name: 'Alice', avatar: 'Alice.png', data: { extensions: { world: 'Alice Book' } } },
            { name: 'Bob', avatar: 'Bob.png', data: { extensions: { world: 'Bob Book' } } },
        ],
        activeGlobalNames: ['Alice Book', 'Bob Book', 'Public Book'],
        currentCharacterId: 0,
    });

    assert.deepEqual(createCharacterScopedGlobalSelectionPlan(index), {
        keep: ['Alice Book', 'Public Book'],
        deactivate: ['Bob Book'],
    });
});

test('builds a reusable catalog in chunks and projects the current role afterwards', async () => {
    const options = {
        worldNames: ['Alice Book', 'Bob Book', 'Public Book'],
        characters: [
            { name: 'Alice', avatar: 'Alice.png', data: { extensions: { world: 'Alice Book' } } },
            { name: 'Bob', avatar: 'Bob.png', data: { extensions: { world: 'Bob Book' } } },
            { name: 'Cara', avatar: 'Cara.png', data: { extensions: {} } },
        ],
        currentCharacterId: 0,
    };
    let yields = 0;
    const catalog = await buildLorebookIndexAsync({ ...options, currentCharacterId: null }, {
        chunkSize: 1,
        yieldToMain: async () => { yields += 1; },
    });
    const projected = projectLorebookIndex(catalog, '0');
    const direct = buildLorebookIndex(options);

    assert.equal(yields, 2);
    assert.deepEqual(projected.records.map(record => [record.name, record.current]), direct.records.map(record => [record.name, record.current]));
    assert.deepEqual(filterLorebookRecords(projected, 'current').map(record => record.name), ['Alice Book']);
});

test('a rebuilt catalog replaces an earlier public classification after the character link is available', async () => {
    const beforeLink = await buildLorebookIndexAsync({
        worldNames: ['Imported Book'],
        characters: [{ name: 'Alice', avatar: 'Alice.png', data: { extensions: {} } }],
    });
    const afterLink = await buildLorebookIndexAsync({
        worldNames: ['Imported Book'],
        characters: [{ name: 'Alice', avatar: 'Alice.png', data: { extensions: { world: 'Imported Book' } } }],
    });

    assert.deepEqual(filterLorebookRecords(beforeLink, 'public').map(record => record.name), ['Imported Book']);
    assert.deepEqual(filterLorebookRecords(afterLink, 'public'), []);
    assert.deepEqual(filterLorebookRecords(afterLink, 'all')[0]?.owners.map(owner => owner.name), ['Alice']);
});

test('detects same-size delayed bindings in a 500-character catalog', async () => {
    const charactersBeforeLink = Array.from({ length: 500 }, (_, index) => ({
        name: `Role ${index}`,
        avatar: `role-${index}.png`,
        data: { extensions: {} },
    }));
    const worldNames = charactersBeforeLink.map((_, index) => `Book ${index}`);
    const charactersAfterLink = charactersBeforeLink.map((character, index) => ({
        ...character,
        data: { extensions: { world: `Book ${index}` } },
    }));
    const beforeFingerprint = createLorebookCatalogFingerprint({ worldNames, characters: charactersBeforeLink });
    const afterFingerprint = createLorebookCatalogFingerprint({ worldNames, characters: charactersAfterLink });
    const index = await buildLorebookIndexAsync({ worldNames, characters: charactersAfterLink }, {
        chunkSize: 250,
        yieldToMain: async () => {},
    });

    assert.equal(charactersBeforeLink.length, charactersAfterLink.length);
    assert.notEqual(beforeFingerprint, afterFingerprint);
    assert.equal(index.publicCount, 0);
    assert.equal(index.ownedCount, 500);
});
