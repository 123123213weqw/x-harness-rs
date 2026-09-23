[CmdletBinding(SupportsShouldProcess)]
param(
    [Parameter(Mandatory = $true)]
    [string]$Path
)

$ErrorActionPreference = 'Stop'
$resolved = (Resolve-Path -LiteralPath $Path).Path
$document = Get-Content -Raw -LiteralPath $resolved | ConvertFrom-Json
$changed = 0

$efforts = @(
    [ordered]@{
        id = 'off'
        name = '关闭思考'
        description = '优先速度和工具响应'
        request_patch = [ordered]@{ thinking = [ordered]@{ type = 'disabled' } }
    },
    [ordered]@{
        id = 'low'
        name = '低'
        description = '轻量推理'
        request_patch = [ordered]@{
            thinking = [ordered]@{ type = 'enabled' }
            reasoning_effort = 'low'
        }
    },
    [ordered]@{
        id = 'high'
        name = '高'
        description = '长时间编码任务默认'
        request_patch = [ordered]@{
            thinking = [ordered]@{ type = 'enabled' }
            reasoning_effort = 'high'
        }
    },
    [ordered]@{
        id = 'max'
        name = '最高'
        description = '复杂架构与调试任务'
        request_patch = [ordered]@{
            thinking = [ordered]@{ type = 'enabled' }
            reasoning_effort = 'max'
        }
    }
)

foreach ($provider in @($document.providers)) {
    $uri = $null
    if (-not [Uri]::TryCreate([string]$provider.base_url, [UriKind]::Absolute, [ref]$uri)) {
        continue
    }
    if ($uri.Scheme -ne 'https' -or $uri.Host -ne 'api.deepseek.com') {
        continue
    }
    foreach ($model in @($provider.models)) {
        if ($model.id -notin @('deepseek-flash', 'deepseek-v4-flash', 'deepseek-v4-pro')) {
            continue
        }
        if ($null -ne $model.PSObject.Properties['reasoning']) {
            continue
        }
        $reasoning = [ordered]@{
            default_effort = 'high'
            efforts = $efforts
        }
        $model | Add-Member -NotePropertyName reasoning -NotePropertyValue $reasoning
        $changed++
    }
}

if ($changed -eq 0) {
    Write-Output 'No DeepSeek model entries required migration.'
    exit 0
}

if ($PSCmdlet.ShouldProcess($resolved, "add explicit reasoning to $changed DeepSeek model entries")) {
    $backup = "$resolved.pre-reasoning-v1.bak"
    if (-not (Test-Path -LiteralPath $backup)) {
        Copy-Item -LiteralPath $resolved -Destination $backup
    }
    $temporary = "$resolved.tmp-$PID"
    try {
        $json = $document | ConvertTo-Json -Depth 100
        [IO.File]::WriteAllText($temporary, $json, [Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $resolved -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) {
            Remove-Item -LiteralPath $temporary
        }
    }
}

Write-Output "Migrated $changed DeepSeek model entries."
