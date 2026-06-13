import { describe, expect, it } from 'vitest';
import { render, screen } from '@testing-library/react';
import { LiveLogConsole } from '../components/primitives';

describe('LiveLogConsole', () => {
  it('shows the empty state when there are no lines', () => {
    render(<LiveLogConsole lines={[]} />);
    expect(screen.getByText(/waiting for sidecar log output/i)).toBeTruthy();
  });

  it('renders each line content (keyed by stable id)', () => {
    render(
      <LiveLogConsole
        lines={[
          { id: 1, content: 'first line' },
          { id: 2, content: 'second line' },
        ]}
      />,
    );
    expect(screen.getByText('first line')).toBeTruthy();
    expect(screen.getByText('second line')).toBeTruthy();
  });
});
