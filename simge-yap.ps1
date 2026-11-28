# Uygulama simgesini çizer: mavi zemin, beyaz fatura kağıdı, sarı Z fişi şeridi.
Add-Type -AssemblyName System.Drawing
function Ciz($boyut, $yol) {
  $b = New-Object System.Drawing.Bitmap $boyut, $boyut
  $g = [System.Drawing.Graphics]::FromImage($b)
  $g.SmoothingMode = 'AntiAlias'
  $o = $boyut / 512.0
  $g.Clear([System.Drawing.Color]::FromArgb(43, 89, 163))
  # Arkadaki sarı Z fişi
  $sari = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(226, 172, 7))
  $g.FillRectangle($sari, [single](276*$o), [single](110*$o), [single](120*$o), [single](270*$o))
  # Önde beyaz fatura (kıvrık köşeli)
  $beyaz = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $nokta = @(@(130,130),@(290,130),@(350,190),@(350,410),@(130,410)) | ForEach-Object { New-Object System.Drawing.PointF ([single]($_[0]*$o)), ([single]($_[1]*$o)) }
  $p.AddPolygon($nokta)
  $g.FillPath($beyaz, $p)
  $kose = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(200, 214, 236))
  $k = @(@(290,130),@(350,190),@(290,190)) | ForEach-Object { New-Object System.Drawing.PointF ([single]($_[0]*$o)), ([single]($_[1]*$o)) }
  $g.FillPolygon($kose, $k)
  # Satırlar
  $mavi = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(43, 89, 163))
  foreach ($y in 230, 275, 320) { $g.FillRectangle($mavi, [single](165*$o), [single]($y*$o), [single](150*$o), [single](16*$o)) }
  $g.FillRectangle($sari, [single](165*$o), [single](360*$o), [single](80*$o), [single](18*$o))
  $b.Save($yol, [System.Drawing.Imaging.ImageFormat]::Png)
  $g.Dispose(); $b.Dispose()
}
Ciz 180 "$PSScriptRoot\icon-180.png"
Ciz 512 "$PSScriptRoot\icon-512.png"
