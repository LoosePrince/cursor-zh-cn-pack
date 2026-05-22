import * as fs from 'fs/promises';
import * as path from 'path';
import * as vscode from 'vscode';
import { createScopedProgress, ProgressCallback, reportProgress, toPercent, yieldToEventLoop } from './progress';

interface ExtractConfig {
  readonly preferredExtensionOrder?: readonly string[];
  readonly cursorExtensionIdPrefixes?: readonly string[];
  readonly cursorExtensionIds?: readonly string[];
}

interface ExtensionTranslationBundle {
  readonly id: string;
  readonly package: Record<string, unknown>;
}

interface ExtensionCoverageItem {
  readonly id: string;
  readonly total: number;
  readonly translated: number;
}

interface CoverageReportData {
  readonly appDir: string;
  readonly cursorRoot: string;
  readonly generatedAt: string;
  readonly translated: number;
  readonly total: number;
  readonly generatedCount: number;
  readonly skippedCount: number;
  readonly extensionItems: readonly ExtensionCoverageItem[];
  readonly untranslatedSamples: readonly { extension: string; key: string; message: string }[];
  readonly hardcodedCandidates: readonly { needle: string; occurrences: number }[];
}

const projectRoot = path.resolve(__dirname, '..');
const extractConfigPath = path.join(projectRoot, 'data', 'nls-extract-config.json');
const hardcodedNeedlesPath = path.join(projectRoot, 'data', 'workbench-hardcoded-needles.json');
const manifestPath = path.join(projectRoot, 'package.json');
const reportsDirName = 'reports';
const dynamicCoverageReportName = 'coverage-report.generated.md';

export async function generateCoverageReport(
  cursorRoot: string,
  context: vscode.ExtensionContext,
  progress?: ProgressCallback
): Promise<string> {
  await reportProgress(progress, { message: '读取提取配置', percent: 5 });
  const extractConfig = await readJson<ExtractConfig>(extractConfigPath);
  const cursorExtensionIdPrefixes = Array.isArray(extractConfig.cursorExtensionIdPrefixes)
    ? extractConfig.cursorExtensionIdPrefixes
    : ['anysphere.cursor-'];
  const cursorExtensionIds = new Set<string>(
    Array.isArray(extractConfig.cursorExtensionIds)
      ? extractConfig.cursorExtensionIds.filter((item): item is string => typeof item === 'string')
      : []
  );
  const preferredExtensionOrder = Array.isArray(extractConfig.preferredExtensionOrder)
    ? extractConfig.preferredExtensionOrder.filter((item): item is string => typeof item === 'string')
    : [];

  const appDir = await resolveAppDir(cursorRoot);
  await reportProgress(progress, { message: '扫描扩展目录', percent: 12 });
  const coverageData = await buildCoverageData(
    appDir,
    cursorRoot,
    cursorExtensionIdPrefixes,
    cursorExtensionIds,
    preferredExtensionOrder,
    createScopedProgress(progress, 12, 88, '统计覆盖情况')
  );

  const reportContents = renderCoverageReport(coverageData);
  const reportDir = path.join(context.globalStorageUri.fsPath, reportsDirName);
  await fs.mkdir(reportDir, { recursive: true });
  const reportPath = path.join(reportDir, dynamicCoverageReportName);

  await reportProgress(progress, { message: '写入动态覆盖报告', percent: 94 });
  await fs.writeFile(reportPath, reportContents, 'utf8');

  const untranslatedPath = path.join(reportDir, 'untranslated-extensions.generated.json');
  await fs.writeFile(untranslatedPath, `${JSON.stringify(coverageData.untranslatedSamples, null, 2)}\n`, 'utf8');
  await reportProgress(progress, { message: '动态覆盖报告已生成', percent: 100 });
  return reportPath;
}

async function buildCoverageData(
  appDir: string,
  cursorRoot: string,
  cursorExtensionIdPrefixes: readonly string[],
  cursorExtensionIds: ReadonlySet<string>,
  preferredExtensionOrder: readonly string[],
  progress?: ProgressCallback
): Promise<CoverageReportData> {
  const translationsById = await loadPackagedTranslations();
  const extensionFiles = await listPackageNlsFiles(path.join(appDir, 'extensions'));
  const hardcodedCandidates = await scanHardcodedCandidates(appDir);

  let translated = 0;
  let total = 0;
  let skippedCount = 0;
  const extensionItems: ExtensionCoverageItem[] = [];
  const untranslatedSamples: { extension: string; key: string; message: string }[] = [];

  await reportProgress(progress, {
    message: '开始统计 Cursor 专用扩展',
    percent: 0,
    current: 0,
    total: extensionFiles.length
  });

  for (let index = 0; index < extensionFiles.length; index += 1) {
    const file = extensionFiles[index];
    const manifest = await readJson<Record<string, unknown>>(file.packagePath);
    const publisher = typeof manifest.publisher === 'string' ? manifest.publisher : 'vscode';
    const name = typeof manifest.name === 'string' ? manifest.name : path.basename(file.extDir);
    const id = `${publisher}.${name}`;

    if (!isCursorExtensionId(id, cursorExtensionIdPrefixes, cursorExtensionIds)) {
      skippedCount += 1;
      continue;
    }

    const packageNls = await readJson<Record<string, unknown>>(file.nlsPath);
    const localizedPackage = translationsById.get(id)?.package ?? {};
    const itemTotal = countStrings(packageNls);
    const itemTranslated = countTranslatedStrings(packageNls, localizedPackage);
    translated += itemTranslated;
    total += itemTotal;

    extensionItems.push({ id, total: itemTotal, translated: itemTranslated });

    for (const [key, original] of Object.entries(packageNls)) {
      const localized = localizedPackage[key];
      if (typeof original === 'string' && original === localized && /[A-Za-z]{3}/.test(original)) {
        untranslatedSamples.push({ extension: id, key, message: original });
      }
    }

    if ((index + 1) % 10 === 0 || index + 1 === extensionFiles.length) {
      await reportProgress(progress, {
        message: `已统计 ${index + 1}/${extensionFiles.length} 个扩展目录`,
        percent: toPercent(index + 1, extensionFiles.length),
        current: index + 1,
        total: extensionFiles.length
      });
      await yieldToEventLoop();
    }
  }

  extensionItems.sort((left, right) => {
    const preferredLeft = preferredExtensionOrder.indexOf(left.id);
    const preferredRight = preferredExtensionOrder.indexOf(right.id);
    if (preferredLeft !== -1 || preferredRight !== -1) {
      return (preferredLeft === -1 ? 999 : preferredLeft) - (preferredRight === -1 ? 999 : preferredRight);
    }
    return left.id.localeCompare(right.id);
  });

  return {
    appDir,
    cursorRoot,
    generatedAt: new Date().toISOString(),
    translated,
    total,
    generatedCount: extensionItems.length,
    skippedCount,
    extensionItems,
    untranslatedSamples: untranslatedSamples.slice(0, 2000),
    hardcodedCandidates
  };
}

async function loadPackagedTranslations(): Promise<Map<string, ExtensionTranslationBundle>> {
  const manifest = await readJson<Record<string, unknown>>(manifestPath);
  const contributes = asRecord(manifest.contributes);
  const localizations = Array.isArray(contributes?.localizations) ? contributes.localizations : [];

  let translationsValue: unknown = undefined;
  for (const item of localizations) {
    const record = asRecord(item);
    if (record?.languageId === 'zh-cn') {
      translationsValue = record.translations;
      break;
    }
  }

  const translations = Array.isArray(translationsValue) ? translationsValue : [];
  const result = new Map<string, ExtensionTranslationBundle>();

  for (const item of translations) {
    const record = asRecord(item);
    const id = typeof record?.id === 'string' ? record.id : undefined;
    const translationPath = typeof record?.path === 'string' ? record.path : undefined;
    if (!id || !translationPath) {
      continue;
    }

    const absolutePath = path.resolve(projectRoot, translationPath.replace(/^\.\//, ''));
    try {
      const value = await readJson<Record<string, unknown>>(absolutePath);
      const contents = asRecord(value.contents);
      const packageContents = asRecord(contents?.package) ?? {};
      result.set(id, { id, package: packageContents });
    } catch {
      result.set(id, { id, package: {} });
    }
  }

  return result;
}

async function resolveAppDir(cursorRoot: string): Promise<string> {
  const directExtensions = path.join(cursorRoot, 'extensions');
  if (await exists(directExtensions)) {
    return cursorRoot;
  }

  const appDir = path.join(cursorRoot, 'resources', 'app');
  const nestedExtensions = path.join(appDir, 'extensions');
  if (await exists(nestedExtensions)) {
    return appDir;
  }

  throw new Error(`没有找到 Cursor 扩展目录：${directExtensions} 或 ${nestedExtensions}`);
}

async function listPackageNlsFiles(
  extensionsDir: string
): Promise<readonly { extDir: string; nlsPath: string; packagePath: string }[]> {
  const entries = await fs.readdir(extensionsDir, { withFileTypes: true });
  const result: { extDir: string; nlsPath: string; packagePath: string }[] = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) {
      continue;
    }

    const extDir = path.join(extensionsDir, entry.name);
    const nlsPath = path.join(extDir, 'package.nls.json');
    const packagePath = path.join(extDir, 'package.json');
    if ((await exists(nlsPath)) && (await exists(packagePath))) {
      result.push({ extDir, nlsPath, packagePath });
    }
  }

  return result;
}

async function scanHardcodedCandidates(appDir: string): Promise<readonly { needle: string; occurrences: number }[]> {
  const workbenchPath = path.join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  if (!(await exists(workbenchPath))) {
    return [];
  }

  const needlesValue = await readJson<unknown>(hardcodedNeedlesPath);
  const needles = Array.isArray(needlesValue)
    ? needlesValue.filter((needle): needle is string => typeof needle === 'string' && needle.length > 0)
    : [];
  const source = await fs.readFile(workbenchPath, 'utf8');

  return needles
    .map(needle => ({ needle, occurrences: source.split(needle).length - 1 }))
    .filter(item => item.occurrences > 0);
}

function renderCoverageReport(data: CoverageReportData): string {
  const lines = [
    '# Cursor 汉化覆盖率报告（动态生成）',
    '',
    `- 生成时间：\`${data.generatedAt}\``,
    `- Cursor 根目录：\`${data.cursorRoot}\``,
    `- Cursor 应用目录：\`${data.appDir}\``,
    '- 统计口径：基于当前 Cursor 安装中的 `extensions/*/package.nls.json`，以及当前扩展实际打包的 `translations/extensions/*.i18n.json` 实时计算。',
    '- 处理范围：仅 Cursor 专用语言包资源和可选 workbench 补丁。',
    '- VS Code 基础翻译不由本插件生成或打包，应交给 `MS-CEINTL.vscode-language-pack-zh-hans`。',
    `- Cursor 专用扩展字符串：${data.translated}/${data.total}，覆盖率 ${percentage(data.translated, data.total)}`,
    `- 已打包 Cursor 专用扩展翻译文件：${data.generatedCount} 个`,
    `- 跳过官方/通用内置扩展翻译文件：${data.skippedCount} 个`,
    '',
    '## Cursor 专用扩展',
    '',
    '| 扩展 ID | 已翻译 / 总数 |',
    '| --- | ---: |',
    ...data.extensionItems.map(item => `| \`${item.id}\` | ${item.translated}/${item.total} |`),
    '',
    '## 疑似硬编码 Cursor 文案',
    '',
    '这些候选词出现在当前 Cursor 主 bundle 中，不保证能被标准语言包覆盖；可通过 Cursor 汉化管理器中的补丁功能处理高置信度硬编码文案。',
    '',
    '| 片段 | 出现次数 |',
    '| --- | ---: |',
    ...data.hardcodedCandidates.map(item => `| \`${item.needle}\` | ${item.occurrences} |`),
    '',
    '## 后续翻译输入',
    '',
    '- 当前安装中仍未翻译的 Cursor 专用扩展样本会同时写入扩展全局存储下的 `reports/untranslated-extensions.generated.json`。'
  ];

  return `${lines.join('\n')}\n`;
}

function countStrings(value: unknown): number {
  if (typeof value === 'string') {
    return 1;
  }
  if (Array.isArray(value)) {
    return value.reduce((sum, item) => sum + countStrings(item), 0);
  }
  if (value && typeof value === 'object') {
    return Object.values(value).reduce((sum, item) => sum + countStrings(item), 0);
  }
  return 0;
}

function countTranslatedStrings(original: unknown, localized: unknown): number {
  if (typeof original === 'string') {
    return typeof localized === 'string' && localized !== original ? 1 : 0;
  }
  if (Array.isArray(original)) {
    return original.reduce(
      (sum, item, index) => sum + countTranslatedStrings(item, Array.isArray(localized) ? localized[index] : undefined),
      0
    );
  }
  if (original && typeof original === 'object') {
    const localizedRecord = asRecord(localized) ?? {};
    return Object.entries(original).reduce((sum, [key, item]) => sum + countTranslatedStrings(item, localizedRecord[key]), 0);
  }
  return 0;
}

function percentage(translated: number, total: number): string {
  if (!total) {
    return '0.00%';
  }
  return `${((translated / total) * 100).toFixed(2)}%`;
}

function isCursorExtensionId(id: string, prefixes: readonly string[], ids: ReadonlySet<string>): boolean {
  return ids.has(id) || prefixes.some(prefix => id.startsWith(prefix));
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await fs.readFile(filePath, 'utf8')) as T;
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined;
}