# Changelog

All notable RackSight changes are documented here. Dates use ISO 8601.

## [1.1.6] - 2026-08-14

### Added

- Added unattended installation support for Microsoft Store and WinGet distribution.
- Made installation registration optional during silent deployment; users can register through AuthorityGate after installation.
- Prepared both Desktop and IIS Server installers for signed public package-manager delivery.

## [1.1.5] - 2026-08-14

### Changed

- Startup uses a dedicated ten-second bootstrap window so every configured server begins its initial collection promptly instead of waiting for the steady-state one-minute schedule.
- Steady-state collections retain evenly distributed start times (`60 seconds ÷ server count`) while allowing an already-started scan to finish independently.
- GitHub release retention is now enforced automatically: the current release and two immediately preceding releases and tags are retained.

## [1.1.4] - 2026-08-14

### Changed

- Server-wide Redfish collections now run one at a time and are evenly staggered across each one-minute polling cycle (`60 seconds ÷ server count`). Slow collections never overlap; when collection time exceeds the assigned spacing, serialization takes priority.
- Renamed the overview response metric to **Average collection** and individual timing labels to clarify that they measure a complete Redfish hardware scan rather than network latency.

## [1.1.3] - 2026-08-14

### Fixed

- Saving an edited BMC address or credential now clears the prior authentication cooldown and tests the new values immediately.
- Added **Connect now** actions to offline server cards and every BMC connection in Settings.
- Redfish polling now reuses standards-based session tokens instead of submitting Basic credentials for every hardware resource request, reducing BMC authentication throttling and lockouts. Devices that explicitly do not implement SessionService retain a Basic-authentication fallback.

## [1.1.2] - 2026-08-14

### Added

- Company name is automatically populated from the existing RackSight registration, Windows `RegisteredOrganization`, or the signed-in Windows domain; the installer still allows correction and an explicit deployment override.

### Fixed

- Corrected the packaged Electron icon path that caused RackSight 1.1.1 to exit immediately after installation.

## [1.1.1] - 2026-08-14

### Changed

- Updated the RackSight application, installer, taskbar, tray, notification, and web-interface icon to the approved separated rack-and-arch design with a transparent gap around the arch.
- Added a visible application-update status and manual **Check for updates** action to Settings.

### Fixed

- The installed Windows app now records and exposes every startup update-check result instead of silently hiding release-feed errors.

## [1.1.0] - 2026-08-14

### Added

- Average and peak telemetry values for every 1-hour, 4-hour, 24-hour, 7-day, and 30-day chart bucket.
- Matching solid average and dashed peak chart series for CPU, memory, temperatures, fan speed, and fan-control demand.
- A supported centralized deployment guide using an authenticated HTTPS IIS reverse proxy and a loopback-only RackSight service.
- Required company-name capture in installation registration, stored with the existing email, computer FQDN, and application version.

### Changed

- Public deployment guidance now focuses on the Electron desktop app or centralized IIS instead of direct Node.js/LAN exposure.
- Centralized deployments now enforce Node.js 22 or newer; Node.js 18 is no longer supported.
- Release builds and development tooling are pinned to Node.js 24 while retaining Node.js 22 runtime compatibility.

### Fixed

- BMC HTTP 401, 403, and 429 responses now trigger an exponential 5-to-30-minute polling backoff instead of repeated requests that can prolong an ASRock Rack/AMI source-IP block.
- Successful BMC data is cached for 55 seconds so the desktop UI and one-minute history collector share a poll instead of starting separate 30-second collections.

## [1.0.2] - 2026-08-14

### Fixed

- Corrected the Windows PowerShell registry-value operation used by installation registration. Version 1.0.1 setup collected and stored the required email but could stop before submitting the registration because `Set-ItemProperty` does not accept a `-Type` parameter.
- Registration success, skipped status, timestamps, ID, FQDN, and error details are now reliably written under `HKLM\SOFTWARE\AuthorityGate\RackSight`.

## [1.0.1] - 2026-08-14

### Added

- AuthorityGate RackSight application icon throughout the desktop executable, installer, tray, notifications, and web interface.
- Fixed system-wide installation path at `C:\Program Files\AuthorityGate\RackSight` with application values under `HKLM\SOFTWARE\AuthorityGate\RackSight`.
- Required installer email disclosure and best-effort installation registration containing only email, computer FQDN, and app version; registration never licenses, activates, gates, or blocks RackSight.
- Startup update prompt backed by signed GitHub Releases, with upgrade, changelog, and defer choices.
- Pre-update application-data backups and automatic recovery if the primary data directory is unexpectedly missing.

### Changed

- Installer data remains separate from program binaries so server definitions, encrypted credentials, SMTP and alert settings, and retained telemetry history persist across every upgrade.

## [1.0.0] - 2026-08-14

### Added

- Cross-vendor Redfish discovery for systems, chassis, managers, firmware, inventory, temperatures, and fans.
- ASRock Rack/AMI handling for `FSC_INDEX`, disconnected fan headers, OEM inventory placeholders, and authoritative memory summaries.
- Overview, Hardware, and Settings interfaces.
- Persistent telemetry with 1-hour, 4-hour, 24-hour, 7-day, and 30-day chart ranges.
- Sustained-temperature alert engine with configurable threshold, duration, and cooldown.
- Browser and Electron native notifications.
- Encrypted SMTP configuration, test delivery, high-temperature messages, and recovery messages.
- AES-256-GCM storage for BMC and SMTP credentials.
- Electron desktop wrapper with notification-area operation.
- Authenticode-signed Windows installer and portable application published by AuthorityGate.
- MIT license, two-branch repository policy, and automatic closure of external pull requests.

### Known limitations

- CPU and memory utilization appear only when the BMC publishes usable metrics.
- RackSight does not write BIOS, BMC, boot, or fan-control settings.
- The web service has no built-in user authentication and defaults to loopback for that reason.
- Compatibility outside the tested ASRock Rack platform is based on standard Redfish behavior and vendor documentation pending additional lab validation.
