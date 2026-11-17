# Uses the installed PowerPoint to (a) export every slide as a PNG for a visual check and
# (b) optionally save a legacy .ppt (PowerPoint 97-2003) copy.
#
#   powershell -File scripts\export-deck.ps1 -Deck feedback.pptx -PngDir <folder> [-SavePpt]
param(
  [Parameter(Mandatory = $true)][string]$Deck,
  [string]$PngDir,
  [switch]$SavePpt
)
$ErrorActionPreference = 'Stop'
$deckPath = (Resolve-Path $Deck).Path
$app = New-Object -ComObject PowerPoint.Application
try {
  # open read-only, without a window
  $pres = $app.Presentations.Open($deckPath, $true, $false, $false)
  if ($PngDir) {
    New-Item -ItemType Directory -Force -Path $PngDir | Out-Null
    $pres.Export((Resolve-Path $PngDir).Path, 'PNG', 1600, 900)
    Write-Host "exported $($pres.Slides.Count) slides to $PngDir"
  }
  if ($SavePpt) {
    $ppt = [System.IO.Path]::ChangeExtension($deckPath, '.ppt')
    $pres.SaveCopyAs($ppt, 1)   # 1 = ppSaveAsPowerPoint97
    Write-Host "saved $ppt"
  }
  $pres.Close()
} finally {
  $app.Quit()
  [System.Runtime.InteropServices.Marshal]::ReleaseComObject($app) | Out-Null
}
