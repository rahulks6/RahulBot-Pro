// Global identifiers for ESLint's no-undef rule (the `globals` package is not
// available offline). Only names actually used by the project are needed.
const node = Object.fromEntries(
  [
    'process',
    'console',
    'Buffer',
    'URL',
    'URLSearchParams',
    'setTimeout',
    'clearTimeout',
    'setInterval',
    'clearInterval',
    'setImmediate',
    'queueMicrotask',
    'structuredClone',
    'TextEncoder',
    'TextDecoder',
    'AbortController',
    'AbortSignal',
    'fetch',
    'Response',
    'Request',
    'Headers',
    'globalThis',
    'performance',
    'crypto',
  ].map((n) => [n, 'readonly']),
);
const browser = Object.fromEntries(
  [
    'window',
    'document',
    'confirm',
    'alert',
    'console',
    'URL',
    'FormData',
    'fetch',
    'Event',
    'HTMLElement',
    'HTMLFormElement',
    'HTMLInputElement',
    'HTMLAudioElement',
    'setTimeout',
  ].map((n) => [n, 'readonly']),
);
export default { node, browser };
