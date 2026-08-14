# RackSight local API

The browser and Electron interface use the same local JSON API. It is intended for the bundled UI, internal automation, and troubleshooting.

The API has no built-in authentication. Electron keeps it on loopback. Centralized deployments must keep the service on loopback and expose it only through the authenticated IIS HTTPS site described in [INSTALL-IIS.md](INSTALL-IIS.md).

## Responses

- JSON responses use `Content-Type: application/json` and `Cache-Control: no-store`.
- Validation failures return HTTP `400` with `{ "error": "message" }`.
- A BMC collection failure returns HTTP `502`.
- Credentials and SMTP passwords are never returned.

## Servers

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/servers` | List configured servers with redacted credentials. |
| `POST` | `/api/servers` | Add a server, or update one when `id` is supplied. |
| `DELETE` | `/api/servers/{id}` | Delete a server connection. Existing history files are retained. |
| `GET` | `/api/servers/{id}/data` | Collect or return recently cached normalized Redfish data. |
| `GET` | `/api/servers/{id}/history?range=24h` | Return downsampled telemetry for `1h`, `4h`, `24h`, `7d`, or `30d`. |

Each history bucket includes average scalar values with matching `*Peak` fields and average sensor maps with matching peak maps: `temperaturePeaks` and `fanPeaks`. Bucket widths are 1 minute, 2 minutes, 5 minutes, 30 minutes, and 2 hours for the five supported ranges.

Example server request:

```json
{
  "name": "rack-01",
  "address": "bmc01.example.net",
  "username": "racksight-readonly",
  "password": "replace-me"
}
```

The address defaults to HTTPS when no scheme is supplied. Do not embed credentials in the address.

## Alert configuration

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/alert-settings` | Read global alert settings. |
| `PUT` | `/api/alert-settings` | Replace global alert settings. |
| `GET` | `/api/alerts/active` | List pending and firing alerts. |
| `GET` | `/api/alerts/events?limit=100` | Read recent fired and recovery events. |

Alert settings:

```json
{
  "enabled": true,
  "thresholdC": 85,
  "durationMinutes": 5,
  "fanAlertsEnabled": true,
  "fanFailureDurationMinutes": 2,
  "cooldownMinutes": 30,
  "browserNotifications": true
}
```

Thresholds apply to physical temperature sensors. Synthetic values such as ASRock `FSC_INDEX` are excluded. Fan monitoring learns connected fans and detects sustained zero RPM, disappearance, unavailable readings, or unhealthy Redfish status without alerting on unused headers.

## SMTP configuration

| Method | Path | Purpose |
| --- | --- | --- |
| `GET` | `/api/smtp-settings` | Read SMTP settings with the password removed. |
| `PUT` | `/api/smtp-settings` | Validate and save encrypted SMTP settings. |
| `POST` | `/api/smtp/test` | Send a test message using saved settings. |

Sending an empty password during an update preserves the existing encrypted password.

## Stability

The local API is versioned with the application and is not currently a separately supported public contract. Integrations should pin a RackSight release and validate response shapes during upgrades.
