import { describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen } from '@testing-library/react';
import { SettingsPage } from '../pages/SettingsPage';
import type { AppSettings } from '../types';

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
    coreDevSlackUserGroup: '',
    vaultPath: '',
    vaultEnabled: false,
    accessControl: {
      mode: 'audit',
      groups: {
        viewer: {
          slackUserGroupHandle: '',
          manualUserIds: 'UVIEWER',
          allowedChannelIds: 'C-VIEW',
          allowIm: true,
          allowMpim: false,
        },
        reviewer: {
          slackUserGroupHandle: '',
          manualUserIds: 'UREVIEW',
          allowedChannelIds: 'C-REVIEW',
          allowIm: false,
          allowMpim: false,
        },
        builder: {
          slackUserGroupHandle: '',
          manualUserIds: 'UBUILDER',
          allowedChannelIds: 'C-BUILD',
          allowIm: false,
          allowMpim: false,
        },
        admin: {
          slackUserGroupHandle: '',
          manualUserIds: 'UADMIN',
          allowedChannelIds: 'C-ADMIN',
          allowIm: true,
          allowMpim: true,
        },
        owner: {
          slackUserGroupHandle: '',
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

describe('SettingsPage', () => {
  it('renders the access-control section and role tabs when navigated to', () => {
    renderAndNavigateToAccess();

    expect(screen.getAllByText('Access Control').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Viewer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Reviewer').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Builder').length).toBeGreaterThan(0);
    expect(screen.getAllByText('Admin').length).toBeGreaterThan(0);
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

  it('maps DM toggle for a selected role into onSettingsChange', () => {
    const onSettingsChange = renderAndNavigateToAccess();

    // Default active role is admin — switch to reviewer
    fireEvent.click(screen.getByText('Reviewer'));
    onSettingsChange.mockClear();

    const allowDmToggle = screen.getByLabelText('Allow DM');
    fireEvent.click(allowDmToggle);
    expect(onSettingsChange).toHaveBeenCalledWith(
      expect.objectContaining({
        accessControl: expect.objectContaining({
          groups: expect.objectContaining({
            reviewer: expect.objectContaining({
              allowIm: true,
            }),
          }),
        }),
      }),
    );
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
