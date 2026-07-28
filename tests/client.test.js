import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import EventEmitter from 'events';
import WebSocket from 'ws';
import { ComfyWsClient, uploadImageToComfy, queuePromptToComfy, getComfyPromptHistory, interruptComfy } from '../client.js';

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

  it('should interrupt active prompt successfully', async () => {
    const mockResponse = {
      ok: true
    };
    fetch.mockResolvedValueOnce(mockResponse);

    const ok = await interruptComfy('http://localhost:8188');
    expect(ok).toBe(true);
    expect(fetch).toHaveBeenCalledWith('http://localhost:8188/interrupt', { method: 'POST' });
  });
});
