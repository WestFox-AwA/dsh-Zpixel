# ZPixel capability 0.5.3-dev

`./capability` exports the shared ZPixel business implementation for embedded Hosts. It has no framework, agent, or Master imports. The standalone package entry remains `.` (`src/index.mjs`) and registers the seven native tools through a thin real Host adapter.

## Public contract

```js
import { createCapability } from '@dsh-external/dsh-zpixel/capability';

const capability = createCapability(ports, { version: '0.5.3-dev' });
capability.descriptor;
const result = await capability.execute('scene', args, request);
await capability.releaseSession(request.sessionId);
await capability.dispose();
```

The descriptor is:

```js
{
  id: 'zpixel',
  version: '0.5.3-dev',
  contractVersion: 1,
  operations: [
    { name: 'scene', description, parameters, outputSchema, execution },
    { name: 'render', description, parameters, outputSchema, execution },
    { name: 'normalmap', description, parameters, outputSchema, execution },
    { name: 'inspect', description, parameters, outputSchema, execution },
    { name: 'export', description, parameters, outputSchema, execution },
    { name: 'guide', description, parameters, outputSchema, execution },
    { name: 'theme', description, parameters, outputSchema, execution },
  ],
  interaction: { version, workflow, aliases, topics, examples },
}

capability.executionPolicy(action, args) // -> { timeoutMs, concurrencySafe }
```

`execution` is the same scheduling declaration the standalone tool definitions use (`timeoutMs` plus a conservative `concurrencySafe`). `executionPolicy(action, args)` is synchronous and resolves the action-specific value, for example `scene action:"open"` is concurrent while `scene action:"edit"` is not. `interaction` is plain JSON: `workflow` is the exact standalone workflow text, `aliases` maps `zpixel_*` tool names to capability actions, `topics` point at the existing guide topics, and `examples` carry canonical `{action, args}` calls. An example with `bindings` is a template: each binding records a JSON pointer into `args` plus its type, and the Host must substitute a real value before executing. Examples without `bindings` are self-contained and chain their numeric revisions from the preceding create/edit calls.

`execute(action, args, request)` accepts the original tool suffixes `scene`, `render`, `normalmap`, `inspect`, `export`, `guide`, and `theme`. The `zpixel_` prefix is accepted as a compatibility spelling. It returns a Promise of `{ value, content? }`. `value` is the unchanged domain result. When the result contains an attachment, `content` carries native image blocks so an embedding Host cannot accidentally drop the render by returning only `value`.

## Ports

Ports are supplied by the Host and are required explicitly:

```js
const ports = {
  workspace: {
    // Return the already-authorized workspace for this trusted request.
    ensure(request, { write, signal }) {},
  },
  attachments: {
    imageLimits: { maxImageDimension: 4096 },
    // Resolve only after the Host has accepted the image delivery.
    async saveImages(images) {},
    // Optional: turn an attachment into the Host's native content block(s).
    async toContent(attachment, request) {},
  },
  // Optional only when request.modelInput is omitted. Return exactly one of
  // image_capable, data_only, capability_unknown.
  async modelInput(request) {},
};
```

`workspace.ensure` is the file authorization boundary. The request policy must explicitly be `read-only`, `workspace-write`, or `danger-full-access`; writable requests require `policy.workspaceRoot` so ZPixel output stays inside the explicit workspace even when the Host grants danger-full-access. The capability never defaults to unrestricted access. The service keeps its existing `.zpixel` path checks, symlink checks, workspace containment checks, revision checks, and abort checks.

`attachments.saveImages` is the delivery boundary. A successful render or normal-map preview records delivery only after this port resolves. `toContent` is optional; without it, the capability emits a generic `{ type: 'image', attachment }` block while preserving the original `value.attachment`. A Host must not resolve `saveImages` merely because Master invoked the operation if the image was not accepted for presentation.

The model input value is Host-owned. It may be present on the request DTO or detected by the `modelInput` port. Unknown or malformed values become `capability_unknown`. A reviewed export requires `image_capable`; unknown image capability fails closed with `VISUAL_INPUT_REQUIRED`. Drafts and technical normal-map output remain usable. No argument field can override this value.

## Trusted request

The Host constructs the DTO; callers must not put identity or policy fields in `args`:

```js
const request = Object.freeze({
  actorId: 'agent-parent',
  sessionId: 'session-42',
  workspace: 'C:/work/game',
  signal: execution.signal,
  callId: execution.callId,
  rootCallId: execution.rootCallId,
  policy: { mode: 'workspace-write', workspaceRoot: 'C:/work/game' },
  modelInput: 'image_capable', // optional; otherwise use ports.modelInput
});

const { value, content } = await capability.execute('render', {
  document: 'yard',
  mode: 'beauty',
}, request);
```

`actorId` owns reviewed visual evidence. A child actor cannot satisfy its parent actor's observation or delivery gate. Evidence is also tracked by `sessionId` for cleanup; `releaseSession(sessionId)` removes that session's delivery and observation evidence. Workspace and document hashes remain part of the existing gate. An observation is recorded only after the image delivery port succeeds, and normal-map output explicitly cannot satisfy the beauty observation gate.

## Domain behavior retained

The seven operations still execute the original `zpixel_scene`, `zpixel_render`, `zpixel_normalmap`, `zpixel_inspect`, `zpixel_export`, `zpixel_guide`, and `zpixel_theme` behavior. Rendering remains the existing exact-grid renderer. `zpixel_normalmap` produces a technical sprite-local normal map from the beauty hit buffer; an OpenGL normal convention does not remove the beauty render's authored lighting. ZPixel sprites are not arbitrary PBR textures or mesh tangent maps. `zpixel_normalmap` arguments are strict (document, revision, convention, scale, export; unknown fields fail with `UNSUPPORTED_FIELD`) and its results carry additive flatness diagnostics (`sourceMode:"geometry"`, `relief:"none"`, dominant/neutral shares, `flatness`); no height or strength parameter exists.

Standalone installation keeps the existing tool names and workflow. Embedded Hosts call `createCapability` directly and do not call `apply()` or register the seven tools again.
