#!/usr/bin/env pwsh
$scriptDir = Split-Path -Parent $MyInvocation.MyCommand.Path
& node "$scriptDir/swarm.js" @args
exit $LASTEXITCODE
