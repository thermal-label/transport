# Class: TcpTransport

TCP transport for network-attached thermal label printers.

Targets the JetDirect raw socket (port 9100) by default. Accumulates
incoming bytes across `data` events so `read(n)` hands callers a
pull-based API over a stream socket.

## Implements

- [`Transport`](/contracts/api/interfaces/Transport)

## Accessors

### connected

#### Get Signature

```ts
get connected(): boolean;
```

Whether the transport is currently connected.

##### Returns

`boolean`

#### Implementation of

```ts
Transport.connected
```

## Methods

### close()

```ts
close(): Promise<void>;
```

Close the connection.

Always safe to call multiple times. Always `await` the result.

#### Returns

`Promise`\<`void`\>

#### Implementation of

```ts
Transport.close
```

***

### read()

```ts
read(length: number, timeout?: number): Promise<Uint8Array>;
```

Read bytes from the printer.

Buffers until `length` bytes are available or the timeout fires.

BLE implementations: there is no "read N bytes" primitive in BLE.
Implementations must buffer incoming GATT notifications internally
and satisfy `read()` calls from that buffer. Document this in your
transport class — every BLE implementation must handle buffering
consistently so drivers get the same pull-based API on every
transport.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `length` | `number` |
| `timeout?` | `number` |

#### Returns

`Promise`\<`Uint8Array`\>

#### Throws

TransportTimeoutError on timeout.

#### Throws

TransportClosedError if the transport is closed mid-read.

#### Implementation of

```ts
Transport.read
```

***

### write()

```ts
write(data: Uint8Array): Promise<void>;
```

Send bytes to the printer.

#### Parameters

| Parameter | Type |
| ------ | ------ |
| `data` | `Uint8Array` |

#### Returns

`Promise`\<`void`\>

#### Implementation of

```ts
Transport.write
```

***

### connect()

```ts
static connect(
   host: string, 
   port?: number, 
timeout?: number): Promise<TcpTransport>;
```

Connect to a raw TCP printer port.

#### Parameters

| Parameter | Type | Default value | Description |
| ------ | ------ | ------ | ------ |
| `host` | `string` | `undefined` | IP address or hostname. |
| `port` | `number` | `DEFAULT_PORT` | TCP port (default 9100). |
| `timeout?` | `number` | `undefined` | Connection timeout in ms (default 5000). On expiry the returned promise rejects with `TransportError` (not `TransportTimeoutError`, which the contracts reserve for read timeouts). |

#### Returns

`Promise`\<`TcpTransport`\>
