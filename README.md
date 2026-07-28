# comfyui-orchestrator

> **The ultimate ComfyUI API client, Node.js SDK, and multi-GPU server pool orchestrator for Stable Diffusion & AI video generation pipelines.**

`comfyui-orchestrator` is a lightweight, framework-agnostic Node.js library designed for scalable ComfyUI workflow automation, multi-server load balancing, and real-time WebSocket execution tracking.

Whether you are building an AI video generator, an automated image synthesis pipeline, or a multi-GPU cloud cluster for ComfyUI workflows, `comfyui-orchestrator` provides high-level pool management, automatic server failover, prompt queuing, input image uploads, and output file downloads with zero external friction.

---

## Key Features & Keywords

- 🏊 **ComfyUI Server Pool & Load Balancer**: High-level multi-server queue manager for distributed AI generation.
  - Multi-GPU server availability tracking & job dispatch locking.
  - Real-time ComfyUI telemetry monitoring (`cpuTemp`, `gpuTemp`).
  - Automatic reconnection backoff & crash resilience (Scenarios A/B/C/D).
  - Predicate-based active job cancellation (`pool.interruptJobs()`).
  - Automatic orphan prompt sweeping to clean up stale ComfyUI queues.
- ⚡ **ComfyUI WebSocket Client SDK**: Event-driven `ComfyWsClient` for tracking prompt progress.
  - Granular WebSocket event emission: `connected`, `disconnected`, `progress`, `execution_start`, `executing`, `executed`, `execution_success`, `execution_error`.
  - Auto-reconnect with error log suppression for offline ComfyUI instances.
- 🎨 **ComfyUI Workflow Automation & Prompt Injector**:
  - Pure JSON workflow cloning (zero mutation).
  - Dynamic node targeting using standard title markers (`APP_PROMPT`, `APP_SEED`, `APP_INPUT_IMAGE`, `APP_NEGATIVE_PROMPT`, `APP_OUTPUT_VIDEO`, `APP_OUTPUT_IMAGE`, `APP_PROMPT_OUTPUT`).
- 🌐 **ComfyUI REST API Helpers**:
  - Direct helper functions for `/prompt`, `/history`, `/upload/image`, `/view`, and `/interrupt`.

---

## Keywords / Use Cases

`ComfyUI API Client` • `ComfyUI Node.js Library` • `Multi-GPU ComfyUI Load Balancer` • `Stable Diffusion Workflow Orchestrator` • `AI Video Generation Queue` • `ComfyUI WebSocket Monitor` • `ComfyUI Automation SDK` • `Flux & AnimateDiff Pipeline Manager`

---

## Installation

```bash
npm install comfyui-orchestrator
```

*Or reference locally as a workspace package:*
```json
"dependencies": {
  "comfyui-orchestrator": "file:../comfyui_orchestrator"
}
```

---

## API & Usage Examples

### 1. Multi-Server Pool Management (`ComfyServerPool`)

Manage multiple ComfyUI GPU servers with automatic failover, progress events, and telemetry monitoring:

```js
import { ComfyServerPool } from 'comfyui-orchestrator';

// Initialize pool with configured ComfyUI endpoints
const pool = new ComfyServerPool({
  servers: ['http://gpu1:8188', 'http://gpu2:8188'],
  recoveryTimeoutMs: 60000,
  telemetryIntervalMs: 5000,
  getTrackedPromptIds: () => new Set(['prompt-id-1', 'prompt-id-2'])
});

// Telemetry monitoring (CPU/GPU temperature metrics)
pool.on('telemetry', (healthList) => {
  console.log('Server Health Metrics:', healthList);
  // Example payload item:
  // { url: 'http://gpu1:8188', status: 'connected', activeJob: 'job-101', cpuTemp: 45, gpuTemp: 68 }
});

// Track sampling step progress across all ComfyUI GPU workers
pool.on('progress', ({ serverUrl, jobId, val, max, percent }) => {
  console.log(`[${serverUrl}][${jobId}] Sampling step: ${val}/${max} (${percent}%)`);
});

pool.on('executing', ({ serverUrl, jobId, node }) => {
  console.log(`[${serverUrl}][${jobId}] Executing Node: ${node}`);
});

// Start background connection monitoring and telemetry polling
pool.start();

// Dispatch AI generation job to an available server
const serverUrl = 'http://gpu1:8188';

if (pool.isServerAvailable(serverUrl)) {
  try {
    const result = await pool.dispatch(serverUrl, {
      id: 'job-101',
      jobType: 'video', // 'video' or 'image'
      prompt: 'A cinematic wide-angle shot of a cybernetic tiger in a neon city at night',
      seed: 987654321,
      negativePrompt: 'blurry, low quality, distorted',
      workflowTemplate: rawWorkflowJson,
      inputImage: {
        buffer: imageBuffer,
        filename: 'init_frame.png'
      },
      outputDestPath: './outputs/job_101.mp4'
    });

    console.log('Generation Completed!');
    console.log('Prompt ID:', result.promptId);
    console.log('Resolved Wildcard Prompt:', result.resolvedPrompt);
  } catch (err) {
    console.error('Job Dispatch Error:', err.message);
  }
}

// Cancel or interrupt active jobs by workspace or custom condition
await pool.interruptJobs(job => job.workspaceId === 'ws_123');

// Clean up all client sockets and background timers when tearing down
pool.stop();
```

---

### 2. Low-Level ComfyUI WebSocket Client (`ComfyWsClient`)

Directly subscribe to ComfyUI execution events via WebSocket:

```js
import { ComfyWsClient } from 'comfyui-orchestrator';

const client = new ComfyWsClient('http://localhost:8188', 'client-session-123');

client.on('connected', () => console.log('WebSocket connection established'));
client.on('disconnected', () => console.log('WebSocket disconnected'));
client.on('progress', (val, max, node, promptId) => {
  console.log(`[Prompt ${promptId}] Sampling step ${val}/${max} on Node ${node}`);
});
client.on('execution_success', (promptId) => {
  console.log(`Execution succeeded for prompt: ${promptId}`);
});
client.on('execution_error', (promptId, exception) => {
  console.error(`Execution error for prompt ${promptId}:`, exception);
});

// Connect to ComfyUI WebSocket endpoint
client.connect();

// Disconnect when finished
// client.disconnect();
```

---

### 3. Workflow JSON Preparation (`prepareWorkflowJson`)

Inject parameters into ComfyUI workflow JSON files automatically using standard title markers (`_meta.title`):

| Node Title Marker (`_meta.title`) | Target Field | Purpose |
|---|---|---|
| `APP_PROMPT` | `inputs.text` / `inputs.value` | Positive prompt text injection |
| `APP_SEED` | `inputs.seed` / `inputs.noise_seed` / `inputs.value` | Seed number injection |
| `APP_INPUT_IMAGE` | `inputs.image` | Starting image filename injection |
| `APP_NEGATIVE_PROMPT` | `inputs.text` / `inputs.value` | Negative prompt suffix appending |
| `APP_OUTPUT_VIDEO` | Output node | Video file destination node |
| `APP_OUTPUT_IMAGE` | Output node | Image file destination node |
| `APP_PROMPT_OUTPUT` | Output node | Extracted wildcard prompt node |

```js
import { prepareWorkflowJson } from 'comfyui-orchestrator';

const {
  workflow,
  foundInputImage,
  foundPrompt,
  foundSeed,
  videoOutputNodeId,
  imageOutputNodeId,
  promptOutputNodeId
} = prepareWorkflowJson(
  templateWorkflowJson,
  'A futuristic cyberpunk skyscraper under heavy rain', // Prompt
  424242,                                              // Seed
  'uploaded_input_frame.png',                         // Input Image Filename
  'ugly, distorted, artifacting'                       // Negative Prompt Suffix
);

console.log('Prepared Workflow:', workflow);
```

---

### 4. Low-Level REST API Helpers

```js
import {
  uploadImageToComfy,
  queuePromptToComfy,
  getComfyPromptHistory,
  downloadComfyFile,
  interruptComfy
} from 'comfyui-orchestrator';

const serverUrl = 'http://localhost:8188';

// 1. Upload input image buffer to ComfyUI /upload/image
const savedFilename = await uploadImageToComfy(serverUrl, imageBuffer, 'input.png');

// 2. Queue prompt workflow to ComfyUI /prompt
const promptId = await queuePromptToComfy(serverUrl, workflowJson, 'client-id-123');

// 3. Fetch prompt execution history from /history/{promptId}
const history = await getComfyPromptHistory(serverUrl, promptId);

// 4. Download output file from /view directly to disk
await downloadComfyFile(serverUrl, 'generated_00001.mp4', '', 'output', './local_dest.mp4');

// 5. Interrupt running execution via /interrupt
const isInterrupted = await interruptComfy(serverUrl);
```

---

## Testing

Run unit tests with Vitest:

```bash
npm test
```

---

## License

MIT
