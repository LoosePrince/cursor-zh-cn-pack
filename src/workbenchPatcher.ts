import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { CursorInstall, validateCursorRoot } from './cursorLocator';
import { workbenchPatchRules, workbenchPatchRuntimePolicy } from './patchMap';

const metadataKey = 'cursorZhCn.workbenchPatchMetadata';

export type PatchState = 'not-applied' | 'applied' | 'partial' | 'unknown';

export interface PatchRuleStatus {
  readonly id: string;
  readonly sourceHits: number;
  readonly targetHits: number;
}

export interface PatchMetadata {
  readonly cursorRoot: string;
  readonly cursorVersion?: string;
  readonly workbenchPath: string;
  readonly originalHash: string;
  readonly patchedHash: string;
  readonly backupPath: string;
  readonly appliedRuleIds: readonly string[];
  readonly appliedAt: string;
  readonly restoredAt?: string;
  readonly restoreSafetyBackupPath?: string;
}

export interface PatchScanResult {
  readonly state: PatchState;
  readonly filePath: string;
  readonly cursorRoot: string;
  readonly cursorVersion?: string;
  readonly currentHash: string;
  readonly backupPath?: string;
  readonly totalRules: number;
  readonly sourceHits: number;
  readonly targetHits: number;
  readonly matchedRules: number;
  readonly rules: readonly PatchRuleStatus[];
}

export interface PatchApplyResult {
  readonly changed: boolean;
  readonly backupPath?: string;
  readonly appliedRuleIds: readonly string[];
  readonly before: PatchScanResult;
  readonly after: PatchScanResult;
}

export interface PatchRestoreResult {
  readonly restored: boolean;
  readonly backupPath: string;
  readonly safetyBackupPath: string;
  readonly after: PatchScanResult;
}

export async function scanWorkbenchPatch(root: string, context: vscode.ExtensionContext): Promise<PatchScanResult> {
  const install = await validateCursorRoot(root, '补丁扫描');
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  return scanInstallPatch(install, context);
}

export async function applyWorkbenchPatch(root: string, context: vscode.ExtensionContext): Promise<PatchApplyResult> {
  const install = await validateCursorRoot(root, '补丁应用');
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const before = await scanInstallPatch(install, context);
  if (before.state === 'applied') {
    return {
      changed: false,
      backupPath: before.backupPath,
      appliedRuleIds: [],
      before,
      after: before
    };
  }

  if (before.sourceHits === 0 && before.targetHits === 0) {
    throw new Error('当前 workbench 文件中没有命中可补丁的英文源文案，也没有命中已补丁中文文案。请确认 Cursor 版本是否已变化。');
  }

  const originalContent = await fs.readFile(install.workbenchPath, 'utf8');
  const originalHash = sha256(originalContent);
  const backupPath = await ensureBackup(install, originalContent, context);
  let patchedContent = originalContent;
  let appliedOccurrences = 0;
  const appliedRuleIds: string[] = [];

  for (const rule of workbenchPatchRules) {
    const occurrences = countOccurrences(patchedContent, rule.source);
    if (occurrences > 0) {
      patchedContent = replaceAll(patchedContent, rule.source, rule.target);
      appliedOccurrences += occurrences;
      appliedRuleIds.push(rule.id);
    }
  }

  if (patchedContent === originalContent) {
    const after = await scanInstallPatch(install, context);
    return {
      changed: false,
      backupPath,
      appliedRuleIds,
      before,
      after
    };
  }

  assertRuntimePatchIsSafe(originalContent, patchedContent, appliedRuleIds, appliedOccurrences);

  await fs.writeFile(install.workbenchPath, patchedContent, 'utf8');
  const patchedHash = sha256(patchedContent);

  const metadata: PatchMetadata = {
    cursorRoot: install.root,
    cursorVersion: install.version,
    workbenchPath: install.workbenchPath,
    originalHash,
    patchedHash,
    backupPath,
    appliedRuleIds,
    appliedAt: new Date().toISOString()
  };
  await context.globalState.update(metadataKey, metadata);

  return {
    changed: true,
    backupPath,
    appliedRuleIds,
    before,
    after: await scanInstallPatch(install, context)
  };
}

export async function restoreWorkbenchBackup(root: string, context: vscode.ExtensionContext): Promise<PatchRestoreResult> {
  const metadata = getPatchMetadata(context);
  if (!metadata?.backupPath) {
    throw new Error('没有找到可恢复的补丁备份记录。');
  }

  await assertFile(metadata.backupPath, '备份文件不存在');
  const install = await validateCursorRoot(root, '补丁恢复');
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const currentContent = await fs.readFile(install.workbenchPath, 'utf8');
  const safetyBackupPath = backupPathFor(install, 'before-restore');
  await fs.writeFile(safetyBackupPath, currentContent, 'utf8');

  const backupContent = await fs.readFile(metadata.backupPath, 'utf8');
  await fs.writeFile(install.workbenchPath, backupContent, 'utf8');

  const updatedMetadata: PatchMetadata = {
    ...metadata,
    restoredAt: new Date().toISOString(),
    restoreSafetyBackupPath: safetyBackupPath
  };
  await context.globalState.update(metadataKey, updatedMetadata);

  return {
    restored: true,
    backupPath: metadata.backupPath,
    safetyBackupPath,
    after: await scanInstallPatch(install, context)
  };
}

export function getPatchMetadata(context: vscode.ExtensionContext): PatchMetadata | undefined {
  return context.globalState.get<PatchMetadata>(metadataKey);
}

async function scanInstallPatch(install: CursorInstall, context: vscode.ExtensionContext): Promise<PatchScanResult> {
  const content = await fs.readFile(install.workbenchPath, 'utf8');
  const rules = workbenchPatchRules.map(rule => ({
    id: rule.id,
    sourceHits: countOccurrences(content, rule.source),
    targetHits: countOccurrences(content, rule.target)
  }));
  const sourceHits = rules.reduce((sum, rule) => sum + rule.sourceHits, 0);
  const targetHits = rules.reduce((sum, rule) => sum + rule.targetHits, 0);
  const matchedRules = rules.filter(rule => rule.sourceHits > 0 || rule.targetHits > 0).length;
  const metadata = getPatchMetadata(context);

  return {
    state: getPatchState(sourceHits, targetHits, matchedRules),
    filePath: install.workbenchPath,
    cursorRoot: install.root,
    cursorVersion: install.version,
    currentHash: sha256(content),
    backupPath: metadata?.backupPath,
    totalRules: workbenchPatchRules.length,
    sourceHits,
    targetHits,
    matchedRules,
    rules
  };
}

async function ensureBackup(install: CursorInstall, content: string, context: vscode.ExtensionContext): Promise<string> {
  const metadata = getPatchMetadata(context);
  if (metadata?.backupPath && await fileExists(metadata.backupPath)) {
    return metadata.backupPath;
  }

  const backupPath = backupPathFor(install, 'bak');
  await fs.writeFile(backupPath, content, 'utf8');
  return backupPath;
}

function backupPathFor(install: CursorInstall, kind: 'bak' | 'before-restore'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const version = install.version ?? 'unknown';
  return path.join(path.dirname(install.workbenchPath), `workbench.desktop.main.js.cursor-zh-cn-pack.${kind}.${version}.${timestamp}`);
}

function getPatchState(sourceHits: number, targetHits: number, matchedRules: number): PatchState {
  if (targetHits > 0 && sourceHits === 0) {
    return 'applied';
  }

  if (targetHits > 0 && sourceHits > 0) {
    return 'partial';
  }

  if (sourceHits > 0) {
    return 'not-applied';
  }

  return matchedRules > 0 ? 'partial' : 'unknown';
}

function assertRuntimePatchIsSafe(originalContent: string, patchedContent: string, appliedRuleIds: readonly string[], appliedOccurrences: number): void {
  const policy = workbenchPatchRuntimePolicy;
  if (appliedOccurrences > policy.maxRuntimePatchRuleHits) {
    throw new Error(`补丁命中 ${appliedOccurrences} 处，超过运行时安全阈值 ${policy.maxRuntimePatchRuleHits}，已取消写入。`);
  }

  const changedLines = countChangedLines(originalContent, patchedContent);
  if (changedLines > policy.maxRuntimePatchChangedLines) {
    throw new Error(`补丁将修改 ${changedLines} 行，超过运行时安全阈值 ${policy.maxRuntimePatchChangedLines}，已取消写入。`);
  }

  for (const needle of policy.guardedRuntimeNeedles) {
    const before = countOccurrences(originalContent, needle);
    const after = countOccurrences(patchedContent, needle);
    if (before !== after) {
      throw new Error(`补丁触及受保护运行时关键字 ${needle}，已取消写入。`);
    }
  }
}

function countChangedLines(before: string, after: string): number {
  const beforeLines = before.split(/\r?\n/g);
  const afterLines = after.split(/\r?\n/g);
  const length = Math.max(beforeLines.length, afterLines.length);
  let changed = 0;

  for (let index = 0; index < length; index += 1) {
    if ((beforeLines[index] ?? '') !== (afterLines[index] ?? '')) {
      changed += 1;
    }
  }

  return changed;
}

function replaceAll(value: string, source: string, target: string): string {
  return value.split(source).join(target);
}

function countOccurrences(value: string, needle: string): number {
  if (!needle) {
    return 0;
  }

  return value.split(needle).length - 1;
}

function sha256(value: string): string {
  return crypto.createHash('sha256').update(value, 'utf8').digest('hex');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function assertFile(filePath: string, message: string): Promise<void> {
  if (!await fileExists(filePath)) {
    throw new Error(`${message}: ${filePath}`);
  }
}