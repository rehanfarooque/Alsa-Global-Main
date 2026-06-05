export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createShippingV2ServiceRoutes } from '../../../src/generated/server/alsaglobal/shipping/v2/service_server';
import { shippingV2Handler } from '../../../server/alsaglobal/shipping/v2/handler';

export default createDomainGateway(
  createShippingV2ServiceRoutes(shippingV2Handler, serverOptions),
);
