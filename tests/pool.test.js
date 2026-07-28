import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'events';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import { ComfyServerPool } from '../pool.js';

// Mock the 'ws' module
vi.mock('ws', () => {
  const EventEmitter = require('events');
  class MockWebSocket extends EventEmitter {
    constructor(url) {
      super();
      this.url = url;
      this.readyState = 0; // CONNECTING
      MockWebSocket.instances.push(this);
      
      // Simulate connection opening in next tick
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

  it('should initialize and register server state maps', () => {
    const pool = new ComfyServerPool({
      servers: ['http://gpu1:8188', 'http://gpu2:8188']
    });

    expect(pool.servers).toEqual(['http://gpu1:8188', 'http://gpu2:8188']);
    expect(pool.serverStates.has('http://gpu1:8188')).toBe(true);
    expect(pool.serverStates.get('http://gpu1:8188').status).toBe('offline');
    pool.stop();
  });

  it('should poll telemetry and emit telemetry events', async () => {
    const pool = new ComfyServerPool({
      servers: ['http://gpu1:8188'],
      telemetryIntervalMs: 1000
    });

    // Make client show connected so it polls
    const state = pool.getOrCreateServerState('http://gpu1:8188');
    state.status = 'connected';

    // Mock fetch for custom temperature endpoint
    const mockFetch = vi.fn().mockResolvedValue({
      ok: true,
      json: () => Promise.resolve({ cpuTemp: 45, gpuTemp: 68 })
    });
    vi.stubGlobal('fetch', mockFetch);

    let telemetryData = null;
    pool.on('telemetry', (data) => {
      telemetryData = data;
    });

    pool.start();
    await vi.advanceTimersByTimeAsync(0);

    expect(mockFetch).toHaveBeenCalledWith('http://gpu1:8188/custom_comfy_monitoring/temp', expect.anything());
    expect(telemetryData).toEqual([
      { url: 'http://gpu1:8188', status: 'connected', activeJob: null, cpuTemp: 45, gpuTemp: 68 }
    ]);
    pool.stop();
  });

  it('should transition server connection state and trigger verification on reconnect', async () => {
    const pool = new ComfyServerPool({
      servers: ['http://gpu1:8188'],
      recoveryTimeoutMs: 100
    });

    const client = pool.getClient('http://gpu1:8188');
    await vi.advanceTimersByTimeAsync(1); // open socket

    const state = pool.serverStates.get('http://gpu1:8188');
    expect(state.status).toBe('connected');

    // Simulate active job
    state.activeJob = { id: 'job-123', promptId: 'prompt-456' };
    state.activePromise = {
      onSuccess: vi.fn(),
      onFailure: vi.fn(),
      reject: vi.fn()
    };

    // Simulate disconnect
    client.emit('disconnected');
    expect(state.status).toBe('disconnected');
    expect(state.disconnectTimer).toBeDefined();

    // Advance timer past recovery timeout
    await vi.advanceTimersByTimeAsync(150);
    expect(state.status).toBe('offline');
    expect(state.activePromise.onFailure).toHaveBeenCalledWith(
      expect.objectContaining({ message: 'Connection to ComfyUI server lost' })
    );

    pool.stop();
  });

  it('Scenario C: should recover completed job when client reconnects within timeout', async () => {
    const pool = new ComfyServerPool({
      servers: ['http://gpu1:8188'],
      recoveryTimeoutMs: 500
    });

    // Mock fetch responses
    const mockFetch = vi.fn().mockImplementation((url) => {
      const urlStr = String(url);
      if (urlStr.endsWith('/prompt')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ prompt_id: 'prompt-456' })
        });
      }
      if (urlStr.includes('/queue')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({ queue_running: [], queue_pending: [] })
        });
      }
      if (urlStr.includes('/history/prompt-456')) {
        return Promise.resolve({
          ok: true,
          json: () => Promise.resolve({
            'prompt-456': {
              status: { status_str: 'success' },
              outputs: {
                '12': { gifs: [{ filename: 'out.mp4', subfolder: '', type: 'output' }] }
              }
            }
          })
        });
      }
      if (urlStr.includes('/view')) {
        return Promise.resolve({
          ok: true,
          arrayBuffer: () => Promise.resolve(new ArrayBuffer(4))
        });
      }
      return Promise.resolve({ ok: true });
    });
    vi.stubGlobal('fetch', mockFetch);

    const client = pool.getClient('http://gpu1:8188');
    await vi.advanceTimersByTimeAsync(1); // connect WS

    const outPath = path.join(tempDir, 'out.mp4');
    const dispatchPromise = pool.dispatch('http://gpu1:8188', {
      id: 'job-123',
      jobType: 'video',
      prompt: 'panda',
      seed: 12345,
      workflowTemplate: { "12": { "_meta": { "title": "APP_OUTPUT_VIDEO" } } },
      outputDestPath: outPath
    });

    // Let the prompt queue run
    await vi.advanceTimersByTimeAsync(1);

    // Simulate disconnect & reconnect
    client.emit('disconnected');
    expect(pool.serverStates.get('http://gpu1:8188').status).toBe('disconnected');

    // Emit connected (triggers verifyActiveJobState)
    client.emit('connected');
    await vi.advanceTimersByTimeAsync(1);

    const result = await dispatchPromise;
    expect(result.promptId).toBe('prompt-456');
    expect(fs.existsSync(outPath)).toBe(true);

    pool.stop();
  });
});
