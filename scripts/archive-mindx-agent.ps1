$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
Set-StrictMode -Version Latest

$SourceRoot = 'D:\CodeX\mindx-agent'
$DestinationZip = 'D:\CodeX\mindx-agent-source.zip'

$ExcludedDirectoryNames = @(
  '.git',
  'node_modules',
  'dist',
  'build',
  '.next',
  '.nuxt',
  '.cache',
  'coverage',
  '.venv',
  'venv',
  '__pycache__'
)

$ExcludedFileNamePatterns = @(
  '.env',
  '.env.*',
  '.envrc',
  '.npmrc',
  '.pypirc',
  '*.pem',
  '*.key',
  '*.crt',
  '*.cer',
  '*.p12',
  '*.pfx',
  'id_rsa',
  'id_rsa.*',
  'id_ed25519',
  'id_ed25519.*',
  'mindx-agent-source.zip'
)

function Test-ExcludedDirectory {
  param([Parameter(Mandatory = $true)][string]$RelativePath)

  $segments = $RelativePath -split '[\\/]+'
  foreach ($segment in $segments) {
    if ($ExcludedDirectoryNames -contains $segment) {
      return $true
    }
  }

  return $false
}

function Test-ExcludedFileName {
  param([Parameter(Mandatory = $true)][string]$FileName)

  foreach ($pattern in $ExcludedFileNamePatterns) {
    if ($FileName -like $pattern) {
      return $true
    }
  }

  return $false
}

if (-not (Test-Path -LiteralPath $SourceRoot -PathType Container)) {
  throw "Source directory does not exist: $SourceRoot"
}

$resolvedSourceRoot = (Resolve-Path -LiteralPath $SourceRoot).Path.TrimEnd('\')
$sourcePrefix = $resolvedSourceRoot + '\'
$stagingRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("mindx-agent-archive-" + [guid]::NewGuid().ToString('N'))

try {
  New-Item -ItemType Directory -Path $stagingRoot -Force | Out-Null

  $files = Get-ChildItem -LiteralPath $resolvedSourceRoot -Recurse -File -Force | Where-Object {
    $relativePath = $_.FullName.Substring($sourcePrefix.Length)
    -not (Test-ExcludedDirectory -RelativePath $relativePath) -and
    -not (Test-ExcludedFileName -FileName $_.Name)
  }

  foreach ($file in $files) {
    $relativePath = $file.FullName.Substring($sourcePrefix.Length)
    $targetPath = Join-Path $stagingRoot $relativePath
    $targetDir = Split-Path -Parent $targetPath

    if (-not (Test-Path -LiteralPath $targetDir -PathType Container)) {
      New-Item -ItemType Directory -Path $targetDir -Force | Out-Null
    }

    Copy-Item -LiteralPath $file.FullName -Destination $targetPath -Force
  }

  if (Test-Path -LiteralPath $DestinationZip) {
    Remove-Item -LiteralPath $DestinationZip -Force
  }

  Compress-Archive -Path (Join-Path $stagingRoot '*') -DestinationPath $DestinationZip -Force

  $archive = Get-Item -LiteralPath $DestinationZip
  [pscustomobject]@{
    Path = $archive.FullName
    SizeBytes = $archive.Length
    LastWriteTime = $archive.LastWriteTime.ToString('s')
    SourceRoot = $resolvedSourceRoot
  } | Format-List
} finally {
  if (Test-Path -LiteralPath $stagingRoot) {
    Remove-Item -LiteralPath $stagingRoot -Recurse -Force
  }
}
