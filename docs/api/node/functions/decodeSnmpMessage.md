# Function: decodeSnmpMessage()

```ts
function decodeSnmpMessage(buf: Uint8Array): SnmpMessage;
```

Decode an SNMPv1 GET request or response. Throws `RangeError` on a
truncated or non-SNMP datagram; callers drop those.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `buf` | `Uint8Array` |

## Returns

[`SnmpMessage`](../interfaces/SnmpMessage.md)
