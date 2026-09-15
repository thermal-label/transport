# Type Alias: SnmpValue

```ts
type SnmpValue = 
  | {
  raw: Uint8Array;
  type: "string";
  value: string;
}
  | {
  type: "integer";
  value: number;
}
  | {
  raw: Uint8Array;
  type: "octets";
}
  | {
  type: "noSuchObject" | "noSuchInstance" | "null";
};
```

A decoded SNMP value.

OCTET STRINGs come back as `string` when every byte is printable ASCII
(trailing NULs ignored), else as `octets`. Bit strings such as
`hrPrinterDetectedErrorState` can land in either shape depending on
which bits are set, so read `raw` for those. INTEGER, Counter32,
Gauge32 and TimeTicks all decode to `integer`. Anything else
(IpAddress, OBJECT IDENTIFIER, Opaque) is `octets`.
