# RackSight architecture

RackSight supports an Electron desktop deployment or a centralized IIS deployment. IIS terminates HTTPS and authenticates users while proxying to the RackSight Node.js service on loopback. RackSight does not require a cloud service or database.

```mermaid
flowchart LR
    UI[Electron window or authenticated IIS user] -->|JSON API| Edge[Electron loopback or IIS HTTPS]
    Edge --> App[Node.js RackSight service]
    App -->|HTTPS Basic auth / read-only GET| BMC1[Redfish BMC]
    App -->|HTTPS Basic auth / read-only GET| BMC2[Redfish BMC]
    App --> Store[(Encrypted configuration and JSONL history)]
    App --> Alert[Alert state engine]
    App -->|AES-256-GCM ciphertext over HTTPS| Relay[AuthorityGate mobile control plane]
    Relay --> FCM[Firebase Cloud Messaging]
    Relay --> Mail[Alerts@AuthorityGate.com]
    FCM --> Android[Registered Android device]
    Android -->|decrypt locally| MobileUI[Read-only mobile dashboard]
    Alert --> UI
    Alert --> Native[Electron notification]
```

## Components

- `server.js` serves the static UI, local JSON API, Redfish collector, history worker, encryption, and alert state machine.
- `mobile.js` performs owner verification, QR enrollment, per-device administration, and outbound-only encrypted snapshot/alert delivery.
- `public/` contains the dependency-free browser interface and chart renderer.
- `electron/main.js` starts the service on a random loopback port, hosts it in a sandboxed `BrowserWindow`, manages the tray, and displays native notifications.
- The configured `RACKSIGHT_DATA_DIR` contains centralized IIS runtime state. Electron redirects it into its per-user application-data location.

## Collection flow

1. A configured server is loaded from the encrypted credential store.
2. RackSight requests the Redfish service root and follows advertised `Systems`, `Chassis`, `Managers`, and update-service links.
3. Collection member requests run with a four-request concurrency limit and one retry for transient failures.
4. Vendor payloads are normalized into one dashboard response.
5. A compact snapshot is appended to the server's JSONL history at the configured interval.
6. Physical temperature readings are evaluated by the persistent alert state machine.
7. A sustained breach creates an event and can trigger browser, Electron, encrypted Android, and centralized generic email notifications. A return below threshold creates a recovery event.

RackSight caches a successful collection briefly so simultaneous UI, history, and alert requests do not repeatedly load the BMC.

## Storage model

| File | Purpose | Protection |
| --- | --- | --- |
| `master.key` | Random 256-bit local encryption key | Owner-only permissions where supported; never commit or share. |
| `servers.enc.json` | BMC addresses, usernames, and passwords | AES-256-GCM encrypted. |
| `mobile.enc.json` | Installation token, mobile data key, verified owner, and cached device status | AES-256-GCM encrypted; secrets are never returned by the local API. |
| `latest-data.enc.json` | Last successful normalized inventory for offline display and mobile snapshots | AES-256-GCM encrypted. |
| `alert-settings.json` | Non-secret threshold and notification preferences | Plain JSON. |
| `monitoring-settings.json` | Configurable BMC polling interval | Plain JSON. |
| `alert-state.json` | Pending and firing alert state | Plain JSON. |
| `fan-inventory.json` | Learned connected-fan baselines | Plain JSON. |
| `alert-events.jsonl` | Fired and recovery event journal | Plain JSONL. |
| `management-actions.jsonl` | Auditable BMC manager-recovery actions | Plain JSONL. |
| `history/<id>.jsonl` | Compact telemetry snapshots | Plain JSONL, retained for 31 days. |

When `DASHBOARD_SECRET` is set, RackSight derives the encryption key from that value. Otherwise it uses `master.key`.

## Trust boundaries

- The local API trusts any client that can connect to its listening address. Electron keeps it on a random loopback port; centralized deployments keep it on loopback and require authenticated IIS HTTPS access.
- BMC credentials are decrypted only in the Node.js process and are never returned by the API.
- Self-signed BMC TLS certificates are accepted by default for common management-network deployments. Set `ALLOW_SELF_SIGNED=false` to enforce normal certificate validation.
- Mobile connectivity is outbound HTTPS only. AuthorityGate stores AES-256-GCM envelopes without the mobile data key. Email addresses and device delivery tokens remain visible to the control plane because they are required for routing.
- Enrollment QR codes are generated locally, expire after five minutes, and can be consumed only once after a separate ten-minute email verification challenge.

## Scaling characteristics

RackSight targets small and medium internal fleets. It polls each configured BMC every five minutes by default, configurable from two through ten minutes, and stores local JSONL files. It is not a clustered service, distributed time-series database, or replacement for enterprise monitoring platforms.
