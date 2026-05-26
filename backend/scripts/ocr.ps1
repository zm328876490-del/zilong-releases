param([string]$ImagePath)

[Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime] | Out-Null
[Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
[Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null

function Await($op) {
    $asTask = ([System.Runtime.WindowsRuntime.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
        $_.Name -eq 'AsTask' -and $_.IsGenericMethod -and $_.GetParameters().Count -eq 1
    })[0]
    $task = $asTask.MakeGenericMethod(@($op.GetType().GenericTypeArguments[0])).Invoke($null, @($op))
    $task.Wait()
    return $task.Result
}

try {
    $fullPath = (Resolve-Path $ImagePath).Path
    $file = Await ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fullPath))
    $stream = Await ($file.OpenReadAsync())
    $decoder = Await ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream))
    $bitmap = Await ($decoder.GetSoftwareBitmapAsync())

    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages()
    if (-not $engine) { Write-Host '[]'; exit 0 }

    $result = Await ($engine.RecognizeAsync($bitmap))

    $items = @()
    foreach ($line in $result.Lines) {
        foreach ($word in $line.Words) {
            $items += [PSCustomObject]@{
                text = $word.Text
                x    = [int]$word.BoundingRect.X
                y    = [int]$word.BoundingRect.Y
                w    = [int]$word.BoundingRect.Width
                h    = [int]$word.BoundingRect.Height
            }
        }
    }
    ConvertTo-Json @($items) -Compress
} catch {
    Write-Host "[]"
}
