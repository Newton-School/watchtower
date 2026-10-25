import { hydrateBundleUserIds } from '../access/control.js';
import type { AppConfig, Bundle } from '../types/contracts.js';

/**
 * Hot-reload of the access bundles (D5a) when the app (or direct SQL) edited
 * them since they were last loaded: signal-driven, so it costs nothing when
 * nothing changed. Read at every job start, and again by a wait that lasts
 * long enough for access to change under it (the deploy offer, issue #703).
 */

export interface BundleSource {
  getAccessCacheSignalAt(): string | undefined;
  getBundles(): Bundle[];
}

let loadedAt = new Date().toISOString();

/** Reloads `config.bundles` in place when they changed. True when it did. */
export function reloadBundlesIfChanged(config: AppConfig, store: BundleSource): boolean {
  const signalAt = store.getAccessCacheSignalAt();
  if (!signalAt || signalAt <= loadedAt) return false;
  const reloaded = store.getBundles();
  if (reloaded.length === 0) return false;
  config.bundles = hydrateBundleUserIds(reloaded, config.ownerSlackUserIds);
  loadedAt = signalAt;
  return true;
}

export function __setBundlesLoadedAtForTests(at: string): void {
  loadedAt = at;
}
