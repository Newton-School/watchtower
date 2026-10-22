import { invoke } from '@tauri-apps/api/core';
import type { SlackDirectory } from '../types';

// Images are private Slack files the app fetches with the bot token, so keep
// the ones already shown instead of fetching them again on every refresh.
const MAX_IMAGES = 60;
const images = new Map<string, Promise<string>>();

/** A Slack-hosted image as a data URL. */
export function loadSlackImage(url: string, mimetype: string): Promise<string> {
  const cached = images.get(url);
  if (cached) return cached;
  const loading = invoke<string>('get_slack_image', { url, mimetype });
  images.set(url, loading);
  loading.catch(() => images.delete(url));
  if (images.size > MAX_IMAGES) {
    const oldest = images.keys().next().value;
    if (oldest !== undefined) images.delete(oldest);
  }
  return loading;
}

// The first read of the directory is slow (a few seconds for a big
// workspace), so share one read between callers; the app itself keeps it an hour.
const DIRECTORY_REUSE_MS = 10 * 60 * 1000;
let directory: { loading: Promise<SlackDirectory>; at: number } | null = null;

/** The workspace's people and groups for @mentions. */
export function loadSlackDirectory(): Promise<SlackDirectory> {
  if (!directory || Date.now() - directory.at > DIRECTORY_REUSE_MS) {
    const loading = invoke<SlackDirectory>('get_slack_directory');
    directory = { loading, at: Date.now() };
    loading.catch(() => {
      if (directory?.loading === loading) directory = null;
    });
  }
  return directory.loading;
}
