# index

## Functions

| Function | Description |
| ------ | ------ |
| [buildBluetoothRequestOptions](functions/buildBluetoothRequestOptions.md) | Build Web Bluetooth request options from a `BluetoothGattTransport`. |
| [buildSerialRequestOptions](functions/buildSerialRequestOptions.md) | Build Web Serial request options, optionally including Bluetooth service class IDs so paired SPP devices with custom UUIDs appear in the picker. |
| [buildUsbFilters](functions/buildUsbFilters.md) | Build WebUSB filters from one or more device registries. |
| [discoverAll](functions/discoverAll.md) | Universal printer discovery — aggregates results from multiple driver implementations. |
| [matchDevice](functions/matchDevice.md) | Match a USB device against a list of known device entries. |
| [matchModelName](functions/matchModelName.md) | Match a model string a device reports about itself — SNMP `hrDeviceDescr` / `sysDescr`, IEEE-1284 `MDL:`, mDNS TXT `usb_MDL`, IPP `printer-device-id` — against the registries' `modelNames` (default `[name]`). |
