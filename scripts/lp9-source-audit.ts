#!/usr/bin/env node
// SPDX-License-Identifier: MIT
// SPDX-FileCopyrightText: 2026 Sythos (https://www.sythos.net)
// Author: Sythos (https://www.sythos.net)

import { readFile, readdir } from 'node:fs/promises';
import { resolve } from 'node:path';

type SourceFile = { readonly path: string; readonly extension: string };
export type SourceAuditSummary = {
  readonly milestone: 'LP9';
  readonly status: 'passed';
  readonly typescriptSources: number;
  readonly bridgeSources: number;
  readonly executableJavaScriptSources: number;
  readonly bridgePaths: readonly string[];
  readonly waiverCount: number;
};

const SOURCE_ROOTS = ['src', 'scripts', 'web'] as const;
const GENERATED_DIRECTORIES = new Set(['dist', 'node_modules', '.git']);
const SOURCE_EXTENSIONS = new Set(['.mjs', '.cjs', '.js', '.ts']);
const AUTHOR = 'Author: Sythos (https://www.sythos.net)';
const SPDX = 'SPDX-License-Identifier: MIT';

function failure(code: string, message: string): Error & { code: string } {
  const error = new Error(`${code}: ${message}`) as Error & { code: string };
  error.code = code;
  return error;
}

function posixPath(value: string): string {
  return value.replaceAll('\\', '/');
}

async function collectSources(root: string, directory: string): Promise<SourceFile[]> {
  const entries = await readdir(resolve(root, directory), { withFileTypes: true });
  const files: SourceFile[] = [];
  for (const entry of entries) {
    if (GENERATED_DIRECTORIES.has(entry.name)) continue;
    const child = `${directory}/${entry.name}`;
    if (entry.isDirectory()) {
      files.push(...await collectSources(root, child));
      continue;
    }
    const extension = entry.name.slice(entry.name.lastIndexOf('.'));
    if (SOURCE_EXTENSIONS.has(extension)) files.push({ path: posixPath(child), extension });
  }
  return files;
}

function stripComments(source: string): string {
  return source
    .replace(/\/\*[\s\S]*?\*\//gu, '')
    .replace(/^\s*\/\/.*$/gmu, '')
    .replace(/^\s*#!.*$/gmu, '')
    .trim();
}

function bridgeStatements(source: string): string[] {
  return stripComments(source).split(/\r?\n/u).map((line) => line.trim()).filter(Boolean);
}

function canonicalPathForBridge(bridgePath: string): string {
  return bridgePath.replace(/\.mjs$/u, '.ts').replace(/\.cjs$/u, '.ts').replace(/\.js$/u, '.ts');
}

function validateBridgeText(source: string, bridgePath: string): void {
  if (!source.includes(SPDX) || !source.includes(AUTHOR)) {
    throw failure('LP9_METADATA_INVALID', `${bridgePath} is missing the canonical MIT/SPDX attribution.`);
  }
  if (!/compatibility (?:bridge|shim)/iu.test(source)) {
    throw failure('LP9_BRIDGE_NOT_DOCUMENTED', `${bridgePath} does not document why the compatibility entry point remains.`);
  }
  const statements = bridgeStatements(source);
  if (statements.length === 0) throw failure('LP9_BRIDGE_NOT_THIN', `${bridgePath} has no delegating statement.`);
  for (const statement of statements) {
    const directTypeScript = /^(?:import\s+['"][^'"]+\.ts['"];?|await\s+import\(['"][^'"]+\.ts['"]\);?|export\s+\*\s+from\s+['"][^'"]+\.ts['"];?)$/u.test(statement);
    const compiledRuntime = /^(?:await\s+import\(['"][^'"]+\/dist\/server\/[^'"]+\.js['"]\);?|export\s+\*\s+from\s+['"][^'"]+\/dist\/server\/[^'"]+\.js['"];?)$/u.test(statement);
    if (!directTypeScript && !compiledRuntime) {
      throw failure('LP9_BRIDGE_NOT_THIN', `${bridgePath} contains executable compatibility logic: ${statement}`);
    }
  }
}

function countWaivers(contents: readonly string[]): number {
  return contents.reduce((count, source) => count + (source.match(/^\s*\/\/\s*@ts-nocheck\b/gmu)?.length ?? 0), 0);
}

export async function auditSource(root = process.cwd()): Promise<SourceAuditSummary> {
  const files = (await Promise.all(SOURCE_ROOTS.map((directory) => collectSources(root, directory)))).flat();
  const typescript = files.filter((file) => file.extension === '.ts');
  const javascript = files.filter((file) => file.extension !== '.ts');
  const sources = await Promise.all(files.map((file) => readFile(resolve(root, file.path), 'utf8')));
  for (const [index, source] of sources.entries()) {
    if (!source.includes(SPDX) || !source.includes(AUTHOR)) {
      throw failure('LP9_METADATA_INVALID', `${files[index].path} is missing the canonical MIT/SPDX attribution.`);
    }
  }
  const bridgePaths: string[] = [];
  for (const file of javascript) {
    if (file.extension !== '.mjs') throw failure('LP9_JAVASCRIPT_SOURCE', `${file.path} is executable JavaScript; use TypeScript.`);
    const canonical = canonicalPathForBridge(file.path);
    try {
      await readFile(resolve(root, canonical), 'utf8');
    } catch {
      throw failure('LP9_CANONICAL_MISSING', `${file.path} has no TypeScript canonical at ${canonical}.`);
    }
    const source = await readFile(resolve(root, file.path), 'utf8');
    validateBridgeText(source, file.path);
    bridgePaths.push(file.path);
  }
  const packageJson = JSON.parse(await readFile(resolve(root, 'package.json'), 'utf8')) as { scripts?: Record<string, string> };
  const packageScripts = Object.entries(packageJson.scripts ?? {});
  for (const [name, command] of packageScripts) {
    if (/\.(?:mjs|cjs|js)\b/u.test(command) && !/dist\/server/u.test(command)) {
      throw failure('LP9_PACKAGE_JAVASCRIPT', `package script ${name} still invokes a source JavaScript entry point.`);
    }
  }
  return {
    milestone: 'LP9',
    status: 'passed',
    typescriptSources: typescript.length,
    bridgeSources: bridgePaths.length,
    executableJavaScriptSources: 0,
    bridgePaths: bridgePaths.sort(),
    waiverCount: countWaivers(sources.filter((_, index) => files[index].extension === '.ts')),
  };
}

async function main(): Promise<void> {
  const summary = await auditSource(process.cwd());
  process.stdout.write(`${JSON.stringify(summary, null, 2)}\n`);
}

if (posixPath(process.argv[1] ?? '').endsWith('/lp9-source-audit.ts')) await main();

export { canonicalPathForBridge, validateBridgeText };
