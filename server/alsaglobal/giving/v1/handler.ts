import type { GivingServiceHandler } from '../../../../src/generated/server/alsaglobal/giving/v1/service_server';

import { getGivingSummary } from './get-giving-summary';

export const givingHandler: GivingServiceHandler = {
  getGivingSummary,
};
