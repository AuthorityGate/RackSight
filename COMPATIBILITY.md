# RackSight compatibility

Copyright (c) 2026 AuthorityGate

RackSight reads hardware inventory and telemetry through the DMTF Redfish API. Redfish adoption is broad, but vendors are allowed to omit optional properties and add OEM extensions. Compatibility therefore depends more on BMC firmware than on the operating system installed on the server.

## Support levels

| Level | Meaning |
| --- | --- |
| Tested | AuthorityGate exercised the hardware against RackSight and verified the core dashboard. |
| Expected | The vendor documents a Redfish implementation that exposes the standard resources RackSight reads. AuthorityGate has not lab-tested every listed model. |
| Partial | The BMC may omit inventory, utilization, settings, or sensor fields. RackSight displays available data and uses `N/A` for missing data. |

The list is intentionally evidence-based, not a guarantee. Firmware revisions, BMC licenses, disabled services, and vendor schema changes can affect results.

## Lab-tested hardware

| Vendor | Server or motherboard | BMC | Firmware tested | Result |
| --- | --- | --- | --- | --- |
| ASRock Rack | B650D4U-2L2T/BCM | ASPEED AST2600 / AMI MegaRAC | BMC 7.02.0; BIOS 21.08 | Core inventory, 256 GB memory summary, temperatures, fans, firmware, settings, alerts, and history verified on three systems. |

ASRock's `FSC_INDEX` is a fan-speed-control index, not a physical temperature. RackSight isolates it from temperature calculations. Disconnected fan headers are normally omitted by the BMC and cannot be inferred safely.

## Expected compatibility

| Vendor/platform | Expected systems and model families | RackSight expectation | Official basis |
| --- | --- | --- | --- |
| ASRock Rack | Server boards using AST2500 or AST2600 BMCs, including the B650D4U family | Strong. AMI OEM quirks are handled; utilization may be absent. | [ASRock Rack says its management utility uses Redfish and supports AST2500/AST2600 boards](https://www.asrockrack.com/support/smu.asp); [B650D4U-2L2T/BCM platform guide](https://www.asrockrack.com/general/2023Q4_AMDRyzenDM.pdf). |
| Dell PowerEdge / iDRAC7 and iDRAC8 | 12th–13th generation families such as R620/R720/R820, R630/R730/R930, T620/T630, and equivalent M/FC systems | Expected; older firmware may provide only legacy thermal resources. | [Dell iDRAC7/8 Redfish API guide](https://www.dell.com/support/manuals/en-us/idrac7-8-lifecycle-controller-v2.60.60.60/idrac_2.60.60.60_redfishapiguide/overview). |
| Dell PowerEdge / iDRAC9 | 14th generation R240/R340/R440/R540/R640/R740/R740xd/R740xd2/R840/R940/R940xa, T140/T340/T440/T640, C4140/C6420; 15th generation R250/R350/R450/R550/R650/R650xs/R6515/R6525/R750/R750xa/R750xs/R7515/R7525, T150/T350/T550, C6520/C6525, MX750c, XR11/XR12; 16th generation R260/R360/R660/R660xs/R6615/R6625/R760/R760xa/R760xd2/R760xs/R7615/R7625/R860/R960, T160/T360/T560, C6615/C6620, MX760c, XE8640/XE9680 and XR5xxx/XR8xxx families | Strong expected compatibility for inventory, health, fans, and temperatures. Telemetry fields vary by iDRAC license and firmware. | [Dell iDRAC9 14G supported systems](https://www.dell.com/support/manuals/en-uk/idrac9-lifecycle-controller-v3.3-series/idrac9_3.36.36.36_rn/supported-systems); [Dell iDRAC9 15G/16G supported systems](https://www.dell.com/support/manuals/en-us/idrac9-lifecycle-controller-v7.x-series/idrac9_7.20.10.05/supported-systems). |
| HPE ProLiant / iLO4 | ProLiant Gen9 families, including common DL360, DL380 and ML350 Gen9 systems, with current iLO4 firmware | Expected but more likely to be partial because early iLO4 releases mixed pre-Redfish and Redfish resources. Use iLO4 2.30 or later. | [HPE's Redfish conformance history](https://developer.hpe.com/blog/getting-started-with-ilo-restful-api-redfish-api-conformance/). |
| HPE ProLiant / iLO5, iLO6 and iLO7 | Gen10, Gen10 Plus, Gen11 and newer ProLiant families, including DL3xx, DL5xx, ML and Apollo/Cray systems whose iLO exposes standard chassis and system resources | Strong expected compatibility. | [HPE iLO RESTful API platform](https://developer.hpe.com/platform/ilo-restful-api/home/). |
| Lenovo ThinkSystem / XCC and XCC2 | XCC-equipped systems; XCC2 V3 examples include SR630 V3, SR650 V3, ST650 V3, SD650 V3, SD650-I V3, SR635 V3, SR645 V3, SR655 V3, SR665 V3, SD665 V3 and SR675 V3 | Strong expected compatibility; firmware determines schema version. | [Lenovo XCC2 Redfish API](https://pubs.lenovo.com/xcc2-restapi/); [Lenovo V3 model list](https://pubs.lenovo.com/xcc2/dw1lm_t_ngmsupportfeatures). |
| Supermicro | Intel X10/X11/X12/X13/X14 and AMD H11/H12/H13/H14 platforms with Redfish enabled; related B/BH motherboard generations where the installed BMC firmware exposes Redfish | Expected. Some generations require an SFT-OOB-LIC or SFT-DCMS-SINGLE license. | [Supermicro Redfish introduction](https://www.supermicro.com/manuals/other/redfish-user-guide-4-0/Content/general-content/introduction.htm); [Supermicro BMC resources](https://www.supermicro.com/en/solutions/management-software/bmc-resources). |
| Cisco UCS C-Series / CIMC | Standalone UCS C-Series M5, M6 and M7 servers with a current CIMC release | Expected for standard inventory and sensors; Cisco OEM settings are not normalized. | [Cisco UCS C-Series REST API guide](https://www.cisco.com/c/en/us/td/docs/unified_computing/ucs/c/sw/api/4_3/b-cisco-ucs-c-series-servers-rest-api-programmer-s-guide-release-4-3.pdf). |
| Fujitsu PRIMERGY and PRIMEQUEST / iRMC | iRMC S5 and S6 systems with Redfish access enabled; documented PRIMEQUEST examples include 3400E, 3800B/B2 and 3800E/E2 | Expected; exact sensors depend on the platform-specific iRMC schema pack. | [Fujitsu iRMC S5 RESTful API documentation](https://support.ts.fujitsu.com/Search/SWP1293374.asp); [Fujitsu iRMC S5/S6 integration requirements](https://support.ts.fujitsu.com/prim_supportcd/SVSSoftware/software/Integration_Solutions/vLCM/PRIMERGY%20Plug-in%20for%20VMware%20vCenter-en.pdf). |
| IBM Power / OpenBMC | Power systems whose BMC publishes `/redfish/v1`, including documented Power11 model 9242-21T | Expected for standard OpenBMC resources; Power-specific OEM data is not normalized. | [IBM Power Redfish management](https://www.ibm.com/docs/en/power11/9242-21T?topic=cr2-managing-system-by-using-dmtf-redfish-apis). |
| Generic OpenBMC / bmcweb | Platforms shipping OpenBMC with bmcweb Redfish enabled | Expected for standard system, chassis, sensor and manager resources. Platform integration controls which sensors exist. | [OpenBMC bmcweb](https://github.com/openbmc/bmcweb); [OpenBMC sensor architecture](https://github.com/openbmc/docs/blob/master/architecture/sensor-architecture.md). |

These vendors also appear on the [DMTF Redfish adopters list](https://www.dmtf.org/adopters?field_standards_value=redfish), but adopter status alone does not prove that every product or firmware version is compatible.

## Required Redfish behavior

RackSight requires:

- HTTPS or HTTP access to `/redfish/v1/`.
- HTTP Basic authentication accepted by the BMC.
- A discoverable `Systems` collection and at least one computer system.
- A discoverable `Chassis` collection for physical sensors.
- Standard collection links using `Members`, including expanded-member responses.
- At least one of legacy `Thermal`, modern `ThermalSubsystem`/`Fans`, `EnvironmentMetrics`, or chassis `Sensors` for environmental telemetry.

Optional resources improve the display:

- `Processors`, `Memory`, `MemorySummary`, `Bios`, `Boot`, `Managers`, `EthernetInterfaces`, and `UpdateService/FirmwareInventory`.
- CPU and memory utilization fields in standard or OEM telemetry.

RackSight is read-only toward monitored BMCs. The Settings page displays selected BMC/BIOS configuration but does not write firmware settings.

## Adding a compatibility result

AuthorityGate maintains the compatibility table. Record the vendor, complete server model, motherboard model when known, BMC type and firmware, BIOS version, and which RackSight sections populated correctly. Do not include hostnames, IP addresses, credentials, serial numbers, asset tags, or screenshots containing private infrastructure data.
