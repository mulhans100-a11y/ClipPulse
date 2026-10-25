import { promises as fs } from 'node:fs';
import { ffmpegAvailable, runCommand } from './ffmpeg';
import type { AnalysisRuntimeStatus } from './types';

export interface OptionalAnalysisRuntime extends AnalysisRuntimeStatus {
  /** Resolved executable path is kept in the main process and never sent to the renderer. */
  executablePath?: string;
}

const executableLookupCache = new Map<string, Promise<string | null>>();

export async function findExecutable(command: string): Promise<string | null> {
  const key = command.trim().toLocaleLowerCase();
  const cached = executableLookupCache.get(key);
  if (cached) return cached;
  const locator = process.platform === 'win32' ? 'where.exe' : 'which';
  const lookup = runCommand(locator, [command]).then((result) =>
    result.stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean) ?? null
  ).catch(() => null);
  // PATH is fixed for the lifetime of the Electron/CLI process. Keep both
  // hits and misses so large libraries do not spawn `where`/`which` per clip.
  executableLookupCache.set(key, lookup);
  return lookup;
}

export async function getOptionalAnalysisRuntimes(): Promise<OptionalAnalysisRuntime[]> {
  const ffmpeg = await ffmpegAvailable();
  const tesseractPath = await findExecutable('tesseract');
  let tesseract: OptionalAnalysisRuntime;
  if (!tesseractPath) {
    tesseract = { id: 'tesseract-ocr', label: 'Tesseract OCR', status: 'missing', message: 'Optional OCR is disabled. Install Tesseract and restart OpenMontage to recognize sampled HUD text.' };
  } else {
    try {
      const { stdout, stderr } = await runCommand(tesseractPath, ['--version']);
      const version = `${stdout}\n${stderr}`.match(/tesseract\s+([\w.-]+)/i)?.[1];
      tesseract = { id: 'tesseract-ocr', label: 'Tesseract OCR', status: 'ready', version, message: 'OCR runtime is available for local sampled-frame recognition.', executablePath: tesseractPath };
    } catch (error) {
      tesseract = { id: 'tesseract-ocr', label: 'Tesseract OCR', status: 'missing', message: error instanceof Error ? error.message : String(error) };
    }
  }

  const modelPath = process.env.OPENMONTAGE_GAMEPLAY_MODEL?.trim();
  const runtimePath = process.env.OPENMONTAGE_ONNX_RUNTIME?.trim();
  const gameRulesPath = process.env.OPENMONTAGE_GAME_RULES?.trim();
  const gameRulesFileExists = gameRulesPath ? await fs.access(gameRulesPath).then(() => true, () => false) : false;
  const gameRules: OptionalAnalysisRuntime = gameRulesPath
    ? { id: 'game-event-rules', label: 'Game event rules', status: gameRulesFileExists ? 'ready' : 'missing', message: gameRulesFileExists ? 'Custom local phrase rules are configured. OCR still requires Tesseract.' : 'OPENMONTAGE_GAME_RULES points to a missing file.' }
    : { id: 'game-event-rules', label: 'Game event rules', status: 'ready', message: 'Built-in explicit HUD event phrases are available; custom rules are optional.' };
  let modelStatus: OptionalAnalysisRuntime;
  if (modelPath && runtimePath) {
    const [modelExists, runtimeExists] = await Promise.all([
      fs.access(modelPath).then(() => true, () => false),
      fs.access(runtimePath).then(() => true, () => false)
    ]);
    modelStatus = modelExists && runtimeExists
      ? { id: 'gameplay-model', label: 'Gameplay model', status: 'not-configured', message: 'Model files were found, but this build has no compatible inference adapter. Heuristic detectors remain active.' }
      : { id: 'gameplay-model', label: 'Gameplay model', status: 'missing', message: 'OPENMONTAGE_GAMEPLAY_MODEL or OPENMONTAGE_ONNX_RUNTIME points to a missing file.' };
  } else {
    modelStatus = { id: 'gameplay-model', label: 'Gameplay model', status: 'not-configured', message: 'No gameplay model or supported inference adapter is configured. No gameplay classification is claimed.' };
  }

  return [
    { id: 'ffmpeg', label: 'FFmpeg', status: ffmpeg.ffmpeg && ffmpeg.ffprobe && ffmpeg.compatible ? 'ready' : 'missing', message: ffmpeg.message ?? 'FFmpeg 6 or newer with drawtext and libx264, plus ffprobe 6 or newer, is required for local editing and export.' },
    tesseract,
    gameRules,
    modelStatus
  ];
}

export async function getPublicAnalysisRuntimeStatuses(): Promise<AnalysisRuntimeStatus[]> {
  return (await getOptionalAnalysisRuntimes()).map(({ executablePath: _path, ...runtime }) => runtime);
}
