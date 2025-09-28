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

// Add this function BEFORE the default export
async function directVectorSearch(env: RouterEnv, q: string, k: number = 5) {
  if (!env.MEM || !env.AI) {
    return { warn: "Missing bindings" };
  }

  const model = env.EMBED_MODEL || "@cf/baai/bge-base-en-v1.5";
  const out = await env.AI.run(model, { text: q.trim().slice(0, 512) });
  
  if (!out.data?.[0] || !Array.isArray(out.data[0]) || out.data[0].length !== 768) {
    return { warn: "Failed to generate embedding" };
  }

  const vector = out.data[0].map(Number);
  
  try {
    // Cast to the expected Vectorize type
    const result = await (env.MEM as any).query({ 
      vector: vector as number[], 
      topK: Math.max(1, Math.min(25, k)) 
    });
    return result;
  } catch (e: any) {
    return { warn: "Vector search failed", debug: String(e.message) };
  }
}

export default {
  async fetch(req: Request, env: RouterEnv): Promise<Response> {
    const url = new URL(req.url);
    if (url.pathname === "/__ping") return new Response("pong");

    // Handle vector search directly in the main worker
    if (url.pathname === "/vector_search" && req.method === "POST") {
      const { q, k } = await req.json() as { q: string; k?: number };
      if (!q) return new Response(JSON.stringify({ error: "Missing { q }" }), { 
        status: 400, 
        headers: { "content-type": "application/json" } 
      });
      const out = await directVectorSearch(env, q, k ?? 5);
      return new Response(JSON.stringify(out), { 
        headers: { "content-type": "application/json" } 
      });
    }

    const agentPaths = [
      "/dataset_stream",
      "/run_stream",
      "/vector_search_multi",  // Remove /vector_search from here
      "/export_csv",
      "/replan_charts",
    ];
    if (agentPaths.includes(url.pathname)) {
      const name = url.searchParams.get("name") ?? "singleton";
      const agent = await getAgentByName<AgentEnv, DataAgent>(env.DataAgent, name);
      return agent.fetch(req);
    }

    return env.ASSETS.fetch(req);
  }
};