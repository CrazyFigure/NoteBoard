param([int]$ParentId, [string]$TargetExe)

$ErrorActionPreference = 'Stop'
$SourceExe = Join-Path $PSScriptRoot 'new.exe'
$BackupExe = Join-Path $PSScriptRoot 'old.exe'
$Parent = Get-Process -Id $ParentId -ErrorAction SilentlyContinue
$Replaced = $false

function Start-NoteBoard {
    # PowerShell 的 Start-Process 会按通配符解析工作目录。使用进程 API 传入字面路径。
    $StartInfo = New-Object System.Diagnostics.ProcessStartInfo
    $StartInfo.FileName = $TargetExe
    $StartInfo.WorkingDirectory = [System.IO.Path]::GetDirectoryName($TargetExe)
    $StartInfo.UseShellExecute = $false
    [void][System.Diagnostics.Process]::Start($StartInfo)
}

try {
    # 旧进程释放 EXE 与单实例互斥后才替换。超时不改动程序文件。
    if ($Parent -and -not $Parent.WaitForExit(30000)) { throw '旧版 NoteBoard 未能退出。' }
    [System.IO.File]::Replace($SourceExe, $TargetExe, $BackupExe)
    $Replaced = $true
    Start-NoteBoard
    $Replaced = $false
} catch {
    $Failure = $_.Exception.Message
    if ($Replaced) {
        try { [System.IO.File]::Replace($BackupExe, $TargetExe, $null); $Replaced = $false }
        catch { $Failure = "$Failure`n$($_.Exception.Message)`n$BackupExe" }
    } elseif ((Test-Path -LiteralPath $BackupExe) -and -not (Test-Path -LiteralPath $TargetExe)) {
        # 文件系统在替换中报错时，仍尝试从存在的旧程序备份恢复目标。
        try { [System.IO.File]::Move($BackupExe, $TargetExe) }
        catch { $Replaced = $true; $Failure = "$Failure`n$($_.Exception.Message)`n$BackupExe" }
    }
    Add-Type -AssemblyName System.Windows.Forms
    [void][System.Windows.Forms.MessageBox]::Show($Failure, 'NoteBoard 更新失败')
    if (-not $Replaced -and (-not $Parent -or $Parent.HasExited)) {
        Start-NoteBoard
    }
} finally {
    # 失败且恢复不了时保留旧 EXE，不清除其他文件。
    if (-not $Replaced) { Remove-Item -LiteralPath $BackupExe -Force -ErrorAction SilentlyContinue }
    Remove-Item -LiteralPath $SourceExe, $PSCommandPath -Force -ErrorAction SilentlyContinue
    if (-not $Replaced) { Remove-Item -LiteralPath $PSScriptRoot -Force -ErrorAction SilentlyContinue }
}
