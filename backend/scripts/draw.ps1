param([string]$InputPath, [string]$OutputPath, [string]$JsonPath)

$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

try {
    $img = [System.Drawing.Image]::FromFile((Resolve-Path $InputPath).Path)
    $g = [System.Drawing.Graphics]::FromImage($img)
    $g.TextRenderingHint = 'AntiAlias'

    $raw = Get-Content -Raw -Encoding UTF8 $JsonPath
    $items = $raw | ConvertFrom-Json

    # Detect available CJK font
    $fontName = $null
    foreach ($name in @('Microsoft YaHei', 'SimHei', 'SimSun', 'Arial')) {
        $f = $null
        try { $f = New-Object System.Drawing.Font($name, 10) } catch {}
        if ($f) { $f.Dispose(); $fontName = $name; break }
    }
    if (-not $fontName) {
        $fontName = [System.Drawing.SystemFonts]::DefaultFont.Name
    }

    foreach ($item in $items) {
        $x = [Math]::Max(0, [int]$item.x)
        $y = [Math]::Max(0, [int]$item.y)
        $w = [int]$item.w
        $h = [int]$item.h

        # Expand rect slightly to cover original text
        $padX = [Math]::Max(4, [int]($w * 0.3))
        $padY = [Math]::Max(2, [int]($h * 0.2))
        $rx = [Math]::Max(0, $x - $padX)
        $ry = [Math]::Max(0, $y - $padY)
        $rw = [Math]::Min($img.Width - $rx, $w + $padX * 2)
        $rh = [Math]::Min($img.Height - $ry, $h + $padY * 2)

        if ($rw -le 0 -or $rh -le 0) { continue }

        # Erase original text with white background
        # Transparent text overlay — no background fill

        # Font size matches original text height (bounding rect h ~= font pt size)
        $fontSize = [Math]::Max(8, [Math]::Min($h, 72))
        $font = $null
        for ($fs = $fontSize; $fs -ge 7; $fs -= 1) {
            try { $font = New-Object System.Drawing.Font($fontName, $fs) } catch {}
            if (-not $font) { continue }
            try { $sz = $g.MeasureString($item.translated, $font) } catch { $font.Dispose(); $font = $null; continue }
            if ($sz.Width -le $rw + 20 -or $fs -le 8) { break }
            $font.Dispose()
            $font = $null
        }
        if (-not $font) { try { $font = New-Object System.Drawing.Font($fontName, 8) } catch {} }
        if (-not $font) { continue }

        $brush = New-Object System.Drawing.SolidBrush([System.Drawing.Color]::Black)
        $g.DrawString($item.translated, $font, $brush, [System.Drawing.PointF]::new($rx, $ry))
        $font.Dispose()
        $brush.Dispose()
    }

    $g.Dispose()
    $dir = [System.IO.Path]::GetDirectoryName($OutputPath)
    if ($dir -and -not (Test-Path $dir)) {
        New-Item -ItemType Directory -Force -Path $dir | Out-Null
    }
    $img.Save($OutputPath)
    $img.Dispose()
} catch {
    Write-Host "ERROR: $_"
    exit 1
}
