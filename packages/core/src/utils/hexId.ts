/**
 * Random 8-char uppercase hex id, matching Microsoft's `w14:paraId`
 * extension format (also reused for comment `paraId` / `durableId`).
 *
 * Uses `Math.random()` rather than `crypto.randomUUID()` so the
 * generator works in non-secure contexts (file://, web workers).
 */
export function generateHexId(): string {
  const digits = '0123456789ABCDEF';
  const bytes = Array.from({ length: 4 }, () => Math.floor(Math.random() * 256));
  let id = '';
  for (const byte of bytes) {
    id += digits.charAt(byte >>> 4);
    id += digits.charAt(byte & 0x0f);
  }
  return id;
}
