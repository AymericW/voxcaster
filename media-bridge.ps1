# Voxcaster media bridge.
# Reads Spotify's now-playing info from Windows' media controls (the same data as the
# volume flyout), so the player needs no Spotify API calls for it. Accepts
# play/pause/toggle/next/prev on stdin and writes one JSON object per line to stdout:
#   {"type":"state", ...} whenever playback changes
#   {"type":"cmd", "cmd":..., "ok":...} after each command
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [Text.Encoding]::UTF8
Add-Type -AssemblyName System.Runtime.WindowsRuntime

$asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
  $_.Name -eq 'AsTask' -and $_.GetParameters().Count -eq 1 -and
  $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
} | Select-Object -First 1

function Await($op, [Type]$type) {
  $task = $asTask.MakeGenericMethod($type).Invoke($null, @($op))
  $null = $task.Wait(5000)
  $task.Result
}

function Send($obj) {
  [Console]::Out.WriteLine(($obj | ConvertTo-Json -Compress))
  [Console]::Out.Flush()
}

$null = [Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager, Windows.Media.Control, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.DataReader, Windows.Storage.Streams, ContentType = WindowsRuntime]
$null = [Windows.Storage.Streams.IRandomAccessStream, Windows.Storage.Streams, ContentType = WindowsRuntime]
$manager = Await ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager]::RequestAsync()) `
  ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionManager])

function Get-SpotifySession {
  foreach ($s in $manager.GetSessions()) {
    if ($s.SourceAppUserModelId -like '*Spotify*') { return $s }
  }
  $null
}

function Get-Thumbnail($props) {
  if (-not $props.Thumbnail) { return $null }
  try {
    $ras = Await ($props.Thumbnail.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
    # PowerShell can't see this object's interface members, so go through the interface.
    $iface = [Windows.Storage.Streams.IRandomAccessStream]
    $size = [uint32]$iface.GetProperty('Size').GetValue($ras)
    if ($size -eq 0) { return $null }
    $input = $iface.GetMethod('GetInputStreamAt').Invoke($ras, @([uint64]0))
    $reader = [Windows.Storage.Streams.DataReader]::new($input)
    $null = Await ($reader.LoadAsync($size)) ([uint32])
    $bytes = New-Object byte[] $size
    $reader.ReadBytes($bytes)
    $reader.Dispose()
    $type = if ($bytes[0] -eq 0x89) { 'image/png' } else { 'image/jpeg' }
    "data:$type;base64," + [Convert]::ToBase64String($bytes)
  } catch { [Console]::Error.WriteLine("thumbnail: $($_.Exception.Message)"); $null }
}

# [Console]::In is empty when PowerShell runs a script with -File, so read the raw handle.
$stdin = New-Object System.IO.StreamReader([Console]::OpenStandardInput())
$pending = $stdin.ReadLineAsync()
$lastKey = $null
$lastTrack = $null
$art = $null
$artSentFor = $null

while ($true) {
  while ($pending.IsCompleted) {
    $cmd = $pending.Result
    if ($null -eq $cmd) { [Console]::Error.WriteLine('stdin closed'); exit 0 } # Voxcaster quit
    $ok = $false
    $s = Get-SpotifySession
    if ($s) {
      $op = switch ($cmd.Trim()) {
        'play' { $s.TryPlayAsync() }
        'pause' { $s.TryPauseAsync() }
        'toggle' { $s.TryTogglePlayPauseAsync() }
        'next' { $s.TrySkipNextAsync() }
        'prev' { $s.TrySkipPreviousAsync() }
      }
      if ($op) { $ok = [bool](Await $op ([bool])) }
    }
    Send @{ type = 'cmd'; cmd = $cmd.Trim(); ok = $ok }
    $lastKey = $null # report fresh state after a command
    $pending = $stdin.ReadLineAsync()
  }

  $msg = @{ type = 'state'; available = $false }
  try {
    $s = Get-SpotifySession
    if ($s) {
      $props = Await ($s.TryGetMediaPropertiesAsync()) ([Windows.Media.Control.GlobalSystemMediaTransportControlsSessionMediaProperties])
      $playback = $s.GetPlaybackInfo()
      $timeline = $s.GetTimelineProperties()
      $track = "$($props.Title)|$($props.Artist)"
      if ($track -ne $lastTrack) { $lastTrack = $track; $art = Get-Thumbnail $props }
      $msg = @{
        type = 'state'
        available = [bool]$props.Title
        title = $props.Title
        artist = $props.Artist
        album = $props.AlbumTitle
        isPlaying = ($playback.PlaybackStatus -eq 'Playing')
        position = [int64]$timeline.Position.TotalMilliseconds
        duration = [int64]$timeline.EndTime.TotalMilliseconds
        updatedAt = $timeline.LastUpdatedTime.ToUnixTimeMilliseconds()
      }
    }
  } catch { }

  # Only report changes. The art (large) is sent once per track, and left out of the comparison.
  $key = $msg | ConvertTo-Json -Compress
  if ($key -ne $lastKey) {
    $lastKey = $key
    if ($msg.available -and $lastTrack -ne $artSentFor) {
      $msg.art = $art
      $artSentFor = $lastTrack
    }
    Send $msg
  }
  Start-Sleep -Milliseconds 400
}
