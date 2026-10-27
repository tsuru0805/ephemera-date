// Where requests go and with which credential: read from the session (host init, standalone login, or demo).
import { getSession } from "../runtime/session";

export const storage = {
  async getToken(): Promise<string | null> { return getSession().credential; },
  async getBase(): Promise<string> { return getSession().apiBase; },
};
