import type { AudioAnalysis, Project, TimelineClip } from './types';
import { seconds } from './time';

export type AudioAnalysisMap = Record<string, AudioAnalysis>;

export function audioClipBeatOffsets(clip: TimelineClip, analysis?: AudioAnalysis): number[] {
  if (!analysis) return [];
  const sourceIn = seconds(clip.sourceIn);
  const sourceEnd = sourceIn + seconds(clip.duration);
  const duration = seconds(clip.duration);
  return analysis.beats
    .filter((beat) => beat >= sourceIn && beat < sourceEnd)
    .map((beat) => (beat - sourceIn) / duration);
}

export function collectTimelineSnapPoints(project: Project, analyses: AudioAnalysisMap): number[] {
  const points: number[] = [];
  for (const track of project.tracks) {
    for (const clip of track.clips) {
      const start = seconds(clip.start);
      const sourceIn = seconds(clip.sourceIn);
      const duration = seconds(clip.duration);
      points.push(start, start + duration);
      const asset = project.media.find((item) => item.id === clip.mediaId);
      const analysis = asset ? analyses[asset.id] : undefined;
      if (!asset || asset.kind !== 'audio' || !analysis) continue;
      for (const beat of analysis.beats) {
        if (beat >= sourceIn && beat < sourceIn + duration) points.push(start + beat - sourceIn);
      }
    }
  }
  return [...new Set(points)].sort((a, b) => a - b);
}

export function snapTimelineTime(project: Project, candidate: number, pixelsPerSecond: number, analyses: AudioAnalysisMap, thresholdPixels = 10): number {
  if (!Number.isFinite(candidate) || pixelsPerSecond <= 0) return candidate;
  const threshold = thresholdPixels / pixelsPerSecond;
  let nearest = candidate;
  let distance = threshold;
  for (const point of collectTimelineSnapPoints(project, analyses)) {
    const delta = Math.abs(point - candidate);
    if (delta <= distance) { nearest = point; distance = delta; }
  }
  return nearest;
}
