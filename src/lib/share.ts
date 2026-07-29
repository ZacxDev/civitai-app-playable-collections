// Share a link via the Web Share API, falling back to copy-to-clipboard.
// The navigator is injectable so the branch is deterministically testable.

export interface ShareData {
  title: string;
  text?: string;
  url: string;
}

export type ShareMethod = 'share' | 'copy' | 'none';
export interface ShareResult {
  method: ShareMethod;
  ok: boolean;
}

type ShareNavigator = {
  share?: (data: ShareData) => Promise<void>;
  clipboard?: { writeText?: (text: string) => Promise<void> };
};

/**
 * Prefer the native Web Share sheet (mobile); fall back to copying the link.
 * A user-cancelled share resolves `{ method: 'share', ok: false }` (not an
 * error to surface). Returns `{ method: 'none' }` when neither path exists.
 */
export async function shareLink(
  data: ShareData,
  nav: ShareNavigator | undefined = typeof navigator !== 'undefined' ? navigator : undefined,
): Promise<ShareResult> {
  if (nav?.share) {
    try {
      await nav.share(data);
      return { method: 'share', ok: true };
    } catch (err) {
      // User dismissed the sheet — handled, don't fall through to a copy.
      if (err instanceof DOMException && err.name === 'AbortError') return { method: 'share', ok: false };
      // Otherwise fall through to the clipboard fallback.
    }
  }
  if (nav?.clipboard?.writeText) {
    try {
      await nav.clipboard.writeText(data.url);
      return { method: 'copy', ok: true };
    } catch {
      return { method: 'none', ok: false };
    }
  }
  return { method: 'none', ok: false };
}
