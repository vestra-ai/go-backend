// The Quick start sheet's extra answer (app contract §4.4 JoinAnswers), mapped onto what the contract already has:
// `vibe` is one "Vibe: …" entry of the person's `know` list (group- and Go-visible, not the trip-level vibe only Go writes).
const VIBE_PREFIX = /^vibe:\s*/i;

/** `know` with the vibe as its one "Vibe: beach" entry, replacing an earlier one; unchanged when no vibe was sent. */
export function knowWithVibe(know: string[], vibe: string | undefined): string[] {
  if (vibe === undefined) return know;
  return [...know.filter((k) => !VIBE_PREFIX.test(k)), `Vibe: ${vibe}`];
}
