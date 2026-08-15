# RackSight Android notifications

RackSight mobile access is optional, free, read-only, and outbound-only. A Desktop or IIS installation encrypts complete normalized server snapshots and alert details before sending them to the AuthorityGate control plane. Registered Android devices download and decrypt those payloads locally.

## Trust model

- A random 256-bit mobile data key is created and stored in the encrypted local `mobile.enc.json` store.
- Snapshots and alert details use AES-256-GCM with the installation ID as authenticated additional data.
- The data key is carried only in a locally rendered, five-minute, single-use QR code.
- AuthorityGate stores ciphertext. It never receives the mobile data key and cannot read the monitored-server data.
- AuthorityGate necessarily processes verified email addresses, device names, opaque token hashes, and Firebase Installation IDs used for push delivery.
- Android API calls fail closed unless Firebase App Check validates the RackSight package through Play Integrity against the registered AuthorityGate release-signing certificate SHA-256 fingerprint. Debug-signed and repackaged builds cannot enroll, refresh credentials, register for push, or download payloads.
- Email notices contain no server, sensor, address, inventory, or alert details.
- Desktop/IIS uses outbound HTTPS. No customer listener or BMC is exposed to the internet.
- Android has no server mutation, acknowledgement, remediation, power, firmware, BIOS, or configuration API.

## Registration sequence

1. Settings initially shows **Android notifications — Unconfigured** in a disabled visual state.
2. An administrator enters the installation-owner email.
3. AuthorityGate sends a six-digit code from `Alerts@AuthorityGate.com`; the code expires after 10 minutes and locks after five failed attempts.
4. After owner verification, Settings enables **Create QR code**.
5. The administrator assigns an email and creates a single-use QR code that expires after five minutes.
6. The Android user scans the code, confirms the assigned email, and requests a separate six-digit device code.
7. Successful verification creates independent device access and refresh tokens. Android then requests notification permission.
8. Settings lists each device separately. Revocation invalidates that device and all of its refresh tokens.

Multiple customers are separated by random installation IDs and installation credentials. Multiple people and devices are attached to exactly one installation and can be revoked independently.

## Control-plane deployment

The deployable Worker is in `control-plane/`. It can coexist with the current Next.js license site by routing only:

```text
license.authoritygate.com/api/racksight/mobile/v1/*
```

Create a D1 database, replace the placeholder `database_id` in `wrangler.toml`, then configure secrets:

```powershell
cd control-plane
npx wrangler d1 create racksight-mobile
npx wrangler secret put TOKEN_PEPPER
npx wrangler secret put GRAPH_TENANT_ID
npx wrangler secret put GRAPH_CLIENT_ID
npx wrangler secret put GRAPH_CLIENT_SECRET
npx wrangler secret put FIREBASE_PROJECT_ID
npx wrangler secret put FIREBASE_PROJECT_NUMBER
npx wrangler secret put FIREBASE_ANDROID_APP_ID
npx wrangler secret put FIREBASE_CLIENT_EMAIL
npx wrangler secret put FIREBASE_PRIVATE_KEY
npx wrangler d1 migrations apply racksight-mobile --remote
npx wrangler deploy
```

`TOKEN_PEPPER` must be a high-entropy deployment secret. The Microsoft Entra application needs narrowly scoped application permission to send mail as the dedicated `Alerts@AuthorityGate.com` mailbox. Set optional `GRAPH_SENDER` as a non-secret Worker variable only if the mailbox differs. Firebase values come from a service account authorized only for the RackSight Firebase project. The app uses the current FCM Installation ID registration API rather than deprecated registration-token APIs.

Do not deploy until the placeholder D1 identifier is replaced and both email and FCM credentials have been tested in a non-production environment.

## Android Firebase configuration

Create the Android application `net.authoritygate.racksight` in the AuthorityGate Firebase project and place its unmodified `google-services.json` at:

```text
RackSight_Android/app/google-services.json
```

The file is ignored by Git. The Android project compiles without it for UI and enrollment development, but FCM registration and push delivery require the real file. Never copy the Firebase service-account private key into the Android app.

Register the SHA-256 fingerprint of the AuthorityGate Android release-signing certificate in Firebase, enable App Check with the Play Integrity provider for `net.authoritygate.racksight`, and do not register the debug certificate in production. The control plane also checks the verified token's Firebase App ID and project claims on every Android API request.

## Connector configuration

Production defaults to:

```text
https://license.authoritygate.com/api/racksight/mobile/v1
```

For an approved private test environment, set `RACKSIGHT_MOBILE_API_URL`. Non-loopback HTTP URLs are rejected. `RACKSIGHT_REGISTRATION_ID` can link the runtime claim to an existing installer registration ID when the deployment system supplies it.

## Retention

The Worker retains the latest three encrypted snapshots and the latest 500 encrypted alert events per installation. Device refresh tokens expire after 90 days and rotate on use; access tokens expire after 15 minutes. Revocation takes effect on the next API or push operation.
