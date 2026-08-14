# RackSight troubleshooting

## A server will not connect

1. Open `https://<bmc>/redfish/v1/` from the RackSight computer or test it with a read-only request.
2. Confirm DNS resolution, routing, TCP 443, and firewall policy to the management network.
3. Verify the account can log into Redfish. Some BMCs separately enable Redfish or API access per user.
4. Remove any path, query string, or embedded credentials from the address entered in RackSight.
5. Update the BMC firmware if the service returns HTTP 500 or malformed JSON.

Self-signed certificates are accepted by default. If `ALLOW_SELF_SIGNED=false` is configured, install a trusted certificate on the BMC or restore the default only on a trusted management network.

## Memory totals change or look wrong

RackSight prefers the Redfish `MemorySummary.TotalSystemMemoryGiB` value because individual DIMM collections can be incomplete while a BMC is refreshing inventory. Wait for POST/inventory collection to finish and update BMC firmware if the summary itself changes unexpectedly.

The Hardware page can help identify missing DIMM records. RackSight does not estimate unreported capacity.

## Fan count differs between identical servers

Many BMCs omit disconnected fan headers entirely. Compare physical connections, BMC firmware, sensor-definition/SDR state, and fan-control policy. A missing sensor is different from a connected fan reporting `0 RPM`.

Do not assume Redfish labels such as `FAN1_1` describe the same physical header across motherboard revisions. Confirm the motherboard manual and trace the cable before changing hardware.

## `FSC_INDEX` appears near 80°C

It is not a temperature. On the tested AMI/ASRock platform it is a synthetic fan-speed-control index placed in the Redfish temperature collection. RackSight displays it separately and excludes it from maximum-temperature calculations and alerts.

## Utilization says `N/A`

CPU and memory workload utilization are optional and frequently absent from BMC Redfish data. The tested B650D4U BMC publishes physical sensors but not host workload utilization. RackSight does not invent a value.

Use a hypervisor or operating-system data source such as vCenter/ESXi performance metrics when workload utilization is required.

## No history is shown

- History begins only after RackSight starts collecting; it cannot reconstruct earlier telemetry.
- Leave the Electron tray process or Node.js service running.
- The first background sample is taken shortly after startup and subsequent samples default to 60 seconds.
- Confirm the application-data directory is writable and has free disk space.
- Deleting or changing `RACKSIGHT_DATA_DIR` starts a different history store.

## Alerts do not fire

- Confirm alerts are enabled and that a physical sensor stayed above the threshold for the entire configured duration.
- A brief spike resets when the sensor returns below threshold.
- Browser notifications require permission and an open page.
- Electron notifications require the tray process to remain running.
- SMTP notifications require saved settings and a successful test email.
- Check `alert-events.jsonl` to distinguish alert evaluation from notification-delivery problems.

## SMTP test fails

- Port 465 normally uses **TLS from connection**.
- Port 587 normally starts plain and upgrades with STARTTLS, so secure mode is usually off.
- Confirm the provider permits SMTP authentication and whether an application password is required.
- Check outbound firewall rules and DNS.
- Confirm the sender is permitted by the SMTP account.

RackSight does not bypass certificate errors or authentication policy for SMTP.

## The app disappeared after closing the window

RackSight closes to the Windows notification area so monitoring continues. Double-click the tray icon to reopen it, or use its menu. Choose **Quit** to stop the application.

## Diagnostic safety

Before sharing logs or screenshots, remove hostnames, IP addresses, usernames, email addresses, serial numbers, asset tags, and environment-specific identifiers. Never share `master.key`, `servers.enc.json`, `smtp.enc.json`, a signing certificate private key, or token PIN.
