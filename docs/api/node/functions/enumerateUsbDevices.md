# Function: enumerateUsbDevices()

```ts
function enumerateUsbDevices(registries: readonly DeviceEntry[]): Promise<EnumeratedUsbDevice[]>;
```

Enumerate connected USB devices that match one of the given registries.

Owns the `usb` native addon (lazy-imported) so drivers no longer reach
around transport into `usb` to list devices — see DECISIONS.md D1. The
registry match, the `iSerialNumber` guard, the open/read/close lifecycle,
and `connectionId` normalization all live here once.

Resilient by contract: a matched device we cannot open or whose serial we
cannot read (busy, permission, unplugged mid-scan, hung descriptor read) is
still returned, just without a `serialNumber`. One bad device never aborts
the scan.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `registries` | readonly [`DeviceEntry`](/contracts/api/README)[] |

## Returns

`Promise`\<[`EnumeratedUsbDevice`](../interfaces/EnumeratedUsbDevice.md)[]\>
