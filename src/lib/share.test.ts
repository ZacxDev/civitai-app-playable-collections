import { describe, expect, it, vi } from 'vitest';

import { shareLink } from './share.js';

const data = { title: 'Neon', text: 'Play Neon', url: 'https://x/app#c=101' };

describe('shareLink', () => {
  it('uses the Web Share API when available', async () => {
    const share = vi.fn(async () => {});
    const res = await shareLink(data, { share });
    expect(share).toHaveBeenCalledWith(data);
    expect(res).toEqual({ method: 'share', ok: true });
  });

  it('treats a user-cancelled share as handled (no clipboard fallback)', async () => {
    const share = vi.fn(async () => {
      throw new DOMException('cancelled', 'AbortError');
    });
    const writeText = vi.fn(async () => {});
    const res = await shareLink(data, { share, clipboard: { writeText } });
    expect(res).toEqual({ method: 'share', ok: false });
    expect(writeText).not.toHaveBeenCalled();
  });

  it('falls back to clipboard when share throws a non-cancel error', async () => {
    const share = vi.fn(async () => {
      throw new Error('not allowed');
    });
    const writeText = vi.fn(async () => {});
    const res = await shareLink(data, { share, clipboard: { writeText } });
    expect(writeText).toHaveBeenCalledWith(data.url);
    expect(res).toEqual({ method: 'copy', ok: true });
  });

  it('copies to clipboard when there is no Web Share API', async () => {
    const writeText = vi.fn(async () => {});
    const res = await shareLink(data, { clipboard: { writeText } });
    expect(res).toEqual({ method: 'copy', ok: true });
  });

  it('reports none when neither path is available', async () => {
    expect(await shareLink(data, {})).toEqual({ method: 'none', ok: false });
  });

  it('reports none when the clipboard write fails', async () => {
    const writeText = vi.fn(async () => {
      throw new Error('denied');
    });
    expect(await shareLink(data, { clipboard: { writeText } })).toEqual({ method: 'none', ok: false });
  });
});
