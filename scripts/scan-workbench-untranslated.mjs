import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const cursorRootInput = process.argv[2] || process.env.CURSOR_ROOT || 'D:\\cursor';
const cursorRoot = path.resolve(cursorRootInput);
const reportsDir = path.join(projectRoot, 'reports');
const configPath = path.join(projectRoot, 'data', 'workbench-untranslated-scan-config.json');
const patchesPath = path.join(projectRoot, 'data', 'workbench-patches.json');
const needlesPath = path.join(projectRoot, 'data', 'workbench-hardcoded-needles.json');

async function exists(filePath) {
  try {
    await fs.access(filePath);
    return true;
  } catch {
    return false;
  }
}

async function readJson(filePath) {
  return JSON.parse(await fs.readFile(filePath, 'utf8'));
}

async function writeJson(filePath, value) {
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

async function resolveAppDir() {
  const directWorkbench = path.join(cursorRoot, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  if (await exists(directWorkbench)) {
    return cursorRoot;
  }

  const appDir = path.join(cursorRoot, 'resources', 'app');
  const nestedWorkbench = path.join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  if (await exists(nestedWorkbench)) {
    return appDir;
  }

  throw new Error(`没有找到 workbench.desktop.main.js：${directWorkbench} 或 ${nestedWorkbench}`);
}

function compilePatterns(patterns) {
  return patterns.map((pattern) => new RegExp(pattern, 'u'));
}

function decodeJsString(raw) {
  const jsonReady = raw
    .replace(/"/g, '\\"')
    .replace(/\\'/g, "'")
    .replace(/\\`/g, '`')
    .replace(/\\x([0-9a-fA-F]{2})/g, (_match, hex) => `\\u00${hex}`)
    .replace(/\\0(?![0-9])/g, '\\u0000')
    .replace(/\\\r?\n/g, '');

  return JSON.parse(`"${jsonReady}"`);
}

function normalizeText(value) {
  return value.replace(/\s+/g, ' ').trim();
}

function hasEnglishText(value) {
  return /[A-Za-z]{2}/.test(value);
}

function hasCjkText(value) {
  return /[\u3400-\u9fff]/.test(value);
}

function isTemplateExpression(raw, quote) {
  return quote === '`' && /(^|[^\\])\$\{/.test(raw);
}

function skipQuotedString(source, start, quote) {
  for (let i = start + 1; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\\') {
      i += 1;
      continue;
    }
    if (quote === '`' && char === '$' && source[i + 1] === '{') {
      i = skipTemplateExpression(source, i + 2) - 1;
      continue;
    }
    if (char === quote) {
      return i + 1;
    }
  }

  return source.length;
}

function skipTemplateExpression(source, start) {
  let depth = 1;

  for (let i = start; i < source.length; i += 1) {
    const char = source[i];
    if (char === '\'' || char === '"' || char === '`') {
      i = skipQuotedString(source, i, char) - 1;
      continue;
    }
    if (char === '{') {
      depth += 1;
      continue;
    }
    if (char === '}') {
      depth -= 1;
      if (depth === 0) {
        return i + 1;
      }
    }
  }

  return source.length;
}

function extractStringLiterals(source) {
  const literals = [];

  for (let index = 0; index < source.length; index += 1) {
    const quote = source[index];
    if (quote !== '\'' && quote !== '"' && quote !== '`') continue;

    const start = index;
    let raw = '';
    let hasTemplateExpression = false;
    index += 1;

    for (; index < source.length; index += 1) {
      const char = source[index];
      if (char === '\\') {
        raw += source.slice(index, index + 2);
        index += 1;
        continue;
      }
      if (quote === '`' && char === '$' && source[index + 1] === '{') {
        hasTemplateExpression = true;
        index = skipTemplateExpression(source, index + 2) - 1;
        continue;
      }
      if (char === quote) {
        if (!(quote === '`' && hasTemplateExpression)) {
          try {
            const value = decodeJsString(raw);
            literals.push({ value, literal: source.slice(start, index + 1), index: start });
          } catch {
            // Ignore non-JSON-compatible JavaScript escape sequences.
          }
        }
        break;
      }
      raw += char;
    }
  }

  return literals;
}

function buildLineStarts(source) {
  const starts = [0];

  for (let i = 0; i < source.length; i += 1) {
    if (source.charCodeAt(i) === 10) {
      starts.push(i + 1);
    }
  }

  return starts;
}

function lineColumnAt(lineStarts, index) {
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

function contextAt(source, index, length, surroundingChars) {
  const start = Math.max(0, index - surroundingChars);
  const end = Math.min(source.length, index + length + surroundingChars);
  return source.slice(start, end).replace(/\s+/g, ' ').trim();
}

function confidenceFor(value, highConfidencePatterns, lowConfidencePatterns) {
  if (lowConfidencePatterns.some((pattern) => pattern.test(value))) return 'low';
  if (highConfidencePatterns.some((pattern) => pattern.test(value))) return 'high';
  return 'medium';
}

function compileContextTags(tags) {
  return (tags || [])
    .filter((tag) => tag && typeof tag.id === 'string' && Array.isArray(tag.patterns))
    .map((tag) => ({
      id: tag.id,
      label: typeof tag.label === 'string' ? tag.label : tag.id,
      patterns: compilePatterns(tag.patterns)
    }));
}

function contextTagsFor(value, tagDefinitions) {
  return tagDefinitions
    .filter((tag) => tag.patterns.some((pattern) => pattern.test(value)))
    .map((tag) => tag.id);
}

function mergeUniqueTags(target, tags) {
  for (const tag of tags) {
    if (!target.includes(tag)) {
      target.push(tag);
    }
  }
}

function orderIndex(order, value) {
  const index = order.indexOf(value);
  return index === -1 ? order.length : index;
}

function contextTagRank(candidate, contextTagOrder) {
  if (!candidate.contextTags.length) {
    return contextTagOrder.length;
  }

  return Math.min(...candidate.contextTags.map((tag) => orderIndex(contextTagOrder, tag)));
}

function extractPatchSourceTexts(patches) {
  return new Set(
    patches
      .flatMap((patch) => [patch.source, patch.target])
      .filter((value) => typeof value === 'string')
      .flatMap((value) => [...value.matchAll(/["']([^"']*[A-Za-z][^"']*)["']/g)].map((match) => normalizeText(match[1])))
      .filter(Boolean)
  );
}

function buildCandidateReport({ source, literals, config, patches, needles }) {
  const excludePatterns = compilePatterns(config.excludePatterns || []);
  const lowConfidencePatterns = compilePatterns(config.lowConfidencePatterns || []);
  const highConfidencePatterns = compilePatterns(config.highConfidencePatterns || []);
  const contextTagDefinitions = compileContextTags(config.contextTags);
  const statusOrder = config.statusOrder || ['candidate', 'tracked-needle', 'already-in-patch-map'];
  const confidenceOrder = config.confidenceOrder || ['high', 'medium', 'low'];
  const contextTagOrder = config.contextTagOrder || contextTagDefinitions.map((tag) => tag.id);
  const patchedTexts = extractPatchSourceTexts(patches);
  const needleSet = new Set(needles.map((needle) => normalizeText(needle)));
  const lineStarts = buildLineStarts(source);
  const candidatesByText = new Map();

  for (const literal of literals) {
    const text = normalizeText(literal.value);
    if (text.length < config.minLength || text.length > config.maxLength) continue;
    if (!hasEnglishText(text) || hasCjkText(text)) continue;
    if (excludePatterns.some((pattern) => pattern.test(text))) continue;

    const location = lineColumnAt(lineStarts, literal.index);
    const context = contextAt(source, literal.index, literal.literal.length, config.surroundingChars);
    const contextTags = contextTagsFor(context, contextTagDefinitions);
    const sample = {
      line: location.line,
      column: location.column,
      index: literal.index,
      literal: literal.literal,
      context,
      contextTags
    };
    const existing = candidatesByText.get(text);

    if (existing) {
      existing.occurrences += 1;
      mergeUniqueTags(existing.contextTags, contextTags);
      if (existing.samples.length < config.maxSamplesPerCandidate) {
        existing.samples.push(sample);
      }
      continue;
    }

    candidatesByText.set(text, {
      text,
      occurrences: 1,
      confidence: confidenceFor(text, highConfidencePatterns, lowConfidencePatterns),
      status: patchedTexts.has(text) ? 'already-in-patch-map' : needleSet.has(text) ? 'tracked-needle' : 'candidate',
      contextTags,
      samples: [sample]
    });
  }

  return [...candidatesByText.values()].sort((a, b) => {
    return orderIndex(statusOrder, a.status) - orderIndex(statusOrder, b.status)
      || contextTagRank(a, contextTagOrder) - contextTagRank(b, contextTagOrder)
      || orderIndex(confidenceOrder, a.confidence) - orderIndex(confidenceOrder, b.confidence)
      || b.occurrences - a.occurrences
      || a.text.localeCompare(b.text);
  });
}

function escapeMarkdownCell(value) {
  return value.replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

async function writeMarkdownReport({ appDir, workbenchPath, candidates, config }) {
  const limit = config.markdownCandidateLimit;
  const lines = [
    '# workbench.desktop.main.js 未汉化硬编码字符串报告',
    '',
    `- Cursor 应用目录：\`${appDir}\``,
    `- 扫描文件：\`${workbenchPath}\``,
    `- 候选字符串：${candidates.length}`,
    `- 高置信度：${candidates.filter((item) => item.confidence === 'high').length}`,
    `- 中置信度：${candidates.filter((item) => item.confidence === 'medium').length}`,
    `- 低置信度：${candidates.filter((item) => item.confidence === 'low').length}`,
    '',
    '## 候选列表',
    '',
    '| 状态 | 上下文 | 置信度 | 次数 | 首次位置 | 原文 |',
    '| --- | --- | --- | ---: | --- | --- |',
    ...candidates.slice(0, limit).map((item) => {
      const first = item.samples[0];
      const contextTags = item.contextTags.length ? item.contextTags.join(', ') : '-';
      return `| ${item.status} | ${contextTags} | ${item.confidence} | ${item.occurrences} | ${first.line}:${first.column} | \`${escapeMarkdownCell(item.text)}\` |`;
    }),
    '',
    '## 产物说明',
    '',
    '- 完整候选与上下文：`reports/workbench-untranslated.json`',
    '- Markdown 只截取排序后的前若干项；完整结果以 JSON 为准。',
    '- `already-in-patch-map` 表示原文已在 `data/workbench-patches.json` 中维护。',
    '- `tracked-needle` 表示原文已在 `data/workbench-hardcoded-needles.json` 中列为重点观察词。'
  ];

  await fs.writeFile(path.join(reportsDir, 'workbench-untranslated.md'), `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const [appDir, config, patches, needles] = await Promise.all([
    resolveAppDir(),
    readJson(configPath),
    readJson(patchesPath),
    readJson(needlesPath)
  ]);
  const workbenchPath = path.join(appDir, 'out', 'vs', 'workbench', 'workbench.desktop.main.js');
  const source = await fs.readFile(workbenchPath, 'utf8');
  const literals = extractStringLiterals(source);
  const candidates = buildCandidateReport({ source, literals, config, patches, needles });

  await writeJson(path.join(reportsDir, 'workbench-untranslated.json'), {
    appDir,
    workbenchPath,
    scannedAt: new Date().toISOString(),
    totalStringLiterals: literals.length,
    candidateCount: candidates.length,
    candidates
  });
  await writeMarkdownReport({ appDir, workbenchPath, candidates, config });

  console.log(`字符串字面量：${literals.length}`);
  console.log(`未汉化候选：${candidates.length}`);
  console.log(`JSON 报告：${path.join(reportsDir, 'workbench-untranslated.json')}`);
  console.log(`Markdown 报告：${path.join(reportsDir, 'workbench-untranslated.md')}`);
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});