import assert from 'node:assert/strict'
import { test } from 'node:test'

import { apply } from '../index.js'

/**
 * Build a registrant context whose subagents settle after scripted delays.
 * @param {object} options - delays, failures, depth cap, admission cap.
 * @returns harness with registered definitions and observable facts.
 */
function harness(options = {}) {
  const delays = options.delays ?? []
  const failures = options.failures ?? {}
  const capacityRefusals = options.capacityRefusals ?? 0
  const starts = []
  const disposals = []
  const registered = []
  const cleanups = []
  const listeners = new Map()
  const startedAt = Date.now()
  let active = 0
  let peak = 0
  let sequence = 0
  let refused = 0

  const subagents = {
    getProvider: (name) => (name === 'spawn' ? { name } : undefined),
    resolveMaxDepth: () => (options.maxDepth === undefined ? 1 : options.maxDepth),
    ...options.hostCap === undefined ? {} : { config: { maxActiveSubagents: { get: () => options.hostCap } } },
    async startActivation(spec) {
      if (refused < capacityRefusals) {
        refused += 1
        const error = new Error('subagent activation limit reached')
        error.code = 'ACTIVATION_LIMIT_REACHED'
        throw error
      }
      const index = starts.length
      starts.push({ label: spec.label, at: Date.now() - startedAt })
      sequence += 1
      const childId = `child-${sequence}`
      active += 1
      peak = Math.max(peak, active)
      let settle
      const result = new Promise((resolve, reject) => {
        settle = { resolve, reject }
      })
      let done = false
      const finish = (fn, value) => {
        if (done) return
        done = true
        active -= 1
        fn(value)
      }
      const timer = setTimeout(() => {
        const failure = failures[index]
        if (failure !== undefined) finish(settle.reject, failure)
        else finish(settle.resolve, { output: [{ type: 'text', text: `result ${index}` }], stopReason: 'completed' })
      }, delays[index] ?? 10)
      return {
        childId,
        result,
        async dispose() {
          disposals.push(childId)
          clearTimeout(timer)
          finish(settle.resolve, { output: [], stopReason: 'aborted' })
        },
      }
    },
  }

  const ctx = {
    tools: {
      register(definition) {
        registered.push(definition)
        return () => {}
      },
    },
    subagents,
    logger: { warn() {}, info() {} },
    effect(fn) {
      const disposer = fn()
      if (typeof disposer === 'function') cleanups.push(disposer)
      return disposer
    },
    on(event, listener) {
      listeners.set(event, listener)
      return () => {}
    },
  }

  return {
    ctx,
    registered,
    starts,
    disposals,
    get peak() {
      return peak
    },
    tool(name) {
      return registered.find((definition) => definition.name === name)
    },
    configure(config) {
      apply(ctx, config)
      return registered.find((definition) => definition.name === (config.toolName ?? 'subagent_batch'))
    },
    statusTool(config = {}) {
      return registered.find((definition) => definition.name === (config.statusToolName ?? 'subagent_batch_status'))
    },
    emit(event, payload) {
      listeners.get(event)?.(payload)
    },
    async dispose() {
      for (const cleanup of cleanups.reverse()) await cleanup()
    },
  }
}

const agent = {
  id: 'parent-1',
  session: { header: { delegationDepth: 0 } },
  options: {},
}

function exec(signal = new AbortController().signal, owner = agent) {
  return { agent: owner, signal }
}

function tasks(count) {
  return Array.from({ length: count }, (_, index) => ({
    description: `task ${index}`,
    prompt: `do work ${index}`,
  }))
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

test('refills the window as soon as any child settles', async () => {
  const h = harness({ delays: [80, 200, 80, 80] })
  const tool = h.configure({ concurrency: 2 })
  const value = await tool.execute({ tasks: tasks(4) }, exec())

  assert.equal(h.peak, 2)
  assert.deepEqual(h.starts.map((start) => start.label), ['task 0', 'task 1', 'task 2', 'task 3'])
  assert.equal(value.mode, 'sync')
  assert.equal(value.status, 'completed')
  assert.equal(value.total, 4)
  assert.equal(value.completed, 4)
  assert.equal(value.failed, 0)
  assert.equal(value.concurrency, 2)
  assert.equal(value.concurrencySource, 'config')
  assert.deepEqual(value.results.map((result) => result.output), ['result 0', 'result 1', 'result 2', 'result 3'])
  assert.deepEqual(value.results.map((result) => result.index), [1, 2, 3, 4])
})

test('isolates a failed child and keeps the remaining queue moving', async () => {
  const h = harness({ delays: [20, 20, 20], failures: { 1: new Error('boom') } })
  const tool = h.configure({ concurrency: 3 })
  const value = await tool.execute({ tasks: tasks(3) }, exec())

  assert.deepEqual(value.results.map((result) => result.status), ['completed', 'failed', 'completed'])
  assert.match(value.results[1].error, /boom/)
  assert.equal(value.completed, 2)
  assert.equal(value.failed, 1)
})

test('fail_fast stops admitting queued tasks but drains running ones', async () => {
  const h = harness({ delays: [20, 200, 200, 200], failures: { 0: new Error('first failure') } })
  const tool = h.configure({ concurrency: 2 })
  const value = await tool.execute({ tasks: tasks(4), fail_fast: true }, exec())

  assert.equal(h.starts.length, 2)
  assert.deepEqual(value.results.map((result) => result.status), ['failed', 'completed', 'skipped', 'skipped'])
  assert.match(value.results[2].error, /fail_fast/)
})

test('cancellation disposes running children and rejects the call', async () => {
  const h = harness({ delays: [1000, 1000, 1000] })
  const tool = h.configure({ concurrency: 2 })
  const controller = new AbortController()
  const running = tool.execute({ tasks: tasks(3) }, exec(controller.signal))
  setTimeout(() => controller.abort(new Error('user cancelled')), 30)

  await assert.rejects(running, /user cancelled/)
  assert.equal(h.starts.length, 2)
  assert.deepEqual(h.disposals.sort(), ['child-1', 'child-2'])
})

test('retries a capacity refusal before admitting the child', async () => {
  const h = harness({ delays: [10], capacityRefusals: 1 })
  const tool = h.configure({ concurrency: 1 })
  const value = await tool.execute({ tasks: tasks(1) }, exec())

  assert.equal(value.completed, 1)
  assert.ok(h.starts[0].at >= 450, `expected a capacity wait, started after ${h.starts[0].at}ms`)
})

test('truncates a child answer to the configured budget', async () => {
  const h = harness({ delays: [10] })
  const tool = h.configure({ concurrency: 1, outputCharsPerTask: 500 })
  const original = h.ctx.subagents.startActivation
  h.ctx.subagents.startActivation = async (spec) => {
    const activation = await original(spec)
    return {
      ...activation,
      result: activation.result.then(() => ({ output: [{ type: 'text', text: 'x'.repeat(700) }], stopReason: 'completed' })),
    }
  }
  const value = await tool.execute({ tasks: tasks(1) }, exec())

  assert.equal(value.results[0].outputTruncated, true)
  assert.match(value.results[0].output, /200 characters omitted/)
  const rendered = tool.output.render({}, value)
  assert.match(rendered[0].text, /x{500}/)
})

test('rejects an empty or malformed task list before starting any child', async () => {
  const h = harness()
  const tool = h.configure({ concurrency: 1 })
  await assert.rejects(tool.execute({ tasks: [] }, exec()), /non-empty array/)
  await assert.rejects(tool.execute({ tasks: [{ description: 'x' }] }, exec()), /prompt/)
  assert.equal(h.starts.length, 0)
})

test('rejects delegation at the configured depth cap', async () => {
  const h = harness({ maxDepth: 1 })
  const tool = h.configure({ concurrency: 1 })
  const capped = { id: 'child', session: { header: { delegationDepth: 1 } }, options: {} }
  await assert.rejects(tool.execute({ tasks: tasks(1) }, { agent: capped, signal: new AbortController().signal }), /depth 1/)
})

test('the user owns concurrency by default: no model parameter, model requests rejected', async () => {
  const h = harness({ delays: [10, 10] })
  const tool = h.configure({ concurrency: 1 })

  assert.equal(tool.parameters.properties.concurrency, undefined)
  const value = await tool.execute({ tasks: tasks(2) }, exec())
  assert.equal(value.concurrency, 1)
  assert.equal(value.concurrencySource, 'config')
  await assert.rejects(tool.execute({ tasks: tasks(1), concurrency: 2 }, exec()), /user-controlled/)
})

test('allowModelConcurrency "lower" accepts a smaller window and rejects a larger one', async () => {
  const h = harness({ delays: [10, 10, 10] })
  const tool = h.configure({ concurrency: 3, allowModelConcurrency: 'lower' })

  assert.ok(tool.parameters.properties.concurrency)
  const value = await tool.execute({ tasks: tasks(3), concurrency: 2 }, exec())
  assert.equal(value.concurrency, 2)
  assert.equal(value.concurrencySource, 'model')
  await assert.rejects(tool.execute({ tasks: tasks(1), concurrency: 4 }, exec()), /only lower/)
})

test('allowModelConcurrency true accepts any window up to maxConcurrency', async () => {
  const h = harness({ delays: [10, 10, 10, 10, 10] })
  const tool = h.configure({ concurrency: 2, maxConcurrency: 6, allowModelConcurrency: true })

  const value = await tool.execute({ tasks: tasks(5), concurrency: 5 }, exec())
  assert.equal(value.concurrency, 5)
  assert.equal(value.concurrencySource, 'model')
  await assert.rejects(tool.execute({ tasks: tasks(1), concurrency: 7 }, exec()), /cannot exceed/)
})

test('explicit config concurrency is clamped to the Host admission cap with a warning', async () => {
  const h = harness({ delays: [10], hostCap: 2 })
  const tool = h.configure({ concurrency: 6 })
  const value = await tool.execute({ tasks: tasks(1) }, exec())

  assert.equal(value.concurrency, 2)
  assert.equal(value.concurrencySource, 'config')
})

test('async mode returns a batch id immediately and status wait collects the report', async () => {
  const h = harness({ delays: [500, 500, 500] })
  const tool = h.configure({ concurrency: 2 })
  const status = h.statusTool()
  const started = Date.now()
  const start = await tool.execute({ tasks: tasks(3), mode: 'async' }, exec())
  const elapsed = Date.now() - started

  assert.ok(elapsed < 250, `async start took ${elapsed}ms`)
  assert.equal(start.mode, 'async')
  assert.equal(start.status, 'running')
  assert.equal(start.total, 3)
  assert.equal(start.completed, 0)
  assert.ok(start.pending + start.running > 0)
  assert.ok(start.batchId.startsWith('batch-'))

  const final = await status.execute({ batchId: start.batchId, wait: true, timeout_ms: 5000 }, exec())
  assert.equal(final.status, 'completed')
  assert.equal(final.completed, 3)
  assert.deepEqual(final.results.map((result) => result.output), ['result 0', 'result 1', 'result 2'])
})

test('async status reports partial progress while the batch runs', async () => {
  const h = harness({ delays: [100, 600] })
  const tool = h.configure({ concurrency: 1 })
  const status = h.statusTool()
  const start = await tool.execute({ tasks: tasks(2), mode: 'async' }, exec())
  await sleep(250)

  const mid = await status.execute({ batchId: start.batchId }, exec())
  assert.equal(mid.status, 'running')
  assert.equal(mid.results[0].status, 'completed')
  assert.equal(mid.results[1].status, 'running')
  assert.equal(mid.running, 1)

  const final = await status.execute({ batchId: start.batchId, wait: true, timeout_ms: 5000 }, exec())
  assert.equal(final.status, 'completed')
  assert.equal(final.completed, 2)
})

test('async status can cancel a running batch', async () => {
  const h = harness({ delays: [1000, 1000] })
  const tool = h.configure({ concurrency: 2 })
  const status = h.statusTool()
  const start = await tool.execute({ tasks: tasks(2), mode: 'async' }, exec())

  const cancelled = await status.execute({ batchId: start.batchId, cancel: true }, exec())
  assert.equal(cancelled.status, 'cancelled')
  assert.equal(cancelled.cancelled, 2)
  assert.deepEqual(h.disposals.sort(), ['child-1', 'child-2'])
})

test('async status rejects unknown batches and foreign sessions', async () => {
  const h = harness({ delays: [10] })
  const tool = h.configure({ concurrency: 1 })
  const status = h.statusTool()
  await assert.rejects(status.execute({ batchId: 'batch-missing' }, exec()), /unknown or expired/)

  const start = await tool.execute({ tasks: tasks(1), mode: 'async' }, exec())
  const other = { id: 'parent-2', session: { header: { delegationDepth: 0 } }, options: {} }
  await assert.rejects(status.execute({ batchId: start.batchId }, exec(new AbortController().signal, other)), /another session/)
  await status.execute({ batchId: start.batchId, wait: true, timeout_ms: 5000 }, exec())
})

test('enforces maxAsyncBatches per session', async () => {
  const h = harness({ delays: [500] })
  const tool = h.configure({ concurrency: 1, maxAsyncBatches: 1 })
  const status = h.statusTool()
  const start = await tool.execute({ tasks: tasks(1), mode: 'async' }, exec())
  await assert.rejects(tool.execute({ tasks: tasks(1), mode: 'async' }, exec()), /running asynchronous batches/)
  await status.execute({ batchId: start.batchId, cancel: true }, exec())
})

test('retains only the configured number of finished batches', async () => {
  const h = harness({ delays: [10] })
  const tool = h.configure({ concurrency: 1, retainedBatches: 1 })
  const status = h.statusTool()
  const first = await tool.execute({ tasks: tasks(1), mode: 'async' }, exec())
  await status.execute({ batchId: first.batchId, wait: true, timeout_ms: 5000 }, exec())
  const second = await tool.execute({ tasks: tasks(1), mode: 'async' }, exec())

  await assert.rejects(status.execute({ batchId: first.batchId }, exec()), /unknown or expired/)
  await status.execute({ batchId: second.batchId, wait: true, timeout_ms: 5000 }, exec())
})

test('a disposed parent cancels its running asynchronous batches', async () => {
  const h = harness({ delays: [1000] })
  const tool = h.configure({ concurrency: 1 })
  const status = h.statusTool()
  const start = await tool.execute({ tasks: tasks(1), mode: 'async' }, exec())

  h.emit('agent/disposed', { agent })
  const final = await status.execute({ batchId: start.batchId, wait: true, timeout_ms: 5000 }, exec())
  assert.equal(final.status, 'cancelled')
})
