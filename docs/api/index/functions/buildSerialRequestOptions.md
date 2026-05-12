# Function: buildSerialRequestOptions()

```ts
function buildSerialRequestOptions(bluetoothServiceClassIds?: readonly (string | number)[]): SerialPortRequestOptions;
```

Build Web Serial request options, optionally including Bluetooth service
class IDs so paired SPP devices with custom UUIDs appear in the picker.

For printers that advertise standard Serial Port Profile (UUID `0x1101`,
which is most thermal printers with classic Bluetooth), no options are
needed — pass the result as-is or call `WebSerialTransport.request()`
without arguments.

For printers with a custom RFCOMM service class, pass those UUIDs here.

## Parameters

| Parameter | Type |
| ------ | ------ |
| `bluetoothServiceClassIds?` | readonly (`string` \| `number`)[] |

## Returns

`SerialPortRequestOptions`
