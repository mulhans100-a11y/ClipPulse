param(
  [string]$Game = 'Counter-Strike 2',
  [int]$ClipCount = 12,
  [switch]$SingleReviewer
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$sourceRoot = Join-Path 'C:\Medal\Clips' $Game
$reviewRoot = Join-Path $projectRoot 'evaluation/.local/game-review'
$ffprobe = (Get-Command ffprobe -ErrorAction Stop).Source
if (!(Test-Path -LiteralPath $sourceRoot -PathType Container)) { throw "Medal game folder not found: $sourceRoot" }
if ($ClipCount -lt 1 -or $ClipCount -gt 40) { throw 'ClipCount must be between 1 and 40.' }

$files = @(Get-ChildItem -LiteralPath $sourceRoot -Recurse -File | Where-Object { $_.Extension -match '^\.(mp4|mkv|mov|webm)$' } | Sort-Object FullName)
if ($files.Count -lt $ClipCount) { throw "Found only $($files.Count) video clips under $sourceRoot; requested $ClipCount." }
New-Item -ItemType Directory -Force -Path $reviewRoot | Out-Null

$selected = @()
$used = [System.Collections.Generic.HashSet[int]]::new()
for ($sample = 0; $sample -lt $ClipCount; $sample++) {
  $index = [Math]::Floor(($sample + 0.5) * $files.Count / $ClipCount)
  if (!$used.Add($index)) { throw 'Sampling produced a duplicate clip.' }
  $selected += $files[$index]
}

$items = @()
for ($index = 0; $index -lt $selected.Count; $index++) {
  $media = $selected[$index]
  $metadata = (& $ffprobe -v error -show_entries format=duration:stream=codec_type -of json $media.FullName | ConvertFrom-Json)
  $duration = [double]::Parse([string]$metadata.format.duration, [Globalization.CultureInfo]::InvariantCulture)
  $hash = (Get-FileHash -LiteralPath $media.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
  $clipId = 'cs2-{0:D2}' -f ($index + 1)
  $items += @{
    clipId = $clipId
    mediaPath = $media.FullName
    mediaKind = 'video'
    hasAudio = @($metadata.streams | Where-Object codec_type -eq 'audio').Count -gt 0
    durationSeconds = [Math]::Round($duration, 6)
    sha256 = $hash
    reviewedWholeClip = $false
    annotations = @()
  }
}

$reviewerIds = if ($SingleReviewer) { @('reviewer-a') } else { @('reviewer-a', 'reviewer-b') }
foreach ($reviewerId in $reviewerIds) {
  $review = @{
    schemaVersion = 1
    datasetId = 'phase-c-counter-strike-2-local-review'
    game = $Game
    reviewerId = $reviewerId
    independent = $true
    instructions = 'Watch every entire clip without consulting the other reviewer file. Set reviewedWholeClip=true only after viewing its full duration. Add all target gameplay moments with eventType, startSeconds, decisiveSeconds, and endSeconds. Use annotations=[] only after confirming no target moment is present.'
    items = $items
  }
  Set-Content -LiteralPath (Join-Path $reviewRoot "$reviewerId.json") -Value ($review | ConvertTo-Json -Depth 50) -Encoding utf8
}

$guide = @'
# Private Counter-Strike 2 review set

This is an optional local benchmark helper. It is not required to use or complete OpenMontage.

Run `scripts/record-medal-times.ps1` to enter kill-feed times in seconds (for example `4,7; 8,2`). Use `none` after a full review with no clear kill; press Enter to leave a clip unreviewed. The helper creates event labels, fixed context bounds, IDs, and the full-review flag.

For a one-reviewer pilot, run `scripts/merge-medal-review.ps1 -SingleReviewerPilot`; for two independent reviewers, run it without that switch. Results are exploratory unless a sufficiently large representative set is reviewed.
'@
Set-Content -LiteralPath (Join-Path $reviewRoot 'README.md') -Value $guide -Encoding utf8
Write-Output "Prepared $ClipCount optional review clips from $sourceRoot"
Write-Output "Review files: $($reviewerIds -join ', ')"
