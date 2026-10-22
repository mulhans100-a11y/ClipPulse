/** Return Medal's documented Windows default capture folder for the system drive. */
export function medalCaptureFolderPreset(platform = process.platform, systemDrive = process.env.SystemDrive): string | null {
  if (platform !== 'win32') return null;
  const drive = /^[A-Za-z]:/.exec(systemDrive ?? '')?.[0] ?? 'C:';
  return `${drive}\\Medal`;
}
