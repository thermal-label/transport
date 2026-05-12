# Function: buildBluetoothRequestOptions()

```ts
function buildBluetoothRequestOptions(config: BluetoothGattTransport): RequestDeviceOptions;
```

Build Web Bluetooth request options from a `BluetoothGattTransport`.

Uses `filters[].services` (required so the user picker narrows to the
correct printer family) and `optionalServices` (required so the
returned `BluetoothDevice` is permitted to access the service). If
`namePrefix` is set, it is added to the filter to further narrow the
picker. See DECISIONS.md D2.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `config` | [`BluetoothGattTransport`](/contracts/api/interfaces/BluetoothGattTransport) |

## Returns

`RequestDeviceOptions`
