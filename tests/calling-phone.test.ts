import { describe, expect, it } from 'vitest';
import { toDialablePhone } from '../src/features/os/calling/phone.js';

describe('device SIM dial strings', () => {
  it('formats an Indian mobile for the employee handset', () => {
    expect(toDialablePhone('9876543210')).toEqual({ e164: '+919876543210', telUri: 'tel:+919876543210' });
    expect(toDialablePhone('+91 98765 43210')).toEqual({ e164: '+919876543210', telUri: 'tel:+919876543210' });
    expect(toDialablePhone('09876543210')?.e164).toBe('+919876543210');
  });

  it('keeps an international number and rejects junk', () => {
    expect(toDialablePhone('+1 415 555 2671')?.e164).toBe('+14155552671');
    expect(toDialablePhone('12')).toBeNull();
    expect(toDialablePhone('')).toBeNull();
    expect(toDialablePhone('call me')).toBeNull();
  });
});
