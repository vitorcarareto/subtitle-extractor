import type { Provider } from '../types.js';
import hotmart from './hotmart.js';
import youtube from './youtube.js';

const providers: Provider[] = [hotmart, youtube];

export function getProviderForUrl(url: string): Provider | null {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    return null;
  }

  for (const provider of providers) {
    for (const pattern of provider.domains) {
      if (pattern.startsWith('*.')) {
        const suffix = pattern.slice(1);
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

export function getProviderById(id: string): Provider | null {
  return providers.find((p) => p.id === id) || null;
}

export function getAllProviders(): Provider[] {
  return providers;
}
