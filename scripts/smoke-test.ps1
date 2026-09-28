param(
    [string]$BaseUrl = "http://localhost:3000",
    [int]$TimeoutSeconds = 120
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest
Add-Type -AssemblyName System.Net.Http
$projectRoot = Split-Path -Parent $PSScriptRoot
$smokeRoot = [IO.Path]::GetFullPath((Join-Path $projectRoot "runtime/smoke"))
$runDirectory = Join-Path $smokeRoot ([guid]::NewGuid().ToString())
$handler = New-Object System.Net.Http.HttpClientHandler
$handler.CookieContainer = New-Object System.Net.CookieContainer
$client = New-Object System.Net.Http.HttpClient($handler)
$client.Timeout = [TimeSpan]::FromSeconds(20)
$client.BaseAddress = [uri]($BaseUrl.TrimEnd('/') + '/')

function Invoke-Json([string]$Method, [string]$Route, $Body = $null) {
    $request = New-Object System.Net.Http.HttpRequestMessage
    $request.Method = New-Object System.Net.Http.HttpMethod($Method)
    $request.RequestUri = [uri]::new($Route, [UriKind]::Relative)
    if ($null -ne $Body) {
        $request.Content = New-Object System.Net.Http.StringContent(
            ($Body | ConvertTo-Json -Depth 5 -Compress), [Text.Encoding]::UTF8, "application/json")
    }
    try {
        $response = $client.SendAsync($request).GetAwaiter().GetResult()
        try {
            if (-not $response.IsSuccessStatusCode) { throw "$Method $Route failed: HTTP $([int]$response.StatusCode)" }
            return ($response.Content.ReadAsStringAsync().GetAwaiter().GetResult() | ConvertFrom-Json)
        } finally { $response.Dispose() }
    } finally { $request.Dispose() }
}

Push-Location $projectRoot
try {
    if ($TimeoutSeconds -lt 1) { throw "TimeoutSeconds must be positive" }
    $health = Invoke-Json GET "api/health"
    if ($health.status -ne "ok") { throw "Web health endpoint failed" }

    $email = "smoke-$([guid]::NewGuid().ToString('N'))@example.test"
    $password = [guid]::NewGuid().ToString('N') + [guid]::NewGuid().ToString('N')
    $null = Invoke-Json POST "api/auth/register" @{ email = $email; password = $password; passwordConfirm = $password }
    $null = Invoke-Json POST "api/auth/logout" @{}
    $null = Invoke-Json POST "api/auth/login" @{ email = $email; password = $password }

    $null = New-Item -ItemType Directory -Path $runDirectory -Force
    $pngPath = Join-Path $runDirectory "smoke.png"
    $png = [Convert]::FromBase64String('iVBORw0KGgoAAAANSUhEUgAAADAAAAAwCAIAAADYYG7QAAAAQklEQVR4nO3OQQ0AIAwAsalDGOqQhQuOR5MK6Kx9vjL5QEhISKgeCAkJCdUDISEhoXogJCQkVA+EhISE6oGQkNBjFz0AENNUjHRQAAAAAElFTkSuQmCC')
    [IO.File]::WriteAllBytes($pngPath, $png)
    $job = Invoke-Json POST "api/jobs" @{ operation = "image_to_pdf"; inputNames = @("smoke.png"); options = @{} }
    if ($job.id -notmatch '^[a-zA-Z0-9]{15}$') { throw "Invalid job ID" }
    $multipart = New-Object System.Net.Http.MultipartFormDataContent
    $fileContent = New-Object System.Net.Http.ByteArrayContent -ArgumentList (,[IO.File]::ReadAllBytes($pngPath))
    $fileContent.Headers.ContentType = New-Object System.Net.Http.Headers.MediaTypeHeaderValue("image/png")
    $multipart.Add($fileContent, "files", "smoke.png")
    try {
        $response = $client.PostAsync("api/jobs/$($job.id)/upload", $multipart).GetAwaiter().GetResult()
        try {
            if (-not $response.IsSuccessStatusCode) { throw "Upload failed: HTTP $([int]$response.StatusCode)" }
        } finally { $response.Dispose() }
    } finally { $multipart.Dispose() }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    do {
        $status = Invoke-Json GET "api/jobs/$($job.id)"
        if ($status.status -eq "ready") { break }
        if ($status.status -in @("failed", "expired", "downloaded")) { throw "Job reached unexpected state: $($status.status)" }
        if ([DateTime]::UtcNow -ge $deadline) { throw "Timed out waiting for conversion" }
        Start-Sleep -Milliseconds 500
    } while ($true)

    # Resolve exactly this job's private key using credentials already in the worker.
    $lookup = 'import os,sys; from app.pocketbase_client import PocketBaseClient; client=PocketBaseClient(os.environ["POCKETBASE_URL"],os.environ["POCKETBASE_SUPERUSER_EMAIL"],os.environ["POCKETBASE_SUPERUSER_PASSWORD"]); print(client.get_job(sys.argv[1])["jobKey"])'
    $jobKey = ($lookup | docker compose exec -T worker python - $job.id | Out-String).Trim()
    if ($LASTEXITCODE -ne 0 -or $jobKey -notmatch '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$') { throw "Could not resolve smoke job directory" }
    $jobDirectory = Join-Path (Join-Path $projectRoot "runtime/jobs") $jobKey
    if (-not (Test-Path -LiteralPath $jobDirectory -PathType Container)) { throw "Job directory missing before download" }
    if (-not (Test-Path -LiteralPath (Join-Path $jobDirectory "input/0001") -PathType Leaf)) { throw "Numbered input missing" }

    $result = $client.GetAsync("api/jobs/$($job.id)/download").GetAwaiter().GetResult()
    try {
        if (-not $result.IsSuccessStatusCode) { throw "Download failed: HTTP $([int]$result.StatusCode)" }
        $bytes = $result.Content.ReadAsByteArrayAsync().GetAwaiter().GetResult()
        [IO.File]::WriteAllBytes((Join-Path $runDirectory "result.pdf"), $bytes)
        if ($bytes.Length -lt 5 -or [Text.Encoding]::ASCII.GetString($bytes, 0, 5) -ne '%PDF-') { throw "Download is not a PDF" }
    } finally { $result.Dispose() }

    $deadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (Test-Path -LiteralPath $jobDirectory) {
        if ([DateTime]::UtcNow -ge $deadline) { throw "Worker did not remove downloaded job directory" }
        Start-Sleep -Milliseconds 500
    }
    Write-Host "PASS: health, registration/login, image-to-PDF, PDF signature, numbered input, and job cleanup ($($job.id))."
} finally {
    $client.Dispose()
    $handler.Dispose()
    if (Test-Path -LiteralPath $runDirectory) {
        $resolved = (Resolve-Path -LiteralPath $runDirectory).Path
        if ([IO.Path]::GetDirectoryName($resolved) -ne $smokeRoot) { throw "Unsafe smoke cleanup path" }
        Remove-Item -LiteralPath $resolved -Recurse -Force
    }
    Pop-Location
}
