import * as fs from 'fs/promises';
import * as path from 'path';
import { assertPatchRuleBraceBalance } from './braceBalance';
import { createScopedProgress, ProgressCallback, reportProgress, toPercent, yieldToEventLoop } from './progress';

export interface WorkbenchPatchRule {
  readonly id: string;
  readonly source: string;
  readonly target: string;
  readonly note?: string;
}

export interface NlsMessagePatchRule {
  readonly id: string;
  readonly module: string;
  readonly key: string;
  readonly source: string;
  readonly target: string;
  readonly note?: string;
}

export interface WorkbenchPatchRuntimePolicy {
  readonly runtimeRuleIdPrefixes: readonly string[];
  readonly safeSourcePrefixes: readonly string[];
  readonly guardedRuntimeNeedles: readonly string[];
  readonly maxRuntimePatchRuleHits: number;
  readonly maxRuntimePatchChangedLines: number;
}

export interface WorkbenchPatchData {
  readonly runtimePolicy: WorkbenchPatchRuntimePolicy;
  readonly allRules: readonly WorkbenchPatchRule[];
  readonly rules: readonly WorkbenchPatchRule[];
}

const patchDataPath = path.join(__dirname, '..', 'data', 'workbench-patches.json');
const runtimePolicyPath = path.join(__dirname, '..', 'data', 'workbench-patch-runtime-policy.json');
const nlsMessagePatchDataPath = path.join(__dirname, '..', 'data', 'nls-message-patches.json');

let cachedPatchData: WorkbenchPatchData | undefined;
let loadingPatchData: Promise<WorkbenchPatchData> | undefined;
let cachedNlsMessagePatchRules: readonly NlsMessagePatchRule[] | undefined;
let loadingNlsMessagePatchRules: Promise<readonly NlsMessagePatchRule[]> | undefined;
let cachedSafeSourcePrefixMatcher: ((source: string) => boolean) | undefined;
let cachedRuntimeRuleIdPrefixMatcher: ((ruleId: string) => boolean) | undefined;

export async function loadWorkbenchPatchData(progress?: ProgressCallback): Promise<WorkbenchPatchData> {
  if (cachedPatchData) {
    await reportProgress(progress, {
      message: `补丁数据已加载（${cachedPatchData.rules.length}/${cachedPatchData.allRules.length} 条可用）`,
      percent: 100,
      current: cachedPatchData.rules.length,
      total: cachedPatchData.allRules.length
    });
    return cachedPatchData;
  }

  if (!loadingPatchData) {
    loadingPatchData = loadWorkbenchPatchDataCore(progress);
  } else {
    await reportProgress(progress, { message: '等待补丁数据加载完成', percent: 20 });
  }

  cachedPatchData = await loadingPatchData;
  await reportProgress(progress, {
    message: `补丁数据加载完成（${cachedPatchData.rules.length}/${cachedPatchData.allRules.length} 条可用）`,
    percent: 100,
    current: cachedPatchData.rules.length,
    total: cachedPatchData.allRules.length
  });
  return cachedPatchData;
}

export async function loadNlsMessagePatchRules(progress?: ProgressCallback): Promise<readonly NlsMessagePatchRule[]> {
  if (cachedNlsMessagePatchRules) {
    await reportProgress(progress, {
      message: `NLS 消息表规则已加载（${cachedNlsMessagePatchRules.length} 条）`,
      percent: 100,
      current: cachedNlsMessagePatchRules.length,
      total: cachedNlsMessagePatchRules.length
    });
    return cachedNlsMessagePatchRules;
  }

  if (!loadingNlsMessagePatchRules) {
    loadingNlsMessagePatchRules = loadNlsMessagePatchRulesCore(progress);
  } else {
    await reportProgress(progress, { message: '等待 NLS 消息表规则加载完成', percent: 20 });
  }

  cachedNlsMessagePatchRules = await loadingNlsMessagePatchRules;
  await reportProgress(progress, {
    message: `NLS 消息表规则加载完成（${cachedNlsMessagePatchRules.length} 条）`,
    percent: 100,
    current: cachedNlsMessagePatchRules.length,
    total: cachedNlsMessagePatchRules.length
  });
  return cachedNlsMessagePatchRules;
}

async function loadWorkbenchPatchDataCore(progress?: ProgressCallback): Promise<WorkbenchPatchData> {
  await reportProgress(progress, { message: '读取补丁运行策略', percent: 5 });
  const runtimePolicy = await readWorkbenchPatchRuntimePolicy();
  cachedSafeSourcePrefixMatcher = createPrefixMatcher(runtimePolicy.safeSourcePrefixes);
  cachedRuntimeRuleIdPrefixMatcher = createPrefixMatcher(runtimePolicy.runtimeRuleIdPrefixes);

  await reportProgress(progress, { message: '读取补丁规则文件', percent: 20 });
  const rawRules = await readJson(patchDataPath);
  if (!Array.isArray(rawRules)) {
    throw new Error(`无效的 workbench 补丁映射文件: ${patchDataPath}`);
  }

  const allRules = await parseWorkbenchPatchRules(rawRules, createScopedProgress(progress, 30, 70, '校验补丁规则'));
  const rules = await filterRuntimeSafePatchRules(allRules, runtimePolicy, createScopedProgress(progress, 70, 95, '筛选运行时安全规则'));

  return { runtimePolicy, allRules, rules };
}

async function loadNlsMessagePatchRulesCore(progress?: ProgressCallback): Promise<readonly NlsMessagePatchRule[]> {
  await reportProgress(progress, { message: '读取 NLS 消息表规则文件', percent: 20 });
  const rawRules = await readJson(nlsMessagePatchDataPath);
  if (!Array.isArray(rawRules)) {
    throw new Error(`无效的 NLS 消息表补丁映射文件: ${nlsMessagePatchDataPath}`);
  }

  return parseNlsMessagePatchRules(rawRules, createScopedProgress(progress, 30, 95, '校验 NLS 消息表规则'));
}

async function parseWorkbenchPatchRules(rawRules: readonly unknown[], progress?: ProgressCallback): Promise<readonly WorkbenchPatchRule[]> {
  const rules: WorkbenchPatchRule[] = [];
  const total = rawRules.length;
  await reportProgress(progress, { message: '开始校验补丁规则', percent: 0, current: 0, total });

  for (let index = 0; index < total; index += 1) {
    const rule = rawRules[index];
    if (!isWorkbenchPatchRule(rule)) {
      throw new Error(`无效的 workbench 补丁规则 #${index + 1}: ${patchDataPath}`);
    }

    assertPatchRuleBraceBalance(rule.id, rule.source, rule.target);
    rules.push(rule);
    if (shouldYieldRuleProgress(index + 1, total, progress)) {
      await reportProgress(progress, {
        message: `校验补丁规则 ${index + 1}/${total}`,
        percent: toPercent(index + 1, total),
        current: index + 1,
        total
      });
      await yieldToEventLoop();
    }
  }

  return rules;
}

async function parseNlsMessagePatchRules(rawRules: readonly unknown[], progress?: ProgressCallback): Promise<readonly NlsMessagePatchRule[]> {
  const rules: NlsMessagePatchRule[] = [];
  const total = rawRules.length;
  await reportProgress(progress, { message: '开始校验 NLS 消息表规则', percent: 0, current: 0, total });

  for (let index = 0; index < total; index += 1) {
    const rule = rawRules[index];
    if (!isNlsMessagePatchRule(rule)) {
      throw new Error(`无效的 NLS 消息表补丁规则 #${index + 1}: ${nlsMessagePatchDataPath}`);
    }

    rules.push(rule);
    if ((index + 1) % 25 === 0 || index + 1 === total) {
      await reportProgress(progress, {
        message: `校验 NLS 消息表规则 ${index + 1}/${total}`,
        percent: toPercent(index + 1, total),
        current: index + 1,
        total
      });
      await yieldToEventLoop();
    }
  }

  return rules;
}

async function filterRuntimeSafePatchRules(
  allRules: readonly WorkbenchPatchRule[],
  policy: WorkbenchPatchRuntimePolicy,
  progress?: ProgressCallback
): Promise<readonly WorkbenchPatchRule[]> {
  const rules: WorkbenchPatchRule[] = [];
  const total = allRules.length;
  await reportProgress(progress, { message: '开始筛选运行时安全规则', percent: 0, current: 0, total });

  for (let index = 0; index < total; index += 1) {
    const rule = allRules[index];
    if (isRuntimeSafePatchRule(rule, policy)) {
      rules.push(rule);
    }

    if (shouldYieldRuleProgress(index + 1, total, progress)) {
      await reportProgress(progress, {
        message: `筛选运行时安全规则 ${index + 1}/${total}`,
        percent: toPercent(index + 1, total),
        current: index + 1,
        total
      });
      await yieldToEventLoop();
    }
  }

  return rules;
}

async function readWorkbenchPatchRuntimePolicy(): Promise<WorkbenchPatchRuntimePolicy> {
  const value = await readJson(runtimePolicyPath);
  if (!isWorkbenchPatchRuntimePolicy(value)) {
    throw new Error(`无效的 workbench 补丁运行策略文件: ${runtimePolicyPath}`);
  }
  return value;
}

async function readJson(filePath: string): Promise<unknown> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
}

function isRuntimeSafePatchRule(rule: WorkbenchPatchRule, _policy: WorkbenchPatchRuntimePolicy): boolean {
  if (rule.source === rule.target) {
    return false;
  }

  return getRuntimeRuleIdPrefixMatcher()(rule.id)
    && getSafeSourcePrefixMatcher()(rule.source);
}

function getSafeSourcePrefixMatcher(): (source: string) => boolean {
  if (!cachedSafeSourcePrefixMatcher) {
    throw new Error('补丁运行策略尚未加载');
  }

  return cachedSafeSourcePrefixMatcher;
}

function getRuntimeRuleIdPrefixMatcher(): (ruleId: string) => boolean {
  if (!cachedRuntimeRuleIdPrefixMatcher) {
    throw new Error('补丁运行策略尚未加载');
  }

  return cachedRuntimeRuleIdPrefixMatcher;
}

function createPrefixMatcher(prefixes: readonly string[]): (value: string) => boolean {
  return value => {
    for (const prefix of prefixes) {
      if (value.startsWith(prefix)) {
        return true;
      }
    }

    return false;
  };
}

function shouldYieldRuleProgress(current: number, total: number, progress?: ProgressCallback): boolean {
  if (!progress) {
    return false;
  }

  return current % 100 === 0 || current === total;
}

function isWorkbenchPatchRule(value: unknown): value is WorkbenchPatchRule {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const rule = value as Record<string, unknown>;
  return typeof rule.id === 'string'
    && typeof rule.source === 'string'
    && typeof rule.target === 'string'
    && (rule.note === undefined || typeof rule.note === 'string');
}

function isNlsMessagePatchRule(value: unknown): value is NlsMessagePatchRule {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const rule = value as Record<string, unknown>;
  return typeof rule.id === 'string'
    && typeof rule.module === 'string'
    && typeof rule.key === 'string'
    && typeof rule.source === 'string'
    && typeof rule.target === 'string'
    && rule.source !== rule.target
    && (rule.note === undefined || typeof rule.note === 'string');
}

function isWorkbenchPatchRuntimePolicy(value: unknown): value is WorkbenchPatchRuntimePolicy {
  if (!value || typeof value !== 'object') {
    return false;
  }

  const policy = value as Record<string, unknown>;
  return isStringArray(policy.runtimeRuleIdPrefixes)
    && isStringArray(policy.safeSourcePrefixes)
    && isStringArray(policy.guardedRuntimeNeedles)
    && typeof policy.maxRuntimePatchRuleHits === 'number'
    && typeof policy.maxRuntimePatchChangedLines === 'number';
}

function isStringArray(value: unknown): value is readonly string[] {
  return Array.isArray(value) && value.every(item => typeof item === 'string');
}