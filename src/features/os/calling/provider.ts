import { ValidationError } from '../../../shared/errors/index.js';
import { toDialablePhone } from './phone.js';

export type CallProviderId = 'device_sim' | 'voip';

/**
 * A provider prepares a call. It does not own CRM records.
 * `device_sim` is free and uses the employee's own phone. It cannot see
 * carrier events: a `tel:` link never reports connect, hangup, or duration.
 * A future VoIP provider can implement the same interface and be registered below.
 */
export interface DialPlan {
  provider: CallProviderId;
  telUri: string;
  phone: string;
  paid: boolean;
  reportsCarrierEvents: boolean;
}

export interface CallProvider {
  id: CallProviderId;
  paid: boolean;
  reportsCarrierEvents: boolean;
  prepare(rawPhone: string): DialPlan;
}

class DeviceSimProvider implements CallProvider {
  id = 'device_sim' as const;
  paid = false;
  reportsCarrierEvents = false;

  prepare(rawPhone: string): DialPlan {
    const dial = toDialablePhone(rawPhone);
    if (!dial) throw new ValidationError('This lead does not have a callable phone number');
    return {
      provider: this.id,
      telUri: dial.telUri,
      phone: dial.e164,
      paid: false,
      reportsCarrierEvents: false,
    };
  }
}

const providers: Partial<Record<CallProviderId, CallProvider>> = {
  device_sim: new DeviceSimProvider(),
};

export function getCallProvider(id: CallProviderId = 'device_sim'): CallProvider {
  const provider = providers[id];
  if (!provider) throw new ValidationError('That calling provider is not available');
  return provider;
}
