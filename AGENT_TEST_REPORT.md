# ClipPulse Agent- und Build-Testbericht

## Aktueller v0.1.2-Kandidat — Windows x64, 23. Oktober 2026

| Prüfung | Ergebnis | Messwerte |
| --- | --- | --- |
| `npm run build` | Bestanden | TypeScript, Main-Prozess und Vite-Renderer; im erfolgreichen `npm run package:win` erneut ausgeführt |
| `npm test` | Bestanden | 63 bestanden, 0 fehlgeschlagen, 0 übersprungen; Node-Testlauf 21,21 s nach `npm ci` und Wiederherstellung der Electron-Distribution |
| `npm run smoke-test` | Bestanden | CLI, Projekt erstellen/öffnen, Medienimport, Timeline split/move, FFmpeg/FFprobe, MP4-Export, MCP stdio; Version 0.1.2 |
| `npm audit` | Bestanden | 0 Schwachstellen in allen Abhängigkeiten; `adm-zip` ist auf die korrigierte Version 0.6.1 aufgelöst |
| Windows x64 NSIS-Paket | Bestanden | `ClipPulse Setup 0.1.2.exe`, 160.989.578 Byte; stille Installation in eindeutigem temporärem Ordner, App blieb 12 s geöffnet |
| Gepackter MCP-Server | Bestanden | Im installierten Paket 49 Werkzeuge aufgelistet; Diagnostics-Aufruf beantwortet |
| Signatur | Nicht signiert | Windows meldet `NotSigned`; Electron-Standardicon, da kein Produkticon konfiguriert ist |
| ONNX Runtime im lokalen Node-Prozess | Bestanden | Native Windows-x64-Bindung der auf 1.22.0 gepinnten Runtime wird geladen; Modellinferenz wurde damit nicht separat erneut gemessen |
| Build/Test-Matrix auf Windows, Linux, macOS arm64 und Intel | Vorheriger Stand bestanden | Actions-Lauf #15 prüfte Commit `b6ea427`; der aktuell geänderte Runtime-Pin braucht noch einen eigenen Matrix-Lauf |
| macOS arm64 Paketierung | Vorheriger Stand bestanden | Actions-Lauf #15; der aktuelle Kandidat benötigt einen neuen Paketlauf |
| macOS Intel Paketierung | Vorheriger Stand fehlgeschlagen, Ursache lokal behoben | Actions-Lauf #15 zeigte, dass das ONNX-Runtime-1.30.0-npm-Paket kein macOS-x64-Binding enthält. Der Kandidat pinnt 1.22.0 und verwendet nun die Zielarchitektur aus electron-builder; der Release-Lauf muss dies noch auf einem Intel-Runner nachweisen |
| Codex-/Claude-Host mit v0.1.2 | Nicht getestet | Ein früherer Codex-CLI-Lauf für v0.1.1 steht weiter unten; er belegt keinen aktuellen v0.1.2- oder Claude-Lauf |
| 20 echte Gaming-Clips | Nicht getestet | Für diesen Kandidaten lagen keine lokalen autorisierten Medien vor; das reproduzierbare MCP-E2E nutzt synthetische Medien |

Installer-SHA-256: `AF1F16E2D61C19DF21CFCC3E1275040EC443A1DBE5BABCE7BF729484538B8757`. `npm ci`, `npm run build`, `npm test`, `npm run smoke-test`, `npm audit`, Windows-Paketierung, isolierte Installer-Installation, gepackter MCP-Diagnostics-Aufruf und 12-Sekunden-App-Start wurden am 23. Oktober 2026 ausgeführt. Die lokalen Analyseberichte wurden zuvor am selben Tag mit `npm run evaluate:audio`, `npm run evaluate:valorant-fixture` und `npm run benchmark:preview` aktualisiert. Die Audio-, HUD- und Preview-Messungen sowie ihre Grenzen stehen in [evaluation/README.md](evaluation/README.md), [GAMEPLAY_HIGHLIGHTS.md](GAMEPLAY_HIGHLIGHTS.md) und [TIMELINE_PREVIEW.md](TIMELINE_PREVIEW.md).

> **Historischer Lauf:** Dieser Bericht dokumentiert den Windows-x64-Stand vom 22. Oktober 2026. Er ist kein Nachweis dafür, dass alle späteren, derzeit lokalen Änderungen bereits in diesem Lauf enthalten waren. Die neuere MCP-Onboarding-Prüfung und ihre Grenzen stehen in [MCP_SETUP.md](MCP_SETUP.md).

**Stand:** 22. Oktober 2026
**Getestete Umgebung:** Windows x64, Node.js 24.16.0, npm 11.13.0, FFmpeg/FFprobe 9.0.2, Electron 45.0.0, ClipPulse 0.1.1.

## Ergebnisse

| Prüfung | Ergebnis | Messwerte |
| --- | --- | --- |
| `npm run build` | Bestanden | TypeScript-Typprüfung, Main-Prozess und Renderer-Build |
| `npm test` | Bestanden | 44 bestanden, 0 fehlgeschlagen, 0 übersprungen; 17,87 s nach sauberem `npm ci` |
| SDK-MCP-Agenten-E2E | Bestanden | 23 Aktionen, 100 % Erfolg, 0 fehlgeschlagene Aktionen, 0 Wiederholungen, 3,59 s |
| `npm run smoke-test` | Bestanden | CLI, Projekt anlegen/öffnen, Import, Timeline-Split/Move, FFmpeg/FFprobe, MP4 und MCP-stdio |
| `node scripts/verify-ffmpeg-ci.cjs` | Bestanden | FFmpeg und FFprobe kompatibel; benötigte Encoder/Filter vorhanden |
| `npm audit --omit=dev` | Bestanden | 0 Produktionsabhängigkeits-Schwachstellen |
| Windows-x64-NSIS-Paket | Bestanden | Installer erzeugt; isoliert installiert; App-Archiv, ONNX-Binding und Lizenzhinweise vorhanden; App blieb beim Starttest 12 s geöffnet |
| Codex-CLI mit ClipPulse-MCP | Bestanden | Echter Agentenlauf bis zum fertigen, unabhängig per FFprobe geprüften Export |
| Claude-Host | Nicht getestet | Claude-CLI ist in dieser Umgebung nicht installiert |
| Linux/macOS-Pakete | Nicht getestet | In dieser Windows-Umgebung nicht gebaut; dafür ist die GitHub-Actions-Matrix vorgesehen |
| 20 echte Gaming-Clips | Nicht getestet | Es wurde kein lokales Medienmanifest bereitgestellt; getestet wurden synthetische Medien |

### Reproduzierbarer MCP-SDK-Lauf

Die Testsuite führt einen echten MCP-stdio-Prozess mit dem offiziellen TypeScript-MCP-Client aus. Sie erzeugt synthetisches Gameplay mit Szenenwechseln und einen 120-BPM-Klicktrack, legt das Projekt an, importiert und analysiert Medien, wählt Highlights, erstellt eine beat-synchronisierte 30-Sekunden-Montage, wendet Effekte an, prüft Timeline und Vorschau und exportiert MP4.

- 34 erkannte, 24 ausgewählte Highlights; 24 Review-Entscheidungen
- 12 Videosegmente plus Musik; alle Beat-Zuordnungen lagen bei 0 Frames Abweichung
- 4 Effekteingriffe protokolliert; keine Agentenkorrekturen und keine Wiederholungen
- Export: 147.887 Byte, 30,000 s, H.264/AAC, 320×180, yuv420p, 24 fps, 720 Frames
- Vorschau: 320×180, Frame 360, durchschnittliche Luma 81
- FFprobe-Prüfungen: alle bestanden; Eingabedateien nach dem Export unverändert

Der strukturierte Laufbericht wird von `npm run agent-e2e` unter `test-results/` erzeugt und in CI als versioniertes, plattformbezogenes Artefakt hochgeladen. Der hier geprüfte Bericht heißt `agent-e2e-v0.1.1-win32-x64-20261022-172203494Z.json`. Die JSON-Berichte sind lokale/CI-Testartefakte und keine Release-Assets.

### Separater Codex-Hostlauf

Der verfügbare Codex-CLI-Agent wurde mit einer nur für diesen Aufruf konfigurierten ClipPulse-stdio-MCP-Verbindung ausgeführt. Er hat ohne Shell- oder Dateisystemwerkzeuge ein Projekt erstellt, zwei synthetische Medien importiert, 119,9 BPM und Highlights erkannt, 34 Szenenwechsel akzeptiert, eine 30-Sekunden-Montage mit 10 Videosegmenten gebaut, Zoom/Farbe/Überblendung/Speed-Ramp angewandt, Timeline und Vorschau validiert und den Exportjob bis `complete` abgefragt.

Unabhängige FFprobe-Prüfung des Codex-Exports: 147.655 Byte, 30,000 s, H.264/AAC, 320×180, yuv420p, 24 fps, 720 Frames. Die SHA-256-Werte der synthetischen Video- und Audiodatei entsprachen den beim Import gespeicherten Inhalts-Hashes. Die Ausführung dauerte vom Start des CLI-Turns bis zum abgeschlossenen Renderstatus etwa 77 s, einschließlich Modell- und Tool-Aufrufen. Dies ist ein tatsächlicher lokaler Hosttest; er ist nicht Teil der deterministischen npm-Tests und wird nicht als Claude-Test gewertet.

## Wiederholen

```powershell
npm ci
npm run build
node scripts/verify-ffmpeg-ci.cjs
npm test
npm run smoke-test
npm run agent-e2e
npm run package:win
```

Der Installer-Starttest für einen separaten temporären Ordner:

```powershell
$env:RUNNER_TEMP = Join-Path $env:TEMP 'clippulse-installer-smoke'
New-Item -ItemType Directory -Force -Path $env:RUNNER_TEMP | Out-Null
./scripts/smoke-test-windows-installer.ps1 -InstallerPath './release/ClipPulse Setup 0.1.2.exe'
```

Für den optionalen 20-Clip-Lauf, Manifestformat und FFprobe-/Reportumfang siehe [AGENT_E2E.md](AGENT_E2E.md). Die Medien bleiben außerhalb des Repositorys und werden nicht verändert.

## Historische v0.1.1-Release-Hinweise (22. Oktober 2026)

- Der lokal erzeugte Windows-Installer ist **nicht signiert**. SHA-256 des finalen Installers: `F1285AA922C1974C40FA3CD8CF999E94FAFD13BF6AF3AB7041D982DEFC7593B1`.
- Die v0.1.1-Validierung verwendete SHA-256 `F1285AA922C1974C40FA3CD8CF999E94FAFD13BF6AF3AB7041D982DEFC7593B1`. Die getrennte v0.1.2-Kandidatenprüfung oben enthält den aktuellen Installer-Hash und aktuellen Audit-Status.
- Zum Zeitpunkt dieses historischen Berichts war der geänderte Release-Workflow nicht auf GitHub ausgelöst. Für v0.1.2 sind Push, native Plattformmatrix und Draft-Prüfung die nächsten Schritte.
- Linux/macOS-Zielsysteminstallation, Release-Signaturgeheimnisse und reale Gaming-Clips wurden für v0.1.1 beziehungsweise den aktuellen Kandidaten in der jeweils oben angegebenen Umgebung nicht geprüft.
