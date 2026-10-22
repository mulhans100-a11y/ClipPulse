import { promises as fs } from 'node:fs';
import { createHash } from 'node:crypto';
import { AppError } from './errors';

export interface GameRuleEvent {
  id: string;
  keywords: string[];
}

export interface GameRuleProfile {
  id: string;
  gameAliases: string[];
  events: GameRuleEvent[];
}

export interface GameRuleMatch {
  profileId: string;
  eventId: string;
  matchedKeyword: string;
}

export const BUILT_IN_GAME_RULES: GameRuleProfile[] = [
  { id: 'valorant', gameAliases: ['valorant'], events: [
    { id: 'ace', keywords: ['ace'] },
    { id: 'kill', keywords: ['eliminated', 'headshot', 'killed'] },
    { id: 'round_objective', keywords: ['spike planted', 'spike defused'] },
    { id: 'round_result', keywords: ['round won', 'round lost', 'victory', 'defeat'] }
  ] },
  { id: 'counter-strike', gameAliases: ['counter-strike', 'counter strike', 'cs2', 'cs go', 'csgo'], events: [
    { id: 'round_win', keywords: ['terrorists win', 'counter-terrorists win', 'counter terrorists win'] },
    { id: 'bomb_objective', keywords: ['bomb has been planted', 'bomb has been defused', 'bomb planted', 'bomb defused'] },
    { id: 'ace', keywords: ['ace'] }
  ] },
  { id: 'fortnite', gameAliases: ['fortnite'], events: [
    { id: 'victory', keywords: ['victory royale'] },
    { id: 'elimination', keywords: ['eliminated', 'double elimination', 'triple elimination'] }
  ] },
  { id: 'apex-legends', gameAliases: ['apex', 'apex legends'], events: [
    { id: 'champion', keywords: ['you are the champion', 'champion squad'] },
    { id: 'squad_elimination', keywords: ['squad eliminated', 'squad wipe'] },
    { id: 'knockdown', keywords: ['knocked down', 'eliminated'] }
  ] },
  { id: 'overwatch', gameAliases: ['overwatch'], events: [
    { id: 'team_kill', keywords: ['team kill'] },
    { id: 'match_result', keywords: ['victory', 'defeat'] },
    { id: 'elimination', keywords: ['eliminated'] }
  ] },
  { id: 'call-of-duty', gameAliases: ['call of duty', 'modern warfare', 'warzone'], events: [
    { id: 'multi_kill', keywords: ['double kill', 'triple kill', 'quad feed', 'multi kill'] },
    { id: 'headshot', keywords: ['headshot'] },
    { id: 'elimination', keywords: ['elimination', 'eliminated'] }
  ] },
  { id: 'openarena', gameAliases: ['openarena', 'anarch'], events: [
    { id: 'frag', keywords: ['you fragged', 'was fragged by', 'was gunned down by'] },
    { id: 'match_result', keywords: ['red team wins', 'blue team wins', 'you win', 'you lose'] }
  ] },
  { id: 'generic-explicit-events', gameAliases: ['*'], events: [
    { id: 'kill', keywords: ['double kill', 'triple kill', 'multi kill', 'headshot', 'eliminated', 'killed', 'fragged', 'knocked down'] },
    { id: 'death', keywords: ['you died', 'killed by', 'eliminated by'] },
    { id: 'victory', keywords: ['victory', 'match won', 'round won', 'winner'] }
  ] }
];

let cachedConfiguredPath: string | undefined;
let cachedConfigHash: string | undefined;
let cachedProfiles: GameRuleProfile[] | undefined;

export async function loadGameRuleProfiles(): Promise<GameRuleProfile[]> {
  const configuredPath = process.env.OPENMONTAGE_GAME_RULES?.trim();
  if (!configuredPath) return BUILT_IN_GAME_RULES;
  let raw: Buffer;
  try { raw = await fs.readFile(configuredPath); }
  catch (error) { throw new AppError('GAME_RULES_READ_FAILED', `Could not read OPENMONTAGE_GAME_RULES: ${error instanceof Error ? error.message : error}`); }
  const configHash = createHash('sha256').update(raw).digest('hex');
  if (cachedConfiguredPath === configuredPath && cachedConfigHash === configHash && cachedProfiles) return cachedProfiles;
  let parsed: unknown;
  try { parsed = JSON.parse(raw.toString('utf8')); }
  catch (error) { throw new AppError('GAME_RULES_READ_FAILED', `Could not read OPENMONTAGE_GAME_RULES: ${error instanceof Error ? error.message : error}`); }
  if (!parsed || typeof parsed !== 'object' || !('schemaVersion' in parsed) || parsed.schemaVersion !== 1 || !('profiles' in parsed) || !Array.isArray(parsed.profiles)) {
    throw new AppError('INVALID_GAME_RULES', 'Game rules file must contain schemaVersion 1 and a profiles array.');
  }
  const customProfiles = (parsed.profiles as unknown[]).map((profile, index) => validateProfile(profile, index));
  cachedConfiguredPath = configuredPath;
  cachedConfigHash = configHash;
  cachedProfiles = [...customProfiles, ...BUILT_IN_GAME_RULES];
  return cachedProfiles;
}

export async function gameRuleCacheKey(): Promise<string> {
  const configuredPath = process.env.OPENMONTAGE_GAME_RULES?.trim();
  if (!configuredPath) return 'built-in-game-rules-v1';
  try {
    const raw = await fs.readFile(configuredPath);
    return `custom-game-rules:${createHash('sha256').update(raw).digest('hex')}`;
  } catch {
    return `missing-game-rules:${configuredPath}`;
  }
}

export async function matchGameEvent(text: string, game?: string, profiles?: GameRuleProfile[]): Promise<GameRuleMatch | null> {
  const normalizedText = normalize(text);
  if (!normalizedText || !game?.trim()) return null;
  const activeProfiles = profiles ?? await loadGameRuleProfiles();
  const normalizedGame = normalize(game);
  const orderedProfiles = activeProfiles.filter((profile) => profile.gameAliases.some((alias) => alias === '*' || normalizedGame.includes(normalize(alias))));
  for (const profile of orderedProfiles) {
    for (const event of profile.events) {
      const matchedKeyword = event.keywords.find((keyword) => normalizedText.includes(normalize(keyword)));
      if (matchedKeyword) return { profileId: profile.id, eventId: event.id, matchedKeyword };
    }
  }
  return null;
}

function validateProfile(value: unknown, index: number): GameRuleProfile {
  if (!value || typeof value !== 'object') throw new AppError('INVALID_GAME_RULES', `Game rule profile ${index + 1} must be an object.`);
  const profile = value as Partial<GameRuleProfile>;
  if (!profile.id?.trim() || !Array.isArray(profile.gameAliases) || !profile.gameAliases.length || profile.gameAliases.some((alias) => typeof alias !== 'string' || !alias.trim()) || !Array.isArray(profile.events) || !profile.events.length) {
    throw new AppError('INVALID_GAME_RULES', `Game rule profile ${index + 1} needs an id, gameAliases, and events.`);
  }
  for (const [eventIndex, event] of profile.events.entries()) {
    if (!event?.id?.trim() || !Array.isArray(event.keywords) || !event.keywords.length || event.keywords.some((keyword) => typeof keyword !== 'string' || !keyword.trim())) {
      throw new AppError('INVALID_GAME_RULES', `Event ${eventIndex + 1} in profile ${profile.id} needs an id and non-empty keywords.`);
    }
  }
  return profile as GameRuleProfile;
}

function normalize(value: string): string { return value.normalize('NFKC').toLocaleLowerCase().replace(/[^\p{L}\p{N}]+/gu, ' ').trim(); }
