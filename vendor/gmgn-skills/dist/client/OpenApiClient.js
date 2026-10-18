/**
 * OpenApiClient — GMGN OpenAPI external client
 *
 * Auth modes:
 *   Exist (market/token/portfolio): X-APIKEY + timestamp + client_id
 *   Signed (swap and order routes): X-APIKEY + timestamp + client_id + X-Signature (private key signature)
 */
import { createRequire } from "node:module";
import { buildAuthQuery, buildMessage, detectAlgorithm, sign } from "./signer.js";
const RATE_LIMIT_RETRY_BUFFER_MS = 1000;
const DEFAULT_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS = 5000;
const { version: CLI_VERSION } = createRequire(import.meta.url)("../../package.json");
const USER_AGENT = `gmgn-cli/${CLI_VERSION}`;
class OpenApiError extends Error {
    method;
    path;
    status;
    apiCode;
    apiError;
    apiMessage;
    resetAtUnix;
    upgradeUrl;
    upgradeMessage;
    constructor(params) {
        super(buildOpenApiErrorMessage(params));
        this.name = "OpenApiError";
        this.method = params.method;
        this.path = params.path;
        this.status = params.status;
        this.apiCode = params.apiCode;
        this.apiError = params.apiError;
        this.apiMessage = params.apiMessage;
        this.resetAtUnix = params.resetAtUnix;
        this.upgradeUrl = params.upgradeUrl;
        this.upgradeMessage = params.upgradeMessage;
    }
}
export class OpenApiClient {
    apiKey;
    privateKeyPem;
    host;
    constructor(config) {
        this.apiKey = config.apiKey;
        this.privateKeyPem = config.privateKeyPem;
        this.host = config.host.replace(/\/$/, "");
    }
    // ---- Token endpoints (exist auth) ----
    async getTokenInfo(chain, address) {
        return this.authExistRequest("GET", "/v1/token/info", { chain, address });
    }
    async getTokenSecurity(chain, address) {
        return this.authExistRequest("GET", "/v1/token/security", { chain, address });
    }
    async getTokenPoolInfo(chain, address) {
        return this.authExistRequest("GET", "/v1/token/pool_info", { chain, address });
    }
    async getTokenTopHolders(chain, address, extra = {}) {
        return this.authExistRequest("GET", "/v1/market/token_top_holders", { chain, address, ...extra });
    }
    async getTokenTopTraders(chain, address, extra = {}) {
        return this.authExistRequest("GET", "/v1/market/token_top_traders", { chain, address, ...extra });
    }
    // ---- Market endpoints (exist auth) ----
    async getTokenKline(chain, address, resolution, from, to) {
        const query = { chain, address, resolution };
        if (from != null)
            query["from"] = from;
        if (to != null)
            query["to"] = to;
        return this.authExistRequest("GET", "/v1/market/token_kline", query);
    }
    // ---- Portfolio endpoints ----
    async getWalletHoldings(chain, walletAddress, extra = {}) {
        return this.authSignedRequest("GET", "/v1/user/wallet_holdings", {
            chain,
            wallet_address: walletAddress,
            ...extra,
        }, null);
    }
    async getWalletActivity(chain, walletAddress, extra = {}) {
        return this.authExistRequest("GET", "/v1/user/wallet_activity", {
            chain,
            wallet_address: walletAddress,
            ...extra,
        });
    }
    async getWalletStats(chain, walletAddresses, period = "7d") {
        return this.authExistRequest("GET", "/v1/user/wallet_stats", {
            chain,
            wallet_address: walletAddresses,
            period,
        });
    }
    async getWalletProfits(chain, walletAddresses, period = "7d") {
        return this.authExistRequest("POST", "/v1/user/wallet_profits", {}, {
            chain,
            period,
            wallet_addresses: walletAddresses,
        });
    }
    async getWalletTokenBalance(chain, walletAddress, tokenAddress) {
        return this.authExistRequest("GET", "/v1/user/wallet_token_balance", { chain, wallet_address: walletAddress, token_address: tokenAddress });
    }
    async getTrenches(chain, types, platforms, limit, filters) {
        const body = buildTrenchesBody(chain, types, platforms, limit, filters);
        return this.authExistRequest("POST", "/v1/trenches", { chain }, body);
    }
    // ---- Market trending endpoints (exist auth) ----
    async getTrendingSwaps(chain, interval, extra = {}) {
        return this.authExistRequest("GET", "/v1/market/rank", { chain, interval, ...extra });
    }
    async getTokenSignalV2(chain, groups) {
        return this.authExistRequest("POST", "/v1/market/token_signal", {}, { chain, groups });
    }
    async getHotSearches(params) {
        return this.authExistRequest("POST", "/v1/market/hot_searches", {}, { params });
    }
    async searchMarket(query, extra = {}) {
        return this.authExistRequest("GET", "/v1/market/search", { q: query, ...extra });
    }
    // ---- User endpoints (exist auth) ----
    async getUserInfo() {
        return this.authExistRequest("GET", "/v1/user/info", {});
    }
    async getFollowWallet(chain, extra = {}) {
        return this.authSignedRequest("GET", "/v1/trade/follow_wallet", { chain, ...extra }, null);
    }
    async getFollowTokens(chain, walletAddress, extra = {}) {
        return this.authExistRequest("GET", "/v1/user/follow_tokens", { chain, wallet_address: walletAddress, ...extra });
    }
    async getFollowGroupNames(chain, walletAddress) {
        return this.authExistRequest("GET", "/v1/user/follow_token_groups", { chain, wallet_address: walletAddress });
    }
    async getKol(chain, limit) {
        const query = {};
        if (chain)
            query["chain"] = chain;
        if (limit != null)
            query["limit"] = limit;
        return this.authExistRequest("GET", "/v1/user/kol", query);
    }
    async getSmartMoney(chain, limit) {
        const query = {};
        if (chain)
            query["chain"] = chain;
        if (limit != null)
            query["limit"] = limit;
        return this.authExistRequest("GET", "/v1/user/smartmoney", query);
    }
    async getCreatedTokens(chain, walletAddress, extra = {}) {
        return this.authExistRequest("GET", "/v1/user/created_tokens", { chain, wallet_address: walletAddress, ...extra });
    }
    // ---- Callout endpoints (exist auth, read-only) ----
    async getCalloutRecord(chain, callWallet, extra = {}) {
        return this.authExistRequest("POST", "/v1/callout/get_record", {}, { chain, call_wallet: callWallet, ...extra });
    }
    async getCalloutGlobal(chains, extra = {}) {
        return this.authExistRequest("POST", "/v1/callout/global", {}, { chains, ...extra });
    }
    async quoteOrder(chain, from_address, input_token, output_token, input_amount, slippage) {
        const query = { chain, from_address, input_token, output_token, input_amount, slippage };
        return this.authExistRequest("GET", "/v1/trade/quote", query);
    }
    // ---- Swap endpoints (signed auth) ----
    async swap(params) {
        return this.authSignedRequest("POST", "/v1/trade/swap", {}, params);
    }
    async multiSwap(params) {
        return this.authSignedRequest("POST", "/v1/trade/multi_swap", {}, params);
    }
    async queryOrder(orderId, chain) {
        return this.authSignedRequest("GET", "/v1/trade/query_order", { order_id: orderId, chain }, null);
    }
    async getGasPrice(chain) {
        return this.authExistRequest("GET", "/v1/trade/gas_price", { chain });
    }
    // ---- Strategy order endpoints (signed auth) ----
    async createStrategyOrder(params) {
        return this.authSignedRequest("POST", "/v1/trade/strategy/create", {}, params);
    }
    async getStrategyOrders(chain, extra = {}) {
        return this.authSignedRequest("GET", "/v1/trade/strategy/orders", { chain, ...extra }, null);
    }
    async cancelStrategyOrder(params) {
        return this.authSignedRequest("POST", "/v1/trade/strategy/cancel", {}, params);
    }
    // ---- Cooking endpoints ----
    async getCookingStatistics() {
        return this.authExistRequest("GET", "/v1/cooking/statistics", {});
    }
    async createToken(params) {
        return this.authSignedRequest("POST", "/v1/cooking/create_token", {}, params);
    }
    // ---- Internal methods ----
    async authExistRequest(method, subPath, queryExtra, body = null) {
        return this.executePreparedRequest(() => {
            const { timestamp, client_id } = buildAuthQuery();
            const query = { ...queryExtra, timestamp, client_id };
            const url = buildUrl(`${this.host}${subPath}`, query);
            const headers = {
                "X-APIKEY": this.apiKey,
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            };
            const bodyStr = body !== null ? JSON.stringify(body) : null;
            return {
                method,
                subPath,
                url,
                headers,
                body: bodyStr,
                curlStr: formatCurl(method, url, headers, bodyStr),
            };
        }, true);
    }
    async authSignedRequest(method, subPath, queryExtra, body) {
        if (!this.privateKeyPem) {
            throw new Error("GMGN_PRIVATE_KEY is required for critical-auth commands (swap, order, follow-wallet, and portfolio holdings commands)");
        }
        return this.executePreparedRequest(() => {
            const { timestamp, client_id } = buildAuthQuery();
            const query = { ...queryExtra, timestamp, client_id };
            const bodyStr = body !== null ? JSON.stringify(body) : "";
            const message = buildMessage(subPath, query, bodyStr, timestamp);
            const signature = sign(message, this.privateKeyPem, detectAlgorithm(this.privateKeyPem));
            const url = buildUrl(`${this.host}${subPath}`, query);
            const headers = {
                "X-APIKEY": this.apiKey,
                "X-Signature": signature,
                "Content-Type": "application/json",
                "User-Agent": USER_AGENT,
            };
            return {
                method,
                subPath,
                url,
                headers,
                body: bodyStr || null,
                curlStr: formatCurl(method, url, headers, bodyStr || null),
            };
        }, method !== "POST");
    }
    async executePreparedRequest(prepare, autoRetryOnRateLimit) {
        const maxAttempts = autoRetryOnRateLimit ? 2 : 1;
        for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
            const request = prepare();
            const res = await this.doFetch(request.method, request.subPath, request.url, request.headers, request.body, request.curlStr);
            try {
                return this.parseResponse(request.method, request.subPath, res, request.curlStr);
            }
            catch (err) {
                const retryDelayMs = getRateLimitRetryDelayMs(err, attempt, maxAttempts, autoRetryOnRateLimit);
                if (retryDelayMs == null) {
                    throw err;
                }
                if (process.env.GMGN_DEBUG) {
                    console.error(`[gmgn-cli] ${request.method} ${request.subPath} hit rate limit, retrying once in ${Math.ceil(retryDelayMs / 1000)}s`);
                }
                await sleep(retryDelayMs);
            }
        }
        throw new Error("Unexpected retry loop exit");
    }
    async doFetch(method, subPath, url, headers, body, curlStr) {
        try {
            return await fetch(url, { method, headers, body: body ?? undefined });
        }
        catch (err) {
            const cause = extractRootCause(err);
            const errorCode = cause.code;
            // Detect IPv4 unavailability errors
            if (errorCode === "EADDRNOTAVAIL" || errorCode === "ENETUNREACH") {
                throw new Error(`Network unreachable (${errorCode}): Your system may not support IPv4. ` +
                    `Please check your network configuration or contact support.`);
            }
            if (process.env.GMGN_DEBUG)
                console.error(`${curlStr}\n[error] fetch failed: ${cause}`);
            throw new Error(`${method} ${subPath} fetch failed: ${cause}`);
        }
    }
    async parseResponse(method, path, res, curlStr) {
        const fail = (msg, body = null) => {
            if (process.env.GMGN_DEBUG) {
                console.error(`${curlStr}\n${formatResponse(res, body)}`);
            }
            throw new Error(msg);
        };
        const resetAtUnix = parseRateLimitReset(res.headers.get("x-ratelimit-reset"));
        let text;
        try {
            text = await res.text();
        }
        catch (err) {
            fail(`${method} ${path} failed: HTTP ${res.status} (failed to read response body: ${err})`);
        }
        let json;
        try {
            json = JSON.parse(text);
        }
        catch {
            fail(`${method} ${path} failed: HTTP ${res.status} (non-JSON response)`, text);
        }
        if (json.code !== 0) {
            if (process.env.GMGN_DEBUG) {
                console.error(`${curlStr}\n${formatResponse(res, text)}`);
            }
            throw new OpenApiError({
                method,
                path,
                status: res.status,
                apiCode: json.code,
                apiError: json.error,
                apiMessage: json.message,
                resetAtUnix,
                upgradeUrl: json.upgrade_url,
                upgradeMessage: json.upgrade_message,
            });
        }
        return json.data;
    }
}
function getRateLimitRetryDelayMs(err, attempt, maxAttempts, autoRetryOnRateLimit) {
    if (!autoRetryOnRateLimit || attempt >= maxAttempts) {
        return null;
    }
    if (!(err instanceof OpenApiError)) {
        return null;
    }
    if (err.apiError !== "RATE_LIMIT_EXCEEDED" && err.apiError !== "RATE_LIMIT_BANNED") {
        return null;
    }
    if (err.resetAtUnix == null) {
        return null;
    }
    const waitMs = Math.max(err.resetAtUnix * 1000 - Date.now(), 0) + RATE_LIMIT_RETRY_BUFFER_MS;
    return waitMs <= getAutoRetryMaxWaitMs() ? waitMs : null;
}
function parseRateLimitReset(raw) {
    if (raw == null || raw.trim() === "") {
        return undefined;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : undefined;
}
function getAutoRetryMaxWaitMs() {
    const raw = process.env.GMGN_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS;
    if (!raw) {
        return DEFAULT_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS;
    }
    const parsed = Number.parseInt(raw, 10);
    return Number.isFinite(parsed) && parsed >= 0 ? parsed : DEFAULT_RATE_LIMIT_AUTO_RETRY_MAX_WAIT_MS;
}
function buildOpenApiErrorMessage(params) {
    const parts = [`${params.method} ${params.path} failed: HTTP ${params.status}`];
    if (params.apiCode != null)
        parts.push(`code=${params.apiCode}`);
    if (params.apiError)
        parts.push(`error=${params.apiError}`);
    if (params.apiMessage)
        parts.push(`message=${params.apiMessage}`);
    let message = parts.join(" ");
    if (params.apiError === "PLAN_UPGRADE_REQUIRED") {
        const upgrade = params.upgradeMessage ?? params.upgradeUrl ?? "Upgrade your plan to use this endpoint.";
        return `${message}. This endpoint is unavailable on your current plan; retrying will not help. ${upgrade}`;
    }
    if (params.status !== 429) {
        return message;
    }
    const resetText = params.resetAtUnix != null
        ? formatRateLimitReset(params.resetAtUnix)
        : "an unknown time";
    if (params.apiError === "ERROR_RATE_LIMIT_BLOCKED") {
        return `${message}. Repeated business errors triggered a temporary block until ${resetText}. Fix the underlying request before retrying.`;
    }
    if (params.apiError === "RATE_LIMIT_BANNED_MAX") {
        return `${message}. The ban has reached the 5-minute maximum. Stop ALL requests until ${resetText}; every request sent before then resets the ban to 5 minutes.`;
    }
    if (params.apiError === "RATE_LIMIT_EXCEEDED" || params.apiError === "RATE_LIMIT_BANNED") {
        const retryGuidance = `Rate limit resets at ${resetText}. Stop sending requests before then; repeated requests can extend the ban by 5s up to 5 minutes.`;
        if (params.apiError === "RATE_LIMIT_EXCEEDED" && params.upgradeMessage) {
            return `${message}. ${retryGuidance} ${params.upgradeMessage}`;
        }
        return `${message}. ${retryGuidance}`;
    }
    return `${message}. Received HTTP 429; retry after ${resetText}.`;
}
function formatRateLimitReset(resetAtUnix) {
    const resetAt = new Date(resetAtUnix * 1000);
    const remainingSeconds = Math.max(Math.ceil((resetAt.getTime() - Date.now()) / 1000), 0);
    return `${formatLocalTimestamp(resetAt)} (~${remainingSeconds}s remaining)`;
}
function formatLocalTimestamp(date) {
    const year = date.getFullYear();
    const month = String(date.getMonth() + 1).padStart(2, "0");
    const day = String(date.getDate()).padStart(2, "0");
    const hours = String(date.getHours()).padStart(2, "0");
    const minutes = String(date.getMinutes()).padStart(2, "0");
    const seconds = String(date.getSeconds()).padStart(2, "0");
    const offsetMinutes = -date.getTimezoneOffset();
    const sign = offsetMinutes >= 0 ? "+" : "-";
    const absOffsetMinutes = Math.abs(offsetMinutes);
    const offsetHours = String(Math.floor(absOffsetMinutes / 60)).padStart(2, "0");
    const offsetMins = String(absOffsetMinutes % 60).padStart(2, "0");
    return `${year}-${month}-${day} ${hours}:${minutes}:${seconds} GMT${sign}${offsetHours}:${offsetMins}`;
}
function sleep(ms) {
    return new Promise((resolve) => setTimeout(resolve, ms));
}
function formatResponse(res, body) {
    const headerLines = [...res.headers.entries()].map(([k, v]) => `  ${k}: ${v}`).join("\n");
    return `[response] HTTP ${res.status}\n${headerLines}\n\n${body ?? "(no body)"}`;
}
const REDACTED_HEADERS = new Set(["x-apikey"]);
function formatCurl(method, url, headers, body) {
    const headerArgs = Object.entries(headers)
        .map(([k, v]) => `  -H '${k}: ${REDACTED_HEADERS.has(k.toLowerCase()) ? "***" : v}'`)
        .join(" \\\n");
    const bodyArg = body ? ` \\\n  -d '${body.replace(/'/g, "'\\''")}'` : "";
    return `\n[curl]\ncurl -X ${method} '${url}' \\\n${headerArgs}${bodyArg}\n`;
}
const TRENCHES_QUOTE_ADDRESS_TYPES = {
    sol: [4, 5, 3, 1, 13, 0],
    bsc: [6, 7, 1, 16, 8, 3, 9, 10, 2, 17, 18, 0],
    base: [11, 3, 12, 13, 0],
    eth: [20, 11, 8, 3, 12, 1, 0],
    robinhood: [11, 20, 24, 12, 26, 0],
};
function buildTrenchesBody(chain, types, platforms, limit, filters) {
    const selectedTypes = types?.length ? types : ["new_creation", "near_completion", "completed"];
    const quote_address_type = TRENCHES_QUOTE_ADDRESS_TYPES[chain] ?? [];
    const actualLimit = limit ?? 80;
    const section = {
        filters: ["offchain", "onchain"],
        launchpad_platform_v2: true,
        limit: actualLimit,
        ...filters,
    };
    // Let the service apply its current per-chain launchpad defaults when the user
    // does not provide an explicit filter. Keeping a duplicate client-side allow-list
    // here can silently hide newly supported platforms until the CLI is released.
    if (platforms?.length)
        section.launchpad_platform = platforms;
    if (quote_address_type.length)
        section.quote_address_type = quote_address_type;
    const body = { version: "v2" };
    for (const type of selectedTypes) {
        body[type] = { ...section };
    }
    return body;
}
function buildUrl(base, query) {
    const params = new URLSearchParams();
    for (const [k, v] of Object.entries(query)) {
        if (Array.isArray(v)) {
            for (const item of v)
                params.append(k, item);
        }
        else {
            params.set(k, String(v));
        }
    }
    return `${base}?${params.toString()}`;
}
// Recursively extract the root cause from nested Error.cause chain
function extractRootCause(err) {
    if (err instanceof Error && err.cause) {
        return extractRootCause(err.cause);
    }
    return err;
}
//# sourceMappingURL=OpenApiClient.js.map