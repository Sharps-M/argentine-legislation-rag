import { checkHealth } from "@/server/health";
import { databaseProbe } from "@/server/health-probe";

export async function GET() {
  const report = await checkHealth(databaseProbe);

  return Response.json(report, { status: report.status === "ok" ? 200 : 503 });
}
