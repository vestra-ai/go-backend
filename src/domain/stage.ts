// `stage` (app contract §4.4, rule fixed in APP-CONTRACT-CHANGES.md): where a trip is, from the trip's own fields,
// never from record lines. The app picks the zero state or the populated Trip home from it, and the home card's line.
export type Stage = 'new' | 'deciding' | 'planned';

export interface StageInput {
  destination?: unknown | null;
  dates?: { start: string; end: string } | null;
  bookings: Array<{ kind: string; status: string }>;
}

/**
 * `new`: no destination and no dates yet. `planned`: a destination and dates, and a confirmed booking (a stay, or any
 * other confirmed booking). Anything in between is `deciding`.
 */
export function stageOf(t: StageInput): Stage {
  const hasDestination = t.destination !== null && t.destination !== undefined;
  const hasDates = !!t.dates;
  if (!hasDestination && !hasDates) return 'new';
  const booked = t.bookings.some((b) => b.status === 'confirmed');
  return hasDestination && hasDates && booked ? 'planned' : 'deciding';
}

export type Attention = { kind: 'needs_you'; count: number } | { kind: 'all_set' } | { kind: 'collecting' } | { kind: 'task'; label: string };

/** The home card's status line: things pending on me first, else "all set" once planned, else Go is still collecting. (`task` is phase 4/5.) */
export function attentionOf(stage: Stage, needsYouCount: number): Attention {
  if (needsYouCount > 0) return { kind: 'needs_you', count: needsYouCount };
  return stage === 'planned' ? { kind: 'all_set' } : { kind: 'collecting' };
}
