import test from 'node:test';
import assert from 'node:assert/strict';
import { getAmbientMaxTokens } from './analyzer.js';

test('getAmbientMaxTokens defaults to a reasoning-safe budget', () => {
  assert.equal(getAmbientMaxTokens(undefined), 4096);
});

test('getAmbientMaxTokens accepts positive numeric overrides', () => {
  assert.equal(getAmbientMaxTokens('2048'), 2048);
  assert.equal(getAmbientMaxTokens(1024.9), 1024);
});

test('getAmbientMaxTokens ignores invalid overrides', () => {
  assert.equal(getAmbientMaxTokens(''), 4096);
  assert.equal(getAmbientMaxTokens('abc'), 4096);
  assert.equal(getAmbientMaxTokens('-1'), 4096);
  assert.equal(getAmbientMaxTokens('0'), 4096);
});
