import { logger } from './logger.js';

/**
 * Secrets are referenced, never stored, in Postgres. `shortcodes.daraja_secret_ref`
 * holds a pointer like "env:DARAJA_SECRET_ACME" and this resolver turns it into a
 * value. Swap the env provider for Vault/AWS Secrets Manager without touching
 * callers or the schema.
 */
export interface SecretProvider {
  readonly scheme: string;
  resolve(key: string): Promise<string | null>;
}

const envProvider: SecretProvider = {
  scheme: 'env',
  async resolve(key) {
    return process.env[key] ?? null;
  },
};

const providers = new Map<string, SecretProvider>([[envProvider.scheme, envProvider]]);

export function registerSecretProvider(provider: SecretProvider): void {
  providers.set(provider.scheme, provider);
}

export async function resolveSecret(ref: string | null | undefined): Promise<string | null> {
  if (!ref) return null;
  const idx = ref.indexOf(':');
  if (idx === -1) {
    logger.error({ ref }, 'secret ref missing scheme (expected "scheme:key")');
    return null;
  }
  const scheme = ref.slice(0, idx);
  const key = ref.slice(idx + 1);
  const provider = providers.get(scheme);
  if (!provider) {
    logger.error({ scheme }, 'no secret provider registered for scheme');
    return null;
  }
  const value = await provider.resolve(key);
  if (!value) logger.error({ ref }, 'secret ref resolved to nothing');
  return value;
}

/** Constant-time-ish comparison for tokens and webhook path secrets. */
export function safeEqual(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}
