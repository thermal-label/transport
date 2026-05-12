# Function: discoverAll()

```ts
function discoverAll(discoveries: readonly PrinterDiscovery[]): Promise<DiscoveredPrinter[]>;
```

Universal printer discovery — aggregates results from multiple driver
implementations.

Uses `Promise.allSettled` so one failing driver does not block others
(DECISIONS.md D5). Rejected results are dropped silently — callers
that need per-driver error detail should call the individual
`PrinterDiscovery.listPrinters()` directly.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `discoveries` | readonly [`PrinterDiscovery`](/contracts/api/interfaces/PrinterDiscovery)[] |

## Returns

`Promise`\<[`DiscoveredPrinter`](/contracts/api/interfaces/DiscoveredPrinter)[]\>
