param(
  [switch]$RequireAllClips,
  [switch]$SingleReviewerPilot,
  [ValidateSet('reviewer-a', 'reviewer-b')]
  [string]$Reviewer = 'reviewer-a'
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$reviewRoot = Join-Path $projectRoot 'evaluation/.local/game-review'
$reviewerIds = if ($SingleReviewerPilot) { @($Reviewer) } else { @('reviewer-a', 'reviewer-b') }
$reviewers = @()
foreach ($reviewerId in $reviewerIds) {
  $reviewPath = Join-Path $reviewRoot "$reviewerId.json"
  if (!(Test-Path -LiteralPath $reviewPath -PathType Leaf)) { throw "Review file not found: $reviewPath. Run prepare-medal-review.ps1 first." }
  $reviewers += Get-Content -LiteralPath $reviewPath -Raw | ConvertFrom-Json
}

$nonIndependentReviewers = @($reviewers | Where-Object { $_.independent -ne $true })
if ($reviewers.Count -ne $reviewerIds.Count -or $nonIndependentReviewers.Count -gt 0 -or @($reviewers | Where-Object { $_.reviewerId -notin $reviewerIds }).Count -gt 0) {
  throw 'Review files must match the selected reviewer mode and identify the reviewer as independent of detector proposals.'
}
if ($reviewers | Where-Object { $_.game -ne $reviewers[0].game -or $_.datasetId -ne $reviewers[0].datasetId }) { throw 'Reviewer files must describe the same game and dataset.' }
if ($reviewers[0].items.Count -eq 0 -or @($reviewers | Where-Object { $_.items.Count -ne $reviewers[0].items.Count }).Count -gt 0) { throw 'Reviewer files must contain the same non-empty clip set.' }

$annotators = @($reviewers | ForEach-Object { @{ id = $_.reviewerId; independent = $true; kind = 'human' } })
$items = @()
$completeIndexes = [System.Collections.Generic.List[int]]::new()
$excludedItems = @()
for ($itemIndex = 0; $itemIndex -lt $reviewers[0].items.Count; $itemIndex++) {
  $first = $reviewers[0].items[$itemIndex]
  foreach ($reviewEntry in $reviewers | Select-Object -Skip 1) {
    $other = $reviewEntry.items[$itemIndex]
    if ($first.clipId -ne $other.clipId -or $first.mediaPath -ne $other.mediaPath -or $first.sha256 -ne $other.sha256) { throw "Reviewer media sets differ at item $($itemIndex + 1)." }
  }
  $fullyReviewed = @($reviewers | Where-Object { $_.items[$itemIndex].reviewedWholeClip -eq $true }).Count -eq $reviewers.Count
  if ($fullyReviewed) {
    $completeIndexes.Add($itemIndex)
  } else {
    $reviewRequirement = if ($SingleReviewerPilot) { 'the selected reviewer' } else { 'both reviewers' }
    $excludedItems += @{ mediaPath = [string]$first.mediaPath; reason = "Excluded because $reviewRequirement have not confirmed a complete review." }
  }
}
if ($RequireAllClips -and $excludedItems.Count -gt 0) {
  if ($SingleReviewerPilot) { throw "$($excludedItems.Count) clips do not have a complete review from $Reviewer. Finish all reviews or omit -RequireAllClips to score the reviewed subset." }
  throw "$($excludedItems.Count) clips do not have complete reviews from both reviewers. Finish all reviews or omit -RequireAllClips to score the reviewed subset."
}
if ($completeIndexes.Count -eq 0) {
  if ($SingleReviewerPilot) { throw "No clip has a complete review from $Reviewer. Mark at least one clip reviewedWholeClip=true in that review file." }
  throw 'No clip has complete reviews from both reviewers. Mark at least one shared clip reviewedWholeClip=true in both files.'
}

foreach ($itemIndex in $completeIndexes) {
  $first = $reviewers[0].items[$itemIndex]
  if (!(Test-Path -LiteralPath $first.mediaPath -PathType Leaf)) { throw "Review media is missing: $($first.mediaPath)" }
  $actualHash = (Get-FileHash -LiteralPath $first.mediaPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualHash -ne $first.sha256) { throw "Review media changed after annotation: $($first.mediaPath)" }
  $mergedAnnotations = @()
  foreach ($reviewEntry in $reviewers) {
    $reviewItem = $reviewEntry.items[$itemIndex]
    if ($reviewItem.annotations -isnot [array]) { throw "Annotations must be an array for $($first.clipId)." }
    for ($labelIndex = 0; $labelIndex -lt $reviewItem.annotations.Count; $labelIndex++) {
      $label = $reviewItem.annotations[$labelIndex]
      if (!$label.eventType -or ![double]::IsFinite([double]$label.startSeconds) -or ![double]::IsFinite([double]$label.decisiveSeconds) -or ![double]::IsFinite([double]$label.endSeconds) -or $label.startSeconds -lt 0 -or $label.startSeconds -gt $label.decisiveSeconds -or $label.decisiveSeconds -gt $label.endSeconds -or $label.endSeconds -gt $first.durationSeconds) {
        throw "Invalid event label $($labelIndex + 1) for $($first.clipId)."
      }
      $mergedAnnotations += @{
        annotationId = "$($reviewEntry.reviewerId)-$($first.clipId)-$($labelIndex + 1)"
        annotatorId = $reviewEntry.reviewerId
        eventType = [string]$label.eventType
        startSeconds = [double]$label.startSeconds
        decisiveSeconds = [double]$label.decisiveSeconds
        endSeconds = [double]$label.endSeconds
      }
    }
  }
  $items += @{
    mediaPath = $first.mediaPath
    mediaKind = 'video'
    hasAudio = [bool]$first.hasAudio
    durationSeconds = [double]$first.durationSeconds
    sha256 = [string]$first.sha256
    reviewedBy = @($reviewers | ForEach-Object { $_.reviewerId })
    annotations = $mergedAnnotations
  }
}

$datasetPath = Join-Path $reviewRoot 'dataset.json'
$reportPath = Join-Path $reviewRoot 'report.json'
$annotationMode = if ($SingleReviewerPilot) { 'single-reviewer-pilot' } else { 'independent-review' }
$dataset = @{
  schemaVersion = 1
  datasetId = $reviewers[0].datasetId
  game = $reviewers[0].game
  annotationMode = $annotationMode
  annotators = $annotators
  excludedItems = $excludedItems
  items = $items
}
$dataset | ConvertTo-Json -Depth 50 | Set-Content -LiteralPath $datasetPath -Encoding utf8
& node (Join-Path $projectRoot 'dist/src/main/cli.js') evaluate-highlights --dataset $datasetPath --output $reportPath | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Game-specific highlight evaluation failed.' }
$report = Get-Content -LiteralPath $reportPath -Raw | ConvertFrom-Json
if ($SingleReviewerPilot) {
  Write-Output "Evaluated $($report.mediaItems) $($report.game) clips with $($report.referenceEvents) reference events from one reviewer ($Reviewer). This is not an inter-reviewer consensus report."
} else {
  Write-Output "Evaluated $($report.mediaItems) $($report.game) clips with $($report.referenceEvents) majority-agreed reference events."
}
if ($excludedItems.Count -gt 0) { Write-Output "Skipped $($excludedItems.Count) clips without complete review by the required reviewer set." }
if ($report.mediaItems -lt 3) { Write-Output 'This is a small pilot sample; do not treat its scores as representative performance.' }
Write-Output "Report: $reportPath"
