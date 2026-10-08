// The Quick start sheet's two extra answers (app contract §4.4 JoinAnswers), mapped onto what the contract already has:
// `vibe` is one "Vibe: …" entry of the person's `know` list (group- and Go-visible, not the trip-level vibe only Go writes);
// `spend_band` is the person's private budget answer, handled exactly like PUT …/me/budget.
import type { SpendBand } from '../api/bodies.js';

const VIBE_PREFIX = /^vibe:\s*/i;

/** `know` with the vibe as its one "Vibe: beach" entry, replacing an earlier one; unchanged when no vibe was sent. */
export function knowWithVibe(know: string[], vibe: string | undefined): string[] {
  if (vibe === undefined) return know;
  return [...know.filter((k) => !VIBE_PREFIX.test(k)), `Vibe: ${vibe}`];
}

/** The spend bands in paise: under ₹15k, ₹15k to ₹25k, over ₹25k (no upper limit). */
export const BUDGET_BANDS: Record<SpendBand, { min_minor: number; max_minor: number | null }> = {
  lt15: { min_minor: 0, max_minor: 1_500_000 },
  '15to25': { min_minor: 1_500_000, max_minor: 2_500_000 },
  gt25: { min_minor: 2_500_000, max_minor: null },
};
