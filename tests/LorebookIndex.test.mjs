import test from 'node:test';
import assert from 'node:assert/strict';
import { buildLorebookIndex, createCharacterScopedGlobalSelectionPlan, filterLorebookRecords, normalizeAvatarKey } from '../modules/LorebookIndex.js';

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
