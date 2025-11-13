# collect-code.ps1
$OutputFile = "singlefile-code.txt"
$ProjectRoot = Get-Location

Write-Host "Sobiraem vse TypeScript fayly proekta (isklyuchaya /src/generated)..." -ForegroundColor Green

# Udalyayem staryy fayl esli sushchestvuet
if (Test-Path $OutputFile) { 
    Remove-Item $OutputFile 
    Write-Host "Udalem staryy fayl $OutputFile" -ForegroundColor Yellow
}

# Sozdaem zagolovok
$header = @"
================================================================================
  PUMP SCOUT BOT - Project full code collection
  DATA: $(Get-Date -Format "yyyy-MM-dd HH:mm:ss")
  ISKLYUCHENO: src/generated
================================================================================

"@
$header | Out-File $OutputFile -Encoding UTF8

# Poluchaem vse .ts fayly rekursivno, НО ИСКЛЮЧАЯ папку /src/generated
$files = Get-ChildItem -Path "src" -Recurse -Filter "*.ts" | 
         Where-Object { $_.FullName -notmatch '\\src\\generated\\' -and $_.FullName -notmatch '/src/generated/' }

$fileCount = 0
foreach ($file in $files) {
    $fileCount++
    $relativePath = $file.FullName.Replace($ProjectRoot, "").TrimStart('\').Replace('\', '/')
    
    Write-Host "Obrabatyvaetsya: $relativePath" -ForegroundColor Cyan
    
    # Dobavlyaem razdelitel
    $separator = @"

========================================================================
  FILE: $relativePath
========================================================================

"@
    $separator | Out-File $OutputFile -Append -Encoding UTF8
    
    # Dobavlyaem soderzhimoe fayla
    Get-Content $file.FullName -Encoding UTF8 | Out-File $OutputFile -Append -Encoding UTF8
    
    # Dobavlyaem pustuyu stroku posle fayla
    "" | Out-File $OutputFile -Append -Encoding UTF8
}

# Dobavlyaem footer
$footer = @"

================================================================================
  KONETS FAYLOV
  Vsego obrabotano failov: $fileCount
  Isklyuchena papka: src/generated
================================================================================
"@
$footer | Out-File $OutputFile -Append -Encoding UTF8

Write-Host "Gotovo!" -ForegroundColor Green
Write-Host "Fayl sozdan: $OutputFile" -ForegroundColor Yellow
Write-Host "Obrabotano failov: $fileCount" -ForegroundColor Cyan

# Otkryvaem fayl?
Write-Host "Otkryt fayl? (y/n)" -ForegroundColor White
$response = Read-Host
if ($response -eq 'y') {
    Invoke-Item $OutputFile
}