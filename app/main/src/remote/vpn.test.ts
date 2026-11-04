import type { NetworkInterfaceInfo } from 'node:os'
import { describe, expect, it } from 'vitest'
import { vpnName } from './vpn'

const up = (address: string): NetworkInterfaceInfo[] => [{ address, family: 'IPv4', internal: false, netmask: '255.255.255.0', mac: '00:00:00:00:00:00', cidr: `${address}/24` }]

describe('vpnName', () => {
  it('names an active VPN adapter and ignores the LAN and mesh networks', () => {
    expect(vpnName({ 'Wi-Fi': up('192.168.1.10'), NordLynx: up('10.5.0.2') })).toBe('NordLynx')
    expect(vpnName({ Ethernet: up('192.168.1.10'), Tailscale: up('100.64.0.1'), 'ZeroTier One [abc]': up('10.147.17.2') })).toBeNull()
    expect(vpnName({ 'ProtonVPN TUN': [] })).toBeNull()
  })
})
