/**
 * Calls an observability emitter without letting it reach the delivery path.
 *
 * The emitter is specified never to throw, and the buffer that implements it
 * does not. This is the belt for that brace: the axiom is that a report can
 * fail in any way at all and a card still advances, and an axiom that depends
 * on every caller's implementation being correct is a convention, not an axiom.
 */
export function emitSafely(
  emit: ((type: string, data: unknown) => void) | undefined,
  data: unknown,
  type = "phase.telemetry",
): void {
  if (!emit) return;
  try {
    emit(type, data);
  } catch {
    // Nothing to do with it here: reporting the failure of reporting down the
    // delivery path is exactly what this ring exists to prevent.
  }
}
