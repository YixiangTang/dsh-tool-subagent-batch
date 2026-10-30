#!/usr/bin/env node
/**
 * Print a hardware-based concurrency recommendation for
 * `dsh-tool-subagent-batch`.
 *
 * Usage:
 *   dsh-subagent-batch-recommend [--json] [--max=<n>] [--host-cap=<n>]
 */

import { CONCURRENCY_ENV, recommendConcurrency } from '../index.js'

function parseFlag(name) {
  const prefix = `--${name}=`
  const found = process.argv.slice(2).find((arg) => arg.startsWith(prefix))
  if (found === undefined) return undefined
  const value = Number(found.slice(prefix.length))
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

if (process.argv.includes('--help') || process.argv.includes('-h')) {
  console.log(`Usage: dsh-subagent-batch-recommend [--json] [--max=<n>] [--host-cap=<n>]

Prints the rolling-window size this machine can reasonably sustain for
dsh-tool-subagent-batch, based on logical cores, total RAM, free RAM, and the
Host's subagent admission cap.

  --json             print the recommendation as JSON
  --max=<n>          ceiling to respect (default 8)
  --host-cap=<n>     Host maxActiveSubagents value, when known
  -h, --help         show this help`)
  process.exit(0)
}

const recommendation = recommendConcurrency({
  max: parseFlag('max') ?? 8,
  hostCap: parseFlag('host-cap'),
})

if (process.argv.includes('--json')) {
  console.log(JSON.stringify(recommendation, null, 2))
  process.exit(0)
}

console.log(`Recommended concurrency: ${recommendation.concurrency}`)
console.log(`Machine: ${recommendation.cores} logical cores, ${recommendation.totalGiB} GiB RAM (${recommendation.freeGiB} GiB free)`)
console.log(`Why: ${recommendation.reason}`)
console.log('')
console.log('Set it in your profile\'s cordis.patch.yml:')
console.log('')
console.log('  - id: tool-subagent-batch')
console.log('    config:')
console.log(`      concurrency: ${recommendation.concurrency}`)
console.log('')
console.log(`Or, when config.concurrency is "auto", set ${CONCURRENCY_ENV}=${recommendation.concurrency}:`)
console.log(`  PowerShell:  $env:${CONCURRENCY_ENV}=${recommendation.concurrency}`)
console.log(`  bash/zsh:    export ${CONCURRENCY_ENV}=${recommendation.concurrency}`)
console.log('')
console.log('Or keep `concurrency: auto` and let the plugin detect the machine at mount time.')
