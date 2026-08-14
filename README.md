# RackSight

An AuthorityGate project
Copyright (c) 2026 AuthorityGate

A cross-vendor monitoring and alerting dashboard for servers with a Redfish-capable BMC. It supports ASRock Rack and standard Redfish implementations such as Dell iDRAC, HPE iLO, Lenovo XClarity, Supermicro, Cisco CIMC, IBM, Intel BMC, Fujitsu iRMC, and OpenBMC. It provides:

- Overall server health and power state
- CPU and DIMM inventory
- CPU and memory utilization when exposed by the BMC
- Temperature and fan sensors
- BIOS/BMC firmware inventory
- Boot, BIOS, and BMC network settings
- Persistent 1-hour, 4-hour, 24-hour, 7-day, and 30-day telemetry charts
- Configurable sustained-temperature alerts
- Browser, native Electron, and encrypted SMTP notifications

## Requirements

- Node.js 18 or newer
- Network access from the dashboard host to each BMC
- A read-only BMC account (recommended)
- Redfish enabled on each BMC

## Run

```bash
npm start
```

Open <http://127.0.0.1:3000>, select **Add server**, and enter the BMC's FQDN or IP address and credentials. Most BMCs use a self-signed certificate; these are accepted by default. Set `ALLOW_SELF_SIGNED=false` to require a certificate trusted by the dashboard host.

To listen on the LAN:

```bash
HOST=0.0.0.0 PORT=3000 npm start
```

Put the dashboard behind an authenticated HTTPS reverse proxy before exposing it beyond a trusted management network.

## Desktop application

Run the Electron desktop version during development:

```bash
npm run electron
```

Build Windows installer and portable artifacts:

```bash
npm run dist:win
```

The desktop app continues monitoring in the system tray when its window is closed. Its credentials, alert rules, SMTP configuration, and history are stored under Electron's per-user application-data directory.

## Credential storage

Credentials never return to the browser after saving. They are encrypted with AES-256-GCM in `data/servers.enc.json`; a randomly generated 256-bit key is stored at `data/master.key`. Both are created with owner-only permissions where supported.

For containers or reproducible deployments, set a persistent secret instead:

```bash
DASHBOARD_SECRET='replace-with-a-long-random-secret' npm start
```

Do not change or lose the secret while encrypted server records exist. The `data/` directory is excluded from Git.

## Historical telemetry

The server polls configured BMCs in the background every 60 seconds, including when no browser is open. Compact snapshots are written to `data/history/<server-id>.jsonl` and retained for 31 days. The API uses one-minute points for one hour, two-minute points for four hours, five-minute points for 24 hours, 30-minute points for seven days, and two-hour points for 30 days.

You can change the collection interval, with a minimum of 30 seconds:

```bash
HISTORY_INTERVAL_MS=60000 npm start
```

History begins accumulating after this version starts; it cannot reconstruct telemetry from before collection was enabled.

## Alerts and SMTP

Temperature alerts apply to physical Redfish temperature sensors; synthetic values such as ASRock's `FSC_INDEX` are excluded. Configure the threshold, required time above threshold, repeat cooldown, browser permission, and SMTP delivery on the Settings page. SMTP passwords are encrypted using the same AES-256-GCM credential key as BMC passwords. Test-email delivery is available before enabling SMTP alerts.

Both high-temperature and recovery messages are recorded in `data/alert-events.jsonl`. Email delivery requires the RackSight process to remain running.

## Redfish differences

Inventory, health, and temperatures are widely supported. Live CPU and memory utilization are optional Redfish/OEM telemetry, and some ASRock BMC firmware does not publish them. RackSight displays `N/A` in that case rather than estimating incorrect values. Updating the board's BMC firmware may expose additional data.

The B650D4U BMC telemetry service exposes temperature, fan, and voltage definitions but not host CPU or memory workload utilization. RackSight therefore omits an empty utilization history chart. Workload history requires a separate ESXi or vCenter integration.

AMI firmware reports `FSC_INDEX` in Redfish's temperature collection, but it is a synthetic fan-speed-control index rather than a physical temperature. RackSight displays it separately and excludes it from maximum-temperature calculations.

## Test

```bash
npm test
```

## Repository policy

AuthorityGate maintains exactly two branches: `main` is the stable/default branch and `Dev` is the active development branch. External pull requests are not accepted and are closed automatically. See [CONTRIBUTING.md](CONTRIBUTING.md) for the complete policy.

## License, warranty, and support

RackSight is licensed under the [MIT License](LICENSE). It is provided **as is**, without warranty or guarantee of any kind. AuthorityGate provides no support commitment, service-level agreement, implementation assistance, compatibility guarantee, or obligation to fix defects. RackSight is not a replacement for vendor-supported monitoring or safety controls; users are responsible for validating alert delivery and operating the software securely.
