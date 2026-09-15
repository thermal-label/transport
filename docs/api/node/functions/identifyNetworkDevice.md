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

Model comes from `hrDeviceDescr.1`, falling back to `sysDescr.0` when
the agent does not carry it (other vendors order `hrDeviceTable`
differently). Resolves `undefined` when the host answered but is not
in these registries ("not mine"); rejects (`TransportTimeoutError` /
`TransportError`) when it could not be asked at all (host down, SNMP
disabled, wrong community), so drivers can tell the two apart. Never
opens a TCP connection.

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
