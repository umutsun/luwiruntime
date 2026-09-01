// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { useState } from 'react';
import { afterEach, describe, expect, it } from 'vitest';

import { DetailDrawer } from './detail-drawer.js';

afterEach(() => {
  cleanup();
  document.body.style.overflow = '';
});

function Harness() {
  const [open, setOpen] = useState(false);
  return (
    <>
      <button type="button" onClick={() => setOpen(true)}>
        Open evidence
      </button>
      {open ? (
        <DetailDrawer
          eyebrow="Read-only evidence"
          title="Message detail"
          meta="corr-1"
          onClose={() => setOpen(false)}
        >
          <p>Selected evidence</p>
          <button type="button">Inner action</button>
        </DetailDrawer>
      ) : null}
    </>
  );
}

function openDrawer() {
  render(<Harness />);
  const opener = screen.getByRole('button', { name: 'Open evidence' });
  opener.focus();
  fireEvent.click(opener);
  return opener;
}

describe('detail drawer', () => {
  it('renders a labelled modal drawer in a portal and moves focus to Close', () => {
    openDrawer();

    const drawer = screen.getByRole('dialog', { name: 'Message detail' });
    expect(drawer.getAttribute('aria-modal')).toBe('true');
    expect(drawer.parentElement).toBe(document.body.querySelector('.detail-drawer-layer'));
    expect(screen.getByText('Read-only evidence')).toBeTruthy();
    expect(screen.getByText('corr-1')).toBeTruthy();
    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Close drawer' }));
    expect(document.body.style.overflow).toBe('hidden');
  });

  it('closes with its button and restores focus to the opener', () => {
    const opener = openDrawer();

    fireEvent.click(screen.getByRole('button', { name: 'Close drawer' }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(document.activeElement).toBe(opener);
    expect(document.body.style.overflow).toBe('');
  });

  it('closes on Escape', () => {
    openDrawer();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('closes when the backdrop itself is pressed', () => {
    openDrawer();
    const layer = document.body.querySelector('.detail-drawer-layer');
    expect(layer).toBeTruthy();

    fireEvent.mouseDown(layer as Element);

    expect(screen.queryByRole('dialog')).toBeNull();
  });

  it('does not close when the drawer surface is pressed', () => {
    openDrawer();

    fireEvent.mouseDown(screen.getByRole('dialog'));

    expect(screen.getByRole('dialog', { name: 'Message detail' })).toBeTruthy();
  });

  it('keeps Tab inside the drawer in both directions', () => {
    openDrawer();
    const drawer = screen.getByRole('dialog');
    const close = screen.getByRole('button', { name: 'Close drawer' });
    const inner = screen.getByRole('button', { name: 'Inner action' });

    inner.focus();
    fireEvent.keyDown(drawer, { key: 'Tab' });
    expect(document.activeElement).toBe(close);

    close.focus();
    fireEvent.keyDown(drawer, { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(inner);
  });
});
