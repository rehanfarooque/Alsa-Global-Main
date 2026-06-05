export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createImageryServiceRoutes } from '../../../src/generated/server/alsaglobal/imagery/v1/service_server';
import { imageryHandler } from '../../../server/alsaglobal/imagery/v1/handler';

export default createDomainGateway(
  createImageryServiceRoutes(imageryHandler, serverOptions),
);
