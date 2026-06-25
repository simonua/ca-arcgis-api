import type { SourceAccessWindow } from './operating-window-gate.ts';

export type DailyAttemptBudgetDecision =
  | Readonly<{ allowed: true; dateKey: string; attempts: number; ceiling: number }>
  | Readonly<{
    allowed: false;
    reason: 'ceiling-reached' | 'invalid-time' | 'no-window-budget';
    dateKey?: string;
    attempts?: number;
    ceiling?: number;
    nextResetAtEpochMs?: number;
  }>;

export interface DailyAttemptBudget {
  check(nowEpochMs: number): DailyAttemptBudgetDecision;
  consume(nowEpochMs: number): DailyAttemptBudgetDecision;
}

export interface DailyAttemptBudgetOptions {
  readonly sourceWindows: readonly SourceAccessWindow[];
  readonly minimumIntervalMs: number;
  readonly easternDateKey: (epochMs: number) => string | undefined;
}

/** Creates a restart-local hard ceiling from each Eastern date's configured source windows. */
export function createDailyAttemptBudget(options: DailyAttemptBudgetOptions): DailyAttemptBudget {
  const ceilings = new Map<string, number>();
  const attempts = new Map<string, number>();
  for (const window of options.sourceWindows) {
    const dateKey = options.easternDateKey(window.startsAtEpochMs);
    const durationMs = window.endsAtEpochMs - window.startsAtEpochMs;
    if (
      dateKey === undefined || !isDateKey(dateKey) || !Number.isSafeInteger(durationMs) ||
      durationMs <= 0 || !Number.isSafeInteger(options.minimumIntervalMs) ||
      options.minimumIntervalMs <= 0
    ) {
      continue;
    }
    const windowCeiling = Math.ceil(durationMs / options.minimumIntervalMs);
    ceilings.set(dateKey, (ceilings.get(dateKey) ?? 0) + windowCeiling);
  }

  return Object.freeze({
    check(nowEpochMs: number): DailyAttemptBudgetDecision {
      return evaluate(nowEpochMs, false);
    },
    consume(nowEpochMs: number): DailyAttemptBudgetDecision {
      return evaluate(nowEpochMs, true);
    },
  });

  function evaluate(nowEpochMs: number, consume: boolean): DailyAttemptBudgetDecision {
    if (!Number.isSafeInteger(nowEpochMs) || nowEpochMs < 0) {
      return Object.freeze({ allowed: false, reason: 'invalid-time' });
    }
    const dateKey = options.easternDateKey(nowEpochMs);
    if (dateKey === undefined || !isDateKey(dateKey)) {
      return Object.freeze({ allowed: false, reason: 'invalid-time' });
    }
    const ceiling = ceilings.get(dateKey);
    if (ceiling === undefined) {
      return Object.freeze({ allowed: false, reason: 'no-window-budget', dateKey });
    }
    const currentAttempts = attempts.get(dateKey) ?? 0;
    if (currentAttempts >= ceiling) {
      const nextResetAtEpochMs = findNextResetAt(nowEpochMs, dateKey);
      return Object.freeze({
        allowed: false,
        reason: 'ceiling-reached',
        dateKey,
        attempts: currentAttempts,
        ceiling,
        ...(nextResetAtEpochMs === undefined ? {} : { nextResetAtEpochMs }),
      });
    }
    const nextAttempts = consume ? currentAttempts + 1 : currentAttempts;
    if (consume) {
      attempts.set(dateKey, nextAttempts);
    }
    return Object.freeze({ allowed: true, dateKey, attempts: nextAttempts, ceiling });
  }

  function findNextResetAt(nowEpochMs: number, currentDateKey: string): number | undefined {
    for (const window of options.sourceWindows) {
      if (window.startsAtEpochMs <= nowEpochMs) {
        continue;
      }
      const windowDateKey = options.easternDateKey(window.startsAtEpochMs);
      if (
        windowDateKey !== undefined && isDateKey(windowDateKey) &&
        windowDateKey !== currentDateKey
      ) {
        return window.startsAtEpochMs;
      }
    }
    return undefined;
  }
}

function isDateKey(value: string): boolean {
  return /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(value);
}
