CREATE TABLE "attachments" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"uploader_id" uuid NOT NULL,
	"message_id" uuid,
	"filename" text NOT NULL,
	"mime_type" text NOT NULL,
	"size" integer NOT NULL,
	"storage_key" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canned_responses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"title" text NOT NULL,
	"body" text NOT NULL,
	"category" text,
	"created_by" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "jobs" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"type" text NOT NULL,
	"payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"status" text DEFAULT 'queued' NOT NULL,
	"run_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempts" integer DEFAULT 0 NOT NULL,
	"max_attempts" integer DEFAULT 5 NOT NULL,
	"locked_until" timestamp with time zone,
	"locked_by" text,
	"last_error" text,
	"dedupe_key" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"finished_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "login_attempts" (
	"id" bigserial PRIMARY KEY NOT NULL,
	"email" text NOT NULL,
	"ip" text NOT NULL,
	"attempted_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "messages" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"author_id" uuid NOT NULL,
	"body" text NOT NULL,
	"internal" boolean DEFAULT false NOT NULL,
	"client_message_id" uuid,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', body)) STORED NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notifications" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"kind" text NOT NULL,
	"ticket_id" uuid NOT NULL,
	"due_at" timestamp with time zone,
	"read_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_views" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"user_id" uuid NOT NULL,
	"name" text NOT NULL,
	"query" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sessions" (
	"token_hash" text PRIMARY KEY NOT NULL,
	"user_id" uuid NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"expires_at" timestamp with time zone NOT NULL
);
--> statement-breakpoint
CREATE TABLE "sla_alerts" (
	"ticket_id" uuid NOT NULL,
	"alert" text NOT NULL,
	"sla_kind" text NOT NULL,
	"due_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "sla_alerts_ticket_id_alert_sla_kind_due_at_pk" PRIMARY KEY("ticket_id","alert","sla_kind","due_at")
);
--> statement-breakpoint
CREATE TABLE "sla_pauses" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"started_at" timestamp with time zone NOT NULL,
	"ended_at" timestamp with time zone
);
--> statement-breakpoint
CREATE TABLE "sla_policies" (
	"priority" text PRIMARY KEY NOT NULL,
	"first_response_minutes" integer NOT NULL,
	"resolution_minutes" integer NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" uuid
);
--> statement-breakpoint
CREATE TABLE "ticket_counter" (
	"id" smallint PRIMARY KEY DEFAULT 1 NOT NULL,
	"value" integer DEFAULT 0 NOT NULL,
	CONSTRAINT "ticket_counter_single_row_ck" CHECK ("ticket_counter"."id" = 1)
);
--> statement-breakpoint
CREATE TABLE "ticket_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"ticket_id" uuid NOT NULL,
	"actor_id" uuid,
	"field" text NOT NULL,
	"from_value" text,
	"to_value" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "ticket_reads" (
	"user_id" uuid NOT NULL,
	"ticket_id" uuid NOT NULL,
	"last_read_at" timestamp with time zone NOT NULL,
	CONSTRAINT "ticket_reads_user_id_ticket_id_pk" PRIMARY KEY("user_id","ticket_id")
);
--> statement-breakpoint
CREATE TABLE "tickets" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"number" integer NOT NULL,
	"subject" text NOT NULL,
	"category" text NOT NULL,
	"priority" text NOT NULL,
	"priority_rank" smallint GENERATED ALWAYS AS (case priority when 'urgent' then 3 when 'high' then 2 when 'normal' then 1 else 0 end) STORED,
	"status" text DEFAULT 'new' NOT NULL,
	"customer_id" uuid NOT NULL,
	"assignee_id" uuid,
	"tags" text[] DEFAULT '{}' NOT NULL,
	"version" integer DEFAULT 0 NOT NULL,
	"parent_ticket_id" uuid,
	"first_response_due_at" timestamp with time zone,
	"resolution_due_at" timestamp with time zone,
	"first_responded_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"next_due_at" timestamp with time zone,
	"sla_sort_at" timestamp with time zone NOT NULL,
	"sla_paused_at" timestamp with time zone,
	"sla_breached_first" boolean DEFAULT false NOT NULL,
	"sla_breached_resolution" boolean DEFAULT false NOT NULL,
	"last_message_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_customer_message_at" timestamp with time zone,
	"last_staff_reply_at" timestamp with time zone,
	"rating_score" smallint,
	"rating_comment" text,
	"rated_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"search_vector" "tsvector" GENERATED ALWAYS AS (to_tsvector('simple', subject)) STORED NOT NULL,
	CONSTRAINT "tickets_status_ck" CHECK ("tickets"."status" in ('new', 'open', 'pending', 'resolved', 'closed')),
	CONSTRAINT "tickets_priority_ck" CHECK ("tickets"."priority" in ('low', 'normal', 'high', 'urgent')),
	CONSTRAINT "tickets_category_ck" CHECK ("tickets"."category" in ('billing', 'delivery', 'account', 'technical', 'other')),
	CONSTRAINT "tickets_rating_ck" CHECK ("tickets"."rating_score" is null or "tickets"."rating_score" between 1 and 5)
);
--> statement-breakpoint
CREATE TABLE "users" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"email" text NOT NULL,
	"name" text NOT NULL,
	"role" text NOT NULL,
	"categories" text[] DEFAULT '{}' NOT NULL,
	"password_hash" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "users_role_ck" CHECK ("users"."role" in ('customer', 'agent', 'lead'))
);
--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_uploader_id_users_id_fk" FOREIGN KEY ("uploader_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "attachments" ADD CONSTRAINT "attachments_message_id_messages_id_fk" FOREIGN KEY ("message_id") REFERENCES "public"."messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canned_responses" ADD CONSTRAINT "canned_responses_created_by_users_id_fk" FOREIGN KEY ("created_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "messages" ADD CONSTRAINT "messages_author_id_users_id_fk" FOREIGN KEY ("author_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notifications" ADD CONSTRAINT "notifications_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "saved_views" ADD CONSTRAINT "saved_views_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sessions" ADD CONSTRAINT "sessions_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_alerts" ADD CONSTRAINT "sla_alerts_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_pauses" ADD CONSTRAINT "sla_pauses_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "sla_policies" ADD CONSTRAINT "sla_policies_updated_by_users_id_fk" FOREIGN KEY ("updated_by") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_events" ADD CONSTRAINT "ticket_events_actor_id_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_reads" ADD CONSTRAINT "ticket_reads_user_id_users_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."users"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "ticket_reads" ADD CONSTRAINT "ticket_reads_ticket_id_tickets_id_fk" FOREIGN KEY ("ticket_id") REFERENCES "public"."tickets"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_customer_id_users_id_fk" FOREIGN KEY ("customer_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_assignee_id_users_id_fk" FOREIGN KEY ("assignee_id") REFERENCES "public"."users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tickets" ADD CONSTRAINT "tickets_parent_ticket_id_tickets_id_fk" FOREIGN KEY ("parent_ticket_id") REFERENCES "public"."tickets"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "attachments_message_idx" ON "attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "attachments_orphan_idx" ON "attachments" USING btree ("created_at") WHERE message_id is null;--> statement-breakpoint
CREATE UNIQUE INDEX "jobs_dedupe_uq" ON "jobs" USING btree ("dedupe_key");--> statement-breakpoint
CREATE INDEX "jobs_ready_idx" ON "jobs" USING btree ("run_at") WHERE status in ('queued', 'running');--> statement-breakpoint
CREATE INDEX "jobs_finished_idx" ON "jobs" USING btree ("finished_at") WHERE status in ('done', 'failed');--> statement-breakpoint
CREATE INDEX "login_attempts_email_idx" ON "login_attempts" USING btree ("email","attempted_at");--> statement-breakpoint
CREATE INDEX "login_attempts_ip_idx" ON "login_attempts" USING btree ("ip","attempted_at");--> statement-breakpoint
CREATE INDEX "messages_ticket_created_idx" ON "messages" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "messages_author_client_id_uq" ON "messages" USING btree ("author_id","client_message_id");--> statement-breakpoint
CREATE INDEX "messages_search_gin" ON "messages" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "messages_public_search_gin" ON "messages" USING gin ("search_vector") WHERE not internal;--> statement-breakpoint
CREATE INDEX "messages_author_created_idx" ON "messages" USING btree ("author_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_created_idx" ON "notifications" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "notifications_user_unread_idx" ON "notifications" USING btree ("user_id") WHERE read_at is null;--> statement-breakpoint
CREATE INDEX "saved_views_user_idx" ON "saved_views" USING btree ("user_id","created_at");--> statement-breakpoint
CREATE INDEX "sessions_user_idx" ON "sessions" USING btree ("user_id");--> statement-breakpoint
CREATE INDEX "sessions_expires_idx" ON "sessions" USING btree ("expires_at");--> statement-breakpoint
CREATE INDEX "sla_pauses_ticket_idx" ON "sla_pauses" USING btree ("ticket_id","started_at");--> statement-breakpoint
CREATE UNIQUE INDEX "sla_pauses_open_uq" ON "sla_pauses" USING btree ("ticket_id") WHERE ended_at is null;--> statement-breakpoint
CREATE INDEX "ticket_events_ticket_idx" ON "ticket_events" USING btree ("ticket_id","created_at");--> statement-breakpoint
CREATE INDEX "ticket_events_field_idx" ON "ticket_events" USING btree ("field","to_value","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tickets_number_uq" ON "tickets" USING btree ("number");--> statement-breakpoint
CREATE INDEX "tickets_search_gin" ON "tickets" USING gin ("search_vector");--> statement-breakpoint
CREATE INDEX "tickets_tags_gin" ON "tickets" USING gin ("tags");--> statement-breakpoint
CREATE INDEX "tickets_sla_sort_idx" ON "tickets" USING btree ("sla_sort_at","id");--> statement-breakpoint
CREATE INDEX "tickets_created_idx" ON "tickets" USING btree ("created_at","id");--> statement-breakpoint
CREATE INDEX "tickets_updated_idx" ON "tickets" USING btree ("updated_at","id");--> statement-breakpoint
CREATE INDEX "tickets_status_sla_idx" ON "tickets" USING btree ("status","sla_sort_at","id");--> statement-breakpoint
CREATE INDEX "tickets_status_created_idx" ON "tickets" USING btree ("status","created_at","id");--> statement-breakpoint
CREATE INDEX "tickets_assignee_status_sla_idx" ON "tickets" USING btree ("assignee_id","status","sla_sort_at","id");--> statement-breakpoint
CREATE INDEX "tickets_category_status_sla_idx" ON "tickets" USING btree ("category","status","sla_sort_at","id");--> statement-breakpoint
CREATE INDEX "tickets_category_created_idx" ON "tickets" USING btree ("category","created_at","id");--> statement-breakpoint
CREATE INDEX "tickets_category_updated_idx" ON "tickets" USING btree ("category","updated_at","id");--> statement-breakpoint
CREATE INDEX "tickets_customer_updated_idx" ON "tickets" USING btree ("customer_id","updated_at","id");--> statement-breakpoint
CREATE INDEX "tickets_customer_created_idx" ON "tickets" USING btree ("customer_id","created_at","id");--> statement-breakpoint
CREATE INDEX "tickets_parent_idx" ON "tickets" USING btree ("parent_ticket_id");--> statement-breakpoint
CREATE INDEX "tickets_queue_free_idx" ON "tickets" USING btree ("category","sla_sort_at","priority_rank","created_at") WHERE assignee_id is null and status in ('new', 'open');--> statement-breakpoint
CREATE INDEX "tickets_breached_idx" ON "tickets" USING btree ("sla_sort_at","id") WHERE sla_breached_first or sla_breached_resolution;--> statement-breakpoint
CREATE INDEX "tickets_next_due_idx" ON "tickets" USING btree ("next_due_at") WHERE next_due_at is not null;--> statement-breakpoint
CREATE INDEX "tickets_resolved_at_idx" ON "tickets" USING btree ("resolved_at") WHERE status = 'resolved';--> statement-breakpoint
CREATE UNIQUE INDEX "users_email_uq" ON "users" USING btree ("email");--> statement-breakpoint
CREATE INDEX "users_role_idx" ON "users" USING btree ("role");