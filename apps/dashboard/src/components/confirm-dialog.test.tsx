// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ConfirmDialog } from './confirm-dialog.js';

afterEach(cleanup);

function renderDialog(overrides: { busy?: boolean } = {}) {
  const onConfirm = vi.fn();
  const onCancel = vi.fn();
  render(
    <ConfirmDialog
      title="Apply plan-1"
      confirmLabel="Apply"
      onConfirm={onConfirm}
      onCancel={onCancel}
      {...overrides}
    >
      <p>Writes two files.</p>
    </ConfirmDialog>,
  );
  return { onConfirm, onCancel };
}

describe('confirm dialog', () => {
  it('is a modal dialog labelled by its own heading', () => {
    renderDialog();
    const dialog = screen.getByRole('dialog');

    expect(dialog.getAttribute('aria-modal')).toBe('true');
    const labelledBy = dialog.getAttribute('aria-labelledby');
    expect(labelledBy).toBeTruthy();
    expect(document.getElementById(labelledBy ?? '')?.textContent).toBe('Apply plan-1');
  });

  it('moves focus into the dialog so the keyboard is not left behind it', () => {
    renderDialog();

    expect(document.activeElement).toBe(screen.getByRole('button', { name: 'Cancel' }));
  });

  it('confirms and cancels through their own buttons', () => {
    const { onConfirm, onCancel } = renderDialog();

    fireEvent.click(screen.getByRole('button', { name: 'Apply' }));
    expect(onConfirm).toHaveBeenCalledTimes(1);

    fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('cancels on Escape', () => {
    const { onCancel } = renderDialog();

    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });

    expect(onCancel).toHaveBeenCalledTimes(1);
  });

  it('keeps Tab inside the dialog in both directions', () => {
    renderDialog();
    const cancel = screen.getByRole('button', { name: 'Cancel' });
    const confirm = screen.getByRole('button', { name: 'Apply' });

    confirm.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab' });
    expect(document.activeElement).toBe(cancel);

    cancel.focus();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Tab', shiftKey: true });
    expect(document.activeElement).toBe(confirm);
  });

  it('disables both controls while the confirmed work is in flight', () => {
    const { onConfirm, onCancel } = renderDialog({ busy: true });

    const confirm = screen.getByRole('button', { name: 'Apply' }) as HTMLButtonElement;
    const cancel = screen.getByRole('button', { name: 'Cancel' }) as HTMLButtonElement;
    expect(confirm.disabled).toBe(true);
    expect(cancel.disabled).toBe(true);

    fireEvent.click(confirm);
    expect(onConfirm).not.toHaveBeenCalled();
    fireEvent.keyDown(screen.getByRole('dialog'), { key: 'Escape' });
    expect(onCancel).not.toHaveBeenCalled();
  });

  it('returns focus to whatever opened it', () => {
    const opener = document.createElement('button');
    document.body.append(opener);
    opener.focus();

    const { unmount } = render(
      <ConfirmDialog title="t" confirmLabel="Go" onConfirm={vi.fn()} onCancel={vi.fn()}>
        <p>body</p>
      </ConfirmDialog>,
    );
    expect(document.activeElement).not.toBe(opener);

    unmount();

    expect(document.activeElement).toBe(opener);
    opener.remove();
  });
});
