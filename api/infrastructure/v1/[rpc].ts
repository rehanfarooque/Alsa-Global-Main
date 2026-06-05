export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createInfrastructureServiceRoutes } from '../../../src/generated/server/alsaglobal/infrastructure/v1/service_server';
import { infrastructureHandler } from '../../../server/alsaglobal/infrastructure/v1/handler';

export default createDomainGateway(
  createInfrastructureServiceRoutes(infrastructureHandler, serverOptions),
);
