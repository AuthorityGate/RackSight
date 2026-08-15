# Centralized RackSight deployment with IIS

The signed `RackSight-IIS-Server-<version>.exe` release asset installs a complete server payload, including locked production dependencies, under `C:\Program Files\AuthorityGate\RackSight-Web` and opens this IIS configuration guide. It is separate from the Electron desktop installer. The server checks the official GitHub release once at startup and every 24 hours, recording the result in `update-status.json` in the RackSight data directory.

Use this deployment when multiple authorized administrators need one centralized RackSight dashboard. IIS is the only network-facing component. The RackSight Node.js service remains bound to `127.0.0.1` and is not exposed directly to the LAN.

## Supported topology

```text
Administrator browser
        |
        | HTTPS + IIS authentication
        v
IIS site on the management network
        |
        | reverse proxy over loopback
        v
RackSight Node.js service at 127.0.0.1:3000
        |
        +---- HTTPS to Redfish BMCs
        +---- persistent encrypted configuration and JSONL history
        +---- outbound HTTPS to license.authoritygate.com for optional Android/email notifications
```

## Prerequisites

- A supported Windows Server release with IIS
- Node.js 22 or newer (use a currently supported LTS release)
- IIS URL Rewrite module
- IIS Application Request Routing with proxy support enabled
- An HTTPS certificate for the internal RackSight site
- Windows Authentication or another organization-approved authentication layer
- A dedicated Windows service identity with logon-as-a-service rights
- Network access from the RackSight server to each BMC management interface

## Application and data locations

Use separate program and data directories:

```text
C:\Program Files\AuthorityGate\RackSight-Web
C:\ProgramData\AuthorityGate\RackSight
```

Copy a tagged RackSight source release into the program directory and run `npm ci --omit=dev` there. Grant the service identity read and execute access to the program directory and modify access only to the data directory.

Configure these values in the Windows service environment:

```text
HOST=127.0.0.1
PORT=3000
RACKSIGHT_DATA_DIR=C:\ProgramData\AuthorityGate\RackSight
DASHBOARD_SECRET=<organization-managed persistent secret>
```

Optional service values include `HISTORY_INTERVAL_MS=60000` and `ALLOW_SELF_SIGNED=false`. Store `DASHBOARD_SECRET` in the organization's protected service configuration or secrets system. Do not put it in source control or the IIS `web.config` file.

Android notifications additionally require outbound HTTPS to `license.authoritygate.com`, Firebase endpoints, and Microsoft identity/Graph endpoints used by the AuthorityGate control plane. Override the control plane only for an approved private deployment with `RACKSIGHT_MOBILE_API_URL=https://example/api/racksight/mobile/v1`. RackSight never requires an inbound internet rule.

Run `node server.js` under the organization's approved Windows service manager. Configure automatic startup, restart on failure, and log collection. The service must run independently of an interactive user session.

## IIS configuration

1. Create a dedicated IIS site with an HTTPS binding and the internal RackSight hostname.
2. Disable anonymous access and enable the organization's chosen authentication method.
3. Restrict access to approved administrator groups and the management network.
4. Enable ARR proxy support at the IIS server level.
5. Add this `web.config` to an otherwise empty IIS site directory:

```xml
<?xml version="1.0" encoding="UTF-8"?>
<configuration>
  <system.webServer>
    <rewrite>
      <rules>
        <rule name="RackSight loopback proxy" stopProcessing="true">
          <match url="(.*)" />
          <action type="Rewrite" url="http://127.0.0.1:3000/{R:1}" appendQueryString="true" />
        </rule>
      </rules>
    </rewrite>
    <proxy preserveHostHeader="true" />
  </system.webServer>
</configuration>
```

6. Confirm Windows Firewall does not expose TCP 3000. Only the IIS HTTPS binding should accept remote connections.
7. Browse to the authenticated IIS URL and add BMC connections from the RackSight interface.

## Data protection and upgrades

Back up the complete `C:\ProgramData\AuthorityGate\RackSight` directory as one unit. It contains the encryption key, encrypted BMC credentials, encrypted mobile registration/data key, alert state, alert history, and telemetry history. Encrypted files cannot be recovered without the matching `master.key` or unchanged `DASHBOARD_SECRET`.

For an upgrade:

1. Back up the complete data directory.
2. Stop the RackSight Windows service.
3. Replace the application files with the new tagged release.
4. Run `npm ci --omit=dev` in the program directory.
5. Preserve the service environment and data directory unchanged.
6. Start the service and verify the IIS site, server inventory, history, and encrypted mobile sync status.

Do not use the Electron auto-updater for an IIS deployment. Centralized releases should be promoted through the organization's normal server change process.
