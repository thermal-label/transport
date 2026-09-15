# Function: enumerateNetworkDevices()

```ts
function enumerateNetworkDevices(registries: readonly DeviceEntry[], opts?: SnmpOptions & {
  windowMs?: number;
}): Promise<EnumeratedNetworkDevice[]>;
```

Find network printers on the local subnets: one SNMP broadcast of
`hrDeviceDescr.1`, every responder matched against the TCP-capable
entries of the given registries, then one unicast for the serial.
Responders whose `hrDeviceDescr.1` is absent or matches nothing go
through [identifyNetworkDevice](identifyNetworkDevice.md) for the `sysDescr` fallback.

Best-effort like [enumerateUsbDevices](enumerateUsbDevices.md): a responder that stops
answering mid-scan is dropped (or listed without a serial), never
aborts the scan. Registries with no TCP-capable entry send nothing.
Results are sorted by address so repeated scans list in one order.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `registries` | readonly [`DeviceEntry`](/contracts/api/README)[] |
| `opts` | [`SnmpOptions`](../interfaces/SnmpOptions.md) & \{ `windowMs?`: `number`; \} |

## Returns

`Promise`\<[`EnumeratedNetworkDevice`](../interfaces/EnumeratedNetworkDevice.md)[]\>
