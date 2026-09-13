import { recordAuditEvent } from "@scout/db";

/**
 * Notifications to the humans who approve. Best effort: a webhook that is
 * down changes nothing about the proposal, which waits either way, and the
 * failure is audited so nobody assumes the message arrived.
 */
export async function notify(kind: "proposal" | "scope-expansion" | "delivery", payload: Record<string, unknown>, envName = "AGENT_APPROVAL_WEBHOOK"): Promise<{ sent: boolean; status: number | null }> {
  const url = process.env[envName]?.trim() ?? "";
  if (url === "") return { sent: false, status: null };
  try {
    const response = await fetch(url, {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ event: kind, at: new Date().toISOString(), ...payload }), signal: AbortSignal.timeout(10_000),
    });
    if (!response.ok) await recordAuditEvent({ action: "v2.agent.webhook.failed", actor: "agent", detail: { kind, envName, status: response.status } });
    return { sent: response.ok, status: response.status };
  } catch (caught) {
    await recordAuditEvent({ action: "v2.agent.webhook.failed", actor: "agent", detail: { kind, envName, message: caught instanceof Error ? caught.message : String(caught) } });
    return { sent: false, status: null };
  }
}
