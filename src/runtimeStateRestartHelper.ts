import { execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { applicationUserKey, cleanLanguagePackCache, clearComposerModeCache, openRuntimeStateDatabase, uiTextNeedles, valueToText } from './runtimeStateCleaner';

const execFileAsync = promisify(execFile);
const gracefulTimeoutMs = 5000;
const forcedTimeoutMs = 5000;
const maxWaitAfterKillMs = 15000;

interface HelperOptions {
  readonly cursorExe: string;
  readonly logPath: string;
  readonly cleanRuntimeState: boolean;
  readonly dryRun: boolean;
}

async function main(): Promise<void> {
  const options = parseArgs(process.argv.slice(2));
  await appendLog(options.logPath, `helper started, cleanRuntimeState=${options.cleanRuntimeState}, dryRun=${options.dryRun}`);
  if (options.dryRun) {
    await appendLog(options.logPath, 'dry run finished');
    return;
  }

  await closeCursor(options.cursorExe, options.logPath);

  if (options.cleanRuntimeState) {
    await runHelperStep('clean runtime state', options.logPath, () => cleanRuntimeStateAfterExit(options.logPath));
    await runHelperStep('clean language pack cache', options.logPath, () => cleanLanguagePackCacheAfterExit(options.logPath));
  }

  await launchCursor(options.cursorExe, options.logPath);
  await appendLog(options.logPath, 'helper finished');
}

async function runHelperStep(name: string, logPath: string, step: () => Promise<void>): Promise<void> {
  try {
    await step();
  } catch (error) {
    await appendLog(logPath, `${name} failed but restart will continue: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
}

function parseArgs(args: readonly string[]): HelperOptions {
  const cursorExe = getArg(args, '--cursor-exe');
  const logPath = getArg(args, '--log');
  return {
    cursorExe,
    logPath,
    cleanRuntimeState: args.includes('--clean-runtime-state'),
    dryRun: args.includes('--dry-run')
  };
}

function getArg(args: readonly string[], name: string): string {
  const index = args.indexOf(name);
  const value = index >= 0 ? args[index + 1] : undefined;
  if (!value) {
    throw new Error(`缺少参数 ${name}`);
  }
  return value;
}

async function closeCursor(cursorExe: string, logPath: string): Promise<void> {
  const processes = await listTargetCursorProcesses(cursorExe);
  await appendLog(logPath, `found ${processes.length} Cursor processes`);
  if (processes.length === 0) {
    return;
  }

  await closeProcessesGracefully(processes.map(process => process.id));
  await waitForProcessExit(processes.map(process => process.id), gracefulTimeoutMs);
  const remainingAfterGraceful = await listTargetCursorProcesses(cursorExe);
  await appendLog(logPath, `remaining after graceful close: ${remainingAfterGraceful.map(process => process.id).join(',') || 'none'}`);

  if (remainingAfterGraceful.length > 0) {
    await killProcesses(remainingAfterGraceful.map(process => process.id));
    await waitForNoTargetCursorProcesses(cursorExe, maxWaitAfterKillMs);
  }

  const remaining = await listTargetCursorProcesses(cursorExe);
  if (remaining.length > 0) {
    throw new Error(`Cursor 未完全退出：${remaining.map(process => process.id).join(', ')}`);
  }
}

async function cleanRuntimeStateAfterExit(logPath: string): Promise<void> {
  const statePath = resolveRuntimeStatePath();
  if (!(await fileExists(statePath))) {
    await appendLog(logPath, `state.vscdb not found: ${statePath}`);
    return;
  }

  const db = openRuntimeStateDatabase(statePath, false);
  try {
    const row = db.prepare('SELECT value FROM ItemTable WHERE key = ?').get(applicationUserKey) as RuntimeStateValueRow | undefined;
    const value = valueToText(row?.value);
    const hasNeedle = uiTextNeedles.some(needle => value.includes(needle));
    if (!hasNeedle) {
      await appendLog(logPath, 'runtime state has no target UI text cache');
      return;
    }

    db.exec('BEGIN TRANSACTION');
    const changed = clearComposerModeCache(db, value);
    db.exec('COMMIT');

    if (!changed) {
      await appendLog(logPath, 'runtime state matched text but no safe field changed');
      return;
    }

    await appendLog(logPath, 'runtime state cleaned');
  } catch (error) {
    try {
      db.exec('ROLLBACK');
    } catch {
      // 忽略回滚失败，继续记录原始错误。
    }
    throw error;
  } finally {
    db.close();
  }
}

interface RuntimeStateValueRow {
  readonly value: unknown;
}

async function cleanLanguagePackCacheAfterExit(logPath: string): Promise<void> {
  const result = await cleanLanguagePackCache();
  await appendLog(logPath, `${result.message}${result.changed ? ` backup=${result.backupRoot}` : ''}`);
}

async function launchCursor(cursorExe: string, logPath: string): Promise<void> {
  await appendLog(logPath, `launching Cursor: ${cursorExe}`);
  const env = createCleanCursorLaunchEnv();
  const child = spawn(cursorExe, [], {
    detached: true,
    windowsHide: false,
    stdio: 'ignore',
    cwd: path.dirname(cursorExe),
    env
  });
  child.unref();
}

function createCleanCursorLaunchEnv(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = { ...process.env };
  for (const key of [
    'ELECTRON_RUN_AS_NODE',
    'ELECTRON_NO_ATTACH_CONSOLE',
    'VSCODE_CLI',
    'VSCODE_DEV',
    'VSCODE_HANDLES_UNCAUGHT_ERRORS',
    'VSCODE_CODE_CACHE_PATH',
    'VSCODE_CRASH_REPORTER_PROCESS_TYPE',
    'VSCODE_PID',
    'VSCODE_PORTABLE'
  ]) {
    delete env[key];
  }
  return env;
}

interface ProcessInfo {
  readonly id: number;
  readonly path?: string;
  readonly commandLine?: string;
}

async function listTargetCursorProcesses(cursorExe: string): Promise<ProcessInfo[]> {
  const command = "$items = Get-CimInstance Win32_Process -Filter \"name = 'Cursor.exe'\" | Select-Object ProcessId,ExecutablePath,CommandLine; $items | ConvertTo-Json -Depth 3";
  const output = await runPowerShell(command, 6000);
  if (!output.trim()) {
    return [];
  }

  const parsed = JSON.parse(output) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  const normalizedCursorExe = cursorExe.toLowerCase();
  return values
    .map(value => normalizeProcess(value))
    .filter((value): value is ProcessInfo => Boolean(value))
    .filter(value => (value.path ?? '').toLowerCase() === normalizedCursorExe)
    .filter(value => !(value.commandLine ?? '').includes('runtimeStateRestartHelper.js'));
}

function normalizeProcess(value: unknown): ProcessInfo | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.ProcessId === 'number' ? record.ProcessId : Number(record.ProcessId);
  if (!Number.isFinite(id) || id <= 0) {
    return undefined;
  }

  return {
    id,
    path: typeof record.ExecutablePath === 'string' ? record.ExecutablePath : undefined,
    commandLine: typeof record.CommandLine === 'string' ? record.CommandLine : undefined
  };
}

async function closeProcessesGracefully(processIds: readonly number[]): Promise<void> {
  if (processIds.length === 0) {
    return;
  }

  const idList = processIds.join(',');
  await runPowerShell(`$ids = @(${idList}); $items = Get-Process -Id $ids -ErrorAction SilentlyContinue; foreach ($item in $items) { try { [void]$item.CloseMainWindow() } catch {} }`, 6000);
}

async function killProcesses(processIds: readonly number[]): Promise<void> {
  if (processIds.length === 0) {
    return;
  }

  const idList = processIds.join(',');
  await runPowerShell(`Stop-Process -Id @(${idList}) -Force -ErrorAction SilentlyContinue`, forcedTimeoutMs);
}

async function waitForProcessExit(processIds: readonly number[], timeoutMs: number): Promise<void> {
  if (processIds.length === 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (!(await areProcessesAlive(processIds))) {
      return;
    }
    await delay(300);
  }
}

async function waitForNoTargetCursorProcesses(cursorExe: string, timeoutMs: number): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await listTargetCursorProcesses(cursorExe)).length === 0) {
      return;
    }
    await delay(300);
  }
}

async function areProcessesAlive(processIds: readonly number[]): Promise<boolean> {
  const idList = processIds.join(',');
  const output = await runPowerShell(`$ids = @(${idList}); @(Get-Process -Id $ids -ErrorAction SilentlyContinue).Count`, 4000);
  return Number(output.trim()) > 0;
}

function resolveRuntimeStatePath(): string {
  const appData = process.env.APPDATA;
  if (!appData) {
    throw new Error('未找到 APPDATA，无法定位 state.vscdb');
  }

  return path.join(appData, 'Cursor', 'User', 'globalStorage', 'state.vscdb');
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}

async function runPowerShell(command: string, timeout: number): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}

async function appendLog(logPath: string, message: string): Promise<void> {
  await fs.mkdir(path.dirname(logPath), { recursive: true });
  await fs.appendFile(logPath, `[${new Date().toISOString()}] ${message}\n`, 'utf8');
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

async function delay(ms: number): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, ms));
}

main().catch(async error => {
  const logPath = safeLogPath(process.argv.slice(2));
  if (logPath) {
    await appendLog(logPath, `failed: ${error instanceof Error ? error.stack ?? error.message : String(error)}`);
  }
  process.exitCode = 1;
});

function safeLogPath(args: readonly string[]): string | undefined {
  const index = args.indexOf('--log');
  return index >= 0 ? args[index + 1] : undefined;
}