<?php
declare(strict_types=1);

require_once __DIR__ . '/../server/siteeu-relay/lib/relay.php';

function relay_test_expect(bool $condition, string $message): void
{
    if (!$condition) {
        throw new RuntimeException($message);
    }
}

function relay_test_transaction(string $signature, int $received, string $reference): array
{
    return [
        'transaction' => [
            'signatures' => [$signature],
            'message' => [
                'accountKeys' => [
                    ['pubkey' => SILO_USDC_RECEIVER],
                    $reference,
                ],
            ],
        ],
        'meta' => [
            'err' => null,
            'preTokenBalances' => [],
            'postTokenBalances' => [[
                'accountIndex' => 0,
                'mint' => SILO_USDC_MINT,
                'owner' => SILO_USDC_RECEIVER,
                'uiTokenAmount' => ['amount' => (string)$received, 'decimals' => 6],
            ]],
        ],
        'blockTime' => 1700000000,
    ];
}

$signature = str_repeat('5', 88);
$walletSignature = str_repeat('6', 88);
$manualSignature = str_repeat('7', 88);
$reference = '11111111111111111111111111111111';
$createdAt = 1699999999000;
$walletTransaction = relay_test_transaction($signature, SILO_WALLET_MIN_USDC_MICRO, $reference);
$walletTransaction['transaction']['signatures'] = [$walletSignature];
$wallet = relay_evaluate_payment_transaction($walletSignature, $walletTransaction, $createdAt, 'solana-pay', $reference);
relay_test_expect($wallet['state'] === 'verified', 'A finalized $25 direct wallet payment with its reference should verify.');
relay_test_expect(relay_transaction_has_reference($walletTransaction, $reference), 'The Solana Pay reference should be found in the transaction account keys.');

$wrongReference = relay_evaluate_payment_transaction($walletSignature, $walletTransaction, $createdAt, 'solana-pay', str_repeat('2', 32));
relay_test_expect($wrongReference['state'] === 'invalid', 'A direct wallet payment without the registered reference must not unlock the purchase.');

$feeAdjustedCard = relay_test_transaction($signature, SILO_CARD_MIN_USDC_MICRO, $reference);
$card = relay_evaluate_payment_transaction($signature, $feeAdjustedCard, $createdAt, 'card');
relay_test_expect($card['state'] === 'verified', 'A card checkout settlement at the existing 23.75 USDC minimum should verify.');

$underpaidWallet = relay_evaluate_payment_transaction($signature, $feeAdjustedCard, $createdAt, 'manual');
relay_test_expect($underpaidWallet['state'] === 'invalid', 'Manual and QR wallet payments must send the full 25 USDC.');

$manualTransaction = relay_test_transaction($manualSignature, SILO_WALLET_MIN_USDC_MICRO, $reference);
$manual = relay_evaluate_payment_transaction($manualSignature, $manualTransaction, $createdAt, 'manual');
relay_test_expect($manual['state'] === 'verified', 'A manually submitted, finalized $25 wallet payment should verify.');

$unmatchedSignature = relay_evaluate_payment_transaction(str_repeat('8', 88), $walletTransaction, $createdAt, 'manual');
relay_test_expect($unmatchedSignature['state'] === 'invalid', 'The transaction response must contain the requested signature.');

$deviceId = str_repeat('a', 32);
$key = openssl_pkey_new(['private_key_bits' => 2048, 'private_key_type' => OPENSSL_KEYTYPE_RSA]);
relay_test_expect($key instanceof OpenSSLAsymmetricKey, 'An ephemeral RSA test key should be created.');
$privatePem = '';
relay_test_expect(openssl_pkey_export($key, $privatePem), 'The ephemeral RSA test key should export.');
$keyDetails = openssl_pkey_get_details($key);
relay_test_expect(is_array($keyDetails) && is_string($keyDetails['key'] ?? null), 'The ephemeral RSA public key should be readable.');
$otherDeviceId = str_repeat('b', 32);
$paymentCases = [
    ['method' => 'card', 'signature' => $signature, 'verification' => $card],
    ['method' => 'solana-pay', 'signature' => $walletSignature, 'verification' => $wallet],
    ['method' => 'manual', 'signature' => $manualSignature, 'verification' => $manual],
];
foreach ($paymentCases as $paymentCase) {
    relay_test_expect($paymentCase['verification']['state'] === 'verified', $paymentCase['method'] . ' payment should be eligible for license recovery.');
    $verifiedAt = 1700000000123;
    $licenseToken = relay_sign_license_token(
        $deviceId,
        $paymentCase['signature'],
        $verifiedAt,
        $privatePem,
        $keyDetails['key']
    );
    [$payloadPart, $signaturePart] = explode('.', $licenseToken, 2);
    $licenseSignature = base64_decode(strtr($signaturePart, '-_', '+/'), true);
    $licensePayload = json_decode(base64_decode(strtr($payloadPart, '-_', '+/'), true) ?: '', true);
    relay_test_expect(
        is_string($licenseSignature) && openssl_verify($payloadPart, $licenseSignature, $keyDetails['key'], OPENSSL_ALGO_SHA256) === 1,
        $paymentCase['method'] . ' license token should verify with its corresponding public key.'
    );
    relay_test_expect(
        is_array($licensePayload) &&
        ($licensePayload['version'] ?? null) === 1 &&
        ($licensePayload['product'] ?? null) === 'silo' &&
        ($licensePayload['grant'] ?? null) === 'lifetime-purchase' &&
        ($licensePayload['deviceId'] ?? null) === $deviceId &&
        ($licensePayload['paymentSignature'] ?? null) === $paymentCase['signature'] &&
        ($licensePayload['verifiedAt'] ?? null) === $verifiedAt,
        $paymentCase['method'] . ' license token should remain bound to the machine that paid.'
    );
    $storedPurchase = [
        'installation_id' => $deviceId,
        'transaction_signature' => $paymentCase['signature'],
        'license_token' => $licenseToken,
        'verified_at_ms' => $verifiedAt,
    ];
    $recovered = relay_license_recovery_payload($storedPurchase, $deviceId, $paymentCase['signature']);
    relay_test_expect(
        is_array($recovered) &&
        ($recovered['status'] ?? null) === 'verified' &&
        ($recovered['installationId'] ?? null) === $deviceId &&
        ($recovered['licenseToken'] ?? null) === $licenseToken &&
        ($recovered['signature'] ?? null) === $paymentCase['signature'],
        $paymentCase['method'] . ' license should be recoverable by the same machine.'
    );
    relay_test_expect(
        relay_license_recovery_payload($storedPurchase, $otherDeviceId, $paymentCase['signature']) === null,
        $paymentCase['method'] . ' license recovery must not return a token to another machine.'
    );
}

fwrite(STDOUT, "Site.eu relay contract tests passed: direct wallet reference, method-specific USDC thresholds, card/manual/wallet verification, and same-machine license recovery.\n");
