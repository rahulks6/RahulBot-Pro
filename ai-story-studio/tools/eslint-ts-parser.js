// Minimal ESLint parser for TypeScript sources.
//
// The project avoids third-party runtime dependencies, and typescript-eslint is
// not available in the offline development environment. Node 22 ships
// `module.stripTypeScriptTypes`, which replaces type annotations with
// whitespace (positions are preserved), so ESLint's own parser (espree) can
// lint the remaining JavaScript with accurate line/column numbers.
// Type-level correctness is covered separately by `tsc` (npm run typecheck).
import { stripTypeScriptTypes } from 'node:module';
import * as espree from 'espree';

export const meta = { name: 'ai-story-studio-ts-strip', version: '1.0.0' };

export function parseForESLint(code, options = {}) {
  const js = stripTypeScriptTypes(code, { mode: 'strip' });
  const ast = espree.parse(js, {
    ecmaVersion: 'latest',
    sourceType: 'module',
    range: true,
    loc: true,
    comment: true,
    tokens: true,
    ...(options.ecmaFeatures ? { ecmaFeatures: options.ecmaFeatures } : {}),
  });
  return { ast, visitorKeys: espree.VisitorKeys };
}
