# comfyui-orchestrator

> **A lightweight, robust Node.js SDK and multi-server pool orchestrator for ComfyUI, Stable Diffusion, and AI video/image generation pipelines.**

`comfyui-orchestrator` is a production-ready Node.js library for distributed ComfyUI workflow automation, multi-GPU load balancing, real-time WebSocket execution tracking, and crash-resilient prompt dispatch.

---

## Key Capabilities

- 🏊 **Multi-Server GPU Pool & Load Balancer (`ComfyServerPool`)**:
  - Distribute jobs across multiple ComfyUI GPU worker instances.
  - Per-server availability tracking, concurrency locking, and health monitoring.
  - Background telemetry polling (`cpuTemp`, `gpuTemp` from `/custom_comfy_monitoring/temp`).
  - Dynamic cluster reconfiguration on the fly via `pool.syncServers()`.
  - Predicate-based job interruption via `pool.interruptJobs(predicate)`.
- ⚡ **Real-Time WebSocket Client (`ComfyWsClient`)**:
  - Live execution tracking with granular events (`progress`, `executing`, `executed`, `execution_success`, `execution_error`).
  - Automatic reconnection handling with intelligent error log suppression for offline instances.
- 🛡️ **Crash & Reconnection Recovery**:
  - Handles network interruptions and server restarts across 4 distinct lifecycle scenarios (Prompt Lost, Prompt Still Running, Prompt Completed While Disconnected, Prompt Failed on Server).
  - Progressive backoff retry for `/history/{promptId}` (up to 30s) to eliminate disk-flush race conditions between execution success and history availability.
- 🧹 **Automated Orphan Prompt Sweeper**:
  - Detects unmanaged or stale jobs in ComfyUI queues upon connection, interrupts running orphans, and sweeps them from the queue.
- 🎨 **Workflow Automation & Parameter Injection (`prepareWorkflowJson`)**:
  - Deep-clone JSON workflow mutation without modifying source template objects.
  - Standardized `_meta.title` node marker convention for prompts, seeds, input images, negative prompts, output nodes, and extracted wildcard outputs (`APP_PROMPT_OUTPUT`).
- 🌐 **Zero-Dependency REST API Helpers**:
  - Standalone helper functions for `/upload/image`, `/prompt`, `/history`, `/view`, and `/interrupt`.

---

## Installation

```bash
npm install comfyui-orchestrator
```

*Native ES Module (Node.js 18+ required).*

---

## Quick Start

```js
import { ComfyServerPool } from 'comfyui-orchestrator';
import fs from 'fs';

// 1. Initialize server pool
const pool = new ComfyServerPool({
  servers: ['http://gpu1:8188', 'http://gpu2:8188'],
  recoveryTimeoutMs: 60000,
  telemetryIntervalMs: 5000,
  historyRetryMaxTimeMs: 30000
});

// 2. Listen to execution progress and telemetry
pool.on('progress', ({ serverUrl, jobId, val, max, percent }) => {
  console.log(`[${serverUrl}][${jobId}] Step ${val}/${max} (${percent}%)`);
});

pool.on('executing', ({ serverUrl, jobId, node }) => {
  console.log(`[${serverUrl}][${jobId}] Executing node: ${node}`);
});

pool.on('telemetry', (healthList) => {
  console.log('Cluster Health:', healthList);
});

// Start background telemetry polling & connection management
pool.start();

// 3. Dispatch a generation job to an available GPU server
const targetServer = 'http://gpu1:8188';

if (pool.isServerAvailable(targetServer)) {
  const workflowTemplate = JSON.parse(fs.readFileSync('./workflow.json', 'utf-8'));

  const result = await pool.dispatch(targetServer, {
    id: 'job-001',
    jobType: 'image', // 'image' or 'video'
    prompt: 'masterpiece portrait of a futuristic cyberpunk traveler, 8k',
    seed: 424242,
    negativePrompt: 'blurry, deformed, low quality',
    workflowTemplate,
    inputImage: {
      buffer: fs.readFileSync('./input_face.png'),
      filename: 'input_face.png'
    },
    outputDestPath: './outputs/job_001.png'
  });

  console.log('Completed prompt ID:', result.promptId);
  console.log('Saved to outputDestPath:', './outputs/job_001.png');
  if (result.resolvedPrompt) {
    console.log('Resolved Wildcard Prompt:', result.resolvedPrompt);
  }
}
```

---

## API Reference

### 1. `ComfyServerPool`

High-level multi-server manager with queue locking, failover, telemetry, and automated dispatch lifecycle.

#### Constructor Options

```js
const pool = new ComfyServerPool(options);
```

| Option | Type | Default | Description |
|---|---|---|---|
| `servers` | `string[]` | `[]` | List of ComfyUI base HTTP URLs (e.g. `['http://127.0.0.1:8188']`). |
| `recoveryTimeoutMs` | `number` | `60000` | Max duration (ms) to wait for disconnected server reconnection before failing active jobs. |
| `telemetryIntervalMs` | `number` | `5000` | Interval (ms) for polling temperature telemetry from `/custom_comfy_monitoring/temp`. |
| `historyRetryMaxTimeMs` | `number` | `30000` | Max time (ms) for progressive backoff polling of `/history/{promptId}` outputs after execution. |
| `getTrackedPromptIds` | `() => Set<string>` | `() => new Set()` | Optional callback returning prompt IDs tracked by external app to protect them from orphan sweeping. |
| `serverStates` | `Map` | `new Map()` | Optional pre-existing server states map. |

#### Methods

- **`pool.start()`**: Starts background telemetry polling and establishes active WebSocket connections to configured servers.
- **`pool.stop()`**: Stops background polling, clears reconnect timers, rejects pending dispatch promises, and terminates all active WebSocket clients.
- **`pool.isServerAvailable(serverUrl)`**: Returns `true` if the server is connected and has no active job.
- **`pool.getServerState(serverUrl)`**: Returns a snapshot `{ status, activeJob, cpuTemp, gpuTemp }` or `null`.
- **`pool.getHealthList()`**: Returns an array of `{ url, status, activeJob, cpuTemp, gpuTemp }` for all configured servers.
- **`pool.syncServers(newServers)`**: Dynamically updates the server list, connects to new servers, and disconnects removed servers.
- **`pool.dispatch(serverUrl, job)`**: Dispatches a generation job. Returns a `Promise<{ serverUrl, promptId, history, resolvedPrompt }>`.
- **`pool.cancel(serverUrl, jobId)`**: Cancels an active job on a specific server, interrupts execution on ComfyUI, and rejects the dispatch promise.
- **`pool.interruptJobs(predicateFn)`**: Cancels and interrupts all active jobs where `predicateFn(activeJob)` evaluates to `true`.

#### Job Options (`pool.dispatch(serverUrl, job)`)

| Parameter | Type | Required | Description |
|---|---|---|---|
| `id` | `string` | Yes | Unique identifier for the job. |
| `jobType` | `'image' \| 'video'` | Yes | Determines whether output is extracted from `APP_OUTPUT_IMAGE` or `APP_OUTPUT_VIDEO`. |
| `prompt` | `string` | Yes | Positive prompt injected into `APP_PROMPT`. |
| `seed` | `number` | Yes | Seed injected into `APP_SEED`. |
| `workflowTemplate` | `object` | Yes | ComfyUI API workflow JSON object. |
| `negativePrompt` | `string` | No | Suffix appended to `APP_NEGATIVE_PROMPT`. |
| `inputImage` | `{ buffer: Buffer, filename: string }` | No | Uploaded to ComfyUI `/upload/image` and filename injected into `APP_INPUT_IMAGE`. |
| `outputDestPath` | `string` | Yes | Local destination file path where generated image/video will be downloaded. |

#### Events Emitted by `ComfyServerPool`

| Event | Arguments | Description |
|---|---|---|
| `serverConnected` | `serverUrl` | Emitted when a server's WebSocket connects. |
| `serverDisconnected` | `serverUrl` | Emitted when a server's WebSocket disconnects. |
| `serverError` | `{ serverUrl, error }` | Emitted on WebSocket communication errors. |
| `queued` | `{ serverUrl, jobId, promptId }` | Emitted when prompt is accepted into ComfyUI queue. |
| `executing` | `{ serverUrl, jobId, node }` | Emitted when ComfyUI begins processing a workflow node. |
| `progress` | `{ serverUrl, jobId, val, max, percent }` | Emitted during KSampler sampling step progress (percent scaled 35%–80%). |
| `downloading` | `{ serverUrl, jobId }` | Emitted after execution succeeds when downloading output file. |
| `telemetry` | `healthList` | Emitted after each telemetry polling cycle. |

---

### 2. `ComfyWsClient`

Low-level, event-driven WebSocket client wrapper for ComfyUI.

```js
import { ComfyWsClient } from 'comfyui-orchestrator';

const client = new ComfyWsClient('http://127.0.0.1:8188', 'my-client-id');

client.on('connected', () => console.log('Connected to ComfyUI WS'));
client.on('disconnected', () => console.log('Disconnected from ComfyUI WS'));
client.on('progress', (val, max, node, promptId) => {
  console.log(`[${promptId}] Progress: ${val}/${max} on Node ${node}`);
});
client.on('executing', (node, promptId) => {
  console.log(`[${promptId}] Executing Node: ${node}`);
});
client.on('executed', (promptId, node, output) => {
  console.log(`[${promptId}] Node ${node} executed with output:`, output);
});
client.on('execution_success', (promptId) => {
  console.log(`[${promptId}] Execution complete!`);
});
client.on('execution_error', (promptId, exception) => {
  console.error(`[${promptId}] Execution error:`, exception);
});

client.connect();

// When done:
// client.disconnect();
```

---

### 3. Workflow JSON Injection (`prepareWorkflowJson`)

Pure, non-mutating workflow JSON preparation function using node title conventions (`_meta.title`).

```js
import { prepareWorkflowJson } from 'comfyui-orchestrator';

const {
  workflow,
  foundInputImage,
  foundPrompt,
  foundSeed,
  foundNegativePrompt,
  videoOutputNodeId,
  imageOutputNodeId,
  promptOutputNodeId
} = prepareWorkflowJson(
  rawWorkflowJson,
  'cinematic portrait of an astronaut on Mars', // Positive prompt
  123456789,                                   // Seed
  'uploaded_source.png',                       // Input image name
  'bad quality, lowres, watermark'             // Negative prompt suffix
);
```

#### Supported Node Title Markers (`_meta.title`)

| Title Marker | Target Inputs | Description |
|---|---|---|
| `APP_PROMPT` | `inputs.text` or `inputs.value` | Injects positive prompt string. |
| `APP_SEED` | `inputs.seed`, `inputs.noise_seed`, or `inputs.value` | Injects seed integer. |
| `APP_INPUT_IMAGE` | `inputs.image` or `inputs.value` | Injects uploaded input image filename. |
| `APP_NEGATIVE_PROMPT` | `inputs.text` or `inputs.value` | Appends negative prompt suffix (with automatic comma separation). |
| `APP_OUTPUT_VIDEO` | Output node | Identifies video output node (for `gifs`/`videos`). |
| `APP_OUTPUT_IMAGE` | Output node | Identifies image output node (for `images`). |
| `APP_PROMPT_OUTPUT` | Text output node | Extracts resolved prompt text from history (e.g. wildcards). |

---

### 4. REST API Helpers

Zero-dependency HTTP helper functions for direct ComfyUI API interactions:

```js
import {
  uploadImageToComfy,
  queuePromptToComfy,
  getComfyPromptHistory,
  downloadComfyFile,
  interruptComfy
} from 'comfyui-orchestrator';

const serverUrl = 'http://127.0.0.1:8188';

// 1. Upload an image buffer via multipart/form-data
const uploadedFilename = await uploadImageToComfy(serverUrl, imageBuffer, 'input.png');

// 2. Queue prompt workflow
const promptId = await queuePromptToComfy(serverUrl, workflowJson, 'client-id-123');

// 3. Fetch prompt execution history
const history = await getComfyPromptHistory(serverUrl, promptId);

// 4. Download output file from /view endpoint directly to disk
await downloadComfyFile(serverUrl, 'ComfyUI_00001_.png', '', 'output', './downloaded.png');

// 5. Interrupt active generation
const ok = await interruptComfy(serverUrl);
```

---

## Architecture & Reliability Features

### Failover & Reconnect Recovery (Scenarios A–D)
When a GPU server temporarily disconnects during an active job:
1. **Scenario A (Lost)**: If the prompt is no longer in ComfyUI queue or history upon reconnection, the active job promise is rejected.
2. **Scenario B (Running)**: If ComfyUI is still executing the prompt upon reconnection, execution tracking resumes seamlessly without interrupting the worker.
3. **Scenario C (Completed)**: If the job completed while disconnected, the output file is automatically downloaded and the job promise resolves successfully.
4. **Scenario D (Failed)**: If ComfyUI suffered an execution error while disconnected, the error details and node exception are retrieved from history and the job promise is rejected.

### Progressive History Backoff
On fast nodes or network latency, ComfyUI WebSocket may emit `execution_success` milliseconds before file writes are committed to `/history`. `ComfyServerPool` automatically retries fetching history with progressive exponential backoff (up to `historyRetryMaxTimeMs`, default 30s) to guarantee outputs are ready before downloading.

### Automated Orphan Sweeper
On connection establishment, `ComfyServerPool` queries `/queue` to discover any stale jobs left behind by previous crashes. Any prompt ID not actively managed by the pool or tracked by `getTrackedPromptIds()` is immediately interrupted and deleted from the queue.

---

## Testing

Run the full test suite (65 tests across pool, client, and workflow modules):

```bash
npm test
```

---

## License

[MIT](LICENSE)
