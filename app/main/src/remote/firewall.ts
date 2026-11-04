import { execFile } from 'node:child_process'

const RULE_NAME = 'Better Player'

const CHECK = `
$fw = New-Object -ComObject HNetCfg.FwPolicy2
$allow = 0; $block = 0
foreach ($r in $fw.Rules) {
  if ($r.Direction -ne 1 -or -not $r.Enabled -or -not $r.ApplicationName) { continue }
  if ([Environment]::ExpandEnvironmentVariables($r.ApplicationName) -ne $env:BP_EXE) { continue }
  if ($r.Action -eq 0) { $block = $block -bor $r.Profiles } else { $allow = $allow -bor $r.Profiles }
}
foreach ($p in 1, 2, 4) {
  if (-not ($fw.CurrentProfileTypes -band $p) -or -not $fw.FirewallEnabled($p)) { continue }
  if (($block -band $p) -or (-not ($allow -band $p) -and $fw.DefaultInboundAction($p) -eq 0)) { 'blocked'; exit }
}
'open'`

function powershell(script: string, env: NodeJS.ProcessEnv = {}): Promise<string | null> {
  return new Promise((resolve) => {
    execFile(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', script],
      { env: { ...process.env, ...env }, windowsHide: true, timeout: 60_000 },
      (error, stdout) => resolve(error ? null : stdout.trim()),
    )
  })
}

export async function firewallBlocks(exe = process.execPath): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return (await powershell(CHECK, { BP_EXE: exe })) === 'blocked'
}

export async function allowThroughFirewall(exe = process.execPath): Promise<boolean> {
  if (process.platform !== 'win32') return true
  const program = `program="${exe}"`
  const commands = [
    `netsh advfirewall firewall delete rule name=all dir=in ${program}`,
    `netsh advfirewall firewall add rule name="${RULE_NAME}" dir=in action=allow ${program} enable=yes profile=any`,
  ]
  const encoded = Buffer.from(commands.join('\n'), 'utf16le').toString('base64')
  const elevate = `Start-Process powershell.exe -Verb RunAs -Wait -WindowStyle Hidden -ArgumentList '-NoProfile','-EncodedCommand','${encoded}'`
  await powershell(elevate)
  return !(await firewallBlocks(exe))
}
