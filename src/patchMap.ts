import * as fs from 'fs';
import * as path from 'path';

export interface WorkbenchPatchRule {
  readonly id: string;
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

const patchDataPath = path.join(__dirname, '..', 'data', 'workbench-patches.json');
const runtimePolicyPath = path.join(__dirname, '..', 'data', 'workbench-patch-runtime-policy.json');

export const workbenchPatchRuntimePolicy: WorkbenchPatchRuntimePolicy = loadWorkbenchPatchRuntimePolicy();
export const allWorkbenchPatchRules: readonly WorkbenchPatchRule[] = loadWorkbenchPatchRules();
export const workbenchPatchRules: readonly WorkbenchPatchRule[] = allWorkbenchPatchRules.filter(rule => isRuntimeSafePatchRule(rule, workbenchPatchRuntimePolicy));

function loadWorkbenchPatchRules(): readonly WorkbenchPatchRule[] {
  const rawRules = readJson(patchDataPath);
  if (!Array.isArray(rawRules)) {
    throw new Error(`无效的 workbench 补丁映射文件: ${patchDataPath}`);
  }

  return rawRules.map((rule, index) => {
    if (!isWorkbenchPatchRule(rule)) {
      throw new Error(`无效的 workbench 补丁规则 #${index + 1}: ${patchDataPath}`);
    }
    return rule;
  });
}

function loadWorkbenchPatchRuntimePolicy(): WorkbenchPatchRuntimePolicy {
  const value = readJson(runtimePolicyPath);
  if (!isWorkbenchPatchRuntimePolicy(value)) {
    throw new Error(`无效的 workbench 补丁运行策略文件: ${runtimePolicyPath}`);
  }
  return value;
}

function readJson(filePath: string): unknown {
  return JSON.parse(fs.readFileSync(filePath, 'utf8')) as unknown;
}

function isRuntimeSafePatchRule(rule: WorkbenchPatchRule, policy: WorkbenchPatchRuntimePolicy): boolean {
  if (rule.source === rule.target) {
    return false;
  }

  return policy.runtimeRuleIdPrefixes.some(prefix => rule.id.startsWith(prefix))
    && policy.safeSourcePrefixes.some(prefix => rule.source.startsWith(prefix));
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