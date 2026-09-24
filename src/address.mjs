const EVM_TOKEN = /^0x[0-9a-f]{40}$/i;
const EVM_POOL = /^0x(?:[0-9a-f]{40}|[0-9a-f]{64})$/i;
const SOLANA_TEXT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const BASE58 = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';

function solanaBytes(value) {
  if (!SOLANA_TEXT.test(value)) return 0;
  let number = 0n;
  for (const character of value) {
    const digit = BASE58.indexOf(character);
    if (digit < 0) return 0;
    number = number * 58n + BigInt(digit);
  }
  const significant = number === 0n ? 0 : Math.ceil(number.toString(16).length / 2);
  return significant + (value.match(/^1*/)?.[0].length || 0);
}

export function normalizeTokenAddress(chain, value) {
  if (typeof value !== 'string' || value !== value.trim()) return null;
  if (chain === 'sol') return solanaBytes(value) === 32 && !/^1+$/.test(value) ? value : null;
  return EVM_TOKEN.test(value) && !/^0x(?:0{40}|e{40})$/i.test(value) ? value.toLowerCase() : null;
}

export function normalizePoolAddress(chain, value) {
  const token = normalizeTokenAddress(chain, value);
  if (token) return token;
  if (chain === 'sol' || typeof value !== 'string' || value !== value.trim()) return null;
  return EVM_POOL.test(value) && !/^0x0{64}$/i.test(value) ? value.toLowerCase() : null;
}

export const validTokenAddress = (chain, value) => normalizeTokenAddress(chain, value) !== null;
export const validPoolAddress = (chain, value) => normalizePoolAddress(chain, value) !== null;
