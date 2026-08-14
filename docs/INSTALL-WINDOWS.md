# Installing RackSight on Windows

RackSight 1.1.4 is distributed as a Windows x64 installer. The release file is Authenticode-signed by **AUTHORITYGATE INC** and timestamped by GlobalSign.

## Installer

1. Download `RackSight-Setup-<version>-x64.exe` from the repository's Releases page.
2. Open **Properties → Digital Signatures** and confirm the signer is `AUTHORITYGATE INC`.
3. Run the installer, accept the MIT license, confirm the company name automatically detected from Windows registration or domain information, and enter the required registration email address.
4. Start RackSight from the Start menu or desktop shortcut.
5. Select **Add server** and enter the BMC FQDN or IP address, a descriptive name, and BMC credentials.

The installer requires administrator approval and installs to:

```text
C:\Program Files\AuthorityGate\RackSight
```

Application installation values are stored under `HKEY_LOCAL_MACHINE\SOFTWARE\AuthorityGate\RackSight`. Windows also creates its standard Apps & Features uninstall entry.

Setup attempts one registration with `https://license.authoritygate.com` containing only the detected or corrected company name and email, the computer FQDN, and installed app version. This is not licensing or activation. If the service is offline or blocked, setup records the skipped attempt locally and continues without restricting RackSight.

For managed silent deployment, supply the required email. Company is detected automatically when Windows registration or domain information is available; `/RACKSIGHTCOMPANY` remains an explicit override and is required only when detection returns no value:

```powershell
.\RackSight-Setup-1.1.4-x64.exe /S /RACKSIGHTEMAIL=user@example.com
```

## Verify the signature

In PowerShell:

```powershell
Get-AuthenticodeSignature .\RackSight-Setup-1.1.4-x64.exe |
  Select-Object Status, StatusMessage, SignerCertificate
```

`Status` must be `Valid`, and the certificate subject must include `CN=AUTHORITYGATE INC`. Stop if the signature is missing, invalid, or names another publisher.

To calculate a checksum:

```powershell
Get-FileHash .\RackSight-Setup-1.1.4-x64.exe -Algorithm SHA256
```

Compare the result with the checksum published in the matching GitHub Release notes.

## Application data

Electron stores RackSight data under the current Windows user's application-data directory, normally:

```text
%APPDATA%\RackSight\data
```

This directory contains the encryption key, encrypted BMC and SMTP credentials, alert state, alert events, and telemetry history. Back up the entire directory as one unit. Copying only the encrypted credential files without `master.key` makes them unrecoverable.

This directory is outside the installation folder and remains unchanged when RackSight is upgraded. Before an automatic update is installed, RackSight copies it to `%APPDATA%\RackSight\update-backups` and retains the three newest pre-update backups. If the primary data directory is unexpectedly missing after an update, RackSight restores the newest backup before starting its local service.

## Automatic updates

Installed builds check GitHub Releases shortly after startup. Settings displays the installed version, last check, result, and a **Check for updates** button. When a newer version is published, choose **Upgrade now**, **Read changelog**, or **Later**. Only the installed NSIS build supports in-app replacement; portable users should download and replace the portable executable manually. A failed check is recorded in Settings and never interrupts monitoring.

## Running and closing

Closing the RackSight window hides it to the notification area. Monitoring and alerts continue while its tray icon is present. Choose **Quit** from the tray menu to stop polling and notifications completely.

SMTP, browser, and native alerts require RackSight to remain running. Verify a test email before relying on email notification delivery.

## Network placement

RackSight connects directly to each BMC over HTTPS. Allow outbound TCP 443 from the desktop to the management network. A read-only BMC account is recommended.

Do not expose BMC interfaces or RackSight's embedded local service to the public internet.

## Uninstall

Use **Settings → Apps → Installed apps → RackSight → Uninstall**. Uninstalling the application may leave the per-user data directory so monitoring history and configuration can be preserved. Remove that directory manually only when the encrypted credentials and history are no longer needed.
