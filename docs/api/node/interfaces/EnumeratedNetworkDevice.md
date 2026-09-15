# Interface: EnumeratedNetworkDevice

## Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-connectionid"></a> `connectionId` | `string` | `${host}:${port}`. Display-only. |
| <a id="property-descriptor"></a> `descriptor` | [`DeviceEntry`](/contracts/api/README) | - |
| <a id="property-host"></a> `host` | `string` | - |
| <a id="property-modelname"></a> `modelName` | `string` | `hrDeviceDescr` (or `sysDescr`) as reported. |
| <a id="property-port"></a> `port` | `number` | `descriptor.transports.tcp.port`. |
| <a id="property-serialnumber"></a> `serialNumber?` | `string` | `prtGeneralSerialNumber`, when the agent answers it. |
