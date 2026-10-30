# dsh-tool-subagent-batch

[![License: MIT](https://img.shields.io/badge/license-MIT-blue.svg)](LICENSE)
[![Node.js](https://img.shields.io/badge/node-%3E%3D20-brightgreen.svg)](https://nodejs.org)
[![Runtime dependencies](https://img.shields.io/badge/runtime%20dependencies-0-success.svg)](package.json)

[English](README.md) | **简体中文**

面向 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) 子智能体的滑动窗口批处理调度器。

一次工具调用携带一批独立子任务和一个并发窗口。插件最多同时启动 *N* 个子智能体，**任意一个子智能体一结束，队列里的下一个立刻补进空出的槽位**；全部结束后，调用返回每个子任务的最终答复、停止原因和持久化子会话 id，交由主智能体验收。

```
任务队列：[1] [2] [3] [4] [5] [6]
窗口：    [1] [2] [3]          ← 同时启动
              ↓ 1 结束
窗口：        [2] [3] [4]      ← 4 立即补位
```

## 为什么需要它

DSH 自带的 `subagent` 工具在子智能体被接纳后就立即返回。一次性并发很多个时会出现：

- 宿主的 `maxActiveSubagents` 接纳上限（默认 **8**）会直接拒绝超出的调用，而不是排队；
- 主智能体没有统一的地方收集、对比结果；
- 某个子智能体失败时，它的结果容易淹没在大量完成通知里。

这个插件把它变成一个**有界、可自动补位的池**，并给主智能体一份可验收的汇总结果。

## 功能

- **滑动窗口，而不是固定分批**：任意子智能体结束就补位，不必等整批结束。
- **并发数由用户决定**：支持显式配置、环境变量、本机硬件推荐三种来源；默认不允许模型改动。
- **读取本机配置推荐并发数**：根据逻辑核心数、总内存、空闲内存和宿主接纳上限计算建议值。
- **逐任务验收报告**：状态、最终答复、停止原因、耗时、子会话 id 一目了然。
- **失败隔离**：单个任务失败不会卡住队列；可选 `fail_fast`。
- **协作式取消**：取消工具调用会停止接纳、销毁所有运行中的子智能体，并让未启动任务保持未启动。
- **容量退避**：遇到宿主接纳上限时按 30 次 × 500ms 重试，仍失败才把该任务记为失败。
- **深度保护**：遵守宿主 `subagent.maxDepth` 和当前调用者的委派深度。
- **输出裁剪**：避免一个超长答复撑爆主智能体上下文。
- **零运行时依赖**：只用 Node 内置模块，可作为单文件挂载。

## 工作原理

```mermaid
sequenceDiagram
    participant M as 主智能体
    participant T as subagent_batch
    participant S as ctx.subagents
    participant C1 as 子智能体 1
    participant C2 as 子智能体 2
    participant C3 as 子智能体 3

    M->>T: tasks[1..3]，concurrency 2
    T->>S: startActivation(C1, delivery=caller)
    T->>S: startActivation(C2, delivery=caller)
    S-->>C1: 执行
    S-->>C2: 执行
    T->>T: Promise.race(running)
    C1-->>T: 结果
    T->>S: startActivation(C3, delivery=caller)
    C2-->>T: 结果
    T-->>M: 汇总结果
```

核心调度循环很短：

```js
while (cursor < tasks.length || running.size > 0) {
  while (running.size < concurrency && cursor < tasks.length) {
    running.set(cursor, runOne(cursor++))
  }
  await Promise.race(running.values())   // 任意一个结束就唤醒
}
```

每个 `runOne` 调用 `ctx.subagents.startActivation({ delivery: 'caller', ... })`，等待 `activation.result`，映射停止原因，并在 `finally` 中 `dispose()`。

`delivery: 'caller'` 是刻意选择：子智能体运行时**不会**向父会话注入完成通知，收集工作完全由这次批处理调用负责。主智能体因此只收到一份确定的汇总报告，而不是 *N* 条交错插入的消息。

## 环境要求

| 要求 | 说明 |
|---|---|
| DSH `0.2.x` | 使用 `ctx.subagents.startActivation`、`resolveMaxDepth`、`ctx.tools.register` |
| 子智能体 provider | 默认后端是 `spawn`，由 `@deepseek-ai/dsh-subagent-spawn-in-process` 提供 |
| Node.js 20+ | DSH 已自带兼容的 Node，无需单独安装 |
| 运行时依赖 | 无 |

## 安装

二选一，最终效果都是让模型看到名为 `subagent_batch` 的工具。

### 方式一：作为 bundle 包安装（推荐）

适合希望像普通 DSH 插件一样管理的场景。

```sh
git clone https://github.com/<you>/dsh-tool-subagent-batch.git
cd dsh-tool-subagent-batch
dsh plugin --profile desktop add "link:$PWD"
```

Windows PowerShell：

```powershell
dsh plugin --profile desktop add "link:E:\path\to\dsh-tool-subagent-batch"
```

然后在 profile 的 `package.json` 中选中该 bundle：

```json
{
  "dsh": {
    "profile": {
      "bundles": [
        "@deepseek-ai/dsh-base",
        "@deepseek-ai/dsh-web-app",
        "dsh-tool-subagent-batch"
      ]
    }
  }
}
```

也可以在 **Plugins** 页面启用它，然后重载/重启 profile。包内已声明自己的 bundle patch：[`cordis.patch.yml`](cordis.patch.yml)。

### 方式二：绝对路径零安装挂载

不想动 `node_modules` 时，直接在 `$DSH_HOME/profiles/<profile>/cordis.patch.yml` 添加：

```yaml
- insert:
    - id: tool-subagent-batch
      name: 'E:/path/to/dsh-tool-subagent-batch/index.js'
      config:
        concurrency: auto
```

- 路径要加引号；Windows 下推荐使用正斜杠。
- Loader 会把绝对路径的 `name` 解析成 `file:` URL，因此不需要安装包。
- 启用 HMR 的 profile 会自动重载；否则重启 DSH。

## 配置

| 字段 | 默认值 | 含义 |
|---|---|---|
| `provider` | `spawn` | `ctx.subagents` 上的 provider 名称。 |
| `toolName` | `subagent_batch` | 模型看到的工具名。 |
| `concurrency` | `auto` | 用户决定的窗口：`1..maxConcurrency` 的整数，或 `auto`。 |
| `maxConcurrency` | `8` | `auto`、环境变量以及（启用时）模型可选窗口的上限。 |
| `allowModelConcurrency` | `false` | `false` 不向模型暴露并发参数；`"lower"` 只允许模型调小；`true` 允许模型在 `maxConcurrency` 内选择。 |
| `maxTasks` | `32` | 单次调用最多携带的任务数。 |
| `outputCharsPerTask` | `12000` | 每个子任务答复在报告中保留的字符数。 |
| `maxDepth` | 宿主设置 | 绝对委派深度上限；省略则使用 `subagent.maxDepth`（默认 `1`）。 |

未知字段会在挂载时报错，拼错配置不会静默失效。

## 并发数由用户决定

挂载时的解析顺序：

| 顺序 | 来源 | 何时生效 |
|---|---|---|
| 1 | `config.concurrency: <n>` | 始终优先。 |
| 2 | `DSH_SUBAGENT_BATCH_CONCURRENCY=<n\|auto>` | 仅当 `config.concurrency` 为 `auto`。 |
| 3 | 硬件推荐 | `auto` 的兜底。 |
| 4 | 模型请求 | 仅当 `allowModelConcurrency` 为 `"lower"` 或 `true`。 |

### 获取推荐值

```sh
node bin/recommend.mjs
# 或
npx dsh-subagent-batch-recommend --json
```

在一台 16 核、24 GiB 内存的机器上：

```text
Recommended concurrency: 6
Machine: 16 logical cores, 23.2 GiB RAM (8.9 GiB free)
Why: 16 logical cores, 23.2 GiB RAM (8.9 GiB free): CPU budget 6,
memory budget 8, free-memory headroom 8, cap 8 → 6

Set it in your profile's cordis.patch.yml:

  - id: tool-subagent-batch
    config:
      concurrency: 6
```

推荐规则把子智能体视为以 I/O 等待为主：大约每两个硬件线程一个子智能体（范围 2–6），再受内存预算（`(总内存 − 1 GiB) / 1.5 GiB`）约束；空闲内存紧张时降到 1–2；最后与 `maxConcurrency` 和宿主 `maxActiveSubagents` 取最小值。

### 之后如何调整

```yaml
# 1. 完全由用户固定，模型不能改
- id: tool-subagent-batch
  config:
    concurrency: 4

# 2. 允许模型在本批更保守，但不能超过 4
- id: tool-subagent-batch
  config:
    concurrency: 4
    allowModelConcurrency: lower

# 3. 允许模型在你的上限内自行选择
- id: tool-subagent-batch
  config:
    maxConcurrency: 8
    allowModelConcurrency: true
```

环境变量覆盖（PowerShell / bash）：

```powershell
$env:DSH_SUBAGENT_BATCH_CONCURRENCY = "4"
```

```sh
export DSH_SUBAGENT_BATCH_CONCURRENCY=4
```

## 使用方式

对主智能体说：

> 这里有 6 个独立模块要审查。用 `subagent_batch` 并行处理，最多同时 3 个，全部结束后逐条汇报。

模型会调用：

```json
{
  "tasks": [
    { "description": "审查认证模块", "prompt": "审查 src/auth，关注……只报告发现的问题。" },
    { "description": "审查计费模块", "prompt": "审查 src/billing，关注……" },
    { "description": "审查搜索模块", "prompt": "审查 src/search，关注……" }
  ],
  "fail_fast": false
}
```

当 `concurrency: 3` 时三个子智能体同时启动；当 `concurrency: 2` 时，第三个会在前两个中任意一个结束的瞬间补位。

### 返回结果

```json
{
  "batchId": "batch-1f0c...",
  "total": 3,
  "completed": 2,
  "failed": 1,
  "cancelled": 0,
  "skipped": 0,
  "concurrency": 3,
  "concurrencySource": "config",
  "durationMs": 48210,
  "results": [
    {
      "index": 1,
      "description": "审查认证模块",
      "status": "completed",
      "childId": "session-...",
      "stopReason": "completed",
      "output": "发现两个问题：……",
      "outputTruncated": false,
      "durationMs": 22100
    },
    {
      "index": 2,
      "description": "审查计费模块",
      "status": "failed",
      "childId": "session-...",
      "stopReason": "error",
      "output": "",
      "outputTruncated": false,
      "durationMs": 900,
      "error": "child stopped with reason \"error\"",
      "diagnostic": "..."
    }
  ]
}
```

`childId` 是持久化的子会话 id。如果部署中挂载了 `@deepseek-ai/dsh-tool-subagent-control`，主智能体可以用 `send_message` 继续追问某个子智能体（例如让它修正答案），而不必重跑整批。

### 状态含义

| 状态 | 含义 |
|---|---|
| `completed` | 子智能体以 `stopReason: "completed"` 正常结束。 |
| `failed` | 启动被拒绝、子智能体报错，或停止原因不是完成。 |
| `cancelled` | 因为本次批处理调用被取消而停止。 |
| `skipped` | 从未启动：触发了 `fail_fast`，或整批被取消。 |

## 语义与保证

- **按提交顺序启动**：从索引 0 开始接纳；结果始终按提交顺序返回。
- **任意一个结束就补位**：成功和失败都会释放槽位。
- **有界队列**：同时最多 `concurrency` 个子智能体存活，其余在进程内等待。
- **失败隔离**：默认单个失败不会中断队列；`fail_fast: true` 时只停止启动新任务，运行中的仍会跑完。
- **取消**：监听 `exec.signal`；中止时销毁所有运行中的 activation，停止接纳，等待清理完成后以 `ABORTED` 结束本次调用。
- **容量退避**：`ACTIVATION_LIMIT_REACHED` 每 500ms 重试，最多 30 次，之后只把该任务记为失败。
- **深度限制**：调用者已在深度上限时直接给出可操作的错误，而不是启动一个注定失败的子智能体。
- **不注入完成通知**：`delivery: 'caller'` 让父会话只收到一份汇总报告，而不是每个子智能体一条消息。
- **精确释放**：每个被接纳的 activation 都恰好 `dispose()` 一次，失败和取消路径也不例外。

## 安全与权限

- 在 profile 中安装插件意味着**在进程内运行宿主代码**，不受工作区文件沙箱限制。启用前请审阅源码。
- 批处理子智能体继承调用者固定的委派权限范围，无法自行扩大，也无法获得新的审批；子智能体中需要审批的操作会被拒绝。
- 插件自身不额外增加网络、文件系统或进程访问能力。
- 任务提示词会作为子会话发送给所配置的模型提供商；不要把不应让提供商看到的密钥放进提示词。

## 兼容性

- 基于 DSH `0.2.1-rc.5` 的公开 `0.2.x` 插件接缝开发。调度器使用模拟的 `ctx.subagents` 做单元测试；正式依赖前，请先在真实部署中跑一批任务验证。
- 可选读取 `ctx.subagents.config.maxActiveSubagents`；该字段不存在时会自动降级，不影响运行。
- 工具 schema 使用 DSH 支持的 JSON Schema 子集（`type`、`properties`、`required`、`additionalProperties`、`items`、`enum`、`description`）。
- 运行时不 import 任何 peer 包；插件本身是单个 ESM 文件。

## 常见问题

| 现象 | 原因 / 处理 |
|---|---|
| 看不到 `subagent_batch` | 对应行被禁用、profile 未重载，或 `tools`/`subagents` 没有挂载。查看 Loader 日志并重启。 |
| `subagent provider "spawn" is not registered` | 挂载 `@deepseek-ai/dsh-subagent-spawn-in-process`，或把 `provider` 改成已注册的后端。 |
| `concurrency is user-controlled` | `allowModelConcurrency` 为 `false` 时模型传了并发参数。这是预期策略；需要时改为 `"lower"` 或 `true`。 |
| 重试后仍报 `ACTIVATION_LIMIT_REACHED` | 宿主接纳树被其他子智能体占满。降低 `concurrency` 或提高 `subagent.maxActiveSubagents`。 |
| `cannot delegate from depth ...` | 调用者已处于 `subagent.maxDepth`（默认 1）。让子智能体直接完成工作，或提高上限。 |
| 推荐值偏高 | 直接设置显式 `concurrency`。推荐只是起点，不代表模型 API 的速率限制。 |
| 受限沙箱中 `npm test` 报 `spawn EPERM` | Node 测试运行器需要派生子进程；改用 `npm run test:unit`，它在当前进程内执行测试文件。 |

## 限制

- 工具调用是**阻塞式**的：父智能体的这一轮会等到所有任务结束；子任务进度不会流式呈现，只返回最终报告。
- 一次调用就是一批；再次调用会开启新窗口，插件不会跨调用合并队列。
- 失败任务不会自动重试，由主智能体决定重跑还是继续追问子智能体。
- 子智能体最终答复按 `outputCharsPerTask` 裁剪；完整记录仍保留在子会话里。
- 子智能体运行在父进程内，这不是沙箱边界。
- 并发数在插件挂载时解析；修改配置或环境变量需要重载 profile。

## 开发

```sh
npm test          # node --test，自动发现 test/*.test.js
npm run test:unit # 在当前进程内执行测试文件（适合受限沙箱）
npm run recommend # 本机并发推荐
```

无需安装依赖：本包没有任何运行时依赖。

```
.
├── index.js                 # 插件 + 调度器 + 推荐算法（单文件）
├── bin/recommend.mjs        # 独立推荐 CLI
├── cordis.patch.yml         # 作为包安装时使用的 bundle patch
├── examples/cordis.patch.yml# 零安装挂载示例
├── test/                    # node:test 测试
├── README.md                # English
└── README.zh.md             # 简体中文
```

欢迎贡献。请保持零依赖，并为每个行为变更补充测试。

## 许可证

[MIT](LICENSE)
