export interface BraceBalance {
  readonly curly: number;
  readonly round: number;
  readonly square: number;
}

export function measureBraceBalance(value: string): BraceBalance {
  let curly = 0;
  let round = 0;
  let square = 0;
  let inString = false;
  let quote = '';
  let escaped = false;

  for (let index = 0; index < value.length; index += 1) {
    const char = value[index];
    if (inString) {
      if (escaped) {
        escaped = false;
        continue;
      }

      if (char === '\\') {
        escaped = true;
        continue;
      }

      if (char === quote) {
        inString = false;
      }

      continue;
    }

    if (char === '"' || char === '\'' || char === '`') {
      inString = true;
      quote = char;
      continue;
    }

    switch (char) {
      case '{':
        curly += 1;
        break;
      case '}':
        curly -= 1;
        break;
      case '(':
        round += 1;
        break;
      case ')':
        round -= 1;
        break;
      case '[':
        square += 1;
        break;
      case ']':
        square -= 1;
        break;
      default:
        break;
    }
  }

  return { curly, round, square };
}

export function assertPatchRuleBraceBalance(ruleId: string, source: string, target: string): void {
  const sourceBalance = measureBraceBalance(source);
  const targetBalance = measureBraceBalance(target);
  if (
    sourceBalance.curly === targetBalance.curly
    && sourceBalance.round === targetBalance.round
    && sourceBalance.square === targetBalance.square
  ) {
    return;
  }

  throw new Error(
    `补丁规则 ${ruleId} 的 target 与 source 括号结构不一致（{} ${sourceBalance.curly}→${targetBalance.curly}，() ${sourceBalance.round}→${targetBalance.round}，[] ${sourceBalance.square}→${targetBalance.square}）`
  );
}

export function assertBraceBalanceUnchanged(before: BraceBalance, after: BraceBalance, ruleId: string): void {
  if (before.curly === after.curly && before.round === after.round && before.square === after.square) {
    return;
  }

  throw new Error(
    `补丁规则 ${ruleId} 改变了括号平衡（{} ${before.curly}→${after.curly}，() ${before.round}→${after.round}，[] ${before.square}→${after.square}），已取消写入。`
  );
}
