# Interface: SnmpOptions

Options shared by [snmpGet](../functions/snmpGet.md) and [snmpBroadcast](../functions/snmpBroadcast.md).

## Properties

| Property | Type | Description |
| ------ | ------ | ------ |
| <a id="property-community"></a> `community?` | `string` | SNMPv1 community string. Default `'public'`. |
| <a id="property-port"></a> `port?` | `number` | Agent UDP port. Default `161`. |
| <a id="property-retries"></a> `retries?` | `number` | Resends after a `timeoutMs` with no answer. Total budget per OID is `timeoutMs × (retries + 1)`. Default `1`. |
| <a id="property-timeoutms"></a> `timeoutMs?` | `number` | Wait per attempt before resending. Default `1000`. |
