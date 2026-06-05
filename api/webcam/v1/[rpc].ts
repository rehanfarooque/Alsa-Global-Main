export const config = { runtime: 'edge' };

import { createDomainGateway, serverOptions } from '../../../server/gateway';
import { createWebcamServiceRoutes } from '../../../src/generated/server/alsaglobal/webcam/v1/service_server';
import { webcamHandler } from '../../../server/alsaglobal/webcam/v1/handler';

export default createDomainGateway(
  createWebcamServiceRoutes(webcamHandler, serverOptions),
);
