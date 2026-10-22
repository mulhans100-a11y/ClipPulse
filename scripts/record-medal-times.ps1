param(
  [ValidateSet('reviewer-a', 'reviewer-b')]
  [string]$Reviewer = 'reviewer-a',
  [string[]]$ClipIds = @()
)

$ErrorActionPreference = 'Stop'
$projectRoot = (Resolve-Path (Join-Path $PSScriptRoot '..')).Path
$reviewRoot = Join-Path $projectRoot 'evaluation/.local/game-review'
$reviewPath = Join-Path $reviewRoot "$Reviewer.json"
if (!(Test-Path -LiteralPath $reviewPath -PathType Leaf)) { throw "Review file not found: $reviewPath. Run prepare-medal-review.ps1 first." }

$review = Get-Content -LiteralPath $reviewPath -Raw | ConvertFrom-Json
if ($review.reviewerId -ne $Reviewer -or $review.game -ne 'Counter-Strike 2') { throw "Unexpected reviewer or game metadata in $reviewPath." }
$items = @($review.items)
if ($ClipIds.Count -gt 0) {
  $unknownIds = @($ClipIds | Where-Object { $_ -notin $items.clipId })
  if ($unknownIds.Count -gt 0) { throw "Unknown clip ID(s): $($unknownIds -join ', ')" }
  $items = @($items | Where-Object { $_.clipId -in $ClipIds })
}

Write-Host "Reviewer: $Reviewer. Enter kill-feed time(s) in seconds, separated by semicolons (example: 4,7; 8,2)."
Write-Host "Enter 'none' after a full review with no clear kill. Press Enter to leave a clip unchanged/unreviewed."
Write-Host 'Use the first frame where the kill feed confirms the elimination, not enemy appearance or the first shot.'

foreach ($item in $items) {
  Write-Host "`n$($item.clipId) · $([Math]::Round([double]$item.durationSeconds, 2)) s · $($item.mediaPath)"
  $inputTimes = (Read-Host 'Kill time(s), none, or Enter to skip').Trim()
  if (!$inputTimes) { continue }

  $annotations = @()
  if ($inputTimes -notmatch '^(?i:none|keine|-)$') {
    $tokens = @($inputTimes -split ';' | ForEach-Object { $_.Trim() })
    $emptyTokens = @($tokens | Where-Object { !$_ })
    if ($tokens.Count -eq 0 -or $emptyTokens.Count -gt 0) { throw "Use semicolons between times for $($item.clipId), for example 4,7; 8,2." }
    $eventIndex = 0
    foreach ($token in $tokens) {
      $parsedTime = 0.0
      $normalized = $token.Replace(',', '.')
      $valid = [double]::TryParse($normalized, [Globalization.NumberStyles]::Float, [Globalization.CultureInfo]::InvariantCulture, [ref]$parsedTime)
      if (!$valid -or ![double]::IsFinite($parsedTime) -or $parsedTime -lt 0 -or $parsedTime -gt [double]$item.durationSeconds) {
        throw "Invalid kill time '$token' for $($item.clipId). Use seconds between 0 and $($item.durationSeconds)."
      }
      $eventIndex++
      $annotations += [ordered]@{
        annotationId = "$Reviewer-$($item.clipId)-$eventIndex"
        annotatorId = $Reviewer
        eventType = 'kill'
        startSeconds = [Math]::Round([Math]::Max(0, $parsedTime - 1), 3)
        decisiveSeconds = [Math]::Round($parsedTime, 3)
        endSeconds = [Math]::Round([Math]::Min([double]$item.durationSeconds, $parsedTime + 1), 3)
      }
    }
  }

  $item.reviewedWholeClip = $true
  $item.annotations = @($annotations)
  Write-Host "Saved $($annotations.Count) kill marker(s) for $($item.clipId)."
}

$json = $review | ConvertTo-Json -Depth 100
[System.IO.File]::WriteAllText($reviewPath, $json, [System.Text.UTF8Encoding]::new($false))
Write-Host "Updated $reviewPath"
