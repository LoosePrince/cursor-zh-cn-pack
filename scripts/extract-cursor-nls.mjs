import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const cursorRootInput = process.argv[2] || process.env.CURSOR_ROOT || 'D:\\cursor';
const cursorRoot = path.resolve(cursorRootInput);

const extractConfig = await readJson(path.join(projectRoot, 'data', 'nls-extract-config.json'));
const exactTranslations = new Map(Object.entries(await readJson(path.join(projectRoot, 'data', 'nls-exact-translations.json'))));
const unitTranslations = await readJson(path.join(projectRoot, 'data', 'nls-unit-translations.json'));
const languagePackHeader = Array.isArray(extractConfig.languagePackHeader)
  ? extractConfig.languagePackHeader
  : ['Generated for Cursor-specific resources by cursor-zh-cn-pack.'];
const preferredExtensionOrder = Array.isArray(extractConfig.preferredExtensionOrder)
  ? extractConfig.preferredExtensionOrder
  : [];
const cursorExtensionIdPrefixes = Array.isArray(extractConfig.cursorExtensionIdPrefixes)
  ? extractConfig.cursorExtensionIdPrefixes
  : ['anysphere.cursor-'];
const cursorExtensionIds = new Set(Array.isArray(extractConfig.cursorExtensionIds) ? extractConfig.cursorExtensionIds : []);
const relativeTimePattern = buildPlaceholderUnitPattern(unitTranslations.relativeTime, ' ago');
const durationPattern = buildPlaceholderUnitPattern(unitTranslations.duration, '');

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function deleteIfExists(filePath) {
  try {
    await fs.rm(filePath, { force: true, recursive: true });
  } catch (error) {
    if (error?.code !== 'ENOENT') {
      throw error;
    }
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function wrapLanguagePackContents(contents) {
  return {
    '': languagePackHeader,
    version: '1.0.0',
    contents
  };
}

function buildPlaceholderUnitPattern(translations, suffix) {
  const units = Object.keys(translations || {});
  if (!units.length) {
    return undefined;
  }

  return new RegExp(`^\\{0\\} (${units.map(escapeRegExp).join('|')})${escapeRegExp(suffix)}$`);
}

function escapeRegExp(value) {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isCursorExtensionId(id) {
  return cursorExtensionIds.has(id) || cursorExtensionIdPrefixes.some((prefix) => id.startsWith(prefix));
}

function translateString(value) {
  if (typeof value !== 'string') {
    return value;
  }

  const direct = exactTranslations.get(value);
  if (direct) {
    return direct;
  }

  const fromNow = relativeTimePattern?.exec(value);
  if (fromNow) {
    return `{0} ${unitTranslations.relativeTime[fromNow[1]]}前`;
  }

  const duration = durationPattern?.exec(value);
  if (duration) {
    return `{0} ${unitTranslations.duration[duration[1]]}`;
  }

  return value;
}

function translateObject(value) {
  if (typeof value === 'string') {
    return translateString(value);
  }
  if (Array.isArray(value)) {
    return value.map(translateObject);
  }
  if (value && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([key, nested]) => [key, translateObject(nested)]));
  }
  return value;
}

function countStrings(value) {
  if (typeof value === 'string') return 1;
  if (Array.isArray(value)) return value.reduce((sum, item) => sum + countStrings(item), 0);
  if (value && typeof value === 'object') return Object.values(value).reduce((sum, item) => sum + countStrings(item), 0);
  return 0;
}

function countChangedStrings(original, translated) {
  if (typeof original === 'string' && typeof translated === 'string') {
    return original === translated ? 0 : 1;
  }
  if (Array.isArray(original) && Array.isArray(translated)) {
    return original.reduce((sum, item, index) => sum + countChangedStrings(item, translated[index]), 0);
  }
  if (original && translated && typeof original === 'object' && typeof translated === 'object') {
    return Object.keys(original).reduce((sum, key) => sum + countChangedStrings(original[key], translated[key]), 0);
  }
  return 0;
}

async function resolveAppDir() {
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

async function cleanupGeneratedTranslations() {
  const translationsDir = path.join(projectRoot, 'translations');
  const extensionTranslationsDir = path.join(translationsDir, 'extensions');

  await deleteIfExists(path.join(translationsDir, 'main.i18n.json'));

  if (!(await exists(extensionTranslationsDir))) {
    return;
  }

  const entries = await fs.readdir(extensionTranslationsDir, { withFileTypes: true });
  for (const entry of entries) {
    if (!entry.isFile() || !entry.name.endsWith('.i18n.json')) {
      continue;
    }

    const id = entry.name.slice(0, -'.i18n.json'.length);
    if (!isCursorExtensionId(id)) {
      await deleteIfExists(path.join(extensionTranslationsDir, entry.name));
    }
  }
}

async function listPackageNlsFiles(extensionsDir) {
  const entries = await fs.readdir(extensionsDir, { withFileTypes: true });
  const result = [];

  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const extDir = path.join(extensionsDir, entry.name);
    const nlsPath = path.join(extDir, 'package.nls.json');
    const packagePath = path.join(extDir, 'package.json');
    if ((await exists(nlsPath)) && (await exists(packagePath))) {
      result.push({ extDir, nlsPath, packagePath });
    }
  }

  return result;
}

async function buildExtensionBundles(appDir) {
  const extensionsDir = path.join(appDir, 'extensions');
  const files = await listPackageNlsFiles(extensionsDir);
  const generated = [];
  const skipped = [];
  const untranslated = [];
  let total = 0;
  let translated = 0;

  for (const file of files) {
    const manifest = await readJson(file.packagePath);
    const publisher = manifest.publisher || 'vscode';
    const name = manifest.name || path.basename(file.extDir);
    const id = `${publisher}.${name}`;

    if (!isCursorExtensionId(id)) {
      skipped.push(id);
      continue;
    }

    const packageNls = await readJson(file.nlsPath);
    const localizedPackage = translateObject(packageNls);

    const keyTotal = countStrings(packageNls);
    const keyTranslated = countChangedStrings(packageNls, localizedPackage);
    total += keyTotal;
    translated += keyTranslated;

    for (const [key, original] of Object.entries(packageNls)) {
      const localized = localizedPackage[key];
      if (typeof original === 'string' && localized === original && /[A-Za-z]{3}/.test(original)) {
        untranslated.push({ extension: id, key, message: original });
      }
    }

    const relPath = `./translations/extensions/${id}.i18n.json`;
    const outPath = path.join(projectRoot, 'translations', 'extensions', `${id}.i18n.json`);

    await writeJson(outPath, wrapLanguagePackContents({ package: localizedPackage }));
    generated.push({ id, path: relPath, total: keyTotal, translated: keyTranslated });
  }

  generated.sort((a, b) => {
    const preferredA = preferredExtensionOrder.indexOf(a.id);
    const preferredB = preferredExtensionOrder.indexOf(b.id);
    if (preferredA !== -1 || preferredB !== -1) {
      return (preferredA === -1 ? 999 : preferredA) - (preferredB === -1 ? 999 : preferredB);
    }
    return a.id.localeCompare(b.id);
  });

  skipped.sort((a, b) => a.localeCompare(b));

  return { generated, skipped, total, translated, localTranslated: translated, untranslated };
}

async function updateManifest(extensionTranslations) {
  const manifestPath = path.join(projectRoot, 'package.json');
  const manifest = await readJson(manifestPath);
  const localization = manifest.contributes.localizations[0];

  localization.translations = extensionTranslations.map(({ id, path: translationPath }) => ({ id, path: translationPath }));

  await writeJson(manifestPath, manifest);
}

async function scanHardcodedCandidates(appDir) {
  const workbenchPath = path.join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  if (!(await exists(workbenchPath))) return [];

  const source = await fs.readFile(workbenchPath, 'utf8');
  const needles = await readJson(path.join(projectRoot, 'data', 'workbench-hardcoded-needles.json'));

  return needles
    .map((needle) => ({ needle, occurrences: source.split(needle).length - 1 }))
    .filter((item) => item.occurrences > 0);
}

function percentage(translated, total) {
  if (!total) return '0.00%';
  return `${((translated / total) * 100).toFixed(2)}%`;
}

async function writeReports({ appDir, extensionStats, hardcodedCandidates }) {
  const reportsDir = path.join(projectRoot, 'reports');
  await fs.mkdir(reportsDir, { recursive: true });

  await deleteIfExists(path.join(reportsDir, 'coverage-report.md'));
  await deleteIfExists(path.join(reportsDir, 'untranslated-main.json'));
  await writeJson(path.join(reportsDir, 'untranslated-extensions.json'), extensionStats.untranslated.slice(0, 2000));
}

async function main() {
  const appDir = await resolveAppDir();

  await cleanupGeneratedTranslations();

  const extensionStats = await buildExtensionBundles(appDir);
  await updateManifest(extensionStats.generated);

  const hardcodedCandidates = await scanHardcodedCandidates(appDir);
  await writeReports({ appDir, extensionStats, hardcodedCandidates });

  console.log(`Cursor 专用扩展：${extensionStats.translated}/${extensionStats.total} (${percentage(extensionStats.translated, extensionStats.total)})`);
  console.log(`生成 Cursor 专用扩展翻译文件：${extensionStats.generated.length} 个`);
  console.log(`跳过官方/通用内置扩展翻译文件：${extensionStats.skipped.length} 个`);
  console.log(`报告：${path.join(projectRoot, 'reports', 'coverage-report.md')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});