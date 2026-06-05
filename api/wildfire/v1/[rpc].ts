export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createWildfireServiceRoutes } from '../../../src/generated/server/alsaglobal/wildfire/v1/service_server';
import { wildfireHandler } from '../../../server/alsaglobal/wildfire/v1/handler';

export default createDomainGateway(
  createWildfireServiceRoutes(wildfireHandler, serverOptions),
);
