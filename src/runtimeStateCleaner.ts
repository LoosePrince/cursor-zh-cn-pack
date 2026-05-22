import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import initSqlJs from 'sql.js/dist/sql-asm.js';
import { listCursorProcesses } from './cursorProcessManager';
import { ProgressCallback, reportProgress } from './progress';

export const runtimeStateFileName = 'state.vscdb';
export const backupSuffixPrefix = '.cursor-zh-cn-runtime-backup-';
export const applicationUserKey = 'src.vs.platform.reactivestorage.browser.reactiveStorageServiceImpl.persistentStorage.applicationUser';
export const uiTextNeedles = [
  'Plan, search, make edits, run commands',
  'Create detailed plans for accomplishing tasks',
  'Ask Cursor questions about your codebase',
  'Systematically diagnose and fix bugs using runtime traces'
] as const;
export const modeActionNeedles = [
  'composerMode.agent',
  'composerMode.plan',
  'composerMode.chat',
  'composerMode.debug'
] as const;

export type RuntimeStateCleanState = 'not-found' | 'clean' | 'dirty' | 'cursor-running' | 'cleaned' | 'failed';

export interface RuntimeStateScanResult {
  readonly state: RuntimeStateCleanState;
  readonly filePath: string;
  readonly exists: boolean;
  readonly matchedRecords: number;
  readonly matchedFields: number;
  readonly matchedNeedles: readonly string[];
  readonly matchedKeys: readonly string[];
  readonly message: string;
}

export interface RuntimeStateCleanResult {
  readonly state: RuntimeStateCleanState;
  readonly filePath: string;
  readonly backupPath?: string;
  readonly changed: boolean;
  readonly matchedRecords: number;
  readonly cleanedFields: readonly string[];
  readonly deletedRecords: number;
  readonly matchedNeedles: readonly string[];
  readonly matchedKeys: readonly string[];
  readonly runningProcessIds: readonly number[];
  readonly message: string;
}

export interface LanguagePackCacheCleanResult {
  readonly cacheRoot: string;
  readonly languagePacksPath: string;
  readonly changed: boolean;
  readonly backupRoot?: string;
  readonly cleanedDirectories: readonly string[];
  readonly backupPaths: readonly string[];
  readonly message: string;
}

interface RuntimeStateMatch {
  readonly key: string;
  readonly value: string;
  readonly needles: readonly string[];
  readonly hasModeCache: boolean;
}

let sqlJsPromise: ReturnType<typeof initSqlJs> | undefined;

export function resolveRuntimeStatePath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Cursor', 'User', 'globalStorage', runtimeStateFileName);
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor', 'User', 'globalStorage', runtimeStateFileName);
  }

  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(configHome, 'Cursor', 'User', 'globalStorage', runtimeStateFileName);
}

export function resolveCursorUserDataPath(): string {
  if (process.platform === 'win32') {
    const appData = process.env.APPDATA ?? path.join(os.homedir(), 'AppData', 'Roaming');
    return path.join(appData, 'Cursor');
  }

  if (process.platform === 'darwin') {
    return path.join(os.homedir(), 'Library', 'Application Support', 'Cursor');
  }

  const configHome = process.env.XDG_CONFIG_HOME ?? path.join(os.homedir(), '.config');
  return path.join(configHome, 'Cursor');
}

export function resolveLanguagePackCacheRoot(): string {
  return path.join(resolveCursorUserDataPath(), 'clp');
}

export function resolveLanguagePacksPath(): string {
  return path.join(resolveCursorUserDataPath(), 'languagepacks.json');
}

export async function scanRuntimeState(progress?: ProgressCallback): Promise<RuntimeStateScanResult> {
  const filePath = resolveRuntimeStatePath();
  await reportProgress(progress, { message: '定位运行时状态库', percent: 5 });

  if (!(await fileExists(filePath))) {
    await reportProgress(progress, { message: '未找到 state.vscdb', percent: 100, current: 0, total: 1 });
    return {
      state: 'not-found',
      filePath,
      exists: false,
      matchedRecords: 0,
      matchedFields: 0,
      matchedNeedles: [],
      matchedKeys: [],
      message: '未找到运行时状态库。'
    };
  }

  const matches = await findRuntimeStateMatches(filePath, progress);
  const matchedNeedles = unique(matches.flatMap(match => match.needles));
  const matchedKeys = unique(matches.map(match => match.key));
  const matchedFields = matches.filter(match => match.hasModeCache).length;
  await reportProgress(progress, {
    message: matches.length ? `发现 ${matches.length} 条运行时 UI 缓存记录` : '未发现运行时 UI 缓存记录',
    percent: 100,
    current: matches.length,
    total: Math.max(1, matches.length)
  });

  return {
    state: matches.length ? 'dirty' : 'clean',
    filePath,
    exists: true,
    matchedRecords: matches.length,
    matchedFields,
    matchedNeedles,
    matchedKeys,
    message: matches.length ? '发现持久化 UI 文本缓存，建议清理后重启 Cursor。' : '未发现需要清理的运行时 UI 文本缓存。'
  };
}

export async function cleanRuntimeState(cursorRoot: string, progress?: ProgressCallback): Promise<RuntimeStateCleanResult> {
  const filePath = resolveRuntimeStatePath();
  await reportProgress(progress, { message: '准备清理运行时状态库', percent: 0 });

  if (!(await fileExists(filePath))) {
    await reportProgress(progress, { message: '未找到 state.vscdb', percent: 100, current: 0, total: 1 });
    return {
      state: 'not-found',
      filePath,
      changed: false,
      matchedRecords: 0,
      cleanedFields: [],
      deletedRecords: 0,
      matchedNeedles: [],
      matchedKeys: [],
      runningProcessIds: [],
      message: '未找到运行时状态库。'
    };
  }

  await reportProgress(progress, { message: '检查 Cursor 是否仍在运行', percent: 8 });
  const runningProcesses = await listCursorProcesses(cursorRoot);
  if (runningProcesses.length > 0) {
    await reportProgress(progress, {
      message: `Cursor 仍在运行，已跳过 state.vscdb 清理`,
      percent: 100,
      current: runningProcesses.length,
      total: runningProcesses.length
    });
    return {
      state: 'cursor-running',
      filePath,
      changed: false,
      matchedRecords: 0,
      cleanedFields: [],
      deletedRecords: 0,
      matchedNeedles: [],
      matchedKeys: [],
      runningProcessIds: runningProcesses.map(process => process.id),
      message: 'Cursor 仍在运行。请完全关闭 Cursor 后再清理 state.vscdb。'
    };
  }

  const matches = await findRuntimeStateMatches(filePath, progress);
  if (matches.length === 0) {
    await reportProgress(progress, { message: '没有需要清理的运行时 UI 缓存', percent: 100, current: 0, total: 1 });
    return {
      state: 'clean',
      filePath,
      changed: false,
      matchedRecords: 0,
      cleanedFields: [],
      deletedRecords: 0,
      matchedNeedles: [],
      matchedKeys: [],
      runningProcessIds: [],
      message: '未发现需要清理的运行时 UI 文本缓存。'
    };
  }

  await reportProgress(progress, { message: '备份 state.vscdb', percent: 42, current: 0, total: matches.length });
  const backupPath = await backupRuntimeState(filePath);
  const databaseBytes = await fs.readFile(filePath);
  const SQL = await loadSqlJs();
  const db = new SQL.Database(databaseBytes);
  const cleanedFields: string[] = [];
  let deletedRecords = 0;

  try {
    db.run('BEGIN TRANSACTION');
    const applicationUserMatch = matches.find(match => match.key === applicationUserKey && match.hasModeCache);
    if (applicationUserMatch) {
      const changed = clearComposerModeCache(db, applicationUserMatch.value);
      if (changed) {
        cleanedFields.push('ItemTable.applicationUser.composerState.modes4');
      }
    }

    const removableKeys = matches
      .filter(match => match.key !== applicationUserKey)
      .map(match => match.key);
    for (const key of removableKeys) {
      db.run('DELETE FROM ItemTable WHERE key = ?', [key]);
      deletedRecords += 1;
    }
    db.run('COMMIT');
  } catch (error) {
    try {
      db.run('ROLLBACK');
    } catch {
      // 忽略回滚失败，继续抛出原始错误。
    }
    throw error;
  }

  if (cleanedFields.length === 0 && deletedRecords === 0) {
    db.close();
    await reportProgress(progress, { message: '没有可安全删除的 UI 缓存字段', percent: 100, current: 0, total: matches.length });
    return {
      state: 'clean',
      filePath,
      backupPath,
      changed: false,
      matchedRecords: matches.length,
      cleanedFields,
      deletedRecords,
      matchedNeedles: unique(matches.flatMap(match => match.needles)),
      matchedKeys: unique(matches.map(match => match.key)),
      runningProcessIds: [],
      message: '发现命中项，但没有可安全删除的 UI 缓存字段。'
    };
  }

  await reportProgress(progress, { message: '写回清理后的 state.vscdb', percent: 82, current: cleanedFields.length + deletedRecords, total: matches.length });
  const exported = db.export();
  db.close();
  await fs.writeFile(filePath, Buffer.from(exported));
  await reportProgress(progress, { message: '运行时 UI 状态清理完成', percent: 100, current: cleanedFields.length + deletedRecords, total: matches.length });

  return {
    state: 'cleaned',
    filePath,
    backupPath,
    changed: true,
    matchedRecords: matches.length,
    cleanedFields,
    deletedRecords,
    matchedNeedles: unique(matches.flatMap(match => match.needles)),
    matchedKeys: unique(matches.map(match => match.key)),
    runningProcessIds: [],
    message: '已删除持久化 UI 文本缓存，下次启动 Cursor 会从已补丁的默认配置重新生成。'
  };
}

export async function cleanLanguagePackCache(progress?: ProgressCallback): Promise<LanguagePackCacheCleanResult> {
  const cacheRoot = resolveLanguagePackCacheRoot();
  const languagePacksPath = resolveLanguagePacksPath();
  await reportProgress(progress, { message: '准备重建语言包合成缓存', percent: 84 });

  if (!(await directoryExists(cacheRoot))) {
    await reportProgress(progress, { message: '未发现语言包合成缓存目录', percent: 92, current: 0, total: 1 });
    return {
      cacheRoot,
      languagePacksPath,
      changed: false,
      cleanedDirectories: [],
      backupPaths: [],
      message: '未发现语言包合成缓存目录。'
    };
  }

  const zhCnDirectories = await listZhCnLanguagePackCacheDirectories(cacheRoot);
  if (zhCnDirectories.length === 0) {
    await reportProgress(progress, { message: '未发现 zh-cn 语言包合成缓存', percent: 92, current: 0, total: 1 });
    return {
      cacheRoot,
      languagePacksPath,
      changed: false,
      cleanedDirectories: [],
      backupPaths: [],
      message: '未发现 zh-cn 语言包合成缓存。'
    };
  }

  const backupRoot = `${cacheRoot}.cursor-zh-cn-cache-backup-${formatTimestamp(new Date())}`;
  await fs.mkdir(backupRoot, { recursive: true });
  const cleanedDirectories: string[] = [];
  const backupPaths: string[] = [];

  for (let index = 0; index < zhCnDirectories.length; index += 1) {
    const directory = zhCnDirectories[index];
    const backupPath = path.join(backupRoot, path.basename(directory));
    await fs.rename(directory, backupPath);
    cleanedDirectories.push(directory);
    backupPaths.push(backupPath);
    await reportProgress(progress, {
      message: `清理语言包合成缓存 ${index + 1}/${zhCnDirectories.length}`,
      percent: 86 + toProgress(index + 1, zhCnDirectories.length) * 10,
      current: index + 1,
      total: zhCnDirectories.length
    });
  }

  await reportProgress(progress, { message: '语言包合成缓存已清理，下次启动会重新生成', percent: 96, current: cleanedDirectories.length, total: zhCnDirectories.length });
  return {
    cacheRoot,
    languagePacksPath,
    changed: true,
    backupRoot,
    cleanedDirectories,
    backupPaths,
    message: '已备份并清理 zh-cn 语言包合成缓存，下次启动 Cursor 会从官方中文包和补充包重新生成。'
  };
}

async function findRuntimeStateMatches(filePath: string, progress?: ProgressCallback): Promise<RuntimeStateMatch[]> {
  await reportProgress(progress, { message: '读取 state.vscdb', percent: 18 });
  const databaseBytes = await fs.readFile(filePath);
  const SQL = await loadSqlJs();
  const db = new SQL.Database(databaseBytes);

  try {
    const rows = db.exec('SELECT key, value FROM ItemTable WHERE key = ?', [applicationUserKey]);
    const values = rows[0]?.values ?? [];
    const matches: RuntimeStateMatch[] = [];
    for (const row of values) {
      const key = String(row[0]);
      const value = valueToText(row[1]);
      const needles = uiTextNeedles.filter(needle => value.includes(needle));
      const hasModeCache = value.includes('"modes4"') && modeActionNeedles.some(needle => value.includes(needle));
      if (needles.length > 0 && hasModeCache) {
        matches.push({ key, value, needles, hasModeCache });
      }
    }
    return matches;
  } finally {
    db.close();
  }
}

export function clearComposerModeCache(db: import('sql.js').Database, rawValue: string): boolean {
  const parsed = JSON.parse(rawValue) as unknown;
  if (!parsed || typeof parsed !== 'object') {
    return false;
  }

  const root = parsed as Record<string, unknown>;
  const composerState = root.composerState;
  if (!composerState || typeof composerState !== 'object') {
    return false;
  }

  const composerRecord = composerState as Record<string, unknown>;
  if (!Object.prototype.hasOwnProperty.call(composerRecord, 'modes4')) {
    return false;
  }

  const serializedModeCache = JSON.stringify(composerRecord.modes4);
  if (!uiTextNeedles.some(needle => serializedModeCache.includes(needle))) {
    return false;
  }

  delete composerRecord.modes4;
  db.run('UPDATE ItemTable SET value = ? WHERE key = ?', [JSON.stringify(root), applicationUserKey]);
  return true;
}

async function backupRuntimeState(filePath: string): Promise<string> {
  const backupPath = `${filePath}${backupSuffixPrefix}${formatTimestamp(new Date())}`;
  await fs.copyFile(filePath, backupPath);
  return backupPath;
}

async function loadSqlJs() {
  sqlJsPromise ??= initSqlJs();
  return sqlJsPromise;
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function directoryExists(directoryPath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(directoryPath);
    return stat.isDirectory();
  } catch {
    return false;
  }
}

async function listZhCnLanguagePackCacheDirectories(cacheRoot: string): Promise<string[]> {
  const entries = await fs.readdir(cacheRoot, { withFileTypes: true });
  return entries
    .filter(entry => entry.isDirectory() && entry.name.toLowerCase().endsWith('.zh-cn'))
    .map(entry => path.join(cacheRoot, entry.name));
}

export function valueToText(value: unknown): string {
  if (typeof value === 'string') {
    return value;
  }

  if (value instanceof Uint8Array) {
    return Buffer.from(value).toString('utf8');
  }

  if (Buffer.isBuffer(value)) {
    return value.toString('utf8');
  }

  return String(value ?? '');
}

function toProgress(current: number, total: number): number {
  if (total <= 0) {
    return 1;
  }
  return Math.min(1, Math.max(0, current / total));
}

function formatTimestamp(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, '0');
  return [
    date.getFullYear(),
    pad(date.getMonth() + 1),
    pad(date.getDate()),
    '-',
    pad(date.getHours()),
    pad(date.getMinutes()),
    pad(date.getSeconds())
  ].join('');
}

function unique<T>(values: readonly T[]): T[] {
  return [...new Set(values)];
}