# Changelog

All notable RackSight changes are documented here. Dates use ISO 8601.

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
