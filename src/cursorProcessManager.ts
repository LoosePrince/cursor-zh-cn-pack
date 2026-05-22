import { execFile, spawn } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';
import { ProgressCallback, reportProgress } from './progress';

const execFileAsync = promisify(execFile);
const gracefulTimeoutMs = 4500;

export interface CursorProcessInfo {
  readonly id: number;
  readonly name: string;
  readonly path?: string;
}

export interface CursorShutdownResult {
  readonly before: readonly CursorProcessInfo[];
  readonly after: readonly CursorProcessInfo[];
  readonly closedCount: number;
  readonly forcedCount: number;
}

export interface CursorRestartResult extends CursorShutdownResult {
  readonly executablePath: string;
  readonly launchScheduled: boolean;
}

export async function shutdownCursorProcesses(cursorRoot: string, progress?: ProgressCallback): Promise<CursorShutdownResult> {
  const executablePath = await resolveCursorExecutablePath(cursorRoot);
  await reportProgress(progress, { message: '检查当前 Cursor 进程', percent: 5 });
  const before = await listTargetCursorProcesses(executablePath);

  if (before.length === 0) {
    await reportProgress(progress, { message: '没有发现需要关闭的 Cursor 进程', percent: 100, current: 0, total: 0 });
    return { before, after: [], closedCount: 0, forcedCount: 0 };
  }

  await reportProgress(progress, { message: `请求关闭 ${before.length} 个 Cursor 进程`, percent: 20, current: 0, total: before.length });
  const gracefulIds = await closeProcessesGracefully(before.map(process => process.id));
  await waitForProcessExit(gracefulIds, gracefulTimeoutMs);

  const remainingAfterGraceful = await listTargetCursorProcesses(executablePath);
  await reportProgress(progress, {
    message: remainingAfterGraceful.length ? `仍有 ${remainingAfterGraceful.length} 个进程未退出，准备强制关闭` : 'Cursor 进程已正常退出',
    percent: 65,
    current: before.length - remainingAfterGraceful.length,
    total: before.length
  });

  if (remainingAfterGraceful.length > 0) {
    await killProcesses(remainingAfterGraceful.map(process => process.id));
    await waitForProcessExit(remainingAfterGraceful.map(process => process.id), 2500);
  }

  const after = await listTargetCursorProcesses(executablePath);
  const forcedCount = remainingAfterGraceful.length;
  await reportProgress(progress, {
    message: after.length ? `仍有 ${after.length} 个 Cursor 进程未关闭` : 'Cursor 已完全关闭',
    percent: 100,
    current: before.length - after.length,
    total: before.length
  });

  return {
    before,
    after,
    closedCount: before.length - after.length,
    forcedCount
  };
}

export async function restartCursorProcesses(cursorRoot: string, progress?: ProgressCallback): Promise<CursorRestartResult> {
  const executablePath = await resolveCursorExecutablePath(cursorRoot);
  await reportProgress(progress, { message: '准备关闭并重新启动 Cursor', percent: 0 });
  const shutdown = await shutdownCursorProcesses(cursorRoot, progress);

  if (shutdown.after.length > 0) {
    throw new Error(`仍有 ${shutdown.after.length} 个 Cursor 进程未关闭，已取消自动重启。`);
  }

  await reportProgress(progress, { message: '安排重新启动 Cursor', percent: 96 });
  scheduleCursorLaunch(executablePath);
  await reportProgress(progress, { message: 'Cursor 重启已触发', percent: 100 });

  return {
    ...shutdown,
    executablePath,
    launchScheduled: true
  };
}

export async function resolveCursorExecutablePath(cursorRoot: string): Promise<string> {
  const candidate = path.join(path.resolve(cursorRoot), 'Cursor.exe');
  try {
    const stat = await fs.stat(candidate);
    if (stat.isFile()) {
      return candidate;
    }
  } catch {
    // 继续抛出更明确的错误。
  }

  throw new Error(`未找到 Cursor.exe: ${candidate}`);
}

async function listTargetCursorProcesses(executablePath: string): Promise<CursorProcessInfo[]> {
  if (process.platform !== 'win32') {
    throw new Error('当前一键关闭/重启只支持 Windows 版 Cursor。');
  }

  const normalizedExecutablePath = executablePath.toLowerCase();
  const command = "$items = Get-CimInstance Win32_Process -Filter \"name = 'Cursor.exe'\" | Select-Object ProcessId,Name,ExecutablePath; $items | ConvertTo-Json -Depth 3";
  const lines = await runPowerShell(command, 5000);
  if (!lines.trim()) {
    return [];
  }

  const parsed = JSON.parse(lines) as unknown;
  const values = Array.isArray(parsed) ? parsed : [parsed];
  return values
    .map(value => normalizeProcessInfo(value))
    .filter((value): value is CursorProcessInfo => Boolean(value))
    .filter(value => (value.path ?? '').toLowerCase() === normalizedExecutablePath);
}

function normalizeProcessInfo(value: unknown): CursorProcessInfo | undefined {
  if (!value || typeof value !== 'object') {
    return undefined;
  }

  const record = value as Record<string, unknown>;
  const id = typeof record.ProcessId === 'number' ? record.ProcessId : Number(record.ProcessId);
  const name = typeof record.Name === 'string' ? record.Name : 'Cursor.exe';
  const executablePath = typeof record.ExecutablePath === 'string' ? record.ExecutablePath : undefined;

  if (!Number.isFinite(id) || id <= 0) {
    return undefined;
  }

  return {
    id,
    name,
    path: executablePath
  };
}

async function closeProcessesGracefully(processIds: readonly number[]): Promise<number[]> {
  if (processIds.length === 0) {
    return [];
  }

  const idList = processIds.join(',');
  const command = `$ids = @(${idList}); $items = Get-Process -Id $ids -ErrorAction SilentlyContinue; foreach ($item in $items) { try { [void]$item.CloseMainWindow() } catch {} }; $items | Select-Object -ExpandProperty Id`;
  const output = await runPowerShell(command, 5000);
  return output
    .split(/\r?\n/g)
    .map(line => Number(line.trim()))
    .filter(value => Number.isFinite(value));
}

async function killProcesses(processIds: readonly number[]): Promise<void> {
  if (processIds.length === 0) {
    return;
  }

  const idList = processIds.join(',');
  await runPowerShell(`Stop-Process -Id @(${idList}) -Force -ErrorAction SilentlyContinue`, 5000);
}

async function waitForProcessExit(processIds: readonly number[], timeoutMs: number): Promise<void> {
  if (processIds.length === 0) {
    return;
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const alive = await areProcessesAlive(processIds);
    if (!alive) {
      return;
    }

    await new Promise(resolve => setTimeout(resolve, 300));
  }
}

async function areProcessesAlive(processIds: readonly number[]): Promise<boolean> {
  const idList = processIds.join(',');
  const output = await runPowerShell(`$ids = @(${idList}); @(Get-Process -Id $ids -ErrorAction SilentlyContinue).Count`, 3000);
  return Number(output.trim()) > 0;
}

function scheduleCursorLaunch(executablePath: string): void {
  const command = `ping 127.0.0.1 -n 3 > nul & start "" "${executablePath.replace(/"/g, '""')}"`;
  const child = spawn('cmd.exe', ['/d', '/s', '/c', command], {
    detached: true,
    windowsHide: true,
    stdio: 'ignore'
  });
  child.unref();
}

async function runPowerShell(command: string, timeout: number): Promise<string> {
  const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
    timeout,
    windowsHide: true,
    maxBuffer: 1024 * 1024
  });
  return stdout;
}