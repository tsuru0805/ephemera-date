// fetch for the pages: the real engine, or the in-page demo engine in demo mode.
import { demoFetch } from "../demo/server";
import { isDemo } from "../runtime/session";

export function apiFetch(url: string, init?: RequestInit): Promise<Response> {
  return isDemo() ? demoFetch(url, init) : fetch(url, init);
}
