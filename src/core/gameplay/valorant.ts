import type { EvidenceLevel, GameplayEventType } from '../types';

export interface ValorantHudClassification {
  profileId: 'valorant';
  eventId: string;
  eventType: GameplayEventType;
  evidenceLevel: EvidenceLevel;
  matchedKeyword: string;
  uncertainties: string[];
}

export interface GameplayHudClassification {
  profileId: string;
  eventId: string;
  eventType: GameplayEventType;
  evidenceLevel: EvidenceLevel;
  matchedKeyword: string;
  uncertainties: string[];
}

export interface NormalizedHudWord {
  text: string;
  confidence: number;
  /** Coordinates normalized against the decoded frame dimensions, independent of resolution. */
  x: number;
  y: number;
  width: number;
  height: number;
  lineId: string;
}

export interface ValorantHudFrame {
  timeSeconds: number;
  words: NormalizedHudWord[];
}

export interface GameplayAdapter {
  id: string;
  canonicalName?: string;
  gameAliases: string[];
  classifyHudText(text: string): GameplayHudClassification | null;
  detectFeedChanges?(frames: ValorantHudFrame[]): Array<{ timeSeconds: number; signature: string; confidence: number }>;
}

const EVENT_RULES: Array<{ id: string; type: GameplayEventType; keywords: string[]; uncertainty?: string }> = [
  { id: 'multi_kill', type: 'multi_kill', keywords: ['double kill', 'triple kill', 'quadra kill', 'quad kill', 'multi kill'] },
  { id: 'ace', type: 'ace', keywords: ['ace'] },
  { id: 'headshot', type: 'headshot', keywords: ['headshot', 'head shot'] },
  { id: 'clutch', type: 'clutch', keywords: ['clutch'] },
  { id: 'buy_phase', type: 'quiet_passage', keywords: ['buy phase', 'purchase phase', 'kaufphase', 'kauf phase', 'press b to buy', 'druecke b zum kaufen', 'drücke b zum kaufen', '2um kaufen'] },
  { id: 'spike_prompt', type: 'quiet_passage', keywords: ['hold e to plant spike', 'hold e to defuse spike', 'halte e zum pflanzen', 'halte e zum entschärfen'] },
  { id: 'round_objective', type: 'round_objective', keywords: ['spike planted', 'spike defused', 'spike detonated'] },
  { id: 'round_end', type: 'round_end', keywords: ['round won', 'round lost', 'victory', 'defeat', 'match won', 'match lost', 'rundensieg', 'runde gewonnen', 'runde verloren'] }
];

const UNSUPPORTED_CERTAINTY = 'OCR phrase matching reports visible text; it does not inspect the underlying game state.';
const OWNERSHIP_UNCERTAINTY = 'Visible kill-related HUD text does not establish that the recorded player made the kill.';

export function isValorantGame(game?: string): boolean {
  const normalized = normalize(game ?? '');
  return normalized === 'valorant' || normalized === 'valorant champions tour';
}

export const BUILT_IN_GAMEPLAY_ADAPTERS: GameplayAdapter[] = [{
  id: 'valorant', canonicalName: 'Valorant', gameAliases: ['valorant', 'valorant champions tour'],
  classifyHudText: (text) => classifyValorantHudText(text, 'valorant'),
  detectFeedChanges: detectValorantKillFeedChanges
}];

export function gameplayAdapterFor(game?: string): GameplayAdapter | undefined {
  const normalized = normalize(game ?? '');
  return BUILT_IN_GAMEPLAY_ADAPTERS.find((adapter) => adapter.gameAliases.some((alias) => normalized === normalize(alias) || normalized.includes(normalize(alias))));
}

/** Prefer explicit project metadata; use a recognized adapter alias from the media label as a fallback. */
export function inferGameplayGame(game: string | undefined, mediaLabel: string): string | undefined {
  if (game?.trim()) return game;
  const normalizedLabel = normalize(mediaLabel);
  const adapter = BUILT_IN_GAMEPLAY_ADAPTERS.find((candidate) => candidate.gameAliases.some((alias) => normalizedLabel.includes(normalize(alias))));
  return adapter?.canonicalName ?? adapter?.gameAliases[0];
}

/** Classifies only explicit Valorant-related HUD phrases. No text means no kill claim. */
export function classifyValorantHudText(text: string, game = 'Valorant'): ValorantHudClassification | null {
  if (!isValorantGame(game)) return null;
  const normalized = normalize(text);
  if (!normalized) return null;
  for (const rule of EVENT_RULES) {
    const matchedKeyword = rule.keywords.find((keyword) => containsPhrase(normalized, normalize(keyword)));
    if (matchedKeyword) {
      return {
        profileId: 'valorant', eventId: rule.id, eventType: rule.type,
        evidenceLevel: 'explicit', matchedKeyword,
        uncertainties: [UNSUPPORTED_CERTAINTY, ...(['headshot', 'multi_kill', 'ace'].includes(rule.id) ? [OWNERSHIP_UNCERTAINTY] : [])]
      };
    }
  }
  const clutchSituation = normalized.match(/(?:^|\s)1\s*(?:v|vs|versus)\s*([2-5])(?:\s|$)/);
  if (clutchSituation) {
    return {
      profileId: 'valorant', eventId: 'clutch_situation', eventType: 'clutch_situation',
      evidenceLevel: 'heuristic', matchedKeyword: clutchSituation[0].trim(),
      uncertainties: ['A visible 1vN-like string may be OCR noise and does not establish that the round was won.']
    };
  }
  return null;
}

/**
 * Detects changes in OCR text rows in Valorant's conventional top-right kill-feed region.
 * Coordinates are normalized, and output is deliberately a heuristic cue rather than a kill.
 */
export function detectValorantKillFeedChanges(frames: ValorantHudFrame[]): Array<{ timeSeconds: number; signature: string; confidence: number }> {
  const seenAt = new Map<string, number>();
  let previous = new Set<string>();
  let hasBaseline = false;
  const results: Array<{ timeSeconds: number; signature: string; confidence: number }> = [];
  for (const frame of [...frames].sort((a, b) => a.timeSeconds - b.timeSeconds)) {
    const rows = new Map<string, NormalizedHudWord[]>();
    for (const word of frame.words) {
      const centerX = word.x + word.width / 2;
      const centerY = word.y + word.height / 2;
      // The feed is a relative screen region, not a pixel rectangle. This remains stable across
      // captured resolutions and ordinary HUD scaling, while the resulting label stays tentative.
      if (centerX < 0.62 || centerY < 0.035 || centerY > 0.48 || word.confidence < 45) continue;
      rows.set(word.lineId, [...(rows.get(word.lineId) ?? []), word]);
    }
    const signatures = new Map<string, number>();
    for (const words of rows.values()) {
      const sorted = [...words].sort((a, b) => a.x - b.x);
      const normalized = normalize(sorted.map((word) => word.text).join(' '));
      // Requiring multiple tokens and some visual extent suppresses clocks and single HUD labels.
      const first = sorted[0];
      const last = sorted.at(-1)!;
      const span = last.x + last.width - first.x;
      if (normalized.split(' ').length < 2 || span < 0.045 || normalized.length > 72) continue;
      signatures.set(normalized, sorted.reduce((sum, word) => sum + word.confidence, 0) / sorted.length / 100);
    }
    const frameText = normalize(frame.words.map((word) => word.text).join(' '));
    const overlayMarkers = [
      'buy phase', 'purchase phase', 'combat report', 'killed by', 'spike carrier killed',
      'scoreboard', 'press tab to display', 'match won',
      'match lost', 'round won', 'round lost', 'victory', 'defeat'
    ];
    const nonFeedOverlay = overlayMarkers.some((marker) => containsPhrase(frameText, normalize(marker)));
    const current = new Set(signatures.keys());
    if (!hasBaseline) { previous = current; hasBaseline = true; continue; }
    if (nonFeedOverlay) { previous = current; continue; }
    for (const [signature, confidence] of signatures) {
      const lastTime = seenAt.get(signature) ?? -Infinity;
      if (!previous.has(signature) && frame.timeSeconds - lastTime >= 2) {
        results.push({ timeSeconds: frame.timeSeconds, signature, confidence: clamp(confidence, 0.2, 0.75) });
        seenAt.set(signature, frame.timeSeconds);
      }
    }
    previous = current;
  }
  return results;
}

export function legacyValorantTextMatch(text: string): { eventId: string; matchedKeyword: string } | null {
  const normalized = normalize(text);
  const legacyRules: Array<{ eventId: string; keywords: string[] }> = [
    { eventId: 'ace', keywords: ['ace'] },
    { eventId: 'kill', keywords: ['eliminated', 'headshot', 'killed'] },
    { eventId: 'round_objective', keywords: ['spike planted', 'spike defused'] },
    { eventId: 'round_result', keywords: ['round won', 'round lost', 'victory', 'defeat'] }
  ];
  for (const rule of legacyRules) {
    // Mirrors the former substring matcher for a comparable regression baseline.
    const matchedKeyword = rule.keywords.find((keyword) => normalized.includes(normalize(keyword)));
    if (matchedKeyword) return { eventId: rule.eventId, matchedKeyword };
  }
  return null;
}

function normalize(value: string): string {
  return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim();
}
function containsPhrase(text: string, phrase: string): boolean { return ` ${text} `.includes(` ${phrase} `); }
function clamp(value: number, min: number, max: number): number { return Math.min(max, Math.max(min, value)); }
