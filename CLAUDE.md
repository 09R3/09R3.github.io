# Claude Instructions for 09R3.github.io

## Project Context

### Field Ops (`field-ops/`)
A mobile-friendly form app used by field operators to take readings and report
issues found in the field. Readings are saved into a PostgreSQL database.

### Water Ops Viewer (`water-ops-viewer/`)
A database viewer used to access, organize, sort, and analyze the data entered
by field operators. Includes report generation and CSV/Excel/PDF export.

---

## Ports & Deployments

| App | Branch | Appdata Path | Port |
|-----|--------|-------------|------|
| field-ops | `main` | `/mnt/user/appdata/field-ops` | 3067 |
| field-ops | beta (`claude/field-operator-form-app-dEwL1`) | `/mnt/user/appdata/field-ops-beta` | 3066 |
| water-ops-viewer | `main` | `/mnt/user/appdata/water-ops-viewer` | 3069 |
| water-ops-viewer | beta (`claude/database-viewer-reports-i8gRu`) | `/mnt/user/appdata/water-ops-viewer-beta` | 3068 |

---

## Branch Strategy

- **water-ops-viewer** changes → branch `claude/database-viewer-reports-i8gRu`
- **field-ops** changes → branch `claude/field-operator-form-app-dEwL1`
- Beta branches map to the `claude/` feature branches above
- Never push directly to `main`

---

## Version Bumping

**Whenever changes are made to files inside `water-ops-viewer/`**, bump the
patch version in `water-ops-viewer/package.json` before committing.

Use semantic versioning — patch for fixes/small changes, minor for new features:
- Bug fix or tweak → `1.1.0` → `1.1.1`
- New feature → `1.1.0` → `1.2.0`

The version is displayed in the app UI (sidebar footer) and read from
`package.json` via the `/api/version` endpoint — no other files need updating.

## Database Schema

DROP TABLE IF EXISTS "_waterops_saved_queries";
DROP SEQUENCE IF EXISTS "public"._waterops_saved_queries_id_seq;
CREATE SEQUENCE "public"._waterops_saved_queries_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."_waterops_saved_queries" (
    "id" integer DEFAULT nextval('_waterops_saved_queries_id_seq') NOT NULL,
    "name" text NOT NULL,
    "sql" text NOT NULL,
    "created_by" text DEFAULT 'admin' NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT "_waterops_saved_queries_pkey" PRIMARY KEY ("id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "air_compressors";
CREATE TABLE "public"."air_compressors" (
    "compressor_id" integer NOT NULL,
    "building_id" integer,
    "serial_number" text,
    "manufacturer" text,
    "model_number" text,
    "install_date" date,
    "certification_expiry_date" date,
    "status" text DEFAULT 'active',
    "notes" text,
    CONSTRAINT "air_compressors_pkey" PRIMARY KEY ("compressor_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "app_settings";
CREATE TABLE "public"."app_settings" (
    "key" character varying(100) NOT NULL,
    "value" text,
    "updated_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "app_settings_pkey" PRIMARY KEY ("key")
)
WITH (oids = false);


DROP TABLE IF EXISTS "bug_reports";
DROP SEQUENCE IF EXISTS "public".bug_reports_report_id_seq;
CREATE SEQUENCE "public".bug_reports_report_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."bug_reports" (
    "report_id" integer DEFAULT nextval('bug_reports_report_id_seq') NOT NULL,
    "submitted_by" character varying(100) NOT NULL,
    "submitted_at" timestamp DEFAULT now(),
    "screen_area" character varying(100),
    "severity" character varying(20) DEFAULT 'minor',
    "is_repeatable" boolean DEFAULT false,
    "description" text NOT NULL,
    "app_version" character varying(20),
    "resolved" boolean DEFAULT false,
    "resolved_by" character varying(100),
    "resolved_at" timestamp,
    CONSTRAINT "bug_reports_pkey" PRIMARY KEY ("report_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "building_issues";
DROP SEQUENCE IF EXISTS "public".building_issues_issue_id_seq;
CREATE SEQUENCE "public".building_issues_issue_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."building_issues" (
    "issue_id" integer DEFAULT nextval('building_issues_issue_id_seq') NOT NULL,
    "building_id" integer,
    "site_id" integer,
    "building_name" text,
    "site_name" text,
    "status" text DEFAULT 'open' NOT NULL,
    "description" text NOT NULL,
    "reported_date" date DEFAULT CURRENT_DATE NOT NULL,
    "resolved_date" date,
    "resolution_notes" text,
    "entered_by" text NOT NULL,
    "assigned_to" text,
    "notes" text,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,
    "action_taken" text,
    "po_number" text,
    "cost" numeric(10,2),
    CONSTRAINT "building_issues_pkey" PRIMARY KEY ("issue_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "buildings";
CREATE TABLE "public"."buildings" (
    "building_id" integer NOT NULL,
    "site_id" integer,
    "building_letter" text,
    "building_name" text,
    "notes" text,
    CONSTRAINT "buildings_pkey" PRIMARY KEY ("building_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "canal_structures";
CREATE TABLE "public"."canal_structures" (
    "structure_id" integer NOT NULL,
    "structure_name" text NOT NULL,
    "structure_type" text,
    "flow_direction" text,
    "in_service" boolean,
    "constructed_date" date,
    "gate_capacity" numeric,
    "design_capacity" numeric,
    "operational_capacity" numeric,
    "owner" text,
    "who_maintains" text,
    "gps_latitude" numeric,
    "gps_longitude" numeric,
    "has_flow_meter" boolean,
    "meter_type" text,
    "meter_model" text,
    "meter_status" text,
    "formula_or_chart_ref" text,
    "notes" text,
    CONSTRAINT "canal_structures_pkey" PRIMARY KEY ("structure_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "equipment_issues";
DROP SEQUENCE IF EXISTS "public".equipment_issues_issue_id_seq;
CREATE SEQUENCE "public".equipment_issues_issue_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."equipment_issues" (
    "issue_id" integer DEFAULT nextval('equipment_issues_issue_id_seq') NOT NULL,
    "equipment_type" text NOT NULL,
    "equipment_id" text,
    "equipment_name" text,
    "status" text DEFAULT 'open' NOT NULL,
    "description" text NOT NULL,
    "reported_date" date DEFAULT CURRENT_DATE NOT NULL,
    "resolved_date" date,
    "resolution_notes" text,
    "entered_by" text NOT NULL,
    "assigned_to" text,
    "notes" text,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,
    "action_taken" text,
    "po_number" text,
    "cost" numeric(10,2),
    CONSTRAINT "equipment_issues_pkey" PRIMARY KEY ("issue_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "equipment_swaps";
DROP SEQUENCE IF EXISTS "public".equipment_swaps_swap_id_seq;
CREATE SEQUENCE "public".equipment_swaps_swap_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."equipment_swaps" (
    "swap_id" integer DEFAULT nextval('equipment_swaps_swap_id_seq') NOT NULL,
    "category" text NOT NULL,
    "swap_date" date NOT NULL,
    "location" text,
    "item_removed_id" integer,
    "item_installed_id" integer,
    "removed_description" text,
    "installed_description" text,
    "performed_by" text,
    "notes" text,
    "entered_by" text NOT NULL,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT "equipment_swaps_pkey" PRIMARY KEY ("swap_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "maintenance_buildings";
DROP SEQUENCE IF EXISTS "public".maintenance_buildings_record_id_seq;
CREATE SEQUENCE "public".maintenance_buildings_record_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."maintenance_buildings" (
    "record_id" integer DEFAULT nextval('maintenance_buildings_record_id_seq') NOT NULL,
    "building_id" integer,
    "work_date" date,
    "work_type" text,
    "record_type" text,
    "description" text,
    "performed_by" text,
    "is_contractor" boolean,
    "entered_by" text,
    "severity" text,
    "status" text,
    "cost" numeric,
    "po_number" text,
    "resolution_notes" text,
    "next_service_date" date,
    "notes" text,
    CONSTRAINT "maintenance_buildings_pkey" PRIMARY KEY ("record_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "maintenance_equipment";
DROP SEQUENCE IF EXISTS "public".maintenance_equipment_maintenance_id_seq;
CREATE SEQUENCE "public".maintenance_equipment_maintenance_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."maintenance_equipment" (
    "maintenance_id" integer DEFAULT nextval('maintenance_equipment_maintenance_id_seq') NOT NULL,
    "equipment_type" text,
    "equipment_id" integer,
    "work_date" date,
    "work_type" text,
    "performed_by" text,
    "is_contractor" boolean,
    "entered_by" text,
    "location_at_time" text,
    "description" text,
    "parts_used" text,
    "cost" numeric,
    "po_number" text,
    "hours_at_service" numeric,
    "next_service_date" date,
    "notes" text,
    CONSTRAINT "maintenance_equipment_pkey" PRIMARY KEY ("maintenance_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "maintenance_vehicles";
DROP SEQUENCE IF EXISTS "public".maintenance_vehicles_maintenance_id_seq;
CREATE SEQUENCE "public".maintenance_vehicles_maintenance_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."maintenance_vehicles" (
    "maintenance_id" integer DEFAULT nextval('maintenance_vehicles_maintenance_id_seq') NOT NULL,
    "vehicle_id" integer,
    "work_date" date,
    "work_type" text,
    "performed_by" text,
    "is_contractor" boolean,
    "entered_by" text,
    "description" text,
    "odometer_at_service" numeric,
    "engine_hours_at_service" numeric,
    "parts_used" text,
    "cost" numeric,
    "po_number" text,
    "next_service_date" date,
    "next_service_miles" numeric,
    "notes" text,
    "next_service_hours" numeric,
    CONSTRAINT "maintenance_vehicles_pkey" PRIMARY KEY ("maintenance_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "motors";
CREATE TABLE "public"."motors" (
    "motor_id" integer NOT NULL,
    "serial_number" text,
    "manufacturer" text,
    "model_number" text,
    "rated_hp" numeric,
    "frame_type" text,
    "oil_capacity_upper_qt" numeric,
    "oil_capacity_lower_qt" numeric,
    "install_date_current" date,
    "current_location" text,
    "status" text DEFAULT 'active',
    "notes" text,
    CONSTRAINT "motors_pkey" PRIMARY KEY ("motor_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "pesticide_usage";
DROP SEQUENCE IF EXISTS "public".pesticide_usage_usage_id_seq;
CREATE SEQUENCE "public".pesticide_usage_usage_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."pesticide_usage" (
    "usage_id" integer DEFAULT nextval('pesticide_usage_usage_id_seq') NOT NULL,
    "pesticide_id" integer NOT NULL,
    "used_date" date DEFAULT CURRENT_DATE NOT NULL,
    "used_time" time without time zone DEFAULT CURRENT_TIME NOT NULL,
    "applied_by" integer,
    "quantity" numeric(10,2) NOT NULL,
    "location_description" text,
    "notes" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "pesticide_usage_pkey" PRIMARY KEY ("usage_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "pesticides";
DROP SEQUENCE IF EXISTS "public".pesticides_pesticide_id_seq;
CREATE SEQUENCE "public".pesticides_pesticide_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."pesticides" (
    "pesticide_id" integer DEFAULT nextval('pesticides_pesticide_id_seq') NOT NULL,
    "name" character varying(100) NOT NULL,
    "epa_reg_number" character varying(50),
    "unit_of_measure" character varying(30) NOT NULL,
    "active" boolean DEFAULT true NOT NULL,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "pesticides_pkey" PRIMARY KEY ("pesticide_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "pge_meters";
CREATE TABLE "public"."pge_meters" (
    "pge_meter_id" integer NOT NULL,
    "building_id" integer,
    "meter_name" text,
    "meter_number" text,
    "account_number" text,
    "utility_provider" text,
    "notes" text,
    CONSTRAINT "pge_meters_pkey" PRIMARY KEY ("pge_meter_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "pm_records";
DROP SEQUENCE IF EXISTS "public".pm_records_pm_id_seq;
CREATE SEQUENCE "public".pm_records_pm_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."pm_records" (
    "pm_id" integer DEFAULT nextval('pm_records_pm_id_seq') NOT NULL,
    "pm_type" character varying(50) NOT NULL,
    "building" character varying(100),
    "completed_date" date DEFAULT CURRENT_DATE NOT NULL,
    "completed_time" time without time zone DEFAULT CURRENT_TIME NOT NULL,
    "completed_by" integer,
    "checklist" jsonb DEFAULT '{}' NOT NULL,
    "notes" text,
    "created_at" timestamp DEFAULT now() NOT NULL,
    CONSTRAINT "pm_records_pkey" PRIMARY KEY ("pm_id")
)
WITH (oids = false);

CREATE INDEX pm_records_type_date ON public.pm_records USING btree (pm_type, completed_date DESC);


DROP TABLE IF EXISTS "power_monitors";
CREATE TABLE "public"."power_monitors" (
    "monitor_id" integer NOT NULL,
    "building_id" integer,
    "monitor_number" text,
    "manufacturer" text,
    "ip_address" text,
    "notes" text,
    CONSTRAINT "power_monitors_pkey" PRIMARY KEY ("monitor_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "pump_positions";
CREATE TABLE "public"."pump_positions" (
    "position_id" text NOT NULL,
    "site_id" integer,
    "building_id" integer,
    "pump_letter" text,
    "rated_hp" numeric,
    "current_motor_id" integer,
    "current_pump_unit_id" integer,
    "status" text DEFAULT 'active',
    "notes" text,
    CONSTRAINT "pump_positions_pkey" PRIMARY KEY ("position_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "pump_units";
CREATE TABLE "public"."pump_units" (
    "pump_unit_id" integer NOT NULL,
    "serial_number" text,
    "manufacturer" text,
    "model_number" text,
    "rated_hp" numeric,
    "frame_type" text,
    "forward_flow_rating" numeric,
    "reverse_flow_rating" numeric,
    "install_date_current" date,
    "current_location" text,
    "status" text DEFAULT 'active',
    "notes" text,
    CONSTRAINT "pump_units_pkey" PRIMARY KEY ("pump_unit_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "readings_canal";
DROP SEQUENCE IF EXISTS "public".readings_canal_reading_id_seq;
CREATE SEQUENCE "public".readings_canal_reading_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."readings_canal" (
    "reading_id" integer DEFAULT nextval('readings_canal_reading_id_seq') NOT NULL,
    "structure_id" integer,
    "reading_date" date,
    "reading_time" time without time zone,
    "entered_by" text,
    "instantaneous_flow_cfs" numeric,
    "totalizer_reading_af" numeric,
    "gate_setting" text,
    "head_reading_ft" numeric,
    "derived_flow_cfs" numeric,
    "notes" text,
    CONSTRAINT "readings_canal_pkey" PRIMARY KEY ("reading_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "readings_compressor_hours";
DROP SEQUENCE IF EXISTS "public".readings_compressor_hours_reading_id_seq;
CREATE SEQUENCE "public".readings_compressor_hours_reading_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."readings_compressor_hours" (
    "reading_id" integer DEFAULT nextval('readings_compressor_hours_reading_id_seq') NOT NULL,
    "compressor_id" integer,
    "reading_date" date,
    "reading_time" time without time zone,
    "hour_reading" numeric,
    "entered_by" text,
    "notes" text,
    CONSTRAINT "readings_compressor_hours_pkey" PRIMARY KEY ("reading_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "readings_kf_monthly";
DROP SEQUENCE IF EXISTS "public".readings_kf_monthly_kf_reading_id_seq;
CREATE SEQUENCE "public".readings_kf_monthly_kf_reading_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."readings_kf_monthly" (
    "kf_reading_id" integer DEFAULT nextval('readings_kf_monthly_kf_reading_id_seq') NOT NULL,
    "well_id" integer,
    "reading_date" date,
    "reading_time" time without time zone,
    "dtw_reading" numeric,
    "operator" text,
    "plopper_sounder" text,
    "well_on_off" boolean,
    "notes" text,
    "common_name" text,
    CONSTRAINT "readings_kf_monthly_pkey" PRIMARY KEY ("kf_reading_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "readings_pge_meters";
DROP SEQUENCE IF EXISTS "public".readings_pge_meters_reading_id_seq;
CREATE SEQUENCE "public".readings_pge_meters_reading_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."readings_pge_meters" (
    "reading_id" integer DEFAULT nextval('readings_pge_meters_reading_id_seq') NOT NULL,
    "pge_meter_id" integer,
    "reading_date" date,
    "reading_time" time without time zone,
    "kwh_reading" numeric,
    "entered_by" text,
    "notes" text,
    CONSTRAINT "readings_pge_meters_pkey" PRIMARY KEY ("reading_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "readings_power_monitors";
DROP SEQUENCE IF EXISTS "public".readings_power_monitors_reading_id_seq;
CREATE SEQUENCE "public".readings_power_monitors_reading_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."readings_power_monitors" (
    "reading_id" integer DEFAULT nextval('readings_power_monitors_reading_id_seq') NOT NULL,
    "monitor_id" integer,
    "reading_date" date,
    "reading_time" time without time zone,
    "kwh_reading" numeric,
    "entered_by" text,
    "notes" text,
    CONSTRAINT "readings_power_monitors_pkey" PRIMARY KEY ("reading_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "readings_pump_hours";
DROP SEQUENCE IF EXISTS "public".readings_pump_hours_reading_id_seq;
CREATE SEQUENCE "public".readings_pump_hours_reading_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."readings_pump_hours" (
    "reading_id" integer DEFAULT nextval('readings_pump_hours_reading_id_seq') NOT NULL,
    "position_id" text,
    "reading_date" date,
    "reading_time" time without time zone,
    "hour_reading" numeric,
    "entered_by" text,
    "notes" text,
    CONSTRAINT "readings_pump_hours_pkey" PRIMARY KEY ("reading_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "readings_run_dwr";
DROP SEQUENCE IF EXISTS "public".readings_run_dwr_reading_id_seq;
CREATE SEQUENCE "public".readings_run_dwr_reading_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."readings_run_dwr" (
    "reading_id" integer DEFAULT nextval('readings_run_dwr_reading_id_seq') NOT NULL,
    "well_id" integer NOT NULL,
    "reading_date" date NOT NULL,
    "reading_time" time without time zone,
    "depth_to_water" numeric(8,2),
    "method" text,
    "operator" text,
    "no_measurement" text[],
    "questionable_measurement" text[],
    "notes" text,
    "entered_by" text,
    "created_at" timestamptz DEFAULT now(),
    CONSTRAINT "readings_run_dwr_pkey" PRIMARY KEY ("reading_id")
)
WITH (oids = false);

CREATE INDEX idx_readings_run_dwr_well ON public.readings_run_dwr USING btree (well_id);

CREATE INDEX idx_readings_run_dwr_date ON public.readings_run_dwr USING btree (reading_date DESC);


DROP TABLE IF EXISTS "readings_vehicle_monthly";
DROP SEQUENCE IF EXISTS "public".readings_vehicle_monthly_reading_id_seq;
CREATE SEQUENCE "public".readings_vehicle_monthly_reading_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."readings_vehicle_monthly" (
    "reading_id" integer DEFAULT nextval('readings_vehicle_monthly_reading_id_seq') NOT NULL,
    "vehicle_id" integer,
    "vehicle_number" text,
    "reading_date" date,
    "reading_time" time without time zone,
    "entered_by" text,
    "odometer_miles" numeric,
    "engine_hours" numeric,
    "notes" text,
    CONSTRAINT "readings_vehicle_monthly_pkey" PRIMARY KEY ("reading_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "readings_well";
DROP SEQUENCE IF EXISTS "public".readings_well_reading_id_seq;
CREATE SEQUENCE "public".readings_well_reading_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."readings_well" (
    "reading_id" integer DEFAULT nextval('readings_well_reading_id_seq') NOT NULL,
    "well_id" integer,
    "common_name" text,
    "reading_date" date,
    "reading_time" time without time zone,
    "on_off" boolean,
    "hour_reading" numeric,
    "flow_cfs" numeric,
    "totalizer" numeric,
    "motor_oil" boolean,
    "dripper_oil" numeric,
    "pge_kwh" numeric,
    "entered_by" text,
    "notes" text,
    CONSTRAINT "readings_well_pkey" PRIMARY KEY ("reading_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "scada_equipment";
DROP SEQUENCE IF EXISTS "public".scada_equipment_scada_id_seq;
CREATE SEQUENCE "public".scada_equipment_scada_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."scada_equipment" (
    "scada_id" integer DEFAULT nextval('scada_equipment_scada_id_seq') NOT NULL,
    "building_id" integer,
    "equipment_number" text,
    "equipment_name" text,
    "manufacturer" text,
    "ip_address" text,
    "notes" text,
    CONSTRAINT "scada_equipment_pkey" PRIMARY KEY ("scada_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "siphon_breaker_swaps";
DROP SEQUENCE IF EXISTS "public".siphon_breaker_swaps_swap_id_seq;
CREATE SEQUENCE "public".siphon_breaker_swaps_swap_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."siphon_breaker_swaps" (
    "swap_id" integer DEFAULT nextval('siphon_breaker_swaps_swap_id_seq') NOT NULL,
    "swap_date" date NOT NULL,
    "location" text NOT NULL,
    "unit_removed_id" integer,
    "unit_installed_id" integer,
    "performed_by" text,
    "notes" text,
    "entered_by" text,
    "created_at" timestamptz DEFAULT now(),
    CONSTRAINT "siphon_breaker_swaps_pkey" PRIMARY KEY ("swap_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "siphon_breakers";
CREATE TABLE "public"."siphon_breakers" (
    "pump_unit_id" integer NOT NULL,
    "serial_number" text,
    "manufacturer" text,
    "model_number" text,
    "operating_psi" numeric,
    "max_psi" numeric,
    "install_date_current" date,
    "current_location" text,
    "status" text DEFAULT 'active',
    "notes" text,
    CONSTRAINT "siphon_breakers_pkey" PRIMARY KEY ("pump_unit_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "sites";
CREATE TABLE "public"."sites" (
    "site_id" integer NOT NULL,
    "site_name" text NOT NULL,
    "site_type" text,
    "gps_latitude" numeric,
    "gps_longitude" numeric,
    "notes" text,
    CONSTRAINT "sites_pkey" PRIMARY KEY ("site_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "users";
DROP SEQUENCE IF EXISTS "public".users_user_id_seq;
CREATE SEQUENCE "public".users_user_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."users" (
    "user_id" integer DEFAULT nextval('users_user_id_seq') NOT NULL,
    "username" text NOT NULL,
    "full_name" text,
    "role" text,
    "password" text,
    "initials" text,
    "email" text,
    "is_active" boolean DEFAULT true,
    CONSTRAINT "users_pkey" PRIMARY KEY ("user_id")
)
WITH (oids = false);

CREATE UNIQUE INDEX users_username_key ON public.users USING btree (username);


DROP TABLE IF EXISTS "vehicles";
CREATE TABLE "public"."vehicles" (
    "vehicle_id" integer NOT NULL,
    "vehicle_number" text,
    "vehicle_type" text,
    "year" text,
    "make" text,
    "model" text,
    "vin" text,
    "license_plate" text,
    "fuel_type" text,
    "assigned_user" text,
    "reading_type" text,
    "status" text DEFAULT 'active',
    "notes" text,
    CONSTRAINT "vehicles_pkey" PRIMARY KEY ("vehicle_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "well_issues";
DROP SEQUENCE IF EXISTS "public".well_issues_issue_id_seq;
CREATE SEQUENCE "public".well_issues_issue_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."well_issues" (
    "issue_id" integer DEFAULT nextval('well_issues_issue_id_seq') NOT NULL,
    "well_id" integer,
    "well_name" text,
    "well_area" text,
    "status" text DEFAULT 'open' NOT NULL,
    "description" text NOT NULL,
    "reported_date" date DEFAULT CURRENT_DATE NOT NULL,
    "resolved_date" date,
    "resolution_notes" text,
    "entered_by" text NOT NULL,
    "assigned_to" text,
    "notes" text,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    "updated_at" timestamptz DEFAULT now() NOT NULL,
    "action_taken" text,
    "po_number" text,
    "cost" numeric(10,2),
    CONSTRAINT "well_issues_pkey" PRIMARY KEY ("issue_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "well_meters";
DROP SEQUENCE IF EXISTS "public".well_meters_well_meter_id_seq;
CREATE SEQUENCE "public".well_meters_well_meter_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."well_meters" (
    "well_meter_id" integer DEFAULT nextval('well_meters_well_meter_id_seq') NOT NULL,
    "manufacturer" text,
    "model_number" text,
    "serial_number" text,
    "meter_type" text,
    "status" text DEFAULT 'spare' NOT NULL,
    "well_id" integer,
    "notes" text,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT "well_meters_pkey" PRIMARY KEY ("well_meter_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "well_motors";
DROP SEQUENCE IF EXISTS "public".well_motors_well_motor_id_seq;
CREATE SEQUENCE "public".well_motors_well_motor_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 2147483647 CACHE 1;

CREATE TABLE "public"."well_motors" (
    "well_motor_id" integer DEFAULT nextval('well_motors_well_motor_id_seq') NOT NULL,
    "manufacturer" text,
    "model_number" text,
    "serial_number" text,
    "hp" numeric,
    "status" text DEFAULT 'spare' NOT NULL,
    "well_id" integer,
    "notes" text,
    "created_at" timestamptz DEFAULT now() NOT NULL,
    CONSTRAINT "well_motors_pkey" PRIMARY KEY ("well_motor_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "well_sets";
CREATE TABLE "public"."well_sets" (
    "set_id" integer NOT NULL,
    "set_name" text,
    "description" text,
    CONSTRAINT "well_sets_pkey" PRIMARY KEY ("set_id")
)
WITH (oids = false);


DROP TABLE IF EXISTS "wells";
DROP SEQUENCE IF EXISTS "public".wells_well_id_seq;
CREATE SEQUENCE "public".wells_well_id_seq INCREMENT 1 MINVALUE 1 MAXVALUE 9223372036854775807 CACHE 1;

CREATE TABLE "public"."wells" (
    "well_id" integer DEFAULT nextval('wells_well_id_seq') NOT NULL,
    "common_name" text,
    "state_well_number" text,
    "area" text,
    "discharge_pool" text,
    "participant" text,
    "agency" text,
    "kf_set_id" integer,
    "well_type" text,
    "total_depth_ft" numeric,
    "pump_hp" numeric,
    "pump_frame_size" text,
    "pump_unit_id" integer,
    "status" text,
    "gps_latitude" numeric,
    "gps_longitude" numeric,
    "notes" text,
    "is_important" boolean DEFAULT false,
    "well_run" text,
    "rp_elev" numeric,
    "gs_elev" numeric,
    CONSTRAINT "wells_pkey" PRIMARY KEY ("well_id")
)
WITH (oids = false);

CREATE INDEX idx_wells_kf_set_id ON public.wells USING btree (kf_set_id);


ALTER TABLE ONLY "public"."air_compressors" ADD CONSTRAINT "air_compressors_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(building_id);

ALTER TABLE ONLY "public"."building_issues" ADD CONSTRAINT "building_issues_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(building_id);
ALTER TABLE ONLY "public"."building_issues" ADD CONSTRAINT "building_issues_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(site_id);

ALTER TABLE ONLY "public"."buildings" ADD CONSTRAINT "buildings_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(site_id);

ALTER TABLE ONLY "public"."maintenance_buildings" ADD CONSTRAINT "maintenance_buildings_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(building_id);

ALTER TABLE ONLY "public"."maintenance_vehicles" ADD CONSTRAINT "maintenance_vehicles_vehicle_id_fkey" FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id);

ALTER TABLE ONLY "public"."pesticide_usage" ADD CONSTRAINT "pesticide_usage_applied_by_fkey" FOREIGN KEY (applied_by) REFERENCES users(user_id);
ALTER TABLE ONLY "public"."pesticide_usage" ADD CONSTRAINT "pesticide_usage_pesticide_id_fkey" FOREIGN KEY (pesticide_id) REFERENCES pesticides(pesticide_id);

ALTER TABLE ONLY "public"."pge_meters" ADD CONSTRAINT "pge_meters_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(building_id);

ALTER TABLE ONLY "public"."pm_records" ADD CONSTRAINT "pm_records_completed_by_fkey" FOREIGN KEY (completed_by) REFERENCES users(user_id);

ALTER TABLE ONLY "public"."power_monitors" ADD CONSTRAINT "power_monitors_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(building_id);

ALTER TABLE ONLY "public"."pump_positions" ADD CONSTRAINT "pump_positions_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(building_id);
ALTER TABLE ONLY "public"."pump_positions" ADD CONSTRAINT "pump_positions_site_id_fkey" FOREIGN KEY (site_id) REFERENCES sites(site_id);

ALTER TABLE ONLY "public"."readings_canal" ADD CONSTRAINT "readings_canal_structure_id_fkey" FOREIGN KEY (structure_id) REFERENCES canal_structures(structure_id);

ALTER TABLE ONLY "public"."readings_compressor_hours" ADD CONSTRAINT "readings_compressor_hours_compressor_id_fkey" FOREIGN KEY (compressor_id) REFERENCES air_compressors(compressor_id);

ALTER TABLE ONLY "public"."readings_kf_monthly" ADD CONSTRAINT "readings_kf_monthly_well_id_fkey" FOREIGN KEY (well_id) REFERENCES wells(well_id);

ALTER TABLE ONLY "public"."readings_pge_meters" ADD CONSTRAINT "readings_pge_meters_pge_meter_id_fkey" FOREIGN KEY (pge_meter_id) REFERENCES pge_meters(pge_meter_id);

ALTER TABLE ONLY "public"."readings_power_monitors" ADD CONSTRAINT "readings_power_monitors_monitor_id_fkey" FOREIGN KEY (monitor_id) REFERENCES power_monitors(monitor_id);

ALTER TABLE ONLY "public"."readings_pump_hours" ADD CONSTRAINT "readings_pump_hours_position_id_fkey" FOREIGN KEY (position_id) REFERENCES pump_positions(position_id);

ALTER TABLE ONLY "public"."readings_run_dwr" ADD CONSTRAINT "readings_run_dwr_well_id_fkey" FOREIGN KEY (well_id) REFERENCES wells(well_id) ON DELETE CASCADE;

ALTER TABLE ONLY "public"."readings_vehicle_monthly" ADD CONSTRAINT "readings_vehicle_monthly_vehicle_id_fkey" FOREIGN KEY (vehicle_id) REFERENCES vehicles(vehicle_id);

ALTER TABLE ONLY "public"."readings_well" ADD CONSTRAINT "readings_well_well_id_fkey" FOREIGN KEY (well_id) REFERENCES wells(well_id);

ALTER TABLE ONLY "public"."scada_equipment" ADD CONSTRAINT "scada_equipment_building_id_fkey" FOREIGN KEY (building_id) REFERENCES buildings(building_id);

ALTER TABLE ONLY "public"."siphon_breaker_swaps" ADD CONSTRAINT "siphon_breaker_swaps_unit_installed_id_fkey" FOREIGN KEY (unit_installed_id) REFERENCES siphon_breakers(pump_unit_id);
ALTER TABLE ONLY "public"."siphon_breaker_swaps" ADD CONSTRAINT "siphon_breaker_swaps_unit_removed_id_fkey" FOREIGN KEY (unit_removed_id) REFERENCES siphon_breakers(pump_unit_id);

ALTER TABLE ONLY "public"."well_issues" ADD CONSTRAINT "well_issues_well_id_fkey" FOREIGN KEY (well_id) REFERENCES wells(well_id);

ALTER TABLE ONLY "public"."well_meters" ADD CONSTRAINT "well_meters_well_id_fkey" FOREIGN KEY (well_id) REFERENCES wells(well_id);

ALTER TABLE ONLY "public"."well_motors" ADD CONSTRAINT "well_motors_well_id_fkey" FOREIGN KEY (well_id) REFERENCES wells(well_id);

ALTER TABLE ONLY "public"."wells" ADD CONSTRAINT "fk_wells_kf_set_id" FOREIGN KEY (kf_set_id) REFERENCES well_sets(set_id) ON DELETE SET NULL;
ALTER TABLE ONLY "public"."wells" ADD CONSTRAINT "wells_kf_set_id_fkey" FOREIGN KEY (kf_set_id) REFERENCES well_sets(set_id);
