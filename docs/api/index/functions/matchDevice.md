# Function: matchDevice()

```ts
function matchDevice(
   vid: number, 
   pid: number, 
   registries: readonly DeviceEntry[]): DeviceEntry | undefined;
```

Match a USB device against a list of known device entries.

Entries without a `transports.usb` block (network-only printers) are
skipped — they cannot match a USB device. VID/PID hex strings on the
registry are parsed at the boundary.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `vid` | `number` |
| `pid` | `number` |
| `registries` | readonly [`DeviceEntry`](/contracts/api/README)[] |

## Returns

[`DeviceEntry`](/contracts/api/README) \| `undefined`
