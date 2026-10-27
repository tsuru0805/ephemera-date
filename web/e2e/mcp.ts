// A bare MCP client over Streamable HTTP (JSON-RPC): the "AI" that writes a date through the engine's /mcp,
// the same path any MCP client takes. Used by the standalone and iframe end-to-end runs.
export class Mcp {
  private sid: string | null = null;
  private n = 0;
  private url: string;
  private token: string;
  constructor(url: string, token: string) { this.url = url; this.token = token; }
  private async rpc(method: string, params?: unknown, notify = false) {
    const r = await fetch(this.url, {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json, text/event-stream", Authorization: `Bearer ${this.token}`,
        ...(this.sid ? { "mcp-session-id": this.sid } : {}) },
      body: JSON.stringify(notify ? { jsonrpc: "2.0", method, params } : { jsonrpc: "2.0", id: ++this.n, method, params }),
    });
    this.sid = r.headers.get("mcp-session-id") ?? this.sid;
    if (notify) return null;
    const text = await r.text();
    const line = text.split("\n").find((l) => l.startsWith("data:"));
    const msg = JSON.parse(line ? line.slice(5) : text);
    if (msg.error) throw new Error(`${method}: ${JSON.stringify(msg.error)}`);
    return msg.result;
  }
  async init() {
    await this.rpc("initialize", { protocolVersion: "2025-03-26", capabilities: {}, clientInfo: { name: "e2e", version: "0" } });
    await this.rpc("notifications/initialized", {}, true);
  }
  async tools(): Promise<Array<{ name: string; inputSchema: unknown }>> { return (await this.rpc("tools/list", {})).tools; }
  async call(name: string, args: Record<string, unknown>): Promise<string> {
    const res = await this.rpc("tools/call", { name, arguments: args });
    const text = (res.content ?? []).map((c: { text?: string }) => c.text ?? "").join("\n");
    if (res.isError) throw new Error(`${name}: ${text}`);
    return text;
  }
}
