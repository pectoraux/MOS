/**
 * fetch-based HttpCallPort adapter (MKT-011).
 *
 * Wired at the composition root. Enforces the fail-closed envelope
 * (https-or-loopback, deadline, bounded response body). Transport failures
 * are RETURNED as data per the port contract — the task runner owns the
 * error taxonomy mapping.
 */

import { httpCallRequestProblem, type HttpCallPort, type HttpCallRequest, type HttpCallResponse } from './outbound.ts';

export class FetchHttpCall implements HttpCallPort {
  async request(request: HttpCallRequest): Promise<HttpCallResponse> {
    const problem = httpCallRequestProblem(request);
    if (problem !== null) {
      throw new Error(`invalid outbound http call: ${problem}`);
    }

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), request.timeoutMs);
    try {
      const response = await fetch(request.url, {
        method: request.method,
        headers: { ...request.headers },
        body: request.body,
        signal: controller.signal,
        redirect: 'manual',
      });

      const headers: Record<string, string> = {};
      response.headers.forEach((value, key) => {
        headers[key] = value;
      });

      const contentLength = Number(response.headers.get('content-length') ?? '0');
      if (Number.isFinite(contentLength) && contentLength > request.sizeCapBytes) {
        // Bounded response: never buffer an oversized body.
        return {
          status: response.status,
          headers,
          body: '',
          transportRefused: false,
          timedOut: false,
        };
      }

      const buffer = await response.arrayBuffer();
      if (buffer.byteLength > request.sizeCapBytes) {
        return {
          status: response.status,
          headers,
          body: '',
          transportRefused: false,
          timedOut: false,
        };
      }
      return {
        status: response.status,
        headers,
        body: new TextDecoder().decode(buffer),
        transportRefused: false,
        timedOut: false,
      };
    } catch (error) {
      if (error instanceof DOMException && error.name === 'AbortError') {
        return {
          status: 0,
          headers: {},
          body: '',
          transportRefused: false,
          timedOut: true,
        };
      }
      // Connection refused / DNS / network unreachable: the request was not
      // processed (no side effect possible on the remote side).
      return {
        status: 0,
        headers: {},
        body: '',
        transportRefused: true,
        timedOut: false,
      };
    } finally {
      clearTimeout(timer);
    }
  }
}
