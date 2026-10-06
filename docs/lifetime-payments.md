# Lifetime payments

The lifetime unlock accepts a one-time payment of 25 USDC on Solana. The
primary flow displays a Solana Pay transfer-request QR in Silo; the customer
scans and approves it in their wallet. Silo never receives a seed phrase or
signs a transaction for the customer.

Each request includes a fresh random 32-byte reference. While the payment panel
is open, Silo checks Helius for finalized transactions mentioning that
reference, then runs the existing recipient, USDC mint, amount, and transaction
success checks before saving the local lifetime license. The wallet remains
responsible for transaction review and approval. The transfer is not considered
paid until Solana finalizes it.

Customers may still send USDC manually and paste the transaction signature in
the fallback panel. Silo verifies that signature with the same on-chain checks.
Neither payment path uses a hosted payment backend or requires a WalletConnect
project ID.
