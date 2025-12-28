/**
 * Embedded Token for MemberSync Role
 * This token is used by the memberSync role to sync data to GitHub
 * without requiring manual token configuration.
 * 
 * The token is obfuscated using base64 encoding and split storage.
 * This is not meant to be highly secure (code can be inspected),
 * but prevents casual exposure.
 */

// Token parts (base64 encoded, split for obfuscation)
const _p1 = 'Z2hwX3lHUVdM';
const _p2 = 'T2E0RFdRZjRl';
const _p3 = 'VXNuWGlycUxZ';
const _p4 = 'NUd5bGVVQjMw';
const _p5 = 'a0VxRA==';

// Reassemble and decode
const _decode = (s: string): string => {
  try {
    return atob(s);
  } catch {
    return '';
  }
};

/**
 * Get the embedded GitHub token for memberSync role
 * @returns The decoded GitHub token
 */
export const getEmbeddedToken = (): string => {
  return _decode(_p1 + _p2 + _p3 + _p4 + _p5);
};

/**
 * Check if embedded token is available
 */
export const hasEmbeddedToken = (): boolean => {
  const token = getEmbeddedToken();
  return token.length > 0 && token.startsWith('ghp_');
};

