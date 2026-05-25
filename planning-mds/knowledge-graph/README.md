# Knowledge Graph (this product's data)

The yaml files in this directory are this product's knowledge-graph data.
They are queried by the CLIs at `scripts/kg/` (e.g. `lookup.py`,
`hint.py`, `blast.py`).

**How the KG works, who maintains what, and how agents use it during
planning and implementation** is documented framework-side at:

- `nebula-agents/agents/docs/KNOWLEDGE-GRAPH.md`

That doc covers the mental model, file inventory, AST extraction
(Roslyn / ts-morph / Python ast), query CLIs, lifecycle triggers, health
checks, and failure modes. It is the same for every product built with
the framework.
