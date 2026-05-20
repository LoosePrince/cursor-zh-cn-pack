export interface ProgressUpdate {
  readonly message: string;
  readonly percent: number;
  readonly current?: number;
  readonly total?: number;
}

export type ProgressCallback = (update: ProgressUpdate) => void | Promise<void>;

export async function reportProgress(progress: ProgressCallback | undefined, update: ProgressUpdate): Promise<void> {
  if (!progress) {
    return;
  }

  await progress({
    ...update,
    percent: clampPercent(update.percent)
  });
}

export function createScopedProgress(
  progress: ProgressCallback | undefined,
  startPercent: number,
  endPercent: number,
  label?: string
): ProgressCallback | undefined {
  if (!progress) {
    return undefined;
  }

  return update => progress({
    ...update,
    message: label ? `${label}：${update.message}` : update.message,
    percent: scalePercent(update.percent, startPercent, endPercent)
  });
}

export function toPercent(current: number, total: number): number {
  if (total <= 0) {
    return 100;
  }

  return clampPercent((current / total) * 100);
}

export function scalePercent(percent: number, startPercent: number, endPercent: number): number {
  return clampPercent(startPercent + (clampPercent(percent) / 100) * (endPercent - startPercent));
}

export function clampPercent(percent: number): number {
  if (!Number.isFinite(percent)) {
    return 0;
  }

  return Math.max(0, Math.min(100, Math.round(percent)));
}

export async function yieldToEventLoop(): Promise<void> {
  await new Promise<void>(resolve => setTimeout(resolve, 0));
}