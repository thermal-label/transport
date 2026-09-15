# Variable: PRINTER\_MIB

```ts
const PRINTER_MIB: {
  hrDeviceDescr: "1.3.6.1.2.1.25.3.2.1.3.1";
  hrPrinterDetectedErrorState: "1.3.6.1.2.1.25.3.5.1.2.1";
  hrPrinterStatus: "1.3.6.1.2.1.25.3.5.1.1.1";
  prtGeneralSerialNumber: "1.3.6.1.2.1.43.5.1.1.17.1";
  prtInputDimUnit: "1.3.6.1.2.1.43.8.2.1.3.1.1";
  prtInputMediaDimFeedDir: "1.3.6.1.2.1.43.8.2.1.4.1.1";
  prtInputMediaDimXFeedDir: "1.3.6.1.2.1.43.8.2.1.5.1.1";
  prtInputMediaName: "1.3.6.1.2.1.43.8.2.1.12.1.1";
  prtMarkerLifeCount: "1.3.6.1.2.1.43.10.2.1.4.1.1";
  sysDescr: "1.3.6.1.2.1.1.1.0";
};
```

Standard MIB-II / Host-Resources-MIB / Printer-MIB objects a network
printer answers. Indexes are `.1` (first host device, first input
tray) as measured on Brother NC print servers; other vendors may
order `hrDeviceTable` differently, which is why `sysDescr` is here.

## Type Declaration

| Name | Type | Default value |
| ------ | ------ | ------ |
| <a id="property-hrdevicedescr"></a> `hrDeviceDescr` | `"1.3.6.1.2.1.25.3.2.1.3.1"` | `'1.3.6.1.2.1.25.3.2.1.3.1'` |
| <a id="property-hrprinterdetectederrorstate"></a> `hrPrinterDetectedErrorState` | `"1.3.6.1.2.1.25.3.5.1.2.1"` | `'1.3.6.1.2.1.25.3.5.1.2.1'` |
| <a id="property-hrprinterstatus"></a> `hrPrinterStatus` | `"1.3.6.1.2.1.25.3.5.1.1.1"` | `'1.3.6.1.2.1.25.3.5.1.1.1'` |
| <a id="property-prtgeneralserialnumber"></a> `prtGeneralSerialNumber` | `"1.3.6.1.2.1.43.5.1.1.17.1"` | `'1.3.6.1.2.1.43.5.1.1.17.1'` |
| <a id="property-prtinputdimunit"></a> `prtInputDimUnit` | `"1.3.6.1.2.1.43.8.2.1.3.1.1"` | `'1.3.6.1.2.1.43.8.2.1.3.1.1'` |
| <a id="property-prtinputmediadimfeeddir"></a> `prtInputMediaDimFeedDir` | `"1.3.6.1.2.1.43.8.2.1.4.1.1"` | `'1.3.6.1.2.1.43.8.2.1.4.1.1'` |
| <a id="property-prtinputmediadimxfeeddir"></a> `prtInputMediaDimXFeedDir` | `"1.3.6.1.2.1.43.8.2.1.5.1.1"` | `'1.3.6.1.2.1.43.8.2.1.5.1.1'` |
| <a id="property-prtinputmedianame"></a> `prtInputMediaName` | `"1.3.6.1.2.1.43.8.2.1.12.1.1"` | `'1.3.6.1.2.1.43.8.2.1.12.1.1'` |
| <a id="property-prtmarkerlifecount"></a> `prtMarkerLifeCount` | `"1.3.6.1.2.1.43.10.2.1.4.1.1"` | `'1.3.6.1.2.1.43.10.2.1.4.1.1'` |
| <a id="property-sysdescr"></a> `sysDescr` | `"1.3.6.1.2.1.1.1.0"` | `'1.3.6.1.2.1.1.1.0'` |
