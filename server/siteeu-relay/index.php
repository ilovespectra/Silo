<?php
declare(strict_types=1);

ini_set('display_errors', '0');
error_reporting(E_ALL);
require_once __DIR__ . '/lib/relay.php';

function relay_create_purchase(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        relay_json(405, ['error' => 'Method not allowed.']);
    }
    $body = relay_request_json();
    $installationId = $body['installationId'] ?? null;
    $paymentMethod = $body['paymentMethod'] ?? 'card';
    $reference = $body['reference'] ?? null;
    if (!relay_valid_installation_id($installationId)) {
        relay_json(400, ['error' => 'Invalid Silo installation reference.']);
    }
    if (!in_array($paymentMethod, ['card', 'solana-pay', 'manual'], true)) {
        relay_json(400, ['error' => 'Unsupported payment method.']);
    }
    if (($paymentMethod === 'solana-pay' && !relay_valid_reference($reference)) || ($paymentMethod !== 'solana-pay' && $reference !== null)) {
        relay_json(400, ['error' => 'The Solana Pay reference is missing or unexpected.']);
    }

    $db = relay_db();
    relay_ensure_schema($db);
    $id = relay_uuid_v4();
    $claimToken = relay_claim_token();
    $now = (int)floor(microtime(true) * 1000);
    $insert = $db->prepare("INSERT INTO silo_card_purchases (id, claim_token_sha256, installation_id, payment_method, reference, paylink_id, status, created_at_ms) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)");
    try {
        $insert->execute([$id, relay_token_hash($claimToken), $installationId, $paymentMethod, $reference, SILO_PAYLINK_ID, $now]);
    } catch (PDOException $error) {
        if (relay_duplicate_signature($error) && $paymentMethod === 'solana-pay') {
            relay_json(409, ['error' => 'This Solana Pay request is already registered. Generate a new QR code.']);
        }
        throw $error;
    }

    $payload = [
        'purchaseId' => $id,
        'claimToken' => $claimToken,
    ];
    if ($paymentMethod === 'card') {
        $payload['checkoutUrl'] = relay_config()['public_base_url'] . '/checkout.html?' . http_build_query([
            'purchase' => $id,
            'claim' => $claimToken,
        ], '', '&', PHP_QUERY_RFC3986);
    }
    if ($paymentMethod === 'solana-pay') {
        $payload['reference'] = $reference;
    }
    relay_json(201, $payload);
}

function relay_verified_purchase(PDO $db, string $id, string $signature, array $verification): array
{
    try {
        $db->beginTransaction();
        $select = $db->prepare('SELECT status, transaction_signature, installation_id, license_token, verified_at_ms FROM silo_card_purchases WHERE id = ? FOR UPDATE');
        $select->execute([$id]);
        $purchase = $select->fetch();
        if (!$purchase) {
            $db->rollBack();
            return ['status' => 404, 'body' => ['error' => 'Checkout not found.']];
        }
        if ($purchase['status'] === 'verified') {
            if ($purchase['transaction_signature'] !== $signature) {
                $db->rollBack();
                return ['status' => 409, 'body' => ['error' => 'This checkout already has a different verified payment.']];
            }
            $verifiedAt = (int)$purchase['verified_at_ms'];
            $licenseToken = is_string($purchase['license_token']) ? $purchase['license_token'] : '';
            if ($licenseToken === '') {
                $licenseToken = relay_sign_license_token($purchase['installation_id'], $signature, $verifiedAt);
                $update = $db->prepare('UPDATE silo_card_purchases SET license_token = ? WHERE id = ? AND status = \'verified\'');
                $update->execute([$licenseToken, $id]);
            }
            $db->commit();
            return ['status' => 200, 'body' => [
                'status' => 'verified',
                'signature' => $signature,
                'installationId' => $purchase['installation_id'],
                'licenseToken' => $licenseToken,
                'verifiedAt' => $verifiedAt,
            ]];
        }
        if ($purchase['status'] === 'expired') {
            $db->rollBack();
            return ['status' => 410, 'body' => [
                'status' => 'expired',
                'error' => 'This checkout expired. Start a new payment from Silo.',
            ]];
        }

        $verifiedAt = (int)floor(microtime(true) * 1000);
        $licenseToken = relay_sign_license_token($purchase['installation_id'], $signature, $verifiedAt);
        $update = $db->prepare("UPDATE silo_card_purchases SET status = 'verified', transaction_signature = ?, usdc_received_micro = ?, license_token = ?, verified_at_ms = ? WHERE id = ? AND status = 'pending'");
        $update->execute([$signature, $verification['received'], $licenseToken, $verifiedAt, $id]);
        $db->commit();
        return ['status' => 200, 'body' => [
            'status' => 'verified',
            'signature' => $signature,
            'installationId' => $purchase['installation_id'],
            'licenseToken' => $licenseToken,
            'verifiedAt' => $verifiedAt,
        ]];
    } catch (PDOException $error) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        if (relay_duplicate_signature($error)) {
            return ['status' => 409, 'body' => ['error' => 'This Solana payment has already been claimed.']];
        }
        throw $error;
    } catch (Throwable $error) {
        if ($db->inTransaction()) {
            $db->rollBack();
        }
        throw $error;
    }
}

function relay_reply_purchase(array $purchase, int $status = 200, ?string $message = null): void
{
    $payload = ['status' => $purchase['status']];
    if ($purchase['status'] === 'verified') {
        $payload['signature'] = $purchase['transaction_signature'];
        $payload['verifiedAt'] = (int)$purchase['verified_at_ms'];
        $recovery = relay_license_recovery_payload(
            $purchase,
            (string)relay_read_installation_id(),
            (string)($purchase['transaction_signature'] ?? '')
        );
        if ($recovery !== null) {
            $payload['installationId'] = $recovery['installationId'];
            $payload['licenseToken'] = $recovery['licenseToken'];
        }
    }
    if ($message !== null) {
        $payload['message'] = $message;
    }
    relay_json($status, $payload);
}

function relay_purchase_status(string $id): void
{
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));
    if ($method !== 'GET' && $method !== 'POST') {
        relay_json(405, ['error' => 'Method not allowed.']);
    }
    $db = relay_db();
    relay_ensure_schema($db);
    $select = $db->prepare('SELECT id, claim_token_sha256, installation_id, payment_method, reference, status, transaction_signature, created_at_ms, verified_at_ms, license_token FROM silo_card_purchases WHERE id = ? LIMIT 1');
    $select->execute([$id]);
    $purchase = $select->fetch();
    if (!$purchase || !relay_token_matches(relay_read_claim_token(), $purchase['claim_token_sha256'])) {
        relay_json(404, ['error' => 'Checkout not found.']);
    }
    $requestInstallationId = relay_read_installation_id();
    if ($method === 'GET' && (!relay_valid_installation_id($requestInstallationId) || !hash_equals($purchase['installation_id'], $requestInstallationId))) {
        relay_json(403, ['error' => 'This payment request belongs to a different Silo installation.']);
    }
    if ($method === 'POST' && $requestInstallationId !== null && (!relay_valid_installation_id($requestInstallationId) || !hash_equals($purchase['installation_id'], $requestInstallationId))) {
        relay_json(403, ['error' => 'This payment request belongs to a different Silo installation.']);
    }

    $now = (int)floor(microtime(true) * 1000);
    if ($purchase['status'] === 'pending' && $now - (int)$purchase['created_at_ms'] > 86400000) {
        $expire = $db->prepare("UPDATE silo_card_purchases SET status = 'expired' WHERE id = ? AND status = 'pending'");
        $expire->execute([$id]);
        $purchase['status'] = 'expired';
        relay_reply_purchase($purchase, $method === 'POST' ? 410 : 200, 'This checkout expired. Start a new payment from Silo.');
    }

    if ($purchase['status'] === 'verified') {
        if ((!is_string($purchase['license_token']) || $purchase['license_token'] === '') && relay_valid_signature($purchase['transaction_signature'] ?? null)) {
            $backfill = relay_verified_purchase($db, $id, $purchase['transaction_signature'], ['received' => '0']);
            if ($backfill['status'] !== 200) {
                relay_json($backfill['status'], $backfill['body']);
            }
            $purchase['license_token'] = $backfill['body']['licenseToken'];
            $purchase['installation_id'] = $backfill['body']['installationId'];
            $purchase['verified_at_ms'] = $backfill['body']['verifiedAt'];
        }
        if ($method === 'POST') {
            $body = relay_request_json();
            $signature = $body['signature'] ?? null;
            if (!is_string($signature) || !hash_equals((string)$purchase['transaction_signature'], $signature)) {
                relay_json(409, ['error' => 'This checkout already has a different verified payment.']);
            }
        }
        relay_reply_purchase($purchase);
    }
    if ($purchase['status'] === 'expired') {
        relay_reply_purchase($purchase, $method === 'POST' ? 410 : 200, 'This checkout expired. Start a new payment from Silo.');
    }

    if ($method === 'POST') {
        $body = relay_request_json();
        $signature = $body['signature'] ?? null;
        if (!is_string($signature)) {
            relay_json(400, ['error' => 'Missing transaction signature.']);
        }
        if ($purchase['transaction_signature'] !== null && $purchase['transaction_signature'] !== $signature) {
            relay_json(409, ['error' => 'A different payment is already being checked for this checkout.']);
        }
        $verification = relay_verify_with_helius(
            $signature,
            (int)$purchase['created_at_ms'],
            $purchase['payment_method'],
            $purchase['reference']
        );
        if ($verification['state'] === 'retry') {
            try {
                $save = $db->prepare("UPDATE silo_card_purchases SET transaction_signature = ? WHERE id = ? AND status = 'pending' AND (transaction_signature IS NULL OR transaction_signature = ?)");
                $save->execute([$signature, $id, $signature]);
                $check = $db->prepare('SELECT transaction_signature FROM silo_card_purchases WHERE id = ?');
                $check->execute([$id]);
                if ($check->fetchColumn() !== $signature) {
                    relay_json(409, ['error' => 'A different payment is already being checked for this checkout.']);
                }
            } catch (PDOException $error) {
                if (relay_duplicate_signature($error)) {
                    relay_json(409, ['error' => 'This Solana payment has already been claimed.']);
                }
                throw $error;
            }
            relay_json(202, ['status' => 'pending', 'message' => $verification['reason']]);
        }
        if ($verification['state'] !== 'verified') {
            relay_json(422, ['status' => 'invalid', 'message' => $verification['reason']]);
        }
        $result = relay_verified_purchase($db, $id, $signature, $verification);
        if ($result['status'] === 200 && $requestInstallationId !== null && hash_equals($purchase['installation_id'], $requestInstallationId)) {
            relay_json($result['status'], $result['body']);
        }
        $body = $result['body'];
        unset($body['installationId'], $body['licenseToken']);
        relay_json($result['status'], $body);
    }

    if ($purchase['payment_method'] === 'solana-pay') {
        $verification = relay_find_reference_payment($purchase['reference'], (int)$purchase['created_at_ms']);
        if ($verification['state'] === 'pending' || $verification['state'] === 'retry') {
            relay_json(200, ['status' => 'pending', 'message' => $verification['reason']]);
        }
        if ($verification['state'] !== 'verified') {
            relay_json(200, ['status' => 'invalid', 'message' => $verification['reason']]);
        }
        $signature = $verification['signature'];
    } elseif ($purchase['transaction_signature'] !== null) {
        $signature = $purchase['transaction_signature'];
        $verification = relay_verify_with_helius(
            $signature,
            (int)$purchase['created_at_ms'],
            $purchase['payment_method'],
            $purchase['reference']
        );
        if ($verification['state'] === 'retry') {
            relay_json(200, ['status' => 'pending', 'message' => $verification['reason']]);
        }
        if ($verification['state'] !== 'verified') {
            $clear = $db->prepare("UPDATE silo_card_purchases SET transaction_signature = NULL WHERE id = ? AND status = 'pending' AND transaction_signature = ?");
            $clear->execute([$id, $signature]);
            relay_json(200, ['status' => 'invalid', 'message' => $verification['reason']]);
        }
    } else {
        relay_json(200, ['status' => 'pending', 'message' => 'Waiting for the finalized payment.']);
    }

    $result = relay_verified_purchase($db, $id, $signature, $verification);
    if ($result['status'] !== 200) {
        relay_json($result['status'], $result['body']);
    }
    $purchase['status'] = 'verified';
    $purchase['transaction_signature'] = $signature;
    $purchase['installation_id'] = $result['body']['installationId'];
    $purchase['license_token'] = $result['body']['licenseToken'];
    $purchase['verified_at_ms'] = $result['body']['verifiedAt'];
    relay_reply_purchase($purchase);
}

function relay_claim_legacy_license(): void
{
    if (($_SERVER['REQUEST_METHOD'] ?? '') !== 'POST') {
        relay_json(405, ['error' => 'Method not allowed.']);
    }
    $body = relay_request_json();
    $installationId = $body['installationId'] ?? null;
    $signature = $body['signature'] ?? null;
    $legacyInstallationId = $body['legacyInstallationId'] ?? null;
    if (!relay_valid_installation_id($installationId) || !relay_valid_signature($signature)) {
        relay_json(400, ['error' => 'The existing license receipt is invalid.']);
    }
    if ($legacyInstallationId !== null && !relay_valid_installation_id($legacyInstallationId)) {
        relay_json(400, ['error' => 'The existing installation reference is invalid.']);
    }

    $db = relay_db();
    relay_ensure_schema($db);
    $verification = relay_verify_with_helius($signature, 0, 'manual');
    if ($verification['state'] === 'retry') {
        relay_json(202, ['status' => 'pending', 'message' => $verification['reason']]);
    }
    if ($verification['state'] !== 'verified') {
        relay_json(422, ['status' => 'invalid', 'message' => $verification['reason']]);
    }

    $purchaseLookup = $db->prepare('SELECT installation_id, status, transaction_signature, license_token, verified_at_ms FROM silo_card_purchases WHERE transaction_signature = ? LIMIT 1');
    $purchaseLookup->execute([$signature]);
    $purchase = $purchaseLookup->fetch();
    if ($purchase) {
        if (!hash_equals($purchase['installation_id'], $installationId)) {
            relay_json(409, ['status' => 'claimed-elsewhere', 'error' => 'This payment is already bound to another Silo installation.']);
        }
        if ($purchase['status'] !== 'verified' || !is_string($purchase['license_token']) || $purchase['license_token'] === '') {
            relay_json(409, ['status' => 'claimed-elsewhere', 'error' => 'This payment is already in use.']);
        }
        $recovery = relay_license_recovery_payload($purchase, $installationId, $signature);
        if ($recovery === null) {
            relay_json(409, ['status' => 'claimed-elsewhere', 'error' => 'This payment could not be recovered for this Silo installation.']);
        }
        relay_json(200, $recovery);
    }

    $claimLookup = $db->prepare('SELECT installation_id, license_token, verified_at_ms FROM silo_paid_license_claims WHERE transaction_signature = ? LIMIT 1');
    $claimLookup->execute([$signature]);
    $existing = $claimLookup->fetch();
    if ($existing) {
        if (!hash_equals($existing['installation_id'], $installationId)) {
            relay_json(409, ['status' => 'claimed-elsewhere', 'error' => 'This payment is already bound to another Silo installation.']);
        }
        $recovery = relay_license_recovery_payload($existing, $installationId, $signature);
        if ($recovery === null) {
            relay_json(409, ['status' => 'claimed-elsewhere', 'error' => 'This payment could not be recovered for this Silo installation.']);
        }
        relay_json(200, $recovery);
    }

    $verifiedAt = (int)floor(microtime(true) * 1000);
    $licenseToken = relay_sign_license_token($installationId, $signature, $verifiedAt);
    try {
        $insert = $db->prepare('INSERT INTO silo_paid_license_claims (transaction_signature, installation_id, verified_at_ms, license_token, created_at_ms) VALUES (?, ?, ?, ?, ?)');
        $insert->execute([$signature, $installationId, $verifiedAt, $licenseToken, $verifiedAt]);
    } catch (PDOException $error) {
        if (!relay_duplicate_signature($error)) {
            throw $error;
        }
        $claimLookup->execute([$signature]);
        $existing = $claimLookup->fetch();
        if (!$existing || !hash_equals($existing['installation_id'], $installationId)) {
            relay_json(409, ['status' => 'claimed-elsewhere', 'error' => 'This payment is already bound to another Silo installation.']);
        }
        $licenseToken = $existing['license_token'];
        $verifiedAt = (int)$existing['verified_at_ms'];
    }
    $recovery = relay_license_recovery_payload([
        'installation_id' => $installationId,
        'license_token' => $licenseToken,
        'verified_at_ms' => $verifiedAt,
    ], $installationId, $signature);
    if ($recovery === null) {
        relay_json(500, ['error' => 'The verified payment could not be bound to this Silo installation.']);
    }
    relay_json(200, $recovery);
}

function relay_dispatch(): void
{
    $path = parse_url((string)($_SERVER['REQUEST_URI'] ?? '/'), PHP_URL_PATH);
    $path = is_string($path) ? rtrim($path, '/') : '/';
    if ($path === '') {
        $path = '/';
    }
    $method = strtoupper((string)($_SERVER['REQUEST_METHOD'] ?? 'GET'));

    if ($path === '/api/health') {
        if ($method !== 'GET') {
            relay_json(405, ['error' => 'Method not allowed.']);
        }
        $db = relay_db();
        relay_ensure_schema($db);
        $db->query('SELECT 1')->fetchColumn();
        relay_load_signing_key();
        relay_json(200, ['status' => 'ready']);
    }
    if ($path === '/api/purchase') {
        relay_create_purchase();
    }
    if (preg_match('#^/api/purchase/([0-9a-f-]{36})$#iD', $path, $matches) === 1) {
        relay_purchase_status($matches[1]);
    }
    if ($path === '/api/license/claim-legacy') {
        relay_claim_legacy_license();
    }
    if ($path === '/') {
        if ($method !== 'GET') {
            relay_json(405, ['error' => 'Method not allowed.']);
        }
        header('Content-Type: text/html; charset=utf-8');
        header('Cache-Control: no-store');
        echo '<!doctype html><html lang="en"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>Silo License Relay</title><body style="margin:0;background:#111;color:#f4f1ec;font:16px system-ui;display:grid;min-height:100vh;place-items:center"><main style="max-width:34rem;padding:2rem"><h1>Silo License Relay</h1><p>This service verifies direct Silo wallet payments and MoonPay card checkout.</p><p><a style="color:#ff9b4a" href="/api/health">Check relay readiness</a></p></main></body></html>';
        exit;
    }
    relay_json(404, ['error' => 'Not found.']);
}

try {
    relay_dispatch();
} catch (Throwable $error) {
    error_log('Silo payment relay error: ' . $error->getMessage());
    relay_json(503, ['error' => 'The license relay is temporarily unavailable.']);
}
