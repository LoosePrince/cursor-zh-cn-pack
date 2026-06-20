import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { CursorInstall, validateCursorRoot } from './cursorLocator';
import { loadWorkbenchPatchData, WorkbenchPatchRule, WorkbenchPatchRuntimePolicy } from './patchMap';
import { createScopedProgress, ProgressCallback, reportProgress, toPercent, yieldToEventLoop } from './progress';
import { assertBraceBalanceUnchanged, measureBraceBalance } from './braceBalance';
import { countOccurrences, replaceAllWithCount } from './stringPatchUtils';

const metadataKey = 'cursorZhCn.workbenchPatchMetadata';
const desktopBackupFilePrefix = 'workbench.desktop.main.js.cursor-zh-cn-pack.';
const glassBackupFilePrefix = 'workbench.glass.main.js.cursor-zh-cn-pack.';
const backupFilePrefixes = [desktopBackupFilePrefix, glassBackupFilePrefix] as const;

type WorkbenchPatchTargetId = 'desktop' | 'glass';

interface WorkbenchPatchTarget {
  readonly id: WorkbenchPatchTargetId;
  readonly filePath: string;
  readonly backupFilePrefix: string;
  readonly label: string;
}

interface PatchTargetRecord {
  readonly id: WorkbenchPatchTargetId;
  readonly filePath: string;
  readonly originalHash: string;
  readonly patchedHash: string;
  readonly backupPath: string;
}

interface RuleScanCacheEntry {
  readonly contentHash: string;
  readonly ruleFingerprint: string;
  readonly statuses: readonly PatchRuleStatus[];
}

let cachedRuleScan: RuleScanCacheEntry | undefined;

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
  readonly targets?: readonly PatchTargetRecord[];
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
  readonly appliedOccurrences: number;
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
  const result = await scanInstallPatch(
    install,
    context,
    patchData.rules,
    createScopedProgress(progress, 35, 99, '扫描补丁状态'),
    undefined,
    { scanBackupRuleStatus: false }
  );
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
  const targets = await filterExistingPatchTargets(resolveWorkbenchPatchTargets(install));
  if (targets.length === 0) {
    throw new Error('未找到可补丁的 workbench 文件。');
  }

  const before = await scanInstallPatch(
    install,
    context,
    patchData.rules,
    createScopedProgress(progress, 20, 35, '扫描当前状态'),
    undefined,
    { scanBackupRuleStatus: false }
  );
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
      appliedOccurrences: 0,
      before,
      after: before
    };
  }

  if (before.sourceHits === 0 && before.targetHits === 0) {
    throw new Error('当前 workbench 文件中没有命中可补丁的英文源文案，也没有命中已补丁中文文案。请确认 Cursor 版本是否已变化。');
  }

  const rules = patchData.rules;
  const targetRecords: PatchTargetRecord[] = [];
  let changed = false;
  let totalAppliedOccurrences = 0;
  const appliedRuleIds = new Set<string>();
  let primaryBackupPath: string | undefined;

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    const targetProgress = createScopedProgress(
      progress,
      35 + toPercent(targetIndex, targets.length) * 55,
      35 + toPercent(targetIndex + 1, targets.length) * 55,
      `补丁 ${target.label}`
    );
    const result = await applyPatchToTarget(
      target,
      install,
      context,
      rules,
      patchData.runtimePolicy,
      targetProgress
    );

    if (result.changed) {
      changed = true;
      totalAppliedOccurrences += result.appliedOccurrences;
      for (const ruleId of result.appliedRuleIds) {
        appliedRuleIds.add(ruleId);
      }
    }

    targetRecords.push(result.record);
    if (!primaryBackupPath && result.record.backupPath) {
      primaryBackupPath = result.record.backupPath;
    }
  }

  const desktopRecord = targetRecords.find(record => record.id === 'desktop');
  const metadata: PatchMetadata = {
    cursorRoot: install.root,
    cursorVersion: install.version,
    workbenchPath: install.workbenchPath,
    originalHash: desktopRecord?.originalHash ?? targetRecords[0]?.originalHash ?? '',
    patchedHash: desktopRecord?.patchedHash ?? targetRecords[0]?.patchedHash ?? '',
    backupPath: desktopRecord?.backupPath ?? targetRecords[0]?.backupPath ?? '',
    targets: targetRecords,
    appliedRuleIds: [...appliedRuleIds],
    appliedAt: new Date().toISOString()
  };
  await reportProgress(progress, { message: '保存补丁元数据', percent: 92, current: rules.length, total: rules.length });
  await context.globalState.update(metadataKey, metadata);

  const after = await scanInstallPatch(
    install,
    context,
    rules,
    createScopedProgress(progress, 94, 99, '复扫补丁状态'),
    undefined,
    { scanBackupRuleStatus: false }
  );
  await reportProgress(progress, {
    message: `补丁应用完成，处理 ${appliedRuleIds.size}/${rules.length} 条规则`,
    percent: 100,
    current: rules.length,
    total: rules.length
  });
  return {
    changed,
    backupPath: primaryBackupPath,
    appliedRuleIds: [...appliedRuleIds],
    appliedOccurrences: totalAppliedOccurrences,
    before,
    after
  };
}

interface ApplyPatchToTargetResult {
  readonly changed: boolean;
  readonly appliedRuleIds: readonly string[];
  readonly appliedOccurrences: number;
  readonly record: PatchTargetRecord;
}

async function applyPatchToTarget(
  target: WorkbenchPatchTarget,
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  runtimePolicy: WorkbenchPatchRuntimePolicy,
  progress?: ProgressCallback
): Promise<ApplyPatchToTargetResult> {
  await reportProgress(progress, { message: `读取 ${target.label}`, percent: 5 });
  const originalContent = await fs.readFile(target.filePath, 'utf8');
  const originalHash = sha256(originalContent);

  await reportProgress(progress, { message: `创建或复用 ${target.label} 原始备份`, percent: 15 });
  const backupPath = await ensureBackup(target, install, originalContent, context);
  let patchedContent = originalContent;
  let appliedOccurrences = 0;
  const appliedRuleIds: string[] = [];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const replacement = replaceAllWithCount(patchedContent, rule.source, rule.target);
    if (replacement.count > 0) {
      patchedContent = replacement.value;
      appliedOccurrences += replacement.count;
      appliedRuleIds.push(rule.id);
    }

    if (shouldYieldPatchProgress(index + 1, rules.length, progress)) {
      await reportProgress(progress, {
        message: `应用 ${target.label} 规则 ${index + 1}/${rules.length}`,
        percent: 20 + toPercent(index + 1, rules.length) * 0.55,
        current: index + 1,
        total: rules.length
      });
      await yieldToEventLoop();
    }
  }

  if (patchedContent === originalContent) {
    return {
      changed: false,
      appliedRuleIds,
      appliedOccurrences,
      record: {
        id: target.id,
        filePath: target.filePath,
        originalHash,
        patchedHash: originalHash,
        backupPath
      }
    };
  }

  await assertRuntimePatchIsSafe(
    originalContent,
    patchedContent,
    appliedRuleIds,
    appliedOccurrences,
    runtimePolicy,
    rules.length,
    createScopedProgress(progress, 78, 86, `校验 ${target.label} 运行时安全`)
  );

  await reportProgress(progress, { message: `写入 ${target.label}`, percent: 90, current: rules.length, total: rules.length });
  await fs.writeFile(target.filePath, patchedContent, 'utf8');

  return {
    changed: true,
    appliedRuleIds,
    appliedOccurrences,
    record: {
      id: target.id,
      filePath: target.filePath,
      originalHash,
      patchedHash: sha256(patchedContent),
      backupPath
    }
  };
}

export async function unapplyWorkbenchPatch(root: string, context: vscode.ExtensionContext, progress?: ProgressCallback): Promise<PatchUnapplyResult> {
  const install = await validateCursorRoot(root, '补丁卸载', createScopedProgress(progress, 0, 5, '校验安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const patchData = await loadWorkbenchPatchData(createScopedProgress(progress, 5, 15, '加载补丁数据'));
  const targets = await filterExistingPatchTargets(resolveWorkbenchPatchTargets(install));
  const before = await scanInstallPatch(
    install,
    context,
    patchData.rules,
    createScopedProgress(progress, 20, 35, '扫描当前状态'),
    undefined,
    { scanBackupRuleStatus: false }
  );
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

  const rules = patchData.rules;
  let changed = false;
  let safetyBackupPath: string | undefined;
  const unappliedRuleIds = new Set<string>();

  for (let targetIndex = 0; targetIndex < targets.length; targetIndex += 1) {
    const target = targets[targetIndex];
    const targetProgress = createScopedProgress(
      progress,
      35 + toPercent(targetIndex, targets.length) * 55,
      35 + toPercent(targetIndex + 1, targets.length) * 55,
      `卸载 ${target.label}`
    );
    const result = await unapplyPatchFromTarget(target, install, rules, patchData.runtimePolicy, targetProgress);
    if (result.changed) {
      changed = true;
      safetyBackupPath = result.safetyBackupPath;
      for (const ruleId of result.unappliedRuleIds) {
        unappliedRuleIds.add(ruleId);
      }
    }
  }

  const metadata = getPatchMetadata(context);
  if (metadata && changed) {
    const updatedMetadata: PatchMetadata = {
      ...metadata,
      uninstalledAt: new Date().toISOString(),
      uninstallSafetyBackupPath: safetyBackupPath
    };
    await context.globalState.update(metadataKey, updatedMetadata);
  }

  const after = await scanInstallPatch(
    install,
    context,
    rules,
    createScopedProgress(progress, 92, 99, '复扫补丁状态'),
    undefined,
    { scanBackupRuleStatus: false }
  );
  await reportProgress(progress, {
    message: `补丁卸载完成，处理 ${unappliedRuleIds.size}/${rules.length} 条规则`,
    percent: 100,
    current: rules.length,
    total: rules.length
  });
  return {
    changed,
    safetyBackupPath,
    unappliedRuleIds: [...unappliedRuleIds],
    before,
    after
  };
}

interface UnapplyPatchFromTargetResult {
  readonly changed: boolean;
  readonly safetyBackupPath?: string;
  readonly unappliedRuleIds: readonly string[];
}

async function unapplyPatchFromTarget(
  target: WorkbenchPatchTarget,
  install: CursorInstall,
  rules: readonly WorkbenchPatchRule[],
  runtimePolicy: WorkbenchPatchRuntimePolicy,
  progress?: ProgressCallback
): Promise<UnapplyPatchFromTargetResult> {
  await reportProgress(progress, { message: `读取 ${target.label}`, percent: 5 });
  const currentContent = await fs.readFile(target.filePath, 'utf8');
  let restoredContent = currentContent;
  let unappliedOccurrences = 0;
  const unappliedRuleIds: string[] = [];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const replacement = replaceAllWithCount(restoredContent, rule.target, rule.source);
    if (replacement.count > 0) {
      restoredContent = replacement.value;
      unappliedOccurrences += replacement.count;
      unappliedRuleIds.push(rule.id);
    }

    if (shouldYieldPatchProgress(index + 1, rules.length, progress)) {
      await reportProgress(progress, {
        message: `卸载 ${target.label} 规则 ${index + 1}/${rules.length}`,
        percent: 20 + toPercent(index + 1, rules.length) * 0.55,
        current: index + 1,
        total: rules.length
      });
      await yieldToEventLoop();
    }
  }

  if (restoredContent === currentContent) {
    return { changed: false, unappliedRuleIds };
  }

  await assertRuntimePatchIsSafe(
    restoredContent,
    currentContent,
    unappliedRuleIds,
    unappliedOccurrences,
    runtimePolicy,
    rules.length,
    createScopedProgress(progress, 78, 86, `校验 ${target.label} 运行时安全`)
  );

  const safetyBackupPath = backupPathFor(target, install, 'before-uninstall');
  await reportProgress(progress, { message: `保存 ${target.label} 卸载前快照`, percent: 88 });
  await fs.writeFile(safetyBackupPath, currentContent, 'utf8');
  await reportProgress(progress, { message: `写入还原后的 ${target.label}`, percent: 94 });
  await fs.writeFile(target.filePath, restoredContent, 'utf8');

  return {
    changed: true,
    safetyBackupPath,
    unappliedRuleIds
  };
}

export async function restoreWorkbenchBackup(root: string, context: vscode.ExtensionContext, backupPath?: string, progress?: ProgressCallback): Promise<PatchRestoreResult> {
  const install = await validateCursorRoot(root, '补丁恢复', createScopedProgress(progress, 0, 8, '校验安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const patchData = await loadWorkbenchPatchData(createScopedProgress(progress, 8, 15, '加载补丁数据'));
  const metadata = getPatchMetadata(context);
  const backups = await scanAllBackupFiles(
    install,
    context,
    patchData.rules,
    metadata,
    createScopedProgress(progress, 15, 45, '扫描备份'),
    true
  );
  const selectedBackup = backupPath
    ? backups.find(backup => samePath(backup.path, backupPath))
    : backups.find(backup => metadata?.backupPath && samePath(backup.path, metadata.backupPath));

  if (!selectedBackup) {
    throw new Error(backupPath ? `所选备份文件不在当前 Cursor 安装的备份列表中: ${backupPath}` : '没有选择可恢复的补丁备份。');
  }

  const target = getPatchTargetFromBackupName(selectedBackup.name, install);
  if (!target) {
    throw new Error(`无法识别备份文件对应的目标: ${selectedBackup.name}`);
  }

  await reportProgress(progress, { message: '校验备份文件', percent: 50, current: 1, total: 1 });
  await assertFile(selectedBackup.path, '备份文件不存在');

  await reportProgress(progress, { message: `读取当前 ${target.label}`, percent: 58, current: 1, total: 1 });
  const currentContent = await fs.readFile(target.filePath, 'utf8');
  const safetyBackupPath = backupPathFor(target, install, 'before-restore');
  await reportProgress(progress, { message: '保存恢复前快照', percent: 68, current: 1, total: 1 });
  await fs.writeFile(safetyBackupPath, currentContent, 'utf8');

  await reportProgress(progress, { message: '读取备份内容', percent: 78, current: 1, total: 1 });
  const backupContent = await fs.readFile(selectedBackup.path, 'utf8');
  await reportProgress(progress, { message: `写入 ${target.label} 备份内容`, percent: 88, current: 1, total: 1 });
  await fs.writeFile(target.filePath, backupContent, 'utf8');

  if (metadata) {
    const updatedMetadata: PatchMetadata = {
      ...metadata,
      restoredAt: new Date().toISOString(),
      restoreSafetyBackupPath: safetyBackupPath
    };
    await context.globalState.update(metadataKey, updatedMetadata);
  }

  const after = await scanInstallPatch(
    install,
    context,
    patchData.rules,
    createScopedProgress(progress, 92, 99, '复扫补丁状态'),
    backupContent,
    { scanBackupRuleStatus: false }
  );
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

function resolveWorkbenchPatchTargets(install: CursorInstall): readonly WorkbenchPatchTarget[] {
  const targets: WorkbenchPatchTarget[] = [{
    id: 'desktop',
    filePath: install.workbenchPath,
    backupFilePrefix: desktopBackupFilePrefix,
    label: 'workbench.desktop.main.js'
  }];

  if (install.glassWorkbenchPath) {
    targets.push({
      id: 'glass',
      filePath: install.glassWorkbenchPath,
      backupFilePrefix: glassBackupFilePrefix,
      label: 'workbench.glass.main.js'
    });
  }

  return targets;
}

function formatPatchFilePaths(targets: readonly WorkbenchPatchTarget[]): string {
  return targets.map(target => target.filePath).join('\n');
}

function getPatchTargetFromBackupName(name: string, install: CursorInstall): WorkbenchPatchTarget | undefined {
  if (name.startsWith(glassBackupFilePrefix)) {
    return resolveWorkbenchPatchTargets(install).find(target => target.id === 'glass');
  }

  return resolveWorkbenchPatchTargets(install).find(target => target.id === 'desktop');
}

function getMetadataTargetRecord(metadata: PatchMetadata | undefined, targetId: WorkbenchPatchTargetId): PatchTargetRecord | undefined {
  return metadata?.targets?.find(record => record.id === targetId);
}

function mergePatchRuleStatuses(allStatuses: readonly (readonly PatchRuleStatus[])[]): readonly PatchRuleStatus[] {
  const merged = new Map<string, PatchRuleStatus>();

  for (const statuses of allStatuses) {
    for (const status of statuses) {
      const existing = merged.get(status.id);
      if (!existing) {
        merged.set(status.id, { ...status });
        continue;
      }

      merged.set(status.id, {
        id: status.id,
        sourceHits: existing.sourceHits + status.sourceHits,
        targetHits: existing.targetHits + status.targetHits
      });
    }
  }

  return [...merged.values()];
}

interface ScanInstallPatchOptions {
  readonly scanBackupRuleStatus?: boolean;
}

async function scanTargetPatch(
  target: WorkbenchPatchTarget,
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  progress?: ProgressCallback,
  content?: string,
  options?: ScanInstallPatchOptions
): Promise<PatchScanResult> {
  if (!content) {
    await reportProgress(progress, { message: `读取 ${target.label}`, percent: 5 });
  }

  const resolvedContent = content ?? await fs.readFile(target.filePath, 'utf8');
  const currentHash = sha256(resolvedContent);
  const ruleStatuses = await getPatchRuleStatuses(
    resolvedContent,
    rules,
    currentHash,
    createScopedProgress(progress, 15, 75, `扫描 ${target.label} 规则`),
    progress
  );
  const status = getPatchStatusFromRules(ruleStatuses);
  const metadata = getPatchMetadata(context);
  const backups = await scanBackupFiles(
    install,
    target,
    context,
    rules,
    metadata,
    createScopedProgress(progress, 80, 98, `扫描 ${target.label} 备份`),
    options?.scanBackupRuleStatus ?? true
  );

  await reportProgress(progress, {
    message: `${target.label} 补丁状态扫描完成，命中 ${status.matchedRules}/${rules.length} 条规则`,
    percent: 100,
    current: status.matchedRules,
    total: rules.length
  });
  return {
    state: status.state,
    filePath: target.filePath,
    cursorRoot: install.root,
    cursorVersion: install.version,
    currentHash,
    backupPath: getMetadataTargetRecord(metadata, target.id)?.backupPath ?? (target.id === 'desktop' ? metadata?.backupPath : undefined),
    backups,
    totalRules: rules.length,
    sourceHits: status.sourceHits,
    targetHits: status.targetHits,
    matchedRules: status.matchedRules,
    rules: ruleStatuses
  };
}

async function scanInstallPatch(
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  progress?: ProgressCallback,
  content?: string,
  options?: ScanInstallPatchOptions
): Promise<PatchScanResult> {
  const targets = await filterExistingPatchTargets(resolveWorkbenchPatchTargets(install));
  if (targets.length === 0) {
    throw new Error('未找到可补丁的 workbench 文件。');
  }

  if (content !== undefined && targets.length === 1) {
    return scanTargetPatch(targets[0], install, context, rules, progress, content, options);
  }

  const scans: PatchScanResult[] = [];
  for (let index = 0; index < targets.length; index += 1) {
    const target = targets[index];
    scans.push(await scanTargetPatch(
      target,
      install,
      context,
      rules,
      createScopedProgress(progress, toPercent(index, targets.length), toPercent(index + 1, targets.length)),
      undefined,
      options
    ));
  }

  const mergedRules = mergePatchRuleStatuses(scans.map(scan => scan.rules));
  const mergedStatus = getPatchStatusFromRules(mergedRules);
  const backups = scans.flatMap(scan => scan.backups).sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));

  return {
    state: mergedStatus.state,
    filePath: formatPatchFilePaths(targets),
    cursorRoot: install.root,
    cursorVersion: install.version,
    currentHash: scans.map(scan => `${scan.filePath}:${scan.currentHash}`).join('\n'),
    backupPath: scans.find(scan => scan.backupPath)?.backupPath,
    backups,
    totalRules: rules.length,
    sourceHits: mergedStatus.sourceHits,
    targetHits: mergedStatus.targetHits,
    matchedRules: mergedStatus.matchedRules,
    rules: mergedRules
  };
}

async function filterExistingPatchTargets(targets: readonly WorkbenchPatchTarget[]): Promise<WorkbenchPatchTarget[]> {
  const existing: WorkbenchPatchTarget[] = [];

  for (const target of targets) {
    if (await fileExists(target.filePath)) {
      existing.push(target);
    }
  }

  return existing;
}

async function scanAllBackupFiles(
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  metadata: PatchMetadata | undefined,
  progress?: ProgressCallback,
  scanRuleStatus = true
): Promise<PatchBackupInfo[]> {
  const targets = await filterExistingPatchTargets(resolveWorkbenchPatchTargets(install));
  const backups: PatchBackupInfo[] = [];

  for (const target of targets) {
    backups.push(...await scanBackupFiles(
      install,
      target,
      context,
      rules,
      metadata,
      progress,
      scanRuleStatus
    ));
  }

  return backups.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
}

async function scanBackupFiles(
  install: CursorInstall,
  target: WorkbenchPatchTarget,
  context: vscode.ExtensionContext,
  rules: readonly WorkbenchPatchRule[],
  metadata: PatchMetadata | undefined,
  progress?: ProgressCallback,
  scanRuleStatus = true
): Promise<PatchBackupInfo[]> {
  const directory = path.dirname(target.filePath);
  let entries: string[];

  await reportProgress(progress, { message: `读取 ${target.label} 备份目录`, percent: 0 });
  try {
    entries = await fs.readdir(directory);
  } catch {
    await reportProgress(progress, { message: `${target.label} 备份目录不可读取`, percent: 100, current: 0, total: 0 });
    return [];
  }

  const names = entries.filter(name => name.startsWith(target.backupFilePrefix));
  const backups: PatchBackupInfo[] = [];
  if (names.length === 0) {
    await reportProgress(progress, { message: `未发现 ${target.label} 备份文件`, percent: 100, current: 0, total: 0 });
    return [];
  }

  for (let index = 0; index < names.length; index += 1) {
    const backup = await readPatchBackupInfo(target, directory, names[index], metadata, rules, scanRuleStatus);
    if (backup) {
      backups.push(backup);
    }

    if (shouldYieldPatchProgress(index + 1, names.length, progress)) {
      await reportProgress(progress, {
        message: `扫描 ${target.label} 备份 ${index + 1}/${names.length}`,
        percent: toPercent(index + 1, names.length),
        current: index + 1,
        total: names.length
      });
      await yieldToEventLoop();
    }
  }

  return backups.sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt));
}

async function readPatchBackupInfo(
  target: WorkbenchPatchTarget,
  directory: string,
  name: string,
  metadata: PatchMetadata | undefined,
  rules: readonly WorkbenchPatchRule[],
  scanRuleStatus: boolean
): Promise<PatchBackupInfo | undefined> {
  const filePath = path.join(directory, name);

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return undefined;
    }

    const kind = getPatchBackupKind(name);
    if (!scanRuleStatus) {
      const hash = getBackupInferredHash(filePath, metadata);
      const status = inferBackupPatchStatus(hash, kind, metadata) ?? {
        state: 'unknown',
        sourceHits: 0,
        targetHits: 0,
        matchedRules: 0
      };

      return {
        path: filePath,
        name,
        kind,
        isOriginal: kind === 'original' && status.state === 'not-applied',
        currentMetadataBackup: isCurrentMetadataBackup(filePath, target.id, metadata),
        hash,
        size: stat.size,
        modifiedAt: stat.mtime.toISOString(),
        status
      };
    }

    const content = await fs.readFile(filePath, 'utf8');
    const hash = sha256(content);
    const status = await getPatchContentStatus(content, rules);

    return {
      path: filePath,
      name,
      kind,
      isOriginal: kind === 'original' && status.state === 'not-applied',
      currentMetadataBackup: isCurrentMetadataBackup(filePath, target.id, metadata),
      hash,
      size: stat.size,
      modifiedAt: stat.mtime.toISOString(),
      status
    };
  } catch {
    return undefined;
  }
}

function shouldYieldPatchProgress(current: number, total: number, progress?: ProgressCallback): boolean {
  if (!progress) {
    return false;
  }

  return current % 50 === 0 || current === total;
}

function getBackupInferredHash(filePath: string, metadata: PatchMetadata | undefined): string {
  if (metadata?.targets) {
    for (const target of metadata.targets) {
      if (samePath(filePath, target.backupPath)) {
        return target.originalHash;
      }
    }
  }

  if (metadata?.backupPath && samePath(filePath, metadata.backupPath)) {
    return metadata.originalHash;
  }

  return '';
}

function inferBackupPatchStatus(
  hash: string,
  kind: PatchBackupKind,
  metadata: PatchMetadata | undefined
): PatchBackupStatus | undefined {
  if (metadata?.targets) {
    for (const target of metadata.targets) {
      if (target.originalHash && hash === target.originalHash) {
        return { state: 'not-applied', sourceHits: 0, targetHits: 0, matchedRules: 0 };
      }

      if (target.patchedHash && hash === target.patchedHash) {
        return { state: 'applied', sourceHits: 0, targetHits: 0, matchedRules: 0 };
      }
    }
  }

  if (metadata?.originalHash && hash === metadata.originalHash) {
    return { state: 'not-applied', sourceHits: 0, targetHits: 0, matchedRules: 0 };
  }

  if (metadata?.patchedHash && hash === metadata.patchedHash) {
    return { state: 'applied', sourceHits: 0, targetHits: 0, matchedRules: 0 };
  }

  if (kind === 'original') {
    return { state: 'not-applied', sourceHits: 0, targetHits: 0, matchedRules: 0 };
  }

  return undefined;
}

function getPatchBackupKind(name: string): PatchBackupKind {
  for (const prefix of backupFilePrefixes) {
    if (name.startsWith(`${prefix}bak.`)) {
      return 'original';
    }

    if (name.startsWith(`${prefix}before-restore.`)) {
      return 'before-restore';
    }

    if (name.startsWith(`${prefix}before-uninstall.`)) {
      return 'before-uninstall';
    }
  }

  return 'unknown';
}

function isCurrentMetadataBackup(filePath: string, targetId: WorkbenchPatchTargetId, metadata: PatchMetadata | undefined): boolean {
  const targetRecord = getMetadataTargetRecord(metadata, targetId);
  if (targetRecord?.backupPath) {
    return samePath(filePath, targetRecord.backupPath);
  }

  return targetId === 'desktop' ? Boolean(metadata?.backupPath && samePath(filePath, metadata.backupPath)) : false;
}

async function getPatchContentStatus(content: string, rules: readonly WorkbenchPatchRule[]): Promise<PatchBackupStatus> {
  return getPatchStatusFromRules(await getPatchRuleStatuses(content, rules, sha256(content)));
}

async function getPatchRuleStatuses(
  content: string,
  rules: readonly WorkbenchPatchRule[],
  contentHash: string,
  progress?: ProgressCallback,
  yieldProgress?: ProgressCallback
): Promise<PatchRuleStatus[]> {
  const ruleFingerprint = getRuleFingerprint(rules);
  if (cachedRuleScan?.contentHash === contentHash && cachedRuleScan.ruleFingerprint === ruleFingerprint) {
    await reportProgress(progress, {
      message: '复用补丁扫描缓存',
      percent: 100,
      current: rules.length,
      total: rules.length
    });
    return [...cachedRuleScan.statuses];
  }

  const statuses: PatchRuleStatus[] = [];
  await reportProgress(progress, { message: '开始扫描补丁规则', percent: 0, current: 0, total: rules.length });

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    statuses.push({
      id: rule.id,
      sourceHits: countOccurrences(content, rule.source),
      targetHits: countOccurrences(content, rule.target)
    });

    if (shouldYieldPatchProgress(index + 1, rules.length, yieldProgress ?? progress)) {
      await reportProgress(progress, {
        message: `扫描补丁规则 ${index + 1}/${rules.length}`,
        percent: toPercent(index + 1, rules.length),
        current: index + 1,
        total: rules.length
      });
      await yieldToEventLoop();
    }
  }

  cachedRuleScan = { contentHash, ruleFingerprint, statuses };
  return statuses;
}

function getRuleFingerprint(rules: readonly WorkbenchPatchRule[]): string {
  if (rules.length === 0) {
    return '0';
  }

  return crypto.createHash('sha1').update(rules.map(rule => rule.id).join('\n'), 'utf8').digest('hex');
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

async function ensureBackup(
  target: WorkbenchPatchTarget,
  install: CursorInstall,
  content: string,
  context: vscode.ExtensionContext
): Promise<string> {
  const metadata = getPatchMetadata(context);
  const existingBackupPath = getMetadataTargetRecord(metadata, target.id)?.backupPath
    ?? (target.id === 'desktop' ? metadata?.backupPath : undefined);

  if (existingBackupPath && await fileExists(existingBackupPath)) {
    return existingBackupPath;
  }

  const backupPath = backupPathFor(target, install, 'bak');
  await fs.writeFile(backupPath, content, 'utf8');
  return backupPath;
}

function backupPathFor(target: WorkbenchPatchTarget, install: CursorInstall, kind: 'bak' | 'before-restore' | 'before-uninstall'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const version = install.version ?? 'unknown';
  return path.join(path.dirname(target.filePath), `${target.backupFilePrefix}${kind}.${version}.${timestamp}`);
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
  ruleCount: number,
  progress?: ProgressCallback
): Promise<void> {
  const maxHits = resolveMaxRuntimePatchHits(policy, ruleCount);
  if (appliedOccurrences > maxHits) {
    throw new Error(`补丁命中 ${appliedOccurrences} 处，超过运行时安全阈值 ${maxHits}，已取消写入。`);
  }

  await reportProgress(progress, { message: '计算变更行数', percent: 30, current: 1, total: 4 });
  const changedLines = countChangedLines(originalContent, patchedContent);
  const maxChangedLines = resolveMaxRuntimePatchChangedLines(policy, ruleCount);
  if (changedLines > maxChangedLines) {
    throw new Error(`补丁将修改 ${changedLines} 行，超过运行时安全阈值 ${maxChangedLines}，已取消写入。`);
  }

  assertBraceBalanceUnchanged(
    measureBraceBalance(originalContent),
    measureBraceBalance(patchedContent),
    '补丁汇总'
  );

  for (let index = 0; index < policy.guardedRuntimeNeedles.length; index += 1) {
    const needle = policy.guardedRuntimeNeedles[index];
    const before = countOccurrences(originalContent, needle);
    const after = countOccurrences(patchedContent, needle);
    if (before !== after) {
      throw new Error(`补丁触及受保护运行时关键字 ${needle}，已取消写入。`);
    }

    if (shouldYieldPatchProgress(index + 1, policy.guardedRuntimeNeedles.length, progress)) {
      await reportProgress(progress, {
        message: `校验受保护关键字 ${index + 1}/${policy.guardedRuntimeNeedles.length}`,
        percent: 30 + toPercent(index + 1, policy.guardedRuntimeNeedles.length) * 0.7,
        current: index + 1,
        total: policy.guardedRuntimeNeedles.length
      });
      await yieldToEventLoop();
    }
  }

  void appliedRuleIds;
}

function resolveMaxRuntimePatchHits(policy: WorkbenchPatchRuntimePolicy, ruleCount: number): number {
  return Math.max(policy.maxRuntimePatchRuleHits, Math.ceil(ruleCount * 1.25));
}

function resolveMaxRuntimePatchChangedLines(policy: WorkbenchPatchRuntimePolicy, ruleCount: number): number {
  return Math.max(policy.maxRuntimePatchChangedLines, Math.ceil(ruleCount * 0.75));
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