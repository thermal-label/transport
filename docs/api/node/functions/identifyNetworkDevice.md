# Function: identifyNetworkDevice()

```ts
function identifyNetworkDevice(
   host: string, 
   registries: readonly DeviceEntry[], 
   opts?: SnmpOptions): Promise<
  | EnumeratedNetworkDevice
| undefined>;
```

Ask one host over SNMP what it is and match the answer against the
TCP-capable entries of the given registries.

One GET fetches `hrDeviceDescr.1`, `sysDescr.0` and the serial.
`hrDeviceDescr.1` is matched first; `sysDescr.0` whenever that is
absent *or* matches nothing (other vendors list an interface, not the
printer, at `hrDeviceIndex` 1). Resolves `undefined` when the host
answered but is not in these registries ("not mine"); rejects
(`TransportTimeoutError` / `TransportError`) when it could not be
asked at all (host down, SNMP disabled, wrong community), so drivers
can tell the two apart. Never opens a TCP connection.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `host` | `string` |
| `registries` | readonly [`DeviceEntry`](/contracts/api/README)[] |
| `opts` | [`SnmpOptions`](../interfaces/SnmpOptions.md) |

## Returns

`Promise`\<
  \| [`EnumeratedNetworkDevice`](../interfaces/EnumeratedNetworkDevice.md)
  \| `undefined`\>
