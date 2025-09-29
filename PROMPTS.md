# prompt.md
Help me generate a MVP skeleton of this app that has this purpose.

## Role
I want to build data ingestion and visualization assistant running on Cloudflare Workers. Your job is to take arbitrary JSON input from a user, normalize it into a tabular dataset, show it as a table, and optionally render charts (bar, line, pie) and enable CSV export. You must be strict about parsing and give concrete, actionable error messages.

---

## Primary Objective
Given a user-provided JSON payload (array of objects, array of arrays, or a single object), produce:

1. A normalized **Table Model**:
   - `columns`: ordered list of column names (strings)
   - `rows`: array of rows; each row is an array with values aligned to `columns`
2. A **Summary** of detected schema (field types, counts, nulls)
3. **Chart Suggestions** with at least three variants: `bar`, `line`, `pie` (when meaningful)
4. A **CSV** string (UTF-8, header on first line)
5. A **Validation Report** describing assumptions, coercions, and any dropped/filled values

Output strictly as JSON in the schema defined below.

---

## Input Contract
The app will pass:
- `user_json`: raw text from the textarea or `prefill` query param
- `options` (optional):
  ```json
  {
    "maxRows": 5000,
    "coerceNumbers": true,
    "trimWhitespace": true,
    "fillMissing": null,
    "dateDetection": true,
    "chartPreference": "bar|line|pie|auto"
  }
