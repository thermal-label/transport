# Interface: SnmpMessage

The SNMPv1 GET request/response envelope. Exposed so tests and stubs
can build well-formed agent responses; drivers never need it.

## Properties

| Property | Type |
| ------ | ------ |
| <a id="property-community"></a> `community` | `string` |
| <a id="property-errorindex"></a> `errorIndex` | `number` |
| <a id="property-errorstatus"></a> `errorStatus` | `number` |
| <a id="property-pdutype"></a> `pduType` | `"get-request"` \| `"get-response"` |
| <a id="property-requestid"></a> `requestId` | `number` |
| <a id="property-varbinds"></a> `varbinds` | readonly [`SnmpVarbind`](SnmpVarbind.md)[] |
