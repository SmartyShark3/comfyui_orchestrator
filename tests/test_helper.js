import EventEmitter from 'events';
import { vi } from 'vitest';
import { ComfyServerPool } from '../pool.js';

export class MockWebSocket extends EventEmitter {
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

  ping() {
    this.emit('pong');
  }

  terminate() {
    this.readyState = 3; // CLOSED
    this.emit('close');
  }
}
MockWebSocket.instances = [];

export function createTestPool(options = {}, mockOverrides = {}) {
  const defaultMocks = {
    prepareWorkflow: vi.fn().mockImplementation((workflowTemplate, prompt, seed, inputImageName, negativePrompt) => ({
      workflow: workflowTemplate,
      foundInputImage: true,
      foundPrompt: true,
      foundSeed: true,
      videoOutputNodeId: '12',
      imageOutputNodeId: '14',
      promptOutputNodeId: '13'
    })),
    uploadImage: vi.fn().mockImplementation((serverUrl, fileBuffer, filename) => Promise.resolve(filename)),
    queuePrompt: vi.fn().mockImplementation((serverUrl, workflow, clientId) => Promise.resolve('prompt-test-123')),
    downloadFile: vi.fn().mockImplementation((serverUrl, filename, subfolder, type, localDestPath) => Promise.resolve()),
    getPromptHistory: vi.fn().mockImplementation((serverUrl, promptId) => Promise.resolve({
      outputs: {
        '12': { gifs: [{ filename: 'output.mp4', subfolder: '', type: 'output' }] },
        '14': { images: [{ filename: 'output.png', subfolder: '', type: 'output' }] },
        '13': { text: ['Resolved prompt text'] }
      }
    })),
    interrupt: vi.fn().mockResolvedValue(true),
    ...mockOverrides
  };

  class TestComfyServerPool extends ComfyServerPool {
    prepareWorkflow(workflowTemplate, prompt, seed, inputImageName, negativePrompt) {
      return TestComfyServerPool.mocks.prepareWorkflow(workflowTemplate, prompt, seed, inputImageName, negativePrompt);
    }

    async uploadImage(serverUrl, fileBuffer, filename) {
      return TestComfyServerPool.mocks.uploadImage(serverUrl, fileBuffer, filename);
    }

    async queuePrompt(serverUrl, workflow, clientId) {
      return TestComfyServerPool.mocks.queuePrompt(serverUrl, workflow, clientId);
    }

    async downloadFile(serverUrl, filename, subfolder, type, localDestPath) {
      return TestComfyServerPool.mocks.downloadFile(serverUrl, filename, subfolder, type, localDestPath);
    }

    async getPromptHistory(serverUrl, promptId) {
      return TestComfyServerPool.mocks.getPromptHistory(serverUrl, promptId);
    }

    async interrupt(serverUrl) {
      return TestComfyServerPool.mocks.interrupt(serverUrl);
    }
  }

  TestComfyServerPool.mocks = defaultMocks;

  const poolInstance = new TestComfyServerPool(options);
  return { pool: poolInstance, mocks: defaultMocks };
}
