import { spawn } from 'node:child_process';
import { AppError } from './errors';

export interface CommandResult { stdout: string; stderr: string; }
export interface FfmpegAvailability { ffmpeg: boolean; ffprobe: boolean; compatible: boolean; message?: string; }

export function ffmpegCompatibilityProblems(ffmpegVersion: string, ffprobeVersion: string, filters: string, encoders: string): string[] {
  const problems: string[] = [];
  for (const [name, output] of [['ffmpeg', ffmpegVersion], ['ffprobe', ffprobeVersion]] as const) {
    const match = new RegExp(`\\b${name}\\s+version\\s+(\\d+)`, 'i').exec(output);
    const major = match ? Number(match[1]) : undefined;
    if (major === undefined) problems.push(`Could not determine the ${name} version.`);
    else if (major < 6) problems.push(`${name} ${major} is too old; version 6 or newer is required.`);
  }
  if (!/\bdrawtext\b/i.test(filters)) problems.push('The FFmpeg build is missing the drawtext filter.');
  if (!/\blibx264\b/i.test(encoders)) problems.push('The FFmpeg build is missing the libx264 encoder.');
  return problems;
}

export function runCommand(command: string, args: string[], onStdout?: (line: string) => void, signal?: AbortSignal): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new AppError('PROCESS_ABORTED', `${command} was stopped because the media job was cancelled.`));
      return;
    }
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    const abort = () => child.kill();
    signal?.addEventListener('abort', abort, { once: true });
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; onStdout?.(chunk); });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error: NodeJS.ErrnoException) => {
      signal?.removeEventListener('abort', abort);
      const executable = command.toLowerCase().replace(/\.exe$/, '');
      const isFfmpegTool = executable === 'ffmpeg' || executable === 'ffprobe';
      if (error.code === 'ENOENT' && isFfmpegTool) {
        reject(new AppError(`${executable.toUpperCase()}_NOT_FOUND`, `${executable} was not found on PATH. Install FFmpeg 6 or newer with both ffmpeg and ffprobe, then restart ClipPulse.`, { cause: error }));
        return;
      }
      const detail = error.code ? ` (${error.code})` : '';
      reject(new AppError('PROCESS_START_FAILED', `Could not start ${command}${detail}. Confirm the program is installed and executable.`, { cause: error }));
    });
    child.on('close', (code) => {
      signal?.removeEventListener('abort', abort);
      if (signal?.aborted) {
        reject(new AppError('PROCESS_ABORTED', `${command} was stopped because the media job was cancelled.`));
        return;
      }
      if (code === 0) resolve({ stdout, stderr });
      else reject(new AppError('PROCESS_FAILED', `${command} exited with code ${code}. ${tail(stderr)}`));
    });
  });
}

export function tail(s: string, limit = 1800): string { return s.length > limit ? s.slice(-limit) : s; }

export async function ffmpegAvailable(): Promise<FfmpegAvailability> {
  const problems: string[] = [];
  let ffmpegVersion = '';
  let ffprobeVersion = '';
  let ffmpeg = false;
  let ffprobe = false;
  try { const result = await runCommand('ffmpeg', ['-version']); ffmpegVersion = result.stdout; ffmpeg = true; }
  catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }
  try { const result = await runCommand('ffprobe', ['-version']); ffprobeVersion = result.stdout; ffprobe = true; }
  catch (error) { problems.push(error instanceof Error ? error.message : String(error)); }

  if (ffmpeg && ffprobe) {
    try {
      const [filters, encoders] = await Promise.all([
        runCommand('ffmpeg', ['-hide_banner', '-filters']),
        runCommand('ffmpeg', ['-hide_banner', '-encoders'])
      ]);
      problems.push(...ffmpegCompatibilityProblems(ffmpegVersion, ffprobeVersion, `${filters.stdout}\n${filters.stderr}`, `${encoders.stdout}\n${encoders.stderr}`));
    } catch (error) {
      problems.push(`Could not inspect FFmpeg capabilities: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return { ffmpeg, ffprobe, compatible: ffmpeg && ffprobe && problems.length === 0, ...(problems.length ? { message: problems.join(' ') } : {}) };
}
