-- Opt-in workspace name (customer dashboard label).
--
-- A workspace MAY carry an optional plaintext `name` the SERVER stores and the
-- customer web dashboard renders. This is a DELIBERATE, CONSENSUAL metadata trade
-- (the server learns the label) and is OPT-IN / DEFAULT-OFF: absent a name the row
-- stays NULL and the zero-knowledge "names live only on your devices" promise holds.
--
-- Semantics: set ONCE at create by the first host (`rbox init`) — first-writer-wins,
-- since the row is INSERTed exactly once. No web edit / no PATCH route; the write gate
-- stays closed. `name` is opaque user text (sanitized + length-bounded on write), NOT a
-- path with meaning to the server — just a label. Existing rows keep name = NULL.

ALTER TABLE workspaces ADD COLUMN name TEXT;  -- NULL = no name (private default)
