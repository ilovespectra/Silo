# Beta lifetime licenses

Approved beta testers can receive full lifetime access without sending payment.
Silo submits the installation ID, request code, app version, platform, and
request time through the configured HTTPS request relay. The request screen
keeps those identifiers out of the UI; the developer receives them in the
request email.

## Signing key

The release signing key must stay outside the repository and app packages. The
public key in `src/betaLicensePublicKey.ts` is committed with the app and is
used to verify every grant. The developer dashboard checks that the private
key matches this public key before issuing anything.

## Grant access

The Release Dock developer checkout has a local-only interactive dashboard:

```sh
node scripts/beta-license-dashboard.local.cjs
```

Enter the installation ID from the request email. The dashboard prints a signed
`silo://beta-activate?...` link to include in the reply. Opening that link in
the requesting Silo installation verifies the Ed25519 signature and exact
installation ID, then saves the grant locally. There is no activation-code
paste field.

The dashboard script is intentionally ignored by Git and is not included in
clones. The signing key is stored separately and is not distributed with Silo.
A copied or altered request code cannot create an activation grant.

The grant has no expiry or revocation service. Copying the app's user-data
folder can transfer its saved installation ID and beta grant together. Do not
rotate the signing key for an existing release; an app with a different public
key cannot verify earlier grants unless it explicitly supports key rotation.

## Release checks

`npm run release:check` runs beta-signature tests, confirms the generated app
contains the configured Ed25519 public key and activation-link handling,
rejects code-paste UI in the built renderer, and scans packaged text inputs for
private-key PEM material. The check intentionally fails while the public-key
module is blank; do not bypass it for a beta-enabled build.
