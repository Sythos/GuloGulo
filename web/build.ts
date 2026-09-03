#!/usr/bin/env node
/*
SPDX-License-Identifier: MIT
SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
Author: Sythos (https://www.sythos.net)
*/

import { mkdir, readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const webDirectory = dirname(fileURLToPath(import.meta.url));
const sourcePath = resolve(webDirectory, 'src/app.ts');
const outputPath = resolve(webDirectory, 'dist/app.js');
const source = await readFile(sourcePath, 'utf8');

if (!source.includes('/* @gulogulo-browser-source */')) {
  throw new Error('The browser source marker is missing from web/src/app.ts.');
}

await mkdir(resolve(webDirectory, 'dist'), { recursive: true });

// The `typescript` devDependency is aliased to a TS 6.x-API compatibility
// shim so typescript-eslint (which doesn't yet support TS 7's compiler API)
// can run; the real TS 7 compiler lives under the `@typescript/native` alias
// instead. See package.json's devDependencies for both.
const compilerPath = resolve(webDirectory, '..', 'node_modules', '@typescript', 'native', 'bin', 'tsc');
await new Promise<void>((resolvePromise, reject) => {
  const compiler = spawn(process.execPath, [compilerPath, '--project', resolve(webDirectory, '..', 'tsconfig.json')], {
    stdio: 'inherit',
    windowsHide: true,
  });
  compiler.once('error', reject);
  compiler.once('exit', (code) => {
    if (code === 0) resolvePromise();
    else reject(new Error(`TypeScript compiler exited with status ${code ?? 'unknown'}.`));
  });
});

const output = await readFile(outputPath, 'utf8');
if (!output.includes('export ')) {
  throw new Error('The TypeScript build did not produce an ES module.');
}
console.log(`Built ${outputPath}`);
