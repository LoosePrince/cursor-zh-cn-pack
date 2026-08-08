export function countOccurrences(value: string, needle: string): number {
  if (!needle || !value.includes(needle)) {
    return 0;
  }

  let count = 0;
  let index = 0;
  while ((index = value.indexOf(needle, index)) !== -1) {
    count += 1;
    index += Math.max(needle.length, 1);
  }

  return count;
}

export function replaceAll(value: string, source: string, target: string): string {
  return replaceAllWithCount(value, source, target).value;
}

export interface ReplacementResult {
  readonly value: string;
  readonly count: number;
}

export function replaceAllWithCount(value: string, source: string, target: string): ReplacementResult {
  if (!source || source === target) {
    return { value, count: 0 };
  }

  const parts: string[] = [];
  let index = 0;
  let position = 0;
  let count = 0;
  while ((position = value.indexOf(source, index)) !== -1) {
    parts.push(value.slice(index, position), target);
    index = position + source.length;
    count += 1;
  }

  if (count === 0) {
    return { value, count };
  }

  parts.push(value.slice(index));
  return { value: parts.join(''), count };
}

export function countOccurrencesForPatterns(value: string, patterns: readonly string[]): readonly number[] {
  const root = createPatternNode();
  const patternLengths = patterns.map(pattern => pattern.length);

  for (let index = 0; index < patterns.length; index += 1) {
    const pattern = patterns[index];
    if (!pattern) {
      continue;
    }

    let node = root;
    for (let patternIndex = 0; patternIndex < pattern.length; patternIndex += 1) {
      const character = pattern[patternIndex];
      let child = node.children.get(character);
      if (!child) {
        child = createPatternNode();
        node.children.set(character, child);
      }
      node = child;
    }
    node.patternIndexes.push(index);
  }

  buildFailureLinks(root);
  const counts = patterns.map(() => 0);
  const lastMatchEnds = patterns.map(() => -1);
  let node = root;

  for (let valueIndex = 0; valueIndex < value.length; valueIndex += 1) {
    const character = value[valueIndex];
    while (node !== root && !node.children.has(character)) {
      node = node.failure;
    }
    node = node.children.get(character) ?? root;

    for (const patternIndex of node.patternIndexes) {
      const matchEnd = valueIndex + 1;
      const matchStart = matchEnd - patternLengths[patternIndex];
      if (matchStart >= lastMatchEnds[patternIndex]) {
        counts[patternIndex] += 1;
        lastMatchEnds[patternIndex] = matchEnd;
      }
    }
  }

  return counts;
}

interface PatternNode {
  readonly children: Map<string, PatternNode>;
  readonly patternIndexes: number[];
  failure: PatternNode;
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