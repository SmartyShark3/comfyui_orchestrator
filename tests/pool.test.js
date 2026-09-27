import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ComfyServerPool } from '../pool.js';
import { createTestPool, MockWebSocket } from './test_helper.js';

// Mock the 'ws' module using the MockWebSocket class
vi.mock('ws', () => {
  const EventEmitter = require('events');
  class MockWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0; // CONNECTING
      MockWebSocket.instances.push(this);
      
      setTimeout(() => {
        this.readyState = 1; // OPEN
        this.emit('open');
      }, 0);
    }

    terminate() {
      this.readyState = 3; // CLOSED
      this.emit('close');
    }
  }
  MockWebSocket.instances = [];
  return {
    default: MockWebSocket
  };
});

describe('ComfyServerPool', () => {
  let tempDir;

  beforeEach(() => {
    WebSocket.instances = [];
    vi.useFakeTimers();
    tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-pool-tests-'));
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    try {
      fs.rmSync(tempDir, { recursive: true, force: true });
    } catch (e) {}
  });

  describe('Initialization & Configuration', () => {
    it('should initialize and register server state maps', () => {
      const pool = new ComfyServerPool({
        servers: ['http://gpu1:8188', 'http://gpu2:8188']
      });

      expect(pool.servers).toEqual(['http://gpu1:8188', 'http://gpu2:8188']);
      expect(pool.serverStates.has('http://gpu1:8188')).toBe(true);
      expect(pool.serverStates.get('http://gpu1:8188').status).toBe('offline');
      pool.stop();
    });

    it('should correctly report isServerAvailable', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      expect(pool.isServerAvailable('http://gpu1:8188')).toBe(false); // offline

      pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1); // connected

      expect(pool.isServerAvailable('http://gpu1:8188')).toBe(true);

      pool.getOrCreateServerState('http://gpu1:8188').activeJob = { id: 'busy-job' };
      expect(pool.isServerAvailable('http://gpu1:8188')).toBe(false);

      pool.stop();
    });

    it('should return server state snapshot via getServerState', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      expect(pool.getServerState('http://unknown:8188')).toBeNull();

      pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const state = pool.getServerState('http://gpu1:8188');
      expect(state).toEqual({
        status: 'connected',
        activeJob: null,
        cpuTemp: null,
        gpuTemp: null,
        supportedWorkflows: []
      });

      pool.stop();
    });

    it('should return health list for all configured servers via getHealthList', async () => {
      const { pool } = createTestPool({
        servers: [
          'http://gpu1:8188',
          { url: 'http://gpu2:8188', supportedWorkflows: ['image_workflow.json', 'Z-Image-Turbo'] }
        ]
      });
      pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const healthList = pool.getHealthList();
      expect(healthList).toEqual([
        { url: 'http://gpu1:8188', status: 'connected', activeJob: null, cpuTemp: null, gpuTemp: null, supportedWorkflows: [] },
        { url: 'http://gpu2:8188', status: 'offline', activeJob: null, cpuTemp: null, gpuTemp: null, supportedWorkflows: ['image_workflow.json', 'Z-Image-Turbo'] }
      ]);

      pool.stop();
    });

    it('should correctly check supportedWorkflows with isWorkflowSupported', () => {
      const pool = new ComfyServerPool({
        servers: [
          'http://gpu1:8188',
          { url: 'http://gpu2:8188', supportedWorkflows: ['Z-Image-Turbo', 'video_workflow.json'] },
          { url: 'http://gpu3:8188', supportedWorkflows: ['pony_t2i_app.json'] }
        ]
      });

      const imageWorkflows = [
        { name: 'Z-Image-Turbo', file: 'image_workflow.json' },
        { name: 'Pony SDXL', file: 'pony_t2i_app.json' }
      ];

      // gpu1 supports all workflows (empty supportedWorkflows)
      expect(pool.isWorkflowSupported('http://gpu1:8188', 'image_workflow.json', imageWorkflows)).toBe(true);
      expect(pool.isWorkflowSupported('http://gpu1:8188', 'pony_t2i_app.json', imageWorkflows)).toBe(true);
      expect(pool.isWorkflowSupported('http://gpu1:8188', 'video_workflow.json', imageWorkflows)).toBe(true);

      // gpu2 supports Z-Image-Turbo (matches both by name and file) and video_workflow.json
      expect(pool.isWorkflowSupported('http://gpu2:8188', 'image_workflow.json', imageWorkflows)).toBe(true);
      expect(pool.isWorkflowSupported('http://gpu2:8188', 'Z-Image-Turbo', imageWorkflows)).toBe(true);
      expect(pool.isWorkflowSupported('http://gpu2:8188', 'video_workflow.json', imageWorkflows)).toBe(true);
      expect(pool.isWorkflowSupported('http://gpu2:8188', 'pony_t2i_app.json', imageWorkflows)).toBe(false);
      expect(pool.isWorkflowSupported('http://gpu2:8188', 'Pony SDXL', imageWorkflows)).toBe(false);

      // gpu3 supports Pony SDXL by filename and display name cross-reference
      expect(pool.isWorkflowSupported('http://gpu3:8188', 'pony_t2i_app.json', imageWorkflows)).toBe(true);
      expect(pool.isWorkflowSupported('http://gpu3:8188', 'Pony SDXL', imageWorkflows)).toBe(true);
      expect(pool.isWorkflowSupported('http://gpu3:8188', 'image_workflow.json', imageWorkflows)).toBe(false);
      expect(pool.isWorkflowSupported('http://gpu3:8188', 'video_workflow.json', imageWorkflows)).toBe(false);

      pool.stop();
    });

    it('should interrupt active jobs matching predicate via interruptJobs', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188', 'http://gpu2:8188'] });
      pool.getClient('http://gpu1:8188');
      pool.getClient('http://gpu2:8188');
      await vi.advanceTimersByTimeAsync(1);

      pool.getOrCreateServerState('http://gpu1:8188').activeJob = { id: 'job-ws1-n1', workspaceId: 'ws1', nodeId: 'n1' };
      pool.getOrCreateServerState('http://gpu2:8188').activeJob = { id: 'job-ws2-n2', workspaceId: 'ws2', nodeId: 'n2' };

      const interrupted = await pool.interruptJobs(j => j.workspaceId === 'ws1');
      expect(interrupted).toBe(true);
      expect(mocks.interrupt).toHaveBeenCalledWith('http://gpu1:8188');

      pool.stop();
    });
  });

  describe('Dispatch Lifecycle', () => {
    it('should complete video job dispatch successfully via WS execution_success', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1); // open socket

      const outPath = path.join(tempDir, 'out.mp4');
      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-video-1',
        jobType: 'video',
        prompt: 'a running dog',
        seed: 1234,
        workflowTemplate: {},
        outputDestPath: outPath
      });

      await vi.advanceTimersByTimeAsync(1); // queue prompt

      expect(mocks.prepareWorkflow).toHaveBeenCalled();
      expect(mocks.queuePrompt).toHaveBeenCalled();

      // Emit execution_success from WebSocket client
      client.emit('execution_success', 'prompt-test-123');
      await vi.advanceTimersByTimeAsync(1);

      const result = await dispatchPromise;
      expect(result.promptId).toBe('prompt-test-123');
      expect(result.resolvedPrompt).toBe('Resolved prompt text');
      expect(mocks.downloadFile).toHaveBeenCalledWith('http://gpu1:8188', 'output.mp4', '', 'output', outPath);

      pool.stop();
    });

    it('should complete image job dispatch successfully', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const outPath = path.join(tempDir, 'out.png');
      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-image-1',
        jobType: 'image',
        prompt: 'a cute cat',
        seed: 5678,
        workflowTemplate: {},
        outputDestPath: outPath
      });

      await vi.advanceTimersByTimeAsync(1);
      client.emit('execution_success', 'prompt-test-123');
      await vi.advanceTimersByTimeAsync(1);

      const result = await dispatchPromise;
      expect(result.promptId).toBe('prompt-test-123');
      expect(mocks.downloadFile).toHaveBeenCalledWith('http://gpu1:8188', 'output.png', '', 'output', outPath);

      pool.stop();
    });

    it('should upload input image when job.inputImage is provided', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const imgBuffer = Buffer.from('fake-image');
      const outPath = path.join(tempDir, 'out.mp4');

      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-img-1',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        inputImage: { buffer: imgBuffer, filename: 'input.png' },
        outputDestPath: outPath
      });

      await vi.advanceTimersByTimeAsync(1);
      client.emit('execution_success', 'prompt-test-123');
      await vi.advanceTimersByTimeAsync(1);

      await dispatchPromise;
      expect(mocks.uploadImage).toHaveBeenCalledWith('http://gpu1:8188', imgBuffer, 'input.png');

      pool.stop();
    });

    it('should not upload input image when job.inputImage is absent', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const outPath = path.join(tempDir, 'out.mp4');
      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-noimg-1',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        outputDestPath: outPath
      });

      await vi.advanceTimersByTimeAsync(1);
      client.emit('execution_success', 'prompt-test-123');
      await vi.advanceTimersByTimeAsync(1);

      await dispatchPromise;
      expect(mocks.uploadImage).not.toHaveBeenCalled();

      pool.stop();
    });

    it('should reject dispatch when execution_error string event is received', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const outPath = path.join(tempDir, 'out.mp4');
      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-err-1',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        outputDestPath: outPath
      });
      dispatchPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1);
      client.emit('execution_error', 'prompt-test-123', 'Out of Memory');
      await vi.advanceTimersByTimeAsync(1);

      await expect(dispatchPromise).rejects.toThrow('ComfyUI execution error: Out of Memory');

      pool.stop();
    });

    it('should format execution_error details when exception object is emitted', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const outPath = path.join(tempDir, 'out.mp4');
      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-err-2',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        outputDestPath: outPath
      });
      dispatchPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1);
      client.emit('execution_error', 'prompt-test-123', {
        exception_type: 'RuntimeError',
        exception_message: 'NVRTC error',
        node_id: '15',
        node_type: 'KSampler'
      });
      await vi.advanceTimersByTimeAsync(1);

      await expect(dispatchPromise).rejects.toThrow(
        'ComfyUI execution error: RuntimeError: NVRTC error (at Node 15 [KSampler])'
      );

      pool.stop();
    });

    it('should reject dispatch when uploadImage fails', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      mocks.uploadImage.mockRejectedValueOnce(new Error('Upload failed'));
      pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-up-err',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        inputImage: { buffer: Buffer.from('a'), filename: 'a.png' },
        outputDestPath: '/tmp/out.mp4'
      });
      dispatchPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1);
      await expect(dispatchPromise).rejects.toThrow('Upload failed');

      pool.stop();
    });

    it('should reject dispatch when queuePrompt fails', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      mocks.queuePrompt.mockRejectedValueOnce(new Error('Queue full'));
      pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-q-err',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        outputDestPath: '/tmp/out.mp4'
      });
      dispatchPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1);
      await expect(dispatchPromise).rejects.toThrow('Queue full');

      pool.stop();
    });

    it('should reject dispatch when downloadFile fails after success event', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      mocks.downloadFile.mockRejectedValueOnce(new Error('Disk full'));
      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-dl-err',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        outputDestPath: '/tmp/out.mp4'
      });
      dispatchPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1);
      client.emit('execution_success', 'prompt-test-123');
      await vi.advanceTimersByTimeAsync(1);

      await expect(dispatchPromise).rejects.toThrow('Disk full');

      pool.stop();
    });

    it('should reject dispatch when history outputs do not contain the expected output node', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      mocks.getPromptHistory.mockResolvedValue({ outputs: {} });
      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-hist-err',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        outputDestPath: '/tmp/out.mp4'
      });
      dispatchPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1);
      client.emit('execution_success', 'prompt-test-123');
      await vi.advanceTimersByTimeAsync(30000);

      await expect(dispatchPromise).rejects.toThrow('Could not find output node 12 in history');

      pool.stop();
    });

    it('should reject dispatch when output node has empty file array', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      mocks.getPromptHistory.mockResolvedValueOnce({
        outputs: { '12': { gifs: [] } }
      });
      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-empty-file',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        outputDestPath: '/tmp/out.mp4'
      });
      dispatchPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1);
      client.emit('execution_success', 'prompt-test-123');
      await vi.advanceTimersByTimeAsync(1);

      await expect(dispatchPromise).rejects.toThrow('No files generated by output node');

      pool.stop();
    });

    it('should set resolvedPrompt to null when no promptOutputNodeId is defined', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      mocks.prepareWorkflow.mockReturnValueOnce({
        workflow: {},
        foundInputImage: true,
        foundPrompt: true,
        foundSeed: true,
        videoOutputNodeId: '12',
        promptOutputNodeId: null
      });
      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const outPath = path.join(tempDir, 'out.mp4');
      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-no-prompt-node',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        outputDestPath: outPath
      });

      await vi.advanceTimersByTimeAsync(1);
      client.emit('execution_success', 'prompt-test-123');
      await vi.advanceTimersByTimeAsync(1);

      const result = await dispatchPromise;
      expect(result.resolvedPrompt).toBeNull();

      pool.stop();
    });

    it('should reject dispatch if server is already busy with another job', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      const state = pool.getOrCreateServerState('http://gpu1:8188');
      state.activeJob = { id: 'existing-busy-job' };

      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'new-job-id',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        outputDestPath: '/tmp/out.mp4'
      });

      await expect(dispatchPromise).rejects.toThrow('Server http://gpu1:8188 is already busy with another job.');

      pool.stop();
    });

    it('should reject dispatch promise and call interrupt when cancel is invoked', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });
      pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const dispatchPromise = pool.dispatch('http://gpu1:8188', {
        id: 'job-to-cancel',
        jobType: 'video',
        prompt: 'test',
        seed: 1,
        workflowTemplate: {},
        outputDestPath: '/tmp/out.mp4'
      });
      dispatchPromise.catch(() => {});

      await vi.advanceTimersByTimeAsync(1);

      const cancelled = await pool.cancel('http://gpu1:8188', 'job-to-cancel');
      expect(cancelled).toBe(true);
      expect(mocks.interrupt).toHaveBeenCalledWith('http://gpu1:8188');
      await expect(dispatchPromise).rejects.toThrow('Job cancelled');

      pool.stop();
    });
  });

  describe('Server Lifecycle & Connection Management', () => {
    it('should add new servers and disconnect removed servers on syncServers', () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188', 'http://gpu2:8188'] });

      pool.getClient('http://gpu1:8188');
      pool.getClient('http://gpu2:8188');

      expect(pool.activeClients.size).toBe(2);

      // Sync to remove gpu2 and add gpu3
      pool.syncServers(['http://gpu1:8188', 'http://gpu3:8188']);

      expect(pool.servers).toEqual(['http://gpu1:8188', 'http://gpu3:8188']);
      expect(pool.serverStates.has('http://gpu2:8188')).toBe(false);
      expect(pool.serverStates.has('http://gpu3:8188')).toBe(true);
      expect(pool.activeClients.has('http://gpu2:8188')).toBe(false);

      pool.stop();
    });

    it('should clean up all state and reject active promise on stop()', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const state = pool.serverStates.get('http://gpu1:8188');
      state.activeJob = { id: 'job-1' };
      const rejectSpy = vi.fn();
      state.activePromise = { reject: rejectSpy };

      pool.stop();

      expect(pool.isPolling).toBe(false);
      expect(pool.serverStates.size).toBe(0);
      expect(pool.activeClients.size).toBe(0);
      expect(rejectSpy).toHaveBeenCalledWith(expect.objectContaining({ message: 'Queue reset' }));
    });

    it('should begin telemetry polling on start() and be idempotent', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      expect(pool.isPolling).toBe(false);

      pool.start();
      expect(pool.isPolling).toBe(true);
      const interval = pool.telemetryInterval;

      // Second start call should do nothing
      pool.start();
      expect(pool.telemetryInterval).toBe(interval);

      pool.stop();
      expect(pool.isPolling).toBe(false);
    });
  });

  describe('Reconnect Recovery Scenarios', () => {
    it('Scenario A: should reject job when checkPromptStatus returns lost on reconnect', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });

      // Stub fetch for status check: /queue returns empty, /history returns 404
      const mockFetch = vi.fn().mockImplementation((url) => {
        const urlStr = String(url);
        if (urlStr.includes('/queue')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ queue_running: [], queue_pending: [] }) });
        }
        if (urlStr.includes('/history')) {
          return Promise.resolve({ ok: false, status: 404 });
        }
        return Promise.resolve({ ok: true });
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1); // initial connect (isReconnection = false)

      const state = pool.serverStates.get('http://gpu1:8188');
      state.activeJob = { id: 'job-lost', promptId: 'prompt-lost' };
      const onFailureSpy = vi.fn();
      state.activePromise = { onFailure: onFailureSpy };

      client.emit('disconnected');
      client.emit('connected'); // reconnect (isReconnection = true)
      await vi.advanceTimersByTimeAsync(1);

      expect(onFailureSpy).toHaveBeenCalledWith(expect.objectContaining({
        message: 'ComfyUI job lost on reconnect/crash'
      }));

      pool.stop();
    });

    it('Scenario B: should take no failure action when checkPromptStatus returns running on reconnect', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });

      // Stub fetch: prompt is in queue_running
      const mockFetch = vi.fn().mockImplementation((url) => {
        const urlStr = String(url);
        if (urlStr.includes('/queue')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({ queue_running: [['prompt-run', 'prompt-run']] })
          });
        }
        return Promise.resolve({ ok: true });
      });
      vi.stubGlobal('fetch', mockFetch);

      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const state = pool.serverStates.get('http://gpu1:8188');
      state.activeJob = { id: 'job-run', promptId: 'prompt-run' };
      const onFailureSpy = vi.fn();
      state.activePromise = { onFailure: onFailureSpy };

      client.emit('disconnected');
      client.emit('connected');
      await vi.advanceTimersByTimeAsync(1);

      expect(onFailureSpy).not.toHaveBeenCalled();

      pool.stop();
    });

    it('Scenario D: should fail active promise with history error message when checkPromptStatus returns failed', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });

      // Stub fetch: GET /queue empty, GET /history returns failed status
      const mockFetch = vi.fn().mockImplementation((url) => {
        const urlStr = String(url);
        if (urlStr.includes('/queue')) {
          return Promise.resolve({ ok: true, json: () => Promise.resolve({ queue_running: [], queue_pending: [] }) });
        }
        if (urlStr.includes('/history/prompt-failed')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              'prompt-failed': {
                status: {
                  status_str: 'error',
                  messages: [
                    ['execution_error', { exception_type: 'TorchError', exception_message: 'CUDA out of memory' }]
                  ]
                }
              }
            })
          });
        }
        return Promise.resolve({ ok: true });
      });
      vi.stubGlobal('fetch', mockFetch);

      mocks.getPromptHistory.mockResolvedValueOnce({
        status: {
          status_str: 'error',
          messages: [
            ['execution_error', { exception_type: 'TorchError', exception_message: 'CUDA out of memory' }]
          ]
        }
      });

      const client = pool.getClient('http://gpu1:8188');
      await vi.advanceTimersByTimeAsync(1);

      const state = pool.serverStates.get('http://gpu1:8188');
      state.activeJob = { id: 'job-failed', promptId: 'prompt-failed' };
      const onFailureSpy = vi.fn();
      state.activePromise = { onFailure: onFailureSpy };

      client.emit('disconnected');
      client.emit('connected');
      await vi.advanceTimersByTimeAsync(1);

      expect(onFailureSpy).toHaveBeenCalledWith(expect.objectContaining({
        message: 'TorchError: CUDA out of memory'
      }));

      pool.stop();
    });

    it('verifyActiveJobState should return cleanly without action when no active job is present', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      await expect(pool.verifyActiveJobState('http://gpu1:8188')).resolves.toBeUndefined();
      pool.stop();
    });
  });

  describe('Orphan Sweep', () => {
    it('should delete orphaned pending prompts from server', async () => {
      const { pool } = createTestPool({
        servers: ['http://gpu1:8188'],
        getTrackedPromptIds: () => new Set(['tracked-1'])
      });

      const fetchCalls = [];
      const mockFetch = vi.fn().mockImplementation((url, options) => {
        fetchCalls.push({ url: String(url), options });
        if (String(url).endsWith('/queue')) {
          if (options && options.method === 'POST') {
            return Promise.resolve({ ok: true, json: () => Promise.resolve({ deleted: true }) });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              queue_running: [],
              queue_pending: [['p1', 'orphan-pending-1']]
            })
          });
        }
        return Promise.resolve({ ok: true });
      });
      vi.stubGlobal('fetch', mockFetch);

      await pool.sweepOrphanedPrompts('http://gpu1:8188');

      const postCall = fetchCalls.find(c => c.url.endsWith('/queue') && c.options && c.options.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall.options.body);
      expect(body.delete).toEqual(['orphan-pending-1']);

      pool.stop();
    });

    it('should interrupt and delete orphaned running prompts', async () => {
      const { pool, mocks } = createTestPool({
        servers: ['http://gpu1:8188'],
        getTrackedPromptIds: () => new Set([])
      });

      const fetchCalls = [];
      const mockFetch = vi.fn().mockImplementation((url, options) => {
        fetchCalls.push({ url: String(url), options });
        if (String(url).endsWith('/queue')) {
          if (options && options.method === 'POST') {
            return Promise.resolve({ ok: true });
          }
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              queue_running: [['r1', 'orphan-running-1']],
              queue_pending: []
            })
          });
        }
        return Promise.resolve({ ok: true });
      });
      vi.stubGlobal('fetch', mockFetch);

      await pool.sweepOrphanedPrompts('http://gpu1:8188');

      expect(mocks.interrupt).toHaveBeenCalledWith('http://gpu1:8188');

      const postCall = fetchCalls.find(c => c.url.endsWith('/queue') && c.options && c.options.method === 'POST');
      expect(postCall).toBeDefined();
      const body = JSON.parse(postCall.options.body);
      expect(body.delete).toEqual(['orphan-running-1']);

      pool.stop();
    });

    it('should not delete or interrupt tracked prompts during sweep', async () => {
      const { pool, mocks } = createTestPool({
        servers: ['http://gpu1:8188'],
        getTrackedPromptIds: () => new Set(['tracked-prompt-1'])
      });

      const fetchCalls = [];
      const mockFetch = vi.fn().mockImplementation((url, options) => {
        fetchCalls.push({ url: String(url), options });
        if (String(url).endsWith('/queue')) {
          return Promise.resolve({
            ok: true,
            json: () => Promise.resolve({
              queue_running: [['r1', 'tracked-prompt-1']],
              queue_pending: []
            })
          });
        }
        return Promise.resolve({ ok: true });
      });
      vi.stubGlobal('fetch', mockFetch);

      await pool.sweepOrphanedPrompts('http://gpu1:8188');

      expect(mocks.interrupt).not.toHaveBeenCalled();
      const postCall = fetchCalls.find(c => c.url.endsWith('/queue') && c.options && c.options.method === 'POST');
      expect(postCall).toBeUndefined();

      pool.stop();
    });

    it('should do nothing when queue returns no prompts during sweep', async () => {
      const { pool, mocks } = createTestPool({ servers: ['http://gpu1:8188'] });

      const mockFetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ queue_running: [], queue_pending: [] })
      });
      vi.stubGlobal('fetch', mockFetch);

      await pool.sweepOrphanedPrompts('http://gpu1:8188');
      expect(mocks.interrupt).not.toHaveBeenCalled();

      pool.stop();
    });

    it('should handle fetch failure during sweep gracefully', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('Network error')));

      await expect(pool.sweepOrphanedPrompts('http://gpu1:8188')).resolves.toBeUndefined();

      pool.stop();
    });
  });

  describe('Telemetry', () => {
    it('should update server cpuTemp and gpuTemp on successful pollServerTelemetry', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      const state = pool.getOrCreateServerState('http://gpu1:8188');
      state.status = 'connected';

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve({ cpuTemp: 48, gpuTemp: 65 })
      }));

      await pool.pollServerTelemetry('http://gpu1:8188');

      expect(state.cpuTemp).toBe(48);
      expect(state.gpuTemp).toBe(65);

      pool.stop();
    });

    it('should set temps to null when server is not connected during pollServerTelemetry', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      const state = pool.getOrCreateServerState('http://gpu1:8188');
      state.status = 'disconnected';
      state.cpuTemp = 45;
      state.gpuTemp = 60;

      await pool.pollServerTelemetry('http://gpu1:8188');

      expect(state.cpuTemp).toBeNull();
      expect(state.gpuTemp).toBeNull();

      pool.stop();
    });

    it('should set temps to null when telemetry endpoint fetch returns non-ok response', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      const state = pool.getOrCreateServerState('http://gpu1:8188');
      state.status = 'connected';

      vi.stubGlobal('fetch', vi.fn().mockResolvedValue({
        ok: false,
        status: 404
      }));

      await pool.pollServerTelemetry('http://gpu1:8188');

      expect(state.cpuTemp).toBeNull();
      expect(state.gpuTemp).toBeNull();

      pool.stop();
    });

    it('should set temps to null when telemetry endpoint fetch throws error', async () => {
      const { pool } = createTestPool({ servers: ['http://gpu1:8188'] });
      const state = pool.getOrCreateServerState('http://gpu1:8188');
      state.status = 'connected';

      vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('AbortError')));

      await pool.pollServerTelemetry('http://gpu1:8188');

      expect(state.cpuTemp).toBeNull();
      expect(state.gpuTemp).toBeNull();

      pool.stop();
    });
  });
});
