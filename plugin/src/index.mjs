import path from 'node:path';
import { createCapability } from './capability.mjs';
import { toolDefinitions } from './protocol.mjs';
import { WORKFLOW } from './guides.mjs';

export const name = 'zpixel';
export const inject = ['tools', 'attachments', 'systemPrompt', 'workingDirectory', 'sandboxPolicy', 'llm'];

const hostExecutions = new WeakMap();

function fail(code, message, details = {}) {
  const error = new Error(message);
  error.code = code;
  error.details = details;
  throw error;
}

function headerFor(exec) {
  try { return exec.agent?.session?.requestHeader?.() ?? {}; }
  catch { return {}; }
}

function requiredString(value, field) {
  if (typeof value !== 'string' || !value) fail('HOST_REQUEST', `The real Host execution is missing ${field}.`, { field });
  return value;
}

async function detectModelInput(ctx, exec, header) {
  const selection = header?.config;
  if (!selection || typeof ctx.llm?.resolveModelInfo !== 'function') return 'capability_unknown';
  try {
    const model = await ctx.llm.resolveModelInfo(selection.provider, selection.model, exec.signal);
    if (!Array.isArray(model?.inputModalities)) return 'capability_unknown';
    return model.inputModalities.includes('image') ? 'image_capable' : 'data_only';
  } catch (error) {
    exec.signal?.throwIfAborted?.();
    return 'capability_unknown';
  }
}

async function requestFromExec(ctx, exec) {
  const agent = exec?.agent;
  const session = agent?.session;
  if (!agent || !session) fail('HOST_REQUEST', 'ZPixel standalone tools require a real Host Agent execution and session.');
  const header = headerFor(exec);
  const signal = exec.signal;
  if (!signal || typeof signal.throwIfAborted !== 'function') fail('HOST_REQUEST', 'The real Host execution is missing its cancellation signal.');
  const workspace = await ctx.workingDirectory.ensure(agent, signal);
  const policy = ctx.sandboxPolicy.resolve({ session });
  const actorId = requiredString(agent.id, 'actorId');
  const sessionId = requiredString(session.id ?? session.sessionId ?? header.sessionId, 'sessionId');
  const callId = requiredString(exec.callId ?? exec.requestId ?? header.callId, 'callId');
  const rootCallId = requiredString(exec.rootCallId ?? header.rootCallId ?? header.rootRequestId, 'rootCallId');
  const request = {
    actorId,
    sessionId,
    workspace: path.resolve(workspace),
    signal,
    callId,
    rootCallId,
    policy: { mode: policy?.mode, workspaceRoot: policy?.workspaceRoot },
    modelInput: await detectModelInput(ctx, exec, header),
  };
  hostExecutions.set(request, exec);
  return Object.freeze(request);
}

function createHostPorts(ctx) {
  return {
    workspace: {
      async ensure(request) {
        const exec = hostExecutions.get(request);
        if (!exec) fail('HOST_REQUEST', 'The request DTO was not created by the real standalone Host adapter.');
        const workspace = await ctx.workingDirectory.ensure(exec.agent, request.signal);
        if (path.resolve(workspace) !== path.resolve(request.workspace)) fail('HOST_REQUEST', 'The Host workspace changed while executing the request.');
        return workspace;
      },
    },
    attachments: ctx.attachments,
    modelInput: async request => request.modelInput,
  };
}

/** Host-only, disposable registrations. No model mutation, agent control or Client UI. */
export function apply(ctx) {
  const capability = createCapability(createHostPorts(ctx));
  const service = {
    async run(name, args, exec) {
      const request = await requestFromExec(ctx, exec);
      const action = name.startsWith('zpixel_') ? name.slice('zpixel_'.length) : name;
      return (await capability.execute(action, args, request)).value;
    },
    dispose: () => capability.dispose(),
  };
  ctx.effect(() => {
    const cleanups = [];
    try {
      for (const definition of toolDefinitions(service)) cleanups.push(ctx.tools.register(definition));
      cleanups.push(ctx.systemPrompt.section({
        name: 'zpixel:workflow',
        order: 3510,
        text: context => ctx.tools.get('zpixel_scene', context.scope) ? WORKFLOW : '',
      }));
    } catch (error) {
      for (const dispose of cleanups.reverse()) dispose();
      service.dispose();
      throw error;
    }
    return () => { for (const dispose of cleanups.reverse()) dispose(); service.dispose(); };
  });
}
