export interface OrderedStringPatch {
  readonly source: string;
  readonly target: string;
}

export interface OrderedStringPatchResult {
  readonly value: string;
  readonly totalCount: number;
  readonly ruleCounts: readonly number[];
}

interface PatternNode {
  readonly children: Map<string, PatternNode>;
  readonly patternIndexes: number[];
  failure: PatternNode;
}

interface PatternMatcher {
  readonly root: PatternNode;
  readonly patternLengths: readonly number[];
}

interface TextEdit {
  readonly start: number;
  readonly end: number;
  readonly text: string;
}

interface TextRange {
  readonly start: number;
  readonly end: number;
}

interface PieceBuffer {
  readonly length: number;
  slice(start: number, end: number): string;
  replace(edits: readonly TextEdit[]): PieceBuffer;
  toString(): string;
}

export function applyOrderedStringPatches(
  value: string,
  patches: readonly OrderedStringPatch[]
): OrderedStringPatchResult {
  const ruleCounts = patches.map(() => 0);
  const activePatternIndexes = patches
    .map((patch, index) => ({ patch, index }))
    .filter(({ patch }) => patch.source.length > 0 && patch.source !== patch.target)
    .map(({ index }) => index);

  if (activePatternIndexes.length === 0 || value.length === 0) {
    return { value, totalCount: 0, ruleCounts };
  }

  const matcher = createPatternMatcher(patches.map(patch => patch.source));
  const matchesByRule = patches.map(() => new Set<number>());
  scanPatternMatches(value, matcher, 0, -1, (ruleIndex, start) => {
    matchesByRule[ruleIndex].add(start);
  });

  const maxSourceLength = Math.max(...activePatternIndexes.map(index => patches[index].source.length));
  let buffer = createPieceBuffer(value);

  for (const ruleIndex of activePatternIndexes) {
    const patch = patches[ruleIndex];
    const positions = selectCurrentRuleMatches(buffer, matchesByRule[ruleIndex], patch.source);
    matchesByRule[ruleIndex].clear();
    if (positions.length === 0) {
      continue;
    }

    const edits = positions.map(start => ({
      start,
      end: start + patch.source.length,
      text: patch.target
    }));
    buffer = buffer.replace(edits);
    ruleCounts[ruleIndex] = edits.length;

    updateFutureMatchPositions(matchesByRule, patches, ruleIndex, edits);
    const changedRanges = mapEditsToUpdatedText(edits);
    const windows = createRescanWindows(changedRanges, buffer.length, maxSourceLength);
    for (const window of windows) {
      scanPatternMatches(buffer.slice(window.start, window.end), matcher, window.start, ruleIndex, (futureRuleIndex, start) => {
        matchesByRule[futureRuleIndex].add(start);
      });
    }
  }

  return {
    value: buffer.toString(),
    totalCount: ruleCounts.reduce((total, count) => total + count, 0),
    ruleCounts
  };
}

function selectCurrentRuleMatches(buffer: PieceBuffer, candidates: ReadonlySet<number>, source: string): readonly number[] {
  const positions = [...candidates].sort((left, right) => left - right);
  const selected: number[] = [];
  let nextStart = 0;

  for (const start of positions) {
    if (start < nextStart || buffer.slice(start, start + source.length) !== source) {
      continue;
    }

    selected.push(start);
    nextStart = start + source.length;
  }

  return selected;
}

function updateFutureMatchPositions(
  matchesByRule: readonly Set<number>[],
  patches: readonly OrderedStringPatch[],
  currentRuleIndex: number,
  edits: readonly TextEdit[]
): void {
  for (let ruleIndex = currentRuleIndex + 1; ruleIndex < matchesByRule.length; ruleIndex += 1) {
    const matches = matchesByRule[ruleIndex];
    if (matches.size === 0) {
      continue;
    }

    const sourceLength = patches[ruleIndex].source.length;
    const updated = new Set<number>();
    for (const start of matches) {
      const mappedStart = mapUnchangedRangeStart(start, start + sourceLength, edits);
      if (mappedStart !== undefined) {
        updated.add(mappedStart);
      }
    }

    matches.clear();
    for (const start of updated) {
      matches.add(start);
    }
  }
}

function mapUnchangedRangeStart(start: number, end: number, edits: readonly TextEdit[]): number | undefined {
  let offset = 0;

  for (const edit of edits) {
    if (end <= edit.start) {
      break;
    }

    if (start >= edit.end) {
      offset += edit.text.length - (edit.end - edit.start);
      continue;
    }

    return undefined;
  }

  return start + offset;
}

function mapEditsToUpdatedText(edits: readonly TextEdit[]): readonly TextRange[] {
  const ranges: TextRange[] = [];
  let offset = 0;

  for (const edit of edits) {
    const start = edit.start + offset;
    ranges.push({ start, end: start + edit.text.length });
    offset += edit.text.length - (edit.end - edit.start);
  }

  return ranges;
}

function createRescanWindows(
  changedRanges: readonly TextRange[],
  valueLength: number,
  maxSourceLength: number
): readonly TextRange[] {
  const margin = Math.max(0, maxSourceLength - 1);
  const windows: TextRange[] = [];

  for (const range of changedRanges) {
    const window = {
      start: Math.max(0, range.start - margin),
      end: Math.min(valueLength, range.end + margin)
    };
    const previous = windows[windows.length - 1];
    if (previous && window.start <= previous.end) {
      windows[windows.length - 1] = { start: previous.start, end: Math.max(previous.end, window.end) };
    } else {
      windows.push(window);
    }
  }

  return windows;
}

function createPieceBuffer(value: string): PieceBuffer {
  return createPieceBufferFromPieces(value.length > 0 ? [value] : []);
}

function createPieceBufferFromPieces(pieces: readonly string[]): PieceBuffer {
  const normalized = pieces.filter(piece => piece.length > 0);
  const length = normalized.reduce((total, piece) => total + piece.length, 0);

  return {
    length,
    slice(start, end): string {
      if (start < 0 || end < start || end > length) {
        throw new Error(`文本切片范围无效: ${start}-${end}/${length}`);
      }

      const result: string[] = [];
      appendPieceRange(normalized, start, end, result);
      return result.join('');
    },
    replace(edits): PieceBuffer {
      const nextPieces: string[] = [];
      let cursor = 0;

      for (const edit of edits) {
        if (edit.start < cursor || edit.end < edit.start || edit.end > length) {
          throw new Error(`文本替换范围无效: ${edit.start}-${edit.end}/${length}`);
        }

        appendPieceRange(normalized, cursor, edit.start, nextPieces);
        if (edit.text.length > 0) {
          nextPieces.push(edit.text);
        }
        cursor = edit.end;
      }

      appendPieceRange(normalized, cursor, length, nextPieces);
      return createPieceBufferFromPieces(nextPieces);
    },
    toString(): string {
      return normalized.join('');
    }
  };
}

function appendPieceRange(pieces: readonly string[], start: number, end: number, result: string[]): void {
  if (start === end) {
    return;
  }

  let offset = 0;
  for (const piece of pieces) {
    const pieceEnd = offset + piece.length;
    if (pieceEnd <= start) {
      offset = pieceEnd;
      continue;
    }
    if (offset >= end) {
      break;
    }

    const localStart = Math.max(0, start - offset);
    const localEnd = Math.min(piece.length, end - offset);
    if (localStart === 0 && localEnd === piece.length) {
      result.push(piece);
    } else if (localStart < localEnd) {
      result.push(piece.slice(localStart, localEnd));
    }
    offset = pieceEnd;
  }
}

function createPatternMatcher(patterns: readonly string[]): PatternMatcher {
  const root = createPatternNode();
  const patternLengths = patterns.map(pattern => pattern.length);

  for (let patternIndex = 0; patternIndex < patterns.length; patternIndex += 1) {
    const pattern = patterns[patternIndex];
    if (pattern.length === 0) {
      continue;
    }

    let node = root;
    for (let index = 0; index < pattern.length; index += 1) {
      const character = pattern[index];
      let child = node.children.get(character);
      if (!child) {
        child = createPatternNode();
        node.children.set(character, child);
      }
      node = child;
    }
    node.patternIndexes.push(patternIndex);
  }

  buildFailureLinks(root);
  return { root, patternLengths };
}

function scanPatternMatches(
  value: string,
  matcher: PatternMatcher,
  offset: number,
  minimumRuleIndex: number,
  onMatch: (ruleIndex: number, start: number) => void
): void {
  const { root, patternLengths } = matcher;
  let node = root;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    const character = value[valueIndex];
    while (node !== root && !node.children.has(character)) {
      node = node.failure;
    }
    node = node.children.get(character) ?? root;

    for (const patternIndex of node.patternIndexes) {
      if (patternIndex <= minimumRuleIndex) {
        continue;
      }

      onMatch(patternIndex, offset + valueIndex + 1 - patternLengths[patternIndex]);
    }
  }
}

function createPatternNode(): PatternNode {
  const node = {
    children: new Map<string, PatternNode>(),
    patternIndexes: [],
    failure: undefined as unknown as PatternNode
  };
  node.failure = node;
  return node;
}

function buildFailureLinks(root: PatternNode): void {
  const queue: PatternNode[] = [];
  for (const child of root.children.values()) {
    child.failure = root;
    queue.push(child);
  }

  for (let index = 0; index < queue.length; index += 1) {
    const node = queue[index];
    for (const [character, child] of node.children) {
      let failure = node.failure;
      while (failure !== root && !failure.children.has(character)) {
        failure = failure.failure;
      }
      child.failure = failure.children.get(character) ?? root;
      child.patternIndexes.push(...child.failure.patternIndexes);
      queue.push(child);
    }
  }
}