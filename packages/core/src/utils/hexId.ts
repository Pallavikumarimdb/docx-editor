/**
 * Strictest OOXML `ST_LongHexNumber` upper bound (exclusive) across the
 * fields this helper feeds: `w14:paraId` / `w14:textId` / comment
 * `paraId` (`< 0x80000000`) and `w16cid:commentId/@durableId`
 * (`< 0x7FFFFFFF`). Generated ids must stay strictly below this value
 * to survive both Word ("Document Recovery — Table Properties") and
 * strict OOXML validators.
 */
export const MAX_HEX_ID_EXCLUSIVE = 0x7fffffff;

/**
 * Random 8-char uppercase hex id, matching Microsoft's `w14:paraId`
 * extension format (also reused for comment `paraId` / `durableId`).
 *
 * Range is `[0, MAX_HEX_ID_EXCLUSIVE)` = `[0, 0x7FFFFFFE]`. See
 * `MAX_HEX_ID_EXCLUSIVE` for why this exact bound.
 *
 * Uses `Math.random()` rather than `crypto.randomUUID()` so the
 * generator works in non-secure contexts (file://, web workers).
 */
export function generateHexId(): string {
  const digits = '0123456789ABCDEF';
  const bytes = [
    Math.floor(Math.random() * 128),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
    Math.floor(Math.random() * 256),
  ];

  // The all-ones value is reserved by the strictest durable-id field.
  if (bytes[0] === 0x7f && bytes[1] === 0xff && bytes[2] === 0xff && bytes[3] === 0xff) {
    bytes[3] = 0xfe;
  }

  let id = '';
  for (const byte of bytes) {
    id += digits.charAt(byte >>> 4);
    id += digits.charAt(byte & 0x0f);
  }
  return id;
}
