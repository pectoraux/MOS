// PLANTED VIOLATION: PG_OUTSIDE_ADAPTER
// 'pg' may only be imported inside adapter implementations.
import pg from 'pg';

export const server = pg;
