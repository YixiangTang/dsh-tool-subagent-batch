import assert from 'node:assert/strict'
import { test } from 'node:test'

import { CONCURRENCY_ENV, recommendConcurrency, resolveConcurrency } from '../index.js'

test('recommends a window from cores and memory', () => {
  assert.equal(recommendConcurrency({ machine: { cores: 2, totalGiB: 4, freeGiB: 2 } }).concurrency, 2)
  assert.equal(recommendConcurrency({ machine: { cores: 4, totalGiB: 8, freeGiB: 4 } }).concurrency, 2)
  assert.equal(recommendConcurrency({ machine: { cores: 8, totalGiB: 16, freeGiB: 9 } }).concurrency, 4)
  assert.equal(recommendConcurrency({ machine: { cores: 16, totalGiB: 32, freeGiB: 20 } }).concurrency, 6)
})

test('recommendation respects low free memory, the max, and the Host cap', () => {
  assert.equal(recommendConcurrency({ machine: { cores: 16, totalGiB: 32, freeGiB: 0.5 } }).concurrency, 1)
  assert.ok(recommendConcurrency({ machine: { cores: 16, totalGiB: 32, freeGiB: 20 }, max: 3 }).concurrency <= 3)
  assert.equal(recommendConcurrency({ machine: { cores: 16, totalGiB: 32, freeGiB: 20 }, hostCap: 2 }).concurrency, 2)
})

test('recommendation never leaves the sane range and explains itself', () => {
  for (const machine of [
    { cores: 1, totalGiB: 1, freeGiB: 0.2 },
    { cores: 128, totalGiB: 512, freeGiB: 400 },
  ]) {
    const recommendation = recommendConcurrency({ machine })
    assert.ok(Number.isSafeInteger(recommendation.concurrency))
    assert.ok(recommendation.concurrency >= 1 && recommendation.concurrency <= 8)
    assert.match(recommendation.reason, /cores/)
  }
})

test('resolveConcurrency prefers explicit config over the environment', () => {
  const resolution = resolveConcurrency(
    { concurrency: 4, maxConcurrency: 8 },
    { env: { [CONCURRENCY_ENV]: '5' }, machine: { cores: 8, totalGiB: 16, freeGiB: 9 } },
  )
  assert.equal(resolution.concurrency, 4)
  assert.equal(resolution.source, 'config')
})

test('resolveConcurrency uses the environment when config is auto', () => {
  const resolution = resolveConcurrency(
    { concurrency: 'auto', maxConcurrency: 8 },
    { env: { [CONCURRENCY_ENV]: '5' }, machine: { cores: 8, totalGiB: 16, freeGiB: 9 } },
  )
  assert.equal(resolution.concurrency, 5)
  assert.equal(resolution.source, 'env')
})

test('resolveConcurrency falls back to auto for an invalid environment value', () => {
  const resolution = resolveConcurrency(
    { concurrency: 'auto', maxConcurrency: 8 },
    { env: { [CONCURRENCY_ENV]: 'many' }, machine: { cores: 8, totalGiB: 16, freeGiB: 9 } },
  )
  assert.equal(resolution.source, 'auto')
  assert.equal(resolution.concurrency, 4)
  assert.match(resolution.warning, /invalid/)
})

test('resolveConcurrency clamps an oversized environment value to the admission cap', () => {
  const resolution = resolveConcurrency(
    { concurrency: 'auto', maxConcurrency: 8 },
    { env: { [CONCURRENCY_ENV]: '50' }, hostCap: 3, machine: { cores: 16, totalGiB: 32, freeGiB: 20 } },
  )
  assert.equal(resolution.concurrency, 3)
  assert.equal(resolution.source, 'env')
  assert.match(resolution.warning, /exceeds/)
})

test('resolveConcurrency honors a host admission cap for explicit config', () => {
  const resolution = resolveConcurrency(
    { concurrency: 6, maxConcurrency: 8 },
    { hostCap: 2, machine: { cores: 16, totalGiB: 32, freeGiB: 20 } },
  )
  assert.equal(resolution.concurrency, 2)
  assert.equal(resolution.source, 'config')
  assert.match(resolution.warning, /admission cap/)
})
