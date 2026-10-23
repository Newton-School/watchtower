import { beforeEach, describe, expect, it, vi } from 'vitest';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';

const invoke = vi.fn();
vi.mock('@tauri-apps/api/core', () => ({ invoke: (...args: unknown[]) => invoke(...args) }));

import { BundleEditor } from '../components/BundleEditor';
import type { Bundle } from '../types';

const directory = {
  people: [
    { id: 'U1', name: 'Asha', realName: 'Asha Rao', avatarUrl: null },
    { id: 'U2', name: 'Vik', realName: 'Vikram S', avatarUrl: null },
    { id: 'U3', name: 'Neha', realName: 'Neha K', avatarUrl: null },
  ],
  groups: [],
};

const stored = (name: string, manualUserIds: string, updatedAt: string): Bundle => ({
  name,
  manualUserIds,
  resolvedUserIds: [],
  capabilities: ['query_codebase'],
  allowedChannelIds: [],
  allowIm: false,
  allowMpim: false,
  updatedAt,
});

const card = (name: string) => screen.getByText(name, { selector: 'strong' }).closest('article') as HTMLElement;

describe('BundleEditor', () => {
  let rows: Bundle[];
  beforeEach(() => {
    rows = [stored('admin', 'U1', 'v1'), stored('builder', 'U2', 'v1')];
    invoke.mockReset();
    invoke.mockImplementation((command: string) => {
      if (command === 'get_bundles') return Promise.resolve(rows.map(row => ({ ...row })));
      if (command === 'get_slack_directory') return Promise.resolve(directory);
      return Promise.resolve(undefined);
    });
  });

  it('keeps unsaved edits to other bundles when one is saved, and sends the version it read', async () => {
    render(<BundleEditor />);
    await screen.findByRole('button', { name: 'Remove Asha Rao' });

    fireEvent.click(within(card('admin')).getByRole('button', { name: 'Remove Asha Rao' }));
    fireEvent.click(within(card('builder')).getByRole('button', { name: 'Remove Vikram S' }));
    fireEvent.click(within(card('builder')).getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(invoke).toHaveBeenCalledWith('save_bundle', {
        bundle: expect.objectContaining({ name: 'builder', manualUserIds: '', updatedAt: 'v1' }),
      }),
    );
    await waitFor(() => expect(invoke.mock.calls.filter(([command]) => command === 'get_bundles')).toHaveLength(2));
    // The admin edit is still there, unsaved.
    expect(within(card('admin')).queryByRole('button', { name: 'Remove Asha Rao' })).toBeNull();
    expect(within(card('admin')).getByRole('button', { name: 'Save' })).toBeTruthy();
  });

  it('shows the stored bundle when it changed since the page read it, instead of writing over it', async () => {
    render(<BundleEditor />);
    await screen.findByRole('button', { name: 'Remove Asha Rao' });

    // miniOG copies Neha in after the page loaded.
    rows = [stored('admin', 'U1,U3', 'v2'), rows[1]];
    invoke.mockImplementation((command: string) => {
      if (command === 'get_bundles') return Promise.resolve(rows.map(row => ({ ...row })));
      if (command === 'get_slack_directory') return Promise.resolve(directory);
      if (command === 'save_bundle')
        return Promise.reject(
          'This bundle changed since Settings loaded it (miniOG may have just added people to it). It has been reloaded: make your change again.',
        );
      return Promise.resolve(undefined);
    });

    fireEvent.click(within(card('admin')).getByRole('button', { name: 'Remove Asha Rao' }));
    fireEvent.click(within(card('admin')).getByRole('button', { name: 'Save' }));

    expect(await screen.findByRole('alert')).toHaveProperty(
      'textContent',
      expect.stringContaining('changed since Settings loaded it'),
    );
    expect(within(card('admin')).getByRole('button', { name: 'Remove Neha K' })).toBeTruthy();
    expect(within(card('admin')).getByRole('button', { name: 'Remove Asha Rao' })).toBeTruthy();
  });
});
