import fs from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  buildLineStarts,
  compileContextTags,
  compilePatterns,
  contextAt,
  contextTagsFor,
  countOccurrences,
  decodeJsString,
  hasCjkText,
  hasEnglishText,
  lineColumnAt,
  normalizeText,
  readJson,
  resolveWorkbenchPath,
  slugifyId,
  summarizeCodeBlock,
  writeJson
} from './lib/workbench-scan-shared.mjs';
import {
  BLOCK_ANCHORS,
  extractBlockCandidates,
  pruneSubsumedCandidates
} from './lib/workbench-patch-extractors.mjs';

const scriptDir = path.dirname(fileURLToPath(import.meta.url));
const projectRoot = path.resolve(scriptDir, '..');
const reportsDir = path.join(projectRoot, 'reports');
const configPath = path.join(projectRoot, 'data', 'workbench-untranslated-scan-config.json');
const patchesPath = path.join(projectRoot, 'data', 'workbench-patches.json');
const policyPath = path.join(projectRoot, 'data', 'workbench-patch-runtime-policy.json');

const DEFAULT_UI_KEYS = [
  'label',
  'title',
  'description',
  'children',
  'subtitle',
  'placeholder',
  'message',
  'detail',
  'actionTitle',
  'helpTooltipLabel',
  'tooltip',
  'aria-label',
  'ariaLabel',
  'cancelButton',
  'primaryButton',
  'accept',
  'reject',
  'waitText',
  'errorText',
  'general',
  'profile',
  'appearance',
  'chat',
  'tab',
  'models',
  'rules',
  'plugins',
  'indexing',
  'mcp',
  'hooks',
  'beta',
  'network',
  'worktrees',
  'developer'
];

function parseArgs(argv) {
  const options = {
    cursorRoot: process.env.CURSOR_ROOT || 'D:\\cursor',
    scope: 'settings',
    minConfidence: 'high',
    includeApplied: false,
    staging: true
  };

  for (const arg of argv) {
    if (arg.startsWith('--scope=')) {
      options.scope = arg.slice('--scope='.length);
      continue;
    }
    if (arg.startsWith('--min-confidence=')) {
      options.minConfidence = arg.slice('--min-confidence='.length);
      continue;
    }
    if (arg === '--include-applied') {
      options.includeApplied = true;
      continue;
    }
    if (arg === '--no-staging') {
      options.staging = false;
      continue;
    }
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      continue;
    }
    if (!arg.startsWith('-')) {
      options.cursorRoot = arg;
    }
  }

  return options;
}

function printHelp() {
  console.log(`用法: node scripts/extract-workbench-patch-sources.mjs [Cursor根目录] [选项]

从 workbench.desktop.main.js 按补丁规范提取未汉化片段，生成可直接用作 workbench-patches.json 的 source 候选表。

提取器支持：
  - UI 键名：label/title/description/children 等
  - 块级结构：function switch、memo-arrow、items 数组、导航映射 anh={}、模式对象 var O4r={}
  - HTML 模板：Re()/ot()、Mr 三元表达式、页面标题

选项:
  --scope=settings|all     默认 settings，仅保留设置页相关上下文
  --min-confidence=high|medium|low
  --include-applied        输出中保留已应用/已收录项
  --no-staging             不写入 data/workbench-patches.staging.json

产物:
  reports/workbench-patch-source-candidates.json
  reports/workbench-patch-source-candidates.md
  data/workbench-patches.staging.json   (默认)
`);
}

function confidenceRank(value) {
  switch (value) {
    case 'high':
      return 0;
    case 'medium':
      return 1;
    case 'low':
      return 2;
    default:
      return 3;
  }
}

function confidenceFor({ kind, innerText, highConfidencePatterns, lowConfidencePatterns }) {
  if (lowConfidencePatterns.some((pattern) => pattern.test(innerText))) {
    return 'low';
  }
  if (kind === 'ui-key' || kind === 'getter' || kind === 'html-template' || kind === 'platform-ternary'
    || kind === 'function-switch' || kind === 'memo-arrow' || kind === 'arrow-switch'
    || kind === 'items-array' || kind === 'array-literal' || kind === 'nav-map' || kind === 'mode-object') {
    return 'high';
  }
  if (highConfidencePatterns.some((pattern) => pattern.test(innerText))) {
    return 'high';
  }
  return 'medium';
}

function matchesSafePrefix(source, safePrefixes, extractor) {
  if (extractor?.kind === 'html-template' && /^[A-Za-z_$][\w$]*=Re\("/.test(source)) {
    return true;
  }
  if (extractor?.kind === 'platform-ternary' && /^(label|description):Mr\?/.test(source)) {
    return true;
  }
  if (extractor?.kind === 'jsx-title' && source.startsWith('z(gX,{title:')) {
    return true;
  }
  if (extractor?.kind === 'section-title' && source.startsWith('Jf,{title:')) {
    return true;
  }
  if (extractor?.kind === 'function-switch' && source.startsWith('function ')) {
    return true;
  }
  if (extractor?.kind === 'memo-arrow' && /=me\(\(\)=>\{/.test(source)) {
    return true;
  }
  if (extractor?.kind === 'arrow-switch' && /=>\{switch/.test(source)) {
    return true;
  }
  if (extractor?.kind === 'items-array' && source.startsWith('items:[')) {
    return true;
  }
  if (extractor?.kind === 'array-literal' && /=\[\{id:/.test(source)) {
    return true;
  }
  if (extractor?.kind === 'nav-map' && source.startsWith('anh={')) {
    return true;
  }
  if (extractor?.kind === 'mode-object' && /^var [A-Za-z_$][\w$]*=\{id:/.test(source)) {
    return true;
  }
  return safePrefixes.some((prefix) => source.startsWith(prefix));
}

function longestMatchingPrefix(source, prefixes) {
  let best = '';
  for (const prefix of prefixes) {
    if (source.startsWith(prefix) && prefix.length > best.length) {
      best = prefix;
    }
  }
  return best;
}

function expandToSafePrefix(source, index, endIndex, safePrefixes) {
  const maxLookback = 420;
  const searchStart = Math.max(0, index - maxLookback);
  const window = source.slice(searchStart, endIndex);
  const relativeIndex = index - searchStart;

  let bestPrefix = '';
  let bestPrefixIndex = -1;
  for (const prefix of safePrefixes) {
    if (prefix.length < 4) continue;
    const localIndex = window.lastIndexOf(prefix, relativeIndex);
    if (localIndex === -1 || localIndex > relativeIndex) continue;
    if (prefix.length > bestPrefix.length) {
      bestPrefix = prefix;
      bestPrefixIndex = localIndex;
    }
  }

  if (bestPrefixIndex === -1) {
    return null;
  }

  const expandedStart = searchStart + bestPrefixIndex;
  let expandedEnd = endIndex;

  const tail = source.slice(expandedStart, Math.min(source.length, expandedStart + 900));
  const stopTokens = [',get ', ',set ', '}),', '}})', '});', '},z(', '},re(', '},H('];
  let stopAt = tail.length;
  for (const token of stopTokens) {
    const tokenIndex = tail.indexOf(token, bestPrefix.length);
    if (tokenIndex !== -1) {
      stopAt = Math.min(stopAt, tokenIndex + token.length - (token.endsWith('(') ? 1 : 0));
    }
  }

  expandedEnd = expandedStart + stopAt;
  const expanded = source.slice(expandedStart, expandedEnd);
  if (!hasEnglishText(expanded) || hasCjkText(expanded)) {
    return null;
  }
  if (!matchesSafePrefix(expanded, safePrefixes, null)) {
    return null;
  }

  return expanded;
}

function decodeQuotedLiteral(literal) {
  try {
    const raw = literal.slice(1, -1);
    return decodeJsString(raw);
  } catch {
    return null;
  }
}

function buildPatchIndexes(patches) {
  const sourceToRule = new Map();
  const targetSet = new Set();

  for (const patch of patches) {
    sourceToRule.set(patch.source, patch);
    targetSet.add(patch.target);
  }

  return { sourceToRule, targetSet };
}

function classifyCandidate({ source, sourceToRule, targetSet, workbenchSource }) {
  const rule = sourceToRule.get(source);
  const sourceHits = countOccurrences(workbenchSource, source);
  const targetHits = rule ? countOccurrences(workbenchSource, rule.target) : 0;

  if (rule) {
    if (sourceHits > 0) {
      return {
        status: 'covered-unapplied',
        patchId: rule.id,
        sourceHits,
        targetHits
      };
    }
    if (targetHits > 0) {
      return {
        status: 'covered-applied',
        patchId: rule.id,
        sourceHits,
        targetHits
      };
    }
    return {
      status: 'covered-stale',
      patchId: rule.id,
      sourceHits,
      targetHits
    };
  }

  return {
    status: 'missing',
    patchId: undefined,
    sourceHits,
    targetHits: 0
  };
}

function isInSettingsScope(source, index, length, config) {
  const lookback = config.scopeLookbackChars ?? 420;
  const lookahead = config.scopeLookaheadChars ?? 180;
  const start = Math.max(0, index - lookback);
  const end = Math.min(source.length, index + length + lookahead);
  const window = source.slice(start, end);
  const patterns = compilePatterns(config.settingsScopePatterns || [
    'cursor-settings',
    'z\\(Wu,',
    'z\\(gX,',
    'z\\(Jf,',
    'settings-sidebar',
    'settings-search'
  ]);
  return patterns.some((pattern) => pattern.test(window));
}

function isSettingsHtmlSymbol(symbol, config) {
  return (config.settingsHtmlSymbols || []).includes(symbol);
}

function suggestPatchId({ kind, key, innerText, contextTags }) {
  const scope = contextTags.includes('cursor-settings') || contextTags.includes('settings-dom')
    ? 'settings'
    : 'workbench';
  const keyPart = key ? `${key}` : kind.replace(/[^a-z]/g, '');
  return `${scope}.${keyPart}.${slugifyId(innerText)}`;
}

function createExtractorPatterns(uiKeys) {
  const keyPattern = uiKeys.join('|');
  return [
    {
      kind: 'ui-key',
      id: 'ui-key',
      regex: new RegExp(`(?:^|[^\\w$])(${keyPattern}):("(?:[^"\\\\]|\\\\.)*")`, 'g')
    },
    {
      kind: 'getter',
      id: 'getter-return',
      regex: /get (description|title|fallback|label)\(\)\{return(`(?:[^`\\]|\\.|\\$\\{(?:[^{}]|\\{[^{}]*\\})*\\})*`|"(?:[^"\\]|\\.)*")\}/g
    },
    {
      kind: 'html-template',
      id: 're-template',
      regex: /([A-Za-z_$][\w$]*)=Re\("((?:[^"\\]|\\.)*)"\)/g
    },
    {
      kind: 'html-template',
      id: 'ot-template',
      regex: /([A-Za-z_$][\w$]*)=ot\("((?:[^"\\]|\\.)*)"\)/g
    },
    {
      kind: 'return-literal',
      id: 'return-string',
      regex: /return"((?:[^"\\]|\\.)*)"/g
    },
    {
      kind: 'jsx-title',
      id: 'jsx-title',
      regex: /z\(gX,\{title:("(?:[^"\\]|\\.)*")/g
    },
    {
      kind: 'section-title',
      id: 'jf-title',
      regex: /Jf,\{title:("(?:[^"\\]|\\.)*")/g
    },
    {
      kind: 'platform-ternary',
      id: 'mr-ternary',
      regex: /(label|description):Mr\?("(?:[^"\\]|\\.)*"):("(?:[^"\\]|\\.)*")/g
    }
  ];
}

function extractCandidates({
  workbenchSource,
  config,
  policy,
  patches,
  options
}) {
  const excludePatterns = compilePatterns(config.excludePatterns || []);
  const lowConfidencePatterns = compilePatterns(config.lowConfidencePatterns || []);
  const highConfidencePatterns = compilePatterns(config.highConfidencePatterns || []);
  const contextTagDefinitions = compileContextTags(config.contextTags);
  const contextTagOrder = config.contextTagOrder || contextTagDefinitions.map((tag) => tag.id);
  const uiKeys = config.patchSourceKeys || DEFAULT_UI_KEYS;
  const safePrefixes = [...policy.safeSourcePrefixes].sort((a, b) => b.length - a.length);
  const maxPatchSourceLength = config.maxPatchSourceLength ?? 2000;
  const lineStarts = buildLineStarts(workbenchSource);
  const { sourceToRule, targetSet } = buildPatchIndexes(patches);
  const extractors = createExtractorPatterns(uiKeys);
  const bySource = new Map();

  const addCandidate = (candidate) => {
    const existing = bySource.get(candidate.source);
    if (existing) {
      existing.occurrences += 1;
      if (existing.samples.length < config.maxSamplesPerCandidate) {
        existing.samples.push(candidate.samples[0]);
      }
      return;
    }
    bySource.set(candidate.source, candidate);
  };

  const processRawCandidate = ({
    source,
    innerText,
    kind,
    key,
    index,
    extractor
  }) => {
    if (!innerText || innerText.length < config.minLength) return;
    if (source.length > maxPatchSourceLength) return;
    if (!hasEnglishText(innerText)) return;
    if (excludePatterns.some((pattern) => pattern.test(innerText))) return;

    if (!matchesSafePrefix(source, safePrefixes, extractor)) {
      const canExpand = kind === 'return-literal' || kind === 'getter';
      if (!canExpand) return;
      const expanded = expandToSafePrefix(workbenchSource, index, index + source.length, safePrefixes);
      if (!expanded) return;
      source = expanded;
      index = workbenchSource.indexOf(expanded, Math.max(0, index - 20));
      if (!matchesSafePrefix(source, safePrefixes, extractor)) return;
    }

    const context = contextAt(workbenchSource, index, source.length, config.surroundingChars);
    const contextTags = contextTagsFor(context, contextTagDefinitions);
    const blockAutoScopeKinds = new Set([
      'memo-arrow',
      'arrow-switch',
      'items-array',
      'array-literal',
      'nav-map',
      'mode-object'
    ]);
    const inSettingsScope = contextTags.some((tag) => contextTagOrder.includes(tag))
      || isInSettingsScope(workbenchSource, index, source.length, config)
      || (kind === 'html-template' && isSettingsHtmlSymbol(key, config))
      || blockAutoScopeKinds.has(kind);

    if (options.scope === 'settings' && !inSettingsScope) return;

    const confidenceText = kind === 'html-template'
      ? innerText.replace(/<[^>]+>/g, ' ').trim()
      : innerText;

    const confidence = confidenceFor({
      kind,
      innerText: confidenceText,
      highConfidencePatterns,
      lowConfidencePatterns
    });
    if (confidenceRank(confidence) > confidenceRank(options.minConfidence)) return;

    const classification = classifyCandidate({
      source,
      sourceToRule,
      targetSet,
      workbenchSource
    });

    if (!options.includeApplied && (classification.status === 'covered-applied' || classification.status === 'covered-stale')) {
      return;
    }

    const safePrefix = longestMatchingPrefix(source, safePrefixes);
    const patchRule = sourceToRule.get(source);
    addCandidate({
      id: patchRule?.id || suggestPatchId({ kind, key, innerText, contextTags }),
      source,
      target: patchRule?.target || '',
      innerText,
      kind,
      key: key || undefined,
      confidence,
      status: classification.status,
      patchId: classification.patchId,
      sourceHits: classification.sourceHits,
      targetHits: classification.targetHits,
      safePrefix,
      uniqueInFile: classification.sourceHits === 1,
      contextTags,
      occurrences: 1,
      samples: [{
        line: lineColumnAt(lineStarts, index).line,
        column: lineColumnAt(lineStarts, index).column,
        index,
        context
      }]
    });
  };

  for (const extractor of extractors) {
    for (const match of workbenchSource.matchAll(extractor.regex)) {
      let source = '';
      let innerText = '';
      let key = '';
      let index = match.index ?? 0;

      if (extractor.kind === 'ui-key') {
        key = match[1];
        source = `${key}:${match[2]}`;
        const decoded = decodeQuotedLiteral(match[2]);
        if (decoded === null) continue;
        innerText = normalizeText(decoded);
        index = match.index + match[0].indexOf(source);
      } else if (extractor.kind === 'getter') {
        key = match[1];
        source = match[0];
        try {
          innerText = normalizeText(
            match[2].startsWith('`')
              ? match[2].slice(1, -1)
              : decodeQuotedLiteral(match[2]) ?? ''
          );
        } catch {
          continue;
        }
        if (!innerText) continue;
      } else if (extractor.kind === 'html-template') {
        key = match[1];
        source = match[0];
        try {
          innerText = normalizeText(decodeJsString(match[2]));
        } catch {
          continue;
        }
      } else if (extractor.kind === 'return-literal') {
        key = 'return';
        source = `return"${match[1]}"`;
        try {
          innerText = normalizeText(decodeJsString(match[1]));
        } catch {
          continue;
        }
        index = match.index + match[0].indexOf(source);
      } else if (extractor.kind === 'jsx-title' || extractor.kind === 'section-title') {
        key = 'title';
        const literal = match[1];
        const decoded = decodeQuotedLiteral(literal);
        if (decoded === null) continue;
        source = extractor.kind === 'jsx-title'
          ? `z(gX,{title:${literal}`
          : `Jf,{title:${literal}`;
        innerText = normalizeText(decoded);
        index = match.index;
      } else if (extractor.kind === 'platform-ternary') {
        key = match[1];
        source = match[0];
        const macText = decodeQuotedLiteral(match[2]);
        const otherText = decodeQuotedLiteral(match[3]);
        if (macText === null || otherText === null) continue;
        innerText = normalizeText(`${macText} / ${otherText}`);
        index = match.index;
      }

      if (!innerText || innerText.length > config.maxLength) continue;
      if (!hasEnglishText(innerText) || hasCjkText(innerText)) continue;

      processRawCandidate({
        source,
        innerText,
        kind: extractor.kind,
        key,
        index,
        extractor
      });
    }
  }

  for (const block of extractBlockCandidates(workbenchSource, BLOCK_ANCHORS)) {
    const innerText = summarizeCodeBlock(block.source, config.maxLength);
    if (!innerText) continue;

    processRawCandidate({
      source: block.source,
      innerText,
      kind: block.kind,
      key: block.key,
      index: block.index,
      extractor: { kind: block.kind }
    });
  }

  const statusOrder = ['missing', 'covered-unapplied', 'covered-stale', 'covered-applied'];
  const pruned = pruneSubsumedCandidates([...bySource.values()]);
  return pruned.sort((a, b) => {
    return statusOrder.indexOf(a.status) - statusOrder.indexOf(b.status)
      || confidenceRank(a.confidence) - confidenceRank(b.confidence)
      || (a.uniqueInFile === b.uniqueInFile ? 0 : a.uniqueInFile ? -1 : 1)
      || b.occurrences - a.occurrences
      || a.source.localeCompare(b.source);
  });
}

function escapeMarkdownCell(value) {
  return value.replace(/\|/g, '\\|').replace(/`/g, '\\`');
}

async function writeMarkdownReport({ appDir, workbenchPath, candidates, options }) {
  const lines = [
    '# workbench 补丁 source 候选表',
    '',
    `- Cursor 应用目录：\`${appDir}\``,
    `- 扫描文件：\`${workbenchPath}\``,
    `- 范围：\`${options.scope}\``,
    `- 最低置信度：\`${options.minConfidence}\``,
    `- 候选条数：${candidates.length}`,
  '',
    '## 状态说明',
    '',
    '- `missing`：workbench 中仍存在英文 source，但补丁表未收录',
    '- `covered-unapplied`：补丁表已有 source，但当前 workbench 仍是英文（未应用或版本不匹配）',
    '- `covered-applied`：补丁已应用（仅在使用 `--include-applied` 时出现）',
    '- `covered-stale`：补丁表有记录，但当前 workbench 中 source/target 都未命中（可能已换版）',
    '',
    '## 候选列表',
    '',
    '| 状态 | 置信度 | 类型 | 唯一 | 次数 | innerText | source 前缀 |',
    '| --- | --- | --- | --- | ---: | --- | --- |',
    ...candidates.slice(0, 600).map((item) => {
      return `| ${item.status} | ${item.confidence} | ${item.kind} | ${item.uniqueInFile ? 'yes' : 'no'} | ${item.sourceHits} | \`${escapeMarkdownCell(item.innerText)}\` | \`${escapeMarkdownCell(item.safePrefix)}\` |`;
    }),
    '',
    '完整 JSON（含完整 `source` 字段）见 `reports/workbench-patch-source-candidates.json`。'
  ];

  await fs.writeFile(path.join(reportsDir, 'workbench-patch-source-candidates.md'), `${lines.join('\n')}\n`, 'utf8');
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    printHelp();
    return;
  }

  const { appDir, workbenchPath } = await resolveWorkbenchPath(options.cursorRoot);
  const [config, patches, policy, workbenchSource] = await Promise.all([
    readJson(configPath),
    readJson(patchesPath),
    readJson(policyPath),
    fs.readFile(workbenchPath, 'utf8')
  ]);

  const candidates = extractCandidates({
    workbenchSource,
    config,
    policy,
    patches,
    options
  });

  const summary = {
    missing: candidates.filter((item) => item.status === 'missing').length,
    coveredUnapplied: candidates.filter((item) => item.status === 'covered-unapplied').length,
    coveredApplied: candidates.filter((item) => item.status === 'covered-applied').length,
    coveredStale: candidates.filter((item) => item.status === 'covered-stale').length,
    highConfidence: candidates.filter((item) => item.confidence === 'high').length,
    byKind: Object.fromEntries(
      [...candidates.reduce((map, item) => {
        map.set(item.kind, (map.get(item.kind) ?? 0) + 1);
        return map;
      }, new Map()).entries()].sort((a, b) => b[1] - a[1])
    )
  };

  const report = {
    appDir,
    workbenchPath,
    scannedAt: new Date().toISOString(),
    options,
    summary,
    candidateCount: candidates.length,
    candidates
  };

  await writeJson(path.join(reportsDir, 'workbench-patch-source-candidates.json'), report);
  await writeMarkdownReport({ appDir, workbenchPath, candidates, options });

  if (options.staging) {
    const staging = candidates
      .filter((item) => item.status === 'missing' || item.status === 'covered-unapplied')
      .filter((item) => item.confidence === 'high' || item.confidence === 'medium')
      .map((item) => ({
        id: item.id,
        source: item.source,
        target: item.target || '',
        note: `auto-extracted; kind=${item.kind}; status=${item.status}; innerText=${item.innerText}`
      }));
    await writeJson(path.join(projectRoot, 'data', 'workbench-patches.staging.json'), staging);
  }

  console.log(`扫描完成：${candidates.length} 条 source 候选`);
  console.log(`  missing: ${summary.missing}`);
  console.log(`  covered-unapplied: ${summary.coveredUnapplied}`);
  console.log(`  high confidence: ${summary.highConfidence}`);
  console.log(`  by kind: ${JSON.stringify(summary.byKind)}`);
  console.log(`JSON: ${path.join(reportsDir, 'workbench-patch-source-candidates.json')}`);
  console.log(`Markdown: ${path.join(reportsDir, 'workbench-patch-source-candidates.md')}`);
  if (options.staging) {
    console.log(`Staging: ${path.join(projectRoot, 'data', 'workbench-patches.staging.json')}`);
  }
}

main().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
