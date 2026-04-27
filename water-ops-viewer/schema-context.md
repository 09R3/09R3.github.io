# FieldView Database Context

This database is used by a water district to manage field operations. Field operators
take daily readings at wells, pumping plants, canal structures, and other equipment.
The FieldView app is the read/analysis side; WaterMark is the mobile app operators
use to enter data.

---

## System Overview

- **Wells** are irrigation and monitoring wells spread across multiple areas.
  Each well may have daily pump readings, monthly depth-to-water readings, and DWR run logs.
- **Pumping Plants** are facilities (buildings/sites) that house pumps. Each pump
  position has hourly run-time readings logged by operators.
- **Canal Structures** are gates and measuring points on irrigation canals with
  flow and gate-setting readings.
- **Vehicles & Equipment** are tracked for monthly mileage/hours and maintenance history.
- **Issues** (well, building, equipment) are work orders / problem reports with status tracking.
- **PM Records** are preventive maintenance checklists completed at scheduled intervals.

---

## Key Tables

### Wells & Water Readings

**`wells`** — Master list of wells.
- `well_id` — primary key
- `common_name` — the everyday name used in the field (e.g. "W-14", "Pioneer 3")
- `state_well_number` — official state ID
- `area` — geographic/management area the well belongs to
- `discharge_pool` — which irrigation pool this well pumps to
- `participant` — water district participant/landowner
- `well_type` — e.g. production, monitoring, piezometer
- `pump_hp` — pump horsepower
- `status` — active / inactive
- `is_important` — flag for priority wells
- `well_run` — whether the well is currently running

**`readings_well`** — Daily well readings taken by field operators.
- One row per reading event per well
- `well_id` → `wells`
- `reading_date`, `reading_time` — when the reading was taken
- `on_off` — pump status at time of reading (ON/OFF)
- `hour_reading` — engine/pump hour meter value
- `flow_cfs` — instantaneous flow in cubic feet per second
- `totalizer` — totalizer meter reading (cumulative flow)
- `motor_oil` — motor oil level check
- `dripper_oil` — dripper oil level check
- `pge_kwh` — PG&E kilowatt-hour meter reading
- `entered_by` — operator username

**`readings_kf_monthly`** — Monthly depth-to-water readings for KF wells.
- `well_id` → `wells`
- `dtw_reading` — depth to water in feet
- `operator` — operator initials
- `plopper_sounder` — which measurement device was used
- `well_on_off` — pump state during measurement

**`readings_run_dwr`** — DWR (Dept. of Water Resources) run readings / piezometer runs.
- `well_id` → `wells`
- `depth_to_water` — DTW measurement
- `method` — measurement method used
- `no_measurement` — reasons no measurement was taken (text array)
- `questionable_measurement` — flags for questionable data (text array)

**`piezometers`** — Dedicated piezometer monitoring wells (separate from production wells).
- `piezometer_name`, `pool`, `sort_order`, `max_depth`

**`readings_piezometers`** — Depth-to-water readings for piezometers.
- `dtw_reading`, `wet_dry_moist` — moisture state at measurement depth

---

### Pumping Plants & Infrastructure

**`sites`** — Physical pumping plant sites (e.g. "A Plant", "B Plant").
- `site_id`, `site_name`, `site_type`

**`buildings`** — Individual buildings within a site.
- `building_id`, `site_id` → `sites`, `building_letter`, `building_name`

**`pump_positions`** — Pump units installed at a building/site.
- `position_id` (text PK, e.g. "A-1"), `site_id`, `building_id`
- `pump_letter` — which pump (A, B, C…)
- `rated_hp` — rated horsepower
- `status` — active/inactive

**`readings_pump_hours`** — Hour-meter readings for each pump position.
- `position_id` → `pump_positions`
- `reading_date`, `reading_time`, `hour_reading`

---

### Canal Structures

**`canal_structures`** — Gates, weirs, and measuring points on irrigation canals.
- `structure_name`, `structure_type`, `flow_direction`
- `design_capacity`, `operational_capacity` — in CFS
- `has_flow_meter`, `meter_type`

**`readings_canal`** — Canal flow readings.
- `structure_id` → `canal_structures`
- `instantaneous_flow_cfs` — current flow rate
- `totalizer_reading_af` — cumulative flow in acre-feet
- `gate_setting` — gate opening measurement
- `head_reading_ft` — upstream head in feet
- `derived_flow_cfs` — calculated flow from formula/chart

---

### Vehicles & Equipment

**`vehicles`** — Fleet vehicles (trucks, tractors, etc.).
- `vehicle_number`, `vehicle_type`, `year`, `make`, `model`
- `reading_type` — odometer or engine hours (determines what monthly reading tracks)
- `fuel_type`, `status`

**`readings_vehicle_monthly`** — Monthly vehicle odometer/engine hour readings.
- `vehicle_id` → `vehicles`
- `odometer_miles`, `engine_hours`

**`maintenance_vehicles`** — Vehicle maintenance and repair records.
- `work_date`, `work_type` (oil change, repair, inspection, etc.)
- `odometer_at_service`, `engine_hours_at_service`
- `cost`, `po_number`, `parts_used`
- `next_service_date`, `next_service_miles`, `next_service_hours`
- `is_contractor` — whether work was done by outside contractor

**`maintenance_equipment`** — Maintenance records for general equipment (pumps, motors, etc.).
- `equipment_type`, `equipment_name` — what was worked on
- `work_date`, `work_type`, `cost`, `hours_at_service`

**`maintenance_buildings`** — Building maintenance and repair records.
- `building_id` → `buildings`
- `work_type`, `record_type`, `severity`, `status`

---

### Issues / Work Orders

**`well_issues`** — Problems reported at wells.
- `well_id` → `wells`, `well_name`, `well_area`
- `status` — open / in progress / resolved
- `description`, `resolution_notes`, `action_taken`
- `reported_date`, `resolved_date`
- `entered_by`, `assigned_to`
- `cost`, `po_number`

**`building_issues`** — Problems at buildings/pumping plants.
- Same status/resolution pattern as well_issues

**`equipment_issues`** — Problems with specific pieces of equipment.
- `equipment_type`, `equipment_id`, `equipment_name`

---

### Electrical / Power

**`pge_meters`** — PG&E electricity meters at buildings.
- `meter_name`, `meter_number`, `account_number`

**`readings_pge_meters`** — kWh readings from PG&E meters.
- `kwh_reading`, `reading_date`

**`power_monitors`** — Power monitoring devices.
**`readings_power_monitors`** — kWh readings from power monitors.

**`air_compressors`** — Air compressors at buildings.
**`readings_compressor_hours`** — Hour-meter readings for compressors.

---

### Personnel & Admin

**`users`** — System users / field operators.
- `username`, `full_name`, `initials`, `role`, `is_active`

**`pesticide_usage`** — Log of pesticide applications.
- `pesticide_id` → `pesticides`, `used_date`, `applied_by` → `users`
- `quantity`, `location_description`

**`pm_records`** — Preventive maintenance checklists.
- `pm_type`, `building`, `completed_date`, `completed_by`
- `checklist` — JSONB field with checkbox results

---

## Common Query Patterns

- To get the **most recent reading** for a well: filter by `well_id` and use `ORDER BY reading_date DESC, reading_time DESC LIMIT 1`
- To calculate **flow totals** over a date range: `SUM(flow_cfs)` or `SUM(totalizer)` grouped by well
- **Open issues**: `WHERE status != 'resolved'` or `WHERE status = 'open'`
- **This month / last month**: use `date_trunc('month', reading_date)`
- Wells are most commonly identified by `common_name` in queries; join `readings_well rw JOIN wells w ON rw.well_id = w.well_id`
- Pump positions join to sites: `pp JOIN sites s ON pp.site_id = s.site_id`
- For maintenance cost summaries, `SUM(cost)` grouped by vehicle/equipment and date range
