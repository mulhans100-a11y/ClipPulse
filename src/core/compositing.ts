import type { Project, TimelineClip } from './types';
import { clipVideoOverlayPosition } from './clipEffects';

/** Append one alpha-aware layer to the shared preview/export filter graph. */
export function appendCompositeLayer(
  filters: string[], base: string, clipLabel: string, output: string,
  clip: TimelineClip, project: Project, fps: string, canvasDuration: string, index: number,
  shortest: boolean
): void {
  const position = clipVideoOverlayPosition(clip, project);
  const sync = shortest ? '1' : '0';
  if (!clip.blendMode || clip.blendMode === 'normal') {
    filters.push(`[${base}][${clipLabel}]overlay=x='${position.x}':y='${position.y}':format=auto:shortest=${sync}:eof_action=pass:repeatlast=0[${output}]`);
    return;
  }

  const clear = `clear${index}`, canvas = `layer${index}`;
  const baseA = `basea${index}`, baseB = `baseb${index}`;
  const layerA = `layera${index}`, layerB = `layerb${index}`;
  const alpha = `mask${index}`, candidate = `candidate${index}`;
  filters.push(`color=c=black@0:s=${project.width}x${project.height}:r=${fps}:d=${canvasDuration},format=rgba[${clear}]`);
  filters.push(`[${clear}][${clipLabel}]overlay=x='${position.x}':y='${position.y}':format=auto:shortest=0:eof_action=pass:repeatlast=0,format=gbrap[${canvas}]`);
  filters.push(`[${base}]format=gbrap,split=2[${baseA}][${baseB}]`);
  filters.push(`[${canvas}]split=2[${layerA}][${layerB}]`);
  filters.push(`[${layerA}]alphaextract[${alpha}]`);
  const mode = clip.blendMode === 'add' ? 'addition' : clip.blendMode;
  filters.push(`[${baseA}][${layerB}]blend=all_mode=${mode}:shortest=1[${candidate}]`);
  filters.push(`[${baseB}][${candidate}][${alpha}]maskedmerge[${output}]`);
}
