# ClipPulse

ClipPulse is a free, open-source desktop video editor for gaming clips and music-led montages. It helps you bring local footage and music together, arrange and edit clips on a timeline, and export a finished video. You can edit manually or use the montage generator to create editable starting points.

The application is built with Electron, React, and TypeScript. Media processing and rendering use FFmpeg. Projects refer to your original files; editing does not overwrite them.

## What you can do

- Import videos and audio from individual files or folders, including a local Medal capture folder.
- Organize your media library with search, tags, favorites, game names, and cached thumbnails and waveforms.
- Add your own music. Supported formats include MP3, WAV, FLAC, M4A, AAC, OGG, OPUS, and WMA.
- Arrange, move, trim, split, duplicate, and remove clips across video and audio tracks.
- Preview source footage and the edited timeline, then render an MP4 with H.264 video and AAC audio.
- Adjust clip position, scale, rotation, opacity, color, playback speed, and audio. Add titles, transitions, fades, and keyframes.
- Analyze music for beats, downbeats, tempo, and changes in energy. Use these cues to guide editing and beat snapping.
- Generate one or more editable montage projects from selected footage and music, using a pacing style and target duration.
- Use the command-line interface to create projects, import and inspect media, edit timelines, analyze media, generate montages, and export videos.

## How montage generation works

Choose gameplay footage and a music track, then select a target duration and a pacing style. OpenMontage analyzes the local media, finds candidate audio and video cues, and uses those cues to suggest clip selections and cut positions. Each result is saved as its own project, so you can open it, make changes, preview it, and export it like a manually edited project.

The analysis is local and heuristic. It can identify signals such as audio activity, scene changes, sampled-frame motion, and optional HUD text, but it is not a trained gameplay-understanding system. Suggested events and beat positions can be wrong and should be reviewed while editing.

## Getting started

### Requirements

- Windows 10 or 11 for the currently documented desktop setup
- Node.js 24 or newer and npm 10 or newer
- FFmpeg and FFprobe 6 or newer available on `PATH`
- Git, to get the source code

Tesseract OCR is optional and is only needed for HUD-text detection. Optional object segmentation downloads its model weights the first time that feature is used. Neither tool is required for basic editing or export. See [INSTALLATION.md](INSTALLATION.md) for setup details and troubleshooting.

### Run from source

```powershell
git clone https://github.com/mulhans100-a11y/ClipPulse.git
cd ClipPulse
npm ci
npm run dev
```

Check the [GitHub Releases page](https://github.com/mulhans100-a11y/ClipPulse/releases) for prebuilt installers. FFmpeg is installed separately and is not bundled with the application.

### Make your first edit

1. Create or open a project.
2. Import gameplay clips and any music you want to use. You can select files or import a folder.
3. Add clips to video tracks and music to an audio track.
4. Arrange and trim the clips. Use the preview and inspector to refine timing, image, and sound.
5. Export the project as an MP4.

For an automatically assembled starting point, choose the montage generator, select the footage and your own music, set a duration and style, and generate a project variant. Review and edit the result before exporting.

## Project files and media

Projects use the `.omproj` format. The project stores the edit and references media at its local file paths; it does not embed or alter the original footage or music. Keep the referenced files in place, or relink them if they move. Project edits are saved automatically, with a backup snapshot and undo/redo history.

The Medal shortcut imports from a local capture folder on your computer. It does not connect to a Medal account or cloud service. The application performs media analysis and rendering locally; optional model weights are downloaded separately when segmentation is first used.

## Command-line examples

Build the application and create a project:

```powershell
npm run build
npm run cli -- create --project .\montage.omproj --fps 60/1
npm run cli -- import --project .\montage.omproj D:\Captures\Valorant
npm run cli -- inspect --project .\montage.omproj
```

The import and inspect commands report media and track IDs. Use those IDs to place a clip on the timeline and export it:

```powershell
npm run cli -- clip-add --project .\montage.omproj --media <VIDEO_ID> --track <VIDEO_TRACK_ID> --start 0 --source-in 4.2 --duration 3.5
npm run cli -- export --project .\montage.omproj --output .\montage.mp4
```

To generate editable montage projects from music and footage, run:

```powershell
npm run cli -- analyze-audio --project .\montage.omproj --media <MUSIC_ID>
npm run cli -- generate-montage --project .\montage.omproj --music <MUSIC_ID> --duration 30 --style aggressive --variants 3 --format portrait-1080p
```

The generator prints the paths to the created variants. Export a variant by passing its `.omproj` path to the export command.

See [API.md](API.md) for CLI details and [AGENT_API.md](AGENT_API.md) for the local automation interfaces.

## Current limitations

- Timeline playback is rendered to a preview video before it plays; it is not live playback while editing. Changes require the preview to render again.
- Event detection, tempo, beat, and downbeat positions are estimates. The montage generator can suggest useful cuts, but it does not reliably understand every game event or guarantee that a cut matches the music.
- HUD text detection requires Tesseract. Optional segmentation recognizes common object categories and does not isolate arbitrary game-specific objects.
- Rendering requires a compatible FFmpeg installation with the needed filters and encoders. See the installation guide for checks.

## Development

```powershell
npm run dev
npm run build
npm test
```

The test suite creates short synthetic media files with FFmpeg. It does not require your personal clips or music.

## Documentation and contribution

- [Installation and troubleshooting](INSTALLATION.md)
- [Architecture](ARCHITECTURE.md)
- [CLI and API](API.md)
- [Automation interface](AGENT_API.md)
- [Contributing](CONTRIBUTING.md)
- [Security policy](SECURITY.md)
- [Dependencies](DEPENDENCIES.md)

ClipPulse is licensed under [GPL-3.0-or-later](LICENSE).
