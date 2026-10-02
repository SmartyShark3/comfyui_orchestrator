import WebSocket from 'ws';
import fs from 'fs';
import path from 'path';
import { EventEmitter } from 'events';

/**
 * Helper to upload an image to ComfyUI.
 */
export async function uploadImageToComfy(comfyUrl, fileBuffer, filename) {
  const uploadUrl = `${comfyUrl}/upload/image`;
  
  // Construct multipart/form-data request manually to avoid external dependency issues
  const boundary = `----WebKitFormBoundary${Math.random().toString(36).substring(2)}`;
  const header = 
    `--${boundary}\r\n` +
    `Content-Disposition: form-data; name="image"; filename="${filename}"\r\n` +
    `Content-Type: image/png\r\n\r\n`;
  const footer = `\r\n--${boundary}--\r\n`;

  const body = Buffer.concat([
    Buffer.from(header, 'utf-8'),
    fileBuffer,
    Buffer.from(footer, 'utf-8')
  ]);

  const response = await fetch(uploadUrl, {
    method: 'POST',
    headers: {
      'Content-Type': `multipart/form-data; boundary=${boundary}`,
      'Content-Length': body.length.toString()
    },
    body,
    signal: AbortSignal.timeout(60000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to upload image to ComfyUI: ${response.statusText} - ${errorText}`);
  }

  const result = await response.json();
  return result.name; // returns the filename ComfyUI saved it as
}

/**
 * Submits the workflow prompt to ComfyUI.
 */
export async function queuePromptToComfy(comfyUrl, workflow, clientId) {
  const response = await fetch(`${comfyUrl}/prompt`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      prompt: workflow,
      client_id: clientId,
      extra_data: {
        extra_pnginfo: {
          workflow: {
            id: "app-workflow",
            nodes: []
          }
        }
      }
    }),
    signal: AbortSignal.timeout(15000)
  });

  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Failed to queue prompt: ${response.statusText} - ${errorText}`);
  }

  const result = await response.json();
  return result.prompt_id;
}

/**
 * Downloads a file from ComfyUI view endpoint.
 */
export async function downloadComfyFile(comfyUrl, filename, subfolder, type, localDestPath) {
  const params = new URLSearchParams({ filename, subfolder: subfolder || '', type: type || 'output' });
  const viewUrl = `${comfyUrl}/view?${params.toString()}`;
  
  const response = await fetch(viewUrl, { signal: AbortSignal.timeout(60000) });
  if (!response.ok) {
    throw new Error(`Failed to download file from ComfyUI: ${response.statusText}`);
  }

  const arrayBuffer = await response.arrayBuffer();
  const buffer = Buffer.from(arrayBuffer);
  
  if (buffer.length === 0) {
    throw new Error(`Downloaded empty file (0 bytes) from ComfyUI for ${filename}`);
  }

  await fs.promises.mkdir(path.dirname(localDestPath), { recursive: true });
  await fs.promises.writeFile(localDestPath, buffer);
}

/**
 * Fetches prompt execution history.
 */
export async function getComfyPromptHistory(comfyUrl, promptId) {
  const response = await fetch(`${comfyUrl}/history/${promptId}`, { signal: AbortSignal.timeout(10000) });
  if (!response.ok) {
    throw new Error(`Failed to fetch history for prompt ${promptId}`);
  }
  const history = await response.json();
  return history[promptId];
}

/**
 * Active client to track WebSocket updates for ComfyUI.
 */
export class ComfyWsClient extends EventEmitter {
  constructor(comfyUrl, clientId, options = {}) {
    super();
    this.comfyUrl = comfyUrl;
    this.clientId = clientId;
    this.ws = null;
    this.isConnected = false;
    this._manualDisconnect = false;
    this._connectionErrorLogged = false;
    this.heartbeatIntervalMs = options.heartbeatIntervalMs !== undefined ? options.heartbeatIntervalMs : 15000;
    this._heartbeatTimer = null;
    this._isAwaitingPong = false;
  }

  connect() {
    this._manualDisconnect = false;

    // Clean up any existing socket before connecting
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      this._stopHeartbeat();
      try {
        socket.removeAllListeners();
      } catch (err) { }
      socket.on('error', () => {});
      try {
        if (socket.readyState !== 3) {
          socket.terminate();
        }
      } catch (err) { }
    }

    const wsUrl = this.comfyUrl.replace(/^http/, 'ws') + `/ws?clientId=${this.clientId}`;
    if (!this._connectionErrorLogged) {
      console.log(`Connecting to ComfyUI WebSocket at: ${wsUrl}`);
    }
    
    const socket = new WebSocket(wsUrl);
    this.ws = socket;

    socket.on('open', () => {
      if (this.ws !== socket) return; // Ignore if this socket is no longer active
      this.isConnected = true;
      this._connectionErrorLogged = false;
      this._startHeartbeat();
      this.emit('connected');
      console.log('Connected to ComfyUI WebSocket');
    });

    socket.on('pong', () => {
      if (this.ws !== socket) return;
      this._isAwaitingPong = false;
    });

    socket.on('message', (rawData, isBinary) => {
      if (this.ws !== socket) return; // Ignore if this socket is no longer active
      if (isBinary) return;
      try {
        const msg = JSON.parse(rawData.toString());
        this.emit('message', msg);
        
        // Custom parsed events
        const { type, data } = msg;
        if (type === 'status') {
          this.emit('status', data.status);
        } else if (type === 'execution_start') {
          this.emit('execution_start', data.prompt_id);
        } else if (type === 'executing') {
          this.emit('executing', data.node, data.prompt_id);
        } else if (type === 'progress') {
          this.emit('progress', data.value, data.max, data.node, data.prompt_id);
        } else if (type === 'executed') {
          this.emit('executed', data.prompt_id, data.node, data.output);
        } else if (type === 'execution_success') {
          this.emit('execution_success', data.prompt_id);
        } else if (type === 'execution_error') {
          this.emit('execution_error', data.prompt_id, data.exception || data);
        }
      } catch (err) {
        console.error('Error parsing ComfyUI WS message:', err);
      }
    });

    socket.on('close', () => {
      if (this.ws === socket) {
        this._stopHeartbeat();
        this.ws = null;
        this.isConnected = false;
        this.emit('disconnected');
        
        try {
          socket.removeAllListeners();
        } catch (err) { }
        socket.on('error', () => {});

        if (this._manualDisconnect) {
          console.log('Disconnected from ComfyUI WebSocket (intentional, no reconnect).');
          return;
        }
        if (!this._connectionErrorLogged) {
          console.log('Disconnected from ComfyUI WebSocket. Reconnecting in 5s...');
        }
        setTimeout(() => this.connect(), 5000);
      } else {
        // This was an orphaned socket closing; clean it up silently
        try {
          socket.removeAllListeners();
        } catch (err) { }
          socket.on('error', () => {});
      }
    });

    socket.on('error', (err) => {
      if (this.ws !== socket) return; // Ignore if this socket is no longer active
      this._stopHeartbeat();
      
      const isConnectionError = ['ECONNREFUSED', 'ETIMEDOUT', 'EHOSTUNREACH', 'ENETUNREACH', 'ECONNRESET'].includes(err.code) || err.message.includes('ETIMEDOUT') || err.message.includes('ECONNREFUSED');
      const wasLogged = this._connectionErrorLogged;
      if (isConnectionError) {
        this._connectionErrorLogged = true;
      }

      this.emit('error', err);
      
      if (isConnectionError) {
        if (!wasLogged) {
          console.error(`ComfyUI WebSocket connection failed at ${this.comfyUrl}: ${err.message} (further connection errors suppressed until connected)`);
        }
      } else {
        console.error('ComfyUI WebSocket Error:', err.message);
      }
    });
  }

  _startHeartbeat() {
    this._stopHeartbeat();
    if (this.heartbeatIntervalMs <= 0) return;
    this._isAwaitingPong = false;
    this._heartbeatTimer = setInterval(() => {
      if (!this.ws || !this.isConnected) {
        this._stopHeartbeat();
        return;
      }
      if (this._isAwaitingPong) {
        console.warn(`[ComfyWsClient] WebSocket heartbeat timeout on ${this.comfyUrl}. Terminating socket...`);
        this._stopHeartbeat();
        try {
          this.ws.terminate();
        } catch (e) {}
        return;
      }
      this._isAwaitingPong = true;
      try {
        if (typeof this.ws.ping === 'function') {
          this.ws.ping();
        }
      } catch (err) {
        this._stopHeartbeat();
      }
    }, this.heartbeatIntervalMs);
  }

  _stopHeartbeat() {
    if (this._heartbeatTimer) {
      clearInterval(this._heartbeatTimer);
      this._heartbeatTimer = null;
    }
    this._isAwaitingPong = false;
  }

  disconnect() {
    this._manualDisconnect = true;
    this._stopHeartbeat();
    this.isConnected = false;
    if (this.ws) {
      const socket = this.ws;
      this.ws = null;
      try {
        socket.removeAllListeners();
      } catch (err) { }
      socket.on('error', () => {});
      try {
        if (socket.readyState !== 3) { // 3 is CLOSED
          socket.terminate();
        }
      } catch (err) { }
    }
  }
}

/**
 * Interrupts the currently executing prompt in ComfyUI.
 */
export async function interruptComfy(comfyUrl) {
  try {
    const response = await fetch(`${comfyUrl}/interrupt`, {
      method: 'POST',
      signal: AbortSignal.timeout(5000)
    });
    return response.ok;
  } catch (err) {
    console.error('Failed to interrupt ComfyUI:', err.message);
    return false;
  }
}
