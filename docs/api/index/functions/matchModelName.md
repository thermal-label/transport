# Function: matchModelName()

```ts
function matchModelName(reported: string, registries: readonly DeviceEntry[]): DeviceEntry | undefined;
```

Match a model string a device reports about itself — SNMP
`hrDeviceDescr` / `sysDescr`, IEEE-1284 `MDL:`, mDNS TXT `usb_MDL`,
IPP `printer-device-id` — against the registries' `modelNames`
(default `[name]`).

Case-folded, whitespace-collapsed, whole-token: a candidate matches
when its tokens appear contiguously in the reported tokens, so a
vendor word in front (`Brother QL-820NWB`) is ignored and `QL-800`
never matches a `QL-8000`. The longest matching candidate wins; ties
go to registry order.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `reported` | `string` |
| `registries` | readonly [`DeviceEntry`](/contracts/api/README)[] |

## Returns

[`DeviceEntry`](/contracts/api/README) \| `undefined`
