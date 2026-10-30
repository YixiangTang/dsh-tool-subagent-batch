/**
 * `subagent_batch` — a rolling-window batch scheduler over the DSH subagent seam.
 *
 * One tool call carries a list of independent subtasks and a concurrency
 * window. The tool starts up to `concurrency` fresh children, and every time a
 * child settles it immediately admits the next queued task.
 *
 * Two modes share the same scheduler:
 *   - `sync`  blocks until every task settles and returns the full report.
 *   - `async` returns a batch id immediately, keeps the pool running in the
 *             background, and is collected with `subagent_batch_status`.
 *
 * Concurrency is user-owned by default: it comes from plugin configuration, an
 * environment variable, or a hardware recommendation. The model can only
 * choose it when the user explicitly opts in.
 *
 * The plugin imports Node builtins only, so it can be mounted straight from a
 * file path through a profile patch row without a package installation.
 *
 * @module dsh-tool-subagent-batch
 */

import { randomUUID } from 'node:crypto'
import os from 'node:os'

/** Cordis plugin name. */
export const name = 'tool-subagent-batch'

/** Services this plugin registers into and delegates through. */
export const inject = ['tools', 'subagents']

/** Environment variable that overrides `concurrency: auto`. */
export const CONCURRENCY_ENV = 'DSH_SUBAGENT_BATCH_CONCURRENCY'

/** Bytes in one GiB. */
const GIB = 1024 ** 3

/** Upper bound on an automatically recommended window, independent of config. */
const MAX_RECOMMENDED = 8

/** Default plugin configuration. */
const DEFAULTS = Object.freeze({
  /** Subagent provider name registered on `ctx.subagents` (e.g. `spawn`). */
  provider: 'spawn',
  /** Model-facing tool name. */
  toolName: 'subagent_batch',
  /** Model-facing status tool name for asynchronous batches. */
  statusToolName: 'subagent_batch_status',
  /** Default mode when a call omits `mode`: `sync` or `async`. */
  mode: 'sync',
  /** User-owned window: an integer, or `auto` for a hardware recommendation. */
  concurrency: 'auto',
  /** Largest window `auto`, the environment, or the model may select. */
  maxConcurrency: 8,
  /** Whether the model may request a window: false, 'lower', or true. */
  allowModelConcurrency: false,
  /** Largest number of tasks one call may carry. */
  maxTasks: 32,
  /** Per-task output characters retained in the tool result. */
  outputCharsPerTask: 12000,
  /** Concurrent asynchronous batches allowed per parent session. */
  maxAsyncBatches: 8,
  /** Finished batches retained for later status reads. */
  retainedBatches: 16,
  /** Delegation-depth cap; undefined samples the Host `subagent.maxDepth` setting. */
  maxDepth: undefined,
})

/** Stable provider error code returned when the activation tree is at capacity. */
const CAPACITY_CODE = 'ACTIVATION_LIMIT_REACHED'
/** How many 500 ms waits a capacity rejection may cause before it fails the task. */
const CAPACITY_RETRIES = 30
/** Unknown configuration keys are rejected instead of silently ignored. */
const CONFIG_KEYS = new Set(Object.keys(DEFAULTS))

/** Status-tool wait bounds, in milliseconds. */
const MIN_WAIT_MS = 1000
const MAX_WAIT_MS = 600000
const DEFAULT_WAIT_MS = 60000

/** One batch report schema shared by the batch and status tools. */
const REPORT_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    batchId: { type: 'string' },
    mode: { type: 'string', enum: ['sync', 'async'] },
    status: { type: 'string', enum: ['running', 'completed', 'cancelled'] },
    total: { type: 'integer' },
    completed: { type: 'integer' },
    failed: { type: 'integer' },
    cancelled: { type: 'integer' },
    skipped: { type: 'integer' },
    pending: { type: 'integer' },
    running: { type: 'integer' },
    concurrency: { type: 'integer' },
    concurrencySource: { type: 'string', enum: ['config', 'env', 'auto', 'model'] },
    startedAt: { type: 'string' },
    finishedAt: { type: 'string' },
    durationMs: { type: 'integer' },
    results: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          index: { type: 'integer' },
          description: { type: 'string' },
          status: { type: 'string', enum: ['pending', 'running', 'completed', 'failed', 'cancelled', 'skipped'] },
          childId: { type: 'string' },
          stopReason: { type: 'string' },
          output: { type: 'string' },
          outputTruncated: { type: 'boolean' },
          durationMs: { type: 'integer' },
          error: { type: 'string' },
          diagnostic: { type: 'string' },
        },
        required: ['index', 'description', 'status', 'output', 'outputTruncated', 'durationMs'],
      },
    },
  },
  required: ['batchId', 'mode', 'status', 'total', 'completed', 'failed', 'cancelled', 'skipped', 'pending', 'running', 'concurrency', 'concurrencySource', 'startedAt', 'durationMs', 'results'],
}

/**
 * Read and validate plugin configuration at mount time.
 * @param raw - the loader-supplied configuration, possibly absent.
 * @returns the complete configuration.
 * @throws {TypeError} on an unknown field or an invalid value.
 */
function readConfig(raw) {
  if (raw === undefined || raw === null) raw = {}
  if (typeof raw !== 'object' || Array.isArray(raw)) throw new TypeError('[subagent-batch] config must be an object')
  for (const key of Object.keys(raw)) if (!CONFIG_KEYS.has(key)) throw new TypeError(`[subagent-batch] unknown config field "${key}" (known: ${[...CONFIG_KEYS].join(', ')})`)
  const config = { ...DEFAULTS, ...raw }
  if (typeof config.provider !== 'string' || config.provider.trim() === '') throw new TypeError('[subagent-batch] config.provider must be a non-empty string')
  if (typeof config.toolName !== 'string' || !/^[a-z][a-z0-9_]*$/.test(config.toolName)) throw new TypeError('[subagent-batch] config.toolName must match /^[a-z][a-z0-9_]*$/')
  if (typeof config.statusToolName !== 'string' || !/^[a-z][a-z0-9_]*$/.test(config.statusToolName)) throw new TypeError('[subagent-batch] config.statusToolName must match /^[a-z][a-z0-9_]*$/')
  if (config.statusToolName === config.toolName) throw new TypeError('[subagent-batch] config.statusToolName must differ from config.toolName')
  if (config.mode !== 'sync' && config.mode !== 'async') throw new TypeError('[subagent-batch] config.mode must be "sync" or "async"')
  config.maxConcurrency = positiveInteger(config.maxConcurrency, 'config.maxConcurrency', 1, 64)
  if (config.concurrency !== 'auto') {
    config.concurrency = positiveInteger(config.concurrency, 'config.concurrency', 1, config.maxConcurrency)
  }
  if (config.allowModelConcurrency !== false && config.allowModelConcurrency !== true && config.allowModelConcurrency !== 'lower') {
    throw new TypeError('[subagent-batch] config.allowModelConcurrency must be false, "lower", or true')
  }
  config.maxTasks = positiveInteger(config.maxTasks, 'config.maxTasks', 1, 256)
  config.outputCharsPerTask = positiveInteger(config.outputCharsPerTask, 'config.outputCharsPerTask', 500, 1000000)
  config.maxAsyncBatches = positiveInteger(config.maxAsyncBatches, 'config.maxAsyncBatches', 1, 64)
  config.retainedBatches = positiveInteger(config.retainedBatches, 'config.retainedBatches', 1, 256)
  if (config.maxDepth !== undefined) config.maxDepth = nonNegativeInteger(config.maxDepth, 'config.maxDepth')
  return config
}

/** Assert a positive safe integer inside an inclusive range. */
function positiveInteger(value, label, min, max) {
  if (!Number.isSafeInteger(value) || value < min || value > max) throw new TypeError(`[subagent-batch] ${label} must be an integer from ${min} to ${max}`)
  return value
}

/** Assert a non-negative safe integer. */
function nonNegativeInteger(value, label) {
  if (!Number.isSafeInteger(value) || value < 0 || Object.is(value, -0)) throw new TypeError(`[subagent-batch] ${label} must be a non-negative safe integer`)
  return value
}

/** Clamp an integer into an inclusive range. */
function clamp(value, min, max) {
  return Math.max(min, Math.min(max, value))
}

/** Round to one decimal for human-facing output. */
function round1(value) {
  return Math.round(value * 10) / 10
}

/**
 * Read one machine description, honoring an injected value for tests.
 * @param machine - optional `{ cores, totalGiB, freeGiB }`.
 * @returns normalized machine facts.
 */
function readMachine(machine) {
  if (machine !== undefined) {
    return {
      cores: Math.max(1, Math.floor(Number(machine.cores) || 1)),
      totalGiB: Math.max(0, Number(machine.totalGiB) || 0),
      freeGiB: Math.max(0, Number(machine.freeGiB) || 0),
    }
  }
  return {
    cores: Math.max(1, Math.floor(typeof os.availableParallelism === 'function' ? os.availableParallelism() : os.cpus().length)),
    totalGiB: os.totalmem() / GIB,
    freeGiB: os.freemem() / GIB,
  }
}

/**
 * Recommend a rolling-window size from the machine's CPU and memory.
 *
 * Subagents are mostly I/O-bound (waiting on model and tool calls), so the CPU
 * budget assumes roughly one child per two hardware threads, with a floor of
 * two on multi-core machines. Memory is the harder limit: every in-process
 * child keeps a session, a model loop, and its transcript alive. Headroom
 * shrinks the window when free memory is already tight.
 *
 * @param options - `max` ceiling, optional host admission cap, optional machine facts.
 * @returns recommendation plus the facts that produced it.
 */
export function recommendConcurrency(options = {}) {
  const max = Number.isSafeInteger(options.max) && options.max > 0 ? options.max : MAX_RECOMMENDED
  const hostCap = Number.isSafeInteger(options.hostCap) && options.hostCap > 0 ? options.hostCap : undefined
  const machine = readMachine(options.machine)

  const cpuBudget = machine.cores <= 1 ? 1 : clamp(Math.ceil(machine.cores / 2), 2, 6)
  const memoryBudget = clamp(Math.floor((machine.totalGiB - 1) / 1.5), 1, 8)
  const headroomBudget = machine.freeGiB < 1 ? 1 : machine.freeGiB < 2 ? 2 : 8
  const cap = clamp(Math.min(max, hostCap ?? MAX_RECOMMENDED, MAX_RECOMMENDED), 1, 64)
  const concurrency = Math.max(1, Math.min(cpuBudget, memoryBudget, headroomBudget, cap))
  const reason = `${machine.cores} logical cores, ${round1(machine.totalGiB)} GiB RAM (${round1(machine.freeGiB)} GiB free): CPU budget ${cpuBudget}, memory budget ${memoryBudget}, free-memory headroom ${headroomBudget}, cap ${cap} → ${concurrency}`

  return {
    concurrency,
    cores: machine.cores,
    totalGiB: round1(machine.totalGiB),
    freeGiB: round1(machine.freeGiB),
    cpuBudget,
    memoryBudget,
    headroomBudget,
    cap,
    reason,
  }
}

/**
 * Parse a user-supplied concurrency string.
 * @param raw - trimmed environment value.
 * @returns an integer, `'auto'`, or undefined when invalid.
 */
function parseConcurrency(raw) {
  const text = raw.trim().toLowerCase()
  if (text === 'auto') return 'auto'
  if (!/^\d+$/.test(text)) return undefined
  const value = Number(text)
  return Number.isSafeInteger(value) && value > 0 ? value : undefined
}

/**
 * Resolve the user-owned concurrency for this mount.
 *
 * Precedence: an explicit numeric config wins; otherwise the environment
 * variable chooses when set; otherwise the hardware recommendation applies.
 *
 * @param config - validated plugin configuration.
 * @param options - `env`, host admission cap, optional machine facts.
 * @returns effective concurrency, provenance, reason, and any warning.
 */
export function resolveConcurrency(config, options = {}) {
  const env = options.env ?? process.env
  const hostCap = Number.isSafeInteger(options.hostCap) && options.hostCap > 0 ? options.hostCap : undefined
  const admissionCap = hostCap === undefined ? config.maxConcurrency : Math.min(hostCap, config.maxConcurrency)

  if (typeof config.concurrency === 'number') {
    return {
      concurrency: clamp(config.concurrency, 1, admissionCap),
      source: 'config',
      reason: `configured concurrency ${config.concurrency}`,
      ...config.concurrency > admissionCap ? { warning: `config.concurrency ${config.concurrency} exceeds the admission cap ${admissionCap}; using ${admissionCap}` } : {},
    }
  }

  const raw = env[CONCURRENCY_ENV]
  if (typeof raw === 'string' && raw.trim() !== '') {
    const parsed = parseConcurrency(raw)
    if (parsed === undefined) {
      return {
        ...autoResolve(config, { hostCap, machine: options.machine }),
        warning: `ignored invalid ${CONCURRENCY_ENV}=${JSON.stringify(raw)} (expected a positive integer or "auto")`,
      }
    }
    if (parsed !== 'auto') {
      return {
        concurrency: clamp(parsed, 1, admissionCap),
        source: 'env',
        reason: `${CONCURRENCY_ENV}=${raw.trim()}`,
        ...parsed > admissionCap ? { warning: `${CONCURRENCY_ENV} ${parsed} exceeds the admission cap ${admissionCap}; using ${admissionCap}` } : {},
      }
    }
  }

  return autoResolve(config, { hostCap, machine: options.machine })
}

/** Build the `auto` resolution branch. */
function autoResolve(config, options) {
  const recommendation = recommendConcurrency({ max: config.maxConcurrency, hostCap: options.hostCap, machine: options.machine })
  return {
    concurrency: recommendation.concurrency,
    source: 'auto',
    reason: recommendation.reason,
    machine: recommendation,
  }
}

/**
 * Render a thrown value as one diagnostic line.
 * @param error - any thrown value.
 * @returns readable text.
 */
function failureText(error) {
  if (error && typeof error === 'object') {
    const message = typeof error.message === 'string' ? error.message : String(error)
    const code = typeof error.code === 'string' && error.code !== '' ? ` (${error.code})` : ''
    return `${message}${code}`
  }
  return String(error)
}

/** Whether an admission failure is the Host capacity refusal that waiting can cure. */
function isCapacityError(error) {
  if (!error || typeof error !== 'object') return false
  if (error.code === CAPACITY_CODE) return true
  return typeof error.message === 'string' && error.message.includes(CAPACITY_CODE)
}

/**
 * Sleep, but wake immediately on cancellation.
 * @param ms - delay in milliseconds.
 * @param signal - caller cancellation.
 * @returns a promise settling after the delay or on abort.
 */
function sleep(ms, signal) {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      reject(signal.reason)
      return
    }
    const onAbort = () => {
      clearTimeout(timer)
      reject(signal.reason)
    }
    const timer = setTimeout(() => {
      signal.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    signal.addEventListener('abort', onAbort, { once: true })
  })
}

/**
 * Validate the model-supplied task list without trusting the parameter schema.
 * @param raw - model-supplied `tasks`.
 * @param config - plugin configuration.
 * @returns canonical tasks.
 * @throws {Error} with a model-actionable message.
 */
function readTasks(raw, config) {
  if (!Array.isArray(raw) || raw.length === 0) throw new Error('subagent_batch requires `tasks` to be a non-empty array')
  if (raw.length > config.maxTasks) throw new Error(`subagent_batch received ${raw.length} tasks; this deployment allows at most ${config.maxTasks} per call — split the batch into multiple calls`)
  const tasks = []
  for (let index = 0; index < raw.length; index++) {
    const item = raw[index]
    const label = `tasks[${index}]`
    if (item === null || typeof item !== 'object' || Array.isArray(item)) throw new Error(`${label} must be an object with description, prompt, and optional cwd`)
    for (const key of Object.keys(item)) if (key !== 'description' && key !== 'prompt' && key !== 'cwd') throw new Error(`${label} has unknown field "${key}"; allowed fields: description, prompt, cwd`)
    const description = typeof item.description === 'string' ? item.description.trim() : ''
    const prompt = typeof item.prompt === 'string' ? item.prompt.trim() : ''
    if (description === '') throw new Error(`${label}.description must be a non-empty short label`)
    if (prompt === '') throw new Error(`${label}.prompt must be a non-empty, fully self-contained task`)
    if (item.cwd !== undefined && (typeof item.cwd !== 'string' || item.cwd.trim() === '')) throw new Error(`${label}.cwd must be a non-empty path string when supplied`)
    tasks.push({
      description,
      prompt,
      ...item.cwd === undefined ? {} : { cwd: item.cwd },
    })
  }
  return tasks
}

/**
 * Read and validate the requested mode.
 * @param raw - model-supplied `mode`, possibly absent.
 * @param config - plugin configuration.
 * @returns `sync` or `async`.
 */
function readMode(raw, config) {
  if (raw === undefined || raw === null) return config.mode
  if (raw !== 'sync' && raw !== 'async') throw new Error('`mode` must be "sync" or "async"')
  return raw
}

/**
 * Read an optional model-requested window, enforcing the user's policy.
 * @param raw - model-supplied `concurrency`.
 * @param config - plugin configuration.
 * @param resolution - the user-owned resolution.
 * @param hostCap - the Host admission cap, when known.
 * @returns the accepted window.
 */
function readRequestedConcurrency(raw, config, resolution, hostCap) {
  if (!Number.isSafeInteger(raw) || raw < 1) throw new Error('`concurrency` must be a positive integer')
  const ceiling = config.allowModelConcurrency === 'lower'
    ? resolution.concurrency
    : Math.min(config.maxConcurrency, hostCap ?? config.maxConcurrency)
  if (raw > ceiling) {
    throw new Error(config.allowModelConcurrency === 'lower'
      ? `\`concurrency\` may only lower the user's window (${resolution.concurrency}); ${raw} is too large. Omit it to use ${resolution.concurrency}.`
      : `\`concurrency\` cannot exceed the configured maximum ${ceiling}.`)
  }
  return raw
}

/** Read and bound a status wait timeout. */
function readTimeout(raw) {
  if (raw === undefined || raw === null) return DEFAULT_WAIT_MS
  if (!Number.isSafeInteger(raw) || raw < MIN_WAIT_MS || raw > MAX_WAIT_MS) throw new Error(`\`timeout_ms\` must be an integer from ${MIN_WAIT_MS} to ${MAX_WAIT_MS}`)
  return raw
}

/**
 * Wait for a promise at most `ms`, resolving either way.
 * @param promise - the work to wait for.
 * @param ms - timeout in milliseconds.
 * @returns whether the promise settled before the timeout.
 */
function waitAtMost(promise, ms) {
  return new Promise((resolve) => {
    const timer = setTimeout(() => {
      resolve(false)
    }, ms)
    promise.then(() => {
      clearTimeout(timer)
      resolve(true)
    }, () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

/**
 * Render a subagent output block list as plain text.
 * @param output - final assistant content blocks.
 * @returns joined text.
 */
function outputText(output) {
  if (!Array.isArray(output)) return ''
  const parts = []
  for (const block of output) {
    if (block === null || typeof block !== 'object') continue
    if (block.type === 'text' && typeof block.text === 'string') parts.push(block.text)
    else if (block.type === 'image') parts.push('[image omitted from batch result]')
  }
  return parts.join('\n').trim()
}

/**
 * Clip one child's answer to the configured per-task budget.
 * @param text - full text.
 * @param limit - character budget.
 * @returns retained text plus whether clipping happened.
 */
function clipOutput(text, limit) {
  if (text.length <= limit) return { output: text, truncated: false }
  const omitted = text.length - limit
  return {
    output: `${text.slice(0, limit)}\n…[${omitted} characters omitted; full output remains in the child session]`,
    truncated: true,
  }
}

/** Compact duration for the model-facing render. */
function formatDuration(ms) {
  if (ms < 1000) return `${ms}ms`
  if (ms < 60000) return `${(ms / 1000).toFixed(1)}s`
  const minutes = Math.floor(ms / 60000)
  const seconds = Math.round((ms % 60000) / 1000)
  return `${minutes}m ${String(seconds).padStart(2, '0')}s`
}

/** Human-readable provenance of the effective window. */
function sourceLabel(source) {
  switch (source) {
    case 'config': return 'configured by the user'
    case 'env': return `set by ${CONCURRENCY_ENV}`
    case 'model': return 'requested by the agent'
    default: return 'auto-detected from this machine'
  }
}

/** Build the model-facing batch tool description. */
function describe(config, resolution) {
  const ownership = config.allowModelConcurrency === false
    ? 'The window is fixed by the user and this call has no concurrency parameter. '
    : config.allowModelConcurrency === 'lower'
      ? `This call may pass a smaller \`concurrency\` (1..${resolution.concurrency}) for a more conservative batch, but never a larger one. `
      : `This call may pass \`concurrency\` from 1 to ${config.maxConcurrency} when the user explicitly asks for a different window. `
  return (
    'Run several independent subtasks in one call through managed subagents, using a rolling concurrency window: '
    + `by default up to ${resolution.concurrency} children run at once (${sourceLabel(resolution.source)}), and every time a child settles the next queued task starts immediately. `
    + 'Prefer this over calling `subagent` once per task when you have many independent subtasks or want a bounded, self-refilling batch. '
    + 'Two modes are available. `sync` blocks until every task settles and returns the complete report. '
    + `\`async\` returns a batch id immediately, keeps the pool running in the background, and is collected later with \`${config.statusToolName}\`. `
    + `The configured default is \`${config.mode}\`. `
    + ownership
    + 'Each child is a fresh agent that does not see this conversation, so every `prompt` must be fully self-contained. '
    + 'The final report carries each child\'s answer, stop reason, and durable child id; you are the scheduler and the acceptance reviewer — verify each result, then retry or continue individual children (e.g. with `send_message` to a returned child id) when the deployment offers that tool. '
    + 'Tasks start in submission order. A failed task does not stop the others unless `fail_fast` is true. Cancelling a sync call stops admissions and cancels running children; an async batch is cancelled through the status tool. '
    + 'For long deliverables, ask each child to write files and report a short summary instead of returning the whole artifact in its final message.'
  )
}

/**
 * Install the tools.
 * @param ctx - registrant context carrying `tools` and `subagents`.
 * @param rawConfig - loader configuration.
 */
export function apply(ctx, rawConfig) {
  const config = readConfig(rawConfig)
  const hostCap = readHostAdmissionCap(ctx)
  const resolution = resolveConcurrency(config, { hostCap })
  if (resolution.warning !== undefined) ctx.logger?.warn?.(`[subagent-batch] ${resolution.warning}`)
  ctx.logger?.info?.(`[subagent-batch] concurrency ${resolution.concurrency} (${resolution.source}) — ${resolution.reason}`)

  /** @type {Map<string, ReturnType<typeof createBatch>>} */
  const batches = new Map()

  const pruneBatches = () => {
    const finished = [...batches.values()].filter((batch) => batch.settled)
    while (batches.size > config.retainedBatches && finished.length > 0) {
      const oldest = finished.shift()
      batches.delete(oldest.id)
    }
  }

  const cancelAll = async (reason) => {
    const all = [...batches.values()]
    for (const batch of all) void batch.cancel(reason)
    await Promise.all(all.map((batch) => batch.done))
    batches.clear()
  }

  const parameters = {
    type: 'object',
    additionalProperties: false,
    properties: {
      tasks: {
        type: 'array',
        description: 'The independent subtasks, in submission order.',
        items: {
          type: 'object',
          additionalProperties: false,
          properties: {
            description: {
              type: 'string',
              description: 'A short (3-5 word) label for this task, for display and the batch report.',
            },
            prompt: {
              type: 'string',
              description: 'The complete, self-contained task for the child. The child does not share this conversation, so include every needed fact and instruction.',
            },
            cwd: {
              type: 'string',
              description: 'Optional initial working directory for this child. Relative paths resolve against your current directory; omitted inherits it.',
            },
          },
          required: ['description', 'prompt'],
        },
      },
      mode: {
        type: 'string',
        enum: ['sync', 'async'],
        description: `sync waits for every task and returns the full report; async returns a batch id immediately and runs in the background for \`${config.statusToolName}\`. Default ${config.mode}.`,
      },
      fail_fast: {
        type: 'boolean',
        description: 'When true, stop starting queued tasks after the first failure; already-running children still finish. Default false.',
      },
    },
    required: ['tasks'],
  }
  if (config.allowModelConcurrency !== false) {
    parameters.properties.concurrency = {
      type: 'integer',
      description: config.allowModelConcurrency === 'lower'
        ? `Optional smaller window (1..${resolution.concurrency}); omit to use the user's ${resolution.concurrency}.`
        : `Optional window (1..${config.maxConcurrency}); omit to use the user's ${resolution.concurrency}.`,
    }
  }

  const batchTool = {
    name: config.toolName,
    description: describe(config, resolution),
    parameters,
    output: {
      schema: REPORT_SCHEMA,
      render: (args, value) => renderResult(args, value, config),
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error('subagent_batch requires an owning agent session')
      const signal = exec.signal
      signal.throwIfAborted()
      const tasks = readTasks(args?.tasks, config)
      const mode = readMode(args?.mode, config)
      const failFast = args?.fail_fast === true
      const maxDepth = resolveMaxDepth(ctx, config)
      assertDepth(maxDepth, parent)

      let concurrency = resolution.concurrency
      let concurrencySource = resolution.source
      if (config.allowModelConcurrency === false) {
        if (args?.concurrency !== undefined) throw new Error('`concurrency` is user-controlled in this deployment; omit it, or ask the user to enable allowModelConcurrency.')
      } else if (args?.concurrency !== undefined) {
        concurrency = readRequestedConcurrency(args.concurrency, config, resolution, hostCap)
        concurrencySource = 'model'
      }

      const provider = ctx.subagents.getProvider(config.provider)
      if (provider === undefined) throw new Error(`subagent_batch: subagent provider "${config.provider}" is not registered; mount a provider plugin such as @deepseek-ai/dsh-subagent-spawn-in-process`)

      if (mode === 'async') {
        const active = [...batches.values()].filter((batch) => batch.parentId === parent.id && !batch.settled).length
        if (active >= config.maxAsyncBatches) throw new Error(`this session already has ${active} running asynchronous batches; the limit is ${config.maxAsyncBatches}. Wait for one to finish or raise maxAsyncBatches.`)
        const batch = createBatch({ ctx, config, parent, tasks, concurrency, concurrencySource, mode, failFast, maxDepth })
        batches.set(batch.id, batch)
        pruneBatches()
        return batch.report()
      }

      const batch = createBatch({ ctx, config, parent, tasks, concurrency, concurrencySource, mode, failFast, maxDepth })
      const onAbort = () => { void batch.cancel(signal.reason) }
      signal.addEventListener('abort', onAbort, { once: true })
      try {
        const report = await batch.done
        signal.throwIfAborted()
        return report
      } finally {
        signal.removeEventListener('abort', onAbort)
      }
    },
  }

  const statusTool = {
    name: config.statusToolName,
    description: `Inspect, wait for, or cancel an asynchronous batch started by \`${config.toolName}\` with \`mode: "async"\`. Only the session that started the batch may read it. Use \`wait: true\` to block until the batch settles or \`timeout_ms\` expires; use \`cancel: true\` to stop every running child and skip the queue.`,
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        batchId: {
          type: 'string',
          description: 'The batch id returned by the asynchronous start call.',
        },
        wait: {
          type: 'boolean',
          description: `When true, wait until the batch settles or timeout_ms expires. Default false.`,
        },
        timeout_ms: {
          type: 'integer',
          description: `Maximum wait in milliseconds (${MIN_WAIT_MS}..${MAX_WAIT_MS}, default ${DEFAULT_WAIT_MS}).`,
        },
        cancel: {
          type: 'boolean',
          description: 'When true, cancel the batch and wait for its children to stop. Default false.',
        },
      },
      required: ['batchId'],
    },
    output: {
      schema: REPORT_SCHEMA,
      render: (args, value) => renderResult(args, value, config),
    },
    async execute(args, exec) {
      const parent = exec.agent
      if (parent === undefined) throw new Error(`${config.statusToolName} requires an owning agent session`)
      const batchId = typeof args?.batchId === 'string' ? args.batchId.trim() : ''
      if (batchId === '') throw new Error('`batchId` must be the id returned by an asynchronous batch start')
      const batch = batches.get(batchId)
      if (batch === undefined) throw new Error(`unknown or expired batch "${batchId}"; asynchronous batches live in this process and are retained only for recent status reads`)
      if (batch.parentId !== parent.id) throw new Error(`batch "${batchId}" belongs to another session`)
      if (args?.cancel === true) {
        await batch.cancel(new Error('cancelled by the owning session'))
        return batch.report()
      }
      if (args?.wait === true) {
        await waitAtMost(batch.done, readTimeout(args?.timeout_ms))
      }
      return batch.report()
    },
  }

  ctx.effect(() => ctx.tools.register(batchTool))
  ctx.effect(() => ctx.tools.register(statusTool))
  ctx.on('agent/disposed', ({ agent }) => {
    for (const batch of batches.values()) {
      if (batch.parentId === agent.id && !batch.settled) void batch.cancel(new Error('parent session disposed'))
    }
  })
  ctx.effect(() => () => cancelAll(new Error('plugin disposed')))
}

/**
 * Build one batch: the queue, the rolling window, cancellation, and snapshots.
 * The scheduler starts immediately; callers await `done` (sync) or store the
 * batch for later status reads (async).
 *
 * @param options - context, config, parent, tasks, window, and mode.
 * @returns the live batch handle.
 */
function createBatch(options) {
  const { ctx, config, parent, tasks, concurrency, concurrencySource, mode, failFast, maxDepth } = options
  const id = `batch-${randomUUID()}`
  const startedAt = Date.now()
  const controller = new AbortController()
  const signal = controller.signal
  const results = new Array(tasks.length)
  const states = new Array(tasks.length).fill('pending')
  const stateStarted = new Array(tasks.length).fill(0)
  /** @type {Map<number, {activation?: any, disposal?: Promise<void>, startedAt: number}>} */
  const runningRecords = new Map()
  /** @type {Map<number, Promise<void>>} */
  const runningPromises = new Map()
  let cursor = 0
  let stopStarting = false
  let stopping = false
  let settled = false
  let cancelled = false
  let finishedAt
  let failure
  let resolveDone
  const done = new Promise((resolve) => { resolveDone = resolve })

  const disposeRecord = (record) => {
    if (record.activation === undefined) return Promise.resolve()
    record.disposal ??= Promise.resolve()
      .then(() => record.activation.dispose())
      .catch((error) => {
        ctx.logger?.warn?.(`[subagent-batch] child dispose failed: ${failureText(error)}`)
      })
    return record.disposal
  }

  const onAbort = () => {
    if (settled) return
    stoppedByCancel()
  }

  const stoppedByCancel = () => {
    stopping = true
    cancelled = true
    for (const record of runningRecords.values()) void disposeRecord(record)
  }

  signal.addEventListener('abort', onAbort, { once: true })

  const startActivation = async (task) => {
    let attempt = 0
    for (;;) {
      signal.throwIfAborted()
      if (stopping) throw new Error('batch is stopping')
      try {
        return await ctx.subagents.startActivation({
          provider: config.provider,
          label: task.description,
          delivery: 'caller',
          signal,
          request: {
            parent,
            prompt: [{ type: 'text', text: task.prompt }],
            ...task.cwd === undefined ? {} : { cwd: task.cwd },
            ...maxDepth === undefined ? {} : { maxDepth },
          },
        })
      } catch (error) {
        if (!isCapacityError(error) || attempt >= CAPACITY_RETRIES) throw error
        attempt += 1
        await sleep(500, signal)
      }
    }
  }

  const runOne = async (index) => {
    const task = tasks[index]
    const record = { startedAt: Date.now() }
    states[index] = 'running'
    stateStarted[index] = record.startedAt
    let outcome
    try {
      const activation = await startActivation(task)
      record.activation = activation
      runningRecords.set(index, record)
      if (stopping || signal.aborted) {
        await disposeRecord(record)
        outcome = baseOutcome(index, task, 'cancelled', record.startedAt, activation.childId)
      } else {
        let settledResult
        try {
          settledResult = await activation.result
        } catch (error) {
          outcome = stopping || signal.aborted
            ? baseOutcome(index, task, 'cancelled', record.startedAt, activation.childId)
            : {
                ...baseOutcome(index, task, 'failed', record.startedAt, activation.childId),
                error: failureText(error),
              }
        }
        if (outcome === undefined) {
          const stopReason = typeof settledResult?.stopReason === 'string' ? settledResult.stopReason : 'error'
          const text = outputText(settledResult?.output)
          const clipped = clipOutput(text, config.outputCharsPerTask)
          const status = stopReason === 'completed' ? 'completed' : stopReason === 'aborted' ? 'cancelled' : 'failed'
          outcome = {
            ...baseOutcome(index, task, status, record.startedAt, activation.childId),
            stopReason,
            output: clipped.output,
            outputTruncated: clipped.truncated,
            ...typeof settledResult?.diagnostic === 'string' && settledResult.diagnostic !== '' ? { diagnostic: settledResult.diagnostic } : {},
            ...status === 'failed' ? { error: `child stopped with reason "${stopReason}"` } : {},
          }
        }
      }
    } catch (error) {
      outcome = stopping || signal.aborted
        ? baseOutcome(index, task, 'cancelled', record.startedAt, undefined)
        : {
            ...baseOutcome(index, task, 'failed', record.startedAt, undefined),
            error: failureText(error),
          }
    } finally {
      await disposeRecord(record)
      runningRecords.delete(index)
    }
    results[index] = outcome
    states[index] = outcome.status
    if (outcome.status === 'failed' && failFast) stopStarting = true
  }

  const taskView = (index) => {
    const settledTask = results[index]
    if (settledTask !== undefined) return settledTask
    const running = states[index] === 'running'
    const record = runningRecords.get(index)
    return {
      index: index + 1,
      description: tasks[index].description,
      status: running ? 'running' : 'pending',
      ...record?.activation?.childId === undefined ? {} : { childId: record.activation.childId },
      output: '',
      outputTruncated: false,
      durationMs: running ? Math.max(0, Date.now() - stateStarted[index]) : 0,
    }
  }

  const report = () => {
    const views = tasks.map((_, index) => taskView(index))
    const counts = { completed: 0, failed: 0, cancelled: 0, skipped: 0, pending: 0, running: 0 }
    for (const view of views) counts[view.status] += 1
    return {
      batchId: id,
      mode,
      status: settled ? (cancelled ? 'cancelled' : 'completed') : 'running',
      total: tasks.length,
      ...counts,
      concurrency,
      concurrencySource,
      startedAt: new Date(startedAt).toISOString(),
      ...finishedAt === undefined ? {} : { finishedAt: new Date(finishedAt).toISOString() },
      durationMs: Math.max(0, (finishedAt ?? Date.now()) - startedAt),
      results: views,
    }
  }

  const run = async () => {
    try {
      while (cursor < tasks.length || runningPromises.size > 0) {
        if (!stopStarting && !stopping && !signal.aborted) {
          while (runningPromises.size < concurrency && cursor < tasks.length) {
            const index = cursor
            cursor += 1
            const promise = runOne(index)
            runningPromises.set(index, promise)
            void promise.then(
              () => runningPromises.delete(index),
              () => runningPromises.delete(index),
            )
          }
        }
        if (runningPromises.size === 0) break
        await Promise.race(runningPromises.values())
      }
    } catch (error) {
      failure = failureText(error)
      ctx.logger?.warn?.(`[subagent-batch] batch ${id} scheduler failed: ${failure}`)
    } finally {
      for (let index = 0; index < tasks.length; index++) {
        if (results[index] === undefined) {
          results[index] = {
            ...baseOutcome(index, tasks[index], 'skipped', Date.now(), undefined),
            error: cancelled
              ? 'not started because the batch was cancelled'
              : stopStarting
                ? 'not started because fail_fast was triggered'
                : failure === undefined
                  ? 'not started'
                  : `not started because the batch runner failed: ${failure}`,
          }
        }
        if (states[index] === 'running') states[index] = results[index].status
      }
      settled = true
      finishedAt = Date.now()
      resolveDone(report())
    }
  }

  void run()

  return {
    id,
    parentId: parent.id,
    mode,
    get settled() { return settled },
    done,
    report,
    cancel(reason) {
      if (settled) return done
      cancelled = true
      controller.abort(reason ?? new Error('batch cancelled'))
      return done
    },
  }
}

/**
 * Read the Host's live `maxActiveSubagents` admission cap when available.
 * @param ctx - registrant context.
 * @returns the cap as a positive integer, or undefined.
 */
function readHostAdmissionCap(ctx) {
  try {
    const ref = ctx.subagents?.config?.maxActiveSubagents
    const value = typeof ref?.get === 'function' ? ref.get() : undefined
    return Number.isSafeInteger(value) && value > 0 ? value : undefined
  } catch {
    return undefined
  }
}

/**
 * Shared fields of one per-task outcome.
 * @param index - zero-based task index.
 * @param task - canonical task.
 * @param status - outcome status.
 * @param startedAt - wall-clock start.
 * @param childId - child session id when a child was admitted.
 * @returns outcome fields.
 */
function baseOutcome(index, task, status, startedAt, childId) {
  return {
    index: index + 1,
    description: task.description,
    status,
    ...childId === undefined ? {} : { childId },
    output: '',
    outputTruncated: false,
    durationMs: Math.max(0, Date.now() - startedAt),
  }
}

/**
 * Resolve the numeric depth cap: explicit config, else the Host setting.
 * @param ctx - registrant context.
 * @param config - plugin configuration.
 * @returns numeric cap or undefined for no cap.
 */
function resolveMaxDepth(ctx, config) {
  if (config.maxDepth !== undefined) return config.maxDepth
  if (typeof ctx.subagents.resolveMaxDepth !== 'function') return undefined
  return ctx.subagents.resolveMaxDepth(undefined)
}

/**
 * Reject delegation from an agent that already sits at the depth cap.
 * @param maxDepth - the resolved numeric cap, if any.
 * @param agent - calling agent.
 */
function assertDepth(maxDepth, agent) {
  if (maxDepth === undefined) return
  const headerDepth = agent.session?.header?.delegationDepth
  const optionDepth = agent.options?.subagentDepth
  const depth = Math.max(
    Number.isSafeInteger(headerDepth) ? headerDepth : 0,
    Number.isSafeInteger(optionDepth) ? optionDepth : 0,
  )
  if (depth + 1 > maxDepth) throw new Error(`subagent_batch cannot delegate from depth ${depth}: the configured maximum delegation depth is ${maxDepth}. Do this work directly, or raise the Host subagent.maxDepth setting or this plugin's maxDepth config.`)
}

/**
 * Model-facing render of one batch report.
 * @param _args - call arguments (unused).
 * @param value - validated batch report.
 * @param config - plugin configuration.
 * @returns tool content blocks.
 */
function renderResult(_args, value, config) {
  const counts = [
    `${value.completed}/${value.total} completed`,
    ...value.failed > 0 ? [`${value.failed} failed`] : [],
    ...value.cancelled > 0 ? [`${value.cancelled} cancelled`] : [],
    ...value.skipped > 0 ? [`${value.skipped} skipped`] : [],
    ...value.running > 0 ? [`${value.running} running`] : [],
    ...value.pending > 0 ? [`${value.pending} pending`] : [],
  ].join(', ')
  const lines = [
    `Batch ${value.batchId} (${value.mode}): ${value.status} — ${counts} — concurrency ${value.concurrency} (${value.concurrencySource}), ${formatDuration(value.durationMs)}.`,
  ]
  if (value.status === 'running') {
    lines.push(`Still running. Call \`${config.statusToolName}\` with batchId "${value.batchId}" to poll, or add wait:true to block until it settles.`)
  } else {
    lines.push('Review each result below before accepting it; use a child id to continue that child when follow-up tools are available.')
  }
  for (const result of value.results) {
    const details = []
    if (result.childId !== undefined) details.push(`child ${result.childId}`)
    if (result.status === 'pending') details.push('queued')
    else details.push(formatDuration(result.durationMs))
    let head = `[${result.index}] ${result.description} — ${result.status} (${details.join(', ')})`
    if ((result.status === 'failed' || result.status === 'skipped') && result.error !== undefined) head += `: ${result.error}`
    const body = result.output === '' ? (result.status === 'completed' ? '(no closing message)' : '') : result.output
    if (result.diagnostic !== undefined) lines.push(head, body, `diagnostic: ${result.diagnostic}`)
    else lines.push(head, body)
  }
  return [{ type: 'text', text: lines.filter((line) => line !== '').join('\n') }]
}
