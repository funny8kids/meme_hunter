export type SignAlgorithm = "Ed25519" | "RSA-SHA256";
/**
 * Detect signing algorithm from PEM private key
 */
export declare function detectAlgorithm(pem: string): SignAlgorithm;
/**
 * Build auth query params (timestamp + client_id)
 * timestamp: Unix seconds, server validates within ±5s
 * client_id: UUID, replays rejected within 7s
 */
export declare function buildAuthQuery(): {
    timestamp: number;
    client_id: string;
};
/**
 * Build the signature message (signed auth)
 * Format: {sub_path}:{sorted_query_string}:{request_body}:{timestamp}
 * sorted_query_string: all query params (including timestamp, client_id) sorted alphabetically by key.
 * Array values are serialized as repeated k=v pairs (same as buildUrl / URLSearchParams), sorted by value.
 */
export declare function buildMessage(subPath: string, queryParams: Record<string, string | number | string[]>, body: string, timestamp: number): string;
/**
 * Load private key file (PEM format)
 */
export declare function loadPrivateKey(keyPath: string): string;
/**
 * Sign a message and return the base64-encoded signature
 *
 * Ed25519: signs raw message bytes (no hashing)
 * RSA-SHA256: RSA-PSS + SHA256, salt length = 32 (matches server-side rsa.VerifyPSS nil opts)
 */
export declare function sign(message: string, privateKeyPem: string, algorithm: SignAlgorithm): string;
//# sourceMappingURL=signer.d.ts.map