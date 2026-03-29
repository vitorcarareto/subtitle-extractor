import hotmart from './hotmart.js';
import youtube from './youtube.js';

const providers = [hotmart, youtube];

/**
 * Find the provider that matches a page URL.
 * @param {string} url - The page URL to match
 * @returns {object|null} The matched provider or null
 */
export function getProviderForUrl(url) {
  let hostname;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }

  for (const provider of providers) {
    for (const pattern of provider.domains) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1); // e.g. ".hotmart.com"
        if (hostname === suffix.slice(1) || hostname.endsWith(suffix)) {
          return provider;
        }
      } else if (hostname === pattern) {
        return provider;
      }
    }
  }
  return null;
}

/**
 * Get a provider by its unique ID.
 */
export function getProviderById(id) {
  return providers.find((p) => p.id === id) || null;
}

/**
 * List all registered providers.
 */
export function getAllProviders() {
  return providers;
}
