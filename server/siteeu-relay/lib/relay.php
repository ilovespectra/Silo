<?php
declare(strict_types=1);

const SILO_PAYLINK_ID = '6ac7d0cf88fd0a0de7c57f80';
const SILO_USDC_RECEIVER = '89Y6dpvpfTCBZjw2Xcb3KVVFTebdbGpzWTNEPMWEuMyu';
const SILO_USDC_MINT = 'EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v';
const SILO_CARD_MIN_USDC_MICRO = 23750000;
const SILO_WALLET_MIN_USDC_MICRO = 25000000;
const SILO_HELIUS_DEFAULT = 'https://optimistic-daisy-fast-mainnet.helius-rpc.com';
const SILO_LICENSE_PUBLIC_KEY = <<<'PEM'
-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAkEex9uW5zr8rXs+8SAb/
8PBUq0GX2EAb/vIXnUuzVHweHNFHyZJn0+HD9LLDJxTRv9Qnme4NQIKS5RXzDFgY
gEomSJcQEhZaFdfSKkm5Q1Tqu78fZWTMrxBa/zUyDrPg5FScXVLnIRJKWJq5Lbez
8/QxVlutYvmuk0IGVbAD4hmXGCjPk3P//93PHl8Mae5Oi64/j8L0yJ/KWuvceRxU
Cu1bmmLGkwDtE+HrZDS0s9hpG1WMJf54BI23fKOAePNI09fSrIv2h9reX7xQ/MmH
o93krxW2Y/4p1v2Ni1DqK2vPt+OzYVzhUMXG/qIT7A7UHAEIVngx3bc3TIE1iJdr
SQIDAQAB
-----END PUBLIC KEY-----
PEM;

function relay_config(): array
{
    static $config = null;
    if (is_array($config)) {
        return $config;
    }

    $privateDirectory = dirname(__DIR__, 2) . '/private';
    $path = $privateDirectory . '/silo-relay-config.php';
    if (!is_file($path)) {
        throw new RuntimeException('Private relay configuration is missing.');
    }
    $loaded = require $path;
    if (!is_array($loaded)) {
        throw new RuntimeException('Private relay configuration is invalid.');
    }

    $config = array_merge([
        'mysql_host' => '127.0.0.1',
        'mysql_port' => 3306,
        'mysql_database' => '',
        'mysql_user' => '',
        'mysql_password' => '',
        'public_base_url' => 'https://license.kolektivkrog.si',
        'helius_rpc_url' => SILO_HELIUS_DEFAULT,
        'paid_license_private_key_path' => $privateDirectory . '/silo-license-signing-private.pem',
    ], $loaded);

    foreach (['mysql_host', 'mysql_database', 'mysql_user', 'mysql_password', 'public_base_url', 'paid_license_private_key_path'] as $key) {
        if (!is_string($config[$key]) || trim($config[$key]) === '') {
            throw new RuntimeException('A required private relay setting is empty.');
        }
    }
    if (str_contains($config['mysql_password'], 'REPLACE_WITH_')) {
        throw new RuntimeException('The private relay database password has not been set.');
    }
    if (!filter_var($config['mysql_port'], FILTER_VALIDATE_INT) || (int)$config['mysql_port'] < 1 || (int)$config['mysql_port'] > 65535) {
        throw new RuntimeException('The private relay database port is invalid.');
    }
    $base = parse_url($config['public_base_url']);
    if (!is_array($base) || ($base['scheme'] ?? '') !== 'https' || empty($base['host']) || isset($base['user']) || isset($base['pass'])) {
        throw new RuntimeException('The public relay URL must be a valid HTTPS origin.');
    }
    if (!is_string($config['helius_rpc_url']) || !str_starts_with($config['helius_rpc_url'], 'https://')) {
        throw new RuntimeException('The Helius RPC URL must use HTTPS.');
    }
    $config['mysql_port'] = (int)$config['mysql_port'];
    $config['public_base_url'] = rtrim($config['public_base_url'], '/');
    return $config;
}

function relay_db(): PDO
{
    static $pdo = null;
    if ($pdo instanceof PDO) {
        return $pdo;
    }
    if (!extension_loaded('pdo_mysql')) {
        throw new RuntimeException('The PHP pdo_mysql extension is required.');
    }
    $c = relay_config();
    $dsn = 'mysql:host=' . $c['mysql_host'] . ';port=' . $c['mysql_port'] . ';dbname=' . $c['mysql_database'] . ';charset=utf8mb4';
    $pdo = new PDO($dsn, $c['mysql_user'], $c['mysql_password'], [
        PDO::ATTR_ERRMODE => PDO::ERRMODE_EXCEPTION,
        PDO::ATTR_DEFAULT_FETCH_MODE => PDO::FETCH_ASSOC,
        PDO::ATTR_EMULATE_PREPARES => false,
        PDO::ATTR_TIMEOUT => 10,
    ]);
    return $pdo;
}

function relay_ensure_schema(PDO $db): void
{
    static $ready = false;
    if ($ready) {
        return;
    }
    $db->exec("CREATE TABLE IF NOT EXISTS silo_card_purchases (
        id CHAR(36) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        claim_token_sha256 CHAR(64) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        installation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        payment_method ENUM('card','solana-pay','manual') NOT NULL DEFAULT 'card',
        reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL,
        paylink_id VARCHAR(64) CHARACTER SET ascii NOT NULL,
        status ENUM('pending','verified','expired') NOT NULL DEFAULT 'pending',
        transaction_signature VARCHAR(90) CHARACTER SET ascii COLLATE ascii_bin NULL,
        usdc_received_micro BIGINT UNSIGNED NULL,
        license_token MEDIUMTEXT NULL,
        created_at_ms BIGINT UNSIGNED NOT NULL,
        verified_at_ms BIGINT UNSIGNED NULL,
        UNIQUE KEY silo_card_signature_unique (transaction_signature),
        UNIQUE KEY silo_payment_reference_unique (reference),
        KEY silo_card_installation_lookup (installation_id, created_at_ms)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");

    $columns = $db->query('SHOW COLUMNS FROM silo_card_purchases')->fetchAll(PDO::FETCH_COLUMN, 0);
    if (!in_array('payment_method', $columns, true)) {
        $db->exec("ALTER TABLE silo_card_purchases ADD COLUMN payment_method ENUM('card','solana-pay','manual') NOT NULL DEFAULT 'card' AFTER installation_id");
    }
    if (!in_array('reference', $columns, true)) {
        $db->exec('ALTER TABLE silo_card_purchases ADD COLUMN reference VARCHAR(64) CHARACTER SET ascii COLLATE ascii_bin NULL AFTER payment_method');
    }
    if (!in_array('license_token', $columns, true)) {
        $db->exec('ALTER TABLE silo_card_purchases ADD COLUMN license_token MEDIUMTEXT NULL AFTER usdc_received_micro');
    }
    $indexes = $db->query('SHOW INDEX FROM silo_card_purchases')->fetchAll(PDO::FETCH_COLUMN, 2);
    if (!in_array('silo_payment_reference_unique', $indexes, true)) {
        $db->exec('ALTER TABLE silo_card_purchases ADD UNIQUE KEY silo_payment_reference_unique (reference)');
    }
    $db->exec("CREATE TABLE IF NOT EXISTS silo_paid_license_claims (
        transaction_signature VARCHAR(90) CHARACTER SET ascii COLLATE ascii_bin NOT NULL PRIMARY KEY,
        installation_id CHAR(32) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
        verified_at_ms BIGINT UNSIGNED NOT NULL,
        license_token MEDIUMTEXT NOT NULL,
        created_at_ms BIGINT UNSIGNED NOT NULL,
        KEY silo_paid_claim_installation_lookup (installation_id, created_at_ms)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4");
    $ready = true;
}

function relay_json(int $status, array $payload): void
{
    http_response_code($status);
    header('Content-Type: application/json; charset=utf-8');
    header('Cache-Control: no-store, max-age=0');
    header('X-Content-Type-Options: nosniff');
    echo json_encode($payload, JSON_UNESCAPED_SLASHES | JSON_INVALID_UTF8_SUBSTITUTE);
    exit;
}

function relay_request_json(): array
{
    $length = isset($_SERVER['CONTENT_LENGTH']) ? (int)$_SERVER['CONTENT_LENGTH'] : 0;
    if ($length > 65536) {
        relay_json(413, ['error' => 'Request body is too large.']);
    }
    $raw = file_get_contents('php://input');
    if (!is_string($raw) || $raw === '') {
        return [];
    }
    $decoded = json_decode($raw, true);
    if (!is_array($decoded) || json_last_error() !== JSON_ERROR_NONE) {
        relay_json(400, ['error' => 'Request body must be valid JSON.']);
    }
    return $decoded;
}

function relay_uuid_v4(): string
{
    $bytes = random_bytes(16);
    $bytes[6] = chr((ord($bytes[6]) & 0x0f) | 0x40);
    $bytes[8] = chr((ord($bytes[8]) & 0x3f) | 0x80);
    $hex = bin2hex($bytes);
    return substr($hex, 0, 8) . '-' . substr($hex, 8, 4) . '-' . substr($hex, 12, 4) . '-' . substr($hex, 16, 4) . '-' . substr($hex, 20);
}

function relay_claim_token(): string
{
    return rtrim(strtr(base64_encode(random_bytes(32)), '+/', '-_'), '=');
}

function relay_token_hash(string $token): string
{
    return hash('sha256', $token);
}

function relay_token_matches($token, $expectedHash): bool
{
    if (!is_string($token) || strlen($token) < 40 || strlen($token) > 100 || !is_string($expectedHash)) {
        return false;
    }
    return hash_equals($expectedHash, relay_token_hash($token));
}

function relay_read_header(string $headerName): ?string
{
    $serverKey = 'HTTP_' . strtoupper(str_replace('-', '_', $headerName));
    if (isset($_SERVER[$serverKey]) && is_string($_SERVER[$serverKey])) {
        return $_SERVER[$serverKey];
    }
    if (function_exists('getallheaders')) {
        foreach (getallheaders() ?: [] as $name => $value) {
            if (strcasecmp((string)$name, $headerName) === 0 && is_string($value)) {
                return $value;
            }
        }
    }
    return null;
}

function relay_read_claim_token(): ?string
{
    return relay_read_header('x-silo-claim-token');
}

function relay_read_installation_id(): ?string
{
    return relay_read_header('x-silo-installation-id');
}

function relay_valid_installation_id($value): bool
{
    return is_string($value) && preg_match('/^[a-f0-9]{32}$/D', $value) === 1;
}

function relay_valid_signature($value): bool
{
    return is_string($value) && strlen($value) >= 80 && strlen($value) <= 90 && preg_match('/^[1-9A-HJ-NP-Za-km-z]+$/D', $value) === 1;
}

function relay_valid_reference($value): bool
{
    return is_string($value) && strlen($value) >= 32 && strlen($value) <= 44 && preg_match('/^[1-9A-HJ-NP-Za-km-z]+$/D', $value) === 1;
}

function relay_license_recovery_payload(
    array $record,
    string $requestInstallationId,
    string $signature
): ?array {
    $ownerInstallationId = $record['installation_id'] ?? null;
    $licenseToken = $record['license_token'] ?? null;
    $verifiedAt = isset($record['verified_at_ms']) ? (int)$record['verified_at_ms'] : 0;
    if (
        !relay_valid_installation_id($requestInstallationId) ||
        !relay_valid_installation_id($ownerInstallationId) ||
        !hash_equals($ownerInstallationId, $requestInstallationId) ||
        !relay_valid_signature($signature) ||
        !is_string($licenseToken) ||
        $licenseToken === '' ||
        $verifiedAt <= 0
    ) {
        return null;
    }
    return [
        'status' => 'verified',
        'signature' => $signature,
        'installationId' => $ownerInstallationId,
        'licenseToken' => $licenseToken,
        'verifiedAt' => $verifiedAt,
    ];
}

function relay_amount($value): ?int
{
    if (!is_string($value) || $value === '' || !ctype_digit($value) || strlen($value) > 18) {
        return null;
    }
    $number = (int)$value;
    return $number >= 0 ? $number : null;
}

function relay_recipient_delta(array $transaction): int
{
    $meta = $transaction['meta'] ?? null;
    if (!is_array($meta) || !array_key_exists('err', $meta) || $meta['err'] !== null) {
        return 0;
    }
    $before = [];
    foreach (($meta['preTokenBalances'] ?? []) as $balance) {
        if (!is_array($balance) || ($balance['mint'] ?? null) !== SILO_USDC_MINT || ($balance['owner'] ?? null) !== SILO_USDC_RECEIVER || ($balance['uiTokenAmount']['decimals'] ?? null) !== 6) {
            continue;
        }
        $amount = relay_amount($balance['uiTokenAmount']['amount'] ?? null);
        if ($amount !== null) {
            $index = (int)($balance['accountIndex'] ?? -1);
            $before[$index] = ($before[$index] ?? 0) + $amount;
        }
    }
    $delta = 0;
    foreach (($meta['postTokenBalances'] ?? []) as $balance) {
        if (!is_array($balance) || ($balance['mint'] ?? null) !== SILO_USDC_MINT || ($balance['owner'] ?? null) !== SILO_USDC_RECEIVER || ($balance['uiTokenAmount']['decimals'] ?? null) !== 6) {
            continue;
        }
        $amount = relay_amount($balance['uiTokenAmount']['amount'] ?? null);
        if ($amount !== null) {
            $index = (int)($balance['accountIndex'] ?? -1);
            $delta += $amount - ($before[$index] ?? 0);
        }
    }
    return $delta;
}

function relay_transaction_has_reference(array $transaction, string $reference): bool
{
    $message = $transaction['transaction']['message'] ?? null;
    $keys = is_array($message) && is_array($message['accountKeys'] ?? null) ? $message['accountKeys'] : [];
    foreach ($keys as $key) {
        $pubkey = is_array($key) ? ($key['pubkey'] ?? null) : $key;
        if (is_string($pubkey) && hash_equals($reference, $pubkey)) {
            return true;
        }
    }
    $loaded = $transaction['meta']['loadedAddresses'] ?? null;
    if (is_array($loaded)) {
        foreach (['writable', 'readonly'] as $kind) {
            foreach (($loaded[$kind] ?? []) as $address) {
                if (is_string($address) && hash_equals($reference, $address)) {
                    return true;
                }
            }
        }
    }
    return false;
}

function relay_evaluate_payment_transaction(
    string $signature,
    array $transaction,
    int $createdAtMs,
    string $paymentMethod,
    ?string $reference = null
): array {
    if (!relay_valid_signature($signature)) {
        return ['state' => 'invalid', 'reason' => 'The checkout did not return a valid Solana transaction signature.'];
    }
    if (!in_array($paymentMethod, ['card', 'solana-pay', 'manual'], true)) {
        return ['state' => 'invalid', 'reason' => 'The payment method is invalid.'];
    }
    if ($paymentMethod === 'solana-pay' && (!relay_valid_reference($reference) || !relay_transaction_has_reference($transaction, $reference))) {
        return ['state' => 'invalid', 'reason' => 'This Solana transaction does not match the computer-bound payment request.'];
    }
    $transactionSignatures = $transaction['transaction']['signatures'] ?? null;
    if (!is_array($transactionSignatures) || !in_array($signature, $transactionSignatures, true)) {
        return ['state' => 'invalid', 'reason' => 'The Solana transaction signature could not be matched.'];
    }
    if (!isset($transaction['meta']) || !is_array($transaction['meta']) || !array_key_exists('err', $transaction['meta']) || $transaction['meta']['err'] !== null) {
        return ['state' => 'invalid', 'reason' => 'The Solana transaction did not complete successfully.'];
    }
    if (!isset($transaction['blockTime']) || !is_int($transaction['blockTime'])) {
        return ['state' => 'retry', 'reason' => 'Waiting for Solana to finalize the payment.'];
    }
    if ($createdAtMs > 0 && $transaction['blockTime'] * 1000 < $createdAtMs - 5000) {
        return ['state' => 'invalid', 'reason' => 'That payment predates this checkout attempt. Start a fresh checkout.'];
    }
    $received = relay_recipient_delta($transaction);
    $minimum = $paymentMethod === 'card' ? SILO_CARD_MIN_USDC_MICRO : SILO_WALLET_MIN_USDC_MICRO;
    if ($received < $minimum) {
        $reason = $paymentMethod === 'card'
            ? 'The MoonPay card settlement did not send at least 23.75 USDC to Silo.'
            : 'The wallet payment did not send the full 25 USDC to Silo.';
        return ['state' => 'invalid', 'reason' => $reason];
    }
    return ['state' => 'verified', 'received' => (string)$received, 'blockTime' => $transaction['blockTime']];
}

function relay_rpc(string $method, array $params): array
{
    if (!extension_loaded('curl')) {
        throw new RuntimeException('Solana verification is temporarily unavailable.');
    }
    $body = json_encode([
        'jsonrpc' => '2.0',
        'id' => 'silo-lifetime-license',
        'method' => $method,
        'params' => $params,
    ], JSON_UNESCAPED_SLASHES);
    $c = relay_config();
    $curl = curl_init($c['helius_rpc_url']);
    curl_setopt_array($curl, [
        CURLOPT_POST => true,
        CURLOPT_POSTFIELDS => $body,
        CURLOPT_HTTPHEADER => ['Content-Type: application/json'],
        CURLOPT_RETURNTRANSFER => true,
        CURLOPT_CONNECTTIMEOUT => 5,
        CURLOPT_TIMEOUT => 15,
    ]);
    $responseBody = curl_exec($curl);
    $httpStatus = (int)curl_getinfo($curl, CURLINFO_RESPONSE_CODE);
    $curlError = curl_errno($curl);
    curl_close($curl);
    if ($responseBody === false || $curlError !== 0 || $httpStatus < 200 || $httpStatus >= 300) {
        throw new RuntimeException('Helius could not verify the payment yet.');
    }
    $rpc = json_decode($responseBody, true);
    if (!is_array($rpc) || isset($rpc['error'])) {
        throw new RuntimeException('Helius could not verify the payment yet.');
    }
    return $rpc;
}

function relay_verify_with_helius(
    string $signature,
    int $createdAtMs,
    string $paymentMethod,
    ?string $reference = null
): array {
    if (!relay_valid_signature($signature)) {
        return ['state' => 'invalid', 'reason' => 'The checkout did not return a valid Solana transaction signature.'];
    }
    try {
        $rpc = relay_rpc('getTransaction', [$signature, [
            'commitment' => 'finalized',
            'encoding' => 'jsonParsed',
            'maxSupportedTransactionVersion' => 1,
        ]]);
    } catch (Throwable $error) {
        return ['state' => 'retry', 'reason' => 'Helius could not verify the payment yet. Keep Silo open; it will check again.'];
    }
    $transaction = $rpc['result'] ?? null;
    if (!is_array($transaction)) {
        return ['state' => 'retry', 'reason' => 'Waiting for Solana to finalize the payment.'];
    }
    return relay_evaluate_payment_transaction($signature, $transaction, $createdAtMs, $paymentMethod, $reference);
}

function relay_find_reference_payment(string $reference, int $createdAtMs): array
{
    if (!relay_valid_reference($reference)) {
        return ['state' => 'invalid', 'reason' => 'The Solana Pay reference is invalid.'];
    }
    try {
        $rpc = relay_rpc('getSignaturesForAddress', [$reference, [
            'commitment' => 'finalized',
            'limit' => 20,
        ]]);
    } catch (Throwable $error) {
        return ['state' => 'retry', 'reason' => 'Solana payment lookup is temporarily unavailable. Silo will check again.'];
    }
    $signatures = $rpc['result'] ?? null;
    if (!is_array($signatures)) {
        return ['state' => 'pending', 'reason' => 'Waiting for the direct wallet payment to reach Solana.'];
    }
    $sawRecentSignature = false;
    foreach ($signatures as $entry) {
        if (!is_array($entry) || !relay_valid_signature($entry['signature'] ?? null)) {
            continue;
        }
        if (($entry['err'] ?? null) !== null) {
            continue;
        }
        if (isset($entry['blockTime']) && is_int($entry['blockTime']) && $entry['blockTime'] * 1000 < $createdAtMs - 5000) {
            break;
        }
        $sawRecentSignature = true;
        $verification = relay_verify_with_helius($entry['signature'], $createdAtMs, 'solana-pay', $reference);
        if ($verification['state'] === 'verified') {
            $verification['signature'] = $entry['signature'];
            return $verification;
        }
        if ($verification['state'] === 'retry') {
            return $verification;
        }
    }
    if ($sawRecentSignature) {
        return ['state' => 'invalid', 'reason' => 'The matching wallet transaction did not send the required USDC amount directly to Silo.'];
    }
    return ['state' => 'pending', 'reason' => 'Waiting for the direct wallet payment to reach Silo.'];
}

function relay_load_signing_key(?string $pemOverride = null, ?string $pathOverride = null, ?string $publicKeyPemOverride = null): OpenSSLAsymmetricKey
{
    if ($pemOverride !== null) {
        $pem = $pemOverride;
    } else {
        $config = relay_config();
        $path = $pathOverride ?? $config['paid_license_private_key_path'];
        $privateDirectory = realpath(dirname(__DIR__, 2) . '/private');
        $resolvedKeyPath = realpath($path);
        $publicRoot = realpath(dirname(__DIR__));
        if ($privateDirectory === false || $resolvedKeyPath === false || $publicRoot === false || !is_readable($resolvedKeyPath)) {
            throw new RuntimeException('The private Silo license signing key is missing or unreadable.');
        }
        if (str_starts_with($resolvedKeyPath, $publicRoot . DIRECTORY_SEPARATOR)) {
            throw new RuntimeException('The Silo license signing key must stay outside the public web root.');
        }
        $pem = file_get_contents($resolvedKeyPath);
        if (!is_string($pem)) {
            throw new RuntimeException('The private Silo license signing key could not be read.');
        }
    }
    $key = openssl_pkey_get_private($pem);
    if (!$key instanceof OpenSSLAsymmetricKey) {
        throw new RuntimeException('The private Silo license signing key is invalid.');
    }
    $privateDetails = openssl_pkey_get_details($key);
    $publicKey = openssl_pkey_get_public($publicKeyPemOverride ?? SILO_LICENSE_PUBLIC_KEY);
    $publicDetails = $publicKey ? openssl_pkey_get_details($publicKey) : false;
    if (
        !is_array($privateDetails) ||
        ($privateDetails['type'] ?? null) !== OPENSSL_KEYTYPE_RSA ||
        !is_array($publicDetails) ||
        !isset($privateDetails['rsa']['n'], $privateDetails['rsa']['e'], $publicDetails['rsa']['n'], $publicDetails['rsa']['e']) ||
        !hash_equals($publicDetails['rsa']['n'], $privateDetails['rsa']['n']) ||
        !hash_equals($publicDetails['rsa']['e'], $privateDetails['rsa']['e'])
    ) {
        throw new RuntimeException('The private Silo license signing key does not match this Silo build.');
    }
    return $key;
}

function relay_base64url(string $value): string
{
    return rtrim(strtr(base64_encode($value), '+/', '-_'), '=');
}

function relay_sign_license_token(
    string $installationId,
    string $paymentSignature,
    int $verifiedAtMs,
    ?string $privateKeyPemOverride = null,
    ?string $publicKeyPemOverride = null
): string {
    if (!relay_valid_installation_id($installationId) || !relay_valid_signature($paymentSignature) || $verifiedAtMs <= 0) {
        throw new RuntimeException('The verified payment cannot be bound to this Silo installation.');
    }
    $payload = json_encode([
        'version' => 1,
        'product' => 'silo',
        'grant' => 'lifetime-purchase',
        'deviceId' => $installationId,
        'paymentSignature' => $paymentSignature,
        'verifiedAt' => $verifiedAtMs,
    ], JSON_UNESCAPED_SLASHES | JSON_THROW_ON_ERROR);
    $encodedPayload = relay_base64url($payload);
    $key = relay_load_signing_key($privateKeyPemOverride, null, $publicKeyPemOverride);
    if (!openssl_sign($encodedPayload, $signature, $key, OPENSSL_ALGO_SHA256)) {
        throw new RuntimeException('The Silo license signing operation failed.');
    }
    return $encodedPayload . '.' . relay_base64url($signature);
}

function relay_duplicate_signature(PDOException $error): bool
{
    return isset($error->errorInfo[1]) && (int)$error->errorInfo[1] === 1062;
}
