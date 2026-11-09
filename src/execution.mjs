// One execution table feeds the standalone tool definitions and the public
// capability descriptor/executionPolicy. It has no imports so both surfaces can
// depend on it without a cycle.
export const OUTPUT_SCHEMA = Object.freeze({ type: 'object', additionalProperties: true });
export const DEFAULT_TIMEOUT_MS = 120000;

export const ACTIONS = Object.freeze(['scene', 'render', 'normalmap', 'inspect', 'export', 'guide', 'theme']);

const ALWAYS_CONCURRENT = new Set(['guide', 'inspect', 'render']);

/** Synchronous scheduling contract. Unknown actions fall back conservatively. */
export function executionPolicy(action, args = {}) {
  const name = String(action || '').replace(/^zpixel_/, '');
  if (!ACTIONS.includes(name)) return { timeoutMs: DEFAULT_TIMEOUT_MS, concurrencySafe: false };
  const concurrent = ALWAYS_CONCURRENT.has(name)
    || (name === 'scene' && ['open', 'list'].includes(args?.action))
    || (name === 'normalmap' && !args?.export)
    || (name === 'theme' && ['read', 'list'].includes(args?.action));
  return { timeoutMs: DEFAULT_TIMEOUT_MS, concurrencySafe: concurrent };
}

export const EXECUTION = Object.freeze(Object.fromEntries(ACTIONS.map(name => [name, Object.freeze(executionPolicy(name, {}))])));
