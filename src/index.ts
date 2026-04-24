// Platform-neutral entry. See DECISIONS.md D1 — transport classes live
// strictly behind `./node` and `./web` so browser bundles never see the
// `usb` native addon.
export {
  buildBluetoothRequestOptions,
  buildUsbFilters,
  discoverAll,
  matchDevice,
} from './discovery.js';
