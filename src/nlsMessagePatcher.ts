import * as crypto from 'crypto';
import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { CursorInstall, validateCursorRoot } from './cursorLocator';
import { loadNlsMessagePatchRules, NlsMessagePatchRule } from './patchMap';
import { createScopedProgress, ProgressCallback, reportProgress, toPercent, yieldToEventLoop } from './progress';
import { PatchRuleStatus, PatchState } from './workbenchPatcher';

const metadataKey = 'cursorZhCn.nlsMessagePatchMetadata';
const backupFilePrefix = 'nls.messages.json.cursor-zh-cn-pack.';

interface NlsMessageLocation {
  readonly index: number;
  readonly module: string;
  readonly key: string;
}

export interface NlsMessagePatchMetadata {
  readonly cursorRoot: string;
  readonly cursorVersion?: string;
  readonly nlsMessagesPath: string;
  readonly originalHash: string;
  readonly patchedHash: string;
  readonly backupPath: string;
  readonly appliedRuleIds: readonly string[];
  readonly appliedAt: string;
  readonly uninstalledAt?: string;
  readonly uninstallSafetyBackupPath?: string;
}

export interface NlsMessagePatchScanResult {
  readonly state: PatchState;
  readonly filePath: string;
  readonly keysPath: string;
  readonly cursorRoot: string;
  readonly cursorVersion?: string;
  readonly currentHash: string;
  readonly backupPath?: string;
  readonly totalRules: number;
  readonly sourceHits: number;
  readonly targetHits: number;
  readonly matchedRules: number;
  readonly rules: readonly PatchRuleStatus[];
  readonly missingRuleIds: readonly string[];
}

export interface NlsMessagePatchApplyResult {
  readonly changed: boolean;
  readonly backupPath?: string;
  readonly appliedRuleIds: readonly string[];
  readonly appliedOccurrences: number;
  readonly before: NlsMessagePatchScanResult;
  readonly after: NlsMessagePatchScanResult;
}

export interface NlsMessagePatchUnapplyResult {
  readonly changed: boolean;
  readonly safetyBackupPath?: string;
  readonly unappliedRuleIds: readonly string[];
  readonly before: NlsMessagePatchScanResult;
  readonly after: NlsMessagePatchScanResult;
}

export async function scanNlsMessagePatch(root: string, context: vscode.ExtensionContext, progress?: ProgressCallback): Promise<NlsMessagePatchScanResult> {
  const install = await validateCursorRoot(root, 'NLS 消息表补丁扫描', createScopedProgress(progress, 0, 15, '校验安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const rules = await loadNlsMessagePatchRules(createScopedProgress(progress, 15, 35, '加载 NLS 消息表规则'));
  const result = await scanInstallNlsMessages(install, context, rules, createScopedProgress(progress, 35, 99, '扫描 NLS 消息表'));
  await reportProgress(progress, {
    message: `NLS 消息表扫描完成，命中 ${result.matchedRules}/${result.totalRules} 条规则`,
    percent: 100,
    current: result.matchedRules,
    total: result.totalRules
  });
  return result;
}

export async function applyNlsMessagePatch(root: string, context: vscode.ExtensionContext, progress?: ProgressCallback): Promise<NlsMessagePatchApplyResult> {
  const install = await validateCursorRoot(root, 'NLS 消息表补丁应用', createScopedProgress(progress, 0, 5, '校验安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const rules = await loadNlsMessagePatchRules(createScopedProgress(progress, 5, 15, '加载 NLS 消息表规则'));
  const before = await scanInstallNlsMessages(install, context, rules, createScopedProgress(progress, 15, 35, '扫描 NLS 消息表状态'));

  if (before.sourceHits === 0) {
    await reportProgress(progress, {
      message: before.targetHits > 0 ? 'NLS 消息表已处于应用状态' : 'NLS 消息表没有命中可补丁来源',
      percent: 100,
      current: before.matchedRules,
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

  await reportProgress(progress, { message: '读取 NLS 消息表', percent: 38 });
  const originalMessages = await readMessages(install.nlsMessagesPath);
  const originalContent = await fs.readFile(install.nlsMessagesPath, 'utf8');
  const originalHash = sha256(originalContent);
  const locations = await readLocations(install.nlsKeysPath);
  const locationIndex = indexLocations(locations);

  await reportProgress(progress, { message: '创建或复用 NLS 原始备份', percent: 42 });
  const backupPath = await ensureBackup(install, originalContent, context);

  const patchedMessages = [...originalMessages];
  const appliedRuleIds: string[] = [];
  let appliedOccurrences = 0;

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const messageIndex = locationIndex.get(locationKey(rule));
    if (messageIndex !== undefined && patchedMessages[messageIndex] === rule.source) {
      patchedMessages[messageIndex] = rule.target;
      appliedRuleIds.push(rule.id);
      appliedOccurrences += 1;
    }

    if ((index + 1) % 10 === 0 || index + 1 === rules.length) {
      await reportProgress(progress, {
        message: `应用 NLS 消息表规则 ${index + 1}/${rules.length}`,
        percent: 45 + toPercent(index + 1, rules.length) * 0.3,
        current: index + 1,
        total: rules.length
      });
      await yieldToEventLoop();
    }
  }

  const patchedContent = `${JSON.stringify(patchedMessages)}\n`;
  if (patchedContent === originalContent) {
    const after = await scanInstallNlsMessages(install, context, rules, createScopedProgress(progress, 80, 99, '复扫 NLS 消息表'));
    await reportProgress(progress, { message: 'NLS 消息表未写入：没有需要替换的内容', percent: 100 });
    return {
      changed: false,
      backupPath,
      appliedRuleIds,
      appliedOccurrences,
      before,
      after
    };
  }

  await reportProgress(progress, { message: '写入 NLS 消息表', percent: 86, current: rules.length, total: rules.length });
  await fs.writeFile(install.nlsMessagesPath, patchedContent, 'utf8');
  const patchedHash = sha256(patchedContent);

  const metadata: NlsMessagePatchMetadata = {
    cursorRoot: install.root,
    cursorVersion: install.version,
    nlsMessagesPath: install.nlsMessagesPath,
    originalHash,
    patchedHash,
    backupPath,
    appliedRuleIds,
    appliedAt: new Date().toISOString()
  };
  await context.globalState.update(metadataKey, metadata);

  const after = await scanInstallNlsMessages(install, context, rules, createScopedProgress(progress, 92, 99, '复扫 NLS 消息表'));
  await reportProgress(progress, {
    message: `NLS 消息表补丁完成，处理 ${appliedRuleIds.length}/${rules.length} 条规则`,
    percent: 100,
    current: appliedRuleIds.length,
    total: rules.length
  });
  return {
    changed: true,
    backupPath,
    appliedRuleIds,
    appliedOccurrences,
    before,
    after
  };
}

export async function unapplyNlsMessagePatch(root: string, context: vscode.ExtensionContext, progress?: ProgressCallback): Promise<NlsMessagePatchUnapplyResult> {
  const install = await validateCursorRoot(root, 'NLS 消息表补丁卸载', createScopedProgress(progress, 0, 5, '校验安装目录'));
  if (!install.valid) {
    throw new Error(install.problems.join('\n'));
  }

  const rules = await loadNlsMessagePatchRules(createScopedProgress(progress, 5, 15, '加载 NLS 消息表规则'));
  const before = await scanInstallNlsMessages(install, context, rules, createScopedProgress(progress, 15, 35, '扫描 NLS 消息表状态'));
  if (before.targetHits === 0) {
    await reportProgress(progress, { message: '未检测到 NLS 消息表中文补丁', percent: 100, current: 0, total: rules.length });
    return {
      changed: false,
      unappliedRuleIds: [],
      before,
      after: before
    };
  }

  await reportProgress(progress, { message: '读取 NLS 消息表', percent: 40 });
  const currentMessages = await readMessages(install.nlsMessagesPath);
  const currentContent = await fs.readFile(install.nlsMessagesPath, 'utf8');
  const locations = await readLocations(install.nlsKeysPath);
  const locationIndex = indexLocations(locations);
  const restoredMessages = [...currentMessages];
  const unappliedRuleIds: string[] = [];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const messageIndex = locationIndex.get(locationKey(rule));
    if (messageIndex !== undefined && restoredMessages[messageIndex] === rule.target) {
      restoredMessages[messageIndex] = rule.source;
      unappliedRuleIds.push(rule.id);
    }

    if ((index + 1) % 10 === 0 || index + 1 === rules.length) {
      await reportProgress(progress, {
        message: `卸载 NLS 消息表规则 ${index + 1}/${rules.length}`,
        percent: 45 + toPercent(index + 1, rules.length) * 0.3,
        current: index + 1,
        total: rules.length
      });
      await yieldToEventLoop();
    }
  }

  const restoredContent = `${JSON.stringify(restoredMessages)}\n`;
  if (restoredContent === currentContent) {
    const after = await scanInstallNlsMessages(install, context, rules, createScopedProgress(progress, 80, 99, '复扫 NLS 消息表'));
    await reportProgress(progress, { message: 'NLS 消息表未卸载：没有需要还原的内容', percent: 100 });
    return {
      changed: false,
      unappliedRuleIds,
      before,
      after
    };
  }

  const safetyBackupPath = backupPathFor(install, 'before-uninstall');
  await fs.writeFile(safetyBackupPath, currentContent, 'utf8');
  await fs.writeFile(install.nlsMessagesPath, restoredContent, 'utf8');

  const metadata = getNlsMessagePatchMetadata(context);
  if (metadata) {
    await context.globalState.update(metadataKey, {
      ...metadata,
      uninstalledAt: new Date().toISOString(),
      uninstallSafetyBackupPath: safetyBackupPath
    } satisfies NlsMessagePatchMetadata);
  }

  const after = await scanInstallNlsMessages(install, context, rules, createScopedProgress(progress, 92, 99, '复扫 NLS 消息表'));
  await reportProgress(progress, {
    message: `NLS 消息表补丁卸载完成，处理 ${unappliedRuleIds.length}/${rules.length} 条规则`,
    percent: 100,
    current: unappliedRuleIds.length,
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

export function getNlsMessagePatchMetadata(context: vscode.ExtensionContext): NlsMessagePatchMetadata | undefined {
  return context.globalState.get<NlsMessagePatchMetadata>(metadataKey);
}

async function scanInstallNlsMessages(
  install: CursorInstall,
  context: vscode.ExtensionContext,
  rules: readonly NlsMessagePatchRule[],
  progress?: ProgressCallback
): Promise<NlsMessagePatchScanResult> {
  await reportProgress(progress, { message: '读取 NLS keys/messages', percent: 5 });
  const [locations, messagesContent, messages] = await Promise.all([
    readLocations(install.nlsKeysPath),
    fs.readFile(install.nlsMessagesPath, 'utf8'),
    readMessages(install.nlsMessagesPath)
  ]);

  if (locations.length !== messages.length) {
    throw new Error(`NLS keys/messages 数量不一致：keys ${locations.length} / messages ${messages.length}`);
  }

  const locationIndex = indexLocations(locations);
  const statuses: PatchRuleStatus[] = [];
  const missingRuleIds: string[] = [];

  for (let index = 0; index < rules.length; index += 1) {
    const rule = rules[index];
    const messageIndex = locationIndex.get(locationKey(rule));
    if (messageIndex === undefined) {
      missingRuleIds.push(rule.id);
      statuses.push({ id: rule.id, sourceHits: 0, targetHits: 0 });
    } else {
      const message = messages[messageIndex];
      statuses.push({
        id: rule.id,
        sourceHits: message === rule.source ? 1 : 0,
        targetHits: message === rule.target ? 1 : 0
      });
    }

    if ((index + 1) % 10 === 0 || index + 1 === rules.length) {
      await reportProgress(progress, {
        message: `扫描 NLS 消息表规则 ${index + 1}/${rules.length}`,
        percent: 15 + toPercent(index + 1, rules.length) * 0.75,
        current: index + 1,
        total: rules.length
      });
      await yieldToEventLoop();
    }
  }

  const sourceHits = statuses.reduce((sum, rule) => sum + rule.sourceHits, 0);
  const targetHits = statuses.reduce((sum, rule) => sum + rule.targetHits, 0);
  const matchedRules = statuses.filter(rule => rule.sourceHits > 0 || rule.targetHits > 0).length;
  const metadata = getNlsMessagePatchMetadata(context);

  return {
    state: getPatchState(sourceHits, targetHits, matchedRules),
    filePath: install.nlsMessagesPath,
    keysPath: install.nlsKeysPath,
    cursorRoot: install.root,
    cursorVersion: install.version,
    currentHash: sha256(messagesContent),
    backupPath: metadata?.backupPath,
    totalRules: rules.length,
    sourceHits,
    targetHits,
    matchedRules,
    rules: statuses,
    missingRuleIds
  };
}

async function readLocations(keysPath: string): Promise<NlsMessageLocation[]> {
  const keys = JSON.parse(await fs.readFile(keysPath, 'utf8')) as unknown;
  if (!Array.isArray(keys)) {
    throw new Error(`无效的 nls.keys.json: ${keysPath}`);
  }

  const locations: NlsMessageLocation[] = [];
  for (const entry of keys) {
    if (!Array.isArray(entry) || typeof entry[0] !== 'string' || !Array.isArray(entry[1])) {
      throw new Error(`无效的 nls.keys.json 条目: ${keysPath}`);
    }

    const module = entry[0];
    for (const key of entry[1]) {
      if (typeof key !== 'string') {
        throw new Error(`无效的 nls.keys.json key: ${keysPath}`);
      }
      locations.push({ index: locations.length, module, key });
    }
  }

  return locations;
}

async function readMessages(messagesPath: string): Promise<string[]> {
  const messages = JSON.parse(await fs.readFile(messagesPath, 'utf8')) as unknown;
  if (!Array.isArray(messages) || !messages.every(message => typeof message === 'string')) {
    throw new Error(`无效的 nls.messages.json: ${messagesPath}`);
  }
  return messages;
}

function indexLocations(locations: readonly NlsMessageLocation[]): Map<string, number> {
  return new Map(locations.map(location => [locationKey(location), location.index]));
}

function locationKey(value: Pick<NlsMessageLocation, 'module' | 'key'>): string {
  return `${value.module}\u0000${value.key}`;
}

async function ensureBackup(install: CursorInstall, content: string, context: vscode.ExtensionContext): Promise<string> {
  const metadata = getNlsMessagePatchMetadata(context);
  if (metadata?.backupPath && await fileExists(metadata.backupPath)) {
    return metadata.backupPath;
  }

  const backupPath = backupPathFor(install, 'bak');
  await fs.writeFile(backupPath, content, 'utf8');
  return backupPath;
}

function backupPathFor(install: CursorInstall, kind: 'bak' | 'before-uninstall'): string {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-');
  const version = install.version ?? 'unknown';
  return path.join(path.dirname(install.nlsMessagesPath), `${backupFilePrefix}${kind}.${version}.${timestamp}`);
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