import { EventEmitter } from 'events';
import {
  ComfyWsClient,
  uploadImageToComfy,
  queuePromptToComfy,
  downloadComfyFile,
  getComfyPromptHistory,
  interruptComfy
} from './client.js';
import { prepareWorkflowJson } from './workflow.js';

export class ComfyServerPool extends EventEmitter {
  constructor(options = {}) {
    super();
    this.servers = options.servers || [];
    this.recoveryTimeoutMs = options.recoveryTimeoutMs || 60000;
    this.telemetryIntervalMs = options.telemetryIntervalMs || 5000;

    this.activeClients = new Map(); // serverUrl -> ComfyWsClient
    this.serverStates = options.serverStates || new Map();  // serverUrl -> state object
    this.getTrackedPromptIds = options.getTrackedPromptIds || (() => new Set());
    
    this.telemetryInterval = null;
    this.isPolling = false;

    // Initialize state objects for all servers
    for (const url of this.servers) {
      this.getOrCreateServerState(url);
    }
  }

  // Overridable API methods
  prepareWorkflow(workflowTemplate, prompt, seed, inputImageName, negativePrompt) {
    return prepareWorkflowJson(workflowTemplate, prompt, seed, inputImageName, negativePrompt);
  }

  async uploadImage(serverUrl, fileBuffer, filename) {
    return uploadImageToComfy(serverUrl, fileBuffer, filename);
  }

  async queuePrompt(serverUrl, workflow, clientId) {
    return queuePromptToComfy(serverUrl, workflow, clientId);
  }

  async downloadFile(serverUrl, filename, subfolder, type, localDestPath) {
    return downloadComfyFile(serverUrl, filename, subfolder, type, localDestPath);
  }

  async getPromptHistory(serverUrl, promptId) {
    return getComfyPromptHistory(serverUrl, promptId);
  }

  async interrupt(serverUrl) {
    return interruptComfy(serverUrl);
  }

  getOrCreateServerState(serverUrl) {
    if (!this.serverStates.has(serverUrl)) {
      this.serverStates.set(serverUrl, {
        status: 'offline',
        activeJob: null,
        activePromise: null,
        disconnectTimer: null,
        cpuTemp: null,
        gpuTemp: null
      });
    }
    return this.serverStates.get(serverUrl);
  }

  syncServers(newServers) {
    this.servers = newServers || [];
    const configuredServers = new Set(this.servers);

    // Clean up unconfigured servers
    for (const [url, client] of this.activeClients.entries()) {
      if (!configuredServers.has(url)) {
        console.log(`[QueuePool] Disconnecting client for unconfigured server: ${url}`);
        try {
          client.disconnect();
        } catch (err) {
          console.error(`Error disconnecting client for ${url}:`, err);
        }
        this.activeClients.delete(url);
        
        const state = this.serverStates.get(url);
        if (state && state.disconnectTimer) {
          clearTimeout(state.disconnectTimer);
        }
        this.serverStates.delete(url);
      }
    }

    // Initialize configured servers
    for (const url of this.servers) {
      this.getOrCreateServerState(url);
      this.getClient(url);
    }
  }

  getClient(serverUrl) {
    if (this.activeClients.has(serverUrl)) {
      return this.activeClients.get(serverUrl);
    }

    const state = this.getOrCreateServerState(serverUrl);
    const clientId = `pool-client-${Math.random().toString(36).substring(2, 10)}`;
    const client = new ComfyWsClient(serverUrl, clientId);

    if (client.isConnected) {
      state.status = 'connected';
    }

    let isReconnection = false;

    client.on('connected', () => {
      console.log(`[QueuePool] WebSocket connected for ${serverUrl}`);
      state.status = 'connected';
      if (state.disconnectTimer) {
        clearTimeout(state.disconnectTimer);
        state.disconnectTimer = null;
      }
      this.sweepOrphanedPrompts(serverUrl);
      if (isReconnection) {
        this.verifyActiveJobState(serverUrl);
      }
      isReconnection = true;
      this.emit('serverConnected', serverUrl);
    });

    client.on('disconnected', () => {
      state.status = 'disconnected';
      this.emit('serverDisconnected', serverUrl);

      if (state.activeJob) {
        if (state.disconnectTimer) {
          clearTimeout(state.disconnectTimer);
        }
        state.disconnectTimer = setTimeout(() => {
          state.status = 'offline';
          state.disconnectTimer = null;
          if (state.activeJob && state.activePromise) {
            console.log(`[QueuePool] Reconnection timeout expired for ${serverUrl}. Failing active job.`);
            state.activePromise.onFailure(new Error('Connection to ComfyUI server lost'));
          }
        }, this.recoveryTimeoutMs);
      }
    });

    client.on('error', (err) => {
      this.emit('serverError', { serverUrl, error: err });
    });

    client.connect();
    this.activeClients.set(serverUrl, client);
    return client;
  }

  start() {
    if (this.isPolling) return;
    this.isPolling = true;

    const pollAll = async () => {
      if (!this.servers) return;

      await Promise.all(this.servers.map(url => this.pollServerTelemetry(url)));

      const healthList = this.servers.map(url => {
        const state = this.getOrCreateServerState(url);
        return {
          url,
          status: state.status,
          activeJob: state.activeJob ? (state.activeJob.nodeId || state.activeJob.rootId || state.activeJob.id) : null,
          cpuTemp: state.cpuTemp,
          gpuTemp: state.gpuTemp
        };
      });

      this.emit('telemetry', healthList);
    };

    pollAll();
    this.telemetryInterval = setInterval(pollAll, this.telemetryIntervalMs);
  }

  stop() {
    this.isPolling = false;
    if (this.telemetryInterval) {
      clearInterval(this.telemetryInterval);
      this.telemetryInterval = null;
    }
    for (const state of this.serverStates.values()) {
      if (state.disconnectTimer) {
        clearTimeout(state.disconnectTimer);
        state.disconnectTimer = null;
      }
      if (state.activePromise) {
        try {
          state.activePromise.reject(new Error('Queue reset'));
        } catch (e) {}
      }
    }
    this.serverStates.clear();
    for (const client of this.activeClients.values()) {
      try {
        client.disconnect();
      } catch (err) {
        console.error('Error disconnecting ComfyWsClient:', err);
      }
    }
    this.activeClients.clear();
  }

  async pollServerTelemetry(serverUrl) {
    const state = this.getOrCreateServerState(serverUrl);
    if (state.status !== 'connected') {
      state.cpuTemp = null;
      state.gpuTemp = null;
      return;
    }

    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 2000);
      const res = await fetch(`${serverUrl}/custom_comfy_monitoring/temp`, { signal: controller.signal });
      clearTimeout(timeoutId);
      if (res.ok) {
        const data = await res.json();
        state.cpuTemp = data.cpuTemp !== undefined ? data.cpuTemp : null;
        state.gpuTemp = data.gpuTemp !== undefined ? data.gpuTemp : null;
      } else {
        state.cpuTemp = null;
        state.gpuTemp = null;
      }
    } catch (err) {
      state.cpuTemp = null;
      state.gpuTemp = null;
    }
  }

  async sweepOrphanedPrompts(serverUrl) {
    try {
      const res = await fetch(`${serverUrl}/queue`);
      if (!res.ok) return;

      const q = await res.json();
      const running = q.queue_running || [];
      const pending = q.queue_pending || [];

      const comfyPromptIds = [];
      const runningPromptIds = new Set();

      for (const p of running) {
        let pid = Array.isArray(p) ? p[1] : (p?.prompt_id || p?.[0]);
        if (pid) {
          comfyPromptIds.push(pid);
          runningPromptIds.add(pid);
        }
      }

      for (const p of pending) {
        let pid = Array.isArray(p) ? p[1] : (p?.prompt_id || p?.[0]);
        if (pid) {
          comfyPromptIds.push(pid);
        }
      }

      const trackedPromptIds = new Set(this.getTrackedPromptIds());
      for (const state of this.serverStates.values()) {
        if (state.activeJob && state.activeJob.promptId) {
          trackedPromptIds.add(state.activeJob.promptId);
        }
      }

      const orphanedPromptIds = comfyPromptIds.filter(pid => !trackedPromptIds.has(pid));

      if (orphanedPromptIds.length > 0) {
        console.log(`[QueuePool] Found ${orphanedPromptIds.length} orphaned ComfyUI prompt(s) on ${serverUrl}. Sweeping...`);
        for (const promptId of orphanedPromptIds) {
          if (runningPromptIds.has(promptId)) {
            await this.interrupt(serverUrl);
          }
          try {
            await fetch(`${serverUrl}/queue`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ delete: [promptId] })
            });
          } catch (e) {}
        }
      }
    } catch (err) {}
  }

  async checkPromptStatus(comfyUrl, promptId) {
    try {
      const res = await fetch(`${comfyUrl}/queue`);
      if (res.ok) {
        const q = await res.json();
        const running = q.queue_running || [];
        const pending = q.queue_pending || [];
        const inQueue = running.some(p => p[0] === promptId || p.prompt_id === promptId || (Array.isArray(p) && p[1] === promptId)) ||
          pending.some(p => p[0] === promptId || p.prompt_id === promptId || (Array.isArray(p) && p[1] === promptId));
        if (inQueue) {
          return 'running';
        }
      }
    } catch (err) {}

    try {
      const res = await fetch(`${comfyUrl}/history/${promptId}`);
      if (res.ok) {
        const hist = await res.json();
        const promptHistory = hist[promptId];
        if (promptHistory) {
          if (promptHistory.status) {
            return promptHistory.status.status_str === 'success' ? 'completed' : 'failed';
          }
          return 'completed';
        } else if (hist && hist.outputs) {
          return 'completed';
        }
      }
    } catch (err) {}

    return 'lost';
  }

  async verifyActiveJobState(serverUrl) {
    const state = this.getOrCreateServerState(serverUrl);
    if (!state || !state.activeJob || !state.activeJob.promptId) return;

    const { promptId } = state.activeJob;
    console.log(`[QueuePool] Verifying active job state for promptId: ${promptId} on ${serverUrl}`);

    const status = await this.checkPromptStatus(serverUrl, promptId);
    console.log(`[QueuePool] Active job status on ComfyUI ${serverUrl}: ${status}`);

    if (state.activePromise) {
      if (status === 'completed') {
        state.activePromise.onSuccess(promptId);
      } else if (status === 'failed') {
        let errorMsg = 'ComfyUI job failed or was interrupted';
        try {
          const history = await this.getPromptHistory(serverUrl, promptId);
          if (history && history.status) {
            const s = history.status;
            if (s.status_str === 'error' && s.messages) {
              const errMessage = s.messages.find(m => m[0] === 'execution_error');
              if (errMessage && errMessage[1]) {
                const exception = errMessage[1];
                errorMsg = exception.exception_message ? `${exception.exception_type || 'Error'}: ${exception.exception_message}` : JSON.stringify(exception);
              }
            }
          }
        } catch (err) {}
        state.activePromise.onFailure(new Error(errorMsg));
      } else if (status === 'lost') {
        state.activePromise.onFailure(new Error('ComfyUI job lost on reconnect/crash'));
      }
    }
  }

  dispatch(serverUrl, job) {
    const state = this.getOrCreateServerState(serverUrl);
    const wsClient = this.getClient(serverUrl);

    if (state.activeJob && state.activeJob.id !== job.id) {
      return Promise.reject(new Error(`Server ${serverUrl} is already busy with another job.`));
    }

    state.activeJob = job;

    return new Promise(async (resolve, reject) => {
      let promptId = null;
      let videoOutputNodeId = null;
      let imageOutputNodeId = null;
      let promptOutputNodeId = null;

      const checkAborted = () => {
        if (!state.activeJob || state.activeJob.id !== job.id) {
          throw new Error('Job cancelled');
        }
      };

      const cleanup = () => {
        wsClient.off('progress', onProgress);
        wsClient.off('executing', onExecuting);
        wsClient.off('execution_error', onError);
        wsClient.off('execution_success', onSuccess);
        state.activeJob = null;
        state.activePromise = null;
      };

      const onProgress = (val, max, node, pid) => {
        if (pid !== promptId) return;
        const percent = Math.floor(35 + (val / max) * 45); // Scale between 35% and 80%
        this.emit('progress', { serverUrl, jobId: job.id, val, max, percent });
      };

      const onExecuting = (node, pid) => {
        if (pid !== promptId) return;
        this.emit('executing', { serverUrl, jobId: job.id, node });
      };

      const onError = (pid, exception) => {
        if (pid !== promptId) return;
        cleanup();
        let errMsg = '';
        if (exception && typeof exception === 'object') {
          if (exception.exception_message) {
            errMsg = `${exception.exception_type || 'Error'}: ${exception.exception_message}`;
            if (exception.node_id && exception.node_type) {
              errMsg += ` (at Node ${exception.node_id} [${exception.node_type}])`;
            }
          } else {
            errMsg = JSON.stringify(exception);
          }
        } else {
          errMsg = String(exception);
        }
        reject(new Error(`ComfyUI execution error: ${errMsg}`));
      };

      const onSuccess = async (pid) => {
        if (pid !== promptId) return;
        cleanup();
        try {
          const outputNodeId = job.jobType === 'image' ? imageOutputNodeId : videoOutputNodeId;
          this.emit('downloading', { serverUrl, jobId: job.id });

          const history = await this.getPromptHistory(serverUrl, promptId);
          if (!history || !history.outputs || !history.outputs[outputNodeId]) {
            throw new Error(`Could not find output node ${outputNodeId} in history`);
          }

          const outputNode = history.outputs[outputNodeId];
          const files = outputNode.gifs || outputNode.images || [];
          if (files.length === 0) {
            throw new Error('No files generated by output node');
          }

          const fileInfo = files[0];
          await this.downloadFile(
            serverUrl,
            fileInfo.filename,
            fileInfo.subfolder,
            fileInfo.type,
            job.outputDestPath
          );

          // Extract resolved wildcard prompt if promptOutputNodeId exists
          let resolvedPrompt = null;
          if (promptOutputNodeId && history.outputs[promptOutputNodeId]) {
            const promptNode = history.outputs[promptOutputNodeId];
            resolvedPrompt = promptNode.text || promptNode.string || null;
            if (Array.isArray(resolvedPrompt)) {
              resolvedPrompt = resolvedPrompt[0];
            }
          }

          resolve({
            serverUrl,
            promptId,
            history,
            resolvedPrompt
          });
        } catch (err) {
          reject(err);
        }
      };

      state.activePromise = {
        resolve,
        reject,
        onSuccess: (pid) => onSuccess(pid),
        onFailure: (err) => {
          cleanup();
          reject(err);
        },
        reject: (err) => {
          cleanup();
          reject(err);
        }
      };

      try {
        let localInputImageName = '';

        if (job.inputImage) {
          checkAborted();
          localInputImageName = await this.uploadImage(
            serverUrl,
            job.inputImage.buffer,
            job.inputImage.filename
          );
        }

        checkAborted();
        let workflow;
        ({
          workflow,
          videoOutputNodeId,
          imageOutputNodeId,
          promptOutputNodeId
        } = this.prepareWorkflow(job.workflowTemplate, job.prompt, job.seed, localInputImageName, job.negativePrompt));

        checkAborted();
        promptId = await this.queuePrompt(serverUrl, workflow, wsClient.clientId);
        job.promptId = promptId;
        this.emit('queued', { serverUrl, jobId: job.id, promptId });

        // Register temporary WS listeners
        wsClient.on('progress', onProgress);
        wsClient.on('executing', onExecuting);
        wsClient.on('execution_error', onError);
        wsClient.on('execution_success', onSuccess);

      } catch (err) {
        cleanup();
        reject(err);
      }
    });
  }

  async cancel(serverUrl, jobId) {
    const state = this.getOrCreateServerState(serverUrl);
    const job = state.activeJob;
    if (job && job.id === jobId) {
      if (state.activePromise) {
        state.activePromise.reject(new Error('Job cancelled'));
      }
      try {
        await this.interrupt(serverUrl);
      } catch (err) {
        console.error(`Failed to interrupt ComfyUI execution on ${serverUrl}:`, err.message);
      }
      return true;
    }
    return false;
  }
}
