import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { CursorInstall, validateCursorRoot } from './cursorLocator';
import { loadWorkbenchPatchData, WorkbenchPatchRule, WorkbenchPatchRuntimePolicy } from './patchMap';
import { createScopedProgress, ProgressCallback, reportProgress, toPercent, yieldToEventLoop } from './progress';

const metadataKey = 'cursorZhCn.workbenchPatchMetadata';
const backupFilePrefix = 'workbench.desktop.main.js.cursor-zh-cn-pack.';

export type PatchState = 'not-applied' | 'applied' | 'partial' | 'unknown';
export type PatchBackupKind = 'original' | 'before-restore' | 'before-uninstall' | 'unknown';

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
  readonly uninstalledAt?: string;
  readonly uninstallSafetyBackupPath?: string;
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

export interface PatchUnapplyResult {
  readonly changed: boolean;
  readonly safetyBackupPath?: string;
  readonly unappliedRuleIds: readonly string[];
  readonly before: PatchScanResult;
  readonly after: PatchScanResult;
}

export interface PatchRestoreResult {
  readonly restored: boolean;
  readonly backupPath: string;
  readonly safetyBackupPath: string;
  readonly after: PatchScanResult;
}

export async function scanWorkbenchPatch(root: string, context: vscode.ExtensionContext, progress?: ProgressCallback): Promise<PatchScanResult> {
  const install = await validateCursorRoot(root, '补丁扫描', createScopedProgress(progress, 0, 15, '校验安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const patchData = await loadWorkbenchPatchData(createScopedProgress(progress, 15, 35, '加载补丁数据'));
  const result = await scanInstallPatch(install, context, patchData.rules, createScopedProgress(progress, 35, 99, '扫描补丁状态'));
  await reportProgress(progress, {
    message: `扫描完成，命中 ${result.matchedRules}/${result.totalRules} 条规则`,
    percent: 100,
    current: result.matchedRules,
    total: result.totalRules
  });
  return result;
}

export async function applyWorkbenchPatch(root: string, context: vscode.ExtensionContext, progress?: ProgressCallback): Promise<PatchApplyResult> {
  const install = await validateCursorRoot(root, '补丁应用', createScopedProgress(progress, 0, 5, '校验安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const patchData = await loadWorkbenchPatchData(createScopedProgress(progress, 5, 15, '加载补丁数据'));
  const before = await scanInstallPatch(install, context, patchData.rules, createScopedProgress(progress, 15, 35, '扫描当前状态'));
  if (before.state === 'applied') {
    await reportProgress(progress, {
      message: '补丁已处于应用状态',
      percent: 100,
      current: before.totalRules,
      total: before.totalRules
    });
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

  await reportProgress(progress, { message: '读取 workbench 文件', percent: 38 });
  const originalContent = await fs.readFile(install.workbenchPath, 'utf8');
  const originalHash = sha256(originalContent);

  await reportProgress(progress, { message: '创建或复用原始备份', percent: 42 });
  const backupPath = await ensureBackup(install, originalContent, context);
  let patchedContent = originalContent;
  let appliedOccurrences = 0;
  const appliedRuleIds: string[] = [];
  const rules = patchData.rules;

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const occurrences = countOccurrences(patchedContent, rule.source);
    if (occurrences > 0) {
      patchedContent = replaceAll(patchedContent, rule.source, rule.target);
      appliedOccurrences += occurrences;
      appliedRuleIds.push(rule.id);
    }

    if ((index + 1) % 10 === 0 || index + 1 === rules.length) {
      await reportProgress(progress, {
        message: `应用补丁规则 ${index + 1}/${rules.length}`,
        percent: 45 + toPercent(index + 1, rules.length) * 0.3,
        current: index + 1,
        total: rules.length
      });
      await yieldToEventLoop();
    }
  }

  if (patchedContent === originalContent) {
    const after = await scanInstallPatch(install, context, rules, createScopedProgress(progress, 80, 99, '复扫补丁状态'));
    await reportProgress(progress, {
      message: '补丁未写入：没有需要替换的内容',
      percent: 100,
      current: rules.length,
      total: rules.length
    });
    return {
      changed: false,
      backupPath,
      appliedRuleIds,
      before,
      after
    };
  }

  await assertRuntimePatchIsSafe(originalContent, patchedContent, appliedRuleIds, appliedOccurrences, patchData.runtimePolicy, createScopedProgress(progress, 76, 84, '校验运行时安全'));

  await reportProgress(progress, { message: '写入补丁文件', percent: 86, current: rules.length, total: rules.length });
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
  await reportProgress(progress, { message: '保存补丁元数据', percent: 90, current: rules.length, total: rules.length });
  await context.globalState.update(metadataKey, metadata);

  const after = await scanInstallPatch(install, context, rules, createScopedProgress(progress, 92, 99, '复扫补丁状态'));
  await reportProgress(progress, {
    message: `补丁应用完成，处理 ${rules.length}/${rules.length} 条规则`,
    percent: 100,
    current: rules.length,
    total: rules.length
  });
  return {
    changed: true,
    backupPath,
    appliedRuleIds,
    before,
    after
  };
}

export async function unapplyWorkbenchPatch(root: string, context: vscode.ExtensionContext, progress?: ProgressCallback): Promise<PatchUnapplyResult> {
  const install = await validateCursorRoot(root, '补丁卸载', createScopedProgress(progress, 0, 5, '校验安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const patchData = await loadWorkbenchPatchData(createScopedProgress(progress, 5, 15, '加载补丁数据'));
  const before = await scanInstallPatch(install, context, patchData.rules, createScopedProgress(progress, 15, 35, '扫描当前状态'));
  if (before.targetHits === 0) {
    await reportProgress(progress, {
      message: '未检测到已应用的中文补丁',
      percent: 100,
      current: before.totalRules,
      total: before.totalRules
    });
    return {
      changed: false,
      unappliedRuleIds: [],
      before,
      after: before
    };
  }

  await reportProgress(progress, { message: '读取 workbench 文件', percent: 40 });
  const currentContent = await fs.readFile(install.workbenchPath, 'utf8');
  let restoredContent = currentContent;
  let unappliedOccurrences = 0;
  const unappliedRuleIds: string[] = [];
  const rules = patchData.rules;

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const occurrences = countOccurrences(restoredContent, rule.target);
    if (occurrences > 0) {
      restoredContent = replaceAll(restoredContent, rule.target, rule.source);
      unappliedOccurrences += occurrences;
      unappliedRuleIds.push(rule.id);
    }

    if ((index + 1) % 10 === 0 || index + 1 === rules.length) {
      await reportProgress(progress, {
        message: `卸载补丁规则 ${index + 1}/${rules.length}`,
        percent: 45 + toPercent(index + 1, rules.length) * 0.3,
        current: index + 1,
        total: rules.length
      });
      await yieldToEventLoop();
    }
  }

  if (restoredContent === currentContent) {
    const after = await scanInstallPatch(install, context, rules, createScopedProgress(progress, 80, 99, '复扫补丁状态'));
    await reportProgress(progress, {
      message: '补丁未卸载：没有需要还原的内容',
      percent: 100,
      current: rules.length,
      total: rules.length
    });
    return {
      changed: false,
      unappliedRuleIds,
      before,
      after
    };
  }

  await assertRuntimePatchIsSafe(restoredContent, currentContent, unappliedRuleIds, unappliedOccurrences, patchData.runtimePolicy, createScopedProgress(progress, 76, 84, '校验运行时安全'));

  const safetyBackupPath = backupPathFor(install, 'before-uninstall');
  await reportProgress(progress, { message: '保存卸载前快照', percent: 86, current: rules.length, total: rules.length });
  await fs.writeFile(safetyBackupPath, currentContent, 'utf8');
  await reportProgress(progress, { message: '写入还原后的 workbench 文件', percent: 90, current: rules.length, total: rules.length });
  await fs.writeFile(install.workbenchPath, restoredContent, 'utf8');

  const metadata = getPatchMetadata(context);
  if (metadata) {
    const updatedMetadata: PatchMetadata = {
      ...metadata,
      uninstalledAt: new Date().toISOString(),
      uninstallSafetyBackupPath: safetyBackupPath
    };
    await context.globalState.update(metadataKey, updatedMetadata);
  }

  const after = await scanInstallPatch(install, context, rules, createScopedProgress(progress, 92, 99, '复扫补丁状态'));
  await reportProgress(progress, {
    message: `补丁卸载完成，处理 ${rules.length}/${rules.length} 条规则`,
    percent: 100,
    current: rules.length,
    total: rules.length
  });
  return {
    changed: true,
    safetyBackupPath,
    unappliedRuleIds,
    before,
    after
  };
}

export async function restoreWorkbenchBackup(root: string, context: vscode.ExtensionContext, backupPath?: string, progress?: ProgressCallback): Promise<PatchRestoreResult> {
  const install = await validateCursorRoot(root, '补丁恢复', createScopedProgress(progress, 0, 8, '校验安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const patchData = await loadWorkbenchPatchData(createScopedProgress(progress, 8, 15, '加载补丁数据'));
  const metadata = getPatchMetadata(context);
  const backups = await scanBackupFiles(install, context, patchData.rules, createScopedProgress(progress, 15, 45, '扫描备份'));
  const selectedBackup = backupPath
    ? backups.find(backup => samePath(backup.path, backupPath))
    : backups.find(backup => metadata?.backupPath && samePath(backup.path, metadata.backupPath));

  if (!selectedBackup) {
    throw new Error(backupPath ? `所选备份文件不在当前 Cursor 安装的备份列表中: ${backupPath}` : '没有选择可恢复的补丁备份。');
  }

  await reportProgress(progress, { message: '校验备份文件', percent: 50, current: 1, total: 1 });
  await assertFile(selectedBackup.path, '备份文件不存在');

  await reportProgress(progress, { message: '读取当前 workbench 文件', percent: 58, current: 1, total: 1 });
  const currentContent = await fs.readFile(install.workbenchPath, 'utf8');
  const safetyBackupPath = backupPathFor(install, 'before-restore');
  await reportProgress(progress, { message: '保存恢复前快照', percent: 68, current: 1, total: 1 });
  await fs.writeFile(safetyBackupPath, currentContent, 'utf8');

  await reportProgress(progress, { message: '读取备份内容', percent: 78, current: 1, total: 1 });
  const backupContent = await fs.readFile(selectedBackup.path, 'utf8');
  await reportProgress(progress, { message: '写入备份内容', percent: 88, current: 1, total: 1 });
  await fs.writeFile(install.workbenchPath, backupContent, 'utf8');

  if (metadata) {
    const updatedMetadata: PatchMetadata = {
      ...metadata,
      restoredAt: new Date().toISOString(),
      restoreSafetyBackupPath: safetyBackupPath
    };
    await context.globalState.update(metadataKey, updatedMetadata);
  }

  const after = await scanInstallPatch(install, context, patchData.rules, createScopedProgress(progress, 92, 99, '复扫补丁状态'));
  await reportProgress(progress, { message: '备份恢复完成', percent: 100, current: 1, total: 1 });
  return {
    restored: true,
    backupPath: selectedBackup.path,
    safetyBackupPath,
    after
  };
}

export function getPatchMetadata(context: vscode.ExtensionContext): PatchMetadata | undefined {
  return context.globalState.get<PatchMetadata>(metadataKey);
}

async function scanInstallPatch(
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  progress?: ProgressCallback
): Promise<PatchScanResult> {
  await reportProgress(progress, { message: '读取 workbench 文件', percent: 5 });
  const content = await fs.readFile(install.workbenchPath, 'utf8');
  const ruleStatuses = await getPatchRuleStatuses(content, rules, createScopedProgress(progress, 15, 75, '扫描规则'));
  const status = getPatchStatusFromRules(ruleStatuses);
  const metadata = getPatchMetadata(context);
  const backups = await scanBackupFiles(install, context, rules, createScopedProgress(progress, 80, 98, '扫描备份'));

  await reportProgress(progress, {
    message: `补丁状态扫描完成，命中 ${status.matchedRules}/${rules.length} 条规则`,
    percent: 100,
    current: status.matchedRules,
    total: rules.length
  });
  return {
    state: status.state,
    filePath: install.workbenchPath,
    cursorRoot: install.root,
    cursorVersion: install.version,
    currentHash: sha256(content),
    backupPath: metadata?.backupPath,
    backups,
    totalRules: rules.length,
    sourceHits: status.sourceHits,
    targetHits: status.targetHits,
    matchedRules: status.matchedRules,
    rules: ruleStatuses
  };
}

async function scanBackupFiles(
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  progress?: ProgressCallback
): Promise<PatchBackupInfo[]> {
  const directory = path.dirname(install.workbenchPath);
  const metadata = getPatchMetadata(context);
  let entries: string[];

  await reportProgress(progress, { message: '读取备份目录', percent: 0 });
  try {
    entries = await fs.readdir(directory);
  } catch {
    await reportProgress(progress, { message: '备份目录不可读取', percent: 100, current: 0, total: 0 });
    return [];
  }

  const names = entries.filter(name => name.startsWith(backupFilePrefix));
  const backups: PatchBackupInfo[] = [];
  if (names.length === 0) {
    await reportProgress(progress, { message: '未发现备份文件', percent: 100, current: 0, total: 0 });
    return [];
  }

  for (let index = 0; index < names.length; index += 1) {
    const backup = await readPatchBackupInfo(directory, names[index], metadata, rules);
    if (backup) {
      backups.push(backup);
    }

    await reportProgress(progress, {
      message: `扫描备份文件 ${index + 1}/${names.length}`,
      percent: toPercent(index + 1, names.length),
      current: index + 1,
      total: names.length
    });
    await yieldToEventLoop();
  }

  return backups.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
}

async function readPatchBackupInfo(
  directory: string,
  name: string,
  metadata: PatchMetadata | undefined,
  rules: readonly WorkbenchPatchRule[]
): Promise<PatchBackupInfo | undefined> {
  const filePath = path.join(directory, name);

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return undefined;
    }

    const content = await fs.readFile(filePath, 'utf8');
    const status = await getPatchContentStatus(content, rules);
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

  if (name.startsWith(`${backupFilePrefix}before-uninstall.`)) {
    return 'before-uninstall';
  }

  return 'unknown';
}

async function getPatchContentStatus(content: string, rules: readonly WorkbenchPatchRule[]): Promise<PatchBackupStatus> {
  return getPatchStatusFromRules(await getPatchRuleStatuses(content, rules));
}

async function getPatchRuleStatuses(content: string, rules: readonly WorkbenchPatchRule[], progress?: ProgressCallback): Promise<PatchRuleStatus[]> {
  const statuses: PatchRuleStatus[] = [];
  await reportProgress(progress, { message: '开始扫描补丁规则', percent: 0, current: 0, total: rules.length });

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    statuses.push({
      id: rule.id,
      sourceHits: countOccurrences(content, rule.source),
      targetHits: countOccurrences(content, rule.target)
    });

    if ((index + 1) % 10 === 0 || index + 1 === rules.length) {
      await reportProgress(progress, {
        message: `扫描补丁规则 ${index + 1}/${rules.length}`,
        percent: toPercent(index + 1, rules.length),
        current: index + 1,
        total: rules.length
      });
      await yieldToEventLoop();
    }
  }

  return statuses;
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

function backupPathFor(install: CursorInstall, kind: 'bak' | 'before-restore' | 'before-uninstall'): string {
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

async function assertRuntimePatchIsSafe(
  originalContent: string,
  patchedContent: string,
  appliedRuleIds: readonly string[],
  appliedOccurrences: number,
  policy: WorkbenchPatchRuntimePolicy,
  progress?: ProgressCallback
): Promise<void> {
  if (appliedOccurrences > policy.maxRuntimePatchRuleHits) {
    throw new Error(`补丁命中 ${appliedOccurrences} 处，超过运行时安全阈值 ${policy.maxRuntimePatchRuleHits}，已取消写入。`);
  }

  await reportProgress(progress, { message: '计算变更行数', percent: 30, current: 1, total: 3 });
  const changedLines = countChangedLines(originalContent, patchedContent);
  if (changedLines > policy.maxRuntimePatchChangedLines) {
    throw new Error(`补丁将修改 ${changedLines} 行，超过运行时安全阈值 ${policy.maxRuntimePatchChangedLines}，已取消写入。`);
  }

  for (let index = 0; index < policy.guardedRuntimeNeedles.length; index += 1) {
    const needle = policy.guardedRuntimeNeedles[index];
    const before = countOccurrences(originalContent, needle);
    const after = countOccurrences(patchedContent, needle);
    if (before !== after) {
      throw new Error(`补丁触及受保护运行时关键字 ${needle}，已取消写入。`);
    }

    await reportProgress(progress, {
      message: `校验受保护关键字 ${index + 1}/${policy.guardedRuntimeNeedles.length}`,
      percent: 30 + toPercent(index + 1, policy.guardedRuntimeNeedles.length) * 0.7,
      current: index + 1,
      total: policy.guardedRuntimeNeedles.length
    });
    await yieldToEventLoop();
  }

  void appliedRuleIds;
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