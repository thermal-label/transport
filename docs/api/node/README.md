# node

## Classes

| Class | Description |
| ------ | ------ |
| [SerialTransport](classes/SerialTransport.md) | Node.js serial-port transport. |
| [TcpTransport](classes/TcpTransport.md) | TCP transport for network-attached thermal label printers. |
| [UsbTransport](classes/UsbTransport.md) | USB transport over libusb for Node.js. |

## Interfaces

| Interface | Description |
| ------ | ------ |
| [EnumeratedNetworkDevice](interfaces/EnumeratedNetworkDevice.md) | - |
| [EnumeratedUsbDevice](interfaces/EnumeratedUsbDevice.md) | - |
| [SnmpMessage](interfaces/SnmpMessage.md) | The SNMPv1 GET request/response envelope. Exposed so tests and stubs can build well-formed agent responses; drivers never need it. |
| [SnmpOptions](interfaces/SnmpOptions.md) | Options shared by [snmpGet](functions/snmpGet.md) and [snmpBroadcast](functions/snmpBroadcast.md). |
| [SnmpVarbind](interfaces/SnmpVarbind.md) | One `OID = value` pair inside an SNMP PDU. |
| [UsbOpenOptions](interfaces/UsbOpenOptions.md) | - |

## Type Aliases

| Type Alias | Description |
| ------ | ------ |
| [SnmpValue](type-aliases/SnmpValue.md) | A decoded SNMP value. |

## Variables

| Variable | Description |
| ------ | ------ |
| [PRINTER\_MIB](variables/PRINTER_MIB.md) | Standard MIB-II / Host-Resources-MIB / Printer-MIB objects a network printer answers. Indexes are `.1` (first host device, first input tray) as measured on Brother NC print servers; other vendors may order `hrDeviceTable` differently, which is why `sysDescr` is here. |

## Functions

| Function | Description |
| ------ | ------ |
| [decodeSnmpMessage](functions/decodeSnmpMessage.md) | Decode an SNMPv1 GET request or response. Throws `RangeError` on a truncated or non-SNMP datagram; callers drop those. |
| [encodeSnmpMessage](functions/encodeSnmpMessage.md) | Encode an SNMPv1 message. See [SnmpMessage](interfaces/SnmpMessage.md). |
| [enumerateNetworkDevices](functions/enumerateNetworkDevices.md) | Find network printers on the local subnets: one SNMP broadcast of `hrDeviceDescr.1`, every responder matched against the TCP-capable entries of the given registries, then one unicast for the serial. Responders whose `hrDeviceDescr.1` is absent or matches nothing go through [identifyNetworkDevice](functions/identifyNetworkDevice.md) for the `sysDescr` fallback. |
| [enumerateUsbDevices](functions/enumerateUsbDevices.md) | Enumerate connected USB devices that match one of the given registries. |
| [identifyNetworkDevice](functions/identifyNetworkDevice.md) | Ask one host over SNMP what it is and match the answer against the TCP-capable entries of the given registries. |
| [snmpBroadcast](functions/snmpBroadcast.md) | SNMPv1 GET of one OID to the directed broadcast address of every non-internal IPv4 interface. Collects answers for `windowMs` (default 1000) and resolves with one entry per responder address, first answer wins. `retries` resends of the broadcast are spread evenly over the window (WiFi drops broadcast frames; dedupe makes the resend free). |
| [snmpGet](functions/snmpGet.md) | SNMPv1 GET of one or more OIDs from `host`. |
