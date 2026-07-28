import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'events';
import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import os from 'os';
import {
  ComfyWsClient,
  uploadImageToComfy,
  queuePromptToComfy,
  getComfyPromptHistory,
  interruptComfy,
  downloadComfyFile
} from '../client.js';

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

describe('ComfyWsClient WebSocket', () => {
  beforeEach(() => {
    WebSocket.instances = [];
    vi.useFakeTimers();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
  });

  it('should connect and emit connected event', async () => {
    const client = new ComfyWsClient('http://localhost:8188', 'test-client-id');
    
    let connectedEmitted = false;
    client.on('connected', () => {
      connectedEmitted = true;
    });

    client.connect();
    
    // Allow the connection timeout tick to fire
    await vi.advanceTimersByTimeAsync(1);

    expect(client.isConnected).toBe(true);
    expect(connectedEmitted).toBe(true);
    client.disconnect();
  });

  it('should parse and emit websocket message events', async () => {
    const client = new ComfyWsClient('http://localhost:8188', 'test-client-id');
    
    const events = [];
    client.on('progress', (value, max, node, promptId) => {
      events.push({ name: 'progress', value, max, node, promptId });
    });
    client.on('execution_success', (promptId) => {
      events.push({ name: 'execution_success', promptId });
    });

    client.connect();
    await vi.advanceTimersByTimeAsync(1);

    const wsInstance = WebSocket.instances[0];
    
    // Send progress event message
    const progressMsg = JSON.stringify({
      type: 'progress',
      data: { value: 5, max: 10, node: '12', prompt_id: 'prompt_123' }
    });
    wsInstance.emit('message', Buffer.from(progressMsg), false);

    // Send success event message
    const successMsg = JSON.stringify({
      type: 'execution_success',
      data: { prompt_id: 'prompt_123' }
    });
    wsInstance.emit('message', Buffer.from(successMsg), false);

    expect(events).toEqual([
      { name: 'progress', value: 5, max: 10, node: '12', promptId: 'prompt_123' },
      { name: 'execution_success', promptId: 'prompt_123' }
    ]);
    
    client.disconnect();
  });

  it('should emit all custom message types (status, execution_start, executing, executed, execution_error)', async () => {
    const client = new ComfyWsClient('http://localhost:8188', 'test-client-id');
    const emitted = {};

    client.on('status', (status) => { emitted.status = status; });
    client.on('execution_start', (promptId) => { emitted.execution_start = promptId; });
    client.on('executing', (node, promptId) => { emitted.executing = { node, promptId }; });
    client.on('executed', (promptId, node, output) => { emitted.executed = { promptId, node, output }; });
    client.on('execution_error', (promptId, exception) => { emitted.execution_error = { promptId, exception }; });

    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    const wsInstance = WebSocket.instances[0];

    wsInstance.emit('message', Buffer.from(JSON.stringify({ type: 'status', data: { status: { exec_info: { queue_remaining: 2 } } } })), false);
    wsInstance.emit('message', Buffer.from(JSON.stringify({ type: 'execution_start', data: { prompt_id: 'pid-1' } })), false);
    wsInstance.emit('message', Buffer.from(JSON.stringify({ type: 'executing', data: { node: '10', prompt_id: 'pid-1' } })), false);
    wsInstance.emit('message', Buffer.from(JSON.stringify({ type: 'executed', data: { prompt_id: 'pid-1', node: '10', output: { images: [] } } })), false);
    wsInstance.emit('message', Buffer.from(JSON.stringify({ type: 'execution_error', data: { prompt_id: 'pid-1', exception: 'Error details' } })), false);

    expect(emitted.status).toEqual({ exec_info: { queue_remaining: 2 } });
    expect(emitted.execution_start).toBe('pid-1');
    expect(emitted.executing).toEqual({ node: '10', promptId: 'pid-1' });
    expect(emitted.executed).toEqual({ promptId: 'pid-1', node: '10', output: { images: [] } });
    expect(emitted.execution_error).toEqual({ promptId: 'pid-1', exception: 'Error details' });

    client.disconnect();
  });

  it('should ignore binary messages', async () => {
    const client = new ComfyWsClient('http://localhost:8188', 'test-client-id');
    let messageCount = 0;
    client.on('message', () => { messageCount++; });

    client.connect();
    await vi.advanceTimersByTimeAsync(1);

    const wsInstance = WebSocket.instances[0];
    wsInstance.emit('message', Buffer.from([0x01, 0x02, 0x03]), true);

    expect(messageCount).toBe(0);
    client.disconnect();
  });

  it('should suppress log on consecutive connection errors (ECONNREFUSED)', async () => {
    const client = new ComfyWsClient('http://localhost:8188', 'test-client-id');
    client.on('error', () => {});
    const spyError = vi.spyOn(console, 'error').mockImplementation(() => {});

    client.connect();
    await vi.advanceTimersByTimeAsync(1);

    const wsInstance = WebSocket.instances[0];

    const err1 = new Error('connect ECONNREFUSED 127.0.0.1:8188');
    err1.code = 'ECONNREFUSED';
    wsInstance.emit('error', err1);

    const err2 = new Error('connect ECONNREFUSED 127.0.0.1:8188');
    err2.code = 'ECONNREFUSED';
    wsInstance.emit('error', err2);

    expect(spyError).toHaveBeenCalledTimes(1);
    expect(client._connectionErrorLogged).toBe(true);

    client.disconnect();
    spyError.mockRestore();
  });

  it('should clean up existing socket before opening a new one on connect()', async () => {
    const client = new ComfyWsClient('http://localhost:8188', 'test-client-id');

    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    expect(WebSocket.instances.length).toBe(1);

    // Call connect() again while socket is already present
    client.connect();
    await vi.advanceTimersByTimeAsync(1);

    expect(WebSocket.instances.length).toBe(2);
    expect(WebSocket.instances[0].readyState).toBe(3); // previous socket terminated
    client.disconnect();
  });

  it('should attempt automatic reconnection on unexpected close', async () => {
    const client = new ComfyWsClient('http://localhost:8188', 'test-client-id');
    
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.isConnected).toBe(true);

    const wsInstance = WebSocket.instances[0];
    
    let disconnectedEmitted = false;
    client.on('disconnected', () => {
      disconnectedEmitted = true;
    });

    // Simulate unexpected close
    wsInstance.emit('close');
    expect(client.isConnected).toBe(false);
    expect(disconnectedEmitted).toBe(true);

    // Reconnection is scheduled for 5 seconds
    expect(WebSocket.instances.length).toBe(1);
    await vi.advanceTimersByTimeAsync(5000);

    // A second connection attempt should have happened
    expect(WebSocket.instances.length).toBe(2);
    
    client.disconnect();
  });

  it('should NOT auto-reconnect after manual disconnect() is called', async () => {
    const client = new ComfyWsClient('http://localhost:8188', 'test-client-id');
    
    client.connect();
    await vi.advanceTimersByTimeAsync(1);
    expect(client.isConnected).toBe(true);

    // Disconnect manually
    client.disconnect();
    expect(client.isConnected).toBe(false);

    // Reconnection should NOT be scheduled
    await vi.advanceTimersByTimeAsync(6000);
    expect(WebSocket.instances.length).toBe(1); // No new instance created
  });
});

describe('ComfyUI API Helpers', () => {
  beforeEach(() => {
    vi.stubGlobal('fetch', vi.fn());
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('should queue prompt successfully', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ prompt_id: 'mock_prompt_123' })
    };
    fetch.mockResolvedValueOnce(mockResponse);

    const promptId = await queuePromptToComfy('http://localhost:8188', { node: {} }, 'client_xyz');
    expect(promptId).toBe('mock_prompt_123');
    expect(fetch).toHaveBeenCalledWith('http://localhost:8188/prompt', expect.objectContaining({
      method: 'POST',
      headers: { 'Content-Type': 'application/json' }
    }));
  });

  it('should throw error when queuePromptToComfy receives non-ok response', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Internal Error',
      text: async () => 'Syntax error in workflow'
    });

    await expect(queuePromptToComfy('http://localhost:8188', {}, 'cid')).rejects.toThrow(
      'Failed to queue prompt: Internal Error - Syntax error in workflow'
    );
  });

  it('should fetch history for prompt', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({
        'prompt_123': { status: 'success', outputs: {} }
      })
    };
    fetch.mockResolvedValueOnce(mockResponse);

    const history = await getComfyPromptHistory('http://localhost:8188', 'prompt_123');
    expect(history).toEqual({ status: 'success', outputs: {} });
    expect(fetch).toHaveBeenCalledWith('http://localhost:8188/history/prompt_123');
  });

  it('should throw error when getComfyPromptHistory receives non-ok response', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Not Found'
    });

    await expect(getComfyPromptHistory('http://localhost:8188', 'prompt_999')).rejects.toThrow(
      'Failed to fetch history for prompt prompt_999'
    );
  });

  it('should upload image with custom multi-part structure', async () => {
    const mockResponse = {
      ok: true,
      json: async () => ({ name: 'saved_name.png' })
    };
    fetch.mockResolvedValueOnce(mockResponse);

    const buffer = Buffer.from('fake-image-bytes');
    const resultName = await uploadImageToComfy('http://localhost:8188', buffer, 'input.png');
    expect(resultName).toBe('saved_name.png');
    expect(fetch).toHaveBeenCalledWith(
      'http://localhost:8188/upload/image',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'Content-Type': expect.stringContaining('multipart/form-data; boundary=')
        })
      })
    );
  });

  it('should throw error when uploadImageToComfy receives non-ok response', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      statusText: 'Bad Request',
      text: async () => 'Invalid image format'
    });

    const buffer = Buffer.from('fake-image-bytes');
    await expect(uploadImageToComfy('http://localhost:8188', buffer, 'input.png')).rejects.toThrow(
      'Failed to upload image to ComfyUI: Bad Request - Invalid image format'
    );
  });

  it('should download file and write to local destination path', async () => {
    const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'comfy-download-test-'));
    const localPath = path.join(tempDir, 'sub', 'out.png');
    const fakeBytes = new ArrayBuffer(8);

    fetch.mockResolvedValueOnce({
      ok: true,
      arrayBuffer: async () => fakeBytes
    });

    await downloadComfyFile('http://localhost:8188', 'img.png', 'myfolder', 'output', localPath);

    expect(fs.existsSync(localPath)).toBe(true);
    fs.rmSync(tempDir, { recursive: true, force: true });
  });

  it('should throw error when downloadComfyFile receives non-ok response', async () => {
    fetch.mockResolvedValueOnce({
      ok: false,
      statusText: '404 Not Found'
    });

    await expect(downloadComfyFile('http://localhost:8188', 'missing.png', '', 'output', '/tmp/out.png')).rejects.toThrow(
      'Failed to download file from ComfyUI: 404 Not Found'
    );
  });

  it('should interrupt active prompt successfully', async () => {
    const mockResponse = {
      ok: true
    };
    fetch.mockResolvedValueOnce(mockResponse);

    const ok = await interruptComfy('http://localhost:8188');
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://localhost:8188/interrupt', { method: 'POST' });
  });

  it('should return false when interruptComfy fails', async () => {
    fetch.mockRejectedValueOnce(new Error('Network error'));

    const spyConsole = vi.spyOn(console, 'error').mockImplementation(() => {});
    const ok = await interruptComfy('http://localhost:8188');
    expect(ok).toBe(false);
    spyConsole.mockRestore();
  });
});

