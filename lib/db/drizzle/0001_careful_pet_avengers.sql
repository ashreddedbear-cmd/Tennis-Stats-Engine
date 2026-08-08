CREATE TABLE "legal_consents" (
	"id" serial PRIMARY KEY NOT NULL,
	"context" text NOT NULL,
	"email" text,
	"agreed_terms" text DEFAULT 'true' NOT NULL,
	"agreed_privacy" text DEFAULT 'true' NOT NULL,
	"metadata" jsonb,
	"source_ip" text,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_attachments" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"message_id" integer,
	"uploaded_by_user_id" text,
	"file_name" text NOT NULL,
	"file_type" text NOT NULL,
	"file_size_bytes" integer,
	"data_uri" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_messages" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_id" integer NOT NULL,
	"sender_user_id" text,
	"sender_role" text NOT NULL,
	"sender_name" text,
	"message" text NOT NULL,
	"is_internal_note" boolean DEFAULT false NOT NULL,
	"is_read_by_user" boolean DEFAULT false NOT NULL,
	"is_read_by_admin" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "support_tickets" (
	"id" serial PRIMARY KEY NOT NULL,
	"ticket_number" text,
	"clerk_user_id" text,
	"category" text NOT NULL,
	"subject" text DEFAULT '' NOT NULL,
	"status" text DEFAULT 'open' NOT NULL,
	"priority" text DEFAULT 'normal' NOT NULL,
	"assigned_admin_id" text,
	"source_route" text,
	"app_version" text,
	"device_info" text,
	"user_name" text,
	"user_email" text,
	"subscription_plan" text,
	"is_trialing" text,
	"account_role" text,
	"resolved_at" timestamp with time zone,
	"closed_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"name" text,
	"email" text,
	"message" text,
	"request_type" text,
	"metadata" jsonb,
	"source_ip" text,
	"user_agent" text
);
--> statement-breakpoint
CREATE TABLE "admin_audit_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"admin_id" text DEFAULT 'owner' NOT NULL,
	"target_clerk_user_id" text NOT NULL,
	"target_email" text,
	"action" text NOT NULL,
	"previous_value" jsonb,
	"new_value" jsonb,
	"reason" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "admin_user_notes" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"note" text DEFAULT '' NOT NULL,
	"account_status" text DEFAULT 'active' NOT NULL,
	"complimentary_plan" text,
	"complimentary_expires_at" timestamp with time zone,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_by" text DEFAULT 'owner' NOT NULL
);
--> statement-breakpoint
CREATE TABLE "saved_prediction_cards" (
	"id" serial PRIMARY KEY NOT NULL,
	"clerk_user_id" text NOT NULL,
	"prediction_id" integer NOT NULL,
	"note" text,
	"saved_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_matches" (
	"id" text PRIMARY KEY NOT NULL,
	"match_key" text NOT NULL,
	"player_a_id" text NOT NULL,
	"player_b_id" text NOT NULL,
	"tournament_name" text,
	"normalized_tournament_name" text,
	"tour" text,
	"event_level" text,
	"match_date" timestamp with time zone,
	"round" text,
	"surface" text,
	"draw_type" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "canonical_players" (
	"id" text PRIMARY KEY NOT NULL,
	"display_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"tour" text,
	"nationality" text,
	"date_of_birth" timestamp with time zone,
	"handedness" text,
	"height_cm" integer,
	"active_from" timestamp with time zone,
	"active_to" timestamp with time zone,
	"review_status" text DEFAULT 'approved' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "historical_feature_diagnostics" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_player_id" text NOT NULL,
	"requested_at" timestamp with time zone DEFAULT now() NOT NULL,
	"matches_found" integer DEFAULT 0 NOT NULL,
	"date_from" timestamp with time zone,
	"date_to" timestamp with time zone,
	"surface_matches_found" integer DEFAULT 0 NOT NULL,
	"opponent_quality_sample" integer DEFAULT 0 NOT NULL,
	"serve_return_sample_size" integer DEFAULT 0 NOT NULL,
	"resolution_method" text NOT NULL,
	"resolution_confidence" real NOT NULL,
	"source_coverage" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"fallback_reason" text,
	"historical_data_status" text NOT NULL,
	"fallback_used" boolean DEFAULT false NOT NULL,
	"lineage" jsonb DEFAULT '{}'::jsonb NOT NULL
);
--> statement-breakpoint
CREATE TABLE "match_source_links" (
	"id" text PRIMARY KEY NOT NULL,
	"canonical_match_id" text NOT NULL,
	"provider" text NOT NULL,
	"external_match_id" text NOT NULL,
	"source_payload" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"source_timestamp" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_aliases" (
	"id" text PRIMARY KEY NOT NULL,
	"provider" text NOT NULL,
	"external_player_id" text NOT NULL,
	"external_player_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"canonical_player_id" text NOT NULL,
	"alias_type" text DEFAULT 'provider-id' NOT NULL,
	"verification_status" text DEFAULT 'verified' NOT NULL,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"first_seen_at" timestamp with time zone,
	"last_seen_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "player_resolution_reviews" (
	"id" text PRIMARY KEY NOT NULL,
	"source" text NOT NULL,
	"provider" text,
	"external_player_id" text,
	"external_player_name" text NOT NULL,
	"normalized_name" text NOT NULL,
	"candidate_canonical_ids" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"resolution_method" text NOT NULL,
	"confidence" real NOT NULL,
	"supporting_metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"reason" text,
	"status" text DEFAULT 'pending' NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"reviewed_at" timestamp with time zone
);
--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "data_segment" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "used_fallback" boolean;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "fallback_sources" jsonb;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "cross_engine_agreement" boolean;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "clerk_user_id" text;--> statement-breakpoint
ALTER TABLE "predictions" ADD COLUMN "odds_status" text;--> statement-breakpoint
ALTER TABLE "evaluation_predictions" ADD COLUMN "data_segment" text DEFAULT 'live' NOT NULL;--> statement-breakpoint
ALTER TABLE "evaluation_predictions" ADD COLUMN "used_fallback" boolean;--> statement-breakpoint
ALTER TABLE "evaluation_predictions" ADD COLUMN "fallback_sources" jsonb;--> statement-breakpoint
ALTER TABLE "payments_accounts" ADD COLUMN "trial_start_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments_accounts" ADD COLUMN "failed_payment_count" integer DEFAULT 0 NOT NULL;--> statement-breakpoint
ALTER TABLE "payments_accounts" ADD COLUMN "last_payment_at" timestamp with time zone;--> statement-breakpoint
ALTER TABLE "payments_accounts" ADD COLUMN "last_payment_amount" integer;--> statement-breakpoint
ALTER TABLE "payments_accounts" ADD COLUMN "last_payment_status" text;--> statement-breakpoint
ALTER TABLE "canonical_matches" ADD CONSTRAINT "canonical_matches_player_a_id_canonical_players_id_fk" FOREIGN KEY ("player_a_id") REFERENCES "public"."canonical_players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "canonical_matches" ADD CONSTRAINT "canonical_matches_player_b_id_canonical_players_id_fk" FOREIGN KEY ("player_b_id") REFERENCES "public"."canonical_players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "historical_feature_diagnostics" ADD CONSTRAINT "historical_feature_diagnostics_canonical_player_id_canonical_players_id_fk" FOREIGN KEY ("canonical_player_id") REFERENCES "public"."canonical_players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "match_source_links" ADD CONSTRAINT "match_source_links_canonical_match_id_canonical_matches_id_fk" FOREIGN KEY ("canonical_match_id") REFERENCES "public"."canonical_matches"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "player_aliases" ADD CONSTRAINT "player_aliases_canonical_player_id_canonical_players_id_fk" FOREIGN KEY ("canonical_player_id") REFERENCES "public"."canonical_players"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "legal_consents_context_idx" ON "legal_consents" USING btree ("context");--> statement-breakpoint
CREATE INDEX "legal_consents_created_idx" ON "legal_consents" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "support_attachments_ticket_idx" ON "support_attachments" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "support_attachments_message_idx" ON "support_attachments" USING btree ("message_id");--> statement-breakpoint
CREATE INDEX "support_messages_ticket_idx" ON "support_messages" USING btree ("ticket_id");--> statement-breakpoint
CREATE INDEX "support_messages_created_idx" ON "support_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "support_tickets_clerk_user_idx" ON "support_tickets" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "support_tickets_category_idx" ON "support_tickets" USING btree ("category");--> statement-breakpoint
CREATE INDEX "support_tickets_status_idx" ON "support_tickets" USING btree ("status");--> statement-breakpoint
CREATE INDEX "support_tickets_priority_idx" ON "support_tickets" USING btree ("priority");--> statement-breakpoint
CREATE INDEX "support_tickets_created_idx" ON "support_tickets" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "admin_audit_log_target_idx" ON "admin_audit_log" USING btree ("target_clerk_user_id");--> statement-breakpoint
CREATE INDEX "admin_audit_log_action_idx" ON "admin_audit_log" USING btree ("action");--> statement-breakpoint
CREATE INDEX "admin_audit_log_created_idx" ON "admin_audit_log" USING btree ("created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "admin_user_notes_clerk_user_id_idx" ON "admin_user_notes" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE INDEX "saved_prediction_cards_clerk_user_id_idx" ON "saved_prediction_cards" USING btree ("clerk_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "saved_prediction_cards_user_prediction_idx" ON "saved_prediction_cards" USING btree ("clerk_user_id","prediction_id");--> statement-breakpoint
CREATE UNIQUE INDEX "canonical_matches_match_key_idx" ON "canonical_matches" USING btree ("match_key");--> statement-breakpoint
CREATE INDEX "canonical_players_normalized_name_idx" ON "canonical_players" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "canonical_players_tour_idx" ON "canonical_players" USING btree ("tour");--> statement-breakpoint
CREATE UNIQUE INDEX "match_source_links_provider_external_id_idx" ON "match_source_links" USING btree ("provider","external_match_id");--> statement-breakpoint
CREATE INDEX "match_source_links_canonical_match_idx" ON "match_source_links" USING btree ("canonical_match_id");--> statement-breakpoint
CREATE UNIQUE INDEX "player_aliases_provider_external_id_idx" ON "player_aliases" USING btree ("provider","external_player_id");--> statement-breakpoint
CREATE INDEX "player_aliases_normalized_name_idx" ON "player_aliases" USING btree ("normalized_name");--> statement-breakpoint
CREATE INDEX "player_aliases_canonical_player_idx" ON "player_aliases" USING btree ("canonical_player_id");--> statement-breakpoint
CREATE INDEX "predictions_clerk_user_id_idx" ON "predictions" USING btree ("clerk_user_id");