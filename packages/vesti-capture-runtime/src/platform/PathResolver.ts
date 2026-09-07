/**
 * Path Resolver
 * Multi-root home abstraction: a native home (os.homedir()) plus zero or
 * more WSL distro user homes exposed over UNC paths. Adapters enumerate
 * these roots instead of a single home so sessions living inside WSL are
 * captured too. Host tags flow into work_sessions.host and session ids.
 */

import os from 'os';

export interface HomeRoot {
  /** 'native' for the host OS home, 'wsl:<distro>:<user>' for a WSL user home */
  host: string;
  /** Native: os.homedir(). WSL: UNC path like \\wsl$\Ubuntu\home\alice */
  homeDir: string;
}

export function nativeHomeRoot(): HomeRoot {
  return { host: 'native', homeDir: os.homedir() };
}

/**
 * Canonicalize one segment used in a WSL host tag. The common Linux-user
 * case stays readable (`alice`, `ubuntu-22.04`); every other UTF-8 byte is
 * escaped as `~hh`. Escaping `~` and `_` as well avoids ambiguous cleanup
 * collisions (for example a literal `~e7` can never equal an escaped byte).
 *
 * WSL user names are usually ASCII, but this keeps identity stable when a
 * distribution has an unusual name or a non-ASCII user. `~missing` is a
 * reserved sentinel: it cannot be produced by a non-empty raw segment.
 */
function encodeWslIdentitySegment(value: string, fallback = '~missing'): string {
  if (!value) return fallback;

  let result = '';
  for (const byte of Buffer.from(value, 'utf8')) {
    const isLowerAlpha = byte >= 0x61 && byte <= 0x7a;
    const isDigit = byte >= 0x30 && byte <= 0x39;
    if (isLowerAlpha || isDigit || byte === 0x2d || byte === 0x2e) {
      result += String.fromCharCode(byte);
    } else {
      result += `~${byte.toString(16).padStart(2, '0')}`;
    }
  }
  return result || fallback;
}

/**
 * Canonicalize a WSL distro segment. UNC distribution shares are
 * case-insensitive, so lower-casing their trimmed spelling is intentional.
 */
export function normalizeWslIdentitySegment(value: string, fallback = '~missing'): string {
  return encodeWslIdentitySegment(value.trim().toLowerCase(), fallback);
}

/**
 * Canonicalize a WSL user segment without case or Unicode normalization.
 * Linux user paths are case-sensitive; `Alice`, `alice`, and compatibility
 * characters and even unusual boundary whitespace must therefore remain
 * distinct identities. WslDetector supplies the directory entry verbatim.
 */
export function normalizeWslUserIdentitySegment(value: string, fallback = '~missing'): string {
  return encodeWslIdentitySegment(value, fallback);
}

/** Build the one canonical identity shared by detected WSL homes and paths. */
export function wslHostTag(distro: string, user: string): string {
  return `wsl:${normalizeWslIdentitySegment(distro)}:${normalizeWslUserIdentitySegment(user)}`;
}

/**
 * Derive the host tag for a session file path. UNC paths under
 * `\\wsl$\\<distro>\\home\\<user>` or
 * `\\wsl.localhost\\<distro>\\home\\<user>` map to
 * `wsl:<canonical-distro>:<canonical-user>`; `/root` maps to user `root`.
 * Everything else is `native`. The distro case is canonicalized because the
 * Windows UNC namespace is case-insensitive; the user segment is preserved
 * because Linux home paths are case-sensitive.
 */
export function hostFromPath(filePath: string): string {
  const segments = filePath.split(/[\\/]+/).filter(Boolean);
  const share = segments[0]?.toLowerCase();
  if ((share === 'wsl$' || share === 'wsl.localhost') && segments[1]) {
    const homeKind = segments[2]?.toLowerCase();
    const user = homeKind === 'root'
      ? 'root'
      : homeKind === 'home' ? segments[3] ?? '' : '';
    return wslHostTag(segments[1], user);
  }
  return 'native';
}

/**
 * Deterministic session-id rewrite for WSL sources. A session that exists
 * both natively and inside WSL keeps distinct WorkSession ids: native
 * stays {platform}:{sessionId}, WSL becomes
 * {platform}:wsl-<distro>~z<user>-{sessionId}. `~z` is an unambiguous
 * delimiter: canonical segments never contain it (`~` is always followed by
 * two hexadecimal bytes), so hyphens inside a distro or user cannot erase a
 * component boundary. The function also tolerates
 * pre-user legacy `wsl:<distro>` values so existing direct callers keep
 * their previous identifiers; new capture paths always use the canonical
 * three-part tag above.
 */
export function rewriteSessionIdForHost(sessionId: string, host: string): string {
  if (!host.startsWith('wsl:')) return sessionId;
  const parts = host.slice('wsl:'.length).split(':');
  const identity = parts.length === 2
    // Canonical host: retain a delimiter that cannot occur inside a segment.
    ? `${parts[0]}~z${parts[1]}`
    // Compatibility for legacy direct callers that still provide wsl:<distro>.
    : host.slice('wsl:'.length).replace(/[^\w.-]+/g, '-');
  return `wsl-${identity}-${sessionId}`;
}
