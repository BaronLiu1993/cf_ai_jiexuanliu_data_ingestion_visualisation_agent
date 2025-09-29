# Cloudflare Documentation

An AI-powered data ingestion and visualization agent built with Cloudflare Workers AI. This project automatically fetches API data, transforms it into structured formats, and enables both **semantic search** and **data visualization**.

## Project Overview

**Models Used:**

- **Worker AI Model:** `@cf/meta/llama-3.1-8b-instruct`
- **Embedding Model:** `@cf/baai/bge-base-en-v1.5`

**Architecture:**

1. **Data Ingestion** – The AI Worker fetches API data from a user-provided endpoint.
2. **Transformation** – Data is converted into a structured **CSV table** for readability.
3. **Embedding** – Each row is embedded into a **vector database** for similarity search.
4. **Visualization** – The system generates **custom graphs** for numerical fields.
5. **Memory Handling:**
   - **Short-Term Memory:** Retains recent ingested data for regenerating tables and graphs.
   - **Long-Term Memory:** Managed via Cloudflare Durable Objects\*, ensuring persistent data storage across sessions.

## Features

- **API Auto-Ingestion**: Just provide any (preferably public, no-auth) API URL.
- **Automatic Structuring**: Raw JSON → clean tabular format.
- **Vector Search**: Semantic search over ingested rows using embeddings.
- **Data Visualizations**: Instant graph generation from numerical data.
- **Durable Memory**: Short- and long-term persistence with Cloudflare Durable Objects.

## Instructions

1. Visit: **[Cloudflare AI Agent Demo](https://falling-bonus-907a.baronliu1993.workers.dev/)**
2. Enter a Sample JSON of what you want to convert to table data:
   ### Sample JSON
   ```json
   {
   	"data": [
   		{ "month": "2024-01", "visits": 1200 },
   		{ "month": "2024-02", "visits": 1500 },
   		{ "month": "2024-03", "visits": 1700 },
   		{ "month": "2024-04", "visits": 1600 },
   		{ "month": "2024-05", "visits": 2100 },
   		{ "month": "2024-06", "visits": 2500 },
   		{ "month": "2024-07", "visits": 2300 },
   		{ "month": "2024-08", "visits": 2800 },
   		{ "month": "2024-09", "visits": 3000 },
   		{ "month": "2024-10", "visits": 3200 },
   		{ "month": "2024-11", "visits": 3100 },
   		{ "month": "2024-12", "visits": 3500 }
   	]
   }
   ```
3. The agent will:
   - Fetch and parse the API data
   - Display it as a **CSV-style table**
   - Generate **vector embeddings** for search
   - Create **graphs** if numerical data is detected
   - Analyses and gives key insights on what the data is trying to tell you and key metrics such as IQR, Mean, Median and other statistics.

4. Use the interface to regenerate, search, or visualize data as needed.

---

## Tech Stack

- **Cloudflare Workers AI** – Serverless AI execution at the edge
- **Cloudflare Durable Objects** – State management & long-term memory
- **Vector Database (Embeddings)** – Enables semantic search
- **Custom Graph Generator** – Turns API numbers into charts
