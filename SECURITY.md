# Security policy

Copyright (c) 2026 AuthorityGate

## Supported versions

| Version | Security updates |
| --- | --- |
| 1.x | Current |
| Earlier or modified builds | Not supported |

AuthorityGate provides RackSight without a support commitment or service-level agreement. Publishing this policy does not create an obligation to investigate, respond, remediate, or release updates.

## Reporting a vulnerability

If GitHub displays a **Report a vulnerability** option on the repository's Security page, use it to submit a private security advisory. Do not publish credentials, private infrastructure details, exploit instructions, or unredacted logs in a public issue.

Do not submit ordinary installation, compatibility, configuration, or feature requests as security reports. External pull requests are not accepted.

## Deployment guidance

- Keep RackSight and all BMC interfaces on a trusted management network.
- Use a dedicated least-privilege, read-only BMC account where the vendor permits it.
- Keep the default loopback binding for desktop use.
- For centralized viewing, keep the RackSight service bound to loopback and expose it only through an authenticated IIS HTTPS site with management-network access controls.
- Treat `%APPDATA%\RackSight\data` or the configured `data/` directory as sensitive.
- Back up `master.key` with encrypted credential files; do not commit either.
- Prefer trusted BMC certificates. Self-signed BMC certificates are accepted by default for compatibility and weaken server identity verification.
- Restrict RackSight Settings to administrators because enrollment QR codes carry the end-to-end mobile data key.
- Revoke lost or replaced Android devices promptly from RackSight Settings.
- Verify Windows release signatures name `AUTHORITYGATE INC` and compare release checksums.
- Keep BMC firmware, Windows, Electron, Node.js, and dependencies current.

## Data handled

RackSight stores BMC addresses, usernames, encrypted passwords, mobile enrollment credentials, alert events, hardware inventory, sensor history, firmware versions, serial numbers, and other Redfish-provided identifiers locally. When an administrator activates mobile notifications, RackSight sends AES-256-GCM encrypted telemetry and alert envelopes to AuthorityGate. The cloud stores no corresponding data key and cannot decrypt those envelopes. AuthorityGate does process verified email addresses, opaque credentials, device names, and Firebase Installation IDs for routing. Centralized email contains no monitoring details.

## Security limitations

- Local encryption protects stored secrets but cannot protect them from a user or process that can read both encrypted files and the local key.
- A person who captures an unexpired enrollment QR code and also controls its assigned email could register a device; QR codes are single-use and expire after five minutes.
- The local API trusts clients able to connect to its listening socket.
- RackSight is a monitoring aid, not a safety controller, access-control system, or replacement for vendor management software.
