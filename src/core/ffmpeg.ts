import { spawn } from 'node:child_process';
import { AppError } from './errors';

export interface CommandResult { stdout: string; stderr: string; }

export function runCommand(command: string, args: string[], onStdout?: (line: string) => void): Promise<CommandResult> {
  return new Promise((resolve, reject) => {
    const child = spawn(command, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    child.stdout.setEncoding('utf8');
    child.stderr.setEncoding('utf8');
    child.stdout.on('data', (chunk: string) => { stdout += chunk; onStdout?.(chunk); });
    child.stderr.on('data', (chunk: string) => { stderr += chunk; });
    child.on('error', (error) => {
      reject(new AppError('PROCESS_START_FAILED', `Could not start ${command}. Install FFmpeg and make sure ffmpeg and ffprobe are on PATH.`, { cause: error }));
    });
    child.on('close', (code) => {
      if (code === 0) resolve({ stdout, stderr });
      else reject(new AppError('PROCESS_FAILED', `${command} exited with code ${code}. ${tail(stderr)}`));
    });
  });
}

export function tail(s: string, limit = 1800): string { return s.length > limit ? s.slice(-limit) : s; }

export async function ffmpegAvailable(): Promise<{ ffmpeg: boolean; ffprobe: boolean; message?: string }> {
  try {
    await runCommand('ffmpeg', ['-version']);
    await runCommand('ffprobe', ['-version']);
    return { ffmpeg: true, ffprobe: true };
  } catch (error) {
    return { ffmpeg: false, ffprobe: false, message: error instanceof Error ? error.message : String(error) };
  }
}
