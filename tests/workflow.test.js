import { describe, it, expect } from 'vitest';
import { prepareWorkflowJson } from '../workflow.js';

describe('Workflow JSON preparation', () => {
  it('should propagate prompt and seed to primitive node value keys', () => {
    const mockWorkflow = {
      "10": {
        "inputs": {
          "image": "old_image.png"
        },
        "_meta": { "title": "APP_INPUT_IMAGE" }
      },
      "20": {
        "inputs": {
          "value": "Old default prompt text"
        },
        "class_type": "PrimitiveStringMultiline",
        "_meta": { "title": "APP_PROMPT" }
      },
      "30": {
        "inputs": {
          "value": 123456
        },
        "class_type": "PrimitiveInt",
        "_meta": { "title": "APP_SEED" }
      },
      "40": {
        "inputs": {},
        "_meta": { "title": "APP_OUTPUT_VIDEO" }
      }
    };

    const newPrompt = "A beautiful sunny day in the park";
    const newSeed = 987654321;
    const newImage = "generated_input_frame_99.png";

    const { workflow, foundInputImage, foundPrompt, foundSeed, videoOutputNodeId } = prepareWorkflowJson(
      mockWorkflow,
      newPrompt,
      newSeed,
      newImage
    );

    expect(foundInputImage).toBe(true);
    expect(foundPrompt).toBe(true);
    expect(foundSeed).toBe(true);
    expect(videoOutputNodeId).toBe("40");

    // Check mutated values
    expect(workflow["10"].inputs.image).toBe(newImage);
    expect(workflow["20"].inputs.value).toBe(newPrompt);
    expect(workflow["30"].inputs.value).toBe(newSeed);
  });

  it('should propagate parameters to standard keys as fallbacks', () => {
    const mockWorkflow = {
      "10": {
        "inputs": {
          "image": "old_image.png"
        },
        "_meta": { "title": "APP_INPUT_IMAGE" }
      },
      "20": {
        "inputs": {
          "text": "Old default prompt text"
        },
        "_meta": { "title": "APP_PROMPT" }
      },
      "30": {
        "inputs": {
          "noise_seed": 100
        },
        "_meta": { "title": "APP_SEED" }
      },
      "40": {
        "inputs": {},
        "_meta": { "title": "APP_OUTPUT_VIDEO" }
      }
    };

    const newPrompt = "A futuristic city skyline";
    const newSeed = 7777777;
    const newImage = "init_image.png";

    const { workflow } = prepareWorkflowJson(mockWorkflow, newPrompt, newSeed, newImage);

    expect(workflow["10"].inputs.image).toBe(newImage);
    expect(workflow["20"].inputs.text).toBe(newPrompt);
    expect(workflow["30"].inputs.noise_seed).toBe(newSeed);
  });

  it('should return promptOutputNodeId if APP_PROMPT_OUTPUT node is present', () => {
    const mockWorkflow = {
      "10": {
        "inputs": {},
        "_meta": { "title": "APP_PROMPT_OUTPUT" }
      },
      "20": {
        "inputs": {},
        "_meta": { "title": "APP_OUTPUT_VIDEO" }
      }
    };

    const { promptOutputNodeId, videoOutputNodeId } = prepareWorkflowJson(mockWorkflow, "", 0, "");
    expect(promptOutputNodeId).toBe("10");
    expect(videoOutputNodeId).toBe("20");
  });

  it('should return promptOutputNodeId as null if APP_PROMPT_OUTPUT node is absent', () => {
    const mockWorkflow = {
      "20": {
        "inputs": {},
        "_meta": { "title": "APP_OUTPUT_VIDEO" }
      }
    };

    const { promptOutputNodeId, videoOutputNodeId } = prepareWorkflowJson(mockWorkflow, "", 0, "");
    expect(promptOutputNodeId).toBeNull();
    expect(videoOutputNodeId).toBe("20");
  });

  it('should return imageOutputNodeId if APP_OUTPUT_IMAGE node is present', () => {
    const mockWorkflow = {
      "30": {
        "inputs": {},
        "_meta": { "title": "APP_OUTPUT_IMAGE" }
      }
    };

    const { imageOutputNodeId, videoOutputNodeId } = prepareWorkflowJson(mockWorkflow, "", 0, "");
    expect(imageOutputNodeId).toBe("30");
    expect(videoOutputNodeId).toBeNull();
  });

  it('should append negative prompt suffix to APP_NEGATIVE_PROMPT node using text or value keys', () => {
    const mockWorkflow = {
      "10": {
        "inputs": {
          "text": "original_neg"
        },
        "_meta": { "title": "APP_NEGATIVE_PROMPT" }
      },
      "20": {
        "inputs": {
          "value": "original_neg_val"
        },
        "_meta": { "title": "APP_NEGATIVE_PROMPT" }
      }
    };

    const { workflow, foundNegativePrompt } = prepareWorkflowJson(mockWorkflow, "", 0, "", "suffix_neg");
    expect(foundNegativePrompt).toBe(true);
    expect(workflow["10"].inputs.text).toBe("original_neg, suffix_neg");
    expect(workflow["20"].inputs.value).toBe("original_neg_val, suffix_neg");
  });

  it('should handle comma separation correctly when appending negative prompts', () => {
    const mockWorkflow = {
      "10": {
        "inputs": {
          "text": "original_neg,"
        },
        "_meta": { "title": "APP_NEGATIVE_PROMPT" }
      },
      "20": {
        "inputs": {
          "text": ""
        },
        "_meta": { "title": "APP_NEGATIVE_PROMPT" }
      }
    };

    const { workflow } = prepareWorkflowJson(mockWorkflow, "", 0, "", "suffix_neg");
    expect(workflow["10"].inputs.text).toBe("original_neg, suffix_neg");
    expect(workflow["20"].inputs.text).toBe("suffix_neg");
  });
});
