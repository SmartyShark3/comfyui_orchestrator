/**
 * Modifies workflow JSON in place with prompt, seed, and input image.
 */
export function prepareWorkflowJson(workflowJson, promptText, seed, imageName, negativePromptSuffix) {
  const workflow = JSON.parse(JSON.stringify(workflowJson)); // clone
  let foundInputImage = false;
  let foundPrompt = false;
  let foundSeed = false;
  let foundNegativePrompt = false;
  let videoOutputNodeId = null;
  let imageOutputNodeId = null;
  let promptOutputNodeId = null;

  for (const nodeId in workflow) {
    const node = workflow[nodeId];
    const title = node._meta?.title;

    if (title === 'APP_INPUT_IMAGE') {
      if (node.inputs) {
        if ('image' in node.inputs) {
          node.inputs.image = imageName;
        } else if ('value' in node.inputs) {
          node.inputs.value = imageName;
        } else {
          node.inputs.image = imageName;
        }
        foundInputImage = true;
      }
    } else if (title === 'APP_PROMPT') {
      if (node.inputs) {
        if ('text' in node.inputs) {
          node.inputs.text = promptText;
        } else if ('value' in node.inputs) {
          node.inputs.value = promptText;
        } else {
          node.inputs.text = promptText;
        }
        foundPrompt = true;
      }
    } else if (title === 'APP_SEED') {
      if (node.inputs) {
        if ('seed' in node.inputs) {
          node.inputs.seed = seed;
        } else if ('noise_seed' in node.inputs) {
          node.inputs.noise_seed = seed;
        } else if ('value' in node.inputs) {
          node.inputs.value = seed;
        } else {
          node.inputs.seed = seed;
        }
        foundSeed = true;
      }
    } else if (title === 'APP_NEGATIVE_PROMPT') {
      if (node.inputs) {
        foundNegativePrompt = true;
        if (negativePromptSuffix && typeof negativePromptSuffix === 'string') {
          const suffix = negativePromptSuffix.trim();
          if (suffix) {
            let currentText = '';
            let key = '';
            if ('text' in node.inputs) {
              currentText = node.inputs.text;
              key = 'text';
            } else if ('value' in node.inputs) {
              currentText = node.inputs.value;
              key = 'value';
            } else {
              currentText = '';
              key = 'text';
            }

            if (typeof currentText !== 'string') {
              currentText = '';
            }

            const separator = currentText
              ? (currentText.trim().endsWith(',') ? ' ' : ', ')
              : '';
            node.inputs[key] = currentText + separator + suffix;
          }
        }
      }
    } else if (title === 'APP_OUTPUT_VIDEO') {
      videoOutputNodeId = nodeId;
    } else if (title === 'APP_OUTPUT_IMAGE') {
      imageOutputNodeId = nodeId;
    } else if (title === 'APP_PROMPT_OUTPUT') {
      promptOutputNodeId = nodeId;
    }
  }

  return { workflow, foundInputImage, foundPrompt, foundSeed, foundNegativePrompt, videoOutputNodeId, imageOutputNodeId, promptOutputNodeId };
}
