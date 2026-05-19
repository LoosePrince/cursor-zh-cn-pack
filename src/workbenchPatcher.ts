import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { CursorInstall, validateCursorRoot } from './cursorLocator';
import { workbenchPatchRules, workbenchPatchRuntimePolicy } from './patchMap';

const metadataKey = 'cursorZhCn.workbenchPatchMetadata';
const backupFilePrefix = 'workbench.desktop.main.js.cursor-zh-cn-pack.';

export type PatchState = 'not-applied' | 'applied' | 'partial' | 'unknown';
export type PatchBackupKind = 'original' | 'before-restore' | 'unknown';

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

export interface PatchBackupStatus {
  readonly state: PatchState;
  readonly sourceHits: number;
  readonly targetHits: number;
  readonly matchedRules: number;
}

export interface PatchBackupInfo {
  readonly path: string;
  readonly name: string;
  readonly kind: PatchBackupKind;
  readonly isOriginal: boolean;
  readonly currentMetadataBackup: boolean;
  readonly hash: string;
  readonly size: number;
  readonly modifiedAt: string;
  readonly status: PatchBackupStatus;
}

export interface PatchScanResult {
  readonly state: PatchState;
  readonly filePath: string;
  readonly cursorRoot: string;
  readonly cursorVersion?: string;
  readonly currentHash: string;
  readonly backupPath?: string;
  readonly backups: readonly PatchBackupInfo[];
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

export async function restoreWorkbenchBackup(root: string, context: vscode.ExtensionContext, backupPath?: string): Promise<PatchRestoreResult> {
  const install = await validateCursorRoot(root, '补丁恢复');
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const metadata = getPatchMetadata(context);
  const backups = await scanBackupFiles(install, context);
  const selectedBackup = backupPath
    ? backups.find(backup => samePath(backup.path, backupPath))
    : backups.find(backup => metadata?.backupPath && samePath(backup.path, metadata.backupPath));

  if (!selectedBackup) {
    throw new Error(backupPath ? `所选备份文件不在当前 Cursor 安装的备份列表中: ${backupPath}` : '没有选择可恢复的补丁备份。');
  }

  await assertFile(selectedBackup.path, '备份文件不存在');

  const currentContent = await fs.readFile(install.workbenchPath, 'utf8');
  const safetyBackupPath = backupPathFor(install, 'before-restore');
  await fs.writeFile(safetyBackupPath, currentContent, 'utf8');

  const backupContent = await fs.readFile(selectedBackup.path, 'utf8');
  await fs.writeFile(install.workbenchPath, backupContent, 'utf8');

  if (metadata) {
    const updatedMetadata: PatchMetadata = {
      ...metadata,
      restoredAt: new Date().toISOString(),
      restoreSafetyBackupPath: safetyBackupPath
    };
    await context.globalState.update(metadataKey, updatedMetadata);
  }

  return {
    restored: true,
    backupPath: selectedBackup.path,
    safetyBackupPath,
    after: await scanInstallPatch(install, context)
  };
}

export function getPatchMetadata(context: vscode.ExtensionContext): PatchMetadata | undefined {
  return context.globalState.get<PatchMetadata>(metadataKey);
}

async function scanInstallPatch(install: CursorInstall, context: vscode.ExtensionContext): Promise<PatchScanResult> {
  const content = await fs.readFile(install.workbenchPath, 'utf8');
  const rules = getPatchRuleStatuses(content);
  const status = getPatchStatusFromRules(rules);
  const metadata = getPatchMetadata(context);

  return {
    state: status.state,
    filePath: install.workbenchPath,
    cursorRoot: install.root,
    cursorVersion: install.version,
    currentHash: sha256(content),
    backupPath: metadata?.backupPath,
    backups: await scanBackupFiles(install, context),
    totalRules: workbenchPatchRules.length,
    sourceHits: status.sourceHits,
    targetHits: status.targetHits,
    matchedRules: status.matchedRules,
    rules
  };
}

async function scanBackupFiles(install: CursorInstall, context: vscode.ExtensionContext): Promise<PatchBackupInfo[]> {
  const directory = path.dirname(install.workbenchPath);
  const metadata = getPatchMetadata(context);
  let entries: string[];

  try {
    entries = await fs.readdir(directory);
  } catch {
    return [];
  }

  const backups = await Promise.all(entries
    .filter(name => name.startsWith(backupFilePrefix))
    .map(async name => readPatchBackupInfo(directory, name, metadata)));

  return backups
    .filter((backup): backup is PatchBackupInfo => backup !== undefined)
    .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
}

async function readPatchBackupInfo(directory: string, name: string, metadata: PatchMetadata | undefined): Promise<PatchBackupInfo | undefined> {
  const filePath = path.join(directory, name);

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return undefined;
    }

    const content = await fs.readFile(filePath, 'utf8');
    const status = getPatchContentStatus(content);
    const kind = getPatchBackupKind(name);

    return {
      path: filePath,
      name,
      kind,
      isOriginal: kind === 'original' && status.state === 'not-applied',
      currentMetadataBackup: metadata?.backupPath ? samePath(filePath, metadata.backupPath) : false,
      hash: sha256(content),
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      status
    };
  } catch {
    return undefined;
  }
}

function getPatchBackupKind(name: string): PatchBackupKind {
  if (name.startsWith(`${backupFilePrefix}bak.`)) {
    return 'original';
  }

  if (name.startsWith(`${backupFilePrefix}before-restore.`)) {
    return 'before-restore';
  }

  return 'unknown';
}

function getPatchContentStatus(content: string): PatchBackupStatus {
  return getPatchStatusFromRules(getPatchRuleStatuses(content));
}

function getPatchRuleStatuses(content: string): PatchRuleStatus[] {
  return workbenchPatchRules.map(rule => ({
    id: rule.id,
    sourceHits: countOccurrences(content, rule.source),
    targetHits: countOccurrences(content, rule.target)
  }));
}

function getPatchStatusFromRules(rules: readonly PatchRuleStatus[]): PatchBackupStatus {
  const sourceHits = rules.reduce((sum, rule) => sum + rule.sourceHits, 0);
  const targetHits = rules.reduce((sum, rule) => sum + rule.targetHits, 0);
  const matchedRules = rules.filter(rule => rule.sourceHits > 0 || rule.targetHits > 0).length;

  return {
    state: getPatchState(sourceHits, targetHits, matchedRules),
    sourceHits,
    targetHits,
    matchedRules
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
  return path.join(path.dirname(install.workbenchPath), `${backupFilePrefix}${kind}.${version}.${timestamp}`);
}

function samePath(left: string, right: string): boolean {
  const normalizedLeft = path.resolve(left);
  const normalizedRight = path.resolve(right);

  return process.platform === 'win32'
    ? normalizedLeft.toLowerCase() === normalizedRight.toLowerCase()
    : normalizedLeft === normalizedRight;
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