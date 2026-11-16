import type {
  ChatTicket,
  DeliveryJob,
  RequestDetail,
  RequestSummary,
} from '../../../../rayfin/functions/src/types';

import { getRayfinClient } from './rayfin-client';

export type { ChatTicket, DeliveryJob, RequestDetail, RequestSummary };

export type DiscoveryResult<T = unknown> = { ok: boolean; data?: T; error?: string };

const TIMEOUT = { timeoutMs: 90_000 };
const LONG = { timeoutMs: 230_000 };

async function fns() {
  return (await getRayfinClient()).functions;
}

export const api = {
  whoAmI: async () => (await fns()).whoAmI.invoke(undefined as never, TIMEOUT),
  listRequests: async () => (await fns()).listRequests.invoke(undefined as never, TIMEOUT),
  getRequest: async (queryMasterId: number) => (await fns()).getRequest.invoke({ queryMasterId }, TIMEOUT),
  decide: async (queryMasterId: number, decision: 'APPROVED' | 'REJECTED', comment: string) =>
    (await fns()).decideRequest.invoke({ queryMasterId, decision, comment }, TIMEOUT),
  startDelivery: async (queryMasterId: number, demoMode: boolean) =>
    (await fns()).startDelivery.invoke({ queryMasterId, demoMode }, TIMEOUT),
  getDelivery: async (queryMasterId: number) => (await fns()).getDelivery.invoke({ queryMasterId }, TIMEOUT),
  /** One Discovery action (a chat tool or a page action) on the server; failures come back as {ok: false, error}. */
  discovery: async <T = unknown>(action: string, args: unknown): Promise<DiscoveryResult<T>> => {
    const raw: unknown = await (await fns()).discovery.invoke({ action, payload: JSON.stringify(args ?? {}) }, LONG);
    // The function returns JSON text; the Rayfin client hands it back already parsed.
    return (typeof raw === 'string' ? JSON.parse(raw) : raw) as DiscoveryResult<T>;
  },
  chatTicket: async () => (await fns()).chatTicket.invoke(undefined as never, TIMEOUT),
};

/** The message of a failed function call, without the SDK's wrapping. */
export function errorText(error: unknown): string {
  const raw = error instanceof Error ? error.message : String(error);
  return raw.replace(/^.*?(There is no|Request \d|The decision|Fabric did not|Give the|Could not tell|The approval app)/s, '$1');
}
