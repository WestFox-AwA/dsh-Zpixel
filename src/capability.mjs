import { createZPixelService, VERSION } from './service.mjs';
import { TOOL_SCHEMAS } from './protocol.mjs';
import { ACTIONS, EXECUTION, OUTPUT_SCHEMA, executionPolicy } from './execution.mjs';
import { createInteraction } from './interaction.mjs';

const TOOL_BY_ACTION = new Map(TOOL_SCHEMAS.map(schema => [schema.name.slice('zpixel_'.length), schema]));

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function actionName(action) {
  if (typeof action !== 'string' || !action) fail('ACTION_REQUIRED', 'ZPixel capability action must be one of scene, render, normalmap, inspect, export, guide or theme.');
  const suffix = action.startsWith('zpixel_') ? action.slice('zpixel_'.length) : action;
  if (!ACTIONS.includes(suffix)) fail('ACTION_UNKNOWN', `Unknown ZPixel capability action: ${action}.`, { action, allowed: ACTIONS });
  return suffix;
}

function trustedRequest(request) {
  if (!request || typeof request !== 'object') fail('REQUEST_REQUIRED', 'ZPixel capability execution requires a Host-owned request DTO.');
  return request;
}

async function contentFor(ports, value, request) {
  if (Array.isArray(value?.content)) return value.content;
  const attachment = value?.attachment;
  if (!attachment) return undefined;
  const toContent = ports.attachments?.toContent ?? ports.attachments?.content;
  if (typeof toContent === 'function') {
    const content = await toContent(attachment, request);
    if (content === undefined || content === null) return [{ type: 'image', attachment }];
    if (!Array.isArray(content)) fail('ATTACHMENT_CONTENT', 'ports.attachments.toContent must return an array of native content blocks.');
    return content;
  }
  // The generic block keeps the image visible for hosts that do not need a
  // custom native block factory. A Host may replace it through toContent.
  return [{ type: 'image', attachment }];
}

/**
 * Public embeddable ZPixel capability. This module imports only local domain
 * code; Host bindings, registration and request construction stay in
 * src/index.mjs.
 */
export function createCapability(ports, config = {}) {
  const service = createZPixelService(ports, config);
  let disposed = false;
  const descriptor = {
    id: 'zpixel',
    version: config.version ?? VERSION,
    contractVersion: 1,
    operations: ACTIONS.map(name => {
      const schema = TOOL_BY_ACTION.get(name);
      return {
        name,
        description: schema.description,
        ...(schema.parameters ? { parameters: schema.parameters } : {}),
        outputSchema: JSON.parse(JSON.stringify(OUTPUT_SCHEMA)),
        execution: { ...EXECUTION[name] },
      };
    }),
    interaction: createInteraction(),
  };

  return {
    descriptor,
    async execute(action, args = {}, request) {
      if (disposed) fail('DISPOSED', 'ZPixel capability has been disposed.');
      const suffix = actionName(action);
      const trusted = trustedRequest(request);
      const value = await service.run(`zpixel_${suffix}`, args, trusted);
      const content = await contentFor(ports, value, trusted);
      return content?.length ? { value, content } : { value };
    },
    executionPolicy(action, args = {}) {
      return executionPolicy(action, args);
    },
    async releaseSession(sessionId) {
      if (disposed) return;
      service.releaseSession(sessionId);
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      service.dispose();
    },
  };
}

export { ACTIONS };
