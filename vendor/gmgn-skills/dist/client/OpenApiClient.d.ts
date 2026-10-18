/**
 * OpenApiClient — GMGN OpenAPI external client
 *
 * Auth modes:
 *   Exist (market/token/portfolio): X-APIKEY + timestamp + client_id
 *   Signed (swap and order routes): X-APIKEY + timestamp + client_id + X-Signature (private key signature)
 */
export interface Config {
    apiKey: string;
    privateKeyPem?: string;
    host: string;
}
export interface SwapParams {
    chain: string;
    from_address: string;
    input_token: string;
    output_token: string;
    input_amount: string;
    swap_mode?: string;
    input_amount_bps?: string;
    output_amount?: string;
    slippage?: number;
    auto_slippage?: boolean;
    min_output_amount?: string;
    is_anti_mev?: boolean;
    priority_fee?: string;
    tip_fee?: string;
    gas_price?: string;
    gas_level?: string;
    auto_fee?: boolean;
    max_fee_per_gas?: string;
    max_priority_fee_per_gas?: string;
    condition_orders?: StrategyConditionOrder[];
    sell_ratio_type?: string;
}
export interface StrategyConditionOrder {
    order_type: string;
    side: string;
    price_scale?: string;
    sell_ratio: string;
    drawdown_rate?: string;
}
export interface MultiSwapParams {
    chain: string;
    accounts: string[];
    input_token: string;
    output_token: string;
    input_amount?: Record<string, string>;
    input_amount_bps?: Record<string, string>;
    output_amount?: Record<string, string>;
    swap_mode?: string;
    slippage?: number;
    auto_slippage?: boolean;
    is_anti_mev?: boolean;
    priority_fee?: string;
    tip_fee?: string;
    gas_price?: string;
    gas_level?: string;
    auto_fee?: boolean;
    max_fee_per_gas?: string;
    max_priority_fee_per_gas?: string;
    condition_orders?: StrategyConditionOrder[];
    sell_ratio_type?: string;
}
export interface StrategyCreateParams {
    chain: string;
    from_address: string;
    base_token: string;
    quote_token: string;
    order_type: string;
    sub_order_type: string;
    check_price?: string;
    open_price?: string;
    amount_in?: string;
    amount_in_percent?: string;
    limit_price_mode?: string;
    price_gap_ratio?: string;
    expire_in?: number;
    sell_ratio_type?: string;
    slippage?: number;
    auto_slippage?: boolean;
    fee?: string;
    auto_fee?: boolean;
    gas_price?: string;
    gas_level?: string;
    max_fee_per_gas?: string;
    max_priority_fee_per_gas?: string;
    is_anti_mev?: boolean;
    anti_mev_mode?: string;
    priority_fee?: string;
    tip_fee?: string;
    custom_rpc?: string;
    condition_orders?: StrategyConditionOrder[];
    quote_investment?: string;
    sell_param?: TradeParam;
    buy_param?: TradeParam;
}
export interface StrategyCancelParams {
    chain: string;
    from_address: string;
    order_id: string;
    order_type?: string;
    close_sell_model?: string;
}
export interface TokenSignalGroup {
    signal_type?: number[];
    mc_min?: number;
    mc_max?: number;
    trigger_mc_min?: number;
    trigger_mc_max?: number;
    total_fee_min?: number;
    total_fee_max?: number;
    min_create_or_open_ts?: string;
    max_create_or_open_ts?: string;
}
export interface HotSearchesParam {
    label?: string;
    interval: string;
    chain: string;
    filters?: string[];
    limit?: number;
    [key: string]: string[] | number | string | undefined;
}
export interface CalloutRecordExtra {
    call_token?: string;
    limit?: number;
    page_token?: string;
}
export interface CalloutGlobalExtra {
    limit?: number;
    page_token?: string;
    only_kol?: boolean;
    only_declaration?: boolean;
    only_safe?: boolean;
    min_holding_usd?: string;
    max_holding_usd?: string;
}
export interface PumpFeeShareInfo {
    provider: string;
    username: string;
    basic_points: number;
}
export interface BAGSFeeShareInfo {
    provider: string;
    username: string;
    basic_points: number;
}
export interface FlapRateConf {
    tax_rate?: number;
    buy_tax_rate?: number;
    sell_tax_rate?: number;
    mkt_bps?: number;
    deflation_bps?: number;
    dividend_bps?: number;
    lp_bps?: number;
    minimum_share_balance?: number;
    recipient_type?: string;
    beneficiary?: string;
    twitter_account?: string;
    split_conf?: Array<{
        recipient: string;
        bps: number;
    }>;
}
export interface FourmemeRateConf {
    fee_plan?: boolean;
    fee_rate?: number;
    burn_rate?: number;
    divide_rate?: number;
    liquidity_rate?: number;
    recipient_rate?: number;
    recipient_address?: string;
    min_sharing?: number;
}
export interface BuyWalletInfo {
    from_address: string;
    buy_amt: string;
}
export interface TradeParam {
    slippage?: number;
    auto_slippage?: boolean;
    fee?: string;
    priority_fee?: string;
    tip_fee?: string;
    gas_price?: string;
    max_priority_fee_per_gas?: string;
    max_fee_per_gas?: string;
    is_anti_mev?: boolean;
    anti_mev_mode?: string;
}
export interface CookingSellConfig {
    sell_type: string;
    delay_sec?: number;
    delay_mili_sec?: number;
    sell_ratio: string;
    check_price?: string;
    wallet_addresses: string[];
}
export interface CreateTokenParams {
    chain: string;
    dex: string;
    from_address: string;
    name: string;
    symbol: string;
    buy_amt: string;
    image?: string;
    image_url?: string;
    description?: string;
    website?: string;
    twitter?: string;
    telegram?: string;
    slippage?: number;
    auto_slippage?: boolean;
    fee?: string;
    priority_fee?: string;
    tip_fee?: string;
    gas_price?: string;
    max_priority_fee_per_gas?: string;
    max_fee_per_gas?: string;
    is_anti_mev?: boolean;
    anti_mev_mode?: string;
    raised_token?: string;
    dev_gas?: string;
    dev_priority?: string;
    dev_tip?: string;
    dev_max_fee_per_gas?: string;
    approve_vision?: string;
    source?: string;
    dev_wallet_bps?: number;
    buy_trade_config?: TradeParam;
    sell_trade_config?: TradeParam;
    sell_configs?: CookingSellConfig[];
    is_mayhem?: boolean;
    is_cashback?: boolean;
    is_buy_back?: boolean;
    pump_fee_share_list?: PumpFeeShareInfo[];
    flap_rate_conf?: FlapRateConf;
    fourmeme_rate_conf?: FourmemeRateConf;
    bags_fee_share_list?: BAGSFeeShareInfo[];
    bonk_model?: string;
    buy_wallets?: BuyWalletInfo[];
    snip_buy_wallets?: BuyWalletInfo[];
}
export declare class OpenApiClient {
    private readonly apiKey;
    private readonly privateKeyPem;
    private readonly host;
    constructor(config: Config);
    getTokenInfo(chain: string, address: string): Promise<unknown>;
    getTokenSecurity(chain: string, address: string): Promise<unknown>;
    getTokenPoolInfo(chain: string, address: string): Promise<unknown>;
    getTokenTopHolders(chain: string, address: string, extra?: Record<string, string | number>): Promise<unknown>;
    getTokenTopTraders(chain: string, address: string, extra?: Record<string, string | number>): Promise<unknown>;
    getTokenKline(chain: string, address: string, resolution: string, from?: number, to?: number): Promise<unknown>;
    getWalletHoldings(chain: string, walletAddress: string, extra?: Record<string, string | number>): Promise<unknown>;
    getWalletActivity(chain: string, walletAddress: string, extra?: Record<string, string | number | string[]>): Promise<unknown>;
    getWalletStats(chain: string, walletAddresses: string[], period?: string): Promise<unknown>;
    getWalletProfits(chain: string, walletAddresses: string[], period?: string): Promise<unknown>;
    getWalletTokenBalance(chain: string, walletAddress: string, tokenAddress: string): Promise<unknown>;
    getTrenches(chain: string, types?: string[], platforms?: string[], limit?: number, filters?: Record<string, number | string>): Promise<unknown>;
    getTrendingSwaps(chain: string, interval: string, extra?: Record<string, string | number | string[]>): Promise<unknown>;
    getTokenSignalV2(chain: string, groups: TokenSignalGroup[]): Promise<unknown>;
    getHotSearches(params: HotSearchesParam[]): Promise<unknown>;
    searchMarket(query: string, extra?: Record<string, string | number | string[]>): Promise<unknown>;
    getUserInfo(): Promise<unknown>;
    getFollowWallet(chain: string, extra?: Record<string, string | number | string[]>): Promise<unknown>;
    getFollowTokens(chain: string, walletAddress: string, extra?: Record<string, string | number>): Promise<unknown>;
    getFollowGroupNames(chain: string, walletAddress: string): Promise<unknown>;
    getKol(chain?: string, limit?: number): Promise<unknown>;
    getSmartMoney(chain?: string, limit?: number): Promise<unknown>;
    getCreatedTokens(chain: string, walletAddress: string, extra?: Record<string, string | number>): Promise<unknown>;
    getCalloutRecord(chain: string, callWallet: string, extra?: CalloutRecordExtra): Promise<unknown>;
    getCalloutGlobal(chains: string[], extra?: CalloutGlobalExtra): Promise<unknown>;
    quoteOrder(chain: string, from_address: string, input_token: string, output_token: string, input_amount: string, slippage: number): Promise<unknown>;
    swap(params: SwapParams): Promise<unknown>;
    multiSwap(params: MultiSwapParams): Promise<unknown>;
    queryOrder(orderId: string, chain: string): Promise<unknown>;
    getGasPrice(chain: string): Promise<unknown>;
    createStrategyOrder(params: StrategyCreateParams): Promise<unknown>;
    getStrategyOrders(chain: string, extra?: Record<string, string | number>): Promise<unknown>;
    cancelStrategyOrder(params: StrategyCancelParams): Promise<unknown>;
    getCookingStatistics(): Promise<unknown>;
    createToken(params: CreateTokenParams): Promise<unknown>;
    private authExistRequest;
    private authSignedRequest;
    private executePreparedRequest;
    private doFetch;
    private parseResponse;
}
//# sourceMappingURL=OpenApiClient.d.ts.map