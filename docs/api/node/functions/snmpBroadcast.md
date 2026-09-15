# Function: snmpBroadcast()

```ts
function snmpBroadcast(oid: string, opts?: SnmpOptions & {
  windowMs?: number;
}): Promise<{
  address: string;
  value: SnmpValue;
}[]>;
```

SNMPv1 GET of one OID to the directed broadcast address of every
non-internal IPv4 interface. Collects answers for `windowMs` (default
1000) and resolves with one entry per responder address, first answer
wins. `retries` resends of the broadcast are spread evenly over the
window (WiFi drops broadcast frames; dedupe makes the resend free).

Best-effort by design: a send that fails on one interface is ignored,
and a host with no broadcast-capable interface resolves to `[]`.
Responders that do not carry the OID answer `noSuchObject`; filter on
`value.type` before matching.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `oid` | `string` |
| `opts` | [`SnmpOptions`](../interfaces/SnmpOptions.md) & \{ `windowMs?`: `number`; \} |

## Returns

`Promise`\<\{
  `address`: `string`;
  `value`: [`SnmpValue`](../type-aliases/SnmpValue.md);
\}[]\>
