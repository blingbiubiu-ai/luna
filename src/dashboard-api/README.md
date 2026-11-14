# Dashboard API Projections

`src/server/routes/*` owns HTTP parsing, auth, DB access, selection helpers, and response status decisions.

`src/dashboard-api/*` owns Dashboard DTO types and projection functions that turn selected rows into API response objects.

Extraction must not change Dashboard API response fields. Keep existing snake_case and camelCase duplicate fields when moving projections.
