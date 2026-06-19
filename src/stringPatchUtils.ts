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

export function replaceAllWithCount(value: string, source: string, target: string): { readonly value: string; readonly count: number } {
  if (!source || source === target || !value.includes(source)) {
    return { value, count: 0 };
  }

  const parts: string[] = [];
  let index = 0;
  let position = 0;
  let count = 0;
  while ((position = value.indexOf(source, index)) !== -1) {
    parts.push(value.slice(index, position));
    parts.push(target);
    index = position + source.length;
    count += 1;
  }

  parts.push(value.slice(index));
  return { value: parts.join(''), count };
}