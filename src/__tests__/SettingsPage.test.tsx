import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { SettingsPage } from '../pages/SettingsPage';
import type { AppSettings, Bundle } from '../types';

// Settings → Access edits capability bundles, read from and saved to the store (#320).
const bundle = (name: string, allowIm = false): Bundle => ({
  name,
  manualUserIds: '',
  resolvedUserIds: [],
  capabilities: ['query_codebase'],
  allowedChannelIds: [],
  allowIm,
  allowMpim: false,
  updatedAt: 'v1',
});
const STORED_BUNDLES = [bundle('viewer'), bundle('reviewer'), bundle('builder'), bundle('admin', true)];

function makeSettings(): AppSettings {
  return {
    slackBotToken: 'xoxb-test',
    slackAppToken: 'xapp-test',
    ownerSlackUserIds: 'UOWNER1',
    botUserId: 'UBOT1',
    bugsAndUpdatesChannelId: 'C01H25RNLJH',
    newtonWebPath: '/Users/dipesh/code/newton-web',
    newtonApiPath: '/Users/dipesh/code/newton-api',
    newtonMarketingWebPath: '',
    maxConcurrentJobs: 2,
    repoClassifierThreshold: 0.75,
    themePreset: 'watchtower-midnight',
    themeBackgroundColor: '#06090C',
    themeForegroundColor: '#F2F7FB',
    themeAccentColor: '#53D2FF',
    themeFontFamily: 'ibm-plex',
    successNotificationAudioMode: 'off',
    successNotificationAudioDefaultSound: 'glass',
    successNotificationAudioCustomPath: '',
    failureNotificationAudioMode: 'off',
    failureNotificationAudioDefaultSound: 'glass',
    failureNotificationAudioCustomPath: '',
    agentBackend: 'codex',
    coreDevSlackUserIds: '',
    vaultPath: '',
    vaultEnabled: false,
    accessControl: {
      mode: 'audit',
      groups: {
        viewer: {
          manualUserIds: 'UVIEWER',
          allowedChannelIds: 'C-VIEW',
          allowIm: true,
          allowMpim: false,
        },
        reviewer: {
          manualUserIds: 'UREVIEW',
          allowedChannelIds: 'C-REVIEW',
          allowIm: false,
          allowMpim: false,
        },
        builder: {
          manualUserIds: 'UBUILDER',
          allowedChannelIds: 'C-BUILD',
          allowIm: false,
          allowMpim: false,
        },
        admin: {
          manualUserIds: 'UADMIN',
          allowedChannelIds: 'C-ADMIN',
          allowIm: true,
          allowMpim: true,
        },
        owner: {
          manualUserIds: '',
          allowedChannelIds: '',
          allowIm: false,
          allowMpim: false,
        },
      },
    },
  };
}

function renderAndNavigateToAccess(onSettingsChange = vi.fn()) {
  render(
    <SettingsPage
      onSettingsChange={onSettingsChange}
      onImportNotificationAudio={vi.fn().mockResolvedValue(undefined)}
      onPreviewNotification={vi.fn()}
      onSubmit={vi.fn()}
      previewingNotificationTone={null}
      savingSettings={false}
      settings={makeSettings()}
      settingsConfigured
      settingsMessage={null}
      uploadingNotificationAudioTone={null}
    />,
  );

  // Navigate to the Access section via sidebar
  fireEvent.click(screen.getByText('Access'));
  return onSettingsChange;
}

const bundleCard = async (name: string) =>
  (await screen.findByText(name, { selector: 'strong' })).closest('article') as HTMLElement;

describe('SettingsPage', () => {
  beforeEach(() => {
    invoke.mockReset();
    invoke.mockImplementation((command: string) => {
      if (command === 'get_bundles') return Promise.resolve(STORED_BUNDLES.map(row => ({ ...row })));
      if (command === 'get_slack_directory') return Promise.resolve({ people: [], groups: [] });
      return Promise.resolve(undefined);
    });
  });

  it('renders ownership, the access mode and a card per capability bundle when navigated to', async () => {
    renderAndNavigateToAccess();

    expect(screen.getByText('Owner Slack User IDs')).toBeTruthy();
    expect(screen.getAllByText('Access Mode').length).toBeGreaterThan(0);
    expect(screen.getByText('Capability Bundles')).toBeTruthy();
    for (const name of ['viewer', 'reviewer', 'builder', 'admin']) {
      expect(await bundleCard(name)).toBeTruthy();
    }
  });

  it('maps access mode change into onSettingsChange', () => {
    const onSettingsChange = renderAndNavigateToAccess();

    const accessMode = screen.getByDisplayValue('Audit');
    fireEvent.change(accessMode, { target: { value: 'enforce' } });
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        accessControl: expect.objectContaining({
          mode: 'enforce',
        }),
      }),
    );
  });

  it('saves a bundle with DMs allowed when its Allow DM is ticked, without touching the page settings', async () => {
    const onSettingsChange = renderAndNavigateToAccess();
    const reviewer = await bundleCard('reviewer');
    onSettingsChange.mockClear();

    fireEvent.click(within(reviewer).getByLabelText('Allow DM'));
    fireEvent.click(within(reviewer).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_bundle', {
        bundle: expect.objectContaining({ name: 'reviewer', allowIm: true }),
      }),
    );
    expect(onSettingsChange).not.toHaveBeenCalled();
  });

  it('maps the optional newton-marketing-web path into onSettingsChange', () => {
    const onSettingsChange = vi.fn();
    render(
      <SettingsPage
        onSettingsChange={onSettingsChange}
        onImportNotificationAudio={vi.fn().mockResolvedValue(undefined)}
        onPreviewNotification={vi.fn()}
        onSubmit={vi.fn()}
        previewingNotificationTone={null}
        savingSettings={false}
        settings={makeSettings()}
        settingsConfigured
        settingsMessage={null}
        uploadingNotificationAudioTone={null}
      />,
    );

    fireEvent.click(screen.getByText('Connections'));
    const input = screen.getByPlaceholderText('/Users/you/code/mini-og/newton-marketing-web');
    fireEvent.change(input, { target: { value: '/Users/dipesh/code/mini-og/newton-marketing-web' } });
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        newtonMarketingWebPath: '/Users/dipesh/code/mini-og/newton-marketing-web',
      }),
    );
  });

  it('shows the sidebar nav with all four sections', () => {
    render(
      <SettingsPage
        onSettingsChange={vi.fn()}
        onImportNotificationAudio={vi.fn().mockResolvedValue(undefined)}
        onPreviewNotification={vi.fn()}
        onSubmit={vi.fn()}
        previewingNotificationTone={null}
        savingSettings={false}
        settings={makeSettings()}
        settingsConfigured
        settingsMessage={null}
        uploadingNotificationAudioTone={null}
      />,
    );

    expect(screen.getByText('Appearance')).toBeTruthy();
    expect(screen.getByText('Connections')).toBeTruthy();
    expect(screen.getByText('Access')).toBeTruthy();
    expect(screen.getByText('Automation')).toBeTruthy();
  });

  it('shows the health strip', () => {
    render(
      <SettingsPage
        onSettingsChange={vi.fn()}
        onImportNotificationAudio={vi.fn().mockResolvedValue(undefined)}
        onPreviewNotification={vi.fn()}
        onSubmit={vi.fn()}
        previewingNotificationTone={null}
        savingSettings={false}
        settings={makeSettings()}
        settingsConfigured
        settingsMessage={null}
        uploadingNotificationAudioTone={null}
      />,
    );

    expect(screen.getByText(/Slack \u2713/)).toBeTruthy();
    expect(screen.getByText(/Repos 2\/2/)).toBeTruthy();
    expect(screen.getByText('Access: Audit')).toBeTruthy();
  });
});
