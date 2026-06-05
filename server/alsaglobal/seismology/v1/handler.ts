import type { SeismologyServiceHandler } from '../../../../src/generated/server/alsaglobal/seismology/v1/service_server';

import { listEarthquakes } from './list-earthquakes';

export const seismologyHandler: SeismologyServiceHandler = {
  listEarthquakes,
};
