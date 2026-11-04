import { networkInterfaces, type NetworkInterfaceInfo } from 'node:os'

const VPN = /vpn|wireguard|nordlynx|mullvad|proton|windscribe|surfshark|express|cloudflare warp|\bwarp\b|\bwg\d*\b|\btun\d*\b|\btap\b/i

export function vpnName(interfaces: NodeJS.Dict<NetworkInterfaceInfo[]> = networkInterfaces()): string | null {
  for (const [name, addresses] of Object.entries(interfaces)) {
    if (VPN.test(name) && addresses?.some((a) => a.family === 'IPv4' && !a.internal)) return name
  }
  return null
}
