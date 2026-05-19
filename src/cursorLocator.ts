import { execFile } from 'child_process';
import * as fs from 'fs/promises';
import * as path from 'path';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

export interface CursorInstallPaths {
  readonly appPackagePath: string;
  readonly nlsKeysPath: string;
  readonly nlsMessagesPath: string;
  readonly workbenchPath: string;
}

export interface CursorInstall extends CursorInstallPaths {
  readonly root: string;
  readonly source: string;
  readonly version?: string;
  readonly valid: boolean;
  readonly problems: readonly string[];
}

export interface LocateCursorResult {
  readonly install?: CursorInstall;
  readonly candidates: readonly CursorInstall[];
}

interface Candidate {
  readonly root: string;
  readonly source: string;
}

export async function locateCursorInstall(savedRoot?: string): Promise<LocateCursorResult> {
  const candidates: Candidate[] = [];

  if (savedRoot?.trim()) {
    candidates.push({ root: savedRoot.trim(), source: '已保存配置' });
  }

  for (const processPath of await getRunningCursorProcessPaths()) {
    candidates.push({ root: processPath, source: '正在运行的 Cursor.exe' });
  }

  for (const pathCandidate of getPathCandidates()) {
    candidates.push(pathCandidate);
  }

  for (const registryCandidate of await getRegistryCandidates()) {
    candidates.push(registryCandidate);
  }

  for (const commonPath of getCommonInstallPaths()) {
    candidates.push({ root: commonPath, source: '常见安装路径' });
  }

  const validated = await validateCandidates(candidates);
  return {
    install: validated.find(candidate => candidate.valid),
    candidates: validated
  };
}

export async function validateCursorRoot(root: string, source = '手动选择'): Promise<CursorInstall> {
  const normalizedRoot = path.resolve(root.trim());
  const paths = getCursorPaths(normalizedRoot);
  const problems: string[] = [];

  for (const [label, filePath] of [
    ['Cursor package.json', paths.appPackagePath],
    ['nls.keys.json', paths.nlsKeysPath],
    ['nls.messages.json', paths.nlsMessagesPath],
    ['workbench.desktop.main.js', paths.workbenchPath]
  ] as const) {
    if (!await fileExists(filePath)) {
      problems.push(`缺少 ${label}: ${filePath}`);
    }
  }

  return {
    root: normalizedRoot,
    source,
    version: await readCursorVersion(paths.appPackagePath),
    valid: problems.length === 0,
    problems,
    ...paths
  };
}

export async function resolveCursorRoot(input: string, source = '候选路径'): Promise<CursorInstall | undefined> {
  for (const root of expandPossibleRoots(input)) {
    const install = await validateCursorRoot(root, source);
    if (install.valid) {
      return install;
    }
  }

  return undefined;
}

export function getCursorPaths(root: string): CursorInstallPaths {
  const appRoot = path.join(root, 'resources', 'app');
  return {
    appPackagePath: path.join(appRoot, 'package.json'),
    nlsKeysPath: path.join(appRoot, 'out', 'nls.keys.json'),
    nlsMessagesPath: path.join(appRoot, 'out', 'nls.messages.json'),
    workbenchPath: path.join(appRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js')
  };
}

async function validateCandidates(candidates: readonly Candidate[]): Promise<CursorInstall[]> {
  const seen = new Set<string>();
  const validated: CursorInstall[] = [];

  for (const candidate of candidates) {
    for (const root of expandPossibleRoots(candidate.root)) {
      const key = root.toLowerCase();
      if (seen.has(key)) {
        continue;
      }

      seen.add(key);
      validated.push(await validateCursorRoot(root, candidate.source));
      if (validated[validated.length - 1].valid) {
        break;
      }
    }
  }

  return validated;
}

function expandPossibleRoots(input: string): string[] {
  const roots: string[] = [];
  const push = (value: string) => {
    const normalized = path.resolve(stripExecutableArguments(value));
    if (!roots.some(existing => existing.toLowerCase() === normalized.toLowerCase())) {
      roots.push(normalized);
    }
  };

  push(input);

  const lower = input.toLowerCase();
  if (lower.endsWith('.exe') || lower.endsWith('.cmd') || lower.endsWith('.bat')) {
    push(path.dirname(input));
  }

  let current = path.resolve(stripExecutableArguments(input));
  for (let i = 0; i < 8; i++) {
    push(current);
    const parent = path.dirname(current);
    if (parent === current) {
      break;
    }
    current = parent;
  }

  return roots;
}

function getPathCandidates(): Candidate[] {
  const values = (process.env.PATH ?? '').split(path.delimiter).filter(Boolean);
  const candidates: Candidate[] = [];

  for (const directory of values) {
    candidates.push({ root: path.join(directory, 'cursor.cmd'), source: 'PATH 中的 cursor.cmd' });
    candidates.push({ root: path.join(directory, 'Cursor.exe'), source: 'PATH 中的 Cursor.exe' });
  }

  return candidates;
}

function getCommonInstallPaths(): string[] {
  const paths = [
    process.env.LOCALAPPDATA ? path.join(process.env.LOCALAPPDATA, 'Programs', 'Cursor') : undefined,
    process.env.PROGRAMFILES ? path.join(process.env.PROGRAMFILES, 'Cursor') : undefined,
    process.env['ProgramFiles(x86)'] ? path.join(process.env['ProgramFiles(x86)'], 'Cursor') : undefined,
    'C:\\cursor',
    'D:\\cursor',
    'E:\\cursor'
  ];

  return paths.filter((value): value is string => Boolean(value));
}

async function getRunningCursorProcessPaths(): Promise<string[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  const command = "Get-CimInstance Win32_Process -Filter \"name = 'Cursor.exe'\" | Select-Object -ExpandProperty ExecutablePath | Sort-Object -Unique";
  return await runPowerShellLines(command, 4000);
}

async function getRegistryCandidates(): Promise<Candidate[]> {
  if (process.platform !== 'win32') {
    return [];
  }

  const command = "$keys = 'HKCU:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*','HKLM:\\Software\\WOW6432Node\\Microsoft\\Windows\\CurrentVersion\\Uninstall\\*'; Get-ItemProperty $keys -ErrorAction SilentlyContinue | Where-Object { $_.DisplayName -like '*Cursor*' } | ForEach-Object { $_.InstallLocation; $_.DisplayIcon; $_.UninstallString }";
  const lines = await runPowerShellLines(command, 5000);
  return lines.map(root => ({ root, source: '注册表卸载项' }));
}

async function runPowerShellLines(command: string, timeout: number): Promise<string[]> {
  try {
    const { stdout } = await execFileAsync('powershell.exe', ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', command], {
      timeout,
      windowsHide: true,
      maxBuffer: 1024 * 1024
    });

    return stdout
      .split(/\r?\n/g)
      .map(line => line.trim())
      .filter(Boolean);
  } catch {
    return [];
  }
}

function stripExecutableArguments(value: string): string {
  let result = value.trim();

  if (result.startsWith('"')) {
    const end = result.indexOf('"', 1);
    if (end > 0) {
      result = result.slice(1, end);
    }
  }

  result = result.replace(/^'([^']+)'.*$/, '$1');
  result = result.replace(/^"([^"]+)".*$/, '$1');
  result = result.replace(/,\d+$/, '');

  if (/\.exe\s+/i.test(result)) {
    result = result.replace(/^(.*?\.exe)\s+.*$/i, '$1');
  }

  return result;
}

async function readCursorVersion(packageJsonPath: string): Promise<string | undefined> {
  try {
    const raw = await fs.readFile(packageJsonPath, 'utf8');
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === 'string' ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

async function fileExists(filePath: string): Promise<boolean> {
  try {
    const stat = await fs.stat(filePath);
    return stat.isFile();
  } catch {
    return false;
  }
}