# Beta lifetime licenses

Beta testers can receive the same full, permanent access as a paid lifetime
license without sending payment. The app creates a random installation ID and
shows a request code in the lifetime-access panel. The tester sends that code
to you; you sign it locally and return the activation code. No server or
payment transaction is involved.

## Prepare a release

Run this once in the Silo checkout before building the first beta-enabled app:

```sh
npm run beta:keys
```

This creates an Ed25519 signing key outside the checkout at
`~/.config/silo/beta-license-private.pem` with owner-only file permissions and
writes the matching public key to `src/betaLicensePublicKey.ts`. Commit the
public-key file and include it in every release. Never commit, upload, or ship
the private key. Keep a secure backup of it; losing it means you cannot issue
grants accepted by builds with that public key.

## Grant access

When a tester shares their request code, run:

```sh
npm run beta:grant -- 'SILO-BETA-REQUEST-1.<installation-id>'
```

Copy the printed activation code back to that tester. They paste it into the
beta-access section of the paywall. The grant is lifetime and tied to that
Silo installation ID. They do not need to send a transaction signature or
wallet address for beta access.

Set `SILO_BETA_LICENSE_KEY_PATH` if the private key is stored in a different
secure location. The request code and activation code are not passwords, but
the activation code only works for the installation that requested it.

The grant is offline and has no expiry or revocation service. As with other
local Silo state, copying the app's user-data folder can transfer its saved
installation ID and grant together. Do not rotate the signing key for an
existing release; a new public key would not validate earlier grants unless
the app explicitly supports key rotation.

## Release checks

`npm run dist` runs `npm run release:check` after building the renderer and
Electron main process, before packaging. The check runs beta-signature tests,
confirms the generated app contains the configured Ed25519 public key and beta
activation UI/handlers, and scans packaged text inputs for private-key PEM
material. It intentionally fails while the public-key module is still blank;
do not bypass that check to ship a beta build that cannot activate grants.
