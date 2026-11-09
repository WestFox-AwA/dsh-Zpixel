import { createZPixelService as createExplicitService } from '../src/service.mjs';

function inputFrom(ctx, exec) {
  const selection = exec?.agent?.session?.requestHeader?.()?.config;
  return (async () => {
    if (!selection || typeof ctx.llm?.resolveModelInfo !== 'function') return 'capability_unknown';
    try {
      const model = await ctx.llm.resolveModelInfo(selection.provider, selection.model, exec.signal);
      return Array.isArray(model?.inputModalities)
        ? (model.inputModalities.includes('image') ? 'image_capable' : 'data_only')
        : 'capability_unknown';
    } catch (error) {
      exec.signal?.throwIfAborted?.();
      return 'capability_unknown';
    }
  })();
}

/** Test-only boundary adapter. Runtime code receives the same explicit ports. */
export function createZPixelServiceForTest(ctx) {
  const execByRequest = new WeakMap();
  const attachments = ctx.attachments?.saveImages
    ? ctx.attachments
    : {
      imageLimits: { maxImageDimension: 4096 },
      async saveImages(images) { return images.map((image, index) => ({ path: `stub-${index}.png`, mediaType: image.mediaType, name: image.name })); },
    };
  const ports = {
    workspace: { async ensure(request) { return request.workspace; } },
    attachments,
    async modelInput(request) {
      const exec = execByRequest.get(request);
      return exec ? inputFrom(ctx, exec) : 'capability_unknown';
    },
  };
  const service = createExplicitService(ports);
  return {
    async run(name, args, exec) {
      if (!exec?.agent) throw new Error('test execution requires an agent');
      const workspace = await ctx.workingDirectory.ensure(exec.agent, exec.signal);
      const policy = ctx.sandboxPolicy.resolve({ session: exec.agent.session });
      const header = exec.agent.session?.requestHeader?.() ?? {};
      const actorId = exec.agent.id;
      const sessionId = exec.agent.session?.id ?? exec.agent.session?.sessionId ?? header.sessionId ?? `test-${actorId}`;
      const callId = exec.callId ?? exec.requestId ?? header.callId ?? `test-call-${sessionId}`;
      const rootCallId = exec.rootCallId ?? header.rootCallId ?? header.rootRequestId ?? `test-root-${sessionId}`;
      const request = {
        actorId,
        sessionId,
        workspace,
        signal: exec.signal,
        callId,
        rootCallId,
        policy: { mode: policy?.mode, workspaceRoot: policy?.workspaceRoot },
      };
      execByRequest.set(request, exec);
      request.modelInput = await inputFrom(ctx, exec);
      return service.run(name, args, request);
    },
    releaseSession: service.releaseSession,
    dispose: service.dispose,
  };
}
