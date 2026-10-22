param(
  [string]$PersonalMusicPath
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$datasetRoot = Join-Path $projectRoot 'evaluation/.local/artbeat'
$archivePath = Join-Path $datasetRoot 'ARTBeaT_Dataset.zip'
$extractRoot = Join-Path $datasetRoot 'source'
$audioRoot = Join-Path $extractRoot 'ARTBeaT_Dataset/Audio'
$annotationRoot = Join-Path $extractRoot 'ARTBeaT_Dataset/Annotations/gt_csv'
$manifestPath = Join-Path $datasetRoot 'dataset.json'
$reportPath = Join-Path $datasetRoot 'report.json'
$sourceUrl = 'https://www.audiolabs-erlangen.de/content/resources/MIR/00_2024-ARTBeaT/data/ARTBeaT_Dataset.zip'

New-Item -ItemType Directory -Force -Path $datasetRoot | Out-Null
if (!(Test-Path -LiteralPath $archivePath)) {
  Invoke-WebRequest -Uri $sourceUrl -OutFile $archivePath
}
if (!(Test-Path -LiteralPath $audioRoot)) {
  New-Item -ItemType Directory -Force -Path $extractRoot | Out-Null
  Expand-Archive -LiteralPath $archivePath -DestinationPath $extractRoot -Force
}

$ffprobe = (Get-Command ffprobe -ErrorAction Stop).Source
$referenceId = 'ARTBeaT-published-ground-truth'
$annotator = @{ id = $referenceId; independent = $true; kind = 'published-reference' }
$profiles = @{
  '01' = @{ category = 'basic'; description = 'Metronome calibration' }
  '02' = @{ category = 'basic'; description = 'Synthesizer arpeggio with added instruments' }
  '03' = @{ category = 'rhythmic-deception'; description = 'Delayed accompaniment shifts perceived rhythm' }
  '04' = @{ category = 'polyrhythm'; description = 'Two simultaneous pulse rates' }
  '05' = @{ category = 'tempo-change'; description = 'Abrupt tempo change, 75 to 150 BPM' }
  '06' = @{ category = 'tempo-change'; description = 'Abrupt tempo change, 150 to 75 BPM' }
  '07' = @{ category = 'tempo-change'; description = 'Abrupt tempo change, 75 to 112.5 BPM' }
  '08' = @{ category = 'tempo-change'; description = 'Abrupt tempo change, 112.5 to 75 BPM' }
  '09' = @{ category = 'tempo-change'; description = 'Abrupt tempo change, 90 to 80 BPM' }
  '10' = @{ category = 'tempo-change'; description = 'Abrupt tempo change, 90 to 120 BPM' }
  '11' = @{ category = 'tempo-change'; description = 'Abrupt tempo change, 60 to 80 BPM' }
  '12' = @{ category = 'tempo-change'; description = 'Abrupt tempo change, 80 to 150 BPM' }
  '13' = @{ category = 'tempo-change'; description = 'Abrupt tempo change, 180 to 120 BPM' }
  '14' = @{ category = 'tempo-change'; description = 'Abrupt tempo change, 240 to 96 BPM' }
  '15' = @{ category = 'tempo-and-meter-change'; description = 'Changes from 4/4 at 85 BPM to 6/4 at 127.5 BPM' }
  '16' = @{ category = 'odd-meter'; description = '7/8 drum pattern'; beatsPerBar = 7; denominator = 8 }
  '17' = @{ category = 'odd-meter'; description = 'Heavy guitar and drums in 7/8'; beatsPerBar = 7; denominator = 8 }
  '18' = @{ category = 'expressive-tempo'; description = 'Debussy piano performance with continuous tempo fluctuation' }
  '19' = @{ category = 'continuous-tempo-change'; description = 'Continuous tempo increase from 80 to 200 BPM' }
  '20' = @{ category = 'continuous-tempo-change'; description = 'Continuous tempo decrease from 200 to 80 BPM' }
  '21' = @{ category = 'polyrhythm'; description = '140 BPM pulse with a later 105 BPM drum pulse' }
  '22' = @{ category = 'polyrhythm'; description = '4-over-3 rhythm in regular 4/4'; beatsPerBar = 4; denominator = 4 }
  '23' = @{ category = 'rhythmic-deception'; description = '4/4 beat with syncopated ride cymbal'; beatsPerBar = 4; denominator = 4 }
  '24' = @{ category = 'syncopation'; description = 'Irregularly syncopated 94 BPM rhythm' }
  '25' = @{ category = 'odd-meter'; description = 'Heavy guitar and drums in 11/8'; beatsPerBar = 11; denominator = 8 }
}
$fixedTempoIds = @('02', '03', '16', '17', '22', '23', '24', '25')
$items = @()
$excludedItems = @()
foreach ($audioFile in (Get-ChildItem -LiteralPath $audioRoot -File -Filter '*.wav' | Sort-Object Name)) {
  $id = $audioFile.BaseName.Substring(0, 2)
  $profile = $profiles[$id]
  if (!$profile) { throw "No evaluation profile exists for ARTBeaT item $id." }
  $annotationFile = Join-Path $annotationRoot ($audioFile.BaseName + '_gt.csv')
  if (!(Test-Path -LiteralPath $annotationFile)) { throw "Missing published beat reference: $annotationFile" }
  $beats = @(Get-Content -LiteralPath $annotationFile | ForEach-Object { [double]::Parse($_, [Globalization.CultureInfo]::InvariantCulture) })
  if ($beats.Count -lt 8) { throw "Reference file has too few beat labels: $annotationFile" }

  $durationText = (& $ffprobe -v error -show_entries format=duration -of csv=p=0 $audioFile.FullName).Trim()
  $duration = [double]::Parse($durationText, [Globalization.CultureInfo]::InvariantCulture)
  $outOfRange = @($beats | Where-Object { $_ -gt $duration })
  if ($outOfRange.Count) {
    $excludedItems += @{ mediaPath = "source/ARTBeaT_Dataset/Audio/$($audioFile.Name)"; reason = "Published beat reference extends $([Math]::Round(($outOfRange | Measure-Object -Maximum).Maximum - $duration, 3)) seconds beyond the audio duration; excluded without editing source labels." }
    continue
  }
  $musicAnnotation = @{ annotatorId = $referenceId; beatTimesSeconds = $beats; downbeatTimesSeconds = @() }
  if ($fixedTempoIds -contains $id) {
    $intervals = @()
    for ($index = 1; $index -lt $beats.Count; $index++) { $intervals += ($beats[$index] - $beats[$index - 1]) }
    $sortedIntervals = @($intervals | Sort-Object)
    $medianInterval = if ($sortedIntervals.Count % 2) { $sortedIntervals[[Math]::Floor($sortedIntervals.Count / 2)] } else { ($sortedIntervals[$sortedIntervals.Count / 2 - 1] + $sortedIntervals[$sortedIntervals.Count / 2]) / 2 }
    $referenceBpm = 60 / $medianInterval
    if ($profile.denominator -eq 8) { $referenceBpm = $referenceBpm * 4 / 8 }
    $musicAnnotation.bpm = [Math]::Round($referenceBpm, 2)
  }
  if ($profile.ContainsKey('beatsPerBar')) {
    $musicAnnotation.meter = @{ beatsPerBar = $profile.beatsPerBar; denominator = $profile.denominator; downbeatPhase = 0 }
    for ($index = 0; $index -lt $beats.Count; $index += $profile.beatsPerBar) { $musicAnnotation.downbeatTimesSeconds += $beats[$index] }
  }
  $items += @{
    mediaPath = "source/ARTBeaT_Dataset/Audio/$($audioFile.Name)"
    mediaKind = 'audio'
    hasAudio = $true
    durationSeconds = [Math]::Round($duration, 6)
    sha256 = (Get-FileHash -LiteralPath $audioFile.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
    reviewedBy = @($referenceId)
    annotations = @()
    musicProfile = @{ category = $profile.category; description = $profile.description }
    musicAnnotations = @($musicAnnotation)
  }
}

$archiveSha = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
$dataset = @{
  schemaVersion = 1
  datasetId = "artbeat-2024-$($archiveSha.Substring(0, 12))"
  game = 'ARTBeaT music reference set'
  referenceSource = @{
    kind = 'published-music-reference'
    name = 'ARTBeaT Dataset'
    sourceUrl = 'https://www.audiolabs-erlangen.de/resources/MIR/2024-ARTBeaT'
    license = 'CC BY 4.0'
    citation = 'Rico Rosenbusch, Automated Real-Time Beat Tracking: Response Time and Confidence Analysis, FAU, 2024.'
    annotationMethod = 'Published ground-truth beat timestamps from the dataset CSV files. The source separately describes a listening study; individual participant records are not included in the download and are not represented as separate reviewers here.'
    sourceRevision = $archiveSha
  }
  annotators = @($annotator)
  excludedItems = $excludedItems
  items = $items
}
$datasetJson = $dataset | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($manifestPath, $datasetJson, [System.Text.UTF8Encoding]::new($false))

Push-Location $projectRoot
try {
  & npm.cmd run build
  if ($LASTEXITCODE -ne 0) { throw 'OpenMontage build failed.' }
  & node (Join-Path $projectRoot 'dist/src/main/cli.js') evaluate-highlights --dataset $manifestPath --output $reportPath | Out-Null
  if ($LASTEXITCODE -ne 0) { throw 'ARTBeaT evaluation failed.' }
} finally { Pop-Location }

$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
Write-Output "Dataset: $($report.datasetId)"
Write-Output "Tracks: $($report.mediaItems)"
Write-Output "BPM MAE: $($report.musicSummary.bpmMeanAbsoluteError)"
Write-Output "Beat F1: $($report.musicSummary.beatF1)"
Write-Output "Downbeat F1: $($report.musicSummary.downbeatF1)"
Write-Output "Meter accuracy / coverage: $($report.musicSummary.meterAccuracy) / $($report.musicSummary.meterCoverage)"
Write-Output "Local report: $reportPath"

if ($PersonalMusicPath) {
  $personalPath = (Resolve-Path -LiteralPath $PersonalMusicPath).Path
  $personalReportPath = Join-Path $datasetRoot 'personal-track-analysis.json'
  $runnerPath = Join-Path $datasetRoot 'analyze-personal-track.mjs'
  @'
import { pathToFileURL } from 'node:url';
const { analyzeAudio } = await import(pathToFileURL(process.argv[2]));
const analysis = await analyzeAudio(process.argv[3]);
console.log(JSON.stringify({
  sourceFile: process.argv[3],
  method: analysis.method,
  durationSeconds: analysis.durationSeconds,
  estimatedBpm: analysis.estimatedBpm ?? null,
  bpmHypotheses: analysis.bpmHypotheses,
  meter: analysis.meter ?? null,
  beatCount: analysis.beats.length,
  downbeatCount: analysis.downbeats.length,
  energySections: analysis.energySections,
  drops: analysis.drops
}, null, 2));
'@ | Set-Content -LiteralPath $runnerPath -Encoding utf8
  Push-Location $projectRoot
  try {
    & node $runnerPath (Join-Path $projectRoot 'dist/src/core/audioAnalysis.js') $personalPath | Set-Content -LiteralPath $personalReportPath -Encoding utf8
    if ($LASTEXITCODE -ne 0) { throw 'Personal track analysis failed.' }
  } finally { Pop-Location }
  $personalReport = Get-Content -LiteralPath $personalReportPath -Raw | ConvertFrom-Json
  Write-Output "Personal track analysis: BPM $($personalReport.estimatedBpm), $($personalReport.beatCount) beats, meter $($personalReport.meter.beatsPerBar)/$($personalReport.meter.denominator)"
  Write-Output "Personal track exploratory report: $personalReportPath (not scored against ground truth)"
}
