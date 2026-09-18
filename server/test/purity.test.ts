import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, normalize, relative } from 'node:path';
import { test } from 'node:test';

/**
 * The unit suite has to run with no database, no Redis and no .env -- that is
 * the whole point of it, and it is what CI gives it.
 *
 * `src/config.ts` validates the entire environment at import time and throws if
 * anything is missing, so a single import reaching it takes the whole file down
 * before a test runs. That happened: `daraja/stk.ts` imported the shared Daraja
 * client for two HTTP helpers, the client imports config, and the STK tests
 * died on CI while passing locally -- because a developer machine has a .env
 * and CI does not.
 *
 * This walks the real import graph so the mistake cannot come back quietly.
 */

const testDir = import.meta.dirname;
const serverDir = dirname(testDir);

const IMPORT_RE = /(?:from|import)\s+'(\.[^']+)'/g;

function relativeImports(file: string): string[] {
  const src = readFileSync(file, 'utf8');
  return [...src.matchAll(IMPORT_RE)].map((m) => m[1]!);
}

/** TypeScript writes '.js' in specifiers; resolve back to the source file. */
function resolveImport(fromFile: string, spec: string): string {
  const target = spec.endsWith('.js') ? `${spec.slice(0, -3)}.ts` : `${spec}.ts`;
  return normalize(join(dirname(fromFile), target));
}

/** Every module an entrypoint pulls in, transitively. */
function importGraph(entry: string): string[] {
  const seen = new Set<string>();
  const stack = [entry];

  while (stack.length > 0) {
    const current = stack.pop()!;
    if (seen.has(current)) continue;
    seen.add(current);

    let specs: string[];
    try {
      specs = relativeImports(current);
    } catch {
      continue; // a .json fixture or a path that is not a source file
    }
    for (const spec of specs) stack.push(resolveImport(current, spec));
  }

  return [...seen];
}

const unitTests = readdirSync(testDir)
  .filter((f) => f.endsWith('.test.ts'))
  .map((f) => join(testDir, f));

test('the unit suite has test files to check', () => {
  assert.ok(unitTests.length >= 4, `expected the unit tests, found ${unitTests.length}`);
});

for (const entry of unitTests) {
  const name = relative(testDir, entry);

  test(`${name} runs without an environment`, () => {
    const reached = importGraph(entry).filter((f) => f.endsWith('config.ts'));

    assert.deepEqual(
      reached.map((f) => relative(serverDir, f)),
      [],
      `${name} imports src/config.ts, which validates the environment at import ` +
        `time and will throw in CI where there is no .env. Move whatever needs ` +
        `config behind a separate module (see daraja/stk.ts vs daraja/stkClient.ts).`,
    );
  });
}
