-- Gap-free ticket numbering: one counter row, incremented inside the ticket insert transaction.
INSERT INTO "ticket_counter" ("id", "value") VALUES (1, 1000) ON CONFLICT DO NOTHING;
--> statement-breakpoint
-- Default SLA policies from the assignment, in business minutes (1 business day = 9h = 540 min).
INSERT INTO "sla_policies" ("priority", "first_response_minutes", "resolution_minutes") VALUES
  ('urgent', 60, 240),
  ('high', 240, 540),
  ('normal', 540, 1620),
  ('low', 1080, 2700)
ON CONFLICT DO NOTHING;
