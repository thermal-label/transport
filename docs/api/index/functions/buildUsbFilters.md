# Function: buildUsbFilters()

```ts
function buildUsbFilters(registries: readonly DeviceEntry[]): USBDeviceFilter[];
```

Build WebUSB filters from one or more device registries.

Skips entries without a `transports.usb` block. Pass the result to
`navigator.usb.requestDevice({ filters })` or `WebUsbTransport.request`.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `registries` | readonly [`DeviceEntry`](/contracts/api/README)[] |

## Returns

`USBDeviceFilter`[]
