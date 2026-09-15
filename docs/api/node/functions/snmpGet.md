# Function: snmpGet()

```ts
function snmpGet(
   host: string, 
   oids: readonly string[], 
opts?: SnmpOptions): Promise<Record<string, SnmpValue>>;
```

SNMPv1 GET of one or more OIDs from `host`.

One request per OID, all in flight on one socket, matched back by
request id: a v1 agent fails a whole multi-varbind PDU when any one
OID is absent, per-OID requests keep the others alive. Only a
GetResponse from the target's address and port with a matching
(random) request id is taken; anything else on the socket is dropped.
Rejects with `TransportTimeoutError` when *no* OID was answered
within the budget (host down, SNMP disabled, wrong community) and
with `TransportError` on a socket failure or when `host` does not
resolve. An OID that individually got no answer while others did is
simply absent from the result.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `host` | `string` |
| `oids` | readonly `string`[] |
| `opts` | [`SnmpOptions`](../interfaces/SnmpOptions.md) |

## Returns

`Promise`\<`Record`\<`string`, [`SnmpValue`](../type-aliases/SnmpValue.md)\>\>
