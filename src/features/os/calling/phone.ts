/**
 * Turns a lead phone into a dial string for the employee's own handset.
 * This does not place the call. The browser only receives a `tel:` URI.
 */
export function toDialablePhone(raw?: string | null): { e164: string; telUri: string } | null {
  if (!raw?.trim()) return null;
  const cleaned = raw.trim().replace(/[^\d+]/g, '');
  let digits = cleaned.replace(/\D/g, '');
  if (digits.length < 8 || digits.length > 15) return null;

  if (!cleaned.startsWith('+')) {
    if (digits.length === 10) digits = `91${digits}`;
    else if (digits.length === 11 && digits.startsWith('0')) digits = `91${digits.slice(1)}`;
  }

  const e164 = `+${digits}`;
  return { e164, telUri: `tel:${e164}` };
}
