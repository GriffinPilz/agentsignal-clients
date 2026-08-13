/**
 * The x402 wire protocol, version 1.
 *
 * These shapes are transcribed from the x402 specification rather than
 * imported from the `x402` npm package. That is a deliberate trade:
 *
 *   - The server half of x402 involves no cryptography on our side. We emit a
 *     JSON envelope, base64-decode a header, and POST it to a facilitator
 *     twice. The facilitator checks the signature and moves the money.
 *   - `x402-hono` reaches viem, @solana/kit and @coinbase/cdp-sdk, which is a
 *     large amount of code to load into a Worker whose entire value is edge
 *     latency, in exchange for two `fetch` calls we can write ourselves.
 *   - Its middleware prices routes statically. Our price depends on how many
 *     devices the recipient actually has, which is a database lookup, so the
 *     middleware could not have priced our route regardless.
 *
 * The cost of transcribing is that a protocol revision will not arrive as a
 * dependency bump. `X402_VERSION` is the tripwire: a payer announcing a
 * different version is refused rather than misinterpreted.
 */

/** The only protocol version this server speaks. */
export const X402_VERSION = 1;

/** The only scheme this server accepts. `exact` pays a known amount up front. */
export const X402_SCHEME = 'exact';

/**
 * Networks the spec defines. We only ever quote in the one configured for the
 * deployment, but a payer may name any of them, and a name we do not recognise
 * has to be rejected as unsupported rather than silently treated as ours.
 */
export type X402Network =
  | 'base'
  | 'base-sepolia'
  | 'avalanche'
  | 'avalanche-fuji'
  | 'iotex'
  | 'polygon'
  | 'polygon-amoy'
  | 'sei'
  | 'sei-testnet'
  | 'solana'
  | 'solana-devnet'
  | 'abstract'
  | 'abstract-testnet'
  | 'peaq'
  | 'story'
  | 'educhain'
  | 'skale-base-sepolia';

/**
 * What the server demands, sent in the body of a 402.
 *
 * `maxAmountRequired` is a decimal string in the asset's own base units, not a
 * number: USDC has six decimals, so $0.001 is the string "1000".
 */
export interface PaymentRequirements {
  scheme: typeof X402_SCHEME;
  network: X402Network;
  maxAmountRequired: string;
  resource: string;
  description: string;
  mimeType: string;
  payTo: string;
  maxTimeoutSeconds: number;
  asset: string;
  outputSchema?: Record<string, unknown>;
  /**
   * For EIP-3009 assets this carries the token contract's EIP-712 domain, so
   * the payer can construct a signature the token will actually honour. Get
   * `name` or `version` wrong and every signature verifies as invalid.
   */
  extra?: Record<string, unknown>;
}

/** What the payer sends back, base64-encoded in the `X-PAYMENT` header. */
export interface PaymentPayload {
  x402Version: number;
  scheme: string;
  network: string;
  payload: Record<string, unknown>;
}

/** The body of a 402 response. */
export interface X402Response {
  x402Version: number;
  error: string;
  accepts: PaymentRequirements[];
}

export interface VerifyResponse {
  isValid: boolean;
  invalidReason?: string;
  payer?: string;
}

export interface SettleResponse {
  success: boolean;
  errorReason?: string;
  payer?: string;
  /** The on-chain transaction hash. Our idempotency key for crediting. */
  transaction: string;
  network: string;
}

/**
 * USDC, per network, with the EIP-712 domain each contract actually uses.
 *
 * The `name` differs between mainnet and Sepolia -- "USD Coin" against "USDC"
 * -- which is the classic way an x402 integration ends up rejecting every
 * signature it is sent while looking entirely correct.
 */
export const USDC: Record<string, { address: string; name: string; version: string }> = {
  base: {
    address: '0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913',
    name: 'USD Coin',
    version: '2',
  },
  'base-sepolia': {
    address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
    name: 'USDC',
    version: '2',
  },
};

/** USDC has six decimals, and our internal unit is millionths of a dollar. */
export const USDC_DECIMALS = 6;

/** Render millionths of a USD as the decimal string x402 expects. */
export function microsToAssetAmount(micros: number | bigint): string {
  return BigInt(micros).toString();
}

/** Human-readable price, for the `description` field and for error messages. */
export function formatMicros(micros: number | bigint): string {
  const value = Number(micros) / 1_000_000;
  return `$${value.toFixed(value < 0.01 ? 4 : 2)}`;
}
