export const MAX_TIMELINE_PIXELS_PER_SECOND = 384;
const MIN_WAVEFORM_WIDTH = 640;
const MAX_WAVEFORM_WIDTH = 16_384;

/** Choose a cached waveform resolution that remains sharp at the editor's 400% zoom. */
export function waveformWidthForDuration(durationSeconds: number): number {
  if (!Number.isFinite(durationSeconds) || durationSeconds <= 0) return MIN_WAVEFORM_WIDTH;
  return Math.min(MAX_WAVEFORM_WIDTH, Math.max(MIN_WAVEFORM_WIDTH, Math.ceil(durationSeconds * MAX_TIMELINE_PIXELS_PER_SECOND)));
}
