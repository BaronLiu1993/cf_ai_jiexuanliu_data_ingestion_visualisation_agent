import DataAgent, { type AgentEnv } from "./agent";
export { DataAgent }; // required export for Durable Object binding

import type { AgentNamespace } from "agents";
import { getAgentByName } from "agents";

export interface RouterEnv {
  DataAgent: AgentNamespace<DataAgent>;
  ASSETS: Fetcher;
  AI: any;
  WORKERS_AI_MODEL?: string;
  MEM?: VectorizeIndex;
  EMBED_MODEL?: string;
}

export default {
  async fetch(req: Request, env: RouterEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__ping") return new Response("pong");

    // All agent-related paths are now handled by the Durable Object
    const agentPaths = [
      "/dataset_stream",
      "/run_stream",
      "/vector_search", // <-- ADDED THIS
      "/vector_search_multi",
      "/export_csv",
      "/replan_charts",
    ];
    if (agentPaths.includes(url.pathname)) {
      const name = url.searchParams.get("name") ?? "singleton";
      const agent = await getAgentByName<AgentEnv, DataAgent>(env.DataAgent, name);
      return agent.fetch(req);
    }

    return env.ASSETS.fetch(req);
  },
};