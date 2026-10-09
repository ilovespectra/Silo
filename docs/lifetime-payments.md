# Lifetime payments

The lifetime unlock accepts a one-time payment of 25 USDC on Solana. The
primary flow displays a Solana Pay transfer-request QR in Silo; the customer
scans and approves it in their wallet. Silo never receives a seed phrase or
signs a transaction for the customer. A manual-signature fallback is available
for wallets that cannot open the request directly.

Each request includes a fresh random 32-byte reference. While the payment panel
is open, Silo checks Helius for finalized transactions mentioning that
reference, then runs the existing recipient, USDC mint, amount, and transaction
success checks before saving the local lifetime license. The wallet remains
responsible for transaction review and approval. The transfer is not considered
paid until Solana finalizes it.

Customers may also open the branded Helio checkout in their default browser.
They can connect an installed wallet there or choose card checkout. Helio
returns a transaction signature to the relay; this callback is only a locator,
not proof of payment. The relay checks Helius at finalized commitment, then
Silo independently verifies the signature, recipient, USDC mint, amount, and
transaction success before saving the local lifetime license. The card flow
accepts at least 23.75 USDC at the Silo recipient to allow up to 5% of the $25
price to be absorbed as processor fees; direct Solana Pay and signature
verification still require the full 25 USDC.

The browser checkout uses a short-lived random claim token stored only for the
active checkout, and the hosted page removes it from the address bar after
loading. The installed app polls the relay over HTTPS; neither the relay token
nor the transaction signature is used as a license by itself.

### Relay configuration

Card and browser-wallet checkout require a working HTTPS relay and MySQL
connection. The relay deployment needs `MYSQL_HOST`, `MYSQL_DATABASE`,
`MYSQL_USER`, `MYSQL_PASSWORD`, and `PUBLIC_BASE_URL`; `MYSQL_PORT`,
`MYSQL_SSL`, and `HELIUS_RPC_URL` are optional. Use a database account limited
to the relay's purchase table. The `SILO_PAYMENT_RELAY_URL` environment
variable can override the default relay base URL for development or staging
builds. A build check cannot prove the production database is configured, and
a real card transaction is not part of local build checks.
