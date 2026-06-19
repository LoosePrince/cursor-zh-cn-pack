import fs from 'node:fs/promises';
import path from 'node:path';

export async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

export async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

export async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

export async function resolveWorkbenchPath(cursorRootInput) {
  const cursorRoot = path.resolve(cursorRootInput);
  const directWorkbench = path.join(cursorRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  if (await exists(directWorkbench)) {
    return { appDir: cursorRoot, workbenchPath: directWorkbench };
  }

  const appDir = path.join(cursorRoot, 'resources', 'app');
  const nestedWorkbench = path.join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  if (await exists(nestedWorkbench)) {
    return { appDir, workbenchPath: nestedWorkbench };
  }

  throw new Error(`没有找到 workbench.desktop.main.js：${directWorkbench} 或 ${nestedWorkbench}`);
}

export function decodeJsString(raw) {
  const jsonReady = raw
    .replace(/"/g, '\\"')
    .replace(/\\'/g, "'")
    .replace(/\\`/g, '`')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex) => `\\u00${hex}`)
    .replace(/\\0(?![0-9])/g, '\\u0000')
    .replace(/\\\r?\n/g, '');

  return JSON.parse(`"${jsonReady}"`);
}

export function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

export function hasEnglishText(value) {
  return /[A-Za-z]{2}/.test(value);
}

export function hasCjkText(value) {
  return /[\u3400-\u9fff]/.test(value);
}

export function compilePatterns(patterns) {
  return (patterns || []).map((pattern) => new RegExp(pattern, 'u'));
}

export function compileContextTags(tags) {
  return (tags || [])
    .filter((tag) => tag && typeof tag.id === 'string' && Array.isArray(tag.patterns))
    .map((tag) => ({
      id: tag.id,
      label: typeof tag.label === 'string' ? tag.label : tag.id,
      patterns: compilePatterns(tag.patterns)
    }));
}

export function contextTagsFor(value, tagDefinitions) {
  return tagDefinitions
    .filter((tag) => tag.patterns.some((pattern) => pattern.test(value)))
    .map((tag) => tag.id);
}

export function buildLineStarts(source) {
  const starts = [0];

  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }

  return starts;
}

export function lineColumnAt(lineStarts, index) {
  let low = 0;
  let high = lineStarts.length - 1;

  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (lineStarts[middle] <= index) {
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }

  const lineIndex = Math.max(0, high);
  return {
    line: lineIndex + 1,
    column: index - lineStarts[lineIndex] + 1
  };
}

export function contextAt(source, index, length, surroundingChars) {
  const start = Math.max(0, index - surroundingChars);
  const end = Math.min(source.length, index + length + surroundingChars);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}

export function slugifyId(value) {
  return normalizeText(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 48) || 'text';
}

export function countOccurrences(source, needle) {
  if (!needle) return 0;
  let count = 0;
  let index = 0;
  while ((index = source.indexOf(needle, index)) !== -1) {
    count += 1;
    index += Math.max(needle.length, 1);
  }
  return count;
}
